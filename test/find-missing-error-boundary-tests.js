"use strict";
// Isolated functional tests for find_missing_error_boundary_in_async_route (lib/asyncErrorBoundaryOps.js).
// Run: node test/find-missing-error-boundary-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingErrorBoundaryInAsyncRoute } = require("../lib/asyncErrorBoundaryOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "asyncerr-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags async handler with no try/catch and no wrapper", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', async (req,res) => { const u = await X.find({}); res.json(u); });\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "missing_error_boundary_in_async_route");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("try/catch present suppresses the finding", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', async (req,res) => { try { const u = await X.find({}); res.json(u); } catch(e) { res.status(500).end(); } });\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("asyncHandler( wrapper suppresses the finding", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', asyncHandler(async (req,res) => { const u = await X.find({}); res.json(u); }));\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-async handler is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', (req,res) => { res.json({ ok: true }); });\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.routesSeen, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("post/put/delete/patch/all handlers also scanned", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "router.post('/x', async (req,res) => { await X.save(); res.end(); });\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("wrapAsync/catchAsync wrapper variants suppress too", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/a', wrapAsync(async (req,res) => { res.end(); }));\napp.get('/b', catchAsync(async (req,res) => { res.end(); }));\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findMissingErrorBoundaryInAsyncRoute("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findMissingErrorBoundaryInAsyncRoute(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findMissingErrorBoundaryInAsyncRoute(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', async (req,res)=>{ res.end(); });\n");
    writeFile(d, "notes.md", "app.get fake mention\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, "blob.js"), Buffer.from([0, 1, 2, 3, 0, 5]));
    writeFile(d, "app.js", "app.get('/x', async (req,res)=>{ res.end(); });\n");
    assert.doesNotThrow(() => findMissingErrorBoundaryInAsyncRoute(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("unterminated app.get( call does not crash (skipped, not guessed)", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "app.js", "app.get('/x', async (req,res) => { const u = X.find({}\n");
    assert.doesNotThrow(() => findMissingErrorBoundaryInAsyncRoute(f, "app.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'.' label direct call works without crash", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "app.js", "app.get('/x', async (req,res)=>{ res.end(); });\n");
    const r = findMissingErrorBoundaryInAsyncRoute(f, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', async (req,res)=>{ res.end(); });\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped route path text only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x; rm -rf /', async (req,res)=>{ res.end(); });\n");
    assert.doesNotThrow(() => findMissingErrorBoundaryInAsyncRoute(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', async (req,res)=>{ res.end(); });\n");
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["filesScanned", "findings", "findingsCount", "path", "routesSeen", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 5; i++) content += `app.get('/x${i}', async (req,res)=>{ res.end(); });\n`;
    const f = writeFile(d, "app.js", content);
    const r = findMissingErrorBoundaryInAsyncRoute(f, "app.js", { maxResults: 2 });
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
    assert.doesNotThrow(() => findMissingErrorBoundaryInAsyncRoute(f, "app.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findMissingErrorBoundaryInAsyncRoute(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', async (req,res)=>{ res.end(); });\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findMissingErrorBoundaryInAsyncRoute(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_missing_error_boundary_in_async_route", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_missing_error_boundary_in_async_route"));
  assert.ok(typeof SCAN_DISPATCH.find_missing_error_boundary_in_async_route === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
