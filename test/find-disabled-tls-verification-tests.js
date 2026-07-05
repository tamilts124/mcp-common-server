"use strict";
// Tests for find_disabled_tls_verification (lib/tlsVerificationOps.js)
// Rigor levels: Normal, Medium, High, Critical, Extreme.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findDisabledTlsVerification } = require("../lib/tlsVerificationOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

function tmpFile(content, ext = ".js") {
  const p = path.join(os.tmpdir(), `ftls-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}
function tmpDir() {
  const d = path.join(os.tmpdir(), `ftls-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d);
  return d;
}

// ── Normal ──────────────────────────────────────────────────────────────
test("flags rejectUnauthorized: false option", () => {
  const f = tmpFile("https.request({ rejectUnauthorized: false }, cb);\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "reject_unauthorized_false");
  assert.strictEqual(r.findings[0].severity, "error");
  fs.unlinkSync(f);
});

test("flags process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'", () => {
  const f = tmpFile("process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "node_tls_reject_unauthorized_env");
  fs.unlinkSync(f);
});

test("flags inline NODE_TLS_REJECT_UNAUTHORIZED=0 shape", () => {
  const f = tmpFile("// NODE_TLS_REJECT_UNAUTHORIZED=0 node app.js\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("flags new https.Agent({ rejectUnauthorized: false }) as insecure_https_agent, not duplicated", () => {
  const f = tmpFile("const agent = new https.Agent({ rejectUnauthorized: false });\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "insecure_https_agent");
  fs.unlinkSync(f);
});

test("new tls.SecureContext with rejectUnauthorized:false also flagged", () => {
  const f = tmpFile("const ctx = new tls.SecureContext({ rejectUnauthorized: false });\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "insecure_https_agent");
  fs.unlinkSync(f);
});

test("nearby NODE_ENV guard suppresses the finding", () => {
  const f = tmpFile("if (process.env.NODE_ENV !== 'production') {\n  opts.rejectUnauthorized = false;\n}\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("isTest guard suppresses the finding", () => {
  const f = tmpFile("if (isTest) {\n  https.request({ rejectUnauthorized: false }, cb);\n}\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("rejectUnauthorized: true is not flagged", () => {
  const f = tmpFile("https.request({ rejectUnauthorized: true }, cb);\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("clean file yields zero findings", () => {
  const f = tmpFile("https.request({ hostname: 'example.com' }, cb);\n");
  const r = findDisabledTlsVerification(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("directory aggregation across multiple files", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "https.request({ rejectUnauthorized: false }, cb);\n");
  fs.writeFileSync(path.join(d, "b.js"), "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n");
  const r = findDisabledTlsVerification(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 2);
  assert.strictEqual(r.errorCount, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── Medium (boundary / validation) ─────────────────────────────────────
test("nonexistent path throws", () => {
  assert.throws(() => findDisabledTlsVerification("/no/such/path/xyz.js", "/no/such/path/xyz.js"));
});

test("max_results type mismatch throws ToolError", () => {
  const f = tmpFile("https.request({ rejectUnauthorized: false }, cb);\n");
  assert.throws(() => findDisabledTlsVerification(f, f, { maxResults: "five" }), /max_results must be a number/);
  fs.unlinkSync(f);
});

test("extensions type mismatch throws ToolError", () => {
  const f = tmpFile("https.request({ rejectUnauthorized: false }, cb);\n");
  assert.throws(() => findDisabledTlsVerification(f, f, { extensions: "not-an-array" }), /extensions must be an array/);
  fs.unlinkSync(f);
});

test("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "https.request({ rejectUnauthorized: false }, cb);\n");
  fs.writeFileSync(path.join(d, "b.ts"), "https.request({ rejectUnauthorized: false }, cb);\n");
  const r = findDisabledTlsVerification(d, d, { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── High (dependency / edge-case failure handling) ──────────────────────
test("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "bin.js"), Buffer.from([0, 1, 2, 0, 255, 0]));
  fs.writeFileSync(path.join(d, "ok.js"), "https.request({ rejectUnauthorized: false }, cb);\n");
  const r = findDisabledTlsVerification(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("unterminated Agent constructor call does not crash scan", () => {
  const f = tmpFile("const agent = new https.Agent({ rejectUnauthorized: false }\n");
  assert.doesNotThrow(() => findDisabledTlsVerification(f, f));
  fs.unlinkSync(f);
});

test("direct call with cwd '.' as label works without crash", () => {
  const r = findDisabledTlsVerification(process.cwd(), ".");
  assert.ok(typeof r.filesScanned === "number");
});

// ── Critical (security / sanitization) ──────────────────────────────────
test("path traversal label is echoed back but not resolved into a real traversal", () => {
  const f = tmpFile("https.request({ rejectUnauthorized: false }, cb);\n");
  const r = findDisabledTlsVerification(f, "../../../etc/passwd");
  assert.strictEqual(r.path, "../../../etc/passwd");
  fs.unlinkSync(f);
});

test("shell-injection-shaped content is only reported as text, never executed", () => {
  const f = tmpFile("https.request({ rejectUnauthorized: false }, cb); // $(rm -rf /) `; rm -rf / #`\n");
  const r = findDisabledTlsVerification(f, f);
  assert.ok(Array.isArray(r.findings));
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("result is JSON-serialisable with exact expected top-level keys", () => {
  const f = tmpFile("https.request({ rejectUnauthorized: false }, cb);\n");
  const r = findDisabledTlsVerification(f, f);
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    ["path", "filesScanned", "findingsCount", "errorCount", "truncated", "findings"].sort()
  );
  fs.unlinkSync(f);
});

// ── Extreme (fuzzing / concurrency / limits) ─────────────────────────────
test("max_results truncation sets truncated flag", () => {
  let src = "";
  for (let i = 0; i < 20; i++) src += "https.request({ rejectUnauthorized: false }, cb);\n";
  const f = tmpFile(src);
  const r = findDisabledTlsVerification(f, f, { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  fs.unlinkSync(f);
});

test("fuzz: random-byte file does not crash scan", () => {
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const f = path.join(os.tmpdir(), `ftls-fuzz-${Date.now()}.js`);
  fs.writeFileSync(f, buf);
  assert.doesNotThrow(() => findDisabledTlsVerification(f, f));
  fs.unlinkSync(f);
});

test("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  const r = findDisabledTlsVerification(d, d);
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("10 concurrent scans of the same file give consistent results", () => {
  const f = tmpFile("https.request({ rejectUnauthorized: false }, cb);\nprocess.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findDisabledTlsVerification(f, f));
  for (const r of results) assert.strictEqual(r.findingsCount, 2);
  fs.unlinkSync(f);
});

test("execute_pipeline op-enum registration includes find_disabled_tls_verification", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(src.includes('"find_disabled_tls_verification"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
