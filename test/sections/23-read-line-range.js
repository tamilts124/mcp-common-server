"use strict";
/**
 * [26] READ_FILE LINE-RANGE OUTPUT — structured fromLine/toLine/returnedLines
 *
 * Context: task.md originally proposed a brand-new `read_lines` tool ("view
 * lines 100-150 of a large file without reading the whole thing"). On
 * verification, `read_file` (and `read_files`) already accepted from_line/
 * to_line — the only gap was that the returned metadata was a formatted
 * string ("100-150") instead of structured numeric fields. Rather than ship
 * a second tool that does the same thing, lib/fileOps.js's readLines() was
 * upgraded in place to return { content, totalLines, fromLine, toLine,
 * returnedLines } (returnedLines now a count, not a string) whenever a
 * range is requested. This section tests that upgraded behavior.
 *
 * Rigor levels covered:
 *   1. Normal happy-path
 *   2. Medium boundary/param validation
 *   3. High - dependency/failure handling (batch partial failure)
 *   4. Critical - security/injection/path traversal
 *   5. Extreme - fuzzing, concurrency, large files
 */
const { fs, path, assert, TMP, test, executeTool } = require("../test-harness");

const FIVE_LINES = "line1\nline2\nline3\nline4\nline5";

console.log(`\n[26] NORMAL — read_file/read_files line-range happy path`);
test("read_file with from_line/to_line returns the requested slice", () => {
  executeTool("create_file", { path: "lr-five.txt", content: FIVE_LINES });
  const r = executeTool("read_file", { path: "lr-five.txt", from_line: 2, to_line: 4 });
  assert.strictEqual(r.content, "line2\nline3\nline4");
  assert.strictEqual(r.totalLines, 5);
  assert.strictEqual(r.fromLine, 2);
  assert.strictEqual(r.toLine, 4);
  assert.strictEqual(r.returnedLines, 3);
});
test("read_file with from_line/to_line both 0 returns whole file, no range fields", () => {
  const r = executeTool("read_file", { path: "lr-five.txt" });
  assert.strictEqual(r.content, FIVE_LINES);
  assert.strictEqual(r.totalLines, 5);
  assert.strictEqual(r.fromLine, undefined);
  assert.strictEqual(r.toLine, undefined);
});
test("read_file with only from_line reads to end of file", () => {
  const r = executeTool("read_file", { path: "lr-five.txt", from_line: 4 });
  assert.strictEqual(r.content, "line4\nline5");
  assert.strictEqual(r.toLine, 5);
  assert.strictEqual(r.returnedLines, 2);
});
test("read_file with only to_line reads from start of file", () => {
  const r = executeTool("read_file", { path: "lr-five.txt", to_line: 2 });
  assert.strictEqual(r.content, "line1\nline2");
  assert.strictEqual(r.fromLine, 1);
  assert.strictEqual(r.returnedLines, 2);
});
test("read_files with per-item range applies independently per file", () => {
  executeTool("create_file", { path: "lr-a.txt", content: FIVE_LINES });
  executeTool("create_file", { path: "lr-b.txt", content: FIVE_LINES });
  const r = executeTool("read_files", { files: [
    { path: "lr-a.txt", from_line: 1, to_line: 2 },
    { path: "lr-b.txt", from_line: 4, to_line: 5 },
  ]});
  assert.strictEqual(r.results["lr-a.txt"].content, "line1\nline2");
  assert.strictEqual(r.results["lr-b.txt"].content, "line4\nline5");
});

console.log(`\n[26] MEDIUM — boundary & param validation`);
test("from_line beyond totalLines returns empty content, returnedLines 0", () => {
  const r = executeTool("read_file", { path: "lr-five.txt", from_line: 99 });
  assert.strictEqual(r.content, "");
  assert.strictEqual(r.returnedLines, 0);
  assert.strictEqual(r.totalLines, 5);
});
test("to_line beyond totalLines clamps to totalLines, no throw", () => {
  const r = executeTool("read_file", { path: "lr-five.txt", from_line: 1, to_line: 9999 });
  assert.strictEqual(r.toLine, 5);
  assert.strictEqual(r.returnedLines, 5);
});
test("negative from_line is treated as start of file (1)", () => {
  const r = executeTool("read_file", { path: "lr-five.txt", from_line: -5, to_line: 2 });
  assert.strictEqual(r.fromLine, 1);
  assert.strictEqual(r.content, "line1\nline2");
});
test("from_line equal to total returns exactly the last line", () => {
  const r = executeTool("read_file", { path: "lr-five.txt", from_line: 5 });
  assert.strictEqual(r.content, "line5");
  assert.strictEqual(r.returnedLines, 1);
});
test("single-line range (from===to) returns exactly one line", () => {
  const r = executeTool("read_file", { path: "lr-five.txt", from_line: 3, to_line: 3 });
  assert.strictEqual(r.content, "line3");
  assert.strictEqual(r.returnedLines, 1);
});

