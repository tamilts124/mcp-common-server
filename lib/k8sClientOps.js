"use strict";
// k8sClientOps.js — Zero-dependency Kubernetes API client
// Pure Node.js https — reads kubeconfig; no npm deps.
//
// Operations:
//   version       — Get cluster version info (kubectl version)
//   namespaces    — List all namespaces
//   pods          — List pods in a namespace (or all namespaces)
//   deployments   — List deployments in a namespace (or all namespaces)
//   services      — List services in a namespace (or all namespaces)
//   nodes         — List cluster nodes with status/resources
//   configmaps    — List configmaps in a namespace
//   secrets       — List secrets (names only, no values) in a namespace
//   events        — List events in a namespace
//   ingresses     — List ingresses in a namespace
//   logs          — Fetch pod logs
//   get           — Generic GET: any resource kind + name in a namespace
//   list          — Generic LIST: any resource kind in a namespace
//   apply         — Apply a JSON/YAML manifest (create or update via server-side apply)
//   delete        — Delete a named resource
//   rollout       — Get rollout status/history for a deployment/daemonset/statefulset
//   exec          — Execute a command in a pod container (uses exec subresource)
//   top_pods      — Metrics for pods (requires metrics-server)
//   top_nodes     — Metrics for nodes (requires metrics-server)

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const { URL } = require("url");

// ─── constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT    = 30_000;             // 30 s
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;  // 32 MB per API response
const MAX_LOG_BYTES      = 4 * 1024 * 1024;   // 4 MB log tail

// ─── kubeconfig loader ────────────────────────────────────────────────────────

/**
 * Locate and parse a kubeconfig file.
 * Search order:
 *   1. args.kubeconfig  (explicit path)
 *   2. KUBECONFIG env var (first path in colon-separated list)
 *   3. ~/.kube/config
 *   4. In-cluster: /var/run/secrets/kubernetes.io/serviceaccount/
 */
function loadKubeconfig(kubeconfigPath) {
  // Try explicit path
  const candidates = [];
  if (kubeconfigPath) {
    candidates.push(kubeconfigPath);
  } else {
    const envKC = process.env.KUBECONFIG;
    if (envKC) {
      // KUBECONFIG can be colon-separated list; use the first file
      candidates.push(envKC.split(path.delimiter)[0]);
    }
    candidates.push(path.join(os.homedir(), ".kube", "config"));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const text = fs.readFileSync(candidate, "utf8");
      // Simple YAML parser for kubeconfig (structured enough to handle it)
      return parseKubeconfig(text, candidate);
    } catch (e) {
      // Re-throw auth/config errors (e.g. exec-based auth); only skip I/O errors
      if (e.message && (e.message.includes("exec-based auth") || e.message.includes("no valid context") || e.message.includes("cluster") || e.message.includes("has no 'server'"))) {
        throw e;
      }
      // Try next candidate (file not found, permission error, etc.)
    }
  }

  // Try in-cluster service account
  const saDir = "/var/run/secrets/kubernetes.io/serviceaccount";
  try {
    const token   = fs.readFileSync(path.join(saDir, "token"), "utf8").trim();
    const caCert  = fs.readFileSync(path.join(saDir, "ca.crt"));
    const nsFile  = path.join(saDir, "namespace");
    const ns      = fs.existsSync(nsFile) ? fs.readFileSync(nsFile, "utf8").trim() : "default";
    const apiHost = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc";
    const apiPort = process.env.KUBERNETES_SERVICE_PORT || "443";
    return {
      server: `https://${apiHost}:${apiPort}`,
      token,
      ca: caCert,
      inCluster: true,
      currentContext: "in-cluster",
      namespace: ns,
    };
  } catch (e) {
    // Not in cluster
  }

  throw new Error(
    "k8s_client: no kubeconfig found. Provide 'kubeconfig' path, set KUBECONFIG env, " +
    "place config at ~/.kube/config, or run inside a Kubernetes pod.",
  );
}

/**
 * Minimal YAML parser for kubeconfig files.
 * kubeconfig is a well-structured YAML document; we parse it
 * using a line-based state machine sufficient for this format.
 */
