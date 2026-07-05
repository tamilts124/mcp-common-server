"use strict";
/**
 * [108] GIT_DANGLING_COMMITS — git_dangling_commits tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy path — a commit orphaned by `reset --hard` is detected
 *             (with --no-reflogs) even while its reflog entry still exists;
 *             field shape of each entry; count/truncated fields; a repo
 *             with no dangling commits returns an empty list cleanly.
 *
 *   Medium:   boundary — limit clamping (too-low/too-high/non-numeric);
 *             missing path defaults to first root.
 *
 *   High:     dependency failure — non-git directory throws a descriptive
 *             error; a repo with zero commits (unborn HEAD) does not crash.
 *
 *   Critical: security — path traversal / absolute-path-outside-root
 *             blocked; injection-shaped commit message on the dangling
 *             commit round-trips literally through the subject field,
 *             never executed; result is JSON-serialisable; no unexpected
 *             top-level keys.
 *
 *   Extreme:  stress — several orphaned commits detected and limit caps the
 *             detailed list while count reflects the true total; 10
 *             concurrent calls consistent; registered in the
 *             execute_pipeline op enum.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[108] GIT_DANGLING_COMMITS — git_dangling_commits tool`);

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

/** Make a commit, then reset --hard away from it, orphaning it (still in reflog). Returns its hash. */
function orphanACommit(repoDir, message) {
  gitIn(repoDir, `commit --allow-empty -m ${JSON.stringify(message)}`);
  const hash = gitIn(repoDir, "rev-parse HEAD").trim();
  gitIn(repoDir, "reset --hard HEAD~1");
  return hash;
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("git_dangling_commits: returns result object without throwing", () => {
  const repoDir = makeRepo("dc-basic");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object");
});

test("git_dangling_commits: clean repo with no orphaned commits returns empty list", () => {
  const repoDir = makeRepo("dc-clean");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.danglingCommits, []);
  assert.strictEqual(r.truncated, false);
});

test("git_dangling_commits: commit orphaned by reset --hard is detected even with its reflog entry intact", () => {
  const repoDir = makeRepo("dc-orphan");
  const orphanHash = orphanACommit(repoDir, "will be orphaned");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  assert.ok(r.count >= 1, `expected >=1 dangling commit, got ${r.count}`);
  const hashes = r.danglingCommits.map(c => c.hash);
  assert.ok(hashes.includes(orphanHash), `expected orphaned hash ${orphanHash} in result`);
});

test("git_dangling_commits: each entry has required fields with correct types", () => {
  const repoDir = makeRepo("dc-fields");
  orphanACommit(repoDir, "orphan for fields");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  const e = r.danglingCommits[0];
  assert.ok(typeof e.hash === "string" && e.hash.length === 40);
  assert.ok(typeof e.shortHash === "string" && e.shortHash.length > 0);
  assert.ok(typeof e.subject === "string");
  assert.ok(typeof e.author === "string");
  assert.ok(typeof e.email === "string");
  assert.ok(typeof e.date === "string");
});

test("git_dangling_commits: subject matches the orphaned commit's own message", () => {
  const repoDir = makeRepo("dc-subject");
  orphanACommit(repoDir, "distinctive orphan message");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  const found = r.danglingCommits.find(c => c.subject === "distinctive orphan message");
  assert.ok(found, "expected to find the orphaned commit by its subject");
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_dangling_commits: limit caps the detailed list, count is unaffected", () => {
  const repoDir = makeRepo("dc-limit");
  for (let i = 0; i < 4; i++) orphanACommit(repoDir, `orphan-${i}`);
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir), limit: 2 });
  assert.strictEqual(r.danglingCommits.length, 2);
  assert.ok(r.count >= 4);
  assert.strictEqual(r.truncated, true);
});

test("git_dangling_commits: limit above hard cap (500) is clamped, not rejected", () => {
  const repoDir = makeRepo("dc-limit-high");
  orphanACommit(repoDir, "orphan-high");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir), limit: 999999 });
  assert.ok(r.danglingCommits.length <= 500);
});

test("git_dangling_commits: non-numeric limit falls back to default rather than crashing", () => {
  const repoDir = makeRepo("dc-limit-nan");
  orphanACommit(repoDir, "orphan-nan");
  let result;
  assert.doesNotThrow(() => {
    result = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir), limit: "not-a-number" });
  });
  assert.ok(result.danglingCommits.length >= 1);
});

test("git_dangling_commits: limit below 1 is clamped up to the default, not rejected", () => {
  const repoDir = makeRepo("dc-limit-low");
  orphanACommit(repoDir, "orphan-low");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir), limit: -5 });
  assert.ok(r.danglingCommits.length >= 1);
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_dangling_commits: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "dc-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_dangling_commits", { path: path.relative(TMP, notGit) }),
    /not a git|git_dangling_commits failed|git repository/i
  );
});

test("git_dangling_commits: brand-new repo with zero commits does not crash", () => {
  const repoDir = path.join(TMP, "dc-empty-repo");
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  let result;
  assert.doesNotThrow(() => {
    result = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  });
  assert.strictEqual(result.count, 0);
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_dangling_commits: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_dangling_commits", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_dangling_commits: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_dangling_commits", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_dangling_commits: injection-shaped orphaned commit message round-trips literally, never executed", () => {
  const repoDir = makeRepo("dc-inject-msg");
  const evilMsg = "$(rm -rf /); DROP TABLE users; --";
  orphanACommit(repoDir, evilMsg);
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  const found = r.danglingCommits.find(c => c.subject === evilMsg);
  assert.ok(found, "injection-shaped message must round-trip literally");
});

test("git_dangling_commits: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("dc-json");
  orphanACommit(repoDir, "for json test");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.count, r.count);
});

test("git_dangling_commits: result has no unexpected top-level keys", () => {
  const repoDir = makeRepo("dc-proto");
  orphanACommit(repoDir, "for proto test");
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir) });
  const expected = new Set(["count", "truncated", "danglingCommits"]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  const entryExpected = new Set(["hash", "shortHash", "subject", "author", "email", "date"]);
  for (const e of r.danglingCommits) {
    for (const key of Object.keys(e)) assert.ok(entryExpected.has(key), `unexpected entry key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_dangling_commits: 8 orphaned commits are all detected with limit raised", () => {
  const repoDir = makeRepo("dc-many");
  const orphanHashes = [];
  for (let i = 0; i < 8; i++) orphanHashes.push(orphanACommit(repoDir, `many-orphan-${i}`));
  const r = executeTool("git_dangling_commits", { path: path.relative(TMP, repoDir), limit: 100 });
  assert.ok(r.count >= 8, `expected >=8, got ${r.count}`);
  const hashes = new Set(r.danglingCommits.map(c => c.hash));
  for (const h of orphanHashes) assert.ok(hashes.has(h), `missing orphan hash ${h}`);
});

test("git_dangling_commits: 10 concurrent calls return consistent counts", () => {
  const repoDir = makeRepo("dc-concurrent");
  orphanACommit(repoDir, "concurrent-orphan");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_dangling_commits", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].count, first.count, `call ${i}: count mismatch`);
  }
});

test("git_dangling_commits: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_dangling_commits"), "git_dangling_commits missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_dangling_commits fixture repos", () => {
  const dirs = [
    "dc-basic", "dc-clean", "dc-orphan", "dc-fields", "dc-subject",
    "dc-limit", "dc-limit-high", "dc-limit-nan", "dc-limit-low",
    "dc-not-git", "dc-empty-repo",
    "dc-inject-msg", "dc-json", "dc-proto",
    "dc-many", "dc-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "dc-basic")));
});
