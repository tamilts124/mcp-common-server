"use strict";
/**
 * [132] FIND_DUPLICATE_HTML_ID — duplicate id="..." attribute scan
 *
 * Rigor levels:
 *   Normal:   two elements sharing id="x" flagged (error, occurrences=2); unique ids not flagged.
 *   Medium:   max_results type mismatch throws; non-matching-extension single file throws.
 *   High:     3+ duplicates report all lines; JSX id={`literal`} form detected; dynamic
 *             id={var} skipped; extensions filter narrows scan.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped id value inert.
 *   Extreme:  max_results caps + truncated flag; single-file mode works; JSON-serialisable;
 *             empty id="" not flagged.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[132] FIND_DUPLICATE_HTML_ID — duplicate id attribute scan`);

test("normal: two elements sharing id=\"x\" are flagged", () => {
  executeTool("create_directory", { path: "fdhi_basic" });
  executeTool("write_file", { path: "fdhi_basic/a.html", content:
    `<div id="wrapper"></div><span id="wrapper"></span>` });
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_basic" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "duplicate_id");
  assert.strictEqual(r.findings[0].id, "wrapper");
  assert.strictEqual(r.findings[0].occurrences, 2);
});

test("normal: unique ids are not flagged", () => {
  executeTool("create_directory", { path: "fdhi_unique" });
  executeTool("write_file", { path: "fdhi_unique/a.html", content:
    `<div id="a"></div><span id="b"></span>` });
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_unique" });
  assert.strictEqual(r.findingsCount, 0);
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_duplicate_html_id", { path: "fdhi_basic", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: single file with non-matching extension throws", () => {
  executeTool("write_file", { path: "fdhi_basic/notes.txt", content: "hello" });
  try {
    executeTool("find_duplicate_html_id", { path: "fdhi_basic/notes.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: 3+ duplicates report all lines", () => {
  executeTool("create_directory", { path: "fdhi_triple" });
  executeTool("write_file", { path: "fdhi_triple/a.html", content:
    `<div id="dup"></div>\n<span id="dup"></span>\n<p id="dup"></p>` });
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_triple" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].occurrences, 3);
  assert.deepStrictEqual(r.findings[0].lines, [1, 2, 3]);
});

test("high: JSX id={`literal`} template form is detected", () => {
  executeTool("create_directory", { path: "fdhi_jsxtpl" });
  executeTool("write_file", { path: "fdhi_jsxtpl/a.jsx", content:
    "<div id={`fixed`}></div><span id={`fixed`}></span>" });
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_jsxtpl" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].id, "fixed");
});

test("high: JSX dynamic id={var} is skipped, never flagged", () => {
  executeTool("create_directory", { path: "fdhi_dynamic" });
  executeTool("write_file", { path: "fdhi_dynamic/a.jsx", content:
    `<div id={itemId}></div><span id={itemId}></span>` });
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_dynamic" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "fdhi_ext" });
  executeTool("write_file", { path: "fdhi_ext/a.html", content: `<div id="x"></div><span id="x"></span>` });
  executeTool("write_file", { path: "fdhi_ext/b.jsx", content: `<div id="y"></div><span id="y"></span>` });
  const rBoth = executeTool("find_duplicate_html_id", { path: "fdhi_ext" });
  const rHtmlOnly = executeTool("find_duplicate_html_id", { path: "fdhi_ext", extensions: [".html"] });
  assert.strictEqual(rBoth.findingsCount, 2);
  assert.strictEqual(rHtmlOnly.findingsCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_duplicate_html_id", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped id value is inert, never executed", () => {
  executeTool("create_directory", { path: "fdhi_inj" });
  executeTool("write_file", { path: "fdhi_inj/a.html", content:
    `<div id="$(rm -rf /)"></div><span id="$(rm -rf /)"></span>` });
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_inj" });
  assert.strictEqual(r.findingsCount, 1);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: max_results caps findings and sets truncated", () => {
  executeTool("create_directory", { path: "fdhi_many" });
  let content = "";
  for (let i = 0; i < 5; i++) content += `<div id="dup${i}"></div><span id="dup${i}"></span>\n`;
  executeTool("write_file", { path: "fdhi_many/a.html", content });
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_many", max_results: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

test("extreme: empty id=\"\" is not flagged", () => {
  executeTool("create_directory", { path: "fdhi_empty" });
  executeTool("write_file", { path: "fdhi_empty/a.html", content:
    `<div id=""></div><span id=""></span>` });
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_empty" });
  assert.strictEqual(r.findingsCount, 0);
});

test("extreme: single-file mode scans just that file", () => {
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_basic/a.html" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_duplicate_html_id", { path: "fdhi_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_duplicate_html_id fixtures", () => {
  for (const d of ["fdhi_basic", "fdhi_unique", "fdhi_triple", "fdhi_jsxtpl", "fdhi_dynamic", "fdhi_ext", "fdhi_inj", "fdhi_many", "fdhi_empty"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
