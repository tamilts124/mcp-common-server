"use strict";
/**
 * Tests for find_missing_doctype (doctypeOps.js)
 * All 5 rigor levels: normal, boundary, mock-failures, security, extreme/fuzz
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingDoctype } = require("../../lib/doctypeOps");

let passed = 0, failed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctype-test-"));

function write(name, content) {
  const fp = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

function test(label, fn) {
  try { fn(); console.log(`  \u2713 ${label}`); passed++; }
  catch (e) { console.error(`  \u2717 ${label}: ${e.message}`); failed++; }
}

// ── LEVEL 1: Normal ──────────────────────────────────────────────────────────
console.log("\n[Level 1] Normal");

test("valid HTML5 doctype — no findings", () => {
  const fp = write("valid.html", "<!DOCTYPE html>\n<html><head></head><body>Hi</body></html>");
  const r = findMissingDoctype(fp, "valid.html");
  assert.strictEqual(r.findingsCount, 0);
  assert.strictEqual(r.filesScanned, 1);
});

test("missing doctype — error finding", () => {
  const fp = write("missing.html", "<html><head></head><body>Hi</body></html>");
  const r = findMissingDoctype(fp, "missing.html");
  assert.strictEqual(r.errorCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_doctype");
  assert.strictEqual(r.findings[0].severity, "error");
});

test("XHTML doctype — non_html5_doctype warning", () => {
  const fp = write("xhtml.html",
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html/>');
  const r = findMissingDoctype(fp, "xhtml.html");
  assert.strictEqual(r.warningCount, 1);
  assert.strictEqual(r.findings[0].rule, "non_html5_doctype");
});

test("HTML4 doctype — non_html5_doctype warning", () => {
  const fp = write("html4.html",
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<html/>');
  const r = findMissingDoctype(fp, "html4.html");
  assert.strictEqual(r.warningCount, 1);
});

test("case-insensitive DOCTYPE — valid", () => {
  const fp = write("ci.html", "<!doctype html>\n<html/>");
  const r = findMissingDoctype(fp, "ci.html");
  assert.strictEqual(r.findingsCount, 0);
});

test("directory scan — finds multiple files", () => {
  write("sub/a.html", "<html/>");
  write("sub/b.html", "<!DOCTYPE html>\n<html/>");
  const r = findMissingDoctype(path.join(tmpDir, "sub"), "sub");
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.errorCount, 1);
});

// ── LEVEL 2: Boundary / Parameter Validation ─────────────────────────────────
console.log("\n[Level 2] Boundary");

test("max_results=1 — truncates", () => {
  write("trunc/a.html", "<html/>");
  write("trunc/b.html", "<html/>");
  const r = findMissingDoctype(path.join(tmpDir, "trunc"), "trunc", { maxResults: 1 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findings.length, 1);
});

test("max_results=0 — validation error", () => {
  const fp = write("val.html", "<html/>");
  assert.throws(() => findMissingDoctype(fp, "val.html", { maxResults: 0 }), /max_results/);
});

test("max_results=5001 — validation error", () => {
  const fp = write("val2.html", "<html/>");
  assert.throws(() => findMissingDoctype(fp, "val2.html", { maxResults: 5001 }), /max_results/);
});

test("non-html extension filtered by default", () => {
  write("page.js", "var x = 1;");
  const r = findMissingDoctype(tmpDir, ".", { maxResults: 500 });
  const jsFindings = r.findings.filter(f => f.file.endsWith("page.js"));
  assert.strictEqual(jsFindings.length, 0);
});

test("custom extensions — scan .htm", () => {
  write("page.htm", "<html/>");
  const r = findMissingDoctype(tmpDir, ".", { extensions: [".htm"] });
  assert.ok(r.filesScanned >= 1);
  const found = r.findings.find(f => f.file.includes("page.htm"));
  assert.ok(found);
});

test("path not found — throws -32602", () => {
  try {
    findMissingDoctype("/no/such/path/xyzabc", "/no/such/path/xyzabc");
    assert.fail("Should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

// ── LEVEL 3: Mock failures ───────────────────────────────────────────────────
console.log("\n[Level 3] Mock failures");

test("empty directory — 0 findings", () => {
  const empty = path.join(tmpDir, "emptydir");
  fs.mkdirSync(empty, { recursive: true });
  const r = findMissingDoctype(empty, "emptydir");
  assert.strictEqual(r.findingsCount, 0);
  assert.strictEqual(r.filesScanned, 0);
});

test("empty HTML file — missing_doctype error", () => {
  const fp = write("empty.html", "");
  const r = findMissingDoctype(fp, "empty.html");
  assert.strictEqual(r.errorCount, 1);
});

test("node_modules subdir skipped", () => {
  write("nm/node_modules/dep.html", "<html/>");
  const before = findMissingDoctype(path.join(tmpDir, "nm"), "nm").filesScanned;
  assert.strictEqual(before, 0); // node_modules skipped
});

// ── LEVEL 4: Security ────────────────────────────────────────────────────────
console.log("\n[Level 4] Security");

test("content with traversal strings — valid doctype not flagged", () => {
  const fp = write("sec.html", "<!DOCTYPE html>\n<html>../../../etc/passwd</html>");
  const r = findMissingDoctype(fp, "sec.html");
  assert.strictEqual(r.findingsCount, 0);
});

test("script injection in doctype value — message is plain string", () => {
  const fp = write("xss.html", '<!DOCTYPE html PUBLIC "<script>alert(1)</script>">\n<html/>');
  const r = findMissingDoctype(fp, "xss.html");
  assert.strictEqual(r.warningCount, 1);
  assert.ok(typeof r.findings[0].message === "string");
});

test("null bytes in content — no crash", () => {
  const fp = path.join(tmpDir, "null.html");
  fs.writeFileSync(fp, Buffer.from([0x3c, 0x00, 0x68, 0x74, 0x6d, 0x6c, 0x3e]));
  const r = findMissingDoctype(fp, "null.html");
  assert.ok(typeof r.findingsCount === "number");
});

test("extremely long DOCTYPE value — no crash", () => {
  const longVal = "A".repeat(10000);
  const fp = write("long.html", `<!DOCTYPE ${longVal}>\n<html/>`);
  const r = findMissingDoctype(fp, "long.html");
  assert.strictEqual(r.warningCount, 1);
});

// ── LEVEL 5: Extreme / Fuzz ──────────────────────────────────────────────────
console.log("\n[Level 5] Extreme/Fuzz");

test("file with only whitespace — missing_doctype", () => {
  const fp = write("ws.html", "   \n\n\n   ");
  const r = findMissingDoctype(fp, "ws.html");
  assert.strictEqual(r.errorCount, 1);
});

test("large file (100KB) — no crash", () => {
  const content = "<!DOCTYPE html>\n<html>" + "<p>x</p>".repeat(12000) + "</html>";
  const fp = write("large.html", content);
  const r = findMissingDoctype(fp, "large.html");
  assert.strictEqual(r.findingsCount, 0);
});

test("random fuzz: 20 random HTML strings", () => {
  for (let i = 0; i < 20; i++) {
    const len = Math.floor(Math.random() * 500);
    const chars = "<!DOCTYPE html><>/ \n\r\t?ABCDE";
    let s = "";
    for (let j = 0; j < len; j++) s += chars[Math.floor(Math.random() * chars.length)];
    const fp = write(`fuzz${i}.html`, s);
    findMissingDoctype(fp, `fuzz${i}.html`); // must not throw
  }
});

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\nfind_missing_doctype: ${passed} passed, ${failed} failed\n`);
module.exports = { passed, failed };
