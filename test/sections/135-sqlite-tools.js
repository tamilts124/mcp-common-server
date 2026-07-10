"use strict";
// ── 135: sqlite_create / sqlite_connect / sqlite_execute / sqlite_disconnect / sqlite_connections / sqlite_tables ──
// Tests for the full SQLite lifecycle tool family.
// Runs isolated — no live MCP server needed.
// Covers all 5 rigor levels: Normal / Medium / High / Critical / Extreme.

const path = require("path");
const fs = require("fs");

const { test, assert, TMP, CONNECTIONS } = require("../test-harness");
// Re-require sqliteOps AFTER test-harness has set MCP_ROOTS / MCP_ALLOW_EXEC.
const sqliteOps = require("../../lib/sqliteOps");

console.log("\n[135] sqlite_create / sqlite_connect / sqlite_execute / sqlite_disconnect / sqlite_connections / sqlite_tables");

// ─── helpers ────────────────────────────────────────────────────────────────
let _dbIdx = 0;
function mkDb(name) {
  return path.join(TMP, `sqlite_${_dbIdx++}_${name}.db`);
}

// Disconnect all open connections (clean up between test groups)
function disconnectAll() {
  for (const [id] of sqliteOps.CONNECTIONS) {
    try { sqliteOps.disconnect({ connection_id: id }); } catch (_) {}
  }
}

// ─── LEVEL 1: NORMAL (happy-path) ───────────────────────────────────────────

test("[Normal] sqlite_create: create new DB file", () => {
  const dbPath = mkDb("create");
  const r = sqliteOps.createDatabase({ path: dbPath });
  assert.ok(r.path, "has path");
  assert.strictEqual(r.schemaApplied, false, "schemaApplied false when no schema_sql");
  assert.strictEqual(typeof r.sizeBytes, "number", "sizeBytes is number");
  assert.ok(fs.existsSync(dbPath), "file exists on disk");
});

test("[Normal] sqlite_create: create with schema_sql", () => {
  const dbPath = mkDb("create_schema");
  const r = sqliteOps.createDatabase({ path: dbPath, schema_sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT);" });
  assert.strictEqual(r.schemaApplied, true, "schemaApplied true");
});

test("[Normal] sqlite_create: in-memory DB (:memory:)", () => {
  const r = sqliteOps.createDatabase({ path: ":memory:" });
  assert.strictEqual(r.path, ":memory:", "path is :memory:");
  assert.strictEqual(r.sizeBytes, 0, "size 0 for memory");
});

test("[Normal] sqlite_connect + sqlite_disconnect lifecycle", () => {
  const dbPath = mkDb("lifecycle");
  sqliteOps.createDatabase({ path: dbPath });
  const c = sqliteOps.connect({ path: dbPath });
  assert.ok(typeof c.connection_id === "string" && c.connection_id.length > 0, "got connection_id");
  assert.strictEqual(c.readOnly, false, "not read-only by default");
  const d = sqliteOps.disconnect({ connection_id: c.connection_id });
  assert.strictEqual(d.status, "closed", "disconnected ok");
});

test("[Normal] sqlite_connect :memory: and execute SELECT", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT 1+1 AS result" });
  assert.strictEqual(r.rows[0].result, 2, "SELECT 1+1 = 2");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Normal] sqlite_execute: INSERT then SELECT", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)" });
  const ins = sqliteOps.execute({ connection_id: c.connection_id, sql: "INSERT INTO items (name) VALUES ('hello')", params: [] });
  assert.strictEqual(ins.changes, 1, "1 row inserted");
  assert.ok(typeof ins.lastInsertRowid !== "undefined", "lastInsertRowid present");
  const sel = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT * FROM items" });
  assert.strictEqual(sel.rows.length, 1);
  assert.strictEqual(sel.rows[0].name, "hello");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Normal] sqlite_execute: named params", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE t (val TEXT)" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "INSERT INTO t VALUES ($v)", params: { $v: "world" } });
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT val FROM t" });
  assert.strictEqual(r.rows[0].val, "world", "named param inserted correctly");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Normal] sqlite_execute: batch via params_list", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE nums (n INTEGER)" });
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "INSERT INTO nums (n) VALUES (?)", params_list: [[1],[2],[3]] });
  assert.strictEqual(r.batch, true, "batch flag");
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.succeeded, 3);
  const sel = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT COUNT(*) AS cnt FROM nums" });
  assert.strictEqual(sel.rows[0].cnt, 3, "3 rows in table");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Normal] sqlite_connections: lists open connections", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  const r = sqliteOps.listConnections();
  const found = r.connections.find(x => x.connection_id === c.connection_id);
  assert.ok(found, "new connection in list");
  assert.ok(r.count >= 1, "count >= 1");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Normal] sqlite_tables: lists tables and columns", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)" });
  const r = sqliteOps.listTables({ connection_id: c.connection_id });
  assert.strictEqual(r.count, 1, "1 table");
  assert.strictEqual(r.tables[0].name, "people", "table name correct");
  assert.strictEqual(r.tables[0].columns.length, 2, "2 columns");
  const nameCol = r.tables[0].columns.find(col => col.name === "name");
  assert.ok(nameCol && nameCol.notNull === true, "name column NOT NULL");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Normal] sqlite_execute: PRAGMA returns rows", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "PRAGMA journal_mode" });
  assert.ok(r.rows && r.rows.length > 0, "PRAGMA returns rows");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

