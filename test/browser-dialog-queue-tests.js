"use strict";
/**
 * Standalone tests for dialog queueing (browser_handle_next_dialog queue:true)
 * and browser_wait_for_dialog. NOT added to frozen test/browser-tests.js.
 * Run: node test/browser-dialog-queue-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dialog-queue-test-"));
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
function assertOk(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
async function expectThrow(fn, code) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (code !== undefined && e.code !== code) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
  }
}

let sessionId;

(async () => {
  console.log("== browser-dialog-queue-tests.js ==");

  await test("browser_launch returns session_id", async () => {
    const r = await executeTool("browser_launch", { headless: true });
    assertOk(r.session_id && typeof r.session_id === "string");
    sessionId = r.session_id;
  });

  // ── Normal ────────────────────────────────────────────────────────
  await test("queue:true arms two one-shots consumed in FIFO order (normal)", async () => {
    await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "accept", queue: true });
    const r2 = await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "dismiss", queue: true });
    assertEq(r2.queue_length, 2);
    const before = (await executeTool("browser_get_dialog_log", { session_id: sessionId })).count;
    executeTool("browser_evaluate", { session_id: sessionId, script: "confirm('a'); confirm('b');" }).catch(() => {});
    let log;
    for (let i = 0; i < 30; i++) {
      log = (await executeTool("browser_get_dialog_log", { session_id: sessionId })).dialogs;
      if (log.length >= before + 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assertEq(log[log.length - 2].handledAction, "accept");
    assertEq(log[log.length - 1].handledAction, "dismiss");
  });

  await test("non-queue call replaces pending queue (normal)", async () => {
    await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "accept", queue: true });
    const r = await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "dismiss" });
    assertEq(r.queue_length, 1);
  });

  await test("browser_wait_for_dialog resolves with dialog info when one fires (normal)", async () => {
    const waitP = executeTool("browser_wait_for_dialog", { session_id: sessionId, timeout_ms: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    executeTool("browser_evaluate", { session_id: sessionId, script: "confirm('waited')" }).catch(() => {});
    const r = await waitP;
    assertEq(r.timed_out, false);
    assertOk(r.dialog && r.dialog.message === "waited");
  });

  // ── Medium: param validation ─────────────────────────────────────
  await test("browser_wait_for_dialog missing session_id -> throws (medium)", () =>
    expectThrow(() => executeTool("browser_wait_for_dialog", {})));
  await test("browser_handle_next_dialog invalid action -> -32602 (medium)", () =>
    expectThrow(() => executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "bogus" }), -32602));

  // ── High: timeout with no dialog firing ──────────────────────────
  await test("browser_wait_for_dialog times out cleanly when no dialog fires (high)", async () => {
    const r = await executeTool("browser_wait_for_dialog", { session_id: sessionId, timeout_ms: 300 });
    assertEq(r.timed_out, true);
    assertEq(r.dialog, null);
  });

  // ── Critical: unknown/invalid session ─────────────────────────────
  await test("browser_wait_for_dialog unknown session_id -> throws (critical)", () =>
    expectThrow(() => executeTool("browser_wait_for_dialog", { session_id: "not-a-real-session" })));
  await test("browser_handle_next_dialog queue overflow rejected (critical)", async () => {
    for (let i = 0; i < 50; i++) {
      await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "accept", queue: true });
    }
    await expectThrow(() => executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "accept", queue: true }), -32602);
  });

  // ── Extreme: multiple concurrent waiters resolved in FIFO order ──
  await test("multiple concurrent browser_wait_for_dialog calls resolve one-per-dialog in order (extreme)", async () => {
    // Drain the queue from the overflow test above by triggering + auto-consuming dialogs first.
    executeTool("browser_evaluate", {
      session_id: sessionId,
      script: "for (let i = 0; i < 50; i++) confirm('drain' + i);",
    }).catch(() => {});
    // Wait for the drain to actually finish before starting fresh waiters.
    await new Promise((resolve) => {
      const check = async () => {
        const log = (await executeTool("browser_get_dialog_log", { session_id: sessionId, limit: 1 })).dialogs;
        if (log[0] && log[0].message === "drain49") return resolve();
        setTimeout(check, 100);
      };
      check();
    });

    const w1 = executeTool("browser_wait_for_dialog", { session_id: sessionId, timeout_ms: 5000 });
    const w2 = executeTool("browser_wait_for_dialog", { session_id: sessionId, timeout_ms: 5000 });
    const w3 = executeTool("browser_wait_for_dialog", { session_id: sessionId, timeout_ms: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    executeTool("browser_evaluate", { session_id: sessionId, script: "confirm('x1'); confirm('x2'); confirm('x3');" }).catch(() => {});
    const [r1, r2, r3] = await Promise.all([w1, w2, w3]);
    assertEq(r1.dialog.message, "x1");
    assertEq(r2.dialog.message, "x2");
    assertEq(r3.dialog.message, "x3");
  });

  await test("final browser_close", () => executeTool("browser_close", { session_id: sessionId }));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail ? 1 : 0);
})();
