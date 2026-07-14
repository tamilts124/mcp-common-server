"use strict";
/**
 * gcp_client — Zero-dependency Google Cloud Platform API client
 * (pure Node.js http/https/crypto built-ins; no npm deps)
 *
 * Authentication: Service Account (JSON key file inline or as string) with
 * RS256-signed JWT for self-signed OAuth2 access tokens (google.auth compatible).
 * Also supports access_token (pre-obtained Bearer token) for simpler use cases.
 *
 * Supported services (via REST/JSON API):
 *   gcs        — Cloud Storage: list_buckets, list_objects, get_object,
 *                put_object, delete_object, head_object, get_bucket_metadata
 *   bigquery   — BigQuery: list_datasets, list_tables, query (synchronous),
 *                get_job, list_jobs, insert_rows, get_table_schema
 *   pubsub     — Pub/Sub: list_topics, create_topic, delete_topic,
 *                publish, list_subscriptions, create_subscription,
 *                pull, acknowledge
 *   compute    — Compute Engine: list_instances, get_instance,
 *                list_zones, list_regions, list_machine_types
 *   cloudrun   — Cloud Run: list_services, get_service, list_revisions
 *   iam        — IAM: list_service_accounts, get_service_account,
 *                list_roles, test_permissions
 *   secretmgr  — Secret Manager: list_secrets, get_secret,
 *                access_secret_version, add_secret_version
 *   cloudkms   — Cloud KMS: list_key_rings, list_crypto_keys,
 *                encrypt, decrypt
 *   monitoring — Cloud Monitoring: list_metric_descriptors,
 *                list_time_series, list_monitored_resource_descriptors
 *   request    — Generic authenticated HTTP request to any GCP REST API
 *   info       — Return protocol/service/operation reference (no I/O)
 *
 * Auth:
 *   Option A (service_account): Pass service_account_key as JSON object/string
 *     containing {type, project_id, private_key_id, private_key, client_email, ...}
 *     Generates a short-lived OAuth2 access token using RS256 JWT (2x HTTPS calls).
 *   Option B (access_token): Pass a pre-obtained Bearer token directly.
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000-120000 ms.
 *   Credentials (private keys, access tokens) never returned in output or errors.
 *   16 MB response cap.
 */

const http   = require("http");
const https  = require("https");
const crypto = require("crypto");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB
const TOKEN_SCOPE        = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URL          = "https://oauth2.googleapis.com/token";

// In-process token cache: keyed by client_email, value: { token, expiresAt }
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

// ── JWT / OAuth2 helpers ───────────────────────────────────────────────────

/**
 * URL-safe base64 encode (no padding).
 */
function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Build a RS256-signed JWT for the GCP service account token endpoint.
 * https://developers.google.com/identity/protocols/oauth2/service-account
 */
function buildServiceAccountJwt(clientEmail, privateKeyPem, scopes) {
  const now    = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss:   clientEmail,
    scope: scopes,
    aud:   TOKEN_URL,
    iat:   now,
    exp:   now + 3600,
  };

  const headerB64  = b64urlEncode(Buffer.from(JSON.stringify(header),  "utf8"));
  const claimsB64  = b64urlEncode(Buffer.from(JSON.stringify(claims),  "utf8"));
  const signingInput = `${headerB64}.${claimsB64}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput, "utf8");
  const sigBuf = sign.sign(privateKeyPem);
  const sigB64 = b64urlEncode(sigBuf);

  return `${signingInput}.${sigB64}`;
}

/**
 * Exchange a signed JWT for a GCP OAuth2 access token.
 * Returns { accessToken, expiresAt }.
 */
async function fetchAccessTokenFromServiceAccount(clientEmail, privateKeyPem, scopes, timeoutMs, rejectUnauthorized) {
  const jwt  = buildServiceAccountJwt(clientEmail, privateKeyPem, scopes);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion:  jwt,
  }).toString();

  const res = await gcpHttpRequest({
    url:    TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    timeoutMs,
    rejectUnauthorized,
  });

  if (res.statusCode !== 200) {
    let msg = `GCP OAuth2 token request failed: HTTP ${res.statusCode}`;
    try {
      const j = JSON.parse(res.raw);
      if (j.error_description) msg += ` — ${j.error_description}`;
      else if (j.error)        msg += ` — ${j.error}`;
    } catch (_) {}
    throw new Error(msg);
  }

  let data;
  try { data = JSON.parse(res.raw); } catch (_) {
    throw new Error("GCP OAuth2: invalid JSON response from token endpoint");
  }

  if (!data.access_token)
    throw new Error("GCP OAuth2: no access_token in token response");

  return {
    accessToken: data.access_token,
    expiresAt:   Date.now() + ((data.expires_in || 3600) - 60) * 1000, // 60s buffer
  };
}

/**
 * Resolve a Bearer access token from conn, using in-process cache.
 */
async function resolveAccessToken(conn) {
  // Pre-obtained token
  if (conn.accessToken) return conn.accessToken;

  const { clientEmail, privateKey, scopes, timeoutMs, rejectUnauthorized } = conn;

  // Cache hit
  const cached = TOKEN_CACHE.get(clientEmail);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Fetch new token
  const { accessToken, expiresAt } = await fetchAccessTokenFromServiceAccount(
    clientEmail, privateKey, scopes, timeoutMs, rejectUnauthorized
  );
  TOKEN_CACHE.set(clientEmail, { token: accessToken, expiresAt });
  return accessToken;
}

// ── HTTP helper ────────────────────────────────────────────────────────────

function gcpHttpRequest(opts) {
  const { url, method, headers, body, timeoutMs, rejectUnauthorized } = opts;
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const useTls  = parsed.protocol === "https:";
    const bodyBuf = body
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
    if (bodyBuf) {
      reqOpts.headers["Content-Length"] = bodyBuf.length;
    }

    const mod    = useTls ? https : http;
    const chunks = [];
    let totalBytes = 0;
    let settled    = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`GCP request ${method} ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = mod.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("GCP response exceeded 16 MB cap"));
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
        reject(new Error(`GCP response stream error: ${err.message}`));
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

// ── GCP API request helper ─────────────────────────────────────────────────

async function gcpApiRequest(conn, opts) {
  const { url, method, body, extraHeaders } = opts;
  const token = await resolveAccessToken(conn);

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json",
    ...extraHeaders,
  };

  // Remove undefined/null headers
  for (const k of Object.keys(headers)) {
    if (headers[k] == null) delete headers[k];
  }

  const bodyStr = body
    ? (typeof body === "string" ? body : JSON.stringify(body))
    : null;

  if (bodyStr) {
    headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8");
  }

  return gcpHttpRequest({
    url,
    method: method || "GET",
    headers,
    body:   bodyStr,
    timeoutMs: conn.timeoutMs,
    rejectUnauthorized: conn.rejectUnauthorized,
  });
}

function parseGcpJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`GCP: invalid JSON response (${context}): ${raw.slice(0, 200)}`);
  }
}

function checkGcpStatus(res, context) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let extra = "";
    try {
      const j = JSON.parse(res.raw);
      const err = j.error || {};
      extra = err.message || err.status || JSON.stringify(err);
    } catch (_) {
      extra = res.raw.slice(0, 300);
    }
    throw new Error(`GCP ${context}: HTTP ${res.statusCode} — ${extra}`);
  }
}

// ── Connection builder ─────────────────────────────────────────────────────

