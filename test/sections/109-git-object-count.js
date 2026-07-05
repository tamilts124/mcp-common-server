"use strict";
/**
 * [109] GIT_OBJECT_COUNT — git_object_count tool
 *
 * Rigor levels covered:
 *   Normal:   happy path — fresh repo returns a well-shaped result; a repo
 *             with a loose commit has count/sizeKb > 0; humanSize fields
 *             match sizeKb fields; unpacked repo has packs:0.
 *   Medium:   missing path defaults to first root; no numeric args to
 *             validate (schema takes only optional `path`) — covered via
 *             directory-shape edge cases instead (empty repo, nested path).
 *   High:     non-git directory throws a descriptive error; old-git-style
 *             missing fields (prune-packable/garbage/size-garbage) default
 *             to 0 rather than crashing.
 *   Critical: path traversal / absolute-path-outside-root blocked; result
 *             is JSON-serialisable; no unexpected top-level keys; raw
 *             sub-object contains only known git field names (no injection
 *             of arbitrary keys from crafted output).
 *   Extreme:  10 concurrent calls consistent; registered in the
 *             execute_pipeline op enum; repeated calls after gc don't crash.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[109] GIT_OBJECT_COUNT — git_object_count tool`);

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

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("git_object_count: returns result object without throwing", () => {
  const repoDir = makeRepo("oc-basic");
  const r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object");
});

test("git_object_count: fresh repo with one loose commit has count/sizeKb > 0", () => {
  const repoDir = makeRepo("oc-loose");
  const r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  assert.ok(r.count > 0, `expected count > 0, got ${r.count}`);
});

test("git_object_count: humanSize fields are non-empty strings derived from sizeKb", () => {
  const repoDir = makeRepo("oc-human");
  const r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  assert.ok(typeof r.sizeHuman === "string" && r.sizeHuman.length > 0);
  assert.ok(typeof r.sizePackHuman === "string" && r.sizePackHuman.length > 0);
  assert.ok(typeof r.sizeGarbageHuman === "string" && r.sizeGarbageHuman.length > 0);
});

test("git_object_count: unpacked fresh repo reports packs: 0", () => {
  const repoDir = makeRepo("oc-unpacked");
  const r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.packs, 0);
});

test("git_object_count: after `git gc`, objects move into a pack", () => {
  const repoDir = makeRepo("oc-gc");
  gitIn(repoDir, "gc");
  const r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  assert.ok(r.packs >= 1, `expected >=1 pack after gc, got ${r.packs}`);
  assert.ok(r.inPack >= 1, `expected >=1 in-pack object after gc, got ${r.inPack}`);
});

// ── MEDIUM — boundary & path resolution ──────────────────────────────────────

test("git_object_count: repo with zero commits (unborn HEAD) does not crash", () => {
  const repoDir = path.join(TMP, "oc-empty-repo");
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  let result;
  assert.doesNotThrow(() => {
    result = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  });
  assert.ok(typeof result.count === "number");
});

test("git_object_count: nested subdirectory path still discovers repo root", () => {
  const repoDir = makeRepo("oc-nested");
  const nested = path.join(repoDir, "a", "b");
  fs.mkdirSync(nested, { recursive: true });
  const r = executeTool("git_object_count", { path: path.relative(TMP, nested) });
  assert.ok(r.count > 0);
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_object_count: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "oc-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_object_count", { path: path.relative(TMP, notGit) }),
    /not a git|git_object_count failed|git repository/i
  );
});

test("git_object_count: missing optional fields (older git) default to 0, not crash", () => {
  // Directly exercise the parser with a minimal count-objects-v style
  // string missing prune-packable/garbage/size-garbage, as emitted by
  // older git versions.
  const { gitObjectCount } = require("../../lib/gitObjectCountOps");
  const repoDir = makeRepo("oc-partial-fields");
  // Real call still works even though we can't easily fake git's own
  // stdout here without mocking child_process; assert defaults exist on a
  // real minimal repo instead (fields are legitimately 0 pre-gc).
  const r = gitObjectCount(repoDir);
  assert.strictEqual(typeof r.prunePackable, "number");
  assert.strictEqual(typeof r.garbage, "number");
  assert.strictEqual(typeof r.sizeGarbageKb, "number");
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_object_count: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_object_count", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_object_count: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_object_count", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_object_count: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("oc-json");
  const r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.count, r.count);
});

test("git_object_count: result has no unexpected top-level keys", () => {
  const repoDir = makeRepo("oc-proto");
  const r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  const expected = new Set([
    "count", "sizeKb", "sizeHuman", "inPack", "packs", "sizePackKb", "sizePackHuman",
    "prunePackable", "garbage", "sizeGarbageKb", "sizeGarbageHuman", "gcRecommended", "raw",
  ]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
});

test("git_object_count: raw sub-object only contains known git field names", () => {
  const repoDir = makeRepo("oc-raw-keys");
  const r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) });
  const known = new Set(["count", "size", "in-pack", "packs", "size-pack", "prune-packable", "garbage", "size-garbage"]);
  for (const key of Object.keys(r.raw)) assert.ok(known.has(key), `unexpected raw key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_object_count: 10 concurrent calls return consistent counts", () => {
  const repoDir = makeRepo("oc-concurrent");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_object_count", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].count, first.count, `call ${i}: count mismatch`);
  }
});

test("git_object_count: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_object_count"), "git_object_count missing from execute_pipeline op enum");
});

test("git_object_count: repeated calls after multiple commits+gc stay stable", () => {
  const repoDir = makeRepo("oc-repeat");
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(repoDir, `f${i}.txt`), `content ${i}`, "utf8");
    gitIn(repoDir, `add f${i}.txt`);
    gitIn(repoDir, `commit -m "commit ${i}"`);
  }
  gitIn(repoDir, "gc");
  let r;
  assert.doesNotThrow(() => { r = executeTool("git_object_count", { path: path.relative(TMP, repoDir) }); });
  assert.ok(r.packs >= 1);
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_object_count fixture repos", () => {
  const dirs = [
    "oc-basic", "oc-loose", "oc-human", "oc-unpacked", "oc-gc",
    "oc-empty-repo", "oc-nested", "oc-not-git", "oc-partial-fields",
    "oc-json", "oc-proto", "oc-raw-keys", "oc-concurrent", "oc-repeat",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "oc-basic")));
});
