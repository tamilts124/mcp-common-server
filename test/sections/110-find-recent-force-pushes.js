"use strict";
/**
 * [110] FIND_RECENT_FORCE_PUSHES — find_recent_force_pushes tool
 *
 * Rigor levels covered:
 *   Normal:   happy path — a ref updated purely by fast-forward commits
 *             (append-only) reports zero rewrites; a ref whose local
 *             reflog shows a reset to an earlier/divergent commit (the
 *             local proxy for "this ref's history was rewritten") is
 *             detected as a rewrite event with correct old/new hashes.
 *   Medium:   missing ref defaults to HEAD; limit clamping delegated to
 *             (and inherited from) git_reflog; ref with <2 reflog entries
 *             cleanly reports zero rewrites rather than erroring.
 *   High:     non-git directory throws a descriptive error; unknown ref
 *             throws a descriptive error (delegated from git_reflog).
 *   Critical: path traversal / absolute-path-outside-root blocked; result
 *             is JSON-serialisable; no unexpected top-level/event keys;
 *             ref argument sanitized against shell metacharacters.
 *   Extreme:  many-entry reflog scan completes without crashing; 10
 *             concurrent calls consistent; registered in execute_pipeline
 *             op enum; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[110] FIND_RECENT_FORCE_PUSHES — find_recent_force_pushes tool`);

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
  fs.writeFileSync(path.join(repoDir, "readme.txt"), "hello\n", "utf8");
  gitIn(repoDir, "add readme.txt");
  gitIn(repoDir, 'commit -m "initial commit"');
  return repoDir;
}

function commit(repoDir, file, msg) {
  fs.writeFileSync(path.join(repoDir, file), msg, "utf8");
  gitIn(repoDir, `add ${file}`);
  gitIn(repoDir, `commit -m ${JSON.stringify(msg)}`);
  return gitIn(repoDir, "rev-parse HEAD").trim();
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("find_recent_force_pushes: returns result object without throwing", () => {
  const repoDir = makeRepo("fp-basic");
  const r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object");
});

test("find_recent_force_pushes: pure fast-forward history reports zero rewrites", () => {
  const repoDir = makeRepo("fp-ff");
  commit(repoDir, "a.txt", "commit a");
  commit(repoDir, "b.txt", "commit b");
  commit(repoDir, "c.txt", "commit c");
  const r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.rewritesDetected, 0);
  assert.deepStrictEqual(r.events, []);
});

test("find_recent_force_pushes: a reset --hard to an earlier commit followed by a new commit is detected as a rewrite", () => {
  const repoDir = makeRepo("fp-rewrite");
  const firstHash = gitIn(repoDir, "rev-parse HEAD").trim();
  const oldTipHash = commit(repoDir, "a.txt", "on the old line");
  gitIn(repoDir, `reset --hard ${firstHash}`);
  commit(repoDir, "b.txt", "on the new divergent line");
  const r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir) });
  assert.ok(r.rewritesDetected >= 1, `expected >=1 rewrite, got ${r.rewritesDetected}`);
  // The rewrite is recorded at the reflog step that actually diverged (the
  // `reset --hard` back to firstHash, abandoning oldTipHash) — not at the
  // later fast-forward commit built on top of it, which is a legitimate
  // forward move from that new base and correctly not flagged on its own.
  const found = r.events.find(e => e.oldHash === oldTipHash && e.newHash === firstHash);
  assert.ok(found, "expected an event recording the reset away from the old tip");
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("find_recent_force_pushes: missing ref defaults to HEAD", () => {
  const repoDir = makeRepo("fp-default-ref");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.ref, "HEAD");
});

test("find_recent_force_pushes: fresh repo with only 1 reflog entry reports zero rewrites, not an error", () => {
  const repoDir = makeRepo("fp-single-entry");
  let r;
  assert.doesNotThrow(() => { r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir) }); });
  assert.strictEqual(r.rewritesDetected, 0);
});

test("find_recent_force_pushes: limit narrows entriesScanned", () => {
  const repoDir = makeRepo("fp-limit");
  for (let i = 0; i < 5; i++) commit(repoDir, `f${i}.txt`, `commit ${i}`);
  const r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir), limit: 3 });
  assert.ok(r.entriesScanned <= 3, `expected entriesScanned <= 3, got ${r.entriesScanned}`);
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("find_recent_force_pushes: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "fp-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("find_recent_force_pushes", { path: path.relative(TMP, notGit) }),
    /not a git|git repository|git reflog failed/i
  );
});

test("find_recent_force_pushes: unknown ref throws a descriptive error", () => {
  const repoDir = makeRepo("fp-unknown-ref");
  assert.throws(
    () => executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir), ref: "totally-nonexistent-ref-xyz" }),
    /unknown ref|git reflog failed/i
  );
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("find_recent_force_pushes: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("find_recent_force_pushes", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("find_recent_force_pushes: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("find_recent_force_pushes", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("find_recent_force_pushes: shell-injection-shaped ref is rejected, never executed", () => {
  const repoDir = makeRepo("fp-inject-ref");
  assert.throws(
    () => executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir), ref: "HEAD; rm -rf /" }),
    /disallowed characters|git_ops/i
  );
});

test("find_recent_force_pushes: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("fp-json");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.rewritesDetected, r.rewritesDetected);
});

test("find_recent_force_pushes: result has no unexpected top-level or event keys", () => {
  const repoDir = makeRepo("fp-proto");
  const firstHash = gitIn(repoDir, "rev-parse HEAD").trim();
  commit(repoDir, "a.txt", "line a");
  gitIn(repoDir, `reset --hard ${firstHash}`);
  commit(repoDir, "b.txt", "line b");
  const r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir) });
  const expectedTop = new Set(["ref", "entriesScanned", "rewritesDetected", "events"]);
  for (const key of Object.keys(r)) assert.ok(expectedTop.has(key), `unexpected top-level key: '${key}'`);
  const expectedEvent = new Set(["oldHash", "oldShortHash", "newHash", "newShortHash", "oldDate", "newDate", "action"]);
  for (const e of r.events) {
    for (const key of Object.keys(e)) assert.ok(expectedEvent.has(key), `unexpected event key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("find_recent_force_pushes: many-entry reflog scan completes without crashing", () => {
  const repoDir = makeRepo("fp-many");
  for (let i = 0; i < 20; i++) commit(repoDir, `f${i}.txt`, `commit ${i}`);
  let r;
  assert.doesNotThrow(() => { r = executeTool("find_recent_force_pushes", { path: path.relative(TMP, repoDir), limit: 100 }); });
  assert.strictEqual(r.rewritesDetected, 0);
});

test("find_recent_force_pushes: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("fp-concurrent");
  commit(repoDir, "a.txt", "a");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("find_recent_force_pushes", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].rewritesDetected, first.rewritesDetected, `call ${i}: mismatch`);
  }
});

test("find_recent_force_pushes: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_recent_force_pushes"), "find_recent_force_pushes missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove find_recent_force_pushes fixture repos", () => {
  const dirs = [
    "fp-basic", "fp-ff", "fp-rewrite", "fp-default-ref", "fp-single-entry",
    "fp-limit", "fp-not-git", "fp-unknown-ref", "fp-inject-ref",
    "fp-json", "fp-proto", "fp-many", "fp-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "fp-basic")));
});
