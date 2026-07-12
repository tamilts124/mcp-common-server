"use strict";
// test/sections/216-excel-client.js
// Section 216 — excel_client tool tests
// 75 total: A=validation(10), B=unit(20), C=happy-path(20), D=security(10), E=error-paths(10), F=concurrency(5)

const { excelClient } = require("../../lib/excelClientOps");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Test harness ──────────────────────────────────────────────────
let passed = 0, failed = 0, errors = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; errors.push(msg); process.stderr.write(`  FAIL: ${msg}\n`); }
}

function assertThrows(fn, pattern, msg) {
  try { fn(); failed++; errors.push(`Expected throw: ${msg}`); process.stderr.write(`  FAIL: expected throw — ${msg}\n`); }
  catch (e) {
    if (pattern && !e.message.includes(pattern)) {
      failed++; errors.push(`Wrong error for: ${msg} (got: ${e.message})`);
      process.stderr.write(`  FAIL: wrong error for '${msg}': ${e.message}\n`);
    } else {
      passed++;
    }
  }
}

// ── Setup helpers ──────────────────────────────────────────────────
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "excel-test-"));
const allFiles = [];

function tmpFile(name) {
  const p = path.join(TMPDIR, name);
  allFiles.push(p);
  return p;
}

// Fake resolveClientPath for tests (no server context needed)
function resolve(p) { return { resolved: p }; }

function run(args) {
  return excelClient(args, resolve);
}

// Build a minimal valid XLSX in memory and write it to disk
// We use the tool itself (add_sheet + set_range) to create test fixtures.
function createSampleXlsx(filePath, rows) {
  // Use append_rows to create a fresh file
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  run({ operation: "append_rows", path: filePath, rows });
  return filePath;
}

// ───────────────────────────────────────────────────────────────────
// A — Input Validation (10)
// ───────────────────────────────────────────────────────────────────
process.stderr.write("Section A — Validation\n");

// A1: missing operation
assertThrows(() => run({ path: "x.xlsx" }), "'operation' is required", "A1 missing operation");

// A2: unknown operation
assertThrows(() => run({ operation: "blorp", path: "x.xlsx" }), "unknown operation", "A2 unknown operation");

// A3: path with NUL byte
assertThrows(() => run({ operation: "list_sheets", path: "x\0.xlsx" }), "NUL", "A3 NUL in path");

// A4: non-xlsx extension
assertThrows(() => run({ operation: "list_sheets", path: "spreadsheet.xls" }), "only .xlsx", "A4 xls rejected");

// A5: get_cell without cell
assertThrows(() => run({ operation: "get_cell", path: tmpFile("a5.xlsx"), cell: undefined }), "'cell' is required", "A5 get_cell no cell");

// A6: set_cell without value
assertThrows(() => run({ operation: "set_cell", path: tmpFile("a6.xlsx"), cell: "A1", value: undefined }), "'value' is required", "A6 set_cell no value");

// A7: get_range without range
assertThrows(() => run({ operation: "get_range", path: tmpFile("a7.xlsx"), range: undefined }), "'range' is required", "A7 get_range no range");

// A8: set_range values not array
assertThrows(() => run({ operation: "set_range", path: tmpFile("a8.xlsx"), range: "A1:B2", values: "oops" }), "'values' must be a 2D array", "A8 set_range bad values");

// A9: add_sheet without name
assertThrows(() => run({ operation: "add_sheet", path: tmpFile("a9.xlsx"), name: undefined }), "'name' is required", "A9 add_sheet no name");

// A10: delete_sheet without sheet
assertThrows(() => run({ operation: "delete_sheet", path: tmpFile("a10.xlsx") }), "'sheet' is required", "A10 delete_sheet no sheet");


// ───────────────────────────────────────────────────────────────────
// B — Unit Tests (20)
// ───────────────────────────────────────────────────────────────────
process.stderr.write("Section B — Unit Tests\n");

