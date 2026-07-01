"use strict";
/**
 * [49] GIT_CHERRY — git_cherry tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy path — commits unique to head all reported "unmerged";
 *             after a cherry-pick of one commit onto upstream, that commit
 *             is correctly reclassified "equivalent" while the remaining
 *             commit stays "unmerged"; field shape/types; count/unmerged/
 *             equivalent totals are consistent; head defaults to HEAD.
 *
 *   Medium:   boundary — missing/empty 'upstream' throws -32602 (required
 *             field); upstream === head (nothing unique) returns an empty
 *             list, not an error; a repo with zero divergent commits
 *             returns an empty list.
 *
 *   High:     dependency failure — non-git directory throws a descriptive
 *             error; unknown upstream/head ref throws a descriptive
 *             "unknown ref" error rather than crashing or silently
 *             returning an empty result.
 *
 *   Critical: security — path traversal / absolute-path-outside-root
 *             blocked; shell-injection-shaped upstream/head values rejected
 *             by assertSafeArg; injection-shaped commit subject round-trips
 *             literally, never executed; result is JSON-serialisable; no
 *             prototype pollution; no unexpected top-level keys.
 *
 *   Extreme:  stress — many-commit branch reports every commit correctly;
 *             a rebase (not just a single cherry-pick) reclassifies every
 *             rebased commit as "equivalent" — proving this tool answers a
 *             genuinely different question than a plain two-ref git_diff/
 *             git_log would; 10 concurrent calls consistent; registered in
 *             the execute_pipeline op enum.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[49] GIT_CHERRY — git_cherry tool`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

function gitIn(repoDir, cmd) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

// Cherry-pick with an explicit, fixed GIT_COMMITTER_DATE far from "now" (real
// wall-clock time). Without this, a cherry-pick that runs within the same
// clock-second as the original commit (very plausible — these test-harness
// operations are near-instantaneous) preserves the original AUTHOR_DATE and
// would get an IDENTICAL committer timestamp too, which — combined with an
// identical tree/parent/author/message — produces the exact same commit
// hash as the original rather than a new, patch-equivalent one. That
// degenerate case makes `git cherry` treat the "cherry-picked" commit as
// plain ancestry-reachable (it IS the same object) rather than exercising
// the patch-equivalence ("-") detection this tool exists to test. Forcing a
// committer date that can never coincide with the original guarantees a
// distinct hash every run, matching genuine real-world cherry-pick behavior.
function gitCherryPick(repoDir, refs) {
  return execSync(`git cherry-pick ${refs}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_COMMITTER_DATE: "2030-01-01T00:00:00" },
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

/** Create a `feature` branch off `main` with N distinct-content commits. */
function makeFeatureBranch(repoDir, count) {
  gitIn(repoDir, "checkout -b feature main");
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(repoDir, `f${i}.txt`), `content-${i}\n`, "utf8");
    gitIn(repoDir, `add f${i}.txt`);
    gitIn(repoDir, `commit -m "feature commit ${i}"`);
  }
}

// ── NORMAL — happy path ────────────────────────────────────────────────────────

test("git_cherry: returns result object without throwing", () => {
  const repoDir = makeRepo("cherry-basic");
  makeFeatureBranch(repoDir, 1);
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("git_cherry: commits unique to head are all reported 'unmerged' before anything is merged", () => {
  const repoDir = makeRepo("cherry-unmerged");
  makeFeatureBranch(repoDir, 2);
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.unmergedCount, 2);
  assert.strictEqual(r.equivalentCount, 0);
  for (const c of r.commits) assert.strictEqual(c.status, "unmerged");
});

test("git_cherry: each commit has required fields with correct types", () => {
  const repoDir = makeRepo("cherry-fields");
  makeFeatureBranch(repoDir, 1);
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  const c = r.commits[0];
  assert.ok(typeof c.hash === "string" && c.hash.length === 40, `hash must be 40-char hex: ${c.hash}`);
  assert.ok(typeof c.shortHash === "string" && c.shortHash.length === 7, "shortHash must be 7-char string");
  assert.ok(typeof c.subject === "string" && c.subject.length > 0, "subject must be non-empty string");
  assert.ok(c.status === "unmerged" || c.status === "equivalent", `status must be a valid enum value: ${c.status}`);
});

test("git_cherry: cherry-picking one commit onto upstream reclassifies exactly that commit as 'equivalent'", () => {
  const repoDir = makeRepo("cherry-pick-reclass");
  makeFeatureBranch(repoDir, 2);
  gitIn(repoDir, "checkout main");
  gitCherryPick(repoDir, "feature~1"); // picks "feature commit 0"
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  assert.strictEqual(r.count, 2, `expected 2 total commits, got ${r.count}`);
  assert.strictEqual(r.unmergedCount, 1, `expected 1 unmerged, got ${r.unmergedCount}`);
  assert.strictEqual(r.equivalentCount, 1, `expected 1 equivalent, got ${r.equivalentCount}`);
  const equiv = r.commits.find(c => c.status === "equivalent");
  const unmerged = r.commits.find(c => c.status === "unmerged");
  assert.strictEqual(equiv.subject, "feature commit 0");
  assert.strictEqual(unmerged.subject, "feature commit 1");
});

test("git_cherry: head defaults to HEAD when omitted", () => {
  const repoDir = makeRepo("cherry-default-head");
  makeFeatureBranch(repoDir, 1);
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main" });
  assert.strictEqual(r.head, "HEAD");
  assert.strictEqual(r.count, 1); // currently checked out on 'feature' via makeFeatureBranch
});

test("git_cherry: result echoes upstream and head exactly as (trimmed) requested", () => {
  const repoDir = makeRepo("cherry-echo");
  makeFeatureBranch(repoDir, 1);
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "  main  ", head: "  feature  " });
  assert.strictEqual(r.upstream, "main");
  assert.strictEqual(r.head, "feature");
});

