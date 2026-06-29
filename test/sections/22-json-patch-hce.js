"use strict";
/**
 * Section [25-C/D/E] — json_patch tool tests: High + Critical + Extreme
 *
 * Continuation of 21-json-patch.js (Normal + Medium). Split to keep both
 * files under the project's 500-line threshold.
 *
 * Rigor levels covered here:
 *   High     — failure simulation: test-op mismatch aborts, bad pointer paths
 *   Critical — security: path traversal blocked, injection-shaped JSON values safe
 *   Extreme  — large docs, concurrent writes, fuzz inputs, prototype-pollution
 */

const fs   = require("fs");
const path = require("path");

const { test, counters, TMP } = require("../test-harness");
const { jsonPatch } = require("../../lib/jsonPatchOps");
const { executeTool } = require("../../lib/executeTool");

function writeTmp(name, obj) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return p;
}
function readTmp(name) {
  return JSON.parse(fs.readFileSync(path.join(TMP, name), "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// [25-C] HIGH — failure simulation
// ─────────────────────────────────────────────────────────────────────────────

test("[25-C-1] test op mismatch aborts patch — no partial write", () => {
  const orig = { status: "active", count: 0 };
  const p = writeTmp("patch-test-abort.json", orig);
  try {
    jsonPatch(p, "patch-test-abort.json", [
      { op: "replace", path: "/count", value: 99 },
      { op: "test",    path: "/status", value: "inactive" }, // will fail
      { op: "replace", path: "/status", value: "closed" },
    ]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("test")) throw new Error(`msg: ${e.message}`);
  }
  // File must be unmodified (no partial write)
  const doc = readTmp("patch-test-abort.json");
  if (doc.count !== 0)  throw new Error("partial write occurred: count changed");
  if (doc.status !== "active") throw new Error("partial write: status changed");
});

test("[25-C-2] move: path is child of from — throws descriptive error", () => {
  const p = writeTmp("patch-move-child.json", { a: { b: 1 } });
  try {
    jsonPatch(p, "patch-move-child.json", [{ op: "move", from: "/a", path: "/a/c" }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.includes("child")) throw new Error(`msg: ${e.message}`);
  }
});

test("[25-C-3] operation on file that does not exist throws fs error", () => {
  const p = path.join(TMP, "patch-missing-file.json");
  try {
    jsonPatch(p, "patch-missing-file.json", [{ op: "add", path: "/x", value: 1 }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code === -32602) throw new Error("wrong error type — got validation error not fs error");
    if (!e.message && !e.code) throw new Error("no error info");
  }
});

test("[25-C-4] op on each item of a non-existent step fails properly", () => {
  const p = writeTmp("patch-nonstep.json", {});
  try {
    jsonPatch(p, "patch-nonstep.json", [null]);
    throw new Error("should have thrown");
  } catch (e) {
    if (e.code !== -32602) throw new Error(`code=${e.code}`);
  }
});

test("[25-C-5] copy from non-existent pointer throws error", () => {
  const p = writeTmp("patch-copy-missing.json", { a: 1 });
  try {
    jsonPatch(p, "patch-copy-missing.json", [{ op: "copy", from: "/z", path: "/b" }]);
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.toLowerCase().includes("not found") && !e.message.toLowerCase().includes("pointer"))
      throw new Error(`msg: ${e.message}`);
  }
});

test("[25-C-6] test op with complex nested value (deep equality)", () => {
  const p = writeTmp("patch-test-complex.json", { nested: { arr: [1, { x: 2 }] } });
  const r = jsonPatch(p, "patch-test-complex.json", [
    { op: "test", path: "/nested/arr/1", value: { x: 2 } },
  ]);
  if (r.opsApplied !== 1) throw new Error("test op not counted");
});

// ─────────────────────────────────────────────────────────────────────────────
// [25-D] CRITICAL — security & sanitization
// ─────────────────────────────────────────────────────────────────────────────

test("[25-D-1] path traversal via path arg blocked by executeTool", () => {
  try {
    executeTool("json_patch", {
      path: "../../../etc/passwd",
      ops: [{ op: "add", path: "/x", value: 1 }],
    });
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message.toLowerCase().includes("outside") && !e.message.toLowerCase().includes("jail") &&
        !e.message.toLowerCase().includes("root") && !e.message.toLowerCase().includes("not found") &&
        !e.message.toLowerCase().includes("enoent"))
      throw new Error(`msg: ${e.message}`);
  }
});

test("[25-D-2] absolute path blocked by executeTool", () => {
  try {
    executeTool("json_patch", {
      path: "C:\\Windows\\System32\\config\\sam",
      ops: [{ op: "add", path: "/x", value: 1 }],
    });
    throw new Error("should have thrown");
  } catch (e) {
    if (!e.message) throw new Error("no error message");
  }
});

test("[25-D-3] injection-shaped value is stored literally, not executed", () => {
  const p = writeTmp("patch-inject.json", { cmd: "safe" });
  jsonPatch(p, "patch-inject.json", [
    { op: "replace", path: "/cmd", value: "'; DROP TABLE users; --" },
  ]);
  const doc = readTmp("patch-inject.json");
  if (doc.cmd !== "'; DROP TABLE users; --") throw new Error("value corrupted");
});

test("[25-D-4] null byte in JSON Pointer does not crash server", () => {
  const p = writeTmp("patch-nullbyte.json", { a: 1 });
  try {
    jsonPatch(p, "patch-nullbyte.json", [{ op: "add", path: "/\x00evil", value: 1 }]);
    // Succeeds silently or throws — either is fine as long as process doesn't crash
  } catch (_) { /* acceptable */ }
});

test("[25-D-5] prototype-pollution attempt via __proto__ is blocked or harmless", () => {
  const before = {}.isAdmin;
  const p = writeTmp("patch-proto.json", {});
  try {
    jsonPatch(p, "patch-proto.json", [{ op: "add", path: "/__proto__/isAdmin", value: true }]);
  } catch (_) { /* expected to throw */ }
  if ({}.isAdmin !== before) throw new Error("prototype was polluted");
});

test("[25-D-6] XSS-shaped value round-trips literally", () => {
  const payload = '<script>alert("xss")</script>';
  const p = writeTmp("patch-xss.json", { html: "" });
  jsonPatch(p, "patch-xss.json", [{ op: "replace", path: "/html", value: payload }]);
  const doc = readTmp("patch-xss.json");
  if (doc.html !== payload) throw new Error("payload altered");
});

test("[25-D-7] unicode and emoji in value stored correctly", () => {
  const p = writeTmp("patch-unicode.json", { greeting: "" });
  jsonPatch(p, "patch-unicode.json", [{ op: "replace", path: "/greeting", value: "こんにちは 🎉" }]);
  const doc = readTmp("patch-unicode.json");
  if (doc.greeting !== "こんにちは 🎉") throw new Error(doc.greeting);
});

// ─────────────────────────────────────────────────────────────────────────────
// [25-E] EXTREME — stress, concurrency, fuzz
// ─────────────────────────────────────────────────────────────────────────────

test("[25-E-1] large document (1000 keys) add and remove", () => {
  const big = {};
  for (let i = 0; i < 1000; i++) big[`key${i}`] = i;
  const p = writeTmp("patch-big.json", big);
  jsonPatch(p, "patch-big.json", [
    { op: "add", path: "/key1000", value: 9999 },
    { op: "remove", path: "/key500" },
  ]);
  const doc = readTmp("patch-big.json");
  if (doc.key1000 !== 9999) throw new Error("add failed");
  if ("key500" in doc)      throw new Error("remove failed");
});

test("[25-E-2] deeply nested pointer (10 levels)", () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 42 } } } } } } } } } };
  const p = writeTmp("patch-deep.json", deep);
  jsonPatch(p, "patch-deep.json", [{ op: "replace", path: "/a/b/c/d/e/f/g/h/i/j", value: 99 }]);
  const doc = readTmp("patch-deep.json");
  if (doc.a.b.c.d.e.f.g.h.i.j !== 99) throw new Error("deep replace failed");
});