function buildConn(args) {
  const timeoutMs          = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  const rejectUnauthorized = args.reject_unauthorized !== false;

  // Option A: service account key
  if (args.service_account_key) {
    let key = args.service_account_key;
    if (typeof key === "string") {
      try { key = JSON.parse(key); } catch (_) {
        throw new Error("service_account_key: invalid JSON string");
      }
    }
    if (typeof key !== "object" || !key.private_key || !key.client_email)
      throw new Error("service_account_key must have 'private_key' and 'client_email'");
    if (key.private_key.includes("\0"))
      throw new Error("service_account_key.private_key must not contain NUL bytes");
    if (key.client_email.includes("\0"))
      throw new Error("service_account_key.client_email must not contain NUL bytes");

    const scopes     = (args.scopes || [TOKEN_SCOPE]).join(" ");
    const projectId  = args.project_id || key.project_id || null;

    return {
      mode:               "service_account",
      clientEmail:        key.client_email,
      privateKey:         key.private_key,
      scopes,
      projectId,
      timeoutMs,
      rejectUnauthorized,
    };
  }

  // Option B: pre-obtained access token
  if (args.access_token) {
    guardString(args.access_token, "access_token");
    const projectId = args.project_id || null;
    return {
      mode:         "access_token",
      accessToken:  args.access_token,
      projectId,
      timeoutMs,
      rejectUnauthorized,
    };
  }

  throw new Error(
    "gcp_client: provide either 'service_account_key' (JSON object/string) " +
    "or 'access_token' (pre-obtained Bearer token). " +
    "The 'info' operation does not require credentials."
  );
}

function requireProject(conn, opName) {
  if (!conn.projectId)
    throw new Error(`gcp_client ${opName}: 'project_id' is required for this operation`);
}

// ── Cloud Storage Operations ───────────────────────────────────────────────

const GCS_BASE = "https://storage.googleapis.com";

async function opGcsListBuckets(args, conn) {
  requireProject(conn, "gcs_list_buckets");
  const url    = `${GCS_BASE}/storage/v1/b?project=${encodeURIComponent(conn.projectId)}` +
    (args.max_results ? `&maxResults=${args.max_results}` : "") +
    (args.page_token  ? `&pageToken=${encodeURIComponent(args.page_token)}` : "");
  const res    = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "gcs.list_buckets");
  const data   = parseGcpJson(res.raw, "gcs.list_buckets");
  const items  = (data.items || []).map(b => ({
    name:      b.name,
    location:  b.location,
    storage_class: b.storageClass,
    created:   b.timeCreated,
    updated:   b.updated,
  }));
  return {
    ok: true, operation: "gcs_list_buckets",
    project:    conn.projectId,
    count:      items.length,
    buckets:    items,
    next_page_token: data.nextPageToken || null,
  };
}

async function opGcsListObjects(args, conn) {
  requireString(args.bucket, "bucket");
  const qp = [`bucket=${encodeURIComponent(args.bucket)}`];
  if (args.prefix)      qp.push(`prefix=${encodeURIComponent(args.prefix)}`);
  if (args.delimiter)   qp.push(`delimiter=${encodeURIComponent(args.delimiter)}`);
  if (args.max_results) qp.push(`maxResults=${args.max_results}`);
  if (args.page_token)  qp.push(`pageToken=${encodeURIComponent(args.page_token)}`);
  if (args.versions)    qp.push("versions=true");

  const url = `${GCS_BASE}/storage/v1/b/${encodeURIComponent(args.bucket)}/o?${qp.join("&")}`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "gcs.list_objects");
  const data  = parseGcpJson(res.raw, "gcs.list_objects");
  const items = (data.items || []).map(o => ({
    name:          o.name,
    size:          o.size ? parseInt(o.size) : null,
    content_type:  o.contentType,
    updated:       o.updated,
    storage_class: o.storageClass,
    etag:          o.etag,
  }));
  return {
    ok: true, operation: "gcs_list_objects",
    bucket:          args.bucket,
    prefix:          args.prefix || "",
    count:           items.length,
    objects:         items,
    prefixes:        data.prefixes || [],
    next_page_token: data.nextPageToken || null,
  };
}

async function opGcsGetObject(args, conn) {
  requireString(args.bucket, "bucket");
  requireString(args.object, "object");
  const url = `${GCS_BASE}/storage/v1/b/${encodeURIComponent(args.bucket)}/o/` +
    `${encodeURIComponent(args.object)}?alt=media`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "gcs.get_object");
  const ct = res.headers["content-type"] || "";
  const isText = ct.startsWith("text/") || ct.includes("json") ||
    ct.includes("xml") || ct.includes("javascript");
  return {
    ok: true, operation: "gcs_get_object",
    bucket:         args.bucket,
    object:         args.object,
    content_type:   ct,
    size_bytes:     res.raw.length,
    body:           isText ? res.raw : Buffer.from(res.raw, "binary").toString("base64"),
    body_encoding:  isText ? "utf8" : "base64",
  };
}

async function opGcsPutObject(args, conn) {
  requireString(args.bucket, "bucket");
  requireString(args.object, "object");
  const bodyBuf = args.body_base64
    ? Buffer.from(args.body_base64, "base64")
    : Buffer.from(args.body || "", "utf8");
  const contentType = args.content_type || "application/octet-stream";
  const url = `${GCS_BASE}/upload/storage/v1/b/${encodeURIComponent(args.bucket)}/o` +
    `?uploadType=media&name=${encodeURIComponent(args.object)}`;
  const res = await gcpApiRequest(conn, {
    url, method: "POST",
    body:         bodyBuf.toString("utf8"),
    extraHeaders: { "Content-Type": contentType, "Content-Length": bodyBuf.length },
  });
  checkGcpStatus(res, "gcs.put_object");
  const data = parseGcpJson(res.raw, "gcs.put_object");
  return {
    ok: true, operation: "gcs_put_object",
    bucket:      args.bucket,
    object:      args.object,
    etag:        data.etag || null,
    size_bytes:  bodyBuf.length,
    self_link:   data.selfLink || null,
    media_link:  data.mediaLink || null,
  };
}

async function opGcsDeleteObject(args, conn) {
  requireString(args.bucket, "bucket");
  requireString(args.object, "object");
  const url = `${GCS_BASE}/storage/v1/b/${encodeURIComponent(args.bucket)}/o/` +
    `${encodeURIComponent(args.object)}`;
  const res = await gcpApiRequest(conn, { url, method: "DELETE" });
  if (res.statusCode === 404) {
    return { ok: true, operation: "gcs_delete_object", bucket: args.bucket, object: args.object, deleted: false, reason: "not_found" };
  }
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    checkGcpStatus(res, "gcs.delete_object");
  }
  return { ok: true, operation: "gcs_delete_object", bucket: args.bucket, object: args.object, deleted: true };
}

async function opGcsHeadObject(args, conn) {
  requireString(args.bucket, "bucket");
  requireString(args.object, "object");
  const url = `${GCS_BASE}/storage/v1/b/${encodeURIComponent(args.bucket)}/o/` +
    `${encodeURIComponent(args.object)}`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  if (res.statusCode === 404) {
    return { ok: true, operation: "gcs_head_object", bucket: args.bucket, object: args.object, exists: false };
  }
  checkGcpStatus(res, "gcs.head_object");
  const data = parseGcpJson(res.raw, "gcs.head_object");
  return {
    ok: true, operation: "gcs_head_object",
    bucket:        args.bucket,
    object:        args.object,
    exists:        true,
    content_type:  data.contentType,
    size:          data.size ? parseInt(data.size) : null,
    etag:          data.etag,
    updated:       data.updated,
    storage_class: data.storageClass,
    self_link:     data.selfLink,
    media_link:    data.mediaLink,
  };
}

