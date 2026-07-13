"use strict";
/**
 * influxdb_client — Zero-dependency InfluxDB v2/v3 HTTP API client.
 * Pure Node.js (https/http built-ins only; no npm deps).
 *
 * Supported operations:
 *   ping            — GET /ping  (v1/v2/v3)
 *   health          — GET /health (v2) or /api/v2/health
 *   write           — POST line-protocol points to /api/v2/write (v2) or /write (v1)
 *   query_flux      — POST Flux query to /api/v2/query
 *   query_influxql  — POST InfluxQL query to /query (v1) or /api/v2/query with dialect
 *   buckets         — GET /api/v2/buckets (v2)
 *   orgs            — GET /api/v2/orgs (v2)
 *   measurements    — Query SHOW MEASUREMENTS (v1/v2)
 *   delete          — DELETE /api/v2/delete (v2)
 *
 * Auth:
 *   token     — Bearer token (InfluxDB 2.x / 3.x)
 *   v1        — username + password (InfluxDB 1.x, also works on v2 compat endpoints)
 *
 * Security:
 *   - NUL-byte guards on host, token, org, bucket
 *   - 32 MB response cap
 *   - timeout clamped 1 s – 300 s
 *   - credentials never surfaced in error messages
 *   - HTTP/HTTPS support; HTTPS with optional rejectUnauthorized
 */

const https = require("https");
const http  = require("http");
const { URL } = require("url");

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MB
const DEFAULT_TIMEOUT_MS = 30_000;            // 30 s
const MIN_TIMEOUT_MS     = 1_000;             // 1 s
const MAX_TIMEOUT_MS     = 300_000;           // 300 s

// ── Helpers ───────────────────────────────────────────────────────────────────

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`influxdb_client: '${name}' must not contain NUL bytes.`);
}

function buildAuthHeaders(args) {
  const headers = {};
  if (args.token) {
    guardNul(args.token, "token");
    headers["Authorization"] = `Token ${args.token}`;
  } else if (args.username) {
    // V1 basic auth via header; also accepted on v2 compat endpoints
    const cred = Buffer.from(`${args.username}:${args.password || ""}`).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }
  return headers;
}

/**
 * Perform a raw HTTP/HTTPS request.
 * Returns { statusCode, headers, body (string) }.
 */
function doRequest({
  baseUrl,
  path,
  method = "GET",
  headers = {},
  body,             // string | Buffer | undefined
  timeoutMs = DEFAULT_TIMEOUT_MS,
  rejectUnauthorized = true,
}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, baseUrl);
    } catch (e) {
      return reject(new Error(`influxdb_client: invalid URL: ${baseUrl}${path}`));
    }

    const isHttps = url.protocol === "https:";
    const mod     = isHttps ? https : http;

    const reqOpts = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers:  { ...headers },
      timeout:  timeoutMs,
    };
    if (isHttps) reqOpts.rejectUnauthorized = rejectUnauthorized;

    const bodyBuf = body != null
      ? (Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"))
      : null;

    if (bodyBuf) {
      reqOpts.headers["Content-Length"] = bodyBuf.length;
    }

    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      let totalBytes = 0;
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("influxdb_client: response exceeds 32 MB cap."));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          body:       Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });

    req.on("timeout", () => {
      req.destroy(new Error(`influxdb_client: request timed out after ${timeoutMs} ms.`));
    });
    req.on("error", (e) => {
      // Scrub credentials from error message
      const msg = e.message.replace(/Token [^ ]+/g, "Token [REDACTED]").replace(/Basic [^ ]+/g, "Basic [REDACTED]");
      reject(new Error(msg));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** Parse JSON body safely. */
function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Raise if status code indicates failure. */
function assertOk(res, context) {
  if (res.statusCode >= 200 && res.statusCode < 300) return;
  const parsed = parseJSON(res.body);
  const msg = (parsed && (parsed.message || parsed.error)) || res.body.slice(0, 500) || `HTTP ${res.statusCode}`;
  throw new Error(`influxdb_client: ${context} failed (HTTP ${res.statusCode}): ${msg}`);
}

/** Build base URL from args. */
function buildBase(args) {
  const scheme = args.ssl === false ? "http" : (args.ssl === true ? "https" : "https");
  const host   = (args.host || "localhost").replace(/\/+$/, "");
  const port   = args.port ? `:${args.port}` : "";
  return `${scheme}://${host}${port}`;
}

/** Append query string params, skipping undefined. */
function qs(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj))
    if (v !== undefined && v !== null) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

// ── Operations ────────────────────────────────────────────────────────────────

/** ping — GET /ping */
async function opPing(args, common) {
  const res = await doRequest({ ...common, path: "/ping", method: "GET" });
  // /ping returns 204 on v2, 200 on v1; both are OK
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw new Error(`influxdb_client: ping failed (HTTP ${res.statusCode}): ${res.body.slice(0, 200)}`);
  }
  return {
    ok:         true,
    statusCode: res.statusCode,
    version:    res.headers["x-influxdb-version"] || res.headers["x-influxdb-build"] || null,
    build:      res.headers["x-influxdb-build"] || null,
  };
}

