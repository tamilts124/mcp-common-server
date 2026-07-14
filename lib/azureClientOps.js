"use strict";
/**
 * azure_client — Zero-dependency Microsoft Azure REST API client
 * (pure Node.js https/http built-ins; no npm deps)
 *
 * Authentication: Azure AD / Entra ID OAuth2 Client Credentials flow.
 * Provide tenant_id + client_id + client_secret to obtain a Bearer token
 * automatically (with in-process caching). Alternatively supply a
 * pre-obtained access_token directly.
 *
 * Supported services:
 *   blob         — Azure Blob Storage: list_containers, list_blobs,
 *                  get_blob, put_blob, delete_blob, head_blob,
 *                  create_container, delete_container
 *   keyvault     — Azure Key Vault: get_secret, list_secrets,
 *                  set_secret, delete_secret, get_key, list_keys,
 *                  encrypt, decrypt
 *   servicebus   — Azure Service Bus: send_message, receive_message,
 *                  peek_message, delete_message, list_queues
 *   cosmosdb     — Azure Cosmos DB (SQL API): list_databases,
 *                  list_collections, query_documents, get_document,
 *                  upsert_document, delete_document
 *   resources    — Azure Resource Manager: list_subscriptions,
 *                  list_resource_groups, list_resources,
 *                  get_resource_group
 *   monitor      — Azure Monitor: list_metrics, query_logs
 *   request      — Generic authenticated request to any Azure REST API
 *   info         — Protocol/operation reference (no I/O)
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000-120000 ms.
 *   Credentials (secrets, tokens) never returned in output or errors.
 *   16 MB response cap.
 *   Token cache keyed by tenant_id+client_id+scope, with expiry buffer.
 */

const https  = require("https");
const http   = require("http");
const crypto = require("crypto");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS  = 20000;
const MAX_RESPONSE_BYTES  = 16 * 1024 * 1024; // 16 MB
const ARM_API_VERSION     = "2021-04-01";
const ARM_BASE            = "https://management.azure.com";
const MONITOR_API_VERSION = "2021-05-01";

// In-process token cache: keyed by "tenantId|clientId|scope"
const TOKEN_CACHE = new Map();

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
    if (val.includes("\0"))     throw new Error(`${name} must not contain NUL bytes`);
  }
}

function clampInt(val, def, min, max, name) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min || n > max)  throw new Error(`${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

// ── Low-level HTTP helper ──────────────────────────────────────────────────

function azureHttpRequest(opts) {
  const { url, method, headers, body, timeoutMs, rejectUnauthorized } = opts;
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const useTls   = parsed.protocol === "https:";
    const bodyBuf  = body
      ? (Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"))
      : null;

    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (useTls ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ""),
      method:   (method || "GET").toUpperCase(),
      headers:  { ...headers },
    };
    if (useTls) {
      reqOpts.rejectUnauthorized = rejectUnauthorized !== false;
      reqOpts.servername         = parsed.hostname;
    }
    if (bodyBuf) reqOpts.headers["Content-Length"] = bodyBuf.length;

    const mod    = useTls ? https : http;
    const chunks = [];
    let totalBytes = 0;
    let settled    = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Azure request ${method} ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = mod.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("Azure response exceeded 16 MB cap"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          raw:        Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Azure response stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to ${parsed.hostname}: ${err.message}`));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── OAuth2 / token helpers ─────────────────────────────────────────────────

async function fetchTokenClientCredentials(tenantId, clientId, clientSecret, scope, timeoutMs, rejectUnauthorized) {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body     = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
    scope,
  }).toString();

  const res = await azureHttpRequest({
    url: tokenUrl, method: "POST",
    headers:            { "Content-Type": "application/x-www-form-urlencoded" },
    body, timeoutMs, rejectUnauthorized,
  });

  if (res.statusCode !== 200) {
    let extra = "";
    try {
      const j = JSON.parse(res.raw);
      extra = j.error_description || j.error || res.raw.slice(0, 200);
    } catch (_) { extra = res.raw.slice(0, 200); }
    throw new Error(`Azure token request failed (HTTP ${res.statusCode}): ${extra}`);
  }

  let data;
  try { data = JSON.parse(res.raw); } catch (_) {
    throw new Error("Azure token endpoint returned invalid JSON");
  }
  if (!data.access_token)
    throw new Error("Azure token endpoint: no access_token in response");

  return {
    accessToken: data.access_token,
    expiresAt:   Date.now() + ((data.expires_in || 3600) - 60) * 1000,
  };
}

async function resolveToken(conn) {
  if (conn.accessToken) return conn.accessToken;
  const { tenantId, clientId, clientSecret, scope, timeoutMs, rejectUnauthorized } = conn;
  const cacheKey = `${tenantId}|${clientId}|${scope}`;
  const cached   = TOKEN_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const { accessToken, expiresAt } = await fetchTokenClientCredentials(
    tenantId, clientId, clientSecret, scope, timeoutMs, rejectUnauthorized
  );
  TOKEN_CACHE.set(cacheKey, { token: accessToken, expiresAt });
  return accessToken;
}

// ── Authenticated API request helper ──────────────────────────────────────

async function azureApiRequest(conn, opts) {
  const { url, method, body, extraHeaders } = opts;
  const token = await resolveToken(conn);
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
    ...extraHeaders,
  };
  for (const k of Object.keys(headers)) {
    if (headers[k] == null) delete headers[k];
  }
  const bodyStr = body
    ? (typeof body === "string" ? body : JSON.stringify(body))
    : null;
  if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8");
  return azureHttpRequest({
    url, method: method || "GET", headers, body: bodyStr,
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
}

function parseAzureJson(raw, ctx) {
  try { return JSON.parse(raw); } catch (_) {
    throw new Error(`Azure: invalid JSON response (${ctx}): ${raw.slice(0, 200)}`);
  }
}

function checkAzureStatus(res, ctx) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let extra = "";
    try {
      const j = JSON.parse(res.raw);
      const e = j.error || {};
      extra = e.message || e.code || JSON.stringify(e);
    } catch (_) { extra = res.raw.slice(0, 300); }
    throw new Error(`Azure ${ctx}: HTTP ${res.statusCode} — ${extra}`);
  }
}

// ── Connection builder ─────────────────────────────────────────────────────

const DEFAULT_ARM_SCOPE = "https://management.azure.com/.default";

