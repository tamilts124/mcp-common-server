"use strict";
// Standalone test script for scan_cors_misconfig (not added to the frozen
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cors-misconfig-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanCorsMisconfig } = require("../lib/corsMisconfigOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("scan_cors_misconfig", args); }

(async () => {
  console.log("scan_cors_misconfig tests:");

  // ── Normal ───────────────────────────────────────────────────────────────
  const proj = "proj";
  write(`${proj}/wildcard-header.js`, "res.setHeader('Access-Control-Allow-Origin', '*');\n");
  write(`${proj}/cors-wildcard.js`, "app.use(cors({ origin: '*' }));\n");
  write(`${proj}/cors-bare.js`, "app.use(cors());\n");
  write(`${proj}/clean.js`, "app.use(cors({ origin: 'https://example.com' }));\n");

  let res = await call({ path: proj });

  await test("hardcoded wildcard header flagged as warning", () => {
    const m = res.issues.find(x => x.file === "wildcard-header.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "wildcard_header");
    assert.strictEqual(m.severity, "warning");
    assert.strictEqual(m.line, 1);
  });

  await test("cors({origin:'*'}) flagged", () => {
    const m = res.issues.find(x => x.file === "cors-wildcard.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "cors_wildcard_origin");
  });

  await test("bare cors() flagged as info", () => {
    const m = res.issues.find(x => x.file === "cors-bare.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "cors_default_wildcard");
    assert.strictEqual(m.severity, "info");
  });

  await test("specific-origin cors() not flagged", () => {
    assert.strictEqual(res.issues.find(x => x.file === "clean.js"), undefined);
  });

  // ── Medium ────────────────────────────────────────────────────────────
  await test("nonexistent path throws", () => {
    assert.throws(() => scanCorsMisconfig(path.join(TMP, "does-not-exist"), "x"));
  });

  await test("max_results non-number throws", () => {
    assert.throws(() => scanCorsMisconfig(path.join(TMP, proj), proj, { maxResults: "ten" }), /must be a number/);
  });

  await test("extensions non-array throws", () => {
    assert.throws(() => scanCorsMisconfig(path.join(TMP, proj), proj, { extensions: ".js" }), /must be an array/);
  });

  await test("single-file mode (not a directory) scans just that file", async () => {
    const r = await call({ path: `${proj}/cors-bare.js` });
    assert.strictEqual(r.filesScanned, 1);
    assert.ok(r.issues.find(x => x.rule === "cors_default_wildcard"));
  });

  // ── High ──────────────────────────────────────────────────────────────
  await test("origin:'*' + credentials:true nearby escalates to error", async () => {
    write(`${proj}/wildcard-creds.js`, "app.use(cors({\n  origin: '*',\n  credentials: true\n}));\n");
    const r = await call({ path: proj });
    const m = r.issues.find(x => x.file === "wildcard-creds.js");
    assert.ok(m);
    assert.strictEqual(m.rule, "wildcard_with_credentials");
    assert.strictEqual(m.severity, "error");
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

  await test("reflected origin header flagged as error", () => {
    write(`${proj}/reflect.js`, "res.setHeader('Access-Control-Allow-Origin', req.headers.origin);\n");
    return call({ path: proj }).then(r => {
      const m = r.issues.find(x => x.file === "reflect.js");
      assert.ok(m);
      assert.strictEqual(m.rule, "reflected_origin");
      assert.strictEqual(m.severity, "error");
    });
  });

  await test("shell/HTML-injection-shaped origin string handled as inert text, no crash", async () => {
    write(`${proj}/inject.js`, "const origin = \"<script>alert(1)</script>$(rm -rf /)\";\napp.use(cors({ origin }));\n");
    const r = await call({ path: proj });
    assert.ok(Array.isArray(r.issues));
  });

  await test("result is JSON-serialisable", () => {
    assert.doesNotThrow(() => JSON.stringify(res));
  });

  await test("no unexpected top-level keys", () => {
    assert.deepStrictEqual(Object.keys(res).sort(), ["errorCount", "filesScanned", "infoCount", "issueCount", "issues", "path", "truncated", "warningCount"]);
  });

  // ── Extreme ───────────────────────────────────────────────────────────
  await test("10 concurrent calls all consistent", async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: proj }));
    const results = await Promise.all(calls);
    for (const r of results) assert.ok(r.issues.find(x => x.file === "wildcard-header.js"));
  });

  await test("fuzz: random-byte source file handled without crash", () => {
    const fuzzPath = path.join(TMP, proj, "fuzz.js");
    const bytes = Buffer.from(Array.from({ length: 500 }, () => Math.floor(Math.random() * 256)));
    fs.writeFileSync(fuzzPath, bytes);
    assert.doesNotThrow(() => scanCorsMisconfig(path.join(TMP, proj), proj));
  });

  await test("max_results truncates and sets truncated flag", async () => {
    const manyProj = "many-proj";
    for (let i = 0; i < 20; i++) {
      write(`${manyProj}/file${i}.js`, "res.setHeader('Access-Control-Allow-Origin', '*');\n");
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
    assert.ok(opEnum.includes("scan_cors_misconfig"));
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
