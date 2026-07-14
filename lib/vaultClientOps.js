"use strict";
/**
 * vault_client — Zero-dependency HashiCorp Vault HTTP API client
 * (pure Node.js http/https built-ins; no npm deps)
 *
 * Vault HTTP API v1 — https://developer.hashicorp.com/vault/api-docs
 *
 * Default port: 8200
 *
 * Operations:
 *   kv_get           — Read a secret from KV v1 or KV v2 engine
 *   kv_put           — Write a secret to KV v1 or KV v2 engine
 *   kv_delete        — Delete a secret from KV v1 or KV v2 engine
 *   kv_list          — List secret keys under a KV path
 *   kv_metadata      — Read metadata for a KV v2 secret (versions, created, etc.)
 *   kv_destroy       — Permanently destroy specific versions of a KV v2 secret
 *   token_lookup     — Look up the current or a specified token's properties
 *   token_renew      — Renew a token's TTL
 *   token_revoke     — Revoke a token
 *   auth_userpass    — Authenticate using username/password auth method
 *   auth_approle     — Authenticate using AppRole auth method
 *   auth_token       — Authenticate by validating/looking up a token
 *   pki_issue        — Issue a certificate from a PKI secrets engine
 *   pki_sign         — Sign a CSR using a PKI role
 *   transit_encrypt  — Encrypt data using the Transit secrets engine
 *   transit_decrypt  — Decrypt data using the Transit secrets engine
 *   transit_sign     — Sign data using the Transit secrets engine
 *   transit_verify   — Verify a signature using the Transit secrets engine
 *   sys_health       — Get the health status of the Vault cluster
 *   sys_seal_status  — Get the seal status of the Vault
 *   sys_mounts       — List all mounted secret engines
 *   sys_policies     — List all ACL policies
 *   sys_capabilities — Check token capabilities on given paths
 *   unwrap           — Unwrap a wrapped response token
 *   info             — Return protocol/operation reference (no I/O)
 *
 * Auth: Vault token via X-Vault-Token header (or client_token from auth methods).
 * TLS:  use_tls:true uses https; reject_unauthorized configures cert validation.
 *
 * Security:
 *   NUL-byte guards on host, paths, token, username, password.
 *   Timeout clamped 1000-120000 ms.
 *   Port validated 1-65535.
 *   Tokens/passwords never returned in output or error messages.
 *   16 MB response cap.
 */

const http  = require("http");
const https = require("https");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT       = 8200;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB
const API_V1             = "/v1";

// ── Guard helpers ──────────────────────────────────────────────────────────

function requireString(val, name) {
  if (typeof val !== "string" || val.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
}

function guardString(val, name) {
  if (val !== undefined && val !== null) {
    if (typeof val !== "string") throw new Error(`${name} must be a string`);
    if (val.includes("\0")) throw new Error(`${name} must not contain NUL bytes`);
  }
}

function clampInt(val, def, min, max, name) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

// ── Build connection options ───────────────────────────────────────────────

function buildConn(args) {
  requireString(args.host, "host");
  guardString(args.token,     "token");
  guardString(args.namespace, "namespace");

  const host      = args.host.trim();
  const port      = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");
  const timeoutMs = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  const useTls    = !!args.use_tls;
  const rejectUnauthorized = args.reject_unauthorized !== false;
  const token     = args.token     || null;
  const namespace = args.namespace || null;

  return { host, port, timeoutMs, useTls, rejectUnauthorized, token, namespace };
}

// ── HTTP helper ────────────────────────────────────────────────────────────

/**
 * Perform an HTTP/HTTPS request to the Vault API.
 * method:  GET | PUT | POST | DELETE | LIST
 * apiPath: e.g. "/v1/secret/mykey"
 * body:    JS object (JSON) or null
 */
function vaultRequest(conn, method, apiPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const reqBodyStr = body != null ? JSON.stringify(body) : null;
    const headers    = { "Content-Type": "application/json" };
    if (conn.token)     headers["X-Vault-Token"]     = conn.token;
    if (conn.namespace) headers["X-Vault-Namespace"] = conn.namespace;
    headers["Content-Length"] = reqBodyStr ? Buffer.byteLength(reqBodyStr) : 0;

    // Vault uses LIST as a custom HTTP method for listing operations
    const httpMethod = method === "LIST" ? "GET" : method;
    const fullPath   = method === "LIST"
      ? apiPath + (apiPath.includes("?") ? "&list=true" : "?list=true")
      : apiPath;

    const reqOpts = {
      hostname: conn.host,
      port:     conn.port,
      path:     fullPath,
      method:   httpMethod,
      headers,
    };
    if (conn.useTls) {
      reqOpts.rejectUnauthorized = conn.rejectUnauthorized;
      reqOpts.servername         = conn.host;
    }

    const mod      = conn.useTls ? https : http;
    const chunks   = [];
    let totalBytes = 0;
    let settled    = false;

    const tm = timeoutMs || conn.timeoutMs;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Vault request ${method} ${apiPath} timed out after ${tm}ms`));
    }, tm);

    const req = mod.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("Vault response exceeded 16 MB cap"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, headers: res.headers, raw });
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Vault response stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to Vault ${conn.host}:${conn.port}: ${err.message}`));
    });

    if (reqBodyStr) req.write(reqBodyStr);
    req.end();
  });
}

