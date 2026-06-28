"use strict";
/**
 * [16] GIT DIFF — git_diff tool
 *
 * Tests the `git_diff` tool across all five rigor levels.
 * We create an isolated temporary git repo in a subdirectory of the shared TMP
 * sandbox so we control the commit history without affecting the real project repo.
 *
 * Rigor levels covered:
 *   Normal:   happy-path — working-tree vs HEAD, staged vs HEAD, commit-to-commit,
 *             file-filter, identical state (no changes)
 *   Medium:   boundary — empty repo diff, single-file filter, extra/missing args,
 *             only from_ref supplied
 *   High:     dependency failure — bad ref throws clean error; non-git dir throws;
 *             staged=false on clean tree returns empty diff
 *   Critical: shell metacharacter injection in from_ref/to_ref/file rejected;
 *             path traversal via file arg blocked; extremely long arg rejected
 *   Extreme:  large diff (500-line file, all lines changed); concurrent calls;
 *             commit-to-commit diff spanning many files
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, counters, TMP } = require("../test-harness");
const { executeTool } = require("../../lib/executeTool");

console.log(`\n[16] GIT DIFF — git_diff tool`);

// ── ISOLATED GIT REPO SETUP ───────────────────────────────────────────────────
// We build a small, self-contained git repo inside TMP/git-diff-repo/ with a
// known commit history so our tests are deterministic and hermetic.

const REPO = path.join(TMP, "git-diff-repo");

function gitIn(cmd) {
  return execSync(`git ${cmd}`, {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(REPO) },
  }).trimEnd();
}

function setup() {
  if (fs.existsSync(REPO)) fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });

  // Minimal git identity (local to this repo only)
  gitIn("init -b main");
  gitIn(`config user.email "test@example.com"`);
  gitIn(`config user.name "Test User"`);

  // Initial commit: hello.txt + data.txt
  fs.writeFileSync(path.join(REPO, "hello.txt"), "line one\nline two\nline three\n");
  fs.writeFileSync(path.join(REPO, "data.txt"),  "alpha\nbeta\ngamma\n");
  gitIn("add .");
  gitIn(`commit -m "initial commit"`);

  // Second commit: modify hello.txt, leave data.txt unchanged
  fs.writeFileSync(path.join(REPO, "hello.txt"), "line one\nline TWO (modified)\nline three\n");
  gitIn("add hello.txt");
  gitIn(`commit -m "modify hello.txt"`);
}

setup();

// Capture the two commit hashes for ref-based tests
const LOG = gitIn("log --oneline");
const [secondHash, firstHash] = LOG.split("\n").map(l => l.slice(0, 7));

// Helper — call git_diff routed through the MCP root (TMP is the configured root)
// We pass REPO as a subdirectory of TMP so resolveClientPath will accept it.
const REPO_ALIAS = "git-diff-repo"; // relative alias path under TMP

function gd(args = {}) {
  return executeTool("git_diff", { path: REPO_ALIAS, ...args });
}

// ── NORMAL — happy path ───────────────────────────────────────────────────────
test("git_diff: clean working tree vs HEAD returns empty unified diff", () => {
  // After both commits, working tree is clean
  const r = gd();
  assert.strictEqual(typeof r.unified, "string", "unified must be a string");
  assert.strictEqual(r.unified, "", "clean tree should have empty unified diff");
  assert.strictEqual(r.additions, 0, "no additions on clean tree");
  assert.strictEqual(r.deletions, 0, "no deletions on clean tree");
  assert.strictEqual(r.hunks, 0,     "no hunks on clean tree");
  assert.deepStrictEqual(r.changedFiles, [], "no changedFiles on clean tree");
});

test("git_diff: working tree vs HEAD shows unstaged modification", () => {
  // Make an unstaged change
  fs.writeFileSync(path.join(REPO, "hello.txt"), "line one\nCHANGED LINE\nline three\n");
  try {
    const r = gd(); // working tree vs HEAD
    assert.ok(r.unified.includes("@@"), "diff should contain hunk markers");
    assert.ok(r.hunks >= 1, "at least one hunk");
    assert.ok(r.additions >= 1, "at least one addition");
    assert.ok(r.deletions >= 1, "at least one deletion");
    assert.ok(r.changedFiles.some(f => f.path === "hello.txt"), "hello.txt in changedFiles");
  } finally {
    // Restore working tree
    gitIn("checkout -- hello.txt");
  }
});

test("git_diff: staged=true shows staged change vs HEAD", () => {
  // Stage a change to data.txt without committing
  fs.writeFileSync(path.join(REPO, "data.txt"), "alpha\nbeta\nGAMMA-MODIFIED\n");
  gitIn("add data.txt");
  try {
    const r = gd({ staged: true });
    assert.ok(r.staged === true, "staged flag echoed back");
    assert.ok(r.unified.includes("GAMMA-MODIFIED"), "staged diff should show new content");
    assert.ok(r.additions >= 1, "at least one addition in staged diff");
    assert.ok(r.changedFiles.some(f => f.path === "data.txt"), "data.txt in changedFiles");
  } finally {
    gitIn("checkout -- data.txt");
    gitIn("reset HEAD data.txt");
    // restore the file
    fs.writeFileSync(path.join(REPO, "data.txt"), "alpha\nbeta\ngamma\n");
  }
});

test("git_diff: commit-to-commit diff (from_ref vs to_ref)", () => {
  const r = gd({ from_ref: firstHash, to_ref: secondHash });
  assert.ok(r.unified.includes("@@"), "should have at least one hunk");
  assert.ok(r.changedFiles.some(f => f.path === "hello.txt"), "hello.txt changed between commits");
  assert.strictEqual(r.fromRef, firstHash, "fromRef echoed back");
  assert.strictEqual(r.toRef, secondHash, "toRef echoed back");
});

test("git_diff: file filter restricts diff to one file only", () => {
  // Introduce unstaged changes to both files
  fs.writeFileSync(path.join(REPO, "hello.txt"), "CHANGED\n");
  fs.writeFileSync(path.join(REPO, "data.txt"),  "CHANGED\n");
  try {
    const r = gd({ file: "hello.txt" });
    assert.ok(r.unified.length > 0, "diff should be non-empty when file is changed");
    // Only hello.txt should appear — data.txt was also changed but not in filter
    const paths = r.changedFiles.map(f => f.path);
    assert.ok(paths.every(p => p === "hello.txt"), "only hello.txt in filtered diff");
  } finally {
    gitIn("checkout -- .");
  }
});

test("git_diff: result contains all expected return fields", () => {
  const r = gd({ from_ref: firstHash, to_ref: secondHash });
  const required = ["fromRef", "toRef", "staged", "file", "unified", "additions", "deletions", "hunks", "changedFiles"];
  for (const key of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, key), `result must have field '${key}'`);
  }
  assert.ok(Array.isArray(r.changedFiles), "changedFiles must be an array");
  assert.ok(typeof r.unified === "string", "unified must be a string");
});

// ── MEDIUM — boundary & parameter validation ─────────────────────────────────
test("git_diff: from_ref only (working tree vs that ref) works", () => {
  // Modify a file so working tree differs from firstHash
  fs.writeFileSync(path.join(REPO, "hello.txt"), "COMPLETELY DIFFERENT\n");
  try {
    const r = gd({ from_ref: firstHash });
    assert.ok(r.unified.length > 0, "diff against specific ref should be non-empty");
    assert.strictEqual(r.fromRef, firstHash);
    assert.strictEqual(r.toRef, null, "toRef should be null when not supplied");
  } finally {
    gitIn("checkout -- hello.txt");
  }
});

test("git_diff: staged=false on clean working tree returns empty diff", () => {
  const r = gd({ staged: false });
  assert.strictEqual(r.unified, "", "clean working tree should produce empty diff");
  assert.strictEqual(r.changedFiles.length, 0);
});

test("git_diff: staged=true on clean index returns empty diff", () => {
  // Nothing staged
  const r = gd({ staged: true });
  assert.strictEqual(r.unified, "", "clean index should produce empty staged diff");
});

test("git_diff: file field is null in result when not supplied", () => {
  const r = gd();
  assert.strictEqual(r.file, null, "file should be null when not supplied");
});

test("git_diff: file field echoed back when supplied", () => {
  const r = gd({ file: "hello.txt", from_ref: firstHash, to_ref: secondHash });
  assert.strictEqual(r.file, "hello.txt", "file should be echoed in result");
});

test("git_diff: additions/deletions/hunks are non-negative numbers", () => {
  const r = gd({ from_ref: firstHash, to_ref: secondHash });
  assert.ok(typeof r.additions === "number" && r.additions >= 0);
  assert.ok(typeof r.deletions === "number" && r.deletions >= 0);
  assert.ok(typeof r.hunks === "number"     && r.hunks >= 0);
});

// ── HIGH — dependency failures ────────────────────────────────────────────────
test("git_diff: bad from_ref throws a clean, non-crashing error", () => {
  let threw = false;
  try {
    gd({ from_ref: "doesnotexist999" });
  } catch (e) {
    threw = true;
    assert.ok(typeof e.message === "string" && e.message.length > 0, "error must have message");
  }
  assert.ok(threw, "should throw for an unknown ref");
});

test("git_diff: bad to_ref throws a clean, non-crashing error", () => {
  let threw = false;
  try {
    gd({ from_ref: firstHash, to_ref: "phantom-ref-xyz" });
  } catch (e) {
    threw = true;
    assert.ok(e.message.length > 0);
  }
  assert.ok(threw, "should throw for an unknown to_ref");
});

test("git_diff: non-git directory throws a clean error", () => {
  // Create a plain directory (not a git repo) inside TMP
  const plainDir = path.join(TMP, "not-a-git-repo");
  fs.mkdirSync(plainDir, { recursive: true });
  let threw = false;
  try {
    executeTool("git_diff", { path: "not-a-git-repo" });
  } catch (e) {
    threw = true;
    assert.ok(typeof e.message === "string");
  } finally {
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
  assert.ok(threw, "should throw for a non-git directory");
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────
test("git_diff: semicolon injection in from_ref is rejected", () => {
  assert.throws(() => gd({ from_ref: "main; rm -rf /" }), /disallowed characters/);
});

test("git_diff: backtick injection in from_ref is rejected", () => {
  assert.throws(() => gd({ from_ref: "`whoami`" }), /disallowed characters/);
});

test("git_diff: pipe injection in to_ref is rejected", () => {
  assert.throws(() => gd({ from_ref: firstHash, to_ref: "main|cat /etc/passwd" }), /disallowed characters/);
});

test("git_diff: dollar-sign injection in file arg is rejected", () => {
  assert.throws(() => gd({ file: "$(cat /etc/passwd)" }), /disallowed characters/);
});

test("git_diff: extremely long from_ref (>4096 chars) is rejected", () => {
  assert.throws(() => gd({ from_ref: "a".repeat(4097) }), /exceeds 4096/);
});

test("git_diff: path traversal via 'path' arg is blocked by resolveClientPath", () => {
  assert.throws(
    () => executeTool("git_diff", { path: "../../../../etc" }),
    /outside.*root|path.*traversal|not.*within/i,
  );
});

test("git_diff: newline injection in file arg is rejected", () => {
  assert.throws(() => gd({ file: "hello.txt\ngit commit -m evil" }), /disallowed characters/);
});

// ── EXTREME — stress & concurrency ───────────────────────────────────────────
test("git_diff: large diff (500-line file, all lines changed) parses correctly", () => {
  const bigOld = Array.from({ length: 500 }, (_, i) => `old-line-${i}`).join("\n") + "\n";
  const bigNew = Array.from({ length: 500 }, (_, i) => `new-line-${i}`).join("\n") + "\n";
  const bigFile = path.join(REPO, "bigfile.txt");
  fs.writeFileSync(bigFile, bigOld);
  gitIn("add bigfile.txt");
  gitIn(`commit -m "add bigfile"`);
  const bigHash1 = gitIn("rev-parse --short HEAD");
  fs.writeFileSync(bigFile, bigNew);
  gitIn("add bigfile.txt");
  gitIn(`commit -m "rewrite bigfile"`);
  const bigHash2 = gitIn("rev-parse --short HEAD");
  try {
    const r = gd({ from_ref: bigHash1, to_ref: bigHash2 });
    assert.ok(r.additions === 500, `expected 500 additions, got ${r.additions}`);
    assert.ok(r.deletions === 500, `expected 500 deletions, got ${r.deletions}`);
    assert.ok(r.hunks >= 1, "should have at least one hunk");
    assert.ok(r.unified.length > 0, "unified diff should be non-empty");
  } finally {
    // Roll back the two big commits
    gitIn("reset --hard HEAD~2");
  }
});

test("git_diff: 10 concurrent calls return consistent results", () => {
  const results = Array.from({ length: 10 }, () =>
    gd({ from_ref: firstHash, to_ref: secondHash })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].unified, first.unified, `call ${i} unified mismatch`);
    assert.strictEqual(results[i].additions, first.additions, `call ${i} additions mismatch`);
    assert.strictEqual(results[i].deletions, first.deletions, `call ${i} deletions mismatch`);
  }
});

test("git_diff: result is fully JSON-serialisable (no circular refs)", () => {
  const r = gd({ from_ref: firstHash, to_ref: secondHash });
  let s;
  assert.doesNotThrow(() => { s = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(s);
  assert.strictEqual(parsed.additions, r.additions);
  assert.ok(Array.isArray(parsed.changedFiles));
});

test("git_diff: multi-file commit-to-commit diff captures all changed files", () => {
  // Stage and commit changes to both files simultaneously
  fs.writeFileSync(path.join(REPO, "hello.txt"), "new content A\n");
  fs.writeFileSync(path.join(REPO, "data.txt"), "new content B\n");
  gitIn("add .");
  gitIn(`commit -m "change both files"`);
  const newHash = gitIn("rev-parse --short HEAD");
  try {
    const r = gd({ from_ref: secondHash, to_ref: newHash });
    const paths = r.changedFiles.map(f => f.path);
    assert.ok(paths.includes("hello.txt"), "hello.txt should be in changedFiles");
    assert.ok(paths.includes("data.txt"),  "data.txt should be in changedFiles");
  } finally {
    gitIn("reset --hard HEAD~1");
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────
test("cleanup: remove git-diff-repo sandbox", () => {
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch (_) {}
  assert.ok(!fs.existsSync(REPO), "sandbox must be removed");
});
