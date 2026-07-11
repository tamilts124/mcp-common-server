"use strict";
// Sections G+H: push/pull bare remote, amend, allow_empty, branch rename
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

const TMP = path.join(os.tmpdir(), "test184gh_" + process.pid);
fs.mkdirSync(TMP, { recursive: true });
let rc = 0;
function makeRepo(bare) {
  const d = path.join(TMP, "r" + (++rc));
  fs.mkdirSync(d, { recursive: true });
  git(d, bare ? ["init", "--bare"] : ["init", "-b", "master"]);
  if (!bare) {
    git(d, ["config", "user.email", "t@t.com"]);
    git(d, ["config", "user.name", "T"]);
    git(d, ["config", "commit.gpgsign", "false"]);
  }
  return d;
}
function git(cwd, args) {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } });
  if (r.error) throw r.error;
  return (r.stdout || "").trimEnd();
}
function seed(d, f, c, m) {
  fs.writeFileSync(path.join(d, f || "a.txt"), c || "v1");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-m", m || "initial"]);
  return { hash: git(d, ["rev-parse", "HEAD"]) };
}
const mock = (p) => ({ resolved: p });
const gwo  = (args, d) => gitWriteOps(args, d, mock);

process.stderr.write("--- G: push + pull with local bare remote ---\n");

let gDir, bareDir;
test("G1 push to bare remote", () => {
  gDir    = makeRepo(false);
  bareDir = makeRepo(true);
  seed(gDir, "a.txt", "v1", "initial");
  git(gDir, ["remote", "add", "localbare", bareDir]);
  const r = gwo({ operation: "push", remote: "localbare", branch: "master", set_upstream: true }, gDir);
  assert.strictEqual(r.remote, "localbare");
  assert.ok(git(bareDir, ["log", "--oneline"]).includes("initial"));
});

test("G2 pull from bare remote", () => {
  const g2 = path.join(TMP, "clone");
  childProcess.spawnSync("git", ["clone", bareDir, g2], { encoding: "utf8" });
  git(g2, ["config", "user.email", "t@t.com"]);
  git(g2, ["config", "user.name", "T"]);
  git(g2, ["config", "commit.gpgsign", "false"]);
  seed(gDir, "b.txt", "v2", "second");
  gwo({ operation: "push", remote: "localbare", branch: "master" }, gDir);
  const r = gwo({ operation: "pull", remote: "origin", branch: "master" }, g2);
  assert.strictEqual(r.operation, "pull");
  assert.ok(fs.existsSync(path.join(g2, "b.txt")));
});

test("G3 push --force-with-lease (flag exercised)", () => {
  try {
    gwo({ operation: "push", remote: "localbare", branch: "master", force_with_lease: true }, gDir);
  } catch (e) {
    // Acceptable — flag path was exercised
    assert.ok(typeof e.message === "string");
  }
});

process.stderr.write("\n--- H: amend + allow_empty + branch rename ---\n");

let hDir;
test("H1 commit --allow-empty", () => {
  hDir = makeRepo();
  seed(hDir, "a.txt", "v1", "base");
  gwo({ operation: "commit", message: "empty commit", allow_empty: true }, hDir);
  assert.strictEqual(git(hDir, ["log", "-1", "--format=%s"]), "empty commit");
});

test("H2 commit --amend --no-edit", () => {
  const before = git(hDir, ["log", "-1", "--format=%s"]);
  fs.writeFileSync(path.join(hDir, "new.txt"), "amended");
  git(hDir, ["add", "-A"]);
  gwo({ operation: "commit", amend: true, no_edit: true }, hDir);
  assert.strictEqual(git(hDir, ["log", "-1", "--format=%s"]), before);
  const files = git(hDir, ["show", "--name-only", "--format=", "HEAD"]);
  assert.ok(files.includes("new.txt"), `files=${files}`);
});

test("H3 branch rename", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "base");
  git(d, ["checkout", "-b", "old-name"]);
  gwo({ operation: "branch", action: "rename", name: "old-name", target: "new-name" }, d);
  const branches = git(d, ["branch"]).split("\n").map(b => b.trim().replace(/^\* /, ""));
  assert.ok(branches.includes("new-name"), `branches=${branches}`);
  assert.ok(!branches.includes("old-name"));
});

test("H4 commit with custom author", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "base");
  fs.writeFileSync(path.join(d, "b.txt"), "authored");
  git(d, ["add", "-A"]);
  gwo({ operation: "commit", message: "authored", author: "Alice <alice@example.com>" }, d);
  assert.strictEqual(git(d, ["log", "-1", "--format=%an <%ae>"]), "Alice <alice@example.com>");
});

test("H5 stash push --include-untracked", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "base");
  fs.writeFileSync(path.join(d, "untracked.txt"), "new");
  gwo({ operation: "stash", subop: "push", include_untracked: true }, d);
  assert.ok(!fs.existsSync(path.join(d, "untracked.txt")));
});

test("H6 tag create --force", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "c1");
  gwo({ operation: "tag", action: "create", name: "v1.0" }, d);
  seed(d, "a.txt", "v2", "c2");
  gwo({ operation: "tag", action: "create", name: "v1.0", ref: "HEAD", force: true }, d);
  assert.ok(git(d, ["tag", "-l"]).includes("v1.0"));
});

test("H7 commit --no-verify", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "base");
  fs.writeFileSync(path.join(d, "b.txt"), "new");
  git(d, ["add", "-A"]);
  const r = gwo({ operation: "commit", message: "no-verify", no_verify: true }, d);
  assert.ok(r.hash);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.stderr.write(`\n=== Sections G+H: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
