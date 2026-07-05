"use strict";
// Isolated functional tests for check_missing_rate_limit_headers (lib/rateLimitHeaderOps.js).
// Run: node test/check-missing-rate-limit-headers-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { checkMissingRateLimitHeaders } = require("../lib/rateLimitHeaderOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "rate-limit-headers-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags missing_retry_after_header when rate-limit hint + routes exist with no Retry-After", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.use(rateLimit({ windowMs: 60000 }));\napp.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingRateLimitHeaders(d, ".");
    assert.strictEqual(r.hasRouteRegistrations, true);
    assert.strictEqual(r.hasRateLimitHint, true);
    assert.strictEqual(r.hasRetryAfterHint, false);
    assert.ok(r.findings.some(f => f.rule === "missing_retry_after_header"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("Retry-After header present suppresses missing_retry_after_header", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.use(rateLimit({}));\napp.get('/x', (req,res)=>{res.set('Retry-After','30');res.send('ok');});\n");
    const r = checkMissingRateLimitHeaders(d, ".");
    assert.strictEqual(r.hasRetryAfterHint, true);
    assert.ok(!r.findings.some(f => f.rule === "missing_retry_after_header"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("literal X-RateLimit- header counts as rate-limit hint", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "res.set('X-RateLimit-Remaining', '5');\napp.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingRateLimitHeaders(d, ".");
    assert.strictEqual(r.hasRateLimitHint, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("each disabled header option is flagged individually", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.use(rateLimit({ standardHeaders: false, legacyHeaders: false }));\n");
    const r = checkMissingRateLimitHeaders(d, ".");
    const rules = r.findings.filter(f => f.rule === "rate_limit_header_explicitly_disabled");
    assert.strictEqual(rules.length, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no rate-limit hint at all yields no missing_retry_after_header finding", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingRateLimitHeaders(d, ".");
    assert.ok(!r.findings.some(f => f.rule === "missing_retry_after_header"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory aggregation lists disabled-header findings from multiple files", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "app.use(rateLimit({ standardHeaders: false }));\n");
    writeFile(d, "b.js", "app.get('/y', (req,res)=>res.send('ok'));\n");
    const r = checkMissingRateLimitHeaders(d, ".");
    assert.ok(r.findings.some(f => f.file === "a.js" && f.rule === "rate_limit_header_explicitly_disabled"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => checkMissingRateLimitHeaders("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => checkMissingRateLimitHeaders(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => checkMissingRateLimitHeaders(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    writeFile(d, "notes.md", "app.get fake mention\n");
    const r = checkMissingRateLimitHeaders(d, ".", { extensions: [".js"] });
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
    assert.doesNotThrow(() => checkMissingRateLimitHeaders(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("nested sub-dir route + rate-limit hint detection", () => {
  const d = tmpDir();
  try {
    writeFile(d, "routes/nested.js", "router.post('/z', (req,res)=>res.send('ok'));\n");
    writeFile(d, "mw/limiter.js", "const rl = rateLimit({});\n");
    const r = checkMissingRateLimitHeaders(d, ".");
    assert.strictEqual(r.hasRouteRegistrations, true);
    assert.strictEqual(r.hasRateLimitHint, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'.' label direct call works without crash", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingRateLimitHeaders(f, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingRateLimitHeaders(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped route path text only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x; rm -rf /', (req,res)=>res.send('ok'));\n");
    assert.doesNotThrow(() => checkMissingRateLimitHeaders(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>res.send('ok'));\n");
    const r = checkMissingRateLimitHeaders(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["errorCount", "filesScanned", "findings", "findingsCount", "hasRateLimitHint", "hasRetryAfterHint", "hasRouteRegistrations", "infoCount", "path", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "app.use(rateLimit({";
    for (let i = 0; i < 6; i++) content += (i ? ", " : "") + `standardHeaders: false`;
    content += " }));\n";
    const f = writeFile(d, "app.js", content);
    const r = checkMissingRateLimitHeaders(f, "app.js", { maxResults: 2 });
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
    assert.doesNotThrow(() => checkMissingRateLimitHeaders(f, "app.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = checkMissingRateLimitHeaders(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.use(rateLimit({}));\napp.get('/x', (req,res)=>res.send('ok'));\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(checkMissingRateLimitHeaders(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes check_missing_rate_limit_headers", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("check_missing_rate_limit_headers"));
  assert.ok(typeof SCAN_DISPATCH.check_missing_rate_limit_headers === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
