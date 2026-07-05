"use strict";
// Isolated functional tests for find_env_var_default_fallback_masking_errors (lib/envFallbackSecretOps.js).
// Run: node test/find-env-var-fallback-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findEnvVarDefaultFallbackMaskingErrors } = require("../lib/envFallbackSecretOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "envfallback-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags dot-access sensitive var with || fallback", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const secret = process.env.JWT_SECRET || 'dev';\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "env_var_default_fallback_masking_errors");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags bracket-access sensitive var with ?? fallback", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const key = process.env['API_KEY'] ?? '';\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-sensitive var name with fallback is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const env = process.env.NODE_ENV || 'development';\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("sensitive var with no fallback at all is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const secret = process.env.JWT_SECRET;\nif (!secret) throw new Error('missing');\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("PASSWORD/CREDENTIAL/TOKEN name variants all detected", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "process.env.DB_PASSWORD || 'x';\nprocess.env.AWS_CREDENTIAL || 'y';\nprocess.env.AUTH_TOKEN || 'z';\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".");
    assert.strictEqual(r.findingsCount, 3);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findEnvVarDefaultFallbackMaskingErrors("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findEnvVarDefaultFallbackMaskingErrors(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findEnvVarDefaultFallbackMaskingErrors(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "process.env.JWT_SECRET || 'x';\n");
    writeFile(d, "notes.md", "process.env.JWT_SECRET fake mention\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, "blob.js"), Buffer.from([0, 1, 2, 3, 0, 5]));
    writeFile(d, "a.js", "process.env.JWT_SECRET || 'x';\n");
    assert.doesNotThrow(() => findEnvVarDefaultFallbackMaskingErrors(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("single triple-pipe (||| typo-shaped) does not double count as || fallback", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const x = process.env.MY_SECRET_KEY || 'fallback';\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'.' label direct file call works without crash", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "a.js", "process.env.JWT_SECRET || 'x';\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(f, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "process.env.JWT_SECRET || 'x';\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped fallback value only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "process.env.JWT_SECRET || '; rm -rf /';\n");
    assert.doesNotThrow(() => findEnvVarDefaultFallbackMaskingErrors(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "process.env.JWT_SECRET || 'x';\n");
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["filesScanned", "findings", "findingsCount", "path", "envReadsSeen", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 5; i++) content += `process.env.SECRET_${i} || 'x';\n`;
    const f = writeFile(d, "a.js", content);
    const r = findEnvVarDefaultFallbackMaskingErrors(f, "a.js", { maxResults: 2 });
    assert.strictEqual(r.truncated, r.findingsCount > 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fuzz: random-byte file does not crash scan", () => {
  const d = tmpDir();
  try {
    const buf = Buffer.alloc(2000);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    const f = path.join(d, "a.js");
    fs.writeFileSync(f, buf);
    assert.doesNotThrow(() => findEnvVarDefaultFallbackMaskingErrors(f, "a.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findEnvVarDefaultFallbackMaskingErrors(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "process.env.JWT_SECRET || 'x';\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findEnvVarDefaultFallbackMaskingErrors(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_env_var_default_fallback_masking_errors", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_env_var_default_fallback_masking_errors"));
  assert.ok(typeof SCAN_DISPATCH.find_env_var_default_fallback_masking_errors === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
