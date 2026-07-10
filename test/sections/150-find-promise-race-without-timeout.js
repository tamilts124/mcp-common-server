"use strict";
/**
 * [150] find_promise_race_without_timeout — all 5 rigor levels
 *
 * Tests findPromiseRaceWithoutTimeout (lib/promiseRaceTimeoutOps.js).
 * Does NOT start the MCP server — imports the function directly.
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findPromiseRaceWithoutTimeout } = require("../../lib/promiseRaceTimeoutOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "promise-race-test-"));

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

console.log("\n[150] find_promise_race_without_timeout");
console.log("  -- Level 1: Normal --");

// [150-A] Normal: detect race without timeout
const jsNoTimeout = [
  "async function fetchData() {",
  "  return Promise.race([",
  "    fetch('https://api.example.com/data'),",
  "    fetch('https://api.backup.com/data'),",
  "  ]);",
  "}",
].join("\n");
const fileA = write("no-timeout.js", jsNoTimeout);
const rA = findPromiseRaceWithoutTimeout(fileA, "no-timeout.js");
check("[150-A1] filesScanned=1", rA.filesScanned === 1);
check("[150-A2] 1 error (race without timeout)", rA.errorCount === 1);
check("[150-A3] rule=promise_race_no_timeout", rA.findings[0].rule === "promise_race_no_timeout");
check("[150-A4] severity=error", rA.findings[0].severity === "error");
check("[150-A5] not truncated", rA.truncated === false);
check("[150-A6] finding has message field", typeof rA.findings[0].message === "string");

// Safe pattern: race WITH setTimeout timeout
const jsWithTimeout = [
  "async function fetchWithTimeout() {",
  "  return Promise.race([",
  "    fetch('https://api.example.com/data'),",
  "    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),",
  "  ]);",
  "}",
].join("\n");
const fileWithTimeout = write("with-timeout.js", jsWithTimeout);
const rSafe = findPromiseRaceWithoutTimeout(fileWithTimeout, "with-timeout.js");
check("[150-A7] race with setTimeout \u2192 0 findings", rSafe.findingsCount === 0);

// AbortSignal.timeout pattern
const jsAbort = "Promise.race([fetch(url), AbortSignal.timeout(5000)]);"; 
const fileAbort = write("abort-timeout.js", jsAbort);
const rAbort = findPromiseRaceWithoutTimeout(fileAbort, "abort-timeout.js");
check("[150-A8] AbortSignal.timeout suppresses finding", rAbort.findingsCount === 0);

// withTimeout helper naming
const jsHelper = "Promise.race([op(), withTimeout(5000)]);"; 
const fileHelper = write("helper-timeout.js", jsHelper);
const rHelper = findPromiseRaceWithoutTimeout(fileHelper, "with-helper.js");
check("[150-A9] withTimeout() helper suppresses finding", rHelper.findingsCount === 0);

console.log("  -- Level 2: Boundary --");

const fileEmpty = write("empty.js", "");
const rEmpty = findPromiseRaceWithoutTimeout(fileEmpty, "empty.js");
check("[150-B1] empty file \u2192 0 findings", rEmpty.findingsCount === 0);

const jsSafe2 = "const result = await Promise.all([a(), b()]);"; 
const fileSafe2 = write("safe.js", jsSafe2);
const rSafe2 = findPromiseRaceWithoutTimeout(fileSafe2, "safe.js");
check("[150-B2] Promise.all (not race) \u2192 0 findings", rSafe2.findingsCount === 0);

const rDir = findPromiseRaceWithoutTimeout(DIR, ".");
check("[150-B3] directory scan finds files", rDir.filesScanned >= 2);
check("[150-B4] directory scan finds findings", rDir.findingsCount >= 1);

const rExt = findPromiseRaceWithoutTimeout(DIR, ".", { extensions: [".ts"] });
check("[150-B5] wrong extension \u2192 0 files", rExt.filesScanned === 0);

try {
  findPromiseRaceWithoutTimeout(fileA, "x", { maxResults: 0 });
  check("[150-B6] max_results=0 should throw", false);
} catch (e) { check("[150-B6] max_results=0 throws -32602", e.code === -32602); }

try {
  findPromiseRaceWithoutTimeout("/nonexistent/path", "bad");
  check("[150-B7] nonexistent path should throw", false);
} catch (e) { check("[150-B7] nonexistent path throws -32602", e.code === -32602); }

console.log("  -- Level 3: Mock failures --");

// Single item array
const jsSingle = "const result = Promise.race([singleOperation()]);"; 
const fileSingle = write("single-item.js", jsSingle);
const rSingle = findPromiseRaceWithoutTimeout(fileSingle, "single-item.js");
check("[150-C1] single-item race flagged", rSingle.findingsCount >= 1);
check("[150-C2] has promise_race_single_item or no_timeout rule",
  rSingle.findings.some(f => f.rule === "promise_race_single_item" || f.rule === "promise_race_no_timeout"));

// Unreadable file
const jsUnread = write("cant-read.js", "Promise.race([a()]);");
fs.chmodSync(jsUnread, 0o000);
try {
  const rUnread = findPromiseRaceWithoutTimeout(jsUnread, "cant-read.js");
  check("[150-C3] unreadable file skipped gracefully (no crash)", typeof rUnread.findingsCount === "number");
} finally {
  fs.chmodSync(jsUnread, 0o644);
}

// deadline helper
const jsDeadline = "Promise.race([op(), deadline(3000)]);"; 
const fileDeadline = write("deadline.js", jsDeadline);
const rDeadline = findPromiseRaceWithoutTimeout(fileDeadline, "deadline.js");
check("[150-C4] deadline() helper suppresses finding", rDeadline.findingsCount === 0);

// AbortController pattern  
const jsAbortCtrl = "const ctrl = new AbortController(); Promise.race([fetch(url, { signal: ctrl.signal })]);"; 
const fileAbortCtrl = write("abort-ctrl.js", jsAbortCtrl);
const rAbortCtrl = findPromiseRaceWithoutTimeout(fileAbortCtrl, "abort-ctrl.js");
check("[150-C5] AbortController in array: no crash, result is structured", typeof rAbortCtrl.findingsCount === "number");

console.log("  -- Level 4: Security --");

const jsMalicious = "Promise.race(['../../../etc/passwd', sqlInjection()]);"; 
const fileMalicious = write("malicious.js", jsMalicious);
const rMalicious = findPromiseRaceWithoutTimeout(fileMalicious, "malicious.js");
check("[150-D1] malicious content doesn't crash", typeof rMalicious.findingsCount === "number");

// max_results cap
const manyRaces = Array.from({ length: 50 }, () => "Promise.race([a(), b()]);").join("\n");
const fileManyRaces = write("many-races.js", manyRaces);
const rCapped = findPromiseRaceWithoutTimeout(fileManyRaces, "many-races.js", { maxResults: 5 });
check("[150-D2] max_results=5 caps findings at 5", rCapped.findingsCount === 5);
check("[150-D3] truncated=true when capped", rCapped.truncated === true);

check("[150-D4] all findings have required fields",
  rA.findings.every(f => f.file && f.line && f.rule && f.severity && f.message));

// Both errors and warnings
const jsBoth = "Promise.race([a(), b()]);\nPromise.race([singleOp()]);"; 
const fileBoth = write("both-rules.js", jsBoth);
const rBoth = findPromiseRaceWithoutTimeout(fileBoth, "both-rules.js");
check("[150-D5] errorCount >= 1", rBoth.errorCount >= 1);
check("[150-D6] has findings", rBoth.findingsCount >= 1);

console.log("  -- Level 5: Stress --");

const bigLines = Array.from({ length: 300 }, (_, i) =>
  i % 3 === 0 ? "const r = Promise.race([a(), b()]);" :
  i % 3 === 1 ? "Promise.race([fetch(url), new Promise((_,r)=>setTimeout(r,1000))]);" :
  "const safe = await fetchData();"
).join("\n");
const fileBig = write("big.js", bigLines);
const rBig = findPromiseRaceWithoutTimeout(fileBig, "big.js");
check("[150-E1] large file: structured result", typeof rBig.findingsCount === "number");
check("[150-E2] large file: findings > 0", rBig.findingsCount > 0);
check("[150-E3] findings sorted by line asc",
  rBig.findings.every((f, i, a) => i === 0 || a[i-1].line <= f.line));

write("test.ts", "Promise.race([op1(), op2()]);");
write("test.mjs", "Promise.race([a()]);");
const rMulti = findPromiseRaceWithoutTimeout(DIR, ".", { extensions: [".ts", ".mjs"] });
check("[150-E4] multi-extension scan works", rMulti.filesScanned >= 2);
check("[150-E5] multi-extension findings found", rMulti.findingsCount >= 1);

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[150] find_promise_race_without_timeout: ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
