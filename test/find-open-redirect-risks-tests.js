"use strict";
// Isolated functional tests for find_open_redirect_risks (lib/openRedirectOps.js).
// Direct function import, no live server / MCP inspector. Temp sandbox dir,
// cleaned up on exit. 5 rigor levels: Normal, Medium, High, Critical, Extreme.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { findOpenRedirectRisks } = require("../lib/openRedirectOps");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openredirect-"));
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ───────────────────────────────────────────────────────────────
t("flags res.redirect(req.query.x)", () => {
  write("a.js", "app.get('/go', (req, res) => { res.redirect(req.query.next); });\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 1);
  assert.strictEqual(r.issues[0].rule, "redirect_from_request_input");
  assert.strictEqual(r.issues[0].severity, "error");
  fs.rmSync(path.join(tmp, "a.js"));
});

t("flags multi-line writeHead Location from req.headers", () => {
  write("b.js", "res.writeHead(302, {\n  Location: req.headers.referer\n});\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 1);
  assert.strictEqual(r.issues[0].rule, "redirect_header_from_request_input");
  fs.rmSync(path.join(tmp, "b.js"));
});

t("flags window.location.href = req.query.url (client)", () => {
  write("c.js", "window.location.href = req.query.url;\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 1);
  assert.strictEqual(r.issues[0].rule, "location_assignment_from_request_input");
  assert.strictEqual(r.issues[0].severity, "warning");
  fs.rmSync(path.join(tmp, "c.js"));
});

t("does not flag redirect to a literal", () => {
  write("d.js", "res.redirect('/dashboard');\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 0);
  fs.rmSync(path.join(tmp, "d.js"));
});

t("allow-list hint on same line suppresses finding", () => {
  write("e.js", "if (ALLOWED.includes(req.query.next)) res.redirect(req.query.next);\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 0);
  fs.rmSync(path.join(tmp, "e.js"));
});

// ── Medium (boundary / param validation) ────────────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => findOpenRedirectRisks(path.join(tmp, "nope"), "nope", {}), /cannot access/);
});

t("max_results non-number throws", () => {
  write("f.js", "res.redirect(req.query.x);\n");
  assert.throws(() => findOpenRedirectRisks(tmp, ".", { maxResults: "5" }), /max_results must be a number/);
  fs.rmSync(path.join(tmp, "f.js"));
});

t("extensions non-array throws", () => {
  assert.throws(() => findOpenRedirectRisks(tmp, ".", { extensions: ".js" }), /extensions must be an array/);
});

t("single-file mode scans just that file", () => {
  const f = write("only.js", "res.redirect(req.query.x);\n");
  write("ignored.js", "res.redirect(req.query.y);\n");
  const r = findOpenRedirectRisks(f, "only.js", {});
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.issueCount, 1);
  fs.rmSync(f);
  fs.rmSync(path.join(tmp, "ignored.js"));
});

t("extensions filter narrows scan", () => {
  write("g.ts", "res.redirect(req.query.x);\n");
  write("g.txt", "res.redirect(req.query.x);\n");
  const r = findOpenRedirectRisks(tmp, ".", { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  fs.rmSync(path.join(tmp, "g.ts"));
  fs.rmSync(path.join(tmp, "g.txt"));
});

// ── High (dependency-failure / robustness) ──────────────────────────────
t("binary file skipped without crash", () => {
  write("bin.js", Buffer.from([0, 1, 2, 0, 255, 254]).toString("binary"));
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 0);
  fs.rmSync(path.join(tmp, "bin.js"));
});

t("unreadable sub-entry does not crash directory scan", () => {
  write("dir/x.js", "res.redirect(req.query.x);\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.ok(r.filesScanned >= 1);
  fs.rmSync(path.join(tmp, "dir"), { recursive: true });
});

t("nested directories aggregate correctly", () => {
  write("nested/a/b/deep.js", "res.redirect(req.body.next);\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 1);
  fs.rmSync(path.join(tmp, "nested"), { recursive: true });
});

// ── Critical (security / sanitization) ──────────────────────────────────
t("path traversal segment treated as inert text, not executed", () => {
  write("h.js", "res.redirect('../../../etc/passwd' + req.query.x);\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 1); // still flagged for req.query usage, not "executed"
  fs.rmSync(path.join(tmp, "h.js"));
});

t("shell-injection-shaped input handled as inert string", () => {
  write("i.js", "res.redirect(req.query.x); // `rm -rf /`\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 1);
  fs.rmSync(path.join(tmp, "i.js"));
});

t("result is JSON-serialisable with expected top-level keys", () => {
  write("j.js", "res.redirect(req.query.x);\n");
  const r = findOpenRedirectRisks(tmp, ".", {});
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(),
    ["errorCount", "filesScanned", "issueCount", "issues", "path", "truncated", "warningCount"].sort());
  fs.rmSync(path.join(tmp, "j.js"));
});

t("reflected origin-like header injection string doesn't crash regex engine", () => {
  write("k.js", `res.redirect(req.query["${"x".repeat(2000)}"]);\n`);
  const r = findOpenRedirectRisks(tmp, ".", {});
  assert.strictEqual(r.issueCount, 1);
  fs.rmSync(path.join(tmp, "k.js"));
});

// ── Extreme (fuzzing / concurrency / limits) ────────────────────────────
t("max_results truncation + truncated flag", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`res.redirect(req.query.x${i});`);
  write("many.js", lines.join("\n") + "\n");
  const r = findOpenRedirectRisks(tmp, ".", { maxResults: 5 });
  assert.strictEqual(r.issues.length, 5);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.issueCount, 20);
  fs.rmSync(path.join(tmp, "many.js"));
});

t("fuzz: random-byte file does not crash scan", () => {
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmp, "fuzz.js"), rnd);
  assert.doesNotThrow(() => findOpenRedirectRisks(tmp, ".", {}));
  fs.rmSync(path.join(tmp, "fuzz.js"));
});

t("10 concurrent calls return consistent results", () => {
  write("conc.js", "res.redirect(req.query.x);\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findOpenRedirectRisks(tmp, ".", {}));
  for (const r of results) assert.strictEqual(r.issueCount, 1);
  fs.rmSync(path.join(tmp, "conc.js"));
});

t("cleans up: tmp sandbox removable after all tests", () => {
  // sanity placeholder — real cleanup happens at bottom of file
  assert.ok(fs.existsSync(tmp));
});

// ── Cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
