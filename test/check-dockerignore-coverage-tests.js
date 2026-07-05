"use strict";
// Standalone test script for check_dockerignore_coverage (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dockerignore-cov-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { checkDockerignoreCoverage } = require("../lib/dockerignoreCoverageOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("check_dockerignore_coverage", args); }

(async () => {
  console.log("check_dockerignore_coverage tests:");

  // ── Normal ───────────────────────────────────────────────────────────────
  write("proj1/.dockerignore", "node_modules\n.git\n*.log\ndist/\n!dist/keep.txt\n");
  write("proj1/node_modules/example-pkg/index.js", "x");
  write("proj1/.git/config", "x");
  write("proj1/debug.log", "x");
  write("proj1/dist/bundle.js", "x");
  write("proj1/dist/keep.txt", "x");
  write("proj1/README.md", "x");

  await test("Normal: directory pattern excludes nested files", async () => {
    const r = checkDockerignoreCoverage(path.join(TMP, "proj1"), "proj1", ["node_modules/example-pkg/index.js"]);
    assert.strictEqual(r.results[0].ignored, true);
  });

  await test("Normal: dotdir pattern matches", async () => {
    const r = checkDockerignoreCoverage(path.join(TMP, "proj1"), "proj1", [".git/config"]);
    assert.strictEqual(r.results[0].ignored, true);
  });

  await test("Normal: glob '*.log' matches file", async () => {
    const r = checkDockerignoreCoverage(path.join(TMP, "proj1"), "proj1", ["debug.log"]);
    assert.strictEqual(r.results[0].ignored, true);
  });

  await test("Normal: non-matching file is not ignored", async () => {
    const r = checkDockerignoreCoverage(path.join(TMP, "proj1"), "proj1", ["README.md"]);
    assert.strictEqual(r.results[0].ignored, false);
  });

  await test("Normal: negation re-includes a specific file", async () => {
    const r = checkDockerignoreCoverage(path.join(TMP, "proj1"), "proj1", ["dist/keep.txt", "dist/bundle.js"]);
    assert.strictEqual(r.results[0].ignored, false); // keep.txt re-included
    assert.strictEqual(r.results[1].ignored, true);  // bundle.js still excluded
  });

  await test("Normal: default candidate set runs and reports recommendations", async () => {
    const r = await call({ path: "proj1" });
    assert.strictEqual(r.usingDefaults, true);
    assert.ok(r.totalChecked > 0);
    assert.ok(Array.isArray(r.recommendations));
  });

  // ── Medium: boundary & parameter validation ────────────────────────────────
  await test("Medium: missing .dockerignore throws", async () => {
    write("noignore/keep", "x");
    await assert.rejects(() => call({ path: "noignore" }));
  });

  await test("Medium: empty paths array throws", async () => {
    await assert.rejects(() => call({ path: "proj1", paths: [] }));
  });

  await test("Medium: non-array paths throws", async () => {
    await assert.rejects(() => call({ path: "proj1", paths: "README.md" }));
  });

  await test("Medium: custom dockerignore_path is honoured", async () => {
    write("proj1/docker/custom.ignore", "secrets.txt\n");
    write("proj1/secrets.txt", "x");
    const r = await call({ path: "proj1", dockerignore_path: "docker/custom.ignore", paths: ["secrets.txt"] });
    assert.strictEqual(r.results[0].ignored, true);
    assert.strictEqual(r.dockerignoreFile, "docker/custom.ignore");
  });

  await test("Medium: too many paths throws", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `f${i}.txt`);
    await assert.rejects(() => call({ path: "proj1", paths: many }));
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: comments and blank lines in .dockerignore are ignored", async () => {
    write("proj2/.dockerignore", "# comment\n\nnode_modules\n");
    write("proj2/node_modules/x.js", "x");
    const r = await call({ path: "proj2", paths: ["node_modules/x.js"] });
    assert.strictEqual(r.ruleCount, 1);
    assert.strictEqual(r.results[0].ignored, true);
  });

  await test("High: wildcard '**' matches across multiple segments", async () => {
    write("proj3/.dockerignore", "**/*.tmp\n");
    write("proj3/a/b/c.tmp", "x");
    const r = await call({ path: "proj3", paths: ["a/b/c.tmp"] });
    assert.strictEqual(r.results[0].ignored, true);
  });

  await test("High: CRLF line endings in .dockerignore parsed correctly", async () => {
    write("proj4/.dockerignore", "node_modules\r\n*.log\r\n");
    const r = await call({ path: "proj4", paths: ["x.log"] });
    assert.strictEqual(r.results[0].ignored, true);
  });

  // ── Critical: security & input sanitization ────────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc" }));
  });

  await test("Critical: null byte in candidate path rejected", async () => {
    await assert.rejects(() => call({ path: "proj1", paths: ["a\0b"] }));
  });

  await test("Critical: matchedRule/pattern text never executed, only reported as data", async () => {
    write("proj5/.dockerignore", "$(rm -rf /)\n");
    const r = await call({ path: "proj5", paths: ["$(rm -rf /)"] });
    assert.strictEqual(typeof r.results[0].matchedRule, "string");
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ path: "proj1" });
    JSON.stringify(r);
    const known = ["path", "dockerignoreFile", "ruleCount", "usingDefaults", "totalChecked", "ignoredCount", "notIgnoredCount", "results", "recommendations"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency ──────────────────────────────────────────
  await test("Extreme: fuzz random-byte .dockerignore handled without crash", async () => {
    fs.mkdirSync(path.join(TMP, "proj6"), { recursive: true });
    fs.writeFileSync(path.join(TMP, "proj6/.dockerignore"), require("crypto").randomBytes(500));
    const r = await call({ path: "proj6" });
    assert.ok(typeof r.ruleCount === "number");
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ path: "proj1", paths: ["debug.log"] })));
    for (const r of results) assert.strictEqual(r.results[0].ignored, true);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("check_dockerignore_coverage"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