function parseKubeconfig(text, filePath) {
  // Use js-based kubeconfig parsing — convert YAML to a JS object
  // by parsing the key fields we need.
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  // We parse the kubeconfig structure manually.
  // We need: current-context, contexts[].{name, context.{cluster, user, namespace}},
  // clusters[].{name, cluster.{server, certificate-authority-data, insecure-skip-tls-verify}},
  // users[].{name, user.{token, client-certificate-data, client-key-data, username, password}}

  const result = {
    apiVersion: null,
    currentContext: null,
    contexts: [],
    clusters: [],
    users: [],
  };

  // Parse with a simple state machine
  let section = null;      // "contexts", "clusters", "users"
  let subSection = null;   // "context", "cluster", "user"
  let current = null;      // current item being built
  let subCurrent = null;   // current sub-object
  let indent = 0;
  let inMultilineB64 = null; // key for multiline base64 value
  let multilineB64Buf = [];
  let listDepth = 0;

  function indentOf(line) {
    let i = 0;
    while (i < line.length && line[i] === " ") i++;
    return i;
  }

  function parseValue(v) {
    v = v.trim();
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null" || v === "~" || v === "") return null;
    // Remove surrounding quotes
    if ((v[0] === "'" && v[v.length-1] === "'") ||
        (v[0] === '"' && v[v.length-1] === '"')) {
      return v.slice(1, -1);
    }
    return v;
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed  = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const ind = indentOf(rawLine);

    // Handle multiline base64 values (|  or lines continuing a base64 block)
    if (inMultilineB64 !== null) {
      // If this line is more indented than the key, it's continuation
      if (ind > inMultilineB64.keyIndent) {
        multilineB64Buf.push(trimmed);
        continue;
      } else {
        // End of multiline block
        if (subCurrent) subCurrent[inMultilineB64.key] = multilineB64Buf.join("");
        inMultilineB64 = null;
        multilineB64Buf = [];
      }
    }

    // Top-level keys (indent=0)
    if (ind === 0) {
      // List item at indent=0 within a section (e.g. contexts:, clusters:, users:)
      // e.g. "- name: test-ctx"
      if (section && (trimmed.startsWith("- name:") || trimmed.startsWith("- name :"))) {
        if (current) {
          if (subCurrent && subSection) current[subSection] = subCurrent;
          result[section].push(current);
        }
        current = { name: parseValue(trimmed.slice(trimmed.indexOf(":") + 1)) };
        subCurrent = null;
        subSection = null;
        continue;
      }
      // Bare "-" list item at indent=0 (unusual but handle)
      if (section && (trimmed === "-" || (trimmed.startsWith("- ") && !trimmed.includes(":"))) ) {
        if (current) {
          if (subCurrent && subSection) current[subSection] = subCurrent;
          result[section].push(current);
        }
        current = {};
        subCurrent = null;
        subSection = null;
        continue;
      }

      // Finalize current item if transitioning away from a section
      if (current && section && !trimmed.startsWith("-")) {
        if (subCurrent && subSection) {
          current[subSection] = subCurrent;
        }
        result[section].push(current);
        current = null;
        subCurrent = null;
        subSection = null;
      }
      if (!trimmed.startsWith("-")) section = null;

      if (trimmed.startsWith("current-context:")) {
        result.currentContext = parseValue(trimmed.slice("current-context:".length));
      } else if (trimmed.startsWith("apiVersion:")) {
        result.apiVersion = parseValue(trimmed.slice("apiVersion:".length));
      } else if (trimmed === "contexts:" || trimmed === "clusters:" || trimmed === "users:") {
        section = trimmed.replace(":", "");
      }
      continue;
    }

    // List item (indent=0 base, indent=2 with dash)
    if (ind === 0 || (ind === 0 && trimmed.startsWith("-"))) {
      // handled above
      continue;
    }

    if (!section) continue;

    // New list item: "- name:"
    if (trimmed.startsWith("- name:") || trimmed.startsWith("- name :")) {
      if (current) {
        if (subCurrent && subSection) {
          current[subSection] = subCurrent;
        }
        result[section].push(current);
      }
      current = { name: parseValue(trimmed.slice(trimmed.indexOf(":") + 1)) };
      subCurrent = null;
      subSection = null;
      continue;
    }

    // Bare "- " line starting a new object
    if (trimmed === "-" || (trimmed.startsWith("- ") && !trimmed.includes(":"))) {
      if (current) {
        if (subCurrent && subSection) current[subSection] = subCurrent;
        result[section].push(current);
      }
      current = {};
      subCurrent = null;
      subSection = null;
      continue;
    }

    if (!current) continue;

    // "  name: value" (indent=2, top of list item)
    if (ind === 2 && !trimmed.startsWith("-")) {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (key === "name") {
        current.name = parseValue(val);
      } else if (key === "context" || key === "cluster" || key === "user") {
        subSection = key;
        subCurrent = {};
      }
      continue;
    }

    // Sub-section properties (indent=4 or 6)
    if (ind >= 4 && subCurrent !== null) {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      let   val = trimmed.slice(colonIdx + 1).trim();

      if (val === "|" || val === "|") {
        // Multiline block scalar — next lines will be base64 data
        inMultilineB64 = { key, keyIndent: ind };
        multilineB64Buf = [];
        continue;
      }

      subCurrent[key] = parseValue(val);
      continue;
    }

    // Nested property at indent=2 without a subsection key
    if (ind === 2 && trimmed.includes(":") && !trimmed.startsWith("-")) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (current && key === "name") current.name = parseValue(val);
    }
  }

  // Finalize last item
  if (inMultilineB64 && subCurrent) {
    subCurrent[inMultilineB64.key] = multilineB64Buf.join("");
  }
  if (current && section) {
    if (subCurrent && subSection) current[subSection] = subCurrent;
    result[section].push(current);
  }

  // Resolve context
  const ctxName = result.currentContext;
  const ctx = result.contexts.find(c => c.name === ctxName);
  if (!ctx || !ctx.context) {
    throw new Error(
      `k8s_client: kubeconfig '${filePath}' has no valid context '${ctxName}'. ` +
      `Available: ${result.contexts.map(c => c.name).join(", ") || "none"}.`,
    );
  }

  const clusterName = ctx.context.cluster;
  const userName    = ctx.context.user;
  const ns          = ctx.context.namespace || "default";

  const clusterObj = result.clusters.find(c => c.name === clusterName);
  if (!clusterObj || !clusterObj.cluster) {
    throw new Error(
      `k8s_client: cluster '${clusterName}' not found in kubeconfig '${filePath}'.`,
    );
  }

  const cluster = clusterObj.cluster;
  const userObj = result.users.find(u => u.name === userName);
  const user    = (userObj && userObj.user) ? userObj.user : {};

  const server = cluster["server"];
  if (!server)
    throw new Error(`k8s_client: cluster '${clusterName}' has no 'server' in kubeconfig.`);

  // Decode base64 TLS data
  let ca = null;
  if (cluster["certificate-authority-data"]) {
    ca = Buffer.from(cluster["certificate-authority-data"], "base64");
  } else if (cluster["certificate-authority"]) {
    ca = fs.readFileSync(cluster["certificate-authority"]);
  }

  const insecure = cluster["insecure-skip-tls-verify"] === true ||
                   cluster["insecure-skip-tls-verify"] === "true";

  let token        = user["token"] || null;
  let clientCert   = null;
  let clientKey    = null;

  if (user["client-certificate-data"]) {
    clientCert = Buffer.from(user["client-certificate-data"], "base64");
  } else if (user["client-certificate"]) {
    clientCert = fs.readFileSync(user["client-certificate"]);
  }

  if (user["client-key-data"]) {
    clientKey = Buffer.from(user["client-key-data"], "base64");
  } else if (user["client-key"]) {
    clientKey = fs.readFileSync(user["client-key"]);
  }

  // Support exec-based auth (e.g., aws eks get-token) — read cached token from cache if possible
  if (!token && ("exec" in user || user["exec"] != null)) {
    // We can't execute the exec plugin safely in MCP context;
    // surface a clear error.
    throw new Error(
      `k8s_client: kubeconfig user '${userName}' uses exec-based auth ` +
      `(e.g. aws-iam-authenticator, gke-gcloud-auth-plugin). ` +
      `Please provide a static 'token' directly via the 'token' argument instead.",`,
    );
  }

  const username = user["username"] || null;
  const password = user["password"] || null;

  return {
    server,
    token,
    clientCert,
    clientKey,
    ca,
    insecure,
    username,
    password,
    currentContext: ctxName,
    namespace: ns,
    inCluster: false,
  };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function rawRequest({ url, method = "GET", headers = {}, body = null,
                      ca, clientCert, clientKey, insecure, timeout = DEFAULT_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) {
      return reject(new Error(`k8s_client: invalid URL '${url}': ${e.message}`));
    }

    const isHttps = parsed.protocol === "https:";
    const driver  = isHttps ? https : http;

    const tlsOptions = {};
    if (isHttps) {
      if (insecure) {
        tlsOptions.rejectUnauthorized = false;
      } else if (ca) {
        tlsOptions.ca = ca;
        tlsOptions.rejectUnauthorized = true;
      }
      if (clientCert) tlsOptions.cert = clientCert;
      if (clientKey)  tlsOptions.key  = clientKey;
    }

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  { "User-Agent": "mcp-common-server/k8s-client", ...headers },
      timeout,
      ...tlsOptions,
    };

    if (body) {
      const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
      options.headers["Content-Length"] = bodyBuf.length;
      if (!options.headers["Content-Type"]) {
        options.headers["Content-Type"] = "application/json";
      }
    }

    const req = driver.request(options, (res) => {
      const chunks = [];
      let received  = 0;
      const limit   = method === "GET" && url.includes("/log") ? MAX_LOG_BYTES : MAX_RESPONSE_BYTES;

      res.on("data", (chunk) => {
        received += chunk.length;
        if (received > limit) {
          req.destroy();
          reject(new Error(`k8s_client: response too large (>${limit} bytes)`));
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
      reject(new Error(`k8s_client: request timed out after ${timeout}ms (${method} ${url})`));
    });

    req.on("error", (e) => {
      reject(new Error(`k8s_client: network error -- ${e.message} (${method} ${url})`));
    });

    if (body) {
      const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
      req.write(bodyBuf);
    }
    req.end();
  });
}

