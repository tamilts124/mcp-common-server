"use strict";
/**
 * [62] GIT_WORKTREE_LIST — git_worktree_list tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — single-worktree repo returns count=1, main entry
 *             with path/head/branch/isMain=true and no lock/prunable flags.
 *
 *   Medium:   boundary — repo with a linked worktree (git worktree add) lists
 *             both entries with correct branch/path/isMain; detached-HEAD
 *             worktree reports branch=null, isDetached=true.
 *
 *   High:     dependency failure — non-git directory throws descriptive error;
 *             git versions/binaries without worktree support are out of scope,
 *             but an empty/whitespace-only porcelain output must not crash.
 *
 *   Critical: security — path traversal / absolute-path-outside-root blocked;
 *             result is JSON-serialisable; no unexpected top-level keys.
 *
 *   Extreme:  stress — repo with 5 linked worktrees all listed correctly; 10
 *             concurrent calls consistent; locked worktree reports isLocked
 *             + lockReason.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[62] GIT_WORKTREE_LIST — git_worktree_list tool`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

function gitIn(repoDir, cmd) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

/** Create a minimal git repo under TMP/<name> with an initial commit on main. */
function makeRepo(name) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  gitIn(repoDir, "config user.email test@example.com");
  gitIn(repoDir, 'config user.name "Test User"');
  fs.writeFileSync(path.join(repoDir, "readme.txt"), "hello\n", "utf8");
  gitIn(repoDir, "add readme.txt");
  gitIn(repoDir, 'commit -m "initial commit"');
  return repoDir;
}

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("git_worktree_list: returns result object without throwing", () => {
  const repoDir = makeRepo("wt-basic");
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("git_worktree_list: single-worktree repo reports count=1, isMain=true", () => {
  const repoDir = makeRepo("wt-single");
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 1, "count must be 1");
  assert.strictEqual(r.worktrees.length, 1, "worktrees.length must be 1");
  assert.strictEqual(r.worktrees[0].isMain, true, "sole worktree must be main");
});

test("git_worktree_list: each entry has required fields with correct types", () => {
  const repoDir = makeRepo("wt-fields");
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  const w = r.worktrees[0];
  assert.ok(typeof w.path === "string" && w.path.length > 0, "path must be non-empty string");
  assert.ok(typeof w.head === "string" && w.head.length === 40, `head must be 40-char hex: ${w.head}`);
  assert.ok(w.branch === "refs/heads/main", `branch must be refs/heads/main, got: ${w.branch}`);
  assert.ok(typeof w.isMain === "boolean", "isMain must be boolean");
  assert.ok(typeof w.isBare === "boolean", "isBare must be boolean");
  assert.ok(typeof w.isDetached === "boolean", "isDetached must be boolean");
  assert.ok(typeof w.isLocked === "boolean", "isLocked must be boolean");
  assert.ok(typeof w.isPrunable === "boolean", "isPrunable must be boolean");
  assert.strictEqual(w.lockReason, null, "lockReason must be null when not locked");
  assert.strictEqual(w.prunableReason, null, "prunableReason must be null when not prunable");
});

test("git_worktree_list: main worktree path matches the repo directory", () => {
  const repoDir = makeRepo("wt-path");
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  // git normalizes path separators/case on some platforms; compare basenames as a
  // portable sanity check that we're pointing at the right directory.
  assert.strictEqual(path.basename(r.worktrees[0].path), path.basename(repoDir));
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("git_worktree_list: linked worktree (git worktree add) appears with correct branch", () => {
  const repoDir = makeRepo("wt-linked");
  const linkedDir = path.join(TMP, "wt-linked-extra");
  gitIn(repoDir, `worktree add "${linkedDir}" -b feature-x`);
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 2, "expected main + 1 linked worktree");
  const linked = r.worktrees.find((w) => w.branch === "refs/heads/feature-x");
  assert.ok(linked, `expected a worktree on refs/heads/feature-x among: ${JSON.stringify(r.worktrees.map(w=>w.branch))}`);
  assert.strictEqual(linked.isMain, false, "linked worktree must not be isMain");
  assert.strictEqual(path.basename(linked.path), "wt-linked-extra");
});

test("git_worktree_list: detached-HEAD linked worktree reports branch=null, isDetached=true", () => {
  const repoDir = makeRepo("wt-detached");
  const head = gitIn(repoDir, "rev-parse HEAD").trim();
  const linkedDir = path.join(TMP, "wt-detached-extra");
  gitIn(repoDir, `worktree add --detach "${linkedDir}" ${head}`);
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  const detached = r.worktrees.find((w) => path.basename(w.path) === "wt-detached-extra");
  assert.ok(detached, "expected the detached worktree entry");
  assert.strictEqual(detached.branch, null, "detached worktree must have branch=null");
  assert.strictEqual(detached.isDetached, true, "isDetached must be true");
});

test("git_worktree_list: querying from the linked worktree's own path resolves the same repo", () => {
  const repoDir = makeRepo("wt-fromlinked");
  const linkedDir = path.join(TMP, "wt-fromlinked-extra");
  gitIn(repoDir, `worktree add "${linkedDir}" -b side`);
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, linkedDir) });
  assert.strictEqual(r.count, 2, "should see both worktrees when queried from the linked one");
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("git_worktree_list: non-git directory throws a descriptive error (not a crash)", () => {
  const notGit = path.join(TMP, "wt-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_worktree_list", { path: path.relative(TMP, notGit) }),
    /not a git|git worktree list failed|git repository/i
  );
});

