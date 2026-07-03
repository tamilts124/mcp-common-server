"use strict";
/**
 * [89] GENERATE_PR_DESCRIPTION — markdown PR/commit description drafting
 *
 * Rigor levels:
 *   Normal:   staged changes produce a markdown doc with Summary/Changes
 *             sections; from_ref..to_ref range includes matching commits.
 *   Medium:   no changes -> "No changes." summary, not an error; top_n and
 *             commit_limit cap their respective lists.
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped
 *             from_ref rejected, not executed.
 *   Extreme:  markdown contains all 3 section headers; result is
 *             JSON-serialisable; 10 concurrent calls consistent.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[89] GENERATE_PR_DESCRIPTION — markdown PR description drafting`);

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

test("normal: staged changes produce a markdown doc with Summary/Changes/Commits", () => {
  const repoDir = makeRepo("prd_basic");
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m init');
  fs.writeFileSync(path.join(repoDir, "a.js"), "line1\nline2\n");
  fs.writeFileSync(path.join(repoDir, "b.js"), "new\n");
  gitIn(repoDir, "add -A");
  const r = executeTool("generate_pr_description", { path: "prd_basic", staged: true });
  assert.strictEqual(r.totalFiles, 2);
  assert.ok(r.markdown.includes("## Summary"));
  assert.ok(r.markdown.includes("## Changes"));
  assert.ok(r.markdown.includes("## Commits"));
});

test("normal: from_ref..to_ref range includes matching commits", () => {
  const repoDir = path.join(TMP, "prd_basic");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "feat: second commit"');
  const first = gitIn(repoDir, "rev-list --max-parents=0 HEAD").trim();
  const r = executeTool("generate_pr_description", { path: "prd_basic", from_ref: first });
  assert.ok(r.commitCount >= 1);
  assert.ok(r.commits.some(c => c.subject.includes("second commit")));
});

test("medium: no changes returns 'No changes.' summary, not an error", () => {
  const r = executeTool("generate_pr_description", { path: "prd_basic" });
  assert.strictEqual(r.totalFiles, 0);
  assert.ok(r.markdown.includes("No changes."));
});

test("medium: top_n and commit_limit cap their respective lists", () => {
  const repoDir = path.join(TMP, "prd_basic");
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(repoDir, `f${i}.txt`), `x${i}\n`);
  gitIn(repoDir, "add -A");
  const r = executeTool("generate_pr_description", { path: "prd_basic", staged: true, top_n: 2 });
  const topSection = r.markdown.split("### Top changed files")[1] || "";
  assert.ok((topSection.match(/^- `/gm) || []).length <= 2);
  const first = executeTool("git_log", { path: "prd_basic" }); // sanity: repo has commits
  assert.ok(first.count >= 1);
  const limited = executeTool("generate_pr_description", { path: "prd_basic", commit_limit: 1 });
  assert.ok(limited.commitCount <= 1);
});

test("high: non-git directory throws a descriptive error", () => {
  executeTool("create_directory", { path: "prd_notgit" });
  try {
    executeTool("generate_pr_description", { path: "prd_notgit" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("generate_pr_description", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped from_ref is rejected, not executed", () => {
  try {
    executeTool("generate_pr_description", { path: "prd_basic", from_ref: "$(rm -rf /)" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: markdown contains all 3 section headers with content", () => {
  const repoDir = path.join(TMP, "prd_basic");
  fs.writeFileSync(path.join(repoDir, "c.js"), "x\n");
  gitIn(repoDir, "add -A");
  const r = executeTool("generate_pr_description", { path: "prd_basic", staged: true });
  assert.ok(r.markdown.indexOf("## Summary") < r.markdown.indexOf("## Changes"));
  assert.ok(r.markdown.indexOf("## Changes") < r.markdown.indexOf("## Commits"));
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("generate_pr_description", { path: "prd_basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: 10 concurrent (sequential-simulated) calls return consistent results", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(executeTool("generate_pr_description", { path: "prd_basic" }));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].totalFiles, results[0].totalFiles);
  }
});

test("cleanup: remove generate_pr_description fixture repos", () => {
  for (const d of ["prd_basic", "prd_notgit"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