async function opGcsGetBucketMetadata(args, conn) {
  requireString(args.bucket, "bucket");
  const url = `${GCS_BASE}/storage/v1/b/${encodeURIComponent(args.bucket)}`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "gcs.get_bucket_metadata");
  const data = parseGcpJson(res.raw, "gcs.get_bucket_metadata");
  return {
    ok: true, operation: "gcs_get_bucket_metadata",
    name:          data.name,
    location:      data.location,
    location_type: data.locationType,
    storage_class: data.storageClass,
    created:       data.timeCreated,
    updated:       data.updated,
    project_number: data.projectNumber,
    self_link:     data.selfLink,
    versioning_enabled: data.versioning?.enabled || false,
    labels:        data.labels || {},
  };
}

// ── BigQuery Operations ────────────────────────────────────────────────────

const BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";

async function opBqListDatasets(args, conn) {
  requireProject(conn, "bigquery_list_datasets");
  const url = `${BQ_BASE}/projects/${encodeURIComponent(conn.projectId)}/datasets` +
    (args.all ? "?all=true" : "");
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "bigquery.list_datasets");
  const data = parseGcpJson(res.raw, "bigquery.list_datasets");
  const items = (data.datasets || []).map(d => ({
    id:       d.datasetReference?.datasetId,
    location: d.location,
  }));
  return {
    ok: true, operation: "bigquery_list_datasets",
    project: conn.projectId,
    count:   items.length,
    datasets: items,
  };
}

async function opBqListTables(args, conn) {
  requireProject(conn, "bigquery_list_tables");
  requireString(args.dataset, "dataset");
  const url = `${BQ_BASE}/projects/${encodeURIComponent(conn.projectId)}/datasets/` +
    `${encodeURIComponent(args.dataset)}/tables` +
    (args.max_results ? `?maxResults=${args.max_results}` : "");
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "bigquery.list_tables");
  const data  = parseGcpJson(res.raw, "bigquery.list_tables");
  const items = (data.tables || []).map(t => ({
    id:         t.tableReference?.tableId,
    type:       t.type,
    created:    t.creationTime ? new Date(parseInt(t.creationTime)).toISOString() : null,
  }));
  return {
    ok: true, operation: "bigquery_list_tables",
    project:  conn.projectId,
    dataset:  args.dataset,
    count:    items.length,
    tables:   items,
    next_page_token: data.nextPageToken || null,
  };
}

async function opBqQuery(args, conn) {
  requireProject(conn, "bigquery_query");
  requireString(args.query, "query");
  const url  = `${BQ_BASE}/projects/${encodeURIComponent(conn.projectId)}/queries`;
  const body = {
    query:         args.query,
    useLegacySql:  args.use_legacy_sql || false,
    maxResults:    args.max_results || 1000,
    timeoutMs:     args.query_timeout_ms || 30000,
    ...(args.default_dataset ? { defaultDataset: {
      projectId:  conn.projectId,
      datasetId:  args.default_dataset,
    }} : {}),
    ...(args.location ? { location: args.location } : {}),
  };
  const res = await gcpApiRequest(conn, { url, method: "POST", body });
  checkGcpStatus(res, "bigquery.query");
  const data = parseGcpJson(res.raw, "bigquery.query");

  // Parse schema + rows
  const schema = (data.schema?.fields || []).map(f => ({ name: f.name, type: f.type, mode: f.mode }));
  const fieldNames = schema.map(f => f.name);
  const rows = (data.rows || []).map(r => {
    const row = {};
    (r.f || []).forEach((cell, i) => { row[fieldNames[i]] = cell.v; });
    return row;
  });

  return {
    ok: true, operation: "bigquery_query",
    project:        conn.projectId,
    job_complete:   data.jobComplete || false,
    job_id:         data.jobReference?.jobId || null,
    total_rows:     data.totalRows ? parseInt(data.totalRows) : rows.length,
    row_count:      rows.length,
    schema,
    rows,
    next_page_token: data.pageToken || null,
  };
}

async function opBqGetTableSchema(args, conn) {
  requireProject(conn, "bigquery_get_table_schema");
  requireString(args.dataset, "dataset");
  requireString(args.table,   "table");
  const url = `${BQ_BASE}/projects/${encodeURIComponent(conn.projectId)}/datasets/` +
    `${encodeURIComponent(args.dataset)}/tables/${encodeURIComponent(args.table)}`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "bigquery.get_table_schema");
  const data   = parseGcpJson(res.raw, "bigquery.get_table_schema");
  const schema = (data.schema?.fields || []).map(f => ({
    name: f.name, type: f.type, mode: f.mode, description: f.description || "",
  }));
  return {
    ok: true, operation: "bigquery_get_table_schema",
    project:  conn.projectId,
    dataset:  args.dataset,
    table:    args.table,
    type:     data.type,
    num_rows: data.numRows ? parseInt(data.numRows) : null,
    num_bytes: data.numBytes ? parseInt(data.numBytes) : null,
    created:  data.creationTime ? new Date(parseInt(data.creationTime)).toISOString() : null,
    schema,
  };
}

async function opBqInsertRows(args, conn) {
  requireProject(conn, "bigquery_insert_rows");
  requireString(args.dataset, "dataset");
  requireString(args.table,   "table");
  if (!Array.isArray(args.rows) || args.rows.length === 0)
    throw new Error("bigquery_insert_rows: 'rows' must be a non-empty array");
  const url  = `${BQ_BASE}/projects/${encodeURIComponent(conn.projectId)}/datasets/` +
    `${encodeURIComponent(args.dataset)}/tables/${encodeURIComponent(args.table)}/insertAll`;
  const body = {
    rows: args.rows.map((r, i) => ({ insertId: args.insert_ids?.[i] || undefined, json: r })),
    skipInvalidRows:       args.skip_invalid_rows || false,
    ignoreUnknownValues:   args.ignore_unknown_values || false,
  };
  const res  = await gcpApiRequest(conn, { url, method: "POST", body });
  checkGcpStatus(res, "bigquery.insert_rows");
  const data = parseGcpJson(res.raw, "bigquery.insert_rows");
  const errors = data.insertErrors || [];
  return {
    ok: true, operation: "bigquery_insert_rows",
    project:      conn.projectId,
    dataset:      args.dataset,
    table:        args.table,
    rows_inserted: args.rows.length - errors.length,
    errors_count:  errors.length,
    errors:        errors.map(e => ({ index: e.index, errors: e.errors })),
  };
}

// ── Pub/Sub Operations ─────────────────────────────────────────────────────

const PUBSUB_BASE = "https://pubsub.googleapis.com/v1";

async function opPubsubListTopics(args, conn) {
  requireProject(conn, "pubsub_list_topics");
  const url = `${PUBSUB_BASE}/projects/${encodeURIComponent(conn.projectId)}/topics` +
    (args.page_size  ? `?pageSize=${args.page_size}`   : "") +
    (args.page_token ? `&pageToken=${encodeURIComponent(args.page_token)}` : "");
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "pubsub.list_topics");
  const data = parseGcpJson(res.raw, "pubsub.list_topics");
  const topics = (data.topics || []).map(t => ({
    name:        t.name,
    short_name:  t.name.split("/").pop(),
  }));
  return {
    ok: true, operation: "pubsub_list_topics",
    project:  conn.projectId,
    count:    topics.length,
    topics,
    next_page_token: data.nextPageToken || null,
  };
}

