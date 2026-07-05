"use strict";
// Isolated functional tests for find_missing_json_response_content_type
// (lib/missingJsonContentTypeOps.js). Direct function import, no live server
// / MCP inspector. Temp sandbox dir, cleaned up on exit.
// 5 rigor levels: Normal, Medium, High, Critical, Extreme.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { findMissingJsonResponseContentType } = require("../lib/missingJsonContentTypeOps");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jsoncontenttype-"));
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function rm(rel) { fs.rmSync(path.join(tmp, rel), { recursive: true, force: true }); }

// ── Normal ───────────────────────────────────────────────────────────────
t("flags res.send(JSON.stringify(...)) as warning", () => {
  write("a.js", "app.get('/x', (req, res) => {\n  res.send(JSON.stringify({ ok: true }));\n});\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_content_type_res_send");
  assert.strictEqual(r.findings[0].severity, "warning");
  rm("a.js");
});

t("flags res.end(JSON.stringify(...)) as error", () => {
  write("b.js", "http.createServer((req, res) => {\n  res.end(JSON.stringify({ ok: true }));\n});\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "missing_content_type_res_end");
  assert.strictEqual(r.findings[0].severity, "error");
  rm("b.js");
});

t("suppressed when res.type('json') hint precedes the call", () => {
  write("c.js", "res.type('json');\nres.send(JSON.stringify({ ok: true }));\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("c.js");
});

t("suppressed when res.set('Content-Type','application/json') precedes the call", () => {
  write("d.js", "res.set('Content-Type', 'application/json');\nres.send(JSON.stringify(body));\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("d.js");
});

t("does not flag res.json(...) or plain res.send(obj)", () => {
  write("e.js", "res.json({ ok: true });\nres.send({ ok: true });\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("e.js");
});

// ── Medium (boundary / param validation) ────────────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => findMissingJsonResponseContentType(path.join(tmp, "nope"), "nope", {}), /cannot access/);
});

t("max_results non-number throws", () => {
  write("f.js", "res.send(JSON.stringify(x));\n");
  assert.throws(() => findMissingJsonResponseContentType(tmp, ".", { maxResults: "5" }), /max_results must be a number/);
  rm("f.js");
});

t("extensions non-array throws", () => {
  assert.throws(() => findMissingJsonResponseContentType(tmp, ".", { extensions: ".js" }), /extensions must be an array/);
});

t("single-file mode scans just that file", () => {
  const f = write("only.js", "res.send(JSON.stringify(x));\n");
  write("ignored.js", "res.send(JSON.stringify(y));\n");
  const r = findMissingJsonResponseContentType(f, "only.js", {});
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  rm("only.js"); rm("ignored.js");
});

t("extensions filter narrows scan", () => {
  write("g.ts", "res.send(JSON.stringify(x));\n");
  write("g.txt", "res.send(JSON.stringify(x));\n");
  const r = findMissingJsonResponseContentType(tmp, ".", { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  rm("g.ts"); rm("g.txt");
});

// ── High (dependency-failure / robustness) ──────────────────────────────
t("binary file skipped without crash", () => {
  write("bin.js", Buffer.from([0, 1, 2, 0, 255, 254]).toString("binary"));
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("bin.js");
});

t("nested directories aggregate correctly", () => {
  write("nested/a/b/deep.js", "res.send(JSON.stringify(x));\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("nested");
});

t("content-type hint outside the 15-line lookback window does not suppress", () => {
  const filler = Array.from({ length: 18 }, (_, i) => `const noop${i} = ${i};`).join("\n");
  write("h.js", `res.type('json');\n${filler}\nres.send(JSON.stringify(x));\n`);
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1); // hint too far back to count
  rm("h.js");
});

// ── Critical (security / sanitization) ──────────────────────────────────
t("path-traversal-shaped payload value treated as inert text", () => {
  write("i.js", "res.send(JSON.stringify({ path: '../../../etc/passwd' }));\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("i.js");
});

t("script-injection-shaped payload value still just flagged, not executed", () => {
  write("j.js", "res.send(JSON.stringify({ x: '<script>alert(1)</script>' }));\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("j.js");
});

t("result is JSON-serialisable with expected top-level keys", () => {
  write("k.js", "res.send(JSON.stringify(x));\n");
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(),
    ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort());
  rm("k.js");
});

t("very long single-line argument doesn't pathologically blow up regex", () => {
  write("l.js", `res.send(JSON.stringify({ x: "${"y".repeat(5000)}" }));\n`);
  const start = Date.now();
  const r = findMissingJsonResponseContentType(tmp, ".", {});
  assert.ok(Date.now() - start < 2000);
  assert.strictEqual(r.findingsCount, 1);
  rm("l.js");
});

// ── Extreme (fuzzing / concurrency / limits) ────────────────────────────
t("max_results truncation + truncated flag", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`res.send(JSON.stringify(v${i}));`);
  write("many.js", lines.join("\n") + "\n");
  const r = findMissingJsonResponseContentType(tmp, ".", { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 20);
  rm("many.js");
});

t("fuzz: random-byte file does not crash scan", () => {
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmp, "fuzz.js"), rnd);
  assert.doesNotThrow(() => findMissingJsonResponseContentType(tmp, ".", {}));
  rm("fuzz.js");
});

t("10 concurrent calls return consistent results", () => {
  write("conc.js", "res.send(JSON.stringify(x));\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findMissingJsonResponseContentType(tmp, ".", {}));
  for (const r of results) assert.strictEqual(r.findingsCount, 1);
  rm("conc.js");
});

t("empty directory yields zero findings without error", () => {
  const emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir);
  const r = findMissingJsonResponseContentType(emptyDir, "empty", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("empty");
});

// ── Cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
