#!/usr/bin/env node
"use strict";
// ── Section 215: json_client ─────────────────────────────────────────────
// Tests: A=input-validation x10, B=unit x20, C=happy-path x20,
//        D=security x10, E=error-paths x10, F=concurrency x5 — 75 total

const os   = require("os");
const fs   = require("fs");
const path = require("path");
const { jsonClient } = require("../../lib/jsonClientOps");

// ── Test runner ──────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; process.stdout.write("."); }
  else { failed++; console.error(`\nFAIL: ${msg}`); }
}
function assertThrows(fn, pat, msg) {
  try { fn(); failed++; console.error(`\nFAIL (no throw): ${msg}`); }
  catch (e) {
    if (pat && !e.message.includes(pat)) {
      failed++; console.error(`\nFAIL (wrong error '${e.message}' ≠ '${pat}'): ${msg}`);
    } else { passed++; process.stdout.write("."); }
  }
}

// ── Temp helpers ───────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "json-client-test-"));
function tmpPath(name) { return path.join(TMP, name); }
function writeJson(name, obj) {
  const p = tmpPath(name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return p;
}
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }

// ═══════════════════════════════════════════════════════════════════════
// A — Input validation (10 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log("\nA — input validation");

// A1: unknown operation
assertThrows(() => jsonClient({ operation: "explode", path: "x.json" }),
  "unknown operation", "A1: unknown op");

// A2: empty path
assertThrows(() => jsonClient({ operation: "read", path: "" }),
  "non-empty string", "A2: empty path");

// A3: NUL byte in path
assertThrows(() => jsonClient({ operation: "read", path: "foo\0bar.json" }),
  "NUL byte", "A3: NUL in path");

// A4: get without key_path
{
  const p = writeJson("a4.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "get", path: p }),
    "key_path", "A4: get missing key_path");
}

// A5: set without value
{
  const p = writeJson("a5.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "set", path: p, key_path: "a" }),
    "'value' is required", "A5: set missing value");
}

// A6: set without key_path (null)
{
  const p = writeJson("a6.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "set", path: p, value: 42 }),
    "key_path", "A6: set missing key_path");
}

// A7: delete without key_path
{
  const p = writeJson("a7.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "delete", path: p }),
    "key_path", "A7: delete missing key_path");
}

// A8: merge without sources or data
{
  const p = writeJson("a8.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "merge", path: p }),
    "'sources'", "A8: merge missing sources/data");
}

// A9: patch with empty operations
{
  const p = writeJson("a9.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "patch", path: p, operations: [] }),
    "non-empty array", "A9: patch empty operations");
}

// A10: get from missing file (no default, no create)
assertThrows(() => jsonClient({ operation: "get", path: tmpPath("missing_a10.json"), key_path: "x" }),
  "not found", "A10: get from missing file");

// ═══════════════════════════════════════════════════════════════════════
// B — Unit tests (20 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log("\nB — unit tests");

// B1: read returns full doc
{
  const doc = { name: "test", version: "1.0.0", count: 42 };
  const p = writeJson("b1.json", doc);
  const r = jsonClient({ operation: "read", path: p });
  assert(r.value.name === "test" && r.value.version === "1.0.0", "B1: read full doc");
  assert(r.type === "object", "B1b: type=object");
}

// B2: read array document
{
  const p = writeJson("b2.json", [1, 2, 3]);
  const r = jsonClient({ operation: "read", path: p });
  assert(r.type === "array" && r.value.length === 3, "B2: read array");
}

// B3: get nested key
{
  const p = writeJson("b3.json", { a: { b: { c: 99 } } });
  const r = jsonClient({ operation: "get", path: p, key_path: "a.b.c" });
  assert(r.value === 99, "B3: get nested value");
  assert(r.found === true, "B3b: found=true");
}

// B4: get array index
{
  const p = writeJson("b4.json", { items: ["x", "y", "z"] });
  const r = jsonClient({ operation: "get", path: p, key_path: "items.1" });
  assert(r.value === "y", "B4: get array index");
}