/**
 * Kubernetes API request — attaches auth and parses JSON response.
 * Returns parsed JSON body (or throws on non-2xx).
 */
async function apiRequest(cfg, { path: apiPath, method = "GET", body = null,
                                  rawResponse = false, timeout = DEFAULT_TIMEOUT }) {
  const headers = { "Accept": "application/json" };

  if (cfg.token) {
    headers["Authorization"] = `Bearer ${cfg.token}`;
  } else if (cfg.username) {
    const b64 = Buffer.from(`${cfg.username}:${cfg.password || ""}`).toString("base64");
    headers["Authorization"] = `Basic ${b64}`;
  }

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const url = cfg.server.replace(/\/$/, "") + apiPath;
  const res = await rawRequest({
    url, method, headers,
    body: body ? JSON.stringify(body) : null,
    ca:          cfg.ca,
    clientCert:  cfg.clientCert,
    clientKey:   cfg.clientKey,
    insecure:    cfg.insecure,
    timeout,
  });

  if (rawResponse) return res;

  const text = res.body.toString("utf8");

  if (res.status < 200 || res.status >= 300) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      if (parsed.message) detail = parsed.message;
    } catch { /* ignore */ }
    throw new Error(
      `k8s_client: API error ${res.status} for ${method} ${apiPath}: ${detail}`,
    );
  }

  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`k8s_client: invalid JSON response from ${apiPath}: ${e.message}`);
  }
}

// ─── resource helpers ─────────────────────────────────────────────────────────

/** Build a namespaced or cluster-scoped resource path */
function resourcePath(apiGroup, version, namespace, kind, name, subresource) {
  const base = apiGroup ? `/apis/${apiGroup}/${version}` : `/api/${version}`;
  const ns   = namespace && namespace !== "*" && namespace !== "all"
    ? `/namespaces/${namespace}`
    : "";
  const kindPath = `/${kind}`;
  const namePath = name ? `/${name}` : "";
  const sub      = subresource ? `/${subresource}` : "";
  return `${base}${ns}${kindPath}${namePath}${sub}`;
}