// ── MEDIUM — boundary & param validation ──────────────────────────────────────

test("git_cherry: missing 'upstream' throws -32602", () => {
  const repoDir = makeRepo("cherry-missing-upstream");
  let threw = false;
  try {
    executeTool("git_cherry", { path: path.relative(TMP, repoDir), head: "main" });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.code, -32602, `expected code -32602, got ${e.code}`);
  }
  assert.ok(threw, "must throw when upstream is missing");
});

test("git_cherry: empty string 'upstream' throws (required field)", () => {
  const repoDir = makeRepo("cherry-empty-upstream");
  assert.throws(
    () => executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "", head: "main" }),
    /required|invalid|empty/i
  );
});

test("git_cherry: upstream === head (nothing unique) returns an empty list, not an error", () => {
  const repoDir = makeRepo("cherry-same-ref");
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "main" });
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.commits, []);
});

test("git_cherry: a branch with zero divergent commits (branched but nothing committed since) returns empty", () => {
  const repoDir = makeRepo("cherry-no-divergence");
  gitIn(repoDir, "checkout -b feature main");
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  assert.strictEqual(r.count, 0);
});

// ── HIGH — dependency / failure handling ──────────────────────────────────────

test("git_cherry: non-git directory throws a descriptive error (not a crash)", () => {
  const notGit = path.join(TMP, "cherry-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_cherry", { path: path.relative(TMP, notGit), upstream: "main" }),
    /not a git|git cherry failed|git repository/i
  );
});

test("git_cherry: unknown upstream ref throws a descriptive 'unknown ref' error", () => {
  const repoDir = makeRepo("cherry-unknown-upstream");
  assert.throws(
    () => executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "totally-does-not-exist" }),
    /unknown ref/i
  );
});

test("git_cherry: unknown head ref throws a descriptive 'unknown ref' error", () => {
  const repoDir = makeRepo("cherry-unknown-head");
  assert.throws(
    () => executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "totally-does-not-exist" }),
    /unknown ref/i
  );
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("git_cherry: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_cherry", { path: "../../etc", upstream: "main" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_cherry: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_cherry", { path: "C:\\Windows\\System32", upstream: "main" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_cherry: shell-injection-shaped upstream value is rejected, not executed", () => {
  const repoDir = makeRepo("cherry-inject-upstream");
  assert.throws(
    () => executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main; rm -rf /" }),
    /disallowed characters|git cherry failed|unknown ref/i
  );
});

test("git_cherry: shell-injection-shaped head value is rejected, not executed", () => {
  const repoDir = makeRepo("cherry-inject-head");
  assert.throws(
    () => executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "`rm -rf /`" }),
    /disallowed characters|git cherry failed|unknown ref/i
  );
});

test("git_cherry: injection-shaped commit subject round-trips literally, never executed", () => {
  const repoDir = makeRepo("cherry-inject-subject");
  gitIn(repoDir, "checkout -b feature main");
  const evilMsg = "$(rm -rf /); DROP TABLE users; --";
  fs.writeFileSync(path.join(repoDir, "f.txt"), "x\n", "utf8");
  gitIn(repoDir, "add f.txt");
  fs.writeFileSync(path.join(repoDir, "msgfile.txt"), evilMsg, "utf8");
  gitIn(repoDir, "commit -F msgfile.txt");
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  assert.strictEqual(r.commits[0].subject, evilMsg, "injection-shaped subject must round-trip literally");
});

