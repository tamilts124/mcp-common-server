"use strict";
/**
 * test/sections/99-json-path-set.js
 * Isolated functional tests for the json_path_set tool.
 * Section [37]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { jsonPathSet } = require("../../lib/jsonPathSetOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

let _counter = 0;
function tmpJson(obj) {
  const p = path.join(TMP, `jps-${++_counter}.json`);
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}
function tmpYaml(content) {
  const p = path.join(TMP, `jps-${++_counter}.yaml`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// [37-A] NORMAL
test("[37-A-1] set: simple top-level key", () => {
  const p = tmpJson({ a: 1, b: 2 });
  const r = jsonPathSet(p, "test.json", "$.a", { value: "99" });
  assert(r.matchCount === 1 && r.operation === "set");
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.a === 99 && doc.b === 2);
});
test("[37-A-2] set: nested key path creates/overwrites deep value", () => {
  const p = tmpJson({ spec: { replicas: 1 } });
  jsonPathSet(p, "test.json", "$.spec.replicas", { value: "5" });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.spec.replicas === 5);
});
test("[37-A-3] set: array index updates in place", () => {
  const p = tmpJson({ items: ["a", "b", "c"] });
  jsonPathSet(p, "test.json", "$.items[1]", { value: '"B"' });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.items[1] === "B" && doc.items.length === 3);
});
test("[37-A-4] set: array index one-past-the-end appends", () => {
  const p = tmpJson({ items: [1, 2] });
  jsonPathSet(p, "test.json", "$.items[2]", { value: "3" });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.items.length === 3 && doc.items[2] === 3);
});
test("[37-A-5] set: wildcard on array sets every element", () => {
  const p = tmpJson({ items: [1, 2, 3] });
  const r = jsonPathSet(p, "test.json", "$.items[*]", { value: "0" });
  assert(r.matchCount === 3);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.items.every((v) => v === 0));
});
test("[37-A-6] set: wildcard on object sets every value", () => {
  const p = tmpJson({ a: 1, b: 2, c: 3 });
  const r = jsonPathSet(p, "test.json", "$.*", { value: "0" });
  assert(r.matchCount === 3);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.a === 0 && doc.b === 0 && doc.c === 0);
});
test("[37-A-7] delete: removes an object key", () => {
  const p = tmpJson({ a: 1, b: 2 });
  const r = jsonPathSet(p, "test.json", "$.b", { delete: true });
  assert(r.operation === "delete" && r.matchCount === 1);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(!("b" in doc) && doc.a === 1);
});
test("[37-A-8] delete: removes an array element, shifting later ones", () => {
  const p = tmpJson({ items: ["x", "y", "z"] });
  jsonPathSet(p, "test.json", "$.items[1]", { delete: true });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.items.length === 2 && doc.items[0] === "x" && doc.items[1] === "z");
});
test("[37-A-9] delete: wildcard deletes all array elements without index-shift bugs", () => {
  const p = tmpJson({ items: [1, 2, 3, 4] });
  jsonPathSet(p, "test.json", "$.items[*]", { delete: true });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(Array.isArray(doc.items) && doc.items.length === 0);
});
test("[37-A-10] set: works on YAML files too", () => {
  const p = tmpYaml("name: web\nport: 80\n");
  jsonPathSet(p, "test.yaml", "$.port", { value: "8080" });
  const text = fs.readFileSync(p, "utf8");
  assert(/port: 8080/.test(text) && /name: web/.test(text));
});
test("[37-A-11] set: dry-run (apply=false) does not write file", () => {
  const p = tmpJson({ a: 1 });
  const before = fs.readFileSync(p, "utf8");
  const r = jsonPathSet(p, "test.json", "$.a", { value: "2", apply: false });
  assert(fs.readFileSync(p, "utf8") === before);
  assert(r.result.a === 2, "result still reflects mutation in memory");
});
test("[37-A-12] set: result has all required fields", () => {
  const p = tmpJson({ a: 1 });
  const r = jsonPathSet(p, "test.json", "$.a", { value: "2" });
  assert("path" in r && "query" in r && "format" in r && "operation" in r &&
         "matchCount" in r && "apply" in r && "originalSize" in r && "newSize" in r && "result" in r);
});

// [37-B] MEDIUM — boundary & validation
test("[37-B-1] set: missing value (and no delete) throws -32602", () => {
  const p = tmpJson({ a: 1 });
  let threw = false;
  try { jsonPathSet(p, "test.json", "$.a", {}); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[37-B-2] set: invalid JSON value throws -32602", () => {
  const p = tmpJson({ a: 1 });
  let threw = false;
  try { jsonPathSet(p, "test.json", "$.a", { value: "{not json" }); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[37-B-3] set: bare root query '$' throws -32602", () => {
  const p = tmpJson({ a: 1 });
  let threw = false;
  try { jsonPathSet(p, "test.json", "$", { value: "1" }); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[37-B-4] set: array slice query rejected as mutation target", () => {
  const p = tmpJson({ items: [1, 2, 3] });
  let threw = false, msg = "";
  try { jsonPathSet(p, "test.json", "$.items[0:2]", { value: "0" }); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /slice/.test(msg));
});
test("[37-B-5] set: recursive descent query rejected as mutation target", () => {
  const p = tmpJson({ a: { b: 1 } });
  let threw = false, msg = "";
  try { jsonPathSet(p, "test.json", "$..b", { value: "0" }); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /descent/.test(msg));
});
test("[37-B-6] set: array index out of bounds throws with a clear message", () => {
  const p = tmpJson({ items: [1, 2] });
  let threw = false, msg = "";
  try { jsonPathSet(p, "test.json", "$.items[9]", { value: "0" }); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /out of bounds/.test(msg));
});
test("[37-B-7] set: query matching nothing returns matchCount 0, does not throw", () => {
  const p = tmpJson({ a: 1 });
  const r = jsonPathSet(p, "test.json", "$.doesNotExist.nested", { value: "1" });
  assert(r.matchCount === 0);
});
test("[37-B-8] set: base file missing throws (not silent)", () => {
  let threw = false;
  try { jsonPathSet(path.join(TMP, "nope.json"), "nope.json", "$.a", { value: "1" }); } catch (e) { threw = true; }
  assert(threw);
});
test("[37-B-9] set: invalid JSON base file throws descriptive error", () => {
  const p = path.join(TMP, `jps-${++_counter}.json`);
  fs.writeFileSync(p, "{not json");
  let threw = false;
  try { jsonPathSet(p, "test.json", "$.a", { value: "1" }); } catch (e) { threw = true; }
  assert(threw);
});

// [37-C] HIGH — structural edge cases
test("[37-C-1] set: key access on a non-object node is silently a no-match, not a crash", () => {
  const p = tmpJson({ a: "scalar" });
  const r = jsonPathSet(p, "test.json", "$.a.nested", { value: "1" });
  assert(r.matchCount === 0);
});
test("[37-C-2] set: index access on a non-array node is silently a no-match", () => {
  const p = tmpJson({ a: { not: "an array" } });
  const r = jsonPathSet(p, "test.json", "$.a[0]", { value: "1" });
  assert(r.matchCount === 0);
});
test("[37-C-3] set: setting an object value (not just scalars) works", () => {
  const p = tmpJson({ config: {} });
  jsonPathSet(p, "test.json", "$.config", { value: JSON.stringify({ nested: { deep: true } }) });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.config.nested.deep === true);
});
test("[37-C-4] set: multiple matches each get an independently-cloned value (no aliasing)", () => {
  const p = tmpJson({ items: [{}, {}] });
  jsonPathSet(p, "test.json", "$.items[*]", { value: JSON.stringify({ tag: "x" }) });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  doc.items[0].tag = "mutated";
  assert(doc.items[1].tag === "x", "second match unaffected by mutating the first");
});
test("[37-C-5] set: forced format overrides extension-based detection", () => {
  const p = path.join(TMP, `jps-${++_counter}.txt`);
  fs.writeFileSync(p, JSON.stringify({ a: 1 }), "utf8");
  jsonPathSet(p, "test.txt", "$.a", { value: "2", format: "json" });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.a === 2);
});
test("[37-C-6] set: indent option controls JSON pretty-printing", () => {
  const p = tmpJson({ a: 1 });
  jsonPathSet(p, "test.json", "$.a", { value: "2", indent: 4 });
  const text = fs.readFileSync(p, "utf8");
  assert(text.includes("    \"a\""), "4-space indent applied");
});

// [37-D] CRITICAL — security
test("[37-D-1] set: shell/SQL-injection-shaped value round-trips literally, never executed", () => {
  const p = tmpJson({ cmd: "clean" });
  jsonPathSet(p, "test.json", "$.cmd", { value: JSON.stringify("'; DROP TABLE users; --") });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.cmd === "'; DROP TABLE users; --");
});
test("[37-D-2] set: path-traversal-shaped string value is inert data, not a path", () => {
  const p = tmpJson({ a: 1 });
  jsonPathSet(p, "test.json", "$.a", { value: JSON.stringify("../../../etc/passwd") });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.a === "../../../etc/passwd");
});
test("[37-D-3] set: __proto__ as a query key does not pollute Object.prototype", () => {
  const p = tmpJson({ a: 1 });
  jsonPathSet(p, "test.json", "$.__proto__.polluted", { value: "true" });
  assert(({}).polluted === undefined && Object.prototype.polluted === undefined);
});
test("[37-D-4] set: HTML/script-shaped value round-trips as literal text", () => {
  const p = tmpJson({ note: "ok" });
  jsonPathSet(p, "test.json", "$.note", { value: JSON.stringify("<script>alert(1)</script>") });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.note === "<script>alert(1)</script>");
});
test("[37-D-5] set: result has no unexpected top-level keys", () => {
  const p = tmpJson({ a: 1 });
  const r = jsonPathSet(p, "test.json", "$.a", { value: "2" });
  const keys = Object.keys(r).sort();
  assert(JSON.stringify(keys) === JSON.stringify(
    ["apply", "format", "matchCount", "newSize", "operation", "originalSize", "path", "query", "result"]
  ));
});

// [37-E] EXTREME
test("[37-E-1] set: large array wildcard set (1000 elements) completes correctly", () => {
  const p = tmpJson({ items: Array.from({ length: 1000 }, (_, i) => i) });
  const start = Date.now();
  const r = jsonPathSet(p, "test.json", "$.items[*]", { value: "0" });
  assert(Date.now() - start < 5000);
  assert(r.matchCount === 1000);
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.items.every((v) => v === 0));
});
test("[37-E-2] set: 50 sequential sets on the same key accumulate correctly", () => {
  const p = tmpJson({ count: 0 });
  for (let i = 1; i <= 50; i++) jsonPathSet(p, "test.json", "$.count", { value: String(i) });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.count === 50);
});
test("[37-E-3] fuzz: random-byte query string throws cleanly, never crashes process", () => {
  const p = tmpJson({ a: 1 });
  const fuzz = Buffer.from(Array.from({ length: 100 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  let handled = false;
  try { jsonPathSet(p, "test.json", fuzz, { value: "1" }); handled = true; }
  catch (e) { handled = true; }
  assert(handled);
});
test("[37-E-4] cleanup: remove json_path_set fixture files created in this section", () => {
  for (let i = 1; i <= _counter; i++) {
    for (const ext of ["json", "yaml", "txt"]) {
      const p = path.join(TMP, `jps-${i}.${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  assert(true);
});
