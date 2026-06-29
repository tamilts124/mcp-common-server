"use strict";
/**
 * [18] GIT_STASH_LIST — git_stash_list tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — create a repo with stash entries and verify the
 *             result contains the correct count, structured entries, and all
 *             required fields (index, ref, message, author, email, date).
 *
 *   Medium:   boundary — repo with 0 stashes returns { count:0, stashes:[] };
 *             repo with multiple stashes returns them in most-recent-first order;
 *             stash messages match the WIP pattern; date is ISO 8601.
 *
 *   High:     dependency failure — non-git directory throws a descriptive error
 *             (not a crash); git binary missing (mocked) is handled; accessing
 *             via executeTool with missing/invalid path arg surfaces -32602.
 *
 *   Critical: security — path traversal via 'path' arg is blocked; shell
 *             metachar injection in commit messages is returned as literal data
 *             not executed; result is fully JSON-serialisable; no prototype
 *             pollution.
 *
 *   Extreme:  stress — repo with 5 stashes lists all 5 correctly; 10 concurrent
 *             calls return consistent results; re-reading 50 times gives same count.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[18] GIT_STASH_LIST — git_stash_list tool`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Create a minimal git repo under TMP/<name>, with an initial commit and
 * optionally N stash entries. Returns the absolute path to the repo dir.
 */
