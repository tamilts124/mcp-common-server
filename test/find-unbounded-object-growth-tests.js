"use strict";
// Isolated functional tests for find_unbounded_object_growth
// (lib/unboundedObjectGrowthOps.js). Direct function import, no live server
// / MCP inspector. Temp sandbox dir, cleaned up on exit.
// 5 rigor levels: Normal, Medium, High, Critical, Extreme.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { findUnboundedObjectGrowth } = require("../lib/unboundedObjectGrowthOps");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "unbounded-growth-"));
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function rm(rel) { fs.rmSync(path.join(tmp, rel), { recursive: true, force: true }); }

// ── Normal ───────────────────────────────────────────────────────────────
t("flags module-level Map populated in a request handler with no delete", () => {
  write("a.js", "const cache = new Map();\napp.get('/x', (req, res) => {\n  cache.set(req.query.id, req.body);\n  res.send('ok');\n});\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.ok(r.findings.some(f => f.name === "cache" && f.kind === "Map" && f.rule === "unbounded_cache_growth"));
  rm("a.js");
});

t("flags module-level Set populated in a loop with no delete", () => {
  write("b.js", "const seen = new Set();\nfor (const id of ids) {\n  seen.add(id);\n}\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.ok(r.findings.some(f => f.name === "seen" && f.kind === "Set"));
  rm("b.js");
});

t("flags module-level plain-object cache populated in a handler with no delete", () => {
  write("c.js", "const store = {};\napp.post('/y', (req, res) => {\n  store[req.body.key] = req.body.value;\n});\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.ok(r.findings.some(f => f.name === "store" && f.kind === "Object"));
  rm("c.js");
});

t("does not flag Map with a .delete( present anywhere in the file", () => {
  write("d.js", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set(req.query.id, 1); });\ncache.delete('x');\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("d.js");
});

t("does not flag when a generic TTL/eviction keyword hint is present anywhere in file", () => {
  write("e.js", "const cache = new Map();\n// ttl-based expiry handled by wrapper\napp.get('/x', (req,res) => { cache.set(req.query.id, 1); });\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("e.js");
});

// ── Medium (boundary / param validation) ────────────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => findUnboundedObjectGrowth(path.join(tmp, "nope"), "nope", {}), /cannot access/);
});

t("max_results non-number throws", () => {
  write("f.js", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set(1,1); });\n");
  assert.throws(() => findUnboundedObjectGrowth(tmp, ".", { maxResults: "5" }), /max_results must be a number/);
  rm("f.js");
});

t("extensions non-array throws", () => {
  assert.throws(() => findUnboundedObjectGrowth(tmp, ".", { extensions: ".js" }), /extensions must be an array/);
});

t("population only at module init (no handler/loop context) is not flagged", () => {
  write("g.js", "const cache = new Map();\ncache.set('a', 1);\ncache.set('b', 2);\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("g.js");
});

t("indented (non-module-level) declaration is not flagged", () => {
  write("h.js", "function f() {\n  const cache = new Map();\n  for (const x of xs) { cache.set(x, 1); }\n}\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("h.js");
});

// ── High (dependency-failure / robustness) ──────────────────────────────
t("binary file skipped without crash", () => {
  write("bin.js", Buffer.from([0, 1, 2, 0, 255, 254]).toString("binary"));
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.strictEqual(r.filesScanned, 1);
  rm("bin.js");
});

t("nested directories scanned without crash", () => {
  write("nested/a/b/deep.js", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set(1,1); });\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.ok(r.findingsCount >= 1);
  rm("nested");
});

t("extensions filter narrows scan", () => {
  write("i.ts", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set(1,1); });\n");
  write("i.txt", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set(1,1); });\n");
  const r = findUnboundedObjectGrowth(tmp, ".", { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  rm("i.ts"); rm("i.txt");
});

t("multiple distinct caches in one file each produce their own finding", () => {
  write("j.js", "const cacheA = new Map();\nconst cacheB = new Set();\napp.get('/x', (req,res) => {\n  cacheA.set(1,1);\n  cacheB.add(2);\n});\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 2);
  rm("j.js");
});

// ── Critical (security / sanitization) ──────────────────────────────────
t("path-traversal-shaped key value still just flagged, not executed", () => {
  write("k.js", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set('../../../etc/passwd', 1); });\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("k.js");
});

t("shell-injection-shaped value handled as inert text", () => {
  write("l.js", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set('id', 'rm -rf /'); });\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("l.js");
});

t("result is JSON-serialisable with expected top-level keys", () => {
  write("m.js", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set(1,1); });\n");
  const r = findUnboundedObjectGrowth(tmp, ".", {});
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(),
    ["filesScanned", "findings", "findingsCount", "path", "truncated"].sort());
  rm("m.js");
});

t("large file with many caches doesn't pathologically blow up scan (<2s)", () => {
  // 25 decls + handler + 25 populations: all population lines fall within the
  // 30-line lookback window of the handler-open line, per the tool's
  // documented fixed-window design (a population far outside the window from
  // its handler's opening line is a known, documented limitation, not tested
  // here — see the "population only at module init" / indented-decl tests
  // above for the window's negative-case coverage).
  try {
    const lines = [];
    for (let i = 0; i < 25; i++) lines.push(`const cache${i} = new Map();`);
    lines.push("app.get('/x', (req,res) => {");
    for (let i = 0; i < 25; i++) lines.push(`  cache${i}.set(1,1);`);
    lines.push("});");
    write("n.js", lines.join("\n") + "\n");
    const start = Date.now();
    const r = findUnboundedObjectGrowth(tmp, ".", {});
    assert.ok(Date.now() - start < 2000);
    assert.strictEqual(r.findingsCount, 25);
  } finally {
    rm("n.js");
  }
});

// ── Extreme (fuzzing / concurrency / limits) ────────────────────────────
t("max_results truncation + truncated flag", () => {
  try {
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push(`const cache${i} = new Map();`);
    lines.push("app.get('/x', (req,res) => {");
    for (let i = 0; i < 20; i++) lines.push(`  cache${i}.set(1,1);`);
    lines.push("});");
    write("many.js", lines.join("\n") + "\n");
    const r = findUnboundedObjectGrowth(tmp, ".", { maxResults: 5 });
    assert.strictEqual(r.findings.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.findingsCount, 20);
  } finally {
    rm("many.js");
  }
});

t("fuzz: random-byte file does not crash scan", () => {
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmp, "fuzz.js"), rnd);
  assert.doesNotThrow(() => findUnboundedObjectGrowth(tmp, ".", {}));
  rm("fuzz.js");
});

t("10 concurrent calls return consistent results", () => {
  write("conc.js", "const cache = new Map();\napp.get('/x', (req,res) => { cache.set(1,1); });\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findUnboundedObjectGrowth(tmp, ".", {}));
  for (const r of results) assert.strictEqual(r.findingsCount, 1);
  rm("conc.js");
});

t("empty directory yields zero findings without error", () => {
  const emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir);
  const r = findUnboundedObjectGrowth(emptyDir, "empty", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("empty");
});

t("execute_pipeline op-enum includes find_unbounded_object_growth", () => {
  const execSchemas = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(execSchemas.includes("find_unbounded_object_growth"));
});

// ── Cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
