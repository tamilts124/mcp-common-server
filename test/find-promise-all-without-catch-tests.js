"use strict";
// Isolated functional tests for find_promise_all_without_catch
// (lib/promiseAllWithoutCatchOps.js). Direct function import, no live server
// / MCP inspector. Temp sandbox dir, cleaned up on exit.
// 5 rigor levels: Normal, Medium, High, Critical, Extreme.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { findPromiseAllWithoutCatch } = require("../lib/promiseAllWithoutCatchOps");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promise-all-"));
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function rm(rel) { fs.rmSync(path.join(tmp, rel), { recursive: true, force: true }); }

// ── Normal ───────────────────────────────────────────────────────────────
t("flags bare Promise.all with no catch and no try", () => {
  write("a.js", "async function f() {\n  const r = await Promise.all([p1, p2]);\n  return r;\n}\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "promise_all_without_catch" && f.method === "Promise.all"));
  rm("a.js");
});

t("flags bare Promise.allSettled with no catch and no try", () => {
  write("b.js", "Promise.allSettled([p1, p2]);\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.ok(r.findings.some(f => f.method === "Promise.allSettled"));
  rm("b.js");
});

t("does not flag Promise.all with .catch( chained", () => {
  write("c.js", "Promise.all([p1, p2]).catch(err => log(err));\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("c.js");
});

t("does not flag Promise.all inside a try block", () => {
  write("d.js", "async function f() {\n  try {\n    const r = await Promise.all([p1, p2]);\n    return r;\n  } catch (e) {\n    log(e);\n  }\n}\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("d.js");
});

t("directory scan aggregates findings across files", () => {
  write("e1.js", "Promise.all([p1]);\n");
  write("e2.js", "Promise.all([p2]);\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 2);
  rm("e1.js"); rm("e2.js");
});

// ── Medium (boundary / param validation) ────────────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => findPromiseAllWithoutCatch(path.join(tmp, "nope"), "nope", {}), /cannot access/);
});

t("max_results non-number throws", () => {
  write("f.js", "Promise.all([p1]);\n");
  assert.throws(() => findPromiseAllWithoutCatch(tmp, ".", { maxResults: "5" }), /max_results must be a number/);
  rm("f.js");
});

t("extensions non-array throws", () => {
  assert.throws(() => findPromiseAllWithoutCatch(tmp, ".", { extensions: ".js" }), /extensions must be an array/);
});

t("single-file mode scans the given file regardless of extensions filter", () => {
  const p = write("g.weird", "Promise.all([p1]);\n");
  const r = findPromiseAllWithoutCatch(p, "g.weird", { extensions: [".js"] });
  assert.strictEqual(r.findingsCount, 1);
  rm("g.weird");
});

t("file with no Promise.all/allSettled at all yields zero findings", () => {
  write("h.js", "function add(a,b) { return a+b; }\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("h.js");
});

// ── High (dependency-failure / robustness) ──────────────────────────────
t("binary file skipped without crash", () => {
  write("bin.js", Buffer.from([0, 1, 2, 0, 255, 254]).toString("binary"));
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.filesScanned, 1);
  rm("bin.js");
});

t("nested directories scanned without crash", () => {
  write("nested/a/b/deep.js", "Promise.all([p1]);\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.ok(r.findingsCount >= 1);
  rm("nested");
});

t(".catch( chained across a newline is still recognized as handled", () => {
  write("i.js", "Promise.all([p1, p2])\n  .catch(err => log(err));\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("i.js");
});

t("call outside try whose result is only awaited later inside a try is still flagged (call-site scope)", () => {
  write("j.js", "async function f() {\n  const p = Promise.all([p1, p2]);\n  try {\n    await p;\n  } catch (e) { log(e); }\n}\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("j.js");
});

// ── Critical (security / sanitization) ──────────────────────────────────
t("path-traversal-shaped array element still just flagged, not executed", () => {
  write("k.js", "Promise.all(['../../../etc/passwd', p2]);\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("k.js");
});

t("shell-injection-shaped string argument handled as inert text", () => {
  write("l.js", "Promise.all([exec('rm -rf /'), p2]);\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("l.js");
});

t("result is JSON-serialisable with expected top-level keys", () => {
  write("m.js", "Promise.all([p1]);\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(),
    ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated"].sort());
  rm("m.js");
});

t("very long single-line call doesn't pathologically blow up scan (<2s)", () => {
  const filler = Array.from({ length: 3000 }, (_, i) => `p${i}`).join(", ");
  write("n.js", `Promise.all([${filler}]);\n`);
  const start = Date.now();
  const r = findPromiseAllWithoutCatch(tmp, ".", {});
  assert.ok(Date.now() - start < 2000);
  assert.strictEqual(r.findingsCount, 1);
  rm("n.js");
});

// ── Extreme (fuzzing / concurrency / limits) ────────────────────────────
t("max_results truncation + truncated flag", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`Promise.all([p${i}]);`);
  write("many.js", lines.join("\n") + "\n");
  const r = findPromiseAllWithoutCatch(tmp, ".", { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 20);
  rm("many.js");
});

t("fuzz: random-byte file does not crash scan", () => {
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmp, "fuzz.js"), rnd);
  assert.doesNotThrow(() => findPromiseAllWithoutCatch(tmp, ".", {}));
  rm("fuzz.js");
});

t("10 concurrent calls return consistent results", () => {
  write("conc.js", "Promise.all([p1]);\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findPromiseAllWithoutCatch(tmp, ".", {}));
  for (const r of results) assert.strictEqual(r.findingsCount, 1);
  rm("conc.js");
});

t("empty directory yields zero findings without error", () => {
  const emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir);
  const r = findPromiseAllWithoutCatch(emptyDir, "empty", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("empty");
});

t("execute_pipeline op-enum includes find_promise_all_without_catch", () => {
  const execSchemas = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(execSchemas.includes("find_promise_all_without_catch"));
});

// ── Cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
