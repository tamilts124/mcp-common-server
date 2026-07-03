"use strict";
/**
 * [86] FIND_UNUSED_DEPENDENCIES — package.json deps never required/imported
 *
 * Rigor levels:
 *   Normal:   a used dep (via require) and an unused dep both reported correctly.
 *   Medium:   missing package.json throws; non-directory scan path throws;
 *             empty dependencies block -> 0 checked, 0 unused.
 *   High:     scoped package sub-path import ('@scope/pkg/sub') counts as
 *             usage of '@scope/pkg'; blocks filter narrows which block is
 *             checked; invalid blocks entries rejected.
 *   Critical: path traversal via pkg_path/path blocked; shell/injection-shaped
 *             specifier text is inert, never executed.
 *   Extreme:  relative-specifier imports never counted as dep usage; result
 *             is JSON-serialisable; dep listed in both blocks counted once.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[86] FIND_UNUSED_DEPENDENCIES — package.json unused-dependency detector`);

test("normal: used dep and unused dep both reported correctly", () => {
  executeTool("create_directory", { path: "fud_normal" });
  executeTool("write_file", { path: "fud_normal/package.json", content: JSON.stringify({
    name: "x", version: "1.0.0",
    dependencies: { "left-pad": "^1.0.0", "unused-pkg": "^2.0.0" },
  }) });
  executeTool("write_file", { path: "fud_normal/index.js", content: `const pad = require("left-pad");\npad();` });
  const r = executeTool("find_unused_dependencies", { pkg_path: "fud_normal/package.json", path: "fud_normal" });
  assert.strictEqual(r.dependenciesChecked, 2);
  assert.strictEqual(r.unusedCount, 1);
  assert.strictEqual(r.unused[0].name, "unused-pkg");
});

test("medium: missing package.json throws", () => {
  try {
    executeTool("find_unused_dependencies", { pkg_path: "fud_normal/nope.json", path: "fud_normal" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: non-directory scan path throws", () => {
  try {
    executeTool("find_unused_dependencies", { pkg_path: "fud_normal/package.json", path: "fud_normal/index.js" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: empty dependencies block -> 0 checked, 0 unused", () => {
  executeTool("create_directory", { path: "fud_empty" });
  executeTool("write_file", { path: "fud_empty/package.json", content: JSON.stringify({ name: "x", version: "1.0.0" }) });
  const r = executeTool("find_unused_dependencies", { pkg_path: "fud_empty/package.json", path: "fud_empty" });
  assert.strictEqual(r.dependenciesChecked, 0);
  assert.strictEqual(r.unusedCount, 0);
});

test("high: scoped sub-path import counts as top-level package usage", () => {
  executeTool("create_directory", { path: "fud_scoped" });
  executeTool("write_file", { path: "fud_scoped/package.json", content: JSON.stringify({
    name: "x", version: "1.0.0", dependencies: { "@scope/pkg": "^1.0.0" },
  }) });
  executeTool("write_file", { path: "fud_scoped/index.js", content: `import { fn } from "@scope/pkg/sub";\nfn();` });
  const r = executeTool("find_unused_dependencies", { pkg_path: "fud_scoped/package.json", path: "fud_scoped" });
  assert.strictEqual(r.unusedCount, 0);
});

test("high: blocks filter narrows which dependency block is checked", () => {
  executeTool("create_directory", { path: "fud_blocks" });
  executeTool("write_file", { path: "fud_blocks/package.json", content: JSON.stringify({
    name: "x", version: "1.0.0",
    dependencies: { "dep-a": "^1.0.0" },
    devDependencies: { "dev-b": "^1.0.0" },
  }) });
  executeTool("write_file", { path: "fud_blocks/index.js", content: `console.log("nothing required");` });
  const rDeps = executeTool("find_unused_dependencies", { pkg_path: "fud_blocks/package.json", path: "fud_blocks", blocks: ["dependencies"] });
  assert.strictEqual(rDeps.dependenciesChecked, 1);
  assert.strictEqual(rDeps.unused[0].name, "dep-a");
});

test("high: invalid blocks entries rejected", () => {
  try {
    executeTool("find_unused_dependencies", { pkg_path: "fud_blocks/package.json", path: "fud_blocks", blocks: ["not_a_real_block"] });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via pkg_path is blocked", () => {
  try {
    executeTool("find_unused_dependencies", { pkg_path: "../../../../etc/passwd", path: "fud_normal" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via path is blocked", () => {
  try {
    executeTool("find_unused_dependencies", { pkg_path: "fud_normal/package.json", path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: injection-shaped specifier text is inert, never executed", () => {
  executeTool("create_directory", { path: "fud_inj" });
  executeTool("write_file", { path: "fud_inj/package.json", content: JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "safe-pkg": "^1.0.0" } }) });
  executeTool("write_file", { path: "fud_inj/index.js", content: `require("safe-pkg; rm -rf / #");` });
  const r = executeTool("find_unused_dependencies", { pkg_path: "fud_inj/package.json", path: "fud_inj" });
  assert.ok(Array.isArray(r.unused)); // no crash; malformed specifier just doesn't match "safe-pkg"
});

test("extreme: relative-specifier imports never counted as dep usage", () => {
  executeTool("create_directory", { path: "fud_rel" });
  executeTool("write_file", { path: "fud_rel/package.json", content: JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "./local": "^1.0.0" } }) });
  executeTool("write_file", { path: "fud_rel/index.js", content: `require("./sibling");` });
  const r = executeTool("find_unused_dependencies", { pkg_path: "fud_rel/package.json", path: "fud_rel" });
  assert.strictEqual(r.unusedCount, 1);
  assert.strictEqual(r.unused[0].name, "./local");
});

test("extreme: dep listed in both dependencies and devDependencies counted once", () => {
  executeTool("create_directory", { path: "fud_dupe" });
  executeTool("write_file", { path: "fud_dupe/package.json", content: JSON.stringify({
    name: "x", version: "1.0.0",
    dependencies: { "dupe-pkg": "^1.0.0" },
    devDependencies: { "dupe-pkg": "^1.0.0" },
  }) });
  executeTool("write_file", { path: "fud_dupe/index.js", content: `console.log("nothing required");` });
  const r = executeTool("find_unused_dependencies", { pkg_path: "fud_dupe/package.json", path: "fud_dupe" });
  assert.strictEqual(r.dependenciesChecked, 1);
  assert.strictEqual(r.unusedCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_unused_dependencies", { pkg_path: "fud_normal/package.json", path: "fud_normal" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_unused_dependencies fixtures", () => {
  for (const d of ["fud_normal", "fud_empty", "fud_scoped", "fud_blocks", "fud_inj", "fud_rel", "fud_dupe"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