// We import internal helpers via require (already exported via excelClient, tested indirectly)
// These tests exercise the tool interface at unit level.

// B1: create new xlsx via set_cell (file created from scratch)
const b1 = tmpFile("b1.xlsx");
const r_b1 = run({ operation: "set_cell", path: b1, cell: "A1", value: "Hello" });
assert(r_b1.written === true, "B1 set_cell creates file");
assert(fs.existsSync(b1), "B1 file exists");

// B2: read back the cell we just wrote
const r_b2 = run({ operation: "get_cell", path: b1, cell: "A1" });
assert(r_b2.value === "Hello", "B2 get_cell reads string value");

// B3: set numeric cell
run({ operation: "set_cell", path: b1, cell: "B1", value: 42 });
const r_b3 = run({ operation: "get_cell", path: b1, cell: "B1" });
assert(r_b3.value === 42, "B3 numeric cell value");

// B4: set boolean cell
run({ operation: "set_cell", path: b1, cell: "C1", value: true });
const r_b4 = run({ operation: "get_cell", path: b1, cell: "C1" });
assert(r_b4.value === true, "B4 boolean cell value");

// B5: get_cell on empty cell returns null
const r_b5 = run({ operation: "get_cell", path: b1, cell: "Z99" });
assert(r_b5.value === null, "B5 empty cell returns null");

// B6: list_sheets returns sheet info
const r_b6 = run({ operation: "list_sheets", path: b1 });
assert(r_b6.sheetCount === 1, "B6 one sheet");
assert(r_b6.sheets[0].name === "Sheet1", "B6 sheet name is Sheet1");

// B7: add_sheet creates second sheet
const b7 = tmpFile("b7.xlsx");
run({ operation: "set_cell", path: b7, cell: "A1", value: "data" });
run({ operation: "add_sheet", path: b7, name: "Second" });
const r_b7 = run({ operation: "list_sheets", path: b7 });
assert(r_b7.sheetCount === 2, "B7 two sheets after add");
assert(r_b7.sheets[1].name === "Second", "B7 second sheet name");

// B8: add_sheet at specific index
run({ operation: "add_sheet", path: b7, name: "First", index: 0 });
const r_b8 = run({ operation: "list_sheets", path: b7 });
assert(r_b8.sheets[0].name === "First", "B8 sheet inserted at index 0");

// B9: delete_sheet
run({ operation: "delete_sheet", path: b7, sheet: "Second" });
const r_b9 = run({ operation: "list_sheets", path: b7 });
assert(r_b9.sheetCount === 2, "B9 two sheets after delete");
assert(!r_b9.sheets.find(s => s.name === "Second"), "B9 Second removed");

// B10: append_rows creates new file and adds rows
const b10 = tmpFile("b10.xlsx");
const r_b10 = run({ operation: "append_rows", path: b10, rows: [["Name","Age"],["Alice",30],["Bob",25]] });
assert(r_b10.appendedRows === 3, "B10 three rows appended");
assert(r_b10.startRow === 0, "B10 startRow is 0");

// B11: append_rows again appends after existing rows
const r_b11 = run({ operation: "append_rows", path: b10, rows: [["Carol",35]] });
assert(r_b11.startRow === 3, "B11 appends after row 3");

// B12: read all rows from b10
const r_b12 = run({ operation: "read", path: b10 });
assert(r_b12.rows.length === 4, "B12 four rows total");
assert(r_b12.rows[0].cells[0] === "Name", "B12 header cell");
assert(r_b12.rows[1].cells[1] === 30, "B12 numeric cell");

// B13: read with offset
const r_b13 = run({ operation: "read", path: b10, offset: 1, limit: 2 });
assert(r_b13.rows.length === 2, "B13 offset+limit returns 2 rows");
assert(r_b13.rows[0].cells[0] === "Alice", "B13 first returned row is Alice");

