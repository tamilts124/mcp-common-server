"use strict";
// Tests for check_missing_rate_limit (lib/rateLimitHintOps.js)
// Rigor levels: Normal, Medium, High, Critical, Extreme.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { checkMissingRateLimit } = require("../lib/rateLimitHintOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

function tmpFile(content, ext = ".js") {
  const p = path.join(os.tmpdir(), `cmrl-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}
function tmpDir() {
  const d = path.join(os.tmpdir(), `cmrl-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d);
  return d;
}

// ── Normal ──────────────────────────────────────────────────────────────
test("flags login route with no rate-limit hint anywhere", () => {
  const f = tmpFile("app.post('/login', handler);\n");
  const r = checkMissingRateLimit(f, f);
  assert.strictEqual(r.hasAuthRoutes, true);
  assert.strictEqual(r.hasRateLimitHint, false);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_rate_limit_on_auth_routes");
  assert.strictEqual(r.findings[0].severity, "warning");
  assert.strictEqual(r.findings[0].file, null);
  assert.strictEqual(r.findings[0].authRoutes[0].routePath, "/login");
});

test("rateLimit( hint anywhere in scope suppresses the finding", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "router.post('/reset-password', handler);\n");
  fs.writeFileSync(path.join(d, "b.js"), "app.use(rateLimit({ windowMs: 60000 }));\n");
  const r = checkMissingRateLimit(d, d);
  assert.strictEqual(r.hasRateLimitHint, true);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("express-rate-limit import hint suppresses the finding", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "app.post('/register', handler);\n");
  fs.writeFileSync(path.join(d, "b.js"), "const rateLimit = require('express-rate-limit');\n");
  const r = checkMissingRateLimit(d, d);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("RateLimiterMemory hint suppresses the finding", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "app.get('/verify', handler);\n");
  fs.writeFileSync(path.join(d, "b.js"), "const limiter = new RateLimiterMemory({ points: 5 });\n");
  const r = checkMissingRateLimit(d, d);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("non-auth route is not counted as an auth route", () => {
  const f = tmpFile("app.get('/products', handler);\n");
  const r = checkMissingRateLimit(f, f);
  assert.strictEqual(r.hasAuthRoutes, false);
  assert.strictEqual(r.findingsCount, 0);
});

test("no finding when there are no route registrations at all", () => {
  const f = tmpFile("function noop() { return 1; }\n");
  const r = checkMissingRateLimit(f, f);
  assert.strictEqual(r.hasAuthRoutes, false);
  assert.strictEqual(r.findingsCount, 0);
});

test("directory aggregation lists every matched auth-route site", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "app.post('/login', h1);\n");
  fs.writeFileSync(path.join(d, "b.js"), "router.post('/forgot-password', h2);\n");
  const r = checkMissingRateLimit(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].authRoutes.length, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── Medium (boundary / validation) ─────────────────────────────────────
test("nonexistent path throws", () => {
  assert.throws(() => checkMissingRateLimit("/no/such/path/xyz.js", "/no/such/path/xyz.js"));
});

test("max_results type mismatch throws ToolError", () => {
  const f = tmpFile("app.post('/login', h);\n");
  assert.throws(() => checkMissingRateLimit(f, f, { maxResults: "five" }), /max_results must be a number/);
  fs.unlinkSync(f);
});

test("extensions type mismatch throws ToolError", () => {
  const f = tmpFile("app.post('/login', h);\n");
  assert.throws(() => checkMissingRateLimit(f, f, { extensions: "not-an-array" }), /extensions must be an array/);
  fs.unlinkSync(f);
});

test("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "app.post('/login', h);\n");
  fs.writeFileSync(path.join(d, "b.ts"), "app.post('/login', h);\n");
  const r = checkMissingRateLimit(d, d, { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── High (dependency / edge-case failure handling) ──────────────────────
test("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "bin.js"), Buffer.from([0, 1, 2, 0, 255, 0]));
  fs.writeFileSync(path.join(d, "ok.js"), "app.post('/login', h);\n");
  const r = checkMissingRateLimit(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.hasAuthRoutes, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test("nested sub-directory routes are aggregated", () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, "routes"));
  fs.writeFileSync(path.join(d, "routes", "auth.js"), "app.post('/signin', h);\n");
  const r = checkMissingRateLimit(d, d);
  assert.strictEqual(r.hasAuthRoutes, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test("direct call with cwd '.' as label works without crash", () => {
  const r = checkMissingRateLimit(process.cwd(), ".");
  assert.ok(typeof r.filesScanned === "number");
});

// ── Critical (security / sanitization) ──────────────────────────────────
test("path traversal label is echoed back but not resolved into a real traversal", () => {
  const f = tmpFile("app.post('/login', h);\n");
  const r = checkMissingRateLimit(f, "../../../etc/passwd");
  assert.strictEqual(r.path, "../../../etc/passwd");
  fs.unlinkSync(f);
});

test("shell-injection-shaped route path is only reported as text, never executed", () => {
  const f = tmpFile("app.post('/login`; rm -rf / #`', h); // $(rm -rf /)\n");
  const r = checkMissingRateLimit(f, f);
  assert.ok(Array.isArray(r.findings));
  assert.strictEqual(r.hasAuthRoutes, true);
  fs.unlinkSync(f);
});

test("result is JSON-serialisable with exact expected top-level keys", () => {
  const f = tmpFile("app.post('/login', h);\n");
  const r = checkMissingRateLimit(f, f);
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    ["path", "filesScanned", "hasAuthRoutes", "hasRateLimitHint", "findingsCount", "warningCount", "truncated", "findings"].sort()
  );
  fs.unlinkSync(f);
});

// ── Extreme (fuzzing / concurrency / limits) ─────────────────────────────
test("max_results caps the authRoutes-bearing single finding list (findingsCount stays 1)", () => {
  let src = "";
  for (let i = 0; i < 20; i++) src += `app.post('/login${i}', h);\n`;
  const f = tmpFile(src);
  const r = checkMissingRateLimit(f, f, { maxResults: 1 });
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].authRoutes.length, 20);
  fs.unlinkSync(f);
});

test("fuzz: random-byte file does not crash scan", () => {
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const f = path.join(os.tmpdir(), `cmrl-fuzz-${Date.now()}.js`);
  fs.writeFileSync(f, buf);
  assert.doesNotThrow(() => checkMissingRateLimit(f, f));
  fs.unlinkSync(f);
});

test("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  const r = checkMissingRateLimit(d, d);
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("10 concurrent scans of the same file give consistent results", () => {
  const f = tmpFile("app.post('/login', h);\napp.post('/register', h2);\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(checkMissingRateLimit(f, f));
  for (const r of results) assert.strictEqual(r.findings[0].authRoutes.length, 2);
  fs.unlinkSync(f);
});

test("execute_pipeline op-enum registration includes check_missing_rate_limit", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(src.includes('"check_missing_rate_limit"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
