"use strict";
// Tests for check_dependency_confusion_risk (lib/dependencyConfusionOps.js)
// Rigor levels: Normal, Medium, High, Critical, Extreme.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { checkDependencyConfusionRisk } = require("../lib/dependencyConfusionOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

function tmpPkg(obj) {
  const p = path.join(os.tmpdir(), `cdcr-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
test("flags unscoped dependency matching an explicit internal prefix", () => {
  const p = tmpPkg({ name: "app", dependencies: { "acme-billing-core": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"] });
  assert.strictEqual(r.issueCount, 1);
  assert.strictEqual(r.issues[0].rule, "unscoped_internal_looking_dependency");
  assert.strictEqual(r.issues[0].severity, "error");
  fs.unlinkSync(p);
});

test("auto-derives internal scope from own scoped package name", () => {
  const p = tmpPkg({ name: "@acme/app", dependencies: { "@acme/utils": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p);
  assert.strictEqual(r.ownScope, "@acme");
  assert.ok(r.internalPrefixesUsed.includes("@acme/"));
  fs.unlinkSync(p);
});

test("flags scoped dependency with no matching .npmrc registry pin", () => {
  const p = tmpPkg({ name: "app", dependencies: { "@acme/utils": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { npmrcContent: "" });
  assert.strictEqual(r.issueCount, 1);
  assert.strictEqual(r.issues[0].rule, "scoped_dependency_missing_registry_pin");
  assert.strictEqual(r.issues[0].severity, "warning");
  fs.unlinkSync(p);
});

test("scoped dependency with matching .npmrc registry pin is not flagged", () => {
  const p = tmpPkg({ name: "app", dependencies: { "@acme/utils": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { npmrcContent: "@acme:registry=https://npm.internal.acme.com/\n" });
  assert.strictEqual(r.issueCount, 0);
  fs.unlinkSync(p);
});

test("unscoped dependency not matching any internal prefix is not flagged", () => {
  const p = tmpPkg({ name: "app", dependencies: { "lodash": "4.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"] });
  assert.strictEqual(r.issueCount, 0);
  fs.unlinkSync(p);
});

test("scoped internal dependency (matching own scope) is not flagged as unscoped", () => {
  const p = tmpPkg({ name: "@acme/app", dependencies: { "@acme/utils": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { npmrcContent: "@acme:registry=https://npm.internal/\n" });
  assert.strictEqual(r.issueCount, 0);
  fs.unlinkSync(p);
});

test("devDependencies block is scanned by default", () => {
  const p = tmpPkg({ name: "app", devDependencies: { "acme-test-utils": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"] });
  assert.strictEqual(r.issueCount, 1);
  assert.strictEqual(r.issues[0].block, "devDependencies");
  fs.unlinkSync(p);
});

// ── Medium (boundary / validation) ─────────────────────────────────────
test("nonexistent package.json path throws", () => {
  assert.throws(() => checkDependencyConfusionRisk("/no/such/path/package.json", "/no/such/path/package.json"));
});

test("malformed JSON throws", () => {
  const p = path.join(os.tmpdir(), `cdcr-bad-${Date.now()}.json`);
  fs.writeFileSync(p, "{ not json");
  assert.throws(() => checkDependencyConfusionRisk(p, p), /malformed JSON/);
  fs.unlinkSync(p);
});

test("max_results type mismatch throws ToolError", () => {
  const p = tmpPkg({ name: "app", dependencies: {} });
  assert.throws(() => checkDependencyConfusionRisk(p, p, { maxResults: "five" }), /max_results must be a number/);
  fs.unlinkSync(p);
});

test("blocks type mismatch throws ToolError", () => {
  const p = tmpPkg({ name: "app", dependencies: {} });
  assert.throws(() => checkDependencyConfusionRisk(p, p, { blocks: "not-an-array" }), /blocks must be an array/);
  fs.unlinkSync(p);
});

test("internalPackagePrefixes type mismatch throws ToolError", () => {
  const p = tmpPkg({ name: "app", dependencies: {} });
  assert.throws(() => checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: "acme-" }), /internalPackagePrefixes must be an array/);
  fs.unlinkSync(p);
});

test("no-deps-block package.json returns zero scanned, no crash", () => {
  const p = tmpPkg({ name: "app" });
  const r = checkDependencyConfusionRisk(p, p);
  assert.strictEqual(r.depsScanned, 0);
  assert.strictEqual(r.issueCount, 0);
  fs.unlinkSync(p);
});

// ── High (dependency / edge-case failure handling) ──────────────────────
test("blocks filter narrows scan to only the specified block", () => {
  const p = tmpPkg({ name: "app", dependencies: { "acme-a": "1.0.0" }, devDependencies: { "acme-b": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"], blocks: ["dependencies"] });
  assert.strictEqual(r.depsScanned, 1);
  assert.strictEqual(r.issues[0].name, "acme-a");
  fs.unlinkSync(p);
});

test("non-string dependency name value skipped without crashing (JSON.parse guarantees string keys)", () => {
  const p = tmpPkg({ name: "app", dependencies: { "acme-x": 123 } });
  assert.doesNotThrow(() => checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"] }));
  fs.unlinkSync(p);
});

test("missing sibling .npmrc (no npmrcContent override) treated as no pins, scoped dep still flagged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdcr-dir-"));
  const p = path.join(dir, "package.json");
  fs.writeFileSync(p, JSON.stringify({ name: "app", dependencies: { "@acme/utils": "1.0.0" } }));
  const r = checkDependencyConfusionRisk(p, p);
  assert.strictEqual(r.issueCount, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Critical (security / sanitization) ──────────────────────────────────
test("path traversal label is echoed back but not resolved into a real traversal", () => {
  const p = tmpPkg({ name: "app", dependencies: { "acme-x": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, "../../../etc/passwd", { internalPackagePrefixes: ["acme-"] });
  assert.strictEqual(r.path, "../../../etc/passwd");
  fs.unlinkSync(p);
});

test("shell/script-injection-shaped dependency name only reported never executed", () => {
  const p = tmpPkg({ name: "app", dependencies: { "acme-$(rm -rf /)": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"] });
  assert.strictEqual(r.issueCount, 1);
  assert.ok(r.issues[0].name.includes("$(rm"));
  fs.unlinkSync(p);
});

test("result is JSON-serialisable with exact expected top-level keys", () => {
  const p = tmpPkg({ name: "app", dependencies: { "acme-x": "1.0.0" } });
  const r = checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"] });
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    ["path", "depsScanned", "ownScope", "internalPrefixesUsed", "issueCount", "errorCount", "warningCount", "truncated", "issues"].sort()
  );
  fs.unlinkSync(p);
});

// ── Extreme (fuzzing / concurrency / limits) ─────────────────────────────
test("max_results truncation sets truncated flag", () => {
  const deps = {};
  for (let i = 0; i < 20; i++) deps[`acme-pkg-${i}`] = "1.0.0";
  const p = tmpPkg({ name: "app", dependencies: deps });
  const r = checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"], maxResults: 5 });
  assert.strictEqual(r.issues.length, 5);
  assert.strictEqual(r.truncated, true);
  fs.unlinkSync(p);
});

test("fuzz: random-byte file throws a clean ToolError, not a crash", () => {
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const p = path.join(os.tmpdir(), `cdcr-fuzz-${Date.now()}.json`);
  fs.writeFileSync(p, buf);
  assert.throws(() => checkDependencyConfusionRisk(p, p));
  fs.unlinkSync(p);
});

test("empty dependencies object yields zero findings, no crash", () => {
  const p = tmpPkg({ name: "app", dependencies: {} });
  const r = checkDependencyConfusionRisk(p, p);
  assert.strictEqual(r.depsScanned, 0);
  fs.unlinkSync(p);
});

test("10 concurrent scans of the same package.json give consistent results", () => {
  const p = tmpPkg({ name: "app", dependencies: { "acme-a": "1.0.0", "@acme/b": "1.0.0" } });
  const results = [];
  for (let i = 0; i < 10; i++) results.push(checkDependencyConfusionRisk(p, p, { internalPackagePrefixes: ["acme-"], npmrcContent: "" }));
  for (const r of results) assert.strictEqual(r.issueCount, 2);
  fs.unlinkSync(p);
});

test("execute_pipeline op-enum registration includes check_dependency_confusion_risk", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(src.includes('"check_dependency_confusion_risk"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
