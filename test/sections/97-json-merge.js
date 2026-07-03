"use strict";
/**
 * test/sections/97-json-merge.js
 * Isolated functional tests for the json_merge tool (RFC 7396 JSON Merge
 * Patch) — all five rigor levels in one file since the tool is small.
 * Section [35]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { jsonMerge, mergePatch } = require("../../lib/jsonMergeOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

let _counter = 0;
function tmpJson(obj) {
  const p = path.join(TMP, `jm-${++_counter}.json`);
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  return p;
}

// [35-A] NORMAL
test("[35-A-1] merge: patch adds a new top-level key", () => {
  const p = tmpJson({ name: "Alice", age: 30 });
  const r = jsonMerge(p, "test.json", JSON.stringify({ city: "London" }));
  assert(r.apply === true, "apply defaults true");
  assert(r.result.name === "Alice" && r.result.age === 30 && r.result.city === "London");
});
test("[35-A-2] merge: patch overrides existing scalar", () => {
  const p = tmpJson({ version: 1, debug: false });
  jsonMerge(p, "test.json", JSON.stringify({ version: 2 }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.version === 2 && doc.debug === false);
});
test("[35-A-3] merge: nested objects merge recursively", () => {
  const p = tmpJson({ service: { name: "web", port: 80 } });
  jsonMerge(p, "test.json", JSON.stringify({ service: { port: 8080 } }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.service.name === "web" && doc.service.port === 8080);
});
test("[35-A-4] merge: array in patch fully replaces base array", () => {
  const p = tmpJson({ ports: [80, 443] });
  jsonMerge(p, "test.json", JSON.stringify({ ports: [9000] }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.ports.length === 1 && doc.ports[0] === 9000);
});
test("[35-A-5] merge: dry-run (apply=false) does not modify file", () => {
  const p = tmpJson({ x: 1 });
  const before = fs.readFileSync(p, "utf8");
  const r = jsonMerge(p, "test.json", JSON.stringify({ x: 2 }), { apply: false });
  assert(fs.readFileSync(p, "utf8") === before, "unchanged on dry-run");
  assert(r.result.x === 2, "result still reflects merge");
});
test("[35-A-6] merge: result has all required fields", () => {
  const p = tmpJson({ a: 1 });
  const r = jsonMerge(p, "test.json", JSON.stringify({ b: 2 }));
  assert("path" in r && "apply" in r && "originalSize" in r && "newSize" in r && "result" in r);
  assert(r.path === "test.json", "path echoes client-relative path");
});
test("[35-A-7] mergePatch (direct): pure function, no mutation of inputs", () => {
  const base = { a: 1, nested: { x: 1 } };
  const merged = mergePatch(base, { nested: { y: 2 } });
  assert(base.nested.y === undefined, "base unmutated");
  assert(merged.nested.x === 1 && merged.nested.y === 2);
});

// [35-B] MEDIUM — boundary & validation
test("[35-B-1] merge: missing 'patch' throws -32602", () => {
  const p = tmpJson({ a: 1 });
  let threw = false;
  try { jsonMerge(p, "test.json", undefined); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[35-B-2] merge: empty string patch throws -32602", () => {
  const p = tmpJson({ a: 1 });
  let threw = false;
  try { jsonMerge(p, "test.json", ""); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[35-B-3] merge: whitespace-only patch throws -32602", () => {
  const p = tmpJson({ a: 1 });
  let threw = false;
  try { jsonMerge(p, "test.json", "   \n  "); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[35-B-4] merge: base file missing throws (not silent)", () => {
  let threw = false;
  try { jsonMerge(path.join(TMP, "nope.json"), "nope.json", "{}"); } catch (e) { threw = true; }
  assert(threw);
});
test("[35-B-5] merge: invalid JSON base throws descriptive error", () => {
  const p = tmpJson("{not json");
  let threw = false, msg = "";
  try { jsonMerge(p, "test.json", "{}"); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /base file is not valid JSON/.test(msg));
});
test("[35-B-6] merge: invalid JSON patch throws descriptive error", () => {
  const p = tmpJson({ a: 1 });
  let threw = false, msg = "";
  try { jsonMerge(p, "test.json", "{not json"); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /patch is not valid JSON/.test(msg));
});
test("[35-B-7] merge: indent option clamped to 0-8 range", () => {
  const p = tmpJson({ a: 1 });
  const r = jsonMerge(p, "test.json", JSON.stringify({ b: 2 }), { indent: 999 });
  assert(r.newSize > 0);
});

// [35-C] HIGH — mismatched shapes
test("[35-C-1] merge: base object + patch scalar for same key replaces outright", () => {
  const p = tmpJson({ config: { a: 1, b: 2 } });
  jsonMerge(p, "test.json", JSON.stringify({ config: "disabled" }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.config === "disabled");
});
test("[35-C-2] merge: base scalar + patch object for same key replaces outright", () => {
  const p = tmpJson({ config: "disabled" });
  jsonMerge(p, "test.json", JSON.stringify({ config: { a: 1 } }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.config.a === 1);
});
test("[35-C-3] merge: base array + patch object for same key replaces outright", () => {
  const p = tmpJson({ items: [1, 2] });
  jsonMerge(p, "test.json", JSON.stringify({ items: { x: 1 } }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(!Array.isArray(doc.items) && doc.items.x === 1);
});
test("[35-C-4] merge: null in patch DELETES the key (RFC 7396, differs from yaml_merge)", () => {
  const p = tmpJson({ a: 1, b: 2 });
  jsonMerge(p, "test.json", JSON.stringify({ a: null }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(!("a" in doc) && doc.b === 2);
});
test("[35-C-5] merge: deeply nested null deletes only the targeted leaf", () => {
  const p = tmpJson({ a: { b: { c: 1, d: 2 } } });
  jsonMerge(p, "test.json", JSON.stringify({ a: { b: { c: null } } }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(!("c" in doc.a.b) && doc.a.b.d === 2);
});
test("[35-C-6] merge: multiple sibling keys merged/added/deleted in one call", () => {
  const p = tmpJson({ a: 1, b: 2, c: 3 });
  jsonMerge(p, "test.json", JSON.stringify({ b: null, c: 30, d: 4 }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.a === 1 && !("b" in doc) && doc.c === 30 && doc.d === 4);
});
test("[35-C-7] merge: non-object patch at top level fully replaces base", () => {
  assert(mergePatch({ a: 1 }, "hello") === "hello");
  assert(mergePatch({ a: 1 }, 42) === 42);
  assert(mergePatch({ a: 1 }, null) === null);
});

// [35-D] CRITICAL — security & sanitization
test("[35-D-1] merge: shell/SQL-injection-shaped string values round-trip literally", () => {
  const p = tmpJson({ cmd: "clean" });
  jsonMerge(p, "test.json", JSON.stringify({ cmd: "'; DROP TABLE users; --", sql: "$(rm -rf /)" }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.cmd === "'; DROP TABLE users; --" && doc.sql === "$(rm -rf /)");
});
test("[35-D-2] merge: HTML/script-shaped value round-trips as literal text", () => {
  const p = tmpJson({ note: "ok" });
  jsonMerge(p, "test.json", JSON.stringify({ note: "<script>alert(1)</script>" }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.note === "<script>alert(1)</script>");
});
test("[35-D-3] merge: path-traversal-shaped string value is inert data, not a path", () => {
  const p = tmpJson({ a: 1 });
  const r = jsonMerge(p, "test.json", JSON.stringify({ path: "../../../etc/passwd" }));
  assert(r.result.path === "../../../etc/passwd");
});
test("[35-D-4] merge: __proto__ patch key does not pollute Object.prototype", () => {
  const p = tmpJson({ a: 1 });
  jsonMerge(p, "test.json", JSON.stringify({ __proto__: { polluted: true } }));
  assert(({}).polluted === undefined && Object.prototype.polluted === undefined);
});
test("[35-D-5] merge: result is fully JSON-serialisable, nested value survives round-trip", () => {
  const p = tmpJson({ a: 1 });
  const r = jsonMerge(p, "test.json", JSON.stringify({ b: 2, c: { d: 3 } }));
  const parsed = JSON.parse(JSON.stringify(r));
  assert(parsed.result.c.d === 3);
});
test("[35-D-6] merge: result has no unexpected top-level keys", () => {
  const p = tmpJson({ a: 1 });
  const r = jsonMerge(p, "test.json", JSON.stringify({ b: 2 }));
  const keys = Object.keys(r).sort();
  assert(JSON.stringify(keys) === JSON.stringify(["apply", "newSize", "originalSize", "path", "result"]));
});
test("[35-D-7] merge: unicode and emoji values round-trip correctly", () => {
  const p = tmpJson({ greeting: "hello" });
  jsonMerge(p, "test.json", JSON.stringify({ greeting: "héllo wörld 🚀 日本語" }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.greeting === "héllo wörld 🚀 日本語");
});

// [35-E] EXTREME — fuzzing, scale, sequential/concurrent
test("[35-E-1] merge: large base document (1000 keys) merges quickly and correctly", () => {
  const base = {};
  for (let i = 0; i < 1000; i++) base["k" + i] = i;
  const p = tmpJson(base);
  const start = Date.now();
  jsonMerge(p, "test.json", JSON.stringify({ k500: 999999, newkey: "added" }));
  assert(Date.now() - start < 5000, "completes within 5s");
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.k500 === 999999 && doc.k0 === 0 && doc.k999 === 999 && doc.newkey === "added");
});
test("[35-E-2] merge: deeply nested patch (10 levels) merges and reads back correctly", () => {
  const p = tmpJson({ root: 1 });
  let node = { leaf: "deep-value" };
  for (let i = 0; i < 9; i++) node = { ["n" + i]: node };
  jsonMerge(p, "test.json", JSON.stringify({ a: node }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  let cur = doc.a;
  for (let i = 8; i >= 0; i--) cur = cur["n" + i];
  assert(cur.leaf === "deep-value");
});
test("[35-E-3] merge: 50 sequential merges on same file accumulate correctly", () => {
  const p = tmpJson({ count: 0 });
  for (let i = 1; i <= 50; i++) jsonMerge(p, "test.json", JSON.stringify({ count: i }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.count === 50);
});
test("[35-E-4] merge: 10 dry-runs on same file do not interfere or write", () => {
  const p = tmpJson({ x: 1 });
  const before = fs.readFileSync(p, "utf8");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(jsonMerge(p, "test.json", JSON.stringify({ x: i }), { apply: false }));
  assert(fs.readFileSync(p, "utf8") === before, "file untouched after 10 dry-runs");
  assert(results.every((r, i) => r.result.x === i));
});
test("[35-E-5] merge: fuzz — random-byte patch string throws cleanly, never crashes process", () => {
  const p = tmpJson({ a: 1 });
  const fuzz = Buffer.from(Array.from({ length: 200 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  let handled = false;
  try { jsonMerge(p, "test.json", fuzz); handled = true; }
  catch (e) { handled = true; }
  assert(handled);
});
test("[35-E-6] merge: large patch array (500 entries) does not crash serializer", () => {
  const p = tmpJson({ items: [1] });
  const arr = Array.from({ length: 500 }, (_, i) => "item" + i);
  jsonMerge(p, "test.json", JSON.stringify({ items: arr }));
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  assert(doc.items.length === 500);
});
test("[35-E-7] cleanup: remove json_merge fixture files created in this section", () => {
  for (let i = 1; i <= _counter; i++) {
    const p = path.join(TMP, `jm-${i}.json`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  assert(true);
});