// ─── LEVEL 2: MEDIUM (boundary & param validation) ────────────────────────

test("[Medium] sqlite_create: missing path throws -32602", () => {
  assert.throws(() => sqliteOps.createDatabase({}), /path/);
});

test("[Medium] sqlite_create: schema_sql not a string throws", () => {
  const dbPath = mkDb("bad_schema");
  assert.throws(() => sqliteOps.createDatabase({ path: dbPath, schema_sql: 42 }));
});

test("[Medium] sqlite_connect: missing path throws -32602", () => {
  assert.throws(() => sqliteOps.connect({}), /path/);
});

test("[Medium] sqlite_execute: missing connection_id throws -32602", () => {
  assert.throws(() => sqliteOps.execute({ sql: "SELECT 1" }), /connection_id/);
});

test("[Medium] sqlite_execute: missing sql throws", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  try {
    assert.throws(() => sqliteOps.execute({ connection_id: c.connection_id }), /sql/);
  } finally {
    sqliteOps.disconnect({ connection_id: c.connection_id });
  }
});

test("[Medium] sqlite_execute: params_list must be array", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  try {
    assert.throws(() => sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT 1", params_list: "bad" }));
  } finally {
    sqliteOps.disconnect({ connection_id: c.connection_id });
  }
});

test("[Medium] sqlite_execute: params must be array or object", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  try {
    assert.throws(() => sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT ?", params: 999 }));
  } finally {
    sqliteOps.disconnect({ connection_id: c.connection_id });
  }
});

test("[Medium] sqlite_disconnect: missing connection_id throws", () => {
  assert.throws(() => sqliteOps.disconnect({}), /connection_id/);
});

test("[Medium] sqlite_tables: missing connection_id throws", () => {
  assert.throws(() => sqliteOps.listTables({}), /connection_id/);
});

test("[Medium] sqlite_connect: read_only on nonexistent file throws", () => {
  assert.throws(() => sqliteOps.connect({ path: mkDb("does_not_exist_ever"), read_only: true }));
});

// ─── LEVEL 3: HIGH (dependency failure / mocking) ─────────────────────────

test("[High] sqlite_execute: unknown connection_id throws -32602", () => {
  assert.throws(() => sqliteOps.execute({ connection_id: "no-such-id", sql: "SELECT 1" }), /no sqlite connection/i);
});

test("[High] sqlite_disconnect: unknown connection_id throws -32602", () => {
  assert.throws(() => sqliteOps.disconnect({ connection_id: "no-such-id" }), /no sqlite connection/i);
});