// B5: get missing key returns default
{
  const p = writeJson("b5.json", { a: 1 });
  const r = jsonClient({ operation: "get", path: p, key_path: "b.c", default: "fallback", default_value_set: true });
  assert(r.found === false && r.value === "fallback", "B5: default on missing key");
}

// B6: get null default
{
  const p = writeJson("b6.json", { a: 1 });
  const r = jsonClient({ operation: "get", path: p, key_path: "nope", default: null, default_value_set: true });
  assert(r.found === false && r.value === null, "B6: null as default");
}

// B7: set creates new key
{
  const p = writeJson("b7.json", { a: 1 });
  jsonClient({ operation: "set", path: p, key_path: "b", value: 99 });
  const doc = readJson(p);
  assert(doc.b === 99, "B7: set new key");
}

// B8: set overwrites existing key
{
  const p = writeJson("b8.json", { x: "old" });
  jsonClient({ operation: "set", path: p, key_path: "x", value: "new" });
  const doc = readJson(p);
  assert(doc.x === "new", "B8: set overwrites");
}

// B9: set nested path
{
  const p = writeJson("b9.json", { a: { b: 1 } });
  jsonClient({ operation: "set", path: p, key_path: "a.b", value: 999 });
  assert(readJson(p).a.b === 999, "B9: set nested");
}

// B10: set with create=true creates new file
{
  const p = tmpPath("b10-new.json");
  jsonClient({ operation: "set", path: p, key_path: "hello", value: "world", create: true });
  assert(readJson(p).hello === "world", "B10: set create=true");
}

// B11: delete object key
{
  const p = writeJson("b11.json", { keep: 1, remove: 2 });
  jsonClient({ operation: "delete", path: p, key_path: "remove" });
  const doc = readJson(p);
  assert(doc.keep === 1 && !("remove" in doc), "B11: delete key");
}

// B12: delete array element by index (splice)
{
  const p = writeJson("b12.json", { arr: ["a", "b", "c"] });
  jsonClient({ operation: "delete", path: p, key_path: "arr.1" });
  const doc = readJson(p);
  assert(JSON.stringify(doc.arr) === JSON.stringify(["a", "c"]), "B12: delete array element");
}

// B13: delete ignore_missing
{
  const p = writeJson("b13.json", { a: 1 });
  const r = jsonClient({ operation: "delete", path: p, key_path: "ghost", ignore_missing: true });
  assert(r.deleted === false, "B13: ignore_missing returns deleted=false");
}

// B14: keys on object
{
  const p = writeJson("b14.json", { x: 1, y: 2, z: 3 });
  const r = jsonClient({ operation: "keys", path: p });
  assert(r.type === "object" && r.count === 3, "B14: keys count");
  assert(r.keys.includes("x") && r.keys.includes("z"), "B14b: keys content");
}

// B15: keys on array returns length and indices
{
  const p = writeJson("b15.json", ["a", "b", "c", "d"]);
  const r = jsonClient({ operation: "keys", path: p });
  assert(r.type === "array" && r.length === 4, "B15: keys on array");
}

// B16: keys at nested path
{
  const p = writeJson("b16.json", { nested: { a: 1, b: 2 } });
  const r = jsonClient({ operation: "keys", path: p, key_path: "nested" });
  assert(r.count === 2, "B16: nested keys count");
}

// B17: merge data into file
{
  const p = writeJson("b17.json", { a: 1, b: { x: 10 } });
  jsonClient({ operation: "merge", path: p, data: { b: { y: 20 }, c: 3 } });
  const doc = readJson(p);
  assert(doc.a === 1 && doc.b.x === 10 && doc.b.y === 20 && doc.c === 3, "B17: deep merge data");
}

// B18: merge from source file
{
  const base  = writeJson("b18-base.json",   { a: 1, b: { x: 1 } });
  const other = writeJson("b18-source.json", { b: { y: 2 }, c: 3 });
  jsonClient({ operation: "merge", path: base, sources: [other] });
  const doc = readJson(base);
  assert(doc.b.x === 1 && doc.b.y === 2, "B18: merge from file deep");
}

