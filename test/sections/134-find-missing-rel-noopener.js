"use strict";
/**
 * [134] FIND_MISSING_REL_NOOPENER — target="_blank" reverse-tabnabbing scan
 *
 * Rigor levels:
 *   Normal:   target="_blank" with no rel flagged (error); rel="noopener" not flagged.
 *   Medium:   max_results type mismatch throws; non-matching-extension single file throws.
 *   High:     rel="noreferrer" also treated as safe; JSX target={"_blank"} detected;
 *             JSX dynamic target={var} skipped; dynamic/spread rel not flagged;
 *             extensions filter narrows scan.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped surrounding
 *             attribute text inert/never executed.
 *   Extreme:  max_results caps + truncated flag; single-file mode works; JSON-serialisable.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[134] FIND_MISSING_REL_NOOPENER — target="_blank" reverse-tabnabbing scan`);

test("normal: target=\"_blank\" with no rel is flagged", () => {
  executeTool("create_directory", { path: "fmrn_basic" });
  executeTool("write_file", { path: "fmrn_basic/a.html", content:
    `<a href="https://example.com" target="_blank">link</a>` });
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_basic" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_rel_noopener");
  assert.strictEqual(r.findings[0].severity, "error");
});

test("normal: rel=\"noopener\" is not flagged", () => {
  executeTool("create_directory", { path: "fmrn_safe" });
  executeTool("write_file", { path: "fmrn_safe/a.html", content:
    `<a href="https://example.com" target="_blank" rel="noopener">link</a>` });
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_safe" });
  assert.strictEqual(r.findingsCount, 0);
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_missing_rel_noopener", { path: "fmrn_basic", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: single file with non-matching extension throws", () => {
  executeTool("write_file", { path: "fmrn_basic/notes.txt", content: "hello" });
  try {
    executeTool("find_missing_rel_noopener", { path: "fmrn_basic/notes.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: rel=\"noreferrer\" is also treated as safe", () => {
  executeTool("create_directory", { path: "fmrn_noref" });
  executeTool("write_file", { path: "fmrn_noref/a.html", content:
    `<a href="https://example.com" target="_blank" rel="noreferrer">link</a>` });
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_noref" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: JSX target={\"_blank\"} is detected", () => {
  executeTool("create_directory", { path: "fmrn_jsx" });
  executeTool("write_file", { path: "fmrn_jsx/a.jsx", content:
    `<a href="https://example.com" target={"_blank"}>link</a>` });
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_jsx" });
  assert.strictEqual(r.findingsCount, 1);
});

test("high: JSX dynamic target={var} is skipped, never flagged", () => {
  executeTool("create_directory", { path: "fmrn_dynamic" });
  executeTool("write_file", { path: "fmrn_dynamic/a.jsx", content:
    `<a href="https://example.com" target={someVar}>link</a>` });
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_dynamic" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: dynamic rel={var} and spread props are not flagged", () => {
  executeTool("create_directory", { path: "fmrn_dynrel" });
  executeTool("write_file", { path: "fmrn_dynrel/a.jsx", content:
    `<a href="https://example.com" target="_blank" rel={relVar}>x</a>\n<a href="https://example.com" target="_blank" {...linkProps}>y</a>` });
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_dynrel" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "fmrn_ext" });
  executeTool("write_file", { path: "fmrn_ext/a.html", content: `<a href="x" target="_blank">a</a>` });
  executeTool("write_file", { path: "fmrn_ext/b.jsx", content: `<a href="x" target="_blank">b</a>` });
  const rBoth = executeTool("find_missing_rel_noopener", { path: "fmrn_ext" });
  const rHtmlOnly = executeTool("find_missing_rel_noopener", { path: "fmrn_ext", extensions: [".html"] });
  assert.strictEqual(rBoth.findingsCount, 2);
  assert.strictEqual(rHtmlOnly.findingsCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_missing_rel_noopener", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped surrounding text is inert, never executed", () => {
  executeTool("create_directory", { path: "fmrn_inj" });
  executeTool("write_file", { path: "fmrn_inj/a.html", content:
    `<a href="$(rm -rf /)" target="_blank">link</a>` });
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_inj" });
  assert.strictEqual(r.findingsCount, 1);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: max_results caps findings and sets truncated", () => {
  executeTool("create_directory", { path: "fmrn_many" });
  let content = "";
  for (let i = 0; i < 5; i++) content += `<a href="https://x${i}.com" target="_blank">l${i}</a>\n`;
  executeTool("write_file", { path: "fmrn_many/a.html", content });
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_many", max_results: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

test("extreme: single-file mode scans just that file", () => {
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_basic/a.html" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_missing_rel_noopener", { path: "fmrn_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_missing_rel_noopener fixtures", () => {
  for (const d of ["fmrn_basic", "fmrn_safe", "fmrn_noref", "fmrn_jsx", "fmrn_dynamic", "fmrn_dynrel", "fmrn_ext", "fmrn_inj", "fmrn_many"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
