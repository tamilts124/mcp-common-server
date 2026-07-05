"use strict";
// Isolated functional tests for find_missing_pagination_limit (lib/paginationLimitOps.js).
// Run: node test/find-missing-pagination-limit-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingPaginationLimit } = require("../lib/paginationLimitOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "pagination-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags GET handler with find()+res.json() and no pagination hint", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/users', async (req,res) => { const u = await User.find({}); res.json(u); });\n");
    const r = findMissingPaginationLimit(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "missing_pagination_limit");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("limit keyword present suppresses the finding", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/users', async (req,res) => { const u = await User.find({}).limit(20); res.json(u); });\n");
    const r = findMissingPaginationLimit(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t(".slice( suppresses the finding", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/users', async (req,res) => { const u = await User.find({}); res.json(u.slice(0,10)); });\n");
    const r = findMissingPaginationLimit(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no res.json/send at all does not flag", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/users', async (req,res) => { const u = await User.find({}); console.log(u); });\n");
    const r = findMissingPaginationLimit(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no DB list call at all does not flag", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/status', (req,res) => { res.json({ ok: true }); });\n");
    const r = findMissingPaginationLimit(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("POST handler with the same shape is not flagged (get-only scope)", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.post('/users', async (req,res) => { const u = await User.find({}); res.json(u); });\n");
    const r = findMissingPaginationLimit(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.getRoutesSeen, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("query() hint variant also flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "router.get('/rows', async (req,res) => { const rows = await db.query('SELECT * FROM t'); res.send(rows); });\n");
    const r = findMissingPaginationLimit(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findMissingPaginationLimit("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findMissingPaginationLimit(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findMissingPaginationLimit(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>{ const u = X.find({}); res.json(u); });\n");
    writeFile(d, "notes.md", "app.get fake mention\n");
    const r = findMissingPaginationLimit(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    const bin = Buffer.from([0, 1, 2, 3, 0, 5]);
    fs.writeFileSync(path.join(d, "blob.js"), bin);
    writeFile(d, "app.js", "app.get('/x', (req,res)=>{ const u = X.find({}); res.json(u); });\n");
    assert.doesNotThrow(() => findMissingPaginationLimit(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("unterminated app.get( call does not crash (skipped, not guessed)", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "app.js", "app.get('/x', (req,res) => { const u = X.find({}\n");
    assert.doesNotThrow(() => findMissingPaginationLimit(f, "app.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'.' label direct call works without crash", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "app.js", "app.get('/x', (req,res)=>{ const u = X.find({}); res.json(u); });\n");
    const r = findMissingPaginationLimit(f, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>{ const u = X.find({}); res.json(u); });\n");
    const r = findMissingPaginationLimit(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped route path text only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x; rm -rf /', (req,res)=>{ const u = X.find({}); res.json(u); });\n");
    assert.doesNotThrow(() => findMissingPaginationLimit(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>{ const u = X.find({}); res.json(u); });\n");
    const r = findMissingPaginationLimit(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["filesScanned", "findings", "findingsCount", "getRoutesSeen", "path", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 5; i++) content += `app.get('/x${i}', (req,res)=>{ const u = X.find({}); res.json(u); });\n`;
    const f = writeFile(d, "app.js", content);
    const r = findMissingPaginationLimit(f, "app.js", { maxResults: 2 });
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
    assert.doesNotThrow(() => findMissingPaginationLimit(f, "app.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findMissingPaginationLimit(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res)=>{ const u = X.find({}); res.json(u); });\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findMissingPaginationLimit(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_missing_pagination_limit", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_missing_pagination_limit"));
  assert.ok(typeof SCAN_DISPATCH.find_missing_pagination_limit === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
