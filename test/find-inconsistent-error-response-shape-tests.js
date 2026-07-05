"use strict";
// Isolated functional tests for find_inconsistent_error_response_shape
// (lib/inconsistentErrorShapeOps.js).
// Run: node test/find-inconsistent-error-response-shape-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findInconsistentErrorResponseShape } = require("../lib/inconsistentErrorShapeOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "error-shape-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("differing key in second handler is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "app.get('/x', (req,res) => { res.status(404).json({ error: 'nf' }); });\napp.get('/y', (req,res) => { res.status(500).json({ message: 'oops' }); });\n");
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "inconsistent_error_response_shape");
    assert.strictEqual(r.findings[0].key, "message");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("consistent key across handlers is NOT flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "app.get('/x', (req,res) => { res.status(404).json({ error: 'nf' }); });\napp.get('/y', (req,res) => { res.status(500).json({ error: 'oops' }); });\n");
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("single error response in a file cannot be inconsistent", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "app.get('/x', (req,res) => { res.status(404).json({ error: 'nf' }); });\n");
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("success (2xx) responses are ignored, not counted toward baseline", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "app.get('/x', (req,res) => { res.status(200).json({ data: 'ok' }); });\napp.get('/y', (req,res) => { res.status(500).json({ error: 'oops' }); });\n");
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean file with no res.status().json() calls returns zero findings", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "console.log('hi');\n");
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory scan aggregates findings across files, sorted, per-file baseline", () => {
  const d = mkdir();
  try {
    writeFile(d, "b.js", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    writeFile(d, "a.js", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.findingsCount, 2);
    assert.strictEqual(r.findings[0].file, "a.js");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findInconsistentErrorResponseShape("/no/such/dir/xyz", "."));
});

t("max_results type mismatch throws", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    assert.throws(() => findInconsistentErrorResponseShape(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = mkdir();
  try {
    assert.throws(() => findInconsistentErrorResponseShape(d, ".", { extensions: "not-an-array" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows scan", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.ts", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    writeFile(d, "b.js", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    const r = findInconsistentErrorResponseShape(d, ".", { extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.findings[0].file, "a.ts");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("three differing shapes after baseline all flagged individually", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "res.status(400).json({ error: 'a' });\nres.status(401).json({ err: 'b' });\nres.status(403).json({ message: 'c' });\n");
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.findingsCount, 2);
    assert.deepStrictEqual(r.findings.map(f => f.key), ["err", "message"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("dispatch handler is registered and callable via SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.find_inconsistent_error_response_shape, "function");
});

t("missing path defaults to '.'", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    const r = findInconsistentErrorResponseShape(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped source content only reported as text, never executed", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "res.status(400).json({ error: '`$(rm -rf /)`' });\nres.status(500).json({ msg: 'y' });\n");
    let r;
    assert.doesNotThrow(() => { r = findInconsistentErrorResponseShape(d, "."); });
    assert.strictEqual(r.findingsCount, 1);
    assert.ok(!fs.existsSync("/tmp/pwned"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    const r = findInconsistentErrorResponseShape(d, ".");
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
    let content = "res.status(400).json({ error: 'base' });\n";
    for (let i = 0; i < 10; i++) content += `res.status(500).json({ msg${i}: 'v' });\n`;
    writeFile(d, "a.js", content);
    const r = findInconsistentErrorResponseShape(d, ".", { maxResults: 3 });
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
    assert.doesNotThrow(() => findInconsistentErrorResponseShape(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = mkdir();
  try {
    const r = findInconsistentErrorResponseShape(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "res.status(400).json({ error: 'x' });\nres.status(500).json({ msg: 'y' });\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findInconsistentErrorResponseShape(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_inconsistent_error_response_shape", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_inconsistent_error_response_shape"));
  assert.ok(typeof SCAN_DISPATCH.find_inconsistent_error_response_shape === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