async function opPubsubCreateTopic(args, conn) {
  requireProject(conn, "pubsub_create_topic");
  requireString(args.topic, "topic");
  const topicFqn = `projects/${conn.projectId}/topics/${args.topic}`;
  const url = `${PUBSUB_BASE}/${topicFqn}`;
  const res = await gcpApiRequest(conn, { url, method: "PUT", body: {} });
  checkGcpStatus(res, "pubsub.create_topic");
  const data = parseGcpJson(res.raw, "pubsub.create_topic");
  return {
    ok: true, operation: "pubsub_create_topic",
    project: conn.projectId, topic: args.topic, name: data.name,
  };
}

async function opPubsubDeleteTopic(args, conn) {
  requireProject(conn, "pubsub_delete_topic");
  requireString(args.topic, "topic");
  const topicFqn = args.topic.startsWith("projects/") ? args.topic
    : `projects/${conn.projectId}/topics/${args.topic}`;
  const res = await gcpApiRequest(conn, { url: `${PUBSUB_BASE}/${topicFqn}`, method: "DELETE" });
  if (res.statusCode === 404) {
    return { ok: true, operation: "pubsub_delete_topic", topic: args.topic, deleted: false, reason: "not_found" };
  }
  checkGcpStatus(res, "pubsub.delete_topic");
  return { ok: true, operation: "pubsub_delete_topic", topic: args.topic, deleted: true };
}

async function opPubsubPublish(args, conn) {
  requireProject(conn, "pubsub_publish");
  requireString(args.topic, "topic");
  if (!Array.isArray(args.messages) || args.messages.length === 0)
    throw new Error("pubsub_publish: 'messages' must be a non-empty array");
  const topicFqn = args.topic.startsWith("projects/") ? args.topic
    : `projects/${conn.projectId}/topics/${args.topic}`;
  const msgs = args.messages.map(m => {
    const msg = {};
    if (m.data !== undefined) {
      msg.data = Buffer.isBuffer(m.data)
        ? m.data.toString("base64")
        : Buffer.from(typeof m.data === "string" ? m.data : JSON.stringify(m.data), "utf8").toString("base64");
    }
    if (m.attributes && typeof m.attributes === "object") msg.attributes = m.attributes;
    if (m.ordering_key) msg.orderingKey = m.ordering_key;
    return msg;
  });
  const res = await gcpApiRequest(conn, {
    url:    `${PUBSUB_BASE}/${topicFqn}:publish`,
    method: "POST",
    body:   { messages: msgs },
  });
  checkGcpStatus(res, "pubsub.publish");
  const data = parseGcpJson(res.raw, "pubsub.publish");
  return {
    ok: true, operation: "pubsub_publish",
    topic:      args.topic,
    message_ids: data.messageIds || [],
    count:       (data.messageIds || []).length,
  };
}

async function opPubsubListSubscriptions(args, conn) {
  requireProject(conn, "pubsub_list_subscriptions");
  const url = `${PUBSUB_BASE}/projects/${encodeURIComponent(conn.projectId)}/subscriptions` +
    (args.page_size  ? `?pageSize=${args.page_size}` : "");
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "pubsub.list_subscriptions");
  const data = parseGcpJson(res.raw, "pubsub.list_subscriptions");
  const subs = (data.subscriptions || []).map(s => ({
    name:       s.name,
    short_name: s.name.split("/").pop(),
    topic:      s.topic,
    ack_deadline_seconds: s.ackDeadlineSeconds,
  }));
  return {
    ok: true, operation: "pubsub_list_subscriptions",
    project: conn.projectId,
    count:   subs.length,
    subscriptions: subs,
    next_page_token: data.nextPageToken || null,
  };
}

async function opPubsubCreateSubscription(args, conn) {
  requireProject(conn, "pubsub_create_subscription");
  requireString(args.subscription, "subscription");
  requireString(args.topic,        "topic");
  const topicFqn = args.topic.startsWith("projects/") ? args.topic
    : `projects/${conn.projectId}/topics/${args.topic}`;
  const subFqn   = `projects/${conn.projectId}/subscriptions/${args.subscription}`;
  const body = {
    topic:               topicFqn,
    ackDeadlineSeconds:  args.ack_deadline_seconds || 10,
    ...(args.retain_acked_messages !== undefined ? { retainAckedMessages: args.retain_acked_messages } : {}),
    ...(args.message_retention_duration ? { messageRetentionDuration: args.message_retention_duration } : {}),
    ...(args.push_endpoint ? { pushConfig: { pushEndpoint: args.push_endpoint } } : {}),
  };
  const res = await gcpApiRequest(conn, { url: `${PUBSUB_BASE}/${subFqn}`, method: "PUT", body });
  checkGcpStatus(res, "pubsub.create_subscription");
  const data = parseGcpJson(res.raw, "pubsub.create_subscription");
  return {
    ok: true, operation: "pubsub_create_subscription",
    project:      conn.projectId,
    subscription: args.subscription,
    topic:        args.topic,
    name:         data.name,
    ack_deadline_seconds: data.ackDeadlineSeconds,
  };
}

async function opPubsubPull(args, conn) {
  requireProject(conn, "pubsub_pull");
  requireString(args.subscription, "subscription");
  const subFqn = args.subscription.startsWith("projects/") ? args.subscription
    : `projects/${conn.projectId}/subscriptions/${args.subscription}`;
  const res = await gcpApiRequest(conn, {
    url:    `${PUBSUB_BASE}/${subFqn}:pull`,
    method: "POST",
    body:   { maxMessages: args.max_messages || 10, returnImmediately: args.return_immediately !== false },
  });
  checkGcpStatus(res, "pubsub.pull");
  const data = parseGcpJson(res.raw, "pubsub.pull");
  const messages = (data.receivedMessages || []).map(m => ({
    ack_id:      m.ackId,
    message_id:  m.message?.messageId,
    publish_time: m.message?.publishTime,
    data:        m.message?.data ? Buffer.from(m.message.data, "base64").toString("utf8") : null,
    attributes:  m.message?.attributes || {},
  }));
  return {
    ok: true, operation: "pubsub_pull",
    subscription: args.subscription,
    count:        messages.length,
    messages,
  };
}

async function opPubsubAcknowledge(args, conn) {
  requireProject(conn, "pubsub_acknowledge");
  requireString(args.subscription, "subscription");
  if (!Array.isArray(args.ack_ids) || args.ack_ids.length === 0)
    throw new Error("pubsub_acknowledge: 'ack_ids' must be a non-empty array");
  const subFqn = args.subscription.startsWith("projects/") ? args.subscription
    : `projects/${conn.projectId}/subscriptions/${args.subscription}`;
  const res = await gcpApiRequest(conn, {
    url:    `${PUBSUB_BASE}/${subFqn}:acknowledge`,
    method: "POST",
    body:   { ackIds: args.ack_ids },
  });
  checkGcpStatus(res, "pubsub.acknowledge");
  return {
    ok: true, operation: "pubsub_acknowledge",
    subscription: args.subscription,
    acked:        args.ack_ids.length,
  };
}

// ── Compute Engine Operations ──────────────────────────────────────────────

const CE_BASE = "https://compute.googleapis.com/compute/v1";

