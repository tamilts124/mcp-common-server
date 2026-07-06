"use strict";
// ── SQLITE CONNECTION TABLE: sqlite_create / sqlite_connect / sqlite_execute / sqlite_disconnect / sqlite_connections / sqlite_tables ──
// Backed by Node's built-in node:sqlite module (DatabaseSync, stable since Node
// 22.5) — no new npm dependency, consistent with this project's zero-dependency
// philosophy (Playwright remains the one existing exception, for browser automation).
//
// DatabaseSync is fully synchronous, unlike browserLaunch.js's async
// chromium.launch() — there is no launch-race window here, so (unlike
// browserLaunch.js's pendingLaunches counter) no pending-reservation counter
// is needed to keep MAX_CONNECTIONS accurate under concurrent calls.

const fs = require("fs");
const crypto = require("crypto");
const { ToolError } = require("./errors");
const { resolveClientPath, clientRelative } = require("./roots");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_) {
  DatabaseSync = null; // surfaced as a clear ToolError at call time, not at require time
}

function assertSqliteAvailable() {
  if (!DatabaseSync) {
    throw new ToolError(
      "node:sqlite is not available on this server's Node runtime (requires Node 22.5+; not present in Node 18/20 LTS). Check the server's Node version via env_info.",
      -32603
    );
  }
}

// connectionId -> { db, path, readOnly, createdAt, lastUsedAt }
const CONNECTIONS = new Map();
const MAX_CONNECTIONS = parseInt(process.env.MCP_MAX_SQLITE_CONNECTIONS, 10) || 8;

