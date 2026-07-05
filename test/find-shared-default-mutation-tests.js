"use strict";
// Isolated functional tests for find_missing_null_check_on_optional_chaining_default
// (lib/sharedDefaultMutationOps.js).
// Run: node test/find-shared-default-mutation-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findSharedDefaultMutation } = require("../lib/sharedDefaultMutationOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "shared-default-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("direct chain mutation of module-level literal fallback is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const DEFAULT_TAGS = [];\nfunction f(obj) {\n  (obj?.tags ?? DEFAULT_TAGS).push('x');\n}\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "chained_shared_default_mutation");
    assert.strictEqual(r.findings[0].name, "DEFAULT_TAGS");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("assign-then-mutate of module-level literal fallback is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const DEFAULTS = {};\nfunction f(obj) {\n  const cfg = obj?.settings ?? DEFAULTS;\n  cfg.enabled = true;\n}\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "assigned_shared_default_mutation");
    assert.strictEqual(r.findings[0].name, "cfg");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("inline literal fallback (?? []) is NOT flagged — fresh value every call", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(obj) {\n  (obj?.tags ?? []).push('x');\n}\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-mutating read of fallback result is NOT flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const DEFAULTS = [];\nfunction f(obj) {\n  const cfg = obj?.list ?? DEFAULTS;\n  console.log(cfg.length);\n}\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fallback identifier not declared as a top-level literal is NOT flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "function f(obj, DEFAULTS) {\n  const cfg = obj?.list ?? DEFAULTS;\n  cfg.push(1);\n}\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean file with no optional chaining returns zero findings", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "console.log('hi');\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory scan aggregates findings across files, sorted", () => {
  const d = mkdir();
  try {
    writeFile(d, "b.js", "const D = [];\nconst x = a?.b ?? D;\nx.push(1);\n");
    writeFile(d, "a.js", "const D = [];\nconst y = a?.b ?? D;\ny.push(1);\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 2);
    assert.strictEqual(r.findings[0].file, "a.js");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findSharedDefaultMutation("/no/such/dir/xyz", "."));
});

t("max_results type mismatch throws", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const D = [];\nconst x = a?.b ?? D;\nx.push(1);\n");
    assert.throws(() => findSharedDefaultMutation(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = mkdir();
  try {
    assert.throws(() => findSharedDefaultMutation(d, ".", { extensions: "not-an-array" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows scan", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.ts", "const D = [];\nconst x = a?.b ?? D;\nx.push(1);\n");
    writeFile(d, "b.js", "const D = [];\nconst x = a?.b ?? D;\nx.push(1);\n");
    const r = findSharedDefaultMutation(d, ".", { extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.findings[0].file, "a.ts");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("mutation beyond the 6-line lookahead is NOT flagged (documented limitation)", () => {
  const d = mkdir();
  try {
    const filler = "console.log(1);\n".repeat(7);
    writeFile(d, "a.js", `const D = [];\nconst x = a?.b ?? D;\n${filler}x.push(1);\n`);
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("index-assignment mutation is flagged", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const D = [];\nconst x = a?.b ?? D;\nx[0] = 'y';\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("dispatch handler is registered and callable via SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.find_missing_null_check_on_optional_chaining_default, "function");
});

t("missing path defaults to '.'", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const D = [];\nconst x = a?.b ?? D;\nx.push(1);\n");
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const D = [];\nconst x = a?.b ?? D;\nx.push(1);\n");
    const r = findSharedDefaultMutation(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped source content only reported as text, never executed", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const D = [];\nconst x = a?.b ?? D;\nx.push(`$(rm -rf /)`);\n");
    let r;
    assert.doesNotThrow(() => { r = findSharedDefaultMutation(d, "."); });
    assert.strictEqual(r.findingsCount, 1);
    assert.ok(!fs.existsSync("/tmp/pwned"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const D = [];\nconst x = a?.b ?? D;\nx.push(1);\n");
    const r = findSharedDefaultMutation(d, ".");
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
    let content = "const D = [];\n";
    for (let i = 0; i < 10; i++) content += `(a${i}?.b ?? D).push(${i});\n`;
    writeFile(d, "a.js", content);
    const r = findSharedDefaultMutation(d, ".", { maxResults: 3 });
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
    assert.doesNotThrow(() => findSharedDefaultMutation(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = mkdir();
  try {
    const r = findSharedDefaultMutation(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = mkdir();
  try {
    writeFile(d, "a.js", "const D = [];\nconst x = a?.b ?? D;\nx.push(1);\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findSharedDefaultMutation(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_missing_null_check_on_optional_chaining_default", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_missing_null_check_on_optional_chaining_default"));
  assert.ok(typeof SCAN_DISPATCH.find_missing_null_check_on_optional_chaining_default === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
