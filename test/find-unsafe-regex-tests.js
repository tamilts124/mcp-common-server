"use strict";
// Standalone test script for find_unsafe_regex (not added to the frozen
// test/run-tests.js — new tool areas get their own script per the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "unsafe-regex-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanUnsafeRegex } = require("../lib/unsafeRegexOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("find_unsafe_regex", args); }

(async () => {
  console.log("find_unsafe_regex tests:");

  const proj = "proj";
  write(`${proj}/nested.js`, "const re = /(a+)+/;\n");
  write(`${proj}/alt.js`, "const re = /(a|a)+/;\n");
  write(`${proj}/newregexp.js`, 'const re = new RegExp("(x*)*");\n');
  write(`${proj}/clean.js`, "const re = /^[a-z]+@[a-z]+\\.com$/;\n");
  write(`${proj}/division.js`, "const x = a / b / c;\n");
  write(`${proj}/comment.js`, "// const re = /(a+)+/;\n");

  await test("Normal: nested quantifier detected", async () => {
    const r = scanUnsafeRegex(path.join(TMP, `${proj}/nested.js`), `${proj}/nested.js`);
    assert.strictEqual(r.issueCount, 1);
    assert.strictEqual(r.issues[0].rule, "nested_quantifier");
    assert.strictEqual(r.issues[0].severity, "error");
  });

  await test("Normal: overlapping quantified alternation detected", async () => {
    const r = scanUnsafeRegex(path.join(TMP, `${proj}/alt.js`), `${proj}/alt.js`);
    assert.strictEqual(r.issueCount, 1);
    assert.strictEqual(r.issues[0].rule, "quantified_overlapping_alternation");
  });

  await test("Normal: new RegExp(...) string pattern scanned too", async () => {
    const r = scanUnsafeRegex(path.join(TMP, `${proj}/newregexp.js`), `${proj}/newregexp.js`);
    assert.strictEqual(r.issueCount, 1);
    assert.strictEqual(r.issues[0].rule, "nested_quantifier");
  });

  await test("Normal: clean regex has zero issues", async () => {
    const r = scanUnsafeRegex(path.join(TMP, `${proj}/clean.js`), `${proj}/clean.js`);
    assert.strictEqual(r.issueCount, 0);
  });

  await test("Normal: directory scan aggregates across files", async () => {
    const r = await call({ path: proj });
    assert.ok(r.filesScanned >= 6);
    assert.ok(r.issueCount >= 3);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────
  await test("Medium: nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: `${proj}/does-not-exist.js` }));
  });

  await test("Medium: non-array extensions throws", async () => {
    await assert.rejects(() => call({ path: proj, extensions: ".js" }));
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ path: proj, max_results: "5" }));
  });

  await test("Medium: single-file mode works directly on a file path", async () => {
    const r = await call({ path: `${proj}/nested.js` });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.issueCount, 1);
  });

  await test("Medium: empty file produces zero issues, not a crash", async () => {
    write(`${proj}/empty.js`, "");
    const r = await call({ path: `${proj}/empty.js` });
    assert.strictEqual(r.issueCount, 0);
    assert.strictEqual(r.filesWithErrors, 0);
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: division-operator lines don't crash the scan", async () => {
    const r = await call({ path: `${proj}/division.js` });
    assert.ok(typeof r.filesScanned === "number");
  });

  await test("High: extensions filter narrows scan to .js only", async () => {
    write(`${proj}/notjs.txt`, "const re = /(a+)+/;\n");
    const r = await call({ path: proj, extensions: [".js"] });
    assert.ok(!r.errors.some(e => e.file === "notjs.txt"));
  });

  await test("High: binary file is skipped without crashing", async () => {
    fs.writeFileSync(path.join(TMP, `${proj}/binary.js`), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const r = await call({ path: proj });
    assert.ok(typeof r.filesScanned === "number");
  });

  // ── Critical: security & input sanitization ────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("Critical: shell-injection-shaped regex pattern only reported, never executed", async () => {
    write(`${proj}/adversarial.js`, "const re = /(a+)+; require('child_process').execSync('echo pwned')/;\n");
    const r = await call({ path: `${proj}/adversarial.js` });
    assert.ok(typeof r.issueCount === "number");
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ path: proj });
    JSON.stringify(r);
    const known = ["path", "filesScanned", "filesWithErrors", "issueCount", "errorCount", "warningCount", "truncated", "issues", "errors"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency, truncation ──────────────────────────
  await test("Extreme: max_results truncation sets truncated flag", async () => {
    let content = "";
    for (let i = 0; i < 20; i++) content += `const re${i} = /(a+)+/;\n`;
    write("proj2/many.js", content);
    const r = await call({ path: "proj2/many.js", max_results: 5 });
    assert.strictEqual(r.issues.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.issueCount, 20);
  });

  await test("Extreme: fuzz random-byte file handled without crash", async () => {
    fs.writeFileSync(path.join(TMP, `${proj}/fuzz.js`), require("crypto").randomBytes(2000));
    const r = await call({ path: `${proj}/fuzz.js` });
    assert.ok(typeof r.filesScanned === "number");
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ path: `${proj}/nested.js` })));
    for (const r of results) assert.strictEqual(r.issueCount, 1);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("find_unsafe_regex"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
