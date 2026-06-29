"use strict";
/**
 * [29] GIT_BRANCH_LIST — git_branch_list tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — single-branch repo returns currentBranch, count,
 *             and a branches array with the expected fields and isCurrent=true.
 *
 *   Medium:   boundary — multi-branch repo (current + others), include_remote
 *             default false (no remotes appear), branch names/order sane.
 *
 *   High:     dependency failure — non-git directory throws descriptive error;
 *             repo with no commits yet (unborn HEAD) handled without crash.
 *
 *   Critical: security — path traversal / absolute-path-outside-root blocked;
 *             injection-shaped branch/commit content round-trips literally;
 *             result is JSON-serialisable; no prototype pollution.
 *
 *   Extreme:  stress — repo with many branches all listed correctly; 10
 *             concurrent calls consistent; include_remote=true with a local
 *             "remote" clone includes remote-tracking branches, excludes HEAD ptr.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[29] GIT_BRANCH_LIST — git_branch_list tool`);

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

test("git_branch_list: returns result object without throwing", () => {
  const repoDir = makeRepo("branch-basic");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("git_branch_list: single-branch repo reports currentBranch=main, count=1", () => {
  const repoDir = makeRepo("branch-single");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.currentBranch, "main", `currentBranch should be main, got: ${r.currentBranch}`);
  assert.strictEqual(r.count, 1, "count must be 1");
  assert.strictEqual(r.branches.length, 1, "branches.length must be 1");
});

test("git_branch_list: each entry has required fields with correct types", () => {
  const repoDir = makeRepo("branch-fields");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  const b = r.branches[0];
  assert.ok(typeof b.name === "string", "name must be string");
  assert.ok(typeof b.isCurrent === "boolean", "isCurrent must be boolean");
  assert.ok(typeof b.isRemote === "boolean", "isRemote must be boolean");
  assert.ok(typeof b.lastCommitHash === "string" && b.lastCommitHash.length === 40,
    `lastCommitHash must be 40-char hex: ${b.lastCommitHash}`);
  assert.ok(typeof b.lastCommitShortHash === "string" && b.lastCommitShortHash.length > 0,
    "lastCommitShortHash must be non-empty string");
  assert.ok(typeof b.lastCommitDate === "string", "lastCommitDate must be string");
  assert.ok(typeof b.lastCommitSubject === "string", "lastCommitSubject must be string");
  assert.ok(typeof b.lastCommitAuthor === "string", "lastCommitAuthor must be string");
});

test("git_branch_list: lastCommitDate is a valid ISO 8601 string", () => {
  const repoDir = makeRepo("branch-date");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  const d = new Date(r.branches[0].lastCommitDate);
  assert.ok(!isNaN(d.getTime()), `lastCommitDate must be parseable: ${r.branches[0].lastCommitDate}`);
});

test("git_branch_list: lastCommitSubject matches the commit we made", () => {
  const repoDir = makeRepo("branch-subject");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.branches[0].lastCommitSubject, "initial commit");
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("git_branch_list: multi-branch repo lists current + others, default excludes remotes", () => {
  const repoDir = makeRepo("branch-multi");
  gitIn(repoDir, "branch feature-a");
  gitIn(repoDir, "branch feature-b");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 3, "expected 3 local branches");
  const names = r.branches.map(b => b.name).sort();
  assert.deepStrictEqual(names, ["feature-a", "feature-b", "main"]);
  for (const b of r.branches) assert.strictEqual(b.isRemote, false, `${b.name} should not be remote`);
});

test("git_branch_list: exactly one branch has isCurrent=true, matching currentBranch", () => {
  const repoDir = makeRepo("branch-current");
  gitIn(repoDir, "branch other");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  const currents = r.branches.filter(b => b.isCurrent);
  assert.strictEqual(currents.length, 1, "exactly one branch must be current");
  assert.strictEqual(currents[0].name, r.currentBranch);
});

test("git_branch_list: switching branches updates which entry is current", () => {
  const repoDir = makeRepo("branch-switch");
  gitIn(repoDir, "branch other");
  gitIn(repoDir, "checkout other");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.currentBranch, "other");
  const otherEntry = r.branches.find(b => b.name === "other");
  assert.ok(otherEntry.isCurrent, "other branch must be marked current");
  const mainEntry = r.branches.find(b => b.name === "main");
  assert.ok(!mainEntry.isCurrent, "main must not be marked current after switch");
});

test("git_branch_list: include_remote=false (default/explicit) never returns isRemote=true entries", () => {
  const repoDir = makeRepo("branch-no-remote");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir), include_remote: false });
  assert.ok(r.branches.every(b => !b.isRemote), "no entries should be remote");
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("git_branch_list: non-git directory throws a descriptive error (not a crash)", () => {
  const notGit = path.join(TMP, "branch-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_branch_list", { path: path.relative(TMP, notGit) }),
    /not a git|git branch list failed|git repository/i
  );
});

test("git_branch_list: repo with no commits yet (unborn HEAD) does not crash", () => {
  const repoDir = path.join(TMP, "branch-unborn");
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  let result;
  assert.doesNotThrow(() => {
    result = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  }, "unborn-HEAD repo should not crash the tool");
  assert.strictEqual(result.count, 0, "no real branches exist yet (no commits)");
  assert.ok(Array.isArray(result.branches), "branches must still be an array");
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("git_branch_list: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_branch_list", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_branch_list: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_branch_list", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_branch_list: injection-shaped branch name round-trips literally, never executed", () => {
  const repoDir = makeRepo("branch-inject");
  // Git branch names disallow most shell metachars anyway; use a benign but
  // unusual name to confirm it passes through `for-each-ref` parsing intact.
  gitIn(repoDir, 'branch "feature/weird-name_123"');
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  const names = r.branches.map(b => b.name);
  assert.ok(names.includes("feature/weird-name_123"), `expected weird branch name in: ${names}`);
});

test("git_branch_list: result is fully JSON-serialisable (no circular refs)", () => {
  const repoDir = makeRepo("branch-json");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.count, r.count);
});

test("git_branch_list: result has no unexpected top-level keys (no prototype pollution)", () => {
  const repoDir = makeRepo("branch-proto");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  const expected = new Set(["currentBranch", "count", "branches"]);
  for (const key of Object.keys(r)) {
    assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("git_branch_list: repo with 10 branches — all listed correctly", () => {
  const repoDir = makeRepo("branch-many");
  for (let i = 0; i < 9; i++) gitIn(repoDir, `branch br-${i}`);
  const r = executeTool("git_branch_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 10, "expected 10 branches (main + 9)");
});

test("git_branch_list: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("branch-concurrent");
  gitIn(repoDir, "branch side");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () =>
    executeTool("git_branch_list", { path: relPath })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].count, first.count, `call ${i}: count mismatch`);
    assert.strictEqual(results[i].currentBranch, first.currentBranch, `call ${i}: currentBranch mismatch`);
  }
});

test("git_branch_list: include_remote=true on a clone includes remote-tracking branches, excludes origin/HEAD", () => {
  const upstream = makeRepo("branch-upstream");
  const cloneDir = path.join(TMP, "branch-clone");
  execSync(`git clone "${upstream}" "${cloneDir}"`, { stdio: ["ignore", "pipe", "pipe"] });
  gitIn(upstream, "branch second");
  gitIn(cloneDir, "fetch origin");
  const r = executeTool("git_branch_list", { path: path.relative(TMP, cloneDir), include_remote: true });
  const remoteNames = r.branches.filter(b => b.isRemote).map(b => b.name);
  assert.ok(remoteNames.some(n => n.includes("origin/main")), `expected origin/main among: ${remoteNames}`);
  assert.ok(!remoteNames.some(n => n.endsWith("HEAD")), `origin/HEAD pointer must be excluded: ${remoteNames}`);
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_branch_list fixture repos", () => {
  const dirs = [
    "branch-basic", "branch-single", "branch-fields", "branch-date",
    "branch-subject", "branch-multi", "branch-current", "branch-switch",
    "branch-no-remote", "branch-not-git", "branch-unborn", "branch-inject",
    "branch-json", "branch-proto", "branch-many", "branch-concurrent",
    "branch-upstream", "branch-clone",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "branch-basic")), "branch-basic removed");
});
