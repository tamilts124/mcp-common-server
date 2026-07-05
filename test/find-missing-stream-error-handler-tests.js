"use strict";
// Standalone test suite for find_missing_stream_error_handler (not in run-tests.js).
// Run: node test/find-missing-stream-error-handler-tests.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const { findMissingStreamErrorHandler } = require("../lib/streamErrorHandlerOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "\n    " + e.message); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smeh-test-"));
function writeTmp(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal (happy path) ─────────────────────────────────────────────────
test("Normal: unguarded readStream flagged", () => {
  const p = writeTmp("n1.js", "const rs = fs.createReadStream('a.txt');\nrs.pipe(dest);\n");
  const r = findMissingStreamErrorHandler(p, "n1.js");
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_stream_error_handler");
  assert.strictEqual(r.findings[0].type, "readStream");
});

test("Normal: guarded readStream (var.on('error')) not flagged", () => {
  const p = writeTmp("n2.js", "const rs = fs.createReadStream('a.txt');\nrs.on('error', e => log(e));\nrs.pipe(dest);\n");
  const r = findMissingStreamErrorHandler(p, "n2.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Normal: writeStream flagged with correct type", () => {
  const p = writeTmp("n3.js", "const ws = fs.createWriteStream('out.txt');\nws.write('x');\n");
  const r = findMissingStreamErrorHandler(p, "n3.js");
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].type, "writeStream");
});

test("Normal: http.request flagged as httpRequest", () => {
  const p = writeTmp("n4.js", "const req = http.request(opts);\nreq.end();\n");
  const r = findMissingStreamErrorHandler(p, "n4.js");
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].type, "httpRequest");
});