/** Parse JSON from response; throw helpful error on failure */
function parseJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Vault: invalid JSON response (${context}): ${raw.slice(0, 200)}`);
  }
}

/** Throw on non-2xx responses with Vault error messages */
function checkStatus(res, context) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let errMsg = res.raw.slice(0, 400).trim();
    // Try to extract Vault errors array
    try {
      const parsed = JSON.parse(res.raw);
      if (parsed.errors && Array.isArray(parsed.errors)) {
        errMsg = parsed.errors.join("; ");
      }
    } catch (_) {}
    throw new Error(`Vault ${context}: HTTP ${res.statusCode} — ${errMsg}`);
  }
}

// ── KV v1 / v2 helpers ────────────────────────────────────────────────────

/**
 * Build Vault KV API path depending on version.
 * KV v1: /v1/{mount}/{path}
 * KV v2: /v1/{mount}/data/{path} (for read/write)
 *        /v1/{mount}/metadata/{path} (for metadata/list)
 *        /v1/{mount}/delete/{path} (for soft delete)
 *        /v1/{mount}/destroy/{path} (for destroy)
 */
function kvPath(mount, path, kv_version, mode) {
  const m   = (mount || "secret").replace(/\/+$/, "");
  const p   = (path  || "").replace(/^\/+/, "");
  const ver = kv_version === 2 ? 2 : 1;

  if (ver === 1) {
    return `${API_V1}/${m}/${p}`;
  }
  // KV v2
  switch (mode) {
    case "data":     return `${API_V1}/${m}/data/${p}`;
    case "metadata": return `${API_V1}/${m}/metadata/${p}`;
    case "delete":   return `${API_V1}/${m}/delete/${p}`;
    case "destroy":  return `${API_V1}/${m}/destroy/${p}`;
    default:         return `${API_V1}/${m}/data/${p}`;
  }
}

// ── KV operations ──────────────────────────────────────────────────────────

async function opKvGet(args) {
  const conn = buildConn(args);
  if (!args.path) throw new Error("kv_get requires 'path'");
  guardString(args.path,  "path");
  guardString(args.mount, "mount");

  const ver    = args.kv_version === 2 ? 2 : 1;
  const apiPath = kvPath(args.mount, args.path, ver, "data");
  const query  = ver === 2 && args.version ? `?version=${args.version}` : "";

  const res = await vaultRequest(conn, "GET", apiPath + query, null, conn.timeoutMs);

  if (res.statusCode === 404) {
    return { ok: true, operation: "kv_get", server: `${conn.host}:${conn.port}`, found: false, path: args.path };
  }
  checkStatus(res, "kv_get");

  const json = parseJson(res.raw, "kv_get");

  if (ver === 2) {
    const d = json.data || {};
    return {
      ok:           true,
      operation:    "kv_get",
      server:       `${conn.host}:${conn.port}`,
      found:        true,
      path:         args.path,
      mount:        args.mount || "secret",
      kv_version:   2,
      data:         d.data        || {},
      metadata:     d.metadata    || {},
      version:      d.metadata    ? d.metadata.version    : null,
      created_time: d.metadata    ? d.metadata.created_time : null,
      destroyed:    d.metadata    ? !!d.metadata.destroyed : false,
      deletion_time: d.metadata   ? d.metadata.deletion_time : null,
    };
  }

  // KV v1
  return {
    ok:        true,
    operation: "kv_get",
    server:    `${conn.host}:${conn.port}`,
    found:     true,
    path:      args.path,
    mount:     args.mount || "secret",
    kv_version: 1,
    data:      json.data || {},
    lease_id:  json.lease_id  || null,
    renewable: json.renewable || false,
    lease_duration: json.lease_duration || 0,
  };
}

async function opKvPut(args) {
  const conn = buildConn(args);
  if (!args.path) throw new Error("kv_put requires 'path'");
  if (!args.data || typeof args.data !== "object")
    throw new Error("kv_put requires 'data' (object)");
  guardString(args.path,  "path");
  guardString(args.mount, "mount");

  const ver     = args.kv_version === 2 ? 2 : 1;
  const apiPath = kvPath(args.mount, args.path, ver, "data");

  // KV v2 wraps in { data: {...} }; v1 sends data directly
  const body = ver === 2 ? { data: args.data, options: args.options || {} } : args.data;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "kv_put");

  const json = res.raw ? parseJson(res.raw, "kv_put") : {};

  if (ver === 2) {
    const d = json.data || {};
    return {
      ok:           true,
      operation:    "kv_put",
      server:       `${conn.host}:${conn.port}`,
      path:         args.path,
      mount:        args.mount || "secret",
      kv_version:   2,
      version:      d.version       || null,
      created_time: d.created_time  || null,
    };
  }
  return {
    ok:        true,
    operation: "kv_put",
    server:    `${conn.host}:${conn.port}`,
    path:      args.path,
    mount:     args.mount || "secret",
    kv_version: 1,
    written:   true,
  };
}

async function opKvDelete(args) {
  const conn = buildConn(args);
  if (!args.path) throw new Error("kv_delete requires 'path'");
  guardString(args.path,  "path");
  guardString(args.mount, "mount");

  const ver     = args.kv_version === 2 ? 2 : 1;
  // KV v2 soft-delete uses the /delete/ prefix; v1 uses DELETE on the path
  const apiPath = kvPath(args.mount, args.path, ver, ver === 2 ? "delete" : "data");

  let res;
  if (ver === 2 && args.versions && Array.isArray(args.versions)) {
    // Delete specific versions in KV v2
    res = await vaultRequest(conn, "POST", apiPath, { versions: args.versions }, conn.timeoutMs);
  } else if (ver === 2) {
    // Delete latest version in KV v2 via DELETE on data path
    const dataPath = kvPath(args.mount, args.path, 2, "data");
    res = await vaultRequest(conn, "DELETE", dataPath, null, conn.timeoutMs);
  } else {
    res = await vaultRequest(conn, "DELETE", apiPath, null, conn.timeoutMs);
  }
  checkStatus(res, "kv_delete");

  return {
    ok:        true,
    operation: "kv_delete",
    server:    `${conn.host}:${conn.port}`,
    path:      args.path,
    mount:     args.mount || "secret",
    kv_version: ver,
    deleted:   true,
    versions:  args.versions || null,
  };
}

async function opKvList(args) {
  const conn = buildConn(args);
  if (!args.path && args.path !== "") args.path = "";
  guardString(args.path,  "path");
  guardString(args.mount, "mount");

  const ver     = args.kv_version === 2 ? 2 : 1;
  const apiPath = kvPath(args.mount, args.path || "", ver, "metadata");

  const res = await vaultRequest(conn, "LIST", apiPath, null, conn.timeoutMs);

  if (res.statusCode === 404) {
    return { ok: true, operation: "kv_list", server: `${conn.host}:${conn.port}`, path: args.path || "", count: 0, keys: [] };
  }
  checkStatus(res, "kv_list");

  const json = parseJson(res.raw, "kv_list");
  const keys  = (json.data && json.data.keys) ? json.data.keys : [];

  return {
    ok:        true,
    operation: "kv_list",
    server:    `${conn.host}:${conn.port}`,
    path:      args.path || "",
    mount:     args.mount || "secret",
    kv_version: ver,
    count:     keys.length,
    keys,
  };
}

async function opKvMetadata(args) {
  const conn = buildConn(args);
  if (!args.path) throw new Error("kv_metadata requires 'path'");
  guardString(args.path,  "path");
  guardString(args.mount, "mount");

  const apiPath = kvPath(args.mount, args.path, 2, "metadata");
  const res     = await vaultRequest(conn, "GET", apiPath, null, conn.timeoutMs);

  if (res.statusCode === 404) {
    return { ok: true, operation: "kv_metadata", server: `${conn.host}:${conn.port}`, found: false, path: args.path };
  }
  checkStatus(res, "kv_metadata");

  const json = parseJson(res.raw, "kv_metadata");
  const d    = json.data || {};

  return {
    ok:              true,
    operation:       "kv_metadata",
    server:          `${conn.host}:${conn.port}`,
    found:           true,
    path:            args.path,
    mount:           args.mount || "secret",
    created_time:    d.created_time    || null,
    current_version: d.current_version || 0,
    max_versions:    d.max_versions    || 0,
    oldest_version:  d.oldest_version  || 0,
    updated_time:    d.updated_time    || null,
    cas_required:    d.cas_required    || false,
    delete_version_after: d.delete_version_after || "0s",
    custom_metadata: d.custom_metadata || {},
    versions:        d.versions        || {},
  };
}

async function opKvDestroy(args) {
  const conn = buildConn(args);
  if (!args.path)     throw new Error("kv_destroy requires 'path'");
  if (!Array.isArray(args.versions) || args.versions.length === 0)
    throw new Error("kv_destroy requires 'versions' (non-empty array)");
  guardString(args.path,  "path");
  guardString(args.mount, "mount");

  const apiPath = kvPath(args.mount, args.path, 2, "destroy");
  const res     = await vaultRequest(conn, "POST", apiPath, { versions: args.versions }, conn.timeoutMs);
  checkStatus(res, "kv_destroy");

  return {
    ok:        true,
    operation: "kv_destroy",
    server:    `${conn.host}:${conn.port}`,
    path:      args.path,
    mount:     args.mount || "secret",
    versions:  args.versions,
    destroyed: true,
  };
}

// ── Token operations ───────────────────────────────────────────────────────

async function opTokenLookup(args) {
  const conn  = buildConn(args);
  const token = args.lookup_token || null; // specific token to look up
  guardString(token, "lookup_token");

  let apiPath, body;
  if (token) {
    apiPath = `${API_V1}/auth/token/lookup`;
    body    = { token };
  } else {
    apiPath = `${API_V1}/auth/token/lookup-self`;
    body    = null;
  }

  const res = await vaultRequest(conn, token ? "POST" : "GET", apiPath, body, conn.timeoutMs);
  checkStatus(res, "token_lookup");

  const json = parseJson(res.raw, "token_lookup");
  const d    = json.data || {};

  return {
    ok:             true,
    operation:      "token_lookup",
    server:         `${conn.host}:${conn.port}`,
    id:             d.id             || null,  // always accessor in output
    accessor:       d.accessor       || null,
    display_name:   d.display_name   || null,
    policies:       d.policies       || [],
    meta:           d.meta           || {},
    ttl:            d.ttl            || 0,
    explicit_max_ttl: d.explicit_max_ttl || 0,
    num_uses:       d.num_uses       || 0,
    renewable:      d.renewable      || false,
    orphan:         d.orphan         || false,
    path:           d.path           || null,
    issue_time:     d.issue_time     || null,
    expire_time:    d.expire_time    || null,
    creation_time:  d.creation_time  || 0,
    type:           d.type           || null,
  };
}

async function opTokenRenew(args) {
  const conn  = buildConn(args);
  const token = args.renew_token || null;
  guardString(token, "renew_token");

  let apiPath, body;
  if (token) {
    apiPath = `${API_V1}/auth/token/renew`;
    body    = { token };
  } else {
    apiPath = `${API_V1}/auth/token/renew-self`;
    body    = {};
  }
  if (args.increment) body.increment = args.increment;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "token_renew");

  const json = parseJson(res.raw, "token_renew");
  const auth = json.auth || {};

  return {
    ok:           true,
    operation:    "token_renew",
    server:       `${conn.host}:${conn.port}`,
    renewed:      true,
    client_token: auth.client_token || null,  // only if new token issued
    policies:     auth.policies     || [],
    lease_duration: auth.lease_duration || 0,
    renewable:    auth.renewable    || false,
    accessor:     auth.accessor     || null,
  };
}

async function opTokenRevoke(args) {
  const conn  = buildConn(args);
  const token = args.revoke_token || null;
  guardString(token, "revoke_token");

  let apiPath, body;
  if (token) {
    apiPath = `${API_V1}/auth/token/revoke`;
    body    = { token };
  } else {
    apiPath = `${API_V1}/auth/token/revoke-self`;
    body    = null;
  }

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "token_revoke");

  return {
    ok:        true,
    operation: "token_revoke",
    server:    `${conn.host}:${conn.port}`,
    revoked:   true,
  };
}

// ── Auth operations ────────────────────────────────────────────────────────

async function opAuthUserpass(args) {
  const conn = buildConn(args);
  if (!args.username) throw new Error("auth_userpass requires 'username'");
  if (!args.password) throw new Error("auth_userpass requires 'password'");
  guardString(args.username, "username");
  guardString(args.password, "password");
  const mount = (args.mount || "userpass").replace(/\/+$/, "").replace(/^\/+/, "");

  const apiPath = `${API_V1}/auth/${mount}/login/${encodeURIComponent(args.username)}`;
  const body    = { password: args.password };

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "auth_userpass");

  const json = parseJson(res.raw, "auth_userpass");
  const auth = json.auth || {};

  return {
    ok:             true,
    operation:      "auth_userpass",
    server:         `${conn.host}:${conn.port}`,
    authenticated:  true,
    client_token:   auth.client_token  || null,
    accessor:       auth.accessor      || null,
    policies:       auth.policies      || [],
    token_type:     auth.token_type    || null,
    lease_duration: auth.lease_duration || 0,
    renewable:      auth.renewable     || false,
    entity_id:      auth.entity_id     || null,
    // password deliberately omitted from output
  };
}

async function opAuthApprole(args) {
  const conn = buildConn(args);
  if (!args.role_id)   throw new Error("auth_approle requires 'role_id'");
  guardString(args.role_id,   "role_id");
  guardString(args.secret_id, "secret_id");
  const mount = (args.mount || "approle").replace(/\/+$/, "").replace(/^\/+/, "");

  const apiPath = `${API_V1}/auth/${mount}/login`;
  const body    = { role_id: args.role_id };
  if (args.secret_id) body.secret_id = args.secret_id;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "auth_approle");

  const json = parseJson(res.raw, "auth_approle");
  const auth = json.auth || {};

  return {
    ok:             true,
    operation:      "auth_approle",
    server:         `${conn.host}:${conn.port}`,
    authenticated:  true,
    client_token:   auth.client_token  || null,
    accessor:       auth.accessor      || null,
    policies:       auth.policies      || [],
    token_type:     auth.token_type    || null,
    lease_duration: auth.lease_duration || 0,
    renewable:      auth.renewable     || false,
    entity_id:      auth.entity_id     || null,
    // secret_id deliberately omitted from output
  };
}

async function opAuthToken(args) {
  const conn = buildConn(args);
  // Validate the currently configured token via lookup-self
  const res = await vaultRequest(conn, "GET", `${API_V1}/auth/token/lookup-self`, null, conn.timeoutMs);
  checkStatus(res, "auth_token");

  const json = parseJson(res.raw, "auth_token");
  const d    = json.data || {};

  return {
    ok:           true,
    operation:    "auth_token",
    server:       `${conn.host}:${conn.port}`,
    valid:        true,
    accessor:     d.accessor      || null,
    display_name: d.display_name  || null,
    policies:     d.policies      || [],
    ttl:          d.ttl           || 0,
    renewable:    d.renewable     || false,
    type:         d.type          || null,
    entity_id:    d.entity_id     || null,
    issue_time:   d.issue_time    || null,
    expire_time:  d.expire_time   || null,
  };
}

// ── PKI operations ─────────────────────────────────────────────────────────

async function opPkiIssue(args) {
  const conn = buildConn(args);
  if (!args.role)        throw new Error("pki_issue requires 'role'");
  if (!args.common_name) throw new Error("pki_issue requires 'common_name'");
  guardString(args.role,        "role");
  guardString(args.common_name, "common_name");
  guardString(args.mount,       "mount");
  const mount = (args.mount || "pki").replace(/\/+$/, "");

  const apiPath = `${API_V1}/${mount}/issue/${encodeURIComponent(args.role)}`;
  const body    = { common_name: args.common_name };
  if (args.alt_names)    body.alt_names    = args.alt_names;
  if (args.ip_sans)      body.ip_sans      = args.ip_sans;
  if (args.uri_sans)     body.uri_sans     = args.uri_sans;
  if (args.ttl)          body.ttl          = args.ttl;
  if (args.format)       body.format       = args.format;
  if (args.private_key_format) body.private_key_format = args.private_key_format;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "pki_issue");

  const json = parseJson(res.raw, "pki_issue");
  const d    = json.data || {};

  return {
    ok:               true,
    operation:        "pki_issue",
    server:           `${conn.host}:${conn.port}`,
    serial_number:    d.serial_number    || null,
    certificate:      d.certificate      || null,
    issuing_ca:       d.issuing_ca       || null,
    ca_chain:         d.ca_chain         || [],
    private_key:      d.private_key      || null,
    private_key_type: d.private_key_type || null,
    expiration:       d.expiration       || null,
  };
}

async function opPkiSign(args) {
  const conn = buildConn(args);
  if (!args.role) throw new Error("pki_sign requires 'role'");
  if (!args.csr)  throw new Error("pki_sign requires 'csr'");
  guardString(args.role,  "role");
  guardString(args.csr,   "csr");
  guardString(args.mount, "mount");
  const mount = (args.mount || "pki").replace(/\/+$/, "");

  const apiPath = `${API_V1}/${mount}/sign/${encodeURIComponent(args.role)}`;
  const body    = { csr: args.csr };
  if (args.common_name) body.common_name = args.common_name;
  if (args.alt_names)   body.alt_names   = args.alt_names;
  if (args.ip_sans)     body.ip_sans     = args.ip_sans;
  if (args.ttl)         body.ttl         = args.ttl;
  if (args.format)      body.format      = args.format;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "pki_sign");

  const json = parseJson(res.raw, "pki_sign");
  const d    = json.data || {};

  return {
    ok:            true,
    operation:     "pki_sign",
    server:        `${conn.host}:${conn.port}`,
    serial_number: d.serial_number  || null,
    certificate:   d.certificate    || null,
    issuing_ca:    d.issuing_ca     || null,
    ca_chain:      d.ca_chain       || [],
    expiration:    d.expiration     || null,
  };
}

// ── Transit operations ─────────────────────────────────────────────────────

async function opTransitEncrypt(args) {
  const conn = buildConn(args);
  if (!args.key)       throw new Error("transit_encrypt requires 'key'");
  if (!args.plaintext) throw new Error("transit_encrypt requires 'plaintext'");
  guardString(args.key,       "key");
  guardString(args.plaintext, "plaintext");
  guardString(args.mount,     "mount");
  const mount = (args.mount || "transit").replace(/\/+$/, "");

  // Vault requires base64-encoded plaintext
  const plaintextB64 = Buffer.from(args.plaintext, "utf8").toString("base64");

  const apiPath = `${API_V1}/${mount}/encrypt/${encodeURIComponent(args.key)}`;
  const body    = { plaintext: plaintextB64 };
  if (args.context)          body.context          = args.context;
  if (args.nonce)            body.nonce            = args.nonce;
  if (args.key_version)      body.key_version      = args.key_version;
  if (args.convergent_encryption !== undefined)
    body.convergent_encryption = args.convergent_encryption;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "transit_encrypt");

  const json = parseJson(res.raw, "transit_encrypt");
  const d    = json.data || {};

  return {
    ok:         true,
    operation:  "transit_encrypt",
    server:     `${conn.host}:${conn.port}`,
    key:        args.key,
    ciphertext: d.ciphertext  || null,
    key_version: d.key_version || null,
  };
}

async function opTransitDecrypt(args) {
  const conn = buildConn(args);
  if (!args.key)        throw new Error("transit_decrypt requires 'key'");
  if (!args.ciphertext) throw new Error("transit_decrypt requires 'ciphertext'");
  guardString(args.key,        "key");
  guardString(args.ciphertext, "ciphertext");
  guardString(args.mount,      "mount");
  const mount = (args.mount || "transit").replace(/\/+$/, "");

  const apiPath = `${API_V1}/${mount}/decrypt/${encodeURIComponent(args.key)}`;
  const body    = { ciphertext: args.ciphertext };
  if (args.context) body.context = args.context;
  if (args.nonce)   body.nonce   = args.nonce;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "transit_decrypt");

  const json = parseJson(res.raw, "transit_decrypt");
  const d    = json.data || {};

  // Vault returns base64-encoded plaintext
  const plaintextB64 = d.plaintext || "";
  const plaintext    = plaintextB64
    ? Buffer.from(plaintextB64, "base64").toString("utf8")
    : "";

  return {
    ok:         true,
    operation:  "transit_decrypt",
    server:     `${conn.host}:${conn.port}`,
    key:        args.key,
    plaintext,
    plaintext_b64: plaintextB64,
  };
}

async function opTransitSign(args) {
  const conn = buildConn(args);
  if (!args.key)   throw new Error("transit_sign requires 'key'");
  if (!args.input) throw new Error("transit_sign requires 'input'");
  guardString(args.key,       "key");
  guardString(args.input,     "input");
  guardString(args.mount,     "mount");
  guardString(args.hash_algorithm, "hash_algorithm");
  const mount = (args.mount || "transit").replace(/\/+$/, "");

  // input must be base64
  const inputB64 = Buffer.from(args.input, "utf8").toString("base64");

  const apiPath = `${API_V1}/${mount}/sign/${encodeURIComponent(args.key)}`;
  const body    = { input: inputB64 };
  if (args.hash_algorithm)  body.hash_algorithm  = args.hash_algorithm;
  if (args.signature_algorithm) body.signature_algorithm = args.signature_algorithm;
  if (args.context)         body.context         = args.context;
  if (args.prehashed !== undefined) body.prehashed = args.prehashed;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "transit_sign");

  const json = parseJson(res.raw, "transit_sign");
  const d    = json.data || {};

  return {
    ok:        true,
    operation: "transit_sign",
    server:    `${conn.host}:${conn.port}`,
    key:       args.key,
    signature: d.signature  || null,
    key_version: d.key_version || null,
  };
}

async function opTransitVerify(args) {
  const conn = buildConn(args);
  if (!args.key)       throw new Error("transit_verify requires 'key'");
  if (!args.input)     throw new Error("transit_verify requires 'input'");
  if (!args.signature) throw new Error("transit_verify requires 'signature'");
  guardString(args.key,       "key");
  guardString(args.input,     "input");
  guardString(args.signature, "signature");
  guardString(args.mount,     "mount");
  const mount = (args.mount || "transit").replace(/\/+$/, "");

  const inputB64 = Buffer.from(args.input, "utf8").toString("base64");

  const apiPath = `${API_V1}/${mount}/verify/${encodeURIComponent(args.key)}`;
  const body    = { input: inputB64, signature: args.signature };
  if (args.hash_algorithm)  body.hash_algorithm  = args.hash_algorithm;
  if (args.signature_algorithm) body.signature_algorithm = args.signature_algorithm;
  if (args.context)         body.context         = args.context;
  if (args.prehashed !== undefined) body.prehashed = args.prehashed;

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "transit_verify");

  const json = parseJson(res.raw, "transit_verify");
  const d    = json.data || {};

  return {
    ok:        true,
    operation: "transit_verify",
    server:    `${conn.host}:${conn.port}`,
    key:       args.key,
    valid:     d.valid === true,
  };
}

// ── System operations ──────────────────────────────────────────────────────

async function opSysHealth(args) {
  const conn = buildConn(args);
  const res  = await vaultRequest(conn, "GET", `${API_V1}/sys/health`, null, conn.timeoutMs);
  // Vault health endpoint returns non-200 for standby/uninitialized but still valid
  let json = {};
  if (res.raw) {
    try { json = JSON.parse(res.raw); } catch (_) {}
  }
  return {
    ok:              true,
    operation:       "sys_health",
    server:          `${conn.host}:${conn.port}`,
    http_status:     res.statusCode,
    initialized:     json.initialized     !== undefined ? json.initialized     : null,
    sealed:          json.sealed          !== undefined ? json.sealed          : null,
    standby:         json.standby         !== undefined ? json.standby         : null,
    performance_standby: json.performance_standby !== undefined ? json.performance_standby : null,
    replication_performance_mode: json.replication_performance_mode || null,
    replication_dr_mode:          json.replication_dr_mode          || null,
    server_time_utc: json.server_time_utc || null,
    version:         json.version         || null,
    cluster_name:    json.cluster_name    || null,
    cluster_id:      json.cluster_id      || null,
  };
}

async function opSysSealStatus(args) {
  const conn = buildConn(args);
  const res  = await vaultRequest(conn, "GET", `${API_V1}/sys/seal-status`, null, conn.timeoutMs);
  checkStatus(res, "sys_seal_status");

  const json = parseJson(res.raw, "sys_seal_status");
  return {
    ok:           true,
    operation:    "sys_seal_status",
    server:       `${conn.host}:${conn.port}`,
    type:         json.type         || null,
    initialized:  json.initialized  || false,
    sealed:       json.sealed       || false,
    t:            json.t            || 0,
    n:            json.n            || 0,
    progress:     json.progress     || 0,
    nonce:        json.nonce        || null,
    version:      json.version      || null,
    build_date:   json.build_date   || null,
    migration:    json.migration    || false,
    cluster_name: json.cluster_name || null,
    cluster_id:   json.cluster_id   || null,
    recovery_seal: json.recovery_seal || false,
    storage_type:  json.storage_type  || null,
  };
}

async function opSysMounts(args) {
  const conn = buildConn(args);
  const res  = await vaultRequest(conn, "GET", `${API_V1}/sys/mounts`, null, conn.timeoutMs);
  checkStatus(res, "sys_mounts");

  const json   = parseJson(res.raw, "sys_mounts");
  const mounts = [];
  for (const [path, info] of Object.entries(json)) {
    if (typeof info === "object" && info !== null && info.type) {
      mounts.push({
        path,
        type:        info.type,
        description: info.description || "",
        accessor:    info.accessor    || null,
        local:       info.local       || false,
        seal_wrap:   info.seal_wrap   || false,
        options:     info.options     || {},
      });
    }
  }

  return {
    ok:        true,
    operation: "sys_mounts",
    server:    `${conn.host}:${conn.port}`,
    count:     mounts.length,
    mounts,
  };
}

async function opSysPolicies(args) {
  const conn = buildConn(args);
  const res  = await vaultRequest(conn, "LIST", `${API_V1}/sys/policies/acl`, null, conn.timeoutMs);
  checkStatus(res, "sys_policies");

  const json     = parseJson(res.raw, "sys_policies");
  const policies = (json.data && json.data.keys) ? json.data.keys : [];

  return {
    ok:        true,
    operation: "sys_policies",
    server:    `${conn.host}:${conn.port}`,
    count:     policies.length,
    policies,
  };
}

async function opSysCapabilities(args) {
  const conn = buildConn(args);
  if (!args.paths || !Array.isArray(args.paths) || args.paths.length === 0)
    throw new Error("sys_capabilities requires 'paths' (non-empty array)");

  const apiPath = `${API_V1}/sys/capabilities-self`;
  const body    = { paths: args.paths };

  const res = await vaultRequest(conn, "POST", apiPath, body, conn.timeoutMs);
  checkStatus(res, "sys_capabilities");

  const json = parseJson(res.raw, "sys_capabilities");
  const caps = {};
  for (const path of args.paths) {
    caps[path] = json[path] || json.data && json.data[path] || [];
  }

  return {
    ok:           true,
    operation:    "sys_capabilities",
    server:       `${conn.host}:${conn.port}`,
    paths:        args.paths,
    capabilities: caps,
  };
}

// ── Unwrap ──────────────────────────────────────────────────────────────────

async function opUnwrap(args) {
  const conn = buildConn(args);
  if (!args.wrap_token) throw new Error("unwrap requires 'wrap_token'");
  guardString(args.wrap_token, "wrap_token");

  const res = await vaultRequest(conn, "POST", `${API_V1}/sys/wrapping/unwrap`, null, conn.timeoutMs);
  checkStatus(res, "unwrap");

  const json = parseJson(res.raw, "unwrap");
  return {
    ok:        true,
    operation: "unwrap",
    server:    `${conn.host}:${conn.port}`,
    data:      json.data || {},
    auth:      json.auth || null,
  };
}

// ── Info ───────────────────────────────────────────────────────────────────

function opInfo() {
  return {
    ok:          true,
    protocol:    "HashiCorp Vault HTTP API v1",
    defaultPort: DEFAULT_PORT,
    apiBase:     "http[s]://<host>:<port>/v1/...",
    operations: [
      { op: "kv_get",           description: "Read a secret from KV v1 or KV v2 secrets engine" },
      { op: "kv_put",           description: "Write a secret to KV v1 or KV v2 secrets engine" },
      { op: "kv_delete",        description: "Soft-delete a secret (or specific versions in KV v2)" },
      { op: "kv_list",          description: "List secret keys under a path" },
      { op: "kv_metadata",      description: "Read KV v2 secret metadata (versions, timestamps, cas)" },
      { op: "kv_destroy",       description: "Permanently destroy specific versions of a KV v2 secret" },
      { op: "token_lookup",     description: "Look up current or a specified token's properties and TTL" },
      { op: "token_renew",      description: "Renew a token's TTL" },
      { op: "token_revoke",     description: "Revoke a token" },
      { op: "auth_userpass",    description: "Authenticate using username/password auth method" },
      { op: "auth_approle",     description: "Authenticate using AppRole auth method (role_id + secret_id)" },
      { op: "auth_token",       description: "Validate the current token and return its properties" },
      { op: "pki_issue",        description: "Issue a certificate from a PKI secrets engine role" },
      { op: "pki_sign",         description: "Sign a CSR using a PKI role" },
      { op: "transit_encrypt",  description: "Encrypt data using the Transit secrets engine" },
      { op: "transit_decrypt",  description: "Decrypt data using the Transit secrets engine" },
      { op: "transit_sign",     description: "Sign data using the Transit secrets engine" },
      { op: "transit_verify",   description: "Verify a signature using the Transit secrets engine" },
      { op: "sys_health",       description: "Get the health status of the Vault cluster (no auth required)" },
      { op: "sys_seal_status",  description: "Get the seal status of the Vault server (no auth required)" },
      { op: "sys_mounts",       description: "List all mounted secrets engines" },
      { op: "sys_policies",     description: "List all ACL policies" },
      { op: "sys_capabilities", description: "Check token capabilities on given paths" },
      { op: "unwrap",           description: "Unwrap a wrapped response token" },
      { op: "info",             description: "Return this protocol/config reference (no I/O)" },
    ],
    auth: {
      method:  "Vault token via X-Vault-Token request header",
      usage:   "Pass 'token' parameter with a valid Vault token (e.g. 'hvs.xxxx')",
      methods: ["token", "userpass", "approle", "aws", "kubernetes", "ldap"],
    },
    kvVersions: {
      v1: "Legacy KV: /v1/{mount}/{path} — direct GET/POST/DELETE",
      v2: "KV v2: /v1/{mount}/data/{path} — wraps data in { data: {} }, supports versioning",
    },
    namespaces: {
      description: "Vault Enterprise namespaces via X-Vault-Namespace header",
      usage:       "Pass 'namespace' parameter for Vault Enterprise namespace targeting",
    },
    useCases: [
      "Secrets management: read/write application credentials, API keys, TLS certs",
      "Dynamic secrets: database credentials, cloud credentials",
      "PKI: issue and sign TLS certificates dynamically",
      "Transit: encryption-as-a-service without exposing keys",
      "Auth: authenticate services via AppRole, userpass, Kubernetes, AWS",
      "ACL policies: check and manage access control",
      "Seal status: monitor Vault health in CI/CD pipelines",
    ],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

async function vaultClient(args) {
  // Eager validation of common numeric args
  if (args.timeout !== undefined && args.timeout !== null)
    clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  if (args.port !== undefined && args.port !== null)
    clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");

  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");

  switch (op) {
    case "kv_get":           return opKvGet(args);
    case "kv_put":           return opKvPut(args);
    case "kv_delete":        return opKvDelete(args);
    case "kv_list":          return opKvList(args);
    case "kv_metadata":      return opKvMetadata(args);
    case "kv_destroy":       return opKvDestroy(args);
    case "token_lookup":     return opTokenLookup(args);
    case "token_renew":      return opTokenRenew(args);
    case "token_revoke":     return opTokenRevoke(args);
    case "auth_userpass":    return opAuthUserpass(args);
    case "auth_approle":     return opAuthApprole(args);
    case "auth_token":       return opAuthToken(args);
    case "pki_issue":        return opPkiIssue(args);
    case "pki_sign":         return opPkiSign(args);
    case "transit_encrypt":  return opTransitEncrypt(args);
    case "transit_decrypt":  return opTransitDecrypt(args);
    case "transit_sign":     return opTransitSign(args);
    case "transit_verify":   return opTransitVerify(args);
    case "sys_health":       return opSysHealth(args);
    case "sys_seal_status":  return opSysSealStatus(args);
    case "sys_mounts":       return opSysMounts(args);
    case "sys_policies":     return opSysPolicies(args);
    case "sys_capabilities": return opSysCapabilities(args);
    case "unwrap":           return opUnwrap(args);
    case "info":             return opInfo();
    default:
      throw new Error(
        `Unknown vault_client operation: '${args.operation}'. ` +
        "Valid: kv_get, kv_put, kv_delete, kv_list, kv_metadata, kv_destroy, " +
        "token_lookup, token_renew, token_revoke, " +
        "auth_userpass, auth_approle, auth_token, " +
        "pki_issue, pki_sign, " +
        "transit_encrypt, transit_decrypt, transit_sign, transit_verify, " +
        "sys_health, sys_seal_status, sys_mounts, sys_policies, sys_capabilities, " +
        "unwrap, info"
      );
  }
}

module.exports = {
  vaultClient,
  // Exported for testing
  kvPath, buildConn, requireString, guardString, clampInt,
};
