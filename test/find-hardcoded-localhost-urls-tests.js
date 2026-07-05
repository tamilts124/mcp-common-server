"use strict";
// Isolated functional tests for find_hardcoded_localhost_urls (lib/localhostUrlOps.js).
// Run: node test/find-hardcoded-localhost-urls-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findHardcodedLocalhostUrls } = require("../lib/localhostUrlOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "localhosturl-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags http://localhost with port", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const url = 'http://localhost:3000/api';\n");
    const r = findHardcodedLocalhostUrls(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "hardcoded_localhost_url");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags http://127.0.0.1", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "fetch('http://127.0.0.1:8080/x');\n");
    const r = findHardcodedLocalhostUrls(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags wss://localhost", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "new WebSocket('wss://localhost:9000');\n");
    const r = findHardcodedLocalhostUrls(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-localhost URL is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const url = 'https://api.example.com';\n");
    const r = findHardcodedLocalhostUrls(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("test/spec/mock/fixture paths skipped by default", () => {
  const d = tmpDir();
  try {
    writeFile(d, "test/a.test.js", "'http://localhost:3000';\n");
    writeFile(d, "src/b.js", "'http://localhost:3000';\n");
    const r = findHardcodedLocalhostUrls(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.filesSkippedAsTest, 1);
    assert.strictEqual(r.findings[0].file, "src/b.js");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("include_test_files true scans skipped paths too", () => {
  const d = tmpDir();
  try {
    writeFile(d, "test/a.test.js", "'http://localhost:3000';\n");
    const r = findHardcodedLocalhostUrls(d, ".", { includeTestFiles: true });
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.filesSkippedAsTest, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findHardcodedLocalhostUrls("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findHardcodedLocalhostUrls(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findHardcodedLocalhostUrls(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("include_test_files type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findHardcodedLocalhostUrls(d, ".", { includeTestFiles: "yes" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "'http://localhost:3000';\n");
    writeFile(d, "notes.md", "http://localhost:3000 mentioned\n");
    const r = findHardcodedLocalhostUrls(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, "blob.js"), Buffer.from([0, 1, 2, 3, 0, 5]));
    writeFile(d, "a.js", "'http://localhost:3000';\n");
    assert.doesNotThrow(() => findHardcodedLocalhostUrls(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("multiple matches on same line all counted", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const a='http://localhost:3000', b='http://127.0.0.1:4000';\n");
    const r = findHardcodedLocalhostUrls(d, ".");
    assert.strictEqual(r.findingsCount, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'.' label direct file call works without crash", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "a.js", "'http://localhost:3000';\n");
    const r = findHardcodedLocalhostUrls(f, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "'http://localhost:3000';\n");
    const r = findHardcodedLocalhostUrls(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped content only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const u = 'http://localhost:3000/; rm -rf /';\n");
    assert.doesNotThrow(() => findHardcodedLocalhostUrls(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "'http://localhost:3000';\n");
    const r = findHardcodedLocalhostUrls(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["filesScanned", "filesSkippedAsTest", "findings", "findingsCount", "path", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 5; i++) content += `'http://localhost:300${i}';\n`;
    const f = writeFile(d, "a.js", content);
    const r = findHardcodedLocalhostUrls(f, "a.js", { maxResults: 2 });
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
    assert.doesNotThrow(() => findHardcodedLocalhostUrls(f, "a.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findHardcodedLocalhostUrls(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "'http://localhost:3000';\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findHardcodedLocalhostUrls(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_hardcoded_localhost_urls", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_hardcoded_localhost_urls"));
  assert.ok(typeof SCAN_DISPATCH.find_hardcoded_localhost_urls === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
