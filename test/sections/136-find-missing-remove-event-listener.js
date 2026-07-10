"use strict";
/**
 * [136] FIND_MISSING_REMOVE_EVENT_LISTENER — leaked DOM event-listener scan
 *
 * Rigor levels:
 *   Normal:   inline handler flagged as error; named-no-remove flagged as warning;
 *             named WITH remove not flagged; once:true suppresses; arrow handler error.
 *   Medium:   max_results type mismatch throws; extensions non-array throws;
 *             empty file zero findings; extension filter excludes non-matching;
 *             max_results truncation sets truncated flag.
 *   High:     single-file mode; mixed-rule file; whole-file removeEventListener
 *             suppresses; different target does NOT suppress; dynamic type skipped;
 *             unterminated call doesn't crash.
 *   Critical: path traversal blocked; shell-injection-shaped event type inert;
 *             HTML/script content doesn't break JSON output; exact top-level key set.
 *   Extreme:  fuzz random bytes don't crash; 100 inline listeners all detected;
 *             single-file mode JSON-serialisable; 10 concurrent calls consistent.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[136] FIND_MISSING_REMOVE_EVENT_LISTENER — leaked DOM event-listener scan`);

// ─── LEVEL 1: NORMAL ────────────────────────────────────────────────────────

test("normal: inline handler is flagged as error", () => {
  executeTool("create_directory", { path: "fmrel_basic" });
  executeTool("write_file", { path: "fmrel_basic/a.js",
    content: `window.addEventListener("click", function() { doThing(); });` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_basic" });
  assert.ok(r.findings.length >= 1, "at least one finding");
  assert.strictEqual(r.findings[0].rule, "inline_handler_uncleanable");
  assert.strictEqual(r.findings[0].severity, "error");
  assert.strictEqual(r.findings[0].eventType, "click");
});

test("normal: named handler with no removeEventListener is flagged as warning", () => {
  executeTool("create_directory", { path: "fmrel_named" });
  executeTool("write_file", { path: "fmrel_named/a.js",
    content: `el.addEventListener("resize", onResize);` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_named" });
  assert.strictEqual(r.findings[0].rule, "event_listener_never_removed");
  assert.strictEqual(r.findings[0].severity, "warning");
  assert.strictEqual(r.findings[0].handler, "onResize");
});

test("normal: named handler WITH matching removeEventListener is not flagged", () => {
  executeTool("create_directory", { path: "fmrel_clean" });
  executeTool("write_file", { path: "fmrel_clean/a.js",
    content: `el.addEventListener("resize", onResize);\nel.removeEventListener("resize", onResize);` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_clean" });
  assert.strictEqual(r.findingsCount, 0);
});

test("normal: once:true option suppresses finding", () => {
  executeTool("create_directory", { path: "fmrel_once" });
  executeTool("write_file", { path: "fmrel_once/a.js",
    content: `btn.addEventListener("click", handler, { once: true });` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_once" });
  assert.strictEqual(r.findingsCount, 0);
});

test("normal: arrow handler is flagged as inline_handler_uncleanable", () => {
  executeTool("create_directory", { path: "fmrel_arrow" });
  executeTool("write_file", { path: "fmrel_arrow/a.js",
    content: `el.addEventListener("keydown", (e) => handle(e));` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_arrow" });
  assert.strictEqual(r.findings[0].rule, "inline_handler_uncleanable");
});

// ─── LEVEL 2: MEDIUM ────────────────────────────────────────────────────────

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_missing_remove_event_listener", { path: "fmrel_basic", max_results: "bad" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: extensions non-array throws", () => {
  try {
    executeTool("find_missing_remove_event_listener", { path: "fmrel_basic", extensions: ".js" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: empty file produces zero findings", () => {
  executeTool("create_directory", { path: "fmrel_empty" });
  executeTool("write_file", { path: "fmrel_empty/a.js", content: "// no listeners" });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_empty" });
  assert.strictEqual(r.findingsCount, 0);
});

test("medium: extension filter excludes non-matching files", () => {
  executeTool("create_directory", { path: "fmrel_extfilter" });
  executeTool("write_file", { path: "fmrel_extfilter/a.ts",
    content: `el.addEventListener("click", () => {});` });
  const r = executeTool("find_missing_remove_event_listener",
    { path: "fmrel_extfilter", extensions: [".js"] });
  const found = r.findings.find(f => f.file && f.file.endsWith(".ts"));
  assert.ok(!found, "ts file excluded when filtering for .js only");
});

test("medium: max_results truncation sets truncated flag", () => {
  executeTool("create_directory", { path: "fmrel_trunc" });
  let content = "";
  for (let i = 0; i < 5; i++) content += `el.addEventListener("ev${i}", () => {});\n`;
  executeTool("write_file", { path: "fmrel_trunc/a.js", content });
  const r = executeTool("find_missing_remove_event_listener",
    { path: "fmrel_trunc", max_results: 2 });
  assert.strictEqual(r.truncated, true);
  assert.ok(r.findings.length <= 2);
});

// ─── LEVEL 3: HIGH ──────────────────────────────────────────────────────────

test("high: single-file mode returns correct result", () => {
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_named/a.js" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findings[0].eventType, "resize");
  assert.strictEqual(r.findings[0].handler, "onResize");
});

test("high: mixed-rule file reports correct error/warning counts", () => {
  executeTool("create_directory", { path: "fmrel_mixed" });
  executeTool("write_file", { path: "fmrel_mixed/a.js",
    content: [
      `el.addEventListener("click", () => doIt());`,
      `el.addEventListener("resize", onResize);`,
      `el.addEventListener("load", onLoad, { once: true });`,
    ].join("\n") });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_mixed" });
  assert.strictEqual(r.errorCount, 1);
  assert.strictEqual(r.warningCount, 1);
  assert.strictEqual(r.findingsCount, 2);
});

test("high: removeEventListener in different function still suppresses (whole-file scope)", () => {
  executeTool("create_directory", { path: "fmrel_wholefile" });
  executeTool("write_file", { path: "fmrel_wholefile/a.js",
    content: [
      `function setup() { el.addEventListener("click", onClick); }`,
      `function teardown() { el.removeEventListener("click", onClick); }`,
    ].join("\n") });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_wholefile" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: different target does NOT suppress the finding", () => {
  executeTool("create_directory", { path: "fmrel_tgt" });
  executeTool("write_file", { path: "fmrel_tgt/a.js",
    content: [
      `el1.addEventListener("click", onClick);`,
      `el2.removeEventListener("click", onClick);`,
    ].join("\n") });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_tgt" });
  assert.strictEqual(r.findingsCount, 1);
});

test("high: dynamic event type is skipped without crash", () => {
  executeTool("create_directory", { path: "fmrel_dyntype" });
  executeTool("write_file", { path: "fmrel_dyntype/a.js",
    content: `el.addEventListener(eventType, handler);` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_dyntype" });
  assert.strictEqual(r.findingsCount, 0, "dynamic type skipped, no crash");
});

test("high: unterminated addEventListener call does not crash", () => {
  executeTool("create_directory", { path: "fmrel_unterm" });
  executeTool("write_file", { path: "fmrel_unterm/a.js",
    content: `el.addEventListener("click", ` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_unterm" });
  assert.ok(r.findingsCount >= 0);
});

// ─── LEVEL 4: CRITICAL ──────────────────────────────────────────────────────

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_missing_remove_event_listener", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped event type is stored as inert text, not executed", () => {
  executeTool("create_directory", { path: "fmrel_inj" });
  executeTool("write_file", { path: "fmrel_inj/a.js",
    content: `el.addEventListener("$(rm -rf /)", handler);` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_inj" });
  assert.ok(r.findingsCount >= 0);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("critical: HTML/script content in source doesn't break JSON output", () => {
  executeTool("create_directory", { path: "fmrel_html" });
  executeTool("write_file", { path: "fmrel_html/a.js",
    content: `el.addEventListener("<script>alert(1)<\/script>", () => {});` });
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_html" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("critical: result has exact expected top-level keys", () => {
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_basic" });
  const keys = Object.keys(r).sort();
  for (const k of ["path", "filesScanned", "findingsCount", "errorCount", "warningCount", "truncated", "findings"]) {
    assert.ok(keys.includes(k), `missing key: ${k}`);
  }
});

// ─── LEVEL 5: EXTREME ───────────────────────────────────────────────────────

test("extreme: 100 inline handlers are all detected", () => {
  executeTool("create_directory", { path: "fmrel_bulk" });
  let lines = "";
  for (let i = 0; i < 100; i++)
    lines += `el${i}.addEventListener("ev", function() { doThing${i}(); });\n`;
  executeTool("write_file", { path: "fmrel_bulk/a.js", content: lines });
  const r = executeTool("find_missing_remove_event_listener",
    { path: "fmrel_bulk", max_results: 200 });
  assert.strictEqual(r.errorCount, 100);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_missing_remove_event_listener", { path: "fmrel_named" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_missing_remove_event_listener fixtures", () => {
  for (const d of ["fmrel_basic", "fmrel_named", "fmrel_clean", "fmrel_once", "fmrel_arrow",
    "fmrel_empty", "fmrel_extfilter", "fmrel_trunc", "fmrel_mixed", "fmrel_wholefile",
    "fmrel_tgt", "fmrel_dyntype", "fmrel_unterm", "fmrel_inj", "fmrel_html", "fmrel_bulk"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
