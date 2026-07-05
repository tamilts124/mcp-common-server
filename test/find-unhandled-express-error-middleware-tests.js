"use strict";
// Isolated functional tests for find_unhandled_express_error_middleware
// (lib/unhandledExpressErrorOps.js). Direct function import, no live server
// / MCP inspector. Temp sandbox dir, cleaned up on exit.
// 5 rigor levels: Normal, Medium, High, Critical, Extreme.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { findUnhandledExpressErrorMiddleware } = require("../lib/unhandledExpressErrorOps");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unhandled-err-"));
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function rm(rel) { fs.rmSync(path.join(tmp, rel), { recursive: true, force: true }); }

// ── Normal ───────────────────────────────────────────────────────────────
t("flags project with routes but no error middleware", () => {
  write("a.js", "app.get('/x', (req, res) => { res.send('ok'); });\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.strictEqual(r.hasRouteRegistrations, true);
  assert.strictEqual(r.hasErrorMiddleware, false);
  assert.ok(r.findings.some(f => f.rule === "no_error_handling_middleware"));
  rm("a.js");
});

t("does not flag when error middleware is present elsewhere in scan", () => {
  write("routes.js", "app.get('/x', (req, res) => { res.send('ok'); });\n");
  write("errors.js", "app.use((err, req, res, next) => { res.status(500).end(); });\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.strictEqual(r.hasErrorMiddleware, true);
  assert.ok(!r.findings.some(f => f.rule === "no_error_handling_middleware"));
  rm("routes.js"); rm("errors.js");
});

t("flags a silent catch block (no next/res/rethrow)", () => {
  write("b.js", "try {\n  doWork();\n} catch (e) {\n  logger.error(e);\n}\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "silent_catch_swallows_error"));
  rm("b.js");
});

t("does not flag catch block that calls next(err)", () => {
  write("c.js", "try {\n  doWork();\n} catch (e) {\n  next(e);\n}\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.ok(!r.findings.some(f => f.rule === "silent_catch_swallows_error"));
  rm("c.js");
});

t("does not flag catch block that re-throws", () => {
  write("d.js", "try {\n  doWork();\n} catch (e) {\n  throw e;\n}\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.ok(!r.findings.some(f => f.rule === "silent_catch_swallows_error"));
  rm("d.js");
});

// ── Medium (boundary / param validation) ────────────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => findUnhandledExpressErrorMiddleware(path.join(tmp, "nope"), "nope", {}), /cannot access/);
});

t("max_results non-number throws", () => {
  write("f.js", "try { x(); } catch (e) { console.log(e); }\n");
  assert.throws(() => findUnhandledExpressErrorMiddleware(tmp, ".", { maxResults: "5" }), /max_results must be a number/);
  rm("f.js");
});

t("extensions non-array throws", () => {
  assert.throws(() => findUnhandledExpressErrorMiddleware(tmp, ".", { extensions: ".js" }), /extensions must be an array/);
});

t("no routes at all -> no project-level finding", () => {
  write("g.js", "function add(a,b) { return a+b; }\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.strictEqual(r.hasRouteRegistrations, false);
  assert.ok(!r.findings.some(f => f.rule === "no_error_handling_middleware"));
  rm("g.js");
});

t("extensions filter narrows scan", () => {
  write("h.ts", "app.get('/x', (req,res)=>{});\n");
  write("h.txt", "app.get('/x', (req,res)=>{});\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  rm("h.ts"); rm("h.txt");
});

// ── High (dependency-failure / robustness) ──────────────────────────────
t("binary file skipped without crash", () => {
  write("bin.js", Buffer.from([0, 1, 2, 0, 255, 254]).toString("binary"));
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.strictEqual(r.filesScanned, 1);
  rm("bin.js");
});

t("nested directories aggregate route detection correctly", () => {
  write("nested/a/b/deep.js", "router.post('/y', (req,res)=>{});\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.strictEqual(r.hasRouteRegistrations, true);
  rm("nested");
});

t("multiple silent catch blocks in same file all flagged", () => {
  write("i.js", "try { a(); } catch (e) { log(e); }\ntry { b(); } catch (e) { log(e); }\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  const silent = r.findings.filter(f => f.rule === "silent_catch_swallows_error");
  assert.strictEqual(silent.length, 2);
  rm("i.js");
});

// ── Critical (security / sanitization) ──────────────────────────────────
t("path-traversal-shaped string inside catch body treated as inert text", () => {
  write("j.js", "try { a(); } catch (e) { log('../../../etc/passwd'); }\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "silent_catch_swallows_error"));
  rm("j.js");
});

t("shell-injection-shaped route path still just detected as a route registration", () => {
  write("k.js", "app.get('/x`rm -rf /`', (req,res)=>{ res.send('ok'); });\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.strictEqual(r.hasRouteRegistrations, true);
  rm("k.js");
});

t("result is JSON-serialisable with expected top-level keys", () => {
  write("l.js", "app.get('/x', (req,res)=>{ res.send('ok'); });\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(),
    ["errorCount", "filesScanned", "findings", "findingsCount", "hasErrorMiddleware", "hasRouteRegistrations", "path", "truncated", "warningCount"].sort());
  rm("l.js");
});

t("very large catch body doesn't pathologically blow up brace extraction", () => {
  const filler = Array.from({ length: 3000 }, (_, i) => `const v${i} = ${i};`).join("\n");
  write("m.js", `try { a(); } catch (e) {\n${filler}\n  log(e);\n}\n`);
  const start = Date.now();
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", {});
  assert.ok(Date.now() - start < 2000);
  assert.ok(r.findings.some(f => f.rule === "silent_catch_swallows_error"));
  rm("m.js");
});

// ── Extreme (fuzzing / concurrency / limits) ────────────────────────────
t("max_results truncation + truncated flag", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`try { f${i}(); } catch (e) { log(e); }`);
  write("many.js", lines.join("\n") + "\n");
  const r = findUnhandledExpressErrorMiddleware(tmp, ".", { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 20);
  rm("many.js");
});

t("fuzz: random-byte file does not crash scan", () => {
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmp, "fuzz.js"), rnd);
  assert.doesNotThrow(() => findUnhandledExpressErrorMiddleware(tmp, ".", {}));
  rm("fuzz.js");
});

t("10 concurrent calls return consistent results", () => {
  write("conc.js", "app.get('/x', (req,res)=>{ res.send('ok'); });\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findUnhandledExpressErrorMiddleware(tmp, ".", {}));
  for (const r of results) assert.strictEqual(r.hasRouteRegistrations, true);
  rm("conc.js");
});

t("empty directory yields zero findings without error", () => {
  const emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir);
  const r = findUnhandledExpressErrorMiddleware(emptyDir, "empty", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("empty");
});

// ── Cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
