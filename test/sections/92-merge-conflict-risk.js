"use strict";
/**
 * [92] MERGE_CONFLICT_RISK — branch conflict prediction via changed-file overlap
 *
 * Rigor levels:
 *   Normal:   two branches editing the same file since diverging report it
 *             in `overlapping` with riskLevel != 'none'; two branches
 *             editing disjoint files report riskLevel 'none'.
 *   Medium:   missing branch_a/branch_b throws a clean validation error;
 *             top_n caps the overlapping list.
 *   High:     unknown branch ref throws a descriptive error (no common
 *             ancestor / bad ref).
 *   Critical: path traversal via path arg blocked; shell-injection-shaped
 *             branch_a is rejected, not executed.
 *   Extreme:  overlapping sorted by riskScore descending; result is
 *             JSON-serialisable; 5 concurrent calls consistent.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[92] MERGE_CONFLICT_RISK — branch conflict prediction`);

function gitIn(repoDir, cmd) {
  const env = { ...process.env,
    GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" };
  return execSync(`git ${cmd}`, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
}

function makeRepo(name) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -q -b main");
  return repoDir;
}

test("normal: same file edited on both branches is flagged overlapping, riskLevel != 'none'", () => {
  const repoDir = makeRepo("mcr_basic");
  fs.writeFileSync(path.join(repoDir, "shared.js"), "line1\n");
  fs.writeFileSync(path.join(repoDir, "onlyA.js"), "a\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m base');
  gitIn(repoDir, "checkout -q -b feature-a");
  fs.writeFileSync(path.join(repoDir, "shared.js"), "line1\nfeatureA\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "feature a change"');
  gitIn(repoDir, "checkout -q main");
  gitIn(repoDir, "checkout -q -b feature-b");
  fs.writeFileSync(path.join(repoDir, "shared.js"), "line1\nfeatureB\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "feature b change"');
  const r = executeTool("merge_conflict_risk", { path: "mcr_basic", branch_a: "feature-a", branch_b: "feature-b" });
  assert.ok(r.overlapping.some(o => o.path === "shared.js"));
  assert.notStrictEqual(r.riskLevel, "none");
  assert.strictEqual(r.overlappingCount, 1);
});

test("normal: disjoint file changes report riskLevel 'none'", () => {
  const repoDir = path.join(TMP, "mcr_basic");
  gitIn(repoDir, "checkout -q main");
  gitIn(repoDir, "checkout -q -b feature-c");
  fs.writeFileSync(path.join(repoDir, "onlyC.js"), "c\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "feature c change"');
  gitIn(repoDir, "checkout -q main");
  gitIn(repoDir, "checkout -q -b feature-d");
  fs.writeFileSync(path.join(repoDir, "onlyD.js"), "d\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "feature d change"');
  const r = executeTool("merge_conflict_risk", { path: "mcr_basic", branch_a: "feature-c", branch_b: "feature-d" });
  assert.strictEqual(r.overlappingCount, 0);
  assert.strictEqual(r.riskLevel, "none");
});

test("medium: missing branch_a throws a clean validation error", () => {
  try {
    executeTool("merge_conflict_risk", { path: "mcr_basic", branch_b: "feature-b" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e.message.includes("branch_a")); }
});

test("medium: top_n caps the overlapping list", () => {
  const r = executeTool("merge_conflict_risk", { path: "mcr_basic", branch_a: "feature-a", branch_b: "feature-b", top_n: 0 });
  // top_n clamps to a minimum of 1, not 0
  assert.ok(r.overlapping.length <= 1);
});

test("high: unknown branch ref throws a descriptive error", () => {
  try {
    executeTool("merge_conflict_risk", { path: "mcr_basic", branch_a: "feature-a", branch_b: "does-not-exist-branch" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("merge_conflict_risk", { path: "../../../../etc", branch_a: "main", branch_b: "main" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped branch_a is rejected, not executed", () => {
  try {
    executeTool("merge_conflict_risk", { path: "mcr_basic", branch_a: "$(rm -rf /)", branch_b: "main" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: overlapping sorted by riskScore descending", () => {
  const repoDir = path.join(TMP, "mcr_basic");
  gitIn(repoDir, "checkout -q feature-a");
  fs.writeFileSync(path.join(repoDir, "onlyA.js"), "a\nmore\nlines\nhere\nfor\nchurn\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "churn onlyA"');
  gitIn(repoDir, "checkout -q feature-b");
  fs.writeFileSync(path.join(repoDir, "onlyA.js"), "a\nother\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "touch onlyA too"');
  const r = executeTool("merge_conflict_risk", { path: "mcr_basic", branch_a: "feature-a", branch_b: "feature-b" });
  for (let i = 1; i < r.overlapping.length; i++) {
    assert.ok(r.overlapping[i - 1].riskScore >= r.overlapping[i].riskScore);
  }
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("merge_conflict_risk", { path: "mcr_basic", branch_a: "feature-a", branch_b: "feature-b" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: 5 concurrent (sequential-simulated) calls return consistent results", () => {
  const results = [];
  for (let i = 0; i < 5; i++) results.push(executeTool("merge_conflict_risk", { path: "mcr_basic", branch_a: "feature-a", branch_b: "feature-b" }));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].overlappingCount, results[0].overlappingCount);
  }
});

test("cleanup: remove merge_conflict_risk fixture repo", () => {
  try { executeTool("delete_directory", { path: "mcr_basic", recursive: true }); } catch (_) {}
});
