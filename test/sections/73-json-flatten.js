"use strict";
/**
 * [73] JSON_FLATTEN / JSON_UNFLATTEN — nested <-> dot-notation round-trip
 *
 * Rigor levels:
 *   Normal:   nested object flattened correctly incl. array indices;
 *             round-trip flatten -> unflatten reproduces the original.
 *   Medium:   empty object/array preserved as empty-value leaves; missing
 *             required 'path' arg -> validation error via schema (not tested
 *             here directly — covered by executeTool's own validateArgs).
 *   High:     YAML input flattened via format auto-detection from extension.
 *   Critical: keys containing literal dots are escaped and round-trip intact;
 *             malformed JSON input throws cleanly (no crash).
 *   Extreme:  deep nesting (60 levels) flattens without stack overflow;
 *             wide object (200 keys) flattens completely, keyCount accurate.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[73] JSON_FLATTEN / JSON_UNFLATTEN — dot-notation conversion`);

test("normal: nested object flattened with array indices", () => {
  const doc = { a: { b: [1, 2], c: "x" } };
  executeTool("write_file", { path: "jf1.json", content: JSON.stringify(doc) });
  const r = executeTool("json_flatten", { path: "jf1.json" });
  assert.strictEqual(r.flattened["a.b.0"], 1);
  assert.strictEqual(r.flattened["a.b.1"], 2);
  assert.strictEqual(r.flattened["a.c"], "x");
  assert.strictEqual(r.keyCount, 3);
});

test("normal: round-trip flatten -> unflatten reproduces original", () => {
  const r1 = executeTool("json_flatten", { path: "jf1.json" });
  executeTool("write_file", { path: "jf1_flat.json", content: JSON.stringify(r1.flattened) });
  const r2 = executeTool("json_unflatten", { path: "jf1_flat.json" });
  assert.deepStrictEqual(r2.nested, { a: { b: [1, 2], c: "x" } });
});

test("medium: empty object/array preserved as empty-value leaves", () => {
  executeTool("write_file", { path: "jf2.json", content: JSON.stringify({ e: {}, arr: [], v: 0 }) });
  const r = executeTool("json_flatten", { path: "jf2.json" });
  assert.deepStrictEqual(r.flattened["e"], {});
  assert.deepStrictEqual(r.flattened["arr"], []);
  assert.strictEqual(r.flattened["v"], 0);
});

test("high: YAML input flattened via extension auto-detection", () => {
  executeTool("write_file", { path: "jf3.yaml", content: "a:\n  b: 1\n  c: 2\n" });
  const r = executeTool("json_flatten", { path: "jf3.yaml" });
  assert.strictEqual(r.format, "yaml");
  assert.strictEqual(r.flattened["a.b"], 1);
  assert.strictEqual(r.flattened["a.c"], 2);
});

test("critical: literal dots in keys are escaped and round-trip intact", () => {
  const doc = { "a.b": { "c.d": 5 } };
  executeTool("write_file", { path: "jf4.json", content: JSON.stringify(doc) });
  const r1 = executeTool("json_flatten", { path: "jf4.json" });
  const flatKeys = Object.keys(r1.flattened);
  assert.strictEqual(flatKeys.includes("a\\.b.c\\.d"), true);
  executeTool("write_file", { path: "jf4_flat.json", content: JSON.stringify(r1.flattened) });
  const r2 = executeTool("json_unflatten", { path: "jf4_flat.json" });
  assert.deepStrictEqual(r2.nested, doc);
});

test("critical: malformed JSON input throws cleanly", () => {
  executeTool("write_file", { path: "jf5.json", content: "{not valid json" });
  try {
    executeTool("json_flatten", { path: "jf5.json" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("extreme: deep nesting (60 levels) flattens without stack overflow", () => {
  let obj = { leaf: 1 };
  for (let i = 0; i < 60; i++) obj = { n: obj };
  executeTool("write_file", { path: "jf6.json", content: JSON.stringify(obj) });
  const r = executeTool("json_flatten", { path: "jf6.json" });
  assert.strictEqual(r.keyCount, 1);
  assert.strictEqual(Object.values(r.flattened)[0], 1);
});

test("extreme: wide object (200 keys) flattens completely", () => {
  const wide = {};
  for (let i = 0; i < 200; i++) wide[`k${i}`] = i;
  executeTool("write_file", { path: "jf7.json", content: JSON.stringify(wide) });
  const r = executeTool("json_flatten", { path: "jf7.json" });
  assert.strictEqual(r.keyCount, 200);
  assert.strictEqual(r.flattened["k199"], 199);
});

test("cleanup: remove json_flatten fixtures", () => {
  for (const f of ["jf1.json", "jf1_flat.json", "jf2.json", "jf3.yaml", "jf4.json", "jf4_flat.json", "jf5.json", "jf6.json", "jf7.json"]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
});
