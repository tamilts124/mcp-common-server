"use strict";
/**
 * Standalone tests for browser_start_recording/stop_recording/get_recording/
 * clear_recording/replay_actions. NOT added to frozen test/browser-tests.js.
 * Run: node test/browser-replay-actions-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-replay-test-"));
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
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
async function expectThrow(fn, code) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (code !== undefined && e.code !== code) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
  }
}

let sessionId, targetId;
const BLANK = "about:blank";

(async () => {
  console.log("== browser-replay-actions-tests.js ==");

  await test("browser_launch", async () => {
    const r = await executeTool("browser_launch", { headless: true });
    sessionId = r.session_id;
  });

  // Normal — recording lifecycle + replay happy path
  await test("start_recording then navigate+evaluate get recorded (normal)", async () => {
    const r0 = await executeTool("browser_start_recording", { session_id: sessionId });
    assertEq(r0.recording, true);
    assertEq(r0.actionCount, 0);
    await executeTool("browser_navigate", { session_id: sessionId, url: BLANK });
    await executeTool("browser_evaluate", { session_id: sessionId, script: "1+1" });
    const r1 = await executeTool("browser_get_recording", { session_id: sessionId });
    assertEq(r1.actionCount, 2);
    assertEq(r1.actions[0].tool, "browser_navigate");
    assertEq(r1.actions[1].tool, "browser_evaluate");
  });

  await test("stop_recording returns the log and stops further recording (normal)", async () => {
    const r = await executeTool("browser_stop_recording", { session_id: sessionId });
    assertEq(r.recording, false);
    assertEq(r.actionCount, 2);
    await executeTool("browser_evaluate", { session_id: sessionId, script: "2+2" });
    const r2 = await executeTool("browser_get_recording", { session_id: sessionId });
    assertEq(r2.actionCount, 2, "should not have grown while stopped");
  });

  await test("replay_actions replays own recording onto same session (normal)", async () => {
    const r = await executeTool("browser_replay_actions", { session_id: sessionId });
    assertEq(r.totalActions, 2);
    assertEq(r.replayed, 2);
    assertEq(r.failed, 0);
    assertEq(r.results[1].result.result, 2);
  });

  // Medium — param validation / boundaries
  await test("missing session_id on start_recording -> throws (medium)", () =>
    expectThrow(() => executeTool("browser_start_recording", {}), -32602));
  await test("clear_recording resets count to 0 (medium)", async () => {
    const r = await executeTool("browser_clear_recording", { session_id: sessionId });
    assertEq(r.actionCount, 0);
  });
  await test("replay_actions with empty actions array throws -32602 (medium)", () =>
    expectThrow(() => executeTool("browser_replay_actions", { session_id: sessionId, actions: [] }), -32602));
  await test("replay_actions with no recording and no actions throws -32602 (medium)", () =>
    expectThrow(() => executeTool("browser_replay_actions", { session_id: sessionId }), -32602));
  await test("replay_actions non-array actions throws -32602 (medium)", () =>
    expectThrow(() => executeTool("browser_replay_actions", { session_id: sessionId, actions: "nope" }), -32602));

  // High — dependency-failure-style (unknown tool / failing action)
  await test("replay stops on unknown tool by default (high)", async () => {
    const r = await executeTool("browser_replay_actions", {
      session_id: sessionId,
      actions: [{ tool: "browser_not_a_real_tool", args: {} }, { tool: "browser_evaluate", args: { script: "1" } }],
    });
    assertEq(r.failed, 1);
    assertEq(r.replayed, 0, "stop_on_error default true should skip the 2nd action");
    assertEq(r.results.length, 1);
  });
  await test("stop_on_error:false continues past a failing action (high)", async () => {
    const r = await executeTool("browser_replay_actions", {
      session_id: sessionId,
      stop_on_error: false,
      actions: [{ tool: "browser_not_a_real_tool", args: {} }, { tool: "browser_evaluate", args: { script: "42" } }],
    });
    assertEq(r.failed, 1);
    assertEq(r.replayed, 1);
    assertEq(r.results[1].result.result, 42);
  });
  await test("side-effect tool skipped by default, replayable with include_side_effects (high)", async () => {
    const shotPath = "shot.png";
    const r = await executeTool("browser_replay_actions", {
      session_id: sessionId,
      actions: [{ tool: "browser_screenshot", args: { path: shotPath } }],
    });
    assertEq(r.skipped, 1);
    assertEq(r.replayed, 0);
    const r2 = await executeTool("browser_replay_actions", {
      session_id: sessionId,
      include_side_effects: true,
      actions: [{ tool: "browser_screenshot", args: { path: shotPath } }],
    });
    assertEq(r2.replayed, 1);
  });
  await test("control/lifecycle tools in actions list are skipped, not replayed (high)", async () => {
    const r = await executeTool("browser_replay_actions", {
      session_id: sessionId,
      actions: [{ tool: "browser_launch", args: {} }, { tool: "browser_close", args: {} }, { tool: "browser_evaluate", args: { script: "7" } }],
    });
    assertEq(r.skipped, 2);
    assertEq(r.replayed, 1);
  });

  // Critical — security / unknown session
  await test("unknown session_id on replay -> throws (critical)", () =>
    expectThrow(() => executeTool("browser_replay_actions", { session_id: "not-real", actions: [{ tool: "browser_evaluate", args: { script: "1" } }] })));
  await test("injection-shaped script content round-trips literally as data, not executed as shell (critical)", async () => {
    const payload = "'; DROP TABLE users; -- $(rm -rf /)";
    const r = await executeTool("browser_replay_actions", {
      session_id: sessionId,
      actions: [{ tool: "browser_evaluate", args: { script: `(${JSON.stringify(payload)})` } }],
    });
    assertEq(r.results[0].result.result, payload);
  });
  await test("action.args.session_id is ignored and overridden by target session (critical)", async () => {
    const r2 = await executeTool("browser_launch", { headless: true });
    targetId = r2.session_id;
    const r = await executeTool("browser_replay_actions", {
      session_id: sessionId,
      target_session_id: targetId,
      actions: [{ tool: "browser_evaluate", args: { session_id: "attacker-controlled-id", script: "99" } }],
    });
    assertEq(r.session_id, targetId);
    assertEq(r.results[0].result.result, 99);
  });

  // Extreme — fuzz / large payload / cleanup
  await test("action missing 'tool' field errors cleanly, no crash (extreme)", async () => {
    const r = await executeTool("browser_replay_actions", { session_id: sessionId, stop_on_error: false, actions: [{ args: {} }, { tool: 123 }, { tool: "browser_evaluate", args: { script: "5" } }] });
    assertEq(r.failed, 2);
    assertEq(r.replayed, 1);
  });
  await test("501 actions rejected (max 500 per call) (extreme)", () =>
    expectThrow(() => executeTool("browser_replay_actions", {
      session_id: sessionId,
      actions: Array.from({ length: 501 }, () => ({ tool: "browser_evaluate", args: { script: "1" } })),
    }), -32602));
  await test("500 actions replay successfully (extreme boundary)", async () => {
    const r = await executeTool("browser_replay_actions", {
      session_id: sessionId,
      actions: Array.from({ length: 500 }, () => ({ tool: "browser_evaluate", args: { script: "1" } })),
    });
    assertEq(r.totalActions, 500);
    assertEq(r.replayed, 500);
  });
  await test("recording caps at 500 entries (oldest dropped) (extreme)", async () => {
    await executeTool("browser_start_recording", { session_id: targetId });
    for (let i = 0; i < 520; i++) await executeTool("browser_evaluate", { session_id: targetId, script: String(i) });
    const r = await executeTool("browser_get_recording", { session_id: targetId });
    assert(r.actionCount === 500, "actionCount=" + r.actionCount);
    assertEq(r.actions[0].args.script, "20", "oldest 20 entries should have been dropped");
  });

  await test("final cleanup", async () => {
    await executeTool("browser_close", { session_id: sessionId });
    await executeTool("browser_close", { session_id: targetId });
    try { fs.rmSync(path.join(TMP, "shot.png"), { force: true }); } catch (_) {}
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail ? 1 : 0);
})();