/** health — GET /health (v2) */
async function opHealth(args, common) {
  const res = await doRequest({ ...common, path: "/health", method: "GET" });
  const parsed = parseJSON(res.body);
  if (!parsed) {
    // Fallback: /api/v2/health
    const res2 = await doRequest({ ...common, path: "/api/v2/health", method: "GET" });
    const p2 = parseJSON(res2.body);
    return p2 || { ok: res2.statusCode < 300, statusCode: res2.statusCode, raw: res2.body.slice(0, 500) };
  }
  return { ok: parsed.status === "pass" || parsed.status === "ok" || res.statusCode < 300, ...parsed };
}

/** write — POST line-protocol data */
async function opWrite(args, common) {
  const org    = args.org    || "";
  const bucket = args.bucket || "";
  if (!bucket) throw new Error("influxdb_client: write requires 'bucket'.");
  guardNul(org, "org");
  guardNul(bucket, "bucket");

  // Accept lines as array or string
  let body;
  if (Array.isArray(args.lines)) {
    body = args.lines.join("\n");
  } else if (typeof args.lines === "string") {
    body = args.lines;
  } else {
    throw new Error("influxdb_client: write requires 'lines' (string or array of strings).");
  }
  if (!body.trim()) throw new Error("influxdb_client: write 'lines' must not be empty.");

  // v2: /api/v2/write?org=...&bucket=...&precision=...
  // v1: /write?db=...&precision=...
  let path;
  const precision = args.precision || "ns";
  const apiVersion = args.api_version || "v2";

  if (apiVersion === "v1") {
    path = `/write${qs({ db: bucket, precision, u: args.username, p: args.password })}`;
  } else {
    path = `/api/v2/write${qs({ org, bucket, precision })}`;
  }

  const headers = { ...common.headers, "Content-Type": "text/plain; charset=utf-8" };
  const res = await doRequest({ ...common, path, method: "POST", headers, body });
  // 204 = success on v2; 200 on some v1 setups
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    const parsed = parseJSON(res.body);
    const msg = (parsed && (parsed.message || parsed.error)) || res.body.slice(0, 500);
    throw new Error(`influxdb_client: write failed (HTTP ${res.statusCode}): ${msg}`);
  }
  const lineCount = body.split("\n").filter(l => l.trim()).length;
  return { ok: true, statusCode: res.statusCode, linesWritten: lineCount, bucket, org };
}

/** query_flux — POST Flux query to /api/v2/query */
async function opQueryFlux(args, common) {
  const org   = args.org || "";
  const query = args.query;
  if (!query) throw new Error("influxdb_client: query_flux: 'query' is required.");
  guardNul(org, "org");

  const path = `/api/v2/query${qs({ org })}`;
  const reqBody = JSON.stringify({
    query,
    type:    "flux",
    dialect: {
      header:      args.header !== false,
      delimiter:   ",",
      annotations: args.annotations || ["datatype", "group", "default"],
      commentPrefix: "#",
      dateTimeFormat: "RFC3339",
    },
  });
  const headers = { ...common.headers, "Content-Type": "application/json", "Accept": "application/csv" };
  const res = await doRequest({ ...common, path, method: "POST", headers, body: reqBody });
  assertOk(res, "query_flux");

  // Parse CSV result into rows
  const rows = parseCsvResult(res.body, args.max_rows);
  return {
    ok:      true,
    query,
    org,
    rowCount: rows.length,
    rows,
    raw: args.raw ? res.body.slice(0, 65536) : undefined,
  };
}

