"use strict";
/**
 * [8] GIT METADATA TOOLS — git_status, git_log, git_blame.
 *
 * Uses a fresh, isolated git repo in its own temp dir (independent of the
 * shared MCP_ROOTS sandbox, since the root jail would block a path outside
 * MCP_ROOTS). The gitOps.js functions are exercised directly to stay
 * consistent with "isolated functional testing" — no live server, no MCP
 * inspector.
 */
const { fs, os, path, assert, test, cleanupDir } = require("../test-harness");
const cp = require("child_process");
const { gitStatus, gitLog, gitBlame } = require("../../lib/gitOps");

console.log(`\n[8] GIT METADATA TOOLS — git_status, git_log, git_blame`);

// Create a temp git repo
const GIT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-git-test-"));
function gitTmp(cmd) {
  return cp.execSync(`git ${cmd}`, {
    cwd: GIT_TMP, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com",
           GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  }).trim();
}

// Bootstrap the repo
gitTmp("init -b main");
gitTmp("config user.email t@t.com");
gitTmp("config user.name Test");

// First commit
fs.writeFileSync(path.join(GIT_TMP, "hello.txt"), "line one\nline two\nline three\n");
gitTmp("add hello.txt");
gitTmp(`commit --allow-empty-message -m "initial commit"`);

// Second commit (modify file)
fs.writeFileSync(path.join(GIT_TMP, "hello.txt"), "line one\nline two modified\nline three\n");
fs.writeFileSync(path.join(GIT_TMP, "other.txt"), "other file\n");
gitTmp("add -A");
gitTmp(`commit -m "second commit"`);

// ── git_status normal-path tests ──────────────────────────────────────────
test("git_status: returns branch name 'main'", () => {
  const r = gitStatus(GIT_TMP);
  assert.strictEqual(r.branch, "main");
});

test("git_status: clean=true when working tree is clean", () => {
  const r = gitStatus(GIT_TMP);
  assert.ok(r.clean === true, "expected clean=true");
  assert.strictEqual(r.staged, 0);
  assert.strictEqual(r.unstaged, 0);
  assert.strictEqual(r.untracked, 0);
});

test("git_status: upstream is null for a repo with no remote", () => {
  const r = gitStatus(GIT_TMP);
  assert.strictEqual(r.upstream, null);
});

test("git_status: detects unstaged file modification", () => {
  fs.appendFileSync(path.join(GIT_TMP, "hello.txt"), "line four\n");
  const r = gitStatus(GIT_TMP);
  assert.ok(r.clean === false);
  assert.ok(r.unstaged >= 1, "expected at least 1 unstaged change");
  // Restore
  fs.writeFileSync(path.join(GIT_TMP, "hello.txt"), "line one\nline two modified\nline three\n");
});

test("git_status: detects staged file", () => {
  fs.writeFileSync(path.join(GIT_TMP, "staged.txt"), "new staged file\n");
  gitTmp("add staged.txt");
  const r = gitStatus(GIT_TMP);
  assert.ok(r.staged >= 1, "expected at least 1 staged change");
  assert.ok(r.files.some(f => f.path.includes("staged")));
  // Unstage
  gitTmp("reset HEAD staged.txt");
  fs.unlinkSync(path.join(GIT_TMP, "staged.txt"));
});

test("git_status: detects untracked file", () => {
  fs.writeFileSync(path.join(GIT_TMP, "untracked.txt"), "untracked\n");
  const r = gitStatus(GIT_TMP);
  assert.ok(r.untracked >= 1);
  assert.ok(r.files.some(f => f.status === "??"));
  // Clean up
  fs.unlinkSync(path.join(GIT_TMP, "untracked.txt"));
});

test("git_status: files array contains structured entries", () => {
  fs.writeFileSync(path.join(GIT_TMP, "mod.txt"), "modified\n");
  const r = gitStatus(GIT_TMP);
  const untracked = r.files.filter(f => f.status === "??");
  assert.ok(untracked.length > 0);
  assert.ok(untracked[0].path, "entry must have a path");
  // Clean up
  fs.unlinkSync(path.join(GIT_TMP, "mod.txt"));
});

// ── git_log normal-path tests ─────────────────────────────────────────────
test("git_log: returns 2 commits for this repo", () => {
  const r = gitLog(GIT_TMP, 20, null, null);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.commits.length, 2);
});

test("git_log: commits have required fields", () => {
  const r = gitLog(GIT_TMP, 20, null, null);
  const c = r.commits[0]; // most recent
  assert.ok(c.hash.match(/^[0-9a-f]{40}$/), "hash should be 40 hex chars");
  assert.ok(c.shortHash.match(/^[0-9a-f]{7}$/), "short hash should be 7 chars");
  assert.strictEqual(c.author, "Test");
  assert.strictEqual(c.email, "t@t.com");
  assert.ok(c.date.match(/^\d{4}-\d{2}-\d{2}T/), "date should be ISO 8601");
  assert.ok(typeof c.subject === "string");
});