async function opComputeListInstances(args, conn) {
  requireProject(conn, "compute_list_instances");
  // Aggregate or zone-specific
  let url;
  if (args.zone) {
    url = `${CE_BASE}/projects/${encodeURIComponent(conn.projectId)}/zones/` +
      `${encodeURIComponent(args.zone)}/instances`;
  } else {
    url = `${CE_BASE}/projects/${encodeURIComponent(conn.projectId)}/aggregated/instances`;
  }
  if (args.filter)      url += (url.includes("?") ? "&" : "?") + `filter=${encodeURIComponent(args.filter)}`;
  if (args.max_results) url += (url.includes("?") ? "&" : "?") + `maxResults=${args.max_results}`;

  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "compute.list_instances");
  const data = parseGcpJson(res.raw, "compute.list_instances");

  let instances = [];
  if (args.zone && data.items) {
    instances = (data.items || []).map(i => ({
      name:   i.name,
      id:     i.id,
      zone:   i.zone?.split("/").pop(),
      status: i.status,
      machine_type: i.machineType?.split("/").pop(),
      network_ip:   i.networkInterfaces?.[0]?.networkIP,
      nat_ip:       i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP,
      created:      i.creationTimestamp,
    }));
  } else if (data.items) {
    for (const [zone, zoneData] of Object.entries(data.items || {})) {
      for (const i of (zoneData.instances || [])) {
        instances.push({
          name:   i.name,
          id:     i.id,
          zone:   zone.replace("zones/", ""),
          status: i.status,
          machine_type: i.machineType?.split("/").pop(),
          network_ip:   i.networkInterfaces?.[0]?.networkIP,
          nat_ip:       i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP,
          created:      i.creationTimestamp,
        });
      }
    }
  }
  return {
    ok: true, operation: "compute_list_instances",
    project: conn.projectId,
    zone:    args.zone || "all",
    count:   instances.length,
    instances,
    next_page_token: data.nextPageToken || null,
  };
}

async function opComputeGetInstance(args, conn) {
  requireProject(conn, "compute_get_instance");
  requireString(args.zone,     "zone");
  requireString(args.instance, "instance");
  const url = `${CE_BASE}/projects/${encodeURIComponent(conn.projectId)}/zones/` +
    `${encodeURIComponent(args.zone)}/instances/${encodeURIComponent(args.instance)}`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  if (res.statusCode === 404) {
    return { ok: true, operation: "compute_get_instance", exists: false, instance: args.instance };
  }
  checkGcpStatus(res, "compute.get_instance");
  const i = parseGcpJson(res.raw, "compute.get_instance");
  return {
    ok: true, operation: "compute_get_instance",
    exists:       true,
    name:         i.name,
    id:           i.id,
    status:       i.status,
    zone:         i.zone?.split("/").pop(),
    machine_type: i.machineType?.split("/").pop(),
    network_ip:   i.networkInterfaces?.[0]?.networkIP,
    nat_ip:       i.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP,
    disk_count:   (i.disks || []).length,
    labels:       i.labels || {},
    tags:         i.tags?.items || [],
    created:      i.creationTimestamp,
    self_link:    i.selfLink,
  };
}

async function opComputeListZones(args, conn) {
  requireProject(conn, "compute_list_zones");
  const url = `${CE_BASE}/projects/${encodeURIComponent(conn.projectId)}/zones` +
    (args.filter ? `?filter=${encodeURIComponent(args.filter)}` : "");
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "compute.list_zones");
  const data  = parseGcpJson(res.raw, "compute.list_zones");
  const zones = (data.items || []).map(z => ({ name: z.name, status: z.status, region: z.region?.split("/").pop() }));
  return {
    ok: true, operation: "compute_list_zones",
    project: conn.projectId,
    count:   zones.length,
    zones,
  };
}

// ── Secret Manager Operations ──────────────────────────────────────────────

const SM_BASE = "https://secretmanager.googleapis.com/v1";

async function opSecretMgrListSecrets(args, conn) {
  requireProject(conn, "secretmgr_list_secrets");
  const url = `${SM_BASE}/projects/${encodeURIComponent(conn.projectId)}/secrets` +
    (args.page_size ? `?pageSize=${args.page_size}` : "");
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "secretmgr.list_secrets");
  const data    = parseGcpJson(res.raw, "secretmgr.list_secrets");
  const secrets = (data.secrets || []).map(s => ({
    name:       s.name,
    short_name: s.name.split("/").pop(),
    created:    s.createTime,
    labels:     s.labels || {},
  }));
  return {
    ok: true, operation: "secretmgr_list_secrets",
    project:  conn.projectId,
    count:    secrets.length,
    secrets,
    next_page_token: data.nextPageToken || null,
  };
}

async function opSecretMgrGetSecret(args, conn) {
  requireProject(conn, "secretmgr_get_secret");
  requireString(args.secret, "secret");
  const secretFqn = args.secret.startsWith("projects/") ? args.secret
    : `projects/${conn.projectId}/secrets/${args.secret}`;
  const res = await gcpApiRequest(conn, { url: `${SM_BASE}/${secretFqn}`, method: "GET" });
  if (res.statusCode === 404) {
    return { ok: true, operation: "secretmgr_get_secret", exists: false, secret: args.secret };
  }
  checkGcpStatus(res, "secretmgr.get_secret");
  const data = parseGcpJson(res.raw, "secretmgr.get_secret");
  return {
    ok: true, operation: "secretmgr_get_secret",
    exists:     true,
    name:       data.name,
    short_name: data.name.split("/").pop(),
    created:    data.createTime,
    labels:     data.labels || {},
    replication: data.replication || {},
  };
}

async function opSecretMgrAccessVersion(args, conn) {
  requireProject(conn, "secretmgr_access_secret_version");
  requireString(args.secret, "secret");
  const version    = args.version || "latest";
  const secretFqn  = args.secret.startsWith("projects/") ? args.secret
    : `projects/${conn.projectId}/secrets/${args.secret}`;
  const versionFqn = `${secretFqn}/versions/${version}`;
  const res = await gcpApiRequest(conn, { url: `${SM_BASE}/${versionFqn}:access`, method: "GET" });
  checkGcpStatus(res, "secretmgr.access_secret_version");
  const data = parseGcpJson(res.raw, "secretmgr.access_secret_version");
  const payloadB64 = data.payload?.data || "";
  const secretValue = payloadB64 ? Buffer.from(payloadB64, "base64").toString("utf8") : null;
  return {
    ok: true, operation: "secretmgr_access_secret_version",
    secret:       args.secret,
    version:      version,
    version_name: data.name,
    secret_value: secretValue,
  };
}

async function opSecretMgrAddVersion(args, conn) {
  requireProject(conn, "secretmgr_add_secret_version");
  requireString(args.secret,       "secret");
  requireString(args.secret_value, "secret_value");
  const secretFqn = args.secret.startsWith("projects/") ? args.secret
    : `projects/${conn.projectId}/secrets/${args.secret}`;
  const payload   = Buffer.from(args.secret_value, "utf8").toString("base64");
  const res       = await gcpApiRequest(conn, {
    url:    `${SM_BASE}/${secretFqn}:addVersion`,
    method: "POST",
    body:   { payload: { data: payload } },
  });
  checkGcpStatus(res, "secretmgr.add_secret_version");
  const data = parseGcpJson(res.raw, "secretmgr.add_secret_version");
  return {
    ok: true, operation: "secretmgr_add_secret_version",
    secret:       args.secret,
    version_name: data.name,
    state:        data.state,
    created:      data.createTime,
  };
}

// ── Cloud KMS Operations ───────────────────────────────────────────────────

const KMS_BASE = "https://cloudkms.googleapis.com/v1";