// B19: patch add operation
{
  const p = writeJson("b19.json", { version: "1.0.0" });
  jsonClient({ operation: "patch", path: p, operations: [{ op: "add", path: "/name", value: "myapp" }] });
  assert(readJson(p).name === "myapp", "B19: patch add");
}

// B20: stringify returns formatted JSON string
{
  const doc = { z: 3, a: 1, b: 2 };
  const p = writeJson("b20.json", doc);
  const r = jsonClient({ operation: "stringify", path: p, indent: 4 });
  assert(r.content.includes("    "), "B20: stringify 4-space indent");
  assert(!r.written, "B20b: written=false by default");
}

// ═══════════════════════════════════════════════════════════════════════
// C — Happy-path (20 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log("\nC — happy-path");

// C1: full round-trip: read → set → get → delete → keys
{
  const p = writeJson("c1.json", { name: "Alice", age: 30 });
  jsonClient({ operation: "set", path: p, key_path: "city", value: "London" });
  const r = jsonClient({ operation: "get", path: p, key_path: "city" });
  assert(r.value === "London", "C1a: get after set");
  jsonClient({ operation: "delete", path: p, key_path: "city" });
  const keys = jsonClient({ operation: "keys", path: p });
  assert(!keys.keys.includes("city"), "C1b: key removed");
}

// C2: set root document (key_path='')
{
  const p = writeJson("c2.json", { old: true });
  jsonClient({ operation: "set", path: p, key_path: "", value: { brand: "new" } });
  const doc = readJson(p);
  assert(doc.brand === "new" && !("old" in doc), "C2: set root replaces doc");
}

// C3: set nested path creates intermediate objects
{
  const p = writeJson("c3.json", { level1: { level2: {} } });
  jsonClient({ operation: "set", path: p, key_path: "level1.level2.level3", value: "deep" });
  assert(readJson(p).level1.level2.level3 === "deep", "C3: set deep path");
}

// C4: set array value
{
  const p = writeJson("c4.json", {});
  jsonClient({ operation: "set", path: p, key_path: "tags", value: ["a", "b", "c"] });
  const doc = readJson(p);
  assert(Array.isArray(doc.tags) && doc.tags[1] === "b", "C4: set array value");
}

// C5: set index in existing array
{
  const p = writeJson("c5.json", { arr: [1, 2, 3] });
  jsonClient({ operation: "set", path: p, key_path: "arr.1", value: 99 });
  assert(readJson(p).arr[1] === 99, "C5: set array index");
}

// C6: delete then verify keys shrinks
{
  const p = writeJson("c6.json", { a: 1, b: 2, c: 3 });
  jsonClient({ operation: "delete", path: p, key_path: "b" });
  const r = jsonClient({ operation: "keys", path: p });
  assert(r.count === 2 && !r.keys.includes("b"), "C6: delete reduces keys");
}

// C7: merge with multiple sources — later wins on conflict
{
  const base = writeJson("c7-base.json", { a: 1, b: 1 });
  const s1   = writeJson("c7-s1.json",   { b: 2, c: 2 });
  const s2   = writeJson("c7-s2.json",   { c: 3, d: 4 });
  jsonClient({ operation: "merge", path: base, sources: [s1, s2] });
  const doc = readJson(base);
  assert(doc.a === 1, "C7a: base key preserved");
  assert(doc.b === 2, "C7b: source override");
  assert(doc.c === 3, "C7c: later source wins");
  assert(doc.d === 4, "C7d: new key added");
}

// C8: merge data after sources
{
  const base = writeJson("c8-base.json", { x: 1 });
  const src  = writeJson("c8-src.json",  { y: 2 });
  jsonClient({ operation: "merge", path: base, sources: [src], data: { z: 3 } });
  const doc = readJson(base);
  assert(doc.x === 1 && doc.y === 2 && doc.z === 3, "C8: merge sources+data");
}