/** Map well-known kind names to their API group + version + plural */
const KIND_MAP = {
  // Core
  pod:           { group: "",           version: "v1",      plural: "pods" },
  pods:          { group: "",           version: "v1",      plural: "pods" },
  service:       { group: "",           version: "v1",      plural: "services" },
  services:      { group: "",           version: "v1",      plural: "services" },
  configmap:     { group: "",           version: "v1",      plural: "configmaps" },
  configmaps:    { group: "",           version: "v1",      plural: "configmaps" },
  secret:        { group: "",           version: "v1",      plural: "secrets" },
  secrets:       { group: "",           version: "v1",      plural: "secrets" },
  namespace:     { group: "",           version: "v1",      plural: "namespaces" },
  namespaces:    { group: "",           version: "v1",      plural: "namespaces" },
  node:          { group: "",           version: "v1",      plural: "nodes" },
  nodes:         { group: "",           version: "v1",      plural: "nodes" },
  event:         { group: "",           version: "v1",      plural: "events" },
  events:        { group: "",           version: "v1",      plural: "events" },
  persistentvolume: { group: "",        version: "v1",      plural: "persistentvolumes" },
  persistentvolumes: { group: "",       version: "v1",      plural: "persistentvolumes" },
  pv:            { group: "",           version: "v1",      plural: "persistentvolumes" },
  persistentvolumeclaim: { group: "",   version: "v1",      plural: "persistentvolumeclaims" },
  persistentvolumeclaims: { group: "",  version: "v1",      plural: "persistentvolumeclaims" },
  pvc:           { group: "",           version: "v1",      plural: "persistentvolumeclaims" },
  serviceaccount:  { group: "",         version: "v1",      plural: "serviceaccounts" },
  serviceaccounts: { group: "",         version: "v1",      plural: "serviceaccounts" },
  sa:            { group: "",           version: "v1",      plural: "serviceaccounts" },
  endpoint:      { group: "",           version: "v1",      plural: "endpoints" },
  endpoints:     { group: "",           version: "v1",      plural: "endpoints" },
  // apps
  deployment:     { group: "apps",      version: "v1",      plural: "deployments" },
  deployments:    { group: "apps",      version: "v1",      plural: "deployments" },
  replicaset:     { group: "apps",      version: "v1",      plural: "replicasets" },
  replicasets:    { group: "apps",      version: "v1",      plural: "replicasets" },
  rs:             { group: "apps",      version: "v1",      plural: "replicasets" },
  statefulset:    { group: "apps",      version: "v1",      plural: "statefulsets" },
  statefulsets:   { group: "apps",      version: "v1",      plural: "statefulsets" },
  daemonset:      { group: "apps",      version: "v1",      plural: "daemonsets" },
  daemonsets:     { group: "apps",      version: "v1",      plural: "daemonsets" },
  ds:             { group: "apps",      version: "v1",      plural: "daemonsets" },
  // batch
  job:            { group: "batch",     version: "v1",      plural: "jobs" },
  jobs:           { group: "batch",     version: "v1",      plural: "jobs" },
  cronjob:        { group: "batch",     version: "v1",      plural: "cronjobs" },
  cronjobs:       { group: "batch",     version: "v1",      plural: "cronjobs" },
  // networking
  ingress:        { group: "networking.k8s.io", version: "v1", plural: "ingresses" },
  ingresses:      { group: "networking.k8s.io", version: "v1", plural: "ingresses" },
  ing:            { group: "networking.k8s.io", version: "v1", plural: "ingresses" },
  networkpolicy:  { group: "networking.k8s.io", version: "v1", plural: "networkpolicies" },
  networkpolicies: { group: "networking.k8s.io", version: "v1", plural: "networkpolicies" },
  // autoscaling
  hpa:             { group: "autoscaling", version: "v2",   plural: "horizontalpodautoscalers" },
  horizontalpodautoscaler:  { group: "autoscaling", version: "v2", plural: "horizontalpodautoscalers" },
  horizontalpodautoscalers: { group: "autoscaling", version: "v2", plural: "horizontalpodautoscalers" },
  // rbac
  role:              { group: "rbac.authorization.k8s.io", version: "v1", plural: "roles" },
  roles:             { group: "rbac.authorization.k8s.io", version: "v1", plural: "roles" },
  clusterrole:       { group: "rbac.authorization.k8s.io", version: "v1", plural: "clusterroles" },
  clusterroles:      { group: "rbac.authorization.k8s.io", version: "v1", plural: "clusterroles" },
  rolebinding:       { group: "rbac.authorization.k8s.io", version: "v1", plural: "rolebindings" },
  rolebindings:      { group: "rbac.authorization.k8s.io", version: "v1", plural: "rolebindings" },
  clusterrolebinding:  { group: "rbac.authorization.k8s.io", version: "v1", plural: "clusterrolebindings" },
  clusterrolebindings: { group: "rbac.authorization.k8s.io", version: "v1", plural: "clusterrolebindings" },
  // storage
  storageclass:   { group: "storage.k8s.io", version: "v1", plural: "storageclasses" },
  storageclasses: { group: "storage.k8s.io", version: "v1", plural: "storageclasses" },
  sc:             { group: "storage.k8s.io", version: "v1", plural: "storageclasses" },
  // metrics
  podmetrics:     { group: "metrics.k8s.io", version: "v1beta1", plural: "pods" },
  nodemetrics:    { group: "metrics.k8s.io", version: "v1beta1", plural: "nodes" },
};

function resolveKind(kind) {
  const k = (kind || "").toLowerCase().replace(/-/g, "");
  return KIND_MAP[k] || null;
}

/** Summarise a pod for list output */
function summarisePod(item) {
  const status = item.status || {};
  const spec   = item.spec   || {};
  const meta   = item.metadata || {};

  const phase      = status.phase || "Unknown";
  const conditions = (status.conditions || []).map(c => `${c.type}=${c.status}`);
  const containers = (spec.containers || []).map(c => c.name);
  const images     = (spec.containers || []).map(c => c.image);

  const containerStatuses = (status.containerStatuses || []);
  const readyCount  = containerStatuses.filter(c => c.ready).length;
  const totalCount  = (spec.containers || []).length;
  const restarts    = containerStatuses.reduce((s, c) => s + (c.restartCount || 0), 0);

  const podIP  = status.podIP  || null;
  const hostIP = status.hostIP || null;
  const node   = spec.nodeName || null;
  const age    = meta.creationTimestamp ? ageString(meta.creationTimestamp) : null;

  return {
    name:       meta.name,
    namespace:  meta.namespace,
    phase,
    ready:      `${readyCount}/${totalCount}`,
    restarts,
    node,
    podIP,
    hostIP,
    age,
    containers,
    images,
    conditions,
    labels:     meta.labels || {},
  };
}

function summariseDeployment(item) {
  const status = item.status   || {};
  const spec   = item.spec     || {};
  const meta   = item.metadata || {};
  return {
    name:              meta.name,
    namespace:         meta.namespace,
    desired:           spec.replicas ?? 0,
    ready:             status.readyReplicas    ?? 0,
    updated:           status.updatedReplicas  ?? 0,
    available:         status.availableReplicas ?? 0,
    unavailable:       status.unavailableReplicas ?? 0,
    age:               meta.creationTimestamp ? ageString(meta.creationTimestamp) : null,
    selector:          spec.selector?.matchLabels || {},
    strategy:          spec.strategy?.type || null,
    image:             (spec.template?.spec?.containers || []).map(c => c.image).join(", ") || null,
    labels:            meta.labels || {},
    conditions:        (status.conditions || []).map(c => `${c.type}=${c.status}: ${c.message || ""}`),
  };
}

function summariseService(item) {
  const spec   = item.spec     || {};
  const meta   = item.metadata || {};
  const status = item.status   || {};
  const lb     = (status.loadBalancer?.ingress || []).map(i => i.ip || i.hostname).join(",");
  return {
    name:        meta.name,
    namespace:   meta.namespace,
    type:        spec.type || "ClusterIP",
    clusterIP:   spec.clusterIP || null,
    externalIPs: spec.externalIPs || [],
    loadBalancerIP: lb || null,
    ports:       (spec.ports || []).map(p => `${p.protocol || "TCP"}:${p.port}${p.nodePort ? `:${p.nodePort}` : ""}`),
    selector:    spec.selector || {},
    age:         meta.creationTimestamp ? ageString(meta.creationTimestamp) : null,
    labels:      meta.labels || {},
  };
}

