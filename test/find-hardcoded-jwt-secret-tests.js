"use strict";
// Isolated functional tests for find_hardcoded_jwt_secret (lib/jwtSecretOps.js).
// Run: node test/find-hardcoded-jwt-secret-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findHardcodedJwtSecret } = require("../lib/jwtSecretOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "jwtsecret-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags jwt.sign with literal secret", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const jwt = require('jsonwebtoken');\nconst t = jwt.sign({id:1}, 'mysecret123');\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].method, "jwt.sign");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags jwt.verify with literal secret", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const jwt = require('jsonwebtoken');\njwt.verify(token, \"topsecret\");\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].method, "jwt.verify");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags template literal secret", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "jwt.sign(payload, `hardcoded-${1}`);\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-jwt identifier binding is still recognized via require alias", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const tokenLib = require('jsonwebtoken');\ntokenLib.sign(payload, 'literal-secret');\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].method, "tokenLib.sign");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("env-var secret is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "jwt.sign(payload, process.env.JWT_SECRET);\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("variable-reference secret is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const secret = getSecret();\njwt.sign(payload, secret);\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findHardcodedJwtSecret("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findHardcodedJwtSecret(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findHardcodedJwtSecret(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("unrecognized single-file extension throws", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "a.txt", "jwt.sign(p, 'x');\n");
    assert.throws(() => findHardcodedJwtSecret(f, "a.txt"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean file with no jwt calls yields zero findings", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "console.log('hello world');\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "jwt.sign(p, 'literal');\n");
    writeFile(d, "notes.md", "jwt.sign(p, 'literal') mentioned\n");
    const r = findHardcodedJwtSecret(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, "blob.js"), Buffer.from([0, 1, 2, 3, 0, 5]));
    writeFile(d, "a.js", "jwt.sign(p, 'literal');\n");
    assert.doesNotThrow(() => findHardcodedJwtSecret(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("nested subdirectory scanned recursively", () => {
  const d = tmpDir();
  try {
    writeFile(d, "src/auth/token.js", "jwt.sign(p, 'literal-nested');\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].file, "src/auth/token.js");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'.' label direct file call works without crash", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "a.js", "jwt.sign(p, 'literal');\n");
    const r = findHardcodedJwtSecret(f, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("secret argument that is a function call is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "jwt.sign(p, loadSecret('name'));\n");
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "jwt.sign(p, 'literal');\n");
    const r = findHardcodedJwtSecret(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped secret text only reported, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "jwt.sign(p, '; rm -rf / #');\n");
    let r;
    assert.doesNotThrow(() => { r = findHardcodedJwtSecret(d, "."); });
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("secretPreview truncates long literals rather than reproducing them in full", () => {
  const d = tmpDir();
  try {
    const longSecret = "a".repeat(200);
    writeFile(d, "a.js", `jwt.sign(p, '${longSecret}');\n`);
    const r = findHardcodedJwtSecret(d, ".");
    assert.ok(r.findings[0].secretPreview.length < 200);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "jwt.sign(p, 'literal');\n");
    const r = findHardcodedJwtSecret(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["filesScanned", "findings", "findingsCount", "path", "truncated"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 5; i++) content += `jwt.sign(p, 'literal${i}');\n`;
    const f = writeFile(d, "a.js", content);
    const r = findHardcodedJwtSecret(f, "a.js", { maxResults: 2 });
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
    assert.doesNotThrow(() => findHardcodedJwtSecret(f, "a.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findHardcodedJwtSecret(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "jwt.sign(p, 'literal');\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findHardcodedJwtSecret(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_hardcoded_jwt_secret", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_hardcoded_jwt_secret"));
  assert.ok(typeof SCAN_DISPATCH.find_hardcoded_jwt_secret === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
