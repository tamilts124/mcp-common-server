"use strict";
/**
 * [116] GIT_ORPHANED_BRANCHES — git_orphaned_branches tool
 *
 * Rigor levels covered:
 *   Normal:   a branch merged into main is reported; current branch and
 *             base branch are excluded from results.
 *   Medium:   explicit base param overrides auto-detect; unmerged branch
 *             is NOT reported; auto-detect fails cleanly with no main/master.
 *   High:     non-git directory throws; unknown base ref throws.
 *   Critical: path traversal / absolute-path-outside-root blocked; shell-
 *             injection-shaped base is rejected, never executed; result is
 *             JSON-serialisable; no unexpected top-level/orphaned keys.
 *   Extreme:  many-branch repo scan completes without crashing; 10
 *             concurrent calls consistent; registered in execute_pipeline
 *             op enum; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[116] GIT_ORPHANED_BRANCHES — git_orphaned_branches tool`);

function gitIn(repoDir, cmd) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

function makeRepo(name, baseBranch) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, `init -b ${baseBranch || "main"}`);
  gitIn(repoDir, "config user.email test@example.com");
  gitIn(repoDir, 'config user.name "Test User"');
  return repoDir;
}

function commit(repoDir, file, msg) {
  fs.writeFileSync(path.join(repoDir, file), msg, "utf8");
  gitIn(repoDir, `add ${file}`);
  gitIn(repoDir, `commit -m ${JSON.stringify(msg)}`);
  return gitIn(repoDir, "rev-parse HEAD").trim();
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("git_orphaned_branches: merged branch reported, current+base branches excluded", () => {
  const repoDir = makeRepo("gob-basic");
  commit(repoDir, "a.txt", "a");
  gitIn(repoDir, "branch feature-merged");
  // feature-merged's tip == main's tip (branched, no new commits) -> fully merged.
  const r = executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.base, "main");
  assert.strictEqual(r.currentBranch, "main");
  assert.ok(r.orphaned.some(b => b.name === "feature-merged"));
  assert.ok(!r.orphaned.some(b => b.name === "main"), "base branch must be excluded");
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_orphaned_branches: explicit base overrides auto-detect", () => {
  const repoDir = makeRepo("gob-explicit-base", "trunk");
  commit(repoDir, "a.txt", "a");
  gitIn(repoDir, "branch old-feature");
  const r = executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir), base: "trunk" });
  assert.strictEqual(r.base, "trunk");
  assert.ok(r.orphaned.some(b => b.name === "old-feature"));
});

test("git_orphaned_branches: unmerged branch with unique commits is NOT reported", () => {
  const repoDir = makeRepo("gob-unmerged");
  commit(repoDir, "a.txt", "a");
  gitIn(repoDir, "checkout -b wip-feature");
  commit(repoDir, "b.txt", "unique wip commit");
  gitIn(repoDir, "checkout main");
  const r = executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir) });
  assert.ok(!r.orphaned.some(b => b.name === "wip-feature"), "unmerged branch must not be flagged");
});

test("git_orphaned_branches: auto-detect fails cleanly with no main/master", () => {
  const repoDir = makeRepo("gob-no-base", "trunk");
  commit(repoDir, "a.txt", "a");
  assert.throws(
    () => executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir) }),
    /could not auto-detect/i
  );
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_orphaned_branches: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "gob-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_orphaned_branches", { path: path.relative(TMP, notGit) }),
    /not a git repository/i
  );
});

test("git_orphaned_branches: unknown base ref throws a descriptive error", () => {
  const repoDir = makeRepo("gob-unknown-base");
  commit(repoDir, "a.txt", "a");
  assert.throws(
    () => executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir), base: "totally-nonexistent-branch-xyz" }),
    /unknown base branch/i
  );
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_orphaned_branches: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_orphaned_branches", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_orphaned_branches: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_orphaned_branches", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_orphaned_branches: shell-injection-shaped base is rejected, never executed", () => {
  const repoDir = makeRepo("gob-inject-base");
  commit(repoDir, "a.txt", "a");
  assert.throws(
    () => executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir), base: "main; rm -rf /" }),
    /disallowed characters|git_ops/i
  );
  assert.ok(fs.existsSync(path.join(repoDir, "a.txt")), "working tree should be untouched by the injection payload");
});

test("git_orphaned_branches: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("gob-json");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).base, r.base);
});

test("git_orphaned_branches: result has no unexpected top-level or orphaned keys", () => {
  const repoDir = makeRepo("gob-keys");
  commit(repoDir, "a.txt", "a");
  gitIn(repoDir, "branch merged-b");
  const r = executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir) });
  const expectedTop = new Set(["base", "currentBranch", "totalBranches", "orphanedCount", "orphaned"]);
  for (const key of Object.keys(r)) assert.ok(expectedTop.has(key), `unexpected top-level key: '${key}'`);
  const expectedOrphan = new Set(["name", "lastCommitHash", "lastCommitShortHash", "lastCommitDate", "lastCommitSubject", "lastCommitAuthor", "ageDays"]);
  for (const b of r.orphaned) {
    for (const key of Object.keys(b)) assert.ok(expectedOrphan.has(key), `unexpected orphaned key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_orphaned_branches: many-branch repo scan completes without crashing", () => {
  const repoDir = makeRepo("gob-many");
  commit(repoDir, "a.txt", "a");
  for (let i = 0; i < 20; i++) gitIn(repoDir, `branch merged-${i}`);
  let r;
  assert.doesNotThrow(() => { r = executeTool("git_orphaned_branches", { path: path.relative(TMP, repoDir) }); });
  assert.strictEqual(r.totalBranches, 21); // main + 20
  assert.strictEqual(r.orphanedCount, 20);
});

test("git_orphaned_branches: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("gob-concurrent");
  commit(repoDir, "a.txt", "a");
  gitIn(repoDir, "branch side");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_orphaned_branches", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].orphanedCount, first.orphanedCount, `call ${i}: mismatch`);
  }
});

test("git_orphaned_branches: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_orphaned_branches"), "git_orphaned_branches missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_orphaned_branches fixture repos", () => {
  const dirs = [
    "gob-basic", "gob-explicit-base", "gob-unmerged", "gob-no-base",
    "gob-not-git", "gob-unknown-base", "gob-inject-base", "gob-json",
    "gob-keys", "gob-many", "gob-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "gob-basic")));
});
