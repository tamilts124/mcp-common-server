"use strict";
/**
 * [149] find_missing_error_context — all 5 rigor levels
 *
 * Tests findMissingErrorContext (lib/missingErrorContextOps.js).
 * Does NOT start the MCP server — imports the function directly.
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findMissingErrorContext } = require("../../lib/missingErrorContextOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "error-ctx-test-"));

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

console.log("\n[149] find_missing_error_context");
console.log("  -- Level 1: Normal --");

// [149-A] Normal: detect both rules
const jsNormal = [
  "async function fetchData() {",
  "  try {",
  "    return await db.query();",
  "  } catch (err) {",
  "    throw new Error('DB query failed');",  // rethrow_without_cause
  "  }",
  "}",
  "function process() {",
  "  try {",
  "    doWork();",
  "  } catch (e) {",
  "    throw e;",  // bare_rethrow
  "  }",
  "}",
].join("\n");
const fileA = write("normal.js", jsNormal);
const rA = findMissingErrorContext(fileA, "normal.js");
check("[149-A1] filesScanned=1", rA.filesScanned === 1);
check("[149-A2] 1 error (rethrow_without_cause)", rA.errorCount === 1);
check("[149-A3] 1 warning (bare_rethrow)", rA.warningCount === 1);
check("[149-A4] total findings=2", rA.findingsCount === 2);
check("[149-A5] rethrow_without_cause found",
  rA.findings.some(f => f.rule === "rethrow_without_cause"));
check("[149-A6] bare_rethrow found",
  rA.findings.some(f => f.rule === "bare_rethrow"));
check("[149-A7] catchVar captured",
  rA.findings.find(f => f.rule === "rethrow_without_cause").catchVar === "err");
check("[149-A8] bare_rethrow catchVar matches",
  rA.findings.find(f => f.rule === "bare_rethrow").catchVar === "e");
check("[149-A9] not truncated", rA.truncated === false);

console.log("  -- Level 2: Boundary --");

// [149-B] Boundary
const fileEmpty = write("empty.js", "");
const rEmpty = findMissingErrorContext(fileEmpty, "empty.js");
check("[149-B1] empty file → 0 findings", rEmpty.findingsCount === 0);

// Good pattern: throw new Error with { cause }
const jsGood = [
  "try {",
  "  doSomething();",
  "} catch (err) {",
  "  throw new Error('failed', { cause: err });",
  "}",
].join("\n");
const fileGood = write("good.js", jsGood);
const rGood = findMissingErrorContext(fileGood, "good.js");
check("[149-B2] throw new Error with cause → 0 findings", rGood.findingsCount === 0);

// No catch blocks → 0 findings
const jsNoCatch = "function safe() { return 1 + 1; }\n";
const fileNoCatch = write("no-catch.js", jsNoCatch);
const rNoCatch = findMissingErrorContext(fileNoCatch, "no-catch.js");
check("[149-B3] no catch blocks → 0 findings", rNoCatch.findingsCount === 0);

const rDir = findMissingErrorContext(DIR, ".");
check("[149-B4] directory scan finds ≥1 file", rDir.filesScanned >= 1);

try {
  findMissingErrorContext(fileA, "x", { maxResults: 0 });
  check("[149-B5] max_results=0 should throw", false);
} catch (e) { check("[149-B5] max_results=0 throws -32602", e.code === -32602); }

try {
  findMissingErrorContext("/nonexistent", "bad");
  check("[149-B6] nonexistent path throws", false);
} catch (e) { check("[149-B6] nonexistent path throws -32602", e.code === -32602); }

console.log("  -- Level 3: Mock failures --");

// [149-C] High: custom error class
const jsCustomErr = [
  "try {",
  "  db.connect();",
  "} catch (err) {",
  "  throw new DatabaseError('Connection failed');",  // no cause
  "}",
].join("\n");
const fileCustom = write("custom-err.js", jsCustomErr);
const rCustom = findMissingErrorContext(fileCustom, "custom-err.js");
check("[149-C1] custom error class rethrow detected",
  rCustom.findings.some(f => f.rule === "rethrow_without_cause" && f.constructorName === "DatabaseError"));

// Unreadable file
const jsUnread = write("cant-read.js", "try {} catch(err) { throw new Error('x'); }");
fs.chmodSync(jsUnread, 0o000);
try {
  const rUnread = findMissingErrorContext(jsUnread, "cant-read.js");
  check("[149-C2] unreadable file skipped gracefully", rUnread.findingsCount <= 1);
} finally {
  fs.chmodSync(jsUnread, 0o644);
}

// Extension filter works
const rTs = findMissingErrorContext(DIR, ".", { extensions: [".ts"] });
check("[149-C3] .ts-only scan: 0 .js files found", rTs.filesScanned === 0 || rTs.findingsCount === 0);

console.log("  -- Level 4: Security --");

// [149-D] Critical: injection-like inputs don't crash scanner
const jsMalicious = [
  "try {",
  "  eval(userInput);",
  "} catch (err) {",
  "  throw new Error(`../../../etc/passwd: ${err.message}`);",
  "}",
].join("\n");
const fileMalicious = write("malicious.js", jsMalicious);
const rMalicious = findMissingErrorContext(fileMalicious, "malicious.js");
check("[149-D1] path traversal in msg doesn't crash", typeof rMalicious.findingsCount === "number");
check("[149-D2] rethrow_without_cause found in malicious file",
  rMalicious.findingsCount >= 1);

// max_results cap
const manyBlocks = Array.from({ length: 50 }, (_, i) =>
  `try { doWork${i}(); } catch(err) { throw new Error('fail'); }`
).join("\n");
const fileMany = write("many.js", manyBlocks);
const rCapped = findMissingErrorContext(fileMany, "many.js", { maxResults: 5 });
check("[149-D3] max_results=5 caps at 5", rCapped.findingsCount === 5);
check("[149-D4] truncated=true when capped", rCapped.truncated === true);

check("[149-D5] all findings have required fields",
  rA.findings.every(f => f.file && f.line && f.catchVar && f.rule && f.severity && f.message));

console.log("  -- Level 5: Stress --");

// [149-E] Extreme: large file
const bigJs = Array.from({ length: 200 }, (_, i) => [
  `function fn${i}() {`,
  `  try { doWork${i}(); }`,
  `  catch (err) {`,
  i % 2 === 0
    ? `    throw new Error('fail ${i}');`   // error
    : `    throw err;`,                      // warning
  `  }`,
  `}`,
].join("\n")).join("\n");
const fileBig = write("big.js", bigJs);
const rBig = findMissingErrorContext(fileBig, "big.js");
check("[149-E1] large file: structured result", typeof rBig.findingsCount === "number");
check("[149-E2] large file: many findings", rBig.findingsCount >= 100);
check("[149-E3] findings sorted by line asc",
  rBig.findings.every((f, i, a) => i === 0 || a[i-1].line <= f.line));

// Multiple extensions scan
write("test.ts",  "try { x(); } catch(e) { throw new Error('fail'); }");
const rMulti = findMissingErrorContext(DIR, ".", { extensions: [".js", ".ts"] });
check("[149-E4] multi-extension scan works", rMulti.filesScanned >= 2);
check("[149-E5] both .js and .ts findings found", rMulti.findingsCount >= 2);

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[149] find_missing_error_context: ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