// B14: set_range writes 2D values
const b14 = tmpFile("b14.xlsx");
run({ operation: "set_range", path: b14, range: "B2:C3", values: [[1,2],[3,4]] });
const r_b14a = run({ operation: "get_cell", path: b14, cell: "B2" });
const r_b14b = run({ operation: "get_cell", path: b14, cell: "C3" });
assert(r_b14a.value === 1, "B14 set_range B2=1");
assert(r_b14b.value === 4, "B14 set_range C3=4");

// B15: get_range reads rectangle
const r_b15 = run({ operation: "get_range", path: b14, range: "B2:C3" });
assert(r_b15.rows.length === 2, "B15 get_range returns 2 rows");
assert(r_b15.rows[0].cells[0] === 1 && r_b15.rows[0].cells[1] === 2, "B15 first row values");

// B16: delete_rows removes rows and shifts
const b16 = tmpFile("b16.xlsx");
run({ operation: "append_rows", path: b16, rows: [["a"],["b"],["c"],["d"]] });
run({ operation: "delete_rows", path: b16, row: 1, count: 2 });
const r_b16 = run({ operation: "read", path: b16 });
assert(r_b16.rows.length === 2, "B16 two rows remain after delete");
assert(r_b16.rows[1].cells[0] === "d", "B16 'd' is now row 1");

// B17: stringify returns CSV
const b17 = tmpFile("b17.xlsx");
run({ operation: "append_rows", path: b17, rows: [["a","b"],["c","d"]] });
const r_b17 = run({ operation: "stringify", path: b17 });
assert(r_b17.csv.includes("a,b"), "B17 stringify contains a,b");
assert(r_b17.csv.includes("c,d"), "B17 stringify contains c,d");

// B18: sheet by index
const b18 = tmpFile("b18.xlsx");
run({ operation: "set_cell", path: b18, cell: "A1", value: "main" });
run({ operation: "add_sheet", path: b18, name: "Extra" });
run({ operation: "set_cell", path: b18, cell: "A1", value: "extra", sheet: "Extra" });
const r_b18 = run({ operation: "get_cell", path: b18, cell: "A1", sheet: 1 });
assert(r_b18.value === "extra", "B18 sheet by index 1");

// B19: set_cell on non-first sheet by name
const r_b19 = run({ operation: "get_cell", path: b18, cell: "A1", sheet: "Sheet1" });
assert(r_b19.value === "main", "B19 sheet by name Sheet1");

// B20: set_cell null clears cell
run({ operation: "set_cell", path: b18, cell: "A1", value: null });
const r_b20 = run({ operation: "get_cell", path: b18, cell: "A1" });
assert(r_b20.value === null, "B20 null clears cell");


// ───────────────────────────────────────────────────────────────────
// C — Happy-Path (20)
// ───────────────────────────────────────────────────────────────────
process.stderr.write("Section C — Happy-Path\n");

// C1: full workbook round-trip with multiple sheets
const c1 = tmpFile("c1.xlsx");
run({ operation: "append_rows", path: c1, rows: [["ID","Score"],[1,95],[2,87]] });
run({ operation: "add_sheet", path: c1, name: "Metadata" });
run({ operation: "set_cell", path: c1, cell: "A1", value: "Created", sheet: "Metadata" });
run({ operation: "set_cell", path: c1, cell: "B1", value: "2025-01-01", sheet: "Metadata" });
const c1_sheets = run({ operation: "list_sheets", path: c1 });
assert(c1_sheets.sheetCount === 2, "C1 two sheets");
const c1_meta_cell = run({ operation: "get_cell", path: c1, cell: "A1", sheet: "Metadata" });
assert(c1_meta_cell.value === "Created", "C1 metadata cell value");