test("Normal: guarded via .once('error') not flagged", () => {
  const p = writeTmp("n5.js", "const ws = fs.createWriteStream('o.txt');\nws.once('error', noop);\n");
  const r = findMissingStreamErrorHandler(p, "n5.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Normal: pipeline()-wrapped call not flagged", () => {
  const p = writeTmp("n6.js", "pipeline(fs.createReadStream('a'), fs.createWriteStream('b'), cb);\n");
  const r = findMissingStreamErrorHandler(p, "n6.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Normal: inline chained .on('error') without var not flagged", () => {
  const p = writeTmp("n7.js", "fs.createReadStream('a').on('error', noop).pipe(dest);\n");
  const r = findMissingStreamErrorHandler(p, "n7.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Normal: unassigned call with no handler at all is skipped (can't guess)", () => {
  const p = writeTmp("n8.js", "fs.createReadStream('a').pipe(dest);\n");
  const r = findMissingStreamErrorHandler(p, "n8.js");
  assert.strictEqual(r.findingsCount, 0);
});

// ── Medium (boundary & parameter validation) ────────────────────────────
test("Medium: nonexistent path throws ToolError", () => {
  assert.throws(() => findMissingStreamErrorHandler(path.join(tmpDir, "nope.js"), "nope.js"));
});

test("Medium: non-number max_results throws", () => {
  const p = writeTmp("m1.js", "const rs = fs.createReadStream('a');\n");
  assert.throws(() => findMissingStreamErrorHandler(p, "m1.js", { maxResults: "10" }));
});

test("Medium: non-array extensions throws", () => {
  const p = writeTmp("m2.js", "const rs = fs.createReadStream('a');\n");
  assert.throws(() => findMissingStreamErrorHandler(p, "m2.js", { extensions: ".js" }));
});

test("Medium: empty file returns zero findings, no error", () => {
  const p = writeTmp("m3.js", "");
  const r = findMissingStreamErrorHandler(p, "m3.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Medium: extension filter excludes non-matching directory files", () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, "sub-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "const rs = fs.createReadStream('a');\n");
  const r = findMissingStreamErrorHandler(dir, "sub", { extensions: [".js"] });
  assert.strictEqual(r.filesScanned, 0);
});

test("Medium: max_results truncates and sets truncated flag", () => {
  let content = "";
  for (let i = 0; i < 5; i++) content += `const rs${i} = fs.createReadStream('f${i}');\n`;
  const p = writeTmp("m4.js", content);
  const r = findMissingStreamErrorHandler(p, "m4.js", { maxResults: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

// ── High (edge cases / non-crash under odd input) ───────────────────────
test("High: unterminated call does not crash", () => {
  const p = writeTmp("h1.js", "const rs = fs.createReadStream('a'\n// no closing paren\n");
  const r = findMissingStreamErrorHandler(p, "h1.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("High: top-level (no enclosing block) call still detected", () => {
  const p = writeTmp("h2.js", "const rs = fs.createReadStream('a');\n");
  const r = findMissingStreamErrorHandler(p, "h2.js");
  assert.strictEqual(r.findingsCount, 1);
});

test("High: handler in nested block within same scope still counted", () => {
  const p = writeTmp("h3.js", "function f() {\n  const rs = fs.createReadStream('a');\n  if (cond) {\n    rs.on('error', noop);\n  }\n  rs.pipe(dest);\n}\n");
  const r = findMissingStreamErrorHandler(p, "h3.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("High: single-file-path mode (not a directory) works", () => {
  const p = writeTmp("h4.js", "const rs = fs.createReadStream('a');\n");
  const r = findMissingStreamErrorHandler(p, "h4.js");
  assert.strictEqual(r.filesScanned, 1);
});

// ── Critical (security / input sanitization) ────────────────────────────
test("Critical: shell-injection-shaped filename argument never executed, just text", () => {
  const p = writeTmp("c1.js", "const rs = fs.createReadStream('a; rm -rf /');\n");
  const r = findMissingStreamErrorHandler(p, "c1.js");
  assert.strictEqual(r.findingsCount, 1); // scanned as plain text, no crash/exec
});

test("Critical: HTML/script-tag content in file doesn't break JSON-safe output", () => {
  const p = writeTmp("c2.js", "const rs = fs.createReadStream('<script>alert(1)</script>');\n");
  const r = findMissingStreamErrorHandler(p, "c2.js");
  JSON.stringify(r); // must not throw
  assert.strictEqual(r.findingsCount, 1);
});

test("Critical: exact top-level key set", () => {
  const p = writeTmp("c3.js", "const rs = fs.createReadStream('a');\n");
  const r = findMissingStreamErrorHandler(p, "c3.js");
  assert.deepStrictEqual(Object.keys(r).sort(),
    ["filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort());
});

test("Critical: path-traversal-shaped path argument echoed literally, not resolved", () => {
  const p = writeTmp("c4.js", "const rs = fs.createReadStream('../../../etc/passwd');\n");
  const r = findMissingStreamErrorHandler(p, "c4.js");
  assert.strictEqual(r.findingsCount, 1);
  assert.ok(r.findings[0].message.includes("rs"));
});

test("Critical: braces inside a string don't crash the block finder", () => {
  const p = writeTmp("c5.js", "function f() {\n  const s = '{ not a real brace }';\n  const rs = fs.createReadStream('a');\n  return s;\n}\n");
  const r = findMissingStreamErrorHandler(p, "c5.js");
  assert.strictEqual(typeof r.findingsCount, "number");
});

// ── Extreme (fuzzing, concurrency, scale) ───────────────────────────────
test("Extreme: fuzz random bytes does not crash", () => {
  const buf = require("crypto").randomBytes(2000);
  const p = path.join(tmpDir, "fuzz.js");
  fs.writeFileSync(p, buf);
  const r = findMissingStreamErrorHandler(p, "fuzz.js");
  assert.strictEqual(typeof r.findingsCount, "number");
});

test("Extreme: 100 unguarded streams all detected", () => {
  let content = "";
  for (let i = 0; i < 100; i++) content += `const rs${i} = fs.createReadStream('f${i}');\n`;
  const p = writeTmp("e1.js", content);
  const r = findMissingStreamErrorHandler(p, "e1.js", { maxResults: 5000 });
  assert.strictEqual(r.findingsCount, 100);
});

test("Extreme: 50-level-deep nested blocks does not crash", () => {
  let content = "function f() {\n";
  for (let i = 0; i < 50; i++) content += "if (true) {\n";
  content += "const rs = fs.createReadStream('a');\n";
  for (let i = 0; i < 50; i++) content += "}\n";
  content += "}\n";
  const p = writeTmp("e2.js", content);
  const r = findMissingStreamErrorHandler(p, "e2.js");
  assert.strictEqual(typeof r.findingsCount, "number");
});

test("Extreme: 10 concurrent calls give consistent results", () => {
  const p = writeTmp("e3.js", "const rs = fs.createReadStream('a');\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findMissingStreamErrorHandler(p, "e3.js").findingsCount);
  assert.ok(results.every(v => v === 1));
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
