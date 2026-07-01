"use strict";
/**
 * [45] GIT NESTED REPO-ROOT DISCOVERY — audit of git_status, git_log,
 * git_blame, git_diff, git_stash_list, git_branch_list, git_show,
 * git_tag_list for the same "cwd is a subdirectory, not the repo root"
 * gap that git_ownership's audit (test/sections/41-git-ownership.js) found
 * and fixed.
 *
 * Background: every git_* dispatch handler in lib/dispatchRead.js used to
 * hand gitExec() whatever directory resolveClientPath() resolved (or the
 * first configured MCP root when no `path` arg was given) and rely on
 * git's own upward .git-discovery, bounded by
 * gitOpsHelpers.gitExec's GIT_CEILING_DIRECTORIES=dirname(cwd). That only
 * works when cwd is already the repo root — the ceiling is exactly one
 * level above cwd, so a target nested two or more levels inside a repo
 * (with no .git in its immediate parent) silently failed discovery
 * ("not a git repository") even though it plainly is one.
 *
 * Fix: lib/dispatchRead.js now resolves every git_* tool's repo directory
 * through the shared, jail-bounded findRepoRoot() helper (originally
 * written for git_ownership, now lives in lib/gitOpsHelpers.js) before
 * calling into lib/gitOps.js / lib/gitStashOps.js / lib/gitBranchOps.js /
 * lib/gitTagOps.js.
 *
 * Rigor levels covered:
 *
 *   Normal:   each of the 8 tools succeeds (rather than throwing "not a
 *             git repository") when called with a path 2-3 levels deep
 *             inside a real repo, and returns data consistent with calling
 *             the same tool at the repo root directly.
 *
 *   Medium:   a 1-level-deep subdirectory (the previously-"working" case,
 *             since GIT_CEILING_DIRECTORIES=dirname(cwd) already tolerated
 *             exactly one level) still works unchanged.
 *
 *   High:     omitting `path` entirely (falls back to the first configured
 *             MCP root) is unchanged; a repo nested inside a deeper
 *             directory structure than the fixture default (5 levels)
 *             still resolves correctly.
 *
 *   Critical: jail-boundary regression — a non-git directory inside the
 *             sandbox must always throw "not a git repository", never
 *             silently adopt an unrelated ancestor repo from outside the
 *             jail (mirrors the git_ownership jail-escape regression test).
 *
 *   Extreme:  10 concurrent (sequential-simulated) nested-path calls
 *             return results consistent with each other and with the
 *             root-level call.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[45] GIT NESTED REPO-ROOT DISCOVERY — audit of remaining git_* tools`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

function gitIn(repoDir, cmd, extraEnv) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Nest Author", GIT_AUTHOR_EMAIL: "nest@example.com",
      GIT_COMMITTER_NAME: "Nest Author", GIT_COMMITTER_EMAIL: "nest@example.com", ...extraEnv },
  });
}

/** Create a git repo under TMP/<name> with a nested directory tree and a
 *  couple of commits, so every git_* tool has real history/files/tags/
 *  stashes/branches to report on regardless of which nested path is used. */
function makeNestedRepo(name, depth) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  gitIn(repoDir, "config user.email nest@example.com");
  gitIn(repoDir, 'config user.name "Nest Author"');

  // Build a nested directory chain: repoDir/lvl1/lvl2/.../lvlN, with a
  // tracked file at the deepest level so file-scoped tools (git_blame,
  // git_show) have something real to point at.
  let deepest = repoDir;
  const segs = [];
  for (let i = 1; i <= depth; i++) {
    segs.push(`lvl${i}`);
    deepest = path.join(deepest, `lvl${i}`);
  }
  fs.mkdirSync(deepest, { recursive: true });
  fs.writeFileSync(path.join(deepest, "deep.txt"), "alpha\nbeta\ngamma\n", "utf8");
  gitIn(repoDir, `add ${segs.join("/")}/deep.txt`);
  gitIn(repoDir, 'commit -m "add deep.txt"');

  // Second commit touching the deep file, so git_log/git_blame have real
  // history to differentiate, plus a tag and a branch for git_tag_list /
  // git_branch_list to enumerate.
  fs.appendFileSync(path.join(deepest, "deep.txt"), "delta\n");
  gitIn(repoDir, `add ${segs.join("/")}/deep.txt`);
  gitIn(repoDir, 'commit -m "extend deep.txt"');
  gitIn(repoDir, "tag -a v1.0 -m \"first tag\"");
  gitIn(repoDir, "branch feature-x");

  return { repoDir, deepDir: deepest, deepFileRel: [...segs, "deep.txt"].join("/") };
}

