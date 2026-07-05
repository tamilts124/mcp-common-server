"use strict";
// Isolated functional tests for find_duplicate_route_registrations (lib/duplicateRouteOps.js).
// Run: node test/find-duplicate-route-registrations-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findDuplicateRouteRegistrations } = require("../lib/duplicateRouteOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "dup-route-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags exact duplicate method+path within one file", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', h1);\napp.get('/x', h2);\n");
    const r = findDuplicateRouteRegistrations(d, ".");
    assert.strictEqual(r.duplicateGroupsCount, 1);
    assert.ok(r.findings.some(f => f.rule === "duplicate_route_registration" && f.line === 2));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("app and router registrations of the same method+path are treated as one group", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.post('/y', h1);\nrouter.post('/y', h2);\n");
    const r = findDuplicateRouteRegistrations(d, ".");
    assert.strictEqual(r.duplicateGroupsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("different methods on the same path are not duplicates", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/z', h1);\napp.post('/z', h2);\n");
    const r = findDuplicateRouteRegistrations(d, ".");
    assert.strictEqual(r.duplicateGroupsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("cross-file duplicate is detected and points to the earlier file", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "app.get('/w', h1);\n");
    writeFile(d, "b.js", "app.get('/w', h2);\n");
    const r = findDuplicateRouteRegistrations(d, ".");
    const f = r.findings.find(fnd => fnd.rule === "duplicate_route_registration");
    assert.ok(f.message.includes("a.js:1"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("template literal path with interpolation is skipped (not compared)", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get(`/v/${id}`, h1);\napp.get(`/v/${id}`, h2);\n");
    const r = findDuplicateRouteRegistrations(d, ".");
    assert.strictEqual(r.duplicateGroupsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no duplicates yields zero findings, routeRegistrationsSeen still counts all", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/a', h1);\napp.get('/b', h2);\napp.get('/c', h3);\n");
    const r = findDuplicateRouteRegistrations(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.routeRegistrationsSeen, 3);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findDuplicateRouteRegistrations("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findDuplicateRouteRegistrations(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findDuplicateRouteRegistrations(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', h1);\n");
    writeFile(d, "notes.md", "app.get('/x', h2);\n");
    const r = findDuplicateRouteRegistrations(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.duplicateGroupsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    const bin = Buffer.from([0, 1, 2, 3, 0, 5]);
    fs.writeFileSync(path.join(d, "blob.js"), bin);
    writeFile(d, "app.js", "app.get('/x', h1);\n");
    assert.doesNotThrow(() => findDuplicateRouteRegistrations(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("triple duplicate produces two findings (both shadowed by the first)", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', h1);\napp.get('/x', h2);\napp.get('/x', h3);\n");
    const r = findDuplicateRouteRegistrations(d, ".");
    assert.strictEqual(r.findingsCount, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'.' label direct call works without crash", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "app.js", "app.get('/x', h1);\n");
    const r = findDuplicateRouteRegistrations(f, ".");
    assert.strictEqual(r.path, ".");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', h1);\n");
    const r = findDuplicateRouteRegistrations(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped route path text only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x; rm -rf /', h1);\napp.get('/x; rm -rf /', h2);\n");
    assert.doesNotThrow(() => findDuplicateRouteRegistrations(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', h1);\n");
    const r = findDuplicateRouteRegistrations(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["duplicateGroupsCount", "filesScanned", "findings", "findingsCount", "path", "routeRegistrationsSeen", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 5; i++) content += "app.get('/dup', h" + i + ");\n";
    const f = writeFile(d, "app.js", content);
    const r = findDuplicateRouteRegistrations(f, "app.js", { maxResults: 2 });
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
    assert.doesNotThrow(() => findDuplicateRouteRegistrations(f, "app.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findDuplicateRouteRegistrations(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "app.js", "app.get('/x', h1);\napp.get('/x', h2);\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findDuplicateRouteRegistrations(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_duplicate_route_registrations", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_duplicate_route_registrations"));
  assert.ok(typeof SCAN_DISPATCH.find_duplicate_route_registrations === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
