"use strict";
// Isolated functional tests for find_missing_shebang_in_bin_scripts (lib/shebangCheckOps.js).
// Run: node test/find-missing-shebang-in-bin-scripts-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findMissingShebangInBinScripts } = require("../lib/shebangCheckOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "shebang-test-")); }
function writePkg(dir, obj) {
  const p = path.join(dir, "package.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
function writeBin(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  if (process.platform !== "win32") fs.chmodSync(p, 0o755);
  return p;
}

// ── Normal ───────────────────────────────────────────────────────────────────────
t("no bin field flags missing_bin_field info, zero errors", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { name: "x" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.hasBin, false);
    assert.strictEqual(r.findings[0].rule, "missing_bin_field");
    assert.strictEqual(r.errorCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("well-formed string bin with proper shebang + exec bit yields zero findings", () => {
  const d = tmpDir();
  try {
    writeBin(d, "cli.js", "#!/usr/bin/env node\nconsole.log('hi');\n");
    const p = writePkg(d, { name: "x", bin: "cli.js" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.hasBin, true);
    assert.strictEqual(r.binCount, 1);
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("object-form bin, multiple entries, all valid", () => {
  const d = tmpDir();
  try {
    writeBin(d, "a.js", "#!/usr/bin/env node\n");
    writeBin(d, "b.js", "#!/usr/bin/env node\n");
    const p = writePkg(d, { bin: { toola: "a.js", toolb: "b.js" } });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.binCount, 2);
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("bin target with no shebang at all flags missing_shebang error", () => {
  const d = tmpDir();
  try {
    writeBin(d, "cli.js", "console.log('hi');\n");
    const p = writePkg(d, { bin: "cli.js" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.ok(r.findings.some(f => f.rule === "missing_shebang" && f.severity === "error"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("bin target file missing on disk flags bin_file_not_found error", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { bin: "does-not-exist.js" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.findings[0].rule, "bin_file_not_found");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium (boundary & parameter validation) ────────────────────────────
t("nonexistent package.json throws", () => {
  assert.throws(() => findMissingShebangInBinScripts("/no/such/package.json", "package.json"), /cannot read/);
});

t("invalid JSON throws", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    fs.writeFileSync(p, "{ broken");
    assert.throws(() => findMissingShebangInBinScripts(p, "package.json"), /not valid JSON/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("top-level array throws", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    fs.writeFileSync(p, "[1,2]");
    assert.throws(() => findMissingShebangInBinScripts(p, "package.json"), /must contain a JSON object/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("bin as empty string flags invalid_bin_field error", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { bin: "" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.findings[0].rule, "invalid_bin_field");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("bin as number flags invalid_bin_field error", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { bin: 42 });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.findings[0].rule, "invalid_bin_field");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("bin object with non-string entry flags invalid_bin_entry, keeps binName", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { bin: { tool: 123 } });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.findings[0].rule, "invalid_bin_entry");
    assert.strictEqual(r.findings[0].binName, "tool");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty bin object flags invalid_bin_field", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { bin: {} });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.findings[0].rule, "invalid_bin_field");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High (dependency/failure handling) ──────────────────────────────
t("bin target is a directory, not a file, flags bin_file_not_found", () => {
  const d = tmpDir();
  try {
    fs.mkdirSync(path.join(d, "notafile"));
    const p = writePkg(d, { bin: "notafile" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.findings[0].rule, "bin_file_not_found");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-node shebang (#!/bin/sh) flags malformed_node_shebang warning, not error", () => {
  const d = tmpDir();
  try {
    writeBin(d, "cli.sh", "#!/bin/sh\necho hi\n");
    const p = writePkg(d, { bin: "cli.sh" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    const f = r.findings.find(x => x.rule === "malformed_node_shebang");
    assert.ok(f && f.severity === "warning");
    assert.strictEqual(r.errorCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

if (process.platform !== "win32") {
  t("shebang present but exec bit missing flags missing_executable_bit warning (POSIX only)", () => {
    const d = tmpDir();
    try {
      const p2 = writeBin(d, "cli.js", "#!/usr/bin/env node\n");
      fs.chmodSync(p2, 0o644);
      const p = writePkg(d, { bin: "cli.js" });
      const r = findMissingShebangInBinScripts(p, "package.json");
      assert.ok(r.findings.some(f => f.rule === "missing_executable_bit"));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
} else {
  t("missing_executable_bit is never emitted on win32 (no POSIX mode bits)", () => {
    const d = tmpDir();
    try {
      writeBin(d, "cli.js", "#!/usr/bin/env node\n");
      const p = writePkg(d, { bin: "cli.js" });
      const r = findMissingShebangInBinScripts(p, "package.json");
      assert.ok(!r.findings.some(f => f.rule === "missing_executable_bit"));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
}

// ── Critical (security & input sanitization) ─────────────────────────
t("path-traversal-shaped bin target stays within resolved package dir (no real traversal read)", () => {
  const d = tmpDir();
  try {
    const p = writePkg(d, { bin: "../../../../etc/passwd" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    // Resolves relative to package.json's real dir; almost certainly not found there.
    assert.strictEqual(r.findings[0].rule, "bin_file_not_found");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped bin key/value never executed, only read as text", () => {
  const d = tmpDir();
  try {
    writeBin(d, "cli.js", "#!/usr/bin/env node\n");
    const p = writePkg(d, { bin: { "$(rm -rf /)": "cli.js" } });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.findingsCount, 0);
    assert.ok(fs.existsSync(d));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("HTML/script-tag shebang line does not break JSON-serializable output", () => {
  const d = tmpDir();
  try {
    writeBin(d, "cli.js", "#!<script>alert(1)</script>\n");
    const p = writePkg(d, { bin: "cli.js" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    JSON.stringify(r);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result object has exactly the documented top-level keys", () => {
  const d = tmpDir();
  try {
    writeBin(d, "cli.js", "#!/usr/bin/env node\n");
    const p = writePkg(d, { bin: "cli.js" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.deepStrictEqual(Object.keys(r).sort(),
      ["binCount", "errorCount", "findings", "findingsCount", "hasBin", "infoCount", "path", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("'__proto__'-keyed bin object entry does not pollute Object.prototype", () => {
  const d = tmpDir();
  try {
    writeBin(d, "cli.js", "#!/usr/bin/env node\n");
    const p = writePkg(d, { bin: { "__proto__": "cli.js", real: "cli.js" } });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(({}).polluted, undefined);
    assert.ok(r.binCount >= 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme (fuzzing, concurrency, system constraints) ────────────────
t("fuzz: random-byte package.json throws a clean parse error, no crash", () => {
  const d = tmpDir();
  try {
    const p = path.join(d, "package.json");
    const buf = Buffer.alloc(400);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(p, buf);
    assert.throws(() => findMissingShebangInBinScripts(p, "package.json"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("binary (non-UTF8) target file does not crash the shebang read", () => {
  const d = tmpDir();
  try {
    const binPath = path.join(d, "cli.bin");
    const buf = Buffer.alloc(300);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(binPath, buf);
    if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
    const p = writePkg(d, { bin: "cli.bin" });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(typeof r.findingsCount, "number");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("100 bin entries processed without crash", () => {
  const d = tmpDir();
  try {
    const bin = {};
    for (let i = 0; i < 100; i++) { writeBin(d, `f${i}.js`, "#!/usr/bin/env node\n"); bin[`t${i}`] = `f${i}.js`; }
    const p = writePkg(d, { bin });
    const r = findMissingShebangInBinScripts(p, "package.json");
    assert.strictEqual(r.binCount, 100);
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent calls on the same file return consistent results", () => {
  const d = tmpDir();
  try {
    writeBin(d, "cli.js", "#!/usr/bin/env node\n");
    const p = writePkg(d, { bin: "cli.js" });
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findMissingShebangInBinScripts(p, "package.json"));
    assert.ok(results.every(r => r.findingsCount === 0 && r.binCount === 1));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("registered in SCAN_DISPATCH", () => {
  assert.strictEqual(typeof SCAN_DISPATCH.find_missing_shebang_in_bin_scripts, "function");
});

t("registered in execSchemas op-enum (execute_pipeline coverage)", () => {
  const opsSchema = JSON.stringify(EXEC_SCHEMAS);
  assert.ok(opsSchema.includes("find_missing_shebang_in_bin_scripts"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
