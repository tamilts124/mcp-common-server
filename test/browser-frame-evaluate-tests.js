"use strict";
/**
 * Standalone tests for browser_frame_evaluate. NOT added to frozen
 * test/browser-tests.js. Run: node test/browser-frame-evaluate-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-frame-eval-test-"));
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
const IFRAME_URL = "data:text/html," + encodeURIComponent(
  `<html><body><title>parent</title><div id="decoy">not a frame</div><iframe id="frameA" srcdoc="<title>childtitle</title><div id='x'>42</div>"></iframe></body></html>`
);

(async () => {
  console.log("== browser-frame-evaluate-tests.js ==");

  await test("browser_launch + navigate to iframe fixture", async () => {
    const r = await executeTool("browser_launch", { headless: true });
    sessionId = r.session_id;
    await executeTool("browser_navigate", { session_id: sessionId, url: IFRAME_URL });
  });

  // Normal
  await test("evaluates in frame's own document context, not parent (normal)", async () => {
    const r = await executeTool("browser_frame_evaluate", { session_id: sessionId, frame_selector: "#frameA", script: "document.title" });
    assertEq(r.result, "childtitle");
  });
  await test("evaluates function-body script inside frame (normal)", async () => {
    const r = await executeTool("browser_frame_evaluate", { session_id: sessionId, frame_selector: "#frameA", script: "document.getElementById('x').textContent" });
    assertEq(r.result, "42");
  });
  await test("parent page.evaluate unaffected by frame scoping (normal)", async () => {
    const r = await executeTool("browser_evaluate", { session_id: sessionId, script: "document.title" });
    assertEq(r.result, "parent");
  });

  // Medium: param validation
  await test("missing session_id -> throws (medium)", () =>
    expectThrow(() => executeTool("browser_frame_evaluate", { frame_selector: "#frameA", script: "1" })));
  await test("missing frame_selector -> -32602 (medium)", () =>
    expectThrow(() => executeTool("browser_frame_evaluate", { session_id: sessionId, script: "1" }), -32602));
  await test("missing script -> -32602 (medium)", () =>
    expectThrow(() => executeTool("browser_frame_evaluate", { session_id: sessionId, frame_selector: "#frameA" }), -32602));

  // High: dependency-style failure (nonexistent frame times out)
  await test("nonexistent frame_selector -> throws cleanly (high)", () =>
    expectThrow(() => executeTool("browser_frame_evaluate", { session_id: sessionId, frame_selector: "#no-such-frame", script: "1", timeout: 500 })));

  // Critical: injection-shaped script string treated as literal code, not special
  await test("script containing quotes/HTML-shaped payload runs as plain JS, not injected into DOM (critical)", async () => {
    const r = await executeTool("browser_frame_evaluate", {
      session_id: sessionId, frame_selector: "#frameA",
      script: "'<script>window.__x=1</script>'.length",
    });
    assertEq(r.result, 29);
  });
  await test("unknown session_id -> throws (critical)", () =>
    expectThrow(() => executeTool("browser_frame_evaluate", { session_id: "not-real", frame_selector: "#frameA", script: "1" })));

  // Extreme: huge script fuzz + selector targeting a non-iframe element
  await test("huge script string does not crash the process (extreme)", async () => {
    const big = "1+".repeat(20000) + "1";
    const r = await executeTool("browser_frame_evaluate", { session_id: sessionId, frame_selector: "#frameA", script: big });
    assertEq(r.result, 20001);
  });
  await test("frame_selector matching a non-iframe element -> clean error, not a crash (extreme)", () =>
    expectThrow(() => executeTool("browser_frame_evaluate", { session_id: sessionId, frame_selector: "#decoy", script: "1", timeout: 500 })));

  await test("final browser_close", () => executeTool("browser_close", { session_id: sessionId }));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail ? 1 : 0);
})();
