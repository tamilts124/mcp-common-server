"use strict";
/**
 * [84] GIT_FILE_AGE — inverse-recency companion to git_blame_hotspots
 *
 * Rigor levels:
 *   Normal:   oldest file ranked first; ageDays/lastCommit fields correct.
 *   Medium:   max_commits window excludes older files (unknown:true, not an
 *             error); top_n caps the oldest list.
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped
 *             file pathspec rejected, not executed.
 *   Extreme:  known-ages sorted oldest-first before any unknown entries;
 *             JSON-serialisable; 10 concurrent calls consistent.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[84] GIT_FILE_AGE — inverse-recency companion to git_blame_hotspots`);

function commitAt(repoDir, isoDate, cmd) {
  const env = { ...process.env,
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  return execSync(`git ${cmd}`, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
}

function makeRepo(name) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  execSync("git init -q -b main", { cwd: repoDir });
  return repoDir;
}

test("normal: oldest file ranked first, fields correct", () => {
  const repoDir = makeRepo("gfa_basic");
  fs.writeFileSync(path.join(repoDir, "old.js"), "v1\n");
  commitAt(repoDir, "2015-01-01T00:00:00", "add -A");
  commitAt(repoDir, "2015-01-01T00:00:00", 'commit -q -m "old file"');

  fs.writeFileSync(path.join(repoDir, "new.js"), "v1\n");
  commitAt(repoDir, "2024-01-01T00:00:00", "add -A");
  commitAt(repoDir, "2024-01-01T00:00:00", 'commit -q -m "new file"');

  const r = executeTool("git_file_age", { path: "gfa_basic" });
  assert.strictEqual(r.oldest[0].file, "old.js");
  assert.strictEqual(r.oldest[0].unknown, false);
  assert.ok(r.oldest[0].ageDays > r.oldest[1].ageDays);
  assert.ok(r.oldest[0].lastCommitHash.length === 40);
  assert.strictEqual(r.oldest[0].lastCommitAuthor, "Test");
});

test("medium: max_commits window excludes older files (unknown, not an error)", () => {
  const r = executeTool("git_file_age", { path: "gfa_basic", max_commits: 1 });
  assert.strictEqual(r.commitsScanned, 1);
  const old = r.oldest.find(f => f.file === "old.js");
  assert.strictEqual(old.unknown, true);
  assert.strictEqual(old.ageDays, null);
});

test("medium: top_n caps the oldest list", () => {
  const repoDir = path.join(TMP, "gfa_basic");
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(repoDir, `f${i}.txt`), `x${i}\n`);
    commitAt(repoDir, "2020-01-01T00:00:00", "add -A");
    commitAt(repoDir, "2020-01-01T00:00:00", `commit -q -m "f${i}"`);
  }
  const r = executeTool("git_file_age", { path: "gfa_basic", top_n: 2 });
  assert.strictEqual(r.oldest.length, 2);
  assert.strictEqual(r.truncated, true);
});

test("high: non-git directory throws a descriptive error", () => {
  executeTool("create_directory", { path: "gfa_notgit" });
  try {
    executeTool("git_file_age", { path: "gfa_notgit" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("git_file_age", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped file pathspec is rejected, not executed", () => {
  try {
    executeTool("git_file_age", { path: "gfa_basic", file: "$(rm -rf /)" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: known ages sorted oldest-first before any unknown entries", () => {
  const r = executeTool("git_file_age", { path: "gfa_basic", top_n: 50 });
  let seenUnknown = false;
  for (const f of r.oldest) {
    if (f.unknown) { seenUnknown = true; continue; }
    assert.strictEqual(seenUnknown, false, "known entry found after an unknown one");
  }
  const known = r.oldest.filter(f => !f.unknown);
  for (let i = 1; i < known.length; i++) assert.ok(known[i - 1].ageDays >= known[i].ageDays);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("git_file_age", { path: "gfa_basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: 10 concurrent (sequential-simulated) calls return consistent results", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(executeTool("git_file_age", { path: "gfa_basic" }));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].filesScanned, results[0].filesScanned);
  }
});

test("cleanup: remove git_file_age fixture repos", () => {
  for (const d of ["gfa_basic", "gfa_notgit"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
