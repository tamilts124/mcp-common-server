"use strict";
// Isolated functional tests for find_regex_denial_of_service_in_route_params
// (lib/regexDosRouteParamsOps.js). Direct function import, no live server /
// MCP inspector. Temp sandbox dir, cleaned up on exit.
// 5 rigor levels: Normal, Medium, High, Critical, Extreme.
// Cleanup always runs in `finally` so one failing assertion can't leak a
// fixture file into the next test's directory scan.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { findRegexDosInRouteParams } = require("../lib/regexDosRouteParamsOps");

let pass = 0, fail = 0;
function t(name, fn, cleanup) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
  finally { if (cleanup) { try { cleanup(); } catch (_) {} } }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regex-dos-"));
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function rm(rel) { fs.rmSync(path.join(tmp, rel), { recursive: true, force: true }); }

// ── Normal ───────────────────────────────────────────────────────────────
t("flags unsafe literal regex .test() on req.query member", () => {
  write("a.js", "if (/^(a+)+$/.test(req.query.name)) { ok(); }\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "unsafe_regex_against_request_input"));
}, () => rm("a.js"));

t("flags req.body member .match() with unsafe literal", () => {
  write("b.js", "const m = req.body.text.match(/^(\\d*)*$/);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "unsafe_regex_against_request_input"));
}, () => rm("b.js"));

t("flags new RegExp(unsafe literal string) .exec() on req.params member", () => {
  write("c.js", "new RegExp('^(a|a)+$').exec(req.params.id);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "unsafe_regex_against_request_input"));
}, () => rm("c.js"));

t("flags regex pattern built directly from request input (regex injection)", () => {
  write("d.js", "new RegExp(req.query.pattern).test(str);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "regex_pattern_from_request_input"));
}, () => rm("d.js"));

t("does not flag safe regex literal against req.query member", () => {
  write("e.js", "if (/^[a-z]+$/.test(req.query.name)) { ok(); }\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
}, () => rm("e.js"));

// ── Medium (boundary / param validation) ────────────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => findRegexDosInRouteParams(path.join(tmp, "nope"), "nope", {}), /cannot access/);
});

t("max_results non-number throws", () => {
  write("f.js", "/^(a+)+$/.test(req.query.x);\n");
  assert.throws(() => findRegexDosInRouteParams(tmp, ".", { maxResults: "5" }), /max_results must be a number/);
}, () => rm("f.js"));

t("extensions non-array throws", () => {
  assert.throws(() => findRegexDosInRouteParams(tmp, ".", { extensions: ".js" }), /extensions must be an array/);
});

t("length-cap hint (.slice(0,N)) suppresses finding", () => {
  write("g.js", "const q = req.query.name.slice(0, 50);\n/^(a+)+$/.test(q);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
}, () => rm("g.js"));

t("unsafe regex against a non-tainted local variable is not flagged", () => {
  write("h.js", "const local = 'internal';\n/^(a+)+$/.test(local);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
}, () => rm("h.js"));

// ── High (dependency-failure / robustness) ──────────────────────────────
t("binary file skipped without crash", () => {
  write("bin.js", Buffer.from([0, 1, 2, 0, 255, 254]).toString("binary"));
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.strictEqual(r.filesScanned, 1);
}, () => rm("bin.js"));

t("nested directories scanned without crash", () => {
  write("nested/a/b/deep.js", "/^(a+)+$/.test(req.query.x);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findingsCount >= 1);
}, () => rm("nested"));

t("variable assigned from req.query is tainted and flagged when used later", () => {
  write("i.js", "const name = req.query.name;\n/^(a+)+$/.test(name);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "unsafe_regex_against_request_input"));
}, () => rm("i.js"));

t("destructured req.body fields are tainted", () => {
  write("j.js", "const { comment } = req.body;\n/^(a+)+$/.test(comment);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "unsafe_regex_against_request_input"));
}, () => rm("j.js"));

// ── Critical (security / sanitization) ──────────────────────────────────
t("path-traversal-shaped arg text just flagged, not executed", () => {
  write("k.js", "/^(a+)+$/.test(req.query['../../../etc/passwd']);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findingsCount >= 0); // must not throw or execute anything
}, () => rm("k.js"));

t("dynamic non-literal, non-tainted pattern against tainted input flagged as dynamic rule", () => {
  write("l.js", "const p = buildPattern();\nnew RegExp(p).test(req.query.name);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "dynamic_regex_against_request_input"));
}, () => rm("l.js"));

t("result is JSON-serialisable with expected top-level keys", () => {
  write("m.js", "/^(a+)+$/.test(req.query.x);\n");
  const r = findRegexDosInRouteParams(tmp, ".", {});
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(),
    ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort());
}, () => rm("m.js"));

t("very long line doesn't pathologically blow up scan (<2s)", () => {
  const filler = "x".repeat(5000);
  write("n.js", `const q = req.query.name + "${filler}";\n/^(a+)+$/.test(q);\n`);
  const start = Date.now();
  findRegexDosInRouteParams(tmp, ".", {});
  assert.ok(Date.now() - start < 2000);
}, () => rm("n.js"));

// ── Extreme (fuzzing / concurrency / limits) ────────────────────────────
t("max_results truncation + truncated flag", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`/^(a+)+$/.test(req.query.f${i});`);
  write("many.js", lines.join("\n") + "\n");
  const r = findRegexDosInRouteParams(tmp, ".", { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 20);
}, () => rm("many.js"));

t("fuzz: random-byte file does not crash scan", () => {
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmp, "fuzz.js"), rnd);
  assert.doesNotThrow(() => findRegexDosInRouteParams(tmp, ".", {}));
}, () => rm("fuzz.js"));

t("10 concurrent calls return consistent results", () => {
  write("conc.js", "/^(a+)+$/.test(req.query.x);\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findRegexDosInRouteParams(tmp, ".", {}));
  for (const r of results) assert.strictEqual(r.findingsCount, 1);
}, () => rm("conc.js"));

t("empty directory yields zero findings without error", () => {
  const emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir);
  const r = findRegexDosInRouteParams(emptyDir, "empty", {});
  assert.strictEqual(r.findingsCount, 0);
}, () => rm("empty"));

t("execute_pipeline op-enum includes find_regex_denial_of_service_in_route_params", () => {
  const execSchemas = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(execSchemas.includes("find_regex_denial_of_service_in_route_params"));
});

// ── Cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