// C9: patch remove operation
{
  const p = writeJson("c9.json", { a: 1, b: 2, c: 3 });
  jsonClient({ operation: "patch", path: p, operations: [{ op: "remove", path: "/b" }] });
  const doc = readJson(p);
  assert(!("b" in doc) && doc.a === 1, "C9: patch remove");
}

// C10: patch replace operation
{
  const p = writeJson("c10.json", { version: "1.0" });
  jsonClient({ operation: "patch", path: p, operations: [{ op: "replace", path: "/version", value: "2.0" }] });
  assert(readJson(p).version === "2.0", "C10: patch replace");
}

// C11: patch move operation
{
  const p = writeJson("c11.json", { old_key: "value" });
  jsonClient({ operation: "patch", path: p, operations: [{ op: "move", from: "/old_key", path: "/new_key" }] });
  const doc = readJson(p);
  assert(doc.new_key === "value" && !("old_key" in doc), "C11: patch move");
}

// C12: patch copy operation
{
  const p = writeJson("c12.json", { a: { nested: 42 } });
  jsonClient({ operation: "patch", path: p, operations: [{ op: "copy", from: "/a", path: "/b" }] });
  const doc = readJson(p);
  assert(doc.b.nested === 42, "C12: patch copy");
}

// C13: patch test succeeds
{
  const p = writeJson("c13.json", { version: "1.0" });
  const r = jsonClient({ operation: "patch", path: p,
    operations: [{ op: "test", path: "/version", value: "1.0" }] });
  assert(r.opsApplied === 1, "C13: patch test succeeds");
}

// C14: stringify write_back reformats file
{
  const p = tmpPath("c14.json");
  fs.writeFileSync(p, '{"a":1,"b":2}', "utf8"); // minified
  jsonClient({ operation: "stringify", path: p, indent: 2, write_back: true });
  const raw = fs.readFileSync(p, "utf8");
  assert(raw.includes("  "), "C14: write_back reformats");
}

// C15: stringify indent=0 minifies
{
  const p = writeJson("c15.json", { hello: "world" });
  const r = jsonClient({ operation: "stringify", path: p, indent: 0 });
  assert(!r.content.includes("\n"), "C15: minify no newlines");
}

// C16: read json null document
{
  const p = tmpPath("c16.json");
  fs.writeFileSync(p, "null\n", "utf8");
  const r = jsonClient({ operation: "read", path: p });
  assert(r.value === null && r.type === "null", "C16: read null doc");
}

// C17: get returns correct type for different value types
{
  const p = writeJson("c17.json", { n: 42, s: "hello", b: true, arr: [], obj: {} });
  assert(jsonClient({ operation: "get", path: p, key_path: "n" }).type === "number", "C17a: number type");
  assert(jsonClient({ operation: "get", path: p, key_path: "s" }).type === "string", "C17b: string type");
  assert(jsonClient({ operation: "get", path: p, key_path: "b" }).type === "boolean", "C17c: boolean type");
  assert(jsonClient({ operation: "get", path: p, key_path: "arr" }).type === "array", "C17d: array type");
}

// C18: merge with create=true creates file
{
  const p = tmpPath("c18-new.json");
  jsonClient({ operation: "merge", path: p, data: { fresh: true }, create: true });
  assert(readJson(p).fresh === true, "C18: merge create=true");
}

// C19: multiple patch ops in one call
{
  const p = writeJson("c19.json", { a: 1, b: 2 });
  jsonClient({ operation: "patch", path: p, operations: [
    { op: "add",     path: "/c", value: 3 },
    { op: "replace", path: "/a", value: 10 },
    { op: "remove",  path: "/b" },
  ]});
  const doc = readJson(p);
  assert(doc.a === 10 && doc.c === 3 && !("b" in doc), "C19: multi-op patch");
}