// Best-effort cleanup of open handles if the server exits (crash, SIGINT/SIGTERM)
// while connections are still open — same pattern as browserLaunch.js.
let exitHooked = false;
function hookExitCleanup() {
  if (exitHooked) return;
  exitHooked = true;
  const cleanup = () => {
    for (const [, e] of CONNECTIONS) {
      try { e.db.close(); } catch (_) { /* best effort */ }
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

function getConnection(connectionId) {
  const c = CONNECTIONS.get(connectionId);
  if (!c) throw new ToolError(`No sqlite connection with id: ${connectionId}`, -32602);
  return c;
}

// Small leading-keyword sniff (comments/whitespace stripped) used only to pick
// stmt.all() vs stmt.run() -- NOT a security boundary. Arbitrary SQL is always
// allowed through this tool (same trust tier as run_command); this purely
// decides which DatabaseSync statement method returns something useful.
function isRowReturningStatement(sql) {
  const stripped = String(sql)
    .replace(/^(\s*--[^\n]*\n)+/g, "")
    .replace(/^\s*\/\*[\s\S]*?\*\//, "")
    .trim();
  return /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(stripped);
}

// Resolves a client path the same jailed way every other file-touching tool
// does, but also accepts the special SQLite ':memory:' location verbatim
// (resolveClientPath would otherwise try to jail it as a relative path).
function resolveDbPath(clientPath) {
  if (clientPath === ":memory:") return { resolved: ":memory:", alias: null };
  const { resolved, alias } = resolveClientPath(clientPath);
  return { resolved, alias };
}

function createDatabase(args = {}) {
  assertSqliteAvailable();
  if (!args.path) throw new ToolError("sqlite_create requires a 'path' field.", -32602);
  const { resolved, alias } = resolveDbPath(args.path);

  let db;
  try {
    db = new DatabaseSync(resolved);
  } catch (e) {
    throw new ToolError(`sqlite_create failed to create database: ${e.message}`, -32603);
  }

  let schemaApplied = false;
  if (args.schema_sql !== undefined) {
    if (typeof args.schema_sql !== "string") {
      try { db.close(); } catch (_) { /* best effort */ }
      throw new ToolError("sqlite_create 'schema_sql' must be a string.", -32602);
    }
    try {
      db.exec(args.schema_sql);
      schemaApplied = true;
    } catch (e) {
      try { db.close(); } catch (_) { /* best effort */ }
      throw new ToolError(`sqlite_create: schema_sql failed: ${e.message}`, -32603);
    }
  }
  try { db.close(); } catch (_) { /* best effort */ }

  let sizeBytes = 0;
  if (resolved !== ":memory:") {
    try { sizeBytes = fs.statSync(resolved).size; } catch (_) { /* leave 0 */ }
  }

  return {
    path: resolved === ":memory:" ? ":memory:" : clientRelative(alias, resolved),
    sizeBytes,
    schemaApplied,
  };
}

function connect(args = {}) {
  assertSqliteAvailable();
  if (!args.path) throw new ToolError("sqlite_connect requires a 'path' field.", -32602);
  if (CONNECTIONS.size >= MAX_CONNECTIONS) {
    throw new ToolError(
      `Max concurrent sqlite connections (${MAX_CONNECTIONS}) reached. Disconnect an existing connection first.`,
      -32603
    );
  }
  const readOnly = args.read_only === true;
  const { resolved, alias } = resolveDbPath(args.path);

  if (readOnly && resolved !== ":memory:" && !fs.existsSync(resolved)) {
    throw new ToolError(`sqlite_connect: cannot open read_only — file does not exist: ${args.path}`, -32602);
  }

  let db;
  try {
    db = readOnly ? new DatabaseSync(resolved, { readOnly: true }) : new DatabaseSync(resolved);
  } catch (e) {
    throw new ToolError(`sqlite_connect failed: ${e.message}`, -32603);
  }

  hookExitCleanup();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const displayPath = resolved === ":memory:" ? ":memory:" : clientRelative(alias, resolved);
  CONNECTIONS.set(id, { db, path: displayPath, readOnly, createdAt: now, lastUsedAt: now });
  return { connection_id: id, path: displayPath, readOnly, createdAt: now };
}

function execute(args = {}) {
  if (!args.connection_id) throw new ToolError("sqlite_execute requires a 'connection_id' field.", -32602);
  if (!args.sql || typeof args.sql !== "string") throw new ToolError("sqlite_execute requires a non-empty string 'sql' field.", -32602);
  const entry = getConnection(args.connection_id);

  // node:sqlite's StatementSync.run()/.all() take positional (anonymous) bind
  // values as separate variadic arguments, not as a single array -- passing an
  // array as one argument makes the module treat it as a named-parameter bag
  // keyed by array index ('0', '1', ...), which fails with "Unknown named
  // parameter '0'". A plain object (named params) is still passed through as
  // a single argument, which is exactly the API's named-parameter form.
  const bind = (fn, params) => {
    if (params === undefined) return fn();
    if (Array.isArray(params)) return fn(...params);
    return fn(params);
  };

  const runOnce = (params) => {
    const stmt = entry.db.prepare(args.sql);
    if (isRowReturningStatement(args.sql)) {
      const rows = bind(stmt.all.bind(stmt), params);
      return { rows, rowCount: rows.length };
    }
    const info = bind(stmt.run.bind(stmt), params);
    return {
      changes: info.changes,
      lastInsertRowid: typeof info.lastInsertRowid === "bigint" ? info.lastInsertRowid.toString() : info.lastInsertRowid,
    };
  };

  entry.lastUsedAt = new Date().toISOString();

  if (args.params_list !== undefined) {
    if (!Array.isArray(args.params_list)) throw new ToolError("sqlite_execute 'params_list' must be an array.", -32602);
    const results = [];
    for (const params of args.params_list) {
      try {
        results.push({ status: "ok", result: runOnce(params) });
      } catch (e) {
        results.push({ status: "error", error: e.message });
      }
    }
    return {
      connection_id: args.connection_id,
      batch: true,
      count: results.length,
      succeeded: results.filter(r => r.status === "ok").length,
      failed: results.filter(r => r.status === "error").length,
      results,
    };
  }

  if (args.params !== undefined && (typeof args.params !== "object" || args.params === null)) {
    throw new ToolError("sqlite_execute 'params' must be an array (positional) or object (named).", -32602);
  }

  try {
    const result = runOnce(args.params);
    return { connection_id: args.connection_id, batch: false, ...result };
  } catch (e) {
    throw new ToolError(`sqlite_execute failed: ${e.message}`, -32603);
  }
}

function disconnect(args = {}) {
  if (!args.connection_id) throw new ToolError("sqlite_disconnect requires a 'connection_id' field.", -32602);
  const entry = getConnection(args.connection_id);
  try {
    entry.db.close();
  } catch (e) {
    console.error(`[SQLITE] Error closing connection ${args.connection_id}: ${e.message}`);
  }
  CONNECTIONS.delete(args.connection_id);
  return { connection_id: args.connection_id, status: "closed" };
}

function listConnections() {
  const list = [];
  for (const [id, e] of CONNECTIONS) {
    list.push({ connection_id: id, path: e.path, readOnly: e.readOnly, createdAt: e.createdAt, lastUsedAt: e.lastUsedAt });
  }
  return { connections: list, count: list.length };
}

// Minimal identifier quoting for the PRAGMA table_info(...) call below — table
// names come from sqlite_master itself (not directly from user input), but
// doubled-quote escaping still guards any table legitimately named with
// special characters.
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function listTables(args = {}) {
  if (!args.connection_id) throw new ToolError("sqlite_tables requires a 'connection_id' field.", -32602);
  const entry = getConnection(args.connection_id);
  const objects = entry.db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const tables = objects.map((o) => {
    const cols = entry.db.prepare(`PRAGMA table_info(${quoteIdent(o.name)})`).all();
    return {
      name: o.name,
      type: o.type,
      columns: cols.map((c) => ({
        name: c.name, type: c.type, notNull: !!c.notnull, pk: !!c.pk, defaultValue: c.dflt_value,
      })),
    };
  });
  return { connection_id: args.connection_id, tables, count: tables.length };
}

module.exports = {
  CONNECTIONS, getConnection,
  createDatabase, connect, execute, disconnect, listConnections, listTables,
};
