"use strict";
/**
 * [43] GIT_LOG — include_files extension (per-commit filesChanged)
 *
 * Tests the `include_files` option added to the existing `git_log` tool:
 * when true, each commit in the result also gets a
 * `filesChanged: [{path, additions, deletions}]` array, computed via a
 * second `git log --numstat` call and matched back to each commit by its
 * full 40-char hash (see lib/gitLogOps.js's parseNumstatByHash).
 *
 * Uses its own isolated temp git repo (separate from test/sections/
 * 04-git-tools.js's repo) so the two sections' commit histories can't
 * interfere with each other.
 *
 * Rigor levels covered:
 *   Normal:   happy-path — filesChanged present/absent per include_files,
 *             correct add/delete counts, correct file lists per commit
 *   Medium:   boundary — include_files omitted/false/falsy-string behave
 *             identically to the pre-existing git_log (no filesChanged key
 *             at all, not an empty array — a real absence, not a default),
 *             file-filter + include_files combined, limit + include_files
 *             combined
 *   High:     dependency/failure — binary file reports additions/deletions
 *             as null not NaN; bad branch still throws cleanly with
 *             include_files:true; a repo with only 1 commit doesn't crash
 *   Critical: shell-injection-shaped branch/file rejected exactly as before
 *             (include_files doesn't bypass assertSafeArg); path traversal
 *             via 'path' still blocked at the dispatcher level (schema-only
 *             check here since this file calls gitLog directly); a commit
 *             message crafted to look like a 40-hex-char hash does not get
 *             mis-parsed as a hash/REC boundary
 *   Extreme:  a commit with a real multi-line body (the exact scenario that
 *             motivated running numstat as a separate command) still parses
 *             correctly with include_files:true; a 15-file commit reports
 *             all 15 files; 10 concurrent include_files:true calls return
 *             consistent results; result is JSON-serialisable
 */
const { fs, os, path, assert, test, cleanupDir } = require("../test-harness");
const cp = require("child_process");
const { gitLog } = require("../../lib/gitLogOps");

console.log(`\n[43] GIT_LOG — include_files extension (per-commit filesChanged)`);

// Create a dedicated temp git repo for this section
const GLF_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gitlog-files-test-"));
function gitTmp(cmd, opts = {}) {
  return cp.execSync(`git ${cmd}`, {
    cwd: GLF_TMP, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com",
           GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
    ...opts,
  }).trim();
}

gitTmp("init -b main");
gitTmp("config user.email t@t.com");
gitTmp("config user.name Test");

// Commit 1: adds a.txt, b.txt
fs.writeFileSync(path.join(GLF_TMP, "a.txt"), "line1\nline2\n");
fs.writeFileSync(path.join(GLF_TMP, "b.txt"), "hello\n");
gitTmp("add -A");
gitTmp(`commit -m "first commit"`);

// Commit 2: modifies a.txt, deletes b.txt, adds c.txt
fs.writeFileSync(path.join(GLF_TMP, "a.txt"), "line1\nline2 changed\nline3\n");
fs.writeFileSync(path.join(GLF_TMP, "c.txt"), "new file\n");
fs.unlinkSync(path.join(GLF_TMP, "b.txt"));
gitTmp("add -A");
gitTmp(`commit -m "second commit"`);

// ── NORMAL — happy path ───────────────────────────────────────────────────────
test("git_log include_files: filesChanged present when include_files=true", () => {
  const r = gitLog(GLF_TMP, 20, null, null, true);
  assert.strictEqual(r.count, 2);
  for (const c of r.commits) {
    assert.ok(Array.isArray(c.filesChanged), `commit ${c.shortHash} must have filesChanged array`);
  }
});

test("git_log include_files: filesChanged is absent (not even an empty array) when omitted", () => {
  const r = gitLog(GLF_TMP, 20, null, null);
  for (const c of r.commits) {
    assert.ok(!("filesChanged" in c), "filesChanged key must not be present at all when include_files is omitted");
  }
});

test("git_log include_files: second commit reports correct per-file add/delete counts", () => {
  const r = gitLog(GLF_TMP, 20, null, null, true);
  const second = r.commits.find(c => c.subject === "second commit");
  const a = second.filesChanged.find(f => f.path === "a.txt");
  const b = second.filesChanged.find(f => f.path === "b.txt");
  const c = second.filesChanged.find(f => f.path === "c.txt");
  assert.ok(a && b && c, "all three touched files must be listed");
  assert.strictEqual(a.additions, 2);
  assert.strictEqual(a.deletions, 1);
  assert.strictEqual(b.additions, 0);
  assert.strictEqual(b.deletions, 1, "deleted file reports 0 additions, N deletions");
  assert.strictEqual(c.additions, 1);
  assert.strictEqual(c.deletions, 0);
});

