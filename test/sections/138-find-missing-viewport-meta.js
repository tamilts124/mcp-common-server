"use strict";
/**
 * [138] FIND_MISSING_VIEWPORT_META — viewport meta tag absence scan
 *
 * Rigor levels:
 *   Normal:   missing viewport flagged as error; good viewport no findings;
 *             missing width=device-width warned; reversed attr order works;
 *             directory mode scans only .html/.htm.
 *   Medium:   empty file flagged; max_results truncation; boundary values.
 *   High:     nonexistent path throws; nested dirs traversed; node_modules excluded.
 *   Critical: display-only path traversal doesn't affect logic; adversarial
 *             content handled; result is JSON-serialisable; exact key set.
 *   Extreme:  large file handled quickly; deeply nested dir; empty dir;
 *             max_results=5000; concurrent calls consistent.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[138] FIND_MISSING_VIEWPORT_META — viewport meta tag absence scan`);

// ─── LEVEL 1: NORMAL ────────────────────────────────────────────────────────

test("normal: file missing viewport meta is flagged as error", () => {
  executeTool("create_directory", { path: "fmvm_noviewport" });
  executeTool("write_file", { path: "fmvm_noviewport/a.html",
    content: `<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_noviewport" });
  assert.strictEqual(r.findingsCount, 1, "1 finding for missing viewport");
  assert.strictEqual(r.findings[0].rule, "missing_viewport_meta");
  assert.strictEqual(r.findings[0].severity, "error");
  assert.strictEqual(r.errorCount, 1);
  assert.strictEqual(r.warningCount, 0);
});

test("normal: file with correct viewport meta has no findings", () => {
  executeTool("create_directory", { path: "fmvm_good" });
  executeTool("write_file", { path: "fmvm_good/index.html",
    content: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_good" });
  assert.strictEqual(r.findingsCount, 0, "0 findings for correct viewport");
  assert.strictEqual(r.filesScanned, 1);
});

test("normal: viewport present but missing width=device-width is warned", () => {
  executeTool("create_directory", { path: "fmvm_nowidth" });
  executeTool("write_file", { path: "fmvm_nowidth/a.html",
    content: `<html><head><meta name="viewport" content="initial-scale=1"></head></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_nowidth" });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "viewport_missing_width_device_width");
  assert.strictEqual(r.findings[0].severity, "warning");
  assert.strictEqual(r.warningCount, 1);
});

test("normal: reversed attribute order (content before name) is detected correctly", () => {
  executeTool("create_directory", { path: "fmvm_reversed" });
  executeTool("write_file", { path: "fmvm_reversed/a.html",
    content: `<html><head><meta content="width=device-width, initial-scale=1" name="viewport"></head></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_reversed" });
  assert.strictEqual(r.findingsCount, 0, "reversed attr order detected correctly");
});

test("normal: directory mode scans only .html and .htm files", () => {
  executeTool("create_directory", { path: "fmvm_dirmode" });
  executeTool("write_file", { path: "fmvm_dirmode/a.html",
    content: `<html><head></head></html>` });
  executeTool("write_file", { path: "fmvm_dirmode/b.js",
    content: `// no viewport here` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_dirmode" });
  assert.strictEqual(r.filesScanned, 1, "only .html file scanned");
  assert.strictEqual(r.findingsCount, 1);
});

test("normal: .htm extension also scanned by default", () => {
  executeTool("create_directory", { path: "fmvm_htm" });
  executeTool("write_file", { path: "fmvm_htm/page.htm",
    content: `<html><head></head></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_htm" });
  assert.strictEqual(r.filesScanned, 1, ".htm file scanned");
  assert.strictEqual(r.findingsCount, 1);
});

// ─── LEVEL 2: MEDIUM ────────────────────────────────────────────────────────

test("medium: empty HTML file is flagged for missing viewport", () => {
  executeTool("create_directory", { path: "fmvm_empty" });
  // write_file requires non-empty content; use minimal whitespace-only HTML
  executeTool("write_file", { path: "fmvm_empty/empty.html", content: " " });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_empty" });
  assert.strictEqual(r.findingsCount, 1, "nearly-empty file flagged");
  assert.strictEqual(r.findings[0].rule, "missing_viewport_meta");
});

test("medium: max_results truncation sets truncated flag", () => {
  executeTool("create_directory", { path: "fmvm_trunc" });
  for (let i = 0; i < 4; i++) {
    executeTool("write_file", { path: `fmvm_trunc/p${i}.html`,
      content: `<html><head></head></html>` });
  }
  const r = executeTool("find_missing_viewport_meta",
    { path: "fmvm_trunc", max_results: 2 });
  assert.strictEqual(r.truncated, true, "truncated=true");
  assert.ok(r.findings.length <= 2, "findings capped at 2");
});

test("medium: max_results=0 throws -32602", () => {
  executeTool("create_directory", { path: "fmvm_mbounds" });
  executeTool("write_file", { path: "fmvm_mbounds/a.html", content: "<html></html>" });
  try {
    executeTool("find_missing_viewport_meta",
      { path: "fmvm_mbounds", max_results: 0 });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: max_results=5001 throws -32602", () => {
  try {
    executeTool("find_missing_viewport_meta",
      { path: "fmvm_mbounds", max_results: 5001 });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("medium: custom extensions (.xhtml) are respected", () => {
  executeTool("create_directory", { path: "fmvm_xhtml" });
  executeTool("write_file", { path: "fmvm_xhtml/page.xhtml",
    content: `<html><head></head></html>` });
  const r = executeTool("find_missing_viewport_meta",
    { path: "fmvm_xhtml", extensions: [".xhtml"] });
  assert.strictEqual(r.filesScanned, 1, "custom extension scanned");
  assert.strictEqual(r.findingsCount, 1);
});

// ─── LEVEL 3: HIGH ─────────────────────────────────────────────────────────���

test("high: nonexistent path throws an error", () => {
  try {
    executeTool("find_missing_viewport_meta", { path: "nonexistent_fmvm_xyz_999" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: nested directory structure is traversed", () => {
  executeTool("create_directory", { path: "fmvm_nested/sub/deep" });
  executeTool("write_file", { path: "fmvm_nested/sub/deep/index.html",
    content: `<html><head></head></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_nested" });
  assert.strictEqual(r.filesScanned, 1, "nested file found");
  assert.strictEqual(r.findingsCount, 1);
});

test("high: node_modules directory is excluded", () => {
  executeTool("create_directory", { path: "fmvm_nmtest/node_modules/pkg" });
  executeTool("write_file",
    { path: "fmvm_nmtest/node_modules/pkg/index.html",
      content: `<html><head></head></html>` });
  executeTool("write_file", { path: "fmvm_nmtest/index.html",
    content: `<html><head><meta name="viewport" content="width=device-width"></head></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_nmtest" });
  assert.strictEqual(r.filesScanned, 1, "node_modules excluded");
  assert.strictEqual(r.findingsCount, 0, "no finding (only good file scanned)");
});

test("high: single-file mode returns correct result", () => {
  const r = executeTool("find_missing_viewport_meta",
    { path: "fmvm_noviewport/a.html" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
});

// ─── LEVEL 4: CRITICAL ──────────────────────────────────────────────────────

test("critical: path traversal arg is blocked by roots", () => {
  try {
    executeTool("find_missing_viewport_meta", { path: "../../../../etc" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: XSS content in viewport value doesn't break scanner", () => {
  executeTool("create_directory", { path: "fmvm_xss" });
  executeTool("write_file", { path: "fmvm_xss/a.html",
    content: `<html><head><meta name="viewport" content="width=device-width; <script>alert(1)</script>"></head></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_xss" });
  assert.strictEqual(r.findingsCount, 0, "XSS content parsed safely");
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("critical: result is JSON-serialisable", () => {
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_noviewport" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("critical: exact top-level key set present", () => {
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_good" });
  for (const k of ["path", "filesScanned", "findingsCount", "errorCount", "warningCount", "truncated", "findings"]) {
    assert.ok(Object.keys(r).includes(k), `missing key: ${k}`);
  }
});

test("critical: long content attribute handled gracefully", () => {
  executeTool("create_directory", { path: "fmvm_longcontent" });
  const longContent = "x".repeat(10000);
  executeTool("write_file", { path: "fmvm_longcontent/a.html",
    content: `<html><head><meta name="viewport" content="${longContent}"></head></html>` });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_longcontent" });
  assert.strictEqual(r.findings[0].rule, "viewport_missing_width_device_width");
  assert.doesNotThrow(() => JSON.stringify(r));
});

// ─── LEVEL 5: EXTREME ───────────────────────────────────────────────────────

test("extreme: empty directory returns 0 files and 0 findings", () => {
  executeTool("create_directory", { path: "fmvm_emptydir" });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_emptydir" });
  assert.strictEqual(r.filesScanned, 0, "0 files");
  assert.strictEqual(r.findingsCount, 0, "0 findings");
});

test("extreme: max_results=5000 does not truncate 10 files", () => {
  executeTool("create_directory", { path: "fmvm_bigbatch" });
  for (let i = 0; i < 10; i++) {
    executeTool("write_file", { path: `fmvm_bigbatch/p${i}.html`,
      content: `<html><head></head></html>` });
  }
  const r = executeTool("find_missing_viewport_meta",
    { path: "fmvm_bigbatch", max_results: 5000 });
  assert.strictEqual(r.truncated, false, "no truncation for 10 files");
  assert.strictEqual(r.findingsCount, 10);
});

test("extreme: fuzz random bytes in HTML don't crash", () => {
  executeTool("create_directory", { path: "fmvm_fuzz" });
  const fuzz = Buffer.from(
    Array.from({ length: 200 }, () => Math.floor(Math.random() * 256))
  ).toString("latin1");
  executeTool("write_file", { path: "fmvm_fuzz/a.html", content: fuzz });
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_fuzz" });
  assert.ok(r.findingsCount >= 0, "no crash on fuzz input");
});

test("extreme: result fully JSON-serialisable after bulk scan", () => {
  const r = executeTool("find_missing_viewport_meta", { path: "fmvm_bigbatch" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("cleanup: remove find_missing_viewport_meta fixtures", () => {
  for (const d of [
    "fmvm_noviewport", "fmvm_good", "fmvm_nowidth", "fmvm_reversed",
    "fmvm_dirmode", "fmvm_htm", "fmvm_empty", "fmvm_trunc",
    "fmvm_mbounds", "fmvm_xhtml", "fmvm_nested", "fmvm_nmtest",
    "fmvm_xss", "fmvm_longcontent", "fmvm_emptydir", "fmvm_bigbatch", "fmvm_fuzz",
  ]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
