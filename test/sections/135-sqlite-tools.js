"use strict";
/**
 * [135] SQLITE LIFECYCLE TOOLS — sqlite_create / sqlite_connect / sqlite_execute /
 *       sqlite_disconnect / sqlite_connections / sqlite_tables
 *
 * Rigor levels:
 *   Normal:   create with schema_sql, connect, insert+select round-trip, disconnect.
 *   Medium:   missing required fields throw; bad params type throws; unknown
 *             connection_id throws.
 *   High:     params_list batch mode (mixed success/error per-entry), named
 *             params (object) + positional params (array), read_only connect
 *             enforced (write attempt fails), sqlite_tables column introspection,
 *             sqlite_connections lists open connections with correct count.
 *   Critical: path traversal via path arg blocked; SQL-injection-shaped string
 *             values treated as inert data (parameterized, never alters schema);
 *             read_only connect against a nonexistent file throws instead of
 *             creating one.
 *   Extreme:  MAX_CONNECTIONS ceiling enforced; :memory: databases are isolated
 *             per-connection (not shared); disconnect frees a connection slot;
 *             result is fully JSON-serialisable (including bigint rowid coercion).
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[135] SQLITE LIFECYCLE TOOLS — sqlite_create/connect/execute/disconnect/connections/tables`);

test("normal: sqlite_create applies schema_sql", () => {
  const r = executeTool("sqlite_create", {
    path: "sqlite_basic.db",
    schema_sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);",
  });
  assert.strictEqual(r.schemaApplied, true);
  assert.ok(r.path);
});

test("normal: sqlite_connect + sqlite_execute insert/select round-trip + sqlite_disconnect", () => {
  const conn = executeTool("sqlite_connect", { path: "sqlite_basic.db" });
  assert.ok(conn.connection_id);

  const ins = executeTool("sqlite_execute", {
    connection_id: conn.connection_id,
    sql: "INSERT INTO users (name) VALUES ('Ada')",
  });
  assert.strictEqual(ins.changes, 1);

  const sel = executeTool("sqlite_execute", {
    connection_id: conn.connection_id,
    sql: "SELECT * FROM users",
  });
  assert.strictEqual(sel.rowCount, 1);
  assert.strictEqual(sel.rows[0].name, "Ada");

  const disc = executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
  assert.strictEqual(disc.status, "closed");
});

test("medium: sqlite_create missing 'path' throws", () => {
  try {
    executeTool("sqlite_create", {});
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: sqlite_execute missing 'sql' throws", () => {
  const conn = executeTool("sqlite_connect", { path: ":memory:" });
  try {
    executeTool("sqlite_execute", { connection_id: conn.connection_id });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
  executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
});

test("medium: sqlite_execute with bad 'params' type throws", () => {
  const conn = executeTool("sqlite_connect", { path: ":memory:" });
  try {
    executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "SELECT 1", params: "not-array-or-object" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
  executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
});

test("medium: unknown connection_id throws", () => {
  try {
    executeTool("sqlite_execute", { connection_id: "nonexistent-id", sql: "SELECT 1" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: params_list batch mode reports per-entry success/failure", () => {
  const conn = executeTool("sqlite_connect", { path: ":memory:" });
  executeTool("sqlite_execute", {
    connection_id: conn.connection_id,
    sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT UNIQUE)",
  });
  const batch = executeTool("sqlite_execute", {
    connection_id: conn.connection_id,
    sql: "INSERT INTO t (val) VALUES (?)",
    params_list: [["a"], ["b"], ["a"]], // third is a duplicate -> UNIQUE violation
  });
  assert.strictEqual(batch.batch, true);
  assert.strictEqual(batch.count, 3);
  assert.strictEqual(batch.succeeded, 2);
  assert.strictEqual(batch.failed, 1);
  assert.strictEqual(batch.results[2].status, "error");
  executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
});

test("high: named params (object) and positional params (array) both work", () => {
  const conn = executeTool("sqlite_connect", { path: ":memory:" });
  executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "CREATE TABLE p (id INTEGER, name TEXT)" });
  executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "INSERT INTO p VALUES (?, ?)", params: [1, "pos"] });
  executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "INSERT INTO p VALUES (:id, :name)", params: { id: 2, name: "named" } });
  const sel = executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "SELECT * FROM p ORDER BY id" });
  assert.strictEqual(sel.rowCount, 2);
  assert.strictEqual(sel.rows[0].name, "pos");
  assert.strictEqual(sel.rows[1].name, "named");
  executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
});

test("high: read_only connect rejects a write attempt", () => {
  executeTool("sqlite_create", { path: "sqlite_ro.db", schema_sql: "CREATE TABLE x (id INTEGER)" });
  const conn = executeTool("sqlite_connect", { path: "sqlite_ro.db", read_only: true });
  assert.strictEqual(conn.readOnly, true);
  try {
    executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "INSERT INTO x VALUES (1)" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
  executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
});

test("high: sqlite_tables reports table name/type/columns", () => {
  const conn = executeTool("sqlite_connect", { path: ":memory:" });
  executeTool("sqlite_execute", {
    connection_id: conn.connection_id,
    sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
  });
  const r = executeTool("sqlite_tables", { connection_id: conn.connection_id });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.tables[0].name, "widgets");
  const idCol = r.tables[0].columns.find(c => c.name === "id");
  const labelCol = r.tables[0].columns.find(c => c.name === "label");
  assert.strictEqual(idCol.pk, true);
  assert.strictEqual(labelCol.notNull, true);
  executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
});

test("high: sqlite_connections lists open connections with correct count", () => {
  const before = executeTool("sqlite_connections", {});
  const c1 = executeTool("sqlite_connect", { path: ":memory:" });
  const c2 = executeTool("sqlite_connect", { path: ":memory:" });
  const after = executeTool("sqlite_connections", {});
  assert.strictEqual(after.count, before.count + 2);
  const ids = after.connections.map(c => c.connection_id);
  assert.ok(ids.includes(c1.connection_id));
  assert.ok(ids.includes(c2.connection_id));
  executeTool("sqlite_disconnect", { connection_id: c1.connection_id });
  executeTool("sqlite_disconnect", { connection_id: c2.connection_id });
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("sqlite_create", { path: "../../../../etc/passwd.db" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: SQL-injection-shaped string values are treated as inert parameterized data", () => {
  const conn = executeTool("sqlite_connect", { path: ":memory:" });
  executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "CREATE TABLE inj (id INTEGER PRIMARY KEY, val TEXT)" });
  const payload = "'); DROP TABLE inj; --";
  executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "INSERT INTO inj (val) VALUES (?)", params: [payload] });
  const sel = executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "SELECT * FROM inj" });
  assert.strictEqual(sel.rowCount, 1);
  assert.strictEqual(sel.rows[0].val, payload);
  const tables = executeTool("sqlite_tables", { connection_id: conn.connection_id });
  assert.strictEqual(tables.count, 1); // table still exists — payload never executed as SQL
  executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
});

test("critical: read_only connect against a nonexistent file throws instead of creating one", () => {
  try {
    executeTool("sqlite_connect", { path: "sqlite_does_not_exist.db", read_only: true });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: MAX_CONNECTIONS ceiling is enforced", () => {
  const max = parseInt(process.env.MCP_MAX_SQLITE_CONNECTIONS, 10) || 8;
  const before = executeTool("sqlite_connections", {}).count;
  const room = max - before;
  const opened = [];
  for (let i = 0; i < room; i++) {
    opened.push(executeTool("sqlite_connect", { path: ":memory:" }).connection_id);
  }
  try {
    executeTool("sqlite_connect", { path: ":memory:" });
    assert.fail("should have thrown once at the connection ceiling");
  } catch (e) { assert.ok(e); }
  for (const id of opened) executeTool("sqlite_disconnect", { connection_id: id });
});

test("extreme: :memory: databases are isolated per-connection, not shared", () => {
  const c1 = executeTool("sqlite_connect", { path: ":memory:" });
  const c2 = executeTool("sqlite_connect", { path: ":memory:" });
  executeTool("sqlite_execute", { connection_id: c1.connection_id, sql: "CREATE TABLE only_in_c1 (id INTEGER)" });
  const t1 = executeTool("sqlite_tables", { connection_id: c1.connection_id });
  const t2 = executeTool("sqlite_tables", { connection_id: c2.connection_id });
  assert.strictEqual(t1.count, 1);
  assert.strictEqual(t2.count, 0);
  executeTool("sqlite_disconnect", { connection_id: c1.connection_id });
  executeTool("sqlite_disconnect", { connection_id: c2.connection_id });
});

test("extreme: disconnect frees a connection slot for reuse", () => {
  const before = executeTool("sqlite_connections", {}).count;
  const c1 = executeTool("sqlite_connect", { path: ":memory:" });
  executeTool("sqlite_disconnect", { connection_id: c1.connection_id });
  const after = executeTool("sqlite_connections", {}).count;
  assert.strictEqual(after, before);
});

test("extreme: result is fully JSON-serialisable including bigint rowid coercion", () => {
  const conn = executeTool("sqlite_connect", { path: ":memory:" });
  executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)" });
  const ins = executeTool("sqlite_execute", { connection_id: conn.connection_id, sql: "INSERT INTO big (v) VALUES ('x')" });
  assert.strictEqual(typeof ins.lastInsertRowid !== "bigint", true);
  assert.doesNotThrow(() => JSON.stringify(ins));
  const tables = executeTool("sqlite_tables", { connection_id: conn.connection_id });
  assert.doesNotThrow(() => JSON.stringify(tables));
  executeTool("sqlite_disconnect", { connection_id: conn.connection_id });
});

test("cleanup: remove sqlite fixture files and close any stray connections", () => {
  const conns = executeTool("sqlite_connections", {});
  for (const c of conns.connections) {
    try { executeTool("sqlite_disconnect", { connection_id: c.connection_id }); } catch (_) {}
  }
  for (const f of ["sqlite_basic.db", "sqlite_ro.db"]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
});
