"use strict";
// Standalone test script for check_missing_csp_header (not added to the
// frozen test/run-tests.js — new tool areas get their own script per task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "csp-header-"));
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

async function call(args) { return executeTool("check_missing_csp_header", args); }

(async () => {
  console.log("check_missing_csp_header tests:");

  // ── Normal ────────────────────────────────────────────────────────────
  writeFile("proj/no-csp.js", [
    "const app = require(\"express\")();",
    "app.get(\"/\", (req, res) => res.send(\"hi\"));",
  ].join("\n"));

  await test("flags missing_csp_header when routes exist with no CSP hint", async () => {
    const r = await call({ path: "proj/no-csp.js" });
    assert.strictEqual(r.hasRouteRegistrations, true);
    assert.strictEqual(r.hasCspHint, false);
    assert.ok(r.findings.some(f => f.rule === "missing_csp_header"));
  });

  writeFile("proj2/with-helmet.js", [
    "const express = require(\"express\");",
    "const helmet = require(\"helmet\");",
    "const app = express();",
    "app.use(helmet());",
    "app.get(\"/\", (req, res) => res.send(\"hi\"));",
  ].join("\n"));

  await test("does not flag missing_csp_header when helmet() is used", async () => {
    const r = await call({ path: "proj2/with-helmet.js" });
    assert.strictEqual(r.hasCspHint, true);
    assert.strictEqual(r.findings.filter(f => f.rule === "missing_csp_header").length, 0);
  });

  writeFile("proj3/manual-header.js", [
    "const app = require(\"express\")();",
    "app.get(\"/\", (req, res) => {",
    "  res.setHeader(\"Content-Security-Policy\", \"default-src 'self'\");",
    "  res.send(\"hi\");",
    "});",
  ].join("\n"));

  await test("does not flag missing_csp_header with a manual literal header", async () => {
    const r = await call({ path: "proj3/manual-header.js" });
    assert.strictEqual(r.hasCspHint, true);
    assert.strictEqual(r.findings.filter(f => f.rule === "missing_csp_header").length, 0);
  });

  writeFile("proj4/disabled.js", [
    "const app = require(\"express\")();",
    "app.use(helmet({ contentSecurityPolicy: false }));",
    "app.get(\"/\", (req, res) => res.send(\"hi\"));",
  ].join("\n"));

  await test("flags csp_explicitly_disabled call site", async () => {
    const r = await call({ path: "proj4/disabled.js" });
    const f = r.findings.find(x => x.rule === "csp_explicitly_disabled");
    assert.ok(f);
    assert.strictEqual(f.line, 2);
  });

  writeFile("proj5/no-routes.js", "const x = 1 + 1;");

  await test("no project-level finding when there are no route registrations", async () => {
    const r = await call({ path: "proj5/no-routes.js" });
    assert.strictEqual(r.hasRouteRegistrations, false);
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("directory scan aggregates findings across files", async () => {
    const r = await call({ path: "proj" });
    assert.ok(r.filesScanned >= 1);
    assert.ok(r.findings.some(f => f.rule === "missing_csp_header"));
  });

  // ── Medium: boundary & parameter validation ─────────────────────────────
  await test("nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: "proj/does-not-exist.js" }));
  });

  await test("max_results type mismatch throws", async () => {
    await assert.rejects(() => call({ path: "proj", max_results: "five" }));
  });

  await test("extensions type mismatch throws", async () => {
    await assert.rejects(() => call({ path: "proj", extensions: "js" }));
  });

  await test("extensions filter narrows the scan", async () => {
    writeFile("proj6/a.js", "const app = require(\"express\")(); app.get(\"/\", (req,res)=>res.send(1));");
    writeFile("proj6/b.ts", "const app = require(\"express\")(); app.get(\"/\", (req,res)=>res.send(1));");
    const r = await call({ path: "proj6", extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
  });

  // ── High: binary skip, nested dirs, defaults ────────────────────────────
  await test("binary file is skipped without crashing the scan", async () => {
    fs.writeFileSync(path.join(TMP, "proj7-bin.js"), Buffer.from([0, 1, 2, 0, 3]));
    const r = await call({ path: "proj7-bin.js" });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("nested sub-directory scanning aggregates without crashing", async () => {
    writeFile("proj8/sub/deep/nested.js", "const app = require(\"express\")(); app.post(\"/\", (req,res)=>res.send(1));");
    const r = await call({ path: "proj8" });
    assert.strictEqual(r.hasRouteRegistrations, true);
    assert.ok(r.findings.some(f => f.rule === "missing_csp_header"));
  });

  await test("missing path defaults to '.'", async () => {
    const r = await call({});
    assert.ok("hasRouteRegistrations" in r);
  });

  // ── Critical: security & sanitization ───────────────────────────────────
  await test("path traversal is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../etc/passwd" }));
  });

  await test("shell-injection-shaped route path text is only reported, never executed", async () => {
    writeFile("proj9/inj.js", "const app = require(\"express\")(); app.get(\"/x; rm -rf / #\", (req,res)=>res.send(1));");
    const r = await call({ path: "proj9/inj.js" });
    assert.strictEqual(r.hasRouteRegistrations, true);
  });

  await test("result is JSON-serialisable with exact top-level keys", async () => {
    const r = await call({ path: "proj/no-csp.js" });
    assert.doesNotThrow(() => JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r).sort(),
      ["errorCount", "filesScanned", "findings", "findingsCount", "hasCspHint", "hasRouteRegistrations", "path", "truncated", "warningCount"].sort());
  });

  // ── Extreme: fuzzing, truncation, concurrency ───────────────────────────
  await test("max_results truncation sets truncated flag", async () => {
    let big = "const app = require(\"express\")();\n";
    for (let i = 0; i < 20; i++) big += `app.use(helmet({ contentSecurityPolicy: false }));\n`;
    writeFile("proj10/many.js", big);
    const r = await call({ path: "proj10/many.js", max_results: 5 });
    assert.strictEqual(r.findings.length, 5);
    assert.strictEqual(r.truncated, true);
  });

  await test("fuzz: random-byte file content does not crash the scanner", async () => {
    const randBuf = require("crypto").randomBytes(2000);
    fs.writeFileSync(path.join(TMP, "proj10", "rand.js"), randBuf);
    const r = await call({ path: "proj10/rand.js" });
    assert.ok("findings" in r);
  });

  await test("empty directory yields zero findings", async () => {
    fs.mkdirSync(path.join(TMP, "proj11"), { recursive: true });
    const r = await call({ path: "proj11" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("10 concurrent calls return consistent results", async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: "proj4/disabled.js" }));
    const results = await Promise.all(calls);
    const counts = results.map(r => r.findingsCount);
    assert.ok(counts.every(c => c === counts[0]));
  });

  await test("execute_pipeline op-enum registration", async () => {
    const r = await executeTool("execute_pipeline", { steps: [{ op: "check_missing_csp_header", path: "proj/no-csp.js" }] });
    assert.strictEqual(r.steps[0].status, "ok");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
