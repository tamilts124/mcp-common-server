"use strict";
// Standalone test script for check_semver_range_strictness (not added to the
// frozen test/run-tests.js — new tool areas get their own script per the
// testing-strategy pivot documented in task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "semver-strict-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { checkSemverRangeStrictness } = require("../lib/semverRangeStrictnessOps");

function writePkg(rel, deps) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ name: "x", version: "1.0.0", dependencies: deps }, null, 2));
}

async function call(args) { return executeTool("check_semver_range_strictness", args); }

(async () => {
  console.log("check_semver_range_strictness tests:");

  writePkg("proj/mixed/package.json", {
    exact: "1.2.3",
    tilde: "~1.2.3",
    caret: "^1.2.3",
    complex: ">=1.2.3 <2.0.0",
    unbounded: "*",
    empty: "",
    gitdep: "git+https://github.com/a/b.git",
  });
  writePkg("proj/allexact/package.json", { a: "1.0.0", b: "2.3.4" });

  await test("Normal: exact pin not flagged, contributes to exactCount", async () => {
    const r = await call({ pkg_path: "proj/mixed/package.json" });
    assert.ok(!r.issues.some(i => i.name === "exact"));
    assert.ok(r.exactCount >= 1);
  });

  await test("Normal: tilde flagged info tier", async () => {
    const r = await call({ pkg_path: "proj/mixed/package.json" });
    const i = r.issues.find(x => x.name === "tilde");
    assert.strictEqual(i.tier, "tilde");
    assert.strictEqual(i.severity, "info");
  });

  await test("Normal: caret flagged info tier", async () => {
    const r = await call({ pkg_path: "proj/mixed/package.json" });
    const i = r.issues.find(x => x.name === "caret");
    assert.strictEqual(i.tier, "caret");
    assert.strictEqual(i.severity, "info");
  });

  await test("Normal: complex comparator range flagged warning", async () => {
    const r = await call({ pkg_path: "proj/mixed/package.json" });
    const i = r.issues.find(x => x.name === "complex");
    assert.strictEqual(i.tier, "complex_range");
    assert.strictEqual(i.severity, "warning");
  });

  await test("Normal: wildcard and empty range flagged unbounded error", async () => {
    const r = await call({ pkg_path: "proj/mixed/package.json" });
    assert.strictEqual(r.issues.find(x => x.name === "unbounded").tier, "unbounded");
    assert.strictEqual(r.issues.find(x => x.name === "empty").severity, "error");
  });

  await test("Normal: git+ specifier skipped entirely (not counted as exact or issue)", async () => {
    const r = await call({ pkg_path: "proj/mixed/package.json" });
    assert.ok(!r.issues.some(i => i.name === "gitdep"));
  });

  await test("Normal: all-exact project has zero issues", async () => {
    const r = await call({ pkg_path: "proj/allexact/package.json" });
    assert.strictEqual(r.issueCount, 0);
    assert.strictEqual(r.exactCount, 2);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────
  await test("Medium: missing package.json throws", async () => {
    await assert.rejects(() => call({ pkg_path: "proj/does-not-exist/package.json" }));
  });

  await test("Medium: malformed JSON throws with parse detail", async () => {
    fs.mkdirSync(path.join(TMP, "proj/malformed"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/malformed/package.json"), "{ not json");
    await assert.rejects(() => call({ pkg_path: "proj/malformed/package.json" }), /malformed JSON/);
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ pkg_path: "proj/allexact/package.json", max_results: "5" }));
  });

  await test("Medium: non-array blocks throws", async () => {
    await assert.rejects(() => call({ pkg_path: "proj/allexact/package.json", blocks: "dependencies" }));
  });

  await test("Medium: package.json with no dependency blocks returns zero scanned, not a crash", async () => {
    fs.mkdirSync(path.join(TMP, "proj/nodeps"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/nodeps/package.json"), JSON.stringify({ name: "x" }));
    const r = await call({ pkg_path: "proj/nodeps/package.json" });
    assert.strictEqual(r.depsScanned, 0);
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: devDependencies scanned by default alongside dependencies", async () => {
    fs.mkdirSync(path.join(TMP, "proj/devdeps"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/devdeps/package.json"), JSON.stringify({ devDependencies: { foo: "*" } }));
    const r = await call({ pkg_path: "proj/devdeps/package.json" });
    assert.strictEqual(r.issues[0].block, "devDependencies");
  });

  await test("High: blocks filter narrows to only requested blocks", async () => {
    fs.mkdirSync(path.join(TMP, "proj/blocksfilter"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/blocksfilter/package.json"), JSON.stringify({ dependencies: { a: "*" }, devDependencies: { b: "*" } }));
    const r = await call({ pkg_path: "proj/blocksfilter/package.json", blocks: ["dependencies"] });
    assert.strictEqual(r.depsScanned, 1);
  });

  await test("High: non-string range value treated as unbounded, not a crash", async () => {
    fs.mkdirSync(path.join(TMP, "proj/badtype"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/badtype/package.json"), JSON.stringify({ dependencies: { a: 123 } }));
    const r = await call({ pkg_path: "proj/badtype/package.json" });
    assert.strictEqual(r.issues[0].tier, "unbounded");
  });

  // ── Critical: security & input sanitization ────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ pkg_path: "../../../../etc/passwd" }));
  });

  await test("Critical: shell/script-injection-shaped range value only reported, never executed", async () => {
    writePkg("proj/adversarial/package.json", { evil: "$(rm -rf /); <script>alert(1)</script>" });
    const r = await call({ pkg_path: "proj/adversarial/package.json" });
    assert.strictEqual(r.issues[0].range, "$(rm -rf /); <script>alert(1)</script>");
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ pkg_path: "proj/allexact/package.json" });
    JSON.stringify(r);
    const known = ["path", "depsScanned", "exactCount", "issueCount", "errorCount", "warningCount", "infoCount", "truncated", "issues", "tierCounts"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency, truncation ──────────────────────────
  await test("Extreme: max_results truncation sets truncated flag", async () => {
    const deps = {};
    for (let i = 0; i < 20; i++) deps[`d${i}`] = "*";
    writePkg("proj/many/package.json", deps);
    const r = await call({ pkg_path: "proj/many/package.json", max_results: 5 });
    assert.strictEqual(r.issues.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.issueCount, 20);
  });

  await test("Extreme: fuzz random-byte package.json throws cleanly (malformed JSON), no crash", async () => {
    fs.mkdirSync(path.join(TMP, "proj/fuzz"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj/fuzz/package.json"), require("crypto").randomBytes(500));
    await assert.rejects(() => call({ pkg_path: "proj/fuzz/package.json" }));
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ pkg_path: "proj/allexact/package.json" })));
    for (const r of results) assert.strictEqual(r.issueCount, 0);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("check_semver_range_strictness"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