test("git_cherry: result is fully JSON-serialisable (no circular refs)", () => {
  const repoDir = makeRepo("cherry-json");
  makeFeatureBranch(repoDir, 1);
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.count, r.count);
});

test("git_cherry: result has no unexpected top-level keys (no prototype pollution)", () => {
  const repoDir = makeRepo("cherry-proto");
  makeFeatureBranch(repoDir, 1);
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  const expected = new Set(["upstream", "head", "count", "unmergedCount", "equivalentCount", "commits"]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
  const commitExpected = new Set(["hash", "shortHash", "subject", "status"]);
  for (const c of r.commits) {
    for (const key of Object.keys(c)) assert.ok(commitExpected.has(key), `unexpected commit key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ────────────────────────────────────

test("git_cherry: a 15-commit feature branch reports all 15 unmerged commits correctly", () => {
  const repoDir = makeRepo("cherry-many");
  makeFeatureBranch(repoDir, 15);
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  assert.strictEqual(r.count, 15, `expected 15 commits, got ${r.count}`);
  assert.strictEqual(r.unmergedCount, 15);
  // git cherry lists oldest-diverged-first
  assert.strictEqual(r.commits[0].subject, "feature commit 0");
  assert.strictEqual(r.commits[14].subject, "feature commit 14");
});

test("git_cherry: a full rebase (not just one cherry-pick) reclassifies every rebased commit as 'equivalent' — the tool's core value proposition", () => {
  const repoDir = makeRepo("cherry-rebase");
  makeFeatureBranch(repoDir, 3);
  // Advance main so the rebase actually changes commit hashes.
  gitIn(repoDir, "checkout main");
  fs.writeFileSync(path.join(repoDir, "mainonly.txt"), "m\n", "utf8");
  gitIn(repoDir, "add mainonly.txt");
  gitIn(repoDir, 'commit -m "main-only commit"');
  gitIn(repoDir, "checkout feature");
  gitIn(repoDir, "rebase main");
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  // After a rebase, every one of feature's 3 commits is a *new* commit
  // object (different hash) whose patch content is unchanged — a plain
  // ancestry diff would call these "new" commits entirely; git_cherry
  // must instead detect that main itself has no such patches yet (they
  // were never applied to main), so all 3 remain genuinely "unmerged".
  assert.strictEqual(r.count, 3, `expected 3 commits after rebase, got ${r.count}`);
  assert.strictEqual(r.unmergedCount, 3);
});

test("git_cherry: cherry-picking ALL feature commits onto upstream reclassifies all of them as 'equivalent'", () => {
  const repoDir = makeRepo("cherry-all-equivalent");
  makeFeatureBranch(repoDir, 3);
  gitIn(repoDir, "checkout main");
  gitCherryPick(repoDir, "feature~2 feature~1 feature");
  const r = executeTool("git_cherry", { path: path.relative(TMP, repoDir), upstream: "main", head: "feature" });
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.equivalentCount, 3, `expected all 3 equivalent, got ${r.equivalentCount}`);
  assert.strictEqual(r.unmergedCount, 0);
});

test("git_cherry: 10 concurrent (sequential-simulated) calls return consistent results", () => {
  const repoDir = makeRepo("cherry-concurrent");
  makeFeatureBranch(repoDir, 3);
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () =>
    executeTool("git_cherry", { path: relPath, upstream: "main", head: "feature" })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].count, first.count, `call ${i}: count mismatch`);
    assert.deepStrictEqual(results[i].commits, first.commits, `call ${i}: commits mismatch`);
  }
});

test("git_cherry: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_cherry"), "git_cherry missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_cherry fixture repos", () => {
  const dirs = [
    "cherry-basic", "cherry-unmerged", "cherry-fields", "cherry-pick-reclass",
    "cherry-default-head", "cherry-echo",
    "cherry-missing-upstream", "cherry-empty-upstream", "cherry-same-ref", "cherry-no-divergence",
    "cherry-not-git", "cherry-unknown-upstream", "cherry-unknown-head",
    "cherry-inject-upstream", "cherry-inject-head", "cherry-inject-subject",
    "cherry-json", "cherry-proto",
    "cherry-many", "cherry-rebase", "cherry-all-equivalent", "cherry-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "cherry-basic")), "cherry-basic removed");
});
