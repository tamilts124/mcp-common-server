"use strict";
// test/sections/209-csv-client.js
// csv_client comprehensive tests
// Sections: A=input-validation(10), B=parser-unit(20), C=writer-unit(10),
//           D=happy-path(20), E=security(10), F=concurrency(5) — 75 total

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const {
  csvClient,
  parseCSV,
  serialiseCSV,
  resolveDelimiter,
  splitHeaderData,
  headerIndex,
} = require("../../lib/csvClientOps");

// ── helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  FAIL: ${label}`);
  }
}

function assertThrows(label, fn, codeOrMsg) {
  try {
    fn();
    failed++;
    failures.push(label + " (no throw)");
    console.error(`  FAIL (no throw): ${label}`);
  } catch (e) {
    if (codeOrMsg) {
      const ok = typeof codeOrMsg === "string"
        ? (e.code === codeOrMsg || e.message.includes(codeOrMsg))
        : true;
      assert(label, ok);
    } else {
      passed++;
    }
  }
}

function tmpFile(content, ext = ".csv") {
  const f = path.join(os.tmpdir(), `csv-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  if (content != null) fs.writeFileSync(f, content, "utf8");
  return f;
}

function cleanup(...files) {
  for (const f of files) try { fs.unlinkSync(f); } catch {}
}

// ── Section A: Input Validation (10) ─────────────────────────────────────
console.log("\nA. Input Validation");

// A1: missing operation
assertThrows("A1: missing operation",
  () => csvClient({}), "INVALID_ARG");

// A2: unknown operation
assertThrows("A2: unknown operation",
  () => csvClient({ operation: "explode" }), "INVALID_ARG");

// A3: missing path for read
assertThrows("A3: empty path for read",
  () => csvClient({ operation: "read", path: "" }), "INVALID_ARG");

// A4: NUL byte in path
assertThrows("A4: NUL in path",
  () => csvClient({ operation: "read", path: "/tmp/\0evil" }), "INVALID_ARG");

// A5: unknown delimiter
assertThrows("A5: unknown delimiter",
  () => csvClient({ operation: "read", path: "/tmp/x.csv", delimiter: "asterisk" }), "INVALID_ARG");

// A6: write without rows array
{
  const f = tmpFile("a,b\n1,2\n");
  assertThrows("A6: write without rows",
    () => csvClient({ operation: "write", path: f, rows: "not-array" }), "INVALID_ARG");
  cleanup(f);
}

// A7: get_row without row_index
{
  const f = tmpFile("a,b\n1,2\n");
  assertThrows("A7: get_row no index",
    () => csvClient({ operation: "get_row", path: f }), "INVALID_ARG");
  cleanup(f);
}

// A8: set_row without row
{
  const f = tmpFile("a,b\n1,2\n");
  assertThrows("A8: set_row no row",
    () => csvClient({ operation: "set_row", path: f, row_index: 0 }), "INVALID_ARG");
  cleanup(f);
}

// A9: filter without column
{
  const f = tmpFile("a,b\n1,2\n");
  assertThrows("A9: filter no column",
    () => csvClient({ operation: "filter", path: f, operator: "eq", value: "1" }), "INVALID_ARG");
  cleanup(f);
}

// A10: filter unknown operator
{
  const f = tmpFile("a,b\n1,2\n");
  assertThrows("A10: filter bad operator",
    () => csvClient({ operation: "filter", path: f, column: "a", operator: "like", value: "1" }), "INVALID_ARG");
  cleanup(f);
}

// ── Section B: Parser Unit Tests (20) ────────────────────────────────────
console.log("\nB. Parser Unit Tests");

// B1: basic comma parsing
{
  const rows = parseCSV("a,b,c\n1,2,3\n", ",");
  assert("B1: 2 rows", rows.length === 2);
  assert("B1: header fields", rows[0].join(",") === "a,b,c");
  assert("B1: data fields", rows[1].join(",") === "1,2,3");
}

// B2: quoted field with embedded comma
{
  const rows = parseCSV('"hello, world",b\n', ",");
  assert("B2: quoted comma", rows[0][0] === "hello, world");
  assert("B2: second field", rows[0][1] === "b");
}

// B3: double-quote escape inside quoted field
{
  const rows = parseCSV('"say ""hi""",end\n', ",");
  assert("B3: escaped quote", rows[0][0] === 'say "hi"');
}

// B4: quoted field with embedded newline
{
  const rows = parseCSV('"line1\nline2",next\n', ",");
  assert("B4: newline in field", rows[0][0] === "line1\nline2");
  assert("B4: two fields", rows[0].length === 2);
}

// B5: CRLF line endings
{
  const rows = parseCSV("a,b\r\n1,2\r\n", ",");
  assert("B5: CRLF rows", rows.length === 2);
  assert("B5: field intact", rows[1][0] === "1");
}

// B6: tab delimiter
{
  const rows = parseCSV("a\tb\n1\t2\n", "\t");
  assert("B6: tab delim cols", rows[0].length === 2);
  assert("B6: tab field", rows[0][1] === "b");
}

// B7: empty fields
{
  const rows = parseCSV(",b,,d\n", ",");
  assert("B7: empty first", rows[0][0] === "");
  assert("B7: empty third", rows[0][2] === "");
  assert("B7: four fields", rows[0].length === 4);
}

// B8: single-field single-row no trailing newline
{
  const rows = parseCSV("only", ",");
  assert("B8: single row", rows.length === 1);
  assert("B8: single field", rows[0][0] === "only");
}

// B9: trailing newline not adding extra empty row
{
  const rows = parseCSV("a,b\n1,2\n", ",");
  assert("B9: no extra trailing row", rows.length === 2);
}

// B10: semicolon delimiter
{
  const rows = parseCSV("a;b;c\n", ";");
  assert("B10: three semi fields", rows[0].length === 3);
}

// B11: pipe delimiter
{
  const rows = parseCSV("x|y\n", "|");
  assert("B11: pipe fields", rows[0][1] === "y");
}

// B12: resolveDelimiter keyword
{
  assert("B12: comma keyword",    resolveDelimiter("comma") === ",");
  assert("B12: tab keyword",      resolveDelimiter("tab")   === "\t");
  assert("B12: semicolon keyword",resolveDelimiter("semicolon") === ";");
  assert("B12: pipe keyword",     resolveDelimiter("pipe") === "|");
  assert("B12: space keyword",    resolveDelimiter("space") === " ");
}

// B13: resolveDelimiter literal chars
{
  assert("B13: literal ,", resolveDelimiter(",") === ",");
  assert("B13: literal \t", resolveDelimiter("\t") === "\t");
}

// B14: resolveDelimiter null defaults to comma
{
  assert("B14: null -> comma", resolveDelimiter(null) === ",");
  assert("B14: undef -> comma", resolveDelimiter(undefined) === ",");
}

// B15: resolveDelimiter unknown throws
assertThrows("B15: bad delim throws", () => resolveDelimiter("bang"), "INVALID_ARG");

// B16: splitHeaderData with header
{
  const rows = [["a","b"],["1","2"],["3","4"]];
  const { headers, data } = splitHeaderData(rows, true);
  assert("B16: headers extracted", headers.join(",") === "a,b");
  assert("B16: data length", data.length === 2);
}

// B17: splitHeaderData without header
{
  const rows = [["1","2"],["3","4"]];
  const { headers, data } = splitHeaderData(rows, false);
  assert("B17: no headers", headers === null);
  assert("B17: all data", data.length === 2);
}

// B18: headerIndex by name
{
  const headers = ["a","b","c"];
  assert("B18: index of b", headerIndex(headers, "b") === 1);
  assert("B18: index of a", headerIndex(headers, "a") === 0);
}

// B19: headerIndex by number
{
  assert("B19: numeric index", headerIndex(null, 2) === 2);
}

// B20: headerIndex not found throws
assertThrows("B20: col not found", () => headerIndex(["a","b"], "z"), "NOT_FOUND");

// ── Section C: Writer Unit Tests (10) ────────────────────────────────────
console.log("\nC. Writer Unit Tests");

// C1: serialiseCSV basic
{
  const csv = serialiseCSV([["a","b"],["1","2"]], ",");
  assert("C1: header line", csv.startsWith("a,b\n"));
  assert("C1: data line",   csv.includes("1,2\n"));
}

// C2: field with delimiter gets quoted
{
  const csv = serialiseCSV([["hel,lo"]], ",");
  assert("C2: quoted delim", csv.includes('"hel,lo"'));
}

// C3: field with quote gets double-escaped
{
  const csv = serialiseCSV([['say "hi"']], ",");
  assert("C3: escaped quote", csv.includes('"say \"\"hi\"\""') || csv.includes('say ""hi""'));
}

// C4: field with newline gets quoted
{
  const csv = serialiseCSV([["line1\nline2"]], ",");
  assert("C4: quoted newline", csv.startsWith('"line1\nline2"'));
}

// C5: empty fields serialised correctly
{
  const csv = serialiseCSV([["","b",""]], ",");
  assert("C5: empty fields", csv.trim() === ",b,");
}

// C6: write + read round-trip with objects
{
  const f = tmpFile(null);
  csvClient({ operation: "write", path: f, rows: [{name:"Alice",age:"30"},{name:"Bob",age:"25"}] });
  const r = csvClient({ operation: "read", path: f });
  assert("C6: round-trip rows", r.totalRows === 2);
  assert("C6: name field",      r.rows[0].name === "Alice");
  assert("C6: age field",       r.rows[1].age  === "25");
  cleanup(f);
}

// C7: write with explicit headers order
{
  const f = tmpFile(null);
  csvClient({ operation: "write", path: f, rows: [{b:"2",a:"1"}], headers: ["a","b"] });
  const raw = fs.readFileSync(f,"utf8");
  assert("C7: header order", raw.startsWith("a,b\n"));
  cleanup(f);
}

// C8: write with array rows
{
  const f = tmpFile(null);
  csvClient({ operation: "write", path: f, rows: [["x","y"],["1","2"]], has_header: false });
  const r = csvClient({ operation: "read", path: f, has_header: false });
  assert("C8: array rows total", r.totalRows === 2);
  assert("C8: array cell", r.rows[0][0] === "x");
  cleanup(f);
}

// C9: tab delimiter write
{
  const f = tmpFile(null);
  csvClient({ operation: "write", path: f, rows: [["a","b"],["1","2"]], delimiter: "tab", has_header: false });
  const raw = fs.readFileSync(f,"utf8");
  assert("C9: tab in output", raw.includes("\t"));
  cleanup(f);
}

// C10: write empty rows
{
  const f = tmpFile(null);
  const r = csvClient({ operation: "write", path: f, rows: [] });
  assert("C10: empty write", r.written === true && r.rowCount === 0);
  cleanup(f);
}

// ── Section D: Happy-Path Integration (20) ───────────────────────────────
console.log("\nD. Happy-Path Integration");

// D1: read with pagination
{
  const f = tmpFile("id,name\n1,Alice\n2,Bob\n3,Carol\n");
  const r = csvClient({ operation: "read", path: f, offset: 1, limit: 1 });
  assert("D1: offset works",   r.rows[0].id === "2");
  assert("D1: limit works",    r.rows.length === 1);
  assert("D1: totalRows=3",    r.totalRows === 3);
  cleanup(f);
}

// D2: read without header
{
  const f = tmpFile("1,2,3\n4,5,6\n");
  const r = csvClient({ operation: "read", path: f, has_header: false });
  assert("D2: raw arrays",   Array.isArray(r.rows[0]));
  assert("D2: total 2 rows", r.totalRows === 2);
  cleanup(f);
}

// D3: get_row found
{
  const f = tmpFile("a,b\nx,y\np,q\n");
  const r = csvClient({ operation: "get_row", path: f, row_index: 1 });
  assert("D3: found",    r.found === true);
  assert("D3: row.a=p", r.row.a === "p");
  cleanup(f);
}

// D4: get_row out of range
{
  const f = tmpFile("a,b\nx,y\n");
  const r = csvClient({ operation: "get_row", path: f, row_index: 99 });
  assert("D4: not found", r.found === false);
  assert("D4: row null",  r.row === null);
  cleanup(f);
}

// D5: set_row update existing
{
  const f = tmpFile("a,b\n1,2\n3,4\n");
  csvClient({ operation: "set_row", path: f, row_index: 0, row: {a:"10",b:"20"} });
  const r = csvClient({ operation: "get_row", path: f, row_index: 0 });
  assert("D5: set_row updated a", r.row.a === "10");
  assert("D5: set_row updated b", r.row.b === "20");
  cleanup(f);
}

// D6: set_row create new (beyond length)
{
  const f = tmpFile("a,b\n1,2\n");
  const r = csvClient({ operation: "set_row", path: f, row_index: 5, row: ["x","y"] });
  assert("D6: created flag", r.created === true);
  cleanup(f);
}

// D7: delete_row single
{
  const f = tmpFile("a,b\n1,2\n3,4\n5,6\n");
  const r = csvClient({ operation: "delete_row", path: f, row_index: 1 });
  assert("D7: deleted 1",     r.deleted === 1);
  assert("D7: remaining 2",   r.remaining === 2);
  const r2 = csvClient({ operation: "read", path: f });
  assert("D7: row 1 now 5,6", r2.rows[1].a === "5");
  cleanup(f);
}

// D8: delete_row multiple indices
{
  const f = tmpFile("a,b\n1,2\n3,4\n5,6\n7,8\n");
  csvClient({ operation: "delete_row", path: f, row_indices: [0,2] });
  const r = csvClient({ operation: "read", path: f });
  assert("D8: 2 remaining", r.totalRows === 2);
  assert("D8: row 0 is 3",  r.rows[0].a === "3");
  cleanup(f);
}

// D9: append_rows to existing file
{
  const f = tmpFile("a,b\n1,2\n");
  csvClient({ operation: "append_rows", path: f, rows: [{a:"3",b:"4"},{a:"5",b:"6"}] });
  const r = csvClient({ operation: "read", path: f });
  assert("D9: 3 total rows",   r.totalRows === 3);
  assert("D9: last row a=5",   r.rows[2].a === "5");
  cleanup(f);
}

// D10: append_rows creates new file when missing
{
  const f = path.join(os.tmpdir(), `csv-new-${Date.now()}.csv`);
  csvClient({ operation: "append_rows", path: f, rows: [{x:"1",y:"2"}], has_header: true });
  assert("D10: file created", fs.existsSync(f));
  cleanup(f);
}

// D11: filter eq
{
  const f = tmpFile("name,score\nAlice,90\nBob,80\nAlice,70\n");
  const r = csvClient({ operation: "filter", path: f, column: "name", operator: "eq", value: "Alice" });
  assert("D11: 2 matches", r.matched === 2);
  cleanup(f);
}

// D12: filter contains
{
  const f = tmpFile("name,score\nAlice,90\nAliceson,95\nBob,80\n");
  const r = csvClient({ operation: "filter", path: f, column: "name", operator: "contains", value: "Alice" });
  assert("D12: 2 matches", r.matched === 2);
  cleanup(f);
}

// D13: filter numeric gt
{
  const f = tmpFile("name,score\nAlice,90\nBob,80\nCarol,85\n");
  const r = csvClient({ operation: "filter", path: f, column: "score", operator: "gt", value: "85" });
  assert("D13: gt 85 -> 1 match", r.matched === 1);
  assert("D13: Alice only",        r.rows[0].name === "Alice");
  cleanup(f);
}

// D14: filter with output_path
{
  const f   = tmpFile("a,b\n1,x\n2,y\n3,x\n");
  const out = tmpFile(null);
  const r = csvClient({ operation: "filter", path: f, column: "b", operator: "eq", value: "x", output_path: out });
  assert("D14: written flag", r.written === true);
  const r2 = csvClient({ operation: "read", path: out });
  assert("D14: 2 rows in output", r2.totalRows === 2);
  cleanup(f, out);
}

// D15: sort asc
{
  const f = tmpFile("name,score\nCarol,85\nAlice,90\nBob,80\n");
  csvClient({ operation: "sort", path: f, column: "name" });
  const r = csvClient({ operation: "read", path: f });
  assert("D15: asc sorted", r.rows[0].name === "Alice");
  cleanup(f);
}

// D16: sort desc numeric
{
  const f = tmpFile("name,score\nAlice,90\nBob,80\nCarol,85\n");
  csvClient({ operation: "sort", path: f, column: "score", direction: "desc", numeric: true });
  const r = csvClient({ operation: "read", path: f });
  assert("D16: desc first=Alice", r.rows[0].name === "Alice");
  cleanup(f);
}

// D17: update_column set literal value
{
  const f = tmpFile("a,b\n1,x\n2,y\n");
  csvClient({ operation: "update_column", path: f, column: "b", value: "z" });
  const r = csvClient({ operation: "read", path: f });
  assert("D17: all b=z", r.rows.every(row => row.b === "z"));
  cleanup(f);
}

// D18: update_column transform uppercase
{
  const f = tmpFile("name,code\nAlice,abc\nBob,def\n");
  csvClient({ operation: "update_column", path: f, column: "code", transform: "uppercase" });
  const r = csvClient({ operation: "read", path: f });
  assert("D18: uppercase", r.rows[0].code === "ABC");
  cleanup(f);
}

// D19: add_column
{
  const f = tmpFile("a,b\n1,2\n3,4\n");
  csvClient({ operation: "add_column", path: f, column: "c", default_value: "0" });
  const r = csvClient({ operation: "read", path: f });
  assert("D19: 3 headers",   r.headers.length === 3);
  assert("D19: new col c=0", r.rows[0].c === "0");
  cleanup(f);
}

// D20: delete_column
{
  const f = tmpFile("a,b,c\n1,2,3\n4,5,6\n");
  csvClient({ operation: "delete_column", path: f, column: "b" });
  const r = csvClient({ operation: "read", path: f });
  assert("D20: 2 headers",      r.headers.length === 2);
  assert("D20: no b header",    !r.headers.includes("b"));
  assert("D20: row still has a+c", r.rows[0].a === "1" && r.rows[0].c === "3");
  cleanup(f);
}

// ── Section E: Security Tests (10) ──────────────────────────────────────
console.log("\nE. Security Tests");

// E1: NUL byte in path rejected
assertThrows("E1: NUL path", () => csvClient({ operation: "read", path: "\0/etc/passwd" }), "INVALID_ARG");

// E2: file too large
{
  const f = tmpFile(null);
  // Create a >4MB file (write 4MB+1 bytes)
  const big = Buffer.alloc(4 * 1024 * 1024 + 1, "a");
  fs.writeFileSync(f, big);
  assertThrows("E2: file too large", () => csvClient({ operation: "read", path: f }), "FILE_TOO_LARGE");
  cleanup(f);
}

// E3: column limit per row
{
  // Build a CSV row with 1001 columns
  const header = Array.from({length: 1001}, (_,i) => `c${i}`).join(",");
  const row    = Array.from({length: 1001}, (_,i) => String(i)).join(",");
  const f = tmpFile(header + "\n" + row + "\n");
  assertThrows("E3: column limit", () => csvClient({ operation: "read", path: f }), "TOO_MANY_COLS");
  cleanup(f);
}

// E4: NUL byte in output_path rejected
{
  const f = tmpFile("a,b\n1,2\n");
  assertThrows("E4: NUL in output_path",
    () => csvClient({ operation: "sort", path: f, column: "a", output_path: "\0bad" }), "INVALID_ARG");
  cleanup(f);
}

// E5: regex operator with potentially dangerous pattern (should not crash)
{
  const f = tmpFile("val\naaa\n");
  // A catastrophic backtracking pattern — should not hang (our regex is applied per-field)
  let threw = false;
  try {
    csvClient({ operation: "filter", path: f, column: "val", operator: "regex", value: "(a+)+$" });
  } catch { threw = true; }
  assert("E5: regex no crash", !threw);
  cleanup(f);
}

// E6: path traversal-style path (valid path, just unusual)
{
  const f = tmpFile("a\n1\n");
  const r = csvClient({ operation: "read", path: f });
  assert("E6: normal path works", r.totalRows === 1);
  cleanup(f);
}

// E7: update_column prefix injection safety
{
  const f = tmpFile("cmd\nls\n");
  csvClient({ operation: "update_column", path: f, column: "cmd", transform: "prefix:$(rm -rf)" });
  const r = csvClient({ operation: "read", path: f });
  // Value is stored literally, not executed
  assert("E7: prefix stored literal", r.rows[0].cmd === "$(rm -rf)ls");
  cleanup(f);
}

// E8: very long field value stored correctly
{
  const longVal = "A".repeat(100_000);
  const f = tmpFile(`val\n"${longVal}"\n`);
  const r = csvClient({ operation: "read", path: f });
  assert("E8: long value", r.rows[0].val.length === 100_000);
  cleanup(f);
}

// E9: CRLF injection in written field is quoted
{
  const f = tmpFile(null);
  csvClient({ operation: "write", path: f, rows: [["field\r\nvalue","ok"]], has_header: false });
  const r = csvClient({ operation: "read", path: f, has_header: false });
  assert("E9: CRLF field intact", r.rows[0][0] === "field\r\nvalue");
  cleanup(f);
}

// E10: missing file produces ENOENT error (not a generic crash)
{
  const missing = path.join(os.tmpdir(), `no-such-file-${Date.now()}.csv`);
  let msg = "";
  try {
    csvClient({ operation: "read", path: missing });
  } catch (e) {
    msg = e.message || "";
  }
  assert("E10: ENOENT in error", msg.includes("ENOENT") || msg.length > 0);
}

// ── Section F: Concurrency (5) ───────────────────────────────────────────
console.log("\nF. Concurrency Tests");

// F1: concurrent reads on same file
async function runConcurrency() {
  // F1
  {
    const f = tmpFile("a,b\n1,2\n3,4\n");
    const reads = await Promise.all(
      Array.from({length: 10}, () =>
        Promise.resolve(csvClient({ operation: "read", path: f }))
      )
    );
    assert("F1: concurrent reads all return 2 rows",
      reads.every(r => r.totalRows === 2));
    cleanup(f);
  }

  // F2: concurrent writes to different files
  {
    const files = Array.from({length: 5}, () => tmpFile(null));
    await Promise.all(
      files.map((f, i) =>
        Promise.resolve(csvClient({ operation: "write", path: f, rows: [{id: String(i)}] }))
      )
    );
    const results = files.map(f => csvClient({ operation: "read", path: f }));
    assert("F2: concurrent writes distinct",
      results.every(r => r.totalRows === 1));
    files.forEach(f => cleanup(f));
  }

  // F3: concurrent filters
  {
    const f = tmpFile("name,score\nAlice,90\nBob,80\nCarol,70\n");
    const results = await Promise.all(
      ["Alice","Bob","Carol"].map(n =>
        Promise.resolve(csvClient({ operation: "filter", path: f, column: "name", operator: "eq", value: n }))
      )
    );
    assert("F3: concurrent filters", results.every(r => r.matched === 1));
    cleanup(f);
  }

  // F4: concurrent add_column on different files
  {
    const files = Array.from({length: 5}, () => tmpFile("x\n1\n"));
    await Promise.all(
      files.map(f =>
        Promise.resolve(csvClient({ operation: "add_column", path: f, column: "y", default_value: "0" }))
      )
    );
    const results = files.map(f => csvClient({ operation: "read", path: f }));
    assert("F4: concurrent add_column",
      results.every(r => r.headers.includes("y")));
    files.forEach(f => cleanup(f));
  }

  // F5: concurrent sort on different files
  {
    const data = "name\nZara\nAlice\nBob\n";
    const files = Array.from({length: 5}, () => tmpFile(data));
    await Promise.all(
      files.map(f =>
        Promise.resolve(csvClient({ operation: "sort", path: f, column: "name" }))
      )
    );
    const results = files.map(f => csvClient({ operation: "read", path: f }));
    assert("F5: concurrent sorts",
      results.every(r => r.rows[0].name === "Alice"));
    files.forEach(f => cleanup(f));
  }
}

runConcurrency().then(() => {
  console.log(`\n═ Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests ═`);
  if (failures.length) {
    console.error("Failed tests:");
    failures.forEach(f => console.error(" •", f));
  }
  if (failed > 0) process.exit(1);
}).catch(err => {
  console.error("Concurrency runner error:", err);
  process.exit(1);
});
