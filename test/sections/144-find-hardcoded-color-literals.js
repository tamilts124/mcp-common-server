"use strict";
/**
 * Tests for find_hardcoded_color_literals (hardcodedColorOps.js)
 * All 5 rigor levels.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findHardcodedColorLiterals } = require("../../lib/hardcodedColorOps");

let passed = 0, failed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hardcolor-test-"));

function write(name, content) {
  const fp = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

function test(label, fn) {
  try { fn(); console.log(`  \u2713 ${label}`); passed++; }
  catch (e) { console.error(`  \u2717 ${label}: ${e.message}`); failed++; }
}

// ── LEVEL 1: Normal ──────────────────────────────────────────────────────────
console.log("\n[Level 1] Normal");

test("using var() — no findings", () => {
  const fp = write("ok.css",
    ":root { --color-bg: #fff; }\nbody { background: var(--color-bg); }");
  const r = findHardcodedColorLiterals(fp, "ok.css");
  assert.strictEqual(r.findingsCount, 0);
});

test("hardcoded hex in property — warning", () => {
  const fp = write("hex.css", "body { color: #333; }");
  const r = findHardcodedColorLiterals(fp, "hex.css");
  assert.strictEqual(r.warningCount, 1);
  assert.strictEqual(r.findings[0].rule, "hardcoded_color_literal");
  assert.strictEqual(r.findings[0].color, "#333");
});

test("hardcoded rgb() — warning", () => {
  const fp = write("rgb.css", "p { color: rgb(255, 0, 0); }");
  const r = findHardcodedColorLiterals(fp, "rgb.css");
  assert.strictEqual(r.warningCount, 1);
});

test("hardcoded hsl() — warning", () => {
  const fp = write("hsl.css", "a { color: hsl(200, 50%, 50%); }");
  const r = findHardcodedColorLiterals(fp, "hsl.css");
  assert.strictEqual(r.warningCount, 1);
});

test("token declaration in :root — not flagged", () => {
  const fp = write("root.css", ":root { --brand: #ff0000; }\nbody { color: var(--brand); }");
  const r = findHardcodedColorLiterals(fp, "root.css");
  assert.strictEqual(r.findingsCount, 0);
});

test("custom property declaration (--x: #fff) — not flagged", () => {
  const fp = write("customProp.css", "div { --local: #fff; color: var(--local); }");
  const r = findHardcodedColorLiterals(fp, "customProp.css");
  assert.strictEqual(r.findingsCount, 0);
});

test("directory scan — multiple files", () => {
  write("dir/a.css", "body { color: #111; }");
  write("dir/b.css", "body { color: var(--color); }");
  const r = findHardcodedColorLiterals(path.join(tmpDir, "dir"), "dir");
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.warningCount, 1);
});

test("full 6-digit hex — flagged", () => {
  const fp = write("hex6.css", "h1 { background-color: #ff5733; }");
  const r = findHardcodedColorLiterals(fp, "hex6.css");
  assert.strictEqual(r.warningCount, 1);
  assert.ok(r.findings[0].color.includes("#ff5733"));
});

// ── LEVEL 2: Boundary ────────────────────────────────────────────────────────
console.log("\n[Level 2] Boundary");

test("max_results=1 with 2 findings — truncated", () => {
  write("trunc/a.css", "body { color: #111; }\nh1 { color: #222; }");
  const r = findHardcodedColorLiterals(path.join(tmpDir, "trunc"), "trunc", { maxResults: 1 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findings.length, 1);
});

test("max_results=0 — validation error", () => {
  const fp = write("mv.css", "");
  assert.throws(() => findHardcodedColorLiterals(fp, "mv.css", { maxResults: 0 }), /max_results/);
});

test("max_results=5001 — validation error", () => {
  const fp = write("mv2.css", "");
  assert.throws(() => findHardcodedColorLiterals(fp, "mv2.css", { maxResults: 5001 }), /max_results/);
});

test("path not found — throws -32602", () => {
  try {
    findHardcodedColorLiterals("/no/such/xyz", "/no/such/xyz");
    assert.fail("Should throw");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("custom extensions — scan .scss", () => {
  write("comp.scss", "$x: 1; .btn { color: #abc; }");
  const r = findHardcodedColorLiterals(tmpDir, ".", { extensions: [".scss"] });
  assert.ok(r.filesScanned >= 1);
  const found = r.findings.find(f => f.file.includes("comp.scss"));
  assert.ok(found);
});

// ── LEVEL 3: Mock failures ───────────────────────────────────────────────────
console.log("\n[Level 3] Mock failures");

test("empty CSS file — 0 findings", () => {
  const fp = write("empty.css", "");
  const r = findHardcodedColorLiterals(fp, "empty.css");
  assert.strictEqual(r.findingsCount, 0);
});

test("empty directory — 0 findings", () => {
  const empty = path.join(tmpDir, "emptycolor");
  fs.mkdirSync(empty, { recursive: true });
  const r = findHardcodedColorLiterals(empty, "emptycolor");
  assert.strictEqual(r.findingsCount, 0);
});

test("node_modules skipped", () => {
  write("nmC/node_modules/lib.css", "body { color: #f00; }");
  const r = findHardcodedColorLiterals(path.join(tmpDir, "nmC"), "nmC");
  assert.strictEqual(r.findingsCount, 0);
});

test("CSS comment with color — not flagged", () => {
  const fp = write("comment.css", "/* body { color: #ff0000; } */\nbody { color: var(--x); }");
  const r = findHardcodedColorLiterals(fp, "comment.css");
  assert.strictEqual(r.findingsCount, 0);
});

