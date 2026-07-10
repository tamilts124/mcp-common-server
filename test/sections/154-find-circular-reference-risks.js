"use strict";
/**
 * [154] find_circular_reference_risks — all 5 rigor levels
 * Tests findCircularReferenceRisks (lib/circularReferenceOps.js).
 * Does NOT start the MCP server — imports the function directly.
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findCircularReferenceRisks } = require("../../lib/circularReferenceOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crr-test-"));

function write(name, content) {
  const fp = path.join(DIR, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

function check(label, cond, extra) {
  if (cond) { console.log(`  \u2713 ${label}`); passed++; }
  else { console.error(`  \u2717 FAIL: ${label}${extra ? " | " + extra : ""}`); failed++; }
}

console.log("\n[154] find_circular_reference_risks");
console.log("  -- Level 1: Normal (Happy Path) --");

// [154-A] Self-reference: obj.parent = obj
const f1 = write("self-ref.js", [
  "const node = { value: 1 };",
  "node.parent = node;",
].join("\n"));
const r1 = findCircularReferenceRisks(f1, "self-ref.js");
check("[154-A1] self_reference_assignment detected",
  r1.findingsCount >= 1 && r1.findings.some(f => f.rule === "self_reference_assignment"));
check("[154-A2] variable=node", r1.findings[0].variable === "node");
check("[154-A3] severity=error", r1.findings[0].severity === "error");
check("[154-A4] message mentions JSON.stringify", r1.findings[0].message.includes("JSON.stringify"));

// [154-B] Clean file — 0 findings
const f2 = write("clean.js", [
  "const a = { x: 1 };",
  "const b = { y: a };",
].join("\n"));
const r2 = findCircularReferenceRisks(f2, "clean.js");
check("[154-B1] clean file = 0 findings", r2.findingsCount === 0);

// [154-C] Mutual module-scope reference
const f3 = write("mutual.js", [
  "const serviceA = {};",
  "const serviceB = {};",
  "serviceA.dep = serviceB;",
  "serviceB.dep = serviceA;",
  "module.exports = { serviceA, serviceB };",
].join("\n"));
const r3 = findCircularReferenceRisks(f3, "mutual.js");
check("[154-C1] mutual_module_scope_reference detected",
  r3.findings.some(f => f.rule === "mutual_module_scope_reference"));
check("[154-C2] mutual finding has variables array",
  r3.findings.filter(f => f.rule === "mutual_module_scope_reference")
    .every(f => Array.isArray(f.variables)));

// [154-D] Bracket notation self-reference
const f4 = write("bracket.js", [
  "const tree = {};",
  'tree["root"] = tree;',
].join("\n"));
const r4 = findCircularReferenceRisks(f4, "bracket.js");
check("[154-D1] bracket self-reference detected",
  r4.findings.some(f => f.rule === "self_reference_assignment"));

// Result shape
check("[154-E1] result has expected shape",
  typeof r1.path === "string" && typeof r1.filesScanned === "number" &&
  Array.isArray(r1.findings) && typeof r1.truncated === "boolean");

console.log("  -- Level 2: Boundary & Param Validation --");

// max_results clamping
const fMulti = write("multi-circ.js", [
  "const a = {}; a.self = a;",
  "const b = {}; b.self = b;",
  "const c = {}; c.self = c;",
].join("\n"));
const rCap = findCircularReferenceRisks(fMulti, "multi-circ.js", { maxResults: 2 });
check("[154-F1] max_results caps findings", rCap.findings.length <= 2);

// invalid max_results
try {
  findCircularReferenceRisks(fMulti, "x.js", { maxResults: "bad" });
  check("[154-F2] invalid max_results should throw", false);
} catch (e) { check("[154-F2] throws -32602 for bad max_results", e.code === -32602); }

// invalid extensions
try {
  findCircularReferenceRisks(fMulti, "x.js", { extensions: 123 });
  check("[154-F3] invalid extensions should throw", false);
} catch (e) { check("[154-F3] throws -32602 for bad extensions", e.code === -32602); }

// non-existent path
try {
  findCircularReferenceRisks("/no/such/file.js", "/no/such/file.js");
  check("[154-F4] non-existent should throw", false);
} catch (e) { check("[154-F4] non-existent throws -32602", e.code === -32602); }

// empty file
const ef = write("empty.js", "");
const er = findCircularReferenceRisks(ef, "empty.js");
check("[154-F5] empty file = 0 findings", er.findingsCount === 0);

console.log("  -- Level 3: Mock Dependency Failures --");

// Directory with mix of files
const sub = path.join(DIR, "mixed");
fs.mkdirSync(sub, { recursive: true });
fs.writeFileSync(path.join(sub, "a.js"), "const x = {}; x.self = x;");
fs.writeFileSync(path.join(sub, "b.js"), "// clean file");
const rDir = findCircularReferenceRisks(sub, "mixed");
check("[154-G1] directory scan filesScanned=2", rDir.filesScanned === 2);
check("[154-G2] finds circular ref in subdirectory", rDir.findingsCount >= 1);

// Binary file skipped
const binDir = path.join(DIR, "bindir2");
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, "bin.js"), Buffer.alloc(50, 0));
const rBin = findCircularReferenceRisks(binDir, "bindir2");
check("[154-G3] binary file skipped", rBin.findingsCount === 0);

// Non-self cross-assignment should NOT flag self_reference
const fCross = write("non-self.js", [
  "const node = {};",
  "const other = {};",
  "node.ref = other;",
].join("\n"));
const rCross = findCircularReferenceRisks(fCross, "non-self.js");
check("[154-G4] non-self assignment not flagged as self_reference",
  !rCross.findings.some(f => f.rule === "self_reference_assignment"));

console.log("  -- Level 4: Critical / Security --");

// Path traversal
try {
  findCircularReferenceRisks("../../../etc/passwd", "../../../etc/passwd");
  check("[154-H1] path traversal: no crash", true);
} catch (e) { check("[154-H1] path traversal: error caught cleanly", !!e.message); }

// Very long identifier name
const longId = "a".repeat(200);
const longF = write("longid.js", `const ${longId} = {};\n${longId}.self = ${longId};`);
const rLong = findCircularReferenceRisks(longF, "longid.js");
check("[154-H2] very long identifier handled", typeof rLong.findingsCount === "number");

// SQL injection content — should not crash
const sqlF = write("sql.js", [
  "const q = \"SELECT * FROM users WHERE id = '1' OR '1'='1'\";",
  "const obj = {};",
  "obj.safe = 42;",
].join("\n"));
const rSql = findCircularReferenceRisks(sqlF, "sql.js");
check("[154-H3] SQL injection string in code: no crash", typeof rSql.findingsCount === "number");

// 'this' keyword excluded from self_reference
const thisF = write("this-ok.js", [
  "class Foo {",
  "  init() { this.instance = this; }",
  "}",
].join("\n"));
const rThis = findCircularReferenceRisks(thisF, "this-ok.js");
check("[154-H4] this.x = this not flagged as self_reference",
  !rThis.findings.some(f => f.variable === "this" && f.rule === "self_reference_assignment"));

console.log("  -- Level 5: Extreme / Stress --");

// 200 self-references
const stressLines = [];
for (let i = 0; i < 200; i++) {
  stressLines.push(`const obj${i} = {};`);
  stressLines.push(`obj${i}.self = obj${i};`);
}
const bigF = write("big-self.js", stressLines.join("\n"));
const t0 = Date.now();
const rBig = findCircularReferenceRisks(bigF, "big-self.js");
check("[154-I1] large file scanned in <3s", Date.now() - t0 < 3000);
check("[154-I2] 200 self-references found", rBig.findingsCount === 200);

// Custom extensions
const extDir = path.join(DIR, "extdir");
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, "a.ts"), "const x = {}; x.self = x;");
fs.writeFileSync(path.join(extDir, "b.js"), "const y = {}; y.self = y;");
const rExt = findCircularReferenceRisks(extDir, "extdir", { extensions: [".ts"] });
check("[154-I3] custom extensions: only .ts scanned", rExt.filesScanned === 1);
check("[154-I4] custom extensions: 1 finding", rExt.findingsCount === 1);

// All findings have required fields
const rAll = findCircularReferenceRisks(f1, "self-ref.js");
check("[154-I5] all findings have required fields",
  rAll.findings.every(f => f.file && f.line !== undefined && f.rule && f.severity && f.message));

// Sorted by file then line
const rSorted = findCircularReferenceRisks(extDir, "extdir");
check("[154-I6] findings sorted by file",
  rSorted.findings.every((f, i, a) =>
    i === 0 || a[i-1].file <= f.file));

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[154] find_circular_reference_risks: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
module.exports = { passed, failed };
