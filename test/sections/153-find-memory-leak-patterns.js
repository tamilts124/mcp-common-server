"use strict";
/**
 * [153] find_memory_leak_patterns — all 5 rigor levels
 * Tests findMemoryLeakPatterns (lib/memoryLeakPatternsOps.js).
 * Does NOT start the MCP server — imports the function directly.
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findMemoryLeakPatterns } = require("../../lib/memoryLeakPatternsOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mlp-test-"));

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

console.log("\n[153] find_memory_leak_patterns");
console.log("  -- Level 1: Normal (Happy Path) --");

// [153-A] Module-scope Map without eviction
const f1 = write("cache-leak.js", [
  "const cache = new Map();",
  "function store(k, v) { cache.set(k, v); }",
  "module.exports = { store };",
].join("\n"));
const r1 = findMemoryLeakPatterns(f1, "cache-leak.js");
check("[153-A1] module_scope_cache_no_eviction detected",
  r1.findingsCount === 1 && r1.findings[0].rule === "module_scope_cache_no_eviction");
check("[153-A2] variable name correct", r1.findings[0].variable === "cache");
check("[153-A3] severity=warning", r1.findings[0].severity === "warning");
check("[153-A4] message mentions eviction strategy", r1.findings[0].message.includes("eviction"));

// [153-B] Map with eviction — NOT flagged
const f2 = write("cache-ok.js", [
  "const cache = new Map();",
  "function store(k, v) { if (cache.size > 100) cache.clear(); cache.set(k, v); }",
].join("\n"));
const r2 = findMemoryLeakPatterns(f2, "cache-ok.js");
check("[153-B1] Map with .clear() not flagged", r2.findingsCount === 0);

// [153-C] DOM ref at module scope
const f3 = write("dom-ref.js", [
  "const btn = document.getElementById('submit');",
  "btn.addEventListener('click', () => {});",
].join("\n"));
const r3 = findMemoryLeakPatterns(f3, "dom-ref.js");
check("[153-C1] dom_ref_in_module_scope detected",
  r3.findingsCount === 1 && r3.findings[0].rule === "dom_ref_in_module_scope");
check("[153-C2] variable=btn", r3.findings[0].variable === "btn");

// [153-D] Accumulating array in closure
const f4 = write("acc-arr.js", [
  "const events = [];",
  "server.on('request', (req) => {",
  "  events.push(req.url);",
  "});",
].join("\n"));
const r4 = findMemoryLeakPatterns(f4, "acc-arr.js");
check("[153-D1] accumulating_push_in_closure detected",
  r4.findingsCount === 1 && r4.findings[0].rule === "accumulating_push_in_closure");
check("[153-D2] message mentions callback", r4.findings[0].message.includes("callback"));

// [153-E] Array with splice — NOT flagged
const f5 = write("acc-drain.js", [
  "const buf = [];",
  "setInterval(() => {",
  "  buf.push(Date.now());",
  "  if (buf.length > 50) buf.splice(0);",
  "}, 100);",
].join("\n"));
const r5 = findMemoryLeakPatterns(f5, "acc-drain.js");
check("[153-E1] array with splice not flagged", r5.findingsCount === 0);

// Result shape
check("[153-F1] result has expected shape",
  typeof r1.path === "string" && typeof r1.filesScanned === "number" &&
  Array.isArray(r1.findings) && typeof r1.truncated === "boolean");

console.log("  -- Level 2: Boundary & Param Validation --");

// max_results clamping
const fMany = write("many-maps.js", [
  "const a = new Map(); a.set(1,1);",
  "const b = new Map(); b.set(2,2);",
  "const c = new Map(); c.set(3,3);",
].join("\n"));
const rCap = findMemoryLeakPatterns(fMany, "many-maps.js", { maxResults: 2 });
check("[153-G1] max_results caps findings", rCap.findings.length <= 2);
check("[153-G2] truncated=true when capped", rCap.truncated === true);

// invalid maxResults type
try {
  findMemoryLeakPatterns(fMany, "x.js", { maxResults: "bad" });
  check("[153-G3] invalid max_results should throw", false);
} catch (e) { check("[153-G3] invalid max_results throws -32602", e.code === -32602); }

// invalid extensions type
try {
  findMemoryLeakPatterns(fMany, "x.js", { extensions: "js" });
  check("[153-G4] invalid extensions should throw", false);
} catch (e) { check("[153-G4] invalid extensions throws -32602", e.code === -32602); }

// non-existent path
try {
  findMemoryLeakPatterns("/nonexistent/path.js", "/nonexistent/path.js");
  check("[153-G5] non-existent path should throw", false);
} catch (e) { check("[153-G5] non-existent path throws -32602", e.code === -32602); }

// empty file
const ef = write("empty.js", "");
const er = findMemoryLeakPatterns(ef, "empty.js");
check("[153-G6] empty file = 0 findings", er.findingsCount === 0);

console.log("  -- Level 3: Mock Dependency Failures --");

// Directory scan with multiple files
const subDir = path.join(DIR, "sub");
fs.mkdirSync(subDir, { recursive: true });
write("sub/a.js", "const cache = new Map(); cache.set(1,1);");
write("sub/b.js", "// clean");
const rDir = findMemoryLeakPatterns(subDir, "sub");
check("[153-H1] directory scan: found 1+ findings", rDir.findingsCount >= 1);
check("[153-H2] directory result has filesScanned", rDir.filesScanned >= 1);

// Binary file skipped
const binDir = path.join(DIR, "bindir");
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, "binary.js"), Buffer.alloc(100, 0));
const rBin = findMemoryLeakPatterns(binDir, "bindir");
check("[153-H3] binary file skipped without error", rBin.findingsCount === 0);

console.log("  -- Level 4: Critical / Security --");

// Path traversal (should not crash)
try {
  findMemoryLeakPatterns("../../../etc/passwd", "../../../etc/passwd");
  check("[153-I1] path traversal: no crash", true);
} catch (e) { check("[153-I1] path traversal: error caught cleanly", !!e.message); }

// Variable with $ in name
const regexF = write("dollar.js", "const a$b = new Map(); a$b.set('x', 1);");
const rReg = findMemoryLeakPatterns(regexF, "dollar.js");
check("[153-I2] $ in variable name handled", rReg.findingsCount === 1);

// Very long variable name
const longName = "x".repeat(200);
const longF = write("longname.js", `const ${longName} = new Map();\n${longName}.set(1,1);`);
const rLong = findMemoryLeakPatterns(longF, "longname.js");
check("[153-I3] long variable name handled", typeof rLong.findingsCount === "number");

// All findings have required fields
check("[153-I4] all findings have required fields",
  r1.findings.every(f => f.file && f.line !== undefined && f.rule && f.severity && f.message));

console.log("  -- Level 5: Extreme / Fuzzing --");

// Set with .add but no delete
const fSet = write("set-leak.js", [
  "const seen = new Set();",
  "function track(id) { seen.add(id); }",
].join("\n"));
const rSet = findMemoryLeakPatterns(fSet, "set-leak.js");
check("[153-J1] Set without delete flagged", rSet.findingsCount === 1);
check("[153-J2] Set rule correct", rSet.findings[0].rule === "module_scope_cache_no_eviction");

// Set with delete — NOT flagged
const fSetOk = write("set-ok.js", [
  "const seen = new Set();",
  "function track(id) { seen.add(id); }",
  "function untrack(id) { seen.delete(id); }",
].join("\n"));
const rSetOk = findMemoryLeakPatterns(fSetOk, "set-ok.js");
check("[153-J3] Set with delete not flagged", rSetOk.findingsCount === 0);

// Multiple rules in same file
const fMulti = write("multi.js", [
  "const cache = new Map(); cache.set(1,1);",
  "const el = document.querySelector('#root');",
  "const log = [];",
  "app.on('req', () => { log.push(Date.now()); });",
].join("\n"));
const rMulti = findMemoryLeakPatterns(fMulti, "multi.js");
check("[153-J4] multiple rules in one file", rMulti.findingsCount === 3);

// Custom extensions filter
const extDir = path.join(DIR, "extdir");
fs.mkdirSync(extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, "a.ts"), "const cache = new Map(); cache.set(1,1);");
fs.writeFileSync(path.join(extDir, "b.js"), "const arr = []; setInterval(() => arr.push(1), 100);");
const rExt = findMemoryLeakPatterns(extDir, "extdir", { extensions: [".ts"] });
check("[153-J5] custom extensions: only .ts scanned", rExt.filesScanned === 1);

// Large synthetic file — performance
const bigLines = Array.from({ length: 5000 }, (_, i) =>
  i % 100 === 0 ? `const c${i} = new Map(); c${i}.set(${i},${i});` : `// line ${i}`
).join("\n");
const bigF = write("big.js", bigLines);
const t0 = Date.now();
const rBig = findMemoryLeakPatterns(bigF, "big.js");
check("[153-J6] large file scanned in <5s", Date.now() - t0 < 5000);
check("[153-J7] large file: 50 Map findings", rBig.findingsCount === 50);

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[153] find_memory_leak_patterns: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
module.exports = { passed, failed };
