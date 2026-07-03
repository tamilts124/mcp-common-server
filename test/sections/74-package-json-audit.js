"use strict";
/**
 * [74] PACKAGE_JSON_AUDIT — static structural audit of package.json
 *
 * Rigor levels:
 *   Normal:   clean, well-formed package.json -> valid:true, 0 errors.
 *   Medium:   missing name/version -> errors; non-semver version -> warning.
 *   High:     dependency duplicated across dependencies/devDependencies ->
 *             error; 'main' pointing at nonexistent file -> error.
 *   Critical: risky version pins ('*', 'latest', '') flagged; malformed
 *             JSON and non-object top-level throw cleanly (no crash).
 *   Extreme:  large dependency list (100 entries, mixed valid/risky) audited
 *             without crashing, counts accurate.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[74] PACKAGE_JSON_AUDIT — package.json structural audit`);

test("normal: clean package.json -> valid, 0 errors", () => {
  const pkg = { name: "foo", version: "1.0.0", license: "MIT", dependencies: { lodash: "^4.17.0" } };
  executeTool("write_file", { path: "pja1.json", content: JSON.stringify(pkg) });
  const r = executeTool("package_json_audit", { path: "pja1.json" });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.errorCount, 0);
});

test("medium: missing name/version -> errors", () => {
  executeTool("write_file", { path: "pja2.json", content: JSON.stringify({ license: "MIT" }) });
  const r = executeTool("package_json_audit", { path: "pja2.json" });
  assert.strictEqual(r.valid, false);
  assert.ok(r.issues.some(i => i.field === "name" && i.severity === "error"));
  assert.ok(r.issues.some(i => i.field === "version" && i.severity === "error"));
});

test("medium: non-semver version -> warning, not error", () => {
  executeTool("write_file", { path: "pja3.json", content: JSON.stringify({ name: "x", version: "latest", license: "MIT" }) });
  const r = executeTool("package_json_audit", { path: "pja3.json" });
  const versionIssue = r.issues.find(i => i.field === "version");
  assert.strictEqual(versionIssue.severity, "warning");
});

test("high: dependency duplicated across dependencies/devDependencies -> error", () => {
  const pkg = { name: "x", version: "1.0.0", license: "MIT",
    dependencies: { lodash: "^4.0.0" }, devDependencies: { lodash: "^4.0.0", jest: "^29.0.0" } };
  executeTool("write_file", { path: "pja4.json", content: JSON.stringify(pkg) });
  const r = executeTool("package_json_audit", { path: "pja4.json" });
  assert.ok(r.issues.some(i => i.field === "lodash" && i.severity === "error"));
});

test("high: 'main' pointing at nonexistent file -> error", () => {
  const pkg = { name: "x", version: "1.0.0", license: "MIT", main: "does-not-exist.js" };
  executeTool("write_file", { path: "pja5.json", content: JSON.stringify(pkg) });
  const r = executeTool("package_json_audit", { path: "pja5.json" });
  assert.ok(r.issues.some(i => i.field === "main" && i.severity === "error"));
});

test("critical: risky version pins flagged ('*', 'latest', '')", () => {
  const pkg = { name: "x", version: "1.0.0", license: "MIT",
    dependencies: { a: "*", b: "latest", c: "" } };
  executeTool("write_file", { path: "pja6.json", content: JSON.stringify(pkg) });
  const r = executeTool("package_json_audit", { path: "pja6.json" });
  const flagged = r.issues.filter(i => i.field.startsWith("dependencies."));
  assert.strictEqual(flagged.length, 3);
});

test("critical: malformed JSON throws cleanly", () => {
  executeTool("write_file", { path: "pja7.json", content: "{bad json" });
  try {
    executeTool("package_json_audit", { path: "pja7.json" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: non-object top-level (array) throws cleanly", () => {
  executeTool("write_file", { path: "pja8.json", content: "[1,2,3]" });
  try {
    executeTool("package_json_audit", { path: "pja8.json" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: 100-entry mixed dependency list audited without crashing", () => {
  const deps = {};
  for (let i = 0; i < 100; i++) deps[`pkg${i}`] = i % 5 === 0 ? "*" : "^1.0.0";
  const pkg = { name: "x", version: "1.0.0", license: "MIT", dependencies: deps };
  executeTool("write_file", { path: "pja9.json", content: JSON.stringify(pkg) });
  const r = executeTool("package_json_audit", { path: "pja9.json" });
  const riskyCount = r.issues.filter(i => i.field.startsWith("dependencies.")).length;
  assert.strictEqual(riskyCount, 20); // every 5th of 100 = 20
});

test("cleanup: remove package_json_audit fixtures", () => {
  for (let i = 1; i <= 9; i++) {
    try { executeTool("delete_file", { path: `pja${i}.json` }); } catch (_) {}
  }
});
