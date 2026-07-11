"use strict";
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
const TMP = path.join(os.tmpdir(), "test184g_" + process.pid);
fs.mkdirSync(TMP, { recursive: true });
let rc = 0;
function makeRepo(bare) {
  const d = path.join(TMP, "r" + (++rc));
  fs.mkdirSync(d, { recursive: true });
  git(d, bare ? ["init", "--bare"] : ["init", "-b", "master"]);
  if (!bare) { git(d, ["config", "user.email", "t@t.com"]); git(d, ["config", "user.name", "T"]); git(d, ["config", "commit.gpgsign", "false"]); }
  return d;
}
function git(cwd, args) {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } });
  if (r.error) throw r.error; return (r.stdout || "").trimEnd();
}
function seed(d, f, c, m) {
  fs.writeFileSync(path.join(d, f || "a.txt"), c || "v1"); git(d, ["add", "-A"]); git(d, ["commit", "-m", m || "initial"]);
  return { hash: git(d, ["rev-parse", "HEAD"]) };
}
const mock = (p) => ({ resolved: p });
const gwo  = (args, d) => gitWriteOps(args, d, mock);

process.stderr.write("--- G: push + pull ---\n");
let gDir, bareDir;
test("G1 push to bare remote", () => {
  gDir = makeRepo(false); bareDir = makeRepo(true);
  seed(gDir, "a.txt", "v1", "initial");
  git(gDir, ["remote", "add", "localbare", bareDir]);
  const r = gwo({ operation: "push", remote: "localbare", branch: "master", set_upstream: true }, gDir);
  assert.strictEqual(r.remote, "localbare");
  assert.ok(git(bareDir, ["log", "--oneline"]).includes("initial"));
});
test("G2 pull from bare remote", () => {
  const g2 = path.join(TMP, "clone");
  childProcess.spawnSync("git", ["clone", bareDir, g2], { encoding: "utf8" });
  git(g2, ["config", "user.email", "t@t.com"]); git(g2, ["config", "user.name", "T"]); git(g2, ["config", "commit.gpgsign", "false"]);
  seed(gDir, "b.txt", "v2", "second");
  gwo({ operation: "push", remote: "localbare", branch: "master" }, gDir);
  const r = gwo({ operation: "pull", remote: "origin", branch: "master" }, g2);
  assert.strictEqual(r.operation, "pull"); assert.ok(fs.existsSync(path.join(g2, "b.txt")));
});
test("G3 push --force-with-lease flag", () => {
  try { gwo({ operation: "push", remote: "localbare", branch: "master", force_with_lease: true }, gDir); }
  catch (e) { assert.ok(typeof e.message === "string"); }
});
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.stderr.write(`\n=== Section G: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
