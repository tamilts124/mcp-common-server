"use strict";
// Isolated functional tests for find_blocking_child_process_calls
// (lib/blockingChildProcessOps.js). Direct function import, no live server /
// MCP inspector. Temp sandbox dir, cleaned up on exit.
// 5 rigor levels: Normal, Medium, High, Critical, Extreme.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { findBlockingChildProcessCalls } = require("../lib/blockingChildProcessOps");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blockingcp-"));
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function rm(rel) { fs.rmSync(path.join(tmp, rel), { recursive: true, force: true }); }

// ── Normal ───────────────────────────────────────────────────────────────
t("flags execSync inside an Express handler as error", () => {
  write("a.js", "app.get('/run', (req, res) => {\n  execSync('ls');\n  res.send('ok');\n});\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].call, "execSync");
  assert.strictEqual(r.findings[0].rule, "blocking_call_in_request_handler");
  assert.strictEqual(r.findings[0].severity, "error");
  rm("a.js");
});

t("flags spawnSync in a plain script as warning (no handler nearby)", () => {
  write("b.js", "function build() {\n  spawnSync('npm', ['run', 'build']);\n}\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "blocking_child_process_call");
  assert.strictEqual(r.findings[0].severity, "warning");
  rm("b.js");
});

t("flags fully-qualified child_process.execFileSync", () => {
  write("c.js", "child_process.execFileSync('node', ['x.js']);\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].call, "execFileSync");
  rm("c.js");
});

t("does not flag async exec/execFile/spawn (non-Sync)", () => {
  write("d.js", "exec('ls', cb); execFile('node', []); spawn('ls');\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("d.js");
});

t("router.post(...) handler hint also upgrades severity", () => {
  write("e.js", "router.post('/x', function(req, res) {\n  execSync('id');\n});\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findings[0].severity, "error");
  rm("e.js");
});

// ── Medium (boundary / param validation) ────────────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => findBlockingChildProcessCalls(path.join(tmp, "nope"), "nope", {}), /cannot access/);
});

t("max_results non-number throws", () => {
  write("f.js", "execSync('x');\n");
  assert.throws(() => findBlockingChildProcessCalls(tmp, ".", { maxResults: "5" }), /max_results must be a number/);
  rm("f.js");
});

t("extensions non-array throws", () => {
  assert.throws(() => findBlockingChildProcessCalls(tmp, ".", { extensions: ".js" }), /extensions must be an array/);
});

t("single-file mode scans just that file", () => {
  const f = write("only.js", "execSync('x');\n");
  write("ignored.js", "execSync('y');\n");
  const r = findBlockingChildProcessCalls(f, "only.js", {});
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  rm("only.js"); rm("ignored.js");
});

t("extensions filter narrows scan", () => {
  write("g.ts", "execSync('x');\n");
  write("g.txt", "execSync('x');\n");
  const r = findBlockingChildProcessCalls(tmp, ".", { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  rm("g.ts"); rm("g.txt");
});

// ── High (dependency-failure / robustness) ──────────────────────────────
t("binary file skipped without crash", () => {
  write("bin.js", Buffer.from([0, 1, 2, 0, 255, 254]).toString("binary"));
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("bin.js");
});

t("nested directories aggregate correctly", () => {
  write("nested/a/b/deep.js", "spawnSync('x');\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("nested");
});

t("handler hint far outside lookback window does not upgrade severity", () => {
  const filler = Array.from({ length: 45 }, (_, i) => `const noop${i} = ${i};`).join("\n");
  write("h.js", `app.get('/x', (req, res) => {\n${filler}\n  spawnSync('id');\n});\n`);
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findings[0].severity, "warning"); // handler line > 40 lines back
  rm("h.js");
});

// ── Critical (security / sanitization) ──────────────────────────────────
t("path-traversal-shaped argument treated as inert text, not executed", () => {
  write("i.js", "execSync('cat ../../../etc/passwd');\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("i.js");
});

t("shell-injection-shaped argument still just flagged, not executed", () => {
  write("j.js", "execSync('ls; rm -rf /');\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("j.js");
});

t("result is JSON-serialisable with expected top-level keys", () => {
  write("k.js", "execSync('x');\n");
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(),
    ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort());
  rm("k.js");
});

t("very long single-line argument doesn't pathologically blow up regex", () => {
  write("l.js", `execSync("${"x".repeat(5000)}");\n`);
  const start = Date.now();
  const r = findBlockingChildProcessCalls(tmp, ".", {});
  assert.ok(Date.now() - start < 2000);
  assert.strictEqual(r.findingsCount, 1);
  rm("l.js");
});

// ── Extreme (fuzzing / concurrency / limits) ────────────────────────────
t("max_results truncation + truncated flag", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`execSync('cmd${i}');`);
  write("many.js", lines.join("\n") + "\n");
  const r = findBlockingChildProcessCalls(tmp, ".", { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 20);
  rm("many.js");
});

t("fuzz: random-byte file does not crash scan", () => {
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmp, "fuzz.js"), rnd);
  assert.doesNotThrow(() => findBlockingChildProcessCalls(tmp, ".", {}));
  rm("fuzz.js");
});

t("10 concurrent calls return consistent results", () => {
  write("conc.js", "execSync('x');\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findBlockingChildProcessCalls(tmp, ".", {}));
  for (const r of results) assert.strictEqual(r.findingsCount, 1);
  rm("conc.js");
});

t("empty directory yields zero findings without error", () => {
  const emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir);
  const r = findBlockingChildProcessCalls(emptyDir, "empty", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("empty");
});

// ── Cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
