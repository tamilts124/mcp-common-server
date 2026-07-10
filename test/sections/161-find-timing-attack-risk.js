// test/sections/161-find-timing-attack-risk.js
// Tests for find_timing_attack_risk + find_missing_input_validation tools
"use strict";
const path = require("path");
const os   = require("os");
const fs   = require("fs");
const { findTimingAttackRisk }      = require("../../lib/timingAttackOps");
const { findMissingInputValidation } = require("../../lib/missingInputValidationOps");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  \u2713", msg); passed++; }
  else       { console.error("  \u2717", msg); failed++; }
}

function withTmp(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timing-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  try { fn(dir, file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- find_timing_attack_risk ---

console.log("\n=== find_timing_attack_risk ===\n");

// 1. Normal: detects === on password variable
console.log("1. Detects unsafe_secret_comparison (error)");
withTmp("a.js", `
if (password === req.body.pass) { res.send("ok"); }
`, (dir) => {
  const r = findTimingAttackRisk(dir, ".");
  assert(r.filesScanned >= 1, "scanned files");
  assert(r.findings.some(f => f.rule === "unsafe_secret_comparison"), "found unsafe_secret_comparison");
  assert(r.findings.some(f => f.severity === "error"), "severity=error");
});

// 2. Normal: detects string_equality_on_hash (warning)
console.log("2. Detects string_equality_on_hash (warning)");
withTmp("b.js", `
if (Buffer.from(expected, 'hex') === computed) login();
`, (dir) => {
  const r = findTimingAttackRisk(dir, ".");
  assert(r.findings.some(f => f.rule === "string_equality_on_hash" || f.rule === "unsafe_secret_comparison"), "found hash comparison");
});

// 3. timingSafeEqual in window suppresses finding
console.log("3. Suppression: timingSafeEqual in window");
withTmp("c.js", `
const a = Buffer.from(token);
const b = Buffer.from(req.token);
const ok = crypto.timingSafeEqual(a, b);
if (token === req.token) { /* suppressed */ }
`, (dir) => {
  const r = findTimingAttackRisk(dir, ".");
  assert(r.findings.length === 0, "no findings when timingSafeEqual present");
});

// 4. // safe annotation suppresses
console.log("4. Suppression: // safe annotation");
withTmp("d.js", `
if (secret === "fixed") {} // safe
`, (dir) => {
  const r = findTimingAttackRisk(dir, ".");
  assert(r.findings.length === 0, "no findings with // safe annotation");
});

// 5. Empty file
console.log("5. Empty file -> 0 findings");
withTmp("e.js", "", (dir) => {
  const r = findTimingAttackRisk(dir, ".");
  assert(r.findingsCount === 0, "0 findings on empty file");
});

// 6. max_results cap
console.log("6. max_results cap");
const manyLines = Array.from({length: 50}, (_, i) => `if (password === req.p${i}) {}`).join("\n");
withTmp("f.js", manyLines, (dir) => {
  const r = findTimingAttackRisk(dir, ".", { maxResults: 3 });
  assert(r.findings.length <= 3, "findings capped at 3");
  assert(r.truncated === true, "truncated flag true");
});

// 7. Bad path throws ToolError
console.log("7. Security: bad path throws ToolError");
try {
  findTimingAttackRisk("/nonexistent/path", "/nonexistent/path");
  assert(false, "should throw on bad path");
} catch(e) {
  assert(e.message.includes("cannot access") || e.code === -32602 || e.message.includes("ENOENT"), "throws ToolError on bad path");
}

// 8. Wrong type for extensions
console.log("8. Parameter validation: non-array extensions");
withTmp("g.js", `if (password === x) {}`, (dir) => {
  try {
    findTimingAttackRisk(dir, ".", { extensions: "notarray" });
    assert(false, "should throw");
  } catch(e) {
    assert(e.message.includes("extensions"), "error mentions extensions");
  }
});

// 9. Large file
console.log("9. Large file handling");
withTmp("h.js", `if (password === req.pass) {}\n`.repeat(5000), (dir) => {
  const r = findTimingAttackRisk(dir, ".");
  assert(r.filesScanned >= 1, "handled large file without crash");
});

// 10. Hex string comparison
console.log("10. Hex string comparison (warning)");
withTmp("i.js", `
if (computedHash === "abcdef0123456789abcdef0123456789") { ok(); }
`, (dir) => {
  const r = findTimingAttackRisk(dir, ".");
  assert(r.findings.some(f => f.rule === "string_equality_on_hash"), "detected hex string comparison");
});

// --- find_missing_input_validation ---

console.log("\n=== find_missing_input_validation ===\n");

// 11. POST route with req.body, no validation -> error
console.log("11. POST route with req.body, no validation");
withTmp("route1.js", `
app.post('/users', (req, res) => {
  const name = req.body.name;
  db.insert(name);
  res.json({ ok: true });
});
`, (dir) => {
  const r = findMissingInputValidation(dir, ".");
  assert(r.findings.some(f => f.rule === "route_body_no_validation"), "detected route_body_no_validation");
  assert(r.findings.some(f => f.severity === "error"), "severity=error");
});

// 12. GET route with req.query, no validation -> warning
console.log("12. GET route with req.query, no validation");
withTmp("route2.js", `
app.get('/search', (req, res) => {
  const q = req.query.term;
  res.json({ results: [] });
});
`, (dir) => {
  const r = findMissingInputValidation(dir, ".");
  assert(r.findings.some(f => f.rule === "route_query_no_validation"), "detected route_query_no_validation");
  assert(r.findings.some(f => f.severity === "warning"), "severity=warning");
});

// 13. Joi.object suppresses
console.log("13. Joi.object suppresses all findings");
withTmp("route3.js", `
const schema = Joi.object({ name: Joi.string() });
app.post('/users', (req, res) => {
  const { error } = schema.validate(req.body);
  if (error) return res.status(400).json({error});
  db.insert(req.body.name);
  res.json({ ok: true });
});
`, (dir) => {
  const r = findMissingInputValidation(dir, ".");
  assert(r.findings.length === 0, "no findings when Joi.object present");
});

// 14. z.object suppresses
console.log("14. z.object suppresses findings");
withTmp("route4.js", `
const schema = z.object({ name: z.string() });
app.post('/items', (req, res) => {
  schema.parse(req.body);
  res.json({ ok: true });
});
`, (dir) => {
  const r = findMissingInputValidation(dir, ".");
  assert(r.findings.length === 0, "no findings when z.object present");
});

// 15. express-validator suppresses
console.log("15. express-validator suppresses findings");
withTmp("route5.js", `
const { body } = require('express-validator');
app.post('/login', body('email').isEmail(), (req, res) => {
  const email = req.body.email;
  res.json({ ok: true });
});
`, (dir) => {
  const r = findMissingInputValidation(dir, ".");
  assert(r.findings.length === 0, "no findings with express-validator");
});

// 16. Per-line // safe suppresses
console.log("16. // safe annotation suppresses route");
withTmp("route6.js", `
app.post('/data', (req, res) => { // safe
  db.save(req.body);
  res.json({ok:true});
});
`, (dir) => {
  const r = findMissingInputValidation(dir, ".");
  assert(r.findings.length === 0, "no findings with // safe annotation");
});

// 17. Non-array extensions -> ToolError
console.log("17. Invalid extensions parameter");
withTmp("route7.js", `app.post('/x', (r,s) => { r.body; });`, (dir) => {
  try {
    findMissingInputValidation(dir, ".", { extensions: 42 });
    assert(false, "should throw");
  } catch(e) {
    assert(e.message.includes("extensions"), "error mentions extensions");
  }
});

// 18. No Express routes -> 0 findings
console.log("18. No Express routes -> 0 findings");
withTmp("noroutes.js", `
const x = req.body.thing; // bare access, no route
`, (dir) => {
  const r = findMissingInputValidation(dir, ".");
  assert(r.findingsCount === 0, "0 findings with no route registration");
});

// 19. Bad path throws
console.log("19. Bad path throws ToolError");
try {
  findMissingInputValidation("/does/not/exist", "/does/not/exist");
  assert(false, "should throw");
} catch(e) {
  assert(e.message.includes("cannot access") || e.message.includes("ENOENT"), "throws on bad path");
}

// 20. router.put detected
console.log("20. router.put with req.body detected");
withTmp("route8.js", `
router.put('/item/:id', (req, res) => {
  const data = req.body.value;
  res.json({ updated: data });
});
`, (dir) => {
  const r = findMissingInputValidation(dir, ".");
  assert(r.findings.some(f => f.rule === "route_body_no_validation"), "detected router.put");
});

// --- Summary ---
console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===\n");
if (failed > 0) process.exit(1);