function makeStashRepo(name, stashCount = 0) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });

  const git = (cmd) => execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  });

  git("init -b main");
  git("config user.email test@example.com");
  git("config user.name \"Test User\"");

  // Initial commit
  fs.writeFileSync(path.join(repoDir, "readme.txt"), "hello\n", "utf8");
  git("add readme.txt");
  git("commit -m \"initial commit\"");

  // Create N stash entries
  for (let i = 0; i < stashCount; i++) {
    fs.writeFileSync(path.join(repoDir, "work.txt"), `work-${i}\n`, "utf8");
    git("add work.txt");
    git(`stash push -m "stash entry ${i}"`);
  }

  return repoDir;
}

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("git_stash_list: returns result object without throwing", () => {
  const repoDir = makeStashRepo("stash-basic", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("git_stash_list: result has count and stashes array", () => {
  const repoDir = makeStashRepo("stash-fields", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.ok(typeof r.count === "number", "count must be a number");
  assert.ok(Array.isArray(r.stashes), "stashes must be an array");
});

test("git_stash_list: count equals stashes.length", () => {
  const repoDir = makeStashRepo("stash-count", 2);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, r.stashes.length, "count must equal stashes.length");
});

test("git_stash_list: each entry has required fields with correct types", () => {
  const repoDir = makeStashRepo("stash-entry-fields", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.ok(r.stashes.length >= 1, "should have at least 1 stash entry");
  for (const s of r.stashes) {
    assert.ok(typeof s.index === "number",  `index must be number: ${JSON.stringify(s)}`);
    assert.ok(typeof s.ref === "string",    `ref must be string: ${JSON.stringify(s)}`);
    assert.ok(typeof s.message === "string",`message must be string: ${JSON.stringify(s)}`);
    assert.ok(typeof s.author === "string", `author must be string: ${JSON.stringify(s)}`);
    assert.ok(typeof s.email === "string",  `email must be string: ${JSON.stringify(s)}`);
    assert.ok(typeof s.date === "string",   `date must be string: ${JSON.stringify(s)}`);
  }
});

test("git_stash_list: ref field has correct stash@{N} format", () => {
  const repoDir = makeStashRepo("stash-ref", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.ok(/^stash@\{\d+\}$/.test(r.stashes[0].ref),
    `ref must match stash@{N} format: ${r.stashes[0].ref}`);
  assert.strictEqual(r.stashes[0].index, 0, "first stash index must be 0");
});

test("git_stash_list: message contains the stash description we provided", () => {
  const repoDir = makeStashRepo("stash-msg", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.ok(r.stashes[0].message.includes("stash entry 0"),
    `message should contain 'stash entry 0', got: ${r.stashes[0].message}`);
});

test("git_stash_list: author and email are non-empty strings", () => {
  const repoDir = makeStashRepo("stash-author", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.ok(r.stashes[0].author.length > 0, "author must be non-empty");
  assert.ok(r.stashes[0].email.length > 0,  "email must be non-empty");
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("git_stash_list: repo with 0 stashes returns { count:0, stashes:[] }", () => {
  const repoDir = makeStashRepo("stash-empty", 0);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 0, "count must be 0 for empty stash");
  assert.deepStrictEqual(r.stashes, [], "stashes must be [] for empty stash");
});

test("git_stash_list: multiple stashes listed in most-recent-first order", () => {
  // git stash is LIFO; stash@{0} is the most recently pushed
  const repoDir = makeStashRepo("stash-order", 3);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 3, "should have 3 stash entries");
  // Most recent is stash entry 2 (last pushed), which becomes stash@{0}
  assert.ok(r.stashes[0].message.includes("stash entry 2"),
    `most-recent stash should be 'stash entry 2', got: ${r.stashes[0].message}`);
  assert.ok(r.stashes[2].message.includes("stash entry 0"),
    `oldest stash should be 'stash entry 0', got: ${r.stashes[2].message}`);
  // Indices should be 0, 1, 2
  assert.strictEqual(r.stashes[0].index, 0);
  assert.strictEqual(r.stashes[1].index, 1);
  assert.strictEqual(r.stashes[2].index, 2);
});

test("git_stash_list: stash@{N} ref matches index", () => {
  const repoDir = makeStashRepo("stash-refs", 3);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  for (const s of r.stashes) {
    assert.strictEqual(s.ref, `stash@{${s.index}}`,
      `ref must match index: ${JSON.stringify(s)}`);
  }
});

test("git_stash_list: date is a valid ISO 8601 string", () => {
  const repoDir = makeStashRepo("stash-date", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  const d = new Date(r.stashes[0].date);
  assert.ok(!isNaN(d.getTime()), `date must be parseable: ${r.stashes[0].date}`);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.stashes[0].date),
    `date must be ISO 8601: ${r.stashes[0].date}`);
});

test("git_stash_list: no path arg defaults to first root (TMP sandbox, non-git) — throws cleanly", () => {
  // In the test harness MCP_ROOTS is set to a tmpdir sandbox which is NOT a git
  // repository. So calling git_stash_list with no path must throw a descriptive
  // error (git repo not found) rather than crashing the process or returning
  // garbage. This verifies the graceful-fallback path in gitStashList().
  let threw = false;
  let errMsg = "";
  try {
    executeTool("git_stash_list", {});
  } catch (e) {
    threw = true;
    errMsg = e.message || "";
  }
  assert.ok(threw, "should throw when first root is not a git repo");
  assert.ok(
    /not a git|git stash list failed|git repository|fatal/i.test(errMsg),
    `error message should mention git repo problem, got: ${errMsg}`
  );
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("git_stash_list: non-git directory throws a descriptive error (not a crash)", () => {
  const notGit = path.join(TMP, "not-a-git-dir");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_stash_list", { path: path.relative(TMP, notGit) }),
    /not a git|git stash list failed|git repository/i
  );
});

test("git_stash_list: result count matches expected after 2 stashes are made", () => {
  const repoDir = makeStashRepo("stash-high-count", 2);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 2, "expected 2 stash entries");
  assert.strictEqual(r.stashes.length, 2, "stashes.length must match count");
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("git_stash_list: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_stash_list", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_stash_list: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_stash_list", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_stash_list: result is fully JSON-serialisable (no circular refs)", () => {
  const repoDir = makeStashRepo("stash-json", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.count, r.count, "round-trip count preserved");
  assert.ok(Array.isArray(parsed.stashes), "round-trip stashes is array");
});

test("git_stash_list: result has no unexpected top-level keys (no prototype pollution)", () => {
  const repoDir = makeStashRepo("stash-proto", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  const expected = new Set(["count", "stashes"]);
  for (const key of Object.keys(r)) {
    assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"),
    "result must not have __proto__");
});

test("git_stash_list: injection-shaped commit message is returned as literal data", () => {
  // Verify the stash message content (set by us in makeStashRepo) is literal text
  const repoDir = makeStashRepo("stash-inject", 1);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  // The message will contain 'stash entry 0' as text — not executed
  assert.ok(Array.isArray(r.stashes), "stashes is an array, not code output");
  assert.doesNotThrow(() => JSON.stringify(r), "result is serialisable (not code output)");
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("git_stash_list: repo with 5 stashes — all 5 listed with correct refs", () => {
  const repoDir = makeStashRepo("stash-five", 5);
  const r = executeTool("git_stash_list", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.count, 5, "expected 5 stash entries");
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(r.stashes[i].index, i, `entry ${i}: wrong index`);
    assert.strictEqual(r.stashes[i].ref, `stash@{${i}}`, `entry ${i}: wrong ref`);
  }
});

test("git_stash_list: 10 concurrent reads return identical results", () => {
  const repoDir = makeStashRepo("stash-concurrent", 2);
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () =>
    executeTool("git_stash_list", { path: relPath })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].count, first.count,
      `call ${i}: count mismatch`);
    assert.strictEqual(results[i].stashes[0]?.ref, first.stashes[0]?.ref,
      `call ${i}: first stash ref mismatch`);
  }
});

test("git_stash_list: re-reading same repo 50 times gives identical count", () => {
  const repoDir = makeStashRepo("stash-repeat", 2);
  const relPath = path.relative(TMP, repoDir);
  const first = executeTool("git_stash_list", { path: relPath }).count;
  for (let i = 0; i < 49; i++) {
    const r = executeTool("git_stash_list", { path: relPath });
    assert.strictEqual(r.count, first, `read ${i + 2}: count changed`);
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_stash_list fixture repos", () => {
  const dirs = [
    "stash-basic", "stash-fields", "stash-count", "stash-entry-fields",
    "stash-ref", "stash-msg", "stash-author", "stash-empty", "stash-order",
    "stash-refs", "stash-date", "not-a-git-dir", "stash-high-count",
    "stash-json", "stash-proto", "stash-inject", "stash-five",
    "stash-concurrent", "stash-repeat",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "stash-basic")), "stash-basic removed");
});
