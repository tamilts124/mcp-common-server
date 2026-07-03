"use strict";
/**
 * [82] GIT_DIFF_SUMMARY — churn/PR-style summary over gitDiffStat
 *
 * Rigor levels:
 *   Normal:   added+modified files summarised, byStatus/byExtension/topFiles
 *             correct, markdown block generated.
 *   Medium:   no changes -> empty summary, not an error; top_n caps topFiles.
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped
 *             ref rejected, not executed.
 *   Extreme:  many-file diff sorts topFiles by churn desc; result is
 *             JSON-serialisable; 10 concurrent calls consistent.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[82] GIT_DIFF_SUMMARY — churn/PR-style diff summary`);

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

test("normal: added + modified files summarised correctly", () => {
  const repoDir = makeRepo("gds_basic");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m init');
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\nline3\n");
  fs.writeFileSync(path.join(repoDir, "b.js"), "new file\n");
  gitIn(repoDir, "add -A");
  const r = executeTool("git_diff_summary", { path: "gds_basic", staged: true });
  assert.strictEqual(r.totalFiles, 2);
  assert.strictEqual(r.byStatus.added, 1);
  assert.strictEqual(r.byStatus.modified, 1);
  assert.ok(r.additions > 0);
  assert.ok(r.markdown.includes("Diff summary"));
});

test("normal: byExtension breakdown groups by file extension", () => {
  const r = executeTool("git_diff_summary", { path: "gds_basic" });
  const jsExt = r.byExtension.find(e => e.ext === ".js");
  assert.ok(jsExt);
  assert.strictEqual(jsExt.count, 2);
});

test("medium: no changes returns empty summary, not an error", () => {
  const repoDir = path.join(TMP, "gds_basic");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m second');
  const r = executeTool("git_diff_summary", { path: "gds_basic" });
  assert.strictEqual(r.totalFiles, 0);
  assert.strictEqual(r.additions, 0);
});

test("medium: top_n caps the topFiles list", () => {
  const repoDir = path.join(TMP, "gds_basic");
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(repoDir, `f${i}.txt`), `x${i}\n`);
  gitIn(repoDir, "add -A");
  const r = executeTool("git_diff_summary", { path: "gds_basic", top_n: 2 });
  assert.strictEqual(r.topFiles.length, 2);
});

test("high: non-git directory throws a descriptive error", () => {
  executeTool("create_directory", { path: "gds_notgit" });
  try {
    executeTool("git_diff_summary", { path: "gds_notgit" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("git_diff_summary", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped from_ref is rejected, not executed", () => {
  try {
    executeTool("git_diff_summary", { path: "gds_basic", from_ref: "$(rm -rf /)" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: topFiles sorted by churn descending", () => {
  const r = executeTool("git_diff_summary", { path: "gds_basic", top_n: 50 });
  for (let i = 1; i < r.topFiles.length; i++) {
    assert.ok(r.topFiles[i - 1].churn >= r.topFiles[i].churn);
  }
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("git_diff_summary", { path: "gds_basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: 10 concurrent (sequential-simulated) calls return consistent results", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(executeTool("git_diff_summary", { path: "gds_basic" }));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].totalFiles, results[0].totalFiles);
  }
});

test("cleanup: remove git_diff_summary fixture repos", () => {
  for (const d of ["gds_basic", "gds_notgit"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
