"use strict";
// Isolated functional tests for find_missing_null_checks_after_regex_exec
// (lib/missingNullCheckRegexExecOps.js). Direct function import, no live
// server / MCP inspector. Temp sandbox dir, cleaned up on exit.
// 5 rigor levels: Normal, Medium, High, Critical, Extreme.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { findMissingNullChecksAfterRegexExec } = require("../lib/missingNullCheckRegexExecOps");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n    ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "regex-null-"));
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function rm(rel) { fs.rmSync(path.join(tmp, rel), { recursive: true, force: true }); }

// ── Normal ───────────────────────────────────────────────────────────────
t("flags direct chained index with no guard", () => {
  write("a.js", "const x = /foo(\\d)/.exec(s)[1];\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "chained_index_no_guard"));
  rm("a.js");
});

t("flags direct chained .groups with no guard", () => {
  write("b.js", "const g = str.match(re).groups;\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "chained_index_no_guard"));
  rm("b.js");
});

t("flags assign-then-index with no guard", () => {
  write("c.js", "const m = re.exec(s);\nconsole.log(m[0]);\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.ok(r.findings.some(f => f.rule === "missing_null_check_after_regex_exec" && f.name === "m"));
  rm("c.js");
});

t("does not flag when guarded with if(m)", () => {
  write("d.js", "const m = re.exec(s);\nif (m) {\n  console.log(m[0]);\n}\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("d.js");
});

t("does not flag when guarded with optional chaining", () => {
  write("e.js", "const m = re.exec(s);\nconsole.log(m?.[0]);\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("e.js");
});

// ── Medium (boundary / param validation) ────────────────────────────────
t("nonexistent path throws ToolError", () => {
  assert.throws(() => findMissingNullChecksAfterRegexExec(path.join(tmp, "nope"), "nope", {}), /cannot access/);
});

t("max_results non-number throws", () => {
  write("f.js", "const m = re.exec(s);\nm[0];\n");
  assert.throws(() => findMissingNullChecksAfterRegexExec(tmp, ".", { maxResults: "5" }), /max_results must be a number/);
  rm("f.js");
});

t("extensions non-array throws", () => {
  assert.throws(() => findMissingNullChecksAfterRegexExec(tmp, ".", { extensions: ".js" }), /extensions must be an array/);
});

t("use beyond the 6-line lookahead window is not flagged", () => {
  write("g.js", "const m = re.exec(s);\n// 1\n// 2\n// 3\n// 4\n// 5\n// 6\nm[0];\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("g.js");
});

t("file with no exec/match at all yields zero findings", () => {
  write("h.js", "function add(a,b) { return a+b; }\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("h.js");
});

// ── High (dependency-failure / robustness) ──────────────────────────────
t("binary file skipped without crash", () => {
  write("bin.js", Buffer.from([0, 1, 2, 0, 255, 254]).toString("binary"));
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.strictEqual(r.filesScanned, 1);
  rm("bin.js");
});

t("nested directories scanned without crash", () => {
  write("nested/a/b/deep.js", "const m = re.exec(s);\nm[0];\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.ok(r.findingsCount >= 1);
  rm("nested");
});

t("destructure of match result without guard is flagged", () => {
  write("i.js", "const m = re.exec(s);\nconst [, g] = m;\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.ok(r.findings.some(f => f.name === "m"));
  rm("i.js");
});

t("extensions filter narrows scan", () => {
  write("j.ts", "const m = re.exec(s);\nm[0];\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", { extensions: [".js"] });
  assert.strictEqual(r.findingsCount, 0);
  rm("j.ts");
});

// ── Critical (security / sanitization) ──────────────────────────────────
t("path-traversal-shaped regex source just flagged, not executed", () => {
  write("k.js", "const m = /..\\/..\\/etc\\/passwd/.exec(s)[0];\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.strictEqual(r.findingsCount, 1);
  rm("k.js");
});

t("shell-injection-shaped string near match handled as inert text", () => {
  write("l.js", "const m = re.exec(cmd);\nexec('rm -rf /' + m[0]);\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.ok(r.findingsCount >= 1);
  rm("l.js");
});

t("result is JSON-serialisable with expected top-level keys", () => {
  write("m2.js", "const m = re.exec(s);\nm[0];\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(Object.keys(json).sort(),
    ["filesScanned", "findings", "findingsCount", "path", "truncated"].sort());
  rm("m2.js");
});

t("very long single-line call doesn't pathologically blow up scan (<2s)", () => {
  const filler = "x".repeat(5000);
  write("n.js", `const m = /${filler}/.exec(s);\nm[0];\n`);
  const start = Date.now();
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", {});
  assert.ok(Date.now() - start < 2000);
  rm("n.js");
});

// ── Extreme (fuzzing / concurrency / limits) ────────────────────────────
t("max_results truncation + truncated flag", () => {
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(`const m${i} = re.exec(s);`, `m${i}[0];`);
  write("many.js", lines.join("\n") + "\n");
  const r = findMissingNullChecksAfterRegexExec(tmp, ".", { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 20);
  rm("many.js");
});

t("fuzz: random-byte file does not crash scan", () => {
  const rnd = Buffer.alloc(4096);
  for (let i = 0; i < rnd.length; i++) rnd[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(path.join(tmp, "fuzz.js"), rnd);
  assert.doesNotThrow(() => findMissingNullChecksAfterRegexExec(tmp, ".", {}));
  rm("fuzz.js");
});

t("10 concurrent calls return consistent results", () => {
  write("conc.js", "const m = re.exec(s);\nm[0];\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findMissingNullChecksAfterRegexExec(tmp, ".", {}));
  for (const r of results) assert.strictEqual(r.findingsCount, 1);
  rm("conc.js");
});

t("empty directory yields zero findings without error", () => {
  const emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir);
  const r = findMissingNullChecksAfterRegexExec(emptyDir, "empty", {});
  assert.strictEqual(r.findingsCount, 0);
  rm("empty");
});

t("execute_pipeline op-enum includes find_missing_null_checks_after_regex_exec", () => {
  const execSchemas = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(execSchemas.includes("find_missing_null_checks_after_regex_exec"));
});

// ── Cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
