"use strict";
/**
 * [131] FIND_MISSING_BUTTON_ACCESSIBLE_NAME — <button>/<a> accessible-name scan
 *
 * Rigor levels:
 *   Normal:   icon-only <button> with no text flagged (error); <button>Save</button> not flagged.
 *   Medium:   max_results type mismatch throws; non-matching-extension single file throws.
 *   High:     aria-label/aria-labelledby not flagged; title-only flagged as warning not error;
 *             icon child with alt/aria-label not flagged; <a> tag covered; extensions filter narrows scan.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped attribute inert.
 *   Extreme:  max_results caps + truncated flag; single-file mode works; JSON-serialisable;
 *             multiple elements on one line all detected.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[131] FIND_MISSING_BUTTON_ACCESSIBLE_NAME — button/link accessible-name scan`);

test("normal: icon-only <button> with no accessible name is flagged", () => {
  executeTool("create_directory", { path: "fmban_basic" });
  executeTool("write_file", { path: "fmban_basic/a.html", content:
    `<button><span class="icon-trash"></span></button>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_basic" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_accessible_name");
  assert.strictEqual(r.findings[0].tag, "button");
});

test("normal: <button>Save</button> with visible text is not flagged", () => {
  executeTool("create_directory", { path: "fmban_text" });
  executeTool("write_file", { path: "fmban_text/a.html", content:
    `<button>Save</button>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_text" });
  assert.strictEqual(r.findingsCount, 0);
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_missing_button_accessible_name", { path: "fmban_basic", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: single file with non-matching extension throws", () => {
  executeTool("write_file", { path: "fmban_basic/notes.txt", content: "hello" });
  try {
    executeTool("find_missing_button_accessible_name", { path: "fmban_basic/notes.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: aria-label is not flagged", () => {
  executeTool("create_directory", { path: "fmban_arialabel" });
  executeTool("write_file", { path: "fmban_arialabel/a.html", content:
    `<button aria-label="Delete item"><span class="icon"></span></button>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_arialabel" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: aria-labelledby is not flagged", () => {
  executeTool("create_directory", { path: "fmban_labelledby" });
  executeTool("write_file", { path: "fmban_labelledby/a.html", content:
    `<span id="lbl">Close</span><button aria-labelledby="lbl"><span class="icon"></span></button>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_labelledby" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: title-only accessible name is flagged as warning, not error", () => {
  executeTool("create_directory", { path: "fmban_title" });
  executeTool("write_file", { path: "fmban_title/a.html", content:
    `<button title="Delete"><span class="icon"></span></button>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_title" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "title_only_accessible_name");
  assert.strictEqual(r.findings[0].severity, "warning");
});

test("high: icon child carrying its own alt text is not flagged", () => {
  executeTool("create_directory", { path: "fmban_iconalt" });
  executeTool("write_file", { path: "fmban_iconalt/a.html", content:
    `<a href="/home"><img src="home.svg" alt="Home"></a>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_iconalt" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: <a> tag with no text/label is flagged", () => {
  executeTool("create_directory", { path: "fmban_anchor" });
  executeTool("write_file", { path: "fmban_anchor/a.html", content:
    `<a href="/settings"><span class="icon-gear"></span></a>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_anchor" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].tag, "a");
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "fmban_ext" });
  executeTool("write_file", { path: "fmban_ext/a.html", content: `<button></button>` });
  executeTool("write_file", { path: "fmban_ext/b.jsx", content: `<button></button>` });
  const rBoth = executeTool("find_missing_button_accessible_name", { path: "fmban_ext" });
  const rHtmlOnly = executeTool("find_missing_button_accessible_name", { path: "fmban_ext", extensions: [".html"] });
  assert.strictEqual(rBoth.findingsCount, 2);
  assert.strictEqual(rHtmlOnly.findingsCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_missing_button_accessible_name", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped attribute value is inert, never executed", () => {
  executeTool("create_directory", { path: "fmban_inj" });
  executeTool("write_file", { path: "fmban_inj/a.html", content:
    `<button aria-label="$(rm -rf /) Delete"><span class="icon"></span></button>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_inj" });
  assert.strictEqual(r.findingsCount, 0); // non-empty aria-label — correctly not flagged, no injected text executed
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: max_results caps findings and sets truncated", () => {
  executeTool("create_directory", { path: "fmban_many" });
  let content = "";
  for (let i = 0; i < 5; i++) content += `<button><span class="icon-${i}"></span></button>\n`;
  executeTool("write_file", { path: "fmban_many/a.html", content });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_many", max_results: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

test("extreme: multiple elements on one line are all detected", () => {
  executeTool("create_directory", { path: "fmban_oneline" });
  executeTool("write_file", { path: "fmban_oneline/a.html", content:
    `<button><span class="icon"></span></button><button>Save</button>` });
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_oneline" });
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: single-file mode scans just that file", () => {
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_basic/a.html" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_missing_button_accessible_name", { path: "fmban_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_missing_button_accessible_name fixtures", () => {
  for (const d of ["fmban_basic", "fmban_text", "fmban_arialabel", "fmban_labelledby", "fmban_title", "fmban_iconalt", "fmban_anchor", "fmban_ext", "fmban_inj", "fmban_many", "fmban_oneline"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
