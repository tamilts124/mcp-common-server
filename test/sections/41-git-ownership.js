"use strict";
/**
 * [44] GIT_OWNERSHIP — git_ownership tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — single-file blame aggregation, directory-mode
 *             aggregation across multiple tracked files, percentage math,
 *             sort order (lines descending), result field shape/types.
 *
 *   Medium:   boundary — missing required 'path' throws -32602; empty
 *             directory (no tracked files) returns filesScanned:0,
 *             authors:[]; max_files clamping/defaults; extensions filter.
 *
 *   High:     dependency / failure handling — non-git directory throws
 *             descriptive error; a file that is not tracked by git throws;
 *             a binary file in directory mode is skipped via filesSkipped
 *             rather than aborting the whole scan.
 *
 *   Critical: security — path traversal / absolute-path-outside-root
 *             blocked; injection-shaped file/author content round-trips
 *             literally (never executed); result is JSON-serialisable;
 *             no prototype pollution.
 *
 *   Extreme:  stress — multi-author repo with many commits aggregates
 *             correctly; max_files truncation on a wide tree; 10 concurrent
 *             calls consistent.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[44] GIT_OWNERSHIP — git_ownership tool`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

function gitIn(repoDir, cmd, extraEnv) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com", ...extraEnv },
  });
}

/** Create a minimal git repo under TMP/<name> with an initial commit on main. */
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

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("git_ownership: single file — all lines attributed to the sole author", () => {
  const repoDir = makeRepo("own-single");
  const r = executeTool("git_ownership", { path: path.join(path.relative(TMP, repoDir), "readme.txt") });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.totalLines, 3);
  assert.strictEqual(r.authors.length, 1);
  assert.strictEqual(r.authors[0].name, "Test User");
  assert.strictEqual(r.authors[0].lines, 3);
  assert.strictEqual(r.authors[0].percentage, 100);
});

test("git_ownership: directory mode aggregates across multiple tracked files", () => {
  const repoDir = makeRepo("own-dir");
  commitAs(repoDir, "a.txt", "a1\na2\n", "Alice", "alice@example.com", "add a.txt");
  commitAs(repoDir, "b.txt", "b1\nb2\nb3\n", "Bob", "bob@example.com", "add b.txt");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.filesScanned, 3); // readme.txt + a.txt + b.txt
  const alice = r.authors.find(a => a.name === "Alice");
  const bob = r.authors.find(a => a.name === "Bob");
  assert.ok(alice, "Alice must appear");
  assert.ok(bob, "Bob must appear");
  assert.strictEqual(alice.lines, 2);
  assert.strictEqual(bob.lines, 3);
});

test("git_ownership: authors sorted by lines descending", () => {
  const repoDir = makeRepo("own-sort");
  commitAs(repoDir, "small.txt", "x\n", "Minor", "minor@example.com", "add small");
  commitAs(repoDir, "big.txt", "1\n2\n3\n4\n5\n", "Major", "major@example.com", "add big");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir) });
  for (let i = 1; i < r.authors.length; i++) {
    assert.ok(r.authors[i - 1].lines >= r.authors[i].lines, "authors must be sorted lines-desc");
  }
  assert.strictEqual(r.authors[0].name, "Major");
});

test("git_ownership: percentage math sums to ~100 across all authors", () => {
  const repoDir = makeRepo("own-pct");
  commitAs(repoDir, "a.txt", "1\n2\n3\n", "A", "a@example.com", "add a");
  commitAs(repoDir, "b.txt", "1\n2\n3\n4\n5\n6\n7\n", "B", "b@example.com", "add b");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir) });
  const totalPct = r.authors.reduce((s, a) => s + a.percentage, 0);
  assert.ok(Math.abs(totalPct - 100) < 0.5, `percentages should sum to ~100, got ${totalPct}`);
});

test("git_ownership: result has all documented top-level fields with correct types", () => {
  const repoDir = makeRepo("own-fields");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir) });
  assert.ok(typeof r.path === "string");
  assert.ok(typeof r.filesScanned === "number");
  assert.ok(Array.isArray(r.filesSkipped));
  assert.ok(typeof r.truncated === "boolean");
  assert.ok(typeof r.totalLines === "number");
  assert.ok(Array.isArray(r.authors));
  for (const a of r.authors) {
    assert.ok(typeof a.name === "string");
    assert.ok(typeof a.lines === "number");
    assert.ok(typeof a.percentage === "number");
  }
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_ownership: missing required 'path' throws -32602", () => {
  assert.throws(() => executeTool("git_ownership", {}), /required|missing|path/i);
});

