"use strict";
/**
 * [69] CHECK_LINE_ENDINGS — classify LF/CRLF/mixed/none
 *
 * Rigor levels:
 *   Normal:   pure-LF and pure-CRLF files classified correctly.
 *   Medium:   file with no newlines -> "none"; nonexistent path throws -32602.
 *   High:     directory mode aggregates byEnding across files, extension filter.
 *   Critical: mixed file (both CRLF and bare LF) detected with correct counts;
 *             binary file skipped (binarySkipped++, not classified/thrown).
 *   Extreme:  max_mixed_files caps mixedFiles list and sets mixedTruncated.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[69] CHECK_LINE_ENDINGS — line ending classification`);

test("normal: pure LF file classified as LF", () => {
  executeTool("write_file", { path: "le1.txt", content: "a\nb\nc\n" });
  const r = executeTool("check_line_endings", { path: "le1.txt" });
  assert.strictEqual(r.byEnding.LF, 1);
  assert.strictEqual(r.filesScanned, 1);
});

test("normal: pure CRLF file classified as CRLF", () => {
  executeTool("write_file", { path: "le2.txt", content: "a\r\nb\r\nc\r\n" });
  const r = executeTool("check_line_endings", { path: "le2.txt" });
  assert.strictEqual(r.byEnding.CRLF, 1);
});

test("medium: file with no newlines classified as none", () => {
  executeTool("write_file", { path: "le3.txt", content: "no newlines here" });
  const r = executeTool("check_line_endings", { path: "le3.txt" });
  assert.strictEqual(r.byEnding.none, 1);
});

test("medium: nonexistent path throws -32602", () => {
  try {
    executeTool("check_line_endings", { path: "le_does_not_exist.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("high: directory mode aggregates across files, extension filter works", () => {
  executeTool("create_directory", { path: "le_dir" });
  executeTool("write_file", { path: "le_dir/a.txt", content: "x\ny\n" });
  executeTool("write_file", { path: "le_dir/b.md", content: "x\r\ny\r\n" });
  const rAll = executeTool("check_line_endings", { path: "le_dir" });
  assert.strictEqual(rAll.filesScanned, 2);
  assert.strictEqual(rAll.byEnding.LF, 1);
  assert.strictEqual(rAll.byEnding.CRLF, 1);
  const rTxt = executeTool("check_line_endings", { path: "le_dir", extensions: [".txt"] });
  assert.strictEqual(rTxt.filesScanned, 1);
});

test("critical: mixed file detected with correct lf/crlf counts", () => {
  executeTool("write_file", { path: "le4.txt", content: "a\r\nb\nc\r\nd\n" });
  const r = executeTool("check_line_endings", { path: "le4.txt" });
  assert.strictEqual(r.byEnding.mixed, 1);
  assert.strictEqual(r.mixedFiles.length, 1);
  assert.strictEqual(r.mixedFiles[0].crlfCount, 2);
  assert.strictEqual(r.mixedFiles[0].lfCount, 2);
});

test("critical: binary file is skipped, not classified or thrown", () => {
  const bin = Buffer.from([0x00, 0x01, 0x02, 0x0a, 0x00]).toString("base64");
  executeTool("base64_decode", { data: bin, destination: "le5.bin" });
  const r = executeTool("check_line_endings", { path: "le5.bin" });
  assert.strictEqual(r.binarySkipped, 1);
  assert.strictEqual(r.byEnding.LF, 0);
  assert.strictEqual(r.byEnding.CRLF, 0);
  assert.strictEqual(r.byEnding.mixed, 0);
  assert.strictEqual(r.byEnding.none, 0);
});

test("extreme: max_mixed_files caps list and sets mixedTruncated", () => {
  executeTool("create_directory", { path: "le_dir2" });
  for (let i = 0; i < 5; i++) {
    executeTool("write_file", { path: `le_dir2/m${i}.txt`, content: "a\r\nb\nc\r\nd\n" });
  }
  const r = executeTool("check_line_endings", { path: "le_dir2", max_mixed_files: 2 });
  assert.strictEqual(r.mixedFiles.length, 2);
  assert.strictEqual(r.mixedTruncated, true);
  assert.strictEqual(r.byEnding.mixed, 5);
});

test("cleanup: remove check_line_endings fixtures", () => {
  for (const f of ["le1.txt", "le2.txt", "le3.txt", "le4.txt", "le5.bin"]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
  try { executeTool("delete_directory", { path: "le_dir", recursive: true }); } catch (_) {}
  try { executeTool("delete_directory", { path: "le_dir2", recursive: true }); } catch (_) {}
});
