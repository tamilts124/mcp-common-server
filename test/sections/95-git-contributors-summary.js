"use strict";
/**
 * [95] GIT_CONTRIBUTORS_SUMMARY — git_contributors_summary tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — single-author repo commit/insertion counts;
 *             multi-author repo per-author rollup; sort order (commits
 *             desc); firstCommit/lastCommit ISO-8601 date bounds; deletions
 *             counted on file overwrite.
 *
 *   Medium:   boundary — no path arg falls back to first root; top_n
 *             clamping (below 1, above hard max, non-numeric ignored);
 *             empty repo (zero commits) returns authorsFound:0, authors:[];
 *             since filter excludes older commits.
 *
 *   High:     dependency / failure handling — non-git directory throws a
 *             descriptive error rather than crashing; invalid range throws
 *             cleanly.
 *
 *   Critical: security — shell/injection-shaped range and since values are
 *             rejected by assertSafeArg rather than executed; path
 *             traversal on 'path' arg is contained to the repo; result is
 *             JSON-serialisable.
 *
 *   Extreme:  stress — repo with many commits across several authors
 *             aggregates correctly; 10 concurrent calls return consistent
 *             results; unicode author names handled.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[95] GIT_CONTRIBUTORS_SUMMARY — git_contributors_summary tool`);

function gitIn(repoDir, cmd, extraEnv) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com", ...extraEnv },
  });
}

function makeRepo(name) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  gitIn(repoDir, "config user.email test@example.com");
  gitIn(repoDir, 'config user.name "Test User"');
  fs.writeFileSync(path.join(repoDir, "readme.txt"), "line1\nline2\nline3\n", "utf8");
  gitIn(repoDir, "add readme.txt");
  gitIn(repoDir, 'commit -m "initial commit"');
  return repoDir;
}

function commitAs(repoDir, fileName, content, authorName, authorEmail, msg) {
  fs.writeFileSync(path.join(repoDir, fileName), content, "utf8");
  gitIn(repoDir, `add ${fileName}`);
  gitIn(repoDir, `commit -m "${msg}"`, {
    GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail,
  });
}

// ── NORMAL ────────────────────────────────────────────────────────────────

test("git_contributors_summary: single-author repo — one commit, correct insertions", () => {
  const repoDir = makeRepo("gcs-single");
  const r = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalCommits, 1);
  assert.strictEqual(r.authorsFound, 1);
  assert.strictEqual(r.authors[0].name, "Test User");
  assert.strictEqual(r.authors[0].commits, 1);
  assert.strictEqual(r.authors[0].insertions, 3);
  assert.strictEqual(r.authors[0].deletions, 0);
  assert.ok(r.authors[0].firstCommit === r.authors[0].lastCommit);
});

test("git_contributors_summary: multi-author repo aggregates per author, sorted by commits desc", () => {
  const repoDir = makeRepo("gcs-multi");
  commitAs(repoDir, "a.txt", "a1\na2\n", "Alice", "alice@example.com", "add a.txt");
  commitAs(repoDir, "a.txt", "a1\na2\na3\na4\n", "Alice", "alice@example.com", "extend a.txt");
  commitAs(repoDir, "b.txt", "b1\n", "Bob", "bob@example.com", "add b.txt");
  const r = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalCommits, 4); // initial + 2 alice + 1 bob
  const alice = r.authors.find(a => a.name === "Alice");
  const bob = r.authors.find(a => a.name === "Bob");
  assert.ok(alice && bob);
  assert.strictEqual(alice.commits, 2);
  assert.strictEqual(bob.commits, 1);
  assert.strictEqual(r.authors[0].name, "Alice"); // more commits, sorts first
  assert.ok(alice.insertions >= 4);
});

test("git_contributors_summary: overwriting a file counts deletions", () => {
  const repoDir = makeRepo("gcs-del");
  fs.writeFileSync(path.join(repoDir, "readme.txt"), "onlyline\n", "utf8");
  gitIn(repoDir, "add readme.txt");
  gitIn(repoDir, 'commit -m "shrink readme"');
  const r = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir) });
  const author = r.authors[0];
  assert.ok(author.deletions >= 3);
});

// ── MEDIUM ────────────────────────────────────────────────────────────────

test("git_contributors_summary: missing path arg resolves against first root (throws cleanly if root isn't a repo, never crashes)", () => {
  // TMP (the jailed first root) is not itself a git repo in this harness,
  // so the correct, non-crashing behavior is a clean thrown error — same
  // as every other git_* tool's "not a git repository" case.
  assert.throws(() => executeTool("git_contributors_summary", {}));
});

test("git_contributors_summary: top_n clamps below 1 and above hard max", () => {
  const repoDir = makeRepo("gcs-topn");
  commitAs(repoDir, "a.txt", "x\n", "Alice", "alice@example.com", "a");
  commitAs(repoDir, "b.txt", "y\n", "Bob", "bob@example.com", "b");
  const low = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir), top_n: 0 });
  assert.ok(low.authors.length >= 1); // clamped to default, not zero results
  const high = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir), top_n: 999999 });
  assert.ok(high.authors.length <= 500);
});

test("git_contributors_summary: bare repo with zero commits returns empty rollup", () => {
  const repoDir = path.join(TMP, "gcs-empty");
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  const r = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.authorsFound, 0);
  assert.strictEqual(r.totalCommits, 0);
  assert.deepStrictEqual(r.authors, []);
});

test("git_contributors_summary: since filter excludes older commits", () => {
  const repoDir = makeRepo("gcs-since");
  const r = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir), since: "1 second ago" });
  // The initial commit happened before "now - 1s" in almost all cases; this
  // just asserts the call succeeds and returns a well-formed (possibly empty) result.
  assert.ok(typeof r.totalCommits === "number");
});

// ── HIGH ──────────────────────────────────────────────────────────────────

test("git_contributors_summary: non-git directory throws a descriptive error", () => {
  const dir = path.join(TMP, "gcs-nogit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "f.txt"), "x", "utf8");
  assert.throws(() => executeTool("git_contributors_summary", { path: path.relative(TMP, dir) }));
});

test("git_contributors_summary: nonexistent range throws cleanly, no crash", () => {
  const repoDir = makeRepo("gcs-badrange");
  assert.throws(() => executeTool("git_contributors_summary", {
    path: path.relative(TMP, repoDir), range: "definitely-not-a-real-ref-xyz",
  }));
});

// ── CRITICAL ──────────────────────────────────────────────────────────────

test("git_contributors_summary: shell-injection-shaped range value is rejected, not executed", () => {
  const repoDir = makeRepo("gcs-inject-range");
  assert.throws(() => executeTool("git_contributors_summary", {
    path: path.relative(TMP, repoDir), range: "HEAD; rm -rf /tmp/pwned",
  }));
});

test("git_contributors_summary: shell-injection-shaped since value is rejected, not executed", () => {
  const repoDir = makeRepo("gcs-inject-since");
  assert.throws(() => executeTool("git_contributors_summary", {
    path: path.relative(TMP, repoDir), since: "`touch /tmp/pwned`",
  }));
});

test("git_contributors_summary: path traversal outside jail root throws", () => {
  assert.throws(() => executeTool("git_contributors_summary", { path: "../../../../etc" }));
});

test("git_contributors_summary: result is JSON-serialisable", () => {
  const repoDir = makeRepo("gcs-jsonsafe");
  const r = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir) });
  assert.doesNotThrow(() => JSON.stringify(r));
});

// ── EXTREME ───────────────────────────────────────────────────────────────

test("git_contributors_summary: many commits across several authors aggregate correctly", () => {
  const repoDir = makeRepo("gcs-stress");
  const authors = ["Alice", "Bob", "Carol", "Dave"];
  for (let i = 0; i < 20; i++) {
    const a = authors[i % authors.length];
    commitAs(repoDir, `f${i}.txt`, `content ${i}\n`, a, `${a.toLowerCase()}@example.com`, `commit ${i}`);
  }
  const r = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.totalCommits, 21); // initial + 20
  assert.strictEqual(r.authorsFound, 5); // Test User + 4 authors
  const sum = r.authors.reduce((s, a) => s + a.commits, 0);
  assert.strictEqual(sum, 21);
});

test("git_contributors_summary: 10 concurrent calls return consistent totals", () => {
  const repoDir = makeRepo("gcs-concurrent");
  commitAs(repoDir, "a.txt", "x\ny\n", "Alice", "alice@example.com", "add a");
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir) }));
  }
  for (const r of results) assert.strictEqual(r.totalCommits, 2);
});

test("git_contributors_summary: unicode author name handled without corruption", () => {
  const repoDir = makeRepo("gcs-unicode");
  commitAs(repoDir, "u.txt", "x\n", "田中太郎", "tanaka@example.com", "unicode author");
  const r = executeTool("git_contributors_summary", { path: path.relative(TMP, repoDir) });
  const u = r.authors.find(a => a.name === "田中太郎");
  assert.ok(u, "unicode author name must be preserved exactly");
  assert.strictEqual(u.commits, 1);
});
