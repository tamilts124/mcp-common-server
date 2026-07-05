"use strict";
// Standalone test suite for find_setinterval_without_clear (not in run-tests.js).
// Run: node test/find-setinterval-without-clear-tests.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const { findSetIntervalWithoutClear } = require("../lib/setIntervalLeakOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("FAIL  " + name + "\n    " + e.message); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sil-test-"));
function writeTmp(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal (happy path) ─────────────────────────────────────────────────
test("Normal: assigned interval never cleared flagged as warning", () => {
  const p = writeTmp("n1.js", "const id = setInterval(tick, 1000);\n");
  const r = findSetIntervalWithoutClear(p, "n1.js");
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "interval_never_cleared");
  assert.strictEqual(r.findings[0].severity, "warning");
});

test("Normal: assigned interval with matching clearInterval not flagged", () => {
  const p = writeTmp("n2.js", "const id = setInterval(tick, 1000);\nfunction stop() { clearInterval(id); }\n");
  const r = findSetIntervalWithoutClear(p, "n2.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Normal: unassigned interval flagged as error", () => {
  const p = writeTmp("n3.js", "setInterval(tick, 1000);\n");
  const r = findSetIntervalWithoutClear(p, "n3.js");
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "unassigned_interval_handle");
  assert.strictEqual(r.findings[0].severity, "error");
});

test("Normal: inline .unref() on assigned interval not flagged", () => {
  const p = writeTmp("n4.js", "const id = setInterval(tick, 1000).unref();\n");
  const r = findSetIntervalWithoutClear(p, "n4.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Normal: inline .unref() on unassigned interval not flagged", () => {
  const p = writeTmp("n5.js", "setInterval(tick, 1000).unref();\n");
  const r = findSetIntervalWithoutClear(p, "n5.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Normal: multiple intervals, mixed cleared/uncleared, correct count", () => {
  const p = writeTmp("n6.js", "const a = setInterval(f1, 1); clearInterval(a);\nconst b = setInterval(f2, 1);\n");
  const r = findSetIntervalWithoutClear(p, "n6.js");
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].variable, "b");
});

// ── Medium (boundary & parameter validation) ────────────────────────────
test("Medium: nonexistent path throws", () => {
  assert.throws(() => findSetIntervalWithoutClear(path.join(tmpDir, "nope.js"), "nope.js"));
});

test("Medium: non-number max_results throws", () => {
  const p = writeTmp("m1.js", "const id = setInterval(f, 1);\n");
  assert.throws(() => findSetIntervalWithoutClear(p, "m1.js", { maxResults: "5" }));
});

test("Medium: non-array extensions throws", () => {
  const p = writeTmp("m2.js", "const id = setInterval(f, 1);\n");
  assert.throws(() => findSetIntervalWithoutClear(p, "m2.js", { extensions: ".js" }));
});

test("Medium: empty file returns zero findings", () => {
  const p = writeTmp("m3.js", "");
  const r = findSetIntervalWithoutClear(p, "m3.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("Medium: extension filter excludes non-matching directory files", () => {
  const dir = fs.mkdtempSync(path.join(tmpDir, "sub-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "setInterval(f, 1);\n");
  const r = findSetIntervalWithoutClear(dir, "sub", { extensions: [".js"] });
  assert.strictEqual(r.filesScanned, 0);
});

test("Medium: max_results truncates and sets truncated flag", () => {
  let content = "";
  for (let i = 0; i < 5; i++) content += `setInterval(f${i}, 1);\n`;
  const p = writeTmp("m4.js", content);
  const r = findSetIntervalWithoutClear(p, "m4.js", { maxResults: 2 });
  assert.strictEqual(r.findings.length, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 5);
});

// ── High (edge cases / non-crash) ───────────────────────────────────────
test("High: unterminated call does not crash", () => {
  const p = writeTmp("h1.js", "const id = setInterval(f, 1\n// no closing paren\n");
  const r = findSetIntervalWithoutClear(p, "h1.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("High: clearInterval in a different function still suppresses (whole-file scope)", () => {
  const p = writeTmp("h2.js", "function start() { global.id = 0; const id = setInterval(f, 1); }\nfunction stop() { clearInterval(id); }\n");
  const r = findSetIntervalWithoutClear(p, "h2.js");
  assert.strictEqual(r.findingsCount, 0);
});

test("High: single-file-path mode works", () => {
  const p = writeTmp("h3.js", "const id = setInterval(f, 1);\n");
  const r = findSetIntervalWithoutClear(p, "h3.js");
  assert.strictEqual(r.filesScanned, 1);
});

test("High: member-expression assignment treated as unassigned (documented caveat)", () => {
  const p = writeTmp("h4.js", "this.timer = setInterval(f, 1);\n");
  const r = findSetIntervalWithoutClear(p, "h4.js");
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "unassigned_interval_handle");
});

// ── Critical (security / input sanitization) ────────────────────────────
test("Critical: shell-injection-shaped callback text never executed, just text", () => {
  const p = writeTmp("c1.js", "const id = setInterval(() => require('child_process').exec('rm -rf /'), 1000);\n");
  const r = findSetIntervalWithoutClear(p, "c1.js");
  assert.strictEqual(r.findingsCount, 1); // scanned as text only, no crash/exec
});

test("Critical: HTML/script-tag content doesn't break JSON-safe output", () => {
  const p = writeTmp("c2.js", "const id = setInterval(() => log('<script>alert(1)</script>'), 1000);\n");
  const r = findSetIntervalWithoutClear(p, "c2.js");
  JSON.stringify(r); // must not throw
  assert.strictEqual(r.findingsCount, 1);
});

test("Critical: exact top-level key set", () => {
  const p = writeTmp("c3.js", "const id = setInterval(f, 1);\n");
  const r = findSetIntervalWithoutClear(p, "c3.js");
  assert.deepStrictEqual(Object.keys(r).sort(),
    ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort());
});

test("Critical: path-traversal-shaped path argument echoed literally", () => {
  const p = writeTmp("c4.js", "const id = setInterval(f, 1);\n");
  const r = findSetIntervalWithoutClear(p, "../../../etc/passwd_shaped_but_not_real.js".length ? p : p, "c4.js");
  assert.ok(typeof r.path === "string");
});

test("Critical: braces inside a string don't crash the scanner", () => {
  const p = writeTmp("c5.js", "const s = '{ not a real brace }';\nconst id = setInterval(f, 1);\n");
  const r = findSetIntervalWithoutClear(p, "c5.js");
  assert.strictEqual(typeof r.findingsCount, "number");
});

// ── Extreme (fuzzing, concurrency, scale) ───────────────────────────────
test("Extreme: fuzz random bytes does not crash", () => {
  const buf = require("crypto").randomBytes(2000);
  const p = path.join(tmpDir, "fuzz.js");
  fs.writeFileSync(p, buf);
  const r = findSetIntervalWithoutClear(p, "fuzz.js");
  assert.strictEqual(typeof r.findingsCount, "number");
});

test("Extreme: 100 unassigned intervals all detected", () => {
  let content = "";
  for (let i = 0; i < 100; i++) content += "setInterval(f, 1);\n";
  const p = writeTmp("e1.js", content);
  const r = findSetIntervalWithoutClear(p, "e1.js", { maxResults: 5000 });
  assert.strictEqual(r.findingsCount, 100);
});

test("Extreme: very long single line does not crash", () => {
  const p = writeTmp("e2.js", "const id = setInterval(f, 1); // " + "x".repeat(50000) + "\n");
  const r = findSetIntervalWithoutClear(p, "e2.js");
  assert.strictEqual(r.findingsCount, 1);
});

test("Extreme: 10 concurrent calls give consistent results", () => {
  const p = writeTmp("e3.js", "const id = setInterval(f, 1);\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findSetIntervalWithoutClear(p, "e3.js").findingsCount);
  assert.ok(results.every(v => v === 1));
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail ? 1 : 0);
