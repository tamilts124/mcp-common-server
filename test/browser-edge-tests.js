"use strict";
/**
 * Standalone edge-case tests for browser_* tools, separate from the now-frozen
 * test/browser-tests.js bulk suite (see task.browser.md — that file must not
 * be extended or re-run). Run: node test/browser-edge-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-browser-edge-test-"));
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
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${b}, got ${a}`); }
function assertOk(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
async function expectCode(fn, code) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (e.code !== code) throw new Error(`expected code ${code}, got ${e.code}: ${e.message}`);
  }
}
async function waitForNewDialog(sessionId, previousCount, tries = 30, delayMs = 100) {
  for (let i = 0; i < tries; i++) {
    const r = await executeTool("browser_get_dialog_log", { session_id: sessionId });
    if (r.count > previousCount) return r.dialogs;
    await new Promise((res) => setTimeout(res, delayMs));
  }
  throw new Error("dialog log did not grow in time");
}

let sessionId;

(async () => {
  console.log("== browser-edge-tests.js ==");

  await test("browser_launch returns session_id", async () => {
    const r = await executeTool("browser_launch", { headless: true });
    assertOk(r.session_id && typeof r.session_id === "string");
    sessionId = r.session_id;
  });

  // ── Sequential dialogs / dialog+navigate ────────────────────────────
  await test("second dialog auto-dismisses after one-shot arm consumed by first (normal)", async () => {
    const before = (await executeTool("browser_get_dialog_log", { session_id: sessionId })).count;
    await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "accept" });
    executeTool("browser_evaluate", { session_id: sessionId, script: "confirm('one'); confirm('two');" }).catch(() => {});
    let log = await waitForNewDialog(sessionId, before);
    log = await waitForNewDialog(sessionId, before + 1);
    assertEq(log.length, before + 2);
    assertEq(log[before].handledAction, "accept");
    assertEq(log[before + 1].handledAction, "auto-dismiss");
  });
  await test("session usable after browser_navigate shortly following a dialog (extreme)", async () => {
    executeTool("browser_evaluate", { session_id: sessionId, script: "confirm('bye')" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    const r = await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<p>ok</p>" });
    assertOk(!!r.url);
  });

  // ── Cross-frame drag-and-drop ────────────────────────────────────────
  const DND_A = "<div id=\"src\" style=\"width:40px;height:40px;background:red;\">S</div>";
  const DND_B = "<div id=\"tgt\" style=\"width:40px;height:40px;background:blue;margin-top:80px;\" onmouseup=\"parent.document.title='DROPPED'\">T</div>";
  const DND_URL = "data:text/html," + encodeURIComponent(
    `<html><body><title>none</title><iframe id="frameA" srcdoc="${DND_A.replace(/"/g, "&quot;")}"></iframe><iframe id="frameB" srcdoc="${DND_B.replace(/"/g, "&quot;")}"></iframe></body></html>`
  );
  await test("browser_navigate to cross-frame DnD fixture", () => executeTool("browser_navigate", { session_id: sessionId, url: DND_URL }));
  await test("browser_drag_and_drop across iframe boundaries (normal)", async () => {
    const r = await executeTool("browser_drag_and_drop", {
      session_id: sessionId, source: "#src", target: "#tgt",
      source_frame_selector: "#frameA", target_frame_selector: "#frameB",
    });
    assertEq(r.cross_frame, true);
    assertEq(r.status, "dropped");
    const title = await executeTool("browser_evaluate", { session_id: sessionId, script: "document.title" });
    assertEq(title.result, "DROPPED");
  });
  await test("browser_drag_and_drop cross-frame unknown source_frame_selector times out -> -32603 (high)", () =>
    expectCode(() => executeTool("browser_drag_and_drop", {
      session_id: sessionId, source: "#src", target: "#tgt",
      source_frame_selector: "#no-such-frame", target_frame_selector: "#frameB", timeout: 500,
    }), -32603));
  await test("browser_drag_and_drop cross-frame missing source element -> -32603 (critical)", () =>
    expectCode(() => executeTool("browser_drag_and_drop", {
      session_id: sessionId, source: "#missing", target: "#tgt",
      source_frame_selector: "#frameA", target_frame_selector: "#frameB", timeout: 500,
    }), -32603));
  await test("browser_drag_and_drop same-frame path still uses native dragAndDrop (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<div id='s' draggable='true'>S</div><div id='t' style='margin-top:80px'>T</div>" });
    const r = await executeTool("browser_drag_and_drop", { session_id: sessionId, source: "#s", target: "#t" });
    assertEq(r.cross_frame, false);
  });

  await test("final browser_close", () => executeTool("browser_close", { session_id: sessionId }));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail ? 1 : 0);
})();
