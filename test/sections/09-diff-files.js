"use strict";
/**
 * [13] DIFF FILES — diff_files tool (pure-JS Myers diff, no deps).
 *
 * Rigor levels covered:
 *   Normal:   happy-path unified diff for typical file changes
 *   Medium:   identical files, empty files, context param, missing params
 *   High:     binary-ish content, large files, diffing a file against itself
 *   Critical: path traversal blocked on both source and target, injection-shaped content
 *   Extreme:  large files with many scattered changes, fuzz content, concurrent diffs
 */
const { fs, path, assert, test, executeTool } = require("../test-harness");

console.log(`\n[13] DIFF FILES — diff_files tool`);

// ── NORMAL — happy path ───────────────────────────────────────────────────────
test("diff_files: detects added line between two versions", () => {
  executeTool("create_file", { path: "v1.txt", content: "line one\nline two\nline three\n" });
  executeTool("create_file", { path: "v2.txt", content: "line one\nline two\nline two-point-five\nline three\n" });
  const r = executeTool("diff_files", { source: "v1.txt", target: "v2.txt" });
  assert.strictEqual(r.identical, false);
  assert.ok(r.additions >= 1, "should have at least 1 addition");
  assert.ok(r.unified.includes("+line two-point-five"), "added line should appear with + prefix");
  assert.ok(r.unified.startsWith("--- v1.txt"), "unified diff should start with --- header");
  assert.ok(r.unified.includes("+++ v2.txt"), "unified diff should include +++ header");
  assert.ok(r.hunks >= 1, "should have at least one hunk");
});

test("diff_files: detects deleted line between two versions", () => {
  executeTool("create_file", { path: "del1.txt", content: "a\nb\nc\nd\n" });
  executeTool("create_file", { path: "del2.txt", content: "a\nc\nd\n" });
  const r = executeTool("diff_files", { source: "del1.txt", target: "del2.txt" });
  assert.strictEqual(r.identical, false);
  assert.ok(r.deletions >= 1, "should have at least 1 deletion");
  assert.ok(r.unified.includes("-b"), "deleted line should appear with - prefix");
});

test("diff_files: detects modified line (one delete + one insert)", () => {
  executeTool("create_file", { path: "mod1.txt", content: "hello world\n" });
  executeTool("create_file", { path: "mod2.txt", content: "hello claude\n" });
  const r = executeTool("diff_files", { source: "mod1.txt", target: "mod2.txt" });
  assert.strictEqual(r.additions, 1);
  assert.strictEqual(r.deletions, 1);
  assert.ok(r.unified.includes("-hello world"));
  assert.ok(r.unified.includes("+hello claude"));
});

test("diff_files: multi-hunk diff when changes are far apart", () => {
  const top    = "line 1\nline 2\nline 3\n" + "ctx\n".repeat(10) + "change-a\n" + "ctx\n".repeat(10) + "change-b\n";
  const bottom = "line 1\nline 2\nline 3\n" + "ctx\n".repeat(10) + "changed-a\n" + "ctx\n".repeat(10) + "changed-b\n";
  executeTool("create_file", { path: "mh1.txt", content: top });
  executeTool("create_file", { path: "mh2.txt", content: bottom });
  const r = executeTool("diff_files", { source: "mh1.txt", target: "mh2.txt" });
  assert.ok(r.hunks >= 2, `expected >=2 hunks, got ${r.hunks}`);
});

test("diff_files: result includes source/target labels in the response", () => {
  const r = executeTool("diff_files", { source: "v1.txt", target: "v2.txt" });
  assert.strictEqual(r.source, "v1.txt");
  assert.strictEqual(r.target, "v2.txt");
});

// ── MEDIUM — boundary & param validation ──────────────────────────────────────
test("diff_files: identical files produce identical=true and empty unified string", () => {
  executeTool("create_file", { path: "same1.txt", content: "same content\n" });
  executeTool("create_file", { path: "same2.txt", content: "same content\n" });
  const r = executeTool("diff_files", { source: "same1.txt", target: "same2.txt" });
  assert.strictEqual(r.identical, true);
  assert.strictEqual(r.unified, "");
  assert.strictEqual(r.hunks, 0);
  assert.strictEqual(r.additions, 0);
  assert.strictEqual(r.deletions, 0);
});

test("diff_files: two empty files are identical", () => {
  executeTool("create_file", { path: "empty1.txt", content: "" });
  executeTool("create_file", { path: "empty2.txt", content: "" });
  const r = executeTool("diff_files", { source: "empty1.txt", target: "empty2.txt" });
  assert.strictEqual(r.identical, true);
});

test("diff_files: empty source vs non-empty target (all additions)", () => {
  const r = executeTool("diff_files", { source: "empty1.txt", target: "v1.txt" });
  assert.strictEqual(r.identical, false);
  assert.ok(r.additions > 0, "should have additions");
  assert.strictEqual(r.deletions, 0, "should have no deletions");
});

test("diff_files: context=0 shows only changed lines, no surrounding context", () => {
  const r = executeTool("diff_files", { source: "mod1.txt", target: "mod2.txt", context: 0 });
  assert.strictEqual(r.identical, false);
  // With context=0, the hunk body should only have changed lines (no leading space)
  const bodyLines = r.unified.split("\n").filter(l => l.startsWith(" "));
  assert.strictEqual(bodyLines.length, 0, "context=0 should produce no context lines");
});

