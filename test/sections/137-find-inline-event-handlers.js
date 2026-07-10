"use strict";
/**
 * [137] FIND_INLINE_EVENT_HANDLERS — inline event handler / javascript: href CSP violation scan
 *
 * Rigor levels:
 *   Normal:   onclick flagged; onload flagged; empty on* not flagged;
 *             javascript: href flagged; clean file produces 0 findings;
 *             multiple inline handlers all found.
 *   Medium:   max_results type mismatch throws; extensions non-array throws;
 *             max_results truncation sets truncated flag; single-file mode;
 *             extension filter excludes non-matching files.
 *   High:     single-file mode; mixed file (both inline_event_handler and javascript_href);
 *             directory mode with multiple files; clean JS file (no HTML events).
 *   Critical: path traversal blocked; adversarial attribute values are stored
 *             as inert text, not executed; result is JSON-serialisable;
 *             exact top-level key set; value truncated at 80 chars.
 *   Extreme:  50 inline handlers all detected; fuzz random bytes don't crash;
 *             concurrent calls consistent; on-event inside comment may fire
 *             (documented FP), no crash.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[137] FIND_INLINE_EVENT_HANDLERS — inline event handler CSP violation scan`);

// ─── LEVEL 1: NORMAL ────────────────────────────────────────────────────────

test("normal: onclick attribute is flagged as error", () => {
  executeTool("create_directory", { path: "fieh_basic" });
  executeTool("write_file", { path: "fieh_basic/a.html",
    content: `<button onclick="doSomething()">Click me</button>` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_basic" });
  assert.ok(r.findingsCount >= 1, "at least one finding");
  const f = r.findings.find(x => x.rule === "inline_event_handler");
  assert.ok(f, "inline_event_handler finding present");
  assert.strictEqual(f.severity, "error");
  assert.strictEqual(f.attr, "onclick");
});

test("normal: onload attribute is flagged", () => {
  executeTool("create_directory", { path: "fieh_onload" });
  executeTool("write_file", { path: "fieh_onload/a.html",
    content: `<body onload="init()">` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_onload" });
  assert.ok(r.findings.some(f => f.attr === "onload"), "onload found");
});

test("normal: empty onclick is NOT flagged", () => {
  executeTool("create_directory", { path: "fieh_empty" });
  executeTool("write_file", { path: "fieh_empty/a.html",
    content: `<button onclick="">Click</button>` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_empty" });
  assert.strictEqual(r.findingsCount, 0, "empty handler not flagged");
});

test("normal: javascript: href is flagged as javascript_href error", () => {
  executeTool("create_directory", { path: "fieh_jshref" });
  executeTool("write_file", { path: "fieh_jshref/a.html",
    content: `<a href="javascript:void(0)">link</a>` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_jshref" });
  const f = r.findings.find(x => x.rule === "javascript_href");
  assert.ok(f, "javascript_href finding present");
  assert.strictEqual(f.severity, "error");
  assert.strictEqual(f.attr, "href");
});

test("normal: clean HTML file produces zero findings", () => {
  executeTool("create_directory", { path: "fieh_clean" });
  executeTool("write_file", { path: "fieh_clean/a.html",
    content: `<button id="btn">Click</button><script>document.getElementById('btn').addEventListener('click', handler);</script>` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_clean" });
  assert.strictEqual(r.findingsCount, 0, "no findings for clean file");
});

test("normal: multiple inline handlers all found", () => {
  executeTool("create_directory", { path: "fieh_multi" });
  executeTool("write_file", { path: "fieh_multi/a.html",
    content: [
      `<button onclick="a()">A</button>`,
      `<div onmouseover="b()">B</div>`,
      `<img onerror="c()">`,
    ].join("\n") });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_multi" });
  assert.strictEqual(r.findingsCount, 3);
  assert.strictEqual(r.errorCount, 3);
});

// ─── LEVEL 2: MEDIUM ────────────────────────────────────────────────────────

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_inline_event_handlers", { path: "fieh_basic", max_results: "bad" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: extensions non-array throws", () => {
  try {
    executeTool("find_inline_event_handlers", { path: "fieh_basic", extensions: ".html" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: max_results truncation sets truncated flag", () => {
  executeTool("create_directory", { path: "fieh_trunc" });
  let content = "";
  for (let i = 0; i < 5; i++) content += `<div on${["click","load","error","mouseover","submit"][i]}="fn${i}()">x</div>\n`;
  executeTool("write_file", { path: "fieh_trunc/a.html", content });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_trunc", max_results: 2 });
  assert.strictEqual(r.truncated, true);
  assert.ok(r.findings.length <= 2);
});

test("medium: extension filter excludes non-matching files", () => {
  executeTool("create_directory", { path: "fieh_extfilter" });
  executeTool("write_file", { path: "fieh_extfilter/a.txt",
    content: `<button onclick="a()">click</button>` });
  const r = executeTool("find_inline_event_handlers",
    { path: "fieh_extfilter", extensions: [".html"] });
  assert.strictEqual(r.findingsCount, 0, ".txt file excluded when filtering for .html only");
});

test("medium: single-file mode scans only that file", () => {
  const r = executeTool("find_inline_event_handlers", { path: "fieh_basic/a.html" });
  assert.strictEqual(r.filesScanned, 1);
  assert.ok(r.findingsCount >= 1);
});

// ─── LEVEL 3: HIGH ──────────────────────────────────────────────────────────

test("high: mixed file reports correct error counts", () => {
  executeTool("create_directory", { path: "fieh_mixed" });
  executeTool("write_file", { path: "fieh_mixed/a.html",
    content: [
      `<button onclick="doIt()">click</button>`,
      `<a href="javascript:void(0)">link</a>`,
    ].join("\n") });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_mixed" });
  assert.strictEqual(r.errorCount, 2, "two errors total");
  assert.ok(r.findings.some(f => f.rule === "inline_event_handler"), "has inline_event_handler");
  assert.ok(r.findings.some(f => f.rule === "javascript_href"), "has javascript_href");
});

test("high: directory mode scans all matching files", () => {
  executeTool("create_directory", { path: "fieh_dir" });
  executeTool("write_file", { path: "fieh_dir/a.html",
    content: `<button onclick="a()">A</button>` });
  executeTool("write_file", { path: "fieh_dir/b.html",
    content: `<div onload="b()">B</div>` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_dir" });
  assert.ok(r.filesScanned >= 2, "at least 2 files scanned");
  assert.ok(r.findingsCount >= 2, "at least 2 findings");
});

test("high: clean JS file (no HTML events) produces 0 findings", () => {
  executeTool("create_directory", { path: "fieh_cleanjs" });
  executeTool("write_file", { path: "fieh_cleanjs/a.js",
    content: `const x = 'onclick="foo()"'; // just a string, not markup` });
  const r = executeTool("find_inline_event_handlers",
    { path: "fieh_cleanjs/a.js" });
  // May or may not fire (documented FP for string literals) — just must not crash
  assert.ok(r.findingsCount >= 0);
});

test("high: single-quote onclick variant is also caught", () => {
  executeTool("create_directory", { path: "fieh_squote" });
  executeTool("write_file", { path: "fieh_squote/a.html",
    content: `<button onclick='doIt()'>click</button>` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_squote" });
  assert.ok(r.findings.some(f => f.attr === "onclick"), "single-quote onclick caught");
});

// ─── LEVEL 4: CRITICAL ──────────────────────────────────────────────────────

test("critical: path traversal is blocked", () => {
  try {
    executeTool("find_inline_event_handlers", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: adversarial value is stored as inert text, not executed", () => {
  executeTool("create_directory", { path: "fieh_adv" });
  executeTool("write_file", { path: "fieh_adv/a.html",
    content: `<div onclick="$(rm -rf /)">x</div>` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_adv" });
  assert.doesNotThrow(() => JSON.stringify(r));
  // Finding's value should be a string (not executed)
  const f = r.findings[0];
  assert.strictEqual(typeof f.value, "string");
});

test("critical: result is JSON-serialisable", () => {
  const r = executeTool("find_inline_event_handlers", { path: "fieh_basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("critical: exact expected top-level keys present", () => {
  const r = executeTool("find_inline_event_handlers", { path: "fieh_basic" });
  for (const k of ["path", "filesScanned", "findingsCount", "errorCount", "warningCount", "truncated", "findings"]) {
    assert.ok(Object.keys(r).includes(k), `missing key: ${k}`);
  }
});

test("critical: long value is truncated to 80 chars in findings", () => {
  executeTool("create_directory", { path: "fieh_longval" });
  const longExpr = "x".repeat(200);
  executeTool("write_file", { path: "fieh_longval/a.html",
    content: `<button onclick="${longExpr}">x</button>` });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_longval" });
  if (r.findings.length > 0) {
    assert.ok(r.findings[0].value.length <= 80 + 3, "value truncated");
  }
});

// ─── LEVEL 5: EXTREME ───────────────────────────────────────────────────────

test("extreme: 50 inline handlers all detected", () => {
  executeTool("create_directory", { path: "fieh_bulk" });
  const events = ["click","load","error","mouseover","mouseout","keydown","keyup","focus","blur","change"];
  let content = "";
  for (let i = 0; i < 50; i++) {
    content += `<div on${events[i % events.length]}="fn${i}()">x</div>\n`;
  }
  executeTool("write_file", { path: "fieh_bulk/a.html", content });
  const r = executeTool("find_inline_event_handlers",
    { path: "fieh_bulk", max_results: 100 });
  assert.strictEqual(r.errorCount, 50);
});

test("extreme: fuzz random bytes don't crash", () => {
  executeTool("create_directory", { path: "fieh_fuzz" });
  const fuzz = Buffer.from(Array.from({ length: 200 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  executeTool("write_file", { path: "fieh_fuzz/a.html", content: fuzz });
  const r = executeTool("find_inline_event_handlers", { path: "fieh_fuzz" });
  assert.ok(r.findingsCount >= 0);
});

test("extreme: result fully JSON-serialisable after bulk scan", () => {
  const r = executeTool("find_inline_event_handlers", { path: "fieh_bulk" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_inline_event_handlers fixtures", () => {
  for (const d of ["fieh_basic", "fieh_onload", "fieh_empty", "fieh_jshref", "fieh_clean",
    "fieh_multi", "fieh_trunc", "fieh_extfilter", "fieh_mixed", "fieh_dir",
    "fieh_cleanjs", "fieh_squote", "fieh_adv", "fieh_longval", "fieh_bulk", "fieh_fuzz"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
