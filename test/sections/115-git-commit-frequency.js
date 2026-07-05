"use strict";
/**
 * [115] GIT_COMMIT_FREQUENCY — git_commit_frequency tool
 *
 * Rigor levels covered:
 *   Normal:   commits-per-day histogram totals match commit count; byAuthor
 *             percentages sum to ~100.
 *   Medium:   since_days narrows window; non-numeric/over-cap since_days
 *             falls back/clamps; missing ref defaults to HEAD; top_authors
 *             caps breakdown length and sets truncatedAuthors.
 *   High:     non-git directory throws; unknown ref throws.
 *   Critical: path traversal / absolute-path-outside-root blocked; shell-
 *             injection-shaped ref rejected, never executed; result is
 *             JSON-serialisable; no unexpected top-level keys.
 *   Extreme:  many-commit multi-author repo scan completes without
 *             crashing; 10 concurrent calls consistent; registered in
 *             execute_pipeline op enum; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[115] GIT_COMMIT_FREQUENCY — git_commit_frequency tool`);

function gitIn(repoDir, cmd, authorName, authorEmail) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env,
      GIT_AUTHOR_NAME: authorName || "Test User", GIT_AUTHOR_EMAIL: authorEmail || "test@example.com",
      GIT_COMMITTER_NAME: authorName || "Test User", GIT_COMMITTER_EMAIL: authorEmail || "test@example.com" },
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

function commit(repoDir, file, msg, authorName, authorEmail) {
  fs.writeFileSync(path.join(repoDir, file), msg, "utf8");
  gitIn(repoDir, `add ${file}`);
  gitIn(repoDir, `commit -m ${JSON.stringify(msg)}`, authorName, authorEmail);
  return gitIn(repoDir, "rev-parse HEAD").trim();
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("git_commit_frequency: totalCommits matches commits made, byDay sums match", () => {
  const repoDir = makeRepo("gcf-basic");
  commit(repoDir, "a.txt", "a");
  commit(repoDir, "b.txt", "b");
  commit(repoDir, "c.txt", "c");
  const r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalCommits, 3);
  const daySum = r.byDay.reduce((s, d) => s + d.count, 0);
  assert.strictEqual(daySum, 3);
});

test("git_commit_frequency: byAuthor percentages sum to ~100", () => {
  const repoDir = makeRepo("gcf-authors");
  commit(repoDir, "a.txt", "a", "Alice", "alice@example.com");
  commit(repoDir, "b.txt", "b", "Bob", "bob@example.com");
  commit(repoDir, "c.txt", "c", "Alice", "alice@example.com");
  const r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir) });
  const pctSum = r.byAuthor.reduce((s, a) => s + a.percentage, 0);
  assert.ok(Math.abs(pctSum - 100) < 0.5, `expected ~100, got ${pctSum}`);
  const alice = r.byAuthor.find(a => a.author === "Alice");
  assert.strictEqual(alice.count, 2);
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_commit_frequency: since_days narrows window field", () => {
  const repoDir = makeRepo("gcf-since");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir), since_days: 7 });
  assert.strictEqual(r.daysInWindow, 7);
});

test("git_commit_frequency: non-numeric since_days falls back to default", () => {
  const repoDir = makeRepo("gcf-badsince");
  commit(repoDir, "a.txt", "a");
  let r;
  assert.doesNotThrow(() => { r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir), since_days: "not-a-number" }); });
  assert.strictEqual(r.daysInWindow, 30);
});

test("git_commit_frequency: over-cap since_days clamps to 3650", () => {
  const repoDir = makeRepo("gcf-overcap");
  commit(repoDir, "a.txt", "a");
  let r;
  assert.doesNotThrow(() => { r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir), since_days: 999999 }); });
  assert.strictEqual(r.daysInWindow, 3650);
});

test("git_commit_frequency: missing ref defaults to HEAD", () => {
  const repoDir = makeRepo("gcf-default-ref");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.ref, "HEAD");
});

test("git_commit_frequency: top_authors caps breakdown and sets truncatedAuthors", () => {
  const repoDir = makeRepo("gcf-topauthors");
  for (let i = 0; i < 5; i++) commit(repoDir, `f${i}.txt`, `c${i}`, `Author${i}`, `a${i}@example.com`);
  const r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir), top_authors: 2 });
  assert.strictEqual(r.byAuthor.length, 2);
  assert.strictEqual(r.truncatedAuthors, true);
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_commit_frequency: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "gcf-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_commit_frequency", { path: path.relative(TMP, notGit) }),
    /not a git repository/i
  );
});

test("git_commit_frequency: unknown ref throws a descriptive error", () => {
  const repoDir = makeRepo("gcf-unknown-ref");
  commit(repoDir, "a.txt", "a");
  assert.throws(
    () => executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir), ref: "totally-nonexistent-ref-xyz" }),
    /unknown ref/i
  );
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_commit_frequency: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_commit_frequency", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_commit_frequency: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_commit_frequency", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_commit_frequency: shell-injection-shaped ref is rejected, never executed", () => {
  const repoDir = makeRepo("gcf-inject-ref");
  assert.throws(
    () => executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir), ref: "HEAD; rm -rf /" }),
    /disallowed characters|git_ops/i
  );
});

test("git_commit_frequency: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("gcf-json");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).totalCommits, r.totalCommits);
});

test("git_commit_frequency: result has no unexpected top-level keys", () => {
  const repoDir = makeRepo("gcf-keys");
  commit(repoDir, "a.txt", "a");
  const r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir) });
  const expectedTop = new Set([
    "ref", "sinceDays", "totalCommits", "activeDays", "daysInWindow",
    "byDay", "byAuthor", "truncatedAuthors",
  ]);
  for (const key of Object.keys(r)) assert.ok(expectedTop.has(key), `unexpected top-level key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_commit_frequency: many-commit multi-author repo scan completes without crashing", () => {
  const repoDir = makeRepo("gcf-many");
  for (let i = 0; i < 30; i++) commit(repoDir, `f${i}.txt`, `commit ${i}`, `Author${i % 5}`, `a${i % 5}@example.com`);
  let r;
  assert.doesNotThrow(() => { r = executeTool("git_commit_frequency", { path: path.relative(TMP, repoDir), top_authors: 200 }); });
  assert.strictEqual(r.totalCommits, 30);
  assert.strictEqual(r.byAuthor.length, 5);
});

test("git_commit_frequency: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("gcf-concurrent");
  commit(repoDir, "a.txt", "a");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_commit_frequency", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].totalCommits, first.totalCommits, `call ${i}: mismatch`);
  }
});

test("git_commit_frequency: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_commit_frequency"), "git_commit_frequency missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_commit_frequency fixture repos", () => {
  const dirs = [
    "gcf-basic", "gcf-authors", "gcf-since", "gcf-badsince", "gcf-overcap",
    "gcf-default-ref", "gcf-topauthors", "gcf-not-git", "gcf-unknown-ref",
    "gcf-inject-ref", "gcf-json", "gcf-keys", "gcf-many", "gcf-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "gcf-basic")));
});
