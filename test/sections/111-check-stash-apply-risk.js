"use strict";
/**
 * [111] CHECK_STASH_APPLY_RISK — check_stash_apply_risk tool
 *
 * Rigor levels covered:
 *   Normal:   a stash on an unmodified working tree applies clean; a stash
 *             that touches the same lines a later commit also touched
 *             reports a conflict with non-empty conflictOutput.
 *   Medium:   missing stash defaults to 'stash@{0}'; malformed stash ref
 *             format rejected; nonexistent stash index rejected.
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal / absolute-path-outside-root blocked; shell-
 *             injection-shaped stash ref rejected, never executed; result
 *             is JSON-serialisable; no unexpected top-level keys.
 *   Extreme:  10 concurrent calls consistent; registered in execute_pipeline
 *             op enum; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[111] CHECK_STASH_APPLY_RISK — check_stash_apply_risk tool`);

function gitIn(repoDir, cmd) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

function makeRepo(name) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  gitIn(repoDir, "config user.email test@example.com");
  gitIn(repoDir, 'config user.name "Test User"');
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nline2\nline3\n", "utf8");
  gitIn(repoDir, "add a.txt");
  gitIn(repoDir, 'commit -m "initial commit"');
  return repoDir;
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("check_stash_apply_risk: returns result object without throwing", () => {
  const repoDir = makeRepo("sar-basic");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nCHANGED\nline3\n", "utf8");
  gitIn(repoDir, "stash push");
  const r = executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object");
});

test("check_stash_apply_risk: stash applies clean on an untouched working tree", () => {
  const repoDir = makeRepo("sar-clean");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nCHANGED\nline3\n", "utf8");
  gitIn(repoDir, "stash push");
  const r = executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.applyClean, true);
  assert.strictEqual(r.conflictOutput, null);
});

test("check_stash_apply_risk: overlapping edits on the same line report a conflict", () => {
  const repoDir = makeRepo("sar-conflict");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nSTASHED-CHANGE\nline3\n", "utf8");
  gitIn(repoDir, "stash push");
  // Now diverge the working tree on the exact same line the stash touches.
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nDIVERGENT-CHANGE\nline3\n", "utf8");
  gitIn(repoDir, "add a.txt");
  gitIn(repoDir, 'commit -m "divergent commit"');
  const r = executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.applyClean, false);
  assert.ok(typeof r.conflictOutput === "string" && r.conflictOutput.length > 0);
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("check_stash_apply_risk: missing stash defaults to stash@{0}", () => {
  const repoDir = makeRepo("sar-default");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nCHANGED\nline3\n", "utf8");
  gitIn(repoDir, "stash push");
  const r = executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.stash, "stash@{0}");
});

test("check_stash_apply_risk: malformed stash ref format is rejected", () => {
  const repoDir = makeRepo("sar-malformed");
  assert.throws(
    () => executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir), stash: "HEAD~1" }),
    /stash@\{N\}|stash_apply_risk/i
  );
});

test("check_stash_apply_risk: nonexistent stash index is rejected", () => {
  const repoDir = makeRepo("sar-nonexistent");
  assert.throws(
    () => executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir), stash: "stash@{5}" }),
    /no such stash/i
  );
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("check_stash_apply_risk: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "sar-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("check_stash_apply_risk", { path: path.relative(TMP, notGit) }),
    /not a git repository|no such stash/i
  );
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("check_stash_apply_risk: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("check_stash_apply_risk", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("check_stash_apply_risk: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("check_stash_apply_risk", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("check_stash_apply_risk: shell-injection-shaped stash ref is rejected, never executed", () => {
  const repoDir = makeRepo("sar-inject");
  assert.throws(
    () => executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir), stash: "stash@{0}; rm -rf /" }),
    /stash@\{N\}|stash_apply_risk/i
  );
});

test("check_stash_apply_risk: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("sar-json");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nCHANGED\nline3\n", "utf8");
  gitIn(repoDir, "stash push");
  const r = executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.applyClean, r.applyClean);
});

test("check_stash_apply_risk: result has no unexpected top-level keys", () => {
  const repoDir = makeRepo("sar-keys");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nCHANGED\nline3\n", "utf8");
  gitIn(repoDir, "stash push");
  const r = executeTool("check_stash_apply_risk", { path: path.relative(TMP, repoDir) });
  const expectedTop = new Set(["stash", "applyClean", "conflictOutput"]);
  for (const key of Object.keys(r)) assert.ok(expectedTop.has(key), `unexpected top-level key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("check_stash_apply_risk: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("sar-concurrent");
  fs.writeFileSync(path.join(repoDir, "a.txt"), "line1\nCHANGED\nline3\n", "utf8");
  gitIn(repoDir, "stash push");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("check_stash_apply_risk", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].applyClean, first.applyClean, `call ${i}: mismatch`);
  }
});

test("check_stash_apply_risk: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("check_stash_apply_risk"), "check_stash_apply_risk missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove check_stash_apply_risk fixture repos", () => {
  const dirs = [
    "sar-basic", "sar-clean", "sar-conflict", "sar-default", "sar-malformed",
    "sar-nonexistent", "sar-not-git", "sar-inject", "sar-json", "sar-keys",
    "sar-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "sar-basic")));
});
