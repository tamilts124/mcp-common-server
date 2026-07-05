"use strict";
// Isolated functional tests for check_missing_helmet_security_headers (lib/helmetSecurityHeadersOps.js).
// Run: node test/check-missing-helmet-security-headers-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { checkMissingHelmetSecurityHeaders } = require("../lib/helmetSecurityHeadersOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "helmet-headers-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags missing_security_headers when routes exist with no hint", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req, res) => res.send('ok'));\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    assert.strictEqual(r.hasRouteRegistrations, true);
    assert.strictEqual(r.hasSecurityHeaderHint, false);
    assert.ok(r.findings.some(f => f.rule === "missing_security_headers"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("helmet() call suppresses missing_security_headers", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.use(helmet());\napp.get('/x', (req, res) => res.send('ok'));\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    assert.strictEqual(r.hasSecurityHeaderHint, true);
    assert.ok(!r.findings.some(f => f.rule === "missing_security_headers"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("manual literal header string suppresses missing_security_headers", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "res.setHeader('X-Frame-Options', 'DENY');\napp.get('/x', (req, res) => res.send('ok'));\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    assert.strictEqual(r.hasSecurityHeaderHint, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("each disabled helmet module is flagged individually", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.use(helmet({ frameguard: false, hsts: false }));\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    const rules = r.findings.filter(f => f.rule === "helmet_module_explicitly_disabled");
    assert.strictEqual(rules.length, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no route registrations at all yields no missing_security_headers finding", () => {
  const d = tmpDir();
  try {
    writeFile(d, "util.js", "function add(a,b){return a+b;}\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory aggregation lists disabled-module findings from multiple files", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "app.use(helmet({ noSniff: false }));\n");
    writeFile(d, "b.js", "app.get('/y', (req,res) => res.send('ok'));\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    assert.ok(r.findings.some(f => f.file === "a.js" && f.rule === "helmet_module_explicitly_disabled"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => checkMissingHelmetSecurityHeaders("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => checkMissingHelmetSecurityHeaders(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => checkMissingHelmetSecurityHeaders(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    writeFile(d, "notes.md", "app.get fake mention\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    const bin = Buffer.from([0, 1, 2, 3, 0, 5]);
    fs.writeFileSync(path.join(d, "blob.js"), bin);
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    assert.doesNotThrow(() => checkMissingHelmetSecurityHeaders(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("nested sub-dir route detection", () => {
  const d = tmpDir();
  try {
    writeFile(d, "routes/nested.js", "router.post('/z', (req,res)=>res.send('ok'));\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    assert.strictEqual(r.hasRouteRegistrations, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'.' label direct call works without crash", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingHelmetSecurityHeaders(f, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingHelmetSecurityHeaders(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped route path text only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x; rm -rf /', (req,res)=>res.send('ok'));\n");
    assert.doesNotThrow(() => checkMissingHelmetSecurityHeaders(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["errorCount", "filesScanned", "findings", "findingsCount", "hasRouteRegistrations", "hasSecurityHeaderHint", "path", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "app.use(helmet({";
    for (let i = 0; i < 6; i++) content += (i ? ", " : "") + `frameguard: false`;
    content += " }));\n";
    // 6 identical disabled-module matches won't dedupe since regex has global flag over one string
    const f = writeFile(d, "app.js", content);
    const r = checkMissingHelmetSecurityHeaders(f, "app.js", { maxResults: 2 });
    assert.strictEqual(r.truncated, r.findingsCount > 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fuzz: random-byte file does not crash scan", () => {
  const d = tmpDir();
  try {
    const buf = Buffer.alloc(2000);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    const f = path.join(d, "app.js");
    fs.writeFileSync(f, buf);
    assert.doesNotThrow(() => checkMissingHelmetSecurityHeaders(f, "app.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = checkMissingHelmetSecurityHeaders(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(checkMissingHelmetSecurityHeaders(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes check_missing_helmet_security_headers", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("check_missing_helmet_security_headers"));
  assert.ok(typeof SCAN_DISPATCH.check_missing_helmet_security_headers === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