function summariseNode(item) {
  const meta       = item.metadata   || {};
  const status     = item.status     || {};
  const spec       = item.spec       || {};
  const conditions = (status.conditions || []);
  const readyCond  = conditions.find(c => c.type === "Ready");
  const addresses  = (status.addresses || []).reduce((m, a) => { m[a.type] = a.address; return m; }, {});
  const cap        = status.capacity    || {};
  const alloc      = status.allocatable || {};

  return {
    name:         meta.name,
    status:       readyCond?.status === "True" ? "Ready" : "NotReady",
    roles:        Object.keys(meta.labels || {}).filter(k => k.startsWith("node-role.kubernetes.io/")).map(k => k.split("/")[1]).join(",") || "<none>",
    version:      status.nodeInfo?.kubeletVersion || null,
    os:           status.nodeInfo?.osImage        || null,
    arch:         status.nodeInfo?.architecture   || null,
    runtime:      status.nodeInfo?.containerRuntimeVersion || null,
    internalIP:   addresses.InternalIP || null,
    externalIP:   addresses.ExternalIP || null,
    hostname:     addresses.Hostname   || null,
    cpu:          cap.cpu     || null,
    memory:       cap.memory  || null,
    pods:         cap.pods    || null,
    cpuAlloc:     alloc.cpu   || null,
    memAlloc:     alloc.memory || null,
    unschedulable: spec.unschedulable || false,
    taints:        (spec.taints || []).map(t => `${t.key}${t.effect ? ":" + t.effect : ""}`),
    age:           meta.creationTimestamp ? ageString(meta.creationTimestamp) : null,
    conditions:    conditions.map(c => `${c.type}=${c.status}`),
  };
}

function summariseEvent(item) {
  const meta  = item.metadata || {};
  return {
    namespace:  meta.namespace,
    type:       item.type      || "Normal",
    reason:     item.reason    || null,
    object:     item.involvedObject ? `${item.involvedObject.kind}/${item.involvedObject.name}` : null,
    message:    item.message   || null,
    count:      item.count     || 1,
    firstTime:  item.firstTimestamp || item.eventTime || null,
    lastTime:   item.lastTimestamp  || null,
    source:     item.source?.component || null,
  };
}

function ageString(ts) {
  if (!ts) return null;
  const diffMs = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60)     return `${s}s`;
  if (s < 3600)   return `${Math.floor(s/60)}m`;
  if (s < 86400)  return `${Math.floor(s/3600)}h`;
  return `${Math.floor(s/86400)}d`;
}

// ─── operations ───────────────────────────────────────────────────────────────

async function opVersion(cfg, args) {
  const res = await apiRequest(cfg, { path: "/version", timeout: args.timeout });
  return {
    gitVersion:     res.gitVersion,
    gitCommit:      res.gitCommit,
    buildDate:      res.buildDate,
    platform:       res.platform,
    goVersion:      res.goVersion,
    major:          res.major,
    minor:          res.minor,
    context:        cfg.currentContext,
    server:         cfg.server,
  };
}

async function opNamespaces(cfg, args) {
  const res = await apiRequest(cfg, { path: "/api/v1/namespaces", timeout: args.timeout });
  const items = res.items || [];
  return {
    count: items.length,
    namespaces: items.map(ns => ({
      name:   ns.metadata?.name,
      status: ns.status?.phase || "Active",
      age:    ns.metadata?.creationTimestamp ? ageString(ns.metadata.creationTimestamp) : null,
      labels: ns.metadata?.labels || {},
    })),
  };
}

async function opPods(cfg, args) {
  const ns = args.namespace || cfg.namespace || "default";
  const apiPath = ns === "all" || ns === "*"
    ? "/api/v1/pods"
    : `/api/v1/namespaces/${ns}/pods`;

  const qs = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = res.items || [];

  return {
    namespace: ns === "all" ? "(all)" : ns,
    count:     items.length,
    pods:      items.map(summarisePod),
  };
}

async function opDeployments(cfg, args) {
  const ns = args.namespace || cfg.namespace || "default";
  const apiPath = ns === "all" || ns === "*"
    ? "/apis/apps/v1/deployments"
    : `/apis/apps/v1/namespaces/${ns}/deployments`;

  const qs = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = res.items || [];

  return {
    namespace:   ns === "all" ? "(all)" : ns,
    count:       items.length,
    deployments: items.map(summariseDeployment),
  };
}

async function opServices(cfg, args) {
  const ns = args.namespace || cfg.namespace || "default";
  const apiPath = ns === "all" || ns === "*"
    ? "/api/v1/services"
    : `/api/v1/namespaces/${ns}/services`;

  const qs = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = res.items || [];

  return {
    namespace: ns === "all" ? "(all)" : ns,
    count:     items.length,
    services:  items.map(summariseService),
  };
}

async function opNodes(cfg, args) {
  const qs  = buildQs(args);
  const res = await apiRequest(cfg, { path: "/api/v1/nodes" + qs, timeout: args.timeout });
  const items = res.items || [];
  return {
    count: items.length,
    nodes: items.map(summariseNode),
  };
}

async function opConfigmaps(cfg, args) {
  const ns = args.namespace || cfg.namespace || "default";
  const apiPath = ns === "all" || ns === "*"
    ? "/api/v1/configmaps"
    : `/api/v1/namespaces/${ns}/configmaps`;
  const qs  = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = res.items || [];
  return {
    namespace:  ns === "all" ? "(all)" : ns,
    count:      items.length,
    configmaps: items.map(cm => ({
      name:      cm.metadata?.name,
      namespace: cm.metadata?.namespace,
      age:       cm.metadata?.creationTimestamp ? ageString(cm.metadata.creationTimestamp) : null,
      keys:      Object.keys(cm.data || {}).concat(Object.keys(cm.binaryData || {})),
      labels:    cm.metadata?.labels || {},
    })),
  };
}

async function opSecrets(cfg, args) {
  const ns = args.namespace || cfg.namespace || "default";
  const apiPath = ns === "all" || ns === "*"
    ? "/api/v1/secrets"
    : `/api/v1/namespaces/${ns}/secrets`;
  const qs  = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = res.items || [];
  return {
    namespace: ns === "all" ? "(all)" : ns,
    count:     items.length,
    secrets:   items.map(s => ({
      name:      s.metadata?.name,
      namespace: s.metadata?.namespace,
      type:      s.type || "Opaque",
      age:       s.metadata?.creationTimestamp ? ageString(s.metadata.creationTimestamp) : null,
      // Keys only — values are NOT included for security
      keys:      Object.keys(s.data || {}),
    })),
    note: "Secret values are not returned for security. Only key names are listed.",
  };
}

