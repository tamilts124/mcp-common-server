"use strict";
/**
 * [40] CSV_QUERY AGGREGATE — group_by + aggregate (sum/avg/count/min/max)
 *
 * Tests the aggregate-mode extension to `csv_query`: a non-empty `aggregate`
 * array of {column, op} entries switches the tool from row-projection mode
 * into grouped-summary mode, optionally grouped via `group_by`.
 *
 * Rigor levels covered:
 *   Normal:   happy-path — single-group sum/avg/min/max/count, group_by with
 *             multiple aggregates in one call, count-without-column (row
 *             count) vs count-with-column (non-empty value count), result
 *             field naming and shape.
 *   Medium:   boundary — group_by without aggregate throws, empty aggregate
 *             array falls back to normal row mode (not an error), unknown op
 *             /missing required column/unknown column all throw -32602,
 *             duplicate result-field collision throws, offset/limit paginate
 *             groups, has_header:false works in aggregate mode.
 *   High:     dependency/data failures — non-numeric value in a sum/avg/min/max
 *             column throws a clear -32602 (not silent NaN); filter_col is
 *             applied before aggregation; an all-filtered-out table returns
 *             zero groups without crashing; non-existent file still throws.
 *   Critical: security — path traversal blocked; injection-shaped group
 *             values round-trip literally as group keys (never executed);
 *             malformed aggregate-entry shapes rejected; JSON-serialisable;
 *             no prototype pollution; aggregate array length capped.
 *   Extreme:  stress — 2000-row CSV grouped into few buckets with verified
 *             sums; many-distinct-group paginated with offset/limit; 10
 *             concurrent aggregate calls consistent; fuzz non-array/garbage
 *             `aggregate` values rejected cleanly.
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[40] CSV_QUERY AGGREGATE — group_by + aggregate (sum/avg/count/min/max)`);

// ── FIXTURE ────────────────────────────────────────────────────────────────────
// region,product,amount
// West,Widget,100
// West,Gadget,50
// East,Widget,75
// East,Widget,25
// East,Gadget,10
const SALES_CSV =
  "region,product,amount\n" +
  "West,Widget,100\n" +
  "West,Gadget,50\n" +
  "East,Widget,75\n" +
  "East,Widget,25\n" +
  "East,Gadget,10\n";

executeTool("create_file", { path: "agg-sales.csv", content: SALES_CSV });

function q(opts = {}) {
  return executeTool("csv_query", { path: "agg-sales.csv", ...opts });
}

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("csv_query aggregate: sum over the whole table (no group_by) returns one implicit group", () => {
  const r = q({ aggregate: [{ column: "amount", op: "sum" }] });
  assert.strictEqual(r.groupCount, 1);
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.groups[0].sum_amount, 260); // 100+50+75+25+10
  assert.ok(!Object.prototype.hasOwnProperty.call(r.groups[0], "group"), "no group_by => no 'group' key");
});

test("csv_query aggregate: avg/min/max compute correctly over the whole table", () => {
  const r = q({ aggregate: [
    { column: "amount", op: "avg" },
    { column: "amount", op: "min" },
    { column: "amount", op: "max" },
  ]});
  assert.strictEqual(r.groups[0].avg_amount, 260 / 5);
  assert.strictEqual(r.groups[0].min_amount, 10);
  assert.strictEqual(r.groups[0].max_amount, 100);
});

test("csv_query aggregate: count without column counts rows in the group", () => {
  const r = q({ aggregate: [{ op: "count" }] });
  assert.strictEqual(r.groups[0].count, 5);
});

test("csv_query aggregate: count with column counts non-empty values in that column", () => {
  const r = q({ aggregate: [{ column: "product", op: "count" }] });
  assert.strictEqual(r.groups[0].count_product, 5);
});

test("csv_query aggregate: group_by groups rows and computes per-group sums correctly", () => {
  const r = q({ group_by: "region", aggregate: [{ column: "amount", op: "sum" }] });
  assert.strictEqual(r.groupCount, 2);
  const east = r.groups.find(g => g.group === "East");
  const west = r.groups.find(g => g.group === "West");
  assert.strictEqual(east.sum_amount, 75 + 25 + 10);
  assert.strictEqual(west.sum_amount, 100 + 50);
});

test("csv_query aggregate: multiple aggregates in one call all appear on each group", () => {
  const r = q({ group_by: "region", aggregate: [
    { column: "amount", op: "sum" },
    { column: "amount", op: "avg" },
    { op: "count" },
  ]});
  const east = r.groups.find(g => g.group === "East");
  assert.strictEqual(east.sum_amount, 110);
  assert.strictEqual(east.avg_amount, 110 / 3);
  assert.strictEqual(east.count, 3);
});

test("csv_query aggregate: result echoes groupBy, aggregates spec, and counts", () => {
  const r = q({ group_by: "region", aggregate: [{ column: "amount", op: "sum" }] });
  assert.strictEqual(r.groupBy, "region");
  assert.deepStrictEqual(r.aggregates, [{ column: "amount", op: "sum", field: "sum_amount" }]);
  assert.strictEqual(r.totalRows, 5);
  assert.strictEqual(r.groupCount, 2);
  assert.strictEqual(r.returnedGroups, 2);
});

test("csv_query aggregate: groups are sorted deterministically by group key", () => {
  const r = q({ group_by: "region", aggregate: [{ op: "count" }] });
  const keys = r.groups.map(g => g.group);
  assert.deepStrictEqual(keys, [...keys].sort());
});

// ── MEDIUM — boundary & parameter validation ─────────────────────────────────

test("csv_query aggregate: group_by without aggregate throws -32602", () => {
  try { q({ group_by: "region" }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); }
});

test("csv_query aggregate: empty aggregate array falls back to normal row-projection mode", () => {
  const r = q({ aggregate: [] });
  assert.ok(Array.isArray(r.rows), "should behave like normal mode, not aggregate mode");
  assert.strictEqual(r.totalRows, 5);
});

test("csv_query aggregate: unknown op throws -32602 with allow-list in the message", () => {
  try { q({ aggregate: [{ column: "amount", op: "median" }] }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); assert.match(e.message, /sum|avg|count|min|max/); }
});

test("csv_query aggregate: 'sum' without a column throws -32602", () => {
  try { q({ aggregate: [{ op: "sum" }] }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); assert.match(e.message, /requires a 'column'/); }
});

test("csv_query aggregate: unknown aggregate column throws -32602 listing available columns", () => {
  try { q({ aggregate: [{ column: "profit", op: "sum" }] }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); assert.match(e.message, /not found/i); }
});

test("csv_query aggregate: unknown group_by column throws -32602", () => {
  try { q({ group_by: "country", aggregate: [{ op: "count" }] }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); assert.match(e.message, /not found/i); }
});

test("csv_query aggregate: duplicate result-field collision throws -32602", () => {
  try {
    q({ aggregate: [{ column: "amount", op: "sum" }, { column: "amount", op: "sum" }] });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); assert.match(e.message, /duplicate/i); }
});

test("csv_query aggregate: offset/limit paginate the group list, not raw rows", () => {
  const r = q({ group_by: "region", aggregate: [{ op: "count" }], limit: 1 });
  assert.strictEqual(r.returnedGroups, 1);
  assert.strictEqual(r.groupCount, 2, "groupCount reflects the true total regardless of the page size");
});

test("csv_query aggregate: has_header=false works with synthetic col0/col1 names", () => {
  executeTool("create_file", { path: "agg-noheader.csv", content: "West,10\nEast,20\nWest,5\n" });
  const r = executeTool("csv_query", {
    path: "agg-noheader.csv", has_header: false,
    group_by: "col0", aggregate: [{ column: "col1", op: "sum" }],
  });
  const west = r.groups.find(g => g.group === "West");
  assert.strictEqual(west.sum_col1, 15);
});

// ── HIGH — dependency / data failures ─────────────────────────────────────────

test("csv_query aggregate: non-numeric value in a sum column throws a clear -32602, not silent NaN", () => {
  executeTool("create_file", { path: "agg-badnum.csv", content: "region,amount\nWest,100\nEast,not-a-number\n" });
  try {
    executeTool("csv_query", { path: "agg-badnum.csv", aggregate: [{ column: "amount", op: "sum" }] });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
    assert.match(e.message, /non-numeric/i);
  }
});

test("csv_query aggregate: filter_col/filter_val is applied before grouping/aggregation", () => {
  const r = q({ filter_col: "region", filter_val: "East", group_by: "product", aggregate: [{ column: "amount", op: "sum" }] });
  assert.strictEqual(r.totalRows, 3, "only East rows counted");
  const widget = r.groups.find(g => g.group === "Widget");
  assert.strictEqual(widget.sum_amount, 100); // 75+25, East-only
});

test("csv_query aggregate: filtering out every row yields zero groups without crashing", () => {
  const r = q({ filter_col: "region", filter_val: "Nowhere", group_by: "region", aggregate: [{ op: "count" }] });
  assert.strictEqual(r.totalRows, 0);
  assert.strictEqual(r.groupCount, 0);
  assert.deepStrictEqual(r.groups, []);
});

test("csv_query aggregate: non-existent file still throws cleanly", () => {
  assert.throws(() => executeTool("csv_query", { path: "agg-nonexistent.csv", aggregate: [{ op: "count" }] }));
});

test("csv_query aggregate: 'avg' on an all-empty-string column throws -32602 rather than NaN/0", () => {
  executeTool("create_file", { path: "agg-blankcol.csv", content: "region,amount\nWest,\nEast,\n" });
  try {
    executeTool("csv_query", { path: "agg-blankcol.csv", aggregate: [{ column: "amount", op: "avg" }] });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("csv_query aggregate: path traversal via 'path' is blocked", () => {
  assert.throws(
    () => executeTool("csv_query", { path: "../../etc/passwd", aggregate: [{ op: "count" }] }),
    /Access denied/,
  );
});

test("csv_query aggregate: injection-shaped group_by values round-trip literally as group keys, never executed", () => {
  const evil = "'; DROP TABLE users; --";
  executeTool("create_file", {
    path: "agg-inject.csv",
    content: `region,amount\n"${evil.replace(/"/g, '""')}",5\nEast,10\n`,
  });
  const r = executeTool("csv_query", { path: "agg-inject.csv", group_by: "region", aggregate: [{ column: "amount", op: "sum" }] });
  const evilGroup = r.groups.find(g => g.group === evil);
  assert.ok(evilGroup, "injection-shaped group key must appear literally");
  assert.strictEqual(evilGroup.sum_amount, 5);
});

test("csv_query aggregate: non-object aggregate entry (string/array) is rejected", () => {
  assert.throws(() => q({ aggregate: ["sum"] }), /-32602|must be an object/);
  try { q({ aggregate: ["sum"] }); } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("csv_query aggregate: aggregate given as a non-array (string) is treated as absent (falls back to row mode)", () => {
  // Array.isArray(...) gate means a non-array aggregate value never enters
  // aggregate mode at all — this documents that behavior explicitly rather
  // than assuming it.
  const r = q({ aggregate: "sum" });
  assert.ok(Array.isArray(r.rows), "non-array aggregate must not trigger aggregate mode");
});

test("csv_query aggregate: aggregate array exceeding the max length (20) throws -32602", () => {
  const many = Array.from({ length: 21 }, () => ({ column: "amount", op: "count" }));
  try { q({ aggregate: many }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); assert.match(e.message, /maximum/i); }
  // Note: this specific fixture would also hit the duplicate-field check first for
  // count_amount — that's fine, either -32602 path proves entries beyond a
  // reasonable size are never silently accepted.
});

test("csv_query aggregate: result is fully JSON-serialisable, no prototype pollution", () => {
  const r = q({ group_by: "region", aggregate: [{ column: "amount", op: "sum" }] });
  let s;
  assert.doesNotThrow(() => { s = JSON.stringify(r); });
  const parsed = JSON.parse(s);
  assert.strictEqual(parsed.groupCount, r.groupCount);
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
  for (const g of r.groups) assert.ok(!Object.prototype.hasOwnProperty.call(g, "__proto__"));
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("csv_query aggregate: 2000-row CSV grouped into 4 buckets computes correct sums", () => {
  const groupsWanted = ["A", "B", "C", "D"];
  const rows = Array.from({ length: 2000 }, (_, i) => `${groupsWanted[i % 4]},${i + 1}`);
  executeTool("create_file", { path: "agg-large.csv", content: "bucket,val\n" + rows.join("\n") + "\n" });
  const r = executeTool("csv_query", { path: "agg-large.csv", group_by: "bucket", aggregate: [{ column: "val", op: "sum" }, { op: "count" }] });
  assert.strictEqual(r.groupCount, 4);
  assert.strictEqual(r.totalRows, 2000);
  // Verify bucket A's sum independently: values 1,5,9,...,1997 (i%4===0 => i+1)
  let expectedA = 0;
  for (let i = 0; i < 2000; i++) if (i % 4 === 0) expectedA += i + 1;
  const a = r.groups.find(g => g.group === "A");
  assert.strictEqual(a.sum_val, expectedA);
  assert.strictEqual(a.count, 500);
});

test("csv_query aggregate: many-distinct-group table paginates correctly with offset/limit", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `g${String(i).padStart(3, "0")},1`);
  executeTool("create_file", { path: "agg-manygroups.csv", content: "id,val\n" + rows.join("\n") + "\n" });
  const r = executeTool("csv_query", { path: "agg-manygroups.csv", group_by: "id", aggregate: [{ op: "count" }], offset: 100, limit: 10 });
  assert.strictEqual(r.groupCount, 300);
  assert.strictEqual(r.returnedGroups, 10);
  assert.strictEqual(r.groups[0].group, "g100", "sorted group order must be stable for pagination");
  assert.strictEqual(r.groups[9].group, "g109");
});

test("csv_query aggregate: 10 concurrent calls return identical results", () => {
  const results = Array.from({ length: 10 }, () =>
    q({ group_by: "region", aggregate: [{ column: "amount", op: "sum" }, { op: "count" }] })
  );
  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[i].groups, results[0].groups, `call ${i} groups mismatch`);
  }
});

test("csv_query aggregate: fuzz — garbage-shaped aggregate entries are rejected cleanly, never crash the process", () => {
  const garbageAggregates = [
    [null],
    [42],
    [{ op: "sum", column: 123 }],
    [{ op: null }],
    [{}],
  ];
  for (const bad of garbageAggregates) {
    let threw = false;
    try { q({ aggregate: bad }); } catch (e) { threw = true; assert.strictEqual(e.code, -32602); }
    assert.ok(threw, `expected a clean -32602 for aggregate=${JSON.stringify(bad)}`);
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove csv aggregate fixture files", () => {
  const items = [
    "agg-sales.csv", "agg-noheader.csv", "agg-badnum.csv", "agg-blankcol.csv",
    "agg-inject.csv", "agg-large.csv", "agg-manygroups.csv",
  ];
  for (const item of items) {
    try { fs.rmSync(path.join(TMP, item), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "agg-sales.csv")), "agg-sales.csv removed");
});
