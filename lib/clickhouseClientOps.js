"use strict";
/**
 * clickhouse_client — Zero-dependency ClickHouse HTTP API client.
 * Pure Node.js (http + https built-ins; no npm deps).
 *
 * Supported operations:
 *   ping          — Check server liveness (GET /ping)
 *   info          — Return server version, settings, and connection details
 *   query         — Execute a SELECT / SHOW / DESCRIBE / EXPLAIN query
 *   insert        — Insert rows into a table (JSON, JSONEachRow, CSV, TSV formats)
 *   databases     — List databases (SHOW DATABASES)
 *   tables        — List tables in a database (SHOW TABLES)
 *   create_table  — Create a table with a schema definition
 *   drop_table    — Drop a table (optionally IF EXISTS)
 *
 * Formats supported for query output:
 *   JSONEachRow (default) — one JSON object per line, easy to parse
 *   JSON                  — full ClickHouse JSON response with metadata
 *   CSV / TSVWithNames    — tabular output
 *
 * Auth:
 *   username + password (sent as X-ClickHouse-User / X-ClickHouse-Key headers)
 *   or URL query params (?user=&password=) for older versions
 *
 * Security:
 *   - NUL-byte guards on host, database, username
 *   - Timeout clamped 1 s – 300 s
 *   - Response body capped at 32 MB
 *   - Credentials never in error messages
 *   - TLS: rejectUnauthorized configurable (default true)
 */

const http  = require("http");
const https = require("https");
const url   = require("url");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_HOST        = "127.0.0.1";
const DEFAULT_PORT_HTTP   = 8123;
const DEFAULT_PORT_HTTPS  = 8443;
const DEFAULT_DATABASE    = "default";
const DEFAULT_USERNAME    = "default";
const DEFAULT_TIMEOUT     = 30_000;
const MIN_TIMEOUT         = 1_000;
const MAX_TIMEOUT         = 300_000;
const MAX_RESPONSE_BYTES  = 32 * 1024 * 1024; // 32 MB
const MAX_INSERT_ROWS     = 100_000;

// ── Guards ────────────────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`clickhouse_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.trunc(n)));
}

// ── HTTP request helper ───────────────────────────────────────────────────────
function httpRequest({ protocol, host, port, path, method, headers, body, timeoutMs, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const mod = protocol === "https:" ? https : http;
    const options = {
      hostname: host,
      port,
      path,
      method: method || "GET",
      headers: headers || {},
      timeout: timeoutMs,
    };
    if (protocol === "https:") {
      options.rejectUnauthorized = rejectUnauthorized !== false;
    }

    const req = mod.request(options, (res) => {
      const chunks = [];
      let totalBytes = 0;
      let truncated = false;

      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          truncated = true;
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (truncated) {
          reject(new Error(
            `clickhouse_client: response too large (> ${MAX_RESPONSE_BYTES} bytes). ` +
            `Use LIMIT in your query to reduce result size.`
          ));
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });

      res.on("error", (e) => reject(new Error(`clickhouse_client: response error: ${e.message}`)));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`clickhouse_client: request to ${host}:${port} timed out after ${timeoutMs} ms.`));
    });

    req.on("error", (e) => {
      if (e.code === "ECONNREFUSED")
        reject(new Error(`clickhouse_client: connection refused to ${host}:${port}. Is ClickHouse running?`));
      else if (e.code === "ENOTFOUND")
        reject(new Error(`clickhouse_client: host not found: '${host}'.`));
      else
        reject(new Error(`clickhouse_client: network error: ${e.message}`));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ── Build connection config ───────────────────────────────────────────────────
function buildConfig(args) {
  const secure   = args.secure === true;
  const protocol = secure ? "https:" : "http:";
  const host     = args.host || DEFAULT_HOST;
  const port     = args.port ?? (secure ? DEFAULT_PORT_HTTPS : DEFAULT_PORT_HTTP);
  const database = args.database || DEFAULT_DATABASE;
  const username = args.username || DEFAULT_USERNAME;
  const password = args.password || "";
  const timeoutMs = clampTimeout(args.timeout);
  const rejectUnauthorized = args.reject_unauthorized !== false;

  guardNul(host,     "host");
  guardNul(database, "database");
  guardNul(username, "username");

  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`clickhouse_client: 'port' must be an integer 1–65535 (got ${port}).`);

  // Build auth headers (ClickHouse recommends header-based auth over URL params)
  const headers = {
    "X-ClickHouse-User":     username,
    "X-ClickHouse-Key":      password,
    "X-ClickHouse-Database": database,
    "User-Agent":             "mcp-clickhouse-client/1.0",
  };

  return { protocol, host, port, database, username, timeoutMs, rejectUnauthorized, headers };
}

// ── Execute a query via POST ──────────────────────────────────────────────────
async function executeQuery(cfg, sql, format) {
  const fmt = format || "JSONEachRow";
  // Append FORMAT clause only for SELECT-like statements
  // INSERT, CREATE, DROP, etc. don't need it
  const needsFormat = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH|FROM)/i.test(sql.trim());
  const fullSql = needsFormat ? `${sql.trimEnd()}\nFORMAT ${fmt}` : sql;

  const headers = {
    ...cfg.headers,
    "Content-Type": "text/plain; charset=utf-8",
  };

  const result = await httpRequest({
    protocol:          cfg.protocol,
    host:              cfg.host,
    port:              cfg.port,
    path:              "/",
    method:            "POST",
    headers,
    body:              fullSql,
    timeoutMs:         cfg.timeoutMs,
    rejectUnauthorized: cfg.rejectUnauthorized,
  });

  if (result.statusCode !== 200) {
    // ClickHouse error responses are plain text
    const errMsg = result.body.trim().slice(0, 500);
    throw new Error(`clickhouse_client: ClickHouse error (HTTP ${result.statusCode}): ${errMsg}`);
  }

  return { body: result.body, format: fmt };
}

