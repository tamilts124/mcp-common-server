"use strict";
// Standalone test script for find_case_sensitive_import_mismatches (not
// added to the frozen test/run-tests.js — new tool areas get their own
// script per the testing-strategy pivot documented in task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "case-mismatch-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { findCaseSensitiveImportMismatches } = require("../lib/caseSensitiveImportsOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("find_case_sensitive_import_mismatches", args); }

(async () => {
  console.log("find_case_sensitive_import_mismatches tests:");

  // ── Normal ───────────────────────────────────────────────────────────────
  const proj = "proj";
  write(`${proj}/utils.js`, "module.exports = { helper() {} };\n");
  write(`${proj}/bad-import.js`, "const u = require('./Utils');\nmodule.exports = u;\n");
  write(`${proj}/good-import.js`, "const u = require('./utils');\nmodule.exports = u;\n");
  write(`${proj}/helpers/index.js`, "module.exports = {};\n");
  write(`${proj}/bad-dir-import.js`, "import x from './Helpers';\nexport default x;\n");
  write(`${proj}/dynamic-bad.js`, "async function f() { return import('./Utils'); }\nmodule.exports = f;\n");
  write(`${proj}/external-import.js`, "const fs = require('fs');\nconst r = require('react');\nmodule.exports = { fs, r };\n");

  let res = await call({ path: proj });

  await test("mismatched require('./Utils') vs actual utils.js flagged with correct line/actualPath", () => {
    const m = res.mismatches.find(x => x.file === "bad-import.js");
    assert.ok(m);
    assert.strictEqual(m.specifier, "./Utils");
    assert.strictEqual(m.actualPath, "utils.js");
    assert.strictEqual(m.line, 1);
  });

  await test("correctly-cased require('./utils') not flagged", () => {
    assert.strictEqual(res.mismatches.find(x => x.file === "good-import.js"), undefined);
  });

  await test("directory-index mismatch (./Helpers vs helpers/index.js) flagged", () => {
    const m = res.mismatches.find(x => x.file === "bad-dir-import.js");
    assert.ok(m);
    assert.strictEqual(m.actualPath, "helpers/index.js");
  });

  // ── Medium ────────────────────────────────────────────────────────────
  await test("non-directory path throws", () => {
    assert.throws(() => findCaseSensitiveImportMismatches(path.join(TMP, proj, "utils.js"), "x"));
  });

  await test("max_results non-number throws", () => {
    assert.throws(() => findCaseSensitiveImportMismatches(path.join(TMP, proj), proj, { maxResults: "ten" }), /must be a number/);
  });

  await test("extensions non-array throws", () => {
    assert.throws(() => findCaseSensitiveImportMismatches(path.join(TMP, proj), proj, { extensions: ".js" }), /must be an array/);
  });

  await test("external/bare specifiers (fs, react) never flagged", () => {
    assert.strictEqual(res.mismatches.find(x => x.file === "external-import.js"), undefined);
  });

  // ── High ──────────────────────────────────────────────────────────────
  await test("dynamic import() with mismatched case also flagged", () => {
    const m = res.mismatches.find(x => x.file === "dynamic-bad.js");
    assert.ok(m);
    assert.strictEqual(m.actualPath, "utils.js");
  });

  await test("genuinely missing specifier (no real file, any case) not reported", async () => {
    write(`${proj}/truly-missing.js`, "const x = require('./does-not-exist-anywhere');\nmodule.exports = x;\n");
    const r = await call({ path: proj });
    assert.strictEqual(r.mismatches.find(x => x.file === "truly-missing.js"), undefined);
  });

  await test("extensions filter narrows scan (only .ts scanned finds nothing in this all-.js project)", async () => {
    const r = await call({ path: proj, extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 0);
  });

  // ── Critical ──────────────────────────────────────────────────────────
  await test("path traversal blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc" }));
  });

  await test("shell-injection-shaped specifier text inert, no crash", async () => {
    write(`${proj}/inject.js`, "const x = require('./$(rm -rf /)');\nmodule.exports = x;\n");
    const r = await call({ path: proj });
    assert.strictEqual(r.mismatches.find(x => x.file === "inject.js"), undefined);
  });

  await test("result is JSON-serialisable", () => {
    assert.doesNotThrow(() => JSON.stringify(res));
  });

  await test("no unexpected top-level keys", () => {
    assert.deepStrictEqual(Object.keys(res).sort(), ["collisionCount", "collisions", "filesScanned", "mismatchCount", "mismatches", "path", "specifiersChecked", "truncated"]);
  });

  // ── Extreme ───────────────────────────────────────────────────────────
  const collProj = "coll-proj";
  write(`${collProj}/Icon.js`, "module.exports = 1;\n");
  write(`${collProj}/icon.js`, "module.exports = 2;\n");
  const caseInsensitiveFs = fs.readdirSync(path.join(TMP, collProj)).length < 2;
  await test("on-disk case collision (Icon.js vs icon.js) detected", async () => {
    if (caseInsensitiveFs) { console.log("    (skipped - host filesystem is case-insensitive, can't hold both files)"); return; }
    const r = await call({ path: collProj });
    assert.strictEqual(r.collisionCount, 1);
    assert.deepStrictEqual(r.collisions[0].paths.sort(), ["Icon.js", "icon.js"]);
  });

  await test("10 concurrent calls all consistent", async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: proj }));
    const results = await Promise.all(calls);
    for (const r of results) assert.ok(r.mismatches.find(x => x.file === "bad-import.js"));
  });

  await test("fuzz: random-byte source file handled without crash", () => {
    const fuzzPath = path.join(TMP, proj, "fuzz.js");
    const bytes = Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256)));
    fs.writeFileSync(fuzzPath, bytes);
    assert.doesNotThrow(() => findCaseSensitiveImportMismatches(path.join(TMP, proj), proj));
  });

  await test("execute_pipeline op-enum registration", () => {
    const schemas = require("../lib/toolsSchema").TOOLS_ALL;
    const pipelineSchema = schemas.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("find_case_sensitive_import_mismatches"));
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
