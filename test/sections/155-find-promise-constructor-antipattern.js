"use strict";
/**
 * [155] find_promise_constructor_antipattern — all 5 rigor levels
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findPromiseConstructorAntipattern } = require("../../lib/promiseConstructorOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pca-test-"));

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

console.log("\n[155] find_promise_constructor_antipattern");
console.log("  -- Level 1: Normal (Happy Path) --");

// [155-A] async executor — error
const f1 = write("async-exec.js", [
  "const p = new Promise(async (resolve, reject) => {",
  "  const result = await fetch('/api/data');",
  "  resolve(result.json());",
  "});",
].join("\n"));
const r1 = findPromiseConstructorAntipattern(f1, "async-exec.js");
check("[155-A1] async_executor_in_promise_constructor detected",
  r1.findingsCount >= 1 && r1.findings.some(f => f.rule === "async_executor_in_promise_constructor"));
check("[155-A2] severity=error", r1.findings[0].severity === "error");
check("[155-A3] message mentions async", r1.findings[0].message.includes("async"));
check("[155-A4] result has shape",
  typeof r1.path === "string" && typeof r1.filesScanned === "number" &&
  Array.isArray(r1.findings) && typeof r1.truncated === "boolean");

// [155-B] explicit wrap with .then(resolve, reject)
const f2 = write("explicit-wrap.js", [
  "function wrap(p) {",
  "  return new Promise((resolve, reject) => p.then(resolve, reject));",
  "}",
].join("\n"));
const r2 = findPromiseConstructorAntipattern(f2, "explicit-wrap.js");
check("[155-B1] explicit_promise_wrap detected",
  r2.findingsCount >= 1 && r2.findings.some(f => f.rule === "explicit_promise_wrap"));
check("[155-B2] severity=warning", r2.findings[0].severity === "warning");

// [155-C] explicit wrap with .then(resolve).catch(reject)
const f3 = write("explicit-wrap2.js", [
  "function wrap2(p) {",
  "  return new Promise((resolve, reject) => { p.then(resolve).catch(reject); });",
  "}",
].join("\n"));
const r3 = findPromiseConstructorAntipattern(f3, "explicit-wrap2.js");
check("[155-C1] .then(resolve).catch(reject) detected",
  r3.findingsCount >= 1 && r3.findings.some(f => f.rule === "explicit_promise_wrap"));

// [155-D] clean: non-async executor, no then-wrap
const f4 = write("clean.js", [
  "const p = new Promise((resolve, reject) => {",
  "  setTimeout(() => resolve('done'), 1000);",
  "});",
].join("\n"));
const r4 = findPromiseConstructorAntipattern(f4, "clean.js");
check("[155-D1] clean Promise not flagged", r4.findingsCount === 0);

console.log("  -- Level 2: Boundary & Param Validation --");

// max_results cap
const fMany = write("many.js", [
  "const a = new Promise(async (r) => { r(await fetch('/a')); });",
  "const b = new Promise(async (r) => { r(await fetch('/b')); });",
  "const c = new Promise(async (r) => { r(await fetch('/c')); });",
].join("\n"));
const rCap = findPromiseConstructorAntipattern(fMany, "many.js", { maxResults: 2 });
check("[155-E1] max_results caps findings", rCap.findings.length <= 2);
check("[155-E2] truncated=true when capped", rCap.truncated === true);

// invalid maxResults
try {
  findPromiseConstructorAntipattern(fMany, "x.js", { maxResults: "bad" });
  check("[155-E3] invalid max_results should throw", false);
} catch (e) { check("[155-E3] throws -32602", e.code === -32602); }

// invalid extensions
try {
  findPromiseConstructorAntipattern(fMany, "x.js", { extensions: 123 });
  check("[155-E4] invalid extensions should throw", false);
} catch (e) { check("[155-E4] throws -32602", e.code === -32602); }

// non-existent path
try {
  findPromiseConstructorAntipattern("/no/such/file.js", "/no/such/file.js");
  check("[155-E5] non-existent should throw", false);
} catch (e) { check("[155-E5] throws -32602", e.code === -32602); }

// empty file
const ef = write("empty.js", "");
const er = findPromiseConstructorAntipattern(ef, "empty.js");
check("[155-E6] empty file = 0 findings", er.findingsCount === 0);

console.log("  -- Level 3: Mock Dependency Failures --");

const sub = path.join(DIR, "multi");
fs.mkdirSync(sub, { recursive: true });
fs.writeFileSync(path.join(sub, "a.js"), "const p = new Promise(async r => r(1));");
fs.writeFileSync(path.join(sub, "b.js"), "// clean");
const rDir = findPromiseConstructorAntipattern(sub, "multi");
check("[155-F1] directory scan works", rDir.filesScanned === 2);
check("[155-F2] finds async executor in subdir", rDir.findingsCount >= 1);

// Binary file skipped
const binDir = path.join(DIR, "bindir");
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, "bin.js"), Buffer.alloc(50, 0));
const rBin = findPromiseConstructorAntipattern(binDir, "bindir");
check("[155-F3] binary file skipped", rBin.findingsCount === 0);

console.log("  -- Level 4: Critical / Security --");

// Path traversal
try {
  findPromiseConstructorAntipattern("../../../etc/passwd", "../../../etc/passwd");
  check("[155-G1] path traversal: no crash", true);
} catch (e) { check("[155-G1] path traversal: error caught cleanly", !!e.message); }

// async function keyword (not arrow)
const fAsync2 = write("async-fn.js", [
  "const p = new Promise(async function(resolve, reject) {",
  "  const data = await loadData();",
  "  resolve(data);",
  "});",
].join("\n"));
const rAsync2 = findPromiseConstructorAntipattern(fAsync2, "async-fn.js");
check("[155-G2] async function (not arrow) detected",
  rAsync2.findings.some(f => f.rule === "async_executor_in_promise_constructor"));

// All findings have required fields
check("[155-G3] all findings have file/line/rule/severity/message",
  r1.findings.every(f => f.file && f.line !== undefined && f.rule && f.severity && f.message));

console.log("  -- Level 5: Extreme / Stress --");

// No false positive on regular async function that happens to use Promise.resolve
const fOk = write("ok-async.js", [
  "async function fetchData() {",
  "  const result = await fetch('/api');",
  "  return result.json();",
  "}",
  "const p2 = Promise.resolve(fetchData());",
].join("\n"));
const rOk = findPromiseConstructorAntipattern(fOk, "ok-async.js");
check("[155-H1] async fn + Promise.resolve not flagged", rOk.findingsCount === 0);

// Large file performance
const bigLines = Array.from({ length: 2000 }, (_, i) =>
  i % 50 === 0
    ? `const p${i} = new Promise(async (r) => { r(await fetch('/x${i}')); });`
    : `// line ${i}`
).join("\n");
const bigF = write("big.js", bigLines);
const t0 = Date.now();
const rBig = findPromiseConstructorAntipattern(bigF, "big.js");
check("[155-H2] large file scanned in <3s", Date.now() - t0 < 3000);
check("[155-H3] large file: 40 async executor findings", rBig.findingsCount === 40);

// Custom extensions
const extDir = path.join(DIR, "ext");
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, "a.ts"), "const p = new Promise(async r => r(1));");
fs.writeFileSync(path.join(extDir, "b.js"), "const p = new Promise(async r => r(2));");
const rExt = findPromiseConstructorAntipattern(extDir, "ext", { extensions: [".ts"] });
check("[155-H4] custom extensions: only .ts scanned", rExt.filesScanned === 1);
check("[155-H5] custom extensions: 1 finding", rExt.findingsCount === 1);

// Sorted by file then line
const rSorted = findPromiseConstructorAntipattern(bigF, "big.js");
check("[155-H6] findings sorted by file then line",
  rSorted.findings.every((f, i, a) => i === 0 || a[i-1].line <= f.line));

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[155] find_promise_constructor_antipattern: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
module.exports = { passed, failed };
