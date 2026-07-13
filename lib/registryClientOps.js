"use strict";
// registryClientOps.js — Zero-dependency Docker/OCI registry client
// Pure Node.js https — no npm deps.
//
// Operations:
//   ping         — Check that the registry speaks the Distribution API (GET /v2/)
//   tags         — List all tags for an image (paginated)
//   manifest     — Fetch and decode a manifest (schema v1/v2, OCI image index / image manifest)
//   config       — Fetch and decode the image config (OS, arch, Env, Cmd, Labels, history…)
//   layers       — List layers (digest, mediaType, size) from the manifest
//   exists       — Check whether a specific tag or digest exists (HEAD request)
//   digest       — Return the content-addressable digest for a tag (Docker-Content-Digest header)

const https  = require("https");
const http   = require("http");
const { URL } = require("url");

// ─── constants ────────────────────────────────────────────────────────────────
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;  // 16 MB per API response
const MAX_TAGS           = 5_000;              // hard cap when listing tags
const DEFAULT_TIMEOUT    = 20_000;             // 20 s

// Accept headers that tell registries to return fat manifests / OCI manifests
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v1+prettyjws",
  "application/json",
].join(", ");

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalise a registry hostname.
 * "docker.io" / "index.docker.io" -> "registry-1.docker.io"
 * anything else -> as-is
 */
function normaliseRegistry(reg) {
  if (!reg || reg === "docker.io" || reg === "index.docker.io")
    return "registry-1.docker.io";
  return reg;
}

/**
 * Parse an image reference into { registry, repository, reference }.
 * Examples:
 *   "ubuntu"                     -> registry-1.docker.io, library/ubuntu, latest
 *   "nginx:1.25"                 -> registry-1.docker.io, library/nginx, 1.25
 *   "myuser/myimage:v2"          -> registry-1.docker.io, myuser/myimage, v2
 *   "ghcr.io/owner/repo:sha256..." -> ghcr.io, owner/repo, sha256:...
 *   "localhost:5000/myimg"       -> localhost:5000, myimg, latest
 */
function parseImageRef(image) {
  if (!image || typeof image !== "string")
    throw new Error("registry_client: 'image' must be a non-empty string.");

  // Split off tag/digest reference (@sha256:...  or :tag)
  let ref = "latest";
  let name = image;

  const atIdx = name.indexOf("@");
  if (atIdx !== -1) {
    ref  = name.slice(atIdx + 1);
    name = name.slice(0, atIdx);
  } else {
    const lastColon = name.lastIndexOf(":");
    if (lastColon !== -1) {
      const afterColon = name.slice(lastColon + 1);
      if (!afterColon.includes("/")) {
        ref  = afterColon;
        name = name.slice(0, lastColon);
      }
    }
  }

  // Determine registry vs repository
  const parts = name.split("/");
  let registry   = "";
  let repository = "";

  const looksLikeRegistry = (s) =>
    s.includes(".") || s.includes(":") || s === "localhost";

  if (parts.length >= 2 && looksLikeRegistry(parts[0])) {
    registry   = parts[0];
    repository = parts.slice(1).join("/");
  } else {
    registry   = "docker.io";
    if (parts.length === 1) {
      repository = `library/${parts[0]}`;
    } else {
      repository = parts.join("/");
    }
  }

  registry = normaliseRegistry(registry);
  return { registry, repository, reference: ref };
}

/**
 * Low-level HTTP(S) request with auth header injection.
 * Returns { status, headers, body (Buffer) }.
 */
function rawRequest({ url, method = "GET", headers = {}, timeout = DEFAULT_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) {
      return reject(new Error(`registry_client: invalid URL '${url}': ${e.message}`));
    }

    const driver = parsed.protocol === "http:" ? http : https;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { "User-Agent": "mcp-common-server/registry-client", ...headers },
      timeout,
    };

    const req = driver.request(options, (res) => {
      const chunks = [];
      let received  = 0;

      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new Error(
            `registry_client: response too large (>${MAX_RESPONSE_BYTES} bytes) from ${url}`,
          ));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        resolve({
          status:  res.statusCode,
          headers: res.headers,
          body:    Buffer.concat(chunks),
        });
      });

      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`registry_client: request timed out after ${timeout}ms (${url})`));
    });

    req.on("error", (e) => {
      reject(new Error(`registry_client: network error -- ${e.message} (${url})`));
    });

    req.end();
  });
}

/**
 * Obtain a Bearer token from the registry's auth challenge.
 * Parses:  WWW-Authenticate: Bearer realm="...",service="...",scope="..."
 */