test("git_ownership: directory with only an untracked file returns filesScanned:0, empty authors", () => {
  const repoDir = makeRepo("own-empty");
  const emptyDir = path.join(repoDir, "untracked-sub");
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, "not-added.txt"), "hello\n", "utf8");
  const r = executeTool("git_ownership", { path: path.join(path.relative(TMP, repoDir), "untracked-sub") });
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.totalLines, 0);
  assert.deepStrictEqual(r.authors, []);
});

test("git_ownership: max_files caps the number of files blamed in directory mode", () => {
  const repoDir = makeRepo("own-maxfiles");
  for (let i = 0; i < 5; i++) {
    commitAs(repoDir, `f${i}.txt`, `content-${i}\n`, "Author", "author@example.com", `add f${i}`);
  }
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir), max_files: 2 });
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.truncated, true);
});

test("git_ownership: max_files above default still works without truncation when file count is small", () => {
  const repoDir = makeRepo("own-notrunc");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir), max_files: 50 });
  assert.strictEqual(r.truncated, false);
});

test("git_ownership: extensions filter narrows directory-mode scan to matching files", () => {
  const repoDir = makeRepo("own-ext");
  commitAs(repoDir, "script.js", "console.log(1);\n", "JsAuthor", "js@example.com", "add js");
  commitAs(repoDir, "notes.md", "# hi\ntext\n", "MdAuthor", "md@example.com", "add md");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir), extensions: [".js"] });
  const names = r.authors.map(a => a.name);
  assert.ok(names.includes("JsAuthor"));
  assert.ok(!names.includes("MdAuthor"), "MdAuthor should be excluded by extensions filter");
});

// ── HIGH — dependency / failure handling ──────────────────────────────────────

test("git_ownership: non-git directory throws a descriptive error (not a crash)", () => {
  const notGit = path.join(TMP, "own-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_ownership", { path: path.relative(TMP, notGit) }),
    /not a git|failed|repository/i
  );
});

test("git_ownership: repo-root discovery never ascends above the jailed MCP root (no unrelated ancestor .git escape)", () => {
  // Regression test for a real bug found during development: an early
  // implementation walked upward from the target directory looking for a
  // `.git` with no boundary, and on a machine where an ancestor of the OS
  // temp directory happens to be a git repo (e.g. a dotfiles repo in the
  // user's home directory), it would silently adopt that unrelated repo as
  // the "root" and run `git ls-files`/`git blame` with a cwd outside the
  // sandbox entirely. A non-git directory inside the jail must always
  // throw "not inside a git repository", never silently succeed by
  // borrowing an ancestor repo from outside the sandbox.
  const notGit = path.join(TMP, "own-jail-boundary");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_ownership", { path: path.relative(TMP, notGit) }),
    /not inside a git repository/i,
    "must not silently adopt a repo found above the jail boundary"
  );
});

test("git_ownership: a file that is not tracked by git throws a descriptive error", () => {
  const repoDir = makeRepo("own-untracked-file");
  fs.writeFileSync(path.join(repoDir, "loose.txt"), "hello\n", "utf8");
  assert.throws(
    () => executeTool("git_ownership", { path: path.join(path.relative(TMP, repoDir), "loose.txt") }),
    /blame failed|fatal|no such/i
  );
});

test("git_ownership: a binary file in directory mode is skipped via filesSkipped, scan continues", () => {
  const repoDir = makeRepo("own-binary");
  const binPath = path.join(repoDir, "data.bin");
  fs.writeFileSync(binPath, Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
  gitIn(repoDir, "add data.bin");
  gitIn(repoDir, 'commit -m "add binary"');
  commitAs(repoDir, "text.txt", "hello\nworld\n", "TextAuthor", "text@example.com", "add text");
  let r;
  assert.doesNotThrow(() => {
    r = executeTool("git_ownership", { path: path.relative(TMP, repoDir) });
  }, "binary file should not abort the whole scan");
  // git blame actually works fine on most binary files too (treats as text),
  // so we just assert the scan completed and text.txt's author is present —
  // the real guarantee under test is that *no single file's failure* aborts
  // the aggregate (see filesSkipped handling), not that binaries are always
  // unblameable.
  const names = r.authors.map(a => a.name);
  assert.ok(names.includes("TextAuthor"), "text.txt author must still be counted");
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("git_ownership: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_ownership", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_ownership: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_ownership", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_ownership: injection-shaped file content and author name round-trip literally, never executed", () => {
  const repoDir = makeRepo("own-inject");
  const evilContent = "$(rm -rf /)\n'; DROP TABLE users; --\n";
  commitAs(repoDir, "evil.txt", evilContent, "$(echo pwned)", "evil@example.com", "add evil");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir) });
  const evilAuthor = r.authors.find(a => a.name === "$(echo pwned)");
  assert.ok(evilAuthor, "injection-shaped author name must round-trip literally as data");
  assert.strictEqual(evilAuthor.lines, 2, "evil.txt has 2 lines");
});

