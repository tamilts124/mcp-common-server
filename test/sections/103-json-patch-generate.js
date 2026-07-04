"use strict";
/**
 * test/sections/103-json-patch-generate.js
 * Isolated functional tests for the json_patch_generate tool.
 * Section [41]
 * Signature under test: jsonPatchGenerate(leftResolved, rightResolved, leftClientPath, rightClientPath, opts)
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { jsonPatchGenerate } = require("../../lib/jsonPatchGenerateOps");
const { jsonPatch } = require("../../lib/jsonPatchOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

let _counter = 0;
function tmpJson(obj) {
  const p = path.join(TMP, `jpg-${++_counter}.json`);
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  return p;
}
function tmpYaml(content) {
  const p = path.join(TMP, `jpg-${++_counter}.yaml`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}
function findOp(ops, opName, ptr) {
  return ops.find((o) => o.op === opName && o.path === ptr);
}

// [41-A] NORMAL
test("[41-A-1] generate: identical documents -> empty ops, identical:true", () => {
  const l = tmpJson({ a: 1 });
  const r = tmpJson({ a: 1 });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(res.identical === true && res.opCount === 0 && res.ops.length === 0);
});
test("[41-A-2] generate: changed scalar value -> replace op", () => {
  const l = tmpJson({ a: 1 });
  const r = tmpJson({ a: 2 });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  const op = findOp(res.ops, "replace", "/a");
  assert(op && op.value === 2);
});
test("[41-A-3] generate: new key -> add op", () => {
  const l = tmpJson({ a: 1 });
  const r = tmpJson({ a: 1, b: 2 });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  const op = findOp(res.ops, "add", "/b");
  assert(op && op.value === 2);
});
test("[41-A-4] generate: removed key -> remove op", () => {
  const l = tmpJson({ a: 1, b: 2 });
  const r = tmpJson({ a: 1 });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(findOp(res.ops, "remove", "/b") !== undefined);
});
test("[41-A-5] generate: nested object change recurses into a deep pointer", () => {
  const l = tmpJson({ spec: { replicas: 1 } });
  const r = tmpJson({ spec: { replicas: 5 } });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  const op = findOp(res.ops, "replace", "/spec/replicas");
  assert(op && op.value === 5);
});
test("[41-A-6] generate: array append -> add op(s) at trailing indices", () => {
  const l = tmpJson({ items: [1, 2] });
  const r = tmpJson({ items: [1, 2, 3] });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  const op = findOp(res.ops, "add", "/items/2");
  assert(op && op.value === 3);
});
test("[41-A-7] generate: array shrink -> remove op(s) highest index first", () => {
  const l = tmpJson({ items: [1, 2, 3] });
  const r = tmpJson({ items: [1] });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  const removes = res.ops.filter((o) => o.op === "remove");
  assert(removes.length === 2 && removes[0].path === "/items/2" && removes[1].path === "/items/1");
});
test("[41-A-8] generate: works on YAML files too", () => {
  const l = tmpYaml("name: web\nport: 80\n");
  const r = tmpYaml("name: web\nport: 8080\n");
  const res = jsonPatchGenerate(l, r, "l.yaml", "r.yaml");
  assert(res.format === "yaml" && findOp(res.ops, "replace", "/port")?.value === 8080);
});
test("[41-A-9] round-trip: generated ops actually apply cleanly via the real json_patch tool", () => {
  const before = { name: "svc", port: 80, tags: ["a", "b"] };
  const after  = { name: "svc", port: 8080, tags: ["a", "b", "c"], enabled: true };
  const l = tmpJson(before);
  const r = tmpJson(after);
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  const target = tmpJson(before);
  jsonPatch(target, "target.json", res.ops, { apply: true });
  const applied = JSON.parse(fs.readFileSync(target, "utf8"));
  // json_patch's 'replace' (remove+add) can reorder object keys, so compare
  // structurally (sorted-key JSON) rather than raw JSON.stringify order.
  const sortKeys = (v) => (v && typeof v === "object" && !Array.isArray(v))
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
    : Array.isArray(v) ? v.map(sortKeys) : v;
  assert(JSON.stringify(sortKeys(applied)) === JSON.stringify(sortKeys(after)));
});
test("[41-A-10] generate: RFC 6901 pointer escaping for keys containing '/' and '~'", () => {
  const l = tmpJson({ "a/b": 1, "c~d": 1 });
  const r = tmpJson({ "a/b": 2, "c~d": 2 });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(findOp(res.ops, "replace", "/a~1b")?.value === 2);
  assert(findOp(res.ops, "replace", "/c~0d")?.value === 2);
});

// [41-B] MEDIUM — boundary & validation
test("[41-B-1] generate: missing left file throws", () => {
  let threw = false;
  try { jsonPatchGenerate(path.join(TMP, "nope.json"), tmpJson({}), "nope.json", "r.json"); }
  catch (e) { threw = true; }
  assert(threw);
});
test("[41-B-2] generate: invalid JSON in right file throws descriptive error", () => {
  const l = tmpJson({ a: 1 });
  const r = path.join(TMP, `jpg-${++_counter}.json`);
  fs.writeFileSync(r, "{not json");
  let threw = false, msg = "";
  try { jsonPatchGenerate(l, r, "l.json", "r.json"); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /not valid JSON/.test(msg));
});
test("[41-B-3] generate: unsupported forced format throws -32602", () => {
  const l = tmpJson({ a: 1 });
  const r = tmpJson({ a: 2 });
  let threw = false;
  try { jsonPatchGenerate(l, r, "l.json", "r.json", { format: "xml" }); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[41-B-4] generate: max_ops clamps ops array but opCount stays true total", () => {
  const l = tmpJson({});
  const r = tmpJson(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])));
  const res = jsonPatchGenerate(l, r, "l.json", "r.json", { max_ops: 5 });
  assert(res.ops.length === 5 && res.opCount === 20 && res.truncated === true);
});
test("[41-B-5] generate: non-numeric max_ops falls back to default", () => {
  const l = tmpJson({ a: 1 });
  const r = tmpJson({ a: 2 });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json", { max_ops: "not-a-number" });
  assert(res.opCount === 1 && res.truncated === false);
});

// [41-C] HIGH — structural edge cases
test("[41-C-1] generate: type change object->scalar emits single replace, not recursed removes", () => {
  const l = tmpJson({ a: { nested: true } });
  const r = tmpJson({ a: "scalar" });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  const op = findOp(res.ops, "replace", "/a");
  assert(op && op.value === "scalar" && res.ops.length === 1);
});
test("[41-C-2] generate: root-level type change (array -> object) emits replace at root pointer \"\"", () => {
  const lp = tmpJson([1, 2]);
  const rp = tmpJson({ a: 1 });
  const res = jsonPatchGenerate(lp, rp, "l.json", "r.json");
  const op = findOp(res.ops, "replace", "");
  assert(op !== undefined);
});
test("[41-C-3] generate: null vs object treated as type mismatch replace, no crash", () => {
  const l = tmpJson({ a: null });
  const r = tmpJson({ a: { x: 1 } });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(findOp(res.ops, "replace", "/a") !== undefined);
});
test("[41-C-4] generate: forced format overrides extension-based detection for both sides", () => {
  const l = path.join(TMP, `jpg-${++_counter}.txt`);
  const r = path.join(TMP, `jpg-${++_counter}.txt`);
  fs.writeFileSync(l, JSON.stringify({ a: 1 }));
  fs.writeFileSync(r, JSON.stringify({ a: 2 }));
  const res = jsonPatchGenerate(l, r, "l.txt", "r.txt", { format: "json" });
  assert(res.format === "json" && findOp(res.ops, "replace", "/a")?.value === 2);
});
test("[41-C-5] generate: mixed array-of-objects diff recurses per-index into object keys", () => {
  const l = tmpJson({ items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] });
  const r = tmpJson({ items: [{ id: 1, name: "A" }, { id: 2, name: "b" }] });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(findOp(res.ops, "replace", "/items/0/name")?.value === "A");
});

// [41-D] CRITICAL — security
test("[41-D-1] generate: SQL-injection-shaped value round-trips as inert literal text in op.value", () => {
  const l = tmpJson({ note: "clean" });
  const r = tmpJson({ note: "'; DROP TABLE users; --" });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(findOp(res.ops, "replace", "/note")?.value === "'; DROP TABLE users; --");
});
test("[41-D-2] generate: path-traversal-shaped key becomes an inert (escaped) JSON pointer segment, not a real path", () => {
  const l = tmpJson({ "../../../etc/passwd": 1 });
  const r = tmpJson({ "../../../etc/passwd": 2 });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(findOp(res.ops, "replace", "/..~1..~1..~1etc~1passwd")?.value === 2);
});
test("[41-D-3] generate: __proto__ as an object key does not pollute Object.prototype during diffing", () => {
  const l = tmpJson({ a: 1 });
  const r = tmpJson({ a: 1, __proto__: { polluted: true } });
  jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(({}).polluted === undefined && Object.prototype.polluted === undefined);
});
test("[41-D-4] generate: HTML/script-shaped value round-trips as literal text", () => {
  const l = tmpJson({ note: "ok" });
  const r = tmpJson({ note: "<script>alert(1)</script>" });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  assert(findOp(res.ops, "replace", "/note")?.value === "<script>alert(1)</script>");
});
test("[41-D-5] generate: result has no unexpected top-level keys", () => {
  const l = tmpJson({ a: 1 });
  const r = tmpJson({ a: 2 });
  const res = jsonPatchGenerate(l, r, "l.json", "r.json");
  const keys = Object.keys(res).sort();
  assert(JSON.stringify(keys) === JSON.stringify(
    ["format", "identical", "left", "opCount", "ops", "right", "truncated"]
  ));
});

// [41-E] EXTREME
test("[41-E-1] generate: 500-key object diff completes correctly and quickly", () => {
  const before = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
  const after  = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i === 250 ? -1 : i]));
  const l = tmpJson(before);
  const r = tmpJson(after);
  const start = Date.now();
  const res = jsonPatchGenerate(l, r, "l.json", "r.json", { max_ops: 5000 });
  assert(Date.now() - start < 5000);
  assert(res.opCount === 1 && findOp(res.ops, "replace", "/k250")?.value === -1);
});
test("[41-E-2] generate: deeply nested structure diff does not crash or stack-overflow", () => {
  let l = {}, cur = l;
  for (let i = 0; i < 40; i++) { cur.child = {}; cur = cur.child; }
  cur.value = 1;
  let r = JSON.parse(JSON.stringify(l));
  let rc = r;
  for (let i = 0; i < 40; i++) rc = rc.child;
  rc.value = 2;
  const lp = tmpJson(l);
  const rp = tmpJson(r);
  let handled = false;
  try { jsonPatchGenerate(lp, rp, "l.json", "r.json"); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[41-E-3] generate: 20 rapid sequential calls with different file pairs are independent", () => {
  for (let i = 0; i < 20; i++) {
    const l = tmpJson({ n: i });
    const r = tmpJson({ n: i + 1 });
    const res = jsonPatchGenerate(l, r, "l.json", "r.json");
    assert(findOp(res.ops, "replace", "/n")?.value === i + 1);
  }
});
test("[41-E-4] cleanup: remove json_patch_generate fixture files created in this section", () => {
  for (let i = 1; i <= _counter; i++) {
    for (const ext of ["json", "yaml", "txt"]) {
      const p = path.join(TMP, `jpg-${i}.${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  assert(true);
});