async function fetchBearerToken(wwwAuth, credentials, timeout) {
  const realmM   = wwwAuth.match(/realm="([^"]+)"/);
  const serviceM = wwwAuth.match(/service="([^"]+)"/);
  const scopeM   = wwwAuth.match(/scope="([^"]+)"/);

  if (!realmM) throw new Error(`registry_client: cannot parse Bearer realm from: ${wwwAuth}`);

  const realm   = realmM[1];
  const params  = new URLSearchParams();
  if (serviceM) params.set("service", serviceM[1]);
  if (scopeM)   params.set("scope",   scopeM[1]);

  const tokenUrl = `${realm}?${params.toString()}`;
  const headers  = {};
  if (credentials && credentials.username) {
    const b64 = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
    headers.Authorization = `Basic ${b64}`;
  }

  const res = await rawRequest({ url: tokenUrl, headers, timeout });
  if (res.status !== 200)
    throw new Error(
      `registry_client: token request failed -- HTTP ${res.status} from ${tokenUrl}`,
    );

  let parsed;
  try { parsed = JSON.parse(res.body.toString("utf8")); }
  catch { throw new Error("registry_client: invalid JSON in token response."); }

  const token = parsed.token || parsed.access_token;
  if (!token)
    throw new Error("registry_client: no token in auth response.");
  return token;
}

/**
 * High-level authenticated request.
 * Handles: anonymous, Basic, Bearer (auto-negotiated via 401 challenge).
 */
async function apiRequest({
  registry, path, method = "GET", extraHeaders = {},
  credentials, insecure = false, timeout = DEFAULT_TIMEOUT,
}) {
  const scheme = insecure ? "http" : "https";
  const url    = `${scheme}://${registry}${path}`;

  const headers = { ...extraHeaders };
  if (credentials && credentials.token) {
    headers.Authorization = `Bearer ${credentials.token}`;
  } else if (credentials && credentials.username) {
    const b64 = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64");
    headers.Authorization = `Basic ${b64}`;
  }

  let res = await rawRequest({ url, method, headers, timeout });

  // Bearer challenge handling (401)
  if (res.status === 401) {
    const wwwAuth = res.headers["www-authenticate"] || "";
    if (wwwAuth.toLowerCase().startsWith("bearer ")) {
      const creds = (credentials && credentials.username) ? credentials : null;
      const token = await fetchBearerToken(wwwAuth, creds, timeout);
      const retryHeaders = { ...extraHeaders, Authorization: `Bearer ${token}` };
      res = await rawRequest({ url, method, headers: retryHeaders, timeout });
    }
  }

  return res;
}

/**
 * Parse a JSON body; throw a descriptive error on failure.
 */
