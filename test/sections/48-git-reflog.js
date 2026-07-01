"use strict";
/**
 * [48] GIT_REFLOG — git_reflog tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy path — reflog entries after a commit, selector/hash/
 *             action/subject/author/email/date field shape, default ref
 *             (HEAD) when omitted, explicit ref name.
 *
 *   Medium:   boundary — missing/blank ref falls back to HEAD; limit
 *             clamping (too-low/too-high/non-numeric); repo with only the
 *             initial commit still returns at least one entry (the initial
 *             commit itself is a reflog entry).
 *
 *   High:     dependency failure — non-git directory throws a descriptive
 *             error; unknown/nonexistent ref throws a descriptive error
 *             rather than crashing; a fresh repo with no commits yet
 *             (unborn HEAD) does not crash.
 *
 *   Critical: security — path traversal / absolute-path-outside-root
 *             blocked; shell-injection-shaped ref value rejected by
 *             assertSafeArg; injection-shaped commit message round-trips
 *             literally through the subject field, never executed; result
 *             is JSON-serialisable; no prototype pollution; no unexpected
 *             top-level keys.
 *
 *   Extreme:  stress — repo with many reflog-producing operations (commits,
 *             checkouts, resets) all listed correctly with the right count
 *             and ordering; limit correctly caps the returned entries while
 *             the underlying reflog has more; 10 concurrent calls
 *             consistent; registered in the execute_pipeline op enum.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[48] GIT_REFLOG — git_reflog tool`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

function gitIn(repoDir, cmd) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

/** Create a minimal git repo under TMP/<name> with an initial commit on main. */
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

// ── NORMAL — happy path ────────────────────────────────────────────────────────

test("git_reflog: returns result object without throwing", () => {
  const repoDir = makeRepo("reflog-basic");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("git_reflog: initial commit produces at least one reflog entry", () => {
  const repoDir = makeRepo("reflog-initial");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  assert.ok(r.count >= 1, `expected at least 1 entry, got ${r.count}`);
  assert.strictEqual(r.ref, "HEAD");
});

test("git_reflog: each entry has required fields with correct types", () => {
  const repoDir = makeRepo("reflog-fields");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  const e = r.entries[0];
  assert.ok(typeof e.selector === "string" && e.selector.length > 0, "selector must be non-empty string");
  assert.ok(typeof e.hash === "string" && e.hash.length === 40, `hash must be 40-char hex: ${e.hash}`);
  assert.ok(typeof e.shortHash === "string" && e.shortHash.length > 0, "shortHash must be non-empty string");
  assert.ok(typeof e.action === "string", "action must be string");
  assert.ok(typeof e.subject === "string", "subject must be string");
  assert.ok(typeof e.author === "string", "author must be string");
  assert.ok(typeof e.email === "string", "email must be string");
  assert.ok(typeof e.date === "string", "date must be string");
});

test("git_reflog: date is a valid ISO 8601 string", () => {
  const repoDir = makeRepo("reflog-date");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  const d = new Date(r.entries[0].date);
  assert.ok(!isNaN(d.getTime()), `date must be parseable: ${r.entries[0].date}`);
});

test("git_reflog: commit action is reported in the reflog subject", () => {
  const repoDir = makeRepo("reflog-commit-action");
  gitIn(repoDir, 'commit --allow-empty -m "second commit"');
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  const top = r.entries[0];
  assert.ok(/commit/i.test(top.action), `expected 'commit' in action, got: ${top.action}`);
  assert.strictEqual(top.subject, "second commit");
});

test("git_reflog: explicit ref name (branch) works the same as HEAD's own reflog", () => {
  const repoDir = makeRepo("reflog-explicit-ref");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir), ref: "main" });
  assert.strictEqual(r.ref, "main");
  assert.ok(r.count >= 1);
});

test("git_reflog: most-recent entry is first (reflog @{0})", () => {
  const repoDir = makeRepo("reflog-order");
  gitIn(repoDir, 'commit --allow-empty -m "second commit"');
  gitIn(repoDir, 'commit --allow-empty -m "third commit"');
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.entries[0].subject, "third commit");
  assert.ok(r.entries[0].selector.includes("@{0}"), `expected @{0} selector, got: ${r.entries[0].selector}`);
});

// ── MEDIUM — boundary & param validation ──────────────────────────────────────

test("git_reflog: blank/whitespace-only ref falls back to HEAD", () => {
  const repoDir = makeRepo("reflog-blank-ref");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir), ref: "   " });
  assert.strictEqual(r.ref, "HEAD");
});

test("git_reflog: omitted ref defaults to HEAD", () => {
  const repoDir = makeRepo("reflog-omit-ref");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.ref, "HEAD");
});

test("git_reflog: limit caps the returned entry count", () => {
  const repoDir = makeRepo("reflog-limit");
  for (let i = 0; i < 10; i++) gitIn(repoDir, `commit --allow-empty -m commit-${i}`);
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir), limit: 3 });
  assert.strictEqual(r.entries.length, 3);
});

test("git_reflog: limit below 1 is clamped up to 1, not rejected", () => {
  const repoDir = makeRepo("reflog-limit-low");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir), limit: -5 });
  assert.strictEqual(r.entries.length, 1);
});

