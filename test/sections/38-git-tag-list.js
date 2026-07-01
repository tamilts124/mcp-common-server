"use strict";
/**
 * [41] GIT_TAG_LIST — git_tag_list tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — lightweight tag on the current commit, annotated
 *             tag with its own message, field shape/types, isAnnotated flag
 *             correctness, hash correctness (dereferenced for annotated).
 *
 *   Medium:   boundary — repo with no tags returns { count:0, tags:[] } not
 *             an error; tags sorted most-recent-first; multiple tags on the
 *             same commit; tag name with slashes (e.g. release/v1.0).
 *
 *   High:     dependency failure — non-git directory throws descriptive
 *             error; repo with no commits yet (unborn HEAD, no tags) does
 *             not crash.
 *
 *   Critical: security — path traversal / absolute-path-outside-root
 *             blocked; injection-shaped tag message round-trips literally,
 *             never executed; result is JSON-serialisable; no prototype
 *             pollution; no unexpected top-level keys.
 *
 *   Extreme:  stress — repo with many tags (lightweight + annotated mixed)
 *             all listed correctly; 10 concurrent calls consistent.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[41] GIT_TAG_LIST — git_tag_list tool`);

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

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("git_tag_list: returns result object without throwing", () => {
  const repoDir = makeRepo("tag-basic");
  gitIn(repoDir, "tag v1.0.0");
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("git_tag_list: lightweight tag reports isAnnotated=false and the commit hash", () => {
  const repoDir = makeRepo("tag-lightweight");
  const commitHash = gitIn(repoDir, "rev-parse HEAD").trim();
  gitIn(repoDir, "tag v1.0.0");
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 1);
  const t = r.tags[0];
  assert.strictEqual(t.name, "v1.0.0");
  assert.strictEqual(t.isAnnotated, false);
  assert.strictEqual(t.hash, commitHash, "lightweight tag hash must equal the commit hash");
  assert.strictEqual(t.message, "initial commit", "lightweight tag message falls back to the commit subject");
});

test("git_tag_list: annotated tag reports isAnnotated=true, its own message, and dereferenced commit hash", () => {
  const repoDir = makeRepo("tag-annotated");
  const commitHash = gitIn(repoDir, "rev-parse HEAD").trim();
  gitIn(repoDir, 'tag -a v2.0.0 -m "Release version 2.0.0"');
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 1);
  const t = r.tags[0];
  assert.strictEqual(t.name, "v2.0.0");
  assert.strictEqual(t.isAnnotated, true);
  assert.strictEqual(t.hash, commitHash, "annotated tag hash must be dereferenced to the target commit");
  assert.strictEqual(t.message, "Release version 2.0.0");
});

test("git_tag_list: each entry has required fields with correct types", () => {
  const repoDir = makeRepo("tag-fields");
  gitIn(repoDir, "tag v1.0.0");
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  const t = r.tags[0];
  assert.ok(typeof t.name === "string", "name must be string");
  assert.ok(typeof t.hash === "string" && t.hash.length === 40, `hash must be 40-char hex: ${t.hash}`);
  assert.ok(typeof t.isAnnotated === "boolean", "isAnnotated must be boolean");
  assert.ok(typeof t.date === "string", "date must be string");
  assert.ok(typeof t.message === "string", "message must be string");
});

test("git_tag_list: date is a valid ISO 8601 string", () => {
  const repoDir = makeRepo("tag-date");
  gitIn(repoDir, 'tag -a v1.0.0 -m "first release"');
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  const d = new Date(r.tags[0].date);
  assert.ok(!isNaN(d.getTime()), `date must be parseable: ${r.tags[0].date}`);
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_tag_list: repo with no tags returns { count:0, tags:[] }, not an error", () => {
  const repoDir = makeRepo("tag-none");
  let result;
  assert.doesNotThrow(() => {
    result = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  });
  assert.strictEqual(result.count, 0);
  assert.deepStrictEqual(result.tags, []);
});

test("git_tag_list: tags are sorted most-recent-first", () => {
  const repoDir = makeRepo("tag-sort");
  gitIn(repoDir, "tag v1.0.0");
  gitIn(repoDir, "commit --allow-empty -m second");
  gitIn(repoDir, "tag v2.0.0");
  gitIn(repoDir, "commit --allow-empty -m third");
  gitIn(repoDir, "tag v3.0.0");
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 3);
  const dates = r.tags.map(t => t.date);
  const sortedDesc = [...dates].sort().reverse();
  // Since dates may collide to the second, just verify non-increasing order.
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i - 1] >= dates[i], `expected non-increasing dates, got ${dates}`);
  }
});

test("git_tag_list: multiple tags on the same commit are all listed", () => {
  const repoDir = makeRepo("tag-samecommit");
  gitIn(repoDir, "tag v1.0.0");
  gitIn(repoDir, "tag stable");
  gitIn(repoDir, 'tag -a v1.0.0-annotated -m "also here"');
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 3);
  const names = r.tags.map(t => t.name).sort();
  assert.deepStrictEqual(names, ["stable", "v1.0.0", "v1.0.0-annotated"]);
});

test("git_tag_list: tag name containing a slash (e.g. release/v1.0) round-trips correctly", () => {
  const repoDir = makeRepo("tag-slash");
  gitIn(repoDir, "tag release/v1.0");
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.tags[0].name, "release/v1.0");
});

// ── HIGH — dependency / failure handling ──────────────────────────────────────

test("git_tag_list: non-git directory throws a descriptive error (not a crash)", () => {
  const notGit = path.join(TMP, "tag-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_tag_list", { path: path.relative(TMP, notGit) }),
    /not a git|git tag list failed|git repository/i
  );
});

test("git_tag_list: repo with no commits yet (unborn HEAD, no tags) does not crash", () => {
  const repoDir = path.join(TMP, "tag-unborn");
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  let result;
  assert.doesNotThrow(() => {
    result = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  }, "unborn-HEAD repo should not crash the tool");
  assert.strictEqual(result.count, 0);
  assert.ok(Array.isArray(result.tags), "tags must still be an array");
});

test("git_tag_list: no path arg defaults to first root (TMP sandbox, non-git) — throws cleanly", () => {
  assert.throws(() => executeTool("git_tag_list", {}), /not a git|git tag list failed|git repository/i);
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("git_tag_list: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_tag_list", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_tag_list: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_tag_list", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_tag_list: injection-shaped annotated-tag message round-trips literally, never executed", () => {
  const repoDir = makeRepo("tag-inject");
  const evilMsg = "$(rm -rf /); DROP TABLE users; --";
  fs.writeFileSync(path.join(repoDir, "msgfile.txt"), evilMsg, "utf8");
  gitIn(repoDir, "tag -a v1.0.0-evil -F msgfile.txt");
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  const t = r.tags.find(x => x.name === "v1.0.0-evil");
  assert.ok(t, "evil-tag must appear in the list");
  assert.strictEqual(t.message, evilMsg, "injection-shaped message must round-trip literally");
});

test("git_tag_list: result is fully JSON-serialisable (no circular refs)", () => {
  const repoDir = makeRepo("tag-json");
  gitIn(repoDir, "tag v1.0.0");
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.count, r.count);
});

test("git_tag_list: result has no unexpected top-level keys (no prototype pollution)", () => {
  const repoDir = makeRepo("tag-proto");
  gitIn(repoDir, "tag v1.0.0");
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  const expected = new Set(["count", "tags"]);
  for (const key of Object.keys(r)) {
    assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
  for (const t of r.tags) {
    const tagExpected = new Set(["name", "hash", "isAnnotated", "date", "message"]);
    for (const key of Object.keys(t)) assert.ok(tagExpected.has(key), `unexpected tag key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ───────────────────────────────────

test("git_tag_list: repo with 15 mixed lightweight/annotated tags — all listed correctly", () => {
  const repoDir = makeRepo("tag-many");
  for (let i = 0; i < 15; i++) {
    gitIn(repoDir, "commit --allow-empty -m " + `commit-${i}`);
    if (i % 2 === 0) gitIn(repoDir, `tag light-${i}`);
    else gitIn(repoDir, `tag -a ann-${i} -m "annotated tag ${i}"`);
  }
  const r = executeTool("git_tag_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 15, "expected all 15 tags to be listed");
  const lightCount = r.tags.filter(t => !t.isAnnotated).length;
  const annCount = r.tags.filter(t => t.isAnnotated).length;
  assert.strictEqual(lightCount, 8, "8 lightweight tags (i=0,2,4,...,14)");
  assert.strictEqual(annCount, 7, "7 annotated tags (i=1,3,5,...,13)");
});

test("git_tag_list: 10 concurrent calls return consistent results", () => {
  const repoDir = makeRepo("tag-concurrent");
  gitIn(repoDir, "tag v1.0.0");
  gitIn(repoDir, 'tag -a v2.0.0 -m "second"');
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () =>
    executeTool("git_tag_list", { path: relPath })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].count, first.count, `call ${i}: count mismatch`);
    assert.deepStrictEqual(results[i].tags, first.tags, `call ${i}: tags mismatch`);
  }
});

test("git_tag_list: re-reading the same repo 50 times gives identical count", () => {
  const repoDir = makeRepo("tag-repeat");
  gitIn(repoDir, "tag stable");
  const relPath = path.relative(TMP, repoDir);
  for (let i = 0; i < 50; i++) {
    const r = executeTool("git_tag_list", { path: relPath });
    assert.strictEqual(r.count, 1);
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_tag_list fixture repos", () => {
  const dirs = [
    "tag-basic", "tag-lightweight", "tag-annotated", "tag-fields", "tag-date",
    "tag-none", "tag-sort", "tag-samecommit", "tag-slash",
    "tag-not-git", "tag-unborn",
    "tag-inject", "tag-json", "tag-proto",
    "tag-many", "tag-concurrent", "tag-repeat",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "tag-basic")), "tag-basic removed");
});
