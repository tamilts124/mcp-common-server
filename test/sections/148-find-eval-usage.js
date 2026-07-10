"use strict";
/**
 * [148] find_eval_usage — all 5 rigor levels
 *
 * Tests findEvalUsage (lib/evalUsageOps.js).
 * Does NOT start the MCP server — imports the function directly.
 */
const assert = require("assert");
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findEvalUsage } = require("../../lib/evalUsageOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eval-usage-test-"));

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

console.log("\n[148] find_eval_usage");
console.log("  -- Level 1: Normal --");

// [148-A] Normal
const jsWithEval = [
  "const result = eval(userInput);",
  "const fn = new Function('a', 'b', 'return a + b');",
  "setTimeout(\"console.log('hi')\", 100);",
  "setInterval('doSomething()', 1000);",
  "console.log('safe');",
].join("\n");
const fileA = write("with-eval.js", jsWithEval);
const rA = findEvalUsage(fileA, "with-eval.js");
check("[148-A1] filesScanned=1", rA.filesScanned === 1);
check("[148-A2] 2 errors (eval + new Function)", rA.errorCount === 2);
check("[148-A3] 2 warnings (setTimeout + setInterval string)", rA.warningCount === 2);
check("[148-A4] total findings=4", rA.findingsCount === 4);
check("[148-A5] direct_eval found",            rA.findings.some(f => f.rule === "direct_eval"));
check("[148-A6] new_function_constructor found", rA.findings.some(f => f.rule === "new_function_constructor"));
check("[148-A7] settimeout_string_arg found",   rA.findings.some(f => f.rule === "settimeout_string_arg"));
check("[148-A8] all findings have text field",   rA.findings.every(f => typeof f.text === "string"));
check("[148-A9] not truncated", rA.truncated === false);

console.log("  -- Level 2: Boundary --");

// [148-B] Boundary
const fileEmpty = write("empty.js", "");
const rEmpty = findEvalUsage(fileEmpty, "empty.js");
check("[148-B1] empty file → 0 findings", rEmpty.findingsCount === 0);

const jsSafe = "function add(a, b) { return a + b; }\nsetTimeout(() => { console.log('hi'); }, 100);";
const fileSafe = write("safe.js", jsSafe);
const rSafe = findEvalUsage(fileSafe, "safe.js");
check("[148-B2] safe JS → 0 findings", rSafe.findingsCount === 0);

const rDir = findEvalUsage(DIR, ".");
check("[148-B3] directory scan finds files",    rDir.filesScanned >= 2);
check("[148-B4] directory scan finds findings", rDir.findingsCount >= 4);

const rExt = findEvalUsage(DIR, ".", { extensions: [".ts"] });
check("[148-B5] wrong extension → 0 files", rExt.filesScanned === 0);

try {
  findEvalUsage(fileA, "x", { maxResults: 0 });
  check("[148-B6] max_results=0 should throw", false);
} catch (e) { check("[148-B6] max_results=0 throws -32602", e.code === -32602); }

try {
  findEvalUsage(fileA, "x", { maxResults: 9999 });
  check("[148-B7] max_results=9999 should throw", false);
} catch (e) { check("[148-B7] max_results=9999 throws -32602", e.code === -32602); }

try {
  findEvalUsage("/nonexistent/path", "bad");
  check("[148-B8] nonexistent path should throw", false);
} catch (e) { check("[148-B8] nonexistent path throws -32602", e.code === -32602); }

console.log("  -- Level 3: Mock failures --");

// [148-C] High
// Method-style eval NOT matched (foo.eval(x) is out of scope per design)
const jsMethodEval = "foo.eval(x);\nobj['eval'](y);";
const fileMethod = write("method-eval.js", jsMethodEval);
const rMethod = findEvalUsage(fileMethod, "method-eval.js");
check("[148-C1] foo.eval() NOT flagged", rMethod.findingsCount === 0);

// setTimeout with function reference — NOT flagged
const jsGoodTimer = "setTimeout(doSomething, 100);\nsetInterval(myFn, 1000);";
const fileGoodTimer = write("good-timer.js", jsGoodTimer);
const rGoodTimer = findEvalUsage(fileGoodTimer, "good-timer.js");
check("[148-C2] setTimeout(fnRef) not flagged", rGoodTimer.findingsCount === 0);

