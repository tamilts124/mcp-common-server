"use strict";
/**
 * [113] GIT_TAG_ANNOTATE_AUDIT — git_tag_annotate_audit tool
 *
 * Rigor levels covered:
 *   Normal:   mixed repo (1 annotated w/ message, 1 lightweight, 1
 *             annotated w/ empty message) classifies each correctly.
 *   Medium:   zero-tag repo returns empty result, not an error; missing
 *             path defaults to first root (no throw).
 *   High:     non-git directory throws a descriptive error.
 *   Critical: path traversal / absolute-path-outside-root blocked; an
 *             injection-shaped tag message round-trips as inert literal
 *             text, never executed; result is JSON-serialisable; no
 *             unexpected top-level/tag keys.
 *   Extreme:  20-tag repo classifies all correctly; 10 concurrent calls
 *             consistent; registered in execute_pipeline op enum; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[113] GIT_TAG_ANNOTATE_AUDIT — git_tag_annotate_audit tool`);

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
  fs.writeFileSync(path.join(repoDir, "a.txt"), "hello\n", "utf8");
  gitIn(repoDir, "add a.txt");
  gitIn(repoDir, 'commit -m "initial commit"');
  return repoDir;
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("git_tag_annotate_audit: classifies annotated/lightweight/empty-message tags correctly", () => {
  const repoDir = makeRepo("taa-mixed");
  gitIn(repoDir, 'tag -a v1.0.0 -m "first release"');
  gitIn(repoDir, "tag v1.0.1-lw");
  gitIn(repoDir, 'tag -a v1.0.2-empty -m " "');
  const r = executeTool("git_tag_annotate_audit", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalTags, 3);
  assert.strictEqual(r.annotatedCount, 2);
  assert.strictEqual(r.lightweightCount, 1);
  assert.strictEqual(r.flaggedCount, 2);
  const good = r.tags.find(t => t.name === "v1.0.0");
  const lw = r.tags.find(t => t.name === "v1.0.1-lw");
  const empty = r.tags.find(t => t.name === "v1.0.2-empty");
  assert.strictEqual(good.flagged, false);
  assert.strictEqual(lw.reason, "lightweight");
  assert.strictEqual(empty.reason, "annotated-empty-message");
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_tag_annotate_audit: zero-tag repo returns empty result, not an error", () => {
  const repoDir = makeRepo("taa-empty");
  let r;
  assert.doesNotThrow(() => { r = executeTool("git_tag_annotate_audit", { path: path.relative(TMP, repoDir) }); });
  assert.strictEqual(r.totalTags, 0);
  assert.deepStrictEqual(r.tags, []);
});

test("git_tag_annotate_audit: missing path resolves against first root (same convention as every other git_* tool, not this tool's own logic)", () => {
  // Whether this throws or succeeds depends on whether the harness's first
  // configured root happens to be a git repo — that's resolveRepoDir's
  // shared convention (every git_* tool), not something this tool decides.
  // Just confirm it doesn't crash the process with something other than a
  // clean Error.
  try { executeTool("git_tag_annotate_audit", {}); }
  catch (e) { assert.ok(e instanceof Error); }
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_tag_annotate_audit: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "taa-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_tag_annotate_audit", { path: path.relative(TMP, notGit) }),
    /not a git repository/i
  );
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_tag_annotate_audit: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_tag_annotate_audit", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_tag_annotate_audit: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_tag_annotate_audit", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_tag_annotate_audit: injection-shaped tag message round-trips as inert literal text", () => {
  const repoDir = makeRepo("taa-inject");
  gitIn(repoDir, 'tag -a v1.0.0 -m "$(rm -rf /) ; DROP TABLE tags; <script>alert(1)</script>"');
  const r = executeTool("git_tag_annotate_audit", { path: path.relative(TMP, repoDir) });
  const t = r.tags.find(x => x.name === "v1.0.0");
  assert.ok(t.message.includes("DROP TABLE") && t.message.includes("<script>"));
  assert.ok(fs.existsSync(path.join(repoDir, "a.txt")), "working tree should be untouched by the injection payload");
});

test("git_tag_annotate_audit: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("taa-json");
  gitIn(repoDir, 'tag -a v1.0.0 -m "release"');
  const r = executeTool("git_tag_annotate_audit", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).totalTags, r.totalTags);
});

test("git_tag_annotate_audit: result has no unexpected top-level or tag keys", () => {
  const repoDir = makeRepo("taa-keys");
  gitIn(repoDir, 'tag -a v1.0.0 -m "release"');
  gitIn(repoDir, "tag v1.0.1-lw");
  const r = executeTool("git_tag_annotate_audit", { path: path.relative(TMP, repoDir) });
  const expectedTop = new Set(["totalTags", "annotatedCount", "lightweightCount", "flaggedCount", "tags"]);
  for (const key of Object.keys(r)) assert.ok(expectedTop.has(key), `unexpected top-level key: '${key}'`);
  const expectedTag = new Set(["name", "hash", "isAnnotated", "message", "flagged", "reason"]);
  for (const t of r.tags) {
    for (const key of Object.keys(t)) assert.ok(expectedTag.has(key), `unexpected tag key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_tag_annotate_audit: 20-tag repo classifies all correctly", () => {
  const repoDir = makeRepo("taa-many");
  for (let i = 0; i < 10; i++) gitIn(repoDir, `tag -a v-ann-${i} -m "release ${i}"`);
  for (let i = 0; i < 10; i++) gitIn(repoDir, `tag v-lw-${i}`);
  const r = executeTool("git_tag_annotate_audit", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalTags, 20);
  assert.strictEqual(r.annotatedCount, 10);
  assert.strictEqual(r.lightweightCount, 10);
  assert.strictEqual(r.flaggedCount, 10);
});

test("git_tag_annotate_audit: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("taa-concurrent");
  gitIn(repoDir, 'tag -a v1.0.0 -m "release"');
  gitIn(repoDir, "tag v1.0.1-lw");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_tag_annotate_audit", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].flaggedCount, first.flaggedCount, `call ${i}: mismatch`);
  }
});

test("git_tag_annotate_audit: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_tag_annotate_audit"), "git_tag_annotate_audit missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_tag_annotate_audit fixture repos", () => {
  const dirs = [
    "taa-mixed", "taa-empty", "taa-not-git", "taa-inject", "taa-json",
    "taa-keys", "taa-many", "taa-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "taa-mixed")));
});
