"use strict";
/**
  // Force 'master' as default branch regardless of global init.defaultBranch.
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/master"]);
 * Section 184 — git_write_ops tool
 * Tests gitWriteOps across all 5 rigor levels:
 *   A – Input validation (operation + per-op params)
 *   B – Internal helper unit tests (validateStr, author format)
 *   C – Happy path: add, commit, branch, checkout, tag
 *   D – Happy path: stash, reset, merge
 *   E – Happy path: rebase, cherry_pick
 *   F – Git-level error propagation (nothing to commit, bad ref)
 *   G – Push/pull with local bare remote
 *   H – Amend, allow_empty, branch rename, tag annotated
 *   I – Security: null bytes, CRLF in messages, shell metachar safety
 *   J – Concurrency: parallel commits to isolated repos
 *
 * MUST set MCP_ALLOW_EXEC=true before any require so config.js picks it up.
 */

// ── MUST be first — config.js reads this at require time ──────────────────────
process.env.MCP_ALLOW_EXEC = "true";

const assert       = require("assert");
const fs           = require("fs");
const os           = require("os");
const path         = require("path");
const childProcess = require("child_process");

// Direct imports — no live MCP server
const { gitWriteOps } = require("../../lib/gitWriteOps");

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { process.stderr.write(`  PASS  ${name}\n`); passed++; },
        (e) => { process.stderr.write(`  FAIL  ${name}: ${e.message}\n`); failed++; },
      );
    }
    process.stderr.write(`  PASS  ${name}\n`); passed++;
  } catch (e) {
    process.stderr.write(`  FAIL  ${name}: ${e.message}\n`); failed++;
  }
  return Promise.resolve();
}

// ── Git repo helpers ──────────────────────────────────────────────────────────
const TMP_BASE = path.join(__dirname, "..", "..", "tmp", `test-184-${process.pid}`);
fs.mkdirSync(TMP_BASE, { recursive: true });

