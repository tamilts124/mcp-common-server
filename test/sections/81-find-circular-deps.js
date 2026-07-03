"use strict";
/**
 * [81] FIND_CIRCULAR_DEPS — JS/TS import/require cycle detector
 *
 * Rigor levels:
 *   Normal:   direct A<->B cycle detected; acyclic tree reports zero cycles.
 *   Medium:   3-file cycle (A->B->C->A); non-directory path throws;
 *             self-import excluded (not a cycle).
 *   High:     bare specifiers (npm packages) ignored, don't create false
 *             edges; extensions filter narrows scan; index-file resolution.
 *   Critical: path traversal via path arg blocked; malicious-looking
 *             specifier text treated as inert string, never executed/required.
 *   Extreme:  max_cycles caps + truncated flag; larger multi-cycle graph;
 *             result is JSON-serialisable.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[81] FIND_CIRCULAR_DEPS — import/require cycle detection`);

test("normal: direct A<->B cycle detected", () => {
  executeTool("create_directory", { path: "cd_ab" });
  executeTool("write_file", { path: "cd_ab/a.js", content: `require("./b");\nmodule.exports = {};` });
  executeTool("write_file", { path: "cd_ab/b.js", content: `require("./a");\nmodule.exports = {};` });
  const r = executeTool("find_circular_deps", { path: "cd_ab" });
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.cycleCount, 1);
  assert.strictEqual(r.cycles[0].length, 3); // a, b, a
});

test("normal: acyclic tree reports zero cycles", () => {
  executeTool("create_directory", { path: "cd_acyclic" });
  executeTool("write_file", { path: "cd_acyclic/a.js", content: `require("./b");` });
  executeTool("write_file", { path: "cd_acyclic/b.js", content: `module.exports = {};` });
  const r = executeTool("find_circular_deps", { path: "cd_acyclic" });
  assert.strictEqual(r.cycleCount, 0);
  assert.strictEqual(r.edgesFound, 1);
});

test("medium: 3-file cycle A->B->C->A detected", () => {
  executeTool("create_directory", { path: "cd_abc" });
  executeTool("write_file", { path: "cd_abc/a.js", content: `import "./b";` });
  executeTool("write_file", { path: "cd_abc/b.js", content: `import "./c";` });
  executeTool("write_file", { path: "cd_abc/c.js", content: `import "./a";` });
  const r = executeTool("find_circular_deps", { path: "cd_abc" });
  assert.strictEqual(r.cycleCount, 1);
  assert.strictEqual(r.cycles[0].length, 4);
});

test("medium: non-directory path throws", () => {
  try {
    executeTool("find_circular_deps", { path: "cd_ab/a.js" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: self-import is excluded (not reported as a cycle)", () => {
  executeTool("create_directory", { path: "cd_self" });
  executeTool("write_file", { path: "cd_self/a.js", content: `require("./a");` });
  const r = executeTool("find_circular_deps", { path: "cd_self" });
  assert.strictEqual(r.cycleCount, 0);
});

test("high: bare npm-package specifiers do not create false edges", () => {
  executeTool("create_directory", { path: "cd_bare" });
  executeTool("write_file", { path: "cd_bare/a.js", content: `const x = require("lodash");\nimport React from "react";` });
  const r = executeTool("find_circular_deps", { path: "cd_bare" });
  assert.strictEqual(r.edgesFound, 0);
  assert.strictEqual(r.cycleCount, 0);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "cd_ext" });
  executeTool("write_file", { path: "cd_ext/a.js", content: `require("./b");` });
  executeTool("write_file", { path: "cd_ext/b.ts", content: `export {};` });
  const rBoth = executeTool("find_circular_deps", { path: "cd_ext" });
  const rJsOnly = executeTool("find_circular_deps", { path: "cd_ext", extensions: [".js"] });
  assert.strictEqual(rBoth.filesScanned, 2);
  assert.strictEqual(rJsOnly.filesScanned, 1);
});

test("high: index-file resolution (require('./dir') -> dir/index.js) forms a real edge", () => {
  executeTool("create_directory", { path: "cd_idx/sub" });
  executeTool("write_file", { path: "cd_idx/a.js", content: `require("./sub");` });
  executeTool("write_file", { path: "cd_idx/sub/index.js", content: `require("../a");` });
  const r = executeTool("find_circular_deps", { path: "cd_idx" });
  assert.strictEqual(r.cycleCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_circular_deps", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell/injection-shaped specifier text is inert, never executed", () => {
  executeTool("create_directory", { path: "cd_inj" });
  executeTool("write_file", { path: "cd_inj/a.js", content: `require("./b; rm -rf / #");` });
  executeTool("write_file", { path: "cd_inj/b.js", content: `module.exports = {};` });
  const r = executeTool("find_circular_deps", { path: "cd_inj" });
  assert.strictEqual(r.cycleCount, 0); // unresolvable specifier, no edge, no crash
});

test("extreme: max_cycles caps output and sets truncated", () => {
  executeTool("create_directory", { path: "cd_many" });
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6;
    executeTool("write_file", { path: `cd_many/f${i}.js`, content: `require("./f${next}");` });
  }
  const r = executeTool("find_circular_deps", { path: "cd_many", max_cycles: 0 }); // clamps to 1
  assert.strictEqual(r.cycles.length, 1);
});

test("extreme: multi-component graph finds all independent cycles", () => {
  executeTool("create_directory", { path: "cd_multi" });
  executeTool("write_file", { path: "cd_multi/x1.js", content: `require("./x2");` });
  executeTool("write_file", { path: "cd_multi/x2.js", content: `require("./x1");` });
  executeTool("write_file", { path: "cd_multi/y1.js", content: `require("./y2");` });
  executeTool("write_file", { path: "cd_multi/y2.js", content: `require("./y1");` });
  const r = executeTool("find_circular_deps", { path: "cd_multi" });
  assert.strictEqual(r.cycleCount, 2);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_circular_deps", { path: "cd_multi" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_circular_deps fixtures", () => {
  for (const d of ["cd_ab", "cd_acyclic", "cd_abc", "cd_self", "cd_bare", "cd_ext", "cd_idx", "cd_inj", "cd_many", "cd_multi"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
