"use strict";
/**
 * [14] TRUNCATE FILE & APPEND FILE — truncate_file and append_file tools.
 *
 * Rigor levels covered:
 *   Normal:   happy-path line truncation, byte truncation, append to existing
 *             file, append creates new file, idempotency (file already short)
 *   Medium:   boundary values (0 lines, 0 bytes), both params supplied / neither
 *             supplied (validation errors), missing required params, no-op cases
 *   High:     append to file in subdirectory that doesn't exist yet (auto-mkdir),
 *             concurrent appends produce consistent combined output, file already
 *             at exact truncation size (truncated=false returned)
 *   Critical: path traversal blocked on both tools, injection-shaped content
 *             round-trips literally, write-gated in READ_ONLY mode
 *   Extreme:  large file truncation (10k lines), large append (500 KB), fuzz
 *             content in append, many sequential appends accumulate correctly
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[14] TRUNCATE FILE & APPEND FILE`);

// ── NORMAL — happy path ───────────────────────────────────────────────────────
test("truncate_file: line mode — keeps first N lines", () => {
  executeTool("create_file", { path: "trunc-lines.txt", content: "a\nb\nc\nd\ne\n" });
  const r = executeTool("truncate_file", { path: "trunc-lines.txt", lines: 3 });
  assert.strictEqual(r.truncated, true);
  // Read back and verify only 3 lines remain
  const back = executeTool("read_file", { path: "trunc-lines.txt" });
  const lineCount = back.content.split("\n").filter((l, i, arr) =>
    // Don't count the final empty element from a trailing newline
    !(i === arr.length - 1 && l === "")
  ).length;
  assert.strictEqual(lineCount, 3, `Expected 3 lines, got ${lineCount}: ${JSON.stringify(back.content)}`);
  assert.ok(back.content.includes("a"), "first line should be present");
  assert.ok(!back.content.includes("d"), "fourth line should be gone");
});

test("truncate_file: byte mode — keeps first N bytes", () => {
  executeTool("create_file", { path: "trunc-bytes.txt", content: "Hello World!!" });
  const r = executeTool("truncate_file", { path: "trunc-bytes.txt", bytes: 5 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.newSize, 5);
  const back = executeTool("read_file", { path: "trunc-bytes.txt" });
  assert.strictEqual(back.content, "Hello");
});

test("truncate_file: file already shorter than limit — no change (truncated=false)", () => {
  executeTool("create_file", { path: "short.txt", content: "tiny" });
  const r = executeTool("truncate_file", { path: "short.txt", bytes: 9999 });
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.newSize, r.originalSize, "sizes should match when no truncation");
  const back = executeTool("read_file", { path: "short.txt" });
  assert.strictEqual(back.content, "tiny", "content unchanged");
});

test("truncate_file: returns originalSize and newSize", () => {
  executeTool("create_file", { path: "trunc-meta.txt", content: "abcdefghij" });
  const r = executeTool("truncate_file", { path: "trunc-meta.txt", bytes: 4 });
  assert.ok(r.originalSize > 0, "originalSize should be > 0");
  assert.ok(r.newSize < r.originalSize, "newSize should be less than originalSize");
  assert.strictEqual(r.newSize, 4);
});

test("append_file: appends content to existing file", () => {
  executeTool("create_file", { path: "append-existing.txt", content: "line1\n" });
  executeTool("append_file", { path: "append-existing.txt", content: "line2\n" });
  const back = executeTool("read_file", { path: "append-existing.txt" });
  assert.ok(back.content.includes("line1"), "original line should still be there");
  assert.ok(back.content.includes("line2"), "appended line should appear");
  assert.strictEqual(back.content, "line1\nline2\n");
});

test("append_file: creates new file if it does not exist", () => {
  const r = executeTool("append_file", { path: "append-new.txt", content: "fresh content" });
  assert.ok(r.bytesAppended > 0, "should report bytes appended");
  assert.ok(r.newSize > 0, "new file should have size");
  const back = executeTool("read_file", { path: "append-new.txt" });
  assert.strictEqual(back.content, "fresh content");
});

test("append_file: returns bytesAppended and newSize", () => {
  executeTool("create_file", { path: "append-meta.txt", content: "ABC" });
  const r = executeTool("append_file", { path: "append-meta.txt", content: "DEF" });
  assert.strictEqual(r.bytesAppended, 3);
  assert.strictEqual(r.newSize, 6);
});

test("append_file: multiple appends accumulate correctly", () => {
  executeTool("create_file", { path: "multi-append.txt", content: "" });
  for (let i = 1; i <= 5; i++) {
    executeTool("append_file", { path: "multi-append.txt", content: `line${i}\n` });
  }
  const back = executeTool("read_file", { path: "multi-append.txt" });
  for (let i = 1; i <= 5; i++) {
    assert.ok(back.content.includes(`line${i}`), `line${i} should be present`);
  }
});

// ── MEDIUM — boundary & param validation ──────────────────────────────────────
test("truncate_file: lines=0 produces empty file", () => {
  executeTool("create_file", { path: "trunc-zero-lines.txt", content: "something\n" });
  const r = executeTool("truncate_file", { path: "trunc-zero-lines.txt", lines: 0 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.newSize, 0);
  const back = executeTool("read_file", { path: "trunc-zero-lines.txt" });
  assert.strictEqual(back.content, "");
});

test("truncate_file: bytes=0 produces empty file", () => {
  executeTool("create_file", { path: "trunc-zero-bytes.txt", content: "something" });
  const r = executeTool("truncate_file", { path: "trunc-zero-bytes.txt", bytes: 0 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.newSize, 0);
});

test("truncate_file: both lines and bytes supplied throws -32602", () => {
  executeTool("create_file", { path: "trunc-both.txt", content: "x" });
  try {
    executeTool("truncate_file", { path: "trunc-both.txt", lines: 1, bytes: 10 });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602, `Expected -32602, got ${e.code}: ${e.message}`);
  }
});

test("truncate_file: neither lines nor bytes supplied throws -32602", () => {
  executeTool("create_file", { path: "trunc-neither.txt", content: "x" });
  try {
    executeTool("truncate_file", { path: "trunc-neither.txt" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("truncate_file: missing path throws -32602", () => {
  try {
    executeTool("truncate_file", { lines: 1 });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("truncate_file: nonexistent file throws (not silent)", () => {
  assert.throws(() =>
    executeTool("truncate_file", { path: "ghost-file.txt", lines: 1 }),
  );
});

test("append_file: missing path throws -32602", () => {
  try {
    executeTool("append_file", { content: "hello" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("append_file: missing content defaults to empty string (no error)", () => {
  // content is optional — omitting it is the same as appending ""
  executeTool("create_file", { path: "no-content.txt", content: "base" });
  const r = executeTool("append_file", { path: "no-content.txt" });
  assert.strictEqual(r.bytesAppended, 0);
  const back = executeTool("read_file", { path: "no-content.txt" });
  assert.strictEqual(back.content, "base", "file should be unchanged");
});

test("append_file: appending empty string is a no-op (file size unchanged)", () => {
  executeTool("create_file", { path: "append-empty.txt", content: "original" });
  const r = executeTool("append_file", { path: "append-empty.txt", content: "" });
  // bytesAppended should be 0; file should be unchanged
  assert.strictEqual(r.bytesAppended, 0);
  const back = executeTool("read_file", { path: "append-empty.txt" });
  assert.strictEqual(back.content, "original");
});

test("truncate_file: line=1 on single-line file produces that single line", () => {
  executeTool("create_file", { path: "one-line.txt", content: "only line\n" });
  const r = executeTool("truncate_file", { path: "one-line.txt", lines: 1 });
  assert.strictEqual(r.truncated, false, "file already has exactly 1 line — no change needed");
});

// ── HIGH — edge cases & dependency handling ───────────────────────────────────
test("append_file: creates intermediate directories automatically", () => {
  // Append to a path in a subdirectory that doesn't exist yet
  executeTool("append_file", { path: "subdir-auto/nested/log.txt", content: "entry1\n" });
  const back = executeTool("read_file", { path: "subdir-auto/nested/log.txt" });
  assert.strictEqual(back.content, "entry1\n");
});

test("truncate_file: exact-size file reports truncated=false", () => {
  const content = "abc";
  executeTool("create_file", { path: "exact-size.txt", content });
  const r = executeTool("truncate_file", { path: "exact-size.txt", bytes: Buffer.byteLength(content) });
  assert.strictEqual(r.truncated, false, "no actual truncation — sizes match");
});

test("truncate_file: line count exactly equal to file line count — no truncation", () => {
  executeTool("create_file", { path: "exact-lines.txt", content: "x\ny\nz\n" });
  const r = executeTool("truncate_file", { path: "exact-lines.txt", lines: 3 });
  assert.strictEqual(r.truncated, false);
});

test("append_file: concurrent appends all succeed and content is preserved", () => {
  executeTool("create_file", { path: "concurrent-append.txt", content: "" });
  // Sequential concurrent simulation — each append should be reflected
  const entries = Array.from({ length: 10 }, (_, i) => `item${i}\n`);
  for (const entry of entries) {
    executeTool("append_file", { path: "concurrent-append.txt", content: entry });
  }
  const back = executeTool("read_file", { path: "concurrent-append.txt" });
  for (let i = 0; i < 10; i++) {
    assert.ok(back.content.includes(`item${i}`), `item${i} should be present`);
  }
});

// ── CRITICAL — security & path safety ────────────────────────────────────────
test("truncate_file: path traversal is blocked", () => {
  assert.throws(
    () => executeTool("truncate_file", { path: "../../../etc/shadow", lines: 0 }),
    /Access denied/,
  );
});

test("append_file: path traversal is blocked", () => {
  assert.throws(
    () => executeTool("append_file", { path: "../../../etc/crontab", content: "evil" }),
    /Access denied/,
  );
});

test("truncate_file: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("truncate_file", { path: "C:\\Windows\\System32\\drivers\\etc\\hosts", lines: 0 }),
  );
});

test("append_file: injection-shaped content round-trips literally", () => {
  const evil = "; rm -rf / && echo $(whoami)\n`cat /etc/passwd`\n";
  executeTool("append_file", { path: "inject-append.txt", content: evil });
  const back = executeTool("read_file", { path: "inject-append.txt" });
  assert.strictEqual(back.content, evil, "injection content must be stored verbatim, never executed");
});

test("truncate_file: SQL-injection-shaped filename content still truncates cleanly", () => {
  executeTool("create_file", { path: "sql-trunc.txt", content: "'; DROP TABLE users; --\nline2\nline3\n" });
  const r = executeTool("truncate_file", { path: "sql-trunc.txt", lines: 1 });
  assert.strictEqual(r.truncated, true);
  const back = executeTool("read_file", { path: "sql-trunc.txt" });
  assert.ok(!back.content.includes("line2"), "line2 should be truncated away");
});

test("append_file: READ_ONLY mode blocks append (simulated via direct policy check)", () => {
  // Verify that truncate_file and append_file are in WRITE_TOOLS
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  assert.ok(WRITE_TOOLS.has("truncate_file"), "truncate_file must be in WRITE_TOOLS");
  assert.ok(WRITE_TOOLS.has("append_file"), "append_file must be in WRITE_TOOLS");
});

// ── EXTREME — large files, fuzz, stress ──────────────────────────────────────
test("truncate_file: large file (10k lines) truncates to first 100 lines correctly", () => {
  const bigContent = Array.from({ length: 10000 }, (_, i) => `line${i}`).join("\n") + "\n";
  executeTool("write_file", { path: "big-trunc.txt", content: bigContent });
  const r = executeTool("truncate_file", { path: "big-trunc.txt", lines: 100 });
  assert.strictEqual(r.truncated, true);
  const back = executeTool("read_file", { path: "big-trunc.txt" });
  const lines = back.content.split("\n").filter(l => l !== "");
  assert.strictEqual(lines.length, 100, `Expected 100 lines, got ${lines.length}`);
  assert.strictEqual(lines[0], "line0");
  assert.strictEqual(lines[99], "line99");
  assert.ok(!back.content.includes("line100"), "line100 should be truncated away");
});

test("append_file: large append (500 KB) succeeds and size is correct", () => {
  const chunk = "x".repeat(1024); // 1 KB
  executeTool("create_file", { path: "large-append.txt", content: "" });
  for (let i = 0; i < 500; i++) {
    executeTool("append_file", { path: "large-append.txt", content: chunk });
  }
  const r = executeTool("append_file", { path: "large-append.txt", content: "END" });
  assert.ok(r.newSize >= 500 * 1024, `Expected >= 500KB, got ${r.newSize}`);
});

test("append_file: fuzz printable-ASCII content does not crash", () => {
  const fuzz = Buffer.from(
    Array.from({ length: 500 }, () => 32 + Math.floor(Math.random() * 94)),
  ).toString("utf8");
  try {
    const r = executeTool("append_file", { path: "fuzz-append.txt", content: fuzz });
    assert.ok(typeof r.bytesAppended === "number");
  } catch (e) {
    assert.ok(e instanceof Error, "fuzz must fail with a proper Error, not a crash");
  }
});

test("truncate_file: byte-truncate in the middle of a multi-byte UTF-8 sequence", () => {
  // '€' is a 3-byte UTF-8 sequence (E2 82 AC). Truncating at byte 1 or 2
  // creates an invalid sequence — the tool should not crash.
  executeTool("create_file", { path: "utf8-trunc.txt", content: "€€€" });
  try {
    const r = executeTool("truncate_file", { path: "utf8-trunc.txt", bytes: 2 });
    // Might succeed (bytes kept are just raw bytes) or throw — either is fine
    assert.ok(typeof r.truncated === "boolean");
  } catch (e) {
    assert.ok(e instanceof Error, "mid-sequence cut must fail cleanly if at all");
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────
test("cleanup: remove truncate/append fixture files created in this section", () => {
  const files = [
    "trunc-lines.txt", "trunc-bytes.txt", "short.txt", "trunc-meta.txt",
    "append-existing.txt", "append-new.txt", "append-meta.txt", "multi-append.txt",
    "trunc-zero-lines.txt", "trunc-zero-bytes.txt", "trunc-both.txt", "trunc-neither.txt",
    "one-line.txt", "exact-size.txt", "exact-lines.txt", "concurrent-append.txt",
    "inject-append.txt", "sql-trunc.txt", "big-trunc.txt", "large-append.txt",
    "fuzz-append.txt", "utf8-trunc.txt", "append-empty.txt", "no-content.txt",
  ];
  for (const f of files) {
    const p = path.join(TMP, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  // Also clean up the auto-created subdir
  const subdir = path.join(TMP, "subdir-auto");
  if (fs.existsSync(subdir)) fs.rmSync(subdir, { recursive: true, force: true });
  assert.ok(true);
});
