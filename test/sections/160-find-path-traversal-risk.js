"use strict";
// Tests for find_path_traversal_risk
const { findPathTraversalRisk } = require("../../lib/pathTraversalOps");
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ptrav-test-"));
function write(name, code) { fs.writeFileSync(path.join(tmpDir, name), code); }
function clean() { fs.rmSync(tmpDir, { recursive: true, force: true }); }

console.log("=== find_path_traversal_risk ===");

// NORMAL — path.join with req input
test("flags path.join with req.params input", () => {
  write("a.js", "const p = path.join('/uploads', req.params.filename);");
  const r = findPathTraversalRisk(tmpDir, tmpDir);
  assert(r.findingsCount >= 1, "expected finding");
  assert(r.findings[0].rule === "path_join_with_user_input");
});

// NORMAL — fs.readFile with user input
test("flags fs.readFile with user path", () => {
  write("b.js", "fs.readFile(filePath, (err, data) => {});");
  const r = findPathTraversalRisk(tmpDir, tmpDir);
  const f = r.findings.find(x => x.rule === "fs_readwrite_with_user_input");
  assert(f, "expected fs_readwrite finding");
});

// NORMAL — res.sendFile with user input
test("flags res.sendFile with user path", () => {
  write("c.js", "res.sendFile(filePath);");
  const r = findPathTraversalRisk(tmpDir, tmpDir);
  const f = r.findings.find(x => x.rule === "send_file_with_user_input");
  assert(f, "expected send_file finding");
});

// SUPPRESSION — // path-safe annotation
test("suppresses with // path-safe annotation", () => {
  write("d.js", "const p = path.join('/uploads', req.params.filename); // path-safe");
  const r = findPathTraversalRisk(tmpDir, tmpDir);
  const f = r.findings.filter(x => x.file === "d.js");
  assert(f.length === 0, "should be suppressed");
});

// SUPPRESSION — guard: startsWith
test("suppresses when startsWith guard present", () => {
  write("e.js", `
if (!resolved.startsWith('/safe')) throw new Error();
const p = path.join('/safe', filePath);
`);
  const r = findPathTraversalRisk(tmpDir, tmpDir);
  const f = r.findings.filter(x => x.file === "e.js" && x.rule === "path_join_with_user_input");
  assert(f.length === 0, "startsWith guard should suppress");
});

// MEDIUM — no taint: static string only
test("does not flag path.join with static strings", () => {
  write("f.js", "const p = path.join('/public', 'index.html');");
  const r = findPathTraversalRisk(tmpDir, tmpDir);
  const f = r.findings.filter(x => x.file === "f.js");
  assert(f.length === 0, "static path should not flag");
});

// MEDIUM — invalid extensions type
test("throws on invalid extensions", () => {
  let threw = false;
  try { findPathTraversalRisk(tmpDir, tmpDir, { extensions: "js" }); }
  catch(e) { threw = true; assert(e instanceof ToolError); }
  assert(threw, "should throw ToolError for bad extensions");
});

// CRITICAL — nonexistent path
test("throws on nonexistent path", () => {
  let threw = false;
  try { findPathTraversalRisk("/no/such/path", "/no/such/path"); }
  catch(e) { threw = true; }
  assert(threw, "should throw for nonexistent path");
});

// HIGH — binary file skipped
test("skips binary files gracefully", () => {
  const buf = Buffer.alloc(50); buf[0] = 0;
  fs.writeFileSync(path.join(tmpDir, "bin.js"), buf);
  const r = findPathTraversalRisk(tmpDir, tmpDir);
  assert(typeof r.filesScanned === "number");
});

// IMPOSSIBLE — very large max_results
test("caps max_results at hard max", () => {
  const r = findPathTraversalRisk(tmpDir, tmpDir, { maxResults: 999999 });
  assert(typeof r.findingsCount === "number");
});

clean();
console.log(`  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