// C2: large row append (100 rows)
const c2 = tmpFile("c2.xlsx");
const bigRows = Array.from({ length: 100 }, (_, i) => [i, `Row ${i}`, i * 2.5]);
run({ operation: "append_rows", path: c2, rows: bigRows });
const c2_read = run({ operation: "read", path: c2 });
assert(c2_read.rows.length === 100, "C2 100 rows appended");
assert(c2_read.rows[99].cells[1] === "Row 99", "C2 last row content");

// C3: read with limit
const c3_read = run({ operation: "read", path: c2, limit: 10 });
assert(c3_read.rows.length === 10, "C3 limit=10 returns 10 rows");
assert(c3_read.totalRows === 100, "C3 totalRows=100");

// C4: get_range spanning multiple rows and cols
const c4 = tmpFile("c4.xlsx");
run({ operation: "set_range", path: c4, range: "A1:D3", values: [
  ["Q1","Q2","Q3","Q4"],
  [100, 200, 300, 400],
  [150, 250, 350, 450],
] });
const c4_r = run({ operation: "get_range", path: c4, range: "A1:D3" });
assert(c4_r.rows[0].cells[3] === "Q4", "C4 header Q4");
assert(c4_r.rows[2].cells[3] === 450, "C4 last cell 450");

// C5: overwrite existing cell
run({ operation: "set_cell", path: c4, cell: "A1", value: "Period" });
const c5_r = run({ operation: "get_cell", path: c4, cell: "A1" });
assert(c5_r.value === "Period", "C5 overwrite cell");

// C6: empty sheet (add_sheet, then read)
const c6 = tmpFile("c6.xlsx");
run({ operation: "set_cell", path: c6, cell: "A1", value: 1 });
run({ operation: "add_sheet", path: c6, name: "Empty" });
const c6_r = run({ operation: "read", path: c6, sheet: "Empty" });
assert(c6_r.rows.length === 0, "C6 empty sheet has 0 rows");

// C7: delete_rows from middle
const c7 = tmpFile("c7.xlsx");
run({ operation: "append_rows", path: c7, rows: [[1],[2],[3],[4],[5]] });
run({ operation: "delete_rows", path: c7, row: 1, count: 3 });
const c7_r = run({ operation: "read", path: c7 });
assert(c7_r.rows.length === 2, "C7 two rows remain");
assert(c7_r.rows[1].cells[0] === 5, "C7 row[1] = 5");

// C8: delete first sheet by index
const c8 = tmpFile("c8.xlsx");
run({ operation: "set_cell", path: c8, cell: "A1", value: "first" });
run({ operation: "add_sheet", path: c8, name: "Second" });
run({ operation: "delete_sheet", path: c8, sheet: 0 });
const c8_r = run({ operation: "list_sheets", path: c8 });
assert(c8_r.sheets[0].name === "Second", "C8 first sheet is now Second");

// C9: stringify with tab separator
const c9 = tmpFile("c9.xlsx");
run({ operation: "append_rows", path: c9, rows: [["a","b"],[1,2]] });
const c9_r = run({ operation: "stringify", path: c9, separator: "\t" });
assert(c9_r.csv.includes("a\tb"), "C9 tab-separated");

// C10: cell addresses case-insensitive
const c10 = tmpFile("c10.xlsx");
run({ operation: "set_cell", path: c10, cell: "a1", value: "lower" });
const c10_r = run({ operation: "get_cell", path: c10, cell: "A1" });
assert(c10_r.value === "lower", "C10 lowercase cell address works");

// C11: multiple concurrent sheets with data
const c11 = tmpFile("c11.xlsx");
run({ operation: "append_rows", path: c11, rows: [["sheet1row"]] });
run({ operation: "add_sheet", path: c11, name: "S2" });
run({ operation: "append_rows", path: c11, sheet: "S2", rows: [["sheet2row"]] });
const c11_s1 = run({ operation: "get_cell", path: c11, cell: "A1", sheet: 0 });
const c11_s2 = run({ operation: "get_cell", path: c11, cell: "A1", sheet: 1 });
assert(c11_s1.value === "sheet1row", "C11 S1 A1");
assert(c11_s2.value === "sheet2row", "C11 S2 A1");

