"use strict";
// Sections E+F: rebase, cherry_pick, git error propagation
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

const TMP = path.join(os.tmpdir(), "test184ef_" + process.pid);
fs.mkdirSync(TMP, { recursive: true });
let rc = 0;
function makeRepo() {
  const d = path.join(TMP, "r" + (++rc));
  fs.mkdirSync(d, { recursive: true });
  git(d, ["init", "-b", "master"]);
  git(d, ["config", "user.email", "t@t.com"]);
  git(d, ["config", "user.name", "T"]);
  git(d, ["config", "commit.gpgsign", "false"]);
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

process.stderr.write("--- E: rebase + cherry_pick ---\n");

test("E1 rebase onto master", () => {
  const d = makeRepo();
  seed(d, "base.txt", "base", "base");
  git(d, ["checkout", "-b", "feature"]);
  seed(d, "feat.txt", "feat", "feat");
  git(d, ["checkout", "master"]);
  seed(d, "m2.txt", "m2", "main2");
  git(d, ["checkout", "feature"]);
  const r = gwo({ operation: "rebase", branch: "master" }, d);
  assert.strictEqual(r.operation, "rebase");
  assert.ok(fs.existsSync(path.join(d, "feat.txt")));
});

test("E2 cherry_pick copies commit", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "initial");
  git(d, ["checkout", "-b", "src"]);
  const { hash } = seed(d, "cherry.txt", "cherry", "cherry commit");
  git(d, ["checkout", "master"]);
  const r = gwo({ operation: "cherry_pick", ref: hash }, d);
  assert.strictEqual(r.operation, "cherry_pick");
  assert.ok(fs.existsSync(path.join(d, "cherry.txt")));
});

test("E3 cherry_pick --no-commit stages only", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "initial");
  git(d, ["checkout", "-b", "src"]);
  const { hash } = seed(d, "extra.txt", "extra", "extra");
  git(d, ["checkout", "master"]);
  gwo({ operation: "cherry_pick", ref: hash, no_commit: true }, d);
  const staged = git(d, ["diff", "--cached", "--name-only"]);
  assert.ok(staged.includes("extra.txt"), `staged=${staged}`);
  assert.ok(git(d, ["log", "--oneline", "-1"]).includes("initial"));
});

process.stderr.write("\n--- F: git error propagation ---\n");

let fRepo;
test("F1 commit nothing staged", () => {
  fRepo = makeRepo();
  seed(fRepo, "a.txt", "v1", "first");
  assert.throws(() => gwo({ operation: "commit", message: "empty" }, fRepo),
    /nothing to commit|nothing added|no changes/i);
});

test("F2 checkout non-existent branch", () => {
  assert.throws(() => gwo({ operation: "checkout", branch: "does-not-exist-xyz" }, fRepo),
    /did not match|not found|pathspec/i);
});

test("F3 push to non-existent remote", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "first");
  assert.throws(() => gwo({ operation: "push", remote: "nonexistent-xyz" }, d),
    /does not appear|remote.*not.*found|No such remote|fatal/i);
});

test("F4 cherry_pick bad ref", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "base");
  assert.throws(() => gwo({ operation: "cherry_pick", ref: "deadbeef12345678" }, d),
    /bad.*revision|unknown.*revision|not a commit/i);
});

test("F5 tag delete non-existent", () => {
  assert.throws(() => gwo({ operation: "tag", action: "delete", name: "v999.999.999" }, fRepo),
    /not found|no tag.*found|error|fatal/i);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.stderr.write(`\n=== Sections E+F: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