console.log(`\n[26] HIGH — dependency / failure handling`);
test("read_files: one missing file in a ranged batch fails independently, others still succeed", () => {
  const r = executeTool("read_files", { files: [
    { path: "lr-a.txt", from_line: 1, to_line: 1 },
    { path: "lr-does-not-exist.txt", from_line: 1, to_line: 1 },
  ]});
  assert.strictEqual(r.results["lr-a.txt"].content, "line1");
  assert.ok(r.results["lr-does-not-exist.txt"].error);
});
test("ranged read on a directory path throws cleanly instead of crashing", () => {
  fs.mkdirSync(path.join(TMP, "lr-dir"), { recursive: true });
  assert.throws(() => executeTool("read_file", { path: "lr-dir", from_line: 1, to_line: 2 }));
});

console.log(`\n[26] CRITICAL — security & input sanitization`);
test("path traversal is still blocked when from_line/to_line are supplied", () => {
  assert.throws(() => executeTool("read_file", { path: "../../../etc/passwd", from_line: 1, to_line: 2 }), /Access denied/);
});
test("absolute path outside root is blocked on ranged read", () => {
  const outside = process.platform === "win32" ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/passwd";
  assert.throws(() => executeTool("read_file", { path: outside, from_line: 1, to_line: 1 }));
});
test("injection-shaped content round-trips literally through a ranged read", () => {
  executeTool("create_file", { path: "lr-inject.txt", content: "safe\n'; DROP TABLE users; --\n<script>alert(1)</script>\nsafe2" });
  const r = executeTool("read_file", { path: "lr-inject.txt", from_line: 2, to_line: 3 });
  assert.strictEqual(r.content, "'; DROP TABLE users; --\n<script>alert(1)</script>");
});

console.log(`\n[26] EXTREME — fuzzing, concurrency, large files`);
test("large file (5000 lines): middle-chunk range read returns exactly the requested slice", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `row-${i + 1}`);
  executeTool("create_file", { path: "lr-big.txt", content: lines.join("\n") });
  const r = executeTool("read_file", { path: "lr-big.txt", from_line: 2000, to_line: 2009 });
  assert.strictEqual(r.totalLines, 5000);
  assert.strictEqual(r.returnedLines, 10);
  assert.strictEqual(r.content, lines.slice(1999, 2009).join("\n"));
});
test("10 concurrent ranged reads of the same large file return consistent results", () => {
  for (let i = 0; i < 10; i++) {
    const r = executeTool("read_file", { path: "lr-big.txt", from_line: 1, to_line: 3 });
    assert.strictEqual(r.content, "row-1\nrow-2\nrow-3");
  }
});
test("from_line as a numeric-looking string does not crash the process", () => {
  assert.doesNotThrow(() => executeTool("read_file", { path: "lr-five.txt", from_line: "2", to_line: "4" }));
});
test("fuzz: random non-numeric from_line/to_line values do not crash the process", () => {
  const fuzzVals = [NaN, Infinity, -Infinity, null, {}, []];
  for (const v of fuzzVals) {
    assert.doesNotThrow(() => executeTool("read_file", { path: "lr-five.txt", from_line: v, to_line: v }));
  }
});
test("cleanup: remove read-line-range fixture files", () => {
  for (const f of ["lr-five.txt", "lr-a.txt", "lr-b.txt", "lr-inject.txt", "lr-big.txt"]) {
    const p = path.join(TMP, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.rmSync(path.join(TMP, "lr-dir"), { recursive: true, force: true });
});