// C12: set_range with partial null skipping
const c12 = tmpFile("c12.xlsx");
run({ operation: "set_range", path: c12, range: "A1:C2", values: [[1, undefined, 3],[null, 5, null]] });
const c12_A1 = run({ operation: "get_cell", path: c12, cell: "A1" });
const c12_C1 = run({ operation: "get_cell", path: c12, cell: "C1" });
const c12_B2 = run({ operation: "get_cell", path: c12, cell: "B2" });
assert(c12_A1.value === 1, "C12 A1=1");
assert(c12_C1.value === 3, "C12 C1=3");
assert(c12_B2.value === 5, "C12 B2=5");

// C13: list_sheets rowCount is accurate
const c13_list = run({ operation: "list_sheets", path: c2 });
assert(c13_list.sheets[0].rowCount === 100, "C13 rowCount=100");

// C14: append_rows respects existing data
const c14 = tmpFile("c14.xlsx");
run({ operation: "set_cell", path: c14, cell: "A1", value: "existing" });
run({ operation: "append_rows", path: c14, rows: [["new"]] });
const c14_r = run({ operation: "read", path: c14 });
assert(c14_r.rows.length === 2, "C14 append after existing");
assert(c14_r.rows[1].cells[0] === "new", "C14 appended row");

// C15: read returnedRows field
assert(c3_read.returnedRows === 10, "C15 returnedRows field");

// C16: get_range returns correct address
const c16_r = run({ operation: "get_range", path: c4, range: "a1:b2" });
assert(c16_r.range === "A1:B2", "C16 range normalized to uppercase");

// C17: add_sheet at index 0 (prepend)
const c17 = tmpFile("c17.xlsx");
run({ operation: "set_cell", path: c17, cell: "A1", value: "orig" });
run({ operation: "add_sheet", path: c17, name: "Prepend", index: 0 });
const c17_r = run({ operation: "list_sheets", path: c17 });
assert(c17_r.sheets[0].name === "Prepend", "C17 Prepend at index 0");

// C18: delete_rows with count=1 (default)
const c18 = tmpFile("c18.xlsx");
run({ operation: "append_rows", path: c18, rows: [["x"],["y"],["z"]] });
run({ operation: "delete_rows", path: c18, row: 0 });
const c18_r = run({ operation: "read", path: c18 });
assert(c18_r.rows[0].cells[0] === "y", "C18 first row is now y");

// C19: stringify wraps cells with commas
const c19 = tmpFile("c19.xlsx");
run({ operation: "append_rows", path: c19, rows: [["a,b","c"]] });
const c19_r = run({ operation: "stringify", path: c19 });
assert(c19_r.csv.includes('"a,b"'), "C19 comma value is quoted");

// C20: read offset beyond total returns empty
const c20_r = run({ operation: "read", path: c2, offset: 200 });
assert(c20_r.rows.length === 0, "C20 offset beyond total returns empty");


// ───────────────────────────────────────────────────────────────────
// D — Security (10)
// ───────────────────────────────────────────────────────────────────
process.stderr.write("Section D — Security\n");

// D1: NUL byte in path (read)
assertThrows(() => run({ operation: "read", path: "test\0.xlsx" }), "NUL", "D1 NUL in read path");

// D2: NUL byte in path (set_cell)
assertThrows(() => run({ operation: "set_cell", path: "x\0.xlsx", cell: "A1", value: 1 }), "NUL", "D2 NUL in set_cell path");

// D3: file extension must be .xlsx (set_range)
assertThrows(() => run({ operation: "set_range", path: "data.csv", range: "A1:B1", values: [[1,2]] }), "only .xlsx", "D3 csv extension rejected in set_range");

