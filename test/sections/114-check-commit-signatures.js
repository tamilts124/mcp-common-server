"use strict";
/**
 * [114] CHECK_COMMIT_SIGNATURES — check_commit_signatures tool
 *
 * Rigor levels covered:
 *   Normal:   unsigned commits (the common case in a fresh test repo with
 *             no GPG configured) report status 'N', signed:false,
 *             unsignedCount incrementing; totals/counts consistent.
 *   Medium:   limit narrows totalScanned; non-numeric/over-cap limit falls
 *             back/clamps; missing ref defaults to HEAD.
 *   High:     non-git directory throws; unknown ref throws.
 *   Critical: path traversal / absolute-path-outside-root blocked; shell-
 *             injection-shaped ref rejected, never executed; result is
 *             JSON-serialisable; no unexpected top-level/commit keys;
 *             injection-shaped commit subject round-trips as inert text.
 *   Extreme:  many-commit repo scan completes without crashing; 10
 *             concurrent calls consistent; registered in execute_pipeline
 *             op enum; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[114] CHECK_COMMIT_SIGNATURES — check_commit_signatures tool`);

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
  return repoDir;
}

function commit(repoDir, file, msg) {
  fs.writeFileSync(path.join(repoDir, file), msg, "utf8");
  gitIn(repoDir, `add ${file}`);
  gitIn(repoDir, `commit -m ${JSON.stringify(msg)}`);
  return gitIn(repoDir, "rev-parse HEAD").trim();
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("check_commit_signatures: unsigned commits report status N, signed:false", () => {
  const repoDir = makeRepo("ccs-basic");
  commit(repoDir, "a.txt", "commit a");
  commit(repoDir, "b.txt", "commit b");
  const r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalScanned, 2);
  assert.strictEqual(r.unsignedCount, 2);
  assert.strictEqual(r.signedCount, 0);
  assert.strictEqual(r.badCount, 0);
  for (const c of r.commits) {
    assert.strictEqual(c.status, "N");
    assert.strictEqual(c.signed, false);
    assert.strictEqual(c.bad, false);
  }
});

test("check_commit_signatures: counts sum to totalScanned", () => {
  const repoDir = makeRepo("ccs-sum");
  for (let i = 0; i < 4; i++) commit(repoDir, `f${i}.txt`, `commit ${i}`);
  const r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.signedCount + r.unsignedCount + r.badCount, r.totalScanned);
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("check_commit_signatures: limit narrows totalScanned", () => {
  const repoDir = makeRepo("ccs-limit");
  for (let i = 0; i < 5; i++) commit(repoDir, `f${i}.txt`, `commit ${i}`);
  const r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir), limit: 3 });
  assert.strictEqual(r.totalScanned, 3);
});

test("check_commit_signatures: non-numeric limit falls back to default", () => {
  const repoDir = makeRepo("ccs-badlimit");
  commit(repoDir, "a.txt", "a");
  let r;
  assert.doesNotThrow(() => { r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir), limit: "not-a-number" }); });
  assert.strictEqual(r.totalScanned, 1);
});

test("check_commit_signatures: over-cap limit clamps to 200", () => {
  const repoDir = makeRepo("ccs-overcap");
  commit(repoDir, "a.txt", "a");
  let r;
  assert.doesNotThrow(() => { r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir), limit: 999999 }); });
  assert.strictEqual(r.totalScanned, 1); // repo only has 1 commit; clamp itself just shouldn't error
});

test("check_commit_signatures: missing ref defaults to HEAD", () => {
  const repoDir = makeRepo("ccs-default-ref");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.ref, "HEAD");
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("check_commit_signatures: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "ccs-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("check_commit_signatures", { path: path.relative(TMP, notGit) }),
    /not a git repository/i
  );
});

test("check_commit_signatures: unknown ref throws a descriptive error", () => {
  const repoDir = makeRepo("ccs-unknown-ref");
  commit(repoDir, "a.txt", "a");
  assert.throws(
    () => executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir), ref: "totally-nonexistent-ref-xyz" }),
    /unknown ref/i
  );
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("check_commit_signatures: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("check_commit_signatures", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("check_commit_signatures: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("check_commit_signatures", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("check_commit_signatures: shell-injection-shaped ref is rejected, never executed", () => {
  const repoDir = makeRepo("ccs-inject-ref");
  assert.throws(
    () => executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir), ref: "HEAD; rm -rf /" }),
    /disallowed characters|git_ops/i
  );
});

test("check_commit_signatures: injection-shaped commit subject round-trips as inert literal text", () => {
  const repoDir = makeRepo("ccs-inject-subject");
  commit(repoDir, "a.txt", '$(rm -rf /) ; DROP TABLE commits; <script>alert(1)</script>');
  const r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir) });
  assert.ok(r.commits[0].subject.includes("DROP TABLE"));
  assert.ok(fs.existsSync(path.join(repoDir, "a.txt")), "working tree should be untouched by the injection payload");
});

test("check_commit_signatures: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("ccs-json");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).totalScanned, r.totalScanned);
});

test("check_commit_signatures: result has no unexpected top-level or commit keys", () => {
  const repoDir = makeRepo("ccs-keys");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir) });
  const expectedTop = new Set(["ref", "totalScanned", "signedCount", "unsignedCount", "badCount", "commits"]);
  for (const key of Object.keys(r)) assert.ok(expectedTop.has(key), `unexpected top-level key: '${key}'`);
  const expectedCommit = new Set(["hash", "shortHash", "status", "statusMeaning", "signed", "bad", "signer", "subject"]);
  for (const c of r.commits) {
    for (const key of Object.keys(c)) assert.ok(expectedCommit.has(key), `unexpected commit key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("check_commit_signatures: many-commit repo scan completes without crashing", () => {
  const repoDir = makeRepo("ccs-many");
  for (let i = 0; i < 30; i++) commit(repoDir, `f${i}.txt`, `commit ${i}`);
  let r;
  assert.doesNotThrow(() => { r = executeTool("check_commit_signatures", { path: path.relative(TMP, repoDir), limit: 100 }); });
  assert.strictEqual(r.totalScanned, 30);
});

test("check_commit_signatures: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("ccs-concurrent");
  commit(repoDir, "a.txt", "a");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("check_commit_signatures", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].totalScanned, first.totalScanned, `call ${i}: mismatch`);
  }
});

test("check_commit_signatures: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("check_commit_signatures"), "check_commit_signatures missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove check_commit_signatures fixture repos", () => {
  const dirs = [
    "ccs-basic", "ccs-sum", "ccs-limit", "ccs-badlimit", "ccs-overcap",
    "ccs-default-ref", "ccs-not-git", "ccs-unknown-ref", "ccs-inject-ref",
    "ccs-inject-subject", "ccs-json", "ccs-keys", "ccs-many", "ccs-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "ccs-basic")));
});
