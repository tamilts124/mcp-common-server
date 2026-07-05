"use strict";
/**
 * [127] FIND_MISSING_AWAIT — calls to known-async functions with no `await`
 *
 * Rigor levels:
 *   Normal:   unawaited call to same-file async function flagged; awaited call not flagged.
 *   Medium:   missing path defaults to root (no throw); max_results type mismatch throws;
 *             non-matching-extension single file throws.
 *   High:     `return name()` not flagged; arrow-assigned async function detected;
 *             object-method-shorthand async function detected; extensions filter narrows scan.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped text inert.
 *   Extreme:  max_results caps + truncated flag; single-file mode works; JSON-serialisable.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[127] FIND_MISSING_AWAIT — unawaited async-function calls`);

test("normal: unawaited call to same-file async function is flagged", () => {
  executeTool("create_directory", { path: "fma_basic" });
  executeTool("write_file", { path: "fma_basic/a.js", content:
    `async function fetchData() { return 1; }\nfunction use() {\n  fetchData();\n}` });
  const r = executeTool("find_missing_await", { path: "fma_basic" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].functionName, "fetchData");
});

test("normal: awaited call is not flagged", () => {
  executeTool("create_directory", { path: "fma_awaited" });
  executeTool("write_file", { path: "fma_awaited/a.js", content:
    `async function fetchData() { return 1; }\nasync function use() {\n  await fetchData();\n}` });
  const r = executeTool("find_missing_await", { path: "fma_awaited" });
  assert.strictEqual(r.findingsCount, 0);
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_missing_await", { path: "fma_basic", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: single file with non-matching extension throws", () => {
  executeTool("write_file", { path: "fma_basic/notes.txt", content: "hello" });
  try {
    executeTool("find_missing_await", { path: "fma_basic/notes.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: `return name()` is not flagged (no await needed)", () => {
  executeTool("create_directory", { path: "fma_return" });
  executeTool("write_file", { path: "fma_return/a.js", content:
    `async function fetchData() { return 1; }\nasync function use() {\n  return fetchData();\n}` });
  const r = executeTool("find_missing_await", { path: "fma_return" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: arrow-assigned async function is detected and its unawaited call flagged", () => {
  executeTool("create_directory", { path: "fma_arrow" });
  executeTool("write_file", { path: "fma_arrow/a.js", content:
    `const load = async () => 1;\nfunction use() {\n  load();\n}` });
  const r = executeTool("find_missing_await", { path: "fma_arrow" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].functionName, "load");
});

test("high: object-method-shorthand async function is detected", () => {
  executeTool("create_directory", { path: "fma_obj" });
  executeTool("write_file", { path: "fma_obj/a.js", content:
    `const api = {\n  async get(x) { return x; }\n};\nfunction use() {\n  api.get(1);\n}` });
  const r = executeTool("find_missing_await", { path: "fma_obj" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].functionName, "get");
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "fma_ext" });
  executeTool("write_file", { path: "fma_ext/a.js", content:
    `async function f() { return 1; }\nf();` });
  executeTool("write_file", { path: "fma_ext/b.ts", content:
    `async function g() { return 1; }\ng();` });
  const rBoth = executeTool("find_missing_await", { path: "fma_ext" });
  const rJsOnly = executeTool("find_missing_await", { path: "fma_ext", extensions: [".js"] });
  assert.strictEqual(rBoth.findingsCount, 2);
  assert.strictEqual(rJsOnly.findingsCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_missing_await", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped text is inert, never executed", () => {
  executeTool("create_directory", { path: "fma_inj" });
  executeTool("write_file", { path: "fma_inj/a.js", content:
    `async function run() { return 1; }\nrun(); // $(rm -rf /)` });
  const r = executeTool("find_missing_await", { path: "fma_inj" });
  assert.strictEqual(r.findingsCount, 1);
  assert.ok(r.findings[0].text.includes("$(rm -rf /)"));
});

test("extreme: max_results caps findings and sets truncated", () => {
  executeTool("create_directory", { path: "fma_many" });
  let content = "async function f() { return 1; }\n";
  for (let i = 0; i < 5; i++) content += "f();\n";
  executeTool("write_file", { path: "fma_many/a.js", content });
  const r = executeTool("find_missing_await", { path: "fma_many", max_results: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

test("extreme: single-file mode scans just that file", () => {
  const r = executeTool("find_missing_await", { path: "fma_basic/a.js" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_missing_await", { path: "fma_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_missing_await fixtures", () => {
  for (const d of ["fma_basic", "fma_awaited", "fma_return", "fma_arrow", "fma_obj", "fma_ext", "fma_inj", "fma_many"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
