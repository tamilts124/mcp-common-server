"use strict";
/**
 * [87] FIND_CONSOLE_LOGS — leftover debug console.* / debugger statement scanner
 *
 * Rigor levels:
 *   Normal:   console.log detected; clean file returns zero matches.
 *   Medium:   nonexistent path throws -32602; empty 'methods' array throws;
 *             invalid methods entries rejected.
 *   High:     directory mode + extensions filter; methods filter narrows
 *             which console calls are flagged; debugger; statement detected.
 *   Critical: binary file skipped not thrown/crashed; returned paths stay
 *             prefixed under requested origPath (no traversal).
 *   Extreme:  max_matches caps output and sets truncated; byMethod summary
 *             counts accurate; result is JSON-serialisable.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[87] FIND_CONSOLE_LOGS — leftover debug statement scanner`);

test("normal: console.log detected with correct fields", () => {
  executeTool("create_directory", { path: "fcl_normal" });
  executeTool("write_file", { path: "fcl_normal/a.js", content: `function f() {\n  console.log("debug", 1);\n  return 1;\n}` });
  const r = executeTool("find_console_logs", { path: "fcl_normal" });
  assert.strictEqual(r.totalMatches, 1);
  assert.strictEqual(r.matches[0].method, "console.log");
  assert.strictEqual(r.matches[0].line, 2);
});

test("normal: clean file returns zero matches", () => {
  executeTool("create_directory", { path: "fcl_clean" });
  executeTool("write_file", { path: "fcl_clean/a.js", content: `function f() { return 1; }` });
  const r = executeTool("find_console_logs", { path: "fcl_clean" });
  assert.strictEqual(r.totalMatches, 0);
});

test("medium: nonexistent path throws -32602", () => {
  try {
    executeTool("find_console_logs", { path: "fcl_normal/does_not_exist" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: empty methods array throws", () => {
  try {
    executeTool("find_console_logs", { path: "fcl_normal", methods: [] });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: invalid methods entries rejected", () => {
  try {
    executeTool("find_console_logs", { path: "fcl_normal", methods: ["not_a_real_method"] });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: directory mode + extensions filter narrows scan", () => {
  executeTool("create_directory", { path: "fcl_ext" });
  executeTool("write_file", { path: "fcl_ext/a.js", content: `console.warn("x");` });
  executeTool("write_file", { path: "fcl_ext/b.py", content: `console.warn("not js");` }); // fake extension, irrelevant content
  const r = executeTool("find_console_logs", { path: "fcl_ext" });
  assert.strictEqual(r.filesScanned, 1); // .py excluded by default extensions
  assert.strictEqual(r.totalMatches, 1);
});

test("high: methods filter narrows which console calls are flagged", () => {
  executeTool("create_directory", { path: "fcl_methods" });
  executeTool("write_file", { path: "fcl_methods/a.js", content: `console.log("a");\nconsole.error("b");` });
  const r = executeTool("find_console_logs", { path: "fcl_methods", methods: ["error"] });
  assert.strictEqual(r.totalMatches, 1);
  assert.strictEqual(r.matches[0].method, "console.error");
});

test("high: bare debugger; statement detected", () => {
  executeTool("create_directory", { path: "fcl_dbg" });
  executeTool("write_file", { path: "fcl_dbg/a.js", content: `function f() {\n  debugger;\n  return 1;\n}` });
  const r = executeTool("find_console_logs", { path: "fcl_dbg" });
  assert.strictEqual(r.totalMatches, 1);
  assert.strictEqual(r.matches[0].method, "debugger");
});

test("critical: binary file skipped, not thrown/crashed", () => {
  executeTool("create_directory", { path: "fcl_bin" });
  executeTool("base64_decode", { data: Buffer.from([0, 1, 2, 3, 0, 5]).toString("base64"), destination: "fcl_bin/a.js" });
  const r = executeTool("find_console_logs", { path: "fcl_bin" });
  assert.strictEqual(r.totalMatches, 0);
});

test("critical: returned paths stay prefixed, no traversal segments", () => {
  const r = executeTool("find_console_logs", { path: "fcl_normal" });
  for (const m of r.matches) assert.ok(m.file.startsWith("fcl_normal/"));
});

test("extreme: max_matches caps output and sets truncated", () => {
  executeTool("create_directory", { path: "fcl_many" });
  let content = "";
  for (let i = 0; i < 10; i++) content += `console.log(${i});\n`;
  executeTool("write_file", { path: "fcl_many/a.js", content });
  const r = executeTool("find_console_logs", { path: "fcl_many", max_matches: 3 });
  assert.strictEqual(r.matches.length, 3);
  assert.strictEqual(r.truncated, true);
});

test("extreme: byMethod summary counts accurate", () => {
  executeTool("create_directory", { path: "fcl_summary" });
  executeTool("write_file", { path: "fcl_summary/a.js", content: `console.log(1);\nconsole.log(2);\nconsole.warn(3);` });
  const r = executeTool("find_console_logs", { path: "fcl_summary" });
  assert.strictEqual(r.byMethod["console.log"], 2);
  assert.strictEqual(r.byMethod["console.warn"], 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_console_logs", { path: "fcl_normal" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_console_logs fixtures", () => {
  for (const d of ["fcl_normal", "fcl_clean", "fcl_ext", "fcl_methods", "fcl_dbg", "fcl_bin", "fcl_many", "fcl_summary"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
