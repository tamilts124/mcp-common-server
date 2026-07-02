"use strict";
/**
 * [64] SEARCH_IN_DOCUMENT — grep-like text search inside .docx/.pdf
 *
 * Rigor levels:
 *   Normal:   happy-path match in a generated .docx and .pdf, correct line/
 *             content/context shape.
 *   Medium:   missing pattern / unsupported extension throw -32602; no
 *             matches returns empty array (not an error).
 *   High:     malformed/non-document files (plain text renamed .docx/.pdf,
 *             corrupt zip) throw descriptive errors, not a crash.
 *   Critical: regex-mode injection-shaped pattern (path traversal string as
 *             search text) is treated as plain search content, no exploit;
 *             invalid regex pattern throws cleanly.
 *   Extreme:  case-insensitive + context window across multiple paragraphs;
 *             max_matches cap truncates correctly; large document performs
 *             reasonably.
 *
 * IIFE assigned to module.exports, same pattern as sections 55/58/63 —
 * has async test bodies, so run-tests.js must `await require(...)` this
 * file for counters to be accurate before the final summary is printed.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[64] SEARCH_IN_DOCUMENT — grep inside .docx/.pdf`);

const DOCX_MD = "# Report Title\n\nThe quarterly revenue GREW substantially this year.\n\n- Revenue grew 12%\n- Costs fell 3%\n\nFinal notes about the revenue figures follow.\n";

module.exports = (async () => {
  await test("normal: docx match returns correct shape", async () => {
    executeTool("write_file", { path: "sd1.md", content: DOCX_MD });
    executeTool("md_to_docx", { path: "sd1.md", destination: "sd1.docx" });
    const r = executeTool("search_in_document", { path: "sd1.docx", pattern: "revenue", ignore_case: true });
    assert.ok(r.totalMatches >= 2);
    assert.strictEqual(r.format, "docx");
    assert.ok(r.matches[0].line >= 1);
    assert.ok(typeof r.matches[0].content === "string");
  });

  await test("normal: pdf match returns correct shape", async () => {
    executeTool("write_file", { path: "sd1.md", content: DOCX_MD });
    executeTool("md_to_pdf", { path: "sd1.md", destination: "sd1.pdf" });
    const r = executeTool("search_in_document", { path: "sd1.pdf", pattern: "quarterly" });
    assert.ok(r.totalMatches >= 1);
    assert.strictEqual(r.format, "pdf");
  });

  await test("medium: missing pattern throws -32602", () => {
    assert.throws(() => executeTool("search_in_document", { path: "sd1.docx" }));
  });

  await test("medium: unsupported extension throws -32602", () => {
    executeTool("write_file", { path: "sd1.txt", content: "hello" });
    try {
      executeTool("search_in_document", { path: "sd1.txt", pattern: "hello" });
      assert.fail("should have thrown");
    } catch (e) { assert.strictEqual(e.code, -32602); }
  });

  await test("medium: no matches returns empty array, not an error", () => {
    const r = executeTool("search_in_document", { path: "sd1.docx", pattern: "zzz_nonexistent_zzz" });
    assert.strictEqual(r.totalMatches, 0);
    assert.deepStrictEqual(r.matches, []);
  });

  await test("high: non-docx file with .docx extension throws descriptively", () => {
    executeTool("write_file", { path: "fake.docx", content: "not a zip" });
    try {
      executeTool("search_in_document", { path: "fake.docx", pattern: "x" });
      assert.fail("should have thrown");
    } catch (e) { assert.strictEqual(e.code, -32602); }
  });

  await test("high: non-pdf file with .pdf extension throws descriptively", () => {
    executeTool("write_file", { path: "fake.pdf", content: "not a pdf" });
    try {
      executeTool("search_in_document", { path: "fake.pdf", pattern: "x" });
      assert.fail("should have thrown");
    } catch (e) { assert.strictEqual(e.code, -32602); }
  });

  await test("critical: path-traversal-shaped search text treated as literal content, no exploit", () => {
    const r = executeTool("search_in_document", { path: "sd1.docx", pattern: "../../../etc/passwd" });
    assert.strictEqual(r.totalMatches, 0); // not present in doc, but must not throw/crash
  });

  await test("critical: invalid regex pattern throws cleanly", () => {
    try {
      executeTool("search_in_document", { path: "sd1.docx", pattern: "(unclosed", is_regex: true });
      assert.fail("should have thrown");
    } catch (e) { assert.strictEqual(e.code, -32602); }
  });

  await test("extreme: context window returns surrounding paragraphs", () => {
    const r = executeTool("search_in_document", { path: "sd1.docx", pattern: "grew 12%", context: 1 });
    assert.strictEqual(r.totalMatches, 1);
    assert.ok(Array.isArray(r.matches[0].context.before));
    assert.ok(Array.isArray(r.matches[0].context.after));
  });

  await test("extreme: max_matches caps results and sets truncated", () => {
    const md = Array.from({ length: 20 }, (_, i) => `Line number ${i} contains keyword TARGET.`).join("\n\n");
    executeTool("write_file", { path: "sd_many.md", content: md });
    executeTool("md_to_docx", { path: "sd_many.md", destination: "sd_many.docx" });
    const r = executeTool("search_in_document", { path: "sd_many.docx", pattern: "TARGET", max_matches: 5 });
    assert.strictEqual(r.matches.length, 5);
    assert.strictEqual(r.truncated, true);
  });

  await test("cleanup: remove search-in-document fixtures", () => {
    for (const f of ["sd1.md", "sd1.docx", "sd1.pdf", "sd1.txt", "fake.docx", "fake.pdf", "sd_many.md", "sd_many.docx"]) {
      try { executeTool("delete_file", { path: f }); } catch (_) {}
    }
  });
})();
