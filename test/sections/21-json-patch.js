"use strict";
/**
 * Section [25-A/B] — json_patch tool tests: Normal + Medium
 *
 * Tests RFC 6902 JSON Patch operations (add, remove, replace, move, copy, test)
 * applied via the isolated jsonPatch() function and via the full executeTool()
 * dispatcher.
 *
 * Rigor levels covered here:
 *   Normal   — happy-path: every op type, dry-run mode, indent preservation
 *   Medium   — boundary & param validation: missing fields, bad op name, empty ops
 *
 * High/Critical/Extreme levels live in 22-json-patch-hce.js.
 */

const fs   = require("fs");
const path = require("path");

const { test, counters, TMP } = require("../test-harness");
const { jsonPatch } = require("../../lib/jsonPatchOps");
const { executeTool } = require("../../lib/executeTool");

// ── shared sandbox helpers ─────────────────────────────────────────────────────
function writeTmp(name, obj) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return p;
}
function readTmp(name) {
  return JSON.parse(fs.readFileSync(path.join(TMP, name), "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// [25-A] NORMAL — happy-path tests
// ─────────────────────────────────────────────────────────────────────────────

test("[25-A-1] add: insert new key into object", () => {
  const p = writeTmp("patch-add-key.json", { a: 1 });
  const r = jsonPatch(p, "patch-add-key.json", [{ op: "add", path: "/b", value: 2 }]);
  if (r.opsApplied !== 1) throw new Error(`opsApplied=${r.opsApplied}`);
  const doc = readTmp("patch-add-key.json");
  if (doc.b !== 2) throw new Error("key not added");
});

test("[25-A-2] add: append to array via '-' token", () => {
  const p = writeTmp("patch-add-arr.json", { items: [1, 2, 3] });
  jsonPatch(p, "patch-add-arr.json", [{ op: "add", path: "/items/-", value: 4 }]);
  const doc = readTmp("patch-add-arr.json");
  if (doc.items[3] !== 4) throw new Error(`items=${JSON.stringify(doc.items)}`);
});

test("[25-A-3] add: insert into array at index 0", () => {
  const p = writeTmp("patch-arr-insert.json", { arr: [10, 20] });
  jsonPatch(p, "patch-arr-insert.json", [{ op: "add", path: "/arr/0", value: 5 }]);
  const doc = readTmp("patch-arr-insert.json");
  if (doc.arr[0] !== 5 || doc.arr[1] !== 10) throw new Error(JSON.stringify(doc.arr));
});

test("[25-A-4] remove: delete a key from object", () => {
  const p = writeTmp("patch-remove.json", { a: 1, b: 2 });
  jsonPatch(p, "patch-remove.json", [{ op: "remove", path: "/a" }]);
  const doc = readTmp("patch-remove.json");
  if ("a" in doc) throw new Error("key not removed");
  if (doc.b !== 2) throw new Error("b changed");
});

test("[25-A-5] remove: delete element from array", () => {
  const p = writeTmp("patch-remove-arr.json", { list: ["x", "y", "z"] });
  jsonPatch(p, "patch-remove-arr.json", [{ op: "remove", path: "/list/1" }]);
  const doc = readTmp("patch-remove-arr.json");
  if (doc.list.length !== 2 || doc.list[1] !== "z") throw new Error(JSON.stringify(doc.list));
});

test("[25-A-6] replace: update existing value", () => {
  const p = writeTmp("patch-replace.json", { version: "1.0.0" });
  jsonPatch(p, "patch-replace.json", [{ op: "replace", path: "/version", value: "2.0.0" }]);
  const doc = readTmp("patch-replace.json");
  if (doc.version !== "2.0.0") throw new Error(doc.version);
});

test("[25-A-7] move: rename a key", () => {
  const p = writeTmp("patch-move.json", { old_name: "hello" });
  jsonPatch(p, "patch-move.json", [{ op: "move", from: "/old_name", path: "/new_name" }]);
  const doc = readTmp("patch-move.json");
  if ("old_name" in doc) throw new Error("old_name still present");
  if (doc.new_name !== "hello") throw new Error("new_name wrong");
});

test("[25-A-8] copy: duplicate a value", () => {
  const p = writeTmp("patch-copy.json", { src: { x: 99 } });
  jsonPatch(p, "patch-copy.json", [{ op: "copy", from: "/src", path: "/dst" }]);
  const doc = readTmp("patch-copy.json");
  if (doc.dst.x !== 99) throw new Error("dst wrong");
  if (!doc.src) throw new Error("src destroyed");
});

test("[25-A-9] test op: passes when values match", () => {
  const p = writeTmp("patch-test-ok.json", { status: "active" });
  const r = jsonPatch(p, "patch-test-ok.json", [
    { op: "test", path: "/status", value: "active" },
    { op: "replace", path: "/status", value: "inactive" },
  ]);
  if (r.opsApplied !== 2) throw new Error(`opsApplied=${r.opsApplied}`);
  const doc = readTmp("patch-test-ok.json");
  if (doc.status !== "inactive") throw new Error("replace after test failed");
});

test("[25-A-10] dry-run (apply=false) returns patched doc without writing", () => {
  const orig = { count: 0 };
  const p = writeTmp("patch-dryrun.json", orig);
  const r = jsonPatch(p, "patch-dryrun.json", [{ op: "replace", path: "/count", value: 999 }], { apply: false });
  if (r.apply !== false) throw new Error("apply flag wrong");
  if (r.result.count !== 999) throw new Error("result not patched");
  const ondisk = readTmp("patch-dryrun.json");
  if (ondisk.count !== 0) throw new Error("file was mutated despite apply:false");
});

test("[25-A-11] multiple ops applied atomically in order", () => {
  const p = writeTmp("patch-multi.json", { a: 1, b: 2, c: 3 });
  jsonPatch(p, "patch-multi.json", [
    { op: "remove", path: "/b" },
    { op: "add",    path: "/d", value: 4 },
    { op: "replace", path: "/a", value: 10 },
  ]);
  const doc = readTmp("patch-multi.json");
  if ("b" in doc)  throw new Error("b not removed");
  if (doc.d !== 4) throw new Error("d not added");
  if (doc.a !== 10) throw new Error("a not replaced");
});

test("[25-A-12] indent preserved (4 spaces)", () => {
  const p = path.join(TMP, "patch-indent4.json");
  fs.writeFileSync(p, '{\n    "x": 1\n}\n', "utf8");
  jsonPatch(p, "patch-indent4.json", [{ op: "add", path: "/y", value: 2 }]);
  const raw = fs.readFileSync(p, "utf8");
  if (!raw.includes('    "y"')) throw new Error("indent not preserved:\n" + raw);
});

test("[25-A-13] result.path echoes original client path", () => {
  const p = writeTmp("patch-echo.json", {});
  const r = jsonPatch(p, "some/client/path.json", [{ op: "add", path: "/k", value: 1 }]);
  if (r.path !== "some/client/path.json") throw new Error(`r.path=${r.path}`);
});

test("[25-A-14] result contains originalSize and newSize", () => {
  const p = writeTmp("patch-sizes.json", { a: 1 });
  const r = jsonPatch(p, "patch-sizes.json", [{ op: "add", path: "/b", value: 2 }]);
  if (typeof r.originalSize !== "number" || r.originalSize <= 0) throw new Error("bad originalSize");
  if (typeof r.newSize !== "number" || r.newSize <= 0) throw new Error("bad newSize");
});

test("[25-A-15] JSON Pointer ~0 and ~1 escape sequences", () => {
  const p = writeTmp("patch-escape.json", { "a/b": { "c~d": 1 } });
  const r = jsonPatch(p, "patch-escape.json", [
    { op: "replace", path: "/a~1b/c~0d", value: 99 },
  ]);
  if (r.opsApplied !== 1) throw new Error("op not applied");
  const doc = readTmp("patch-escape.json");
  if (doc["a/b"]["c~d"] !== 99) throw new Error("escape not resolved");
});

test("[25-A-16] executeTool dispatcher routes json_patch correctly", () => {
  const p = writeTmp("patch-dispatch.json", { name: "Alice" });
  const r = executeTool("json_patch", { path: "patch-dispatch.json", ops: [{ op: "replace", path: "/name", value: "Bob" }] });
  if (r.opsApplied !== 1) throw new Error(`opsApplied=${r.opsApplied}`);
  const doc = readTmp("patch-dispatch.json");
  if (doc.name !== "Bob") throw new Error("name not patched via executeTool");
});

test("[25-A-17] copy op creates deep clone (mutating copy does not affect source)", () => {
  const p = writeTmp("patch-copy-clone.json", { arr: [1, 2, 3] });
  jsonPatch(p, "patch-copy-clone.json", [{ op: "copy", from: "/arr", path: "/arr2" }]);
  const doc = readTmp("patch-copy-clone.json");
  const p2 = writeTmp("patch-copy-clone2.json", doc);
  jsonPatch(p2, "patch-copy-clone2.json", [{ op: "add", path: "/arr2/-", value: 99 }]);
  const doc2 = readTmp("patch-copy-clone2.json");
  if (doc2.arr.length !== 3)  throw new Error("source arr mutated");
  if (doc2.arr2.length !== 4) throw new Error("arr2 not extended");
});

// ─────────────────────────────────────────────────────────────────────────────
// [25-B] MEDIUM — boundary & parameter validation
// ─────────────────────────────────────────────────────────────────────────────

test("[25-B-1] empty ops array throws -32602", () => {
  const p = writeTmp("patch-empty-ops.json", {});
  try {
    jsonPatch(p, "patch-empty-ops.json", []);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("non-empty")) throw new Error(`wrong msg: ${e.message}`);
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
  }
});

test("[25-B-2] ops is not an array throws -32602", () => {
  const p = writeTmp("patch-bad-ops-type.json", {});
  try {
    jsonPatch(p, "patch-bad-ops-type.json", "add /x 1");
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
  }
});

test("[25-B-3] unknown op name throws -32602", () => {
  const p = writeTmp("patch-bad-op.json", {});
  try {
    jsonPatch(p, "patch-bad-op.json", [{ op: "upsert", path: "/x", value: 1 }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
    if (!e.message.includes("unknown op")) throw new Error(`msg: ${e.message}`);
  }
});

test("[25-B-4] op missing 'path' field throws -32602", () => {
  const p = writeTmp("patch-no-path.json", {});
  try {
    jsonPatch(p, "patch-no-path.json", [{ op: "add", value: 1 }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
  }
});

test("[25-B-5] add without value throws -32602", () => {
  const p = writeTmp("patch-add-novalue.json", {});
  try {
    jsonPatch(p, "patch-add-novalue.json", [{ op: "add", path: "/x" }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
  }
});

test("[25-B-6] replace without value throws -32602", () => {
  const p = writeTmp("patch-replace-novalue.json", { x: 1 });
  try {
    jsonPatch(p, "patch-replace-novalue.json", [{ op: "replace", path: "/x" }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
  }
});

test("[25-B-7] move without 'from' throws -32602", () => {
  const p = writeTmp("patch-move-nofrom.json", { a: 1 });
  try {
    jsonPatch(p, "patch-move-nofrom.json", [{ op: "move", path: "/b" }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
  }
});

test("[25-B-8] replace on non-existent path throws descriptive error", () => {
  const p = writeTmp("patch-replace-notfound.json", { a: 1 });
  try {
    jsonPatch(p, "patch-replace-notfound.json", [{ op: "replace", path: "/z", value: 99 }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.toLowerCase().includes("not found") && !e.message.toLowerCase().includes("pointer"))
      throw new Error(`unexpected msg: ${e.message}`);
  }
});

test("[25-B-9] remove non-existent key throws descriptive error", () => {
  const p = writeTmp("patch-remove-notfound.json", { a: 1 });
  try {
    jsonPatch(p, "patch-remove-notfound.json", [{ op: "remove", path: "/z" }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.toLowerCase().includes("not found") && !e.message.toLowerCase().includes("key"))
      throw new Error(`unexpected msg: ${e.message}`);
  }
});

test("[25-B-10] executeTool validateArgs: missing path throws -32602", () => {
  try {
    executeTool("json_patch", { ops: [{ op: "add", path: "/x", value: 1 }] });
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
    if (!e.message.includes("path")) throw new Error(`msg: ${e.message}`);
  }
});

test("[25-B-11] executeTool validateArgs: missing ops throws -32602", () => {
  try {
    executeTool("json_patch", { path: "some.json" });
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
    if (!e.message.includes("ops")) throw new Error(`msg: ${e.message}`);
  }
});

test("[25-B-12] invalid JSON file throws descriptive error", () => {
  const p = path.join(TMP, "patch-malformed.json");
  fs.writeFileSync(p, "{ not valid json }", "utf8");
  try {
    jsonPatch(p, "patch-malformed.json", [{ op: "add", path: "/x", value: 1 }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("not valid JSON")) throw new Error(`msg: ${e.message}`);
  }
});

test("[25-B-13] pointer not starting with '/' throws descriptive error", () => {
  const p = writeTmp("patch-badptr.json", { a: 1 });
  try {
    jsonPatch(p, "patch-badptr.json", [{ op: "replace", path: "a", value: 2 }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("JSON Pointer must start with '/'"))
      throw new Error(`msg: ${e.message}`);
  }
});

test("[25-B-14] array index out of bounds throws descriptive error", () => {
  const p = writeTmp("patch-oob.json", { arr: [1, 2] });
  try {
    jsonPatch(p, "patch-oob.json", [{ op: "remove", path: "/arr/5" }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.toLowerCase().includes("out of bounds") && !e.message.toLowerCase().includes("index"))
      throw new Error(`msg: ${e.message}`);
  }
});
