"use strict";
/**
 * airtableClientOps.js
 * Zero-dependency Airtable REST API client (pure Node.js https; no npm deps).
 *
 * Auth: Personal Access Token (Bearer) or API Key (legacy).
 * Base URL: https://api.airtable.com/v0/
 * Meta URL: https://api.airtable.com/v0/meta/
 *
 * Supports:
 *   Records   (8): record_list, record_get, record_create, record_update,
 *                  record_upsert, record_delete, record_bulk_create, record_bulk_delete
 *   Bases     (3): base_list, base_schema, base_create
 *   Tables    (3): table_create, table_update, table_delete
 *   Fields    (2): field_create, field_update
 *   Views     (1): view_list
 *   Webhooks  (4): webhook_list, webhook_create, webhook_delete, webhook_payloads
 *   Comments  (3): comment_list, comment_create, comment_delete
 *   Generic   (1): request
 *
 * Security: Bearer token scrubbed from ALL error messages; NUL-byte guards on
 * all string inputs; 16 MB response cap; timeout clamped 1000–120000 ms; TLS enforced.
 */

const https = require("https");

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const API_HOST          = "api.airtable.com";
const API_BASE_PATH     = "/v0";
const META_BASE_PATH    = "/v0/meta";
const NUL_RE            = /\x00/;

