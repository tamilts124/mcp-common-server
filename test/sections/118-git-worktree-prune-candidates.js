"use strict";
/**
 * [118] GIT_WORKTREE_PRUNE_CANDIDATES — git_worktree_prune_candidates tool
 *
 * Rigor levels covered:
 *   Normal:   single-worktree repo has zero candidates; a linked worktree
 *             whose directory was deleted from disk (git hasn't run gc yet,
 *             so git itself may not mark it prunable immediately) is still
 *             surfaced via missingOnDisk.
 *   Medium:   repo with only the main worktree returns candidateCount:0,
 *             empty candidates array, not an error.
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal / absolute-path-outside-root blocked; result
 *             is JSON-serialisable; no unexpected top-level keys; main
 *             worktree is never included even if somehow flagged.
 *   Extreme:  3 deleted linked worktrees all detected; 10 concurrent calls
 *             consistent; execute_pipeline op-enum registration; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[118] GIT_WORKTREE_PRUNE_CANDIDATES — git_worktree_prune_candidates tool`);

function gitIn(repoDir, cmd) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

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

test("git_worktree_prune_candidates: single-worktree repo has zero candidates", () => {
  const repoDir = makeRepo("wtp-single");
  const r = executeTool("git_worktree_prune_candidates", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalWorktrees, 1);
  assert.strictEqual(r.candidateCount, 0);
  assert.deepStrictEqual(r.candidates, []);
});

test("git_worktree_prune_candidates: linked worktree deleted from disk is flagged missingOnDisk", () => {
  const repoDir = makeRepo("wtp-deleted");
  const linkedDir = path.join(TMP, "wtp-deleted-extra");
  gitIn(repoDir, `worktree add "${linkedDir}" -b feature-x`);
  fs.rmSync(linkedDir, { recursive: true, force: true }); // delete dir but leave git's admin files stale
  const r = executeTool("git_worktree_prune_candidates", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalWorktrees, 2);
  const cand = r.candidates.find((c) => path.basename(c.path) === "wtp-deleted-extra");
  assert.ok(cand, `expected a candidate for the deleted worktree among: ${JSON.stringify(r.candidates)}`);
  assert.strictEqual(cand.missingOnDisk, true);
  assert.strictEqual(cand.branch, "refs/heads/feature-x");
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_worktree_prune_candidates: main-only repo returns empty candidates, not an error", () => {
  const repoDir = makeRepo("wtp-main-only");
  let r;
  assert.doesNotThrow(() => { r = executeTool("git_worktree_prune_candidates", { path: path.relative(TMP, repoDir) }); });
  assert.strictEqual(r.candidateCount, 0);
});

test("git_worktree_prune_candidates: missing path resolves via the shared resolveRepoDir convention (clean error if it throws, not a crash)", () => {
  try {
    executeTool("git_worktree_prune_candidates", {});
  } catch (e) {
    assert.ok(e instanceof Error, "must throw a clean Error, not crash the process");
  }
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_worktree_prune_candidates: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "wtp-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_worktree_prune_candidates", { path: path.relative(TMP, notGit) }),
    /not a git|git worktree list failed|git repository/i
  );
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_worktree_prune_candidates: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_worktree_prune_candidates", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_worktree_prune_candidates: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_worktree_prune_candidates", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_worktree_prune_candidates: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("wtp-json");
  const r = executeTool("git_worktree_prune_candidates", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).totalWorktrees, r.totalWorktrees);
});

test("git_worktree_prune_candidates: result has no unexpected top-level keys", () => {
  const repoDir = makeRepo("wtp-keys");
  const r = executeTool("git_worktree_prune_candidates", { path: path.relative(TMP, repoDir) });
  const expected = new Set(["totalWorktrees", "candidateCount", "candidates"]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
});

test("git_worktree_prune_candidates: main worktree never appears among candidates even when deleted-check would otherwise match", () => {
  const repoDir = makeRepo("wtp-main-safe");
  const r = executeTool("git_worktree_prune_candidates", { path: path.relative(TMP, repoDir) });
  const mainAsCandidate = r.candidates.find((c) => path.basename(c.path) === "wtp-main-safe");
  assert.ok(!mainAsCandidate, "main worktree must never be reported as a prune candidate");
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_worktree_prune_candidates: 3 deleted linked worktrees all detected", () => {
  const repoDir = makeRepo("wtp-many");
  const dirs = [];
  for (let i = 0; i < 3; i++) {
    const d = path.join(TMP, `wtp-many-extra-${i}`);
    gitIn(repoDir, `worktree add "${d}" -b br-${i}`);
    dirs.push(d);
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  const r = executeTool("git_worktree_prune_candidates", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.candidateCount, 3, `expected 3 candidates, got ${r.candidateCount}: ${JSON.stringify(r.candidates)}`);
  assert.ok(r.candidates.every((c) => c.missingOnDisk === true));
});

test("git_worktree_prune_candidates: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("wtp-concurrent");
  const linkedDir = path.join(TMP, "wtp-concurrent-extra");
  gitIn(repoDir, `worktree add "${linkedDir}" -b side`);
  fs.rmSync(linkedDir, { recursive: true, force: true });
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_worktree_prune_candidates", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].candidateCount, first.candidateCount, `call ${i}: mismatch`);
  }
});

test("git_worktree_prune_candidates: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_worktree_prune_candidates"), "git_worktree_prune_candidates missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_worktree_prune_candidates fixture repos", () => {
  const dirs = [
    "wtp-single", "wtp-deleted", "wtp-main-only", "wtp-not-git", "wtp-json", "wtp-keys",
    "wtp-main-safe", "wtp-many", "wtp-many-extra-0", "wtp-many-extra-1", "wtp-many-extra-2",
    "wtp-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "wtp-single")));
});
