"use strict";
// Tests for find_xss_risk
const { findXssRisk } = require("../../lib/xssRiskOps");
const { ToolError } = require("../../lib/errors");
const fs = require("fs");
const path = require("path");
const os = require("os");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS: ${name}`); passed++; }
  catch(e) { console.error(`  FAIL: ${name} — ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xss-test-"));
function write(name, code) {
  fs.writeFileSync(path.join(tmpDir, name), code);
}
function clean() { fs.rmSync(tmpDir, { recursive: true, force: true }); }

console.log("=== find_xss_risk ===");

// NORMAL — innerHTML with req input (should flag)
test("flags innerHTML with req.body taint", () => {
  write("a.js", "el.innerHTML = req.body.html;");
  const r = findXssRisk(tmpDir, tmpDir);
  assert(r.findingsCount >= 1, "expected findings");
  assert(r.findings[0].rule === "inner_html_assignment");
});

// NORMAL — document.write with user input (should flag)
test("flags document.write with query", () => {
  write("b.js", "document.write(req.query.name);");
  const r = findXssRisk(tmpDir, tmpDir);
  const f = r.findings.find(x => x.rule === "document_write_with_input");
  assert(f, "expected document_write finding");
});

// NORMAL — insertAdjacentHTML with input (should flag)
test("flags insertAdjacentHTML with user input", () => {
  write("c.js", "el.insertAdjacentHTML('beforeend', content);");
  const r = findXssRisk(tmpDir, tmpDir);
  const f = r.findings.find(x => x.rule === "insert_adjacent_html_with_input");
  assert(f, "expected insertAdjacentHTML finding");
});

// SUPPRESSION — sanitized annotation
test("suppresses finding with // xss-safe annotation", () => {
  write("d.js", "el.innerHTML = req.body.html; // xss-safe");
  const r = findXssRisk(tmpDir, tmpDir);
  const f = r.findings.filter(x => x.file === "d.js" && x.rule === "inner_html_assignment");
  assert(f.length === 0, "should be suppressed by annotation");
});

// SUPPRESSION — DOMPurify.sanitize hint
test("suppresses finding with DOMPurify.sanitize", () => {
  write("e.js", "el.innerHTML = DOMPurify.sanitize(req.body.html);");
  const r = findXssRisk(tmpDir, tmpDir);
  const f = r.findings.filter(x => x.file === "e.js");
  assert(f.length === 0, "DOMPurify.sanitize should suppress");
});

// MEDIUM — no taint, should not flag
test("does not flag innerHTML with static string", () => {
  write("f.js", "el.innerHTML = '<b>hello</b>';");
  const r = findXssRisk(tmpDir, tmpDir);
  const f = r.findings.filter(x => x.file === "f.js");
  assert(f.length === 0, "static string should not flag");
});

// MEDIUM — invalid max_results type
test("throws on non-number max_results", () => {
  let threw = false;
  try { findXssRisk(tmpDir, tmpDir, { maxResults: "abc" }); }
  catch(e) { threw = true; assert(e instanceof ToolError); }
  assert(threw, "should throw ToolError for bad maxResults");
});

// CRITICAL — path traversal input rejected
test("throws on non-existent path", () => {
  let threw = false;
  try { findXssRisk("/nonexistent/path", "/nonexistent/path"); }
  catch(e) { threw = true; }
  assert(threw, "should throw for nonexistent path");
});

// HIGH — binary file skipped
test("skips binary files", () => {
  const binPath = path.join(tmpDir, "bin.js");
  const buf = Buffer.alloc(100); buf[0] = 0; // NUL byte = binary
  fs.writeFileSync(binPath, buf);
  const r = findXssRisk(tmpDir, tmpDir);
  // Should not crash; binary file skipped
  assert(typeof r.findingsCount === "number");
});

clean();
console.log(`  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