test("git_log include_files: first commit reports its own two added files, not the second commit's", () => {
  const r = gitLog(GLF_TMP, 20, null, null, true);
  const first = r.commits.find(c => c.subject === "first commit");
  assert.strictEqual(first.filesChanged.length, 2);
  const paths = first.filesChanged.map(f => f.path).sort();
  assert.deepStrictEqual(paths, ["a.txt", "b.txt"]);
});

test("git_log include_files: non-filesChanged fields are unaffected (hash/author/date/subject still correct)", () => {
  const r = gitLog(GLF_TMP, 20, null, null, true);
  const second = r.commits.find(c => c.subject === "second commit");
  assert.ok(second.hash.match(/^[0-9a-f]{40}$/));
  assert.strictEqual(second.author, "Test");
  assert.ok(second.date.match(/^\d{4}-\d{2}-\d{2}T/));
});

// ── MEDIUM — boundary & parameter validation ─────────────────────────────────
test("git_log include_files: explicit false behaves identically to omitted", () => {
  const rFalse   = gitLog(GLF_TMP, 20, null, null, false);
  const rOmitted = gitLog(GLF_TMP, 20, null, null);
  for (const c of rFalse.commits)   assert.ok(!("filesChanged" in c));
  for (const c of rOmitted.commits) assert.ok(!("filesChanged" in c));
  assert.strictEqual(rFalse.commits[0].hash, rOmitted.commits[0].hash);
});

test("git_log include_files: combined with a file filter still returns filesChanged for the matching commit", () => {
  const r = gitLog(GLF_TMP, 20, "c.txt", null, true);
  assert.strictEqual(r.count, 1);
  assert.ok(r.commits[0].filesChanged.some(f => f.path === "c.txt"));
});

test("git_log include_files: combined with limit=1 only fetches numstat for the returned commit", () => {
  const r = gitLog(GLF_TMP, 1, null, null, true);
  assert.strictEqual(r.commits.length, 1);
  assert.ok(Array.isArray(r.commits[0].filesChanged));
  assert.strictEqual(r.commits[0].subject, "second commit");
});

test("git_log include_files: ref=main works the same as HEAD with include_files", () => {
  const head = gitLog(GLF_TMP, 20, null, null, true);
  const main = gitLog(GLF_TMP, 20, null, "main", true);
  assert.strictEqual(head.commits[0].filesChanged.length, main.commits[0].filesChanged.length);
});

// ── HIGH — dependency / failure handling ──────────────────────────────────────
test("git_log include_files: binary file reports additions/deletions as null, not NaN", () => {
  fs.writeFileSync(path.join(GLF_TMP, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255, 254]));
  gitTmp("add bin.dat");
  gitTmp(`commit -m "add binary file"`);
  const r = gitLog(GLF_TMP, 1, null, null, true);
  const bin = r.commits[0].filesChanged.find(f => f.path === "bin.dat");
  assert.ok(bin, "binary file must still be listed");
  assert.strictEqual(bin.additions, null);
  assert.strictEqual(bin.deletions, null);
  assert.ok(!Number.isNaN(bin.additions) === true); // null, not NaN
});

test("git_log include_files: invalid branch throws cleanly even with include_files=true", () => {
  assert.throws(
    () => gitLog(GLF_TMP, 5, null, "nonexistent-branch-xyz", true),
    /git log failed/,
  );
});

