"use strict";
/**
 * [68] JSON_SCHEMA_VALIDATE — validate JSON against a JSON Schema subset
 *
 * Rigor levels:
 *   Normal:   valid document against schema -> valid:true, errorCount:0.
 *   Medium:   missing required field, wrong type -> errors collected, not
 *             thrown; missing schema_path arg throws -32602.
 *   High:     nonexistent data/schema file, malformed JSON in either file,
 *             throw descriptive -32602 (not a crash).
 *   Critical: invalid regex in schema.pattern reported as an error, not a
 *             crash/ReDoS; additionalProperties:false rejects extra keys
 *             even if their names look like injection payloads.
 *   Extreme:  nested array-of-objects schema (items+properties recursion);
 *             many errors collected in one pass (not short-circuited).
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[68] JSON_SCHEMA_VALIDATE — validate JSON against a schema`);

const PERSON_SCHEMA = {
  type: "object",
  required: ["name", "age"],
  properties: {
    name: { type: "string", minLength: 1 },
    age:  { type: "integer", minimum: 0, maximum: 150 },
    tags: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

test("normal: valid document passes with no errors", () => {
  executeTool("write_file", { path: "jsv_schema.json", content: JSON.stringify(PERSON_SCHEMA) });
  executeTool("write_file", { path: "jsv_ok.json", content: JSON.stringify({ name: "Ada", age: 30, tags: ["x"] }) });
  const r = executeTool("json_schema_validate", { path: "jsv_ok.json", schema_path: "jsv_schema.json" });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.errorCount, 0);
  assert.deepStrictEqual(r.errors, []);
});

test("medium: missing required + wrong type collected as errors, not thrown", () => {
  executeTool("write_file", { path: "jsv_bad.json", content: JSON.stringify({ age: "not a number" }) });
  const r = executeTool("json_schema_validate", { path: "jsv_bad.json", schema_path: "jsv_schema.json" });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errorCount >= 2); // missing 'name', wrong type for 'age'
  assert.ok(r.errors.some(e => e.path === "name"));
  assert.ok(r.errors.some(e => e.path === "age"));
});

test("medium: missing schema_path throws -32602", () => {
  try {
    executeTool("json_schema_validate", { path: "jsv_ok.json" });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("high: nonexistent data file throws descriptively", () => {
  try {
    executeTool("json_schema_validate", { path: "jsv_missing.json", schema_path: "jsv_schema.json" });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("high: malformed JSON in data file throws descriptively", () => {
  executeTool("write_file", { path: "jsv_malformed.json", content: "{ not json" });
  try {
    executeTool("json_schema_validate", { path: "jsv_malformed.json", schema_path: "jsv_schema.json" });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("critical: invalid regex in schema.pattern reported as error, no crash", () => {
  const schema = { type: "object", properties: { code: { type: "string", pattern: "(unclosed" } } };
  executeTool("write_file", { path: "jsv_badpattern_schema.json", content: JSON.stringify(schema) });
  executeTool("write_file", { path: "jsv_badpattern_data.json", content: JSON.stringify({ code: "abc" }) });
  const r = executeTool("json_schema_validate", { path: "jsv_badpattern_data.json", schema_path: "jsv_badpattern_schema.json" });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.message.includes("invalid regex")));
});

test("critical: additionalProperties:false rejects extra keys", () => {
  const data = { name: "Ada", age: 30, ["__proto__"]: "x", injected: "<script>alert(1)</script>" };
  executeTool("write_file", { path: "jsv_extra.json", content: JSON.stringify(data) });
  const r = executeTool("json_schema_validate", { path: "jsv_extra.json", schema_path: "jsv_schema.json" });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.some(e => e.path === "injected"));
});

test("extreme: nested array-of-objects recursion collects multiple errors in one pass", () => {
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      },
    },
  };
  const data = { items: [{ id: 1 }, {}, { id: "bad" }, {}] };
  executeTool("write_file", { path: "jsv_nested_schema.json", content: JSON.stringify(schema) });
  executeTool("write_file", { path: "jsv_nested_data.json", content: JSON.stringify(data) });
  const r = executeTool("json_schema_validate", { path: "jsv_nested_data.json", schema_path: "jsv_nested_schema.json" });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.errorCount, 3); // items[1], items[2], items[3]
  assert.ok(r.errors.some(e => e.path === "items[1].id"));
  assert.ok(r.errors.some(e => e.path === "items[2].id"));
});

test("cleanup: remove json_schema_validate fixtures", () => {
  for (const f of [
    "jsv_schema.json", "jsv_ok.json", "jsv_bad.json", "jsv_malformed.json",
    "jsv_badpattern_schema.json", "jsv_badpattern_data.json", "jsv_extra.json",
    "jsv_nested_schema.json", "jsv_nested_data.json",
  ]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
});