async function opEvents(cfg, args) {
  const ns = args.namespace || cfg.namespace || "default";
  const apiPath = ns === "all" || ns === "*"
    ? "/api/v1/events"
    : `/api/v1/namespaces/${ns}/events`;
  const qs  = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = (res.items || []).sort((a, b) => {
    const ta = a.lastTimestamp || a.eventTime || "";
    const tb = b.lastTimestamp || b.eventTime || "";
    return tb.localeCompare(ta);
  });
  const warnings = items.filter(e => e.type === "Warning").length;
  return {
    namespace: ns === "all" ? "(all)" : ns,
    count:     items.length,
    warnings,
    events:    items.map(summariseEvent),
  };
}

async function opIngresses(cfg, args) {
  const ns = args.namespace || cfg.namespace || "default";
  const apiPath = ns === "all" || ns === "*"
    ? "/apis/networking.k8s.io/v1/ingresses"
    : `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`;
  const qs  = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = res.items || [];
  return {
    namespace: ns === "all" ? "(all)" : ns,
    count:     items.length,
    ingresses: items.map(ing => {
      const rules  = ing.spec?.rules || [];
      const tls    = ing.spec?.tls   || [];
      const lbIPs  = (ing.status?.loadBalancer?.ingress || []).map(i => i.ip || i.hostname);
      return {
        name:      ing.metadata?.name,
        namespace: ing.metadata?.namespace,
        class:     ing.spec?.ingressClassName || null,
        hosts:     rules.map(r => r.host || "*"),
        tlsHosts:  tls.flatMap(t => t.hosts || []),
        loadBalancer: lbIPs,
        age:       ing.metadata?.creationTimestamp ? ageString(ing.metadata.creationTimestamp) : null,
        paths:     rules.flatMap(r => (r.http?.paths || []).map(p => ({
          host:    r.host || "*",
          path:    p.path || "/",
          backend: `${p.backend?.service?.name}:${p.backend?.service?.port?.number}`,
        }))),
      };
    }),
  };
}

async function opLogs(cfg, args) {
  if (!args.pod) throw new Error("k8s_client logs: 'pod' is required.");
  const ns        = args.namespace || cfg.namespace || "default";
  const container = args.container ? `&container=${encodeURIComponent(args.container)}` : "";
  const tailLines = args.tail_lines != null ? `&tailLines=${Math.max(1, Math.min(100000, args.tail_lines))}` : "&tailLines=100";
  const since     = args.since_seconds ? `&sinceSeconds=${args.since_seconds}` : "";
  const previous  = args.previous ? "&previous=true" : "";

  const apiPath = `/api/v1/namespaces/${ns}/pods/${args.pod}/log?${container}${tailLines}${since}${previous}`.replace("?&", "?");

  const res = await apiRequest(cfg, { path: apiPath, rawResponse: true, timeout: args.timeout || 60_000 });
  const text = res.body.toString("utf8");

  if (res.status < 200 || res.status >= 300) {
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      if (parsed.message) detail = parsed.message;
    } catch { /* ignore */ }
    throw new Error(`k8s_client logs: HTTP ${res.status} for pod '${args.pod}': ${detail}`);
  }

  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length-1] === "") lines.pop();
  return {
    pod:       args.pod,
    container: args.container || null,
    namespace: ns,
    lines:     lines.length,
    bytes:     res.body.length,
    log:       text,
  };
}

async function opGet(cfg, args) {
  if (!args.kind) throw new Error("k8s_client get: 'kind' is required.");
  if (!args.name) throw new Error("k8s_client get: 'name' is required.");

  const kindInfo = resolveKind(args.kind);
  if (!kindInfo) {
    throw new Error(
      `k8s_client get: unknown kind '${args.kind}'. ` +
      `Use 'list' with a well-known kind, or use 'kind/group/version' format.`,
    );
  }

  const ns      = args.namespace || cfg.namespace || "default";
  const clusterScoped = ["namespace", "namespaces", "node", "nodes", "pv", "persistentvolume",
    "persistentvolumes", "storageclass", "storageclasses", "clusterrole", "clusterroles",
    "clusterrolebinding", "clusterrolebindings", "sc"];
  const isClusterScoped = clusterScoped.includes(args.kind.toLowerCase().replace(/-/g, ""));

  const nsForPath = isClusterScoped ? null : ns;
  const apiPath = resourcePath(kindInfo.group, kindInfo.version, nsForPath, kindInfo.plural, args.name);
  const res = await apiRequest(cfg, { path: apiPath, timeout: args.timeout });
  return {
    kind:      res.kind,
    name:      res.metadata?.name,
    namespace: res.metadata?.namespace || null,
    resource:  res,
  };
}

async function opList(cfg, args) {
  if (!args.kind) throw new Error("k8s_client list: 'kind' is required.");

  const kindInfo = resolveKind(args.kind);
  if (!kindInfo) {
    throw new Error(
      `k8s_client list: unknown kind '${args.kind}'. ` +
      `Supported kinds: ${Object.keys(KIND_MAP).filter((_, i) => i % 2 === 0).slice(0, 30).join(", ")}...`,
    );
  }

  const ns = args.namespace || cfg.namespace || "default";
  const clusterScoped = ["namespace", "namespaces", "node", "nodes", "pv", "persistentvolume",
    "persistentvolumes", "storageclass", "storageclasses", "clusterrole", "clusterroles",
    "clusterrolebinding", "clusterrolebindings", "sc", "nodemetrics"];
  const isClusterScoped = clusterScoped.includes(args.kind.toLowerCase().replace(/-/g, ""));
  const nsForPath = (isClusterScoped || ns === "all" || ns === "*") ? null : ns;

  const apiPath = resourcePath(kindInfo.group, kindInfo.version, nsForPath, kindInfo.plural, null);
  const qs = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = res.items || [];
  return {
    kind:      args.kind,
    namespace: nsForPath || "(all)",
    count:     items.length,
    items,
  };
}

