"use strict";
/**
 * [128] FIND_ASYNC_CALLBACK_IN_FOREACH — async callback passed to .forEach()
 *
 * Rigor levels:
 *   Normal:   inline async arrow/function callback flagged; plain sync callback not flagged.
 *   Medium:   missing path defaults to root (no throw); max_results type mismatch throws;
 *             non-matching-extension single file throws.
 *   High:     named async-declared function passed to forEach flagged (warning);
 *             named non-async identifier not flagged; .map(async ...) not flagged (out of scope);
 *             extensions filter narrows scan.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped text inert.
 *   Extreme:  max_results caps + truncated flag; single-file mode works; JSON-serialisable;
 *             many findings across a large file handled without crashing.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[128] FIND_ASYNC_CALLBACK_IN_FOREACH — async callback in .forEach()`);

test("normal: inline async arrow callback to .forEach() is flagged", () => {
  executeTool("create_directory", { path: "facf_basic" });
  executeTool("write_file", { path: "facf_basic/a.js", content:
    `items.forEach(async (item) => {\n  await doThing(item);\n});` });
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_basic" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "foreach_inline_async_callback");
  assert.strictEqual(r.findings[0].severity, "error");
});

test("normal: plain sync callback to .forEach() is not flagged", () => {
  executeTool("create_directory", { path: "facf_sync" });
  executeTool("write_file", { path: "facf_sync/a.js", content:
    `items.forEach((item) => {\n  doThing(item);\n});` });
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_sync" });
  assert.strictEqual(r.findingsCount, 0);
});

test("normal: inline async function expression callback is flagged", () => {
  executeTool("create_directory", { path: "facf_funcexpr" });
  executeTool("write_file", { path: "facf_funcexpr/a.js", content:
    `items.forEach(async function (item) {\n  await doThing(item);\n});` });
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_funcexpr" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "foreach_inline_async_callback");
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_async_callback_in_foreach", { path: "facf_basic", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: single file with non-matching extension throws", () => {
  executeTool("write_file", { path: "facf_basic/notes.txt", content: "hello" });
  try {
    executeTool("find_async_callback_in_foreach", { path: "facf_basic/notes.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: named async-declared function passed to .forEach() is flagged", () => {
  executeTool("create_directory", { path: "facf_named" });
  executeTool("write_file", { path: "facf_named/a.js", content:
    `async function handle(item) { await doThing(item); }\nitems.forEach(handle);` });
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_named" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "foreach_named_async_callback");
  assert.strictEqual(r.findings[0].severity, "warning");
  assert.strictEqual(r.findings[0].callback, "handle");
});

test("high: named non-async identifier passed to .forEach() is not flagged", () => {
  executeTool("create_directory", { path: "facf_nonasync" });
  executeTool("write_file", { path: "facf_nonasync/a.js", content:
    `function handle(item) { doThing(item); }\nitems.forEach(handle);` });
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_nonasync" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: .map(async ...) is out of scope and not flagged", () => {
  executeTool("create_directory", { path: "facf_map" });
  executeTool("write_file", { path: "facf_map/a.js", content:
    `items.map(async (item) => {\n  return await doThing(item);\n});` });
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_map" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "facf_ext" });
  executeTool("write_file", { path: "facf_ext/a.js", content:
    `items.forEach(async (x) => { await f(x); });` });
  executeTool("write_file", { path: "facf_ext/b.ts", content:
    `items.forEach(async (x) => { await g(x); });` });
  const rBoth = executeTool("find_async_callback_in_foreach", { path: "facf_ext" });
  const rJsOnly = executeTool("find_async_callback_in_foreach", { path: "facf_ext", extensions: [".js"] });
  assert.strictEqual(rBoth.findingsCount, 2);
  assert.strictEqual(rJsOnly.findingsCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_async_callback_in_foreach", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped text is inert, never executed", () => {
  executeTool("create_directory", { path: "facf_inj" });
  executeTool("write_file", { path: "facf_inj/a.js", content:
    `items.forEach(async (x) => { await f(x); }); // $(rm -rf /)` });
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_inj" });
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: max_results caps findings and sets truncated", () => {
  executeTool("create_directory", { path: "facf_many" });
  let content = "";
  for (let i = 0; i < 5; i++) content += `items${i}.forEach(async (x) => { await f(x); });\n`;
  executeTool("write_file", { path: "facf_many/a.js", content });
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_many", max_results: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

test("extreme: single-file mode scans just that file", () => {
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_basic/a.js" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_async_callback_in_foreach", { path: "facf_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_async_callback_in_foreach fixtures", () => {
  for (const d of ["facf_basic", "facf_sync", "facf_funcexpr", "facf_named", "facf_nonasync", "facf_map", "facf_ext", "facf_inj", "facf_many"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
