"use strict";
/**
 * [76] EXECUTE_PIPELINE OP-ENUM COVERAGE — regression guard
 *
 * Context: tools added in the #66-75 batch (scan_secrets, check_line_endings,
 * find_large_files, find_empty_dirs, git_untracked_size, json_flatten,
 * json_unflatten, package_json_audit, readme_link_check, env_diff,
 * scan_conflict_markers, json_schema_validate, search_in_document) were
 * dispatchable directly but missing from lib/schemas/execSchemas.js's
 * execute_pipeline op enum -- silently un-chainable via execute_pipeline.
 * Fixed this session. This section guards against future regressions.
 *
 * Rigor levels:
 *   Normal:   every READ_DISPATCH key is present in the op enum.
 *   Medium:   every WRITE_DISPATCH key is present in the op enum.
 *   High:     a previously-missing tool (readme_link_check) actually runs
 *             end-to-end through execute_pipeline, not just schema-listed.
 *   Critical: op enum contains no duplicate entries (schema authoring bug
 *             class -- a dup doesn't break validation but signals drift).
 *   Extreme:  a batch of 10 formerly-missing tools all resolve via
 *             execute_pipeline without "unknown op" schema errors.
 */
const { assert, test, executeTool } = require("../test-harness");
const { READ_DISPATCH } = require("../../lib/dispatchRead");
const { WRITE_DISPATCH } = require("../../lib/dispatchWrite");
const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");

console.log("\n[76] EXECUTE_PIPELINE OP-ENUM COVERAGE");

function opEnum() {
  return EXEC_SCHEMAS.find(function (s) { return s.name === "execute_pipeline"; })
    .inputSchema.properties.steps.items.properties.op.enum;
}

module.exports = (async () => {

await test("normal: every READ_DISPATCH tool name is in the op enum", () => {
  const enumSet = new Set(opEnum());
  const missing = Object.keys(READ_DISPATCH).filter(k => !enumSet.has(k));
  assert.deepStrictEqual(missing, []);
});

await test("medium: every WRITE_DISPATCH tool name is in the op enum", () => {
  const enumSet = new Set(opEnum());
  const missing = Object.keys(WRITE_DISPATCH).filter(k => !enumSet.has(k));
  assert.deepStrictEqual(missing, []);
});

await test("high: formerly-missing tool (readme_link_check) runs via execute_pipeline", async () => {
  executeTool("write_file", { path: "poc76.md", content: "[a](poc76.md)\n" });
  const r = await executeTool("execute_pipeline", { steps: [
    { op: "readme_link_check", path: "poc76.md" },
  ]});
  assert.strictEqual(r.completed, 1);
  assert.strictEqual(r.failed, 0);
});

await test("critical: op enum has no duplicate entries", () => {
  const arr = opEnum();
  const dups = arr.filter((v, i) => arr.indexOf(v) !== i);
  assert.deepStrictEqual(dups, []);
});

await test("extreme: 10 formerly-missing tools all dispatch via execute_pipeline without 'unknown op' schema errors", async () => {
  executeTool("write_file", { path: "poc76b.env", content: "A=1\n" });
  executeTool("write_file", { path: "poc76b.example.env", content: "A=1\nB=2\n" });
  executeTool("write_file", { path: "poc76b.json", content: '{"a":1}' });
  executeTool("write_file", { path: "poc76b-pkg.json", content: '{"name":"x","version":"1.0.0"}' });
  const steps = [
    { op: "scan_secrets", path: "poc76b.env" },
    { op: "check_line_endings", path: "poc76b.env" },
    { op: "find_large_files", path: "." },
    { op: "find_empty_dirs", path: "." },
    { op: "json_flatten", path: "poc76b.json" },
    { op: "package_json_audit", path: "poc76b-pkg.json" },
    { op: "readme_link_check", path: "poc76.md" },
    { op: "env_diff", path: "poc76b.env", compare_path: "poc76b.example.env" },
    { op: "scan_conflict_markers", path: "poc76b.env" },
    { op: "json_schema_validate", path: "poc76b.json", schema_path: "poc76b.json" },
  ];
  const r = await executeTool("execute_pipeline", { steps });
  assert.strictEqual(r.completed, steps.length);
  assert.strictEqual(r.failed, 0);
});

await test("cleanup: remove pipeline-op-coverage fixtures", () => {
  for (const f of ["poc76.md", "poc76b.env", "poc76b.example.env", "poc76b.json", "poc76b-pkg.json"]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
});

})();
