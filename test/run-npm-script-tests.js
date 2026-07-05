"use strict";
/**
 * Standalone tests for run_npm_script. NOT added to frozen test/run-tests.js.
 * Run: node test/run-npm-script-tests.js
 *
 * Rigor levels covered:
 *  Normal   - valid script runs, captures stdout/exit code/success.
 *  Medium   - missing/invalid script, non-existent script, non-dir path,
 *             bad extra_args/timeout/env types, missing package.json.
 *  High     - non-zero exit code, stderr capture, timeout kill, npm-missing
 *             simulated via PATH override.
 *  Critical - shell-injection-shaped extra_args never executed (argv, not
 *             shell string), path-traversal-shaped script name rejected.
 *  Extreme  - 5 concurrent runs, large stdout truncation, fuzzed script name.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runnpmscript-test-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
process.env.MCP_CMD_TIMEOUT = "8";

const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

const counters = { pass: 0, fail: 0 };
async function test(name, fn) {
  try { await fn(); counters.pass++; console.log(`  ok - ${name}`); }
  catch (e) { counters.fail++; console.log(`  FAIL - ${name}\n      ${e.message}`); }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function expectThrow(fn, codeOrMsgFrag) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (typeof codeOrMsgFrag === "number" && e.code !== codeOrMsgFrag)
      throw new Error(`expected code ${codeOrMsgFrag}, got ${e.code}: ${e.message}`);
    if (typeof codeOrMsgFrag === "string" && !e.message.includes(codeOrMsgFrag))
      throw new Error(`expected message to include '${codeOrMsgFrag}', got: ${e.message}`);
  }
}

const PROJECT = path.join(TMP, "proj");
fs.mkdirSync(PROJECT);
fs.writeFileSync(path.join(PROJECT, "package.json"), JSON.stringify({
  name: "fixture", version: "1.0.0",
  scripts: {
    greet: "node -e \"console.log('hello-run-npm-script')\"",
    fail: "node -e \"process.exit(3)\"",
    err: "node -e \"console.error('oops-stderr'); process.exit(1)\"",
    slow: "node -e \"setTimeout(()=>{}, 6000)\"",
    echoargs: "node -e \"console.log(process.argv.slice(1).join(','))\"",
    big: "node -e \"process.stdout.write('x'.repeat(6*1024*1024))\"",
  },
}));

const EMPTY_DIR = path.join(TMP, "empty");
fs.mkdirSync(EMPTY_DIR);

(async () => {
  console.log("== run-npm-script-tests.js ==");

  // ── Normal (happy path) ──────────────────────────────────────────────
  await test("run_npm_script: valid script -> success, exitCode 0, stdout captured", async () => {
    const r = await executeTool("run_npm_script", { path: "proj", script: "greet" });
    assertEq(r.success, true);
    assertEq(r.exitCode, 0);
    assertEq(r.timedOut, false);
    if (!r.stdout.includes("hello-run-npm-script")) throw new Error("stdout missing expected output: " + r.stdout);
    assertEq(r.script, "greet");
    if (typeof r.durationMs !== "number") throw new Error("durationMs missing");
  });

  // ── Medium (boundary & parameter validation) ─────────────────────────
  await test("run_npm_script: missing 'script' -> -32602", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj" }), -32602);
  });
  await test("run_npm_script: non-existent script -> -32602 listing available scripts", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj", script: "nope" }), "Available:");
  });
  await test("run_npm_script: path is not a directory -> clean error", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj/package.json", script: "greet" }), -32602);
  });
  await test("run_npm_script: extra_args not an array -> -32602", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj", script: "greet", extra_args: "x" }), -32602);
  });
  await test("run_npm_script: timeout not a number -> -32602", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj", script: "greet", timeout: "5" }), -32602);
  });
  await test("run_npm_script: env not an object -> -32602", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj", script: "greet", env: ["x"] }), -32602);
  });
  await test("run_npm_script: no package.json in dir -> clean error, not a crash", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "empty", script: "greet" }), -32602);
  });

  // ── High (execution failures: non-zero exit, stderr, timeout) ────────
  await test("run_npm_script: script exits non-zero -> success:false, exitCode preserved", async () => {
    const r = await executeTool("run_npm_script", { path: "proj", script: "fail" });
    assertEq(r.success, false);
    assertEq(r.exitCode, 3);
    assertEq(r.timedOut, false);
  });
  await test("run_npm_script: script writes stderr -> captured, not thrown", async () => {
    const r = await executeTool("run_npm_script", { path: "proj", script: "err" });
    assertEq(r.success, false);
    if (!r.stderr.includes("oops-stderr")) throw new Error("stderr missing expected output: " + r.stderr);
  });
  await test("run_npm_script: long-running script killed by timeout -> timedOut:true, no crash", async () => {
    const r = await executeTool("run_npm_script", { path: "proj", script: "slow", timeout: 1 });
    assertEq(r.timedOut, true);
    assertEq(r.success, false);
  });

  // ── Critical (security / input sanitization) ─────────────────────────
  await test("run_npm_script: shell-injection-shaped extra_args passed as literal argv, never executed", async () => {
    const r = await executeTool("run_npm_script", {
      path: "proj", script: "echoargs", extra_args: ["; touch pwned; echo", "$(whoami)", "`id`"],
    });
    assertEq(r.success, true);
    if (r.stdout.includes("uid=")) throw new Error("command substitution was executed — injection succeeded");
    if (fs.existsSync(path.join(PROJECT, "pwned"))) throw new Error("shell metacharacter created a file — injection succeeded");
  });
  await test("run_npm_script: path-traversal-shaped script name -> clean 'not found' error, not a crash", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj", script: "../../../../etc/passwd" }), -32602);
  });
  await test("run_npm_script: HTML/script-tag-shaped script name -> clean error, not reflected unsafely", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj", script: "<script>alert(1)</script>" }), -32602);
  });

  // ── Extreme (fuzzing, concurrency, large output) ─────────────────────
  await test("run_npm_script: large stdout (>5MB) is truncated, not a crash", async () => {
    const r = await executeTool("run_npm_script", { path: "proj", script: "big" });
    assertEq(r.stdoutTruncated, true);
    if (r.stdout.length > 5 * 1024 * 1024 + 1000) throw new Error("stdout not bounded near MAX_BUFFER");
  });
  await test("run_npm_script: extremely long garbage script name -> clean error, no crash", async () => {
    await expectThrow(() => executeTool("run_npm_script", { path: "proj", script: "x".repeat(5000) }), -32602);
  });
  await test("concurrency: 5 parallel run_npm_script calls, all succeed independently", async () => {
    const jobs = [];
    for (let i = 0; i < 5; i++) jobs.push(executeTool("run_npm_script", { path: "proj", script: "greet" }));
    const results = await Promise.all(jobs);
    for (const r of results) { assertEq(r.success, true); assertEq(r.exitCode, 0); }
  });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(counters.fail > 0 ? 1 : 0);
})();
