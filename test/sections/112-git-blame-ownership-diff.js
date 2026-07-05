"use strict";
/**
 * [112] GIT_BLAME_OWNERSHIP_DIFF — git_blame_ownership_diff tool
 *
 * Rigor levels covered:
 *   Normal:   a file rewritten entirely by a second author between two
 *             refs reports a large ownership shift toward that author;
 *             an untouched file between two refs reports zero shift.
 *   Medium:   missing ref_a throws; missing ref_b defaults to HEAD.
 *   High:     directory path rejected; unknown ref throws; non-git
 *             directory throws.
 *   Critical: path traversal / absolute-path-outside-root blocked; shell-
 *             injection-shaped ref rejected, never executed; result is
 *             JSON-serialisable; shifts sum consistency.
 *   Extreme:  10 concurrent calls consistent; registered in execute_pipeline
 *             op enum; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[112] GIT_BLAME_OWNERSHIP_DIFF — git_blame_ownership_diff tool`);

function gitIn(repoDir, cmd, author) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author || "Test User", GIT_AUTHOR_EMAIL: (author || "test") + "@example.com",
      GIT_COMMITTER_NAME: author || "Test User", GIT_COMMITTER_EMAIL: (author || "test") + "@example.com",
    },
  });
}

function makeRepo(name) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  return repoDir;
}

function commitAs(repoDir, file, content, author, msg) {
  fs.writeFileSync(path.join(repoDir, file), content, "utf8");
  gitIn(repoDir, `add ${file}`, author);
  gitIn(repoDir, `commit -m ${JSON.stringify(msg || "commit")}`, author);
  return gitIn(repoDir, "rev-parse HEAD", author).trim();
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("git_blame_ownership_diff: full rewrite by a second author reports a large shift", () => {
  const repoDir = makeRepo("bod-rewrite");
  const refA = commitAs(repoDir, "a.txt", "alice line1\nalice line2\nalice line3\n", "Alice", "alice's version");
  commitAs(repoDir, "a.txt", "bob line1\nbob line2\nbob line3\n", "Bob", "bob's rewrite");
  const r = executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, repoDir), "a.txt"), ref_a: refA });
  // Alice goes 100% -> 0%, Bob goes 0% -> 100%: equal-magnitude opposite
  // shifts, so which name wins the tiebreak is a naming detail, not the
  // signal under test — assert the shift magnitude and both entries exist.
  assert.ok(Math.abs(r.maxShiftDelta) === 100, `expected a full 100-point swing, got ${r.maxShiftDelta}`);
  const bob = r.shifts.find(s => s.name === "Bob");
  const alice = r.shifts.find(s => s.name === "Alice");
  assert.ok(bob && bob.percentageA === 0 && bob.percentageB === 100, "expected Bob 0%->100%");
  assert.ok(alice && alice.percentageA === 100 && alice.percentageB === 0, "expected Alice 100%->0%");
});

test("git_blame_ownership_diff: unchanged file between two refs reports zero shift", () => {
  const repoDir = makeRepo("bod-unchanged");
  const refA = commitAs(repoDir, "a.txt", "alice line1\n", "Alice", "alice's version");
  commitAs(repoDir, "other.txt", "unrelated\n", "Alice", "unrelated commit");
  const r = executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, repoDir), "a.txt"), ref_a: refA });
  assert.strictEqual(r.maxShiftDelta, 0);
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_blame_ownership_diff: missing ref_a throws", () => {
  const repoDir = makeRepo("bod-missing-refa");
  commitAs(repoDir, "a.txt", "x\n", "Alice", "c1");
  assert.throws(
    () => executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, repoDir), "a.txt") }),
    /ref_a/i
  );
});

test("git_blame_ownership_diff: missing ref_b defaults to HEAD", () => {
  const repoDir = makeRepo("bod-default-refb");
  const refA = commitAs(repoDir, "a.txt", "x\n", "Alice", "c1");
  commitAs(repoDir, "a.txt", "y\n", "Bob", "c2");
  const r = executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, repoDir), "a.txt"), ref_a: refA });
  assert.strictEqual(r.refB, "HEAD");
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_blame_ownership_diff: directory path is rejected", () => {
  const repoDir = makeRepo("bod-dir");
  commitAs(repoDir, "a.txt", "x\n", "Alice", "c1");
  assert.throws(
    () => executeTool("git_blame_ownership_diff", { path: path.relative(TMP, repoDir), ref_a: "HEAD" }),
    /must be a single file|directory/i
  );
});

test("git_blame_ownership_diff: unknown ref throws", () => {
  const repoDir = makeRepo("bod-unknown-ref");
  commitAs(repoDir, "a.txt", "x\n", "Alice", "c1");
  assert.throws(
    () => executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, repoDir), "a.txt"), ref_a: "totally-nonexistent-ref-xyz" }),
    /unknown ref_a/i
  );
});

test("git_blame_ownership_diff: non-git directory throws", () => {
  const notGit = path.join(TMP, "bod-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "a.txt"), "x", "utf8");
  assert.throws(
    () => executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, notGit), "a.txt"), ref_a: "HEAD" }),
    /not inside a git repository|ENOENT|no such file/i
  );
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_blame_ownership_diff: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_blame_ownership_diff", { path: "../../etc/passwd", ref_a: "HEAD" }),
    /outside.*root|traversal|not.*within|ENOENT/i
  );
});

test("git_blame_ownership_diff: shell-injection-shaped ref_a is rejected, never executed", () => {
  const repoDir = makeRepo("bod-inject");
  commitAs(repoDir, "a.txt", "x\n", "Alice", "c1");
  assert.throws(
    () => executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, repoDir), "a.txt"), ref_a: "HEAD; rm -rf /" }),
    /disallowed characters|git_ops/i
  );
});

test("git_blame_ownership_diff: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("bod-json");
  const refA = commitAs(repoDir, "a.txt", "x\n", "Alice", "c1");
  commitAs(repoDir, "a.txt", "y\n", "Bob", "c2");
  const r = executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, repoDir), "a.txt"), ref_a: refA });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).maxShiftAuthor, r.maxShiftAuthor);
});

test("git_blame_ownership_diff: percentageA/percentageB per author each sum to ~100 (or 0 for empty side)", () => {
  const repoDir = makeRepo("bod-sum");
  const refA = commitAs(repoDir, "a.txt", "alice1\nalice2\n", "Alice", "c1");
  commitAs(repoDir, "a.txt", "bob1\nbob2\ncarl1\n", "Bob", "c2");
  gitIn(repoDir, "add a.txt", "Carl"); // no-op, just to have a 3rd potential name unused
  const r = executeTool("git_blame_ownership_diff", { path: path.join(path.relative(TMP, repoDir), "a.txt"), ref_a: refA });
  const sumA = r.ownershipA.reduce((s, o) => s + o.percentage, 0);
  const sumB = r.ownershipB.reduce((s, o) => s + o.percentage, 0);
  assert.ok(Math.abs(sumA - 100) < 0.5, `sumA=${sumA}`);
  assert.ok(Math.abs(sumB - 100) < 0.5, `sumB=${sumB}`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_blame_ownership_diff: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("bod-concurrent");
  const refA = commitAs(repoDir, "a.txt", "x\n", "Alice", "c1");
  commitAs(repoDir, "a.txt", "y\n", "Bob", "c2");
  const relPath = path.join(path.relative(TMP, repoDir), "a.txt");
  const results = Array.from({ length: 10 }, () => executeTool("git_blame_ownership_diff", { path: relPath, ref_a: refA }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].maxShiftAuthor, first.maxShiftAuthor, `call ${i}: mismatch`);
  }
});

test("git_blame_ownership_diff: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_blame_ownership_diff"), "git_blame_ownership_diff missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_blame_ownership_diff fixture repos", () => {
  const dirs = [
    "bod-rewrite", "bod-unchanged", "bod-missing-refa", "bod-default-refb",
    "bod-dir", "bod-unknown-ref", "bod-not-git", "bod-inject", "bod-json",
    "bod-sum", "bod-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "bod-rewrite")));
});
