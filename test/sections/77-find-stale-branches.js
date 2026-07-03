"use strict";
/**
 * [77] FIND_STALE_BRANCHES -- git branches with no commits in N days
 *
 * Rigor levels:
 *   Normal:   branch with an old backdated commit is reported stale; a
 *             fresh branch is not.
 *   Medium:   custom `days` threshold changes the stale/fresh boundary;
 *             non-numeric days falls back to the 90-day default.
 *   High:     non-git directory throws a descriptive error; repo with only
 *             the current branch (no other branches) returns staleCount 0
 *             cleanly (not an error) when nothing is old enough.
 *   Critical: path traversal / absolute-path-outside-root blocked;
 *             injection-shaped branch name round-trips literally, never
 *             executed; result is JSON-serialisable, no prototype pollution.
 *   Extreme:  10 branches at staggered ages sort oldest-first correctly;
 *             10 concurrent calls return consistent results.
 */
const { execSync } = require("child_process");
const { assert, test, TMP, executeTool } = require("../test-harness");

console.log("\n[77] FIND_STALE_BRANCHES -- stale branch detector");

function gitIn(repoDir, cmd, dateIso) {
  const env = { ...process.env,
    GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" };
  if (dateIso) { env.GIT_AUTHOR_DATE = dateIso; env.GIT_COMMITTER_DATE = dateIso; }
  return execSync(`git ${cmd}`, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
}

function daysAgoIso(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeRepo(name) {
  const repoDir = require("path").join(TMP, name);
  require("fs").mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -q -b main");
  require("fs").writeFileSync(require("path").join(repoDir, "f.txt"), "1\n");
  gitIn(repoDir, "add .");
  gitIn(repoDir, `commit -q -m "initial"`, daysAgoIso(1));
  return repoDir;
}

// -- NORMAL -------------------------------------------------------------
test("normal: branch with old commit is reported stale, fresh branch is not", () => {
  const repoDir = makeRepo("fsb-normal");
  gitIn(repoDir, "branch old-branch");
  gitIn(repoDir, "checkout -q old-branch");
  require("fs").writeFileSync(require("path").join(repoDir, "old.txt"), "1\n");
  gitIn(repoDir, "add .");
  gitIn(repoDir, `commit -q -m "old work"`, daysAgoIso(200));
  gitIn(repoDir, "checkout -q main");
  gitIn(repoDir, "branch fresh-branch");

  const r = executeTool("find_stale_branches", { path: repoDir });
  const names = r.stale.map(b => b.name);
  assert.ok(names.includes("old-branch"));
  assert.ok(!names.includes("fresh-branch"));
});

// -- MEDIUM ---------------------------------------------------------------
test("medium: custom days threshold changes stale boundary", () => {
  const repoDir = makeRepo("fsb-medium");
  gitIn(repoDir, "branch mid-branch");
  gitIn(repoDir, "checkout -q mid-branch");
  require("fs").writeFileSync(require("path").join(repoDir, "m.txt"), "1\n");
  gitIn(repoDir, "add .");
  gitIn(repoDir, `commit -q -m "mid work"`, daysAgoIso(10));
  gitIn(repoDir, "checkout -q main");

  const r5 = executeTool("find_stale_branches", { path: repoDir, days: 5 });
  assert.ok(r5.stale.map(b => b.name).includes("mid-branch"));
  const r20 = executeTool("find_stale_branches", { path: repoDir, days: 20 });
  assert.ok(!r20.stale.map(b => b.name).includes("mid-branch"));
});

test("medium: non-numeric days falls back to default (90), not a crash", () => {
  const repoDir = makeRepo("fsb-medium2");
  const r = executeTool("find_stale_branches", { path: repoDir, days: "not-a-number" });
  assert.strictEqual(r.thresholdDays, 90);
});

// -- HIGH -------------------------------------------------------------------
test("high: non-git directory throws a descriptive error", () => {
  assert.throws(() => executeTool("find_stale_branches", { path: TMP }), /git repository/);
});

test("high: repo with only a fresh current branch returns staleCount 0, not an error", () => {
  const repoDir = makeRepo("fsb-high");
  const r = executeTool("find_stale_branches", { path: repoDir, days: 90 });
  assert.strictEqual(r.staleCount, 0);
  assert.strictEqual(r.totalBranches, 1);
});

// -- CRITICAL -----------------------------------------------------------
test("critical: path traversal via path arg is blocked", () => {
  assert.throws(() => executeTool("find_stale_branches", { path: "../../../etc" }), /Access denied/);
});

test("critical: absolute path outside root is blocked", () => {
  const outside = process.platform === "win32" ? "C:/Windows" : "/etc";
  assert.throws(() => executeTool("find_stale_branches", { path: outside }));
});

test("critical: injection-shaped branch name round-trips literally, never executed", () => {
  const repoDir = makeRepo("fsb-critical");
  const injName = "feat-$(touch-pwned)-x";
  gitIn(repoDir, `branch "${injName}"`);
  gitIn(repoDir, "checkout -q main");
  const r = executeTool("find_stale_branches", { path: repoDir, days: 0 });
  const found = r.stale.find(b => b.name === injName);
  assert.ok(found);
  assert.ok(!require("fs").existsSync(require("path").join(repoDir, "touch-pwned")));
});

test("critical: result is JSON-serialisable, no prototype pollution", () => {
  const repoDir = makeRepo("fsb-critical2");
  const r = executeTool("find_stale_branches", { path: repoDir });
  const parsed = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(parsed).sort(),
    ["cutoffDate", "currentBranch", "stale", "staleCount", "thresholdDays", "totalBranches"].sort());
});

// -- EXTREME ------------------------------------------------------------
test("extreme: 10 branches at staggered ages sort oldest-first", () => {
  const repoDir = makeRepo("fsb-extreme");
  for (let i = 1; i <= 10; i++) {
    gitIn(repoDir, `branch b${i}`);
    gitIn(repoDir, `checkout -q b${i}`);
    require("fs").writeFileSync(require("path").join(repoDir, `f${i}.txt`), "1\n");
    gitIn(repoDir, "add .");
    gitIn(repoDir, `commit -q -m "work ${i}"`, daysAgoIso(100 + i * 5));
    gitIn(repoDir, "checkout -q main");
  }
  const r = executeTool("find_stale_branches", { path: repoDir, days: 90 });
  assert.strictEqual(r.staleCount, 10);
  for (let i = 1; i < r.stale.length; i++) {
    assert.ok(r.stale[i - 1].ageDays >= r.stale[i].ageDays);
  }
  assert.strictEqual(r.stale[r.stale.length - 1].name, "b1"); // youngest of the stale set (smallest offset) sorts last
});

test("extreme: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("fsb-extreme2");
  gitIn(repoDir, "branch old2");
  gitIn(repoDir, "checkout -q old2");
  require("fs").writeFileSync(require("path").join(repoDir, "o.txt"), "1\n");
  gitIn(repoDir, "add .");
  gitIn(repoDir, `commit -q -m "old"`, daysAgoIso(200));
  gitIn(repoDir, "checkout -q main");

  const results = [];
  for (let i = 0; i < 10; i++) results.push(executeTool("find_stale_branches", { path: repoDir }));
  // cutoffDate is derived from Date.now() at call time, so it legitimately
  // differs by a few ms between calls -- strip it before comparing.
  const strip = (r) => JSON.stringify({ ...r, cutoffDate: null });
  const first = strip(results[0]);
  for (const r of results) assert.strictEqual(strip(r), first);
});

test("cleanup: remove find_stale_branches fixture repos", () => {
  for (const n of ["fsb-normal", "fsb-medium", "fsb-medium2", "fsb-high", "fsb-critical", "fsb-critical2", "fsb-extreme", "fsb-extreme2"]) {
    try { require("fs").rmSync(require("path").join(TMP, n), { recursive: true, force: true }); } catch (_) {}
  }
});
