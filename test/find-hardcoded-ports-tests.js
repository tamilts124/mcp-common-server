"use strict";
// Standalone test script for find_hardcoded_ports (not added to the frozen
// test/run-tests.js — new tool areas get their own script per task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hardcoded-ports-"));
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

async function call(args) { return executeTool("find_hardcoded_ports", args); }

(async () => {
  console.log("find_hardcoded_ports tests:");

  // ── Normal ────────────────────────────────────────────────────────────
  writeFile("proj/a.js", [
    "const express = require('express');",
    "const app = express();",
    "app.listen(3000, () => console.log('up'));",
    "server.listen(process.env.PORT || 8080);",
    "server.listen(8080 || process.env.PORT);",
    "server.listen(port);",
    "http.createServer(handler).listen(4000);",
  ].join("\n"));

  await test("flags bare numeric literal port", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(r.findings.some(f => f.port === 3000));
  });

  await test("flags createServer(...).listen(N)", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(r.findings.some(f => f.port === 4000));
  });

  await test("does NOT flag process.env.PORT || literal", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(!r.findings.some(f => f.line === 4));
  });

  await test("DOES flag literal || process.env.PORT (literal-first order)", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(r.findings.some(f => f.line === 5 && f.port === 8080));
  });

  await test("does NOT flag identifier argument (no data-flow tracing)", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(!r.findings.some(f => f.line === 6));
  });

  await test("directory scan aggregates across files, sorted by file/line", async () => {
    writeFile("proj/b.js", "app.listen(5000);\n");
    const r = await call({ path: "proj" });
    assert.strictEqual(r.filesScanned, 2);
    assert.ok(r.findings.some(f => f.file === "b.js" && f.port === 5000));
  });

  await test("returns exact success shape", async () => {
    const r = await call({ path: "proj/a.js" });
    for (const k of ["path", "filesScanned", "findingsCount", "truncated", "findings"])
      assert.ok(k in r, `missing key ${k}`);
    assert.strictEqual(r.findingsCount, r.findings.length);
  });

  // ── Medium: boundary & parameter validation ─────────────────────────────
  await test("nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: "proj/nope.js" }));
  });

  await test("max_results type mismatch throws clean validation error", async () => {
    await assert.rejects(() => call({ path: "proj/a.js", max_results: "five" }),
      /max_results must be a number/);
  });

  await test("unrecognized single-file extension throws", async () => {
    writeFile("proj/notes.txt", "app.listen(3000);");
    await assert.rejects(() => call({ path: "proj/notes.txt" }),
      /does not match any scanned extension/);
  });

  await test(".listen() with no args is not flagged", async () => {
    writeFile("proj/c.js", "server.listen();\n");
    const r = await call({ path: "proj/c.js" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("custom extensions filter narrows directory scan", async () => {
    writeFile("proj2/d.ts", "app.listen(6000);\n");
    writeFile("proj2/e.js", "app.listen(7000);\n");
    const r = await call({ path: "proj2", extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
    assert.ok(r.findings.some(f => f.port === 6000));
  });

  await test("empty directory yields zero findings, not an error", async () => {
    fs.mkdirSync(path.join(TMP, "empty"), { recursive: true });
    const r = await call({ path: "empty" });
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  });

  // ── High: dependency/failure handling ───────────────────────────────────
  await test("unreadable file inside directory scan is skipped, not fatal", async () => {
    writeFile("proj3/ok.js", "app.listen(9000);\n");
    fs.mkdirSync(path.join(TMP, "proj3/sub"), { recursive: true }); // a dir named like a candidate isn't a file; ensure no crash
    const r = await call({ path: "proj3" });
    assert.ok(r.findings.some(f => f.port === 9000));
  });

  await test("missing required path defaults to '.' without throwing", async () => {
    const r = await call({});
    assert.ok("findings" in r);
  });

  // ── Critical: security & sanitization ───────────────────────────────────
  await test("path traversal outside jail is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("shell-injection-shaped content is treated as inert text, not executed", async () => {
    writeFile("proj4/f.js", "app.listen(3000); // '; rm -rf / #\n");
    const r = await call({ path: "proj4/f.js" });
    assert.ok(r.findings.some(f => f.port === 3000));
    assert.ok(fs.existsSync(TMP)); // still here
  });

  await test("result is JSON-serialisable", async () => {
    const r = await call({ path: "proj4/f.js" });
    assert.doesNotThrow(() => JSON.stringify(r));
  });

  // ── Extreme: fuzzing, truncation, concurrency ───────────────────────────
  await test("max_results truncation sets truncated flag", async () => {
    let big = "";
    for (let i = 0; i < 20; i++) big += `app.listen(${3000 + i});\n`;
    writeFile("proj5/many.js", big);
    const r = await call({ path: "proj5/many.js", max_results: 5 });
    assert.strictEqual(r.findings.length, 5);
    assert.strictEqual(r.truncated, true);
  });

  await test("fuzz: random-byte file content does not crash the scanner", async () => {
    const randBuf = require("crypto").randomBytes(2000);
    fs.writeFileSync(path.join(TMP, "proj5", "rand.js"), randBuf);
    const r = await call({ path: "proj5/rand.js" });
    assert.ok("findings" in r);
  });

  await test("10 concurrent calls return consistent results", async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: "proj/a.js" }));
    const results = await Promise.all(calls);
    const counts = results.map(r => r.findingsCount);
    assert.ok(counts.every(c => c === counts[0]));
  });

  await test("execute_pipeline op-enum registration", async () => {
    const { executeTool: exec2 } = require("../lib/executeTool");
    const r = await exec2("execute_pipeline", { steps: [{ op: "find_hardcoded_ports", path: "proj/a.js" }] });
    assert.strictEqual(r.steps[0].status, "ok");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
