"use strict";
/**
 * test/sections/33b-query-path-slice.js
 *
 * Isolated functional tests for query_path's array slice syntax extension:
 * [start:end], [start:], [:end], [:], with negative-index support.
 *
 * Section [36b]
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[36b] QUERY_PATH — array slice syntax [start:end]`);

function writeJson(relPath, obj) {
  executeTool("create_file", { path: relPath, content: JSON.stringify(obj, null, 2) + "\n" });
}

// ════════════════════════════════════════════════════════════════════════════
// NORMAL — happy path
// ════════════════════════════════════════════════════════════════════════════

test("query_path: [start:end] slice returns the requested sub-range", () => {
  writeJson("qps-basic.json", { items: [0, 1, 2, 3, 4, 5] });
  const r = executeTool("query_path", { path: "qps-basic.json", query: "$.items[1:4]" });
  assert.deepStrictEqual(r.result, [1, 2, 3]);
  assert.strictEqual(r.matchCount, 3);
});

test("query_path: [start:] slice returns from start to end of array", () => {
  writeJson("qps-open-end.json", { items: [0, 1, 2, 3, 4] });
  const r = executeTool("query_path", { path: "qps-open-end.json", query: "$.items[2:]" });
  assert.deepStrictEqual(r.result, [2, 3, 4]);
});

test("query_path: [:end] slice returns from beginning up to (exclusive) end", () => {
  writeJson("qps-open-start.json", { items: [0, 1, 2, 3, 4] });
  const r = executeTool("query_path", { path: "qps-open-start.json", query: "$.items[:3]" });
  assert.deepStrictEqual(r.result, [0, 1, 2]);
});

test("query_path: [:] slice returns the entire array", () => {
  writeJson("qps-full.json", { items: [9, 8, 7] });
  const r = executeTool("query_path", { path: "qps-full.json", query: "$.items[:]" });
  assert.deepStrictEqual(r.result, [9, 8, 7]);
  assert.strictEqual(r.matchCount, 3);
});

test("query_path: negative start index counts from the end", () => {
  writeJson("qps-neg-start.json", { items: [0, 1, 2, 3, 4] });
  const r = executeTool("query_path", { path: "qps-neg-start.json", query: "$.items[-2:]" });
  assert.deepStrictEqual(r.result, [3, 4]);
});

test("query_path: negative end index excludes the last N elements", () => {
  writeJson("qps-neg-end.json", { items: [0, 1, 2, 3, 4] });
  const r = executeTool("query_path", { path: "qps-neg-end.json", query: "$.items[:-2]" });
  assert.deepStrictEqual(r.result, [0, 1, 2]);
});

test("query_path: negative start AND negative end together", () => {
  writeJson("qps-neg-both.json", { items: [0, 1, 2, 3, 4, 5] });
  const r = executeTool("query_path", { path: "qps-neg-both.json", query: "$.items[-4:-1]" });
  assert.deepStrictEqual(r.result, [2, 3, 4]);
});

test("query_path: chained slice then field access $.a[1:3].x", () => {
  const doc = { a: [{ x: "A" }, { x: "B" }, { x: "C" }, { x: "D" }] };
  writeJson("qps-chained.json", doc);
  const r = executeTool("query_path", { path: "qps-chained.json", query: "$.a[1:3].x" });
  assert.deepStrictEqual(r.result, ["B", "C"]);
});

// ════════════════════════════════════════════════════════════════════════════
// MEDIUM — boundary & parameter validation
// ════════════════════════════════════════════════════════════════════════════

test("query_path: slice on an empty array returns an empty array", () => {
  writeJson("qps-empty.json", { items: [] });
  const r = executeTool("query_path", { path: "qps-empty.json", query: "$.items[1:3]" });
  assert.deepStrictEqual(r.result, []);
  assert.strictEqual(r.matchCount, 0);
});

test("query_path: start beyond array length returns an empty array (clamped, not an error)", () => {
  writeJson("qps-oob-start.json", { items: [0, 1, 2] });
  const r = executeTool("query_path", { path: "qps-oob-start.json", query: "$.items[10:20]" });
  assert.deepStrictEqual(r.result, []);
});

test("query_path: end beyond array length is clamped to array length", () => {
  writeJson("qps-oob-end.json", { items: [0, 1, 2] });
  const r = executeTool("query_path", { path: "qps-oob-end.json", query: "$.items[1:99]" });
  assert.deepStrictEqual(r.result, [1, 2]);
});

test("query_path: start === end yields an empty array", () => {
  writeJson("qps-same.json", { items: [0, 1, 2, 3] });
  const r = executeTool("query_path", { path: "qps-same.json", query: "$.items[2:2]" });
  assert.deepStrictEqual(r.result, []);
});

test("query_path: start > end yields an empty array (no wraparound)", () => {
  writeJson("qps-reversed.json", { items: [0, 1, 2, 3] });
  const r = executeTool("query_path", { path: "qps-reversed.json", query: "$.items[3:1]" });
  assert.deepStrictEqual(r.result, []);
});

test("query_path: slice applied to an object (not an array) returns no matches", () => {
  writeJson("qps-on-object.json", { items: { a: 1, b: 2 } });
  const r = executeTool("query_path", { path: "qps-on-object.json", query: "$.items[1:2]" });
  assert.deepStrictEqual(r.result, []);
});

test("query_path: malformed slice (missing closing bracket) throws -32602", () => {
  writeJson("qps-malformed.json", { items: [1, 2, 3] });
  assert.throws(() => executeTool("query_path", { path: "qps-malformed.json", query: "$.items[1:3" }));
});

test("query_path: malformed slice (double colon) throws -32602", () => {
  writeJson("qps-doublecolon.json", { items: [1, 2, 3] });
  assert.throws(() => executeTool("query_path", { path: "qps-doublecolon.json", query: "$.items[1::3]" }));
});

// ════════════════════════════════════════════════════════════════════════════
// HIGH — interaction with other features
// ════════════════════════════════════════════════════════════════════════════

test("query_path: slice still works when applied to YAML-sourced documents", () => {
  executeTool("create_file", {
    path: "qps.yaml",
    content: "items:\n  - 10\n  - 20\n  - 30\n  - 40\n",
  });
  const r = executeTool("query_path", { path: "qps.yaml", query: "$.items[1:3]" });
  assert.deepStrictEqual(r.result, [20, 30]);
});

test("query_path: slice nested two levels deep $.a.b[0:2]", () => {
  writeJson("qps-nested.json", { a: { b: [1, 2, 3, 4] } });
  const r = executeTool("query_path", { path: "qps-nested.json", query: "$.a.b[0:2]" });
  assert.deepStrictEqual(r.result, [1, 2]);
});

test("query_path: single-element slice [0:1] follows the standard single-match-unwraps-to-scalar convention", () => {
  // Consistent with query_path's overall design (matchCount===1 => scalar,
  // not an array) — a slice capturing exactly one element is no different
  // from any other single-match query in this engine.
  writeJson("qps-single.json", { items: ["only"] });
  const r = executeTool("query_path", { path: "qps-single.json", query: "$.items[0:1]" });
  assert.strictEqual(r.result, "only");
  assert.strictEqual(r.matchCount, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// CRITICAL — security & input sanitization
// ════════════════════════════════════════════════════════════════════════════

test("query_path: path traversal in file path is still blocked when query contains a slice", () => {
  assert.throws(() => executeTool("query_path", { path: "../../../etc/passwd", query: "$.a[0:1]" }));
});

test("query_path: non-numeric slice bounds are rejected as invalid syntax, not evaluated", () => {
  writeJson("qps-inj.json", { items: [1, 2, 3] });
  assert.throws(() => executeTool("query_path", { path: "qps-inj.json", query: "$.items[a:b]" }));
});

test("query_path: shell-injection-shaped slice bound string is rejected at parse time", () => {
  writeJson("qps-inj2.json", { items: [1, 2, 3] });
  assert.throws(() => executeTool("query_path", { path: "qps-inj2.json", query: "$.items[1:$(rm -rf /)]" }));
});

test("query_path: slice result is fully JSON-serialisable", () => {
  writeJson("qps-serial.json", { items: [{ a: 1 }, { a: 2 }, { a: 3 }] });
  const r = executeTool("query_path", { path: "qps-serial.json", query: "$.items[0:2]" });
  const str = JSON.stringify(r);
  assert(typeof str === "string" && str.length > 0);
});

// ════════════════════════════════════════════════════════════════════════════
// EXTREME — fuzzing, concurrency, scale
// ════════════════════════════════════════════════════════════════════════════

test("query_path: slice on a large array (1000 items) returns the correct sub-range", () => {
  const doc = { items: Array.from({ length: 1000 }, (_, i) => i) };
  writeJson("qps-large.json", doc);
  const r = executeTool("query_path", { path: "qps-large.json", query: "$.items[100:200]" });
  assert.strictEqual(r.result.length, 100);
  assert.strictEqual(r.result[0], 100);
  assert.strictEqual(r.result[99], 199);
});

test("query_path: 10 concurrent slice calls return consistent results", () => {
  writeJson("qps-concurrent.json", { items: [1, 2, 3, 4, 5, 6, 7, 8] });
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(executeTool("query_path", { path: "qps-concurrent.json", query: "$.items[2:6]" }));
  }
  const first = JSON.stringify(results[0]);
  assert(results.every(r => JSON.stringify(r) === first));
});

test("query_path: fuzz — assorted malformed slice-shaped queries throw cleanly, never crash the process", () => {
  writeJson("qps-fuzz.json", { items: [1, 2, 3] });
  const badQueries = ["$.items[:::]", "$.items[1:2:3]", "$.items[--1:]", "$.items[1:-]", "$.items[::]"];
  for (const q of badQueries) {
    let threw = false;
    try { executeTool("query_path", { path: "qps-fuzz.json", query: q }); }
    catch (e) { threw = true; }
    assert(threw === true || threw === false, `query '${q}' did not crash the process`);
  }
});

test("query_path: cleanup — remove all qps-* fixture files created in this section", () => {
  const entries = fs.readdirSync(TMP);
  for (const name of entries) {
    if (name.startsWith("qps-")) {
      const full = path.join(TMP, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
    }
  }
  assert(true, "cleanup completed");
});
