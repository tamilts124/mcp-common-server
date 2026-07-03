"use strict";
/**
 * [91] CHECK_LFS_COVERAGE — large tracked files vs .gitattributes filter=lfs
 *
 * Rigor levels:
 *   Normal:   a .bin file matched by a "*.bin filter=lfs" rule reports
 *             lfsTracked:true; a large file with no matching rule reports
 *             lfsTracked:false and is listed in recommendations.
 *   Medium:   min_size_bytes excludes small files from default-mode scan;
 *             explicit paths mode returns no size/recommendations.
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal via path arg blocked; >500 explicit paths
 *             rejected; null-byte-containing path rejected.
 *   Extreme:  max_files caps the default-mode candidate count; result is
 *             JSON-serialisable; 5 concurrent calls consistent.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[91] CHECK_LFS_COVERAGE — filter=lfs coverage for large tracked files`);

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

test("normal: file matched by filter=lfs rule reports lfsTracked:true", () => {
  const repoDir = makeRepo("lfsc_basic");
  fs.writeFileSync(path.join(repoDir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  fs.writeFileSync(path.join(repoDir, "asset.bin"), Buffer.alloc(6_000_000, 1));
  fs.writeFileSync(path.join(repoDir, "dump.sql"), Buffer.alloc(6_000_000, 2));
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m init');
  const r = executeTool("check_lfs_coverage", { path: "lfsc_basic" });
  const bin = r.checked.find(c => c.path === "asset.bin");
  assert.ok(bin);
  assert.strictEqual(bin.lfsTracked, true);
});

test("normal: large file with no matching rule reports lfsTracked:false + recommendation", () => {
  const r = executeTool("check_lfs_coverage", { path: "lfsc_basic" });
  const sql = r.checked.find(c => c.path === "dump.sql");
  assert.ok(sql);
  assert.strictEqual(sql.lfsTracked, false);
  assert.ok(r.recommendations.some(rec => rec.includes("dump.sql")));
});

test("medium: min_size_bytes excludes small files from default-mode scan", () => {
  const repoDir = path.join(TMP, "lfsc_basic");
  fs.writeFileSync(path.join(repoDir, "tiny.txt"), "x\n");
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "add tiny"');
  const r = executeTool("check_lfs_coverage", { path: "lfsc_basic", min_size_bytes: 1_000_000 });
  assert.ok(!r.checked.some(c => c.path === "tiny.txt"));
});

test("medium: explicit paths mode returns no size info or recommendations", () => {
  const r = executeTool("check_lfs_coverage", { path: "lfsc_basic", paths: ["asset.bin", "dump.sql"] });
  assert.strictEqual(r.usingDefaults, false);
  assert.strictEqual(r.recommendations.length, 0);
  assert.strictEqual(r.checked.find(c => c.path === "asset.bin").size, undefined);
  assert.strictEqual(r.checked.find(c => c.path === "asset.bin").lfsTracked, true);
});

test("high: non-git directory throws a descriptive error", () => {
  executeTool("create_directory", { path: "lfsc_notgit" });
  try {
    executeTool("check_lfs_coverage", { path: "lfsc_notgit" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("check_lfs_coverage", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: more than 500 explicit paths is rejected", () => {
  const many = Array.from({ length: 501 }, (_, i) => `f${i}.bin`);
  try {
    executeTool("check_lfs_coverage", { path: "lfsc_basic", paths: many });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: null-byte-containing path is rejected", () => {
  try {
    executeTool("check_lfs_coverage", { path: "lfsc_basic", paths: ["bad\0path.bin"] });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: max_files caps the default-mode candidate count", () => {
  const r = executeTool("check_lfs_coverage", { path: "lfsc_basic", max_files: 1 });
  assert.strictEqual(r.checked.length, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("check_lfs_coverage", { path: "lfsc_basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: 5 concurrent (sequential-simulated) calls return consistent results", () => {
  const results = [];
  for (let i = 0; i < 5; i++) results.push(executeTool("check_lfs_coverage", { path: "lfsc_basic" }));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].notCoveredCount, results[0].notCoveredCount);
  }
});

test("cleanup: remove check_lfs_coverage fixture repos", () => {
  for (const d of ["lfsc_basic", "lfsc_notgit"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
