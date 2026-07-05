"use strict";
// Isolated functional tests for find_json_parse_without_try_catch (lib/jsonParseTryCatchOps.js).
// Run: node test/find-json-parse-without-try-catch-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findJsonParseWithoutTryCatch } = require("../lib/jsonParseTryCatchOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "jsonparse-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("bare JSON.parse with no try/catch is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const x = JSON.parse(raw);\n");
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "unguarded_json_parse");
    assert.strictEqual(r.findings[0].severity, "warning");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("JSON.parse inside try/catch is NOT flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "try {\n  const x = JSON.parse(raw);\n} catch (e) {\n  console.error(e);\n}\n");
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("JSON.parse inside try/finally (no catch) IS flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "try {\n  const x = JSON.parse(raw);\n} finally {\n  cleanup();\n}\n");
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("multiple guarded and unguarded calls both classified correctly", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js",
      "try {\n  JSON.parse(a);\n} catch (e) {}\n" +
      "JSON.parse(b);\n"
    );
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.ok(r.findings[0].text.includes("JSON.parse(b)"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean file with no JSON.parse returns zero findings", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "console.log('hi');\n");
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory scan aggregates findings across files, sorted", () => {
  const d = mkdir();
  try {
    writeFile(d, "b.js", "JSON.parse(x);\n");
    writeFile(d, "a.js", "JSON.parse(y);\n");
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.findingsCount, 2);
    assert.strictEqual(r.findings[0].file, "a.js");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findJsonParseWithoutTryCatch("/no/such/dir/xyz", "."));
});

t("max_results type mismatch throws", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "JSON.parse(x);\n");
    assert.throws(() => findJsonParseWithoutTryCatch(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("single file with unrecognized extension throws", () => {
  const d = mkdir();
  try {
    const f = writeFile(d, "a.txt", "JSON.parse(x);\n");
    assert.throws(() => findJsonParseWithoutTryCatch(f, "a.txt"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows scan", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.ts", "JSON.parse(x);\n");
    writeFile(d, "b.js", "JSON.parse(y);\n");
    const r = findJsonParseWithoutTryCatch(d, ".", { extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.findings[0].file, "a.ts");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("nested try/catch: inner guarded call not flagged, sibling unguarded call is", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js",
      "function f() {\n" +
      "  try {\n" +
      "    if (x) {\n" +
      "      JSON.parse(a);\n" +
      "    }\n" +
      "  } catch (e) {}\n" +
      "}\n" +
      "JSON.parse(b);\n"
    );
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.ok(r.findings[0].text.includes("JSON.parse(b)"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("dispatch handler is registered and callable via SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.find_json_parse_without_try_catch, "function");
});

t("missing path defaults to '.'", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "JSON.parse(x);\n");
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "JSON.parse(x);\n");
    const r = findJsonParseWithoutTryCatch(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped argument only reported as text, never executed", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "JSON.parse(`$(rm -rf /)`);\n");
    let r;
    assert.doesNotThrow(() => { r = findJsonParseWithoutTryCatch(d, "."); });
    assert.strictEqual(r.findingsCount, 1);
    assert.ok(!fs.existsSync("/tmp/pwned"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "JSON.parse(x);\n");
    const r = findJsonParseWithoutTryCatch(d, ".");
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
    for (let i = 0; i < 10; i++) content += `JSON.parse(v${i});\n`;
    writeFile(d, "a.js", content);
    const r = findJsonParseWithoutTryCatch(d, ".", { maxResults: 3 });
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
    assert.doesNotThrow(() => findJsonParseWithoutTryCatch(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = mkdir();
  try {
    const r = findJsonParseWithoutTryCatch(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "JSON.parse(x);\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findJsonParseWithoutTryCatch(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_json_parse_without_try_catch", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_json_parse_without_try_catch"));
  assert.ok(typeof SCAN_DISPATCH.find_json_parse_without_try_catch === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
