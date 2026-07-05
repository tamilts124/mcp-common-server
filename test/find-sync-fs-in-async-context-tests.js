"use strict";
// Standalone test script for find_sync_fs_in_async_context (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sync-in-async-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

function writeFile(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("find_sync_fs_in_async_context", args); }

(async () => {
  console.log("find_sync_fs_in_async_context tests:");

  writeFile("proj/mixed/a.js", [
    "async function loadA() {",
    "  const x = fs.readFileSync('a.txt');",
    "  return x;",
    "}",
    "async function loadB() {",
    "  const x = await fs.promises.readFile('b.txt');",
    "  return x;",
    "}",
    "function sync1() {",
    "  return fs.readFileSync('c.txt');",
    "}",
    "const arrowAsync = async () => {",
    "  return execSync('ls');",
    "};",
  ].join("\n"));

  await test("Normal: fs.readFileSync inside async function declaration flagged", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    assert.ok(r.findings.some(f => f.line === 2 && f.call === "fs.readFileSync"));
  });

  await test("Normal: awaited async call not flagged", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    assert.ok(!r.findings.some(f => f.line === 6));
  });

  await test("Normal: sync call in a plain (non-async) function not flagged", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    assert.ok(!r.findings.some(f => f.line === 10));
  });

  await test("Normal: execSync inside async arrow function flagged", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    const f = r.findings.find(x => x.call === "execSync");
    assert.ok(f);
    assert.strictEqual(f.asyncFunctionName, "arrowAsync");
  });

  await test("Normal: asyncFunctionName reported correctly for named declaration", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    const f = r.findings.find(x => x.call === "fs.readFileSync");
    assert.strictEqual(f.asyncFunctionName, "loadA");
  });

  await test("Normal: clean file has zero findings", async () => {
    writeFile("proj/clean/b.js", "async function loadC() {\n  return await fs.promises.readFile('x');\n}");
    const r = await call({ path: "proj/clean/b.js" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("Normal: directory scan aggregates across files", async () => {
    const r = await call({ path: "proj/mixed" });
    assert.ok(r.filesScanned >= 1);
    assert.ok(r.findingsCount >= 2);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────
  await test("Medium: nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: "proj/does-not-exist.js" }));
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ path: "proj/mixed/a.js", max_results: "5" }));
  });

  await test("Medium: single file with non-matching extension throws", async () => {
    writeFile("proj/mixed/notes.txt", "async function f() { fs.readFileSync('x'); }");
    await assert.rejects(() => call({ path: "proj/mixed/notes.txt" }));
  });

  await test("Medium: file with no async functions returns zero findings, not a crash", async () => {
    writeFile("proj/noasync/c.js", "function f() { return fs.readFileSync('x'); }");
    const r = await call({ path: "proj/noasync/c.js" });
    assert.strictEqual(r.findingsCount, 0);
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: object-method-shorthand async function detected", async () => {
    writeFile("proj/objmethod/d.js", "const obj = {\n  async load() {\n    return fs.readFileSync('x');\n  }\n};");
    const r = await call({ path: "proj/objmethod/d.js" });
    assert.strictEqual(r.findingsCount, 1);
  });

  await test("High: arrow-assigned async function (object property style) detected", async () => {
    writeFile("proj/objarrow/e.js", "const obj = {\n  load: async () => {\n    return spawnSync('ls');\n  }\n};");
    const r = await call({ path: "proj/objarrow/e.js" });
    assert.strictEqual(r.findingsCount, 1);
  });

  await test("High: extensions filter narrows scan", async () => {
    writeFile("proj/extfilter/f.ts", "async function g() { fs.readFileSync('x'); }");
    writeFile("proj/extfilter/f.js", "async function g() { fs.readFileSync('x'); }");
    const r = await call({ path: "proj/extfilter", extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
  });

  await test("High: nested non-async function inside async body still flagged (documented tradeoff)", async () => {
    writeFile("proj/nested/g.js", "async function outer() {\n  function inner() { return fs.readFileSync('x'); }\n  return inner();\n}");
    const r = await call({ path: "proj/nested/g.js" });
    assert.strictEqual(r.findingsCount, 1);
  });

  // ── Critical: security & input sanitization ────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("Critical: shell-injection-shaped call argument handled as inert text", async () => {
    writeFile("proj/adversarial/h.js", "async function f() {\n  return execSync('$(rm -rf /); echo pwned');\n}");
    const r = await call({ path: "proj/adversarial/h.js" });
    assert.ok(r.findings[0].text.includes("$(rm -rf /)"));
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ path: "proj/clean/b.js" });
    JSON.stringify(r);
    const known = ["path", "filesScanned", "findingsCount", "truncated", "findings"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency, truncation ──────────────────────────
  await test("Extreme: max_results truncation sets truncated flag", async () => {
    let src = "";
    for (let i = 0; i < 20; i++) src += `async function f${i}() { fs.readFileSync('x'); }\n`;
    writeFile("proj/many/i.js", src);
    const r = await call({ path: "proj/many/i.js", max_results: 5 });
    assert.strictEqual(r.findings.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.findingsCount, 20);
  });

  await test("Extreme: fuzz random-byte file doesn't crash", async () => {
    fs.writeFileSync(path.join(TMP, "proj/fuzz.js"), require("crypto").randomBytes(2000));
    await assert.doesNotReject(() => call({ path: "proj/fuzz.js" }));
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ path: "proj/clean/b.js" })));
    for (const r of results) assert.strictEqual(r.findingsCount, 0);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("find_sync_fs_in_async_context"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
