"use strict";
// Isolated functional tests for find_missing_websocket_error_handler (lib/websocketErrorHandlerOps.js).
// Run: node test/find-missing-websocket-error-handler-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingWebsocketErrorHandler } = require("../lib/websocketErrorHandlerOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "wserr-test-")); }
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags connection handler with no sibling error listener (arrow fn, ws)", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', (ws) => { ws.on('message', (m) => {}); });\n");
    const r = findMissingWebsocketErrorHandler(d, ".");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "missing_websocket_error_handler");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("error listener present suppresses the finding (socket.io)", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "io.on('connection', (socket) => { socket.on('error', (e) => {}); socket.on('chat', () => {}); });\n");
    const r = findMissingWebsocketErrorHandler(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("function(ws) expression form also detected and parsed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', function(ws) { ws.on('close', () => {}); });\n");
    const r = findMissingWebsocketErrorHandler(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no connection registration at all yields zero findings", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "app.get('/x', (req,res) => { res.end(); });\n");
    const r = findMissingWebsocketErrorHandler(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.connectionHandlersSeen, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("different variable name than 'error'.on unrelated does not suppress", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', (ws) => { other.on('error', () => {}); });\n");
    const r = findMissingWebsocketErrorHandler(d, ".");
    assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findMissingWebsocketErrorHandler("/no/such/path", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findMissingWebsocketErrorHandler(d, ".", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions type mismatch throws", () => {
  const d = tmpDir();
  try {
    assert.throws(() => findMissingWebsocketErrorHandler(d, ".", { extensions: "js" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', (ws) => {});\n");
    writeFile(d, "notes.md", "on('connection' fake mention\n");
    const r = findMissingWebsocketErrorHandler(d, ".", { extensions: [".js"] });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, "blob.js"), Buffer.from([0, 1, 2, 3, 0, 5]));
    writeFile(d, "s.js", "wss.on('connection', (ws) => {});\n");
    assert.doesNotThrow(() => findMissingWebsocketErrorHandler(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("unterminated .on('connection', call does not crash (skipped, not guessed)", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "s.js", "wss.on('connection', (ws) => { ws.send('x'\n");
    assert.doesNotThrow(() => findMissingWebsocketErrorHandler(f, "s.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("no parseable parameter name (destructuring) is skipped, not guessed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', ({ socket }) => { socket.on('close', () => {}); });\n");
    const r = findMissingWebsocketErrorHandler(d, ".");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', (ws) => {});\n");
    const r = findMissingWebsocketErrorHandler(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped variable-name-like text only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', (ws) => { const x = '; rm -rf /'; });\n");
    assert.doesNotThrow(() => findMissingWebsocketErrorHandler(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', (ws) => {});\n");
    const r = findMissingWebsocketErrorHandler(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["filesScanned", "findings", "findingsCount", "path", "connectionHandlersSeen", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 5; i++) content += `srv${i}.on('connection', (ws) => {});\n`;
    const f = writeFile(d, "s.js", content);
    const r = findMissingWebsocketErrorHandler(f, "s.js", { maxResults: 2 });
    assert.strictEqual(r.truncated, r.findingsCount > 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fuzz: random-byte file does not crash scan", () => {
  const d = tmpDir();
  try {
    const buf = Buffer.alloc(2000);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    const f = path.join(d, "s.js");
    fs.writeFileSync(f, buf);
    assert.doesNotThrow(() => findMissingWebsocketErrorHandler(f, "s.js"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findMissingWebsocketErrorHandler(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same directory give consistent results", () => {
  const d = tmpDir();
  try {
    writeFile(d, "s.js", "wss.on('connection', (ws) => {});\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findMissingWebsocketErrorHandler(d, "."));
    for (const r of results) assert.strictEqual(r.findingsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_missing_websocket_error_handler", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_missing_websocket_error_handler"));
  assert.ok(typeof SCAN_DISPATCH.find_missing_websocket_error_handler === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