// C20: dot in key name with escape
{
  // Writing a key with a literal dot requires JSON directly
  const p = tmpPath("c20.json");
  fs.writeFileSync(p, JSON.stringify({ "a.b": "dotted" }), "utf8");
  // Read the dotted key using escape: 'a\\.b'
  const r = jsonClient({ operation: "get", path: p, key_path: "a\\.b" });
  assert(r.value === "dotted", "C20: escaped dot in key name");
}

// ═══════════════════════════════════════════════════════════════════════
// D — Security (10 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log("\nD — security");

// D1: NUL byte in path for set
assertThrows(() => jsonClient({ operation: "set", path: "foo\0bar.json", key_path: "x", value: 1 }),
  "NUL byte", "D1: NUL in set path");

// D2: NUL byte in path for merge source
{
  const p = writeJson("d2.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "merge", path: p, sources: ["foo\0bar.json"] }),
    "NUL byte", "D2: NUL in merge source");
}

// D3: malformed JSON in file is rejected clearly
{
  const p = tmpPath("d3-bad.json");
  fs.writeFileSync(p, "{invalid json", "utf8");
  assertThrows(() => jsonClient({ operation: "read", path: p }),
    "JSON parse error", "D3: malformed JSON error");
}

// D4: deeply nested document triggers depth guard
{
  let obj = {}; let cur = obj;
  for (let i = 0; i < 110; i++) { cur.child = {}; cur = cur.child; }
  const p = tmpPath("d4-deep.json");
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
  assertThrows(() => jsonClient({ operation: "read", path: p }),
    "max nesting depth", "D4: depth limit");
}

// D5: file too large is rejected
{
  const p = tmpPath("d5-large.json");
  // Write just over 10 MB
  const big = JSON.stringify({ data: "x".repeat(11 * 1024 * 1024) });
  fs.writeFileSync(p, big, "utf8");
  assertThrows(() => jsonClient({ operation: "read", path: p }),
    "too large", "D5: file size cap");
}

// D6: patch test failure causes rollback
{
  const p = writeJson("d6.json", { val: 1 });
  assertThrows(() => jsonClient({ operation: "patch", path: p, operations: [
    { op: "add",  path: "/new", value: 99 },       // this would succeed
    { op: "test", path: "/val", value: "WRONG" },   // this fails → rollback
  ]}), "does not equal", "D6: patch test rollback");
  // File should be unchanged (rollback)
  assert(!("new" in readJson(p)), "D6b: rollback preserved original");
}

// D7: delete root is rejected
{
  const p = writeJson("d7.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "delete", path: p, key_path: "" }),
    "cannot delete the root", "D7: delete root rejected");
}

// D8: set on missing parent path rejected
{
  const p = writeJson("d8.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "set", path: p, key_path: "a.b.c", value: 1 }),
    "parent path", "D8: set missing parent rejected");
}

// D9: patch with invalid JSON pointer (no leading slash)
{
  const p = writeJson("d9.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "patch", path: p, operations: [
    { op: "add", path: "no_slash", value: 1 },
  ]}), "JSON Pointer", "D9: invalid pointer rejected");
}

// D10: directory path rejected
{
  assertThrows(() => jsonClient({ operation: "read", path: TMP }),
    "directory", "D10: directory path rejected");
}

// ═══════════════════════════════════════════════════════════════════════
// E — Error paths (10 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log("\nE — error paths");

// E1: get missing path without default throws
{
  const p = writeJson("e1.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "get", path: p, key_path: "b.c" }),
    "not found", "E1: get missing key throws");
}

// E2: delete missing key without ignore_missing throws
{
  const p = writeJson("e2.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "delete", path: p, key_path: "ghost" }),
    "not found", "E2: delete missing key");
}

// E3: set to file not found without create throws
assertThrows(() => jsonClient({ operation: "set", path: tmpPath("e3_missing.json"),
  key_path: "a", value: 1 }), "not found", "E3: set missing file");

// E4: merge from missing source file
{
  const p = writeJson("e4.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "merge", path: p, sources: [tmpPath("e4_missing.json")] }),
    "not found", "E4: merge missing source");
}

