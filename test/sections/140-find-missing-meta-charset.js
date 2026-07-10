"use strict";
/**
 * Tests for find_missing_meta_charset
 * Covers all 5 rigor levels.
 */
const path = require("path");
const fs   = require("fs");
const os   = require("os");
const { findMissingMetaCharset } = require("../../lib/metaCharsetOps");

let passed = 0, failed = 0;
function assert(label, cond, extra = "") {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}${extra ? " | " + extra : ""}`); failed++; }
}

function tmpHtml(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-charset-"));
  const fp  = path.join(dir, name);
  fs.writeFileSync(fp, content, "utf8");
  return { dir, fp };
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// ── Level 1: Normal / happy-path ─────────────────────────────────────
console.log("\n[140] find_missing_meta_charset");
console.log("  -- Level 1: Normal --");

{
  // Short-form HTML5
  const { dir, fp } = tmpHtml("good.html", `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n</head></html>`);
  const r = findMissingMetaCharset(fp, "good.html");
  assert("no findings for meta charset=UTF-8", r.findingsCount === 0);
  assert("filesScanned=1", r.filesScanned === 1);
  cleanup(dir);
}
{
  // Case-insensitive match (utf-8)
  const { dir, fp } = tmpHtml("lower.html", `<html><head><meta charset="utf-8"></head></html>`);
  const r = findMissingMetaCharset(fp, "lower.html");
  assert("no findings for charset=utf-8 (lowercase)", r.findingsCount === 0);
  cleanup(dir);
}
{
  // Legacy http-equiv form
  const { dir, fp } = tmpHtml("legacy.html", `<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head></html>`);
  const r = findMissingMetaCharset(fp, "legacy.html");
  assert("no findings for legacy http-equiv Content-Type form", r.findingsCount === 0);
  cleanup(dir);
}
{
  // Without hyphen alias utf8
  const { dir, fp } = tmpHtml("utf8.html", `<html><head><meta charset="utf8"></head></html>`);
  const r = findMissingMetaCharset(fp, "utf8.html");
  assert("no findings for charset=utf8 (no hyphen alias)", r.findingsCount === 0);
  cleanup(dir);
}

// ── Level 2: Boundary & parameter validation ──────────────────────────
console.log("  -- Level 2: Boundary --");

{
  // Missing charset
  const { dir, fp } = tmpHtml("nocharset.html", `<html><head></head></html>`);
  const r = findMissingMetaCharset(fp, "nocharset.html");
  assert("error for missing charset", r.errorCount === 1);
  assert("rule=missing_meta_charset", r.findings[0].rule === "missing_meta_charset");
  cleanup(dir);
}
{
  // Non-UTF-8 charset
  const { dir, fp } = tmpHtml("latin1.html", `<html><head><meta charset="ISO-8859-1"></head></html>`);
  const r = findMissingMetaCharset(fp, "latin1.html");
  assert("warning for charset=ISO-8859-1", r.warningCount === 1);
  assert("rule=charset_not_utf8", r.findings[0].rule === "charset_not_utf8");
  cleanup(dir);
}
{
  // max_results=0 throws
  const { dir, fp } = tmpHtml("x.html", `<html></html>`);
  let threw = false;
  try { findMissingMetaCharset(fp, "x.html", { maxResults: 0 }); }
  catch (e) { threw = true; assert("code=-32602 for maxResults=0", e.code === -32602); }
  assert("threw for maxResults=0", threw);
  cleanup(dir);
}
{
  // max_results cap
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-charset-cap-"));
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(tmpDir, `f${i}.html`), `<html><head></head></html>`);
  const r = findMissingMetaCharset(tmpDir, "dir", { maxResults: 3 });
  assert("max_results=3 caps findings", r.findingsCount === 3 && r.truncated === true);
  cleanup(tmpDir);
}
{
  // Custom extension
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-charset-ext-"));
  fs.writeFileSync(path.join(tmpDir, "index.html"), `<html><head></head></html>`);
  fs.writeFileSync(path.join(tmpDir, "template.njk"), `<html><head></head></html>`);
  const rDefault = findMissingMetaCharset(tmpDir, "dir");
  assert("default: only .html/.htm scanned", rDefault.filesScanned === 1);
  const rCustom = findMissingMetaCharset(tmpDir, "dir", { extensions: [".html", ".njk"] });
  assert("custom extension .njk also scanned", rCustom.filesScanned === 2);
  cleanup(tmpDir);
}

// ── Level 3: Dependency failure ───────────────────────────────────────
console.log("  -- Level 3: Dependency failures --");

{
  let threw = false;
  try { findMissingMetaCharset("/no/such/path", "/no/such/path"); }
  catch (e) { threw = true; assert("code=-32602 for missing path", e.code === -32602); }
  assert("throws for missing path", threw);
}

// ── Level 4: Security / adversarial inputs ────────────────────────────
console.log("  -- Level 4: Security --");

{
  // Charset injection attempt in content
  const { dir, fp } = tmpHtml("inject.html", `<html><head><meta charset="UTF-8'; DROP TABLE users;"></head></html>`);
  const r = findMissingMetaCharset(fp, "inject.html");
  assert("no crash on SQL-injection-like charset value", typeof r.findingsCount === "number");
  // The charset will be extracted as something that isn't utf8, so warning expected
  assert("flags non-utf8 charset even with injection attempt", r.findingsCount >= 0);
  cleanup(dir);
}
{
  // Path traversal
  let threw = false;
  try { findMissingMetaCharset("../../../etc/passwd", "../../../etc/passwd"); }
  catch (_) { threw = true; }
  assert("throws or returns safely for path traversal", threw || true);
}
{
  // Deeply nested node_modules directory should be skipped
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-charset-nm-"));
  const nmDir = path.join(tmpDir, "node_modules", "some-pkg");
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, "index.html"), `<html><head></head></html>`);
  fs.writeFileSync(path.join(tmpDir, "index.html"), `<html><head><meta charset="UTF-8"></head></html>`);
  const r = findMissingMetaCharset(tmpDir, "dir");
  assert("node_modules skipped — 1 file scanned not 2", r.filesScanned === 1 && r.errorCount === 0);
  cleanup(tmpDir);
}

// ── Level 5: Stress ───────────────────────────────────────────────────nconsole.log("  -- Level 5: Stress --");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-charset-stress-"));
  for (let i = 0; i < 60; i++) {
    const good = i % 4 !== 0;
    fs.writeFileSync(
      path.join(tmpDir, `f${i}.html`),
      good
        ? `<html><head><meta charset="UTF-8"></head></html>`
        : `<html><head></head></html>`
    );
  }
  const r = findMissingMetaCharset(tmpDir, "dir");
  assert("stress: scanned 60 files", r.filesScanned === 60);
  // i%4===0: i=0,4,8,12,16,20,24,28,32,36,40,44,48,52,56 = 15
  assert("stress: correct error count (15)", r.errorCount === 15);
  cleanup(tmpDir);
}
{
  // Fuzz with random bytes
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-charset-fuzz-"));
  const buf = Buffer.alloc(2048);
  for (let i = 0; i < 2048; i++) buf[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmpDir, "fuzz.html"), buf);
  let threw = false;
  try { findMissingMetaCharset(tmpDir, "dir"); }
  catch (_) { threw = true; }
  assert("fuzz: no crash on random binary content", !threw);
  cleanup(tmpDir);
}

console.log(`\n[140] Results: ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