function buildConn(args) {
  const timeoutMs          = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  const rejectUnauthorized = args.reject_unauthorized !== false;
  const scope              = args.scope || DEFAULT_ARM_SCOPE;

  if (args.tenant_id) {
    requireString(args.tenant_id,     "tenant_id");
    requireString(args.client_id,     "client_id");
    requireString(args.client_secret, "client_secret");
    return {
      mode:               "client_credentials",
      tenantId:           args.tenant_id,
      clientId:           args.client_id,
      clientSecret:       args.client_secret,
      scope,
      subscriptionId:     args.subscription_id || null,
      timeoutMs,
      rejectUnauthorized,
    };
  }

  if (args.access_token) {
    requireString(args.access_token, "access_token");
    return {
      mode:           "access_token",
      accessToken:    args.access_token,
      subscriptionId: args.subscription_id || null,
      scope,
      timeoutMs,
      rejectUnauthorized,
    };
  }

  throw new Error(
    "azure_client: provide either (tenant_id + client_id + client_secret) for " +
    "OAuth2 Client Credentials, or 'access_token' (pre-obtained Bearer token). " +
    "The 'info' operation does not require credentials."
  );
}

function requireSubscription(conn, opName) {
  if (!conn.subscriptionId)
    throw new Error(`azure_client ${opName}: 'subscription_id' is required for this operation`);
}

// ── Blob Storage Operations ────────────────────────────────────────────────

function blobBase(args) {
  if (args.custom_endpoint) return args.custom_endpoint.replace(/\/$/, "");
  requireString(args.storage_account, "storage_account");
  return `https://${args.storage_account}.blob.core.windows.net`;
}

async function opBlobListContainers(args, conn) {
  const base = blobBase(args);
  const res  = await azureApiRequest(conn, {
    url: `${base}/?comp=list`, method: "GET",
    extraHeaders: { "x-ms-version": "2021-06-08" },
  });
  checkAzureStatus(res, "blob.list_containers");
  const names = [];
  const re    = /<Name>([^<]+)<\/Name>/g;
  let m;
  while ((m = re.exec(res.raw)) !== null) names.push(m[1]);
  return {
    ok: true, operation: "blob_list_containers",
    account:    args.storage_account || args.custom_endpoint,
    count:      names.length,
    containers: names,
  };
}

async function opBlobCreateContainer(args, conn) {
  requireString(args.container, "container");
  const base   = blobBase(args);
  const access = args.public_access || "off";
  const url    = `${base}/${encodeURIComponent(args.container)}?restype=container`;
  const headers = { "x-ms-version": "2021-06-08", "Content-Length": 0 };
  if (access !== "off") headers["x-ms-blob-public-access"] = access;
  const res = await azureApiRequest(conn, { url, method: "PUT", extraHeaders: headers });
  if (res.statusCode === 409) return { ok: true, operation: "blob_create_container", container: args.container, created: false, reason: "already_exists" };
  checkAzureStatus(res, "blob.create_container");
  return { ok: true, operation: "blob_create_container", container: args.container, created: true };
}

async function opBlobDeleteContainer(args, conn) {
  requireString(args.container, "container");
  const base = blobBase(args);
  const url  = `${base}/${encodeURIComponent(args.container)}?restype=container`;
  const res  = await azureApiRequest(conn, { url, method: "DELETE", extraHeaders: { "x-ms-version": "2021-06-08" } });
  if (res.statusCode === 404) return { ok: true, operation: "blob_delete_container", container: args.container, deleted: false, reason: "not_found" };
  checkAzureStatus(res, "blob.delete_container");
  return { ok: true, operation: "blob_delete_container", container: args.container, deleted: true };
}

async function opBlobListBlobs(args, conn) {
  requireString(args.container, "container");
  const base = blobBase(args);
  let url    = `${base}/${encodeURIComponent(args.container)}?restype=container&comp=list`;
  if (args.prefix)      url += `&prefix=${encodeURIComponent(args.prefix)}`;
  if (args.max_results) url += `&maxresults=${args.max_results}`;
  const res = await azureApiRequest(conn, { url, method: "GET", extraHeaders: { "x-ms-version": "2021-06-08" } });
  checkAzureStatus(res, "blob.list_blobs");
  const blobs  = [];
  const reBlob = /<Blob>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<\/Blob>/g;
  let m;
  while ((m = reBlob.exec(res.raw)) !== null) {
    const block = m[0];
    const name  = m[1];
    const sizeM = /<Content-Length>(\d+)<\/Content-Length>/.exec(block);
    const ctM   = /<Content-Type>([^<]+)<\/Content-Type>/.exec(block);
    const etM   = /<Etag>([^<]+)<\/Etag>/.exec(block);
    blobs.push({
      name,
      size:         sizeM ? parseInt(sizeM[1]) : null,
      content_type: ctM   ? ctM[1] : null,
      etag:         etM   ? etM[1] : null,
    });
  }
  return {
    ok: true, operation: "blob_list_blobs",
    account: args.storage_account || args.custom_endpoint,
    container: args.container, prefix: args.prefix || "",
    count: blobs.length, blobs,
  };
}

async function opBlobGetBlob(args, conn) {
  requireString(args.container, "container");
  requireString(args.blob,      "blob");
  const base = blobBase(args);
  const url  = `${base}/${encodeURIComponent(args.container)}/${encodeURIComponent(args.blob)}`;
  const res  = await azureApiRequest(conn, { url, method: "GET", extraHeaders: { "x-ms-version": "2021-06-08" } });
  if (res.statusCode === 404) return { ok: true, operation: "blob_get_blob", container: args.container, blob: args.blob, exists: false };
  checkAzureStatus(res, "blob.get_blob");
  const ct     = res.headers["content-type"] || "";
  const isText = ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("javascript");
  return {
    ok: true, operation: "blob_get_blob",
    container: args.container, blob: args.blob, exists: true,
    content_type: ct, size_bytes: res.raw.length,
    etag: res.headers["etag"] || null,
    body: isText ? res.raw : Buffer.from(res.raw, "binary").toString("base64"),
    body_encoding: isText ? "utf8" : "base64",
  };
}