function relTo(p) { return path.relative(TMP, p); }

// ── NORMAL — each tool succeeds from a 2-3-level-deep nested path ────────────

test("git_status: succeeds when path is 2 levels deep inside the repo", () => {
  const { repoDir, deepDir } = makeNestedRepo("nest-status", 2);
  const atRoot   = executeTool("git_status", { path: relTo(repoDir) });
  const atNested = executeTool("git_status", { path: relTo(deepDir) });
  assert.strictEqual(atNested.branch, "main");
  assert.strictEqual(atNested.branch, atRoot.branch);
  assert.strictEqual(atNested.clean, true);
});

test("git_log: succeeds when path is 3 levels deep, same commit count as root", () => {
  const { repoDir, deepDir } = makeNestedRepo("nest-log", 3);
  const atRoot   = executeTool("git_log", { path: relTo(repoDir), limit: 20 });
  const atNested = executeTool("git_log", { path: relTo(deepDir), limit: 20 });
  assert.strictEqual(atNested.count, 2);
  assert.strictEqual(atNested.count, atRoot.count);
  assert.strictEqual(atNested.commits[0].hash, atRoot.commits[0].hash);
});

test("git_blame: succeeds when the target file is 2 levels deep", () => {
  const { deepFileRel, repoDir } = makeNestedRepo("nest-blame", 2);
  const r = executeTool("git_blame", { path: path.join(relTo(repoDir), deepFileRel) });
  assert.strictEqual(r.lineCount, 4); // alpha, beta, gamma, delta
  assert.ok(r.lines[0].hash.match(/^[0-9a-f]{40}$/));
});

test("git_diff: succeeds (stat_only) when path is 2 levels deep, matches root-level diff", () => {
  const { repoDir, deepDir, deepFileRel } = makeNestedRepo("nest-diff", 2);
  fs.appendFileSync(path.join(deepDir, "deep.txt"), "epsilon\n");
  const atRoot   = executeTool("git_diff", { path: relTo(repoDir), stat_only: true });
  const atNested = executeTool("git_diff", { path: relTo(deepDir), stat_only: true });
  assert.strictEqual(atNested.changedFiles.length, atRoot.changedFiles.length);
  assert.ok(atNested.changedFiles.some(f => f.path.endsWith("deep.txt")));
});

test("git_stash_list: succeeds when path is 2 levels deep", () => {
  const { repoDir, deepDir } = makeNestedRepo("nest-stash", 2);
  fs.appendFileSync(path.join(deepDir, "deep.txt"), "stash-me\n");
  gitIn(repoDir, "stash push -m \"nested stash\"");
  const r = executeTool("git_stash_list", { path: relTo(deepDir) });
  assert.strictEqual(r.count, 1);
  assert.ok(r.stashes[0].message.includes("nested stash"));
  gitIn(repoDir, "stash drop"); // tidy up so repo state doesn't leak into other assertions
});

test("git_branch_list: succeeds when path is 2 levels deep, sees feature-x branch", () => {
  const { repoDir, deepDir } = makeNestedRepo("nest-branch", 2);
  const r = executeTool("git_branch_list", { path: relTo(deepDir) });
  assert.ok(r.branches.some(b => b.name === "feature-x"));
  assert.strictEqual(r.currentBranch, "main");
});