// ── Parse JSONEachRow response ───────────────────────────────────────────────
function parseJSONEachRow(body) {
  const lines = body.split("\n").filter(l => l.trim());
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip non-JSON lines (e.g. progress lines)
    }
  }
  return rows;
}

// ── Parse ClickHouse JSON response ──────────────────────────────────────────
function parseJSON(body) {
  try {
    const parsed = JSON.parse(body);
    return {
      meta:        parsed.meta        || [],
      data:        parsed.data        || [],
      rows:        parsed.rows        ?? (parsed.data ? parsed.data.length : 0),
      rows_before_limit_at_least: parsed.rows_before_limit_at_least ?? null,
      statistics:  parsed.statistics  || null,
    };
  } catch (e) {
    throw new Error(`clickhouse_client: failed to parse JSON response: ${e.message}`);
  }
}

// ── Operations ────────────────────────────────────────────────────────────────

/** ping — GET /ping */
async function opPing(args) {
  const cfg = buildConfig(args);
  const t0 = Date.now();

  const result = await httpRequest({
    protocol:          cfg.protocol,
    host:              cfg.host,
    port:              cfg.port,
    path:              "/ping",
    method:            "GET",
    headers:           { "User-Agent": "mcp-clickhouse-client/1.0" },
    timeoutMs:         cfg.timeoutMs,
    rejectUnauthorized: cfg.rejectUnauthorized,
  });

  const latencyMs = Date.now() - t0;
  const ok = result.statusCode === 200 && result.body.trim() === "Ok.";

  return {
    ok,
    operation:  "ping",
    host:       cfg.host,
    port:       cfg.port,
    protocol:   cfg.protocol,
    statusCode: result.statusCode,
    response:   result.body.trim(),
    latencyMs,
  };
}

/** info — Return server version and settings */
async function opInfo(args) {
  const cfg = buildConfig(args);

  // Get version via SELECT version()
  const verResult = await executeQuery(cfg, "SELECT version() AS version, uptime() AS uptime_seconds, currentDatabase() AS current_database", "JSON");
  const parsed = parseJSON(verResult.body);
  const row = parsed.data[0] || {};

  return {
    ok:              true,
    operation:       "info",
    host:            cfg.host,
    port:            cfg.port,
    protocol:        cfg.protocol,
    database:        cfg.database,
    serverVersion:   row.version   || null,
    uptimeSeconds:   row.uptime_seconds !== undefined ? Number(row.uptime_seconds) : null,
    currentDatabase: row.current_database || cfg.database,
  };
}

