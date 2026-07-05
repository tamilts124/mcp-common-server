"use strict";
/**
 * [125] FIND_STALE_TODOS — TODO/FIXME markers flagged by git-blame age
 *
 * Rigor levels:
 *   Normal:   old-commit marker flagged stale; recent-commit marker stays fresh.
 *   Medium:   missing path throws; non-git dir throws; threshold_days type mismatch throws.
 *   High:     custom threshold_days changes stale/fresh boundary; max_markers cap.
 *   Critical: path traversal blocked; shell-injection-shaped marker text inert.
 *   Extreme:  uncommitted line handled gracefully (unresolved); stale sorted oldest-first;
 *             JSON-serialisable.
 */
const { assert, test, executeTool, TMP } = require("../test-harness");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

console.log(`\n[125] FIND_STALE_TODOS — TODO marker staleness by git blame age`);

function makeRepo(dirAbs) {
  fs.mkdirSync(dirAbs, { recursive: true });
  execSync("git init -q", { cwd: dirAbs });
  execSync('git config user.email "a@example.com"', { cwd: dirAbs });
  execSync('git config user.name "Alice"', { cwd: dirAbs });
}

function commitAllAt(dirAbs, msg, isoDate) {
  execSync("git add -A", { cwd: dirAbs });
  execSync(`git commit -q -m "${msg}"`, {
    cwd: dirAbs,
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
}

const OLD_DATE = "2020-01-01T00:00:00";
function recentDate() { return new Date().toISOString(); }

test("normal: marker committed long ago is flagged stale", () => {
  const rel = "fst_old";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: "// TODO ancient\n" });
  commitAllAt(repoAbs, "init", OLD_DATE);
  const r = executeTool("find_stale_todos", { path: rel });
  assert.strictEqual(r.totalMarkers, 1);
  assert.strictEqual(r.staleCount, 1);
  assert.strictEqual(r.freshCount, 0);
  assert.strictEqual(r.stale[0].marker, "TODO");
  assert.ok(r.stale[0].ageDays > 90);
});

test("normal: recently committed marker stays fresh", () => {
  const rel = "fst_fresh";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: "// FIXME brand new\n" });
  commitAllAt(repoAbs, "init", recentDate());
  const r = executeTool("find_stale_todos", { path: rel });
  assert.strictEqual(r.totalMarkers, 1);
  assert.strictEqual(r.staleCount, 0);
  assert.strictEqual(r.freshCount, 1);
});

test("medium: missing path throws", () => {
  try { executeTool("find_stale_todos", {}); assert.fail("should throw"); }
  catch (e) { assert.ok(e); }
});

test("medium: non-git directory throws", () => {
  executeTool("create_directory", { path: "fst_notgit" });
  executeTool("write_file", { path: "fst_notgit/a.js", content: "// TODO x\n" });
  try { executeTool("find_stale_todos", { path: "fst_notgit" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e); }
});

test("medium: threshold_days type mismatch throws", () => {
  try { executeTool("find_stale_todos", { path: "fst_old", threshold_days: "90" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e); }
});

test("high: custom threshold_days moves the stale/fresh boundary", () => {
  const rel = "fst_boundary";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  const d = new Date();
  d.setDate(d.getDate() - 10);
  executeTool("write_file", { path: `${rel}/a.js`, content: "// TODO ten days\n" });
  commitAllAt(repoAbs, "init", d.toISOString());
  const rDefault = executeTool("find_stale_todos", { path: rel }); // 90-day default: fresh
  assert.strictEqual(rDefault.staleCount, 0);
  const rTight = executeTool("find_stale_todos", { path: rel, threshold_days: 5 }); // 5-day: stale
  assert.strictEqual(rTight.staleCount, 1);
});

test("high: max_markers caps processed markers", () => {
  const rel = "fst_cap";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  let content = "";
  for (let i = 0; i < 5; i++) content += `// TODO item ${i}\n`;
  executeTool("write_file", { path: `${rel}/a.js`, content });
  commitAllAt(repoAbs, "many", OLD_DATE);
  const r = executeTool("find_stale_todos", { path: rel, max_markers: 2 });
  assert.strictEqual(r.totalMarkers, 2);
  assert.strictEqual(r.truncated, true);
});

test("critical: path traversal blocked", () => {
  try { executeTool("find_stale_todos", { path: "../../../etc/passwd" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped marker text handled as inert literal", () => {
  const rel = "fst_inject";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: '// TODO $(rm -rf /) `whoami`\n' });
  commitAllAt(repoAbs, "c", OLD_DATE);
  const r = executeTool("find_stale_todos", { path: rel });
  assert.strictEqual(r.staleCount, 1);
  assert.ok(r.stale[0].text.includes("$(rm -rf /)"));
});

test("extreme: uncommitted line handled gracefully (unresolved, not thrown)", () => {
  const rel = "fst_uncommitted";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: "// TODO committed\n" });
  commitAllAt(repoAbs, "c", OLD_DATE);
  executeTool("append_file", { path: `${rel}/a.js`, content: "// TODO uncommitted\n" });
  const r = executeTool("find_stale_todos", { path: rel });
  assert.strictEqual(r.totalMarkers, 2);
  assert.ok(r.staleCount + r.freshCount + r.unresolvedCount === 2);
});

test("extreme: stale list sorted oldest-first by ageDays", () => {
  const rel = "fst_sort";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: "// TODO a\n" });
  commitAllAt(repoAbs, "c1", "2019-01-01T00:00:00");
  executeTool("write_file", { path: `${rel}/b.js`, content: "// TODO b\n" });
  commitAllAt(repoAbs, "c2", "2021-01-01T00:00:00");
  const r = executeTool("find_stale_todos", { path: rel });
  assert.strictEqual(r.staleCount, 2);
  assert.ok(r.stale[0].ageDays >= r.stale[1].ageDays);
});

test("extreme: result is JSON-serialisable", () => {
  const r = executeTool("find_stale_todos", { path: "fst_old" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_stale_todos fixtures", () => {
  for (const d of ["fst_old", "fst_fresh", "fst_notgit", "fst_boundary", "fst_cap", "fst_inject", "fst_uncommitted", "fst_sort"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