// ── Helpers ────────────────────────────────────────────────────────────────────
function scrubToken(str, token) {
  if (!token) return String(str);
  return String(str).split(token).join("[REDACTED]");
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

function optBool(val, name) {
  if (val == null) return undefined;
  if (typeof val !== "boolean") throw new Error(`${name} must be a boolean`);
  return val;
}

/**
 * Low-level HTTPS request (returns raw status + parsed body).
 */
function rawRequest({ path, method, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);

    const bodyStr = body != null
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;

    const hdrs = { ...headers };
    if (bodyStr) {
      if (!hdrs["Content-Type"]) hdrs["Content-Type"] = "application/json";
      hdrs["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: API_HOST,
      port: 443,
      path,
      method: method || "GET",
      headers: hdrs,
      rejectUnauthorized: true,
    };

    let timer;
    const req = https.request(options, (res) => {
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
      res.on("error", (err) => { clearTimeout(timer); reject(new Error(err.message)); });
    });

    timer = setTimeout(() => {
      reject(new Error(`Airtable request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => { clearTimeout(timer); reject(new Error(err.message)); });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Build context from tool args.
 */
function buildCtx(args) {
  const token = requireString(args.api_key || args.token, "api_key");
  return {
    token,
    timeout: clampTimeout(args.timeout),
    _secret: token,
  };
}

/**
 * Airtable REST request with error handling.
 */
async function atRequest(ctx, method, path, body, params, allowedStatuses) {
  let fullPath = path;

  if (params && Object.keys(params).length) {
    const filtered = Object.entries(params).filter(([, v]) => v != null);
    if (filtered.length) {
      // Airtable uses fields[]=... style for arrays
      const parts = [];
      for (const [k, v] of filtered) {
        if (Array.isArray(v)) {
          for (const item of v) parts.push(`${encodeURIComponent(k)}[]=${encodeURIComponent(String(item))}`);
        } else {
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
      }
      if (parts.length) fullPath += "?" + parts.join("&");
    }
  }

  const headers = {
    "Authorization": `Bearer ${ctx.token}`,
    "Accept":        "application/json",
    "User-Agent":    "mcp-common-server/airtable_client",
  };

  const res = await rawRequest({
    path: fullPath,
    method,
    headers,
    body: (method !== "GET" && method !== "DELETE") ? (body ?? null) : null,
    timeout: ctx.timeout,
  });

  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;

  if (!ok) {
    const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
    throw new Error(`Airtable API error ${res.status}: ${scrubToken(errBody, ctx._secret)}`);
  }

  return res.body;
}

// ══════════════════════════════════════════════════════════════════════════════
// RECORDS
// ══════════════════════════════════════════════════════════════════════════════

async function recordList(ctx, args) {
  const baseId   = requireString(args.base_id,   "base_id");
  const tableId  = requireString(args.table_id,  "table_id");
  const params   = {};
  const fields   = args.fields;   // array
  const filterFormula = optStr(args.filter_formula, "filter_formula");
  const maxRecords    = optInt(args.max_records, "max_records", 1, 100000);
  const pageSize      = optInt(args.page_size,   "page_size",  1, 100);
  const offset        = optStr(args.offset,      "offset");
  const sort         = args.sort;   // array of {field, direction}
  const view          = optStr(args.view,        "view");
  const cellFormat    = optStr(args.cell_format, "cell_format");
  const timeZone      = optStr(args.time_zone,   "time_zone");
  const userLocale    = optStr(args.user_locale, "user_locale");
  const returnFieldsByFieldId = optBool(args.return_fields_by_field_id, "return_fields_by_field_id");

  if (fields && Array.isArray(fields)) params.fields = fields;
  if (filterFormula) params.filterByFormula   = filterFormula;
  if (maxRecords != null) params.maxRecords   = maxRecords;
  if (pageSize != null)   params.pageSize     = pageSize;
  if (offset)             params.offset       = offset;
  if (view)               params.view         = view;
  if (cellFormat)         params.cellFormat   = cellFormat;
  if (timeZone)           params.timeZone     = timeZone;
  if (userLocale)         params.userLocale   = userLocale;
  if (returnFieldsByFieldId != null) params.returnFieldsByFieldId = returnFieldsByFieldId;

  // Sort: ?sort[0][field]=Name&sort[0][direction]=asc
  if (sort && Array.isArray(sort)) {
    for (let i = 0; i < sort.length; i++) {
      const s = sort[i];
      if (s.field) params[`sort[${i}][field]`]     = s.field;
      if (s.direction) params[`sort[${i}][direction]`] = s.direction;
    }
  }

  // Flatten array params for fields
  const flatParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) flatParams[`${k}[${i}]`] = v[i];
    } else {
      flatParams[k] = v;
    }
  }

  return atRequest(ctx, "GET",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`,
    null, flatParams, [200]);
}

async function recordGet(ctx, args) {
  const baseId   = requireString(args.base_id,   "base_id");
  const tableId  = requireString(args.table_id,  "table_id");
  const recordId = requireString(args.record_id, "record_id");
  return atRequest(ctx, "GET",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`,
    null, null, [200]);
}

async function recordCreate(ctx, args) {
  const baseId  = requireString(args.base_id,  "base_id");
  const tableId = requireString(args.table_id, "table_id");
  const fields  = args.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("fields (object) is required for record_create");
  const body = { fields };
  const typecast = optBool(args.typecast, "typecast");
  if (typecast != null) body.typecast = typecast;
  return atRequest(ctx, "POST",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`,
    body, null, [200]);
}

async function recordUpdate(ctx, args) {
  const baseId   = requireString(args.base_id,   "base_id");
  const tableId  = requireString(args.table_id,  "table_id");
  const recordId = requireString(args.record_id, "record_id");
  const fields   = args.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error("fields (object) is required for record_update");
  // PATCH = merge update, PUT = destructive replace
  const method   = args.replace === true ? "PUT" : "PATCH";
  const body     = { fields };
  const typecast = optBool(args.typecast, "typecast");
  if (typecast != null) body.typecast = typecast;
  return atRequest(ctx, method,
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`,
    body, null, [200]);
}

async function recordUpsert(ctx, args) {
  const baseId   = requireString(args.base_id,   "base_id");
  const tableId  = requireString(args.table_id,  "table_id");
  const records  = args.records;
  if (!Array.isArray(records) || records.length === 0)
    throw new Error("records (non-empty array) is required for record_upsert");
  if (records.length > 10)
    throw new Error("record_upsert supports at most 10 records per call");
  const fieldsToMergeOn = args.fields_to_merge_on;
  if (!Array.isArray(fieldsToMergeOn) || fieldsToMergeOn.length === 0)
    throw new Error("fields_to_merge_on (non-empty array) is required for record_upsert");
  const body = { records, fieldsToMergeOn };
  const typecast = optBool(args.typecast, "typecast");
  if (typecast != null) body.typecast = typecast;
  return atRequest(ctx, "PATCH",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`,
    body, null, [200]);
}

async function recordDelete(ctx, args) {
  const baseId   = requireString(args.base_id,   "base_id");
  const tableId  = requireString(args.table_id,  "table_id");
  const recordId = requireString(args.record_id, "record_id");
  return atRequest(ctx, "DELETE",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}`,
    null, null, [200]);
}

async function recordBulkCreate(ctx, args) {
  const baseId  = requireString(args.base_id,  "base_id");
  const tableId = requireString(args.table_id, "table_id");
  const records = args.records;
  if (!Array.isArray(records) || records.length === 0)
    throw new Error("records (non-empty array) is required for record_bulk_create");
  if (records.length > 10)
    throw new Error("record_bulk_create supports at most 10 records per call");
  const body = { records };
  const typecast = optBool(args.typecast, "typecast");
  if (typecast != null) body.typecast = typecast;
  return atRequest(ctx, "POST",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`,
    body, null, [200]);
}

async function recordBulkDelete(ctx, args) {
  const baseId   = requireString(args.base_id,   "base_id");
  const tableId  = requireString(args.table_id,  "table_id");
  const recordIds = args.record_ids;
  if (!Array.isArray(recordIds) || recordIds.length === 0)
    throw new Error("record_ids (non-empty array) is required for record_bulk_delete");
  if (recordIds.length > 10)
    throw new Error("record_bulk_delete supports at most 10 record IDs per call");
  // Airtable bulk delete uses query params: ?records[]=recXXX&records[]=recYYY
  const params = {};
  for (let i = 0; i < recordIds.length; i++) {
    params[`records[${i}]`] = recordIds[i];
  }
  return atRequest(ctx, "DELETE",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`,
    null, params, [200]);
}

// ══════════════════════════════════════════════════════════════════════════════
// BASES
// ══════════════════════════════════════════════════════════════════════════════

async function baseList(ctx, _args) {
  return atRequest(ctx, "GET", `${META_BASE_PATH}/bases`, null, null, [200]);
}

async function baseSchema(ctx, args) {
  const baseId = requireString(args.base_id, "base_id");
  const params = {};
  const include = optStr(args.include, "include");
  if (include) params.include = include;
  return atRequest(ctx, "GET", `${META_BASE_PATH}/bases/${encodeURIComponent(baseId)}/tables`, null, params, [200]);
}

async function baseCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const tables = args.tables;
  if (!Array.isArray(tables) || tables.length === 0)
    throw new Error("tables (non-empty array) is required for base_create");
  const workspaceId = optStr(args.workspace_id, "workspace_id");
  const body = { name, tables };
  if (workspaceId) body.workspaceId = workspaceId;
  return atRequest(ctx, "POST", `${META_BASE_PATH}/bases`, body, null, [200]);
}

// ══════════════════════════════════════════════════════════════════════════════
// TABLES
// ══════════════════════════════════════════════════════════════════════════════

async function tableCreate(ctx, args) {
  const baseId = requireString(args.base_id, "base_id");
  const name   = requireString(args.name,    "name");
  const fields = args.fields;
  if (!Array.isArray(fields) || fields.length === 0)
    throw new Error("fields (non-empty array) is required for table_create");
  const body = { name, fields };
  const description = optStr(args.description, "description");
  if (description) body.description = description;
  return atRequest(ctx, "POST",
    `${META_BASE_PATH}/bases/${encodeURIComponent(baseId)}/tables`,
    body, null, [200]);
}

async function tableUpdate(ctx, args) {
  const baseId  = requireString(args.base_id,  "base_id");
  const tableId = requireString(args.table_id, "table_id");
  const body = {};
  const name        = optStr(args.name,        "name");
  const description = optStr(args.description, "description");
  if (name)        body.name        = name;
  if (description) body.description = description;
  if (Object.keys(body).length === 0)
    throw new Error("At least one of name or description is required for table_update");
  return atRequest(ctx, "PATCH",
    `${META_BASE_PATH}/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}`,
    body, null, [200]);
}

async function tableDelete(ctx, args) {
  const baseId  = requireString(args.base_id,  "base_id");
  const tableId = requireString(args.table_id, "table_id");
  return atRequest(ctx, "DELETE",
    `${META_BASE_PATH}/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}`,
    null, null, [200]);
}

// ══════════════════════════════════════════════════════════════════════════════
// FIELDS
// ══════════════════════════════════════════════════════════════════════════════

async function fieldCreate(ctx, args) {
  const baseId  = requireString(args.base_id,  "base_id");
  const tableId = requireString(args.table_id, "table_id");
  const name    = requireString(args.name,     "name");
  const type    = requireString(args.type,     "type");
  const body    = { name, type };
  if (args.options && typeof args.options === "object") body.options = args.options;
  const description = optStr(args.description, "description");
  if (description) body.description = description;
  return atRequest(ctx, "POST",
    `${META_BASE_PATH}/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields`,
    body, null, [200]);
}

async function fieldUpdate(ctx, args) {
  const baseId  = requireString(args.base_id,  "base_id");
  const tableId = requireString(args.table_id, "table_id");
  const fieldId = requireString(args.field_id, "field_id");
  const body    = {};
  const name        = optStr(args.name,        "name");
  const description = optStr(args.description, "description");
  if (name)        body.name        = name;
  if (description) body.description = description;
  if (args.options && typeof args.options === "object") body.options = args.options;
  if (Object.keys(body).length === 0)
    throw new Error("At least one of name, description, or options is required for field_update");
  return atRequest(ctx, "PATCH",
    `${META_BASE_PATH}/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(fieldId)}`,
    body, null, [200]);
}

// ══════════════════════════════════════════════════════════════════════════════
// VIEWS
// ══════════════════════════════════════════════════════════════════════════════

async function viewList(ctx, args) {
  const baseId  = requireString(args.base_id,  "base_id");
  const tableId = requireString(args.table_id, "table_id");
  return atRequest(ctx, "GET",
    `${META_BASE_PATH}/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/views`,
    null, null, [200]);
}

// ══════════════════════════════════════════════════════════════════════════════
// WEBHOOKS
// ══════════════════════════════════════════════════════════════════════════════

async function webhookList(ctx, args) {
  const baseId = requireString(args.base_id, "base_id");
  return atRequest(ctx, "GET",
    `/v0/bases/${encodeURIComponent(baseId)}/webhooks`,
    null, null, [200]);
}

async function webhookCreate(ctx, args) {
  const baseId      = requireString(args.base_id,      "base_id");
  const notificationUrl = requireString(args.notification_url, "notification_url");
  const specification = args.specification;
  if (!specification || typeof specification !== "object" || Array.isArray(specification))
    throw new Error("specification (object) is required for webhook_create");
  const body = { notificationUrl, specification };
  const cursorForNextPayload = optInt(args.cursor_for_next_payload, "cursor_for_next_payload", 1);
  if (cursorForNextPayload != null) body.cursorForNextPayload = cursorForNextPayload;
  return atRequest(ctx, "POST",
    `/v0/bases/${encodeURIComponent(baseId)}/webhooks`,
    body, null, [200]);
}

async function webhookDelete(ctx, args) {
  const baseId    = requireString(args.base_id,    "base_id");
  const webhookId = requireString(args.webhook_id, "webhook_id");
  return atRequest(ctx, "DELETE",
    `/v0/bases/${encodeURIComponent(baseId)}/webhooks/${encodeURIComponent(webhookId)}`,
    null, null, [200]);
}

async function webhookPayloads(ctx, args) {
  const baseId    = requireString(args.base_id,    "base_id");
  const webhookId = requireString(args.webhook_id, "webhook_id");
  const params    = {};
  const cursor = optInt(args.cursor, "cursor", 1);
  if (cursor != null) params.cursor = cursor;
  return atRequest(ctx, "GET",
    `/v0/bases/${encodeURIComponent(baseId)}/webhooks/${encodeURIComponent(webhookId)}/payloads`,
    null, params, [200]);
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════════════════════════════

async function commentList(ctx, args) {
  const baseId   = requireString(args.base_id,   "base_id");
  const tableId  = requireString(args.table_id,  "table_id");
  const recordId = requireString(args.record_id, "record_id");
  const params   = {};
  const offset   = optStr(args.offset, "offset");
  if (offset) params.offset = offset;
  return atRequest(ctx, "GET",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}/comments`,
    null, params, [200]);
}

async function commentCreate(ctx, args) {
  const baseId   = requireString(args.base_id,   "base_id");
  const tableId  = requireString(args.table_id,  "table_id");
  const recordId = requireString(args.record_id, "record_id");
  const text     = requireString(args.text,      "text");
  return atRequest(ctx, "POST",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}/comments`,
    { text }, null, [200]);
}

async function commentDelete(ctx, args) {
  const baseId    = requireString(args.base_id,    "base_id");
  const tableId   = requireString(args.table_id,   "table_id");
  const recordId  = requireString(args.record_id,  "record_id");
  const commentId = requireString(args.comment_id, "comment_id");
  return atRequest(ctx, "DELETE",
    `${API_BASE_PATH}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}/${encodeURIComponent(recordId)}/comments/${encodeURIComponent(commentId)}`,
    null, null, [200]);
}

// ══════════════════════════════════════════════════════════════════════════════
// GENERIC REQUEST
// ══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method = requireString(args.method, "method").toUpperCase();
  const path   = requireString(args.path,   "path");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
    throw new Error(`Unsupported method: ${method}`);
  const body   = (method !== "GET" && method !== "DELETE" && method !== "HEAD")
    ? (args.body ?? null) : null;
  const params = (method === "GET" || method === "DELETE") ? (args.params ?? null) : null;
  return atRequest(ctx, method, path, body, params);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ══════════════════════════════════════════════════════════════════════════════

async function airtableClient(args) {
  const op  = requireString(args.operation, "operation");
  const ctx = buildCtx(args);

  switch (op) {
    // Records
    case "record_list":        return recordList(ctx, args);
    case "record_get":         return recordGet(ctx, args);
    case "record_create":      return recordCreate(ctx, args);
    case "record_update":      return recordUpdate(ctx, args);
    case "record_upsert":      return recordUpsert(ctx, args);
    case "record_delete":      return recordDelete(ctx, args);
    case "record_bulk_create": return recordBulkCreate(ctx, args);
    case "record_bulk_delete": return recordBulkDelete(ctx, args);
    // Bases
    case "base_list":          return baseList(ctx, args);
    case "base_schema":        return baseSchema(ctx, args);
    case "base_create":        return baseCreate(ctx, args);
    // Tables
    case "table_create":       return tableCreate(ctx, args);
    case "table_update":       return tableUpdate(ctx, args);
    case "table_delete":       return tableDelete(ctx, args);
    // Fields
    case "field_create":       return fieldCreate(ctx, args);
    case "field_update":       return fieldUpdate(ctx, args);
    // Views
    case "view_list":          return viewList(ctx, args);
    // Webhooks
    case "webhook_list":       return webhookList(ctx, args);
    case "webhook_create":     return webhookCreate(ctx, args);
    case "webhook_delete":     return webhookDelete(ctx, args);
    case "webhook_payloads":   return webhookPayloads(ctx, args);
    // Comments
    case "comment_list":       return commentList(ctx, args);
    case "comment_create":     return commentCreate(ctx, args);
    case "comment_delete":     return commentDelete(ctx, args);
    // Generic
    case "request":            return genericRequest(ctx, args);
    default:
      throw new Error(
        `Unknown operation: ${op}. Supported: ` +
        `record_list, record_get, record_create, record_update, record_upsert, record_delete, ` +
        `record_bulk_create, record_bulk_delete, ` +
        `base_list, base_schema, base_create, ` +
        `table_create, table_update, table_delete, ` +
        `field_create, field_update, ` +
        `view_list, ` +
        `webhook_list, webhook_create, webhook_delete, webhook_payloads, ` +
        `comment_list, comment_create, comment_delete, ` +
        `request`
      );
  }
}

module.exports = { airtableClient };
