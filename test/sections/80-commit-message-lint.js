"use strict";
/**
 * [80] GIT_COMMIT_MESSAGE_LINT — commit message convention checker
 *
 * Rigor levels:
 *   Normal:   clean conventional-style message ("Fix bug in parser") lints
 *             with zero issues; ref-based lookup on a real commit lints its
 *             actual message.
 *   Medium:   empty message -> single empty-message error; missing both
 *             message and ref defaults ref to HEAD; non-string message
 *             throws -32602; custom max_subject_length changes the
 *             too-long threshold.
 *   High:     subject with no blank line before body -> error; trailing
 *             whitespace on any line detected; lookup on a nonexistent ref
 *             throws a descriptive -32602 rather than a raw git error.
 *   Critical: message containing shell-metacharacters is treated as inert
 *             literal text (never executed) since it's linted directly, not
 *             passed to git; injection-shaped ref value is rejected by
 *             assertSafeArg before ever reaching git; result is
 *             JSON-serialisable.
 *   Extreme:  require_type=true rejects a non-conventional subject as an
 *             error (not just a warning); very long (5000-char) subject
 *             lints without crashing; 10 concurrent lints of different
 *             messages don't interfere.
 *
 * IIFE assigned to module.exports (async test bodies for the git-ref path),
 * matches sections 55/58/63/64/76/78/79 — run-tests.js must
 * `await require(...)` this file.
 */
const { execSync } = require("child_process");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[80] GIT_COMMIT_MESSAGE_LINT — commit message linter`);

function gitIn(repoDir, cmd) {
  const env = { ...process.env,
    GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" };
  return execSync(`git ${cmd}`, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
}

function makeRepo(name, commitMsg) {
  const path = require("path"), fs = require("fs");
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -q -b main");
  fs.writeFileSync(path.join(repoDir, "f.txt"), "1\n");
  gitIn(repoDir, "add .");
  fs.writeFileSync(path.join(TMP, `${name}-msg.txt`), commitMsg);
  gitIn(repoDir, `commit -q -F "${path.join(TMP, `${name}-msg.txt`)}"`);
  return repoDir;
}

module.exports = (async () => {
  await test("normal: clean conventional message lints with zero issues", () => {
    const r = executeTool("git_commit_message_lint", { message: "Fix bug in parser" });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.errorCount, 0);
    assert.strictEqual(r.warningCount, 0);
  });

  await test("normal: ref-based lookup lints a real commit's message", async () => {
    const repoDir = makeRepo("cml-normal", "feat: add widget support\n");
    const r = await executeTool("git_commit_message_lint", { path: repoDir, ref: "HEAD" });
    assert.strictEqual(r.ref, "HEAD");
    assert.strictEqual(r.subject, "feat: add widget support");
    assert.strictEqual(r.valid, true);
  });

  await test("medium: empty message yields a single empty-message error", () => {
    const r = executeTool("git_commit_message_lint", { message: "" });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.errorCount, 1);
    assert.strictEqual(r.issues[0].rule, "empty-message");
  });

  await test("medium: missing ref defaults to HEAD", async () => {
    const repoDir = makeRepo("cml-medium-defref", "chore: bump deps\n");
    const r = await executeTool("git_commit_message_lint", { path: repoDir });
    assert.strictEqual(r.ref, "HEAD");
  });

  await test("medium: non-string message throws -32602", async () => {
    let threw = null;
    try { await executeTool("git_commit_message_lint", { message: 12345 }); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("medium: custom max_subject_length changes too-long threshold", () => {
    const r = executeTool("git_commit_message_lint", { message: "a".repeat(20), max_subject_length: 10 });
    assert.ok(r.issues.some((i) => i.rule === "subject-too-long"));
  });

  await test("high: missing blank line before body is an error", () => {
    const r = executeTool("git_commit_message_lint", { message: "Fix bug\nDirect body line, no blank separator" });
    assert.ok(r.issues.some((i) => i.rule === "missing-blank-line-before-body" && i.severity === "error"));
    assert.strictEqual(r.valid, false);
  });

  await test("high: trailing whitespace is detected", () => {
    const r = executeTool("git_commit_message_lint", { message: "Fix bug   " });
    assert.ok(r.issues.some((i) => i.rule === "trailing-whitespace"));
  });

  await test("high: nonexistent ref throws a descriptive -32602", async () => {
    const repoDir = makeRepo("cml-high-badref", "fix: patch\n");
    let threw = null;
    try { await executeTool("git_commit_message_lint", { path: repoDir, ref: "deadbeef1234" }); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("critical: shell-metachar message is inert literal text, no execution", () => {
    const r = executeTool("git_commit_message_lint", { message: "fix: patch `rm -rf /` $(whoami)" });
    assert.strictEqual(r.subject, "fix: patch `rm -rf /` $(whoami)");
    assert.strictEqual(r.valid, true);
  });

  await test("critical: injection-shaped ref rejected before reaching git", async () => {
    const repoDir = makeRepo("cml-critical-ref", "fix: patch\n");
    let threw = null;
    try { await executeTool("git_commit_message_lint", { path: repoDir, ref: "HEAD; rm -rf /" }); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("critical: result is JSON-serialisable", () => {
    const r = executeTool("git_commit_message_lint", { message: "feat: add x\n\nSome body text." });
    assert.doesNotThrow(() => JSON.stringify(r));
  });

  await test("extreme: require_type=true rejects non-conventional subject as an error", () => {
    const r = executeTool("git_commit_message_lint", { message: "Fix bug in parser", require_type: true });
    assert.strictEqual(r.valid, false);
    assert.ok(r.issues.some((i) => i.rule === "missing-conventional-type" && i.severity === "error"));
  });

  await test("extreme: 5000-char subject lints without crashing", () => {
    const r = executeTool("git_commit_message_lint", { message: "feat: " + "x".repeat(5000) });
    assert.ok(r.issues.some((i) => i.rule === "subject-too-long"));
  });

  await test("extreme: 10 concurrent lints of different messages don't interfere", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => executeTool("git_commit_message_lint", { message: `feat: change number ${i}` }))
    );
    results.forEach((r, i) => assert.strictEqual(r.subject, `feat: change number ${i}`));
  });
})();