// ── LEVEL 4: Security ────────────────────────────────────────────────────────
console.log("\n[Level 4] Security");

test("injection attempt in color value — no crash, is plain string", () => {
  const fp = write("inj.css", "body { color: #<script>alert(1)</script>; }");
  const r = findHardcodedColorLiterals(fp, "inj.css");
  // The regex won't match the malformed value or will safely produce a string
  assert.ok(typeof r.findingsCount === "number");
});

test("10,000 rules with hex colors — no crash", () => {
  let content = "";
  for (let i = 0; i < 10000; i++) content += `.c${i} { color: #${(i % 0xffffff).toString(16).padStart(6, "0")}; }\n`;
  const fp = write("huge.css", content);
  const r = findHardcodedColorLiterals(fp, "huge.css", { maxResults: 5000 });
  assert.ok(r.findingsCount >= 5000);
  assert.ok(r.truncated === true);
});

test("path traversal string in content — no FS exploit", () => {
  const fp = write("pt2.css", "body { background: url('../../../etc/passwd') #ff0; }");
  const r = findHardcodedColorLiterals(fp, "pt2.css");
  // The #ff0 should be caught, the path string is irrelevant
  assert.ok(r.warningCount >= 1);
});

// ── LEVEL 5: Extreme / Fuzz ──────────────────────────────────────────────────
console.log("\n[Level 5] Extreme/Fuzz");

test("20 random CSS strings — no crash", () => {
  for (let i = 0; i < 20; i++) {
    const chars = ":root{}#rgba(); \n\t.-_";
    let s = "";
    for (let j = 0; j < 400; j++) s += chars[Math.floor(Math.random() * chars.length)];
    const fp = write(`cfuzz${i}.css`, s);
    findHardcodedColorLiterals(fp, `cfuzz${i}.css`);
  }
});

test("nested :root blocks — tokens not flagged", () => {
  const fp = write("nested.css",
    ":root { --a: #fff; --b: rgb(0,0,0); }\nbody { color: var(--a); background: var(--b); }");
  const r = findHardcodedColorLiterals(fp, "nested.css");
  assert.strictEqual(r.findingsCount, 0);
});

test("rgba with alpha — flagged", () => {
  const fp = write("rgba.css", "div { background: rgba(255, 255, 255, 0.5); }");
  const r = findHardcodedColorLiterals(fp, "rgba.css");
  assert.strictEqual(r.warningCount, 1);
});

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\nfind_hardcoded_color_literals: ${passed} passed, ${failed} failed\n`);
module.exports = { passed, failed };
