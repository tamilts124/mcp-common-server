"use strict";
/**
 * [66] SCAN_CONFLICT_MARKERS — find unresolved git conflict markers
 *
 * Rigor levels:
 *   Normal:   file with start/separator/end markers detected with correct
 *             line numbers and markerType.
 *   Medium:   clean file (no markers) returns empty matches; nonexistent
 *             path throws -32602.
 *   High:     directory mode across multiple files, extension filtering.
 *   Critical: lines that merely resemble markers (6 or 8 '<' chars, markers
 *             embedded mid-line) are NOT falsely matched; binary file skipped.
 *   Extreme:  max_matches caps + truncated flag; large file with many markers.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[66] SCAN_CONFLICT_MARKERS — unresolved merge markers`);

test("normal: detects start/separator/end with correct lines and types", () => {
  const content = "line1\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch-b\nline7\n";
  executeTool("write_file", { path: "cm1.txt", content });
  const r = executeTool("scan_conflict_markers", { path: "cm1.txt" });
  assert.strictEqual(r.totalMatches, 3);
  assert.strictEqual(r.matches[0].line, 2);
  assert.strictEqual(r.matches[0].markerType, "start");
  assert.strictEqual(r.matches[1].line, 4);
  assert.strictEqual(r.matches[1].markerType, "separator");
  assert.strictEqual(r.matches[2].line, 6);
  assert.strictEqual(r.matches[2].markerType, "end");
  assert.strictEqual(r.filesAffected, 1);
});

test("medium: clean file returns empty matches", () => {
  executeTool("write_file", { path: "cm2.txt", content: "nothing to see here\njust normal text\n" });
  const r = executeTool("scan_conflict_markers", { path: "cm2.txt" });
  assert.strictEqual(r.totalMatches, 0);
  assert.deepStrictEqual(r.matches, []);
});

test("medium: nonexistent path throws -32602", () => {
  try {
    executeTool("scan_conflict_markers", { path: "cm_does_not_exist.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("high: directory mode finds markers across files, extension filter works", () => {
  executeTool("create_directory", { path: "cm_dir" });
  executeTool("write_file", { path: "cm_dir/a.js", content: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n" });
  executeTool("write_file", { path: "cm_dir/b.md", content: "<<<<<<< HEAD\nz\n=======\nw\n>>>>>>> c\n" });
  const rAll = executeTool("scan_conflict_markers", { path: "cm_dir" });
  assert.strictEqual(rAll.filesAffected, 2);
  const rJs = executeTool("scan_conflict_markers", { path: "cm_dir", extensions: [".js"] });
  assert.strictEqual(rJs.filesAffected, 1);
  assert.strictEqual(rJs.matches[0].file.endsWith("a.js"), true);
});

test("critical: near-miss patterns are not falsely matched", () => {
  const content = [
    "<<<<<< six angle brackets",       // 6, not 7 — no match
    "<<<<<<<< eight angle brackets",   // 8 — no match (strict 7)
    "text <<<<<<< mid-line not at start", // not at line start — no match
    "======", // 6 equals — no match
    "========", // 8 equals — no match
  ].join("\n");
  executeTool("write_file", { path: "cm3.txt", content });
  const r = executeTool("scan_conflict_markers", { path: "cm3.txt" });
  assert.strictEqual(r.totalMatches, 0);
});

test("extreme: max_matches caps results and sets truncated", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push("<<<<<<< HEAD", "x", "=======", "y", ">>>>>>> b");
  executeTool("write_file", { path: "cm4.txt", content: lines.join("\n") });
  const r = executeTool("scan_conflict_markers", { path: "cm4.txt", max_matches: 10 });
  assert.strictEqual(r.matches.length, 10);
  assert.strictEqual(r.truncated, true);
});

test("cleanup: remove scan_conflict_markers fixtures", () => {
  for (const f of ["cm1.txt", "cm2.txt", "cm3.txt", "cm4.txt"]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
  try { executeTool("delete_directory", { path: "cm_dir", recursive: true }); } catch (_) {}
});
