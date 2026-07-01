"use strict";
/**
 * Standalone tests for browser_set_viewport. NOT added to frozen
 * test/browser-tests.js. Run: node test/browser-set-viewport-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-viewport-test-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";

const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { installCrashGuard } = require("../lib/crashGuard");
installCrashGuard();

const counters = { pass: 0, fail: 0 };
async function test(name, fn) {
  try { await fn(); counters.pass++; console.log(`  ok - ${name}`); }
  catch (e) { counters.fail++; console.log(`  FAIL - ${name}\n      ${e.message}`); }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function expectThrow(fn, code) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (code !== undefined && e.code !== code) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
  }
}

let sessionId;

(async () => {
  console.log("== browser-set-viewport-tests.js ==");

  await test("browser_launch", async () => {
    const r = await executeTool("browser_launch", { headless: true });
    sessionId = r.session_id;
  });

  // Normal
  await test("resizes viewport and takes effect (normal)", async () => {
    const r = await executeTool("browser_set_viewport", { session_id: sessionId, width: 800, height: 600 });
    assertEq(r.viewport.width, 800);
    assertEq(r.viewport.height, 600);
    const check = await executeTool("browser_evaluate", { session_id: sessionId, script: "window.innerWidth" });
    assertEq(check.result, 800);
  });

  // Medium: param validation
  await test("missing session_id -> throws (medium)", () =>
    expectThrow(() => executeTool("browser_set_viewport", { width: 800, height: 600 })));
  await test("missing width -> -32602 (medium)", () =>
    expectThrow(() => executeTool("browser_set_viewport", { session_id: sessionId, height: 600 }), -32602));
  await test("string instead of number -> -32602 (medium)", () =>
    expectThrow(() => executeTool("browser_set_viewport", { session_id: sessionId, width: "wide", height: 600 }), -32602));
  await test("zero/negative rejected (medium)", () =>
    expectThrow(() => executeTool("browser_set_viewport", { session_id: sessionId, width: 0, height: -5 }), -32602));

  // Critical: unknown session
  await test("unknown session_id -> throws (critical)", () =>
    expectThrow(() => executeTool("browser_set_viewport", { session_id: "not-real", width: 800, height: 600 })));

  // Extreme: large-but-safe fuzz value (999999 crashes the renderer per prior
  // finding in browser_emulate testing — reuse the same safe ceiling)
  await test("large viewport within safe bound succeeds (extreme)", async () => {
    const r = await executeTool("browser_set_viewport", { session_id: sessionId, width: 8000, height: 8000 });
    assertEq(r.viewport.width, 8000);
  });

  await test("final browser_close", () => executeTool("browser_close", { session_id: sessionId }));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail ? 1 : 0);
})();