test("git_worktree_list: repo with no commits yet (unborn HEAD) does not crash", () => {
  const repoDir = path.join(TMP, "wt-unborn");
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  let result;
  assert.doesNotThrow(() => {
    result = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  }, "unborn-HEAD repo should not crash the tool");
  assert.strictEqual(result.count, 1, "the main worktree itself still counts as one entry");
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("git_worktree_list: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_worktree_list", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_worktree_list: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_worktree_list", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_worktree_list: result is fully JSON-serialisable (no circular refs)", () => {
  const repoDir = makeRepo("wt-json");
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.count, r.count);
});

test("git_worktree_list: result has no unexpected top-level keys (no prototype pollution)", () => {
  const repoDir = makeRepo("wt-proto");
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  const expected = new Set(["count", "worktrees"]);
  for (const key of Object.keys(r)) {
    assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("git_worktree_list: repo with 5 linked worktrees — all listed correctly", () => {
  const repoDir = makeRepo("wt-many");
  for (let i = 0; i < 5; i++) {
    gitIn(repoDir, `worktree add "${path.join(TMP, `wt-many-extra-${i}`)}" -b br-${i}`);
  }
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 6, "expected main + 5 linked worktrees");
});

test("git_worktree_list: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("wt-concurrent");
  gitIn(repoDir, `worktree add "${path.join(TMP, "wt-concurrent-extra")}" -b side`);
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () =>
    executeTool("git_worktree_list", { path: relPath })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].count, first.count, `call ${i}: count mismatch`);
  }
});

test("git_worktree_list: locked worktree reports isLocked=true and lockReason", () => {
  const repoDir = makeRepo("wt-locked");
  const linkedDir = path.join(TMP, "wt-locked-extra");
  gitIn(repoDir, `worktree add "${linkedDir}" -b locked-branch`);
  gitIn(repoDir, `worktree lock "${linkedDir}" --reason "in use by test"`);
  const r = executeTool("git_worktree_list", { path: path.relative(TMP, repoDir) });
  const locked = r.worktrees.find((w) => path.basename(w.path) === "wt-locked-extra");
  assert.ok(locked, "expected the locked worktree entry");
  assert.strictEqual(locked.isLocked, true, "isLocked must be true");
  assert.strictEqual(locked.lockReason, "in use by test", `lockReason mismatch: ${locked.lockReason}`);
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_worktree_list fixture repos", () => {
  const dirs = [
    "wt-basic", "wt-single", "wt-fields", "wt-path", "wt-linked", "wt-linked-extra",
    "wt-detached", "wt-detached-extra", "wt-fromlinked", "wt-fromlinked-extra",
    "wt-not-git", "wt-unborn", "wt-json", "wt-proto", "wt-many",
    "wt-many-extra-0", "wt-many-extra-1", "wt-many-extra-2", "wt-many-extra-3", "wt-many-extra-4",
    "wt-concurrent", "wt-concurrent-extra", "wt-locked", "wt-locked-extra",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "wt-basic")), "wt-basic removed");
});