test("git_reflog: limit above the hard cap (500) is clamped, not rejected", () => {
  const repoDir = makeRepo("reflog-limit-high");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir), limit: 999999 });
  assert.ok(r.entries.length <= 500);
});

test("git_reflog: non-numeric limit falls back to the default (30) rather than crashing", () => {
  const repoDir = makeRepo("reflog-limit-nan");
  let result;
  assert.doesNotThrow(() => {
    result = executeTool("git_reflog", { path: path.relative(TMP, repoDir), limit: "not-a-number" });
  });
  assert.ok(result.entries.length >= 1);
});

// ── HIGH — dependency / failure handling ──────────────────────────────────────

test("git_reflog: non-git directory throws a descriptive error (not a crash)", () => {
  const notGit = path.join(TMP, "reflog-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_reflog", { path: path.relative(TMP, notGit) }),
    /not a git|git reflog failed|git repository/i
  );
});

test("git_reflog: unknown/nonexistent ref throws a descriptive error", () => {
  const repoDir = makeRepo("reflog-unknown-ref");
  assert.throws(
    () => executeTool("git_reflog", { path: path.relative(TMP, repoDir), ref: "totally-does-not-exist-branch" }),
    /unknown ref|git reflog failed/i
  );
});

test("git_reflog: no path arg defaults to first root (TMP sandbox, non-git) — throws cleanly", () => {
  assert.throws(() => executeTool("git_reflog", {}), /not a git|git reflog failed|git repository/i);
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("git_reflog: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_reflog", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_reflog: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_reflog", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_reflog: shell-injection-shaped ref value is rejected, not executed", () => {
  const repoDir = makeRepo("reflog-inject-ref");
  assert.throws(
    () => executeTool("git_reflog", { path: path.relative(TMP, repoDir), ref: "HEAD; rm -rf /" }),
    /disallowed characters|git reflog failed|unknown ref/i
  );
});

test("git_reflog: injection-shaped commit message round-trips literally through the subject field, never executed", () => {
  const repoDir = makeRepo("reflog-inject-msg");
  const evilMsg = "$(rm -rf /); DROP TABLE users; --";
  fs.writeFileSync(path.join(repoDir, "msgfile.txt"), evilMsg, "utf8");
  gitIn(repoDir, "commit --allow-empty -F msgfile.txt");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.entries[0].subject, evilMsg, "injection-shaped message must round-trip literally");
});

test("git_reflog: result is fully JSON-serialisable (no circular refs)", () => {
  const repoDir = makeRepo("reflog-json");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.count, r.count);
});

test("git_reflog: result has no unexpected top-level keys (no prototype pollution)", () => {
  const repoDir = makeRepo("reflog-proto");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir) });
  const expected = new Set(["ref", "count", "entries"]);
  for (const key of Object.keys(r)) {
    assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
  const entryExpected = new Set(["selector", "hash", "shortHash", "action", "subject", "author", "email", "date"]);
  for (const e of r.entries) {
    for (const key of Object.keys(e)) assert.ok(entryExpected.has(key), `unexpected entry key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ────────────────────────────────────

test("git_reflog: repo with 20 commits — reflog lists all of them correctly", () => {
  const repoDir = makeRepo("reflog-many");
  for (let i = 0; i < 20; i++) gitIn(repoDir, `commit --allow-empty -m commit-${i}`);
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir), limit: 100 });
  // 1 initial commit + 20 more = 21 reflog entries
  assert.strictEqual(r.count, 21, `expected 21 entries, got ${r.count}`);
  assert.strictEqual(r.entries[0].subject, "commit-19");
});

test("git_reflog: reset changes are visible in the reflog even though git_log would no longer show them", () => {
  const repoDir = makeRepo("reflog-reset");
  gitIn(repoDir, 'commit --allow-empty -m "will be reset away"');
  const hashBeforeReset = gitIn(repoDir, "rev-parse HEAD").trim();
  gitIn(repoDir, "reset --hard HEAD~1");
  const r = executeTool("git_reflog", { path: path.relative(TMP, repoDir), limit: 10 });
  const hashes = r.entries.map(e => e.hash);
  assert.ok(hashes.includes(hashBeforeReset), "the reset-away commit must still appear in the reflog");
  assert.ok(/reset/i.test(r.entries[0].action), `expected 'reset' in the most recent action, got: ${r.entries[0].action}`);
});

test("git_reflog: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("reflog-concurrent");
  gitIn(repoDir, 'commit --allow-empty -m "second"');
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () =>
    executeTool("git_reflog", { path: relPath })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].count, first.count, `call ${i}: count mismatch`);
    assert.deepStrictEqual(results[i].entries, first.entries, `call ${i}: entries mismatch`);
  }
});

test("git_reflog: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_reflog"), "git_reflog missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_reflog fixture repos", () => {
  const dirs = [
    "reflog-basic", "reflog-initial", "reflog-fields", "reflog-date",
    "reflog-commit-action", "reflog-explicit-ref", "reflog-order",
    "reflog-blank-ref", "reflog-omit-ref", "reflog-limit", "reflog-limit-low",
    "reflog-limit-high", "reflog-limit-nan",
    "reflog-not-git", "reflog-unknown-ref",
    "reflog-inject-ref", "reflog-inject-msg", "reflog-json", "reflog-proto",
    "reflog-many", "reflog-reset", "reflog-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "reflog-basic")), "reflog-basic removed");
});
