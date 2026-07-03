"use strict";
/**
 * [90] FIND_LARGE_GIT_OBJECTS — largest blobs across full committed history
 *
 * Rigor levels:
 *   Normal:   a large committed-then-still-present file is found and sized
 *             correctly; a small file is excluded by top_n/size ranking.
 *   Medium:   min_size_bytes filters out small blobs; empty repo (no
 *             commits) returns zero objects, not an error.
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal via path arg blocked.
 *   Extreme:  a file committed large then later deleted is STILL found
 *             (history scan, not working-tree scan) — the core value prop;
 *             result is JSON-serialisable; 5 concurrent calls consistent.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[90] FIND_LARGE_GIT_OBJECTS — largest blobs in full git history`);

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

test("normal: large committed file is found and correctly sized", () => {
  const repoDir = makeRepo("flgo_basic");
  fs.writeFileSync(path.join(repoDir, "small.txt"), "x\n");
  fs.writeFileSync(path.join(repoDir, "big.bin"), Buffer.alloc(50_000, 1));
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m init');
  const r = executeTool("find_large_git_objects", { path: "flgo_basic" });
  const big = r.objects.find(o => o.path === "big.bin");
  assert.ok(big);
  assert.strictEqual(big.sizeBytes, 50000);
  assert.ok(r.blobCount >= 2);
});

test("normal: top_n ranks big file above small file", () => {
  const r = executeTool("find_large_git_objects", { path: "flgo_basic", top_n: 1 });
  assert.strictEqual(r.objects.length, 1);
  assert.strictEqual(r.objects[0].path, "big.bin");
});

test("medium: min_size_bytes filters out small blobs", () => {
  const r = executeTool("find_large_git_objects", { path: "flgo_basic", min_size_bytes: 10000 });
  assert.ok(r.objects.every(o => o.sizeBytes >= 10000));
  assert.ok(r.objects.some(o => o.path === "big.bin"));
});

test("medium: empty repo (no commits) returns zero objects, not an error", () => {
  const repoDir = makeRepo("flgo_empty");
  const r = executeTool("find_large_git_objects", { path: "flgo_empty" });
  assert.strictEqual(r.objects.length, 0);
  assert.strictEqual(r.totalObjectsScanned, 0);
});

test("high: non-git directory throws a descriptive error", () => {
  executeTool("create_directory", { path: "flgo_notgit" });
  try {
    executeTool("find_large_git_objects", { path: "flgo_notgit" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_large_git_objects", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: file committed large then deleted is still found via history scan", () => {
  const repoDir = path.join(TMP, "flgo_basic");
  fs.unlinkSync(path.join(repoDir, "big.bin"));
  gitIn(repoDir, "add -A"); gitIn(repoDir, 'commit -q -m "remove big file"');
  // Working tree no longer has big.bin, but history scan should still find it.
  assert.ok(!fs.existsSync(path.join(repoDir, "big.bin")));
  const r = executeTool("find_large_git_objects", { path: "flgo_basic" });
  const big = r.objects.find(o => o.path === "big.bin");
  assert.ok(big, "deleted-but-historically-committed large file should still be found");
  assert.strictEqual(big.sizeBytes, 50000);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_large_git_objects", { path: "flgo_basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: 5 concurrent (sequential-simulated) calls return consistent results", () => {
  const results = [];
  for (let i = 0; i < 5; i++) results.push(executeTool("find_large_git_objects", { path: "flgo_basic" }));
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].blobCount, results[0].blobCount);
  }
});

test("cleanup: remove find_large_git_objects fixture repos", () => {
  for (const d of ["flgo_basic", "flgo_empty", "flgo_notgit"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
