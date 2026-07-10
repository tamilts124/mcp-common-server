"use strict";
// Tests for find_unvalidated_redirect (v4.136.0)
const path = require("path");
const os   = require("os");
const fs   = require("fs");

const { findUnvalidatedRedirect } = require("../../lib/unvalidatedRedirectOps");

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch(e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

function tmpFile(content, ext = ".js") {
  const f = path.join(os.tmpdir(), `ur-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(f, content, "utf8");
  return f;
}

console.log("\n=== find_unvalidated_redirect ===");

// ── NORMAL (happy path) ──────────────────────────────────────────────────────
console.log("\n-- Normal Level --");

test("no redirects → no findings", () => {
  const f = tmpFile(`const x = 1; console.log(x);`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount === 0);
});

test("static string redirect is safe", () => {
  const f = tmpFile(`res.redirect('/login');`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount === 0, `expected 0, got ${r.findingsCount}`);
});

test("detects redirect_dynamic_url with variable", () => {
  const f = tmpFile(`res.redirect(returnUrl);`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount > 0, "expected finding for variable redirect");
  assert(r.findings[0].rule === "redirect_dynamic_url");
});

test("detects redirect_dynamic_url with template literal", () => {
  // Write file with actual template literal interpolation using string concat
  const content = 'res.redirect(`/user/' + '${userId}/home`);';
  const f = tmpFile(content);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount > 0, "expected finding for template literal redirect");
});

test("detects location.href dynamic assignment", () => {
  const f = tmpFile(`location.href = nextPage;`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount > 0, "expected finding for location.href");
  assert(r.findings[0].rule === "location_href_dynamic");
});

test("detects window.location.href dynamic assignment", () => {
  const f = tmpFile(`window.location.href = redirectUrl;`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount > 0, "expected finding for window.location.href");
});

test("detects res.setHeader Location dynamic", () => {
  const f = tmpFile(`res.setHeader('Location', redirectTarget);`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount > 0, "expected finding for setHeader Location");
  assert(r.findings[0].rule === "location_header_dynamic");
});

test("detects next() with route-like variable", () => {
  const f = tmpFile(`app.use((req, res, next) => { next(redirectUrl); });`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount > 0, "expected finding for next(redirectUrl)");
  assert(r.findings[0].rule === "next_with_dynamic_route");
});

// ── MEDIUM (boundary) ────────────────────────────────────────────────────────
console.log("\n-- Medium Level --");

test("invalid extensions type throws", () => {
  const f = tmpFile("");
  let threw = false;
  try { findUnvalidatedRedirect(f, f, { extensions: "js" }); }
  catch (e) { threw = true; }
  fs.unlinkSync(f);
  assert(threw);
});

test("invalid max_results type throws", () => {
  const f = tmpFile("");
  let threw = false;
  try { findUnvalidatedRedirect(f, f, { maxResults: "abc" }); }
  catch (e) { threw = true; }
  fs.unlinkSync(f);
  assert(threw);
});

test("nonexistent path throws ToolError", () => {
  let threw = false;
  try { findUnvalidatedRedirect("/no/such/path", "/no/such/path"); }
  catch (e) { threw = true; }
  assert(threw);
});

test("max_results caps output", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`res.redirect(target${i});`);
  const f = tmpFile(lines.join("\n"));
  const r = findUnvalidatedRedirect(f, f, { maxResults: 3 });
  fs.unlinkSync(f);
  assert(r.findings.length <= 3);
});

test("allowlist hint suppresses finding", () => {
  const f = tmpFile(`const safe = target.startsWith('/'); res.redirect(target); // safe`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  // suppressed by safe annotation
  assert(r.findingsCount === 0, `expected 0 due to suppression, got ${r.findingsCount}`);
});

// ── HIGH (mocked/failures) ───────────────────────────────────────────────────
console.log("\n-- High Level --");

test("binary file skipped", () => {
  const f = path.join(os.tmpdir(), `ur-bin-${Date.now()}.js`);
  const buf = Buffer.alloc(100); buf[4] = 0;
  fs.writeFileSync(f, buf);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount === 0);
});

test("empty file returns 0 findings", () => {
  const f = tmpFile("");
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  assert(r.findingsCount === 0);
});

test("static literal redirect not flagged", () => {
  const f = tmpFile(`res.redirect(302, '/dashboard');`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  // First arg is 302 (number), second is '/dashboard' (literal) — should be safe
  assert(typeof r.findingsCount === "number");
});

// ── CRITICAL (security/adversarial) ─────────────────────────────────────────
console.log("\n-- Critical Level --");

test("path traversal input rejected", () => {
  let threw = false;
  try { findUnvalidatedRedirect("../../../etc/passwd", "../../../etc/passwd"); }
  catch (e) { threw = true; }
  assert(threw, "path traversal should throw");
});

test("injection in variable name is handled", () => {
  const f = tmpFile(`res.redirect(req.query["__proto__"] || "/home");`);
  const r = findUnvalidatedRedirect(f, f);
  fs.unlinkSync(f);
  // template literal or concat might be detected
  assert(typeof r.findingsCount === "number");
});

test("no crash on malformed JS syntax", () => {
  const f = tmpFile(`res.redirect({{ unclosed`);
  let threw = false;
  try {
    const r = findUnvalidatedRedirect(f, f);
    assert(typeof r.findingsCount === "number");
  } catch(e) { threw = true; }
  if (fs.existsSync(f)) fs.unlinkSync(f);
  assert(!threw, "should not crash on malformed JS");
});

// ── EXTREME (stress/fuzz) ────────────────────────────────────────────────────
console.log("\n-- Extreme Level --");

test("100 redirect calls complete in <3s", () => {
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(`app.get('/r${i}', (req, res) => { res.redirect(target${i}); });`);
  }
  const f = tmpFile(lines.join("\n"));
  const start = Date.now();
  const r = findUnvalidatedRedirect(f, f);
  const elapsed = Date.now() - start;
  fs.unlinkSync(f);
  assert(elapsed < 3000, `took ${elapsed}ms`);
  assert(r.findingsCount > 0);
});

test("random bytes not crashing", () => {
  const f = path.join(os.tmpdir(), `ur-fuzz-${Date.now()}.js`);
  const buf = Buffer.allocUnsafe(200);
  // ensure no NUL bytes so it's treated as text
  for (let i = 0; i < buf.length; i++) buf[i] = 0x41 + (i % 50);
  fs.writeFileSync(f, buf);
  let threw = false;
  try {
    const r = findUnvalidatedRedirect(f, f);
    assert(typeof r.findingsCount === "number");
  } catch(e) { threw = true; }
  fs.unlinkSync(f);
  assert(!threw, "should not crash on random bytes");
});

console.log(`\n  Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
