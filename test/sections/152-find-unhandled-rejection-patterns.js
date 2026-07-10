"use strict";
/**
 * [152] find_unhandled_rejection_patterns — all 5 rigor levels
 *
 * Tests findUnhandledRejectionPatterns (lib/unhandledRejectionOps.js).
 * Does NOT start the MCP server — imports the function directly.
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findUnhandledRejectionPatterns } = require("../../lib/unhandledRejectionOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "unhandled-rejection-test-"));

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

console.log("\n[152] find_unhandled_rejection_patterns");
console.log("  -- Level 1: Normal --");

// [152-A] Entry-point file missing unhandledRejection handler
const jsNoHandler = [
  "const http = require('http');",
  "const server = http.createServer(app);",
  "server.listen(3000);",
].join("\n");
const fileServer = write("server.js", jsNoHandler);
const rA = findUnhandledRejectionPatterns(fileServer, "server.js");
check("[152-A1] filesScanned=1", rA.filesScanned === 1);
check("[152-A2] finds missing_global_rejection_handler", rA.findingsCount === 1);
check("[152-A3] rule=missing_global_rejection_handler", rA.findings[0].rule === "missing_global_rejection_handler");
check("[152-A4] severity=warning", rA.findings[0].severity === "warning");
check("[152-A5] message has info to fix it", rA.findings[0].message.includes("process.on"));
check("[152-A6] not truncated", rA.truncated === false);

// Safe: entry point WITH proper unhandledRejection handler
const jsWithHandler = [
  "const http = require('http');",
  "process.on('unhandledRejection', (reason, promise) => {",
  "  console.error('Unhandled rejection:', reason);",
  "  process.exit(1);",
  "});",
  "http.createServer(app).listen(3000);",
].join("\n");
const fileWithHandler = write("server-safe.js", jsWithHandler);
const rSafe = findUnhandledRejectionPatterns(fileWithHandler, "server-safe.js");
check("[152-A7] proper handler -> 0 findings", rSafe.findingsCount === 0);

// Noop handler (arrow function)
const jsNoop = [
  "const app = require('./app');",
  "process.on('unhandledRejection', () => {});",
  "app.listen(3000);",
].join("\n");
const fileNoop = write("app.js", jsNoop);
const rNoop = findUnhandledRejectionPatterns(fileNoop, "app.js");
check("[152-A8] noop arrow handler -> noop_rejection_handler",
  rNoop.findings.some(f => f.rule === "noop_rejection_handler"));
check("[152-A9] noop rule has severity=error",
  rNoop.findings.filter(f => f.rule === "noop_rejection_handler").every(f => f.severity === "error"));

console.log("  -- Level 2: Boundary --");

// Empty file
const fileEmpty = write("empty.js", "");
const rEmpty = findUnhandledRejectionPatterns(fileEmpty, "empty.js");
check("[152-B1] empty non-entry-point -> 0 findings", rEmpty.findingsCount === 0);

// Non-entry-point file without handler -> no missing-handler warning
const jsUtil = "function helper() { return 42; }";
const fileUtil = write("utils.js", jsUtil);
const rUtil = findUnhandledRejectionPatterns(fileUtil, "utils.js");
check("[152-B2] non-entry-point file -> no missing_global_rejection_handler",
  !rUtil.findings.some(f => f.rule === "missing_global_rejection_handler"));

// Directory scan
const rDir = findUnhandledRejectionPatterns(DIR, ".");
check("[152-B3] directory scan runs", rDir.filesScanned >= 2);
check("[152-B4] directory has findings", rDir.findingsCount >= 1);

// Wrong extension
const rExt = findUnhandledRejectionPatterns(DIR, ".", { extensions: [".py"] });
check("[152-B5] wrong extension -> 0 files", rExt.filesScanned === 0);

try {
  findUnhandledRejectionPatterns(fileServer, "x", { maxResults: 0 });
  check("[152-B6] max_results=0 should throw", false);
} catch (e) { check("[152-B6] max_results=0 throws -32602", e.code === -32602); }

try {
  findUnhandledRejectionPatterns("/nonexistent/path", "bad");
  check("[152-B7] nonexistent path should throw", false);
} catch (e) { check("[152-B7] nonexistent path throws -32602", e.code === -32602); }

console.log("  -- Level 3: Mock failures --");

// Noop function handler form
const jsNoopFunc = [
  "process.on('unhandledRejection', function() {});",
].join("\n");
const fileNoopFunc = write("index.js", jsNoopFunc);
const rNoopFunc = findUnhandledRejectionPatterns(fileNoopFunc, "index.js");
check("[152-C1] noop function() {} handler detected",
  rNoopFunc.findings.some(f => f.rule === "noop_rejection_handler"));

// Unreadable file
const fileUnread = write("main.js", "process.on('unhandledRejection', () => {});");
fs.chmodSync(fileUnread, 0o000);
try {
  const rUnread = findUnhandledRejectionPatterns(fileUnread, "main.js");
  check("[152-C2] unreadable file gracefully handled", typeof rUnread.findingsCount === "number");
} finally {
  fs.chmodSync(fileUnread, 0o644);
}

// Only entry-point names get missing-handler check
const jsBootstrap = [
  "const app = require('./app');",
  "app.start();",
].join("\n");
const fileBootstrap = write("bootstrap.js", jsBootstrap);
const rBoot = findUnhandledRejectionPatterns(fileBootstrap, "bootstrap.js");
check("[152-C3] bootstrap.js flagged as entry-point",
  rBoot.findings.some(f => f.rule === "missing_global_rejection_handler"));

// entry.js is also an entry-point
const jsEntry = "require('./app').start();";
const fileEntry = write("entry.js", jsEntry);
const rEntry = findUnhandledRejectionPatterns(fileEntry, "entry.js");
check("[152-C4] entry.js flagged as entry-point",
  rEntry.findings.some(f => f.rule === "missing_global_rejection_handler"));

console.log("  -- Level 4: Security --");

// Path traversal
try {
  findUnhandledRejectionPatterns("../../../etc/passwd", "../../../etc/passwd");
  check("[152-D1] path traversal doesn't crash", true);
} catch (e) {
  check("[152-D1] path traversal throws structured error", e.code === -32602);
}

// max_results capping: create many entry-point-like files with noop handlers in subdir
const subDir = path.join(DIR, "many-entries");
fs.mkdirSync(subDir, { recursive: true });
for (let i = 0; i < 20; i++) {
  fs.writeFileSync(path.join(subDir, `server${i}.js`),
    `process.on('unhandledRejection', () => {});\nhttp.listen(${3000+i});`);
}
const rCapped = findUnhandledRejectionPatterns(subDir, "many-entries", { maxResults: 5 });
check("[152-D2] max_results=5 caps findings", rCapped.findingsCount === 5);
check("[152-D3] truncated=true when capped", rCapped.truncated === true);

check("[152-D4] all findings have required fields",
  rA.findings.every(f => f.file && f.line !== undefined && f.rule && f.severity && f.message));

console.log("  -- Level 5: Stress --");

// Large number of files including noop handlers
const stressDir = path.join(DIR, "stress");
fs.mkdirSync(stressDir, { recursive: true });
for (let i = 0; i < 30; i++) {
  fs.writeFileSync(path.join(stressDir, `mod${i}.js`),
    i % 3 === 0
      ? `process.on('unhandledRejection', () => {}); // noop`
      : i % 3 === 1
      ? `process.on('unhandledRejection', (r, p) => { console.error(r); process.exit(1); }); // safe`
      : `// no handler at all in module file`);
}
const rStress = findUnhandledRejectionPatterns(stressDir, "stress");
check("[152-E1] stress: structured result", typeof rStress.findingsCount === "number");
check("[152-E2] stress: found noop handlers",
  rStress.findings.filter(f => f.rule === "noop_rejection_handler").length === 10);
check("[152-E3] stress: findings sorted by file then line",
  rStress.findings.every((f, i, a) =>
    i === 0 || a[i-1].file < f.file || (a[i-1].file === f.file && a[i-1].line <= f.line)));

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[152] find_unhandled_rejection_patterns: ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
