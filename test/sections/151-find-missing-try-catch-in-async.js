"use strict";
/**
 * [151] find_missing_try_catch_in_async — all 5 rigor levels
 *
 * Tests findMissingTryCatchInAsync (lib/missingTryCatchAsyncOps.js).
 * Does NOT start the MCP server — imports the function directly.
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findMissingTryCatchInAsync } = require("../../lib/missingTryCatchAsyncOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "try-catch-async-test-"));

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

console.log("\n[151] find_missing_try_catch_in_async");
console.log("  -- Level 1: Normal --");

// [151-A] Detect async function with await and no try/catch
const jsNoCatch = [
  "async function fetchUser(id) {",
  "  const user = await db.find(id);",
  "  return user;",
  "}",
].join("\n");
const fileA = write("no-catch.js", jsNoCatch);
const rA = findMissingTryCatchInAsync(fileA, "no-catch.js");
check("[151-A1] filesScanned=1", rA.filesScanned === 1);
check("[151-A2] 1 finding (async without try/catch)", rA.findingsCount === 1);
check("[151-A3] rule=async_await_no_try_catch", rA.findings[0].rule === "async_await_no_try_catch");
check("[151-A4] severity=error", rA.findings[0].severity === "error");
check("[151-A5] finding has message field", typeof rA.findings[0].message === "string");
check("[151-A6] not truncated", rA.truncated === false);
check("[151-A7] message mentions Node.js 15", rA.findings[0].message.includes("Node.js 15"));

// Safe: async function WITH try/catch
const jsWithCatch = [
  "async function fetchUser(id) {",
  "  try {",
  "    const user = await db.find(id);",
  "    return user;",
  "  } catch (err) {",
  "    throw new Error('DB error', { cause: err });",
  "  }",
  "}",
].join("\n");
const fileWithCatch = write("with-catch.js", jsWithCatch);
const rSafe = findMissingTryCatchInAsync(fileWithCatch, "with-catch.js");
check("[151-A8] async with try/catch -> 0 findings", rSafe.findingsCount === 0);

// Async function without await -> no finding
const jsNoAwait = [
  "async function compute() {",
  "  return 42;",
  "}",
].join("\n");
const fileNoAwait = write("no-await.js", jsNoAwait);
const rNoAwait = findMissingTryCatchInAsync(fileNoAwait, "no-await.js");
check("[151-A9] async without await -> 0 findings", rNoAwait.findingsCount === 0);

console.log("  -- Level 2: Boundary --");

// Empty file
const fileEmpty = write("empty.js", "");
const rEmpty = findMissingTryCatchInAsync(fileEmpty, "empty.js");
check("[151-B1] empty file -> 0 findings", rEmpty.findingsCount === 0);

// Non-async function with await (syntactically invalid but scanned)
const jsNonAsync = "function notAsync() { const x = 1; return x; }";
const fileNonAsync = write("non-async.js", jsNonAsync);
const rNonAsync = findMissingTryCatchInAsync(fileNonAsync, "non-async.js");
check("[151-B2] non-async function -> 0 findings", rNonAsync.findingsCount === 0);

// Directory scan
const rDir = findMissingTryCatchInAsync(DIR, ".");
check("[151-B3] directory scan runs", rDir.filesScanned >= 2);
check("[151-B4] directory has findings", rDir.findingsCount >= 1);

// Wrong extension
const rExt = findMissingTryCatchInAsync(DIR, ".", { extensions: [".py"] });
check("[151-B5] wrong extension -> 0 files", rExt.filesScanned === 0);

try {
  findMissingTryCatchInAsync(fileA, "x", { maxResults: 0 });
  check("[151-B6] max_results=0 should throw", false);
} catch (e) { check("[151-B6] max_results=0 throws -32602", e.code === -32602); }

try {
  findMissingTryCatchInAsync("/nonexistent/path", "bad");
  check("[151-B7] nonexistent path should throw", false);
} catch (e) { check("[151-B7] nonexistent path throws -32602", e.code === -32602); }

console.log("  -- Level 3: Mock failures --");

// Multiple async functions in one file
const jsMulti = [
  "async function fetchA() { const a = await getA(); return a; }",
  "async function fetchB() { try { const b = await getB(); return b; } catch(e){} }",
  "async function fetchC() { const c = await getC(); return c; }",
].join("\n");
const fileMulti = write("multi.js", jsMulti);
const rMulti = findMissingTryCatchInAsync(fileMulti, "multi.js");
check("[151-C1] 2 out of 3 async fns without try/catch", rMulti.findingsCount === 2);
check("[151-C2] findings include fetchA and fetchC",
  rMulti.findings.some(f => f.name === "fetchA") && rMulti.findings.some(f => f.name === "fetchC"));

// Unreadable file
const fileUnread = write("cant-read.js", "async function x() { await y(); }");
fs.chmodSync(fileUnread, 0o000);
try {
  const rUnread = findMissingTryCatchInAsync(fileUnread, "cant-read.js");
  check("[151-C3] unreadable file gracefully handled", typeof rUnread.findingsCount === "number");
} finally {
  fs.chmodSync(fileUnread, 0o644);
}

// Arrow async function
const jsArrow = [
  "const fetchData = async (url) => {",
  "  const res = await fetch(url);",
  "  return res.json();",
  "};",
].join("\n");
const fileArrow = write("arrow.js", jsArrow);
const rArrow = findMissingTryCatchInAsync(fileArrow, "arrow.js");
check("[151-C4] async arrow without try/catch flagged", rArrow.findingsCount >= 1);

console.log("  -- Level 4: Security --");

// Path traversal attempt
try {
  findMissingTryCatchInAsync("../../../etc/passwd", "../../../etc/passwd");
  check("[151-D1] path traversal doesn't crash", true);
} catch (e) {
  check("[151-D1] path traversal throws structured error", e.code === -32602);
}

// max_results capping
const manyAsync = Array.from({ length: 40 },
  (_, i) => `async function f${i}() { await op${i}(); }`).join("\n");
const fileManyAsync = write("many-async.js", manyAsync);
const rCapped = findMissingTryCatchInAsync(fileManyAsync, "many-async.js", { maxResults: 10 });
check("[151-D2] max_results=10 caps findings at 10", rCapped.findingsCount === 10);
check("[151-D3] truncated=true when capped", rCapped.truncated === true);

check("[151-D4] all findings have required fields",
  rA.findings.every(f => f.file && f.line && f.rule && f.severity && f.message));

// Malicious content — should not crash
const jsMalicious = "async function evil() { await require('../../../etc/shadow'); }";
const fileMalicious = write("malicious.js", jsMalicious);
const rMalicious = findMissingTryCatchInAsync(fileMalicious, "malicious.js");
check("[151-D5] malicious content scanned safely", typeof rMalicious.findingsCount === "number");

console.log("  -- Level 5: Stress --");

// Large file with many async functions
const bigLines = Array.from({ length: 200 }, (_, i) =>
  i % 2 === 0
    ? `async function f${i}() { const r = await op${i}(); return r; }`
    : `async function g${i}() { try { await op${i}(); } catch(e) { throw new Error('x', {cause:e}); } }`
).join("\n");
const fileBig = write("big.js", bigLines);
const rBig = findMissingTryCatchInAsync(fileBig, "big.js");
check("[151-E1] large file: structured result", typeof rBig.findingsCount === "number");
check("[151-E2] large file: findings match uncaught count", rBig.findingsCount === 100);
check("[151-E3] findings sorted by line ascending",
  rBig.findings.every((f, i, a) => i === 0 || a[i-1].line <= f.line));

// Multi-extension scan
write("test.ts", "async function fetchTS() { await something(); }");
write("test.mjs", "async function fetchMJS() { await something(); }");
const rMultiExt = findMissingTryCatchInAsync(DIR, ".", { extensions: [".ts", ".mjs"] });
check("[151-E4] multi-extension scan works", rMultiExt.filesScanned >= 2);
check("[151-E5] multi-extension finds findings", rMultiExt.findingsCount >= 1);

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[151] find_missing_try_catch_in_async: ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
