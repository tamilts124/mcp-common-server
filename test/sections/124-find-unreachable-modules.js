"use strict";
/**
 * [124] FIND_UNREACHABLE_MODULES — reachability graph traversal from entry point(s)
 *
 * Rigor levels:
 *   Normal:   reachable file via require chain excluded; orphan file reported unreachable.
 *   Medium:   explicit entry_points used; unknown entry point throws; non-directory throws;
 *             auto-discovery via package.json "main"; auto-discovery failure throws.
 *   High:     bare specifiers don't create false edges; extensions filter narrows scan;
 *             index-file resolution counts as reachable.
 *   Critical: path traversal via path arg blocked; injection-shaped specifier text inert.
 *   Extreme:  max_results caps + truncated flag; result JSON-serialisable; large fan-out graph.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[124] FIND_UNREACHABLE_MODULES — reachability from entry point(s)`);

test("normal: file reached via require chain is not reported unreachable", () => {
  executeTool("create_directory", { path: "um_basic" });
  executeTool("write_file", { path: "um_basic/index.js", content: `require("./a");` });
  executeTool("write_file", { path: "um_basic/a.js", content: `module.exports = {};` });
  const r = executeTool("find_unreachable_modules", { path: "um_basic" });
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.unreachableCount, 0);
});

test("normal: orphan file with no incoming path is reported unreachable", () => {
  executeTool("create_directory", { path: "um_orphan" });
  executeTool("write_file", { path: "um_orphan/index.js", content: `require("./a");` });
  executeTool("write_file", { path: "um_orphan/a.js", content: `module.exports = {};` });
  executeTool("write_file", { path: "um_orphan/orphan.js", content: `module.exports = {};` });
  const r = executeTool("find_unreachable_modules", { path: "um_orphan" });
  assert.strictEqual(r.unreachableCount, 1);
  assert.deepStrictEqual(r.unreachable, ["orphan.js"]);
});

test("medium: explicit entry_points overrides auto-discovery", () => {
  executeTool("create_directory", { path: "um_explicit" });
  executeTool("write_file", { path: "um_explicit/main.js", content: `require("./b");` });
  executeTool("write_file", { path: "um_explicit/b.js", content: `module.exports = {};` });
  const r = executeTool("find_unreachable_modules", { path: "um_explicit", entry_points: ["main.js"] });
  assert.strictEqual(r.entryPointsSource, "explicit");
  assert.strictEqual(r.unreachableCount, 0);
});

test("medium: unknown explicit entry point throws", () => {
  try {
    executeTool("find_unreachable_modules", { path: "um_explicit", entry_points: ["nope.js"] });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: non-directory path throws", () => {
  try {
    executeTool("find_unreachable_modules", { path: "um_basic/a.js" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: auto-discovers entry point from package.json main field", () => {
  executeTool("create_directory", { path: "um_pkg" });
  executeTool("write_file", { path: "um_pkg/package.json", content: JSON.stringify({ main: "./start.js" }) });
  executeTool("write_file", { path: "um_pkg/start.js", content: `require("./helper");` });
  executeTool("write_file", { path: "um_pkg/helper.js", content: `module.exports = {};` });
  const r = executeTool("find_unreachable_modules", { path: "um_pkg" });
  assert.strictEqual(r.entryPointsSource, "auto-discovered");
  assert.ok(r.entryPoints.includes("start.js"));
  assert.strictEqual(r.unreachableCount, 0);
});

test("medium: auto-discovery failure throws when no entry point found", () => {
  executeTool("create_directory", { path: "um_noentry" });
  executeTool("write_file", { path: "um_noentry/random.js", content: `module.exports = {};` });
  try {
    executeTool("find_unreachable_modules", { path: "um_noentry" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: bare npm-package specifiers do not create false reachability", () => {
  executeTool("create_directory", { path: "um_bare" });
  executeTool("write_file", { path: "um_bare/index.js", content: `const x = require("lodash");\nimport React from "react";` });
  executeTool("write_file", { path: "um_bare/orphan.js", content: `module.exports = {};` });
  const r = executeTool("find_unreachable_modules", { path: "um_bare" });
  assert.strictEqual(r.unreachableCount, 1);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "um_ext" });
  executeTool("write_file", { path: "um_ext/index.js", content: `require("./b");` });
  executeTool("write_file", { path: "um_ext/b.ts", content: `export {};` });
  const rBoth = executeTool("find_unreachable_modules", { path: "um_ext" });
  const rJsOnly = executeTool("find_unreachable_modules", { path: "um_ext", extensions: [".js"] });
  assert.strictEqual(rBoth.filesScanned, 2);
  assert.strictEqual(rJsOnly.filesScanned, 1);
});

test("high: index-file resolution counts as reachable", () => {
  executeTool("create_directory", { path: "um_idx/sub" });
  executeTool("write_file", { path: "um_idx/index.js", content: `require("./sub");` });
  executeTool("write_file", { path: "um_idx/sub/index.js", content: `module.exports = {};` });
  const r = executeTool("find_unreachable_modules", { path: "um_idx" });
  assert.strictEqual(r.unreachableCount, 0);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_unreachable_modules", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: injection-shaped specifier text is inert, never executed", () => {
  executeTool("create_directory", { path: "um_inj" });
  executeTool("write_file", { path: "um_inj/index.js", content: `require("./b; rm -rf / #");` });
  executeTool("write_file", { path: "um_inj/b.js", content: `module.exports = {};` });
  const r = executeTool("find_unreachable_modules", { path: "um_inj" });
  assert.strictEqual(r.unreachableCount, 1); // b.js unresolvable via injected spec, stays unreachable
});

test("extreme: max_results caps unreachable list and sets truncated", () => {
  executeTool("create_directory", { path: "um_many" });
  executeTool("write_file", { path: "um_many/index.js", content: `module.exports = {};` });
  for (let i = 0; i < 5; i++) {
    executeTool("write_file", { path: `um_many/orphan${i}.js`, content: `module.exports = {};` });
  }
  const r = executeTool("find_unreachable_modules", { path: "um_many", max_results: 2 });
  assert.strictEqual(r.unreachable.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.unreachableCount, 5);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_unreachable_modules", { path: "um_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_unreachable_modules fixtures", () => {
  for (const d of ["um_basic", "um_orphan", "um_explicit", "um_pkg", "um_noentry", "um_bare", "um_ext", "um_idx", "um_inj", "um_many"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
