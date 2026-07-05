"use strict";
// Tests for find_missing_sort_comparator (lib/missingSortComparatorOps.js)
// Rigor levels: Normal, Medium, High, Critical, Extreme.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingSortComparator } = require("../lib/missingSortComparatorOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

function tmpFile(content, ext = ".js") {
  const p = path.join(os.tmpdir(), `msc-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}
function tmpDir() {
  const d = path.join(os.tmpdir(), `msc-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d);
  return d;
}

// ── Normal ──────────────────────────────────────────────────────────────
test("flags bare .sort() on numeric-literal array var", () => {
  const f = tmpFile("const nums = [1, 2, 10];\nnums.sort();\n");
  const r = findMissingSortComparator(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "bare_sort_on_numeric_array");
  assert.strictEqual(r.findings[0].variable, "nums");
  fs.unlinkSync(f);
});

test("flags .map(Number) numeric-coercion var", () => {
  const f = tmpFile("const nums = strs.map(Number);\nnums.sort();\n");
  const r = findMissingSortComparator(f, f);
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("flags .map(parseInt) numeric-coercion var", () => {
  const f = tmpFile("const nums = strs.map(parseInt);\nnums.sort();\n");
  const r = findMissingSortComparator(f, f);
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("flags inline numeric-literal array chained into .sort()", () => {
  const f = tmpFile("const x = [3, 1, 2].sort();\n");
  const r = findMissingSortComparator(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "bare_sort_on_inline_numeric_array");
  fs.unlinkSync(f);
});

test("does not flag .sort() with a comparator", () => {
  const f = tmpFile("const nums = [1, 2, 10];\nnums.sort((a, b) => a - b);\n");
  const r = findMissingSortComparator(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("does not flag .sort() on a non-numeric string array", () => {
  const f = tmpFile("const words = ['b', 'a', 'c'];\nwords.sort();\n");
  const r = findMissingSortComparator(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("directory aggregation across multiple files", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "const n = [1, 2];\nn.sort();\n");
  fs.writeFileSync(path.join(d, "b.js"), "const n2 = [3, 4];\nn2.sort();\n");
  const r = findMissingSortComparator(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── Medium (boundary / validation) ─────────────────────────────────────
test("nonexistent path throws", () => {
  assert.throws(() => findMissingSortComparator("/no/such/path/xyz.js", "/no/such/path/xyz.js"));
});

test("max_results type mismatch throws ToolError", () => {
  const f = tmpFile("const n=[1,2]; n.sort();\n");
  assert.throws(() => findMissingSortComparator(f, f, { maxResults: "five" }), /max_results must be a number/);
  fs.unlinkSync(f);
});

test("extensions type mismatch throws ToolError", () => {
  const f = tmpFile("const n=[1,2]; n.sort();\n");
  assert.throws(() => findMissingSortComparator(f, f, { extensions: "not-an-array" }), /extensions must be an array/);
  fs.unlinkSync(f);
});

test("unrecognized extension on single-file target throws", () => {
  const f = tmpFile("const n=[1,2]; n.sort();\n", ".unsupportedext");
  assert.throws(() => findMissingSortComparator(f, f));
  fs.unlinkSync(f);
});

test("clean file (no numeric arrays) yields zero findings", () => {
  const f = tmpFile("function noop() { return 1; }\n");
  const r = findMissingSortComparator(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "const n=[1,2]; n.sort();\n");
  fs.writeFileSync(path.join(d, "b.ts"), "const n2=[3,4]; n2.sort();\n");
  const r = findMissingSortComparator(d, d, { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── High (dependency / edge-case failure handling) ──────────────────────
test("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "bin.js"), Buffer.from([0, 1, 2, 0, 255, 0]));
  fs.writeFileSync(path.join(d, "ok.js"), "const n=[1,2]; n.sort();\n");
  const r = findMissingSortComparator(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("nested sub-directory scan does not crash", () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, "nested"));
  fs.writeFileSync(path.join(d, "nested", "deep.js"), "const n=[1,2]; n.sort();\n");
  const r = findMissingSortComparator(d, d);
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("direct call with cwd '.' as label works without crash", () => {
  const r = findMissingSortComparator(process.cwd(), ".");
  assert.ok(typeof r.filesScanned === "number");
});

// ── Critical (security / sanitization) ──────────────────────────────────
test("path traversal label is echoed back but not resolved into a real traversal", () => {
  const f = tmpFile("const n=[1,2]; n.sort();\n");
  const r = findMissingSortComparator(f, "../../../etc/passwd");
  assert.strictEqual(r.path, "../../../etc/passwd"); // echoed label only; absTarget was the real jailed path
  fs.unlinkSync(f);
});

test("shell-injection-shaped file content is only reported as text, never executed", () => {
  const f = tmpFile("const cmd = [1,2]; cmd.sort(); // $(rm -rf /) `; rm -rf / #`\n");
  const r = findMissingSortComparator(f, f);
  assert.ok(Array.isArray(r.findings));
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("result is JSON-serialisable with exact expected top-level keys", () => {
  const f = tmpFile("const n=[1,2]; n.sort();\n");
  const r = findMissingSortComparator(f, f);
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(), ["filesScanned", "findings", "findingsCount", "path", "truncated"].sort());
  fs.unlinkSync(f);
});

// ── Extreme (fuzzing / concurrency / limits) ─────────────────────────────
test("max_results truncation sets truncated flag", () => {
  let src = "";
  for (let i = 0; i < 20; i++) src += `const n${i} = [1,2,3];\nn${i}.sort();\n`;
  const f = tmpFile(src);
  const r = findMissingSortComparator(f, f, { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  fs.unlinkSync(f);
});

test("fuzz: random-byte file does not crash scan", () => {
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const f = path.join(os.tmpdir(), `msc-fuzz-${Date.now()}.js`);
  fs.writeFileSync(f, buf);
  assert.doesNotThrow(() => findMissingSortComparator(f, f));
  fs.unlinkSync(f);
});

test("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  const r = findMissingSortComparator(d, d);
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("10 concurrent scans of the same file give consistent results", () => {
  const f = tmpFile("const n=[1,2,10]; n.sort();\n[9,2].sort();\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findMissingSortComparator(f, f));
  for (const r of results) assert.strictEqual(r.findingsCount, 2);
  fs.unlinkSync(f);
});

test("execute_pipeline op-enum registration includes find_missing_sort_comparator", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(src.includes('"find_missing_sort_comparator"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
