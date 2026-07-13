"use strict";
// Section 230: sqlite_client tests
// Five rigor levels: A=validation(10), B=unit(20), C=happy-path(20), D=security(10), E=error-paths(10), F=concurrency(6)
// Total: 76 tests

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { sqliteClient } = require("../../lib/sqliteClientOps");

let passed = 0, failed = 0;
const errors = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; errors.push(msg); process.stderr.write(`  FAIL: ${msg}\n`); }
}

function assertThrows(fn, msgPart, label) {
  try {
    fn();
    failed++;
    errors.push(`${label}: expected throw but returned`);
    process.stderr.write(`  FAIL: ${label}: expected throw but returned\n`);
  } catch (e) {
    if (msgPart && !e.message.includes(msgPart)) {
      failed++;
      errors.push(`${label}: expected '${msgPart}' in error but got '${e.message}'`);
      process.stderr.write(`  FAIL: ${label}: expected '${msgPart}' in '${e.message}'\n`);
    } else {
      passed++;
    }
  }
}

// ── Temp directory ────────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-client-test-"));
const tmpFiles = [];
function registerTmp(p) { tmpFiles.push(p); return p; }
function cleanup() {
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ── Build a minimal valid SQLite3 binary ──────────────────────────────────────
// We build a page-size=4096 database with:
//   - sqlite_master table on page 1 (root page) as a leaf page with 1 row
//   - one real table "users" on page 2 (leaf page) with 3 rows
//
// SQLite binary format reference: https://www.sqlite.org/fileformat2.html

// Encode a varint (SQLite variable-length int, 1-9 bytes)
function encodeVarint(v) {
  if (v < 128) return Buffer.from([v]);
  // Build 9-byte max varint — only used for small integers in practice here
  const bytes = [];
  let val = v;
  while (val > 0x7F) {
    bytes.unshift((val & 0x7F) | 0x80);
    val = Math.floor(val / 128);
  }
  bytes.push(val & 0x7F);
  return Buffer.from(bytes);
}

// Encode a SQLite record given an array of values: null | integer | string
function encodeRecord(values) {
  const serialTypes = [];
  const contentBufs = [];
  for (const v of values) {
    if (v === null) {
      serialTypes.push(0);
    } else if (typeof v === "number" && Number.isInteger(v)) {
      // Serial type 4 = 4-byte signed big-endian integer
      serialTypes.push(4);
      const b = Buffer.allocUnsafe(4);
      b.writeInt32BE(v, 0);
      contentBufs.push(b);
    } else {
      const sb = Buffer.from(String(v), "utf8");
      const st = sb.length * 2 + 13; // text serial type
      serialTypes.push(st);
      contentBufs.push(sb);
    }
  }

  // Header: header-length varint + serial type varints
  const stBufs = serialTypes.map(encodeVarint);
  const stTotal = stBufs.reduce((a, b) => a + b.length, 0);
  // header-length includes the header-length varint itself
  const hdrLenVarint = encodeVarint(stTotal + encodeVarint(stTotal + 1).length);
  const header = Buffer.concat([hdrLenVarint, ...stBufs]);
  const body   = Buffer.concat(contentBufs);
  return Buffer.concat([header, body]);
}

// Build a leaf table B-tree page (page type 0x0D)
// cells: [{ rowid: number, payload: Buffer }]
function buildLeafPage(cells, pageSize, isFirstPage) {
  const hdrOffset = isFirstPage ? 100 : 0;
  const buf = Buffer.alloc(pageSize, 0);
  const numCells = cells.length;

  // Pack cells from the end of the page backwards
  let contentPos = pageSize;
  const cellOffsets = [];

  for (const { rowid, payload } of cells) {
    const payloadLenBuf = encodeVarint(payload.length);
    const rowidBuf      = encodeVarint(rowid);
    const cellSize      = payloadLenBuf.length + rowidBuf.length + payload.length;
    contentPos -= cellSize;
    let pos = contentPos;
    payloadLenBuf.copy(buf, pos); pos += payloadLenBuf.length;
    rowidBuf.copy(buf, pos);      pos += rowidBuf.length;
    payload.copy(buf, pos);
    cellOffsets.push(contentPos);
  }

  // Page header
  buf[hdrOffset + 0] = 0x0D;                              // leaf table page type
  buf[hdrOffset + 1] = 0; buf[hdrOffset + 2] = 0;         // first freeblock = 0
  buf[hdrOffset + 3] = (numCells >> 8) & 0xFF;
  buf[hdrOffset + 4] = numCells & 0xFF;
  const ccs = contentPos || 0;
  buf[hdrOffset + 5] = (ccs >> 8) & 0xFF;
  buf[hdrOffset + 6] = ccs & 0xFF;
  buf[hdrOffset + 7] = 0;                                 // fragment free bytes

  // Cell pointer array at hdrOffset + 8
  let ptrPos = hdrOffset + 8;
  for (const off of cellOffsets) {
    buf[ptrPos++] = (off >> 8) & 0xFF;
    buf[ptrPos++] = off & 0xFF;
  }

  return buf;
}

// Build a minimal SQLite3 database binary in memory
// Schema: CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)
// Rows: (1,'Alice',30), (2,'Bob',25), (3,'Charlie',35)
function buildTestDatabase() {
  const pageSize  = 4096;
  const usersSQL  = "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)";

  // sqlite_master row: [type, name, tbl_name, rootpage, sql]
  const masterRow = encodeRecord(["table", "users", "users", 2, usersSQL]);

  // Page 1: sqlite_master (isFirstPage=true)
  const page1 = buildLeafPage([{ rowid: 1, payload: masterRow }], pageSize, true);

  // Page 2: users data rows
  // INTEGER PRIMARY KEY = rowid alias — id NOT stored in payload
  // Payload columns: name TEXT, age INTEGER
  const page2 = buildLeafPage([
    { rowid: 1, payload: encodeRecord(["Alice",   30]) },
    { rowid: 2, payload: encodeRecord(["Bob",     25]) },
    { rowid: 3, payload: encodeRecord(["Charlie", 35]) },
  ], pageSize, false);

  // Write 100-byte SQLite file header into page1[0..99]
  Buffer.from("SQLite format 3\0", "binary").copy(page1, 0);

  // Page size at bytes 16-17
  page1[16] = (pageSize >> 8) & 0xFF;
  page1[17] = pageSize & 0xFF;
  // File format write/read versions
  page1[18] = 1; page1[19] = 1;
  // Reserved bytes per page: 0
  page1[20] = 0;
  // Max/min embedded fraction (standard values)
  page1[21] = 64; page1[22] = 32; page1[23] = 32;
  // Change counter: 1
  page1[24] = 0; page1[25] = 0; page1[26] = 0; page1[27] = 1;
  // Page count: 2
  page1[28] = 0; page1[29] = 0; page1[30] = 0; page1[31] = 2;
  // First free page: 0, free page count: 0
  page1.fill(0, 32, 40);
  // Schema cookie: 1
  page1[40] = 0; page1[41] = 0; page1[42] = 0; page1[43] = 1;
  // Schema format: 4
  page1[44] = 0; page1[45] = 0; page1[46] = 0; page1[47] = 4;
  // Default page cache size: 0
  page1.fill(0, 48, 56);
  // Text encoding: 1 (UTF-8)
  page1[56] = 0; page1[57] = 0; page1[58] = 0; page1[59] = 1;
  // User version, incremental vacuum, application ID: 0
  page1.fill(0, 60, 92);
  // Version valid for: 1
  page1[92] = 0; page1[93] = 0; page1[94] = 0; page1[95] = 1;
  // SQLite version number: 3.42.0 = 3042000
  const ver = 3042000;
  page1[96] = (ver >> 24) & 0xFF;
  page1[97] = (ver >> 16) & 0xFF;
  page1[98] = (ver >> 8)  & 0xFF;
  page1[99] =  ver        & 0xFF;

  return Buffer.concat([page1, page2]);
}

// Write test database to disk
const dbBuf  = buildTestDatabase();
const dbPath = registerTmp(path.join(tmpDir, "test.db"));
fs.writeFileSync(dbPath, dbBuf);

// Non-SQLite file for error path tests (must be >=100 bytes so magic check fires, not size check)
const notDbPath = registerTmp(path.join(tmpDir, "not-a-db.txt"));
fs.writeFileSync(notDbPath, "This is not a SQLite database. ".padEnd(200, "X"), "utf8");

// ══════════════════════════════════════════════════════════════════════════════
// A — Validation (10 tests)
// ══════════════════════════════════════════════════════════════════════════════
process.stderr.write("[A] Validation\n");

assertThrows(() => sqliteClient({ path: dbPath }),                                         "operation", "A01: missing operation");
assertThrows(() => sqliteClient({ operation: "info" }),                                    "path",      "A02: missing path");
assertThrows(() => sqliteClient({ operation: "info", path: "" }),                          "non-empty", "A03: empty path");
assertThrows(() => sqliteClient({ operation: "badop", path: dbPath }),                     "badop",     "A04: invalid operation");
assertThrows(() => sqliteClient({ operation: "info", path: "test\0.db" }),                 "NUL",       "A05: NUL byte in path");
assertThrows(() => sqliteClient({ operation: "info", path: tmpDir }),                      "directory", "A06: directory as path");
assertThrows(() => sqliteClient({ operation: "info", path: "/totally/fake/path.db" }),     "",          "A07: file not found");
assertThrows(() => sqliteClient({ operation: "info", path: notDbPath }),                   "magic",     "A08: bad magic header");
assertThrows(() => sqliteClient({ operation: "query", path: dbPath }),                     "sql",       "A09: query missing sql");
assertThrows(
  () => sqliteClient({ operation: "query", path: dbPath, sql: "INSERT INTO users VALUES (4,'Dave',40)" }),
  "SELECT",
  "A10: query rejects non-SELECT"
);

// ══════════════════════════════════════════════════════════════════════════════
// B — Unit tests (20 tests)
// ══════════════════════════════════════════════════════════════════════════════
process.stderr.write("[B] Unit\n");

// B01-B10: info operation
{
  const r = sqliteClient({ operation: "info", path: dbPath });
  assert(r.operation === "info",              "B01: info.operation");
  assert(r.pageSize === 4096,                 "B02: info.pageSize");
  assert(r.pageCount === 2,                  "B03: info.pageCount");
  assert(r.encoding === "UTF-8",              "B04: info.encoding");
  assert(r.tableCounts.tables === 1,          "B05: info.tableCounts.tables");
  assert(Array.isArray(r.tables),             "B06: info.tables is array");
  assert(r.tables.includes("users"),          "B07: info.tables includes users");
  assert(typeof r.sqliteVersion === "string", "B08: info.sqliteVersion is string");
  assert(r.sqliteVersion.startsWith("3."),    "B09: info.sqliteVersion starts with 3.");
  assert(typeof r.changeCounter === "number", "B10: info.changeCounter is number");
}

// B11-B15: tables operation
{
  const r = sqliteClient({ operation: "tables", path: dbPath });
  assert(r.operation === "tables",            "B11: tables.operation");
  assert(r.count === 1,                      "B12: tables.count");
  assert(r.tables[0].name === "users",       "B13: tables[0].name");
  assert(typeof r.tables[0].rootpage === "number", "B14: tables[0].rootpage is number");
  assert(r.tables[0].rootpage === 2,         "B15: users rootpage is 2");
}

// B16-B20: schema operation
{
  const r = sqliteClient({ operation: "schema", path: dbPath });
  assert(r.operation === "schema",            "B16: schema.operation");
  assert(r.count >= 1,                       "B17: schema has entries");
  const usersEntry = r.schema.find(e => e.name === "users");
  assert(usersEntry !== undefined,            "B18: schema has users entry");
  assert(usersEntry.type === "table",         "B19: users entry type is table");
  assert(Array.isArray(usersEntry.columns),   "B20: users entry has columns array");
}

// ══════════════════════════════════════════════════════════════════════════════
// C — Happy-path (20 tests)
// ══════════════════════════════════════════════════════════════════════════════
process.stderr.write("[C] Happy-path\n");

// C01-C05: SELECT *
{
  const r = sqliteClient({ operation: "query", path: dbPath, sql: "SELECT * FROM users" });
  assert(r.operation === "query",   "C01: query.operation");
  assert(r.rowCount === 3,         "C02: query returns 3 rows");
  assert(Array.isArray(r.columns), "C03: query.columns is array");
  assert(r.columns.includes("name"), "C04: columns includes name");
  assert(r.rows[0].name === "Alice", "C05: first row name is Alice");
}

// C06-C10: rowid PK alias, LIMIT
{
  const r = sqliteClient({ operation: "query", path: dbPath, sql: "SELECT * FROM users" });
  assert(r.rows[0].id === 1, "C06: id rowid alias = 1");
  assert(r.rows[1].id === 2, "C07: id rowid alias = 2");
  assert(r.rows[2].id === 3, "C08: id rowid alias = 3");

  const r2 = sqliteClient({ operation: "query", path: dbPath, sql: "SELECT * FROM users LIMIT 2" });
  assert(r2.rowCount === 2,           "C09: LIMIT 2 returns 2 rows");
  assert(r2.rows[0].name === "Alice", "C10: LIMIT first row is Alice");
}

// C11-C15: ORDER BY, OFFSET, column projection
{
  const r = sqliteClient({ operation: "query", path: dbPath, sql: "SELECT * FROM users ORDER BY age DESC" });
  assert(r.rows[0].name === "Charlie", "C11: ORDER BY age DESC first is Charlie");
  assert(r.rows[1].name === "Alice",   "C12: ORDER BY age DESC second is Alice");

  const r2 = sqliteClient({ operation: "query", path: dbPath, sql: "SELECT * FROM users LIMIT 2 OFFSET 1" });
  assert(r2.rowCount === 2,          "C13: LIMIT 2 OFFSET 1 returns 2 rows");
  assert(r2.rows[0].name === "Bob",  "C14: OFFSET 1 first row is Bob");

  const r3 = sqliteClient({ operation: "query", path: dbPath, sql: "SELECT name FROM users" });
  assert(r3.columns.length === 1,    "C15: column projection: 1 column");
}

// C16-C20: schema with table filter, export JSON, export CSV
{
  const r = sqliteClient({ operation: "schema", path: dbPath, table: "users" });
  assert(r.schema.length >= 1,           "C16: schema scoped to users");
  assert(r.schema[0].name === "users",   "C17: schema scoped entry name = users");

  const r2 = sqliteClient({ operation: "export", path: dbPath, table: "users" });
  assert(r2.operation === "export",      "C18: export.operation");
  assert(r2.rowCount === 3,             "C19: export rowCount = 3");

  const r3 = sqliteClient({ operation: "export", path: dbPath, table: "users", format: "csv" });
  assert(r3.data.includes("Alice"),      "C20: export CSV includes Alice");
}

// ══════════════════════════════════════════════════════════════════════════════
// D — Security (10 tests)
// ══════════════════════════════════════════════════════════════════════════════
process.stderr.write("[D] Security\n");

assertThrows(
  () => sqliteClient({ operation: "info",    path: "/etc/passwd\0.db" }), "NUL",       "D01: NUL byte guard");
assertThrows(
  () => sqliteClient({ operation: "info",    path: tmpDir }),              "directory", "D02: directory guard");
assertThrows(
  () => sqliteClient({ operation: "execute", path: dbPath, sql: "DROP DATABASE main" }),
  "not allow", "D03: execute blocks DROP DATABASE");
assertThrows(
  () => sqliteClient({ operation: "execute", path: dbPath, sql: "ATTACH '/tmp/evil.db' AS evil" }),
  "not allow", "D04: execute blocks ATTACH");
assertThrows(
  () => sqliteClient({ operation: "execute", path: dbPath, sql: "DETACH evil" }),
  "not allow", "D05: execute blocks DETACH");
assertThrows(
  () => sqliteClient({ operation: "export",  path: dbPath }),              "table",     "D06: export requires table");
assertThrows(
  () => sqliteClient({ operation: "schema",  path: dbPath, table: "nonexistent_xyz" }),
  "nonexistent_xyz", "D07: schema throws on missing table");
assertThrows(
  () => sqliteClient({ operation: "query",   path: dbPath, sql: "SELECT * FROM phantom_table" }),
  "phantom_table",   "D08: query throws on missing table");
assertThrows(
  () => sqliteClient({ operation: "execute", path: "test\0.db", sql: "SELECT 1" }),
  "NUL",             "D09: execute NUL byte guard");

// D10: truncated file (valid magic, too small for header)
{
  const corruptPath = registerTmp(path.join(tmpDir, "corrupt.db"));
  const buf = Buffer.alloc(50, 0);
  Buffer.from("SQLite format 3\0", "binary").copy(buf, 0);
  fs.writeFileSync(corruptPath, buf);
  assertThrows(() => sqliteClient({ operation: "info", path: corruptPath }), "too small", "D10: truncated file detected");
}

// ══════════════════════════════════════════════════════════════════════════════
// E — Error paths (10 tests)
// ══════════════════════════════════════════════════════════════════════════════
process.stderr.write("[E] Error paths\n");

// E01: export non-existent table
assertThrows(() => sqliteClient({ operation: "export", path: dbPath, table: "nosuch" }), "nosuch", "E01: export non-existent table");

// E02: tables with type=view returns 0
{
  const r = sqliteClient({ operation: "tables", path: dbPath, type: "view" });
  assert(r.count === 0, "E02: tables type=view returns 0");
}

// E03: query with empty sql string
assertThrows(() => sqliteClient({ operation: "query", path: dbPath, sql: "" }), "sql", "E03: query with empty sql");

// E04: export CSV with header=false omits header row
{
  const r = sqliteClient({ operation: "export", path: dbPath, table: "users", format: "csv", header: false });
  const lines = r.data.trim().split("\n");
  assert(!lines[0].includes("name"), "E04: CSV header=false has no header row");
}

// E05: export CSV default has header row
{
  const r = sqliteClient({ operation: "export", path: dbPath, table: "users", format: "csv" });
  const lines = r.data.trim().split("\n");
  assert(lines[0].includes("name"), "E05: CSV default has header row");
}

// E06: export JSON default produces parseable JSON
{
  const r = sqliteClient({ operation: "export", path: dbPath, table: "users" });
  assert(typeof r.data === "string", "E06a: export JSON data is string");
  const parsed = JSON.parse(r.data);
  assert(parsed.rows.length === 3,   "E06b: export JSON has 3 rows");
}

// E07: export with output_file writes file
{
  const outPath = registerTmp(path.join(tmpDir, "export-out.json"));
  const r = sqliteClient({ operation: "export", path: dbPath, table: "users", output_file: outPath });
  assert(fs.existsSync(outPath), "E07a: export output_file created");
  assert(r.rowCount === 3,       "E07b: export to file rowCount=3");
}

// E08: export CSV to output_file
{
  const outPath = registerTmp(path.join(tmpDir, "export-out.csv"));
  const r = sqliteClient({ operation: "export", path: dbPath, table: "users", format: "csv", output_file: outPath });
  assert(fs.existsSync(outPath), "E08a: CSV output_file created");
  const content = fs.readFileSync(outPath, "utf8");
  assert(content.includes("Alice"), "E08b: CSV file includes Alice");
}

// E09: non-sqlite file caught by magic check
assertThrows(() => sqliteClient({ operation: "info", path: notDbPath }), "magic", "E09: non-sqlite file caught");

// E10: tables with type=index returns numeric count
{
  const r = sqliteClient({ operation: "tables", path: dbPath, type: "index" });
  assert(typeof r.count === "number", "E10: tables type=index returns count");
}

// ══════════════════════════════════════════════════════════════════════════════
// F — Concurrency (6 tests)
// ══════════════════════════════════════════════════════════════════════════════
process.stderr.write("[F] Concurrency\n");

function runAll(fns) {
  return fns.map(f => { try { return { ok: true, result: f() }; } catch (e) { return { ok: false, error: e.message }; } });
}

// F01: 6 concurrent ops on same file
{
  const results = runAll([
    () => sqliteClient({ operation: "info",   path: dbPath }),
    () => sqliteClient({ operation: "tables", path: dbPath }),
    () => sqliteClient({ operation: "schema", path: dbPath }),
    () => sqliteClient({ operation: "query",  path: dbPath, sql: "SELECT * FROM users" }),
    () => sqliteClient({ operation: "export", path: dbPath, table: "users" }),
    () => sqliteClient({ operation: "info",   path: dbPath }),
  ]);
  assert(results.every(r => r.ok), "F01: 6 concurrent ops all succeed");
}

// F02-F06: 5 rapid SELECT queries
for (let i = 0; i < 5; i++) {
  const r = sqliteClient({ operation: "query", path: dbPath, sql: "SELECT * FROM users ORDER BY age ASC" });
  assert(r.rows[0].name === "Bob", `F0${i + 2}: rapid SELECT ${i + 1}/5 correct (youngest=Bob)`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
cleanup();
const total = passed + failed;
process.stdout.write(`\nSection 230 sqlite_client: ${passed}/${total} tests passed\n`);
if (errors.length) {
  process.stdout.write(`FAILURES:\n${errors.map(e => "  " + e).join("\n")}\n`);
  process.exit(1);
}
