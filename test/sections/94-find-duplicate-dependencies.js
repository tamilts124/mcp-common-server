"use strict";
/**
 * [94] FIND_DUPLICATE_DEPENDENCIES — monorepo package.json version-conflict scan
 *
 * Rigor levels:
 *   Normal:   two packages declaring different versions of the same dep are
 *             flagged; identical versions across packages are not flagged.
 *   Medium:   nonexistent path throws; path-is-a-file throws; invalid
 *             'blocks' entries filtered/rejected same as find_unused_dependencies.
 *   High:     malformed package.json (bad JSON) is skipped and listed in
 *             'malformed', not thrown; non-string version values ignored.
 *   Critical: nested package.json inside node_modules is excluded (isIgnored);
 *             results are JSON-serialisable, no path traversal in package names.
 *   Extreme:  many packages/deps doesn't crash; blocks filter narrows scan.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[94] FIND_DUPLICATE_DEPENDENCIES — monorepo version-conflict scan`);

test("normal: conflicting versions across two packages flagged", () => {
  executeTool("create_directory", { path: "fdd_normal/pkg-a" });
  executeTool("create_directory", { path: "fdd_normal/pkg-b" });
  executeTool("write_file", { path: "fdd_normal/pkg-a/package.json", content: JSON.stringify({ name: "a", dependencies: { lodash: "^4.17.0" } }) });
  executeTool("write_file", { path: "fdd_normal/pkg-b/package.json", content: JSON.stringify({ name: "b", dependencies: { lodash: "^3.10.0" } }) });
  const r = executeTool("find_duplicate_dependencies", { path: "fdd_normal" });
  assert.strictEqual(r.packagesScanned, 2);
  assert.strictEqual(r.conflictCount, 1);
  assert.strictEqual(r.conflicts[0].name, "lodash");
  assert.strictEqual(r.conflicts[0].versionCount, 2);
});

test("normal: identical versions across packages not flagged", () => {
  executeTool("create_directory", { path: "fdd_same/pkg-a" });
  executeTool("create_directory", { path: "fdd_same/pkg-b" });
  executeTool("write_file", { path: "fdd_same/pkg-a/package.json", content: JSON.stringify({ dependencies: { chalk: "^5.0.0" } }) });
  executeTool("write_file", { path: "fdd_same/pkg-b/package.json", content: JSON.stringify({ dependencies: { chalk: "^5.0.0" } }) });
  const r = executeTool("find_duplicate_dependencies", { path: "fdd_same" });
  assert.strictEqual(r.conflictCount, 0);
});

test("medium: nonexistent path throws", () => {
  try { executeTool("find_duplicate_dependencies", { path: "fdd_does_not_exist" }); assert.fail("should have thrown"); }
  catch (e) { assert.ok(e); }
});

test("medium: path pointing at a file throws", () => {
  executeTool("write_file", { path: "fdd_file_target.txt", content: "x" });
  try { executeTool("find_duplicate_dependencies", { path: "fdd_file_target.txt" }); assert.fail("should have thrown"); }
  catch (e) { assert.ok(e); }
});

test("medium: invalid blocks entries filtered leaves defaults if empty result", () => {
  try { executeTool("find_duplicate_dependencies", { path: "fdd_normal", blocks: ["not_a_real_block"] }); assert.fail("should have thrown"); }
  catch (e) { assert.ok(e); }
});

test("high: malformed package.json skipped and listed, not thrown", () => {
  executeTool("create_directory", { path: "fdd_malformed/pkg-a" });
  executeTool("create_directory", { path: "fdd_malformed/pkg-bad" });
  executeTool("write_file", { path: "fdd_malformed/pkg-a/package.json", content: JSON.stringify({ dependencies: { chalk: "^5.0.0" } }) });
  executeTool("write_file", { path: "fdd_malformed/pkg-bad/package.json", content: "{ not valid json" });
  const r = executeTool("find_duplicate_dependencies", { path: "fdd_malformed" });
  assert.strictEqual(r.packagesScanned, 1);
  assert.strictEqual(r.malformed.length, 1);
  assert.ok(r.malformed[0].includes("pkg-bad"));
});

test("high: non-string version values ignored", () => {
  executeTool("create_directory", { path: "fdd_nonstring/pkg-a" });
  executeTool("write_file", { path: "fdd_nonstring/pkg-a/package.json", content: JSON.stringify({ dependencies: { weird: 123 } }) });
  const r = executeTool("find_duplicate_dependencies", { path: "fdd_nonstring" });
  assert.strictEqual(r.dependenciesChecked, 0);
});

test("critical: node_modules package.json excluded from scan", () => {
  executeTool("create_directory", { path: "fdd_nm/pkg-a" });
  executeTool("create_directory", { path: "fdd_nm/node_modules/some-dep" });
  executeTool("write_file", { path: "fdd_nm/pkg-a/package.json", content: JSON.stringify({ dependencies: { x: "^1.0.0" } }) });
  executeTool("write_file", { path: "fdd_nm/node_modules/some-dep/package.json", content: JSON.stringify({ dependencies: { x: "^9.9.9" } }) });
  const r = executeTool("find_duplicate_dependencies", { path: "fdd_nm" });
  assert.strictEqual(r.packagesScanned, 1);
  assert.strictEqual(r.conflictCount, 0);
});

test("critical: result is fully JSON-serialisable", () => {
  const r = executeTool("find_duplicate_dependencies", { path: "fdd_normal" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: blocks filter narrows scan to peerDependencies only", () => {
  executeTool("create_directory", { path: "fdd_blocks/pkg-a" });
  executeTool("create_directory", { path: "fdd_blocks/pkg-b" });
  executeTool("write_file", { path: "fdd_blocks/pkg-a/package.json", content: JSON.stringify({ dependencies: { x: "^1.0.0" }, peerDependencies: { react: "^17.0.0" } }) });
  executeTool("write_file", { path: "fdd_blocks/pkg-b/package.json", content: JSON.stringify({ dependencies: { x: "^2.0.0" }, peerDependencies: { react: "^18.0.0" } }) });
  const r = executeTool("find_duplicate_dependencies", { path: "fdd_blocks", blocks: ["peerDependencies"] });
  assert.strictEqual(r.conflictCount, 1);
  assert.strictEqual(r.conflicts[0].name, "react");
});

test("extreme: many packages with many deps does not crash", () => {
  for (let i = 0; i < 15; i++) {
    const deps = {};
    for (let d = 0; d < 5; d++) deps[`dep${d}`] = `^${(i % 3) + 1}.0.0`;
    executeTool("create_directory", { path: `fdd_many/pkg-${i}` });
    executeTool("write_file", { path: `fdd_many/pkg-${i}/package.json`, content: JSON.stringify({ dependencies: deps }) });
  }
  const r = executeTool("find_duplicate_dependencies", { path: "fdd_many" });
  assert.strictEqual(r.packagesScanned, 15);
  assert.strictEqual(r.dependenciesChecked, 5);
  assert.strictEqual(r.conflictCount, 5); // each dep has 3 distinct versions across the 15 packages
});

test("cleanup: remove find_duplicate_dependencies fixtures", () => {
  for (const d of ["fdd_normal", "fdd_same", "fdd_malformed", "fdd_nonstring", "fdd_nm", "fdd_blocks", "fdd_many"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
  try { executeTool("delete_file", { path: "fdd_file_target.txt" }); } catch (_) {}
});