async function opBlobPutBlob(args, conn) {
  requireString(args.container, "container");
  requireString(args.blob,      "blob");
  const base    = blobBase(args);
  const url     = `${base}/${encodeURIComponent(args.container)}/${encodeURIComponent(args.blob)}`;
  const bodyBuf = args.body_base64
    ? Buffer.from(args.body_base64, "base64")
    : Buffer.from(args.body || "", "utf8");
  const ct  = args.content_type || "application/octet-stream";
  const res = await azureApiRequest(conn, {
    url, method: "PUT",
    body: bodyBuf.toString("binary"),
    extraHeaders: {
      "x-ms-version":   "2021-06-08",
      "x-ms-blob-type": "BlockBlob",
      "Content-Type":   ct,
      "Content-Length": bodyBuf.length,
    },
  });
  checkAzureStatus(res, "blob.put_blob");
  return {
    ok: true, operation: "blob_put_blob",
    container: args.container, blob: args.blob,
    size_bytes: bodyBuf.length, content_type: ct,
    etag: res.headers["etag"] || null,
  };
}

async function opBlobDeleteBlob(args, conn) {
  requireString(args.container, "container");
  requireString(args.blob,      "blob");
  const base = blobBase(args);
  const url  = `${base}/${encodeURIComponent(args.container)}/${encodeURIComponent(args.blob)}`;
  const res  = await azureApiRequest(conn, { url, method: "DELETE", extraHeaders: { "x-ms-version": "2021-06-08" } });
  if (res.statusCode === 404) return { ok: true, operation: "blob_delete_blob", container: args.container, blob: args.blob, deleted: false, reason: "not_found" };
  checkAzureStatus(res, "blob.delete_blob");
  return { ok: true, operation: "blob_delete_blob", container: args.container, blob: args.blob, deleted: true };
}

async function opBlobHeadBlob(args, conn) {
  requireString(args.container, "container");
  requireString(args.blob,      "blob");
  const base = blobBase(args);
  const url  = `${base}/${encodeURIComponent(args.container)}/${encodeURIComponent(args.blob)}`;
  const res  = await azureApiRequest(conn, { url, method: "HEAD", extraHeaders: { "x-ms-version": "2021-06-08" } });
  if (res.statusCode === 404) return { ok: true, operation: "blob_head_blob", container: args.container, blob: args.blob, exists: false };
  checkAzureStatus(res, "blob.head_blob");
  return {
    ok: true, operation: "blob_head_blob",
    container: args.container, blob: args.blob, exists: true,
    content_type:  res.headers["content-type"] || null,
    size_bytes:    res.headers["content-length"] ? parseInt(res.headers["content-length"]) : null,
    etag:          res.headers["etag"] || null,
    last_modified: res.headers["last-modified"] || null,
  };
}

// ── Key Vault Operations ───────────────────────────────────────────────────

function kvBase(args) {
  if (args.vault_url)  return args.vault_url.replace(/\/$/, "");
  if (args.vault_name) return `https://${args.vault_name}.vault.azure.net`;
  throw new Error("azure_client: provide 'vault_url' or 'vault_name' for Key Vault operations");
}

