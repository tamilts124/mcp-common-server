"use strict";
/**
 * salesforceClientOps.js
 * Zero-dependency Salesforce REST API client (pure Node.js https; no npm deps).
 * Auth: username+password+security_token (Resource Owner Password flow) OR
 *       access_token + instance_url (pre-obtained bearer token).
 * API Version: v59.0 (configurable via api_version arg).
 * Base URL: derived from instance_url after login.
 * Credentials are scrubbed from all error messages.
 * Response capped at 16 MB; timeout clamped 1–120 s (default 20 s).
 */

const https = require("https");
const http  = require("http");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const DEFAULT_API_VER   = "v59.0";
const LOGIN_HOST        = "login.salesforce.com";
const SANDBOX_LOGIN     = "test.salesforce.com";
const NUL_RE            = /\x00/;

// ── Helpers ───────────────────────────────────────────────────────────────────
function scrubCreds(str, ...secrets) {
  let s = String(str);
  for (const sec of secrets) {
    if (sec) s = s.split(sec).join("[REDACTED]");
  }
  return s;
}

function validateNul(val, name) {
  if (typeof val === "string" && NUL_RE.test(val))
    throw new Error(`${name} must not contain NUL bytes`);
}

function clampTimeout(t) {
  if (t == null) return DEFAULT_TIMEOUT;
  const n = Number(t);
  if (!isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.round(n)));
}

function requireString(val, name) {
  if (typeof val !== "string" || !val.trim())
    throw new Error(`${name} is required and must be a non-empty string`);
  validateNul(val, name);
  return val.trim();
}

function optStr(val, name) {
  if (val == null) return undefined;
  if (typeof val !== "string") throw new Error(`${name} must be a string`);
  validateNul(val, name);
  return val;
}

function optInt(val, name, min, max) {
  if (val == null) return undefined;
  const n = Number(val);
  if (!isFinite(n) || !Number.isInteger(n))
    throw new Error(`${name} must be an integer`);
  if (min != null && n < min) throw new Error(`${name} must be >= ${min}`);
  if (max != null && n > max) throw new Error(`${name} must be <= ${max}`);
  return n;
}

/**
 * Low-level HTTPS/HTTP request helper.
 */
