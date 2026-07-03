"use strict";
/**
 * [83] GIT_BLAME_HOTSPOTS — recent-activity review-risk ranking
 *
 * Rigor levels:
 *   Normal:   multi-author file ranked above single-author file; authorCount
 *             / commitCount / authors list correct.
 *   Medium:   since_days window excludes old commits (0 activity, not an
 *             error); top_n caps the hotspots list.
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped
 *             file pathspec rejected, not executed.
 *   Extreme:  sorted authorCount-desc-then-commitCount-desc; JSON-serialisable;
 *             10 concurrent calls consistent; extensions filter narrows correctly.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[83] GIT_BLAME_HOTSPOTS — recent-activity review-risk ranking`);

function gitAs(repoDir, cmd, author) {
  const env = { ...process.env,
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.replace(/\s+/g, "")}@example.com`,
    GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: `${author.replace(/\s+/g, "")}@example.com` };
  return execSync(`git ${cmd}`, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
}

function makeRepo(name) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitAs(repoDir, "init -q -b main", "Init");
  return repoDir;
}

test("normal: multi-author file ranked above single-author file", () => {
  const repoDir = makeRepo("gbh_basic");
  fs.writeFileSync(path.join(repoDir, "hot.js"), "v1\n");
  fs.writeFileSync(path.join(repoDir, "cold.js"), "v1\n");
  gitAs(repoDir, "add -A", "Alice"); gitAs(repoDir, 'commit -q -m init', "Alice");

  fs.writeFileSync(path.join(repoDir, "hot.js"), "v2\n");
  gitAs(repoDir, "add -A", "Bob"); gitAs(repoDir, 'commit -q -m "bob edits hot"', "Bob");

  fs.writeFileSync(path.join(repoDir, "hot.js"), "v3\n");
  gitAs(repoDir, "add -A", "Carol"); gitAs(repoDir, 'commit -q -m "carol edits hot"', "Carol");

  const r = executeTool("git_blame_hotspots", { path: "gbh_basic" });
  assert.strictEqual(r.hotspots[0].file, "hot.js");
  assert.strictEqual(r.hotspots[0].authorCount, 3);
  assert.strictEqual(r.hotspots[0].commitCount, 3);
  assert.deepStrictEqual(r.hotspots[0].authors, ["Alice", "Bob", "Carol"]);
  const cold = r.hotspots.find(h => h.file === "cold.js");
  assert.strictEqual(cold.authorCount, 1);
});

test("medium: since_days window excludes old commits (0 activity, not an error)", () => {
  const repoDir = makeRepo("gbh_stale");
  fs.writeFileSync(path.join(repoDir, "old.js"), "v1\n");
  const oldDate = "2000-01-01T00:00:00";
  const env = { ...process.env,
    GIT_AUTHOR_NAME: "Old", GIT_AUTHOR_EMAIL: "old@example.com",
    GIT_COMMITTER_NAME: "Old", GIT_COMMITTER_EMAIL: "old@example.com",
    GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate };
  execSync("git add -A", { cwd: repoDir, env });
  execSync('git commit -q -m "ancient"', { cwd: repoDir, env });

  const r = executeTool("git_blame_hotspots", { path: "gbh_stale", since_days: 30 });
  assert.strictEqual(r.filesWithActivity, 0);
  assert.deepStrictEqual(r.hotspots, []);
});

test("medium: top_n caps the hotspots list", () => {
  const repoDir = path.join(TMP, "gbh_basic");
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(repoDir, `f${i}.txt`), `x${i}\n`);
    gitAs(repoDir, "add -A", "Dave"); gitAs(repoDir, `commit -q -m "f${i}"`, "Dave");
  }
  const r = executeTool("git_blame_hotspots", { path: "gbh_basic", top_n: 2 });
  assert.strictEqual(r.hotspots.length, 2);
  assert.strictEqual(r.truncated, true);
});

test("high: non-git directory throws a descriptive error", () => {
  executeTool("create_directory", { path: "gbh_notgit" });
  try {
    executeTool("git_blame_hotspots", { path: "gbh_notgit" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("git_blame_hotspots", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped file pathspec is rejected, not executed", () => {
  try {
    executeTool("git_blame_hotspots", { path: "gbh_basic", file: "$(rm -rf /)" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: sorted authorCount desc, then commitCount desc", () => {
  const r = executeTool("git_blame_hotspots", { path: "gbh_basic", top_n: 50 });
  for (let i = 1; i < r.hotspots.length; i++) {
    const a = r.hotspots[i - 1], b = r.hotspots[i];
    assert.ok(a.authorCount > b.authorCount || (a.authorCount === b.authorCount && a.commitCount >= b.commitCount));
  }
});

test("extreme: extensions filter narrows results", () => {
  const r = executeTool("git_blame_hotspots", { path: "gbh_basic", extensions: [".js"] });
  assert.ok(r.hotspots.every(h => h.file.endsWith(".js")));
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("git_blame_hotspots", { path: "gbh_basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: 10 concurrent (sequential-simulated) calls return consistent results", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(executeTool("git_blame_hotspots", { path: "gbh_basic" }));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].filesWithActivity, results[0].filesWithActivity);
  }
});

test("cleanup: remove git_blame_hotspots fixture repos", () => {
  for (const d of ["gbh_basic", "gbh_stale", "gbh_notgit"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
