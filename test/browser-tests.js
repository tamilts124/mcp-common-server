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
const { installCrashGuard } = require("../lib/crashGuard");
installCrashGuard();

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
// Dialog events land asynchronously relative to the click that triggers them;
// poll rather than assume ordering. Returns the log once it grows past previousCount.
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

  // ── FOLLOW-UP TOOLS: wait_for_selector/back/forward/reload/cookies/pdf/select/press ──
  await test("browser_navigate reset for follow-up tools page", async () => {
    const r = await executeTool("browser_navigate", {
      session_id: sessionId,
      url: "data:text/html,<html><body><h1 id='t'>Hi</h1><select id='s'><option value='a'>A</option><option value='b'>B</option></select><input id='i2'/></body></html>",
    });
    assertOk(r.url.startsWith("data:"));
  });

  await test("browser_wait_for_selector finds existing element", async () => {
    const r = await executeTool("browser_wait_for_selector", { session_id: sessionId, selector: "#t", timeout: 3000 });
    assertEq(r.status, "found");
  });

  await test("browser_wait_for_selector missing selector -> -32602", () =>
    expectCode(() => executeTool("browser_wait_for_selector", { session_id: sessionId }), -32602));

  await test("browser_wait_for_selector timeout on absent element -> -32603", () =>
    expectCode(() => executeTool("browser_wait_for_selector", { session_id: sessionId, selector: "#nope-xyz", timeout: 500 }), -32603));

  await test("browser_select_option by value", async () => {
    const r = await executeTool("browser_select_option", { session_id: sessionId, selector: "#s", value: "b" });
    assertEq(r.selected[0], "b");
  });

  await test("browser_select_option missing value/label -> -32602", () =>
    expectCode(() => executeTool("browser_select_option", { session_id: sessionId, selector: "#s" }), -32602));

  await test("browser_press_key types into focused selector", async () => {
    await executeTool("browser_click", { session_id: sessionId, selector: "#i2" });
    await executeTool("browser_press_key", { session_id: sessionId, key: "a" });
    const r = await executeTool("browser_evaluate", { session_id: sessionId, script: "document.getElementById('i2').value" });
    assertEq(r.result, "a");
  });

  await test("browser_press_key missing key -> -32602", () =>
    expectCode(() => executeTool("browser_press_key", { session_id: sessionId }), -32602));

  await test("browser_set_cookies then browser_get_cookies round-trips", async () => {
    await executeTool("browser_set_cookies", {
      session_id: sessionId,
      cookies: [{ name: "foo", value: "bar", url: "https://example.com" }],
    });
    const r = await executeTool("browser_get_cookies", { session_id: sessionId, urls: ["https://example.com"] });
    assertOk(r.cookies.some((c) => c.name === "foo" && c.value === "bar"));
  });

  await test("browser_set_cookies missing name/value -> -32602", () =>
    expectCode(() => executeTool("browser_set_cookies", { session_id: sessionId, cookies: [{ name: "x" }] }), -32602));

  await test("browser_set_cookies empty array -> -32602", () =>
    expectCode(() => executeTool("browser_set_cookies", { session_id: sessionId, cookies: [] }), -32602));

  await test("browser_navigate then browser_go_back/browser_go_forward", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "about:blank" });
    const back = await executeTool("browser_go_back", { session_id: sessionId, timeout: 3000 });
    assertEq(back.status, "back");
    const fwd = await executeTool("browser_go_forward", { session_id: sessionId, timeout: 3000 });
    assertEq(fwd.status, "forward");
  });

  await test("browser_reload keeps session usable", async () => {
    const r = await executeTool("browser_reload", { session_id: sessionId, timeout: 3000 });
    assertEq(r.status, "reloaded");
  });

  await test("browser_pdf writes a file (chromium only)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<h1>pdf</h1>" });
    const r = await executeTool("browser_pdf", { session_id: sessionId, path: "out.pdf" });
    assertOk(fs.existsSync(path.join(TMP, "out.pdf")), "pdf file missing");
    assertEq(r.path.replace(/\\/g, "/"), "out.pdf");
  });

  await test("browser_pdf missing path -> -32602", () =>
    expectCode(() => executeTool("browser_pdf", { session_id: sessionId }), -32602));

  await test("browser_pdf path traversal rejected", async () => {
    try {
      await executeTool("browser_pdf", { session_id: sessionId, path: "../../../etc/passwd.pdf" });
      throw new Error("expected throw, none occurred");
    } catch (e) {
      assertOk(/access denied|outside root/i.test(e.message), `unexpected error: ${e.message}`);
    }
  });

  await test("follow-up tools: unknown session_id -> -32602", () =>
    expectCode(() => executeTool("browser_go_back", { session_id: "does-not-exist" }), -32602));

  await test("browser_wait_for_navigation resolves after navigate", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<h1>nav</h1>" });
    const r = await executeTool("browser_wait_for_navigation", { session_id: sessionId, timeout: 3000 });
    assertEq(r.status, "settled");
  });

  await test("browser_wait_for_navigation missing session_id -> -32602", () =>
    expectCode(() => executeTool("browser_wait_for_navigation", {}), -32602));

  await test("browser_wait_for_navigation unknown session_id -> -32602", () =>
    expectCode(() => executeTool("browser_wait_for_navigation", { session_id: "does-not-exist" }), -32602));

  await test("browser_hover moves over element", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<button id='b'>hi</button>" });
    const r = await executeTool("browser_hover", { session_id: sessionId, selector: "#b" });
    assertEq(r.status, "hovered");
  });

  await test("browser_hover missing selector -> -32602", () =>
    expectCode(() => executeTool("browser_hover", { session_id: sessionId }), -32602));

  await test("browser_hover unknown session_id -> -32602", () =>
    expectCode(() => executeTool("browser_hover", { session_id: "does-not-exist", selector: "#b" }), -32602));

  await test("browser_hover missing element -> -32603", () =>
    expectCode(() => executeTool("browser_hover", { session_id: sessionId, selector: "#nope", timeout: 500 }), -32603));

  await test("browser_upload_file sets file on input", async () => {
    const filePath = path.join(TMP, "upload.txt");
    fs.writeFileSync(filePath, "hello");
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<input type='file' id='f'>" });
    const r = await executeTool("browser_upload_file", { session_id: sessionId, selector: "#f", path: "upload.txt" });
    assertEq(r.status, "uploaded");
    assertEq(r.files.length, 1);
  });

  await test("browser_upload_file accepts files array", async () => {
    const r = await executeTool("browser_upload_file", { session_id: sessionId, selector: "#f", files: ["upload.txt"] });
    assertEq(r.status, "uploaded");
  });

  await test("browser_upload_file missing selector -> -32602", () =>
    expectCode(() => executeTool("browser_upload_file", { session_id: sessionId, path: "upload.txt" }), -32602));

  await test("browser_upload_file missing files/path -> -32602", () =>
    expectCode(() => executeTool("browser_upload_file", { session_id: sessionId, selector: "#f" }), -32602));

  await test("browser_upload_file path traversal rejected", async () => {
    try {
      await executeTool("browser_upload_file", { session_id: sessionId, selector: "#f", path: "../../../etc/passwd" });
      throw new Error("expected throw, none occurred");
    } catch (e) {
      assertOk(/access denied|outside root/i.test(e.message), `unexpected error: ${e.message}`);
    }
  });

  await test("browser_scroll by offset (no selector)", async () => {
    const r = await executeTool("browser_scroll", { session_id: sessionId, x: 0, y: 100 });
    assertEq(r.status, "scrolled");
  });

  await test("browser_scroll selector into view", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<div id='s'>hi</div>" });
    const r = await executeTool("browser_scroll", { session_id: sessionId, selector: "#s" });
    assertEq(r.status, "scrolled");
  });

  await test("browser_scroll missing session_id -> -32602", () =>
    expectCode(() => executeTool("browser_scroll", {}), -32602));

  await test("browser_double_click updates DOM", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url:
      "data:text/html,<button id='d' ondblclick=\"this.textContent='dbl'\">x</button>" });
    await executeTool("browser_double_click", { session_id: sessionId, selector: "#d" });
    const c = await executeTool("browser_get_content", { session_id: sessionId, selector: "#d" });
    assertEq(c.content, "dbl");
  });

  await test("browser_double_click missing selector -> -32602", () =>
    expectCode(() => executeTool("browser_double_click", { session_id: sessionId }), -32602));

  await test("browser_double_click missing element -> -32603", () =>
    expectCode(() => executeTool("browser_double_click", { session_id: sessionId, selector: "#nope", timeout: 500 }), -32603));

  await test("browser_right_click updates DOM", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url:
      "data:text/html,<div id='r' oncontextmenu=\"this.textContent='ctx';return false;\">x</div>" });
    await executeTool("browser_right_click", { session_id: sessionId, selector: "#r" });
    const c = await executeTool("browser_get_content", { session_id: sessionId, selector: "#r" });
    assertEq(c.content, "ctx");
  });

  await test("browser_right_click missing selector -> -32602", () =>
    expectCode(() => executeTool("browser_right_click", { session_id: sessionId }), -32602));

  await test("browser_drag_and_drop moves element", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url:
      "data:text/html," +
      "<div id='src' draggable='true'>drag</div><div id='tgt'>drop</div>" +
      "<script>" +
      "src.addEventListener('dragstart',e=>e.dataTransfer.setData('text','x'));" +
      "tgt.addEventListener('dragover',e=>e.preventDefault());" +
      "tgt.addEventListener('drop',e=>{e.preventDefault();tgt.textContent='dropped';});" +
      "</script>" });
    const r = await executeTool("browser_drag_and_drop", { session_id: sessionId, source: "#src", target: "#tgt" });
    assertEq(r.status, "dropped");
  });

  await test("browser_drag_and_drop missing source -> -32602", () =>
    expectCode(() => executeTool("browser_drag_and_drop", { session_id: sessionId, target: "#tgt" }), -32602));

  await test("browser_drag_and_drop missing target -> -32602", () =>
    expectCode(() => executeTool("browser_drag_and_drop", { session_id: sessionId, source: "#src" }), -32602));

  await test("browser_drag_and_drop unknown session_id -> -32602", () =>
    expectCode(() => executeTool("browser_drag_and_drop", { session_id: "does-not-exist", source: "#a", target: "#b" }), -32602));

  // ── cleanup ─────────────────────────────────────────────────────────
  await test("browser_download saves file via click trigger", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url:
      "data:text/html,<a id='dl' download='out.txt' href='data:text/plain,hello'>dl</a>" });
    const r = await executeTool("browser_download", { session_id: sessionId, selector: "#dl", path: "dl.txt" });
    assertEq(r.status, "downloaded");
    if (!fs.existsSync(path.join(TMP, "dl.txt"))) throw new Error("download file not written");
  });

  await test("browser_download missing selector -> -32602", () =>
    expectCode(() => executeTool("browser_download", { session_id: sessionId, path: "x.txt" }), -32602));

  await test("browser_download missing path -> -32602", () =>
    expectCode(() => executeTool("browser_download", { session_id: sessionId, selector: "#dl" }), -32602));

  await test("browser_download path traversal rejected", async () => {
    try {
      await executeTool("browser_download", { session_id: sessionId, selector: "#dl", path: "../../etc/out.txt" });
      throw new Error("expected throw, none occurred");
    } catch (e) {
      if (!/root|outside|jail/i.test(e.message)) throw e;
    }
  });

  await test("browser_download unknown session_id -> -32602", () =>
    expectCode(() => executeTool("browser_download", { session_id: "does-not-exist", selector: "#dl", path: "x.txt" }), -32602));

  await test("browser_download no download event -> -32603", () =>
    expectCode(() => executeTool("browser_download", { session_id: sessionId, selector: "#nope-xyz", path: "x2.txt", timeout: 500 }), -32603));

  // ── Element state/attribute tools ──────────────────────────────────────
  await test("browser_get_attribute reads attribute value (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url:
      "data:text/html,<a id='lnk' href='/foo' data-x='bar'>link</a>" });
    const r = await executeTool("browser_get_attribute", { session_id: sessionId, selector: "#lnk", attribute: "href" });
    assertOk(r.value === "/foo", `expected /foo, got ${r.value}`);
  });
  await test("browser_get_attribute missing attr -> null (normal)", async () => {
    const r = await executeTool("browser_get_attribute", { session_id: sessionId, selector: "#lnk", attribute: "nope" });
    assertEq(r.value, null);
  });
  await test("browser_get_attribute missing selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_attribute", { session_id: sessionId, attribute: "href" }), -32602));
  await test("browser_get_attribute missing attribute -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_attribute", { session_id: sessionId, selector: "#lnk" }), -32602));
  await test("browser_get_attribute unknown selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_attribute", { session_id: sessionId, selector: "#nope-xyz", attribute: "href" }), -32602));
  await test("browser_get_attribute unknown session -> -32602 (high, dep failure)", () =>
    expectCode(() => executeTool("browser_get_attribute", { session_id: "does-not-exist", selector: "#lnk", attribute: "href" }), -32602));
  await test("browser_get_attribute path-traversal-style selector inert (critical)", () =>
    expectCode(() => executeTool("browser_get_attribute", { session_id: sessionId, selector: "../../../etc/passwd", attribute: "href" }), -32602));
  await test("browser_get_attribute script-injection selector inert (critical)", () =>
    expectCode(() => executeTool("browser_get_attribute", { session_id: sessionId, selector: "<script>alert(1)</script>", attribute: "href" }), -32603));
  await test("browser_get_attribute huge selector fuzz doesn't crash (extreme)", () =>
    expectCode(() => executeTool("browser_get_attribute", { session_id: sessionId, selector: "#x".repeat(20000), attribute: "href" }), -32602));

  await test("browser_is_visible true for visible element (normal)", async () => {
    const r = await executeTool("browser_is_visible", { session_id: sessionId, selector: "#lnk" });
    assertEq(r.visible, true);
  });
  await test("browser_is_visible false for absent element (normal)", async () => {
    const r = await executeTool("browser_is_visible", { session_id: sessionId, selector: "#nope-xyz" });
    assertEq(r.visible, false);
  });
  await test("browser_is_visible missing selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_is_visible", { session_id: sessionId }), -32602));
  await test("browser_is_visible unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_is_visible", { session_id: "does-not-exist", selector: "#lnk" }), -32602));

  await test("browser_check/uncheck/is_checked round trip (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url:
      "data:text/html,<input type='checkbox' id='cb'/>" });
    let r = await executeTool("browser_is_checked", { session_id: sessionId, selector: "#cb" });
    assertEq(r.checked, false);
    r = await executeTool("browser_check", { session_id: sessionId, selector: "#cb" });
    assertEq(r.status, "checked");
    r = await executeTool("browser_is_checked", { session_id: sessionId, selector: "#cb" });
    assertEq(r.checked, true);
    r = await executeTool("browser_uncheck", { session_id: sessionId, selector: "#cb" });
    assertEq(r.status, "unchecked");
    r = await executeTool("browser_is_checked", { session_id: sessionId, selector: "#cb" });
    assertEq(r.checked, false);
  });
  await test("browser_check missing selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_check", { session_id: sessionId }), -32602));
  await test("browser_uncheck missing selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_uncheck", { session_id: sessionId }), -32602));
  await test("browser_is_checked missing selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_is_checked", { session_id: sessionId }), -32602));
  await test("browser_check on non-existent element times out -> -32603 (high)", () =>
    expectCode(() => executeTool("browser_check", { session_id: sessionId, selector: "#nope-xyz", timeout: 500 }), -32603));
  await test("browser_check unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_check", { session_id: "does-not-exist", selector: "#cb" }), -32602));
  await test("browser_check on non-checkbox element rejected (critical)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<div id='d'>x</div>" });
    await expectCode(() => executeTool("browser_check", { session_id: sessionId, selector: "#d", timeout: 500 }), -32603);
  });

  await test("browser_get_element_info returns tag/text/attrs/box (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url:
      "data:text/html,<a id='lnk' href='/x' class='c'>Hello</a>" });
    const r = await executeTool("browser_get_element_info", { session_id: sessionId, selector: "#lnk" });
    assertEq(r.tag, "a");
    assertEq(r.text, "Hello");
    assertEq(r.attributes.href, "/x");
    assertOk(r.bounding_box && typeof r.bounding_box.width === "number");
  });
  await test("browser_get_element_info missing selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_element_info", { session_id: sessionId }), -32602));
  await test("browser_get_element_info unknown selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_element_info", { session_id: sessionId, selector: "#nope-xyz" }), -32602));
  await test("browser_get_element_info unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_get_element_info", { session_id: "does-not-exist", selector: "#lnk" }), -32602));
  await test("browser_get_element_info script-injection selector inert (critical)", () =>
    expectCode(() => executeTool("browser_get_element_info", {
      session_id: sessionId, selector: "<img src=x onerror=alert(1)>",
    }), -32603));
  await test("browser_get_element_info huge selector fuzz doesn't crash (extreme)", () =>
    expectCode(() => executeTool("browser_get_element_info", {
      session_id: sessionId, selector: "#" + "z".repeat(50000),
    }), -32602));


  await test("part1 browser_close of session", () => executeTool("browser_close", { session_id: sessionId }));

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});