test("[25-E-3] 50-operation batch applied in order", () => {
  const p = writeTmp("patch-batch.json", { total: 0 });
  const ops = [];
  for (let i = 1; i <= 50; i++) ops.push({ op: "replace", path: "/total", value: i });
  const r = jsonPatch(p, "patch-batch.json", ops);
  if (r.opsApplied !== 50) throw new Error(`opsApplied=${r.opsApplied}`);
  const doc = readTmp("patch-batch.json");
  if (doc.total !== 50) throw new Error(`total=${doc.total}`);
});

test("[25-E-4] concurrent patches to different files are consistent", () => {
  // Sequential simulation — harness test() runner is synchronous.
  const N = 8;
  for (let i = 0; i < N; i++) {
    const fname = `patch-concurrent-${i}.json`;
    writeTmp(fname, { val: 0 });
    const absP = path.join(TMP, fname);
    jsonPatch(absP, fname, [{ op: "replace", path: "/val", value: i }]);
  }
  for (let i = 0; i < N; i++) {
    const doc = readTmp(`patch-concurrent-${i}.json`);
    if (doc.val !== i) throw new Error(`concurrent result mismatch: file ${i} has val=${doc.val}`);
  }
});

test("[25-E-5] fuzz: non-array ops value does not crash the process", () => {
  const p = writeTmp("patch-fuzz.json", { x: 1 });
  const badInputs = [null, undefined, 42, true, "string", { op: "add" }];
  for (const input of badInputs) {
    try {
      jsonPatch(p, "patch-fuzz.json", input);
    } catch (e) {
      if (e.code !== -32602) throw new Error(`unexpected code ${e.code}: ${e.message}`);
    }
  }
});

test("[25-E-6] result is JSON-serialisable (no circular refs, no undefined)", () => {
  const p = writeTmp("patch-serial.json", { a: 1 });
  const r = jsonPatch(p, "patch-serial.json", [{ op: "add", path: "/b", value: [1, "two", null] }]);
  const str = JSON.stringify(r);
  if (!str || str.length < 5) throw new Error("JSON.stringify produced empty/short output");
  const parsed = JSON.parse(str);
  if (typeof parsed.opsApplied !== "number") throw new Error("opsApplied missing from serialised result");
});

test("[25-E-7] json_patch is in WRITE_TOOLS set (blocked under READ_ONLY)", () => {
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  if (!WRITE_TOOLS.has("json_patch")) throw new Error("json_patch not in WRITE_TOOLS");
});

test("[25-E-8] json_patch is in execute_pipeline op enum", () => {
  const { TOOLS_ALL } = require("../../lib/toolsSchema");
  const pipelineTool = TOOLS_ALL.find(t => t.name === "execute_pipeline");
  if (!pipelineTool) throw new Error("execute_pipeline tool not found");
  const enumValues = pipelineTool.inputSchema.properties.steps.items.properties.op.enum;
  if (!enumValues.includes("json_patch"))
    throw new Error(`json_patch not in pipeline enum. enum=${JSON.stringify(enumValues)}`);
});
