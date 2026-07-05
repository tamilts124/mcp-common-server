"use strict";
/**
 * [126] FIND_ORPHANED_TEST_FILES — test files whose source no longer exists
 *
 * Rigor levels:
 *   Normal:   same-dir source present -> not orphaned; source missing -> orphaned.
 *   Medium:   non-directory path throws; max_results type mismatch throws;
 *             non-test file ignored (not counted as testFilesScanned).
 *   High:     tests/ -> src/ directory-swap candidate resolves; Python and Go
 *             naming conventions recognised.
 *   Critical: path traversal via path arg blocked; malicious filename text
 *             treated as inert string.
 *   Extreme:  max_results caps + truncated flag; result JSON-serialisable;
 *             orphaned sorted alphabetically.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[126] FIND_ORPHANED_TEST_FILES — test-file source reachability`);

test("normal: same-directory source present is not orphaned", () => {
  executeTool("create_directory", { path: "otf_present" });
  executeTool("write_file", { path: "otf_present/foo.js", content: "module.exports = {};" });
  executeTool("write_file", { path: "otf_present/foo.test.js", content: "// test" });
  const r = executeTool("find_orphaned_test_files", { path: "otf_present" });
  assert.strictEqual(r.testFilesScanned, 1);
  assert.strictEqual(r.orphanedCount, 0);
});

test("normal: missing source file is reported orphaned", () => {
  executeTool("create_directory", { path: "otf_missing" });
  executeTool("write_file", { path: "otf_missing/bar.test.js", content: "// test" });
  const r = executeTool("find_orphaned_test_files", { path: "otf_missing" });
  assert.strictEqual(r.orphanedCount, 1);
  assert.strictEqual(r.orphaned[0].file, "bar.test.js");
  assert.ok(r.orphaned[0].expectedSourceCandidates.includes("bar.js"));
});

test("medium: non-directory path throws", () => {
  try {
    executeTool("find_orphaned_test_files", { path: "otf_present/foo.js" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_orphaned_test_files", { path: "otf_present", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: non-test file is not counted as a test file", () => {
  executeTool("create_directory", { path: "otf_plain" });
  executeTool("write_file", { path: "otf_plain/readme.txt", content: "hello" });
  const r = executeTool("find_orphaned_test_files", { path: "otf_plain" });
  assert.strictEqual(r.testFilesScanned, 0);
  assert.strictEqual(r.orphanedCount, 0);
});

test("high: tests/ -> src/ directory-swap candidate resolves as not orphaned", () => {
  executeTool("create_directory", { path: "otf_swap/tests" });
  executeTool("create_directory", { path: "otf_swap/src" });
  executeTool("write_file", { path: "otf_swap/src/widget.js", content: "module.exports = {};" });
  executeTool("write_file", { path: "otf_swap/tests/widget.test.js", content: "// test" });
  const r = executeTool("find_orphaned_test_files", { path: "otf_swap" });
  assert.strictEqual(r.orphanedCount, 0);
});

test("high: Python and Go naming conventions recognised", () => {
  executeTool("create_directory", { path: "otf_lang" });
  executeTool("write_file", { path: "otf_lang/util.py", content: "x = 1" });
  executeTool("write_file", { path: "otf_lang/test_util.py", content: "x = 1" });
  executeTool("write_file", { path: "otf_lang/orphan_test.py", content: "x = 1" });
  executeTool("write_file", { path: "otf_lang/server_test.go", content: "x := 1" });
  const r = executeTool("find_orphaned_test_files", { path: "otf_lang" });
  assert.strictEqual(r.testFilesScanned, 3);
  assert.strictEqual(r.orphanedCount, 2); // orphan_test.py and server_test.go have no source
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_orphaned_test_files", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped filename is treated as inert text", () => {
  executeTool("create_directory", { path: "otf_inj" });
  executeTool("write_file", { path: "otf_inj/$(rm -rf /).test.js", content: "// test" });
  const r = executeTool("find_orphaned_test_files", { path: "otf_inj" });
  assert.strictEqual(r.orphanedCount, 1);
  assert.ok(r.orphaned[0].file.includes("$(rm -rf /)"));
});

test("extreme: max_results caps orphaned list and sets truncated", () => {
  executeTool("create_directory", { path: "otf_many" });
  for (let i = 0; i < 5; i++) {
    executeTool("write_file", { path: `otf_many/f${i}.test.js`, content: "// test" });
  }
  const r = executeTool("find_orphaned_test_files", { path: "otf_many", max_results: 2 });
  assert.strictEqual(r.orphaned.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.orphanedCount, 5);
});

test("extreme: orphaned list sorted alphabetically", () => {
  const r = executeTool("find_orphaned_test_files", { path: "otf_many" });
  const files = r.orphaned.map(o => o.file);
  assert.deepStrictEqual(files, [...files].sort());
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_orphaned_test_files", { path: "otf_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_orphaned_test_files fixtures", () => {
  for (const d of ["otf_present", "otf_missing", "otf_plain", "otf_swap", "otf_lang", "otf_inj", "otf_many"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
