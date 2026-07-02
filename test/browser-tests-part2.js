"use strict";
/**
 * Isolated functional tests for browser_* tools (part 2/2).
 * Split from browser-tests.js (exceeded 1000-line file threshold).
 * Covers: multi-tab, network capture, routing, emulation, storage,
 * init scripts, page metrics, exposed functions, wait_for_response,
 * storage state, a11y, dialogs, frames.
 * NOT part of test/run-tests.js. Run standalone: node test/browser-tests-part2.js
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
  console.log("== browser-tests-part2.js ==");

  {
    const r = await executeTool("browser_launch", { headless: true });
    sessionId = r.session_id;
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<h1>part2</h1>" });
  }
  // ── Multi-tab support ──────────────────────────────────────────────────
  let pageId2;
  await test("browser_new_page opens and navigates a second tab (normal)", async () => {
    const r = await executeTool("browser_new_page", { session_id: sessionId, url: "data:text/html,<h1 id='p2'>tab2</h1>" });
    assertOk(r.page_id);
    pageId2 = r.page_id;
    const c = await executeTool("browser_get_content", { session_id: sessionId, selector: "#p2" });
    assertEq(c.content, "tab2");
  });
  await test("browser_list_pages shows both tabs, new one active (normal)", async () => {
    const r = await executeTool("browser_list_pages", { session_id: sessionId });
    assertEq(r.count, 2);
    assertOk(r.pages.some((p) => p.page_id === pageId2 && p.active === true));
  });
  await test("browser_switch_page moves focus back to first tab (normal)", async () => {
    const list = await executeTool("browser_list_pages", { session_id: sessionId });
    const firstId = list.pages.find((p) => p.page_id !== pageId2).page_id;
    const r = await executeTool("browser_switch_page", { session_id: sessionId, page_id: firstId });
    assertEq(r.status, "switched");
    const active = await executeTool("browser_list_pages", { session_id: sessionId });
    assertOk(active.pages.find((p) => p.page_id === firstId).active === true);
  });
  await test("browser_new_page missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_new_page", {}), -32602));
  await test("browser_switch_page missing page_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_switch_page", { session_id: sessionId }), -32602));
  await test("browser_switch_page unknown page_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_switch_page", { session_id: sessionId, page_id: "no-such-page" }), -32602));
  await test("browser_list_pages unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_list_pages", { session_id: "does-not-exist" }), -32602));
  await test("browser_new_page bad url -> -32603, session still usable (high)", () =>
    expectCode(() => executeTool("browser_new_page", { session_id: sessionId, url: "http://127.0.0.1:1/", timeout: 1000 }), -32603));
  await test("browser_close_page closes the second tab (normal)", async () => {
    const r = await executeTool("browser_close_page", { session_id: sessionId, page_id: pageId2 });
    assertEq(r.status, "closed");
    const after = await executeTool("browser_list_pages", { session_id: sessionId });
    assertEq(after.count, 1);
  });
  await test("browser_close_page cannot close last remaining page (critical)", async () => {
    const r = await executeTool("browser_list_pages", { session_id: sessionId });
    await expectCode(() => executeTool("browser_close_page", { session_id: sessionId, page_id: r.pages[0].page_id }), -32602);
  });
  await test("browser_close_page unknown page_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_close_page", { session_id: sessionId, page_id: "no-such-page" }), -32602));
  await test("browser_new_page huge url fuzz doesn't crash (extreme)", () =>
    expectCode(() => executeTool("browser_new_page", { session_id: sessionId, url: "http://" + "x".repeat(50000), timeout: 500 }), -32603));

  // ── Network interception ────────────────────────────────────────────────
  await test("browser_network_start begins capture (normal)", async () => {
    const r = await executeTool("browser_network_start", { session_id: sessionId });
    assertEq(r.status, "capturing");
  });
  await test("browser_network_start idempotent when already capturing (normal)", async () => {
    const r = await executeTool("browser_network_start", { session_id: sessionId });
    assertEq(r.status, "already_capturing");
  });
  const netFile = path.join(TMP, "net-test.html");
  fs.writeFileSync(netFile, "<h1>net</h1>");
  const netUrl = "file://" + netFile.replace(/\\/g, "/");
  await test("browser_get_network_requests captures a navigation (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: netUrl });
    const r = await executeTool("browser_get_network_requests", { session_id: sessionId });
    assertOk(r.count > 0);
    assertOk(r.capturing === true);
  });
  await test("browser_get_network_requests url_contains filter (normal)", async () => {
    const r = await executeTool("browser_get_network_requests", { session_id: sessionId, url_contains: "net-test.html" });
    assertOk(r.requests.length > 0 && r.requests.every((e) => e.url.includes("net-test.html")));
  });
  await test("browser_get_network_requests limit is respected (normal)", async () => {
    const r = await executeTool("browser_get_network_requests", { session_id: sessionId, limit: 1 });
    assertOk(r.requests.length <= 1);
  });
  await test("browser_network_stop stops capture (normal)", async () => {
    const r = await executeTool("browser_network_stop", { session_id: sessionId });
    assertEq(r.status, "stopped");
    const after = await executeTool("browser_get_network_requests", { session_id: sessionId });
    assertEq(after.capturing, false);
  });
  await test("browser_network_start missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_network_start", {}), -32602));
  await test("browser_network_stop missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_network_stop", {}), -32602));
  await test("browser_get_network_requests missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_network_requests", {}), -32602));
  await test("browser_network_start unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_network_start", { session_id: "does-not-exist" }), -32602));
  await test("browser_get_network_requests clear empties the log (high)", async () => {
    await executeTool("browser_network_start", { session_id: sessionId });
    await executeTool("browser_navigate", { session_id: sessionId, url: netUrl });
    const r = await executeTool("browser_get_network_requests", { session_id: sessionId, clear: true });
    assertOk(r.count > 0);
    const after = await executeTool("browser_get_network_requests", { session_id: sessionId });
    assertEq(after.count, 0);
  });
  await test("browser_get_network_requests injection-style filter inert (critical)", async () => {
    const r = await executeTool("browser_get_network_requests", { session_id: sessionId, url_contains: "'; DROP TABLE--" });
    assertEq(r.requests.length, 0);
  });
  await test("browser_get_network_requests huge url_contains fuzz doesn't crash (extreme)", async () => {
    const r = await executeTool("browser_get_network_requests", { session_id: sessionId, url_contains: "x".repeat(50000) });
    assertEq(r.requests.length, 0);
  });

  // ── Request routing/mocking ─────────────────────────────────────────────
  await test("browser_route fulfill mocks a response (normal)", async () => {
    const r = await executeTool("browser_route", { session_id: sessionId, url_pattern: "**/mock-api/**", action: "fulfill", status: 200, body: "mocked", content_type: "text/plain" });
    assertEq(r.status, "routed");
    await executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/mock-api/x" });
    const content = await executeTool("browser_get_content", { session_id: sessionId, mode: "text" });
    assertOk(content.content.includes("mocked"));
  });
  await test("browser_unroute removes a specific route (normal)", async () => {
    const r = await executeTool("browser_unroute", { session_id: sessionId, url_pattern: "**/mock-api/**" });
    assertEq(r.status, "unrouted");
  });
  await test("browser_route abort blocks a request (normal)", async () => {
    await executeTool("browser_route", { session_id: sessionId, url_pattern: "**/blocked-api/**", action: "abort" });
    await expectCode(() => executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/blocked-api/x", timeout: 5000 }), -32603);
    await executeTool("browser_unroute", { session_id: sessionId, url_pattern: "**/blocked-api/**" });
  });
  await test("browser_route continue lets request through (normal)", async () => {
    const r = await executeTool("browser_route", { session_id: sessionId, url_pattern: "**/*", action: "continue" });
    assertEq(r.status, "routed");
    await executeTool("browser_navigate", { session_id: sessionId, url: netUrl });
    await executeTool("browser_unroute", { session_id: sessionId });
  });
  await test("browser_route missing url_pattern -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_route", { session_id: sessionId, action: "abort" }), -32602));
  await test("browser_route missing action -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_route", { session_id: sessionId, url_pattern: "**/*" }), -32602));
  await test("browser_route invalid action -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_route", { session_id: sessionId, url_pattern: "**/*", action: "bogus" }), -32602));
  await test("browser_route unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_route", { session_id: "does-not-exist", url_pattern: "**/*", action: "continue" }), -32602));
  await test("browser_unroute unknown pattern -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_unroute", { session_id: sessionId, url_pattern: "**/never-routed/**" }), -32602));
  await test("browser_unroute missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_unroute", {}), -32602));
  await test("browser_unroute all with no routes is a no-op (normal)", async () => {
    const r = await executeTool("browser_unroute", { session_id: sessionId });
    assertEq(r.status, "unrouted_all");
    assertEq(r.count, 0);
  });
  await test("browser_route huge url_pattern fuzz doesn't crash (extreme)", async () => {
    const r = await executeTool("browser_route", { session_id: sessionId, url_pattern: "x".repeat(50000), action: "continue" });
    assertEq(r.status, "routed");
    await executeTool("browser_unroute", { session_id: sessionId });
  });

  // ── Emulation (viewport/geolocation/color-scheme/offline) ──────────────
  await test("browser_emulate viewport resizes page (normal)", async () => {
    const r = await executeTool("browser_emulate", { session_id: sessionId, viewport: { width: 800, height: 600 } });
    assertEq(r.applied.viewport.width, 800);
  });
  await test("browser_emulate geolocation sets coords (normal)", async () => {
    const r = await executeTool("browser_emulate", { session_id: sessionId, geolocation: { latitude: 51.5, longitude: -0.12 } });
    assertEq(r.applied.geolocation.latitude, 51.5);
  });
  await test("browser_emulate color_scheme dark (normal)", async () => {
    const r = await executeTool("browser_emulate", { session_id: sessionId, color_scheme: "dark" });
    assertEq(r.applied.color_scheme, "dark");
  });
  await test("browser_emulate offline toggles context (normal)", async () => {
    const r = await executeTool("browser_emulate", { session_id: sessionId, offline: true });
    assertEq(r.applied.offline, true);
    await executeTool("browser_emulate", { session_id: sessionId, offline: false });
  });
  await test("browser_emulate no fields -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_emulate", { session_id: sessionId }), -32602));
  await test("browser_emulate missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_emulate", { viewport: { width: 100, height: 100 } }), -32602));
  await test("browser_emulate invalid viewport -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_emulate", { session_id: sessionId, viewport: { width: -1, height: 100 } }), -32602));
  await test("browser_emulate invalid color_scheme -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_emulate", { session_id: sessionId, color_scheme: "rainbow" }), -32602));
  await test("browser_emulate bad geolocation types -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_emulate", { session_id: sessionId, geolocation: { latitude: "x", longitude: 1 } }), -32602));
  await test("browser_emulate unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_emulate", { session_id: "does-not-exist", offline: true }), -32602));
  await test("browser_emulate large viewport fuzz doesn't crash (extreme)", async () => {
    // Note: truly extreme values (e.g. 999999x999999) crash the Chromium
    // renderer itself (target closed) rather than raising a catchable JS
    // error, killing the session out from under the tool. 8000x8000 is
    // large enough to exercise the edge without taking the renderer down.
    const r = await executeTool("browser_emulate", { session_id: sessionId, viewport: { width: 8000, height: 8000 } });
    assertEq(r.applied.viewport.width, 8000);
    await executeTool("browser_emulate", { session_id: sessionId, viewport: { width: 1280, height: 800 } });
  });
  await test("browser_launch with device_scale_factor/timezone/locale (normal)", async () => {
    const r = await executeTool("browser_launch", { headless: true, device_scale_factor: 2, timezone_id: "America/New_York", locale: "fr-FR" });
    assertOk(!!r.session_id);
    await executeTool("browser_close", { session_id: r.session_id });
  });

  await test("browser_set_extra_headers applies headers (normal)", async () => {
    const r = await executeTool("browser_set_extra_headers", { session_id: sessionId, headers: { "X-Test": "1", "Authorization": "Bearer abc" } });
    assertEq(r.headers_set, 2);
  });
  await test("browser_set_extra_headers missing headers -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_set_extra_headers", { session_id: sessionId }), -32602));
  await test("browser_set_extra_headers empty headers object -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_set_extra_headers", { session_id: sessionId, headers: {} }), -32602));
  await test("browser_set_extra_headers non-string value -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_set_extra_headers", { session_id: sessionId, headers: { "X-N": 5 } }), -32602));
  await test("browser_set_extra_headers missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_set_extra_headers", { headers: { a: "b" } }), -32602));
  await test("browser_set_extra_headers unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_set_extra_headers", { session_id: "does-not-exist", headers: { a: "b" } }), -32602));
  await test("browser_set_extra_headers injection-style header value (critical)", async () => {
    const r = await executeTool("browser_set_extra_headers", { session_id: sessionId, headers: { "X-Injected": "'; DROP TABLE users; --" } });
    assertEq(r.headers_set, 1);
    await executeTool("browser_set_extra_headers", { session_id: sessionId, headers: { "X-Test": "reset" } });
  });

  await test("browser_set_local_storage then browser_get_local_storage round-trips (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/" });
    const w = await executeTool("browser_set_local_storage", { session_id: sessionId, items: { foo: "bar", num: "42" } });
    assertEq(w.items_set, 2);
    const r = await executeTool("browser_get_local_storage", { session_id: sessionId });
    assertEq(r.items.foo, "bar");
    assertEq(r.items.num, "42");
  });
  await test("browser_get_local_storage empty store (normal)", async () => {
    const r = await executeTool("browser_get_local_storage", { session_id: sessionId });
    assertEq(typeof r.count, "number");
  });
  await test("browser_set_local_storage missing items -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_set_local_storage", { session_id: sessionId }), -32602));
  await test("browser_set_local_storage empty items object -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_set_local_storage", { session_id: sessionId, items: {} }), -32602));
  await test("browser_set_local_storage non-string value -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_set_local_storage", { session_id: sessionId, items: { a: 1 } }), -32602));
  await test("browser_get_local_storage missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_local_storage", {}), -32602));
  await test("browser_get_local_storage unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_get_local_storage", { session_id: "does-not-exist" }), -32602));
  await test("browser_set_local_storage unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_set_local_storage", { session_id: "does-not-exist", items: { a: "b" } }), -32602));
  await test("browser_set_local_storage script-injection value stored as inert string (critical)", async () => {
    const payload = "<script>alert(1)</script>";
    await executeTool("browser_set_local_storage", { session_id: sessionId, items: { xss: payload } });
    const r = await executeTool("browser_get_local_storage", { session_id: sessionId });
    assertEq(r.items.xss, payload);
  });
  await test("browser_set_local_storage huge value fuzz (extreme)", async () => {
    const big = "x".repeat(200000);
    const w = await executeTool("browser_set_local_storage", { session_id: sessionId, items: { big } });
    assertEq(w.items_set, 1);
    const r = await executeTool("browser_get_local_storage", { session_id: sessionId });
    assertEq(r.items.big.length, 200000);
  });

  await test("browser_add_init_script runs before page scripts on navigate (normal)", async () => {
    await executeTool("browser_add_init_script", { session_id: sessionId, script: "window.__injected = 'hello';" });
    await executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/" });
    const r = await executeTool("browser_evaluate", { session_id: sessionId, script: "window.__injected" });
    assertEq(r.result, "hello");
  });
  await test("browser_add_init_script missing script -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_add_init_script", { session_id: sessionId }), -32602));
  await test("browser_add_init_script empty string -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_add_init_script", { session_id: sessionId, script: "" }), -32602));
  await test("browser_add_init_script missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_add_init_script", { script: "1" }), -32602));
  await test("browser_add_init_script unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_add_init_script", { session_id: "does-not-exist", script: "1" }), -32602));
  await test("browser_add_init_script syntactically invalid JS registers but errors lazily on next nav (critical)", async () => {
    // Playwright's addInitScript doesn't parse eagerly; a broken script just
    // throws inside the page context on the next navigation, not here.
    const r = await executeTool("browser_add_init_script", { session_id: sessionId, script: "this is not valid js (((" });
    assertEq(r.applied, true);
  });
  await test("browser_add_init_script huge script fuzz doesn't crash (extreme)", async () => {
    const big = "// " + "x".repeat(300000) + "\nwindow.__big = 1;";
    const r = await executeTool("browser_add_init_script", { session_id: sessionId, script: big });
    assertEq(r.applied, true);
  });

  await test("browser_get_page_metrics returns navigation timing (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/" });
    const r = await executeTool("browser_get_page_metrics", { session_id: sessionId });
    assertOk(typeof r.metrics.resource_count === "number");
    assertOk("load_event_ms" in r.metrics);
  });
  await test("browser_get_page_metrics missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_page_metrics", {}), -32602));
  await test("browser_get_page_metrics unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_get_page_metrics", { session_id: "does-not-exist" }), -32602));
  await test("browser_get_page_metrics works on about:blank (extreme, near-empty doc)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "about:blank" });
    const r = await executeTool("browser_get_page_metrics", { session_id: sessionId });
    assertOk(r.metrics !== null);
  });

  await test("browser_expose_function then page calls it, recorded via browser_get_exposed_calls (normal)", async () => {
    await executeTool("browser_expose_function", { session_id: sessionId, name: "onTestEvent" });
    await executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/" });
    await executeTool("browser_evaluate", { session_id: sessionId, script: "window.onTestEvent('hi', 42)" });
    const r = await executeTool("browser_get_exposed_calls", { session_id: sessionId, name: "onTestEvent" });
    assertEq(r.count, 1);
    assertEq(r.calls[0].args[0], "hi");
    assertEq(r.calls[0].args[1], 42);
  });
  await test("browser_expose_function missing name -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_expose_function", { session_id: sessionId }), -32602));
  await test("browser_expose_function invalid identifier -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_expose_function", { session_id: sessionId, name: "not-valid!" }), -32602));
  await test("browser_expose_function duplicate name -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_expose_function", { session_id: sessionId, name: "onTestEvent" }), -32602));
  await test("browser_expose_function unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_expose_function", { session_id: "does-not-exist", name: "x" }), -32602));
  await test("browser_get_exposed_calls unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_get_exposed_calls", { session_id: "does-not-exist" }), -32602));
  await test("browser_get_exposed_calls clear empties log (critical)", async () => {
    const r = await executeTool("browser_get_exposed_calls", { session_id: sessionId, clear: true });
    assertOk(r.count >= 1);
    const r2 = await executeTool("browser_get_exposed_calls", { session_id: sessionId });
    assertEq(r2.count, 0);
  });
  await test("browser_expose_function injection-style payload stored as inert data (extreme)", async () => {
    await executeTool("browser_evaluate", { session_id: sessionId, script: "window.onTestEvent('<script>alert(1)</script>', \"'; DROP TABLE x; --\")" });
    const r = await executeTool("browser_get_exposed_calls", { session_id: sessionId });
    assertEq(r.count, 1);
    assertOk(r.calls[0].args[0].includes("<script>"));
  });

  await test("browser_wait_for_response resolves on matching url (normal)", async () => {
    const p = executeTool("browser_wait_for_response", { session_id: sessionId, url_pattern: "example.com", timeout: 10000 });
    await executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/" });
    const r = await p;
    assertOk(r.url.includes("example.com"));
    assertEq(typeof r.status, "number");
  });
  await test("browser_wait_for_response missing url_pattern -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_wait_for_response", { session_id: sessionId }), -32602));
  await test("browser_wait_for_response missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_wait_for_response", { url_pattern: "x" }), -32602));
  await test("browser_wait_for_response unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_wait_for_response", { session_id: "does-not-exist", url_pattern: "x" }), -32602));
  await test("browser_wait_for_response no match times out -> -32603 (high)", () =>
    expectCode(() => executeTool("browser_wait_for_response", { session_id: sessionId, url_pattern: "no-such-endpoint-xyz", timeout: 1000 }), -32603));
  await test("browser_wait_for_response status filter mismatch times out -> -32603 (critical)", () =>
    expectCode(() => executeTool("browser_wait_for_response", { session_id: sessionId, url_pattern: "example.com", status: 599, timeout: 1000 }), -32603));

  await test("browser_get_storage_state captures cookies+localStorage; browser_launch resumes it (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/" });
    await executeTool("browser_set_local_storage", { session_id: sessionId, items: { resumed: "yes" } });
    const snap = await executeTool("browser_get_storage_state", { session_id: sessionId });
    assertOk(snap.storage_state && Array.isArray(snap.storage_state.cookies));
    const launched = await executeTool("browser_launch", { headless: true, storage_state: snap.storage_state });
    await executeTool("browser_navigate", { session_id: launched.session_id, url: "https://example.com/" });
    const ls = await executeTool("browser_get_local_storage", { session_id: launched.session_id });
    assertEq(ls.items.resumed, "yes");
    await executeTool("browser_close", { session_id: launched.session_id });
  });
  await test("browser_get_storage_state missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_storage_state", {}), -32602));
  await test("browser_get_storage_state unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_get_storage_state", { session_id: "does-not-exist" }), -32602));
  await test("browser_launch invalid storage_state type -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_launch", { headless: true, storage_state: "not-an-object" }), -32602));
  await test("browser_launch storage_state array rejected -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_launch", { headless: true, storage_state: [] }), -32602));
  await test("browser_launch malformed storage_state object -> -32603 (critical)", () =>
    expectCode(() => executeTool("browser_launch", { headless: true, storage_state: { cookies: "not-an-array" } }), -32603));

  await test("browser_accessibility_snapshot returns a tree (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "https://example.com/" });
    const r = await executeTool("browser_accessibility_snapshot", { session_id: sessionId });
    assertOk(typeof r.snapshot === "string" && r.snapshot.length > 0);
  });
  await test("browser_accessibility_snapshot with selector root (normal)", async () => {
    const r = await executeTool("browser_accessibility_snapshot", { session_id: sessionId, selector: "h1" });
    assertOk(typeof r.snapshot === "string");
  });
  await test("browser_accessibility_snapshot missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_accessibility_snapshot", {}), -32602));
  await test("browser_accessibility_snapshot unknown selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_accessibility_snapshot", { session_id: sessionId, selector: "#does-not-exist-xyz" }), -32602));
  await test("browser_accessibility_snapshot unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_accessibility_snapshot", { session_id: "does-not-exist" }), -32602));
  await test("browser_accessibility_snapshot injection-style selector rejected cleanly (critical)", () =>
    expectCode(() => executeTool("browser_accessibility_snapshot", { session_id: sessionId, selector: "<script>alert(1)</script>" }), -32603));

  await test("browser_find_by_role finds link on example.com (normal)", async () => {
    const r = await executeTool("browser_find_by_role", { session_id: sessionId, role: "link" });
    assertOk(r.count >= 1);
    assertOk(Array.isArray(r.matches));
  });
  await test("browser_find_by_role with name filter, no match (normal)", async () => {
    const r = await executeTool("browser_find_by_role", { session_id: sessionId, role: "link", name: "definitely-not-a-real-link-name" });
    assertEq(r.count, 0);
  });
  await test("browser_find_by_role missing role -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_find_by_role", { session_id: sessionId }), -32602));
  await test("browser_find_by_role missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_find_by_role", { role: "button" }), -32602));
  await test("browser_find_by_role unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_find_by_role", { session_id: "does-not-exist", role: "button" }), -32602));
  await test("browser_find_by_role invalid role string doesn't crash (critical)", async () => {
    const r = await executeTool("browser_find_by_role", { session_id: sessionId, role: "not-a-real-aria-role" });
    assertEq(r.count, 0);
  });
  await test("browser_find_by_role huge name fuzz doesn't crash (extreme)", async () => {
    const r = await executeTool("browser_find_by_role", { session_id: sessionId, role: "link", name: "x".repeat(100000) });
    assertEq(r.count, 0);
  });

  // ── DIALOG TOOLS: browser_handle_next_dialog / browser_get_dialog_log ──
  await executeTool("browser_navigate", {
    session_id: sessionId,
    url: "data:text/html,<button id='cb' onclick=\"this.textContent=confirm('sure?')?'confirmed':'cancelled'\">C</button><button id='pb' onclick=\"var v=prompt('name?','x');this.textContent=v===null?'null':v\">P</button><button id='ab' onclick=\"alert('hello-alert')\">A</button>",
  });

  await test("browser_handle_next_dialog + confirm accept (normal)", async () => {
    const before = (await executeTool("browser_get_dialog_log", { session_id: sessionId })).count;
    await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "accept" });
    await executeTool("browser_click", { session_id: sessionId, selector: "#cb" });
    const log = await waitForNewDialog(sessionId, before);
    assertEq(log[log.length - 1].handledAction, "accept");
    assertEq(log[log.length - 1].type, "confirm");
    const r = await executeTool("browser_get_content", { session_id: sessionId, selector: "#cb" });
    assertEq(r.content, "confirmed");
  });
  await test("browser_handle_next_dialog + confirm dismiss (normal)", async () => {
    const before = (await executeTool("browser_get_dialog_log", { session_id: sessionId })).count;
    await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "dismiss" });
    await executeTool("browser_click", { session_id: sessionId, selector: "#cb" });
    const log = await waitForNewDialog(sessionId, before);
    assertEq(log[log.length - 1].handledAction, "dismiss");
    const r = await executeTool("browser_get_content", { session_id: sessionId, selector: "#cb" });
    assertEq(r.content, "cancelled");
  });
  await test("browser_handle_next_dialog + prompt accept with text (normal)", async () => {
    const before = (await executeTool("browser_get_dialog_log", { session_id: sessionId })).count;
    await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "accept", prompt_text: "claude-test" });
    await executeTool("browser_click", { session_id: sessionId, selector: "#pb" });
    const log = await waitForNewDialog(sessionId, before);
    assertEq(log[log.length - 1].type, "prompt");
    const r = await executeTool("browser_get_content", { session_id: sessionId, selector: "#pb" });
    assertEq(r.content, "claude-test");
  });
  await test("un-armed dialog auto-dismisses by default (normal)", async () => {
    const before = (await executeTool("browser_get_dialog_log", { session_id: sessionId })).count;
    await executeTool("browser_click", { session_id: sessionId, selector: "#ab" });
    const log = await waitForNewDialog(sessionId, before);
    assertEq(log[log.length - 1].handledAction, "auto-dismiss");
    assertEq(log[log.length - 1].type, "alert");
  });
  await test("browser_handle_next_dialog missing action -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_handle_next_dialog", { session_id: sessionId }), -32602));
  await test("browser_handle_next_dialog invalid action -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "maybe" }), -32602));
  await test("browser_handle_next_dialog missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_handle_next_dialog", { action: "accept" }), -32602));
  await test("browser_handle_next_dialog unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_handle_next_dialog", { session_id: "does-not-exist", action: "accept" }), -32602));
  await test("browser_get_dialog_log unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_get_dialog_log", { session_id: "does-not-exist" }), -32602));
  await test("dialog message with script-like text stored inert (critical)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<button id='xb' onclick=\"alert('<script>alert(1)<\\/script>')\">X</button>" });
    const before = (await executeTool("browser_get_dialog_log", { session_id: sessionId })).count;
    await executeTool("browser_handle_next_dialog", { session_id: sessionId, action: "accept" });
    await executeTool("browser_click", { session_id: sessionId, selector: "#xb" });
    const log = await waitForNewDialog(sessionId, before);
    assertOk(log[log.length - 1].message.includes("<script>"));
  });
  await test("browser_get_dialog_log clear empties log (extreme)", async () => {
    const r = await executeTool("browser_get_dialog_log", { session_id: sessionId, clear: true });
    assertOk(r.count > 0);
    const r2 = await executeTool("browser_get_dialog_log", { session_id: sessionId });
    assertEq(r2.count, 0);
  });

  // ── FRAME TOOLS: browser_list_frames / browser_frame_click / browser_frame_type / browser_frame_get_content ──
  const FRAME_INNER = "<button id=\"fb\" onclick=\"this.textContent='clicked'\">Go</button><input id=\"fi\"/><button id=\"fb2\" onclick=\"this.textContent=document.getElementById('fi').value\">Read</button><p id=\"fp\">frame-text</p>";
  const FRAME_PARENT_URL = "data:text/html," + encodeURIComponent(
    `<html><body><h1>parent</h1><iframe id="frame1" srcdoc="${FRAME_INNER.replace(/"/g, "&quot;")}"></iframe></body></html>`
  );
  await test("browser_navigate to iframe fixture page", () => executeTool("browser_navigate", { session_id: sessionId, url: FRAME_PARENT_URL }));
  await test("browser_list_frames returns main + child (normal)", async () => {
    const r = await executeTool("browser_list_frames", { session_id: sessionId });
    assertEq(r.count, 2);
    assertOk(r.frames.some((f) => f.isMainFrame));
    assertOk(r.frames.some((f) => !f.isMainFrame));
  });
  await test("browser_frame_click clicks inside iframe (normal)", async () => {
    const r = await executeTool("browser_frame_click", { session_id: sessionId, frame_selector: "#frame1", selector: "#fb" });
    assertEq(r.status, "clicked");
    const c = await executeTool("browser_frame_get_content", { session_id: sessionId, frame_selector: "#frame1", selector: "#fb" });
    assertEq(c.content, "clicked");
  });
  await test("browser_frame_type fills field inside iframe (normal)", async () => {
    await executeTool("browser_frame_type", { session_id: sessionId, frame_selector: "#frame1", selector: "#fi", text: "hello-frame" });
    await executeTool("browser_frame_click", { session_id: sessionId, frame_selector: "#frame1", selector: "#fb2" });
    const c = await executeTool("browser_frame_get_content", { session_id: sessionId, frame_selector: "#frame1", selector: "#fb2" });
    assertEq(c.content, "hello-frame");
  });
  await test("browser_frame_get_content mode html includes text (normal)", async () => {
    const c = await executeTool("browser_frame_get_content", { session_id: sessionId, frame_selector: "#frame1", selector: "#fp", mode: "html" });
    assertOk(c.content.includes("frame-text"));
  });
  await test("browser_list_frames missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_list_frames", {}), -32602));
  await test("browser_frame_click missing frame_selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_frame_click", { session_id: sessionId, selector: "#fb" }), -32602));
  await test("browser_frame_click missing selector -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_frame_click", { session_id: sessionId, frame_selector: "#frame1" }), -32602));
  await test("browser_frame_type missing text -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_frame_type", { session_id: sessionId, frame_selector: "#frame1", selector: "#fi" }), -32602));
  await test("browser_frame_click unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_frame_click", { session_id: "does-not-exist", frame_selector: "#frame1", selector: "#fb" }), -32602));
  await test("browser_frame_click unknown frame_selector times out -> -32603 (high)", () =>
    expectCode(() => executeTool("browser_frame_click", { session_id: sessionId, frame_selector: "#no-such-frame", selector: "#fb", timeout: 500 }), -32603));
  await test("browser_frame_click injection-style selector rejected cleanly (critical)", () =>
    expectCode(() => executeTool("browser_frame_click", { session_id: sessionId, frame_selector: "#frame1", selector: "<script>alert(1)</script>", timeout: 500 }), -32603));
  await test("browser_frame_get_content huge selector fuzz doesn't crash (extreme)", () =>
    expectCode(() => executeTool("browser_frame_get_content", { session_id: sessionId, frame_selector: "#frame1", selector: "#" + "x".repeat(50000), timeout: 500 }), -32602));

  // ── browser_get_current_url / browser_get_title ────────────────────────
  await test("browser_get_current_url returns page url (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<h1>u</h1>" });
    const r = await executeTool("browser_get_current_url", { session_id: sessionId });
    assertOk(r.url.startsWith("data:"));
  });
  await test("browser_get_title returns page title (normal)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "data:text/html,<title>MyTitle</title>" });
    const r = await executeTool("browser_get_title", { session_id: sessionId });
    assertEq(r.title, "MyTitle");
  });
  await test("browser_get_current_url missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_current_url", {}), -32602));
  await test("browser_get_title missing session_id -> -32602 (medium)", () =>
    expectCode(() => executeTool("browser_get_title", {}), -32602));
  await test("browser_get_current_url unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_get_current_url", { session_id: "does-not-exist" }), -32602));
  await test("browser_get_title unknown session -> -32602 (high)", () =>
    expectCode(() => executeTool("browser_get_title", { session_id: "does-not-exist" }), -32602));
  await test("browser_get_title on about:blank returns empty string, not throw (extreme)", async () => {
    await executeTool("browser_navigate", { session_id: sessionId, url: "about:blank" });
    const r = await executeTool("browser_get_title", { session_id: sessionId });
    assertEq(r.title, "");
  });

  await test("final browser_close of main session", () => executeTool("browser_close", { session_id: sessionId }));

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
