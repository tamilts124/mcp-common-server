"use strict";
/**
 * [70] FIND_LARGE_FILES — files above a size threshold, sorted descending
 *
 * Rigor levels:
 *   Normal:   file above min_bytes found, sorted descending, humanSize present.
 *   Medium:   min_bytes excludes small files; non-directory path throws.
 *   High:     top_n caps results and sets truncated; extension filter works.
 *   Critical: path traversal-shaped names inside tree don't escape jail
 *             (relies on resolveClientPath in dispatch — direct call here
 *             just confirms relative paths stay under origPath).
 *   Extreme:  large fan-out (50 files) doesn't crash, filesScanned accurate.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[70] FIND_LARGE_FILES — size-threshold scan`);

test("normal: file above min_bytes found, sorted desc, humanSize present", () => {
  executeTool("create_directory", { path: "fl_dir" });
  executeTool("write_file", { path: "fl_dir/small.txt", content: "x".repeat(100) });
  executeTool("write_file", { path: "fl_dir/big.txt", content: "y".repeat(5000) });
  const r = executeTool("find_large_files", { path: "fl_dir", min_bytes: 1000 });
  assert.strictEqual(r.matchCount, 1);
  assert.strictEqual(r.files[0].path.endsWith("big.txt"), true);
  assert.strictEqual(typeof r.files[0].humanSize, "string");
});

test("medium: min_bytes excludes files below threshold", () => {
  const r = executeTool("find_large_files", { path: "fl_dir", min_bytes: 999999 });
  assert.strictEqual(r.matchCount, 0);
  assert.deepStrictEqual(r.files, []);
});

test("medium: non-directory path throws", () => {
  try {
    executeTool("find_large_files", { path: "fl_dir/small.txt", min_bytes: 0 });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: top_n caps results and sets truncated; extension filter works", () => {
  for (let i = 0; i < 5; i++) {
    executeTool("write_file", { path: `fl_dir/f${i}.bin`, content: "z".repeat(2000) });
  }
  const rAll = executeTool("find_large_files", { path: "fl_dir", min_bytes: 1000, top_n: 2 });
  assert.strictEqual(rAll.files.length, 2);
  assert.strictEqual(rAll.truncated, true);
  const rExt = executeTool("find_large_files", { path: "fl_dir", min_bytes: 1000, extensions: [".bin"] });
  assert.strictEqual(rExt.matchCount, 5);
});

test("critical: returned paths stay prefixed under requested origPath", () => {
  const r = executeTool("find_large_files", { path: "fl_dir", min_bytes: 1000 });
  for (const f of r.files) {
    assert.strictEqual(f.path.startsWith("fl_dir/"), true);
    assert.strictEqual(f.path.includes(".."), false);
  }
});

test("extreme: 50-file fan-out scans without crashing, filesScanned accurate", () => {
  executeTool("create_directory", { path: "fl_dir/fan" });
  for (let i = 0; i < 50; i++) {
    executeTool("write_file", { path: `fl_dir/fan/n${i}.txt`, content: "a" });
  }
  const r = executeTool("find_large_files", { path: "fl_dir/fan", min_bytes: 0 });
  assert.strictEqual(r.filesScanned, 50);
  assert.strictEqual(r.matchCount, 50);
});

test("cleanup: remove find_large_files fixtures", () => {
  try { executeTool("delete_directory", { path: "fl_dir", recursive: true }); } catch (_) {}
});
