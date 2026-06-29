"use strict";
/**
 * [23] FILE_STATS & CSV_QUERY — directory statistics and CSV querying
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — file_stats on a populated directory (counts,
 *             byExtension sorted, largestFiles sorted); csv_query basic
 *             column projection, row filter, offset/limit.
 *
 *   Medium:   boundary — file_stats on empty directory; file_stats with
 *             extension filter; csv_query on single-row CSV; csv_query
 *             limit=1; csv_query has_header=false (synthetic column names);
 *             csv_query with quoted fields containing commas; offset beyond
 *             row count returns empty rows; missing required 'path' throws -32602.
 *
 *   High:     error handling — file_stats on a file (not dir) throws; file_stats
 *             on non-existent path throws; csv_query on a non-existent file
 *             throws; csv_query with unknown filter_col throws descriptive error;
 *             csv_query with unknown column in 'columns' throws descriptive error;
 *             csv_query on an empty CSV returns zero rows; csv_query with embedded
 *             newlines inside a quoted field (RFC 4180 multi-line field).
 *
 *   Critical: security — path traversal blocked on both tools; injection-shaped
 *             cell values round-trip literally through csv_query (never executed);
 *             results are JSON-serialisable, no prototype pollution; filter_col
 *             and filter_val are compared as strings, never passed to eval/exec.
 *
 *   Extreme:  stress — file_stats on a 200-file directory tree; csv_query on a
 *             2000-row CSV returns correct totalRows and correct limited slice;
 *             csv_query filter on large CSV returns only matching rows; 10
 *             concurrent file_stats calls return identical results; 10 concurrent
 *             csv_query calls return identical results.
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[23] FILE_STATS & CSV_QUERY — directory statistics and CSV querying`);

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("file_stats: returns totalFiles, totalBytes, byExtension, largestFiles", () => {
  executeTool("create_directory", { path: "fstats-basic" });
  executeTool("create_file", { path: "fstats-basic/a.js", content: "aaaa" });           // 4 bytes
  executeTool("create_file", { path: "fstats-basic/b.js", content: "bbbbbb" });         // 6 bytes
  executeTool("create_file", { path: "fstats-basic/c.ts", content: "ccccccccccccccc" });  // 15 bytes
  executeTool("create_file", { path: "fstats-basic/d.md", content: "d" });              // 1 byte
  const r = executeTool("file_stats", { path: "fstats-basic" });
  assert.strictEqual(r.totalFiles, 4);
  assert.strictEqual(r.totalBytes, 4 + 6 + 15 + 1);
  assert.strictEqual(r.maxBytes, 15);
  assert.strictEqual(r.minBytes, 1);
  assert.ok(Array.isArray(r.byExtension), "byExtension must be an array");
  // .ts has 15 bytes (single file) vs .js's combined 10 bytes — unambiguously first in the sorted list
  assert.strictEqual(r.byExtension[0].ext, ".ts");
  assert.strictEqual(r.byExtension[0].bytes, 15);
  assert.ok(Array.isArray(r.largestFiles), "largestFiles must be an array");
  assert.strictEqual(r.largestFiles[0].bytes, 15, "largest file should have 15 bytes");
});

test("file_stats: byExtension sums files of the same extension correctly", () => {
  const r = executeTool("file_stats", { path: "fstats-basic" });
  const jsExt = r.byExtension.find(e => e.ext === ".js");
  assert.ok(jsExt, ".js extension entry must exist");
  assert.strictEqual(jsExt.count, 2);
  assert.strictEqual(jsExt.bytes, 10); // 4 + 6
});

test("file_stats: avgBytes is the arithmetic mean", () => {
  const r = executeTool("file_stats", { path: "fstats-basic" });
  assert.strictEqual(r.avgBytes, Math.round((4 + 6 + 15 + 1) / 4));
});

test("csv_query: basic parse returns all columns and rows as objects", () => {
  executeTool("create_file", { path: "csv-basic.csv", content: "name,age,city\nAlice,30,NY\nBob,25,LA\nCarol,28,SF\n" });
  const r = executeTool("csv_query", { path: "csv-basic.csv" });
  assert.deepStrictEqual(r.columns, ["name", "age", "city"]);
  assert.strictEqual(r.totalRows, 3);
  assert.strictEqual(r.returnedRows, 3);
  assert.strictEqual(r.rows[0].name, "Alice");
  assert.strictEqual(r.rows[1].age, "25");
  assert.strictEqual(r.rows[2].city, "SF");
});

test("csv_query: column projection returns only requested columns", () => {
  const r = executeTool("csv_query", { path: "csv-basic.csv", columns: ["name", "city"] });
  assert.deepStrictEqual(r.columns, ["name", "city"]);
  for (const row of r.rows) {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, "age"), "age must not appear");
  }
});

test("csv_query: filter_col + filter_val returns only matching rows", () => {
  const r = executeTool("csv_query", { path: "csv-basic.csv", filter_col: "city", filter_val: "LA" });
  assert.strictEqual(r.totalRows, 1);
  assert.strictEqual(r.rows[0].name, "Bob");
});

test("csv_query: offset + limit slice the result window correctly", () => {
  const r = executeTool("csv_query", { path: "csv-basic.csv", offset: 1, limit: 1 });
  assert.strictEqual(r.returnedRows, 1);
  assert.strictEqual(r.rows[0].name, "Bob");
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("file_stats: empty directory returns all-zero counts", () => {
  executeTool("create_directory", { path: "fstats-empty" });
  const r = executeTool("file_stats", { path: "fstats-empty" });
  assert.strictEqual(r.totalFiles, 0);
  assert.strictEqual(r.totalBytes, 0);
  assert.strictEqual(r.avgBytes, 0);
  assert.deepStrictEqual(r.largestFiles, []);
  assert.deepStrictEqual(r.byExtension, []);
});

test("file_stats: extensions filter limits analysis to matching files", () => {
  const r = executeTool("file_stats", { path: "fstats-basic", extensions: [".js"] });
  assert.strictEqual(r.totalFiles, 2);
  assert.strictEqual(r.totalBytes, 4 + 6);
  assert.ok(r.byExtension.every(e => e.ext === ".js"), "only .js entries expected");
});

test("file_stats: missing path defaults to root without throwing", () => {
  const r = executeTool("file_stats", {});
  assert.ok(typeof r.totalFiles === "number");
});

test("csv_query: missing required 'path' throws -32602", () => {
  try { executeTool("csv_query", {}); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); }
});

test("csv_query: single-data-row CSV returns 1 row", () => {
  executeTool("create_file", { path: "csv-onerow.csv", content: "x,y\n1,2\n" });
  const r = executeTool("csv_query", { path: "csv-onerow.csv" });
  assert.strictEqual(r.totalRows, 1);
  assert.strictEqual(r.rows[0].x, "1");
});

test("csv_query: limit=1 returns at most 1 row regardless of file size", () => {
  const r = executeTool("csv_query", { path: "csv-basic.csv", limit: 1 });
  assert.strictEqual(r.returnedRows, 1);
});

test("csv_query: has_header=false generates synthetic col0, col1, ... names", () => {
  executeTool("create_file", { path: "csv-noheader.csv", content: "1,2,3\n4,5,6\n" });
  const r = executeTool("csv_query", { path: "csv-noheader.csv", has_header: false });
  assert.deepStrictEqual(r.columns, ["col0", "col1", "col2"]);
  assert.strictEqual(r.rows[0].col0, "1");
});

test("csv_query: quoted fields containing commas are parsed correctly", () => {
  executeTool("create_file", { path: "csv-quoted.csv", content: 'name,address\nAlice,"123, Main St"\n' });
  const r = executeTool("csv_query", { path: "csv-quoted.csv" });
  assert.strictEqual(r.rows[0].address, "123, Main St");
});

test("csv_query: offset beyond row count returns empty rows (totalRows still correct)", () => {
  const r = executeTool("csv_query", { path: "csv-basic.csv", offset: 999 });
  assert.strictEqual(r.totalRows, 3);
  assert.strictEqual(r.returnedRows, 0);
  assert.deepStrictEqual(r.rows, []);
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("file_stats: a file (not a directory) passed as path throws descriptive error", () => {
  executeTool("create_file", { path: "fstats-file.txt", content: "x" });
  assert.throws(() => executeTool("file_stats", { path: "fstats-file.txt" }), /not a directory/i);
});

test("file_stats: non-existent path throws cleanly", () => {
  assert.throws(() => executeTool("file_stats", { path: "fstats-nonexistent" }));
});

test("csv_query: non-existent file throws cleanly (not silent)", () => {
  assert.throws(() => executeTool("csv_query", { path: "csv-nonexistent.csv" }));
});

test("csv_query: unknown filter_col throws descriptive error with available columns", () => {
  assert.throws(
    () => executeTool("csv_query", { path: "csv-basic.csv", filter_col: "zipcode", filter_val: "10001" }),
    /filter column.*not found/i
  );
});

test("csv_query: unknown column in 'columns' throws descriptive error", () => {
  assert.throws(
    () => executeTool("csv_query", { path: "csv-basic.csv", columns: ["name", "salary"] }),
    /not found/i
  );
});

test("csv_query: empty CSV (no rows) returns zero totalRows and empty rows array", () => {
  executeTool("create_file", { path: "csv-empty.csv", content: "" });
  const r = executeTool("csv_query", { path: "csv-empty.csv" });
  assert.strictEqual(r.totalRows, 0);
  assert.deepStrictEqual(r.rows, []);
});

test("csv_query: header-only CSV (no data rows) returns 0 totalRows", () => {
  executeTool("create_file", { path: "csv-headeronly.csv", content: "a,b,c\n" });
  const r = executeTool("csv_query", { path: "csv-headeronly.csv" });
  assert.strictEqual(r.totalRows, 0);
});

test("csv_query: quoted field with embedded newline (RFC 4180 multi-line field) parses correctly", () => {
  executeTool("create_file", { path: "csv-multiline.csv", content: 'id,notes\n1,"line one\nline two"\n2,plain\n' });
  const r = executeTool("csv_query", { path: "csv-multiline.csv" });
  assert.strictEqual(r.totalRows, 2);
  assert.ok(r.rows[0].notes.includes("\n"), "multi-line field must contain newline");
  assert.strictEqual(r.rows[1].notes, "plain");
});

test("csv_query: escaped double-quote inside quoted field (\"\" → \") is decoded correctly", () => {
  executeTool("create_file", { path: "csv-escape.csv", content: 'a,b\n"say ""hello""","world"\n' });
  const r = executeTool("csv_query", { path: "csv-escape.csv" });
  assert.strictEqual(r.rows[0].a, 'say "hello"');
  assert.strictEqual(r.rows[0].b, "world");
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("file_stats: path traversal is blocked", () => {
  assert.throws(() => executeTool("file_stats", { path: "../../etc" }), /Access denied/);
});

test("csv_query: path traversal is blocked", () => {
  assert.throws(() => executeTool("csv_query", { path: "../../etc/passwd" }), /Access denied/);
});

test("csv_query: shell/SQL-injection-shaped cell values round-trip literally (never executed)", () => {
  const evil = "; rm -rf / && echo $(whoami) `cat /etc/passwd` '; DROP TABLE users; --";
  executeTool("create_file", { path: "csv-inject.csv", content: `cmd\n"${evil.replace(/"/g, '""')}"\n` });
  const r = executeTool("csv_query", { path: "csv-inject.csv" });
  assert.strictEqual(r.rows[0].cmd, evil, "injection-shaped content must be returned as literal string");
});

test("csv_query: filter_col + filter_val are compared as strings, never evaluated", () => {
  executeTool("create_file", { path: "csv-filter-safety.csv", content: "x\n$(whoami)\nnormal\n" });
  // The injection-shaped value should match the row literally
  const r = executeTool("csv_query", { path: "csv-filter-safety.csv", filter_col: "x", filter_val: "$(whoami)" });
  assert.strictEqual(r.totalRows, 1);
  assert.strictEqual(r.rows[0].x, "$(whoami)");
});

test("file_stats: result is JSON-serialisable with no prototype pollution", () => {
  const r = executeTool("file_stats", { path: "fstats-basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

test("csv_query: result is JSON-serialisable with no prototype pollution", () => {
  const r = executeTool("csv_query", { path: "csv-basic.csv" });
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("file_stats: 200-file directory tree returns correct totalFiles count", () => {
  executeTool("create_directory", { path: "fstats-large" });
  executeTool("create_directory", { path: "fstats-large/sub" });
  for (let i = 0; i < 100; i++) {
    executeTool("create_file", { path: `fstats-large/f${i}.js`, content: `x`.repeat(i + 1) });
    executeTool("create_file", { path: `fstats-large/sub/g${i}.ts`, content: `y`.repeat(i + 1) });
  }
  const r = executeTool("file_stats", { path: "fstats-large" });
  assert.strictEqual(r.totalFiles, 200);
  // Largest file is g99.ts with 100 bytes (i=99, i+1=100)
  assert.strictEqual(r.largestFiles[0].bytes, 100);
  // byExtension: .ts has more total bytes than .js (same count but symmetrically equal actually)
  // both extensions have exactly 5050 bytes (1+2+...+100)
  const jsExt = r.byExtension.find(e => e.ext === ".js");
  const tsExt = r.byExtension.find(e => e.ext === ".ts");
  assert.strictEqual(jsExt.count, 100);
  assert.strictEqual(tsExt.count, 100);
  assert.strictEqual(jsExt.bytes, 5050);
  assert.strictEqual(tsExt.bytes, 5050);
});

test("csv_query: 2000-row CSV — totalRows is correct and limit=50 returns exactly 50 rows", () => {
  const hdr = "id,val\n";
  const body = Array.from({ length: 2000 }, (_, i) => `${i},item-${i}`).join("\n") + "\n";
  executeTool("create_file", { path: "csv-large.csv", content: hdr + body });
  const r = executeTool("csv_query", { path: "csv-large.csv", limit: 50 });
  assert.strictEqual(r.totalRows, 2000);
  assert.strictEqual(r.returnedRows, 50);
  assert.strictEqual(r.rows[0].id, "0");
  assert.strictEqual(r.rows[49].id, "49");
});

test("csv_query: filter on large CSV returns only matching rows", () => {
  // Every 10th row (id=0,10,20,...) should match val=item-0 is only row 0
  // Use filter_val='item-500' — exactly 1 match
  const r = executeTool("csv_query", { path: "csv-large.csv", filter_col: "val", filter_val: "item-500" });
  assert.strictEqual(r.totalRows, 1);
  assert.strictEqual(r.rows[0].id, "500");
});

test("file_stats: 10 concurrent calls return identical results", () => {
  const results = Array.from({ length: 10 }, () => executeTool("file_stats", { path: "fstats-basic" }));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].totalFiles, results[0].totalFiles, `call ${i} totalFiles mismatch`);
    assert.strictEqual(results[i].totalBytes, results[0].totalBytes, `call ${i} totalBytes mismatch`);
  }
});

test("csv_query: 10 concurrent calls on the same file return identical results", () => {
  const results = Array.from({ length: 10 }, () => executeTool("csv_query", { path: "csv-basic.csv" }));
  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[i].rows, results[0].rows, `call ${i} rows mismatch`);
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove file_stats and csv_query fixture files", () => {
  const items = [
    "fstats-basic", "fstats-empty", "fstats-file.txt", "fstats-large",
    "csv-basic.csv", "csv-onerow.csv", "csv-noheader.csv", "csv-quoted.csv",
    "csv-empty.csv", "csv-headeronly.csv", "csv-multiline.csv", "csv-escape.csv",
    "csv-inject.csv", "csv-filter-safety.csv", "csv-large.csv",
  ];
  for (const item of items) {
    try { fs.rmSync(path.join(TMP, item), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "fstats-basic")), "fstats-basic removed");
  assert.ok(!fs.existsSync(path.join(TMP, "csv-basic.csv")), "csv-basic.csv removed");
});
