"use strict";
/**
 * Tests for find_unused_css_variables (unusedCssVarsOps.js)
 * All 5 rigor levels.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findUnusedCssVariables } = require("../../lib/unusedCssVarsOps");

let passed = 0, failed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cssvars-test-"));

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

test("declared and used — no findings", () => {
  write("used/styles.css", ":root { --color-primary: #333; }\nbody { color: var(--color-primary); }");
  const r = findUnusedCssVariables(path.join(tmpDir, "used"), "used");
  assert.strictEqual(r.unusedCount, 0);
  assert.strictEqual(r.findingsCount, 0);
});

test("declared but not used — warning finding", () => {
  write("unused/styles.css", ":root { --color-ghost: #fff; }\nbody { color: red; }");
  const r = findUnusedCssVariables(path.join(tmpDir, "unused"), "unused");
  assert.strictEqual(r.unusedCount, 1);
  assert.strictEqual(r.findings[0].rule, "unused_css_variable");
  assert.strictEqual(r.findings[0].variable, "--color-ghost");
  assert.strictEqual(r.findings[0].severity, "warning");
});

test("cross-file: declared in CSS, used in HTML", () => {
  write("cross/styles.css", ":root { --font-size: 16px; }");
  write("cross/index.html", "<html><body style=\"font-size: var(--font-size)\"></body></html>");
  const r = findUnusedCssVariables(path.join(tmpDir, "cross"), "cross");
  assert.strictEqual(r.unusedCount, 0);
});

test("multiple unused vars", () => {
  write("multi/a.css", ":root { --a: 1; --b: 2; --c: 3; }\nbody { color: var(--a); }");
  const r = findUnusedCssVariables(path.join(tmpDir, "multi"), "multi");
  assert.strictEqual(r.unusedCount, 2);
  const names = r.findings.map(f => f.variable).sort();
  assert.deepStrictEqual(names, ["--b", "--c"]);
});

test("returns totalDeclaredVariables count", () => {
  write("total/s.css", ":root { --x: 1; --y: 2; }\nbody { color: var(--x); }");
  const r = findUnusedCssVariables(path.join(tmpDir, "total"), "total");
  assert.strictEqual(r.totalDeclaredVariables, 2);
  assert.strictEqual(r.unusedCount, 1);
});

test("single file scan", () => {
  const fp = write("single.css", ":root { --z: 0; }\n/* no usage */");
  const r = findUnusedCssVariables(fp, "single.css");
  assert.strictEqual(r.unusedCount, 1);
});

// ── LEVEL 2: Boundary / Parameter Validation ─────────────────────────────────
console.log("\n[Level 2] Boundary");

