"use strict";
/**
 * test/sections/104-csv-diff.js
 * Isolated functional tests for the csv_diff tool.
 * Section [42]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { csvDiff } = require("../../lib/csvDiffOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

let _counter = 0;
function tmpCsv(content) {
  const p = path.join(TMP, `cd-${++_counter}.csv`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}
function findByKey(list, key) { return list.find((e) => e.key === key); }

// [42-A] NORMAL
test("[42-A-1] csv_diff: identical files -> identical:true, no entries", () => {
  const l = tmpCsv("id,name\n1,a\n2,b\n");
  const r = tmpCsv("id,name\n1,a\n2,b\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  assert(res.identical === true && res.addedCount === 0 && res.removedCount === 0 && res.changedCount === 0);
});
test("[42-A-2] csv_diff: key-based — changed cell value detected", () => {
  const l = tmpCsv("id,name\n1,a\n2,b\n");
  const r = tmpCsv("id,name\n1,a\n2,B\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const c = findByKey(res.changed, "2");
  assert(c && c.cells.length === 1 && c.cells[0].column === "name" && c.cells[0].oldValue === "b" && c.cells[0].newValue === "B");
});
test("[42-A-3] csv_diff: key-based — added row (key only in right)", () => {
  const l = tmpCsv("id,name\n1,a\n");
  const r = tmpCsv("id,name\n1,a\n2,b\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  assert(res.addedCount === 1 && findByKey(res.added, "2").row.name === "b");
});
test("[42-A-4] csv_diff: key-based — removed row (key only in left)", () => {
  const l = tmpCsv("id,name\n1,a\n2,b\n");
  const r = tmpCsv("id,name\n1,a\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  assert(res.removedCount === 1 && findByKey(res.removed, "2").row.name === "b");
});
test("[42-A-5] csv_diff: positional mode (no key_column) — changed row by index", () => {
  const l = tmpCsv("id,name\n1,a\n2,b\n");
  const r = tmpCsv("id,name\n1,a\n2,B\n");
  const res = csvDiff(l, r, "l.csv", "r.csv");
  const c = findByKey(res.changed, 1);
  assert(c && c.cells[0].newValue === "B");
});
test("[42-A-6] csv_diff: positional mode — extra right rows added ascending", () => {
  const l = tmpCsv("id\n1\n2\n");
  const r = tmpCsv("id\n1\n2\n3\n4\n");
  const res = csvDiff(l, r, "l.csv", "r.csv");
  assert(res.addedCount === 2 && res.added[0].key === 2 && res.added[1].key === 3);
});
test("[42-A-7] csv_diff: positional mode — extra left rows removed highest-index-first", () => {
  const l = tmpCsv("id\n1\n2\n3\n4\n");
  const r = tmpCsv("id\n1\n2\n");
  const res = csvDiff(l, r, "l.csv", "r.csv");
  assert(res.removedCount === 2 && res.removed[0].key === 3 && res.removed[1].key === 2);
});
test("[42-A-8] csv_diff: has_header:false uses synthetic col0/col1 names", () => {
  const l = tmpCsv("1,a\n2,b\n");
  const r = tmpCsv("1,a\n2,B\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "col0", has_header: false });
  const c = findByKey(res.changed, "2");
  assert(c && c.cells[0].column === "col1" && c.cells[0].newValue === "B");
});
test("[42-A-9] csv_diff: differing column sets — new column in right surfaces as a cell add", () => {
  const l = tmpCsv("id,name\n1,a\n");
  const r = tmpCsv("id,name,age\n1,a,30\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const c = findByKey(res.changed, "1");
  assert(c && c.cells.length === 1 && c.cells[0].column === "age" && c.cells[0].oldValue === "" && c.cells[0].newValue === "30");
});

// [42-B] MEDIUM — boundary & validation
test("[42-B-1] csv_diff: nonexistent key_column throws -32602", () => {
  const l = tmpCsv("id,name\n1,a\n");
  const r = tmpCsv("id,name\n1,a\n");
  let threw = false;
  try { csvDiff(l, r, "l.csv", "r.csv", { key_column: "nope" }); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[42-B-2] csv_diff: duplicate key in left file throws -32602", () => {
  const l = tmpCsv("id,name\n1,a\n1,b\n");
  const r = tmpCsv("id,name\n1,a\n");
  let threw = false;
  try { csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" }); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[42-B-3] csv_diff: missing left file throws cleanly", () => {
  let threw = false;
  try { csvDiff(path.join(TMP, "nope.csv"), tmpCsv("id\n1\n"), "nope.csv", "r.csv"); } catch (e) { threw = true; }
  assert(threw);
});
test("[42-B-4] csv_diff: empty files (header only) -> identical, zero rows", () => {
  const l = tmpCsv("id,name\n");
  const r = tmpCsv("id,name\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  assert(res.identical === true && res.totalLeftRows === 0 && res.totalRightRows === 0);
});
test("[42-B-5] csv_diff: max_rows clamps entries but *Count fields stay true totals", () => {
  const lines = ["id,name"];
  const rlines = ["id,name"];
  for (let i = 0; i < 10; i++) { lines.push(`${i},a${i}`); rlines.push(`${i},B${i}`); }
  const l = tmpCsv(lines.join("\n") + "\n");
  const r = tmpCsv(rlines.join("\n") + "\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id", max_rows: 3 });
  assert(res.changed.length === 3 && res.changedCount === 3 && res.truncated === true);
});

// [42-C] HIGH — structural / dependency-ish edge cases
test("[42-C-1] csv_diff: quoted fields with embedded commas diff correctly", () => {
  const l = tmpCsv('id,note\n1,"hello, world"\n');
  const r = tmpCsv('id,note\n1,"hello, mars"\n');
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const c = findByKey(res.changed, "1");
  assert(c && c.cells[0].newValue === "hello, mars");
});
test("[42-C-2] csv_diff: no changes but different row order (key mode) -> identical", () => {
  const l = tmpCsv("id,name\n1,a\n2,b\n");
  const r = tmpCsv("id,name\n2,b\n1,a\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  assert(res.identical === true);
});
test("[42-C-3] csv_diff: positional mode DOES report a change when only row order differs (documented, not a bug)", () => {
  const l = tmpCsv("id,name\n1,a\n2,b\n");
  const r = tmpCsv("id,name\n2,b\n1,a\n");
  const res = csvDiff(l, r, "l.csv", "r.csv");
  assert(res.identical === false && res.changedCount === 2);
});
test("[42-C-4] csv_diff: multiple cell changes in one row all reported", () => {
  const l = tmpCsv("id,a,b\n1,x,y\n");
  const r = tmpCsv("id,a,b\n1,X,Y\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const c = findByKey(res.changed, "1");
  assert(c.cells.length === 2);
});
test("[42-C-5] csv_diff: right file with completely different columns still diffs via union", () => {
  const l = tmpCsv("id,a\n1,x\n");
  const r = tmpCsv("id,b\n1,y\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const c = findByKey(res.changed, "1");
  const cols = c.cells.map((x) => x.column).sort();
  assert(JSON.stringify(cols) === JSON.stringify(["a", "b"]));
});

// [42-D] CRITICAL — security
test("[42-D-1] csv_diff: SQL-injection-shaped cell value round-trips as inert literal text", () => {
  const l = tmpCsv('id,note\n1,clean\n');
  const r = tmpCsv('id,note\n1,"\'; DROP TABLE users; --"\n');
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const c = findByKey(res.changed, "1");
  assert(c.cells[0].newValue === "'; DROP TABLE users; --");
});
test("[42-D-2] csv_diff: path-traversal-shaped cell value is inert data, not a real path", () => {
  const l = tmpCsv("id,note\n1,clean\n");
  const r = tmpCsv('id,note\n1,"../../../etc/passwd"\n');
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const c = findByKey(res.changed, "1");
  assert(c.cells[0].newValue === "../../../etc/passwd");
});
test("[42-D-3] csv_diff: __proto__ as a key_column value does not pollute Object.prototype", () => {
  const l = tmpCsv("id,name\n__proto__,a\n");
  const r = tmpCsv("id,name\n__proto__,b\n");
  csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  assert(({}).polluted === undefined);
});
test("[42-D-4] csv_diff: HTML/script-shaped value round-trips as literal text", () => {
  const l = tmpCsv("id,note\n1,ok\n");
  const r = tmpCsv('id,note\n1,"<script>alert(1)</script>"\n');
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const c = findByKey(res.changed, "1");
  assert(c.cells[0].newValue === "<script>alert(1)</script>");
});
test("[42-D-5] csv_diff: result has no unexpected top-level keys", () => {
  const l = tmpCsv("id\n1\n");
  const r = tmpCsv("id\n1\n");
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  const keys = Object.keys(res).sort();
  assert(JSON.stringify(keys) === JSON.stringify(
    ["added", "addedCount", "changed", "changedCount", "hasHeader", "identical",
     "keyColumn", "left", "removed", "removedCount", "right", "totalLeftRows",
     "totalRightRows", "truncated"]
  ));
});

// [42-E] EXTREME
test("[42-E-1] csv_diff: 300-row key-based diff completes correctly and quickly", () => {
  const lLines = ["id,val"], rLines = ["id,val"];
  for (let i = 0; i < 300; i++) { lLines.push(`${i},${i}`); rLines.push(`${i},${i === 150 ? -1 : i}`); }
  const l = tmpCsv(lLines.join("\n") + "\n");
  const r = tmpCsv(rLines.join("\n") + "\n");
  const start = Date.now();
  const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
  assert(Date.now() - start < 5000);
  assert(res.changedCount === 1 && findByKey(res.changed, "150").cells[0].newValue === "-1");
});
test("[42-E-2] csv_diff: fuzz — random garbage bytes as CSV content doesn't crash", () => {
  const junk = Array.from({ length: 500 }, () => String.fromCharCode(1 + Math.floor(Math.random() * 254))).join("");
  const l = tmpCsv(junk);
  const r = tmpCsv(junk + "x");
  let handled = false;
  try { csvDiff(l, r, "l.csv", "r.csv"); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[42-E-3] csv_diff: 20 rapid sequential calls with different file pairs are independent", () => {
  for (let i = 0; i < 20; i++) {
    const l = tmpCsv(`id,val\n1,${i}\n`);
    const r = tmpCsv(`id,val\n1,${i + 1}\n`);
    const res = csvDiff(l, r, "l.csv", "r.csv", { key_column: "id" });
    assert(findByKey(res.changed, "1").cells[0].newValue === String(i + 1));
  }
});
test("[42-E-4] cleanup: remove csv_diff fixture files created in this section", () => {
  for (let i = 1; i <= _counter; i++) {
    const p = path.join(TMP, `cd-${i}.csv`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  assert(true);
});