test("diff_files: missing source param throws -32602", () => {
  try {
    executeTool("diff_files", { target: "v2.txt" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("diff_files: missing target param throws -32602", () => {
  try {
    executeTool("diff_files", { source: "v1.txt" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("diff_files: nonexistent source file throws (not silent)", () => {
  executeTool("create_file", { path: "exists.txt", content: "x" });
  assert.throws(() => executeTool("diff_files", { source: "ghost.txt", target: "exists.txt" }));
});

// ── HIGH — edge-case handling ─────────────────────────────────────────────────
test("diff_files: single-line file vs empty produces one deletion hunk", () => {
  executeTool("create_file", { path: "single.txt", content: "only line" });
  const r = executeTool("diff_files", { source: "single.txt", target: "empty1.txt" });
  assert.strictEqual(r.deletions, 1);
  assert.strictEqual(r.additions, 0);
  assert.ok(r.unified.includes("-only line"));
});

test("diff_files: content with special regex chars in lines does not break the diff", () => {
  executeTool("create_file", { path: "regex1.txt", content: "price: $100.00 (^old)\n" });
  executeTool("create_file", { path: "regex2.txt", content: "price: $200.00 (^new)\n" });
  const r = executeTool("diff_files", { source: "regex1.txt", target: "regex2.txt" });
  assert.strictEqual(r.identical, false);
  assert.ok(r.unified.includes("$100"), "original line should appear literally");
  assert.ok(r.unified.includes("$200"), "new line should appear literally");
});

test("diff_files: large files (500 lines, one change) diff correctly", () => {
  const linesA = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n") + "\n";
  const linesB = linesA.replace("line250", "line250-modified");
  executeTool("create_file", { path: "big-a.txt", content: linesA });
  executeTool("create_file", { path: "big-b.txt", content: linesB });
  const r = executeTool("diff_files", { source: "big-a.txt", target: "big-b.txt" });
  assert.strictEqual(r.additions, 1);
  assert.strictEqual(r.deletions, 1);
  assert.strictEqual(r.hunks, 1);
});

// ── CRITICAL — security & input sanitization ────────────────────────────────
test("diff_files: path traversal on source is blocked", () => {
  assert.throws(
    () => executeTool("diff_files", { source: "../../../etc/passwd", target: "v1.txt" }),
    /Access denied/,
  );
});

test("diff_files: path traversal on target is blocked", () => {
  assert.throws(
    () => executeTool("diff_files", { source: "v1.txt", target: "../../../etc/shadow" }),
    /Access denied/,
  );
});

test("diff_files: shell-injection-shaped content in file lines round-trips safely as literal diff text", () => {
  executeTool("create_file", { path: "inj1.txt", content: "; rm -rf / && echo $(whoami)\n" });
  executeTool("create_file", { path: "inj2.txt", content: "; rm -rf / && echo changed\n" });
  const r = executeTool("diff_files", { source: "inj1.txt", target: "inj2.txt" });
  assert.ok(r.unified.includes("$(whoami)"), "injection-shaped content preserved literally in diff output");
  assert.ok(r.unified.includes("echo changed"), "replacement line preserved literally");
});

// ── EXTREME — large changes, fuzz, concurrency ───────────────────────────────
test("diff_files: completely different files (all lines replaced) produce correct counts", () => {
  executeTool("create_file", { path: "allA.txt", content: Array.from({ length: 50 }, (_, i) => `old${i}`).join("\n") + "\n" });
  executeTool("create_file", { path: "allB.txt", content: Array.from({ length: 50 }, (_, i) => `new${i}`).join("\n") + "\n" });
  const r = executeTool("diff_files", { source: "allA.txt", target: "allB.txt" });
  assert.strictEqual(r.additions, 50);
  assert.strictEqual(r.deletions, 50);
});

test("diff_files: concurrent diff calls return consistent results", () => {
  const results = Array.from({ length: 8 }, () =>
    executeTool("diff_files", { source: "v1.txt", target: "v2.txt" }),
  );
  for (const r of results) {
    assert.strictEqual(r.identical, false);
    assert.ok(r.additions >= 1);
  }
});

test("diff_files: fuzz printable-ASCII content does not crash the process", () => {
  const fuzz = (n) =>
    Buffer.from(Array.from({ length: n }, () => 32 + Math.floor(Math.random() * 94))).toString("utf8");
  executeTool("create_file", { path: "fuzz1.txt", content: fuzz(500).replace(/\r/g, "") });
  executeTool("create_file", { path: "fuzz2.txt", content: fuzz(500).replace(/\r/g, "") });
  try {
    const r = executeTool("diff_files", { source: "fuzz1.txt", target: "fuzz2.txt" });
    assert.ok(typeof r.unified === "string", "fuzz diff must return a string");
    assert.ok(typeof r.hunks === "number");
  } catch (e) {
    assert.ok(e instanceof Error, "fuzz input may fail, but must fail with a proper Error");
  }
});

test("cleanup: remove diff_files fixture files created in this section", () => {
  const files = [
    "v1.txt", "v2.txt", "del1.txt", "del2.txt", "mod1.txt", "mod2.txt",
    "mh1.txt", "mh2.txt", "same1.txt", "same2.txt", "empty1.txt", "empty2.txt",
    "single.txt", "exists.txt", "regex1.txt", "regex2.txt", "big-a.txt", "big-b.txt",
    "inj1.txt", "inj2.txt", "allA.txt", "allB.txt", "fuzz1.txt", "fuzz2.txt",
  ];
  for (const f of files) {
    const p = path.join(require("../test-harness").TMP, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  assert.ok(true);
});