/** query — Execute a SELECT / SHOW / DESCRIBE / EXPLAIN query */
async function opQuery(args) {
  if (!args.sql || typeof args.sql !== "string" || !args.sql.trim())
    throw new Error("clickhouse_client: 'sql' is required and must be a non-empty string.");

  const cfg    = buildConfig(args);
  const format = args.format || "JSONEachRow";

  if (!["JSONEachRow", "JSON", "CSV", "TSVWithNames", "TabSeparatedWithNames"].includes(format))
    throw new Error(`clickhouse_client: unsupported format '${format}'. Use JSONEachRow, JSON, CSV, or TSVWithNames.`);

  const t0 = Date.now();
  const { body } = await executeQuery(cfg, args.sql, format);
  const elapsedMs = Date.now() - t0;

  let rows = null;
  let meta = null;
  let rawBody = null;
  let statistics = null;

  if (format === "JSONEachRow") {
    rows = parseJSONEachRow(body);
  } else if (format === "JSON") {
    const parsed = parseJSON(body);
    rows       = parsed.data;
    meta       = parsed.meta;
    statistics = parsed.statistics;
  } else {
    // CSV / TSVWithNames — return raw
    rawBody = body;
  }

  // Apply max_rows cap
  const maxRows = args.max_rows ? Math.min(Math.max(1, Math.trunc(args.max_rows)), 100_000) : 10_000;
  let truncated = false;
  if (rows && rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    truncated = true;
  }

  return {
    ok:        true,
    operation: "query",
    sql:       args.sql,
    format,
    database:  cfg.database,
    elapsedMs,
    ...(rows !== null     ? { rows, rowCount: rows.length, truncated } : {}),
    ...(meta !== null     ? { meta } : {}),
    ...(statistics        ? { statistics } : {}),
    ...(rawBody !== null  ? { data: rawBody } : {}),
  };
}

