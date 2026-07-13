"use strict";
/**
 * Section 250 — clickhouse_client tests
 *
 * Rigor levels:
 *   A: Validation (schema/input guards)          × 10
 *   B: Unit / protocol (parsing, building)        × 20
 *   C: Mock-network (HTTP server stubs)           × 10
 *   D: Security (NUL-byte, injection, limits)     × 10
 *   E: Error-paths (network errors, bad SQL)      ×  6
 *
 * Total: 56 tests
 *
 * All network tests use real Node.js http servers on ephemeral ports;
 * no actual ClickHouse instance is required.
 */

const http = require("http");
const net  = require("net");

// ── Load module under test ───────────────────────────────────────────────────────
const { clickhouseClient } = require("../../lib/clickhouseClientOps");

// ── Minimal test harness ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    process.stderr.write(`  PASS  ${label}\n`);
  } else {
    failed++;
    failures.push(label);
    process.stderr.write(`  FAIL  ${label}\n`);
  }
}

async function assertRejects(fn, msgFragment, label) {
  try {
    await fn();
    failed++;
    failures.push(label);
    process.stderr.write(`  FAIL  ${label} (expected rejection, got resolution)\n`);
  } catch (e) {
    const ok = !msgFragment || e.message.includes(msgFragment);
    if (ok) {
      passed++;
      process.stderr.write(`  PASS  ${label}\n`);
    } else {
      failed++;
      failures.push(label);
      process.stderr.write(`  FAIL  ${label} (error was: ${e.message})\n`);
    }
  }
}

// ── HTTP mock server helper ──────────────────────────────────────────────────────
function makeMockServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", d => { body += d; });
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        requests,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// ── Common mock response bodies ─────────────────────────────────────────────────
const PING_RESPONSE = "Ok.\n";
const VERSION_JSON_RESPONSE = JSON.stringify({
  meta: [{name:"version"},{name:"uptime_seconds"},{name:"current_database"}],
  data: [{ version: "24.3.2.1", uptime_seconds: "3600", current_database: "default" }],
  rows: 1,
  statistics: { elapsed: 0.001, rows_read: 1, bytes_read: 10 },
});
const DATABASES_RESPONSE = [
  '{"name":"default"}',
  '{"name":"system"}',
  '{"name":"information_schema"}',
].join("\n") + "\n";
const TABLES_RESPONSE = [
  '{"name":"events"}',
  '{"name":"logs"}',
].join("\n") + "\n";
const QUERY_ROWS_RESPONSE = [
  '{"id":1,"name":"Alice","age":30}',
  '{"id":2,"name":"Bob","age":25}',
  '{"id":3,"name":"Carol","age":35}',
].join("\n") + "\n";

