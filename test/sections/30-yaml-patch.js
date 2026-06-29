"use strict";
/**
 * test/sections/30-yaml-patch.js
 *
 * Isolated functional tests for the yaml_patch tool — Normal / Medium / High.
 * Critical and Extreme levels are in test/sections/30b-yaml-patch-de.js.
 *
 * Does NOT start the HTTP server or any MCP client.
 * All file I/O uses the shared TMP sandbox from test-harness.js.
 *
 * Section [33-A/B/C]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { yamlPatch }       = require("../../lib/yamlPatchOps");
const { serializeYaml }   = require("../../lib/yamlSerializeOps");
const { parseYaml }       = require("../../lib/yamlOps");

// ── Simple assertion helper ────────────────────────────────────────────────────
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Helper: write a temp YAML file and return its abs path ────────────────────
let _counter = 0;
function tmpYaml(content) {
  const p = path.join(TMP, `yp-${++_counter}.yaml`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ════════════════════════════════════════════════════════════════════════════
// [33-A] NORMAL — happy-path operations
// ════════════════════════════════════════════════════════════════════════════

test("[33-A-1] set: add a new top-level key", () => {
  const p = tmpYaml("name: Alice\nage: 30\n");
  const r = yamlPatch(p, "test.yaml", [{ op: "set", path: "city", value: "London" }]);
  assert(r.operationsApplied === 1, "operationsApplied should be 1");
  assert(r.apply === true, "apply should be true");
  assert(typeof r.originalSize === "number" && r.originalSize > 0, "originalSize should be > 0");
  assert(typeof r.newSize === "number" && r.newSize > 0, "newSize should be > 0");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.name === "Alice", "name should be Alice");
  assert(doc.city === "London", "city should be London");
});

test("[33-A-2] set: update an existing value", () => {
  const p = tmpYaml("version: 1\ndebug: false\n");
  yamlPatch(p, "test.yaml", [{ op: "set", path: "version", value: 2 }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.version === 2, "version should be updated to 2");
  assert(doc.debug === false, "debug should remain false");
});

test("[33-A-3] set: nested key path creates intermediate keys", () => {
  const p = tmpYaml("top:\n  a: 1\n");
  yamlPatch(p, "test.yaml", [{ op: "set", path: "top.b", value: 99 }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.top.a === 1, "top.a should still be 1");
  assert(doc.top.b === 99, "top.b should be 99");
});

test("[33-A-4] set: set value in a sequence item by index", () => {
  const p = tmpYaml("items:\n  - name: foo\n    val: 1\n  - name: bar\n    val: 2\n");
  yamlPatch(p, "test.yaml", [{ op: "set", path: "items.0.val", value: 42 }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.items[0].val === 42, "items[0].val should be 42");
  assert(doc.items[1].val === 2, "items[1].val should be 2");
});

test("[33-A-5] delete: remove a top-level key", () => {
  const p = tmpYaml("a: 1\nb: 2\nc: 3\n");
  yamlPatch(p, "test.yaml", [{ op: "delete", path: "b" }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(!Object.prototype.hasOwnProperty.call(doc, "b"), "key b should be deleted");
  assert(doc.a === 1, "a should remain");
  assert(doc.c === 3, "c should remain");
});

test("[33-A-6] delete: splice from a sequence by index", () => {
  const p = tmpYaml("list:\n  - alpha\n  - beta\n  - gamma\n");
  yamlPatch(p, "test.yaml", [{ op: "delete", path: "list.1" }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.list.length === 2, "list should have 2 items after splice");
  assert(doc.list[0] === "alpha", "first item should be alpha");
  assert(doc.list[1] === "gamma", "second item should be gamma");
});

test("[33-A-7] append_to: push item onto a sequence", () => {
  const p = tmpYaml("tags:\n  - v1\n  - v2\n");
  yamlPatch(p, "test.yaml", [{ op: "append_to", path: "tags", value: "v3" }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.tags.length === 3, "tags should have 3 items");
  assert(doc.tags[2] === "v3", "last tag should be v3");
});

test("[33-A-8] insert_at: insert into sequence at index 0", () => {
  const p = tmpYaml("items:\n  - b\n  - c\n");
  yamlPatch(p, "test.yaml", [{ op: "insert_at", path: "items", value: "a", index: 0 }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.items.length === 3, "items should have 3 elements");
  assert(doc.items[0] === "a", "first item should be a");
  assert(doc.items[1] === "b", "second item should be b");
});

test("[33-A-9] insert_at: insert at end (index === length)", () => {
  const p = tmpYaml("items:\n  - x\n  - y\n");
  yamlPatch(p, "test.yaml", [{ op: "insert_at", path: "items", value: "z", index: 2 }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.items[2] === "z", "last item should be z");
});

test("[33-A-10] dry-run: apply=false does not modify the file", () => {
  const src = "key: original\n";
  const p = tmpYaml(src);
  const r = yamlPatch(p, "test.yaml", [{ op: "set", path: "key", value: "mutated" }], { apply: false });
  assert(r.apply === false, "apply should be false");
  assert(r.result.key === "mutated", "result.key in return value should be mutated");
  const onDisk = fs.readFileSync(p, "utf8");
  assert(onDisk === src, "file on disk should be unchanged");
});

test("[33-A-11] multiple ops in one call — all applied atomically", () => {
  const p = tmpYaml("a: 1\nb: 2\ntags:\n  - x\n");
  const r = yamlPatch(p, "test.yaml", [
    { op: "set",       path: "a",    value: 10 },
    { op: "delete",    path: "b" },
    { op: "append_to", path: "tags", value: "y" },
  ]);
  assert(r.operationsApplied === 3, "operationsApplied should be 3");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.a === 10, "a should be 10");
  assert(!("b" in doc), "b should be deleted");
  assert(doc.tags[1] === "y", "tags[1] should be y");
});

test("[33-A-12] result object has all required fields", () => {
  const p = tmpYaml("x: 1\n");
  const r = yamlPatch(p, "result-fields.yaml", [{ op: "set", path: "x", value: 2 }]);
  assert(r.path === "result-fields.yaml", "path should echo client path");
  assert(typeof r.operationsApplied === "number", "operationsApplied should be number");
  assert(typeof r.apply === "boolean", "apply should be boolean");
  assert(typeof r.originalSize === "number", "originalSize should be number");
  assert(typeof r.newSize === "number", "newSize should be number");
  assert(typeof r.result === "object", "result should be object");
});

// ════════════════════════════════════════════════════════════════════════════
// [33-B] MEDIUM — boundary/parameter validation
// ════════════════════════════════════════════════════════════════════════════

test("[33-B-1] missing ops field → -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", []); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602 for empty ops");
  }
  assert(threw, "should have thrown");
});

test("[33-B-2] non-array ops → -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", "set"); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602");
  }
  assert(threw, "should have thrown");
});

test("[33-B-3] unknown op → -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "upsert", path: "a" }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602 for unknown op");
    assert(/upsert/i.test(e.message), "message should mention the bad op name");
  }
  assert(threw, "should have thrown");
});

test("[33-B-4] non-string path in op → -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "set", path: 99, value: 1 }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602");
  }
  assert(threw, "should have thrown");
});

test("[33-B-5] set without value field → -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "set", path: "a" }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602 for missing value");
  }
  assert(threw, "should have thrown");
});

test("[33-B-6] set with empty path → -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "set", path: "", value: 2 }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602 for empty path on set");
  }
  assert(threw, "should have thrown");
});

test("[33-B-7] delete non-existent key → -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "delete", path: "nonexistent" }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602");
  }
  assert(threw, "should have thrown");
});

test("[33-B-8] insert_at out of bounds → -32602", () => {
  const p = tmpYaml("items:\n  - a\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "insert_at", path: "items", value: "x", index: 5 }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602 for out-of-bounds insert");
  }
  assert(threw, "should have thrown");
});

test("[33-B-9] insert_at on non-array → -32602", () => {
  const p = tmpYaml("a: hello\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "insert_at", path: "a", value: "x", index: 0 }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602 for non-array");
  }
  assert(threw, "should have thrown");
});

test("[33-B-10] append_to on non-array → -32602", () => {
  const p = tmpYaml("a: 5\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "append_to", path: "a", value: "x" }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602 for non-array");
  }
  assert(threw, "should have thrown");
});

test("[33-B-11] insert_at with non-integer index → -32602", () => {
  const p = tmpYaml("items:\n  - a\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "insert_at", path: "items", value: "x", index: 1.5 }]); } catch (e) {
    threw = true;
    assert(e.code === -32602, "should be -32602 for non-integer index");
  }
  assert(threw, "should have thrown");
});

test("[33-B-12] file does not exist → throws", () => {
  let threw = false;
  try { yamlPatch(path.join(TMP, "nonexistent-99999.yaml"), "bad.yaml", [{ op: "set", path: "a", value: 1 }]); }
  catch (e) { threw = true; }
  assert(threw, "should throw for nonexistent file");
});

test("[33-B-13] invalid YAML file → throws descriptive error", () => {
  const p = tmpYaml("key: {\ninvalid yaml [[\n");
  let threw = false;
  try { yamlPatch(p, "bad.yaml", [{ op: "set", path: "key", value: 1 }]); } catch (e) {
    threw = true;
    assert(/yaml/i.test(e.message), "error message should mention yaml");
  }
  assert(threw, "should throw for invalid YAML");
});

// ════════════════════════════════════════════════════════════════════════════
// [33-C] HIGH — complex / integration scenarios
// ════════════════════════════════════════════════════════════════════════════

test("[33-C-1] set: deeply nested auto-create (3 levels deep)", () => {
  const p = tmpYaml("top: {}\n");
  yamlPatch(p, "t.yaml", [{ op: "set", path: "top.a.b.c", value: "deep" }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.top.a.b.c === "deep", "deep path should be created and set");
});

test("[33-C-2] set: object value round-trips correctly", () => {
  const p = tmpYaml("config:\n  port: 80\n");
  yamlPatch(p, "t.yaml", [{ op: "set", path: "config", value: { port: 443, ssl: true } }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.config.port === 443, "port should be 443");
  assert(doc.config.ssl === true, "ssl should be true");
});

test("[33-C-3] set: array value round-trips correctly", () => {
  const p = tmpYaml("x: 1\n");
  yamlPatch(p, "t.yaml", [{ op: "set", path: "tags", value: ["a", "b", "c"] }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(Array.isArray(doc.tags), "tags should be an array");
  assert(doc.tags.length === 3, "tags should have 3 items");
  assert(doc.tags[1] === "b", "second tag should be b");
});

test("[33-C-4] set: null value written as YAML null", () => {
  const p = tmpYaml("optional: present\n");
  yamlPatch(p, "t.yaml", [{ op: "set", path: "optional", value: null }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.optional === null, "value should be null");
});

test("[33-C-5] append_to: add object to sequence of objects", () => {
  const p = tmpYaml("users:\n  - name: Alice\n    role: admin\n");
  yamlPatch(p, "t.yaml", [{ op: "append_to", path: "users", value: { name: "Bob", role: "user" } }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.users.length === 2, "should have 2 users");
  assert(doc.users[1].name === "Bob", "second user should be Bob");
  assert(doc.users[1].role === "user", "Bob's role should be user");
});

test("[33-C-6] insert_at middle of sequence preserves order", () => {
  const p = tmpYaml("ports:\n  - 80\n  - 443\n  - 8080\n");
  yamlPatch(p, "t.yaml", [{ op: "insert_at", path: "ports", value: 8443, index: 2 }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.ports.length === 4, "should have 4 ports");
  assert(doc.ports[2] === 8443, "8443 should be at index 2");
  assert(doc.ports[3] === 8080, "8080 should shift to index 3");
});

test("[33-C-7] serializer: booleans and null round-trip correctly", () => {
  const doc = { enabled: true, disabled: false, nothing: null };
  const yaml = serializeYaml(doc);
  const back = parseYaml(yaml);
  assert(back.enabled === true, "enabled should be true");
  assert(back.disabled === false, "disabled should be false");
  assert(back.nothing === null, "nothing should be null");
});

test("[33-C-8] serializer: integers and floats round-trip correctly", () => {
  const doc = { count: 42, ratio: 3.14 };
  const yaml = serializeYaml(doc);
  const back = parseYaml(yaml);
  assert(back.count === 42, "count should be 42");
  assert(Math.abs(back.ratio - 3.14) < 1e-9, "ratio should be ~3.14");
});

test("[33-C-9] serializer: special string values are quoted", () => {
  const doc = { flag: "true", noop: "null", num: "42" };
  const yaml = serializeYaml(doc);
  const back = parseYaml(yaml);
  assert(back.flag === "true", "flag should be string 'true'");
  assert(back.noop === "null", "noop should be string 'null'");
  assert(back.num === "42", "num should be string '42'");
});

test("[33-C-10] empty document (null) treated as empty mapping for mutation", () => {
  const p = tmpYaml("");
  yamlPatch(p, "t.yaml", [{ op: "set", path: "key", value: "hello" }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.key === "hello", "should set key in previously-empty doc");
});
