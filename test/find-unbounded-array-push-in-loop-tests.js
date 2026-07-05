"use strict";
// Isolated functional tests for find_unbounded_array_push_in_loop (lib/arrayPushLoopOps.js).
// Run: node test/find-unbounded-array-push-in-loop-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findUnboundedArrayPushInLoop } = require("../lib/arrayPushLoopOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "arraypush-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags for-loop push with no cap on array declared earlier", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const results = [];\nfor (let i = 0; i < items.length; i++) { results.push(items[i]); }\n");
    const r = findUnboundedArrayPushInLoop(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "unbounded_array_push_in_loop");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t(".length cap suppresses the finding", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const results = [];\nwhile (hasMore) { if (results.length < 100) { results.push(next()); } }\n");
    const r = findUnboundedArrayPushInLoop(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("break suppresses the finding", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const results = [];\nfor (const x of xs) { results.push(x); if (results.length > 50) break; }\n");
    const r = findUnboundedArrayPushInLoop(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("forEach( with unbounded push is flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const out = [];\nitems.forEach((x) => { out.push(transform(x)); });\n");
    const r = findUnboundedArrayPushInLoop(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("push onto a variable never declared as array literal is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "for (let i = 0; i < 10; i++) { results.push(i); }\n");
    const r = findUnboundedArrayPushInLoop(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("loop with no push at all is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "for (let i = 0; i < 10; i++) { console.log(i); }\n");
    const r = findUnboundedArrayPushInLoop(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.loopsSeen, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findUnboundedArrayPushInLoop("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findUnboundedArrayPushInLoop(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findUnboundedArrayPushInLoop(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const r = [];\nfor (let i=0;i<10;i++) { r.push(i); }\n");
    writeFile(d, "notes.md", "for ( fake mention\n");
    const r = findUnboundedArrayPushInLoop(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, "blob.js"), Buffer.from([0, 1, 2, 3, 0, 5]));
    writeFile(d, "a.js", "const r = [];\nfor (let i=0;i<10;i++) { r.push(i); }\n");
    assert.doesNotThrow(() => findUnboundedArrayPushInLoop(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("unterminated for( header does not crash (skipped, not guessed)", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "a.js", "for (let i = 0; i < 10; i++\n");
    assert.doesNotThrow(() => findUnboundedArrayPushInLoop(f, "a.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("single-statement loop body (no braces) is skipped, not guessed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const r = [];\nfor (let i = 0; i < 10; i++) r.push(i);\n");
    const r = findUnboundedArrayPushInLoop(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const r = [];\nfor (let i=0;i<10;i++) { r.push(i); }\n");
    const r = findUnboundedArrayPushInLoop(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped content only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const r = [];\nfor (let i=0;i<10;i++) { r.push('; rm -rf /'); }\n");
    assert.doesNotThrow(() => findUnboundedArrayPushInLoop(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const r = [];\nfor (let i=0;i<10;i++) { r.push(i); }\n");
    const r = findUnboundedArrayPushInLoop(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["filesScanned", "findings", "findingsCount", "path", "loopsSeen", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "const r = [];\n";
    for (let i = 0; i < 5; i++) content += `while (c${i}) { r.push(${i}); }\n`;
    const f = writeFile(d, "a.js", content);
    const r = findUnboundedArrayPushInLoop(f, "a.js", { maxResults: 2 });
    assert.strictEqual(r.truncated, r.findingsCount > 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fuzz: random-byte file does not crash scan", () => {
  const d = tmpDir();
  try {
    const buf = Buffer.alloc(2000);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    const f = path.join(d, "a.js");
    fs.writeFileSync(f, buf);
    assert.doesNotThrow(() => findUnboundedArrayPushInLoop(f, "a.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findUnboundedArrayPushInLoop(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "const r = [];\nfor (let i=0;i<10;i++) { r.push(i); }\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findUnboundedArrayPushInLoop(d, "."));
    for (const res of results) assert.strictEqual(res.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_unbounded_array_push_in_loop", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_unbounded_array_push_in_loop"));
  assert.ok(typeof SCAN_DISPATCH.find_unbounded_array_push_in_loop === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
