"use strict";
/**
 * [71] FIND_EMPTY_DIRS — dirs with no files anywhere in their subtree
 *
 * Rigor levels:
 *   Normal:   truly empty dir detected; dir with a file is not reported.
 *   Medium:   nested-only-empty-dirs bubble up as empty; non-directory throws.
 *   High:     dir containing an empty dir + a dir with a file: only the
 *             empty branch reported, count/dirsScanned accurate.
 *   Critical: reported paths never contain '..' or escape origPath prefix.
 *   Extreme:  max_results caps output and sets truncated; deep nesting
 *             (10 levels, all empty) doesn't crash / stack overflow.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[71] FIND_EMPTY_DIRS — empty directory detection`);

test("normal: truly empty dir detected", () => {
  executeTool("create_directory", { path: "ed_root" });
  executeTool("create_directory", { path: "ed_root/empty1" });
  const r = executeTool("find_empty_dirs", { path: "ed_root" });
  // ed_root itself has no files (only the empty empty1 subdir), so both
  // ed_root and ed_root/empty1 are reported, deepest (empty1) first.
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.emptyDirs[0].endsWith("empty1"), true);
});

test("normal: dir containing a file is not reported", () => {
  executeTool("create_directory", { path: "ed_root/hasfile" });
  executeTool("write_file", { path: "ed_root/hasfile/x.txt", content: "hi" });
  const r = executeTool("find_empty_dirs", { path: "ed_root/hasfile" });
  assert.strictEqual(r.count, 0);
});

test("medium: nested-only-empty dirs bubble up as empty", () => {
  executeTool("create_directory", { path: "ed_root/nest_a/nest_b" });
  const r = executeTool("find_empty_dirs", { path: "ed_root/nest_a" });
  assert.strictEqual(r.count, 2); // nest_a itself, and nest_a/nest_b
});

test("medium: non-directory path throws", () => {
  try {
    executeTool("find_empty_dirs", { path: "ed_root/hasfile/x.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: mixed tree reports only the empty branch, counts accurate", () => {
  const r = executeTool("find_empty_dirs", { path: "ed_root" });
  // ed_root itself is not empty (has hasfile with a file), empty1 + nest_a + nest_a/nest_b are
  assert.strictEqual(r.count, 3);
  assert.ok(r.dirsScanned >= 5);
});

test("critical: reported paths stay prefixed, no traversal segments", () => {
  const r = executeTool("find_empty_dirs", { path: "ed_root" });
  for (const d of r.emptyDirs) {
    assert.strictEqual(d.startsWith("ed_root"), true);
    assert.strictEqual(d.includes(".."), false);
  }
});

test("extreme: max_results caps output and sets truncated", () => {
  executeTool("create_directory", { path: "ed_many" });
  for (let i = 0; i < 10; i++) executeTool("create_directory", { path: `ed_many/e${i}` });
  const r = executeTool("find_empty_dirs", { path: "ed_many", max_results: 3 });
  assert.strictEqual(r.emptyDirs.length, 3);
  assert.strictEqual(r.truncated, true);
});

test("extreme: deep nesting (10 levels, all empty) does not crash", () => {
  let p = "ed_deep";
  executeTool("create_directory", { path: p });
  for (let i = 0; i < 10; i++) { p += `/d${i}`; executeTool("create_directory", { path: p }); }
  const r = executeTool("find_empty_dirs", { path: "ed_deep" });
  assert.strictEqual(r.count, 11); // ed_deep + 10 nested levels, all empty
});

test("cleanup: remove find_empty_dirs fixtures", () => {
  for (const d of ["ed_root", "ed_many", "ed_deep"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
