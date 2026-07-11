"use strict";
// Section D: stash, reset, merge
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

const TMP = path.join(os.tmpdir(), "test184d_" + process.pid);
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

process.stderr.write("--- D: stash + reset + merge ---\n");

let dDir;
test("D1 stash push", () => {
  dDir = makeRepo();
  seed(dDir, "file.txt", "v1", "initial");
  fs.writeFileSync(path.join(dDir, "file.txt"), "v2-dirty");
  const r = gwo({ operation: "stash", subop: "push", message: "wip stuff" }, dDir);
  assert.strictEqual(r.subop, "push");
  assert.strictEqual(fs.readFileSync(path.join(dDir, "file.txt"), "utf8"), "v1");
});

test("D2 stash list", () => {
  const r = gwo({ operation: "stash", subop: "list" }, dDir);
  assert.ok(r.output.includes("wip stuff"), `out=${r.output}`);
});

test("D3 stash show", () => {
  const r = gwo({ operation: "stash", subop: "show" }, dDir);
  assert.ok(typeof r.output === "string");
});

test("D4 stash pop", () => {
  gwo({ operation: "stash", subop: "pop" }, dDir);
  assert.strictEqual(fs.readFileSync(path.join(dDir, "file.txt"), "utf8"), "v2-dirty");
});

test("D5 stash push + clear", () => {
  fs.writeFileSync(path.join(dDir, "file.txt"), "v3-dirty");
  gwo({ operation: "stash", subop: "push" }, dDir);
  const r = gwo({ operation: "stash", subop: "clear" }, dDir);
  const list = gwo({ operation: "stash", subop: "list" }, dDir);
  assert.strictEqual(list.output.trim(), "");
});

test("D6 reset --soft", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "c1"); seed(d, "a.txt", "v2", "c2");
  const before = git(d, ["rev-parse", "HEAD"]);
  gwo({ operation: "reset", mode: "soft", ref: "HEAD~1" }, d);
  assert.notStrictEqual(git(d, ["rev-parse", "HEAD"]), before);
  assert.ok(git(d, ["diff", "--cached", "--name-only"]).includes("a.txt"));
});

test("D7 reset --hard", () => {
  const d = makeRepo();
  seed(d, "a.txt", "v1", "c1");
  fs.writeFileSync(path.join(d, "a.txt"), "dirty");
  gwo({ operation: "reset", mode: "hard", ref: "HEAD" }, d);
  assert.strictEqual(fs.readFileSync(path.join(d, "a.txt"), "utf8"), "v1");
});

test("D8 reset HEAD paths (unstage)", () => {
  const d = makeRepo();
  seed(d, "x.txt", "x1", "base");
  fs.writeFileSync(path.join(d, "x.txt"), "x2");
  git(d, ["add", "-A"]);
  gwo({ operation: "reset", paths: ["x.txt"] }, d);
  assert.strictEqual(git(d, ["diff", "--cached", "--name-only"]).trim(), "");
});

test("D9 merge fast-forward", () => {
  const d = makeRepo();
  seed(d, "base.txt", "base", "base");
  git(d, ["checkout", "-b", "feature"]);
  seed(d, "feat.txt", "feat", "feat");
  git(d, ["checkout", "master"]);
  const r = gwo({ operation: "merge", branch: "feature" }, d);
  assert.strictEqual(r.operation, "merge");
  assert.ok(fs.existsSync(path.join(d, "feat.txt")));
});

test("D10 merge --no-ff", () => {
  const d = makeRepo();
  seed(d, "base.txt", "base", "base");
  git(d, ["checkout", "-b", "feat"]);
  seed(d, "feat.txt", "feat", "feat");
  git(d, ["checkout", "master"]);
  gwo({ operation: "merge", branch: "feat", no_ff: true, message: "Merge feat" }, d);
  const parents = git(d, ["log", "-1", "--format=%P"]);
  assert.ok(parents.includes(" "), "expected merge commit with 2 parents");
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.stderr.write(`\n=== Section D: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