/** query_influxql — POST InfluxQL query to /query (v1) or InfluxQL-compat on v2 */
async function opQueryInfluxQL(args, common) {
  const db    = args.db || args.bucket || "";
  const query = args.query;
  if (!query) throw new Error("influxdb_client: query_influxql: 'query' is required.");
  guardNul(db, "db");

  const apiVersion = args.api_version || "v1";
  let path;
  if (apiVersion === "v1") {
    // v1: GET or POST /query?db=...&q=...
    path = `/query${qs({ db, q: query, epoch: args.epoch || "ns", u: args.username, p: args.password })}`;
  } else {
    // v2 InfluxQL compat: POST /api/v2/query?org=...  with Content-Type: application/vnd.influxql
    path = `/api/v2/query${qs({ org: args.org || "" })}`;
  }

  let res;
  if (apiVersion === "v2") {
    const headers = { ...common.headers, "Content-Type": "application/vnd.influxql", "Accept": "application/csv" };
    res = await doRequest({ ...common, path, method: "POST", headers, body: query });
  } else {
    res = await doRequest({ ...common, path, method: "GET" });
  }
  assertOk(res, "query_influxql");

  const parsed = parseJSON(res.body);
  if (parsed && parsed.results) {
    // v1 JSON response
    const rows = flattenInfluxV1Results(parsed.results, args.max_rows);
    return { ok: true, query, db, rowCount: rows.length, rows };
  }
  // CSV response (v2 compat)
  const rows = parseCsvResult(res.body, args.max_rows);
  return { ok: true, query, db, rowCount: rows.length, rows };
}

/** buckets — GET /api/v2/buckets */
async function opBuckets(args, common) {
  const org   = args.org || "";
  const limit = args.limit || 100;
  guardNul(org, "org");
  const path = `/api/v2/buckets${qs({ org: org || undefined, limit, offset: args.offset || 0 })}`;
  const res = await doRequest({ ...common, path, method: "GET" });
  assertOk(res, "buckets");
  const parsed = parseJSON(res.body);
  const buckets = (parsed && parsed.buckets) || [];
  return {
    ok:      true,
    count:   buckets.length,
    buckets: buckets.map(b => ({
      id:              b.id,
      name:            b.name,
      orgID:           b.orgID,
      type:            b.type,
      retentionRules:  b.retentionRules,
      createdAt:       b.createdAt,
    })),
  };
}

/** orgs — GET /api/v2/orgs */
async function opOrgs(args, common) {
  const limit = args.limit || 100;
  const path = `/api/v2/orgs${qs({ limit, offset: args.offset || 0 })}`;
  const res = await doRequest({ ...common, path, method: "GET" });
  assertOk(res, "orgs");
  const parsed = parseJSON(res.body);
  const orgs = (parsed && parsed.orgs) || [];
  return {
    ok:    true,
    count: orgs.length,
    orgs:  orgs.map(o => ({ id: o.id, name: o.name, description: o.description, createdAt: o.createdAt })),
  };
}

/** measurements — SHOW MEASUREMENTS via InfluxQL */
async function opMeasurements(args, common) {
  const db     = args.db || args.bucket || "";
  if (!db) throw new Error("influxdb_client: measurements requires 'db' or 'bucket'.");
  guardNul(db, "db");
  const apiVersion = args.api_version || "v1";
  const fakeArgs   = { ...args, query: "SHOW MEASUREMENTS", db, api_version: apiVersion };
  const result = await opQueryInfluxQL(fakeArgs, common);
  // Extract measurement names from rows
  const names = result.rows
    .filter(r => r.name !== undefined || r._value !== undefined)
    .map(r => r.name || r._value || r.value || Object.values(r)[0])
    .filter(Boolean);
  return { ok: true, db, measurementCount: names.length, measurements: names };
}