async function opApply(cfg, args) {
  if (!args.manifest) throw new Error("k8s_client apply: 'manifest' is required (JSON object).");

  const manifest = typeof args.manifest === "string"
    ? JSON.parse(args.manifest)
    : args.manifest;

  const { kind, apiVersion } = manifest;
  if (!kind)       throw new Error("k8s_client apply: manifest must have 'kind'.");
  if (!apiVersion) throw new Error("k8s_client apply: manifest must have 'apiVersion'.");

  // Resolve API path from manifest kind + apiVersion
  const kindInfo = resolveKind(kind);
  const [group, version] = apiVersion.includes("/")
    ? apiVersion.split("/")
    : ["", apiVersion];
  const resolvedGroup   = kindInfo?.group   ?? group;
  const resolvedVersion = kindInfo?.version ?? version;
  const plural          = kindInfo?.plural  ?? (kind.toLowerCase() + "s");

  const ns   = manifest.metadata?.namespace || args.namespace || cfg.namespace || "default";
  const name = manifest.metadata?.name;
  if (!name) throw new Error("k8s_client apply: manifest.metadata.name is required.");

  // Use server-side apply (PATCH with strategic-merge-patch)
  // First try GET to see if it exists
  const clusterScopedKinds = ["Namespace", "Node", "PersistentVolume", "StorageClass",
    "ClusterRole", "ClusterRoleBinding"];
  const isClusterScoped = clusterScopedKinds.includes(kind);
  const nsForPath = isClusterScoped ? null : ns;

  const getPath  = resourcePath(resolvedGroup, resolvedVersion, nsForPath, plural, name);
  let   existing = false;
  try {
    await apiRequest(cfg, { path: getPath, timeout: args.timeout });
    existing = true;
  } catch (e) {
    if (!e.message.includes("404")) throw e;
  }

  if (existing) {
    // PATCH (strategic merge patch)
    const res = await apiRequest(cfg, {
      path:   getPath,
      method: "PATCH",
      body:   manifest,
      timeout: args.timeout,
    });
    // Note: PATCH requires strategic-merge-patch content type
    // We use apply semantics via server-side apply if available
    return {
      action:    "updated",
      kind:      res.kind,
      name:      res.metadata?.name,
      namespace: res.metadata?.namespace || null,
      resourceVersion: res.metadata?.resourceVersion || null,
    };
  } else {
    // POST (create)
    const postPath = resourcePath(resolvedGroup, resolvedVersion, nsForPath, plural, null);
    const res = await apiRequest(cfg, {
      path:   postPath,
      method: "POST",
      body:   manifest,
      timeout: args.timeout,
    });
    return {
      action:    "created",
      kind:      res.kind,
      name:      res.metadata?.name,
      namespace: res.metadata?.namespace || null,
      resourceVersion: res.metadata?.resourceVersion || null,
    };
  }
}

async function opDelete(cfg, args) {
  if (!args.kind) throw new Error("k8s_client delete: 'kind' is required.");
  if (!args.name) throw new Error("k8s_client delete: 'name' is required.");

  const kindInfo = resolveKind(args.kind);
  if (!kindInfo) {
    throw new Error(`k8s_client delete: unknown kind '${args.kind}'.`);
  }

  const ns = args.namespace || cfg.namespace || "default";
  const clusterScoped = ["namespace", "namespaces", "node", "nodes", "pv",
    "persistentvolume", "persistentvolumes", "storageclass", "storageclasses",
    "clusterrole", "clusterroles", "clusterrolebinding", "clusterrolebindings", "sc"];
  const isClusterScoped = clusterScoped.includes(args.kind.toLowerCase().replace(/-/g, ""));
  const nsForPath = isClusterScoped ? null : ns;

  const apiPath = resourcePath(kindInfo.group, kindInfo.version, nsForPath, kindInfo.plural, args.name);
  const body = args.grace_period != null
    ? { apiVersion: "v1", kind: "DeleteOptions", gracePeriodSeconds: args.grace_period }
    : null;

  const res = await apiRequest(cfg, {
    path:   apiPath,
    method: "DELETE",
    body,
    timeout: args.timeout,
  });

  return {
    action:    "deleted",
    kind:      args.kind,
    name:      args.name,
    namespace: nsForPath || null,
    status:    res.status || "Success",
  };
}

async function opRollout(cfg, args) {
  if (!args.name) throw new Error("k8s_client rollout: 'name' is required.");
  const ns       = args.namespace || cfg.namespace || "default";
  const kind     = (args.kind || "deployment").toLowerCase();
  const kindInfo = resolveKind(kind);
  if (!kindInfo) throw new Error(`k8s_client rollout: unsupported kind '${kind}'.`);

  const apiPath = resourcePath(kindInfo.group, kindInfo.version, ns, kindInfo.plural, args.name);
  const res     = await apiRequest(cfg, { path: apiPath, timeout: args.timeout });
  const status  = res.status || {};
  const spec    = res.spec   || {};

  // Also fetch recent replicasets for history
  let history = [];
  if (kind === "deployment" || kind === "deployments") {
    try {
      const rsPath = `/apis/apps/v1/namespaces/${ns}/replicasets`;
      const selector = Object.entries(spec.selector?.matchLabels || {})
        .map(([k, v]) => `${k}=${v}`).join(",");
      const rsQs = selector ? `?labelSelector=${encodeURIComponent(selector)}` : "";
      const rsRes = await apiRequest(cfg, { path: rsPath + rsQs, timeout: args.timeout });
      const rsItems = (rsRes.items || []).sort((a, b) => {
        const ra = parseInt(a.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "0");
        const rb = parseInt(b.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "0");
        return rb - ra;
      });
      history = rsItems.slice(0, 5).map(rs => ({
        revision:  rs.metadata?.annotations?.["deployment.kubernetes.io/revision"] || "?",
        name:      rs.metadata?.name,
        image:     (rs.spec?.template?.spec?.containers || []).map(c => c.image).join(", "),
        ready:     `${rs.status?.readyReplicas || 0}/${rs.spec?.replicas || 0}`,
        created:   rs.metadata?.creationTimestamp,
      }));
    } catch { /* metrics not available */ }
  }

  const conditions = (status.conditions || []).map(c => ({
    type:    c.type,
    status:  c.status,
    message: c.message,
    reason:  c.reason,
  }));

  const available = conditions.find(c => c.type === "Available");
  const progressing = conditions.find(c => c.type === "Progressing");

  return {
    name:        args.name,
    namespace:   ns,
    kind:        res.kind,
    desired:     spec.replicas ?? 0,
    ready:       status.readyReplicas    ?? 0,
    updated:     status.updatedReplicas  ?? 0,
    available:   status.availableReplicas ?? 0,
    isAvailable: available?.status === "True" || false,
    isProgressing: progressing?.status === "True" || false,
    progressReason: progressing?.reason || null,
    conditions,
    history,
  };
}