test("git_show: succeeds when path is 2 levels deep, reads deep.txt at HEAD", () => {
  // git_show's `file` argument is always relative to the *repo root*
  // (git_ownership's own convention too — see gitShow's JSDoc), not to
  // whatever nested directory `path` resolved to. The fix under test here
  // is repo-ROOT discovery (finding the right cwd for the git command),
  // not path re-basing — so `file` must still be given repo-root-relative.
  const { repoDir, deepDir, deepFileRel } = makeNestedRepo("nest-show", 2);
  const r = executeTool("git_show", { path: relTo(deepDir), file: deepFileRel });
  assert.strictEqual(r.content, "alpha\nbeta\ngamma\ndelta\n");
});

test("git_tag_list: succeeds when path is 2 levels deep, sees v1.0", () => {
  const { repoDir, deepDir } = makeNestedRepo("nest-tag", 2);
  const r = executeTool("git_tag_list", { path: relTo(deepDir) });
  assert.ok(r.tags.some(t => t.name === "v1.0"));
});

// ── MEDIUM — 1-level-deep (previously-working case) still works ──────────────

test("git_status: 1-level-deep subdirectory still works (previously-tolerated case unchanged)", () => {
  const { repoDir } = makeNestedRepo("nest-shallow", 1);
  const oneDeep = path.join(repoDir, "lvl1");
  const r = executeTool("git_status", { path: relTo(oneDeep) });
  assert.strictEqual(r.branch, "main");
});

// ── HIGH — omitted path / deeper nesting ──────────────────────────────────────

test("git_status: omitted path still falls back to the first configured MCP root unchanged", () => {
  // No assertion on repo-ness of the MCP root itself (it may or may not be
  // a git repo depending on the environment) — only that this doesn't
  // throw a *different* class of error than before (i.e. behavior for the
  // no-path case is unaffected by the findRepoRoot change).
  assert.doesNotThrow(() => {
    try { executeTool("git_status", {}); } catch (e) {
      assert.ok(/not a git repository|git status failed/i.test(e.message));
    }
  });
});

test("git_log: succeeds when path is 5 levels deep inside the repo", () => {
  const { repoDir, deepDir } = makeNestedRepo("nest-deep5", 5);
  const r = executeTool("git_log", { path: relTo(deepDir), limit: 20 });
  assert.strictEqual(r.count, 2);
});

// ── CRITICAL — jail-boundary regression ───────────────────────────────────────

test("git_status: non-git directory inside the sandbox still throws (never escapes the jail)", () => {
  const notGit = path.join(TMP, "nest-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_status", { path: relTo(notGit) }),
    /not a git repository|git status failed/i,
    "must not silently adopt a repo found above the jail boundary"
  );
});

test("git_log: non-git nested directory inside the sandbox still throws (never escapes the jail)", () => {
  const notGit = path.join(TMP, "nest-not-git-log", "sub", "deeper");
  fs.mkdirSync(notGit, { recursive: true });
  assert.throws(
    () => executeTool("git_log", { path: relTo(notGit) }),
    /git log failed/i,
  );
});

test("git_branch_list: non-git directory inside the sandbox still throws (never escapes the jail)", () => {
  const notGit = path.join(TMP, "nest-not-git-branch");
  fs.mkdirSync(notGit, { recursive: true });
  assert.throws(
    () => executeTool("git_branch_list", { path: relTo(notGit) }),
    /not a git repository|git branch list failed/i,
  );
});

// ── EXTREME — concurrency / consistency ───────────────────────────────────────

test("git_status: 10 concurrent (sequential-simulated) nested-path calls return consistent results", () => {
  const { deepDir } = makeNestedRepo("nest-concurrent", 3);
  const relPath = relTo(deepDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_status", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].branch, first.branch, `call ${i}: branch mismatch`);
    assert.strictEqual(results[i].clean, first.clean, `call ${i}: clean mismatch`);
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove nested-repo-root fixture repos", () => {
  const dirs = [
    "nest-status", "nest-log", "nest-blame", "nest-diff", "nest-stash",
    "nest-branch", "nest-show", "nest-tag", "nest-shallow", "nest-deep5",
    "nest-not-git", "nest-not-git-log", "nest-not-git-branch", "nest-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "nest-status")), "nest-status removed");
});