function rawRequest({ hostname, port, path, method, headers, body, timeout, rejectUnauthorized, useHttp }) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);
    const lib = useHttp ? http : https;

    const bodyStr = body != null
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;

    const hdrs = { ...headers };
    if (bodyStr) {
      if (!hdrs["Content-Type"]) hdrs["Content-Type"] = "application/json";
      hdrs["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname,
      port: port || (useHttp ? 80 : 443),
      path,
      method: method || "GET",
      headers: hdrs,
      rejectUnauthorized: rejectUnauthorized !== false,
    };

    let timer;
    const req = lib.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BODY) {
          req.destroy();
          clearTimeout(timer);
          reject(new Error("Response body exceeds 16 MB limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode;
        if (!raw.trim()) { resolve({ status, body: null }); return; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { _raw: raw }; }
        resolve({ status, body: parsed });
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(err.message));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`Salesforce request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(err.message));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Authenticate via username+password+security_token (Resource Owner Password).
 * Returns { access_token, instance_url }.
 */
async function loginWithPassword(args) {
  const username      = requireString(args.username, "username");
  const password      = requireString(args.password, "password");
  const client_id     = requireString(args.client_id, "client_id");
  const client_secret = requireString(args.client_secret, "client_secret");
  const security_token = optStr(args.security_token, "security_token") || "";
  const sandbox       = !!args.sandbox;
  const timeout       = args.timeout;

  const loginHost = sandbox ? SANDBOX_LOGIN : LOGIN_HOST;
  const bodyStr = new URLSearchParams({
    grant_type:    "password",
    client_id,
    client_secret,
    username,
    password:      password + security_token,
  }).toString();

  const ms = clampTimeout(timeout);
  const res = await rawRequest({
    hostname: loginHost,
    path:     "/services/oauth2/token",
    method:   "POST",
    headers:  {
      "Content-Type":   "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(bodyStr),
      "User-Agent":     "mcp-common-server/salesforce_client",
      "Accept":         "application/json",
    },
    body:     bodyStr,
    timeout:  ms,
    rejectUnauthorized: args.reject_unauthorized !== false,
  });

  if (res.status !== 200) {
    const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
    const scrubbed = scrubCreds(errBody, client_secret, password);
    throw new Error(`Salesforce login failed (${res.status}): ${scrubbed}`);
  }

  const { access_token, instance_url } = res.body;
  if (!access_token) throw new Error("Salesforce login: no access_token in response");
  if (!instance_url) throw new Error("Salesforce login: no instance_url in response");
  return { access_token, instance_url };
}

/**
 * Parse instance_url into { hostname, basePath }.
 */
function parseInstanceUrl(instance_url) {
  const u = new URL(instance_url);
  return { hostname: u.hostname, basePath: u.pathname.replace(/\/$/, "") };
}

/**
 * Core SF REST request after auth.
 */
async function sfRequest(ctx, method, path, body, params, allowedStatuses) {
  const { hostname, basePath } = parseInstanceUrl(ctx.instance_url);

  let fullPath = basePath + path;
  let bodyArg  = null;

  if ((method === "GET" || method === "DELETE") && params && Object.keys(params).length) {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) fullPath += "?" + qs;
  } else if (body != null) {
    bodyArg = body;
  }

  const res = await rawRequest({
    hostname,
    path:    fullPath,
    method,
    headers: {
      "Authorization": `Bearer ${ctx.access_token}`,
      "Accept":        "application/json",
      "User-Agent":    "mcp-common-server/salesforce_client",
    },
    body:               bodyArg,
    timeout:            ctx.timeout,
    rejectUnauthorized: ctx.rejectUnauthorized,
  });

  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;

  if (!ok) {
    const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
    const scrubbed = scrubCreds(errBody, ctx.access_token);
    throw new Error(`Salesforce API error ${res.status}: ${scrubbed}`);
  }
  return res;
}

/**
 * Build context from args; authenticate if needed.
 */
async function buildCtx(args) {
  const api_version = optStr(args.api_version, "api_version") || DEFAULT_API_VER;

  let access_token, instance_url;

  if (args.access_token && args.instance_url) {
    access_token  = requireString(args.access_token, "access_token");
    instance_url  = requireString(args.instance_url, "instance_url");
  } else {
    // username+password flow
    const creds = await loginWithPassword(args);
    access_token  = creds.access_token;
    instance_url  = creds.instance_url;
  }

  return {
    access_token,
    instance_url,
    api_version,
    timeout:            args.timeout,
    rejectUnauthorized: args.reject_unauthorized !== false,
    apiBase:            `/services/data/${api_version}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOBJECT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function sobjectCreate(ctx, args) {
  const sobject = requireString(args.sobject, "sobject");
  const fields  = args.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("fields (object) is required for sobject_create");
  const res = await sfRequest(ctx, "POST",
    `${ctx.apiBase}/sobjects/${encodeURIComponent(sobject)}`,
    fields, null, [201]);
  return res.body;
}

async function sobjectGet(ctx, args) {
  const sobject = requireString(args.sobject, "sobject");
  const id      = requireString(args.id, "id");
  const params  = {};
  if (args.fields && Array.isArray(args.fields)) params.fields = args.fields.join(",");
  const res = await sfRequest(ctx, "GET",
    `${ctx.apiBase}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`,
    null, Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404) return { exists: false, id, sobject };
  return res.body;
}

async function sobjectUpdate(ctx, args) {
  const sobject = requireString(args.sobject, "sobject");
  const id      = requireString(args.id, "id");
  const fields  = args.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("fields (object) is required for sobject_update");
  const res = await sfRequest(ctx, "PATCH",
    `${ctx.apiBase}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`,
    fields, null, [204]);
  return { updated: true, id };
}

async function sobjectDelete(ctx, args) {
  const sobject = requireString(args.sobject, "sobject");
  const id      = requireString(args.id, "id");
  const res = await sfRequest(ctx, "DELETE",
    `${ctx.apiBase}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, id };
  return { deleted: true, id };
}

async function sobjectDescribe(ctx, args) {
  const sobject = requireString(args.sobject, "sobject");
  const res = await sfRequest(ctx, "GET",
    `${ctx.apiBase}/sobjects/${encodeURIComponent(sobject)}/describe`,
    null, null, [200]);
  return res.body;
}

async function sobjectList(ctx, _args) {
  const res = await sfRequest(ctx, "GET", `${ctx.apiBase}/sobjects/`, null, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOQL QUERY
// ═══════════════════════════════════════════════════════════════════════════════

async function soqlQuery(ctx, args) {
  const q = requireString(args.query, "query");
  const params = { q };
  if (args.all_rows) {
    // queryAll includes deleted/archived records
    const res = await sfRequest(ctx, "GET", `${ctx.apiBase}/queryAll`,
      null, params, [200]);
    return res.body;
  }
  const res = await sfRequest(ctx, "GET", `${ctx.apiBase}/query`,
    null, params, [200]);
  return res.body;
}

async function soqlQueryMore(ctx, args) {
  const nextUrl = requireString(args.next_records_url, "next_records_url");
  // nextUrl is typically /services/data/vXX.X/query/01gXXXXXXXXX-500
  const res = await sfRequest(ctx, "GET", nextUrl, null, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH (SOSL)
// ═══════════════════════════════════════════════════════════════════════════════

async function soslSearch(ctx, args) {
  const q = requireString(args.query, "query");
  const res = await sfRequest(ctx, "GET", `${ctx.apiBase}/search`,
    null, { q }, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSITE (batch multiple requests in one HTTP call)
// ═══════════════════════════════════════════════════════════════════════════════

async function composite(ctx, args) {
  const requests = args.composite_request;
  if (!Array.isArray(requests) || !requests.length)
    throw new Error("composite_request (array) is required for composite");
  const allOrNone = args.all_or_none !== false;
  const body = { compositeRequest: requests, allOrNone };
  const res = await sfRequest(ctx, "POST", `${ctx.apiBase}/composite`,
    body, null, [200]);
  return res.body;
}

async function compositeBatch(ctx, args) {
  const requests = args.batch_requests;
  if (!Array.isArray(requests) || !requests.length)
    throw new Error("batch_requests (array) is required for composite_batch");
  const haltOnError = !!args.halt_on_error;
  const body = { batchRequests: requests, haltOnError };
  const res = await sfRequest(ctx, "POST", `${ctx.apiBase}/composite/batch`,
    body, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIMITS & METADATA
// ═══════════════════════════════════════════════════════════════════════════════

async function getLimits(ctx, _args) {
  const res = await sfRequest(ctx, "GET", `${ctx.apiBase}/limits`, null, null, [200]);
  return res.body;
}

async function getApiVersions(ctx, _args) {
  const res = await sfRequest(ctx, "GET", `/services/data/`, null, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC REQUEST
// ═══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method = requireString(args.method, "method").toUpperCase();
  const path   = requireString(args.path, "path");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
    throw new Error(`Unsupported method: ${method}`);
  const body   = (method !== "GET" && method !== "DELETE" && method !== "HEAD")
    ? (args.body ?? null) : null;
  const params = (method === "GET" || method === "DELETE") ? (args.params ?? null) : null;
  const res = await sfRequest(ctx, method, path, body, params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function salesforceClient(args) {
  const op = requireString(args.operation, "operation");

  const ctx = await buildCtx(args);

  switch (op) {
    case "sobject_create":    return sobjectCreate(ctx, args);
    case "sobject_get":       return sobjectGet(ctx, args);
    case "sobject_update":    return sobjectUpdate(ctx, args);
    case "sobject_delete":    return sobjectDelete(ctx, args);
    case "sobject_describe":  return sobjectDescribe(ctx, args);
    case "sobject_list":      return sobjectList(ctx, args);
    case "query":             return soqlQuery(ctx, args);
    case "query_more":        return soqlQueryMore(ctx, args);
    case "search":            return soslSearch(ctx, args);
    case "composite":         return composite(ctx, args);
    case "composite_batch":   return compositeBatch(ctx, args);
    case "get_limits":        return getLimits(ctx, args);
    case "get_api_versions":  return getApiVersions(ctx, args);
    case "request":           return genericRequest(ctx, args);
    default:
      throw new Error(
        `Unknown operation: ${op}. Supported: ` +
        `sobject_create, sobject_get, sobject_update, sobject_delete, ` +
        `sobject_describe, sobject_list, query, query_more, search, ` +
        `composite, composite_batch, get_limits, get_api_versions, request`
      );
  }
}

module.exports = { salesforceClient, loginWithPassword };