/** insert — Insert rows into a table */
async function opInsert(args) {
  if (!args.table || typeof args.table !== "string" || !args.table.trim())
    throw new Error("clickhouse_client: 'table' is required for insert.");
  if (!Array.isArray(args.rows) || args.rows.length === 0)
    throw new Error("clickhouse_client: 'rows' must be a non-empty array of objects.");
  if (args.rows.length > MAX_INSERT_ROWS)
    throw new Error(`clickhouse_client: 'rows' array too large (${args.rows.length}; max ${MAX_INSERT_ROWS}).`);

  guardNul(args.table, "table");

  const cfg    = buildConfig(args);
  const format = args.format || "JSONEachRow";

  if (!["JSONEachRow", "CSV"].includes(format))
    throw new Error(`clickhouse_client: insert format must be 'JSONEachRow' or 'CSV'.`);

  let body;
  if (format === "JSONEachRow") {
    body = args.rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  } else {
    // CSV: first row provides headers if rows are objects
    if (typeof args.rows[0] !== "object" || Array.isArray(args.rows[0]))
      throw new Error("clickhouse_client: CSV insert requires rows to be plain objects.");
    const cols = Object.keys(args.rows[0]);
    const escape = (v) => {
      const s = String(v == null ? "" : v);
      if (s.includes(",") || s.includes('"') || s.includes("\n"))
        return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    body = [cols.join(","), ...args.rows.map(r => cols.map(c => escape(r[c])).join(","))].join("\n") + "\n";
  }

  const sql = `INSERT INTO ${args.table} FORMAT ${format}`;

  const headers = {
    ...cfg.headers,
    "Content-Type": "text/plain; charset=utf-8",
  };

  const t0 = Date.now();
  const result = await httpRequest({
    protocol:          cfg.protocol,
    host:              cfg.host,
    port:              cfg.port,
    path:              `/?query=${encodeURIComponent(sql)}`,
    method:            "POST",
    headers,
    body,
    timeoutMs:         cfg.timeoutMs,
    rejectUnauthorized: cfg.rejectUnauthorized,
  });
  const elapsedMs = Date.now() - t0;

  if (result.statusCode !== 200) {
    const errMsg = result.body.trim().slice(0, 500);
    throw new Error(`clickhouse_client: insert error (HTTP ${result.statusCode}): ${errMsg}`);
  }

  return {
    ok:        true,
    operation: "insert",
    table:     args.table,
    database:  cfg.database,
    format,
    inserted:  args.rows.length,
    elapsedMs,
  };
}

/** databases — SHOW DATABASES */
async function opDatabases(args) {
  const cfg = buildConfig(args);
  const { body } = await executeQuery(cfg, "SHOW DATABASES", "JSONEachRow");
  const rows = parseJSONEachRow(body);
  const databases = rows.map(r => r.name || r.database || Object.values(r)[0] || "").filter(Boolean);

  return {
    ok:        true,
    operation: "databases",
    host:      cfg.host,
    port:      cfg.port,
    databases,
    count:     databases.length,
  };
}

/** tables — SHOW TABLES [FROM database] */
async function opTables(args) {
  const cfg = buildConfig(args);
  const db  = args.database || cfg.database;
  guardNul(db, "database");

  const sql = db ? `SHOW TABLES FROM \`${db}\`` : "SHOW TABLES";
  const { body } = await executeQuery(cfg, sql, "JSONEachRow");
  const rows = parseJSONEachRow(body);
  const tables = rows.map(r => r.name || r.table || Object.values(r)[0] || "").filter(Boolean);

  return {
    ok:        true,
    operation: "tables",
    database:  db,
    tables,
    count:     tables.length,
  };
}

/** create_table — CREATE TABLE */
async function opCreateTable(args) {
  if (!args.table || typeof args.table !== "string" || !args.table.trim())
    throw new Error("clickhouse_client: 'table' is required for create_table.");
  if (!args.schema || typeof args.schema !== "string" || !args.schema.trim())
    throw new Error("clickhouse_client: 'schema' is required (column definitions, e.g. 'id UInt64, name String').");
  if (!args.engine || typeof args.engine !== "string" || !args.engine.trim())
    throw new Error("clickhouse_client: 'engine' is required (e.g. 'MergeTree() ORDER BY id').");

  guardNul(args.table,  "table");
  guardNul(args.schema, "schema");

  const cfg       = buildConfig(args);
  const ifNotExists = args.if_not_exists !== false ? "IF NOT EXISTS" : "";
  const db        = args.database || cfg.database;
  const tableRef  = db ? `\`${db}\`.\`${args.table}\`` : `\`${args.table}\``;

  const sql = `CREATE TABLE ${ifNotExists} ${tableRef} (${args.schema}) ENGINE = ${args.engine}`;

  await executeQuery(cfg, sql, null);

  return {
    ok:           true,
    operation:    "create_table",
    table:        args.table,
    database:     db,
    schema:       args.schema,
    engine:       args.engine,
    if_not_exists: args.if_not_exists !== false,
    sql,
  };
}

/** drop_table — DROP TABLE */
async function opDropTable(args) {
  if (!args.table || typeof args.table !== "string" || !args.table.trim())
    throw new Error("clickhouse_client: 'table' is required for drop_table.");

  guardNul(args.table, "table");

  const cfg      = buildConfig(args);
  const ifExists = args.if_exists !== false ? "IF EXISTS" : "";
  const db       = args.database || cfg.database;
  const tableRef = db ? `\`${db}\`.\`${args.table}\`` : `\`${args.table}\``;

  const sql = `DROP TABLE ${ifExists} ${tableRef}`;

  await executeQuery(cfg, sql, null);

  return {
    ok:        true,
    operation: "drop_table",
    table:     args.table,
    database:  db,
    if_exists: args.if_exists !== false,
    sql,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function clickhouseClient(args) {
  const op = args.operation;
  if (!op) throw new Error("clickhouse_client: 'operation' is required.");

  switch (op) {
    case "ping":         return opPing(args);
    case "info":         return opInfo(args);
    case "query":        return opQuery(args);
    case "insert":       return opInsert(args);
    case "databases":    return opDatabases(args);
    case "tables":       return opTables(args);
    case "create_table": return opCreateTable(args);
    case "drop_table":   return opDropTable(args);
    default:
      throw new Error(
        `clickhouse_client: unknown operation '${op}'. ` +
        `Valid: ping, info, query, insert, databases, tables, create_table, drop_table.`
      );
  }
}

module.exports = { clickhouseClient };