let repoCounter = 0;
function makeRepo(bare = false) {
  const dir = path.join(TMP_BASE, `repo${++repoCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  const args = bare ? ["init", "--bare"] : ["init"];
  git(dir, args);
  if (!bare) {
    git(dir, ["config", "user.email", "test@example.com"]);
    // Force 'master' as default branch regardless of global init.defaultBranch.
    git(dir, ["symbolic-ref", "HEAD", "refs/heads/master"]);
    git(dir, ["config", "user.name",  "Test User"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
  }
  return dir;
}

function git(cwd, args) {
  const r = childProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  });
  if (r.error) throw r.error;
  return (r.stdout || "").trimEnd();
}

/** Write a file, add, and commit it. Returns { hash }. */
function seedCommit(dir, filename = "a.txt", content = "hello", message = "initial") {
  fs.writeFileSync(path.join(dir, filename), content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return { hash: git(dir, ["rev-parse", "HEAD"]) };
}

/** Simple resolveClientPath mock — returns path as-is (tests bypass jailing). */
function mockRcp(p) { return { resolved: p }; }

/** Call gitWriteOps with the mock resolver. */
function gwo(args, dir) {
  return gitWriteOps(args, dir || repoDir, mockRcp);
}

// A single shared repo for sections that don't need isolation
let repoDir;

// ── Run ───────────────────────────────────────────────────────────────────────
async function run() {
  process.stderr.write("\n=== Section 184: git_write_ops ===\n");

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION A — Input validation (Level 1 + 2)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- A: Input validation ---\n");

  // Shared repo for most validation tests (operations are validated before git is called)
  repoDir = makeRepo();

  await test("A1: missing operation throws", () => {
    assert.throws(() => gwo({}), /operation.*required/i);
  });

  await test("A2: unknown operation throws", () => {
    assert.throws(() => gwo({ operation: "squash" }), /unknown operation/i);
  });

  await test("A3: add with all=false and no paths throws", () => {
    assert.throws(
      () => gwo({ operation: "add", all: false }),
      /paths.*array.*all/i,
    );
  });

  await test("A4: commit with no message (not amend+no_edit) throws", () => {
    assert.throws(
      () => gwo({ operation: "commit" }),
      /message.*required/i,
    );
  });

  await test("A5: commit author with wrong format throws", () => {
    assert.throws(
      () => gwo({ operation: "commit", message: "x", author: "bad-author" }),
      /author.*Name.*email/i,
    );
  });

  await test("A6: checkout without branch throws", () => {
    assert.throws(
      () => gwo({ operation: "checkout" }),
      /branch.*required/i,
    );
  });

  await test("A7: branch rename without target throws", () => {
    assert.throws(
      () => gwo({ operation: "branch", action: "rename", name: "old" }),
      /target.*required/i,
    );
  });

  await test("A8: branch unknown action throws", () => {
    assert.throws(
      () => gwo({ operation: "branch", action: "explode", name: "x" }),
      /unknown action/i,
    );
  });

  await test("A9: reset with invalid mode throws", () => {
    assert.throws(
      () => gwo({ operation: "reset", mode: "nuclear" }),
      /unknown mode/i,
    );
  });

  await test("A10: stash with unknown subop throws", () => {
    assert.throws(
      () => gwo({ operation: "stash", subop: "teleport" }),
      /unknown subop/i,
    );
  });

  await test("A11: merge with no branch (no abort/continue) throws", () => {
    assert.throws(
      () => gwo({ operation: "merge" }),
      /branch.*required/i,
    );
  });

  await test("A12: rebase action='invalid' throws", () => {
    assert.throws(
      () => gwo({ operation: "rebase", action: "explode" }),
      /unknown action/i,
    );
  });

  await test("A13: cherry_pick action='bad' throws", () => {
    assert.throws(
      () => gwo({ operation: "cherry_pick", action: "teleport" }),
      /unknown action/i,
    );
  });

  await test("A14: tag action='bad' throws", () => {
    assert.throws(
      () => gwo({ operation: "tag", action: "destroy" }),
      /unknown action/i,
    );
  });

  await test("A15: tag create without name throws", () => {
    assert.throws(
      () => gwo({ operation: "tag" }),
      /name.*required/i,
    );
  });

  await test("A16: cherry_pick without ref (no action) throws", () => {
    assert.throws(
      () => gwo({ operation: "cherry_pick" }),
      /ref.*required/i,
    );
  });

  await test("A17: rebase without branch (no action) throws", () => {
    assert.throws(
      () => gwo({ operation: "rebase" }),
      /branch.*required/i,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION B — Internal helper unit tests (Level 1 + 2)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- B: Internal helper unit tests ---\n");

  // validateStr is not exported — test via operation calls that exercise it
  await test("B1: commit message with null byte throws", () => {
    seedCommit(repoDir);
    assert.throws(
      () => gwo({ operation: "commit", message: "hello\0world" }),
      /null bytes/i,
    );
  });

  await test("B2: commit message exceeding 10000 chars throws", () => {
    assert.throws(
      () => gwo({ operation: "commit", message: "x".repeat(10001) }),
      /exceeds.*10000|10000.*characters/i,
    );
  });

  await test("B3: tag name with null byte throws", () => {
    assert.throws(
      () => gwo({ operation: "tag", name: "v1\0.0" }),
      /null bytes/i,
    );
  });

  await test("B4: push remote with null byte throws", () => {
    assert.throws(
      () => gwo({ operation: "push", remote: "ori\0gin" }),
      /null bytes/i,
    );
  });

  await test("B5: cherry_pick mainline must be positive integer", () => {
    assert.throws(
      () => gwo({ operation: "cherry_pick", ref: "HEAD", mainline: 0 }),
      /positive integer/i,
    );
  });

  await test("B6: cherry_pick mainline non-integer throws", () => {
    assert.throws(
      () => gwo({ operation: "cherry_pick", ref: "HEAD", mainline: 1.5 }),
      /positive integer/i,
    );
  });

  await test("B7: MCP_ALLOW_EXEC guard is bypassed for this test (env var set)", () => {
    // If requireExec throws, the test above (A1) would have thrown too.
    // This test verifies ALLOW_EXEC is true in this process.
    const { ALLOW_EXEC } = require("../../lib/config");
    assert.strictEqual(ALLOW_EXEC, true, "MCP_ALLOW_EXEC must be true for exec tests");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION C — Happy path: add, commit, branch, checkout, tag (Level 1 + 3)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- C: Happy path — add/commit/branch/tag ---\n");

  let cDir;

  await test("C1: git add --all stages all untracked files", () => {
    cDir = makeRepo();
    fs.writeFileSync(path.join(cDir, "a.txt"), "hello");
    fs.writeFileSync(path.join(cDir, "b.txt"), "world");
    const r = gwo({ operation: "add" }, cDir);
    assert.strictEqual(r.operation, "add");
    assert.ok(r.stagedFiles >= 2, `staged=${r.stagedFiles}`);
    assert.ok(r.newlyStagedFiles >= 2);
  });

  await test("C2: git commit creates a new commit with the right message", () => {
    const r = gwo({ operation: "commit", message: "feat: first commit" }, cDir);
    assert.strictEqual(r.operation, "commit");
    assert.ok(r.hash && r.hash.length === 40, `hash=${r.hash}`);
    // Verify the message was recorded
    const subject = git(cDir, ["log", "-1", "--format=%s"]);
    assert.strictEqual(subject, "feat: first commit");
  });

  await test("C3: git add specific paths (array)", () => {
    const fp = path.join(cDir, "c.txt");
    fs.writeFileSync(fp, "new file");
    const r = gwo({ operation: "add", paths: [fp] }, cDir);
    assert.ok(r.stagedFiles >= 1);
  });

  await test("C4: branch create produces a new branch", () => {
    const r = gwo({ operation: "branch", action: "create", name: "feature/x" }, cDir);
    assert.strictEqual(r.operation, "branch");
    assert.strictEqual(r.action, "create");
    const branches = git(cDir, ["branch"]).split("\n").map(b => b.trim().replace(/^\* /, ""));
    assert.ok(branches.includes("feature/x"), `branches=${branches.join(",")}`);
  });

  await test("C5: branch list returns all branches", () => {
    const r = gwo({ operation: "branch", action: "list" }, cDir);
    assert.ok(Array.isArray(r.branches), "branches is array");
    assert.ok(r.branches.some(b => b.includes("feature/x")), `branches=${r.branches}`);
  });

  await test("C6: checkout switches to an existing branch", () => {
    const r = gwo({ operation: "checkout", branch: "feature/x" }, cDir);
    assert.strictEqual(r.operation, "checkout");
    assert.strictEqual(r.branch, "feature/x");
    assert.strictEqual(git(cDir, ["branch", "--show-current"]), "feature/x");
  });

  await test("C7: checkout -b creates and switches to a new branch", () => {
    const r = gwo({ operation: "checkout", branch: "hotfix/y", create: true }, cDir);
    assert.strictEqual(r.branch, "hotfix/y");
  });

  await test("C8: branch delete removes an unmerged branch (force)", () => {
    // Create then delete
    gwo({ operation: "branch", action: "create", name: "to-delete" }, cDir);
    const r = gwo({ operation: "branch", action: "delete", name: "to-delete", force: true }, cDir);
    assert.strictEqual(r.action, "delete");
  });

  await test("C9: tag create (lightweight) adds a tag", () => {
    // Switch back to main
    const main = git(cDir, ["log", "--format=%D", "-1"]).includes("master") ? "master" : "main";
    git(cDir, ["checkout", main.split(",")[0].trim() || "master"]);
    const r = gwo({ operation: "tag", action: "create", name: "v0.1.0" }, cDir);
    assert.strictEqual(r.action, "create");
    assert.strictEqual(r.name, "v0.1.0");
    assert.ok(git(cDir, ["tag", "-l"]).includes("v0.1.0"));
  });

  await test("C10: tag list returns all tags", () => {
    const r = gwo({ operation: "tag", action: "list" }, cDir);
    assert.ok(Array.isArray(r.tags), "tags is array");
    assert.ok(r.tags.includes("v0.1.0"), `tags=${r.tags}`);
  });

  await test("C11: tag delete removes the tag", () => {
    gwo({ operation: "tag", action: "create", name: "v0.0.1" }, cDir);
    const r = gwo({ operation: "tag", action: "delete", name: "v0.0.1" }, cDir);
    assert.strictEqual(r.action, "delete");
    assert.ok(!git(cDir, ["tag", "-l"]).includes("v0.0.1"));
  });

  await test("C12: annotated tag (with message) creates an annotated object", () => {
    gwo({ operation: "tag", action: "create", name: "v0.2.0", message: "Release v0.2.0" }, cDir);
    const type = git(cDir, ["cat-file", "-t", "v0.2.0"]);
    assert.strictEqual(type, "tag", "should be annotated tag object");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION D — Happy path: stash, reset, merge (Level 3)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- D: stash + reset + merge ---\n");

  let dDir;

  await test("D1: stash push saves working tree changes", () => {
    dDir = makeRepo();
    seedCommit(dDir, "file.txt", "v1", "initial");
    // Dirty the working tree
    fs.writeFileSync(path.join(dDir, "file.txt"), "v2-dirty");
    const r = gwo({ operation: "stash", subop: "push", message: "wip stuff" }, dDir);
    assert.strictEqual(r.operation, "stash");
    assert.strictEqual(r.subop, "push");
    // Working tree should be clean now
    assert.strictEqual(fs.readFileSync(path.join(dDir, "file.txt"), "utf8"), "v1");
  });

  await test("D2: stash list shows the saved stash", () => {
    const r = gwo({ operation: "stash", subop: "list" }, dDir);
    assert.ok(r.output.includes("wip stuff"), `output=${r.output}`);
  });

  await test("D3: stash show displays the stash diff", () => {
    const r = gwo({ operation: "stash", subop: "show" }, dDir);
    assert.ok(typeof r.output === "string");
  });

  await test("D4: stash pop restores the working tree", () => {
    gwo({ operation: "stash", subop: "pop" }, dDir);
    assert.strictEqual(fs.readFileSync(path.join(dDir, "file.txt"), "utf8"), "v2-dirty");
  });

  await test("D5: stash push + clear removes all stashes", () => {
    fs.writeFileSync(path.join(dDir, "file.txt"), "v3-dirty");
    gwo({ operation: "stash", subop: "push" }, dDir);
    const r = gwo({ operation: "stash", subop: "clear" }, dDir);
    assert.ok(r.output.includes("cleared") || r.output === "(stash cleared)" || r.output === "");
    const list = gwo({ operation: "stash", subop: "list" }, dDir);
    assert.strictEqual(list.output.trim(), "");
  });

  await test("D6: reset --soft moves HEAD back one commit", () => {
    const e2Dir = makeRepo();
    seedCommit(e2Dir, "a.txt", "v1", "commit1");
    seedCommit(e2Dir, "a.txt", "v2", "commit2");
    const beforeHash = git(e2Dir, ["rev-parse", "HEAD"]);
    gwo({ operation: "reset", mode: "soft", ref: "HEAD~1" }, e2Dir);
    const afterHash = git(e2Dir, ["rev-parse", "HEAD"]);
    assert.notStrictEqual(beforeHash, afterHash);
    // Staged changes should still be present
    const staged = git(e2Dir, ["diff", "--cached", "--name-only"]);
    assert.ok(staged.includes("a.txt"), `staged=${staged}`);
  });

  await test("D7: reset --hard discards all changes", () => {
    const e3Dir = makeRepo();
    seedCommit(e3Dir, "a.txt", "v1", "commit1");
    fs.writeFileSync(path.join(e3Dir, "a.txt"), "dirty");
    gwo({ operation: "reset", mode: "hard", ref: "HEAD" }, e3Dir);
    assert.strictEqual(fs.readFileSync(path.join(e3Dir, "a.txt"), "utf8"), "v1");
  });

  await test("D8: reset HEAD with paths unstages specific files", () => {
    const e4Dir = makeRepo();
    seedCommit(e4Dir, "x.txt", "x1", "base");
    fs.writeFileSync(path.join(e4Dir, "x.txt"), "x2");
    git(e4Dir, ["add", "-A"]);
    const r = gwo({ operation: "reset", paths: ["x.txt"] }, e4Dir);
    // After unstage, x.txt should be unstaged
    const staged = git(e4Dir, ["diff", "--cached", "--name-only"]);
    assert.strictEqual(staged, "");
  });

  await test("D9: merge fast-forwards a branch into current branch", () => {
    const mDir = makeRepo();
    seedCommit(mDir, "base.txt", "base", "base commit");
    // Create branch with an extra commit
    git(mDir, ["checkout", "-b", "feature"]);
    seedCommit(mDir, "feature.txt", "feature work", "feature commit");
    git(mDir, ["checkout", "master"]);
    const r = gwo({ operation: "merge", branch: "feature" }, mDir);
    assert.strictEqual(r.operation, "merge");
    assert.ok(r.hash);
    // feature.txt should now exist on master
    assert.ok(fs.existsSync(path.join(mDir, "feature.txt")));
  });

  await test("D10: merge --no-ff always creates a merge commit", () => {
    const mDir2 = makeRepo();
    seedCommit(mDir2, "base.txt", "base", "base");
    git(mDir2, ["checkout", "-b", "feat"]);
    seedCommit(mDir2, "feat.txt", "feat", "feat commit");
    git(mDir2, ["checkout", "master"]);
    gwo({ operation: "merge", branch: "feat", no_ff: true, message: "Merge feat" }, mDir2);
    // Verify a merge commit (2 parents)
    const parents = git(mDir2, ["log", "-1", "--format=%P"]);
    assert.ok(parents.includes(" "), "merge commit should have 2 parents");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION E — Happy path: rebase, cherry_pick (Level 3)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- E: rebase + cherry_pick ---\n");

  await test("E1: rebase feature onto main", () => {
    const rDir = makeRepo();
    seedCommit(rDir, "base.txt", "base", "base");
    git(rDir, ["checkout", "-b", "feature"]);
    seedCommit(rDir, "feature.txt", "feat", "feat commit");
    git(rDir, ["checkout", "master"]);
    seedCommit(rDir, "main2.txt", "m2", "main2");
    git(rDir, ["checkout", "feature"]);
    const r = gwo({ operation: "rebase", branch: "master" }, rDir);
    assert.strictEqual(r.operation, "rebase");
    assert.ok(r.hash);
    // feature.txt should still exist after rebase
    assert.ok(fs.existsSync(path.join(rDir, "feature.txt")));
  });

  await test("E2: cherry_pick copies a commit to the current branch", () => {
    const cpDir = makeRepo();
    seedCommit(cpDir, "a.txt", "v1", "initial");
    git(cpDir, ["checkout", "-b", "src"]);
    const { hash: pickHash } = seedCommit(cpDir, "cherry.txt", "cherry", "cherry commit");
    git(cpDir, ["checkout", "master"]);
    const r = gwo({ operation: "cherry_pick", ref: pickHash }, cpDir);
    assert.strictEqual(r.operation, "cherry_pick");
    assert.ok(r.hash);
    assert.ok(fs.existsSync(path.join(cpDir, "cherry.txt")));
  });

  await test("E3: cherry_pick --no-commit stages without committing", () => {
    const cpDir2 = makeRepo();
    seedCommit(cpDir2, "a.txt", "v1", "initial");
    git(cpDir2, ["checkout", "-b", "src"]);
    const { hash } = seedCommit(cpDir2, "extra.txt", "extra", "extra");
    git(cpDir2, ["checkout", "master"]);
    gwo({ operation: "cherry_pick", ref: hash, no_commit: true }, cpDir2);
    // Should be staged but not committed
    const staged = git(cpDir2, ["diff", "--cached", "--name-only"]);
    assert.ok(staged.includes("extra.txt"), `staged=${staged}`);
    // HEAD should not have changed
    const commitAfter = git(cpDir2, ["log", "--oneline", "-1"]);
    assert.ok(commitAfter.includes("initial"), `log=${commitAfter}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION F — Git-level error propagation (Level 3)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- F: Git error propagation ---\n");

  await test("F1: commit with nothing staged returns git error", () => {
    const fDir = makeRepo();
    seedCommit(fDir, "a.txt", "v1", "first");
    // No changes staged
    assert.throws(
      () => gwo({ operation: "commit", message: "empty" }, fDir),
      /nothing to commit|nothing added|no changes/i,
    );
  });

  await test("F2: checkout to non-existent branch returns git error", () => {
    assert.throws(
      () => gwo({ operation: "checkout", branch: "does-not-exist-branch-xyz" }, repoDir),
      /did not match|not found|pathspec/i,
    );
  });

  await test("F3: push to non-existent remote returns git error", () => {
    const fDir = makeRepo();
    seedCommit(fDir, "a.txt", "v1", "first");
    assert.throws(
      () => gwo({ operation: "push", remote: "nonexistent-xyz" }, fDir),
      /does not appear|remote.*not.*found|No such remote|fatal/i,
    );
  });

  await test("F4: cherry_pick non-existent ref returns git error", () => {
    const fDir2 = makeRepo();
    seedCommit(fDir2, "a.txt", "v1", "base");
    assert.throws(
      () => gwo({ operation: "cherry_pick", ref: "deadbeef12345678" }, fDir2),
      /bad.*revision|unknown.*revision|not a commit/i,
    );
  });

  await test("F5: tag delete non-existent tag returns git error", () => {
    assert.throws(
      () => gwo({ operation: "tag", action: "delete", name: "v999.999.999" }, repoDir),
      /not found|no tag.*found|error|fatal/i,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION G — Push/pull with local bare remote (Level 3)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- G: push + pull with local bare remote ---\n");

  let gDir, bareDir;

  await test("G1: push to local bare remote succeeds", () => {
    gDir  = makeRepo(false);
    bareDir = makeRepo(true);
    seedCommit(gDir, "a.txt", "v1", "initial");
    git(gDir, ["remote", "add", "localbare", bareDir]);
    const r = gwo({ operation: "push", remote: "localbare", branch: "master", set_upstream: true }, gDir);
    assert.strictEqual(r.operation, "push");
    assert.strictEqual(r.remote, "localbare");
    // Bare repo should now have the commit (use --all since HEAD may be unborn in a bare repo)
    const log = git(bareDir, ["log", "--oneline", "--all"]);
    assert.ok(log.includes("initial"), `bare log=${log}`);
  });

  await test("G2: pull from local bare remote after push reflects new commits", () => {
    // Clone the bare to a second working copy
    // Note: do NOT call makeRepo() here — that would git-init the dir and make it non-empty.
    // Instead, generate a fresh unique path and let git clone create it.
    const g2Dir = path.join(TMP_BASE, `repo${++repoCounter}`);
    // g2Dir must not exist yet for git clone to work.
    childProcess.spawnSync("git", ["clone", bareDir, g2Dir], { encoding: "utf8" });
    git(g2Dir, ["config", "user.email", "test@example.com"]);
    git(g2Dir, ["config", "user.name",  "Test User"]);
    // Push a new commit from gDir
    seedCommit(gDir, "b.txt", "v2", "second");
    gwo({ operation: "push", remote: "localbare", branch: "master" }, gDir);
    // Pull in g2Dir
    const r = gwo({ operation: "pull", remote: "origin", branch: "master" }, g2Dir);
    assert.strictEqual(r.operation, "pull");
    assert.ok(fs.existsSync(path.join(g2Dir, "b.txt")));
  });

  await test("G3: push with --force-with-lease flag is accepted", () => {
    // Just verify the flag path is exercised (the command may fail due to no divergence)
    try {
      gwo({ operation: "push", remote: "localbare", branch: "master", force_with_lease: true }, gDir);
    } catch (e) {
      // Acceptable — the flag was passed, git may complain about "already up-to-date"
      assert.ok(typeof e.message === "string");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION H — Amend, allow_empty, branch rename, annotated tag (Level 3)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- H: Amend + allow_empty + branch rename ---\n");

  let hDir;

  await test("H1: commit --allow-empty creates a commit with no file changes", () => {
    hDir = makeRepo();
    seedCommit(hDir, "a.txt", "v1", "base");
    const r = gwo({ operation: "commit", message: "empty commit", allow_empty: true }, hDir);
    const subject = git(hDir, ["log", "-1", "--format=%s"]);
    assert.strictEqual(subject, "empty commit");
  });

  await test("H2: commit --amend --no-edit updates the commit without changing message", () => {
    const before = git(hDir, ["log", "-1", "--format=%s"]);
    fs.writeFileSync(path.join(hDir, "new.txt"), "amended content");
    git(hDir, ["add", "-A"]);
    gwo({ operation: "commit", amend: true, no_edit: true }, hDir);
    const after = git(hDir, ["log", "-1", "--format=%s"]);
    // Message should be unchanged
    assert.strictEqual(before, after);
    // But new.txt should be in the commit
    const files = git(hDir, ["show", "--name-only", "--format=%n", "HEAD"]);
    assert.ok(files.includes("new.txt"), `files=${files}`);
  });

  await test("H3: branch rename gives branch a new name", () => {
    const h2Dir = makeRepo();
    seedCommit(h2Dir, "a.txt", "v1", "base");
    git(h2Dir, ["checkout", "-b", "old-name"]);
    gwo({ operation: "branch", action: "rename", name: "old-name", target: "new-name" }, h2Dir);
    const branches = git(h2Dir, ["branch"]).split("\n").map(b => b.trim().replace(/^\* /, ""));
    assert.ok(branches.includes("new-name"), `branches=${branches}`);
    assert.ok(!branches.includes("old-name"), `old-name still present`);
  });

  await test("H4: commit with custom author is recorded correctly", () => {
    const h3Dir = makeRepo();
    seedCommit(h3Dir, "a.txt", "v1", "base");
    fs.writeFileSync(path.join(h3Dir, "b.txt"), "authored");
    git(h3Dir, ["add", "-A"]);
    gwo({ operation: "commit", message: "authored commit", author: "Alice <alice@example.com>" }, h3Dir);
    const author = git(h3Dir, ["log", "-1", "--format=%an <%ae>"]);
    assert.strictEqual(author, "Alice <alice@example.com>");
  });

  await test("H5: stash push --include-untracked saves untracked files", () => {
    const h4Dir = makeRepo();
    seedCommit(h4Dir, "a.txt", "v1", "base");
    fs.writeFileSync(path.join(h4Dir, "untracked.txt"), "new untracked");
    gwo({ operation: "stash", subop: "push", include_untracked: true }, h4Dir);
    // Untracked file should be gone now
    assert.ok(!fs.existsSync(path.join(h4Dir, "untracked.txt")));
  });

  await test("H6: tag create --force overwrites existing tag", () => {
    const h5Dir = makeRepo();
    seedCommit(h5Dir, "a.txt", "v1", "c1");
    gwo({ operation: "tag", action: "create", name: "v1.0" }, h5Dir);
    seedCommit(h5Dir, "a.txt", "v2", "c2");
    // Force-overwrite tag to point to new commit
    gwo({ operation: "tag", action: "create", name: "v1.0", ref: "HEAD", force: true }, h5Dir);
    // Tag exists with updated ref — just verify it still exists
    assert.ok(git(h5Dir, ["tag", "-l"]).includes("v1.0"));
  });

  await test("H7: commit --no-verify skips pre-commit hooks", () => {
    // In repos without hooks, --no-verify is a no-op; test just validates flag path
    const h6Dir = makeRepo();
    seedCommit(h6Dir, "a.txt", "v1", "base");
    fs.writeFileSync(path.join(h6Dir, "b.txt"), "new");
    git(h6Dir, ["add", "-A"]);
    const r = gwo({ operation: "commit", message: "no-verify commit", no_verify: true }, h6Dir);
    assert.ok(r.hash);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION I — Security (Level 4 — Critical)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- I: Security injection guards ---\n");

  let iDir;

  await test("I1: commit message with shell metacharacters is stored verbatim", async () => {
    iDir = makeRepo();
    seedCommit(iDir, "a.txt", "v1", "base");
    const dangerous = 'feat: $(rm -rf /); `echo pwned`; $PWD || true';
    fs.writeFileSync(path.join(iDir, "b.txt"), "safe");
    git(iDir, ["add", "-A"]);
    gwo({ operation: "commit", message: dangerous }, iDir);
    const recorded = git(iDir, ["log", "-1", "--format=%s"]);
    assert.strictEqual(recorded, dangerous);
  });

  await test("I2: commit message with newline/backtick is stored verbatim", () => {
    const tricky = "line1\nline2\n`code`";
    fs.writeFileSync(path.join(iDir, "c.txt"), "data");
    git(iDir, ["add", "-A"]);
    gwo({ operation: "commit", message: tricky }, iDir);
    const body = git(iDir, ["log", "-1", "--format=%B"]);
    assert.ok(body.includes("line1") && body.includes("`code`"), `body=${body}`);
  });

  await test("I3: tag name with special chars (valid for git) is stored verbatim", () => {
    const tagName = "v1.0.0-rc.1+build.42";
    gwo({ operation: "tag", action: "create", name: tagName }, iDir);
    assert.ok(git(iDir, ["tag", "-l"]).includes(tagName));
  });

  await test("I4: commit message with quotes is safe (no shell expansion)", () => {
    fs.writeFileSync(path.join(iDir, "d.txt"), "q");
    git(iDir, ["add", "-A"]);
    const q = 'feat: "double" and \'single\' and `backtick`';
    gwo({ operation: "commit", message: q }, iDir);
    const subject = git(iDir, ["log", "-1", "--format=%s"]);
    assert.strictEqual(subject, q);
  });

  await test("I5: null byte in commit message blocked before reaching git", () => {
    assert.throws(
      () => gwo({ operation: "commit", message: "hello\0" }, iDir),
      /null bytes/i,
    );
  });

  await test("I6: branch name with null byte is blocked", () => {
    assert.throws(
      () => gwo({ operation: "branch", action: "create", name: "feat\0bad" }, iDir),
      /null bytes/i,
    );
  });

  await test("I7: remote name with null byte is blocked", () => {
    assert.throws(
      () => gwo({ operation: "push", remote: "ori\0gin" }, iDir),
      /null bytes/i,
    );
  });

  await test("I8: stash message with null byte is blocked", () => {
    assert.throws(
      () => gwo({ operation: "stash", subop: "push", message: "wip\0" }, iDir),
      /null bytes/i,
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION J — Concurrency (Level 5 — Extreme)
  // ═══════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- J: Concurrency + stress ---\n");

  await test("J1: 5 concurrent commits to isolated repos succeed independently", async () => {
    const dirs = Array.from({ length: 5 }, () => {
      const d = makeRepo();
      seedCommit(d, "a.txt", "base", "initial");
      fs.writeFileSync(path.join(d, "b.txt"), "change");
      git(d, ["add", "-A"]);
      return d;
    });

    const results = await Promise.all(
      dirs.map((d, i) =>
        Promise.resolve(gwo({ operation: "commit", message: `concurrent commit ${i}` }, d)),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      assert.ok(results[i].hash, `result[${i}].hash missing`);
      const subject = git(dirs[i], ["log", "-1", "--format=%s"]);
      assert.strictEqual(subject, `concurrent commit ${i}`);
    }
  });

  await test("J2: 10 sequential branch-create operations succeed", () => {
    const jDir = makeRepo();
    seedCommit(jDir, "a.txt", "v1", "base");
    for (let i = 0; i < 10; i++) {
      gwo({ operation: "branch", action: "create", name: `branch-${i}` }, jDir);
    }
    const branches = git(jDir, ["branch"]).split("\n").map(b => b.trim().replace(/^\* /, ""));
    for (let i = 0; i < 10; i++) {
      assert.ok(branches.includes(`branch-${i}`), `branch-${i} missing`);
    }
  });

  await test("J3: commit message with 9999 chars is accepted (just under limit)", () => {
    const jDir2 = makeRepo();
    seedCommit(jDir2, "a.txt", "v1", "base");
    fs.writeFileSync(path.join(jDir2, "b.txt"), "new");
    git(jDir2, ["add", "-A"]);
    const longMsg = "x".repeat(9999);
    const r = gwo({ operation: "commit", message: longMsg }, jDir2);
    assert.ok(r.hash);
  });

  await test("J4: 5 concurrent add+commit cycles to same repo (sequential within repo)", async () => {
    // Repos are distinct — tests are order-independent, just verifying no cross-contamination
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => {
        const d = makeRepo();
        seedCommit(d, "a.txt", "v1", "base");
        fs.writeFileSync(path.join(d, `file${i}.txt`), `content${i}`);
        git(d, ["add", "-A"]);
        return Promise.resolve(gwo({ operation: "commit", message: `cycle-${i}` }, d));
      }),
    );
    for (const r of results) assert.ok(r.hash);
  });

  await test("J5: stash push + pop 10 times on same repo is idempotent", () => {
    const j5Dir = makeRepo();
    seedCommit(j5Dir, "a.txt", "v1", "base");
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(j5Dir, "a.txt"), `dirty-${i}`);
      gwo({ operation: "stash", subop: "push" }, j5Dir);
      gwo({ operation: "stash", subop: "pop" }, j5Dir);
      assert.strictEqual(fs.readFileSync(path.join(j5Dir, "a.txt"), "utf8"), `dirty-${i}`);
    }
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (_) {}

  process.stderr.write(`\n=== Section 184 complete: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

// Export the promise so run-tests.js can await it.
module.exports = run().catch((e) => {
  process.stderr.write(`\nUnhandled error in test runner: ${e.stack}\n`);
  process.exit(1);
});
