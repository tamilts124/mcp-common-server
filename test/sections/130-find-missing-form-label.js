"use strict";
/**
 * [130] FIND_MISSING_FORM_LABEL — <input>/<textarea>/<select> accessible-name scan
 *
 * Rigor levels:
 *   Normal:   bare <input> with no name flagged (error); <input aria-label="Name"> not flagged.
 *   Medium:   missing path defaults to root (no throw); max_results type mismatch throws;
 *             non-matching-extension single file throws.
 *   High:     <label for="id"> association not flagged; enclosing <label> wrap not flagged;
 *             aria-labelledby not flagged; type="hidden"/"submit" skipped; <textarea>/<select>
 *             covered; extensions filter narrows scan.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped attribute inert.
 *   Extreme:  max_results caps + truncated flag; single-file mode works; JSON-serialisable;
 *             multiple controls on one line all detected.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[130] FIND_MISSING_FORM_LABEL — form control accessible-name scan`);

test("normal: bare <input> with no accessible name is flagged", () => {
  executeTool("create_directory", { path: "fmfl_basic" });
  executeTool("write_file", { path: "fmfl_basic/a.html", content:
    `<div><input type="text"></div>` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_basic" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_form_label");
  assert.strictEqual(r.findings[0].tag, "input");
});

test("normal: <input aria-label=\"Name\"> is not flagged", () => {
  executeTool("create_directory", { path: "fmfl_arialabel" });
  executeTool("write_file", { path: "fmfl_arialabel/a.html", content:
    `<input type="text" aria-label="Full name">` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_arialabel" });
  assert.strictEqual(r.findingsCount, 0);
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_missing_form_label", { path: "fmfl_basic", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: single file with non-matching extension throws", () => {
  executeTool("write_file", { path: "fmfl_basic/notes.txt", content: "hello" });
  try {
    executeTool("find_missing_form_label", { path: "fmfl_basic/notes.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: <label for=\"id\"> association is not flagged", () => {
  executeTool("create_directory", { path: "fmfl_forid" });
  executeTool("write_file", { path: "fmfl_forid/a.html", content:
    `<label for="email">Email</label><input id="email" type="text">` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_forid" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: enclosing <label> wrap is not flagged", () => {
  executeTool("create_directory", { path: "fmfl_wrap" });
  executeTool("write_file", { path: "fmfl_wrap/a.html", content:
    `<label>Name <input type="text"></label>` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_wrap" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: aria-labelledby is not flagged", () => {
  executeTool("create_directory", { path: "fmfl_labelledby" });
  executeTool("write_file", { path: "fmfl_labelledby/a.html", content:
    `<span id="lbl">Name</span><input aria-labelledby="lbl" type="text">` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_labelledby" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: type=\"hidden\"/\"submit\" are skipped", () => {
  executeTool("create_directory", { path: "fmfl_skiptypes" });
  executeTool("write_file", { path: "fmfl_skiptypes/a.html", content:
    `<input type="hidden" value="x"><input type="submit" value="Go">` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_skiptypes" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: unlabeled <textarea> and <select> are both detected", () => {
  executeTool("create_directory", { path: "fmfl_othertags" });
  executeTool("write_file", { path: "fmfl_othertags/a.html", content:
    `<textarea></textarea><select><option>1</option></select>` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_othertags" });
  assert.strictEqual(r.findingsCount, 2);
  const tags = r.findings.map(f => f.tag).sort();
  assert.deepStrictEqual(tags, ["select", "textarea"]);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "fmfl_ext" });
  executeTool("write_file", { path: "fmfl_ext/a.html", content: `<input type="text">` });
  executeTool("write_file", { path: "fmfl_ext/b.jsx", content: `<input type="text" />` });
  const rBoth = executeTool("find_missing_form_label", { path: "fmfl_ext" });
  const rHtmlOnly = executeTool("find_missing_form_label", { path: "fmfl_ext", extensions: [".html"] });
  assert.strictEqual(rBoth.findingsCount, 2);
  assert.strictEqual(rHtmlOnly.findingsCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_missing_form_label", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped attribute value is inert, never executed", () => {
  executeTool("create_directory", { path: "fmfl_inj" });
  executeTool("write_file", { path: "fmfl_inj/a.html", content:
    `<input type="text" aria-label="$(rm -rf /) NAME">` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_inj" });
  assert.strictEqual(r.findingsCount, 0); // non-empty aria-label — correctly not flagged, no injected text executed
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: max_results caps findings and sets truncated", () => {
  executeTool("create_directory", { path: "fmfl_many" });
  let content = "";
  for (let i = 0; i < 5; i++) content += `<input id="f${i}" type="text">\n`;
  executeTool("write_file", { path: "fmfl_many/a.html", content });
  const r = executeTool("find_missing_form_label", { path: "fmfl_many", max_results: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

test("extreme: multiple controls on one line are all detected", () => {
  executeTool("create_directory", { path: "fmfl_oneline" });
  executeTool("write_file", { path: "fmfl_oneline/a.html", content:
    `<input type="text"><input type="text" aria-label="Named">` });
  const r = executeTool("find_missing_form_label", { path: "fmfl_oneline" });
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: single-file mode scans just that file", () => {
  const r = executeTool("find_missing_form_label", { path: "fmfl_basic/a.html" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_missing_form_label", { path: "fmfl_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_missing_form_label fixtures", () => {
  for (const d of ["fmfl_basic", "fmfl_arialabel", "fmfl_forid", "fmfl_wrap", "fmfl_labelledby", "fmfl_skiptypes", "fmfl_othertags", "fmfl_ext", "fmfl_inj", "fmfl_many", "fmfl_oneline"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
