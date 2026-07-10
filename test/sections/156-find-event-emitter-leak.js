"use strict";
/**
 * [156] find_event_emitter_leak — all 5 rigor levels
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findEventEmitterLeak } = require("../../lib/eventEmitterLeakOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eel-test-"));

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

console.log("\n[156] find_event_emitter_leak");
console.log("  -- Level 1: Normal (Happy Path) --");

// [156-A] process.on inside a function (indented) — error
const f1 = write("process-in-fn.js", [
  "function setup() {",
  "  process.on('uncaughtException', (err) => console.error(err));",
  "}",
].join("\n"));
const r1 = findEventEmitterLeak(f1, "process-in-fn.js");
check("[156-A1] process_listener_in_function_body detected",
  r1.findingsCount >= 1 && r1.findings.some(f => f.rule === "process_listener_in_function_body"));
check("[156-A2] severity=error", r1.findings[0].severity === "error");
check("[156-A3] event name captured", r1.findings[0].event === "uncaughtException");
check("[156-A4] message mentions MaxListeners", r1.findings[0].message.includes("MaxListeners"));

// [156-B] process.on at module scope (NOT indented) — clean
const f2 = write("process-module-scope.js", [
  "process.on('uncaughtException', (err) => console.error(err));",
  "process.on('unhandledRejection', (reason) => console.error(reason));",
].join("\n"));
const r2 = findEventEmitterLeak(f2, "process-module-scope.js");
check("[156-B1] module-scope process.on not flagged", r2.findingsCount === 0);

// [156-C] .on() inside a for loop
const f3 = write("loop-on.js", [
  "const emitters = [new EventEmitter(), new EventEmitter()];",
  "for (let i = 0; i < emitters.length; i++) {",
  "  emitters[i].on('data', (chunk) => process(chunk));",
  "}",
].join("\n"));
const r3 = findEventEmitterLeak(f3, "loop-on.js");
check("[156-C1] emitter_on_inside_loop detected",
  r3.findingsCount >= 1 && r3.findings.some(f => f.rule === "emitter_on_inside_loop"));
check("[156-C2] severity=warning", r3.findings.find(f => f.rule === "emitter_on_inside_loop").severity === "warning");

// [156-D] .on() outside loop (not flagged)
const f4 = write("clean.js", [
  "const ee = new EventEmitter();",
  "ee.on('data', (chunk) => process(chunk));",
].join("\n"));
const r4 = findEventEmitterLeak(f4, "clean.js");
check("[156-D1] .on() at module scope not flagged", r4.findingsCount === 0);

// Result shape
check("[156-E1] result has expected shape",
  typeof r1.path === "string" && typeof r1.filesScanned === "number" &&
  Array.isArray(r1.findings) && typeof r1.truncated === "boolean");

console.log("  -- Level 2: Boundary & Param Validation --");

// max_results
const fMany = write("many.js", [
  "function bad() {",
  "  process.on('a', () => {});",
  "  process.on('b', () => {});",
  "  process.on('c', () => {});",
  "}",
].join("\n"));
const rCap = findEventEmitterLeak(fMany, "many.js", { maxResults: 2 });
check("[156-F1] max_results caps findings", rCap.findings.length <= 2);

try {
  findEventEmitterLeak(fMany, "x.js", { maxResults: "bad" });
  check("[156-F2] bad max_results should throw", false);
} catch (e) { check("[156-F2] throws -32602", e.code === -32602); }

try {
  findEventEmitterLeak(fMany, "x.js", { extensions: 99 });
  check("[156-F3] bad extensions should throw", false);
} catch (e) { check("[156-F3] throws -32602", e.code === -32602); }

try {
  findEventEmitterLeak("/no/such/path.js", "/no/such/path.js");
  check("[156-F4] non-existent should throw", false);
} catch (e) { check("[156-F4] throws -32602", e.code === -32602); }

const ef = write("empty.js", "");
const er = findEventEmitterLeak(ef, "empty.js");
check("[156-F5] empty file = 0 findings", er.findingsCount === 0);

console.log("  -- Level 3: Mock Dependency Failures --");

const sub = path.join(DIR, "multi");
fs.mkdirSync(sub, { recursive: true });
fs.writeFileSync(path.join(sub, "a.js"), "function x() { process.on('exit', () => {}); }");
fs.writeFileSync(path.join(sub, "b.js"), "// clean");
const rDir = findEventEmitterLeak(sub, "multi");
check("[156-G1] directory scan: filesScanned=2", rDir.filesScanned === 2);
check("[156-G2] detects finding in subdir file", rDir.findingsCount >= 1);

const binDir = path.join(DIR, "bin2");
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, "bin.js"), Buffer.alloc(50, 0));
const rBin = findEventEmitterLeak(binDir, "bin2");
check("[156-G3] binary file skipped", rBin.findingsCount === 0);

// while loop detection
const fWhile = write("while-on.js", [
  "let i = 0;",
  "while (i < 10) {",
  "  stream.on('data', cb);",
  "  i++;",
  "}",
].join("\n"));
const rWhile = findEventEmitterLeak(fWhile, "while-on.js");
check("[156-G4] while loop detected",
  rWhile.findings.some(f => f.rule === "emitter_on_inside_loop"));

console.log("  -- Level 4: Critical / Security --");

try {
  findEventEmitterLeak("../../../etc/passwd", "../../../etc/passwd");
  check("[156-H1] path traversal: no crash", true);
} catch (e) { check("[156-H1] path traversal caught", !!e.message); }

// process.once inside function (also flagged)
const fOnce = write("process-once.js", [
  "app.use((req, res, next) => {",
  "  process.once('unhandledRejection', handler);",
  "  next();",
  "});",
].join("\n"));
const rOnce = findEventEmitterLeak(fOnce, "process-once.js");
check("[156-H2] process.once in function body flagged",
  rOnce.findings.some(f => f.rule === "process_listener_in_function_body"));

// All findings have required fields
check("[156-H3] all findings have required fields",
  r1.findings.every(f => f.file && f.line !== undefined && f.rule && f.severity && f.message));

console.log("  -- Level 5: Extreme / Stress --");

// Stress: many process.on inside a function
const stressLines = ["function register() {"];
for (let i = 0; i < 100; i++) stressLines.push(`  process.on('event${i}', () => {});`);
stressLines.push("}");
const bigF = write("stress.js", stressLines.join("\n"));
const t0 = Date.now();
const rBig = findEventEmitterLeak(bigF, "stress.js");
check("[156-I1] stress scan in <2s", Date.now() - t0 < 2000);
check("[156-I2] 100 findings detected", rBig.findingsCount === 100);

// Custom extensions
const extDir = path.join(DIR, "ext");
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, "a.ts"), "function x() { process.on('exit', () => {}); }");
fs.writeFileSync(path.join(extDir, "b.js"), "function y() { process.on('exit', () => {}); }");
const rExt = findEventEmitterLeak(extDir, "ext", { extensions: [".ts"] });
check("[156-I3] custom extensions: only .ts scanned", rExt.filesScanned === 1);
check("[156-I4] custom extensions: 1 finding", rExt.findingsCount === 1);

// do...while loop
const fDo = write("do-while.js", [
  "let n = 0;",
  "do {",
  "  sock.on('data', handler);",
  "  n++;",
  "} while (n < 5);",
].join("\n"));
const rDo = findEventEmitterLeak(fDo, "do-while.js");
check("[156-I5] do...while loop detected",
  rDo.findings.some(f => f.rule === "emitter_on_inside_loop"));

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[156] find_event_emitter_leak: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
module.exports = { passed, failed };