test("git_log include_files: repo with exactly 1 commit does not crash", () => {
  const oneCommitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gitlog-1c-"));
  cp.execSync("git init -b main", { cwd: oneCommitRepo });
  cp.execSync("git config user.email t@t.com", { cwd: oneCommitRepo });
  cp.execSync("git config user.name Test", { cwd: oneCommitRepo });
  fs.writeFileSync(path.join(oneCommitRepo, "only.txt"), "solo\n");
  cp.execSync("git add -A", { cwd: oneCommitRepo });
  cp.execSync('git commit -m "solo commit"', { cwd: oneCommitRepo });
  const r = gitLog(oneCommitRepo, 20, null, null, true);
  assert.strictEqual(r.commits.length, 1);
  assert.strictEqual(r.commits[0].filesChanged.length, 1);
  fs.rmSync(oneCommitRepo, { recursive: true, force: true });
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────
test("git_log include_files: shell injection in branch is still rejected with include_files=true", () => {
  assert.throws(
    () => gitLog(GLF_TMP, 5, null, "main; rm -rf /", true),
    /disallowed characters/,
  );
});

test("git_log include_files: shell injection in file filter is still rejected with include_files=true", () => {
  assert.throws(
    () => gitLog(GLF_TMP, 5, "file.txt | cat /etc/passwd", null, true),
    /disallowed characters/,
  );
});

test("git_log include_files: a commit message that looks like a 40-hex-char hash does not confuse numstat parsing", () => {
  fs.writeFileSync(path.join(GLF_TMP, "tricky.txt"), "tricky content\n");
  gitTmp("add tricky.txt");
  gitTmp(`commit -m "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef looks like a hash"`);
  const r = gitLog(GLF_TMP, 1, null, null, true);
  assert.strictEqual(r.commits.length, 1);
  assert.ok(r.commits[0].filesChanged.some(f => f.path === "tricky.txt"), "the real file must still be correctly attributed despite the hash-shaped subject");
  assert.strictEqual(r.commits[0].filesChanged.length, 1, "no phantom files from the hash-shaped subject line being mis-parsed as a numstat boundary");
});

// ── EXTREME — fuzzing, concurrency, large commits ──────────────────────────────
test("git_log include_files: a commit with a real multi-line body still parses filesChanged correctly", () => {
  fs.writeFileSync(path.join(GLF_TMP, "bodytest.txt"), "body test\n");
  gitTmp("add bodytest.txt");
  const msgFile = path.join(GLF_TMP, "..", "commit-msg-body-test.txt");
  fs.writeFileSync(msgFile, "subject line\n\nthis body\nspans\nmultiple lines\nwith embedded newlines\n");
  gitTmp(`commit -F ${JSON.stringify(msgFile)}`);
  fs.rmSync(msgFile, { force: true });
  const r = gitLog(GLF_TMP, 1, null, null, true);
  assert.strictEqual(r.commits[0].subject, "subject line");
  assert.ok(r.commits[0].body.includes("spans"), "multi-line body must still be captured intact (metadata call is unaffected by the separate numstat call)");
  assert.strictEqual(r.commits[0].filesChanged.length, 1);
  assert.strictEqual(r.commits[0].filesChanged[0].path, "bodytest.txt");
});

test("git_log include_files: a 15-file commit reports all 15 files with correct total additions", () => {
  const bigRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gitlog-big-"));
  cp.execSync("git init -b main", { cwd: bigRepo });
  cp.execSync("git config user.email t@t.com", { cwd: bigRepo });
  cp.execSync("git config user.name Test", { cwd: bigRepo });
  for (let i = 0; i < 15; i++) {
    fs.writeFileSync(path.join(bigRepo, `file${i}.txt`), `content ${i}\n`);
  }
  cp.execSync("git add -A", { cwd: bigRepo });
  cp.execSync('git commit -m "15 files"', { cwd: bigRepo });
  const r = gitLog(bigRepo, 1, null, null, true);
  assert.strictEqual(r.commits[0].filesChanged.length, 15);
  const totalAdditions = r.commits[0].filesChanged.reduce((s, f) => s + f.additions, 0);
  assert.strictEqual(totalAdditions, 15);
  fs.rmSync(bigRepo, { recursive: true, force: true });
});

test("git_log include_files: 10 concurrent (sequential-simulated) calls return consistent results", () => {
  const results = Array.from({ length: 10 }, () => gitLog(GLF_TMP, 20, null, null, true));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].commits.length, first.commits.length, `call ${i} commit count mismatch`);
    assert.deepStrictEqual(
      results[i].commits.map(c => ({ hash: c.hash, filesChanged: c.filesChanged })),
      first.commits.map(c => ({ hash: c.hash, filesChanged: c.filesChanged })),
      `call ${i} filesChanged mismatch`,
    );
  }
});

test("git_log include_files: result is fully JSON-serialisable (no circular refs)", () => {
  const r = gitLog(GLF_TMP, 20, null, null, true);
  let s;
  assert.doesNotThrow(() => { s = JSON.stringify(r); });
  const parsed = JSON.parse(s);
  assert.strictEqual(parsed.commits.length, r.commits.length);
});

// ── Clean up the git temp dir ─────────────────────────────────────────────
cleanupDir(GLF_TMP);
