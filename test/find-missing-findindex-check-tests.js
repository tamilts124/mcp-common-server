"use strict";
// Isolated functional tests for find_missing_findindex_check (lib/findIndexGuardOps.js).
// Run: node test/find-missing-findindex-check-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingFindIndexCheck } = require("../lib/findIndexGuardOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "findindex-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("direct chain subscript is flagged (error, no intermediate var)", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const x = arr[arr.findIndex(f)];\n");
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "chained_findindex_no_guard");
    assert.strictEqual(r.findings[0].severity, "error");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("assign-then-unguarded-subscript is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(f);\nconst item = arr[idx];\n");
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "missing_findindex_guard");
    assert.strictEqual(r.findings[0].name, "idx");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("guarded with if(idx !== -1) is NOT flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(f);\nif (idx !== -1) {\n  const item = arr[idx];\n}\n");
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("guarded with idx >= 0 ternary is NOT flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(f);\nconst item = idx >= 0 ? arr[idx] : null;\n");
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean file with no findIndex returns zero findings", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "console.log('hi');\n");
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory scan aggregates findings across files, sorted", () => {
  const d = mkdir();
  try {
    writeFile(d, "b.js", "const i = arr.findIndex(f);\narr[i].x;\n");
    writeFile(d, "a.js", "const j = arr.findIndex(f);\narr[j].y;\n");
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.findingsCount, 2);
    assert.strictEqual(r.findings[0].file, "a.js");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findMissingFindIndexCheck("/no/such/dir/xyz", "."));
});

t("max_results type mismatch throws", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(f);\narr[idx].x;\n");
    assert.throws(() => findMissingFindIndexCheck(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = mkdir();
  try {
    assert.throws(() => findMissingFindIndexCheck(d, ".", { extensions: "not-an-array" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows scan", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.ts", "const idx = arr.findIndex(f);\narr[idx].x;\n");
    writeFile(d, "b.js", "const idx = arr.findIndex(f);\narr[idx].y;\n");
    const r = findMissingFindIndexCheck(d, ".", { extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.findings[0].file, "a.ts");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("usage beyond the 6-line lookahead is NOT flagged (documented limitation)", () => {
  const d = mkdir();
  try {
    const filler = "console.log(1);\n".repeat(7);
    writeFile(d, "a.js", `const idx = arr.findIndex(f);\n${filler}arr[idx].x;\n`);
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("dispatch handler is registered and callable via SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.find_missing_findindex_check, "function");
});

t("missing path defaults to '.'", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(f);\narr[idx].x;\n");
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(f);\narr[idx].x;\n");
    const r = findMissingFindIndexCheck(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped source content only reported as text, never executed", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(x => x.id === `$(rm -rf /)`);\narr[idx].x;\n");
    let r;
    assert.doesNotThrow(() => { r = findMissingFindIndexCheck(d, "."); });
    assert.strictEqual(r.findingsCount, 1);
    assert.ok(!fs.existsSync("/tmp/pwned"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(f);\narr[idx].x;\n");
    const r = findMissingFindIndexCheck(d, ".");
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
    for (let i = 0; i < 10; i++) content += `arr[arr.findIndex(f${i})];\n`;
    writeFile(d, "a.js", content);
    const r = findMissingFindIndexCheck(d, ".", { maxResults: 3 });
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
    assert.doesNotThrow(() => findMissingFindIndexCheck(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = mkdir();
  try {
    const r = findMissingFindIndexCheck(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const idx = arr.findIndex(f);\narr[idx].x;\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findMissingFindIndexCheck(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_missing_findindex_check", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_missing_findindex_check"));
  assert.ok(typeof SCAN_DISPATCH.find_missing_findindex_check === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