/** delete — DELETE /api/v2/delete  (v2 predicate delete) */
async function opDelete(args, common) {
  const org    = args.org    || "";
  const bucket = args.bucket || "";
  if (!bucket) throw new Error("influxdb_client: delete requires 'bucket'.");
  if (!args.start) throw new Error("influxdb_client: delete requires 'start' (RFC3339 timestamp).");
  if (!args.stop)  throw new Error("influxdb_client: delete requires 'stop'  (RFC3339 timestamp).");
  guardNul(org, "org"); guardNul(bucket, "bucket");

  const path    = `/api/v2/delete${qs({ org, bucket })}`;
  const reqBody = JSON.stringify({
    start:     args.start,
    stop:      args.stop,
    predicate: args.predicate || "",
  });
  const headers = { ...common.headers, "Content-Type": "application/json" };
  const res = await doRequest({ ...common, path, method: "DELETE", headers, body: reqBody });
  assertOk(res, "delete");
  return { ok: true, statusCode: res.statusCode, bucket, org, start: args.start, stop: args.stop };
}

// ── CSV parser for Flux annotated CSV ────────────────────────────────────────

function parseCsvResult(csv, maxRows = 10000) {
  const MAX_ROWS = Math.min(50000, Math.max(1, Math.trunc(maxRows)));
  const lines    = csv.split("\n");
  const rows     = [];
  let headers    = null;
  let dataTypes  = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#datatype") || line.startsWith("#group") || line.startsWith("#default")) {
      // Capture datatype line
      if (line.startsWith("#datatype")) {
        dataTypes = splitCsvLine(line);
      }
      continue;
    }
    const cells = splitCsvLine(line);
    if (!headers) {
      headers = cells;
      continue;
    }
    if (rows.length >= MAX_ROWS) break;
    const row = {};
    headers.forEach((h, i) => {
      const val = cells[i] ?? "";
      // Skip annotation columns (empty string or "" header)
      if (!h || h === "") return;
      // Coerce via datatype
      const dt = dataTypes && dataTypes[i];
      row[h] = coerceCsvCell(val, dt);
    });
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  // Simple CSV split: handle quoted fields
  const cells = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function coerceCsvCell(val, dt) {
  if (dt === "long" || dt === "unsignedLong") {
    const n = parseInt(val, 10);
    return isNaN(n) ? val : n;
  }
  if (dt === "double" || dt === "float") {
    const n = parseFloat(val);
    return isNaN(n) ? val : n;
  }
  if (dt === "boolean") return val === "true";
  return val;
}

// ── InfluxDB v1 JSON result flattener ─────────────────────────────────────────

function flattenInfluxV1Results(results, maxRows = 10000) {
  const MAX = Math.min(50000, Math.max(1, Math.trunc(maxRows)));
  const out  = [];
  for (const result of (results || [])) {
    for (const series of (result.series || [])) {
      const cols = series.columns || [];
      const name = series.name;
      for (const vals of (series.values || [])) {
        if (out.length >= MAX) break;
        const row = { _measurement: name };
        cols.forEach((c, i) => { row[c] = vals[i]; });
        out.push(row);
      }
    }
    if (result.error) throw new Error(`influxdb_client: InfluxQL error: ${result.error}`);
  }
  return out;
}

// ── Main entry point ─────────────────────────────────────────────────────────

async function influxdbClient(args) {
  const op = args.operation;
  if (!op) throw new Error("influxdb_client: 'operation' is required.");

  // Validate host
  const host = args.host || "localhost";
  guardNul(host, "host");
  const baseUrl    = buildBase(args);
  const timeoutMs  = clampTimeout(args.timeout);
  const rejectUnauthorized = args.reject_unauthorized !== false;

  // Build auth headers
  const authHeaders = buildAuthHeaders(args);

  const common = {
    baseUrl,
    headers:  authHeaders,
    timeoutMs,
    rejectUnauthorized,
  };

  switch (op) {
    case "ping":           return opPing(args, common);
    case "health":         return opHealth(args, common);
    case "write":          return opWrite(args, common);
    case "query_flux":     return opQueryFlux(args, common);
    case "query_influxql": return opQueryInfluxQL(args, common);
    case "buckets":        return opBuckets(args, common);
    case "orgs":           return opOrgs(args, common);
    case "measurements":   return opMeasurements(args, common);
    case "delete":         return opDelete(args, common);
    default:
      throw new Error(
        `influxdb_client: unknown operation '${op}'. ` +
        `Valid: ping, health, write, query_flux, query_influxql, buckets, orgs, measurements, delete.`
      );
  }
}

module.exports = { influxdbClient };