test("max_results=1 with 2 unused — truncated", () => {
  write("trunc2/s.css", ":root { --a: 1; --b: 2; }");
  const r = findUnusedCssVariables(path.join(tmpDir, "trunc2"), "trunc2", { maxResults: 1 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findings.length, 1);
});

test("max_results=0 — validation error", () => {
  const fp = write("mv.css", ":root {}");
  assert.throws(() => findUnusedCssVariables(fp, "mv.css", { maxResults: 0 }), /max_results/);
});

test("max_results=5001 — validation error", () => {
  const fp = write("mv2.css", ":root {}");
  assert.throws(() => findUnusedCssVariables(fp, "mv2.css", { maxResults: 5001 }), /max_results/);
});

test("path not found — throws -32602", () => {
  try {
    findUnusedCssVariables("/no/such/dir/abc", "/no/such/dir/abc");
    assert.fail("Should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("no CSS files in directory — 0 declared", () => {
  write("nocss/page.html", "<html><body>hi</body></html>");
  const r = findUnusedCssVariables(path.join(tmpDir, "nocss"), "nocss");
  assert.strictEqual(r.totalDeclaredVariables, 0);
  assert.strictEqual(r.findingsCount, 0);
});

test("custom decl_extensions — only scan .scss", () => {
  write("scssonly/a.css", ":root { --ignored: 1; }");
  write("scssonly/b.scss", ":root { --used-here: 2; }");
  write("scssonly/c.css", "body { color: var(--used-here); }");
  const r = findUnusedCssVariables(
    path.join(tmpDir, "scssonly"), "scssonly",
    { declExtensions: [".scss"] }
  );
  // Only --used-here should be declared; it's used in c.css (in usage scan default)
  assert.strictEqual(r.unusedCount, 0);
});

// ── LEVEL 3: Mock failures ───────────────────────────────────────────────────
console.log("\n[Level 3] Mock failures");

test("empty directory — 0 findings", () => {
  const empty = path.join(tmpDir, "emptycssvars");
  fs.mkdirSync(empty, { recursive: true });
  const r = findUnusedCssVariables(empty, "emptycssvars");
  assert.strictEqual(r.findingsCount, 0);
});

test("empty CSS file — 0 declarations", () => {
  const fp = write("empty.css", "");
  const r = findUnusedCssVariables(fp, "empty.css");
  assert.strictEqual(r.totalDeclaredVariables, 0);
});

test("node_modules skipped", () => {
  write("nm2/node_modules/dep.css", ":root { --nm-var: 1; }");
  const r = findUnusedCssVariables(path.join(tmpDir, "nm2"), "nm2");
  // --nm-var should NOT be counted since node_modules is skipped
  assert.strictEqual(r.totalDeclaredVariables, 0);
});

test("var with whitespace in usage: var( --x ) — recognised", () => {
  const fp = write("space.css", ":root { --x: 1; }\nbody { color: var( --x ); }");
  const r = findUnusedCssVariables(fp, "space.css");
  assert.strictEqual(r.unusedCount, 0);
});

// ── LEVEL 4: Security ────────────────────────────────────────────────────────
console.log("\n[Level 4] Security");

test("path traversal string in content — no crash", () => {
  const fp = write("sec2.css", ":root { --a: url('../../../etc/passwd'); }\nbody { color: var(--a); }");
  const r = findUnusedCssVariables(fp, "sec2.css");
  assert.strictEqual(r.unusedCount, 0); // used
});

test("injection attempt in var name — not a valid CSS var, ignored", () => {
  const fp = write("inj.css", ":root { --<script>: bad; }\nbody {}");
  // DECL_RE only matches --[\w-]+, so the injected name won't match
  const r = findUnusedCssVariables(fp, "inj.css");
  assert.strictEqual(r.totalDeclaredVariables, 0);
});

test("10,000 declarations — no crash", () => {
  let content = ":root {\n";
  let usages = "body {\n";
  for (let i = 0; i < 10000; i++) {
    content += `  --var-${i}: ${i};\n`;
    if (i < 5000) usages += `  color: var(--var-${i});\n`;
  }
  content += "}\n" + usages + "}\n";
  const fp = write("big.css", content);
  const r = findUnusedCssVariables(fp, "big.css", { maxResults: 5000 });
  assert.strictEqual(r.unusedCount, 5000);
  assert.strictEqual(r.truncated, false);
});

// ── LEVEL 5: Extreme / Fuzz ──────────────────────────────────────────────────
console.log("\n[Level 5] Extreme/Fuzz");

test("20 random CSS strings — no crash", () => {
  for (let i = 0; i < 20; i++) {
    const len = Math.floor(Math.random() * 500);
    const chars = ":root{-va}; \n\r\t()";
    let s = "";
    for (let j = 0; j < len; j++) s += chars[Math.floor(Math.random() * chars.length)];
    const fp = write(`fuzz${i}.css`, s);
    findUnusedCssVariables(fp, `fuzz${i}.css`);
  }
});

test("same var declared 3 times — declarationCount=3", () => {
  const fp = write("dup.css",
    ":root { --x: 1; }\n:root { --x: 2; }\n.a { --x: 3; }\n/* no usage */");
  const r = findUnusedCssVariables(fp, "dup.css");
  assert.strictEqual(r.unusedCount, 1);
  assert.strictEqual(r.findings[0].declarationCount, 3);
});

test("very long var name (200 chars) — handled", () => {
  const name = "--" + "a".repeat(198);
  const fp = write("longvar.css", `:root { ${name}: 1; }\nbody { color: var(${name}); }`);
  const r = findUnusedCssVariables(fp, "longvar.css");
  assert.strictEqual(r.unusedCount, 0);
});

// Cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

console.log(`\nfind_unused_css_variables: ${passed} passed, ${failed} failed\n`);
module.exports = { passed, failed };