// E5: patch replace on missing path
{
  const p = writeJson("e5.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "patch", path: p, operations: [
    { op: "replace", path: "/missing", value: 99 },
  ]}), "does not exist", "E5: patch replace missing");
}

// E6: patch move from missing path
{
  const p = writeJson("e6.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "patch", path: p, operations: [
    { op: "move", from: "/ghost", path: "/dest" },
  ]}), "does not exist", "E6: patch move missing from");
}

// E7: patch unknown op
{
  const p = writeJson("e7.json", { a: 1 });
  assertThrows(() => jsonClient({ operation: "patch", path: p, operations: [
    { op: "explode", path: "/a" },
  ]}), "unknown op", "E7: patch unknown op");
}

// E8: keys on non-object/array value throws
{
  const p = writeJson("e8.json", { scalar: 42 });
  assertThrows(() => jsonClient({ operation: "keys", path: p, key_path: "scalar" }),
    "not an object or array", "E8: keys on scalar");
}

// E9: delete array out-of-bounds index
{
  const p = writeJson("e9.json", { arr: [1, 2] });
  assertThrows(() => jsonClient({ operation: "delete", path: p, key_path: "arr.5" }),
    "out of bounds", "E9: delete array OOB");
}

// E10: merge missing file without create throws
assertThrows(() => jsonClient({ operation: "merge", path: tmpPath("e10_missing.json"), data: { x: 1 } }),
  "not found", "E10: merge missing file");

// ═══════════════════════════════════════════════════════════════════════
// F — Concurrency (5 tests, async)
// ═══════════════════════════════════════════════════════════════════════
console.log("\nF — concurrency");

(async () => {

// F1: concurrent reads on same file
{
  const p = writeJson("f1.json", { val: 42 });
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => jsonClient({ operation: "get", path: p, key_path: "val" }))));
  assert(results.every(r => r.value === 42), "F1: concurrent reads consistent");
}

// F2: concurrent reads of different files
{
  const files = Array.from({ length: 5 }, (_, i) => writeJson(`f2-${i}.json`, { id: i }));
  const results = await Promise.all(
    files.map(p => Promise.resolve().then(() => jsonClient({ operation: "read", path: p }))));
  assert(results.every((r, i) => r.value.id === i), "F2: concurrent reads different files");
}

// F3: concurrent stringify calls (read-only, no writes)
{
  const p = writeJson("f3.json", { x: 1 });
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      Promise.resolve().then(() => jsonClient({ operation: "stringify", path: p }))));
  assert(results.every(r => r.content.includes('"x"')), "F3: concurrent stringify");
}

// F4: concurrent writes to different files
{
  const paths = Array.from({ length: 5 }, (_, i) => writeJson(`f4-${i}.json`, { count: 0 }));
  await Promise.all(
    paths.map((p, i) =>
      Promise.resolve().then(() => jsonClient({ operation: "set", path: p, key_path: "count", value: i * 10 }))));
  const values = paths.map(p => readJson(p).count);
  assert(values.every((v, i) => v === i * 10), "F4: concurrent writes to different files");
}

// F5: concurrent keys + get calls
{
  const p = writeJson("f5.json", { a: 1, b: 2, c: 3 });
  const results = await Promise.all([
    Promise.resolve().then(() => jsonClient({ operation: "keys", path: p })),
    Promise.resolve().then(() => jsonClient({ operation: "get",  path: p, key_path: "b" })),
    Promise.resolve().then(() => jsonClient({ operation: "keys", path: p })),
    Promise.resolve().then(() => jsonClient({ operation: "get",  path: p, key_path: "c" })),
  ]);
  assert(results[0].count === 3, "F5a: keys count");
  assert(results[1].value === 2,  "F5b: get b");
  assert(results[3].value === 3,  "F5c: get c");
}

// ── Cleanup ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

// ── Summary ─────────────────────────────────────────────────────────────────────
console.log(`\n\nSection 215: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
if (failed > 0) process.exit(1);

})();