async function opKvGetSecret(args, conn) {
  requireString(args.secret_name, "secret_name");
  const base    = kvBase(args);
  const version = args.secret_version || "";
  const url     = `${base}/secrets/${encodeURIComponent(args.secret_name)}/${version}?api-version=7.4`;
  const res     = await azureApiRequest(conn, { url, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "kv_get_secret", secret_name: args.secret_name, exists: false };
  checkAzureStatus(res, "keyvault.get_secret");
  const data = parseAzureJson(res.raw, "keyvault.get_secret");
  return {
    ok: true, operation: "kv_get_secret",
    secret_name: args.secret_name, exists: true, id: data.id, value: data.value,
    content_type: data.contentType || null,
    enabled: data.attributes?.enabled,
    created: data.attributes?.created ? new Date(data.attributes.created * 1000).toISOString() : null,
    updated: data.attributes?.updated ? new Date(data.attributes.updated * 1000).toISOString() : null,
    expires: data.attributes?.exp     ? new Date(data.attributes.exp     * 1000).toISOString() : null,
  };
}

async function opKvListSecrets(args, conn) {
  const base = kvBase(args);
  const url  = `${base}/secrets?api-version=7.4${args.max_results ? `&$top=${args.max_results}` : ""}`;
  const res  = await azureApiRequest(conn, { url, method: "GET" });
  checkAzureStatus(res, "keyvault.list_secrets");
  const data    = parseAzureJson(res.raw, "keyvault.list_secrets");
  const secrets = (data.value || []).map(s => ({
    id:      s.id,
    name:    s.id.split("/").pop(),
    enabled: s.attributes?.enabled,
    created: s.attributes?.created ? new Date(s.attributes.created * 1000).toISOString() : null,
  }));
  return { ok: true, operation: "kv_list_secrets", count: secrets.length, secrets, next_link: data.nextLink || null };
}

async function opKvSetSecret(args, conn) {
  requireString(args.secret_name,  "secret_name");
  requireString(args.secret_value, "secret_value");
  const base = kvBase(args);
  const url  = `${base}/secrets/${encodeURIComponent(args.secret_name)}?api-version=7.4`;
  const body = {
    value: args.secret_value,
    ...(args.content_type  ? { contentType: args.content_type }  : {}),
    ...(args.enabled !== undefined ? { attributes: { enabled: args.enabled } } : {}),
  };
  const res = await azureApiRequest(conn, { url, method: "PUT", body });
  checkAzureStatus(res, "keyvault.set_secret");
  const data = parseAzureJson(res.raw, "keyvault.set_secret");
  return {
    ok: true, operation: "kv_set_secret",
    secret_name: args.secret_name, id: data.id,
    enabled: data.attributes?.enabled,
    created: data.attributes?.created ? new Date(data.attributes.created * 1000).toISOString() : null,
  };
}

async function opKvDeleteSecret(args, conn) {
  requireString(args.secret_name, "secret_name");
  const base = kvBase(args);
  const url  = `${base}/secrets/${encodeURIComponent(args.secret_name)}?api-version=7.4`;
  const res  = await azureApiRequest(conn, { url, method: "DELETE" });
  if (res.statusCode === 404) return { ok: true, operation: "kv_delete_secret", secret_name: args.secret_name, deleted: false, reason: "not_found" };
  checkAzureStatus(res, "keyvault.delete_secret");
  const data = parseAzureJson(res.raw, "keyvault.delete_secret");
  return {
    ok: true, operation: "kv_delete_secret",
    secret_name: args.secret_name, deleted: true,
    scheduled_purge_date: data.scheduledPurgeDate || null,
  };
}

async function opKvGetKey(args, conn) {
  requireString(args.key_name, "key_name");
  const base    = kvBase(args);
  const version = args.key_version || "";
  const url     = `${base}/keys/${encodeURIComponent(args.key_name)}/${version}?api-version=7.4`;
  const res     = await azureApiRequest(conn, { url, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "kv_get_key", key_name: args.key_name, exists: false };
  checkAzureStatus(res, "keyvault.get_key");
  const data = parseAzureJson(res.raw, "keyvault.get_key");
  return {
    ok: true, operation: "kv_get_key",
    key_name: args.key_name, exists: true,
    id: data.key?.kid, key_type: data.key?.kty, ops: data.key?.key_ops || [],
    enabled: data.attributes?.enabled,
    created: data.attributes?.created ? new Date(data.attributes.created * 1000).toISOString() : null,
  };
}

async function opKvListKeys(args, conn) {
  const base = kvBase(args);
  const url  = `${base}/keys?api-version=7.4${args.max_results ? `&$top=${args.max_results}` : ""}`;
  const res  = await azureApiRequest(conn, { url, method: "GET" });
  checkAzureStatus(res, "keyvault.list_keys");
  const data = parseAzureJson(res.raw, "keyvault.list_keys");
  const keys = (data.value || []).map(k => ({
    id:      k.kid,
    name:    (k.kid || "").split("/").slice(-2, -1)[0] || (k.kid || "").split("/").pop(),
    enabled: k.attributes?.enabled,
    created: k.attributes?.created ? new Date(k.attributes.created * 1000).toISOString() : null,
  }));
  return { ok: true, operation: "kv_list_keys", count: keys.length, keys, next_link: data.nextLink || null };
}

async function opKvEncrypt(args, conn) {
  requireString(args.key_name, "key_name");
  if (!args.plaintext && !args.plaintext_base64)
    throw new Error("kv_encrypt: provide 'plaintext' (string) or 'plaintext_base64' (base64)");
  const base    = kvBase(args);
  const version = args.key_version || "";
  const url     = `${base}/keys/${encodeURIComponent(args.key_name)}/${version}/encrypt?api-version=7.4`;
  const valueB64 = args.plaintext_base64
    ? args.plaintext_base64
    : Buffer.from(args.plaintext, "utf8").toString("base64url");
  const body = { alg: args.algorithm || "RSA-OAEP", value: valueB64 };
  const res  = await azureApiRequest(conn, { url, method: "POST", body });
  checkAzureStatus(res, "keyvault.encrypt");
  const data = parseAzureJson(res.raw, "keyvault.encrypt");
  return { ok: true, operation: "kv_encrypt", key_id: data.kid, algorithm: args.algorithm || "RSA-OAEP", ciphertext: data.value };
}

async function opKvDecrypt(args, conn) {
  requireString(args.key_name,  "key_name");
  requireString(args.ciphertext, "ciphertext");
  const base    = kvBase(args);
  const version = args.key_version || "";
  const url     = `${base}/keys/${encodeURIComponent(args.key_name)}/${version}/decrypt?api-version=7.4`;
  const body    = { alg: args.algorithm || "RSA-OAEP", value: args.ciphertext };
  const res     = await azureApiRequest(conn, { url, method: "POST", body });
  checkAzureStatus(res, "keyvault.decrypt");
  const data      = parseAzureJson(res.raw, "keyvault.decrypt");
  const plaintext = data.value ? Buffer.from(data.value, "base64url").toString("utf8") : null;
  return { ok: true, operation: "kv_decrypt", key_id: data.kid, algorithm: args.algorithm || "RSA-OAEP", plaintext };
}

// ── Service Bus Operations ─────────────────────────────────────────────────

function sbBase(args) {
  if (args.namespace_url)  return args.namespace_url.replace(/\/$/, "");
  if (args.namespace_name) return `https://${args.namespace_name}.servicebus.windows.net`;
  throw new Error("azure_client: provide 'namespace_url' or 'namespace_name' for Service Bus operations");
}

async function opSbSendMessage(args, conn) {
  requireString(args.queue_name, "queue_name");
  if (args.message === undefined || args.message === null)
    throw new Error("sb_send_message: 'message' is required");
  const base    = sbBase(args);
  const url     = `${base}/${encodeURIComponent(args.queue_name)}/messages`;
  const bodyStr = typeof args.message === "string" ? args.message : JSON.stringify(args.message);
  const brokerProps = {};
  if (args.message_id)     brokerProps.MessageId      = args.message_id;
  if (args.correlation_id) brokerProps.CorrelationId  = args.correlation_id;
  if (args.session_id)     brokerProps.SessionId      = args.session_id;
  if (args.time_to_live)   brokerProps.TimeToLiveTimeSpan = args.time_to_live;
  const headers = {
    "Content-Type":    args.content_type || "application/json",
    "BrokerProperties": JSON.stringify(brokerProps),
  };
  const res = await azureApiRequest(conn, { url, method: "POST", body: bodyStr, extraHeaders: headers });
  checkAzureStatus(res, "servicebus.send_message");
  return { ok: true, operation: "sb_send_message", queue: args.queue_name, sent: true };
}

async function opSbReceiveMessage(args, conn) {
  requireString(args.queue_name, "queue_name");
  const base    = sbBase(args);
  const timeout = Math.min(args.timeout_seconds || 5, 60);
  const url     = `${base}/${encodeURIComponent(args.queue_name)}/messages/head?timeout=${timeout}`;
  const res     = await azureApiRequest(conn, { url, method: "POST", extraHeaders: { "Content-Length": 0 } });
  if (res.statusCode === 204) return { ok: true, operation: "sb_receive_message", queue: args.queue_name, message: null };
  checkAzureStatus(res, "servicebus.receive_message");
  let brokerProps = {};
  try { brokerProps = JSON.parse(res.headers["brokerproperties"] || "{}"); } catch (_) {}
  return {
    ok: true, operation: "sb_receive_message",
    queue: args.queue_name, message: res.raw,
    message_id:      brokerProps.MessageId || null,
    lock_token:      brokerProps.LockToken || null,
    sequence_number: brokerProps.SequenceNumber || null,
    enqueued_at:     brokerProps.EnqueuedTimeUtc || null,
  };
}

async function opSbPeekMessage(args, conn) {
  requireString(args.queue_name, "queue_name");
  const base = sbBase(args);
  const url  = `${base}/${encodeURIComponent(args.queue_name)}/messages/head`;
  const res  = await azureApiRequest(conn, { url, method: "GET" });
  if (res.statusCode === 204) return { ok: true, operation: "sb_peek_message", queue: args.queue_name, message: null };
  checkAzureStatus(res, "servicebus.peek_message");
  let brokerProps = {};
  try { brokerProps = JSON.parse(res.headers["brokerproperties"] || "{}"); } catch (_) {}
  return {
    ok: true, operation: "sb_peek_message",
    queue: args.queue_name, message: res.raw,
    message_id:      brokerProps.MessageId || null,
    sequence_number: brokerProps.SequenceNumber || null,
  };
}

async function opSbDeleteMessage(args, conn) {
  requireString(args.queue_name,    "queue_name");
  requireString(args.lock_token,    "lock_token");
  requireString(args.sequence_number, "sequence_number");
  const base = sbBase(args);
  const url  = `${base}/${encodeURIComponent(args.queue_name)}/messages/${args.sequence_number}/${args.lock_token}`;
  const res  = await azureApiRequest(conn, { url, method: "DELETE" });
  if (res.statusCode === 404) return { ok: true, operation: "sb_delete_message", deleted: false, reason: "not_found" };
  checkAzureStatus(res, "servicebus.delete_message");
  return { ok: true, operation: "sb_delete_message", queue: args.queue_name, deleted: true };
}

async function opSbListQueues(args, conn) {
  const base = sbBase(args);
  const url  = `${base}/$Resources/Queues`;
  const res  = await azureApiRequest(conn, { url, method: "GET", extraHeaders: { "Accept": "application/json" } });
  checkAzureStatus(res, "servicebus.list_queues");
  const queues  = [];
  const reQueue = /<title[^>]*>([^<]+)<\/title>/g;
  let m;
  while ((m = reQueue.exec(res.raw)) !== null) queues.push(m[1]);
  return { ok: true, operation: "sb_list_queues", count: queues.length, queues };
}

// ── Cosmos DB Operations ───────────────────────────────────────────────────

function cosmosBase(args) {
  if (args.cosmos_url)     return args.cosmos_url.replace(/\/$/, "");
  if (args.cosmos_account) return `https://${args.cosmos_account}.documents.azure.com`;
  throw new Error("azure_client: provide 'cosmos_url' or 'cosmos_account' for Cosmos DB operations");
}

function cosmosAuthHeader(method, resourceType, resourceId, date, masterKey) {
  const keyBuf  = Buffer.from(masterKey, "base64");
  const payload = `${method.toLowerCase()}\n${resourceType.toLowerCase()}\n${resourceId}\n${date.toLowerCase()}\n\n`;
  const sig     = crypto.createHmac("sha256", keyBuf).update(payload, "utf8").digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

function cosmosHeaders(method, resourceType, resourceId, masterKey) {
  const date = new Date().toUTCString();
  return {
    "x-ms-date":     date,
    "x-ms-version":  "2018-12-31",
    "Authorization": cosmosAuthHeader(method, resourceType, resourceId, date, masterKey),
  };
}

async function opCosmosListDatabases(args, conn) {
  requireString(args.cosmos_master_key, "cosmos_master_key");
  const base    = cosmosBase(args);
  const headers = cosmosHeaders("GET", "dbs", "", args.cosmos_master_key);
  const res     = await azureHttpRequest({
    url: `${base}/dbs`, method: "GET",
    headers: { ...headers, Accept: "application/json" },
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
  checkAzureStatus(res, "cosmosdb.list_databases");
  const data = parseAzureJson(res.raw, "cosmosdb.list_databases");
  const dbs  = (data.Databases || []).map(d => ({ id: d.id, rid: d._rid, self: d._self }));
  return { ok: true, operation: "cosmos_list_databases", count: dbs.length, databases: dbs };
}

async function opCosmosListCollections(args, conn) {
  requireString(args.cosmos_master_key, "cosmos_master_key");
  requireString(args.database,          "database");
  const base    = cosmosBase(args);
  const rid     = `dbs/${args.database}`;
  const headers = cosmosHeaders("GET", "colls", rid, args.cosmos_master_key);
  const res     = await azureHttpRequest({
    url: `${base}/dbs/${encodeURIComponent(args.database)}/colls`, method: "GET",
    headers: { ...headers, Accept: "application/json" },
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
  checkAzureStatus(res, "cosmosdb.list_collections");
  const data  = parseAzureJson(res.raw, "cosmosdb.list_collections");
  const colls = (data.DocumentCollections || []).map(c => ({ id: c.id, rid: c._rid }));
  return { ok: true, operation: "cosmos_list_collections", database: args.database, count: colls.length, collections: colls };
}

async function opCosmosQueryDocuments(args, conn) {
  requireString(args.cosmos_master_key, "cosmos_master_key");
  requireString(args.database,          "database");
  requireString(args.collection,        "collection");
  requireString(args.query,             "query");
  const base    = cosmosBase(args);
  const rid     = `dbs/${args.database}/colls/${args.collection}`;
  const headers = {
    ...cosmosHeaders("POST", "docs", rid, args.cosmos_master_key),
    "Content-Type":  "application/query+json",
    "Accept":        "application/json",
    "x-ms-documentdb-isquery": "true",
    "x-ms-documentdb-query-enablecrosspartition": "true",
  };
  if (args.max_results) headers["x-ms-max-item-count"] = String(args.max_results);
  const body = JSON.stringify({ query: args.query, parameters: args.parameters || [] });
  const res  = await azureHttpRequest({
    url: `${base}/dbs/${encodeURIComponent(args.database)}/colls/${encodeURIComponent(args.collection)}/docs`,
    method: "POST", headers, body,
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
  checkAzureStatus(res, "cosmosdb.query_documents");
  const data = parseAzureJson(res.raw, "cosmosdb.query_documents");
  return {
    ok: true, operation: "cosmos_query_documents",
    database: args.database, collection: args.collection, query: args.query,
    count: (data.Documents || []).length, documents: data.Documents || [],
  };
}

async function opCosmosGetDocument(args, conn) {
  requireString(args.cosmos_master_key, "cosmos_master_key");
  requireString(args.database,          "database");
  requireString(args.collection,        "collection");
  requireString(args.document_id,       "document_id");
  const base    = cosmosBase(args);
  const rid     = `dbs/${args.database}/colls/${args.collection}/docs/${args.document_id}`;
  const headers = {
    ...cosmosHeaders("GET", "docs", rid, args.cosmos_master_key),
    "Accept": "application/json",
  };
  if (args.partition_key !== undefined)
    headers["x-ms-documentdb-partitionkey"] = JSON.stringify([args.partition_key]);
  const res = await azureHttpRequest({
    url: `${base}/dbs/${encodeURIComponent(args.database)}/colls/${encodeURIComponent(args.collection)}/docs/${encodeURIComponent(args.document_id)}`,
    method: "GET", headers,
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
  if (res.statusCode === 404) return { ok: true, operation: "cosmos_get_document", document_id: args.document_id, exists: false };
  checkAzureStatus(res, "cosmosdb.get_document");
  const doc = parseAzureJson(res.raw, "cosmosdb.get_document");
  return { ok: true, operation: "cosmos_get_document", document_id: args.document_id, exists: true, document: doc };
}

async function opCosmosUpsertDocument(args, conn) {
  requireString(args.cosmos_master_key, "cosmos_master_key");
  requireString(args.database,          "database");
  requireString(args.collection,        "collection");
  if (!args.document || typeof args.document !== "object")
    throw new Error("cosmos_upsert_document: 'document' must be a non-null object");
  const base    = cosmosBase(args);
  const rid     = `dbs/${args.database}/colls/${args.collection}`;
  const headers = {
    ...cosmosHeaders("POST", "docs", rid, args.cosmos_master_key),
    "Content-Type":  "application/json",
    "Accept":        "application/json",
    "x-ms-documentdb-is-upsert": "true",
  };
  if (args.partition_key !== undefined)
    headers["x-ms-documentdb-partitionkey"] = JSON.stringify([args.partition_key]);
  const res = await azureHttpRequest({
    url: `${base}/dbs/${encodeURIComponent(args.database)}/colls/${encodeURIComponent(args.collection)}/docs`,
    method: "POST", headers, body: JSON.stringify(args.document),
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
  checkAzureStatus(res, "cosmosdb.upsert_document");
  const doc = parseAzureJson(res.raw, "cosmosdb.upsert_document");
  return {
    ok: true, operation: "cosmos_upsert_document",
    document_id: doc.id || null, rid: doc._rid || null, etag: doc._etag || null,
  };
}

async function opCosmosDeleteDocument(args, conn) {
  requireString(args.cosmos_master_key, "cosmos_master_key");
  requireString(args.database,          "database");
  requireString(args.collection,        "collection");
  requireString(args.document_id,       "document_id");
  const base    = cosmosBase(args);
  const rid     = `dbs/${args.database}/colls/${args.collection}/docs/${args.document_id}`;
  const headers = {
    ...cosmosHeaders("DELETE", "docs", rid, args.cosmos_master_key),
    "Accept": "application/json",
  };
  if (args.partition_key !== undefined)
    headers["x-ms-documentdb-partitionkey"] = JSON.stringify([args.partition_key]);
  const res = await azureHttpRequest({
    url: `${base}/dbs/${encodeURIComponent(args.database)}/colls/${encodeURIComponent(args.collection)}/docs/${encodeURIComponent(args.document_id)}`,
    method: "DELETE", headers,
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
  if (res.statusCode === 404) return { ok: true, operation: "cosmos_delete_document", document_id: args.document_id, deleted: false, reason: "not_found" };
  checkAzureStatus(res, "cosmosdb.delete_document");
  return { ok: true, operation: "cosmos_delete_document", document_id: args.document_id, deleted: true };
}

// ── Azure Resource Manager Operations ─────────────────────────────────────

async function opArmListSubscriptions(args, conn) {
  const url = `${ARM_BASE}/subscriptions?api-version=${ARM_API_VERSION}`;
  const res = await azureApiRequest(conn, { url, method: "GET" });
  checkAzureStatus(res, "resources.list_subscriptions");
  const data = parseAzureJson(res.raw, "resources.list_subscriptions");
  const subs = (data.value || []).map(s => ({
    id: s.subscriptionId, name: s.displayName, state: s.state, tenant_id: s.tenantId,
  }));
  return { ok: true, operation: "arm_list_subscriptions", count: subs.length, subscriptions: subs };
}

async function opArmListResourceGroups(args, conn) {
  requireSubscription(conn, "arm_list_resource_groups");
  const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(conn.subscriptionId)}/resourcegroups?api-version=${ARM_API_VERSION}`;
  const res = await azureApiRequest(conn, { url, method: "GET" });
  checkAzureStatus(res, "resources.list_resource_groups");
  const data   = parseAzureJson(res.raw, "resources.list_resource_groups");
  const groups = (data.value || []).map(g => ({
    name: g.name, location: g.location, id: g.id,
    state: g.properties?.provisioningState, tags: g.tags || {},
  }));
  return {
    ok: true, operation: "arm_list_resource_groups",
    subscription_id: conn.subscriptionId,
    count: groups.length, resource_groups: groups, next_link: data.nextLink || null,
  };
}

async function opArmGetResourceGroup(args, conn) {
  requireSubscription(conn, "arm_get_resource_group");
  requireString(args.resource_group, "resource_group");
  const url = `${ARM_BASE}/subscriptions/${encodeURIComponent(conn.subscriptionId)}/resourcegroups/${encodeURIComponent(args.resource_group)}?api-version=${ARM_API_VERSION}`;
  const res = await azureApiRequest(conn, { url, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "arm_get_resource_group", resource_group: args.resource_group, exists: false };
  checkAzureStatus(res, "resources.get_resource_group");
  const g = parseAzureJson(res.raw, "resources.get_resource_group");
  return {
    ok: true, operation: "arm_get_resource_group", exists: true,
    name: g.name, id: g.id, location: g.location,
    state: g.properties?.provisioningState, tags: g.tags || {},
  };
}

async function opArmListResources(args, conn) {
  requireSubscription(conn, "arm_list_resources");
  let url = `${ARM_BASE}/subscriptions/${encodeURIComponent(conn.subscriptionId)}/resources?api-version=${ARM_API_VERSION}`;
  if (args.resource_group)
    url = `${ARM_BASE}/subscriptions/${encodeURIComponent(conn.subscriptionId)}/resourcegroups/${encodeURIComponent(args.resource_group)}/resources?api-version=${ARM_API_VERSION}`;
  if (args.filter)      url += `&$filter=${encodeURIComponent(args.filter)}`;
  if (args.max_results) url += `&$top=${args.max_results}`;
  const res = await azureApiRequest(conn, { url, method: "GET" });
  checkAzureStatus(res, "resources.list_resources");
  const data      = parseAzureJson(res.raw, "resources.list_resources");
  const resources = (data.value || []).map(r => ({
    name: r.name, type: r.type, location: r.location, id: r.id, tags: r.tags || {},
  }));
  return {
    ok: true, operation: "arm_list_resources",
    subscription_id: conn.subscriptionId, resource_group: args.resource_group || null,
    count: resources.length, resources, next_link: data.nextLink || null,
  };
}

// ── Azure Monitor Operations ───────────────────────────────────────────────

async function opMonitorListMetrics(args, conn) {
  requireString(args.resource_id, "resource_id");
  let url = `${ARM_BASE}${args.resource_id}/providers/microsoft.insights/metrics?api-version=${MONITOR_API_VERSION}`;
  if (args.metric_names) url += `&metricnames=${encodeURIComponent(args.metric_names)}`;
  if (args.timespan)     url += `&timespan=${encodeURIComponent(args.timespan)}`;
  if (args.interval)     url += `&interval=${args.interval}`;
  if (args.aggregation)  url += `&aggregation=${args.aggregation}`;
  const res = await azureApiRequest(conn, { url, method: "GET" });
  checkAzureStatus(res, "monitor.list_metrics");
  const data    = parseAzureJson(res.raw, "monitor.list_metrics");
  const metrics = (data.value || []).map(m => ({
    name:       m.name?.localizedValue || m.name?.value,
    unit:       m.unit,
    timeseries: (m.timeseries || []).map(ts => ({ data: (ts.data || []).slice(0, 100) })),
  }));
  return {
    ok: true, operation: "monitor_list_metrics",
    resource_id: args.resource_id, count: metrics.length, metrics, next_link: data.nextLink || null,
  };
}

async function opMonitorQueryLogs(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  requireString(args.query,        "query");
  const url  = `https://api.loganalytics.io/v1/workspaces/${encodeURIComponent(args.workspace_id)}/query`;
  const body = { query: args.query, ...(args.timespan ? { timespan: args.timespan } : {}) };
  const res  = await azureApiRequest(conn, { url, method: "POST", body });
  checkAzureStatus(res, "monitor.query_logs");
  const data   = parseAzureJson(res.raw, "monitor.query_logs");
  const tables = (data.tables || []).map(t => ({
    name: t.name, columns: (t.columns || []).map(c => c.name), rows: t.rows || [], count: (t.rows || []).length,
  }));
  return { ok: true, operation: "monitor_query_logs", workspace_id: args.workspace_id, query: args.query, tables };
}

// ── Generic request ────────────────────────────────────────────────────────

async function opRequest(args, conn) {
  requireString(args.url,    "url");
  requireString(args.method, "method");
  const validMethods = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"];
  if (!validMethods.includes(args.method.toUpperCase()))
    throw new Error(`method must be one of: ${validMethods.join(", ")}`);
  const body = args.body
    ? (typeof args.body === "string" ? args.body : JSON.stringify(args.body))
    : undefined;
  const res = await azureApiRequest(conn, {
    url: args.url, method: args.method.toUpperCase(),
    body, extraHeaders: args.extra_headers || {},
  });
  let parsedBody = null;
  const ct = res.headers["content-type"] || "";
  if (ct.includes("json")) {
    try { parsedBody = JSON.parse(res.raw); } catch (_) { parsedBody = res.raw; }
  } else {
    parsedBody = res.raw;
  }
  if (res.statusCode < 200 || res.statusCode >= 300)
    checkAzureStatus(res, `request ${args.method.toUpperCase()} ${args.url}`);
  return {
    ok: true, operation: "request",
    url: args.url, method: args.method.toUpperCase(),
    status_code: res.statusCode, headers: res.headers, body: parsedBody,
  };
}

// ── Info ───────────────────────────────────────────────────────────────────

function opInfo() {
  return {
    ok:       true,
    protocol: "Azure REST API (HTTPS/JSON) with Entra ID OAuth2 Bearer token",
    auth: {
      client_credentials: "tenant_id + client_id + client_secret -> OAuth2 access token (auto-cached)",
      access_token:       "Pre-obtained Bearer token (access_token)",
    },
    operations: [
      { op: "blob_list_containers",  service: "blob",        description: "List all blob containers in a storage account" },
      { op: "blob_create_container", service: "blob",        description: "Create a new blob container" },
      { op: "blob_delete_container", service: "blob",        description: "Delete a blob container" },
      { op: "blob_list_blobs",       service: "blob",        description: "List blobs in a container" },
      { op: "blob_get_blob",         service: "blob",        description: "Download a blob" },
      { op: "blob_put_blob",         service: "blob",        description: "Upload a blob (BlockBlob)" },
      { op: "blob_delete_blob",      service: "blob",        description: "Delete a blob" },
      { op: "blob_head_blob",        service: "blob",        description: "Get blob metadata/properties (no body)" },
      { op: "kv_get_secret",         service: "keyvault",    description: "Get a secret value from Key Vault" },
      { op: "kv_list_secrets",       service: "keyvault",    description: "List secrets in Key Vault" },
      { op: "kv_set_secret",         service: "keyvault",    description: "Create or update a secret in Key Vault" },
      { op: "kv_delete_secret",      service: "keyvault",    description: "Delete a secret from Key Vault" },
      { op: "kv_get_key",            service: "keyvault",    description: "Get a key from Key Vault" },
      { op: "kv_list_keys",          service: "keyvault",    description: "List keys in Key Vault" },
      { op: "kv_encrypt",            service: "keyvault",    description: "Encrypt data using a Key Vault key" },
      { op: "kv_decrypt",            service: "keyvault",    description: "Decrypt data using a Key Vault key" },
      { op: "sb_send_message",       service: "servicebus",  description: "Send a message to a Service Bus queue" },
      { op: "sb_receive_message",    service: "servicebus",  description: "Receive (destructive) a message from a Service Bus queue" },
      { op: "sb_peek_message",       service: "servicebus",  description: "Peek (non-destructive) a message from a Service Bus queue" },
      { op: "sb_delete_message",     service: "servicebus",  description: "Complete/delete a locked Service Bus message" },
      { op: "sb_list_queues",        service: "servicebus",  description: "List queues in a Service Bus namespace" },
      { op: "cosmos_list_databases",   service: "cosmosdb",  description: "List Cosmos DB databases" },
      { op: "cosmos_list_collections", service: "cosmosdb",  description: "List collections in a Cosmos DB database" },
      { op: "cosmos_query_documents",  service: "cosmosdb",  description: "Query documents using Cosmos DB SQL API" },
      { op: "cosmos_get_document",     service: "cosmosdb",  description: "Get a document by ID from Cosmos DB" },
      { op: "cosmos_upsert_document",  service: "cosmosdb",  description: "Upsert a document to Cosmos DB" },
      { op: "cosmos_delete_document",  service: "cosmosdb",  description: "Delete a document from Cosmos DB" },
      { op: "arm_list_subscriptions",   service: "resources", description: "List all Azure subscriptions" },
      { op: "arm_list_resource_groups", service: "resources", description: "List resource groups in a subscription" },
      { op: "arm_get_resource_group",   service: "resources", description: "Get details for a resource group" },
      { op: "arm_list_resources",       service: "resources", description: "List resources in a subscription or resource group" },
      { op: "monitor_list_metrics", service: "monitor", description: "List Azure Monitor metrics for a resource" },
      { op: "monitor_query_logs",   service: "monitor", description: "Query Azure Monitor Log Analytics via KQL" },
      { op: "request", service: "*",    description: "Generic authenticated HTTP request to any Azure REST API URL" },
      { op: "info",    service: "none", description: "Return this reference (no I/O)" },
    ],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

async function azureClient(args) {
  if (args.timeout !== undefined && args.timeout !== null)
    clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");

  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");
  if (op === "info") return opInfo();

  const conn = buildConn(args);

  switch (op) {
    // Blob
    case "blob_list_containers":  return opBlobListContainers(args, conn);
    case "blob_create_container": return opBlobCreateContainer(args, conn);
    case "blob_delete_container": return opBlobDeleteContainer(args, conn);
    case "blob_list_blobs":       return opBlobListBlobs(args, conn);
    case "blob_get_blob":         return opBlobGetBlob(args, conn);
    case "blob_put_blob":         return opBlobPutBlob(args, conn);
    case "blob_delete_blob":      return opBlobDeleteBlob(args, conn);
    case "blob_head_blob":        return opBlobHeadBlob(args, conn);
    // Key Vault
    case "kv_get_secret":    return opKvGetSecret(args, conn);
    case "kv_list_secrets":  return opKvListSecrets(args, conn);
    case "kv_set_secret":    return opKvSetSecret(args, conn);
    case "kv_delete_secret": return opKvDeleteSecret(args, conn);
    case "kv_get_key":       return opKvGetKey(args, conn);
    case "kv_list_keys":     return opKvListKeys(args, conn);
    case "kv_encrypt":       return opKvEncrypt(args, conn);
    case "kv_decrypt":       return opKvDecrypt(args, conn);
    // Service Bus
    case "sb_send_message":    return opSbSendMessage(args, conn);
    case "sb_receive_message": return opSbReceiveMessage(args, conn);
    case "sb_peek_message":    return opSbPeekMessage(args, conn);
    case "sb_delete_message":  return opSbDeleteMessage(args, conn);
    case "sb_list_queues":     return opSbListQueues(args, conn);
    // Cosmos DB
    case "cosmos_list_databases":   return opCosmosListDatabases(args, conn);
    case "cosmos_list_collections": return opCosmosListCollections(args, conn);
    case "cosmos_query_documents":  return opCosmosQueryDocuments(args, conn);
    case "cosmos_get_document":     return opCosmosGetDocument(args, conn);
    case "cosmos_upsert_document":  return opCosmosUpsertDocument(args, conn);
    case "cosmos_delete_document":  return opCosmosDeleteDocument(args, conn);
    // ARM
    case "arm_list_subscriptions":   return opArmListSubscriptions(args, conn);
    case "arm_list_resource_groups": return opArmListResourceGroups(args, conn);
    case "arm_get_resource_group":   return opArmGetResourceGroup(args, conn);
    case "arm_list_resources":       return opArmListResources(args, conn);
    // Monitor
    case "monitor_list_metrics": return opMonitorListMetrics(args, conn);
    case "monitor_query_logs":   return opMonitorQueryLogs(args, conn);
    // Generic
    case "request": return opRequest(args, conn);
    default:
      throw new Error(
        `Unknown azure_client operation: '${args.operation}'. ` +
        "Valid: blob_list_containers, blob_create_container, blob_delete_container, " +
        "blob_list_blobs, blob_get_blob, blob_put_blob, blob_delete_blob, blob_head_blob, " +
        "kv_get_secret, kv_list_secrets, kv_set_secret, kv_delete_secret, " +
        "kv_get_key, kv_list_keys, kv_encrypt, kv_decrypt, " +
        "sb_send_message, sb_receive_message, sb_peek_message, sb_delete_message, sb_list_queues, " +
        "cosmos_list_databases, cosmos_list_collections, cosmos_query_documents, " +
        "cosmos_get_document, cosmos_upsert_document, cosmos_delete_document, " +
        "arm_list_subscriptions, arm_list_resource_groups, arm_get_resource_group, arm_list_resources, " +
        "monitor_list_metrics, monitor_query_logs, request, info"
      );
  }
}

module.exports = {
  azureClient,
  buildConn, requireString, guardString, clampInt,
  parseAzureJson, checkAzureStatus, azureHttpRequest,
  cosmosAuthHeader, cosmosHeaders,
  resolveToken, TOKEN_CACHE,
  fetchTokenClientCredentials,
};