test("[High] sqlite_tables: unknown connection_id throws -32602", () => {
  assert.throws(() => sqliteOps.listTables({ connection_id: "no-such-id" }), /no sqlite connection/i);
});

test("[High] sqlite_execute: SQL error in single mode throws", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  try {
    assert.throws(() => sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT * FROM no_such_table" }));
  } finally {
    sqliteOps.disconnect({ connection_id: c.connection_id });
  }
});

test("[High] sqlite_execute: SQL error in batch mode -> per-item error, not throw", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT * FROM nonexistent", params_list: [[]] });
  assert.strictEqual(r.batch, true, "batch mode");
  assert.strictEqual(r.failed, 1, "one failure");
  assert.strictEqual(r.results[0].status, "error", "error status");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[High] sqlite_connect read_only: SELECT ok, INSERT throws", () => {
  const dbPath = mkDb("readonly_test");
  sqliteOps.createDatabase({ path: dbPath, schema_sql: "CREATE TABLE t (v TEXT)" });
  const c = sqliteOps.connect({ path: dbPath, read_only: true });
  assert.strictEqual(c.readOnly, true, "read_only flag set");
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT 1" });
  assert.ok(r.rows, "SELECT works on read-only");
  try {
    assert.throws(() => sqliteOps.execute({ connection_id: c.connection_id, sql: "INSERT INTO t VALUES ('x')" }));
  } finally {
    sqliteOps.disconnect({ connection_id: c.connection_id });
  }
});

test("[High] sqlite_create: invalid SQL in schema_sql throws", () => {
  const dbPath = mkDb("bad_schema_sql");
  assert.throws(() => sqliteOps.createDatabase({ path: dbPath, schema_sql: "THIS IS NOT VALID SQL!!!" }));
});

test("[High] sqlite_execute: positional params via array", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE t (a INTEGER, b TEXT)" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "INSERT INTO t VALUES (?, ?)", params: [42, "abc"] });
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT * FROM t" });
  assert.strictEqual(r.rows[0].a, 42);
  assert.strictEqual(r.rows[0].b, "abc");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[High] sqlite_tables: views included", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  // Use separate execute calls — prepare() handles one statement at a time.
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE base (x INTEGER)" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE VIEW v AS SELECT x FROM base" });
  const r = sqliteOps.listTables({ connection_id: c.connection_id });
  const types = r.tables.map(t => t.type);
  assert.ok(types.includes("view"), "views in results");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[High] sqlite_connections: after disconnect, connection removed", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.disconnect({ connection_id: c.connection_id });
  const r = sqliteOps.listConnections();
  const found = r.connections.find(x => x.connection_id === c.connection_id);
  assert.ok(!found, "disconnected connection not in list");
});

// ─── LEVEL 4: CRITICAL (security / input sanitisation) ────────────────────

test("[Critical] sqlite_create: path traversal rejected", () => {
  // resolveClientPath should block ../ escapes outside MCP_ROOTS jail.
  assert.throws(() => sqliteOps.createDatabase({ path: "../evil" }));
});

test("[Critical] sqlite_connect: path traversal rejected", () => {
  assert.throws(() => sqliteOps.connect({ path: "../../etc/passwd" }));
});

