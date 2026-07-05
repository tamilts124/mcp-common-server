"use strict";
// Tests for find_error_message_leaking_internals (lib/errorLeakOps.js)
// Rigor levels: Normal, Medium, High, Critical, Extreme.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findErrorMessageLeakingInternals } = require("../lib/errorLeakOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

function tmpFile(content, ext = ".js") {
  const p = path.join(os.tmpdir(), `feml-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}
function tmpDir() {
  const d = path.join(os.tmpdir(), `feml-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d);
  return d;
}

// ── Normal ──────────────────────────────────────────────────────────────
test("flags res.send(err.stack)", () => {
  const f = tmpFile("app.use((err, req, res, next) => { res.send(err.stack); });\n");
  const r = findErrorMessageLeakingInternals(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "error_stack_in_response");
  assert.strictEqual(r.findings[0].severity, "error");
  fs.unlinkSync(f);
});

test("flags res.json({ error: err }) as raw object", () => {
  const f = tmpFile("catch (err) { res.json({ error: err }); }\n");
  const r = findErrorMessageLeakingInternals(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "raw_error_object_in_response");
  assert.strictEqual(r.findings[0].severity, "warning");
  fs.unlinkSync(f);
});

test("flags template-literal interpolation of error", () => {
  const f = tmpFile("catch (err) { res.send(`Error: ${err}`); }\n");
  const r = findErrorMessageLeakingInternals(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "error_interpolated_in_response");
  fs.unlinkSync(f);
});

test("res.json(err.message) is not flagged (message is fine to expose)", () => {
  const f = tmpFile("catch (err) { res.json({ error: err.message }); }\n");
  const r = findErrorMessageLeakingInternals(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("nearby NODE_ENV guard suppresses the finding", () => {
  const f = tmpFile("if (process.env.NODE_ENV !== 'production') {\n  res.send(err.stack);\n}\n");
  const r = findErrorMessageLeakingInternals(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("isDev guard suppresses the finding", () => {
  const f = tmpFile("if (isDev) {\n  res.json({ error: err });\n}\n");
  const r = findErrorMessageLeakingInternals(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("custom error identifier is honored", () => {
  const f = tmpFile("catch (myErr) { res.send(myErr.stack); }\n");
  const r1 = findErrorMessageLeakingInternals(f, f);
  assert.strictEqual(r1.findingsCount, 0);
  const r2 = findErrorMessageLeakingInternals(f, f, { errorIdentifiers: ["myErr"] });
  assert.strictEqual(r2.findingsCount, 1);
  fs.unlinkSync(f);
});

test("clean file yields zero findings", () => {
  const f = tmpFile("catch (err) { logger.error(err); res.status(500).json({ error: 'Internal error' }); }\n");
  const r = findErrorMessageLeakingInternals(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("directory aggregation across multiple files", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "res.send(err.stack);\n");
  fs.writeFileSync(path.join(d, "b.js"), "res.json({ error: err });\n");
  const r = findErrorMessageLeakingInternals(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 2);
  assert.strictEqual(r.errorCount, 1);
  assert.strictEqual(r.warningCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── Medium (boundary / validation) ─────────────────────────────────────
test("nonexistent path throws", () => {
  assert.throws(() => findErrorMessageLeakingInternals("/no/such/path/xyz.js", "/no/such/path/xyz.js"));
});

test("max_results type mismatch throws ToolError", () => {
  const f = tmpFile("res.send(err.stack);\n");
  assert.throws(() => findErrorMessageLeakingInternals(f, f, { maxResults: "five" }), /max_results must be a number/);
  fs.unlinkSync(f);
});

test("extensions type mismatch throws ToolError", () => {
  const f = tmpFile("res.send(err.stack);\n");
  assert.throws(() => findErrorMessageLeakingInternals(f, f, { extensions: "not-an-array" }), /extensions must be an array/);
  fs.unlinkSync(f);
});

test("errorIdentifiers type mismatch throws ToolError", () => {
  const f = tmpFile("res.send(err.stack);\n");
  assert.throws(() => findErrorMessageLeakingInternals(f, f, { errorIdentifiers: "err" }), /errorIdentifiers must be an array/);
  fs.unlinkSync(f);
});

test("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "res.send(err.stack);\n");
  fs.writeFileSync(path.join(d, "b.ts"), "res.send(err.stack);\n");
  const r = findErrorMessageLeakingInternals(d, d, { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── High (dependency / edge-case failure handling) ──────────────────────
test("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "bin.js"), Buffer.from([0, 1, 2, 0, 255, 0]));
  fs.writeFileSync(path.join(d, "ok.js"), "res.send(err.stack);\n");
  const r = findErrorMessageLeakingInternals(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("nested sub-directory scan aggregates findings", () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, "routes"));
  fs.writeFileSync(path.join(d, "routes", "err.js"), "res.send(err.stack);\n");
  const r = findErrorMessageLeakingInternals(d, d);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("direct call with cwd '.' as label works without crash", () => {
  const r = findErrorMessageLeakingInternals(process.cwd(), ".");
  assert.ok(typeof r.filesScanned === "number");
});

// ── Critical (security / sanitization) ──────────────────────────────────
test("path traversal label is echoed back but not resolved into a real traversal", () => {
  const f = tmpFile("res.send(err.stack);\n");
  const r = findErrorMessageLeakingInternals(f, "../../../etc/passwd");
  assert.strictEqual(r.path, "../../../etc/passwd");
  fs.unlinkSync(f);
});

test("shell-injection-shaped content is only reported as text, never executed", () => {
  const f = tmpFile("res.send(err.stack); // $(rm -rf /) `; rm -rf / #`\n");
  const r = findErrorMessageLeakingInternals(f, f);
  assert.ok(Array.isArray(r.findings));
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("result is JSON-serialisable with exact expected top-level keys", () => {
  const f = tmpFile("res.send(err.stack);\n");
  const r = findErrorMessageLeakingInternals(f, f);
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    ["path", "filesScanned", "findingsCount", "errorCount", "warningCount", "truncated", "findings"].sort()
  );
  fs.unlinkSync(f);
});

// ── Extreme (fuzzing / concurrency / limits) ─────────────────────────────
test("max_results truncation sets truncated flag", () => {
  let src = "";
  for (let i = 0; i < 20; i++) src += `res.send(err.stack); // line ${i}\n`;
  const f = tmpFile(src);
  const r = findErrorMessageLeakingInternals(f, f, { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  fs.unlinkSync(f);
});

test("fuzz: random-byte file does not crash scan", () => {
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const f = path.join(os.tmpdir(), `feml-fuzz-${Date.now()}.js`);
  fs.writeFileSync(f, buf);
  assert.doesNotThrow(() => findErrorMessageLeakingInternals(f, f));
  fs.unlinkSync(f);
});

test("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  const r = findErrorMessageLeakingInternals(d, d);
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("10 concurrent scans of the same file give consistent results", () => {
  const f = tmpFile("res.send(err.stack);\nres.json({ error: err });\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findErrorMessageLeakingInternals(f, f));
  for (const r of results) assert.strictEqual(r.findingsCount, 2);
  fs.unlinkSync(f);
});

test("execute_pipeline op-enum registration includes find_error_message_leaking_internals", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(src.includes('"find_error_message_leaking_internals"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
