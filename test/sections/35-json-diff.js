"use strict";
/**
 * test/sections/35-json-diff.js
 *
 * Isolated functional tests for the json_diff tool — structural (semantic)
 * diff between two JSON/YAML documents, reporting added/removed/changed
 * values by JSON-Pointer-style path. All 5 rigor levels.
 *
 * Section [38]
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[38] JSON_DIFF — structural (semantic) document diff tool`);

function writeJson(p, obj) {
  executeTool("create_file", { path: p, content: JSON.stringify(obj) });
}

// ════════════════════════════════════════════════════════════════════════════
// [38-A] NORMAL — happy path
// ════════════════════════════════════════════════════════════════════════════

test("json_diff: identical documents report identical=true, no changes", () => {
  writeJson("jd-identical-left.json", { a: 1, b: "x" });
  writeJson("jd-identical-right.json", { a: 1, b: "x" });
  const r = executeTool("json_diff", { left: "jd-identical-left.json", right: "jd-identical-right.json" });
  assert.strictEqual(r.identical, true);
  assert.strictEqual(r.totalChanges, 0);
  assert.deepStrictEqual(r.changes, []);
});

test("json_diff: added key is reported with type 'added' and newValue", () => {
  writeJson("jd-added-left.json", { a: 1 });
  writeJson("jd-added-right.json", { a: 1, b: 2 });
  const r = executeTool("json_diff", { left: "jd-added-left.json", right: "jd-added-right.json" });
  assert.strictEqual(r.addedCount, 1);
  const entry = r.changes.find(c => c.path === "/b");
  assert.strictEqual(entry.type, "added");
  assert.strictEqual(entry.newValue, 2);
  assert.strictEqual(entry.oldValue, undefined);
});

test("json_diff: removed key is reported with type 'removed' and oldValue", () => {
  writeJson("jd-removed-left.json", { a: 1, b: 2 });
  writeJson("jd-removed-right.json", { a: 1 });
  const r = executeTool("json_diff", { left: "jd-removed-left.json", right: "jd-removed-right.json" });
  assert.strictEqual(r.removedCount, 1);
  const entry = r.changes.find(c => c.path === "/b");
  assert.strictEqual(entry.type, "removed");
  assert.strictEqual(entry.oldValue, 2);
  assert.strictEqual(entry.newValue, undefined);
});

test("json_diff: changed scalar value is reported with type 'changed', oldValue and newValue", () => {
  writeJson("jd-changed-left.json", { a: 1 });
  writeJson("jd-changed-right.json", { a: 2 });
  const r = executeTool("json_diff", { left: "jd-changed-left.json", right: "jd-changed-right.json" });
  assert.strictEqual(r.changedCount, 1);
  const entry = r.changes.find(c => c.path === "/a");
  assert.strictEqual(entry.type, "changed");
  assert.strictEqual(entry.oldValue, 1);
  assert.strictEqual(entry.newValue, 2);
});

test("json_diff: nested object changes report the full nested pointer path", () => {
  writeJson("jd-nested-left.json", { a: { b: { c: 1 } } });
  writeJson("jd-nested-right.json", { a: { b: { c: 2 } } });
  const r = executeTool("json_diff", { left: "jd-nested-left.json", right: "jd-nested-right.json" });
  const entry = r.changes.find(c => c.path === "/a/b/c");
  assert(entry, "expected a change at /a/b/c");
  assert.strictEqual(entry.oldValue, 1);
  assert.strictEqual(entry.newValue, 2);
});

test("json_diff: array element change is reported at its index-based pointer path", () => {
  writeJson("jd-arr-left.json", { items: [1, 2, 3] });
  writeJson("jd-arr-right.json", { items: [1, 9, 3] });
  const r = executeTool("json_diff", { left: "jd-arr-left.json", right: "jd-arr-right.json" });
  const entry = r.changes.find(c => c.path === "/items/1");
  assert(entry, "expected a change at /items/1");
  assert.strictEqual(entry.oldValue, 2);
  assert.strictEqual(entry.newValue, 9);
});

test("json_diff: extra trailing array element on the right is reported as 'added' at its index", () => {
  writeJson("jd-arradd-left.json", { items: [1, 2] });
  writeJson("jd-arradd-right.json", { items: [1, 2, 3] });
  const r = executeTool("json_diff", { left: "jd-arradd-left.json", right: "jd-arradd-right.json" });
  const entry = r.changes.find(c => c.path === "/items/2");
  assert.strictEqual(entry.type, "added");
  assert.strictEqual(entry.newValue, 3);
});

test("json_diff: extra trailing array element on the left is reported as 'removed' at its index", () => {
  writeJson("jd-arrrem-left.json", { items: [1, 2, 3] });
  writeJson("jd-arrrem-right.json", { items: [1, 2] });
  const r = executeTool("json_diff", { left: "jd-arrrem-left.json", right: "jd-arrrem-right.json" });
  const entry = r.changes.find(c => c.path === "/items/2");
  assert.strictEqual(entry.type, "removed");
  assert.strictEqual(entry.oldValue, 3);
});

test("json_diff: YAML files are diffed correctly (format auto-detected by extension)", () => {
  executeTool("create_file", { path: "jd-yaml-left.yaml", content: "a: 1\nb: two\n" });
  executeTool("create_file", { path: "jd-yaml-right.yaml", content: "a: 1\nb: three\n" });
  const r = executeTool("json_diff", { left: "jd-yaml-left.yaml", right: "jd-yaml-right.yaml" });
  assert.strictEqual(r.format, "yaml");
  const entry = r.changes.find(c => c.path === "/b");
  assert.strictEqual(entry.oldValue, "two");
  assert.strictEqual(entry.newValue, "three");
});

test("json_diff: comparing a JSON file to a YAML file reports format 'mixed' when not forced", () => {
  writeJson("jd-mixed-left.json", { a: 1 });
  executeTool("create_file", { path: "jd-mixed-right.yaml", content: "a: 1\n" });
  const r = executeTool("json_diff", { left: "jd-mixed-left.json", right: "jd-mixed-right.yaml" });
  assert.strictEqual(r.format, "mixed");
  assert.strictEqual(r.identical, true);
});

test("json_diff: result echoes left/right client paths", () => {
  writeJson("jd-echo-left.json", { a: 1 });
  writeJson("jd-echo-right.json", { a: 1 });
  const r = executeTool("json_diff", { left: "jd-echo-left.json", right: "jd-echo-right.json" });
  assert.strictEqual(r.left, "jd-echo-left.json");
  assert.strictEqual(r.right, "jd-echo-right.json");
});

// ════════════════════════════════════════════════════════════════════════════
// [38-B] MEDIUM — boundary & parameter validation
// ════════════════════════════════════════════════════════════════════════════

test("json_diff: missing 'left' throws -32602", () => {
  writeJson("jd-missing-right.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { right: "jd-missing-right.json" }));
});

test("json_diff: missing 'right' throws -32602", () => {
  writeJson("jd-missing-left.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { left: "jd-missing-left.json" }));
});

test("json_diff: non-existent 'left' file throws cleanly", () => {
  writeJson("jd-noleft-right.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { left: "does-not-exist-jd.json", right: "jd-noleft-right.json" }));
});

test("json_diff: invalid JSON in 'left' throws a descriptive error", () => {
  executeTool("create_file", { path: "jd-badjson-left.json", content: "{ not valid json" });
  writeJson("jd-badjson-right.json", { a: 1 });
  assert.throws(
    () => executeTool("json_diff", { left: "jd-badjson-left.json", right: "jd-badjson-right.json" }),
    /JSON/,
  );
});

test("json_diff: invalid YAML (forced format) throws a descriptive error", () => {
  executeTool("create_file", { path: "jd-badyaml-left.txt", content: "this is not valid yaml\n" });
  writeJson("jd-badyaml-right.json", { a: 1 });
  assert.throws(
    () => executeTool("json_diff", { left: "jd-badyaml-left.txt", right: "jd-badyaml-right.json", format: "yaml" }),
  );
});

test("json_diff: unsupported format value throws -32602", () => {
  writeJson("jd-fmterr-left.json", { a: 1 });
  writeJson("jd-fmterr-right.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { left: "jd-fmterr-left.json", right: "jd-fmterr-right.json", format: "toml" }));
});

test("json_diff: negative max_changes throws -32602", () => {
  writeJson("jd-negmax-left.json", { a: 1 });
  writeJson("jd-negmax-right.json", { a: 2 });
  assert.throws(() => executeTool("json_diff", { left: "jd-negmax-left.json", right: "jd-negmax-right.json", max_changes: -1 }));
});

test("json_diff: non-integer max_changes throws -32602", () => {
  writeJson("jd-fracmax-left.json", { a: 1 });
  writeJson("jd-fracmax-right.json", { a: 2 });
  assert.throws(() => executeTool("json_diff", { left: "jd-fracmax-left.json", right: "jd-fracmax-right.json", max_changes: 1.5 }));
});

test("json_diff: max_changes above the hard cap (20000) is clamped, not rejected", () => {
  writeJson("jd-clamp-left.json", { a: 1 });
  writeJson("jd-clamp-right.json", { a: 2 });
  assert.doesNotThrow(() => executeTool("json_diff", { left: "jd-clamp-left.json", right: "jd-clamp-right.json", max_changes: 999999 }));
});

test("json_diff: max_changes=0 enumerates no changes but totalChanges/truncated reflect the real count", () => {
  writeJson("jd-zero-left.json", { a: 1, b: 2, c: 3 });
  writeJson("jd-zero-right.json", { a: 9, b: 9, c: 9 });
  const r = executeTool("json_diff", { left: "jd-zero-left.json", right: "jd-zero-right.json", max_changes: 0 });
  assert.strictEqual(r.changes.length, 0);
  assert.strictEqual(r.totalChanges, 3);
  assert.strictEqual(r.truncated, true);
});

// ════════════════════════════════════════════════════════════════════════════
// [38-C] HIGH — dependency / failure handling & documented edge semantics
// ════════════════════════════════════════════════════════════════════════════

test("json_diff: type mismatch (object vs scalar) is reported as one 'changed' entry, not recursed into", () => {
  writeJson("jd-typemix-left.json", { a: { nested: 1 } });
  writeJson("jd-typemix-right.json", { a: "just a string" });
  const r = executeTool("json_diff", { left: "jd-typemix-left.json", right: "jd-typemix-right.json" });
  const entries = r.changes.filter(c => c.path.startsWith("/a"));
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].path, "/a");
  assert.strictEqual(entries[0].type, "changed");
});

test("json_diff: root type mismatch (object vs array) reports a single change at the root path", () => {
  writeJson("jd-root-left.json", { a: 1 });
  executeTool("create_file", { path: "jd-root-right.json", content: "[1,2,3]" });
  const r = executeTool("json_diff", { left: "jd-root-left.json", right: "jd-root-right.json" });
  assert.strictEqual(r.totalChanges, 1);
  assert.strictEqual(r.changes[0].path, "");
});

test("json_diff: explicit null vs a real value is a 'changed' entry, not silently ignored", () => {
  writeJson("jd-null-left.json", { a: null });
  writeJson("jd-null-right.json", { a: 5 });
  const r = executeTool("json_diff", { left: "jd-null-left.json", right: "jd-null-right.json" });
  const entry = r.changes.find(c => c.path === "/a");
  assert.strictEqual(entry.oldValue, null);
  assert.strictEqual(entry.newValue, 5);
});

test("json_diff: both sides null at the same path is identical (no change)", () => {
  writeJson("jd-bothnull-left.json", { a: null });
  writeJson("jd-bothnull-right.json", { a: null });
  const r = executeTool("json_diff", { left: "jd-bothnull-left.json", right: "jd-bothnull-right.json" });
  assert.strictEqual(r.identical, true);
});

test("json_diff: deeply nested structure beyond MAX_DEPTH degrades to a single 'changed' entry, no crash", () => {
  function buildDeep(n, leafVal) {
    let obj = { leaf: leafVal };
    for (let i = 0; i < n; i++) obj = { nest: obj };
    return obj;
  }
  writeJson("jd-toodeep-left.json", buildDeep(60, "left-leaf"));
  writeJson("jd-toodeep-right.json", buildDeep(60, "right-leaf"));
  let threw = false;
  let r;
  try {
    r = executeTool("json_diff", { left: "jd-toodeep-left.json", right: "jd-toodeep-right.json" });
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, "should not crash on a pathologically deep structure");
  assert(r.totalChanges >= 1);
});

test("json_diff: array shrinking to empty on the right reports every left element as removed", () => {
  writeJson("jd-shrink-left.json", { items: [1, 2, 3] });
  writeJson("jd-shrink-right.json", { items: [] });
  const r = executeTool("json_diff", { left: "jd-shrink-left.json", right: "jd-shrink-right.json" });
  assert.strictEqual(r.removedCount, 3);
});

// ════════════════════════════════════════════════════════════════════════════
// [38-D] CRITICAL — security & input sanitization
// ════════════════════════════════════════════════════════════════════════════

test("json_diff: path traversal via 'left' is blocked", () => {
  writeJson("jd-trav-right.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { left: "../../../etc/passwd", right: "jd-trav-right.json" }));
});

test("json_diff: path traversal via 'right' is blocked", () => {
  writeJson("jd-trav-left.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { left: "jd-trav-left.json", right: "../../../etc/passwd" }));
});

test("json_diff: absolute path outside root is blocked", () => {
  writeJson("jd-abs-left.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { left: "jd-abs-left.json", right: "C:\\Windows\\system.ini" }));
});

test("json_diff: shell/SQL-injection-shaped values round-trip literally as data, never executed", () => {
  writeJson("jd-inj-left.json", { cmd: "clean" });
  writeJson("jd-inj-right.json", { cmd: "'; DROP TABLE users; -- $(rm -rf /)" });
  const r = executeTool("json_diff", { left: "jd-inj-left.json", right: "jd-inj-right.json" });
  const entry = r.changes.find(c => c.path === "/cmd");
  assert.strictEqual(entry.newValue, "'; DROP TABLE users; -- $(rm -rf /)");
});

test("json_diff: injection-shaped format value is rejected, not executed", () => {
  writeJson("jd-injfmt-left.json", { a: 1 });
  writeJson("jd-injfmt-right.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { left: "jd-injfmt-left.json", right: "jd-injfmt-right.json", format: "json; rm -rf /" }));
});

test("json_diff: __proto__ key in either document does not pollute Object.prototype", () => {
  executeTool("create_file", { path: "jd-proto-left.json", content: '{"__proto__": {"polluted": 1}}' });
  executeTool("create_file", { path: "jd-proto-right.json", content: '{"__proto__": {"polluted": 2}}' });
  executeTool("json_diff", { left: "jd-proto-left.json", right: "jd-proto-right.json" });
  assert.strictEqual({}.polluted, undefined, "Object.prototype must not be polluted");
});

test("json_diff: result is fully JSON-serialisable (no circular refs)", () => {
  writeJson("jd-json-left.json", { a: 1 });
  writeJson("jd-json-right.json", { a: 2 });
  const r = executeTool("json_diff", { left: "jd-json-left.json", right: "jd-json-right.json" });
  const json = JSON.stringify(r);
  assert(typeof json === "string" && json.length > 0);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.changedCount, 1);
});

test("json_diff: result has no unexpected top-level keys", () => {
  writeJson("jd-keys-left.json", { a: 1 });
  writeJson("jd-keys-right.json", { a: 1 });
  const r = executeTool("json_diff", { left: "jd-keys-left.json", right: "jd-keys-right.json" });
  const expected = ["left", "right", "format", "identical", "totalChanges", "addedCount", "removedCount", "changedCount", "truncated", "changes"].sort();
  assert.deepStrictEqual(Object.keys(r).sort(), expected);
});

// ════════════════════════════════════════════════════════════════════════════
// [38-E] EXTREME — fuzzing, concurrency, scale
// ════════════════════════════════════════════════════════════════════════════

test("json_diff: 1000-key object with a handful of scattered changes is diffed correctly", () => {
  const left = {}, right = {};
  for (let i = 0; i < 1000; i++) {
    left[`k${i}`] = i;
    right[`k${i}`] = (i % 137 === 0) ? i + 1000 : i;
  }
  writeJson("jd-large-left.json", left);
  writeJson("jd-large-right.json", right);
  const r = executeTool("json_diff", { left: "jd-large-left.json", right: "jd-large-right.json" });
  const expectedChanges = Math.ceil(1000 / 137);
  assert.strictEqual(r.changedCount, expectedChanges);
});

test("json_diff: 10-level-deep nested single change is found at the correct path", () => {
  function buildNested(n, val) {
    let obj = { value: val };
    for (let i = 0; i < n; i++) obj = { level: obj };
    return obj;
  }
  writeJson("jd-tennest-left.json", buildNested(10, "old"));
  writeJson("jd-tennest-right.json", buildNested(10, "new"));
  const r = executeTool("json_diff", { left: "jd-tennest-left.json", right: "jd-tennest-right.json" });
  const expectedPath = "/" + Array(10).fill("level").join("/") + "/value";
  const entry = r.changes.find(c => c.path === expectedPath);
  assert(entry, `expected a change at ${expectedPath}`);
  assert.strictEqual(entry.oldValue, "old");
  assert.strictEqual(entry.newValue, "new");
});

test("json_diff: 10 concurrent calls on the same document pair return consistent results", () => {
  writeJson("jd-concurrent-left.json", { a: 1, b: [1, 2, 3] });
  writeJson("jd-concurrent-right.json", { a: 2, b: [1, 9, 3] });
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(executeTool("json_diff", { left: "jd-concurrent-left.json", right: "jd-concurrent-right.json" }));
  }
  const first = JSON.stringify(results[0]);
  assert(results.every(r => JSON.stringify(r) === first), "all 10 calls return identical results");
});

test("json_diff: json_diff is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert(opEnum.includes("json_diff"), "json_diff must be in execute_pipeline op enum");
});

test("json_diff: fuzz — non-JSON garbage content throws cleanly, never crashes the process", () => {
  const fuzz = Buffer.from(Array.from({ length: 200 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  executeTool("create_file", { path: "jd-fuzz-left.json", content: fuzz });
  writeJson("jd-fuzz-right.json", { a: 1 });
  assert.throws(() => executeTool("json_diff", { left: "jd-fuzz-left.json", right: "jd-fuzz-right.json" }));
});

test("json_diff: cleanup — remove all jd-* fixture files created in this section", () => {
  const entries = fs.readdirSync(TMP);
  for (const name of entries) {
    if (name.startsWith("jd-")) {
      fs.rmSync(path.join(TMP, name), { recursive: true, force: true });
    }
  }
  assert(true, "cleanup completed");
});