async function opKmsListKeyRings(args, conn) {
  requireProject(conn, "kms_list_key_rings");
  requireString(args.location, "location");
  const url = `${KMS_BASE}/projects/${encodeURIComponent(conn.projectId)}/locations/` +
    `${encodeURIComponent(args.location)}/keyRings`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "kms.list_key_rings");
  const data  = parseGcpJson(res.raw, "kms.list_key_rings");
  const rings = (data.keyRings || []).map(r => ({
    name:       r.name,
    short_name: r.name.split("/").pop(),
    created:    r.createTime,
  }));
  return {
    ok: true, operation: "kms_list_key_rings",
    project: conn.projectId, location: args.location,
    count: rings.length, key_rings: rings,
  };
}

async function opKmsListCryptoKeys(args, conn) {
  requireProject(conn, "kms_list_crypto_keys");
  requireString(args.location, "location");
  requireString(args.key_ring, "key_ring");
  const url = `${KMS_BASE}/projects/${encodeURIComponent(conn.projectId)}/locations/` +
    `${encodeURIComponent(args.location)}/keyRings/${encodeURIComponent(args.key_ring)}/cryptoKeys`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "kms.list_crypto_keys");
  const data = parseGcpJson(res.raw, "kms.list_crypto_keys");
  const keys = (data.cryptoKeys || []).map(k => ({
    name:       k.name,
    short_name: k.name.split("/").pop(),
    purpose:    k.purpose,
    created:    k.createTime,
  }));
  return {
    ok: true, operation: "kms_list_crypto_keys",
    project: conn.projectId, location: args.location, key_ring: args.key_ring,
    count: keys.length, crypto_keys: keys,
  };
}

async function opKmsEncrypt(args, conn) {
  requireProject(conn, "kms_encrypt");
  requireString(args.location,   "location");
  requireString(args.key_ring,   "key_ring");
  requireString(args.crypto_key, "crypto_key");
  if (!args.plaintext && !args.plaintext_base64)
    throw new Error("kms_encrypt: provide 'plaintext' (string) or 'plaintext_base64' (base64)");
  const plaintextB64 = args.plaintext_base64
    ? args.plaintext_base64
    : Buffer.from(args.plaintext, "utf8").toString("base64");
  const keyName = `projects/${conn.projectId}/locations/${args.location}/keyRings/${args.key_ring}/cryptoKeys/${args.crypto_key}`;
  const res = await gcpApiRequest(conn, {
    url:    `${KMS_BASE}/${keyName}:encrypt`,
    method: "POST",
    body:   { plaintext: plaintextB64, ...(args.additional_auth ? { additionalAuthenticatedData: Buffer.from(args.additional_auth, "utf8").toString("base64") } : {}) },
  });
  checkGcpStatus(res, "kms.encrypt");
  const data = parseGcpJson(res.raw, "kms.encrypt");
  return {
    ok: true, operation: "kms_encrypt",
    key_name:   keyName,
    ciphertext: data.ciphertext,
    ciphertext_crc32c: data.ciphertextCrc32c || null,
  };
}

async function opKmsDecrypt(args, conn) {
  requireProject(conn, "kms_decrypt");
  requireString(args.location,   "location");
  requireString(args.key_ring,   "key_ring");
  requireString(args.crypto_key, "crypto_key");
  requireString(args.ciphertext, "ciphertext");
  const keyName = `projects/${conn.projectId}/locations/${args.location}/keyRings/${args.key_ring}/cryptoKeys/${args.crypto_key}`;
  const res = await gcpApiRequest(conn, {
    url:    `${KMS_BASE}/${keyName}:decrypt`,
    method: "POST",
    body:   { ciphertext: args.ciphertext, ...(args.additional_auth ? { additionalAuthenticatedData: Buffer.from(args.additional_auth, "utf8").toString("base64") } : {}) },
  });
  checkGcpStatus(res, "kms.decrypt");
  const data      = parseGcpJson(res.raw, "kms.decrypt");
  const plaintext = data.plaintext ? Buffer.from(data.plaintext, "base64").toString("utf8") : null;
  return {
    ok: true, operation: "kms_decrypt",
    key_name:  keyName,
    plaintext,
  };
}

// ── Cloud Monitoring Operations ────────────────────────────────────────────

const MON_BASE = "https://monitoring.googleapis.com/v3";

async function opMonListMetricDescriptors(args, conn) {
  requireProject(conn, "monitoring_list_metric_descriptors");
  const qp = [`name=projects%2F${encodeURIComponent(conn.projectId)}`];
  if (args.filter) qp.push(`filter=${encodeURIComponent(args.filter)}`);
  if (args.page_size) qp.push(`pageSize=${args.page_size}`);
  const url = `${MON_BASE}/projects/${encodeURIComponent(conn.projectId)}/metricDescriptors?${qp.join("&")}`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "monitoring.list_metric_descriptors");
  const data = parseGcpJson(res.raw, "monitoring.list_metric_descriptors");
  const metrics = (data.metricDescriptors || []).map(m => ({
    type:        m.type,
    display_name: m.displayName,
    metric_kind: m.metricKind,
    value_type:  m.valueType,
    unit:        m.unit || "",
    description: m.description || "",
  }));
  return {
    ok: true, operation: "monitoring_list_metric_descriptors",
    project: conn.projectId,
    count:   metrics.length,
    metric_descriptors: metrics,
    next_page_token: data.nextPageToken || null,
  };
}

async function opMonListTimeSeries(args, conn) {
  requireProject(conn, "monitoring_list_time_series");
  requireString(args.filter, "filter");
  const intervalStart = args.start_time || new Date(Date.now() - 3600000).toISOString();
  const intervalEnd   = args.end_time   || new Date().toISOString();
  const qp = [
    `filter=${encodeURIComponent(args.filter)}`,
    `interval.startTime=${encodeURIComponent(intervalStart)}`,
    `interval.endTime=${encodeURIComponent(intervalEnd)}`,
    `view=${args.view || "FULL"}`,
  ];
  if (args.aggregation_alignment_period) qp.push(`aggregation.alignmentPeriod=${args.aggregation_alignment_period}`);
  if (args.aggregation_cross_series_reducer) qp.push(`aggregation.crossSeriesReducer=${args.aggregation_cross_series_reducer}`);
  if (args.page_size) qp.push(`pageSize=${args.page_size}`);

  const url = `${MON_BASE}/projects/${encodeURIComponent(conn.projectId)}/timeSeries?${qp.join("&")}`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "monitoring.list_time_series");
  const data   = parseGcpJson(res.raw, "monitoring.list_time_series");
  const series = (data.timeSeries || []).map(ts => ({
    metric_type:  ts.metric?.type,
    metric_labels: ts.metric?.labels || {},
    resource_type: ts.resource?.type,
    resource_labels: ts.resource?.labels || {},
    point_count:  (ts.points || []).length,
    points:       (ts.points || []).slice(0, 100).map(p => ({
      start_time: p.interval?.startTime,
      end_time:   p.interval?.endTime,
      value:      p.value,
    })),
  }));
  return {
    ok: true, operation: "monitoring_list_time_series",
    project: conn.projectId,
    filter:  args.filter,
    count:   series.length,
    time_series: series,
    next_page_token: data.nextPageToken || null,
  };
}

// ── IAM Operations ─────────────────────────────────────────────────────────

const IAM_BASE = "https://iam.googleapis.com/v1";

