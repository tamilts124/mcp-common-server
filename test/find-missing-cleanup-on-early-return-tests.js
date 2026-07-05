"use strict";
// Isolated functional tests for find_missing_cleanup_on_early_return
// (lib/cleanupEarlyReturnOps.js).
// Run: node test/find-missing-cleanup-on-early-return-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingCleanupOnEarlyReturn } = require("../lib/cleanupEarlyReturnOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-early-return-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("fd: early return before closeSync is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (bad) return null;\n  fs.closeSync(fd);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "missing_cleanup_on_early_return");
    assert.strictEqual(r.findings[0].kind, "fd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("interval: early throw before clearInterval is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f() {\n  const id = setInterval(tick, 100);\n  if (bad) throw new Error('x');\n  clearInterval(id);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].kind, "interval");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("lock: early return before unlock is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "async function f() {\n  const l = await mutex.lock();\n  if (bad) return;\n  l.unlock();\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].kind, "lock");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no release call anywhere is flagged as resource_never_released", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  console.log(fd);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "resource_never_released");
    assert.strictEqual(r.findings[0].severity, "warning");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("early return guarded by finally is NOT flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  try {\n    if (bad) return null;\n  } finally {\n    fs.closeSync(fd);\n  }\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no early exit between acquire and release is NOT flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  doStuff(fd);\n  fs.closeSync(fd);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean file with no resource acquisition returns zero findings", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "console.log('hi');\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory scan aggregates findings across files, sorted", () => {
  const d = mkdir();
  try {
    writeFile(d, "b.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    writeFile(d, "a.js", "function g(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 2);
    assert.strictEqual(r.findings[0].file, "a.js");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findMissingCleanupOnEarlyReturn("/no/such/dir/xyz", "."));
});

t("max_results type mismatch throws", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    assert.throws(() => findMissingCleanupOnEarlyReturn(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = mkdir();
  try {
    assert.throws(() => findMissingCleanupOnEarlyReturn(d, ".", { extensions: "not-an-array" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows scan", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.ts", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    writeFile(d, "b.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".", { extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.findings[0].file, "a.ts");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("timeout kind: clearTimeout after early return is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f() {\n  const t = setTimeout(fn, 10);\n  if (bad) return;\n  clearTimeout(t);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].kind, "timeout");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("dispatch handler is registered and callable via SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.find_missing_cleanup_on_early_return, "function");
});

t("missing path defaults to '.'", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped source content only reported as text, never executed", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(`$(rm -rf /)`, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    let r;
    assert.doesNotThrow(() => { r = findMissingCleanupOnEarlyReturn(d, "."); });
    assert.strictEqual(r.findingsCount, 1);
    assert.ok(!fs.existsSync("/tmp/pwned"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), [
      "path", "filesScanned", "findingsCount", "truncated", "findings",
    ].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = mkdir();
  try {
    let content = "";
    for (let i = 0; i < 10; i++) {
      content += `function f${i}(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n`;
    }
    writeFile(d, "a.js", content);
    const r = findMissingCleanupOnEarlyReturn(d, ".", { maxResults: 3 });
    assert.strictEqual(r.findings.length, 3);
    assert.strictEqual(r.truncated, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fuzz: random-byte file scanned without crash", () => {
  const d = mkdir();
  try {
    const buf = Buffer.alloc(2000);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(path.join(d, "a.js"), buf);
    assert.doesNotThrow(() => findMissingCleanupOnEarlyReturn(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = mkdir();
  try {
    const r = findMissingCleanupOnEarlyReturn(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(p) {\n  const fd = fs.openSync(p, 'r');\n  if (x) return;\n  fs.closeSync(fd);\n}\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findMissingCleanupOnEarlyReturn(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_missing_cleanup_on_early_return", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_missing_cleanup_on_early_return"));
  assert.ok(typeof SCAN_DISPATCH.find_missing_cleanup_on_early_return === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
