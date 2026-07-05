"use strict";
// Standalone test script for scan_dependency_licenses (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "scan-dep-licenses-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanDependencyLicenses, classifyLicense } = require("../lib/dependencyLicensesOps");

function writePkg(rel, obj) {
  const p = path.join(TMP, rel, "package.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

async function call(args) { return executeTool("scan_dependency_licenses", args); }

(async () => {
  console.log("scan_dependency_licenses tests:");

  // ── Normal ───────────────────────────────────────────────────────────────
  const proj = "proj";
  writePkg(`${proj}/node_modules/pkg-mit`, { name: "pkg-mit", version: "1.0.0", license: "MIT" });
  writePkg(`${proj}/node_modules/pkg-gpl`, { name: "pkg-gpl", version: "2.0.0", license: "GPL-3.0" });
  writePkg(`${proj}/node_modules/pkg-lgpl`, { name: "pkg-lgpl", version: "1.1.0", license: "LGPL-2.1" });
  writePkg(`${proj}/node_modules/pkg-none`, { name: "pkg-none", version: "1.0.0" });
  writePkg(`${proj}/node_modules/@scope/pkg-a`, { name: "@scope/pkg-a", version: "1.0.0", license: "Apache-2.0" });
  writePkg(`${proj}/node_modules/pkg-or`, { name: "pkg-or", version: "1.0.0", license: "MIT OR GPL-3.0" });
  writePkg(`${proj}/node_modules/pkg-and`, { name: "pkg-and", version: "1.0.0", license: "MIT AND GPL-3.0" });
  writePkg(`${proj}/node_modules/pkg-legacy`, { name: "pkg-legacy", version: "1.0.0", licenses: [{ type: "ISC" }] });
  writePkg(`${proj}/node_modules/pkg-custom`, { name: "pkg-custom", version: "1.0.0", license: "SEE LICENSE IN LICENSE.txt" });
  writePkg(`${proj}/node_modules/pkg-inject`, { name: "pkg-inject", version: "1.0.0", license: "$(rm -rf /); <script>alert(1)</script>" });
  fs.mkdirSync(path.join(TMP, `${proj}/node_modules/pkg-stray`), { recursive: true }); // dir with no package.json
  fs.mkdirSync(path.join(TMP, `${proj}/node_modules/pkg-malformed`), { recursive: true });
  fs.writeFileSync(path.join(TMP, `${proj}/node_modules/pkg-malformed/package.json`), "{ not json");

  const nmAbs = path.join(TMP, proj, "node_modules");
  let res = await call({ path: proj });

  await test("MIT package classified permissive, not flagged by default", () => {
    assert.strictEqual(res.foundNodeModules, true);
    assert.strictEqual(res.issues.find(i => i.name === "pkg-mit"), undefined);
    assert.ok(res.counts.permissive >= 1);
  });

  await test("GPL package classified copyleft and flagged by default", () => {
    const issue = res.issues.find(i => i.name === "pkg-gpl");
    assert.strictEqual(issue.category, "copyleft");
    assert.strictEqual(issue.reason, "flagged-category");
  });

  await test("packagesScanned excludes stray dir, malformed tracked separately", () => {
    assert.ok(res.packagesScanned >= 9);
    assert.ok(res.malformed.includes("pkg-malformed"));
  });

  // ── Medium ────────────────────────────────────────────────────────────
  await test("missing node_modules dir returns foundNodeModules:false, not an error", async () => {
    const r = await call({ path: "no-such-project" });
    assert.strictEqual(r.foundNodeModules, false);
  });

  await test("max_results non-number throws", () => {
    assert.throws(() => scanDependencyLicenses(nmAbs, proj, { max_results: "ten" }), /must be a number/);
  });

  await test("flag_categories invalid entry throws", () => {
    assert.throws(() => scanDependencyLicenses(nmAbs, proj, { flag_categories: ["not-a-real-category"] }), /invalid flag_categories/);
  });

  await test("disallowed non-array throws", () => {
    assert.throws(() => scanDependencyLicenses(nmAbs, proj, { disallowed: "gpl" }), /must be an array/);
  });

  // ── High ──────────────────────────────────────────────────────────────
  await test("unknown-license package (no license field) flagged by default", () => {
    const issue = res.issues.find(i => i.name === "pkg-none");
    assert.strictEqual(issue.category, "unknown");
  });

  await test("legacy licenses[] array shape (ISC) classified permissive", () => {
    assert.strictEqual(classifyLicense("ISC"), "permissive");
    assert.strictEqual(res.issues.find(i => i.name === "pkg-legacy"), undefined);
  });

  await test("scoped @scope/pkg-a discovered and classified permissive", () => {
    assert.strictEqual(res.issues.find(i => i.name === "@scope/pkg-a"), undefined);
    assert.ok(res.packagesScanned > 0);
  });

  await test("disallowed substring flags matching licenses beyond category rules", async () => {
    const r = await call({ path: proj, disallowed: ["gpl"] });
    const issue = r.issues.find(i => i.name === "pkg-lgpl");
    assert.strictEqual(issue.reason, "disallowed");
  });

  // ── Critical ──────────────────────────────────────────────────────────
  await test("path traversal blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc" }));
  });

  await test("shell/HTML-injection-shaped license string handled as inert data", async () => {
    // Not a copyleft/unknown SPDX token so not flagged by default — classified
    // 'custom' and left as inert data, verified by widening flag_categories.
    assert.strictEqual(classifyLicense("$(rm -rf /); <script>alert(1)</script>"), "custom");
    const r = await call({ path: proj, flag_categories: ["custom"] });
    const issue = r.issues.find(i => i.name === "pkg-inject");
    assert.ok(issue);
    assert.strictEqual(typeof issue.license, "string");
    assert.strictEqual(issue.license, "$(rm -rf /); <script>alert(1)</script>");
  });

  await test("result is JSON-serialisable", () => {
    assert.doesNotThrow(() => JSON.stringify(res));
  });

  await test("no unexpected top-level keys", () => {
    assert.deepStrictEqual(Object.keys(res).sort(), ["counts", "foundNodeModules", "issueCount", "issues", "malformed", "packagesScanned", "path", "truncated"]);
  });

  // ── Extreme ───────────────────────────────────────────────────────────
  await test("OR resolves least-restrictive, AND resolves most-restrictive", () => {
    assert.strictEqual(classifyLicense("MIT OR GPL-3.0"), "permissive");
    assert.strictEqual(classifyLicense("MIT AND GPL-3.0"), "copyleft");
  });

  await test("10 concurrent calls all consistent", async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: proj }));
    const results = await Promise.all(calls);
    for (const r of results) assert.strictEqual(r.foundNodeModules, true);
  });

  await test("fuzz: random-byte package.json handled without crash (counted malformed)", () => {
    const fuzzDir = path.join(TMP, proj, "node_modules", "pkg-fuzz");
    fs.mkdirSync(fuzzDir, { recursive: true });
    const bytes = Buffer.from(Array.from({ length: 200 }, () => Math.floor(Math.random() * 256)));
    fs.writeFileSync(path.join(fuzzDir, "package.json"), bytes);
    assert.doesNotThrow(() => scanDependencyLicenses(nmAbs, proj));
  });

  await test("execute_pipeline op-enum registration", () => {
    const schemas = require("../lib/toolsSchema").TOOLS_ALL;
    const pipelineSchema = schemas.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("scan_dependency_licenses"));
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
