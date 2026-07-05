"use strict";
/**
 * [129] FIND_MISSING_IMG_ALT_TEXT — <img> accessibility scan
 *
 * Rigor levels:
 *   Normal:   <img> with no alt flagged (error); <img alt="description"> not flagged.
 *   Medium:   missing path defaults to root (no throw); max_results type mismatch throws;
 *             non-matching-extension single file throws.
 *   High:     alt="" (decorative) not flagged; alt="photo.jpg" flagged as non-descriptive
 *             (warning); JSX alt={variable} not flagged (dynamic, assumed fine);
 *             extensions filter narrows scan.
 *   Critical: path traversal via path arg blocked; shell-injection-shaped alt text inert.
 *   Extreme:  max_results caps + truncated flag; single-file mode works; JSON-serialisable;
 *             multiple <img> tags on one line all detected.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[129] FIND_MISSING_IMG_ALT_TEXT — <img> accessibility scan`);

test("normal: <img> with no alt attribute is flagged", () => {
  executeTool("create_directory", { path: "fmiat_basic" });
  executeTool("write_file", { path: "fmiat_basic/a.html", content:
    `<div><img src="photo.png"></div>` });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_basic" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_alt_attribute");
  assert.strictEqual(r.findings[0].severity, "error");
});

test("normal: <img alt=\"description\"> is not flagged", () => {
  executeTool("create_directory", { path: "fmiat_good" });
  executeTool("write_file", { path: "fmiat_good/a.html", content:
    `<img src="photo.png" alt="A red bicycle leaning against a wall">` });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_good" });
  assert.strictEqual(r.findingsCount, 0);
});

test("medium: max_results type mismatch throws", () => {
  try {
    executeTool("find_missing_img_alt_text", { path: "fmiat_basic", max_results: "5" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: single file with non-matching extension throws", () => {
  executeTool("write_file", { path: "fmiat_basic/notes.txt", content: "hello" });
  try {
    executeTool("find_missing_img_alt_text", { path: "fmiat_basic/notes.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: alt=\"\" (decorative image) is not flagged", () => {
  executeTool("create_directory", { path: "fmiat_decorative" });
  executeTool("write_file", { path: "fmiat_decorative/a.html", content:
    `<img src="spacer.png" alt="">` });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_decorative" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: alt=\"photo.jpg\" (filename-as-alt) is flagged as non-descriptive", () => {
  executeTool("create_directory", { path: "fmiat_filename" });
  executeTool("write_file", { path: "fmiat_filename/a.html", content:
    `<img src="img/photo.jpg" alt="photo.jpg">` });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_filename" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "non_descriptive_alt_text");
  assert.strictEqual(r.findings[0].severity, "warning");
  assert.strictEqual(r.findings[0].altText, "photo.jpg");
});

test("high: JSX alt={variable} (dynamic) is not flagged", () => {
  executeTool("create_directory", { path: "fmiat_jsx" });
  executeTool("write_file", { path: "fmiat_jsx/a.jsx", content:
    `function C() { return <img src={src} alt={altText} />; }` });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_jsx" });
  assert.strictEqual(r.findingsCount, 0);
});

test("high: extensions filter narrows scan to matching files only", () => {
  executeTool("create_directory", { path: "fmiat_ext" });
  executeTool("write_file", { path: "fmiat_ext/a.html", content: `<img src="a.png">` });
  executeTool("write_file", { path: "fmiat_ext/b.jsx", content: `<img src="b.png" />` });
  const rBoth = executeTool("find_missing_img_alt_text", { path: "fmiat_ext" });
  const rHtmlOnly = executeTool("find_missing_img_alt_text", { path: "fmiat_ext", extensions: [".html"] });
  assert.strictEqual(rBoth.findingsCount, 2);
  assert.strictEqual(rHtmlOnly.findingsCount, 1);
});

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("find_missing_img_alt_text", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped alt text is inert, never executed", () => {
  executeTool("create_directory", { path: "fmiat_inj" });
  executeTool("write_file", { path: "fmiat_inj/a.html", content:
    `<img src="x.png" alt="$(rm -rf /) DANGEROUS">` });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_inj" });
  assert.strictEqual(r.findingsCount, 0); // has non-empty, non-filename alt text — correctly not flagged, no injected text executed
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("critical: documented caveat — stray '>' inside alt value misplaces tag boundary but never crashes", () => {
  executeTool("create_directory", { path: "fmiat_stray_gt" });
  executeTool("write_file", { path: "fmiat_stray_gt/a.html", content:
    `<img src="x.png" alt="$(rm -rf /) <script>alert(1)</script>">` });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_stray_gt" });
  assert.doesNotThrow(() => JSON.stringify(r)); // never crashes regardless of the misplaced boundary
});

test("extreme: max_results caps findings and sets truncated", () => {
  executeTool("create_directory", { path: "fmiat_many" });
  let content = "";
  for (let i = 0; i < 5; i++) content += `<img src="s${i}.png">\n`;
  executeTool("write_file", { path: "fmiat_many/a.html", content });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_many", max_results: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

test("extreme: multiple <img> tags on one line are all detected", () => {
  executeTool("create_directory", { path: "fmiat_oneline" });
  executeTool("write_file", { path: "fmiat_oneline/a.html", content:
    `<img src="a.png"><img src="b.png" alt="Described image">` });
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_oneline" });
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: single-file mode scans just that file", () => {
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_basic/a.html" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

test("extreme: result is fully JSON-serialisable", () => {
  const r = executeTool("find_missing_img_alt_text", { path: "fmiat_many" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_missing_img_alt_text fixtures", () => {
  for (const d of ["fmiat_basic", "fmiat_good", "fmiat_decorative", "fmiat_filename", "fmiat_jsx", "fmiat_ext", "fmiat_inj", "fmiat_stray_gt", "fmiat_many", "fmiat_oneline"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