// ══════════════════════════════════════════════════════════════════════════════
// A — Validation tests (10)
// ══════════════════════════════════════════════════════════════════════════════
async function runSectionA() {
  process.stderr.write("\n── A: Validation ──\n");

  // A1: missing operation
  await assertRejects(
    () => clickhouseClient({}),
    "'operation' is required",
    "A1: missing operation"
  );

  // A2: unknown operation
  await assertRejects(
    () => clickhouseClient({ operation: "flush" }),
    "unknown operation",
    "A2: unknown operation 'flush'"
  );

  // A3: query with no sql
  await assertRejects(
    () => clickhouseClient({ operation: "query", host: "127.0.0.1", port: 9999 }),
    "'sql' is required",
    "A3: query without sql"
  );

  // A4: query with empty sql
  await assertRejects(
    () => clickhouseClient({ operation: "query", host: "127.0.0.1", port: 9999, sql: "   " }),
    "'sql' is required",
    "A4: query with blank sql"
  );

  // A5: insert with no table
  await assertRejects(
    () => clickhouseClient({ operation: "insert", host: "127.0.0.1", port: 9999, rows: [{a:1}] }),
    "'table' is required",
    "A5: insert without table"
  );

  // A6: insert with no rows
  await assertRejects(
    () => clickhouseClient({ operation: "insert", host: "127.0.0.1", port: 9999, table: "t", rows: [] }),
    "non-empty array",
    "A6: insert with empty rows array"
  );

  // A7: insert rows not an array
  await assertRejects(
    () => clickhouseClient({ operation: "insert", host: "127.0.0.1", port: 9999, table: "t", rows: "bad" }),
    "non-empty array",
    "A7: insert rows not an array"
  );

  // A8: create_table without table
  await assertRejects(
    () => clickhouseClient({ operation: "create_table", host: "127.0.0.1", port: 9999, schema: "id UInt64", engine: "Memory()" }),
    "'table' is required",
    "A8: create_table without table"
  );

  // A9: create_table without schema
  await assertRejects(
    () => clickhouseClient({ operation: "create_table", host: "127.0.0.1", port: 9999, table: "t", engine: "Memory()" }),
    "'schema' is required",
    "A9: create_table without schema"
  );

  // A10: create_table without engine
  await assertRejects(
    () => clickhouseClient({ operation: "create_table", host: "127.0.0.1", port: 9999, table: "t", schema: "id UInt64" }),
    "'engine' is required",
    "A10: create_table without engine"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// B — Unit / Protocol tests (20)
// ══════════════════════════════════════════════════════════════════════════════
async function runSectionB() {
  process.stderr.write("\n── B: Unit / Protocol ──\n");

  // B1–B5: ping operation
  const pingSrv = await makeMockServer((req, res) => {
    if (req.url === "/ping") {
      res.writeHead(200); res.end(PING_RESPONSE);
    } else {
      res.writeHead(404); res.end("Not Found");
    }
  });
  try {
    const r = await clickhouseClient({ operation: "ping", host: "127.0.0.1", port: pingSrv.port });
    assert(r.ok === true,               "B1: ping ok=true");
    assert(r.operation === "ping",       "B2: ping operation field");
    assert(r.response === "Ok.",         "B3: ping response body");
    assert(typeof r.latencyMs === "number" && r.latencyMs >= 0, "B4: ping latencyMs >= 0");
    assert(r.statusCode === 200,         "B5: ping statusCode=200");
  } finally { await pingSrv.close(); }

  // B6–B9: info operation
  const infoSrv = await makeMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(VERSION_JSON_RESPONSE);
  });
  try {
    const r = await clickhouseClient({ operation: "info", host: "127.0.0.1", port: infoSrv.port });
    assert(r.ok === true,                      "B6: info ok=true");
    assert(r.serverVersion === "24.3.2.1",     "B7: info serverVersion");
    assert(r.uptimeSeconds === 3600,           "B8: info uptimeSeconds");
    assert(r.currentDatabase === "default",    "B9: info currentDatabase");
  } finally { await infoSrv.close(); }

  // B10–B13: query JSONEachRow
  const querySrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(QUERY_ROWS_RESPONSE);
  });
  try {
    const r = await clickhouseClient({
      operation: "query",
      host: "127.0.0.1", port: querySrv.port,
      sql: "SELECT id, name, age FROM users LIMIT 3",
    });
    assert(r.ok === true,              "B10: query ok=true");
    assert(r.rowCount === 3,           "B11: query rowCount=3");
    assert(r.rows[0].name === "Alice", "B12: query first row name=Alice");
    assert(r.format === "JSONEachRow",  "B13: query default format=JSONEachRow");
  } finally { await querySrv.close(); }

  // B14–B16: databases operation
  const dbSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(DATABASES_RESPONSE);
  });
  try {
    const r = await clickhouseClient({ operation: "databases", host: "127.0.0.1", port: dbSrv.port });
    assert(r.ok === true,                             "B14: databases ok=true");
    assert(r.databases.includes("default"),           "B15: databases includes 'default'");
    assert(r.databases.includes("system"),            "B16: databases includes 'system'");
  } finally { await dbSrv.close(); }

  // B17–B18: tables operation
  const tblSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(TABLES_RESPONSE);
  });
  try {
    const r = await clickhouseClient({ operation: "tables", host: "127.0.0.1", port: tblSrv.port, database: "mydb" });
    assert(r.ok === true,                  "B17: tables ok=true");
    assert(r.tables.includes("events"),    "B18: tables includes 'events'");
  } finally { await tblSrv.close(); }

  // B19–B20: insert operation
  const insertSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end("");
  });
  try {
    const r = await clickhouseClient({
      operation: "insert",
      host: "127.0.0.1", port: insertSrv.port,
      table: "events",
      rows: [{ id: 1, name: "test" }, { id: 2, name: "test2" }],
    });
    assert(r.ok === true,        "B19: insert ok=true");
    assert(r.inserted === 2,     "B20: insert inserted=2");
  } finally { await insertSrv.close(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// C — Mock-Network tests (10)
// ══════════════════════════════════════════════════════════════════════════════
async function runSectionC() {
  process.stderr.write("\n── C: Mock-Network ──\n");

  // C1: Auth headers sent correctly
  const authSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(PING_RESPONSE);
  });
  try {
    await clickhouseClient({ operation: "ping", host: "127.0.0.1", port: authSrv.port });
    // No auth headers on ping (intentional)
    assert(authSrv.requests.length === 1, "C1: ping made exactly one request");
  } finally { await authSrv.close(); }

  // C2: query sends X-ClickHouse-User / X-ClickHouse-Key headers
  const hdSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(QUERY_ROWS_RESPONSE);
  });
  try {
    await clickhouseClient({
      operation: "query",
      host: "127.0.0.1", port: hdSrv.port,
      username: "myuser", password: "mypass",
      sql: "SELECT 1",
    });
    const req = hdSrv.requests[0];
    assert(req.headers["x-clickhouse-user"] === "myuser", "C2: X-ClickHouse-User header sent");
    assert(req.headers["x-clickhouse-key"]  === "mypass", "C2b: X-ClickHouse-Key header sent");
  } finally { await hdSrv.close(); }

  // C3: query SQL body is the actual SQL (with FORMAT appended)
  let capturedBody = "";
  const sqlSrv = await makeMockServer((req, res, body) => {
    capturedBody = body;
    res.writeHead(200); res.end(QUERY_ROWS_RESPONSE);
  });
  try {
    await clickhouseClient({
      operation: "query",
      host: "127.0.0.1", port: sqlSrv.port,
      sql: "SELECT 1 AS x",
    });
    assert(capturedBody.includes("SELECT 1 AS x"), "C3: SQL body contains original query");
    assert(capturedBody.includes("FORMAT JSONEachRow"), "C3b: FORMAT JSONEachRow appended");
  } finally { await sqlSrv.close(); }

  // C4: JSON format parsing returns meta + statistics
  const jsonSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(VERSION_JSON_RESPONSE);
  });
  try {
    const r = await clickhouseClient({
      operation: "query",
      host: "127.0.0.1", port: jsonSrv.port,
      sql: "SELECT version() AS version, uptime() AS uptime_seconds, currentDatabase() AS current_database",
      format: "JSON",
    });
    assert(r.format === "JSON",                   "C4: format=JSON");
    assert(Array.isArray(r.meta),                 "C4b: meta is array");
    assert(r.statistics !== null,                 "C4c: statistics present");
  } finally { await jsonSrv.close(); }

  // C5: max_rows cap truncates result
  const bigSrv = await makeMockServer((req, res) => {
    const rows = Array.from({ length: 20 }, (_, i) => `{"id":${i}}`).join("\n") + "\n";
    res.writeHead(200); res.end(rows);
  });
  try {
    const r = await clickhouseClient({
      operation: "query",
      host: "127.0.0.1", port: bigSrv.port,
      sql: "SELECT id FROM big LIMIT 20",
      max_rows: 5,
    });
    assert(r.rowCount === 5,   "C5: max_rows=5 caps result");
    assert(r.truncated === true, "C5b: truncated=true when capped");
  } finally { await bigSrv.close(); }

  // C6: insert sends rows as JSONEachRow body
  let insertBody = "";
  const insSrv = await makeMockServer((req, res, body) => {
    insertBody = body;
    res.writeHead(200); res.end("");
  });
  try {
    await clickhouseClient({
      operation: "insert",
      host: "127.0.0.1", port: insSrv.port,
      table: "events",
      rows: [{ id: 1, val: "a" }, { id: 2, val: "b" }],
    });
    assert(insertBody.includes('"id":1'), "C6: insert body contains row 1");
    assert(insertBody.includes('"id":2'), "C6b: insert body contains row 2");
  } finally { await insSrv.close(); }

  // C7: create_table sends correct SQL
  let ddlBody = "";
  const ddlSrv = await makeMockServer((req, res, body) => {
    ddlBody = body;
    res.writeHead(200); res.end("");
  });
  try {
    await clickhouseClient({
      operation: "create_table",
      host: "127.0.0.1", port: ddlSrv.port,
      table: "test_tbl",
      schema: "id UInt64, name String",
      engine: "MergeTree() ORDER BY id",
    });
    assert(ddlBody.includes("CREATE TABLE"),       "C7: DDL contains CREATE TABLE");
    assert(ddlBody.includes("test_tbl"),            "C7b: DDL contains table name");
    assert(ddlBody.includes("MergeTree()"),         "C7c: DDL contains engine");
  } finally { await ddlSrv.close(); }

  // C8: drop_table sends correct SQL
  let dropBody = "";
  const dropSrv = await makeMockServer((req, res, body) => {
    dropBody = body;
    res.writeHead(200); res.end("");
  });
  try {
    await clickhouseClient({
      operation: "drop_table",
      host: "127.0.0.1", port: dropSrv.port,
      table: "old_tbl",
    });
    assert(dropBody.includes("DROP TABLE"),  "C8: drop SQL contains DROP TABLE");
    assert(dropBody.includes("old_tbl"),     "C8b: drop SQL contains table name");
    assert(dropBody.includes("IF EXISTS"),   "C8c: drop SQL has IF EXISTS by default");
  } finally { await dropSrv.close(); }

  // C9: database header sent with query
  const dbHdrSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end('{"id":1}\n');
  });
  try {
    await clickhouseClient({
      operation: "query",
      host: "127.0.0.1", port: dbHdrSrv.port,
      database: "analytics",
      sql: "SELECT 1",
    });
    const req = dbHdrSrv.requests[0];
    assert(req.headers["x-clickhouse-database"] === "analytics", "C9: X-ClickHouse-Database header");
  } finally { await dbHdrSrv.close(); }

  // C10: ping returns latency as number
  const latSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(PING_RESPONSE);
  });
  try {
    const r = await clickhouseClient({ operation: "ping", host: "127.0.0.1", port: latSrv.port });
    assert(typeof r.latencyMs === "number", "C10: latencyMs is a number");
    assert(r.latencyMs >= 0,               "C10b: latencyMs non-negative");
  } finally { await latSrv.close(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// D — Security tests (10)
// ══════════════════════════════════════════════════════════════════════════════
async function runSectionD() {
  process.stderr.write("\n── D: Security ──\n");

  // D1: NUL byte in host
  await assertRejects(
    () => clickhouseClient({ operation: "ping", host: "host\0evil" }),
    "NUL bytes",
    "D1: NUL byte in host rejected"
  );

  // D2: NUL byte in database
  await assertRejects(
    () => clickhouseClient({ operation: "databases", host: "127.0.0.1", port: 9999, database: "db\0evil" }),
    "NUL bytes",
    "D2: NUL byte in database rejected"
  );

  // D3: NUL byte in username
  await assertRejects(
    () => clickhouseClient({ operation: "ping", host: "127.0.0.1", port: 9999, username: "user\0evil" }),
    "NUL bytes",
    "D3: NUL byte in username rejected"
  );

  // D4: NUL byte in table name (insert)
  await assertRejects(
    () => clickhouseClient({ operation: "insert", host: "127.0.0.1", port: 9999, table: "t\0bad", rows: [{a:1}] }),
    "NUL bytes",
    "D4: NUL byte in table name rejected"
  );

  // D5: insert rows over limit
  await assertRejects(
    () => clickhouseClient({
      operation: "insert", host: "127.0.0.1", port: 9999,
      table: "t",
      rows: Array.from({ length: 100_001 }, (_, i) => ({ id: i })),
    }),
    "too large",
    "D5: insert over 100k rows rejected"
  );

  // D6: unsupported query format
  await assertRejects(
    () => clickhouseClient({ operation: "query", host: "127.0.0.1", port: 9999, sql: "SELECT 1", format: "XML" }),
    "unsupported format",
    "D6: unsupported query format rejected"
  );

  // D7: insert unsupported format
  await assertRejects(
    () => clickhouseClient({ operation: "insert", host: "127.0.0.1", port: 9999, table: "t", rows: [{a:1}], format: "JSON" }),
    "insert format must be",
    "D7: insert with unsupported format rejected"
  );

  // D8: timeout clamped to minimum
  const clampSrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(PING_RESPONSE);
  });
  try {
    const r = await clickhouseClient({ operation: "ping", host: "127.0.0.1", port: clampSrv.port, timeout: 1 });
    assert(r.ok === true, "D8: below-min timeout clamped (still succeeds)");
  } finally { await clampSrv.close(); }

  // D9: timeout clamped to maximum (won't test 300s, just verify no error thrown for huge value)
  const clampSrv2 = await makeMockServer((req, res) => {
    res.writeHead(200); res.end(PING_RESPONSE);
  });
  try {
    const r = await clickhouseClient({ operation: "ping", host: "127.0.0.1", port: clampSrv2.port, timeout: 999_999_999 });
    assert(r.ok === true, "D9: above-max timeout clamped (still succeeds)");
  } finally { await clampSrv2.close(); }

  // D10: ClickHouse HTTP error (non-200) is surfaced as error
  const errSrv = await makeMockServer((req, res) => {
    res.writeHead(400); res.end("Code: 62. Syntax error.");
  });
  try {
    await assertRejects(
      () => clickhouseClient({ operation: "query", host: "127.0.0.1", port: errSrv.port, sql: "SELECT bad!!" }),
      "Syntax error",
      "D10: ClickHouse 400 error surfaced with message"
    );
  } finally { await errSrv.close(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// E — Error-path tests (6)
// ══════════════════════════════════════════════════════════════════════════════
async function runSectionE() {
  process.stderr.write("\n── E: Error-Paths ──\n");

  // E1: connection refused (nothing listening on port)
  await assertRejects(
    () => clickhouseClient({ operation: "ping", host: "127.0.0.1", port: 19999, timeout: 3000 }),
    "clickhouse_client",
    "E1: connection refused surfaced as clickhouse_client error"
  );

  // E2: host not found
  await assertRejects(
    () => clickhouseClient({ operation: "ping", host: "host.that.definitely.does.not.exist.invalid", port: 8123, timeout: 3000 }),
    "clickhouse_client",
    "E2: host not found surfaced as clickhouse_client error"
  );

  // E3: insert 500 error
  const errInsSrv = await makeMockServer((req, res) => {
    res.writeHead(500); res.end("Internal error");
  });
  try {
    await assertRejects(
      () => clickhouseClient({
        operation: "insert",
        host: "127.0.0.1", port: errInsSrv.port,
        table: "t",
        rows: [{ id: 1 }],
      }),
      "insert error",
      "E3: insert HTTP 500 throws clickhouse_client error"
    );
  } finally { await errInsSrv.close(); }

  // E4: create_table error
  const errDdlSrv = await makeMockServer((req, res) => {
    res.writeHead(400); res.end("Table already exists.");
  });
  try {
    await assertRejects(
      () => clickhouseClient({
        operation: "create_table",
        host: "127.0.0.1", port: errDdlSrv.port,
        table: "t", schema: "id UInt64", engine: "Memory()",
        if_not_exists: false,
      }),
      "ClickHouse error",
      "E4: create_table error surfaced"
    );
  } finally { await errDdlSrv.close(); }

  // E5: query result is empty (no rows)
  const emptySrv = await makeMockServer((req, res) => {
    res.writeHead(200); res.end("");
  });
  try {
    const r = await clickhouseClient({
      operation: "query",
      host: "127.0.0.1", port: emptySrv.port,
      sql: "SELECT 1 WHERE 0=1",
    });
    assert(r.ok === true,   "E5: empty result ok=true");
    assert(r.rowCount === 0, "E5b: empty result rowCount=0");
  } finally { await emptySrv.close(); }

  // E6: tables operation — SHOW TABLES FROM sends correct SQL
  let tablesSql = "";
  const tblErrSrv = await makeMockServer((req, res, body) => {
    tablesSql = body;
    res.writeHead(200); res.end(TABLES_RESPONSE);
  });
  try {
    const r = await clickhouseClient({
      operation: "tables",
      host: "127.0.0.1", port: tblErrSrv.port,
      database: "system",
    });
    assert(tablesSql.includes("SHOW TABLES"),  "E6: tables sends SHOW TABLES SQL");
    assert(tablesSql.includes("`system`"),      "E6b: tables SQL includes database name");
    assert(r.database === "system",             "E6c: result database field set correctly");
  } finally { await tblErrSrv.close(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// Main runner
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  process.stderr.write("\n=== Section 250: clickhouse_client tests ===\n");

  await runSectionA();
  await runSectionB();
  await runSectionC();
  await runSectionD();
  await runSectionE();

  process.stderr.write(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failures.length) {
    process.stderr.write(`Failed:\n${failures.map(f => `  - ${f}`).join("\n")}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.stack}\n`);
  process.exit(2);
});
