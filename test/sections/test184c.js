"use strict";
// Section C: add, commit, branch, checkout, tag (happy path)
process.env.MCP_ALLOW_EXEC = "true";
const assert       = require("assert");
const fs           = require("fs");
const os           = require("os");
const path         = require("path");
const childProcess = require("child_process");
const { gitWriteOps } = require("../../lib/gitWriteOps");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); process.stderr.write("PASS " + name + "\n"); passed++; }
  catch (e) { process.stderr.write("FAIL " + name + ": " + e.message + "\n"); failed++; }
}

const TMP_BASE = path.join(os.tmpdir(), "test184c_" + process.pid);
fs.mkdirSync(TMP_BASE, { recursive: true });
let repoCounter = 0;

function makeRepo(bare) {
  const dir = path.join(TMP_BASE, "repo" + (++repoCounter));
  fs.mkdirSync(dir, { recursive: true });
  git(dir, bare ? ["init", "--bare"] : ["init", "-b", "master"]);
  if (!bare) {
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name",  "Test User"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
  }
  return dir;
}

function git(cwd, args) {
  const r = childProcess.spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  });
  if (r.error) throw r.error;
  return (r.stdout || "").trimEnd();
}

function seedCommit(dir, fname, content, message) {
  fs.writeFileSync(path.join(dir, fname || "a.txt"), content || "hello");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message || "initial"]);
  return { hash: git(dir, ["rev-parse", "HEAD"]) };
}

const mockRcp = (p) => ({ resolved: p });
const gwo = (args, dir) => gitWriteOps(args, dir, mockRcp);

process.stderr.write("--- C: add/commit/branch/checkout/tag ---\n");

let cDir;
test("C1 add --all", () => {
  cDir = makeRepo();
  fs.writeFileSync(path.join(cDir, "a.txt"), "hello");
  fs.writeFileSync(path.join(cDir, "b.txt"), "world");
  const r = gwo({ operation: "add" }, cDir);
  assert.strictEqual(r.operation, "add");
  assert.ok(r.stagedFiles >= 2, `staged=${r.stagedFiles}`);
});

test("C2 commit", () => {
  const r = gwo({ operation: "commit", message: "feat: first" }, cDir);
  assert.strictEqual(r.operation, "commit");
  assert.ok(r.hash && r.hash.length === 40, `hash=${r.hash}`);
  assert.strictEqual(git(cDir, ["log", "-1", "--format=%s"]), "feat: first");
});

test("C3 add specific paths", () => {
  const fp = path.join(cDir, "c.txt");
  fs.writeFileSync(fp, "new");
  const r = gwo({ operation: "add", paths: [fp] }, cDir);
  assert.ok(r.stagedFiles >= 1);
});

test("C4 branch create", () => {
  const r = gwo({ operation: "branch", action: "create", name: "feature/x" }, cDir);
  assert.strictEqual(r.action, "create");
  const branches = git(cDir, ["branch"]).split("\n").map(b => b.trim().replace(/^\* /, ""));
  assert.ok(branches.includes("feature/x"), `branches=${branches}`);
});

test("C5 branch list", () => {
  const r = gwo({ operation: "branch", action: "list" }, cDir);
  assert.ok(Array.isArray(r.branches));
  assert.ok(r.branches.some(b => b.includes("feature/x")));
});

test("C6 checkout existing branch", () => {
  const r = gwo({ operation: "checkout", branch: "feature/x" }, cDir);
  assert.strictEqual(r.branch, "feature/x");
  assert.strictEqual(git(cDir, ["branch", "--show-current"]), "feature/x");
});

test("C7 checkout -b new branch", () => {
  const r = gwo({ operation: "checkout", branch: "hotfix/y", create: true }, cDir);
  assert.strictEqual(r.branch, "hotfix/y");
});

test("C8 branch delete force", () => {
  gwo({ operation: "branch", action: "create", name: "to-delete" }, cDir);
  const r = gwo({ operation: "branch", action: "delete", name: "to-delete", force: true }, cDir);
  assert.strictEqual(r.action, "delete");
});

test("C9 tag create lightweight", () => {
  git(cDir, ["checkout", "master"]);
  const r = gwo({ operation: "tag", action: "create", name: "v0.1.0" }, cDir);
  assert.strictEqual(r.action, "create");
  assert.ok(git(cDir, ["tag", "-l"]).includes("v0.1.0"));
});

test("C10 tag list", () => {
  const r = gwo({ operation: "tag", action: "list" }, cDir);
  assert.ok(Array.isArray(r.tags));
  assert.ok(r.tags.includes("v0.1.0"));
});

test("C11 tag delete", () => {
  gwo({ operation: "tag", action: "create", name: "v0.0.1" }, cDir);
  gwo({ operation: "tag", action: "delete", name: "v0.0.1" }, cDir);
  assert.ok(!git(cDir, ["tag", "-l"]).includes("v0.0.1"));
});

test("C12 annotated tag", () => {
  gwo({ operation: "tag", action: "create", name: "v0.2.0", message: "Release v0.2.0" }, cDir);
  assert.strictEqual(git(cDir, ["cat-file", "-t", "v0.2.0"]), "tag");
});

try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (_) {}

process.stderr.write(`\n=== Section C: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
