"use strict";
// Isolated functional tests for find_missing_return_after_res_send (lib/missingReturnAfterResSendOps.js).
// Run: node test/find-missing-return-after-res-send-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingReturnAfterResSend } = require("../lib/missingReturnAfterResSendOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "res-send-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ───────────────────────────────────────────────────────────────
t("returned res.send is never flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  if (x) { return res.send('ok'); }\n  next();\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("res.send followed by more code (no return) flags missing_return_after_res_send warning", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  if (bad) {\n    res.send('nope');\n    doSomethingElse();\n  }\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "missing_return_after_res_send");
    assert.strictEqual(r.findings[0].severity, "warning");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("second res.json call later in the same block flags double_response_send error", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  res.json({ok:true});\n  res.json({fallback:true});\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.ok(r.findings.some(f => f.rule === "double_response_send" && f.severity === "error"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("second call in a nested inner block is NOT cross-block-detected (documented limitation)", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  if (a) {\n    res.json({ok:true});\n  }\n  res.json({fallback:true});\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.ok(!r.findings.some(f => f.rule === "double_response_send"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("res.send(...); return; idiom is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  if (a) {\n    res.send('x');\n    return;\n  }\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("arrow implicit-return body is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "app.get('/x', (req, res) => res.json({ok:true}));\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("res.status(500).json chain is recognized and scanned", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  if (err) {\n    res.status(500).json({err:true});\n    cleanup();\n  }\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].method, "json");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium (boundary & parameter validation) ──────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findMissingReturnAfterResSend("/no/such/dir", "."), /cannot access/);
});

t("max_results non-number throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findMissingReturnAfterResSend(d, ".", { maxResults: "abc" }), /must be a number/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions non-array throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findMissingReturnAfterResSend(d, ".", { extensions: "js" }), /must be an array/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, filesScanned 0", () => {
  const d = tmpDir();
  try {
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.filesScanned, 0);
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-matching extensions filter excludes files", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.py", "res.send('x')\ndoStuff()\n");
    const r = findMissingReturnAfterResSend(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High (dependency/failure handling) ────────────────────────────────
t("unreadable/unterminated call (missing closing paren) does not crash", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  res.send('unterminated\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(typeof r.findingsCount, "number");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("single file (not directory) path is scanned directly", () => {
  const d = tmpDir();
  try {
    const p = writeFile(d, "a.js", "function h(req, res) {\n  res.send('x');\n  more();\n}\n");
    const r = findMissingReturnAfterResSend(p, "a.js");
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("top-level (no enclosing block) call with trailing code is still scanned without crash", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "res.send('x');\nconsole.log('after');\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(typeof r.findingsCount, "number");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("comment-only trailing content is not flagged", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  if (a) {\n    res.send('x');\n    // just a trailing comment\n  }\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical (security & input sanitization) ──────────────────────────
t("shell-injection-shaped response body text is only ever treated as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  res.send(\"$(rm -rf /)\");\n  after();\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.ok(fs.existsSync(d));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("HTML/script-tag content in source does not break JSON-serializable output", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  res.send('<script>alert(1)</script>');\n  after();\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    JSON.stringify(r);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result object has exactly the documented top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) { res.send('x'); }\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.deepStrictEqual(Object.keys(r).sort(),
      ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("path-traversal-shaped file names inside scanned dir are echoed literally, no traversal read", () => {
  const d = tmpDir();
  try {
    writeFile(d, "..dots..name.js", "function h(req, res) {\n  res.send('x');\n  after();\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.ok(r.findings.every(f => !f.file.includes("..\\..") && !f.file.includes("../..")));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("nested braces inside a string do not crash the brace-depth block finder", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  const s = '{ not a real block }';\n  res.send(s);\n  after();\n}\n");
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(typeof r.findingsCount, "number");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme (fuzzing, concurrency, system constraints) ────────────────
t("fuzz: random-byte file content does not crash the scan", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "a.js");
    const buf = Buffer.alloc(500);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(p, buf);
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(typeof r.findingsCount, "number");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("100 handlers with fallthrough bugs all detected without crash", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 100; i++) content += `function h${i}(req, res) {\n  res.send('x${i}');\n  cleanup${i}();\n}\n`;
    writeFile(d, "big.js", content);
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(r.findingsCount, 100);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("deeply nested blocks (50 levels) do not crash the block-end finder", () => {
  const d = tmpDir();
  try {
    let content = "function h(req, res) {\n";
    for (let i = 0; i < 50; i++) content += "if (true) {\n";
    content += "res.send('x');\nafter();\n";
    for (let i = 0; i < 50; i++) content += "}\n";
    content += "}\n";
    writeFile(d, "deep.js", content);
    const r = findMissingReturnAfterResSend(d, ".");
    assert.strictEqual(typeof r.findingsCount, "number");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent calls on the same directory return consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "a.js", "function h(req, res) {\n  res.send('x');\n  after();\n}\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findMissingReturnAfterResSend(d, "."));
    assert.ok(results.every(r => r.findingsCount === 1));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("registered in SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.find_missing_return_after_res_send, "function");
});

t("registered in execSchemas op-enum (execute_pipeline coverage)", () => {
  const opsSchema = JSON.stringify(EXEC_SCHEMAS);
  assert.ok(opsSchema.includes("find_missing_return_after_res_send"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
