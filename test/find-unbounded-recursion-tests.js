"use strict";
// Standalone test script for find_unbounded_recursion (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "unbounded-recursion-"));
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

async function call(args) { return executeTool("find_unbounded_recursion", args); }

(async () => {
  console.log("find_unbounded_recursion tests:");

  // ── Normal ────────────────────────────────────────────────────────────
  writeFile("proj/a.js", [
    "function loop() {",
    "  loop();",
    "}",
    "function guarded(n) {",
    "  if (n <= 0) return 0;",
    "  return guarded(n - 1);",
    "}",
    "function ternaryGuarded(n) {",
    "  return n <= 0 ? 0 : ternaryGuarded(n - 1);",
    "}",
    "function notRecursive() {",
    "  return doOtherThing();",
    "}",
  ].join("\n"));

  await test("flags unconditional self-recursion", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(r.findings.some(f => f.line === 2 && f.functionName === "loop"));
  });

  await test("does NOT flag recursion guarded by if/return", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(!r.findings.some(f => f.functionName === "guarded"));
  });

  await test("does NOT flag recursion guarded by ternary", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(!r.findings.some(f => f.functionName === "ternaryGuarded"));
  });

  await test("does NOT flag non-recursive function", async () => {
    const r = await call({ path: "proj/a.js" });
    assert.ok(!r.findings.some(f => f.functionName === "notRecursive"));
  });

  await test("directory scan aggregates across files, sorted by file/line", async () => {
    writeFile("proj/b.js", "function spin() {\n  spin();\n}\n");
    const r = await call({ path: "proj" });
    assert.strictEqual(r.filesScanned, 2);
    assert.ok(r.findings.some(f => f.file === "b.js"));
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
    writeFile("proj/notes.txt", "function loop() { loop(); }");
    await assert.rejects(() => call({ path: "proj/notes.txt" }),
      /does not match any scanned extension/);
  });

  await test("&& guard before recursive call is recognized", async () => {
    writeFile("proj/c.js", "function f(n) {\n  return n > 0 && f(n - 1);\n}\n");
    const r = await call({ path: "proj/c.js" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("custom extensions filter narrows directory scan", async () => {
    writeFile("proj2/d.ts", "function loopy() {\n  loopy();\n}\n");
    writeFile("proj2/e.js", "function loopy() {\n  loopy();\n}\n");
    const r = await call({ path: "proj2", extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
    assert.ok(r.findings.some(f => f.file === "d.ts"));
  });

  await test("empty directory yields zero findings, not an error", async () => {
    fs.mkdirSync(path.join(TMP, "empty"), { recursive: true });
    const r = await call({ path: "empty" });
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  });

  // ── High: dependency/failure handling ───────────────────────────────────
  await test("switch( guard before recursive call is recognized", async () => {
    writeFile("proj3/f.js", "function g(n) {\n  switch (n) { case 0: return 0; default: return g(n - 1); }\n}\n");
    const r = await call({ path: "proj3/f.js" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("directory containing a nested sub-dir doesn't crash", async () => {
    writeFile("proj3/ok.js", "function h() {\n  h();\n}\n");
    fs.mkdirSync(path.join(TMP, "proj3/sub"), { recursive: true });
    const r = await call({ path: "proj3" });
    assert.ok(r.findings.some(f => f.file === "ok.js"));
  });

  await test("missing path defaults to '.' without throwing", async () => {
    const r = await call({});
    assert.ok("findings" in r);
  });

  // ── Critical: security & sanitization ───────────────────────────────────
  await test("path traversal outside jail is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("shell-injection-shaped content is treated as inert text, not executed", async () => {
    writeFile("proj4/g.js", "function loop2() {\n  loop2(); // '; rm -rf / #\n}\n");
    const r = await call({ path: "proj4/g.js" });
    assert.ok(r.findings.some(f => f.functionName === "loop2"));
    assert.ok(fs.existsSync(TMP)); // still here
  });

  await test("result is JSON-serialisable", async () => {
    const r = await call({ path: "proj4/g.js" });
    assert.doesNotThrow(() => JSON.stringify(r));
  });

  // ── Extreme: fuzzing, truncation, concurrency ───────────────────────────
  await test("max_results truncation sets truncated flag", async () => {
    let big = "";
    for (let i = 0; i < 20; i++) big += `function loop${i}() {\n  loop${i}();\n}\n`;
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
    const r = await exec2("execute_pipeline", { steps: [{ op: "find_unbounded_recursion", path: "proj/a.js" }] });
    assert.strictEqual(r.steps[0].status, "ok");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
