"use strict";
/**
 * Isolated functional tests for browser_* tools.
 * NOT part of test/run-tests.js (that suite is frozen/historical, see task.browser.md).
 * Run standalone: node test/browser-tests.js
 * Launches one real headless Chromium session and reuses it across cases.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-browser-test-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";

const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

const counters = { pass: 0, fail: 0 };
async function test(name, fn) {
  try {
    await fn();
    counters.pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    counters.fail++;
    console.log(`  FAIL - ${name}\n      ${e.message}`);
  }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${b}, got ${a}`); }
function assertOk(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
// fn: () => (value | Promise). Catches both sync throws and async rejections.
async function expectCode(fn, code) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (e.code !== code) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
  }
}

let sessionId;

(async () => {
  console.log("== browser-tests.js ==");

  // ── LEVEL 1: NORMAL (happy path) ──────────────────────────────────────
  await test("browser_launch returns session_id", async () => {
    const r = await executeTool("browser_launch", { headless: true });
    assertOk(r.session_id && typeof r.session_id === "string");
    sessionId = r.session_id;
  });

  await test("browser_navigate to data: URL", async () => {
    const r = await executeTool("browser_navigate", {
      session_id: sessionId,
      url: "data:text/html,<html><body><h1 id='t'>Hi</h1><input id='i'/><button id='b' onclick=\"this.textContent='clicked'\">Go</button></body></html>",
    });
    assertOk(r.url.startsWith("data:"));
  });

  await test("browser_get_content text mode with selector", async () => {
    const r = await executeTool("browser_get_content", { session_id: sessionId, selector: "#t", mode: "text" });
    assertEq(r.content, "Hi");
  });

  await test("browser_evaluate returns JSON-safe result", async () => {
    const r = await executeTool("browser_evaluate", { session_id: sessionId, script: "1+1" });
    assertEq(r.result, 2);
  });

  await test("browser_click updates DOM", async () => {
    await executeTool("browser_click", { session_id: sessionId, selector: "#b" });
    const r = await executeTool("browser_get_content", { session_id: sessionId, selector: "#b" });
    assertEq(r.content, "clicked");
  });

  await test("browser_type fills input", async () => {
    await executeTool("browser_type", { session_id: sessionId, selector: "#i", text: "hello" });
    const r = await executeTool("browser_evaluate", { session_id: sessionId, script: "document.getElementById('i').value" });
    assertEq(r.result, "hello");
  });

  await test("browser_screenshot writes a file", async () => {
    const r = await executeTool("browser_screenshot", { session_id: sessionId, path: "shot.png" });
    assertOk(fs.existsSync(path.join(TMP, "shot.png")), "screenshot file missing");
    assertEq(r.path.replace(/\\/g, "/"), "shot.png");
  });

  await test("browser_get_console_logs returns array", async () => {
    const r = await executeTool("browser_get_console_logs", { session_id: sessionId });
    assertOk(Array.isArray(r.logs));
  });

  await test("browser_list_sessions includes our session", async () => {
    const r = await executeTool("browser_list_sessions", {});
    assertOk(r.sessions.some((s) => s.session_id === sessionId));
  });

  // ── LEVEL 2: MEDIUM (boundary / param validation) ─────────────────────
  await test("browser_navigate missing url -> -32602", () =>
    expectCode(() => executeTool("browser_navigate", { session_id: sessionId }), -32602));

  await test("browser_click missing selector -> -32602", () =>
    expectCode(() => executeTool("browser_click", { session_id: sessionId }), -32602));

  await test("browser_type missing text -> -32602", () =>
    expectCode(() => executeTool("browser_type", { session_id: sessionId, selector: "#i" }), -32602));

  await test("browser_launch missing all fields uses defaults (no throw)", async () => {
    const r = await executeTool("browser_launch", {});
    assertOk(r.session_id);
    await executeTool("browser_close", { session_id: r.session_id });
  });

  await test("browser_navigate wrong-type timeout still works (coerced/ignored)", async () => {
    const r = await executeTool("browser_navigate", { session_id: sessionId, url: "about:blank", timeout: "not-a-number" });
    assertOk(r.url === "about:blank");
  });

  // ── LEVEL 3: HIGH (dependency/session failures) ───────────────────────
  await test("unknown session_id -> -32602 clean error", () =>
    expectCode(() => executeTool("browser_get_content", { session_id: "does-not-exist" }), -32602));

  await test("navigate to unreachable host -> -32603, no crash", () =>
    expectCode(() => executeTool("browser_navigate", { session_id: sessionId, url: "http://127.0.0.1:1/", timeout: 2000 }), -32603));

  await test("evaluate() throwing script -> -32603 clean error", () =>
    expectCode(() => executeTool("browser_evaluate", { session_id: sessionId, script: "throw new Error('boom')" }), -32603));

  await test("click on missing selector -> -32603 clean error", () =>
    expectCode(() => executeTool("browser_click", { session_id: sessionId, selector: "#nope-xyz", timeout: 1000 }), -32603));

  // ── LEVEL 4: CRITICAL (security / sanitization) ───────────────────────
  // Path jailing is enforced by lib/roots.js (shared by every tool); it
  // throws a plain Error, not a coded ToolError — same convention the rest
  // of the test suite uses (assert.throws / message-contains, not a code).
  await test("screenshot path traversal rejected", async () => {
    try {
      await executeTool("browser_screenshot", { session_id: sessionId, path: "../../../etc/passwd" });
      throw new Error("expected throw, none occurred");
    } catch (e) {
      assertOk(/access denied|outside root/i.test(e.message), `unexpected error: ${e.message}`);
    }
  });

  await test("evaluate() runs in page sandbox, no Node access", async () => {
    const r = await executeTool("browser_evaluate", { session_id: sessionId, script: "typeof process === 'undefined' && typeof require === 'undefined'" });
    assertEq(r.result, true);
  });

  await test("selector with injection-like string doesn't crash, clean error", () =>
    expectCode(() => executeTool("browser_click", { session_id: sessionId, selector: "';DROP TABLE x;--", timeout: 500 }), -32603));

  await test("script HTML/script-tag payload stays inert (JSON-serialized, not executed as host code)", async () => {
    const r = await executeTool("browser_evaluate", { session_id: sessionId, script: "'<script>alert(1)</script>'" });
    assertEq(r.result, "<script>alert(1)</script>");
  });

  // ── LEVEL 5: EXTREME (fuzzing / concurrency / cleanup) ────────────────
  await test("fuzz: random-byte selector doesn't crash server", async () => {
    const junk = Buffer.from(Array.from({ length: 200 }, () => Math.floor(Math.random() * 256))).toString();
    try { await executeTool("browser_click", { session_id: sessionId, selector: junk, timeout: 300 }); }
    catch (e) { assertOk(typeof e.code === "number"); }
  });

  await test("concurrency: parallel launches + closes all resolve cleanly", async () => {
    const launches = await Promise.all([1, 2, 3].map(() => executeTool("browser_launch", { headless: true })));
    assertEq(launches.length, 3);
    const ids = new Set(launches.map((l) => l.session_id));
    assertEq(ids.size, 3, "session ids collided");
    await Promise.all(launches.map((l) => executeTool("browser_close", { session_id: l.session_id })));
    const after = await executeTool("browser_list_sessions", {});
    for (const l of launches) assertOk(!after.sessions.some((s) => s.session_id === l.session_id));
  });

  await test("browser_close is idempotent-safe (second close -> -32602, no crash)", async () => {
    const r = await executeTool("browser_launch", { headless: true });
    await executeTool("browser_close", { session_id: r.session_id });
    await expectCode(() => executeTool("browser_close", { session_id: r.session_id }), -32602);
  });

  // ── cleanup ─────────────────────────────────────────────────────────
  await test("final browser_close of main session", () => executeTool("browser_close", { session_id: sessionId }));

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
