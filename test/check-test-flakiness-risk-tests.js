"use strict";
// Standalone test script for check_test_flakiness_risk (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "test-flakiness-risk-"));
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

async function call(args) { return executeTool("check_test_flakiness_risk", args); }

(async () => {
  console.log("check_test_flakiness_risk tests:");

  // ── Normal ────────────────────────────────────────────────────────────
  writeFile("proj/bare-timeout.test.js", [
    "it(\"waits then asserts\", () => {",
    "  setTimeout(() => {",
    "    expect(1).toBe(1);",
    "  }, 100);",
    "});",
  ].join("\n"));

  await test("flags bare setTimeout wait with assertion in callback", async () => {
    const r = await call({ path: "proj/bare-timeout.test.js" });
    const f = r.findings.find(x => x.rule === "bare_settimeout_wait");
    assert.ok(f, "expected bare_settimeout_wait finding");
    assert.strictEqual(f.line, 2);
  });

  writeFile("proj/safe-sleep.test.js", [
    "it(\"sleeps safely\", async () => {",
    "  await new Promise(r => setTimeout(r, 10));",
    "  expect(1).toBe(1);",
    "});",
  ].join("\n"));

  await test("does not flag the sanctioned await-new-Promise sleep idiom", async () => {
    const r = await call({ path: "proj/safe-sleep.test.js" });
    assert.strictEqual(r.findings.filter(x => x.rule === "bare_settimeout_wait").length, 0);
  });

  writeFile("proj/date-assert.test.js", [
    "it(\"checks time\", () => {",
    "  expect(Date.now()).toBeGreaterThan(0);",
    "});",
    "it(\"checks random\", () => {",
    "  assert(Math.random() >= 0);",
    "});",
  ].join("\n"));

  await test("flags Date.now() used directly in an assertion", async () => {
    const r = await call({ path: "proj/date-assert.test.js" });
    assert.ok(r.findings.some(x => x.rule === "date_now_or_random_in_assertion" && x.line === 2));
  });

  await test("flags Math.random() used directly in an assertion", async () => {
    const r = await call({ path: "proj/date-assert.test.js" });
    assert.ok(r.findings.some(x => x.rule === "date_now_or_random_in_assertion" && x.line === 5));
  });

  writeFile("proj/faked-timers.test.js", [
    "beforeEach(() => { jest.useFakeTimers(); });",
    "it(\"checks time\", () => {",
    "  expect(Date.now()).toBe(0);",
    "});",
  ].join("\n"));

  await test("does not flag Date.now()/Math.random() when fake timers are hinted", async () => {
    const r = await call({ path: "proj/faked-timers.test.js" });
    assert.strictEqual(r.findings.filter(x => x.rule === "date_now_or_random_in_assertion").length, 0);
  });

  writeFile("proj/shared-state.test.js", [
    "let counter = 0;",
    "it(\"writes counter\", () => {",
    "  counter = 5;",
    "  expect(counter).toBe(5);",
    "});",
    "it(\"reads stale counter\", () => {",
    "  expect(counter).toBe(5);",
    "});",
  ].join("\n"));

  await test("flags module-level mutable state written in one test and read in another", async () => {
    const r = await call({ path: "proj/shared-state.test.js" });
    const f = r.findings.find(x => x.rule === "shared_mutable_state_across_tests");
    assert.ok(f);
    assert.strictEqual(f.variable, "counter");
    assert.deepStrictEqual(f.writtenIn, ["writes counter"]);
    assert.deepStrictEqual(f.usedIn, ["writes counter", "reads stale counter"]);
  });

  writeFile("proj/const-state.test.js", [
    "const FIXTURE = { id: 1 };",
    "it(\"reads a\", () => { expect(FIXTURE.id).toBe(1); });",
    "it(\"reads b\", () => { expect(FIXTURE.id).toBe(1); });",
  ].join("\n"));

  await test("does not flag immutable (const) shared fixtures", async () => {
    const r = await call({ path: "proj/const-state.test.js" });
    assert.strictEqual(r.findings.filter(x => x.rule === "shared_mutable_state_across_tests").length, 0);
  });

  await test("directory scan aggregates findings across files", async () => {
    const r = await call({ path: "proj" });
    assert.ok(r.filesScanned >= 6);
    assert.ok(r.findingsCount >= 4);
  });

  // ── Medium: boundary & parameter validation ─────────────────────────────
  await test("nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: "proj/does-not-exist.js" }));
  });

  await test("max_results type mismatch throws", async () => {
    await assert.rejects(() => call({ path: "proj", max_results: "five" }));
  });

  await test("unrecognized extension on a single file throws", async () => {
    writeFile("proj/notes.txt", "setTimeout(() => { expect(1).toBe(1); }, 10);");
    await assert.rejects(() => call({ path: "proj/notes.txt" }));
  });

  await test("clean file with no antipatterns yields zero findings", async () => {
    writeFile("proj6/clean.test.js", [
      "it(\"adds\", () => {",
      "  expect(1 + 1).toBe(2);",
      "});",
    ].join("\n"));
    const r = await call({ path: "proj6/clean.test.js" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("extensions filter narrows the scan", async () => {
    writeFile("proj7/a.js", "setTimeout(() => { expect(1).toBe(1); }, 10);");
    writeFile("proj7/b.ts", "setTimeout(() => { expect(1).toBe(1); }, 10);");
    const r = await call({ path: "proj7", extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
  });

  // ── High: nested dirs, defaults, same-test-only usage ──────────────────
  await test("variable written and read within the same single test is not flagged", async () => {
    writeFile("proj8/one-test.test.js", [
      "let x = 0;",
      "it(\"does both\", () => {",
      "  x = 1;",
      "  expect(x).toBe(1);",
      "});",
    ].join("\n"));
    const r = await call({ path: "proj8/one-test.test.js" });
    assert.strictEqual(r.findings.filter(f => f.rule === "shared_mutable_state_across_tests").length, 0);
  });

  await test("nested sub-directory scanning aggregates without crashing", async () => {
    writeFile("proj9/sub/deep/nested.test.js", "setTimeout(() => { expect(1).toBe(1); }, 5);");
    const r = await call({ path: "proj9" });
    assert.ok(r.findings.some(f => f.file.includes("nested.test.js")));
  });

  await test("missing path defaults to '.'", async () => {
    const r = await call({});
    assert.ok("findingsCount" in r);
  });

  // ── Critical: security & sanitization ───────────────────────────────────
  await test("path traversal is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../etc/passwd" }));
  });

  await test("shell-injection-shaped assertion text is only reported, never executed", async () => {
    writeFile("proj10/inj.test.js", [
      "it(\"weird\", () => {",
      "  expect(Date.now() + \"; rm -rf / #\").toBeTruthy();",
      "});",
    ].join("\n"));
    const r = await call({ path: "proj10/inj.test.js" });
    const f = r.findings.find(x => x.rule === "date_now_or_random_in_assertion");
    assert.ok(f);
    assert.ok(f.text.includes("rm -rf"));
  });

  await test("result is JSON-serialisable with exact top-level keys", async () => {
    const r = await call({ path: "proj/shared-state.test.js" });
    assert.doesNotThrow(() => JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r).sort(),
      ["filesScanned", "findings", "findingsCount", "path", "truncated"].sort());
  });

  // ── Extreme: fuzzing, truncation, concurrency ───────────────────────────
  await test("max_results truncation sets truncated flag", async () => {
    let big = "";
    for (let i = 0; i < 20; i++) big += `it("t${i}", () => { setTimeout(() => { expect(${i}).toBe(${i}); }, 1); });\n`;
    writeFile("proj11/many.test.js", big);
    const r = await call({ path: "proj11/many.test.js", max_results: 5 });
    assert.strictEqual(r.findings.length, 5);
    assert.strictEqual(r.truncated, true);
  });

  await test("fuzz: random-byte file content does not crash the scanner", async () => {
    const randBuf = require("crypto").randomBytes(2000);
    fs.writeFileSync(path.join(TMP, "proj11", "rand.js"), randBuf);
    const r = await call({ path: "proj11/rand.js" });
    assert.ok("findings" in r);
  });

  await test("empty directory yields zero findings", async () => {
    fs.mkdirSync(path.join(TMP, "proj12"), { recursive: true });
    const r = await call({ path: "proj12" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("10 concurrent calls return consistent results", async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: "proj/shared-state.test.js" }));
    const results = await Promise.all(calls);
    const counts = results.map(r => r.findingsCount);
    assert.ok(counts.every(c => c === counts[0]));
  });

  await test("execute_pipeline op-enum registration", async () => {
    const r = await executeTool("execute_pipeline", { steps: [{ op: "check_test_flakiness_risk", path: "proj/shared-state.test.js" }] });
    assert.strictEqual(r.steps[0].status, "ok");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
