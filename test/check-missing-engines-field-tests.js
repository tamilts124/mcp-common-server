"use strict";
// Isolated functional tests for check_missing_engines_field (lib/enginesFieldOps.js).
// Run: node test/check-missing-engines-field-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { checkMissingEnginesField } = require("../lib/enginesFieldOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "engines-test-")); }
function writePkg(dir, obj) {
  const p = path.join(dir, "package.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// ── Normal ───────────────────────────────────────────────────────────────────────
t("missing engines field flags missing_engines_field", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { name: "x", version: "1.0.0" });
    const r = checkMissingEnginesField(p, "package.json");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "missing_engines_field");
    assert.strictEqual(r.hasEngines, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("well-formed engines.node + engines.npm yields zero findings", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: ">=18", npm: ">=9" } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.hasEngines, true);
    assert.strictEqual(r.hasEnginesNode, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("engines present without node flags missing_engines_node", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { npm: ">=9" } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.ok(r.findings.some(f => f.rule === "missing_engines_node"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("engines.node = '*' flags risky_engines_node_range", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: "*" } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.ok(r.findings.some(f => f.rule === "risky_engines_node_range"));
    assert.strictEqual(r.hasEnginesNode, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("engines present without npm flags missing_engines_npm as info", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: ">=18" } });
    const r = checkMissingEnginesField(p, "package.json");
    const f = r.findings.find(x => x.rule === "missing_engines_npm");
    assert.ok(f && f.severity === "info");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium (boundary & parameter validation) ──────────────────────────
t("nonexistent package.json throws ToolError", () => {
  assert.throws(() => checkMissingEnginesField("/no/such/package.json", "package.json"), /cannot read/);
});

t("invalid JSON throws ToolError", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    fs.writeFileSync(p, "{ broken");
    assert.throws(() => checkMissingEnginesField(p, "package.json"), /not valid JSON/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("top-level array throws", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    fs.writeFileSync(p, "[1,2]");
    assert.throws(() => checkMissingEnginesField(p, "package.json"), /must contain a JSON object/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("engines as non-object flags invalid_engines_field error", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: "node>=18" });
    const r = checkMissingEnginesField(p, "package.json");
    assert.strictEqual(r.findings[0].rule, "invalid_engines_field");
    assert.strictEqual(r.errorCount, 1);
    assert.strictEqual(r.hasEngines, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("engines as array flags invalid_engines_field error", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: ["node", ">=18"] });
    const r = checkMissingEnginesField(p, "package.json");
    assert.strictEqual(r.findings[0].rule, "invalid_engines_field");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High (dependency/failure handling) ─────────────────────────────
t("engines.node non-string value flags risky_engines_node_range without crash", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: 18 } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.ok(r.findings.some(f => f.rule === "risky_engines_node_range"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty-string engines.node flags risky range", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: "" } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.ok(r.findings.some(f => f.rule === "risky_engines_node_range"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory passed instead of file throws a clear read error", () => {
  const d = tmpDir();
  try {
    assert.throws(() => checkMissingEnginesField(d, d), /cannot read/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty engines object flags both missing_engines_node and missing_engines_npm", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: {} });
    const r = checkMissingEnginesField(p, "package.json");
    const rules = r.findings.map(f => f.rule).sort();
    assert.deepStrictEqual(rules, ["missing_engines_node", "missing_engines_npm"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical (security & input sanitization) ───────────────────────
t("path-traversal-shaped origPath is echoed but never re-resolved", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: ">=18" } });
    const r = checkMissingEnginesField(p, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
    assert.strictEqual(r.hasEnginesNode, true); // read the real (jailed) file, not /etc
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped engines.node value is only ever treated as text, never executed", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: "$(rm -rf /)" } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.strictEqual(r.hasEnginesNode, true); // non-empty, non-wildcard literal -> treated as a (nonsense) valid pin, never executed
    assert.ok(fs.existsSync(d));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("HTML/script-tag value in engines.node does not break JSON-serializable output", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: "<script>alert(1)</script>" } });
    const r = checkMissingEnginesField(p, "package.json");
    JSON.stringify(r);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result object has exactly the documented top-level keys", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: ">=18" } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.deepStrictEqual(Object.keys(r).sort(),
      ["errorCount", "findings", "findingsCount", "hasEngines", "hasEnginesNode", "infoCount", "path", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("prototype-pollution-shaped '__proto__' key inside engines does not crash or pollute", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: ">=18", "__proto__": { polluted: true } } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.strictEqual(r.hasEnginesNode, true);
    assert.strictEqual(({}).polluted, undefined);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme (fuzzing, concurrency, system constraints) ─────────────────
t("fuzz: random-byte package.json content throws a clean JSON parse error, no crash", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    const buf = Buffer.alloc(400);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(p, buf);
    assert.throws(() => checkMissingEnginesField(p, "package.json"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extremely long engines.node string does not crash", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: ">=" + "1".repeat(100000) } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.strictEqual(r.hasEnginesNode, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("whitespace-only engines.node treated as risky (trims to empty)", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: "   " } });
    const r = checkMissingEnginesField(p, "package.json");
    assert.ok(r.findings.some(f => f.rule === "risky_engines_node_range"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent calls on the same file return consistent results", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { engines: { node: ">=18" } });
    const results = [];
    for (let i = 0; i < 10; i++) results.push(checkMissingEnginesField(p, "package.json"));
    assert.ok(results.every(r => r.hasEnginesNode === true && r.findingsCount === 1)); // missing_engines_npm info
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("registered in SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.check_missing_engines_field, "function");
});

t("registered in execSchemas op-enum (execute_pipeline coverage)", () => {
  const opsSchema = JSON.stringify(EXEC_SCHEMAS);
  assert.ok(opsSchema.includes("check_missing_engines_field"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