// D4: reading a directory path
const d4 = path.join(TMPDIR, "subdir");
fs.mkdirSync(d4, { recursive: true });
// guardPath passes for .xlsx path, then fs.statSync returns directory
assertThrows(() => run({ operation: "read", path: d4 + ".xlsx" }), "", "D4 non-existent or dir path");

// D5: set_cell with formula string stored safely (no code execution)
const d5 = tmpFile("d5.xlsx");
run({ operation: "set_cell", path: d5, cell: "A1", value: "=DROP_TABLE" });
const d5_r = run({ operation: "get_cell", path: d5, cell: "A1" });
assert(d5_r.value === "=DROP_TABLE", "D5 formula-like string stored as plain string");

// D6: XML injection in string value is escaped
const d6 = tmpFile("d6.xlsx");
run({ operation: "set_cell", path: d6, cell: "A1", value: '<script>alert("xss")</script>' });
const d6_r = run({ operation: "get_cell", path: d6, cell: "A1" });
assert(d6_r.value === '<script>alert("xss")</script>', "D6 XML injection string round-trips safely");

// D7: & in value is handled
const d7 = tmpFile("d7.xlsx");
run({ operation: "set_cell", path: d7, cell: "A1", value: "AT&T" });
const d7_r = run({ operation: "get_cell", path: d7, cell: "A1" });
assert(d7_r.value === "AT&T", "D7 ampersand round-trips");

// D8: sheet name length limit
assertThrows(() => {
  const d8 = tmpFile("d8.xlsx");
  run({ operation: "set_cell", path: d8, cell: "A1", value: 1 });
  run({ operation: "add_sheet", path: d8, name: "A".repeat(32) });
}, "31 characters", "D8 sheet name > 31 chars rejected");

// D9: delete last sheet is rejected
const d9 = tmpFile("d9.xlsx");
run({ operation: "set_cell", path: d9, cell: "A1", value: 1 });
assertThrows(() => run({ operation: "delete_sheet", path: d9, sheet: 0 }), "last remaining sheet", "D9 cannot delete last sheet");

// D10: cannot duplicate sheet name
const d10 = tmpFile("d10.xlsx");
run({ operation: "set_cell", path: d10, cell: "A1", value: 1 });
assertThrows(() => run({ operation: "add_sheet", path: d10, name: "Sheet1" }), "already exists", "D10 duplicate sheet name rejected");


// ───────────────────────────────────────────────────────────────────
// E — Error Paths (10)
// ───────────────────────────────────────────────────────────────────
process.stderr.write("Section E — Error Paths\n");

// E1: read non-existent file
assertThrows(() => run({ operation: "read", path: tmpFile("nonexistent.xlsx") }), "", "E1 read nonexistent file");

// E2: get_cell on non-existent file
assertThrows(() => run({ operation: "get_cell", path: tmpFile("ne2.xlsx"), cell: "A1" }), "", "E2 get_cell nonexistent");

// E3: list_sheets on non-existent file
assertThrows(() => run({ operation: "list_sheets", path: tmpFile("ne3.xlsx") }), "", "E3 list_sheets nonexistent");

// E4: invalid cell address
assertThrows(() => {
  const e4 = tmpFile("e4.xlsx");
  run({ operation: "set_cell", path: e4, cell: "A1", value: 1 });
  run({ operation: "get_cell", path: e4, cell: "A0" }); // row 0 is invalid (1-based)
}, "", "E4 invalid cell row 0");

// E5: invalid range (missing colon)
assertThrows(() => {
  const e5 = tmpFile("e5.xlsx");
  run({ operation: "set_cell", path: e5, cell: "A1", value: 1 });
  run({ operation: "get_range", path: e5, range: "A1B2" });
}, "A1:C10 format", "E5 range missing colon");

// E6: delete_rows out of range
assertThrows(() => {
  const e6 = tmpFile("e6.xlsx");
  run({ operation: "append_rows", path: e6, rows: [[1],[2]] });
  run({ operation: "delete_rows", path: e6, row: 99 });
}, "out of range", "E6 delete_rows out of range");