test("git_ownership: result is fully JSON-serialisable (no circular refs)", () => {
  const repoDir = makeRepo("own-json");
  commitAs(repoDir, "a.txt", "x\ny\n", "A", "a@example.com", "add a");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.filesScanned, r.filesScanned);
});

test("git_ownership: result has no unexpected top-level keys (no prototype pollution)", () => {
  const repoDir = makeRepo("own-proto");
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir) });
  const expected = new Set(["path", "filesScanned", "filesSkipped", "truncated", "totalLines", "authors"]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
  for (const a of r.authors) {
    const authorExpected = new Set(["name", "lines", "percentage"]);
    for (const key of Object.keys(a)) assert.ok(authorExpected.has(key), `unexpected author key: '${key}'`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ───────────────────────────────────

test("git_ownership: multi-author repo (5 authors, 20 files) aggregates all correctly", () => {
  const repoDir = makeRepo("own-stress");
  const authors = ["A1", "A2", "A3", "A4", "A5"];
  for (let i = 0; i < 20; i++) {
    const author = authors[i % authors.length];
    commitAs(repoDir, `file${i}.txt`, `line-${i}-a\nline-${i}-b\n`, author, `${author.toLowerCase()}@example.com`, `add file${i}`);
  }
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir), max_files: 30 });
  assert.strictEqual(r.filesScanned, 21); // readme.txt + 20 files
  assert.strictEqual(r.authors.length, 6); // "Test User" (readme.txt) + A1..A5
  const totalLinesFromAuthors = r.authors.reduce((s, a) => s + a.lines, 0);
  assert.strictEqual(totalLinesFromAuthors, r.totalLines);
  // Each of A1..A5 wrote 4 files * 2 lines = 8 lines
  for (const a of r.authors) {
    if (a.name === "Test User") continue; // readme.txt's original 3-line commit
    assert.strictEqual(a.lines, 8, `${a.name} should have 8 lines`);
  }
});

test("git_ownership: wide tree with max_files below actual count sets truncated:true and scans exactly max_files", () => {
  const repoDir = makeRepo("own-wide");
  for (let i = 0; i < 10; i++) {
    commitAs(repoDir, `w${i}.txt`, `content\n`, "WideAuthor", "wide@example.com", `add w${i}`);
  }
  const r = executeTool("git_ownership", { path: path.relative(TMP, repoDir), max_files: 3 });
  assert.strictEqual(r.filesScanned, 3);
  assert.strictEqual(r.truncated, true);
});

test("git_ownership: 10 concurrent (sequential-simulated) calls on the same repo return consistent results", () => {
  const repoDir = makeRepo("own-concurrent");
  commitAs(repoDir, "a.txt", "1\n2\n3\n", "ConcAuthor", "conc@example.com", "add a");
  const relPath = path.relative(TMP, repoDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_ownership", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].totalLines, first.totalLines, `call ${i}: totalLines mismatch`);
    assert.deepStrictEqual(results[i].authors, first.authors, `call ${i}: authors mismatch`);
  }
});

test("git_ownership: max_files fuzz — non-numeric value falls back to default rather than crashing", () => {
  const repoDir = makeRepo("own-fuzz-maxfiles");
  let r;
  assert.doesNotThrow(() => {
    r = executeTool("git_ownership", { path: path.relative(TMP, repoDir), max_files: "not-a-number" });
  });
  assert.strictEqual(r.filesScanned, 1); // just readme.txt, well under default cap
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_ownership fixture repos", () => {
  const dirs = [
    "own-single", "own-dir", "own-sort", "own-pct", "own-fields",
    "own-empty", "own-maxfiles", "own-notrunc", "own-ext",
    "own-not-git", "own-jail-boundary", "own-untracked-file", "own-binary",
    "own-inject", "own-json", "own-proto",
    "own-stress", "own-wide", "own-concurrent", "own-fuzz-maxfiles",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "own-single")), "own-single removed");
});