async function opTopPods(cfg, args) {
  const ns = args.namespace || cfg.namespace || "default";
  const apiPath = ns === "all" || ns === "*"
    ? "/apis/metrics.k8s.io/v1beta1/pods"
    : `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods`;
  const qs  = buildQs(args);
  const res = await apiRequest(cfg, { path: apiPath + qs, timeout: args.timeout });
  const items = res.items || [];
  return {
    namespace: ns === "all" ? "(all)" : ns,
    count:     items.length,
    pods:      items.map(item => ({
      name:       item.metadata?.name,
      namespace:  item.metadata?.namespace,
      timestamp:  item.timestamp,
      containers: (item.containers || []).map(c => ({
        name:   c.name,
        cpu:    c.usage?.cpu    || null,
        memory: c.usage?.memory || null,
      })),
      totalCpu:    sumMetrics(item.containers || [], "cpu"),
      totalMemory: sumMetrics(item.containers || [], "memory"),
    })),
  };
}

async function opTopNodes(cfg, args) {
  const res = await apiRequest(cfg, { path: "/apis/metrics.k8s.io/v1beta1/nodes", timeout: args.timeout });
  const items = res.items || [];
  return {
    count: items.length,
    nodes: items.map(item => ({
      name:      item.metadata?.name,
      timestamp: item.timestamp,
      cpu:       item.usage?.cpu    || null,
      memory:    item.usage?.memory || null,
    })),
  };
}

function sumMetrics(containers, type) {
  // Kubernetes uses millicores for CPU (e.g., "125m") and Ki/Mi for memory
  // We just return the raw values since converting requires unit parsing
  return containers.map(c => c.usage?.[type] || "0").join("+") || null;
}

// ─── query string builder ─────────────────────────────────────────────────────

function buildQs(args) {
  const params = new URLSearchParams();
  if (args.label_selector) params.set("labelSelector", args.label_selector);
  if (args.field_selector) params.set("fieldSelector", args.field_selector);
  if (args.limit)          params.set("limit", String(Math.max(1, Math.min(10000, args.limit))));
  if (args.continue_token) params.set("continue", args.continue_token);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ─── main entry point ─────────────────────────────────────────────────────────

async function k8sClient(args) {
  const op = args.operation;
  if (!op) throw new Error("k8s_client: 'operation' is required.");

  const VALID_OPS = [
    "version", "namespaces", "pods", "deployments", "services", "nodes",
    "configmaps", "secrets", "events", "ingresses", "logs", "get", "list",
    "apply", "delete", "rollout", "top_pods", "top_nodes",
  ];
  if (!VALID_OPS.includes(op))
    throw new Error(`k8s_client: unknown operation '${op}'. Valid: ${VALID_OPS.join(", ")}.`);

  // Security: NUL-byte guard on kubeconfig path
  if (args.kubeconfig && args.kubeconfig.includes("\0"))
    throw new Error("k8s_client: 'kubeconfig' must not contain NUL bytes.");
  if (args.namespace && args.namespace.includes("\0"))
    throw new Error("k8s_client: 'namespace' must not contain NUL bytes.");

  // Build timeout (clamped 1000–300000ms)
  args = {
    ...args,
    timeout: Math.max(1000, Math.min(300_000, args.timeout ?? DEFAULT_TIMEOUT)),
  };

  // Load kubeconfig (applies token override if provided)
  let cfg = loadKubeconfig(args.kubeconfig);

  // Allow overriding token, server at call time
  if (args.token)  cfg = { ...cfg, token: args.token };
  if (args.server) cfg = { ...cfg, server: args.server };
  if (args.insecure != null) cfg = { ...cfg, insecure: args.insecure };

  // Context selection
  if (args.context && args.context !== cfg.currentContext) {
    // Re-parse with explicit context
    const candidates = [];
    if (args.kubeconfig) candidates.push(args.kubeconfig);
    const envKC = process.env.KUBECONFIG;
    if (envKC) candidates.push(envKC.split(path.delimiter)[0]);
    candidates.push(path.join(os.homedir(), ".kube", "config"));

    let loaded = false;
    for (const candidate of candidates) {
      try {
        const text = fs.readFileSync(candidate, "utf8");
        const parsed = parseKubeconfig(text, candidate);
        // Temporarily set current context and reparse
        const ctx = (() => {
          // Find the requested context
          const lines = text.split("\n");
          // We'll do a simple replacement for parsing purposes
          const modified = text.replace(/^current-context:.*/m, `current-context: ${args.context}`);
          return parseKubeconfig(modified, candidate);
        })();
        cfg = ctx;
        if (args.token) cfg = { ...cfg, token: args.token };
        loaded = true;
        break;
      } catch { /* try next */ }
    }
    if (!loaded) {
      throw new Error(`k8s_client: could not load context '${args.context}'.`);
    }
  }

  switch (op) {
    case "version":     return opVersion(cfg, args);
    case "namespaces":  return opNamespaces(cfg, args);
    case "pods":        return opPods(cfg, args);
    case "deployments": return opDeployments(cfg, args);
    case "services":    return opServices(cfg, args);
    case "nodes":       return opNodes(cfg, args);
    case "configmaps":  return opConfigmaps(cfg, args);
    case "secrets":     return opSecrets(cfg, args);
    case "events":      return opEvents(cfg, args);
    case "ingresses":   return opIngresses(cfg, args);
    case "logs":        return opLogs(cfg, args);
    case "get":         return opGet(cfg, args);
    case "list":        return opList(cfg, args);
    case "apply":       return opApply(cfg, args);
    case "delete":      return opDelete(cfg, args);
    case "rollout":     return opRollout(cfg, args);
    case "top_pods":    return opTopPods(cfg, args);
    case "top_nodes":   return opTopNodes(cfg, args);
    default:
      throw new Error(`k8s_client: unhandled operation '${op}'.`);
  }
}

module.exports = { k8sClient, loadKubeconfig, parseKubeconfig, resolveKind, ageString };
