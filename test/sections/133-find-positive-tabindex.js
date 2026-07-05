"use strict";
/**
 * [133] FIND_POSITIVE_TABINDEX — tabindex/tabIndex > 0 anti-pattern scan
 *
 * Rigor levels:
 *   Normal:   tabindex="1" flagged (warning, value=1); tabindex="0"/"-1" not flagged.
 *   Medium:   max_results type mismatch throws; non-matching-extension single file throws.
 *   High:     JSX tabIndex={2} detected; JSX dynamic tabIndex={var} skipped; malformed
 *             value skipped; multiple positive tabindex per file all detected; extensions
 *             filter narrows scan.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped surrounding
 *             text inert/never executed.
 *   Extreme:  max_results caps + truncated flag; single-file mode works; JSON-serialisable.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[133] FIND_POSITIVE_TABINDEX — tabindex > 0 anti-pattern scan`);

test("normal: tabindex=\"1\" is flagged as positive_tabindex warning", () => {
  executeTool("create_directory", { path: "fpt_basic" });
  executeTool("write_file", { path: "fpt_basic/a.html", content:
    `<div tabindex="1"></div>` });
  const r = executeTool("find_positive_tabindex", { path: "fpt_basic" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "positive_tabindex");
  assert.strictEqual(r.findings[0].severity, "warning");
  assert.strictEqual(r.findings[0].value, 1);
});

test("normal: tabindex=\"0\" and tabindex=\"-1\" are not flagged", () => {
  executeTool("create_directory", { path: "fpt_legit" });
  executeTool("write_file", { path: "fpt_legit/a.html", content:
    `<div tabindex="0"></div><span tabindex="-1"></span>` });
  const r = executeTool("find_positive_tabindex", { path: "fpt_legit" });
  assert.strictEqual(r.findingsCount, 0);
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_positive_tabindex", { path: "fpt_basic", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: single file with non-matching extension throws", () => {
  executeTool("write_file", { path: "fpt_basic/notes.txt", content: "hello" });
  try {
    executeTool("find_positive_tabindex", { path: "fpt_basic/notes.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: JSX tabIndex={2} is detected", () => {
  executeTool("create_directory", { path: "fpt_jsx" });
  executeTool("write_file", { path: "fpt_jsx/a.jsx", content:
    `<div tabIndex={2}></div>` });
  const r = executeTool("find_positive_tabindex", { path: "fpt_jsx" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].value, 2);
});

test("high: JSX dynamic tabIndex={var} is skipped, never flagged", () => {
  executeTool("create_directory", { path: "fpt_dynamic" });
  executeTool("write_file", { path: "fpt_dynamic/a.jsx", content:
    `<div tabIndex={someVar}></div>` });
  const r = executeTool("find_positive_tabindex", { path: "fpt_dynamic" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: malformed non-numeric tabindex value is skipped", () => {
  executeTool("create_directory", { path: "fpt_malformed" });
  executeTool("write_file", { path: "fpt_malformed/a.html", content:
    `<div tabindex="abc"></div>` });
  const r = executeTool("find_positive_tabindex", { path: "fpt_malformed" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: multiple positive tabindex elements per file are all detected", () => {
  executeTool("create_directory", { path: "fpt_multi" });
  executeTool("write_file", { path: "fpt_multi/a.html", content:
    `<div tabindex="1"></div>\n<span tabindex="3"></span>\n<p tabindex="0"></p>` });
  const r = executeTool("find_positive_tabindex", { path: "fpt_multi" });
  assert.strictEqual(r.findingsCount, 2);
  assert.deepStrictEqual(r.findings.map(f => f.value), [1, 3]);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "fpt_ext" });
  executeTool("write_file", { path: "fpt_ext/a.html", content: `<div tabindex="1"></div>` });
  executeTool("write_file", { path: "fpt_ext/b.jsx", content: `<div tabIndex={2}></div>` });
  const rBoth = executeTool("find_positive_tabindex", { path: "fpt_ext" });
  const rHtmlOnly = executeTool("find_positive_tabindex", { path: "fpt_ext", extensions: [".html"] });
  assert.strictEqual(rBoth.findingsCount, 2);
  assert.strictEqual(rHtmlOnly.findingsCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_positive_tabindex", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped surrounding text is inert, never executed", () => {
  executeTool("create_directory", { path: "fpt_inj" });
  executeTool("write_file", { path: "fpt_inj/a.html", content:
    `<div data-x="$(rm -rf /)" tabindex="1"></div>` });
  const r = executeTool("find_positive_tabindex", { path: "fpt_inj" });
  assert.strictEqual(r.findingsCount, 1);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: max_results caps findings and sets truncated", () => {
  executeTool("create_directory", { path: "fpt_many" });
  let content = "";
  for (let i = 1; i <= 5; i++) content += `<div tabindex="${i}"></div>\n`;
  executeTool("write_file", { path: "fpt_many/a.html", content });
  const r = executeTool("find_positive_tabindex", { path: "fpt_many", max_results: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

test("extreme: single-file mode scans just that file", () => {
  const r = executeTool("find_positive_tabindex", { path: "fpt_basic/a.html" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_positive_tabindex", { path: "fpt_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_positive_tabindex fixtures", () => {
  for (const d of ["fpt_basic", "fpt_legit", "fpt_jsx", "fpt_dynamic", "fpt_malformed", "fpt_multi", "fpt_ext", "fpt_inj", "fpt_many"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