test("[Critical] sqlite_execute: SQL injection payload does not crash server", () => {
  // sqlite_execute is EXEC_TOOLS tier — arbitrary SQL is allowed through.
  // This test verifies the server doesn't crash on a malicious-shaped payload.
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE u (email TEXT)" });
  try {
    sqliteOps.execute({
      connection_id: c.connection_id,
      sql: "INSERT INTO u VALUES ('x'); DROP TABLE u; --'",
    });
  } catch (_) { /* may throw for multi-statement, that's fine */ }
  // Connection must remain functional.
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "PRAGMA journal_mode" });
  assert.ok(r.rows, "connection still functional after injection attempt");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Critical] sqlite_execute: shell-injection in SQL param is inert", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE t (v TEXT)" });
  sqliteOps.execute({
    connection_id: c.connection_id,
    sql: "INSERT INTO t VALUES (?)",
    params: ["$(rm -rf /)"],
  });
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT v FROM t" });
  assert.strictEqual(r.rows[0].v, "$(rm -rf /)", "shell payload stored as literal string");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Critical] result is JSON-serialisable (no BigInt bleed)", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" });
  const ins = sqliteOps.execute({ connection_id: c.connection_id, sql: "INSERT INTO t DEFAULT VALUES" });
  const serialised = JSON.stringify(ins); // throws if BigInt not coerced
  assert.ok(serialised.length > 0, "JSON.stringify does not throw");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Critical] sqlite_tables: table name with special chars handled safely", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: 'CREATE TABLE "table \"\"quoted\"\" name" (x TEXT)' });
  const r = sqliteOps.listTables({ connection_id: c.connection_id });
  assert.strictEqual(r.count, 1, "table with quoted name listed");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

// ─── LEVEL 5: EXTREME (fuzz / concurrency / stress) ──────────────────────

test("[Extreme] 100 rows bulk inserted and read back", () => {
  // Close any leftover connections before stress tests so we don't hit MAX_CONNECTIONS.
  disconnectAll();
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE bulk (n INTEGER)" });
  const paramsList = Array.from({ length: 100 }, (_, i) => [i]);
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "INSERT INTO bulk VALUES (?)", params_list: paramsList });
  assert.strictEqual(r.succeeded, 100, "100 batch inserts succeeded");
  const sel = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT COUNT(*) AS cnt FROM bulk" });
  assert.strictEqual(sel.rows[0].cnt, 100, "100 rows in table");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Extreme] very long SQL string does not crash", () => {
  const c = sqliteOps.connect({ path: ":memory:" });
  const longSql = "SELECT " + Array.from({ length: 500 }, (_, i) => `${i} AS c${i}`).join(", ");
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: longSql });
  assert.ok(r.rows && r.rows.length === 1, "long SELECT returns a row");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});

test("[Extreme] fuzz: random-bytes connection_id does not crash", () => {
  const fuzz = Buffer.from(Array.from({ length: 50 }, () => Math.floor(Math.random() * 256))).toString("base64");
  assert.throws(() => sqliteOps.execute({ connection_id: fuzz, sql: "SELECT 1" }));
});

test("[Extreme] 8 concurrent connections (at MAX_CONNECTIONS limit)", () => {
  disconnectAll();
  const conns = [];
  for (let i = 0; i < 8; i++) {
    conns.push(sqliteOps.connect({ path: ":memory:" }));
  }
  assert.strictEqual(conns.length, 8, "8 connections open");
  const r = sqliteOps.listConnections();
  const ids = new Set(r.connections.map(c => c.connection_id));
  for (const c of conns) {
    assert.ok(ids.has(c.connection_id), `connection ${c.connection_id} in list`);
    sqliteOps.disconnect({ connection_id: c.connection_id });
  }
});

test("[Extreme] write 5000 rows and verify", () => {
  disconnectAll();
  const c = sqliteOps.connect({ path: ":memory:" });
  sqliteOps.execute({ connection_id: c.connection_id, sql: "CREATE TABLE stress (v TEXT)" });
  const paramsList = Array.from({ length: 5000 }, (_, i) => [`row${i}`]);
  const r = sqliteOps.execute({ connection_id: c.connection_id, sql: "INSERT INTO stress VALUES (?)", params_list: paramsList });
  assert.strictEqual(r.succeeded, 5000, "5000 rows inserted");
  const cnt = sqliteOps.execute({ connection_id: c.connection_id, sql: "SELECT COUNT(*) AS n FROM stress" });
  assert.strictEqual(cnt.rows[0].n, 5000, "5000 rows verified");
  sqliteOps.disconnect({ connection_id: c.connection_id });
});