test("git_log: most recent commit is 'second commit'", () => {
  const r = gitLog(GIT_TMP, 20, null, null);
  assert.ok(r.commits[0].subject.includes("second commit"));
});

test("git_log: limit=1 returns exactly 1 commit", () => {
  const r = gitLog(GIT_TMP, 1, null, null);
  assert.strictEqual(r.count, 1);
});

test("git_log: file filter restricts to commits touching that file", () => {
  // other.txt only added in second commit
  const r = gitLog(GIT_TMP, 20, "other.txt", null);
  assert.strictEqual(r.count, 1);
  assert.ok(r.commits[0].subject.includes("second commit"));
});

test("git_log: ref=main works same as HEAD", () => {
  const all  = gitLog(GIT_TMP, 20, null, null);
  const main = gitLog(GIT_TMP, 20, null, "main");
  assert.strictEqual(main.count, all.count);
  assert.strictEqual(main.commits[0].hash, all.commits[0].hash);
});

test("git_log: invalid branch throws descriptive error", () => {
  assert.throws(
    () => gitLog(GIT_TMP, 5, null, "nonexistent-branch-xyz"),
    /git log failed/,
  );
});

// ── git_blame normal-path tests ───────────────────────────────────────────
test("git_blame: returns line-by-line entries for hello.txt", () => {
  const r = gitBlame(path.join(GIT_TMP, "hello.txt"), GIT_TMP, null, null);
  assert.strictEqual(r.lineCount, 3); // "line one\nline two modified\nline three\n" = 3 lines
  assert.strictEqual(r.lines[0].line, 1);
  assert.ok(typeof r.lines[0].content === "string");
  assert.ok(r.lines[0].hash.match(/^[0-9a-f]{40}$/));
  assert.ok(r.lines[0].shortHash.match(/^[0-9a-f]{7}$/));
  assert.strictEqual(r.lines[0].author, "Test");
  assert.ok(r.lines[0].date.match(/^\d{4}-\d{2}-\d{2}T/));
  assert.ok(typeof r.lines[0].summary === "string");
});

test("git_blame: line 2 (modified line) comes from 'second commit'", () => {
  const r = gitBlame(path.join(GIT_TMP, "hello.txt"), GIT_TMP, null, null);
  const line2 = r.lines.find(l => l.line === 2);
  assert.ok(line2, "line 2 must exist");
  assert.ok(line2.summary.includes("second commit"));
  assert.strictEqual(line2.content, "line two modified");
});

test("git_blame: line 1 (unchanged line) comes from 'initial commit'", () => {
  const r = gitBlame(path.join(GIT_TMP, "hello.txt"), GIT_TMP, null, null);
  const line1 = r.lines.find(l => l.line === 1);
  assert.ok(line1.summary.includes("initial commit"));
  assert.strictEqual(line1.content, "line one");
});

test("git_blame: from_line/to_line restricts returned lines", () => {
  const r = gitBlame(path.join(GIT_TMP, "hello.txt"), GIT_TMP, 2, 2);
  assert.strictEqual(r.lineCount, 1);
  assert.strictEqual(r.lines[0].line, 2);
  assert.strictEqual(r.lines[0].content, "line two modified");
});

test("git_blame: untracked file throws descriptive error", () => {
  const ghost = path.join(GIT_TMP, "ghost_not_tracked.txt");
  fs.writeFileSync(ghost, "not tracked\n");
  assert.throws(
    () => gitBlame(ghost, GIT_TMP, null, null),
    /git blame failed/,
  );
  fs.unlinkSync(ghost);
});

// ── Security / validation tests ───────────────────────────────────────────
test("assertSafeArg (via gitLog branch param): shell metachar $ is rejected", () => {
  assert.throws(
    () => gitLog(GIT_TMP, 5, null, "main; rm -rf /"),
    /disallowed characters/,
  );
});

test("assertSafeArg: backtick injection in branch rejected", () => {
  assert.throws(
    () => gitLog(GIT_TMP, 5, null, "`id`"),
    /disallowed characters/,
  );
});

test("assertSafeArg: pipe/redirection in file filter rejected", () => {
  assert.throws(
    () => gitLog(GIT_TMP, 5, "file.txt | cat /etc/passwd", null),
    /disallowed characters/,
  );
});

test("assertSafeArg: extremely long branch string (>4096 chars) rejected", () => {
  assert.throws(
    () => gitLog(GIT_TMP, 5, null, "a".repeat(5000)),
    /exceeds 4096/,
  );
});

test("git_status: non-git directory throws (graceful, not crash)", () => {
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "notgit-"));
  assert.throws(() => gitStatus(notGit));
  fs.rmSync(notGit, { recursive: true, force: true });
});

test("git_log: limit capped at 200 — passing 99999 returns ≤200 commits", () => {
  const r = gitLog(GIT_TMP, 99999, null, null);
  assert.ok(r.count <= 200, `expected ≤200, got ${r.count}`);
});

// ── Clean up the git temp dir ─────────────────────────────────────────────
cleanupDir(GIT_TMP);
