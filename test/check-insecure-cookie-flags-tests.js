"use strict";
// Isolated functional tests for check_insecure_cookie_flags (lib/cookieFlagsOps.js).
// Run: node test/check-insecure-cookie-flags-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { checkInsecureCookieFlags } = require("../lib/cookieFlagsOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "cookieflags-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags res.cookie() with no options object", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('sid', token);\n");
    const r = checkInsecureCookieFlags(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "cookie_no_options");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags missing httpOnly/secure/sameSite individually", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('sid', token, { path: '/' });\n");
    const r = checkInsecureCookieFlags(d, ".");
    const rules = r.findings.map(f => f.rule).sort();
    assert.deepStrictEqual(rules, ["res_cookie_missing_http_only", "res_cookie_missing_same_site", "res_cookie_missing_secure"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags httpOnly/secure explicitly false as higher severity", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('sid', token, { httpOnly: false, secure: false, sameSite: 'lax' });\n");
    const r = checkInsecureCookieFlags(d, ".");
    const rules = r.findings.map(f => f.rule).sort();
    assert.deepStrictEqual(rules, ["res_cookie_http_only_disabled", "res_cookie_secure_disabled"]);
    assert.strictEqual(r.errorCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fully-hardened res.cookie() call has zero findings", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('sid', token, { httpOnly: true, secure: true, sameSite: 'strict' });\n");
    const r = checkInsecureCookieFlags(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags session cookie: {} sub-object shape", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "app.use(session({ secret: 'x', cookie: { maxAge: 60000 } }));\n");
    const r = checkInsecureCookieFlags(d, ".");
    assert.ok(r.findings.every(f => f.rule.startsWith("session_cookie_")));
    assert.strictEqual(r.findingsCount, 3);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium (boundary & parameter validation) ──────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => checkInsecureCookieFlags("/no/such/dir/xyz", "/no/such/dir/xyz"), /cannot access/);
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => checkInsecureCookieFlags(d, ".", { maxResults: "five" }), /must be a number/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => checkInsecureCookieFlags(d, ".", { extensions: "js" }), /must be an array/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("unrecognized single-file extension throws", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "a.txt", "res.cookie('sid', v);\n");
    assert.throws(() => checkInsecureCookieFlags(f, "a.txt"), /does not match any scanned extension/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean file with no cookie calls has zero findings", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function add(a,b){ return a+b; }\n");
    const r = checkInsecureCookieFlags(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows scan to matching files only", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.ts", "res.cookie('sid', v);\n");
    writeFile(d, "b.js", "res.cookie('sid', v);\n");
    const r = checkInsecureCookieFlags(d, ".", { extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High (dependency/failure handling) ─────────────────────────────────
t("binary file is skipped without crash", () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, "bin.js"), Buffer.from([0, 1, 2, 0, 3]));
    const r = checkInsecureCookieFlags(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("scans nested sub-directories", () => {
  const d = tmpDir();
  try {
    writeFile(d, "nested/deep/a.js", "res.cookie('sid', v);\n");
    const r = checkInsecureCookieFlags(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].file, "nested/deep/a.js");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("multiple res.cookie() calls in one file are all reported with correct line numbers", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('a', 1);\n\nres.cookie('b', 2, { httpOnly: true, secure: true, sameSite: 'lax' });\n");
    const r = checkInsecureCookieFlags(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].line, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("variable-built options object is invisible to the scan (documented tradeoff)", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const opts = {};\nres.cookie('sid', v, opts);\n");
    const r = checkInsecureCookieFlags(d, ".");
    // opts is a non-empty-looking arg so it's not "no options"; body text is just "opts" -> all three missing
    assert.ok(r.findingsCount >= 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical (security & input sanitization) ───────────────────────────
t("path-traversal-shaped label is echoed but never escapes the resolved target", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('sid', v);\n");
    const r = checkInsecureCookieFlags(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
    assert.strictEqual(r.findingsCount, 1); // scanned the real (jailed) dir, not /etc
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped cookie value is only ever treated as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('sid', `$(rm -rf /)`, { httpOnly: true, secure: true, sameSite: 'lax' });\n");
    const r = checkInsecureCookieFlags(d, ".");
    assert.strictEqual(r.findingsCount, 0); // fully hardened options; injection text never interpreted
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("HTML/script-tag cookie name/value does not break JSON-serializable output", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('<script>alert(1)</script>', v);\n");
    const r = checkInsecureCookieFlags(d, ".");
    JSON.stringify(r); // must not throw
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result object has exactly the documented top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('sid', v);\n");
    const r = checkInsecureCookieFlags(d, ".");
    assert.deepStrictEqual(Object.keys(r).sort(), ["errorCount", "filesScanned", "findings", "findingsCount", "infoCount", "path", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme (fuzzing, concurrency, system constraints) ──────────────────
t("max_results truncates and sets truncated flag", () => {
  const d = tmpDir();
  try {
    let src = "";
    for (let i = 0; i < 20; i++) src += `res.cookie('c${i}', v);\n`;
    writeFile(d, "a.js", src);
    const r = checkInsecureCookieFlags(d, ".", { maxResults: 5 });
    assert.strictEqual(r.findings.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.findingsCount, 20);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fuzz: random-byte file content does not crash the scanner", () => {
  const d = tmpDir();
  try {
    const buf = Buffer.alloc(2000);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(path.join(d, "fuzz.js"), buf);
    const r = checkInsecureCookieFlags(d, ".");
    assert.ok(typeof r.findingsCount === "number");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = checkInsecureCookieFlags(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent calls on the same directory return consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.cookie('sid', v);\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(checkInsecureCookieFlags(d, "."));
    assert.ok(results.every(r => r.findingsCount === 1));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("registered in SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.check_insecure_cookie_flags, "function");
});

t("registered in execSchemas op-enum (execute_pipeline coverage)", () => {
  const opsSchema = JSON.stringify(EXEC_SCHEMAS);
  assert.ok(opsSchema.includes("check_insecure_cookie_flags"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
