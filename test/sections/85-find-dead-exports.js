"use strict";
/**
 * [85] FIND_DEAD_EXPORTS — JS/TS exports never imported elsewhere
 *
 * Rigor levels:
 *   Normal:   ESM named export used vs unused; CJS module.exports.NAME
 *             used vs unused.
 *   Medium:   non-directory path throws; export list `export {a,b}` with
 *             only one used flags the other; max_results caps + truncated.
 *   High:     namespace import (`import * as ns`) marks whole file used
 *             (conservative, no false positive); whole-module require
 *             (`const x = require()`) marks whole file used; extensions
 *             filter narrows scan.
 *   Critical: path traversal via path arg blocked; injection-shaped
 *             specifier text is inert, never executed.
 *   Extreme:  default export used vs unused; re-export (`export {a} from`)
 *             marks source used; result is JSON-serialisable.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[85] FIND_DEAD_EXPORTS — JS/TS unused-export detector`);

test("normal: ESM named export used vs unused", () => {
  executeTool("create_directory", { path: "de_esm" });
  executeTool("write_file", { path: "de_esm/lib.js", content: `export const used = 1;\nexport const unused = 2;` });
  executeTool("write_file", { path: "de_esm/main.js", content: `import { used } from "./lib";\nconsole.log(used);` });
  const r = executeTool("find_dead_exports", { path: "de_esm" });
  assert.strictEqual(r.deadCount, 1);
  assert.strictEqual(r.dead[0].name, "unused");
  assert.strictEqual(r.dead[0].file, "lib.js");
});

test("normal: CJS module.exports.NAME used vs unused", () => {
  executeTool("create_directory", { path: "de_cjs" });
  executeTool("write_file", { path: "de_cjs/lib.js", content: `module.exports.used = () => {};\nmodule.exports.unused = () => {};` });
  executeTool("write_file", { path: "de_cjs/main.js", content: `const { used } = require("./lib");\nused();` });
  const r = executeTool("find_dead_exports", { path: "de_cjs" });
  assert.strictEqual(r.deadCount, 1);
  assert.strictEqual(r.dead[0].name, "unused");
});

test("medium: non-directory path throws", () => {
  try {
    executeTool("find_dead_exports", { path: "de_esm/lib.js" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: export list with only one name used flags the other", () => {
  executeTool("create_directory", { path: "de_list" });
  executeTool("write_file", { path: "de_list/lib.js", content: `const a = 1, b = 2;\nexport { a, b };` });
  executeTool("write_file", { path: "de_list/main.js", content: `import { a } from "./lib";\nconsole.log(a);` });
  const r = executeTool("find_dead_exports", { path: "de_list" });
  assert.strictEqual(r.deadCount, 1);
  assert.strictEqual(r.dead[0].name, "b");
});

test("medium: max_results caps output and sets truncated", () => {
  executeTool("create_directory", { path: "de_many" });
  let content = "";
  for (let i = 0; i < 10; i++) content += `export const x${i} = ${i};\n`;
  executeTool("write_file", { path: "de_many/lib.js", content });
  const r = executeTool("find_dead_exports", { path: "de_many", max_results: 3 });
  assert.strictEqual(r.dead.length, 3);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.deadCount, 10);
});

test("high: namespace import marks whole target file used (conservative)", () => {
  executeTool("create_directory", { path: "de_ns" });
  executeTool("write_file", { path: "de_ns/lib.js", content: `export const a = 1;\nexport const b = 2;` });
  executeTool("write_file", { path: "de_ns/main.js", content: `import * as ns from "./lib";\nconsole.log(ns);` });
  const r = executeTool("find_dead_exports", { path: "de_ns" });
  assert.strictEqual(r.deadCount, 0);
});

test("high: whole-module require marks target file used (conservative)", () => {
  executeTool("create_directory", { path: "de_wholereq" });
  executeTool("write_file", { path: "de_wholereq/lib.js", content: `module.exports.a = 1;\nmodule.exports.b = 2;` });
  executeTool("write_file", { path: "de_wholereq/main.js", content: `const lib = require("./lib");\nconsole.log(lib);` });
  const r = executeTool("find_dead_exports", { path: "de_wholereq" });
  assert.strictEqual(r.deadCount, 0);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "de_ext" });
  executeTool("write_file", { path: "de_ext/a.js", content: `export const x = 1;` });
  executeTool("write_file", { path: "de_ext/b.ts", content: `export const y = 1;` });
  const rBoth = executeTool("find_dead_exports", { path: "de_ext" });
  const rJsOnly = executeTool("find_dead_exports", { path: "de_ext", extensions: [".js"] });
  assert.strictEqual(rBoth.filesScanned, 2);
  assert.strictEqual(rJsOnly.filesScanned, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_dead_exports", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: injection-shaped specifier text is inert, never executed", () => {
  executeTool("create_directory", { path: "de_inj" });
  executeTool("write_file", { path: "de_inj/a.js", content: `require("./b; rm -rf / #");\nmodule.exports.x = 1;` });
  executeTool("write_file", { path: "de_inj/b.js", content: `module.exports.y = 1;` });
  const r = executeTool("find_dead_exports", { path: "de_inj" }); // unresolvable specifier, no crash
  assert.ok(Array.isArray(r.dead));
});

test("extreme: default export used vs unused", () => {
  executeTool("create_directory", { path: "de_default" });
  executeTool("write_file", { path: "de_default/lib.js", content: `export default function foo() {}` });
  executeTool("write_file", { path: "de_default/main.js", content: `import foo from "./lib";\nfoo();` });
  const r = executeTool("find_dead_exports", { path: "de_default" });
  assert.strictEqual(r.deadCount, 0);

  executeTool("write_file", { path: "de_default/main.js", content: `console.log("unused");` });
  const r2 = executeTool("find_dead_exports", { path: "de_default" });
  assert.strictEqual(r2.deadCount, 1);
  assert.strictEqual(r2.dead[0].name, "default");
});

test("extreme: export {a} from './src' marks source used", () => {
  executeTool("create_directory", { path: "de_reexport" });
  executeTool("write_file", { path: "de_reexport/src.js", content: `export const a = 1;` });
  executeTool("write_file", { path: "de_reexport/barrel.js", content: `export { a } from "./src";` });
  const r = executeTool("find_dead_exports", { path: "de_reexport" });
  const srcDead = r.dead.find(d => d.file === "src.js");
  assert.strictEqual(srcDead, undefined);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_dead_exports", { path: "de_esm" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_dead_exports fixtures", () => {
  for (const d of ["de_esm", "de_cjs", "de_list", "de_many", "de_ns", "de_wholereq", "de_ext", "de_inj", "de_default", "de_reexport"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
