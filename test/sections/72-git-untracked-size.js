"use strict";
/**
 * [72] GIT_UNTRACKED_SIZE — sum size of untracked files in a repo
 *
 * Uses a fresh, isolated git repo in its own temp dir (same pattern as
 * 04-git-tools.js) — calls gitUntrackedSize() directly for isolated testing.
 *
 * Rigor levels:
 *   Normal:   untracked file's size summed correctly, fileCount/totalBytes right.
 *   Medium:   tracked (committed) files are excluded; empty repo -> 0/0.
 *   High:     .gitignore'd files excluded automatically (git status behavior);
 *             top_n caps the largest list.
 *   Critical: filenames with spaces/special chars handled (NUL-separated -z
 *             output avoids quoting ambiguity).
 *   Extreme:  many untracked files (30) summed without crashing; largest
 *             list sorted descending.
 */
const { fs, os, path, assert, test } = require("../test-harness");
const cp = require("child_process");
const { gitUntrackedSize } = require("../../lib/gitUntrackedSizeOps");

console.log(`\n[72] GIT_UNTRACKED_SIZE — untracked file size summary`);

const GIT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-git-untracked-test-"));
function gitTmp(cmd) {
  return cp.execSync(`git ${cmd}`, {
    cwd: GIT_TMP, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t.com",
           GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t.com" },
  }).trim();
}

gitTmp("init -b main");
gitTmp("config user.email t@t.com");
gitTmp("config user.name Test");

test("medium: empty repo (nothing untracked) -> fileCount 0, totalBytes 0", () => {
  const r = gitUntrackedSize(GIT_TMP, "repo");
  assert.strictEqual(r.fileCount, 0);
  assert.strictEqual(r.totalBytes, 0);
  assert.strictEqual(r.totalHumanSize, "0 B");
});

test("normal: untracked file size summed correctly", () => {
  fs.writeFileSync(path.join(GIT_TMP, "loose.txt"), "x".repeat(500));
  const r = gitUntrackedSize(GIT_TMP, "repo");
  assert.strictEqual(r.fileCount, 1);
  assert.strictEqual(r.totalBytes, 500);
  assert.strictEqual(r.largest[0].file, "repo/loose.txt");
});

test("medium: tracked (committed) files excluded", () => {
  gitTmp("add loose.txt");
  gitTmp('commit -m "track loose.txt"');
  const r = gitUntrackedSize(GIT_TMP, "repo");
  assert.strictEqual(r.fileCount, 0);
});

test("high: .gitignore'd files excluded automatically", () => {
  fs.writeFileSync(path.join(GIT_TMP, ".gitignore"), "ignored.log\n");
  gitTmp("add .gitignore");
  gitTmp('commit -m "add gitignore"');
  fs.writeFileSync(path.join(GIT_TMP, "ignored.log"), "should not count");
  fs.writeFileSync(path.join(GIT_TMP, "counted.txt"), "should count");
  const r = gitUntrackedSize(GIT_TMP, "repo");
  assert.strictEqual(r.fileCount, 1);
  assert.strictEqual(r.largest[0].file, "repo/counted.txt");
  fs.unlinkSync(path.join(GIT_TMP, "ignored.log"));
  fs.unlinkSync(path.join(GIT_TMP, "counted.txt"));
});

test("high: top_n caps the largest list", () => {
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(GIT_TMP, `u${i}.txt`), "y".repeat(10 + i));
  const r = gitUntrackedSize(GIT_TMP, "repo", { topN: 2 });
  assert.strictEqual(r.largest.length, 2);
  assert.strictEqual(r.fileCount, 5); // fileCount reflects all, only `largest` list is capped
  for (let i = 0; i < 5; i++) fs.unlinkSync(path.join(GIT_TMP, `u${i}.txt`));
});

test("critical: filenames with spaces handled correctly", () => {
  fs.writeFileSync(path.join(GIT_TMP, "file with spaces.txt"), "z".repeat(42));
  const r = gitUntrackedSize(GIT_TMP, "repo");
  assert.strictEqual(r.fileCount, 1);
  assert.strictEqual(r.largest[0].file, "repo/file with spaces.txt");
  assert.strictEqual(r.largest[0].bytes, 42);
  fs.unlinkSync(path.join(GIT_TMP, "file with spaces.txt"));
});

test("extreme: 30 untracked files summed without crashing, largest sorted desc", () => {
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(GIT_TMP, `bulk${i}.dat`), "w".repeat(100 + i * 10));
  const r = gitUntrackedSize(GIT_TMP, "repo", { topN: 500 });
  assert.strictEqual(r.fileCount, 30);
  for (let i = 1; i < r.largest.length; i++) {
    assert.ok(r.largest[i - 1].bytes >= r.largest[i].bytes);
  }
  for (let i = 0; i < 30; i++) fs.unlinkSync(path.join(GIT_TMP, `bulk${i}.dat`));
});

test("cleanup: remove temp git repo", () => {
  fs.rmSync(GIT_TMP, { recursive: true, force: true });
});
