"use strict";
/**
 * [16-B] GIT DIFF — stat_only extension
 *
 * Tests the `git_diff` tool's `stat_only` param across all five rigor levels.
 * A/B/C-level full-diff (non-stat_only) coverage lives in 12-git-diff.js;
 * this file is scoped to the stat_only mode only, using its own isolated
 * temp git repo (separate from 12-git-diff.js's REPO) so the two files can
 * run independently without interfering with each other's commit history.
 *
 * Rigor levels covered:
 *   Normal:   happy-path additions/deletions counts; clean-tree empty array;
 *             commit-to-commit stat_only
 *   Medium:   staged+stat_only combined; file filter+stat_only;
 *             stat_only=false/omitted unchanged from full-diff behavior
 *   High:     binary file under stat_only (git reports "-"/"-" — must not
 *             crash Number parsing); bad ref throws clean error
 *   Critical: shell injection in from_ref/to_ref/file still rejected;
 *             path traversal via 'path' arg still blocked
 *   Extreme:  50-file changeset; 10 concurrent calls consistent;
 *             JSON-serialisability
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, counters, TMP } = require("../test-harness");
const { executeTool } = require("../../lib/executeTool");

console.log(`\n[16-B] GIT DIFF — stat_only extension`);

// ── ISOLATED GIT REPO SETUP ───────────────────────────────────────────────────
const REPO = path.join(TMP, "git-diff-stat-repo");

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

  gitIn("init -b main");
  gitIn(`config user.email "test@example.com"`);
  gitIn(`config user.name "Test User"`);

  fs.writeFileSync(path.join(REPO, "hello.txt"), "line one\nline two\nline three\n");
  fs.writeFileSync(path.join(REPO, "data.txt"),  "alpha\nbeta\ngamma\n");
  gitIn("add .");
  gitIn(`commit -m "initial commit"`);

  fs.writeFileSync(path.join(REPO, "hello.txt"), "line one\nline TWO (modified)\nline three\n");
  gitIn("add hello.txt");
  gitIn(`commit -m "modify hello.txt"`);
}

setup();

const LOG = gitIn("log --oneline");
const [secondHash, firstHash] = LOG.split("\n").map(l => l.slice(0, 7));

const REPO_ALIAS = "git-diff-stat-repo";

function gd(args = {}) {
  return executeTool("git_diff", { path: REPO_ALIAS, ...args });
}

// ── NORMAL ─────────────────────────────────────────────────────────────────
test("git_diff stat_only: working tree vs HEAD reports correct add/delete counts", () => {
  fs.writeFileSync(path.join(REPO, "hello.txt"), "line one\nCHANGED LINE\nline three\n");
  try {
    const r = gd({ stat_only: true });
    assert.strictEqual(r.unified, null, "unified must be null in stat_only mode");
    assert.strictEqual(r.statOnly, true, "statOnly flag must be echoed back as true");
    assert.ok(r.additions >= 1, "at least one addition");
    assert.ok(r.deletions >= 1, "at least one deletion");
    const entry = r.changedFiles.find(f => f.path === "hello.txt");
    assert.ok(entry, "hello.txt must appear in changedFiles");
    assert.strictEqual(typeof entry.additions, "number", "per-file additions must be a number");
    assert.strictEqual(typeof entry.deletions, "number", "per-file deletions must be a number");
  } finally {
    gitIn("checkout -- hello.txt");
  }
});

test("git_diff stat_only: clean working tree returns empty changedFiles and null unified", () => {
  const r = gd({ stat_only: true });
  assert.strictEqual(r.unified, null, "unified must be null");
  assert.strictEqual(r.additions, 0, "no additions on clean tree");
  assert.strictEqual(r.deletions, 0, "no deletions on clean tree");
  assert.deepStrictEqual(r.changedFiles, [], "no changedFiles on clean tree");
});

test("git_diff stat_only: commit-to-commit diff reports per-file counts", () => {
  const r = gd({ from_ref: firstHash, to_ref: secondHash, stat_only: true });
  assert.strictEqual(r.unified, null);
  assert.strictEqual(r.fromRef, firstHash);
  assert.strictEqual(r.toRef, secondHash);
  const entry = r.changedFiles.find(f => f.path === "hello.txt");
  assert.ok(entry, "hello.txt should be reported as changed between commits");
  assert.ok(entry.additions > 0 || entry.deletions > 0, "should report non-zero line changes");
});

// ── MEDIUM — boundary & combined modes ───────────────────────────────────────
test("git_diff stat_only: combined with staged=true reports staged changes", () => {
  fs.writeFileSync(path.join(REPO, "data.txt"), "alpha\nbeta\nGAMMA-MODIFIED\n");
  gitIn("add data.txt");
  try {
    const r = gd({ staged: true, stat_only: true });
    assert.strictEqual(r.staged, true, "staged flag echoed back");
    assert.strictEqual(r.unified, null);
    assert.ok(r.changedFiles.some(f => f.path === "data.txt"), "data.txt in changedFiles");
  } finally {
    gitIn("reset HEAD data.txt");
    fs.writeFileSync(path.join(REPO, "data.txt"), "alpha\nbeta\ngamma\n");
  }
});

test("git_diff stat_only: combined with file filter restricts to one file", () => {
  fs.writeFileSync(path.join(REPO, "hello.txt"), "CHANGED\n");
  fs.writeFileSync(path.join(REPO, "data.txt"),  "CHANGED\n");
  try {
    const r = gd({ file: "hello.txt", stat_only: true });
    const paths = r.changedFiles.map(f => f.path);
    assert.ok(paths.every(p => p === "hello.txt"), "only hello.txt in filtered stat_only diff");
    assert.strictEqual(r.file, "hello.txt", "file echoed back");
  } finally {
    gitIn("checkout -- .");
  }
});

test("git_diff stat_only: omitted (default false) is unchanged full-diff behavior", () => {
  const r = gd({ from_ref: firstHash, to_ref: secondHash });
  assert.strictEqual(typeof r.unified, "string", "unified must still be a string by default");
  assert.ok(r.unified.includes("@@"), "should contain hunk markers");
  assert.strictEqual(r.statOnly, undefined, "statOnly should not appear on full-diff results");
});

test("git_diff stat_only: explicit false behaves identically to omitted", () => {
  const r = gd({ from_ref: firstHash, to_ref: secondHash, stat_only: false });
  assert.strictEqual(typeof r.unified, "string");
  assert.ok(r.unified.length > 0);
});

// ── HIGH — dependency failures ────────────────────────────────────────────────
test("git_diff stat_only: binary file diff does not crash Number parsing", () => {
  const binFile = path.join(REPO, "image.bin");
  fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00, 0x10]));
  gitIn("add image.bin");
  gitIn(`commit -m "add binary file"`);
  const binHash1 = gitIn("rev-parse --short HEAD");
  fs.writeFileSync(binFile, Buffer.from([0x00, 0x02, 0xee, 0xdd, 0x00, 0x20, 0x30]));
  gitIn("add image.bin");
  gitIn(`commit -m "modify binary file"`);
  const binHash2 = gitIn("rev-parse --short HEAD");
  try {
    let r;
    assert.doesNotThrow(() => { r = gd({ from_ref: binHash1, to_ref: binHash2, stat_only: true }); },
      "stat_only must not throw on binary file diffs");
    const entry = r.changedFiles.find(f => f.path === "image.bin");
    assert.ok(entry, "binary file must appear in changedFiles");
    assert.strictEqual(entry.additions, null, "binary file additions must be null, not NaN");
    assert.strictEqual(entry.deletions, null, "binary file deletions must be null, not NaN");
  } finally {
    gitIn("reset --hard HEAD~2");
  }
});

test("git_diff stat_only: bad from_ref throws a clean, non-crashing error", () => {
  let threw = false;
  try {
    gd({ from_ref: "doesnotexist999", stat_only: true });
  } catch (e) {
    threw = true;
    assert.ok(typeof e.message === "string" && e.message.length > 0);
  }
  assert.ok(threw, "should throw for an unknown ref under stat_only");
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────
test("git_diff stat_only: semicolon injection in from_ref is rejected", () => {
  assert.throws(() => gd({ from_ref: "main; rm -rf /", stat_only: true }), /disallowed characters/);
});

test("git_diff stat_only: backtick injection in file arg is rejected", () => {
  assert.throws(() => gd({ file: "`whoami`", stat_only: true }), /disallowed characters/);
});

test("git_diff stat_only: path traversal via 'path' arg is still blocked", () => {
  assert.throws(
    () => executeTool("git_diff", { path: "../../../../etc", stat_only: true }),
    /outside.*root|path.*traversal|not.*within/i,
  );
});

// ── EXTREME — stress & concurrency ───────────────────────────────────────────
test("git_diff stat_only: 50-file changeset reports correct per-file counts", () => {
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(REPO, `stress-${i}.txt`), `content ${i}\nline two\n`);
  }
  gitIn("add .");
  gitIn(`commit -m "add 50 stress files"`);
  const stressHash1 = gitIn("rev-parse --short HEAD");
  for (let i = 0; i < 50; i++) {
    fs.writeFileSync(path.join(REPO, `stress-${i}.txt`), `content ${i}\nline two MODIFIED\nline three\n`);
  }
  gitIn("add .");
  gitIn(`commit -m "modify 50 stress files"`);
  const stressHash2 = gitIn("rev-parse --short HEAD");
  try {
    const r = gd({ from_ref: stressHash1, to_ref: stressHash2, stat_only: true });
    assert.strictEqual(r.changedFiles.length, 50, `expected 50 changed files, got ${r.changedFiles.length}`);
    assert.ok(r.additions >= 50, "should report additions across all 50 files");
    assert.ok(r.deletions >= 50, "should report deletions across all 50 files");
  } finally {
    gitIn("reset --hard HEAD~2");
  }
});

test("git_diff stat_only: 10 concurrent calls return consistent results", () => {
  const results = Array.from({ length: 10 }, () =>
    gd({ from_ref: firstHash, to_ref: secondHash, stat_only: true })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].additions, first.additions, `call ${i} additions mismatch`);
    assert.strictEqual(results[i].deletions, first.deletions, `call ${i} deletions mismatch`);
    assert.deepStrictEqual(results[i].changedFiles, first.changedFiles, `call ${i} changedFiles mismatch`);
  }
});

test("git_diff stat_only: result is fully JSON-serialisable", () => {
  const r = gd({ from_ref: firstHash, to_ref: secondHash, stat_only: true });
  let s;
  assert.doesNotThrow(() => { s = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(s);
  assert.strictEqual(parsed.additions, r.additions);
  assert.strictEqual(parsed.unified, null);
  assert.ok(Array.isArray(parsed.changedFiles));
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────
test("cleanup: remove git-diff-stat-repo sandbox", () => {
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch (_) {}
  assert.ok(!fs.existsSync(REPO), "sandbox must be removed");
});