// setTimeout with template literal string — IS flagged
const jsBadTimer = "setTimeout(`alert(${msg})`, 100);";
const fileBadTimer = write("bad-timer-template.js", jsBadTimer);
const rBadTimer = findEvalUsage(fileBadTimer, "bad-timer-template.js");
check("[148-C3] setTimeout(template-string) flagged", rBadTimer.findingsCount === 1);

// Unreadable file → graceful skip
const jsUnreadable = write("cant-read.js", "eval('x')");
fs.chmodSync(jsUnreadable, 0o000);
try {
  const rBadPerm = findEvalUsage(jsUnreadable, "cant-read.js");
  check("[148-C4] unreadable file skipped gracefully", rBadPerm.findingsCount <= 1);
} finally {
  fs.chmodSync(jsUnreadable, 0o644);
}

// Finds in .mjs and .cjs too
const fileMjs = write("test.mjs", "eval('x'); new Function('return 1');\n");
const rMjs = findEvalUsage(fileMjs, "test.mjs");
check("[148-C5] .mjs files scanned", rMjs.findingsCount === 2);

console.log("  -- Level 4: Security --");

// [148-D] Critical
// All three patterns on one line
const jsCombined = "eval(new Function('return eval(\"x\")'))();";
const fileCombined = write("combined.js", jsCombined);
const rCombined = findEvalUsage(fileCombined, "combined.js");
check("[148-D1] combined eval+new Function detected", rCombined.errorCount >= 2);
check("[148-D2] all findings have required fields",
  rCombined.findings.every(f => f.file && f.line && f.rule && f.severity && f.message));

// max_results truncation
const manyEvals = Array.from({ length: 100 }, () => "eval(x);").join("\n");
const fileManyEvals = write("many-evals.js", manyEvals);
const rCapped = findEvalUsage(fileManyEvals, "many-evals.js", { maxResults: 5 });
check("[148-D3] max_results=5 caps findings at 5", rCapped.findingsCount === 5);
check("[148-D4] truncated=true when capped", rCapped.truncated === true);

// Severity check
const jsAll = "eval(x); new Function('return 1'); setTimeout('x', 1);";
const fileAll = write("all-patterns.js", jsAll);
const rAll = findEvalUsage(fileAll, "all-patterns.js");
check("[148-D5] eval/new Function are errors",
  rAll.findings.filter(f => f.rule === "direct_eval" || f.rule === "new_function_constructor").every(f => f.severity === "error"));
check("[148-D6] settimeout_string_arg is warning",
  rAll.findings.filter(f => f.rule === "settimeout_string_arg").every(f => f.severity === "warning"));

console.log("  -- Level 5: Stress --");

// [148-E] Extreme
const bigLines = Array.from({ length: 500 }, (_, i) =>
  i % 5 === 0 ? "eval(userInput);" :
  i % 5 === 1 ? "const fn = new Function('return 1');" :
  i % 5 === 2 ? "setTimeout('doIt()', 100);" :
  i % 5 === 3 ? "const safe = (x) => x + 1;" :
  "console.log('nothing');"
).join("\n");
const fileBig = write("big.js", bigLines);
const rBig = findEvalUsage(fileBig, "big.js");
check("[148-E1] large file: structured result", typeof rBig.findingsCount === "number");
check("[148-E2] large file: many findings found", rBig.findingsCount > 200);
check("[148-E3] findings sorted by line asc",
  rBig.findings.every((f, i, a) => i === 0 || a[i-1].line <= f.line));

const jsEmptyEval = "eval('')";
const fileEmptyEval = write("empty-eval.js", jsEmptyEval);
const rEmptyEval = findEvalUsage(fileEmptyEval, "empty-eval.js");
check("[148-E4] eval('') still flagged", rEmptyEval.findingsCount === 1);

// Multiple extensions in single scan
write("test2.ts",  "eval(x);");
write("test3.jsx", "new Function('return 1');");
const rMultiExt = findEvalUsage(DIR, ".", { extensions: [".ts", ".jsx"] });
check("[148-E5] multi-extension scan works", rMultiExt.findingsCount >= 2);

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[148] find_eval_usage: ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