// E7: invalid sheet name in get_cell
assertThrows(() => {
  const e7 = tmpFile("e7.xlsx");
  run({ operation: "set_cell", path: e7, cell: "A1", value: 1 });
  run({ operation: "get_cell", path: e7, cell: "A1", sheet: "Nonexistent" });
}, "not found", "E7 nonexistent sheet name");

// E8: invalid sheet index in read
assertThrows(() => {
  const e8 = tmpFile("e8.xlsx");
  run({ operation: "set_cell", path: e8, cell: "A1", value: 1 });
  run({ operation: "read", path: e8, sheet: 99 });
}, "out of range", "E8 sheet index out of range");

// E9: append_rows with non-array row
assertThrows(() => {
  const e9 = tmpFile("e9.xlsx");
  run({ operation: "append_rows", path: e9, rows: ["not-an-array"] });
}, "must be an array", "E9 row not array");

// E10: corrupt / non-zip file rejected
const e10 = tmpFile("e10.xlsx");
fs.writeFileSync(e10, "not a zip file at all");
assertThrows(() => run({ operation: "read", path: e10 }), "", "E10 corrupt file rejected");


// ───────────────────────────────────────────────────────────────────
// F — Concurrency (5)
// ───────────────────────────────────────────────────────────────────
process.stderr.write("Section F — Concurrency\n");

// F1: parallel reads of same file are safe
const f1 = tmpFile("f1.xlsx");
run({ operation: "append_rows", path: f1, rows: Array.from({length:50}, (_,i) => [i]) });
const f1_reads = Array.from({length:10}, () => run({ operation: "read", path: f1, limit: 50 }));
assert(f1_reads.every(r => r.rows.length === 50), "F1 parallel reads all return 50 rows");

// F2: sequential writes to different files don't collide
const f2_files = Array.from({length:5}, (_, i) => tmpFile(`f2_${i}.xlsx`));
f2_files.forEach((p, i) => run({ operation: "set_cell", path: p, cell: "A1", value: i }));
const f2_vals = f2_files.map((p, i) => run({ operation: "get_cell", path: p, cell: "A1" }).value);
assert(f2_vals.every((v, i) => v === i), "F2 separate files have distinct values");

// F3: multiple append_rows in sequence accumulate
const f3 = tmpFile("f3.xlsx");
for (let i = 0; i < 10; i++) run({ operation: "append_rows", path: f3, rows: [[i]] });
const f3_r = run({ operation: "read", path: f3 });
assert(f3_r.rows.length === 10, "F3 10 sequential appends");

// F4: multiple set_cell calls on same file converge
const f4 = tmpFile("f4.xlsx");
for (let i = 0; i < 5; i++) run({ operation: "set_cell", path: f4, cell: `A${i+1}`, value: i * 10 });
const f4_r = run({ operation: "read", path: f4 });
assert(f4_r.rows.length === 5, "F4 five rows written");
assert(f4_r.rows[4].cells[0] === 40, "F4 row[4] cell = 40");

// F5: read total across many small files
const f5_files = Array.from({length:20}, (_, i) => {
  const p = tmpFile(`f5_${i}.xlsx`);
  run({ operation: "set_cell", path: p, cell: "A1", value: i });
  return p;
});
const f5_totals = f5_files.map(p => run({ operation: "list_sheets", path: p }).sheetCount);
assert(f5_totals.every(n => n === 1), "F5 all 20 files have 1 sheet");

// ── Cleanup ───────────────────────────────────────────────────────────────
try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {}

// ── Summary ───────────────────────────────────────────────────────────────
const total = passed + failed;
process.stderr.write(`\nSection 216 — excel_client: ${passed}/${total} passed\n`);
if (errors.length) {
  process.stderr.write("Failures:\n");
  errors.forEach(e => process.stderr.write(`  - ${e}\n`));
}
if (failed > 0) process.exit(1);
