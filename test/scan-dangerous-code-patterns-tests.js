"use strict";
// Standalone test script for scan_dangerous_code_patterns (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dangerous-patterns-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanDangerousPatterns } = require("../lib/dangerousPatternsOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("scan_dangerous_code_patterns", args); }

(async () => {
  console.log("scan_dangerous_code_patterns tests:");

  // ── Normal ───────────────────────────────────────────────────────────────
  const proj = "proj";
  write(`${proj}/eval-bad.js`, "eval(userInput);\n");
  write(`${proj}/new-fn-bad.js`, "const f = new Function('a', 'return a+1');\n");
  write(`${proj}/exec-bad.js`, "const { exec } = require('child_process');\nexec(`ls ${dir}`);\n");
  write(`${proj}/exec-good.js`, "const { execFile } = require('child_process');\nexecFile('ls', [dir]);\n");
  write(`${proj}/timer-bad.js`, "setTimeout(\"doStuff()\", 100);\n");
  write(`${proj}/html-bad.js`, "el.innerHTML = userContent;\n");
  write(`${proj}/html-good.js`, "el.innerHTML = '<b>static</b>';\n");
  write(`${proj}/random-token.js`, "const token = Math.random().toString(36);\n");
  write(`${proj}/clean.js`, "function add(a, b) { return a + b; }\nmodule.exports = { add };\n");

  let res = await call({ path: proj });

  await test("eval() flagged as error", () => {
    const m = res.issues.find(x => x.file === "eval-bad.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "eval_usage");
    assert.strictEqual(m.severity, "error");
  });

  await test("new Function() flagged as error", () => {
    const m = res.issues.find(x => x.file === "new-fn-bad.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "new_function");
  });

  await test("exec() with template literal flagged", () => {
    const m = res.issues.find(x => x.file === "exec-bad.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "exec_dynamic_command");
  });

  await test("execFile() with argv array NOT flagged", () => {
    assert.strictEqual(res.issues.find(x => x.file === "exec-good.js"), undefined);
  });

  await test("setTimeout with string literal flagged", () => {
    const m = res.issues.find(x => x.file === "timer-bad.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "timer_string_eval");
    assert.strictEqual(m.severity, "warning");
  });

  await test("innerHTML from variable flagged", () => {
    const m = res.issues.find(x => x.file === "html-bad.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "unsafe_inner_html");
  });

  await test("innerHTML from string literal NOT flagged", () => {
    assert.strictEqual(res.issues.find(x => x.file === "html-good.js"), undefined);
  });

  await test("Math.random()-based token flagged", () => {
    const m = res.issues.find(x => x.file === "random-token.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "weak_random_token");
  });

  await test("clean file has no issues", () => {
    assert.strictEqual(res.issues.find(x => x.file === "clean.js"), undefined);
  });

  // ── Medium ────────────────────────────────────────────────────────────
  await test("nonexistent path throws", () => {
    assert.throws(() => scanDangerousPatterns(path.join(TMP, "does-not-exist"), "x"));
  });

  await test("max_results non-number throws", () => {
    assert.throws(() => scanDangerousPatterns(path.join(TMP, proj), proj, { maxResults: "ten" }), /must be a number/);
  });

  await test("extensions non-array throws", () => {
    assert.throws(() => scanDangerousPatterns(path.join(TMP, proj), proj, { extensions: ".js" }), /must be an array/);
  });

  await test("single-file mode scans just that file", async () => {
    const r = await call({ path: `${proj}/eval-bad.js` });
    assert.strictEqual(r.filesScanned, 1);
    assert.ok(r.issues.find(x => x.rule === "eval_usage"));
  });

  // ── High ──────────────────────────────────────────────────────────────
  await test("dangerouslySetInnerHTML flagged (React)", async () => {
    write(`${proj}/react-bad.jsx`, "const El = () => <div dangerouslySetInnerHTML={{__html: raw}} />;\n");
    const r = await call({ path: proj });
    const m = r.issues.find(x => x.file === "react-bad.jsx");
    assert.ok(m);
    assert.strictEqual(m.rule, "dangerously_set_inner_html");
  });

  await test("extensions filter narrows scan (only .ts finds nothing in all-.js project)", async () => {
    const r = await call({ path: proj, extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 0);
  });

  await test("binary file skipped without crash", async () => {
    fs.writeFileSync(path.join(TMP, proj, "binary.js"), Buffer.from([0, 1, 2, 0, 255, 254]));
    const r = await call({ path: proj });
    assert.strictEqual(r.issues.find(x => x.file === "binary.js"), undefined);
  });

  // ── Critical ──────────────────────────────────────────────────────────
  await test("path traversal blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc" }));
  });

  await test("shell-injection-shaped eval argument still just flagged as eval_usage, no crash", async () => {
    write(`${proj}/inject.js`, "eval(\"$(rm -rf /)\");\n");
    const r = await call({ path: proj });
    const m = r.issues.find(x => x.file === "inject.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "eval_usage");
  });

  await test("result is JSON-serialisable", () => {
    assert.doesNotThrow(() => JSON.stringify(res));
  });

  await test("no unexpected top-level keys", () => {
    assert.deepStrictEqual(Object.keys(res).sort(), ["errorCount", "filesScanned", "issueCount", "issues", "path", "truncated", "warningCount"]);
  });

  // ── Extreme ───────────────────────────────────────────────────────────
  await test("10 concurrent calls all consistent", async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: proj }));
    const results = await Promise.all(calls);
    for (const r of results) assert.ok(r.issues.find(x => x.file === "eval-bad.js"));
  });

  await test("fuzz: random-byte source file handled without crash", () => {
    const fuzzPath = path.join(TMP, proj, "fuzz.js");
    const bytes = Buffer.from(Array.from({ length: 500 }, () => Math.floor(Math.random() * 256)));
    fs.writeFileSync(fuzzPath, bytes);
    assert.doesNotThrow(() => scanDangerousPatterns(path.join(TMP, proj), proj));
  });

  await test("max_results truncates and sets truncated flag", async () => {
    const manyProj = "many-proj";
    for (let i = 0; i < 20; i++) {
      write(`${manyProj}/file${i}.js`, "eval(x);\n");
    }
    const r = await call({ path: manyProj, max_results: 5 });
    assert.strictEqual(r.issues.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.issueCount, 20);
  });

  await test("execute_pipeline op-enum registration", () => {
    const schemas = require("../lib/toolsSchema").TOOLS_ALL;
    const pipelineSchema = schemas.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("scan_dangerous_code_patterns"));
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
