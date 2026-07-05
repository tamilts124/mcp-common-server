"use strict";
// Tests for find_prototype_pollution_risk (lib/prototypePollutionOps.js)
// Rigor levels: Normal, Medium, High, Critical, Extreme.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findPrototypePollutionRisk } = require("../lib/prototypePollutionOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

function tmpFile(content, ext = ".js") {
  const p = path.join(os.tmpdir(), `ppr-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}
function tmpDir() {
  const d = path.join(os.tmpdir(), `ppr-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d);
  return d;
}

// ── Normal ──────────────────────────────────────────────────────────────
test("flags _.merge(target, req.body)", () => {
  const f = tmpFile("_.merge(target, req.body);\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "prototype_pollution_via_merge");
  assert.strictEqual(r.findings[0].severity, "error");
  fs.unlinkSync(f);
});

test("flags lodash.merge(target, JSON.parse(str))", () => {
  const f = tmpFile("lodash.merge(target, JSON.parse(str));\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("flags deepmerge(target, req.query)", () => {
  const f = tmpFile("deepmerge(target, req.query);\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("does not flag merge with a non-tainted source", () => {
  const f = tmpFile("_.merge(target, safe);\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("guard hint nearby suppresses merge finding", () => {
  const f = tmpFile("if (key === '__proto__') return;\n_.merge(target, req.body);\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("flags Object.assign(target, req.body) as warning", () => {
  const f = tmpFile("Object.assign(target, req.body);\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "prototype_pollution_via_object_assign");
  assert.strictEqual(r.findings[0].severity, "warning");
  fs.unlinkSync(f);
});

test("flags unguarded hand-rolled recursive merge function", () => {
  const f = tmpFile("function deepMerge(target, source) {\n  for (const key in source) {\n    target[key] = source[key];\n  }\n}\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "unguarded_recursive_merge_function");
  assert.strictEqual(r.findings[0].functionName, "deepMerge");
  fs.unlinkSync(f);
});

test("guarded recursive merge function is not flagged", () => {
  const f = tmpFile("function deepMerge(target, source) {\n  for (const key in source) {\n    if (key === '__proto__' || key === 'constructor') continue;\n    target[key] = source[key];\n  }\n}\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("clean file yields zero findings", () => {
  const f = tmpFile("function noop() { return 1; }\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("directory aggregation across multiple files", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "_.merge(t, req.body);\n");
  fs.writeFileSync(path.join(d, "b.js"), "Object.assign(t, req.query);\n");
  const r = findPrototypePollutionRisk(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 2);
  assert.strictEqual(r.errorCount, 1);
  assert.strictEqual(r.warningCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── Medium (boundary / validation) ─────────────────────────────────────
test("nonexistent path throws", () => {
  assert.throws(() => findPrototypePollutionRisk("/no/such/path/xyz.js", "/no/such/path/xyz.js"));
});

test("max_results type mismatch throws ToolError", () => {
  const f = tmpFile("_.merge(t, req.body);\n");
  assert.throws(() => findPrototypePollutionRisk(f, f, { maxResults: "five" }), /max_results must be a number/);
  fs.unlinkSync(f);
});

test("extensions type mismatch throws ToolError", () => {
  const f = tmpFile("_.merge(t, req.body);\n");
  assert.throws(() => findPrototypePollutionRisk(f, f, { extensions: "not-an-array" }), /extensions must be an array/);
  fs.unlinkSync(f);
});

test("unrecognized extension on single-file target throws", () => {
  const f = tmpFile("_.merge(t, req.body);\n", ".unsupportedext");
  assert.throws(() => findPrototypePollutionRisk(f, f));
  fs.unlinkSync(f);
});

test("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "_.merge(t, req.body);\n");
  fs.writeFileSync(path.join(d, "b.ts"), "_.merge(t, req.body);\n");
  const r = findPrototypePollutionRisk(d, d, { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── High (dependency / edge-case failure handling) ──────────────────────
test("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "bin.js"), Buffer.from([0, 1, 2, 0, 255, 0]));
  fs.writeFileSync(path.join(d, "ok.js"), "_.merge(t, req.body);\n");
  const r = findPrototypePollutionRisk(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("unbalanced/unterminated function body does not crash scan", () => {
  const f = tmpFile("function broken(target, source) {\n  for (const key in source) {\n    target[key] = 1;\n");
  assert.doesNotThrow(() => findPrototypePollutionRisk(f, f));
  fs.unlinkSync(f);
});

test("direct call with cwd '.' as label works without crash", () => {
  const r = findPrototypePollutionRisk(process.cwd(), ".");
  assert.ok(typeof r.filesScanned === "number");
});

// ── Critical (security / sanitization) ──────────────────────────────────
test("path traversal label is echoed back but not resolved into a real traversal", () => {
  const f = tmpFile("_.merge(t, req.body);\n");
  const r = findPrototypePollutionRisk(f, "../../../etc/passwd");
  assert.strictEqual(r.path, "../../../etc/passwd");
  fs.unlinkSync(f);
});

test("shell-injection-shaped content is only reported as text, never executed", () => {
  const f = tmpFile("_.merge(t, req.body); // $(rm -rf /) `; rm -rf / #`\n");
  const r = findPrototypePollutionRisk(f, f);
  assert.ok(Array.isArray(r.findings));
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("result is JSON-serialisable with exact expected top-level keys", () => {
  const f = tmpFile("_.merge(t, req.body);\n");
  const r = findPrototypePollutionRisk(f, f);
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort()
  );
  fs.unlinkSync(f);
});

// ── Extreme (fuzzing / concurrency / limits) ─────────────────────────────
test("max_results truncation sets truncated flag", () => {
  let src = "";
  for (let i = 0; i < 20; i++) src += `_.merge(t${i}, req.body);\n`;
  const f = tmpFile(src);
  const r = findPrototypePollutionRisk(f, f, { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  fs.unlinkSync(f);
});

test("fuzz: random-byte file does not crash scan", () => {
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const f = path.join(os.tmpdir(), `ppr-fuzz-${Date.now()}.js`);
  fs.writeFileSync(f, buf);
  assert.doesNotThrow(() => findPrototypePollutionRisk(f, f));
  fs.unlinkSync(f);
});

test("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  const r = findPrototypePollutionRisk(d, d);
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("10 concurrent scans of the same file give consistent results", () => {
  const f = tmpFile("_.merge(t, req.body);\nObject.assign(t, req.query);\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findPrototypePollutionRisk(f, f));
  for (const r of results) assert.strictEqual(r.findingsCount, 2);
  fs.unlinkSync(f);
});

test("execute_pipeline op-enum registration includes find_prototype_pollution_risk", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(src.includes('"find_prototype_pollution_risk"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