async function opIamListServiceAccounts(args, conn) {
  requireProject(conn, "iam_list_service_accounts");
  const url = `${IAM_BASE}/projects/${encodeURIComponent(conn.projectId)}/serviceAccounts` +
    (args.page_size ? `?pageSize=${args.page_size}` : "");
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "iam.list_service_accounts");
  const data    = parseGcpJson(res.raw, "iam.list_service_accounts");
  const accounts = (data.accounts || []).map(sa => ({
    name:          sa.name,
    email:         sa.email,
    display_name:  sa.displayName,
    description:   sa.description || "",
    disabled:      sa.disabled || false,
    unique_id:     sa.uniqueId,
  }));
  return {
    ok: true, operation: "iam_list_service_accounts",
    project:  conn.projectId,
    count:    accounts.length,
    service_accounts: accounts,
    next_page_token: data.nextPageToken || null,
  };
}

async function opIamGetServiceAccount(args, conn) {
  requireProject(conn, "iam_get_service_account");
  requireString(args.email, "email");
  const resourceName = args.email.includes("@")
    ? `projects/${conn.projectId}/serviceAccounts/${args.email}`
    : `projects/${conn.projectId}/serviceAccounts/${args.email}`;
  const res = await gcpApiRequest(conn, { url: `${IAM_BASE}/${resourceName}`, method: "GET" });
  if (res.statusCode === 404) {
    return { ok: true, operation: "iam_get_service_account", exists: false, email: args.email };
  }
  checkGcpStatus(res, "iam.get_service_account");
  const sa = parseGcpJson(res.raw, "iam.get_service_account");
  return {
    ok: true, operation: "iam_get_service_account",
    exists:       true,
    name:         sa.name,
    email:        sa.email,
    unique_id:    sa.uniqueId,
    display_name: sa.displayName,
    description:  sa.description || "",
    disabled:     sa.disabled || false,
    project_id:   sa.projectId,
    oauth2_client_id: sa.oauth2ClientId,
  };
}

// ── Cloud Run Operations ───────────────────────────────────────────────────

const RUN_BASE_V2 = "https://run.googleapis.com/v2";

async function opCloudRunListServices(args, conn) {
  requireProject(conn, "cloudrun_list_services");
  requireString(args.region, "region");
  const url = `${RUN_BASE_V2}/projects/${encodeURIComponent(conn.projectId)}/locations/` +
    `${encodeURIComponent(args.region)}/services`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  checkGcpStatus(res, "cloudrun.list_services");
  const data     = parseGcpJson(res.raw, "cloudrun.list_services");
  const services = (data.services || []).map(s => ({
    name:          s.name,
    short_name:    s.name.split("/").pop(),
    uid:           s.uid,
    generation:    s.generation,
    condition:     s.terminalCondition?.type,
    uri:           s.uri,
    created:       s.createTime,
    updated:       s.updateTime,
  }));
  return {
    ok: true, operation: "cloudrun_list_services",
    project: conn.projectId, region: args.region,
    count: services.length, services,
    next_page_token: data.nextPageToken || null,
  };
}

async function opCloudRunGetService(args, conn) {
  requireProject(conn, "cloudrun_get_service");
  requireString(args.region,  "region");
  requireString(args.service, "service");
  const url = `${RUN_BASE_V2}/projects/${encodeURIComponent(conn.projectId)}/locations/` +
    `${encodeURIComponent(args.region)}/services/${encodeURIComponent(args.service)}`;
  const res = await gcpApiRequest(conn, { url, method: "GET" });
  if (res.statusCode === 404) {
    return { ok: true, operation: "cloudrun_get_service", exists: false, service: args.service };
  }
  checkGcpStatus(res, "cloudrun.get_service");
  const s = parseGcpJson(res.raw, "cloudrun.get_service");
  return {
    ok: true, operation: "cloudrun_get_service",
    exists:      true,
    name:        s.name,
    uid:         s.uid,
    uri:         s.uri,
    generation:  s.generation,
    creator:     s.creator,
    created:     s.createTime,
    updated:     s.updateTime,
    condition:   s.terminalCondition?.type,
    condition_message: s.terminalCondition?.message,
    containers:  (s.template?.containers || []).map(c => ({
      image: c.image,
      resources: c.resources?.limits,
    })),
  };
}

// ── Generic request operation ──────────────────────────────────────────────

async function opRequest(args, conn) {
  requireString(args.url,    "url");
  requireString(args.method, "method");

  const validMethods = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"];
  if (!validMethods.includes(args.method.toUpperCase()))
    throw new Error(`method must be one of: ${validMethods.join(", ")}`);

  const body = args.body
    ? (typeof args.body === "string" ? args.body : JSON.stringify(args.body))
    : undefined;

  const res = await gcpApiRequest(conn, {
    url:          args.url,
    method:       args.method.toUpperCase(),
    body,
    extraHeaders: args.extra_headers || {},
  });

  let parsedBody = null;
  const ct = res.headers["content-type"] || "";
  if (ct.includes("json")) {
    try { parsedBody = JSON.parse(res.raw); } catch (_) { parsedBody = res.raw; }
  } else {
    parsedBody = res.raw;
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    checkGcpStatus(res, `request ${args.method.toUpperCase()} ${args.url}`);
  }

  return {
    ok:          true,
    operation:   "request",
    url:         args.url,
    method:      args.method.toUpperCase(),
    status_code: res.statusCode,
    headers:     res.headers,
    body:        parsedBody,
  };
}

// ── Info ───────────────────────────────────────────────────────────────────