function parseJsonBody(body, context) {
  const text = body.toString("utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `registry_client: expected JSON from ${context} but got: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Decode a registry error body into a human-readable string.
 */
function registryErrorMessage(status, body) {
  const text = body.toString("utf8").slice(0, 500);
  try {
    const parsed = JSON.parse(text);
    const errs   = parsed.errors || [];
    if (errs.length) {
      return errs.map((e) => `${e.code}: ${e.message}`).join("; ");
    }
  } catch { /* ignored */ }
  return `HTTP ${status} -- ${text || "(empty body)"}`;
}

// ─── operations ───────────────────────────────────────────────────────────────

async function opPing({ registry, credentials, insecure, timeout }) {
  const res = await apiRequest({
    registry, path: "/v2/", credentials, insecure, timeout,
  });

  const reachable = res.status === 200 || res.status === 401;
  let authScheme = "none";
  if (res.headers["www-authenticate"]) {
    const wa = res.headers["www-authenticate"].toLowerCase();
    if      (wa.startsWith("bearer")) authScheme = "bearer";
    else if (wa.startsWith("basic"))  authScheme = "basic";
    else                              authScheme = "other";
  }

  return {
    registry,
    reachable,
    apiVersion: res.headers["docker-distribution-api-version"] || null,
    authScheme,
    status: res.status,
  };
}

async function opTags({ registry, repository, credentials, insecure, timeout, limit, last }) {
  const cap    = Math.min(Math.max(1, limit || 1000), MAX_TAGS);
  const params = new URLSearchParams();
  params.set("n", String(cap));
  if (last) params.set("last", last);

  const qs   = `?${params.toString()}`;
  const path = `/v2/${repository}/tags/list${qs}`;

  const res = await apiRequest({ registry, path, credentials, insecure, timeout });

  if (res.status !== 200) {
    throw new Error(
      `registry_client tags: ${registryErrorMessage(res.status, res.body)} (${registry}/${repository})`,
    );
  }

  const parsed = parseJsonBody(res.body, `${registry}/${repository}/tags/list`);
  const tags   = parsed.tags || [];

  const linkHeader = res.headers["link"] || "";
  let   nextRef    = null;
  const linkMatch  = linkHeader.match(/<[^>]+[?&]last=([^&>]+)[^>]*>;\s*rel="next"/);
  if (linkMatch) nextRef = decodeURIComponent(linkMatch[1]);

  return {
    registry,
    repository,
    totalTags: tags.length,
    tags,
    next: nextRef,
  };
}

async function opManifest({ registry, repository, reference, credentials, insecure, timeout }) {
  const path = `/v2/${repository}/manifests/${reference}`;
  const res  = await apiRequest({
    registry, path, credentials, insecure, timeout,
    extraHeaders: { Accept: MANIFEST_ACCEPT },
  });

  if (res.status !== 200) {
    throw new Error(
      `registry_client manifest: ${registryErrorMessage(res.status, res.body)} ` +
      `(${registry}/${repository}:${reference})`,
    );
  }

  const digest      = res.headers["docker-content-digest"] || null;
  const contentType = res.headers["content-type"] || "";
  const parsed      = parseJsonBody(res.body, `manifest ${registry}/${repository}:${reference}`);

  let manifestType = "unknown";
  const mt = contentType.split(";")[0].trim();
  if (mt.includes("oci.image.index"))         manifestType = "oci_index";
  else if (mt.includes("oci.image.manifest")) manifestType = "oci_manifest";
  else if (mt.includes("manifest.list"))      manifestType = "docker_manifest_list";
  else if (mt.includes("manifest.v2"))        manifestType = "docker_manifest_v2";
  else if (mt.includes("manifest.v1"))        manifestType = "docker_manifest_v1";

  let layers    = [];
  let platforms = [];

  if (parsed.layers) {
    layers = parsed.layers.map((l) => ({
      digest:    l.digest,
      mediaType: l.mediaType,
      size:      l.size,
    }));
  }
  if (parsed.manifests) {
    platforms = parsed.manifests.map((m) => ({
      digest:    m.digest,
      mediaType: m.mediaType,
      size:      m.size,
      platform:  m.platform || null,
    }));
  }

  return {
    registry,
    repository,
    reference,
    digest,
    mediaType: mt || null,
    manifestType,
    schemaVersion: parsed.schemaVersion,
    layerCount:    layers.length,
    layers,
    platformCount: platforms.length,
    platforms,
    config: parsed.config || null,
    raw:    parsed,
  };
}

async function opConfig({ registry, repository, reference, credentials, insecure, timeout }) {
  const manifest = await opManifest({
    registry, repository, reference, credentials, insecure, timeout,
  });

  if (!manifest.config || !manifest.config.digest) {
    throw new Error(
      `registry_client config: no config descriptor in manifest for ` +
      `${registry}/${repository}:${reference}. ` +
      `(This may be a manifest list -- specify a platform-specific digest.)`,
    );
  }

  const configDigest = manifest.config.digest;
  const path         = `/v2/${repository}/blobs/${configDigest}`;
  const res          = await apiRequest({ registry, path, credentials, insecure, timeout });

  if (res.status !== 200) {
    throw new Error(
      `registry_client config: ${registryErrorMessage(res.status, res.body)} ` +
      `(config blob ${configDigest})`,
    );
  }

  const config       = parseJsonBody(res.body, `config blob ${configDigest}`);
  const rootfs       = config.rootfs  || {};
  const containerCfg = config.config  || {};

  return {
    registry,
    repository,
    reference,
    configDigest,
    created:      config.created      || null,
    author:       config.author       || null,
    os:           config.os           || null,
    architecture: config.architecture || null,
    variant:      config.variant      || null,
    osVersion:    config.os_version   || null,
    hostname:     containerCfg.Hostname     || null,
    user:         containerCfg.User         || null,
    env:          containerCfg.Env          || [],
    entrypoint:   containerCfg.Entrypoint   || [],
    cmd:          containerCfg.Cmd          || [],
    workingDir:   containerCfg.WorkingDir   || null,
    exposedPorts: containerCfg.ExposedPorts ? Object.keys(containerCfg.ExposedPorts) : [],
    volumes:      containerCfg.Volumes      ? Object.keys(containerCfg.Volumes) : [],
    labels:       containerCfg.Labels       || {},
    rootfsType:   rootfs.type         || null,
    diffIds:      rootfs.diff_ids     || [],
    layerCount:   (rootfs.diff_ids || []).length,
    history: (config.history || []).map((h) => ({
      created:    h.created    || null,
      createdBy:  h.created_by || null,
      emptyLayer: h.empty_layer || false,
      comment:    h.comment    || null,
    })),
  };
}

async function opLayers({ registry, repository, reference, credentials, insecure, timeout }) {
  const manifest = await opManifest({
    registry, repository, reference, credentials, insecure, timeout,
  });

  if (manifest.layers.length === 0 && manifest.platforms.length > 0) {
    throw new Error(
      `registry_client layers: '${registry}/${repository}:${reference}' is a multi-platform ` +
      `manifest list. Specify a platform-specific digest to retrieve layers.`,
    );
  }

  const totalBytes = manifest.layers.reduce((acc, l) => acc + (l.size || 0), 0);
  return {
    registry,
    repository,
    reference,
    digest:     manifest.digest,
    layerCount: manifest.layers.length,
    totalBytes,
    totalMB:    Number((totalBytes / (1024 * 1024)).toFixed(2)),
    layers:     manifest.layers,
  };
}

async function opExists({ registry, repository, reference, credentials, insecure, timeout }) {
  const path = `/v2/${repository}/manifests/${reference}`;
  const res  = await apiRequest({
    registry, path, method: "HEAD", credentials, insecure, timeout,
    extraHeaders: { Accept: MANIFEST_ACCEPT },
  });

  const exists = res.status === 200;
  return {
    registry,
    repository,
    reference,
    exists,
    digest: res.headers["docker-content-digest"] || null,
    status: res.status,
  };
}

async function opDigest({ registry, repository, reference, credentials, insecure, timeout }) {
  const path = `/v2/${repository}/manifests/${reference}`;
  const res  = await apiRequest({
    registry, path, method: "HEAD", credentials, insecure, timeout,
    extraHeaders: { Accept: MANIFEST_ACCEPT },
  });

  if (res.status !== 200) {
    throw new Error(
      `registry_client digest: ${registryErrorMessage(res.status, res.body)} ` +
      `(${registry}/${repository}:${reference})`,
    );
  }

  const digest = res.headers["docker-content-digest"];
  if (!digest)
    throw new Error(
      `registry_client digest: registry did not return Docker-Content-Digest header ` +
      `(${registry}/${repository}:${reference})`,
    );

  return {
    registry,
    repository,
    reference,
    digest,
    contentType: res.headers["content-type"] || null,
  };
}

// ─── main entry point ─────────────────────────────────────────────────────────

async function registryClient(args) {
  const op = args.operation;
  if (!op)
    throw new Error("registry_client: 'operation' is required.");

  const VALID_OPS = ["ping", "tags", "manifest", "config", "layers", "exists", "digest"];
  if (!VALID_OPS.includes(op))
    throw new Error(
      `registry_client: unknown operation '${op}'. Valid: ${VALID_OPS.join(", ")}.`,
    );

  const insecure = !!args.insecure;
  const timeout  = Math.max(1000, Math.min(300_000, args.timeout ?? DEFAULT_TIMEOUT));

  const credentials =
    (args.token)
      ? { token: args.token }
      : (args.username || args.password)
        ? { username: args.username || "", password: args.password || "" }
        : null;

  if (op === "ping") {
    if (!args.registry)
      throw new Error("registry_client ping: 'registry' is required (e.g. 'registry-1.docker.io').");
    const registry = normaliseRegistry(args.registry);
    return opPing({ registry, credentials, insecure, timeout });
  }

  let registry, repository, reference;

  if (args.image != null) {  // includes empty string — parseImageRef throws 'non-empty string'
    ({ registry, repository, reference } = parseImageRef(args.image));
    if (args.registry)   registry   = normaliseRegistry(args.registry);
    if (args.repository) repository = args.repository;
    if (args.reference)  reference  = args.reference;
    if (args.tag)        reference  = args.tag;
    if (args.digest && args.digest.startsWith("sha256:")) reference = args.digest;
  } else if (args.registry && args.repository) {
    registry   = normaliseRegistry(args.registry);
    repository = args.repository;
    reference  = args.reference || args.tag || args.digest || "latest";
  } else {
    throw new Error(
      `registry_client ${op}: provide 'image' (e.g. 'nginx:1.25') ` +
      `or both 'registry' and 'repository'.`,
    );
  }

  for (const [k, v] of Object.entries({ registry, repository, reference })) {
    if (typeof v === "string" && v.includes("\0"))
      throw new Error(`registry_client: '${k}' must not contain NUL bytes.`);
  }

  switch (op) {
    case "tags":
      return opTags({
        registry, repository, credentials, insecure, timeout,
        limit: args.limit,
        last:  args.last,
      });
    case "manifest":
      return opManifest({ registry, repository, reference, credentials, insecure, timeout });
    case "config":
      return opConfig({ registry, repository, reference, credentials, insecure, timeout });
    case "layers":
      return opLayers({ registry, repository, reference, credentials, insecure, timeout });
    case "exists":
      return opExists({ registry, repository, reference, credentials, insecure, timeout });
    case "digest":
      return opDigest({ registry, repository, reference, credentials, insecure, timeout });
    default:
      throw new Error(`registry_client: unhandled operation '${op}'.`);
  }
}

module.exports = { registryClient, parseImageRef, normaliseRegistry };
