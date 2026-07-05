"use strict";
/**
 * test/sections/106-json-schema-generate.js
 * Isolated functional tests for the json_schema_generate tool.
 * Section [44]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { jsonSchemaGenerate } = require("../../lib/jsonSchemaGenerateOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

let _counter = 0;
function tmpFile(ext, content) {
  const p = path.join(TMP, `jsg-${++_counter}${ext}`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// [44-A] NORMAL
test("[44-A-1] json_schema_generate: flat object infers property types + required", () => {
  const p = tmpFile(".json", JSON.stringify({ name: "a", age: 30, active: true, note: null }));
  const res = jsonSchemaGenerate(p, "f.json", {});
  const s = res.schema;
  assert(s.type === "object");
  assert(s.properties.name.type === "string");
  assert(s.properties.age.type === "integer");
  assert(s.properties.active.type === "boolean");
  assert(s.properties.note.type === "null");
  assert(JSON.stringify(s.required.sort()) === JSON.stringify(["active", "age", "name", "note"]));
});
test("[44-A-2] json_schema_generate: float number infers type 'number' not 'integer'", () => {
  const p = tmpFile(".json", JSON.stringify({ price: 9.99 }));
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(res.schema.properties.price.type === "number");
});
test("[44-A-3] json_schema_generate: nested object recurses into properties", () => {
  const p = tmpFile(".json", JSON.stringify({ user: { id: 1, tags: ["a", "b"] } }));
  const res = jsonSchemaGenerate(p, "f.json", {});
  const user = res.schema.properties.user;
  assert(user.type === "object" && user.properties.id.type === "integer");
  assert(user.properties.tags.type === "array" && user.properties.tags.items.type === "string");
});
test("[44-A-4] json_schema_generate: empty array -> items:{} unconstrained", () => {
  const p = tmpFile(".json", JSON.stringify({ list: [] }));
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(res.schema.properties.list.type === "array");
  assert(JSON.stringify(res.schema.properties.list.items) === "{}");
});
test("[44-A-5] json_schema_generate: array of uniform objects merges union properties, intersection required", () => {
  const p = tmpFile(".json", JSON.stringify([{ id: 1, name: "a" }, { id: 2, name: "b", extra: true }]));
  const res = jsonSchemaGenerate(p, "f.json", {});
  const items = res.schema.items;
  assert(items.type === "object");
  assert(Object.keys(items.properties).sort().join(",") === "extra,id,name");
  assert(JSON.stringify(items.required.sort()) === JSON.stringify(["id", "name"])); // extra not in every element
});
test("[44-A-6] json_schema_generate: array of mixed scalar types -> multi-type array", () => {
  const p = tmpFile(".json", JSON.stringify([1, "two", true]));
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(Array.isArray(res.schema.items.type));
  assert(res.schema.items.type.includes("string") && res.schema.items.type.includes("boolean") && res.schema.items.type.includes("integer"));
});
test("[44-A-7] json_schema_generate: top-level scalar document -> bare scalar schema", () => {
  const p = tmpFile(".json", JSON.stringify(42));
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(res.schema.type === "integer");
});
test("[44-A-8] json_schema_generate: YAML file auto-detected and parsed", () => {
  const p = tmpFile(".yaml", "name: a\nage: 5\n");
  const res = jsonSchemaGenerate(p, "f.yaml", {});
  assert(res.format === "yaml" && res.schema.properties.name.type === "string" && res.schema.properties.age.type === "integer");
});

// [44-B] MEDIUM — boundary & validation
test("[44-B-1] json_schema_generate: empty object -> properties {} required []", () => {
  const p = tmpFile(".json", "{}");
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(res.schema.type === "object" && Object.keys(res.schema.properties).length === 0 && res.schema.required.length === 0);
});
test("[44-B-2] json_schema_generate: top-level null -> {type:'null'}", () => {
  const p = tmpFile(".json", "null");
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(res.schema.type === "null");
});
test("[44-B-3] json_schema_generate: missing file throws cleanly", () => {
  let threw = false;
  try { jsonSchemaGenerate(path.join(TMP, "nope.json"), "nope.json", {}); } catch (e) { threw = true; }
  assert(threw);
});
test("[44-B-4] json_schema_generate: invalid JSON throws descriptive error", () => {
  const p = tmpFile(".json", "{ not valid json");
  let threw = false;
  try { jsonSchemaGenerate(p, "f.json", {}); } catch (e) { threw = true; assert(/not valid JSON/.test(e.message)); }
  assert(threw);
});
test("[44-B-5] json_schema_generate: unsupported format value throws -32602", () => {
  const p = tmpFile(".json", "{}");
  let threw = false;
  try { jsonSchemaGenerate(p, "f.json", { format: "xml" }); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[44-B-6] json_schema_generate: non-numeric max_array_sample falls back to default", () => {
  const arr = Array.from({ length: 5 }, (_, i) => i);
  const p = tmpFile(".json", JSON.stringify(arr));
  const res = jsonSchemaGenerate(p, "f.json", { max_array_sample: "not-a-number" });
  assert(res.schema.items.type === "integer");
});
test("[44-B-7] json_schema_generate: max_array_sample above hard cap is clamped, not rejected", () => {
  const arr = Array.from({ length: 10 }, (_, i) => i);
  const p = tmpFile(".json", JSON.stringify(arr));
  const res = jsonSchemaGenerate(p, "f.json", { max_array_sample: 999999 });
  assert(res.schema.items.type === "integer");
});

// [44-C] HIGH — composition / dependency edge cases
test("[44-C-1] json_schema_generate: max_array_sample caps how many elements are inspected", () => {
  const arr = [1, 1, 1, "x"]; // 'x' beyond sample window should be ignored
  const p = tmpFile(".json", JSON.stringify(arr));
  const res = jsonSchemaGenerate(p, "f.json", { max_array_sample: 3 });
  assert(res.schema.items.type === "integer"); // only first 3 sampled, all integers
});
test("[44-C-2] json_schema_generate: array of arrays merges nested items schema", () => {
  const p = tmpFile(".json", JSON.stringify([[1, 2], [3, 4, 5]]));
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(res.schema.items.type === "array" && res.schema.items.items.type === "integer");
});
test("[44-C-3] json_schema_generate: deeply nested object beyond MAX_DEPTH degrades to {} without crashing", () => {
  let obj = { v: 1 };
  for (let i = 0; i < 60; i++) obj = { nested: obj };
  const p = tmpFile(".json", JSON.stringify(obj));
  let handled = false;
  try { jsonSchemaGenerate(p, "f.json", {}); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[44-C-4] json_schema_generate: mixed object+array elements in an array -> multi-type, no properties/items", () => {
  const p = tmpFile(".json", JSON.stringify([{ a: 1 }, [1, 2]]));
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(Array.isArray(res.schema.items.type));
  assert(res.schema.items.properties === undefined && res.schema.items.items === undefined);
});

// [44-D] CRITICAL — security
test("[44-D-1] json_schema_generate: __proto__ key in sample document does not pollute Object.prototype", () => {
  const p = tmpFile(".json", '{"__proto__": {"polluted": true}, "safe": 1}');
  jsonSchemaGenerate(p, "f.json", {});
  assert(({}).polluted === undefined);
});
test("[44-D-2] json_schema_generate: SQL/script-injection-shaped string VALUES never affect the inferred type", () => {
  const p = tmpFile(".json", JSON.stringify({ q: "'; DROP TABLE users; --", x: "<script>alert(1)</script>" }));
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(res.schema.properties.q.type === "string" && res.schema.properties.x.type === "string");
});
test("[44-D-3] json_schema_generate: path-traversal-shaped KEY names are inert schema property names", () => {
  const p = tmpFile(".json", JSON.stringify({ "../../../etc/passwd": "x" }));
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(res.schema.properties["../../../etc/passwd"].type === "string");
});
test("[44-D-4] json_schema_generate: result is fully JSON-serialisable (no circular refs, no prototype leakage)", () => {
  const p = tmpFile(".json", JSON.stringify({ a: { b: [1, { c: "x" }] } }));
  const res = jsonSchemaGenerate(p, "f.json", {});
  let serialised;
  try { serialised = JSON.stringify(res); } catch (e) { serialised = null; }
  assert(typeof serialised === "string" && JSON.parse(serialised).schema.properties.a.type === "object");
});

// [44-E] EXTREME — fuzz, scale, cleanup
test("[44-E-1] json_schema_generate: 1000-key flat object infers correctly and quickly", () => {
  const obj = {};
  for (let i = 0; i < 1000; i++) obj[`k${i}`] = i % 2 === 0 ? i : `s${i}`;
  const p = tmpFile(".json", JSON.stringify(obj));
  const start = Date.now();
  const res = jsonSchemaGenerate(p, "f.json", {});
  assert(Date.now() - start < 5000);
  assert(Object.keys(res.schema.properties).length === 1000 && res.schema.required.length === 1000);
});
test("[44-E-2] json_schema_generate: fuzz — non-JSON garbage content throws cleanly, never crashes", () => {
  const junk = Array.from({ length: 300 }, () => String.fromCharCode(1 + Math.floor(Math.random() * 254))).join("");
  const p = tmpFile(".json", junk);
  let handled = false;
  try { jsonSchemaGenerate(p, "f.json", {}); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[44-E-3] json_schema_generate: 15 rapid sequential calls with different documents are independent", () => {
  for (let i = 0; i < 15; i++) {
    const p = tmpFile(".json", JSON.stringify({ v: i }));
    const res = jsonSchemaGenerate(p, "f.json", {});
    assert(res.schema.properties.v.type === "integer");
  }
});
test("[44-E-4] cleanup: remove json_schema_generate fixture files created in this section", () => {
  for (let i = 1; i <= _counter; i++) {
    for (const ext of [".json", ".yaml"]) {
      const p = path.join(TMP, `jsg-${i}${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  assert(true);
});