function opInfo() {
  return {
    ok:       true,
    protocol: "GCP REST API (HTTPS/JSON) with OAuth2 Bearer token",
    auth: {
      service_account: "RS256-signed JWT → OAuth2 access token (service_account_key + project_id)",
      access_token:    "Pre-obtained Bearer token (access_token)",
      scope:           TOKEN_SCOPE,
    },
    operations: [
      // GCS
      { op: "gcs_list_buckets",      service: "gcs",       description: "List all GCS buckets in the project" },
      { op: "gcs_list_objects",      service: "gcs",       description: "List objects in a GCS bucket" },
      { op: "gcs_get_object",        service: "gcs",       description: "Download an object from GCS" },
      { op: "gcs_put_object",        service: "gcs",       description: "Upload an object to GCS (simple media upload)" },
      { op: "gcs_delete_object",     service: "gcs",       description: "Delete an object from GCS" },
      { op: "gcs_head_object",       service: "gcs",       description: "Get metadata for a GCS object" },
      { op: "gcs_get_bucket_metadata", service: "gcs",     description: "Get metadata for a GCS bucket" },
      // BigQuery
      { op: "bigquery_list_datasets",   service: "bigquery", description: "List datasets in the project" },
      { op: "bigquery_list_tables",     service: "bigquery", description: "List tables in a dataset" },
      { op: "bigquery_query",           service: "bigquery", description: "Run a synchronous BigQuery query" },
      { op: "bigquery_get_table_schema", service: "bigquery", description: "Get schema for a BigQuery table" },
      { op: "bigquery_insert_rows",     service: "bigquery", description: "Insert rows via the streaming insertAll API" },
      // Pub/Sub
      { op: "pubsub_list_topics",           service: "pubsub", description: "List Pub/Sub topics in the project" },
      { op: "pubsub_create_topic",          service: "pubsub", description: "Create a new Pub/Sub topic" },
      { op: "pubsub_delete_topic",          service: "pubsub", description: "Delete a Pub/Sub topic" },
      { op: "pubsub_publish",               service: "pubsub", description: "Publish messages to a Pub/Sub topic" },
      { op: "pubsub_list_subscriptions",    service: "pubsub", description: "List Pub/Sub subscriptions" },
      { op: "pubsub_create_subscription",   service: "pubsub", description: "Create a Pub/Sub subscription" },
      { op: "pubsub_pull",                  service: "pubsub", description: "Pull messages from a Pub/Sub subscription" },
      { op: "pubsub_acknowledge",           service: "pubsub", description: "Acknowledge Pub/Sub messages by ack_ids" },
      // Compute
      { op: "compute_list_instances", service: "compute", description: "List Compute Engine instances (all zones or specific zone)" },
      { op: "compute_get_instance",   service: "compute", description: "Get details for a specific Compute Engine instance" },
      { op: "compute_list_zones",     service: "compute", description: "List available zones in the project" },
      // Cloud Run
      { op: "cloudrun_list_services", service: "cloudrun", description: "List Cloud Run services in a region" },
      { op: "cloudrun_get_service",   service: "cloudrun", description: "Get details for a Cloud Run service" },
      // IAM
      { op: "iam_list_service_accounts", service: "iam", description: "List IAM service accounts in the project" },
      { op: "iam_get_service_account",   service: "iam", description: "Get details for an IAM service account" },
      // Secret Manager
      { op: "secretmgr_list_secrets",          service: "secretmgr", description: "List secrets in Secret Manager" },
      { op: "secretmgr_get_secret",            service: "secretmgr", description: "Get secret metadata from Secret Manager" },
      { op: "secretmgr_access_secret_version", service: "secretmgr", description: "Access (read) a secret version value" },
      { op: "secretmgr_add_secret_version",    service: "secretmgr", description: "Add a new version to an existing secret" },
      // Cloud KMS
      { op: "kms_list_key_rings",   service: "cloudkms", description: "List Cloud KMS key rings in a location" },
      { op: "kms_list_crypto_keys", service: "cloudkms", description: "List Cloud KMS crypto keys in a key ring" },
      { op: "kms_encrypt",          service: "cloudkms", description: "Encrypt plaintext using a Cloud KMS crypto key" },
      { op: "kms_decrypt",          service: "cloudkms", description: "Decrypt ciphertext using a Cloud KMS crypto key" },
      // Monitoring
      { op: "monitoring_list_metric_descriptors", service: "monitoring", description: "List Cloud Monitoring metric descriptors" },
      { op: "monitoring_list_time_series",        service: "monitoring", description: "Query Cloud Monitoring time series data" },
      // Generic
      { op: "request", service: "*",    description: "Generic authenticated HTTP request to any GCP REST API URL" },
      { op: "info",    service: "none", description: "Return this reference (no I/O)" },
    ],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

async function gcpClient(args) {
  if (args.timeout !== undefined && args.timeout !== null)
    clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");

  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");
  if (op === "info") return opInfo();

  const conn = buildConn(args);

  switch (op) {
    // GCS
    case "gcs_list_buckets":        return opGcsListBuckets(args, conn);
    case "gcs_list_objects":        return opGcsListObjects(args, conn);
    case "gcs_get_object":          return opGcsGetObject(args, conn);
    case "gcs_put_object":          return opGcsPutObject(args, conn);
    case "gcs_delete_object":       return opGcsDeleteObject(args, conn);
    case "gcs_head_object":         return opGcsHeadObject(args, conn);
    case "gcs_get_bucket_metadata": return opGcsGetBucketMetadata(args, conn);
    // BigQuery
    case "bigquery_list_datasets":   return opBqListDatasets(args, conn);
    case "bigquery_list_tables":     return opBqListTables(args, conn);
    case "bigquery_query":           return opBqQuery(args, conn);
    case "bigquery_get_table_schema": return opBqGetTableSchema(args, conn);
    case "bigquery_insert_rows":     return opBqInsertRows(args, conn);
    // Pub/Sub
    case "pubsub_list_topics":         return opPubsubListTopics(args, conn);
    case "pubsub_create_topic":        return opPubsubCreateTopic(args, conn);
    case "pubsub_delete_topic":        return opPubsubDeleteTopic(args, conn);
    case "pubsub_publish":             return opPubsubPublish(args, conn);
    case "pubsub_list_subscriptions":  return opPubsubListSubscriptions(args, conn);
    case "pubsub_create_subscription": return opPubsubCreateSubscription(args, conn);
    case "pubsub_pull":                return opPubsubPull(args, conn);
    case "pubsub_acknowledge":         return opPubsubAcknowledge(args, conn);
    // Compute
    case "compute_list_instances": return opComputeListInstances(args, conn);
    case "compute_get_instance":   return opComputeGetInstance(args, conn);
    case "compute_list_zones":     return opComputeListZones(args, conn);
    // Cloud Run
    case "cloudrun_list_services": return opCloudRunListServices(args, conn);
    case "cloudrun_get_service":   return opCloudRunGetService(args, conn);
    // IAM
    case "iam_list_service_accounts": return opIamListServiceAccounts(args, conn);
    case "iam_get_service_account":   return opIamGetServiceAccount(args, conn);
    // Secret Manager
    case "secretmgr_list_secrets":          return opSecretMgrListSecrets(args, conn);
    case "secretmgr_get_secret":            return opSecretMgrGetSecret(args, conn);
    case "secretmgr_access_secret_version": return opSecretMgrAccessVersion(args, conn);
    case "secretmgr_add_secret_version":    return opSecretMgrAddVersion(args, conn);
    // Cloud KMS
    case "kms_list_key_rings":   return opKmsListKeyRings(args, conn);
    case "kms_list_crypto_keys": return opKmsListCryptoKeys(args, conn);
    case "kms_encrypt":          return opKmsEncrypt(args, conn);
    case "kms_decrypt":          return opKmsDecrypt(args, conn);
    // Monitoring
    case "monitoring_list_metric_descriptors": return opMonListMetricDescriptors(args, conn);
    case "monitoring_list_time_series":        return opMonListTimeSeries(args, conn);
    // Generic
    case "request": return opRequest(args, conn);

    default:
      throw new Error(
        `Unknown gcp_client operation: '${args.operation}'. ` +
        "Valid operations: gcs_list_buckets, gcs_list_objects, gcs_get_object, gcs_put_object, " +
        "gcs_delete_object, gcs_head_object, gcs_get_bucket_metadata, " +
        "bigquery_list_datasets, bigquery_list_tables, bigquery_query, bigquery_get_table_schema, bigquery_insert_rows, " +
        "pubsub_list_topics, pubsub_create_topic, pubsub_delete_topic, pubsub_publish, " +
        "pubsub_list_subscriptions, pubsub_create_subscription, pubsub_pull, pubsub_acknowledge, " +
        "compute_list_instances, compute_get_instance, compute_list_zones, " +
        "cloudrun_list_services, cloudrun_get_service, " +
        "iam_list_service_accounts, iam_get_service_account, " +
        "secretmgr_list_secrets, secretmgr_get_secret, secretmgr_access_secret_version, secretmgr_add_secret_version, " +
        "kms_list_key_rings, kms_list_crypto_keys, kms_encrypt, kms_decrypt, " +
        "monitoring_list_metric_descriptors, monitoring_list_time_series, request, info"
      );
  }
}

module.exports = {
  gcpClient,
  // Exported for testing
  buildServiceAccountJwt, b64urlEncode, buildConn, requireString, guardString, clampInt,
  gcpHttpRequest, parseGcpJson, checkGcpStatus, TOKEN_CACHE,
};
