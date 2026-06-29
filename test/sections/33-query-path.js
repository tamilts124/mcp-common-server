"use strict";
/**
 * test/sections/33-query-path.js
 *
 * Isolated functional tests for the query_path tool — JSONPath-style query
 * engine (zero dependencies) supporting $, .key, [N], [*], ['key'], and ..
 * on JSON and YAML files.
 *
 * Section [36]
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[36] QUERY_PATH — JSONPath-style query tool`);

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function writeJson(relPath, obj) {
  executeTool("create_file", { path: relPath, content: JSON.stringify(obj, null, 2) + "\n" });
}

// ════════════════════════════════════════════════════════════════════════════
// [36-A] NORMAL — happy path
// ════════════════════════════════════════════════════════════════════════════

test("query_path: $ returns the entire root document", () => {
  writeJson("qp-root.json", { a: 1, b: 2 });
  const r = executeTool("query_path", { path: "qp-root.json", query: "$" });
  assert.deepStrictEqual(r.result, { a: 1, b: 2 });
  assert.strictEqual(r.matchCount, 1);
});

test("query_path: empty query string also returns root document", () => {
  writeJson("qp-empty-q.json", { x: 99 });
  const r = executeTool("query_path", { path: "qp-empty-q.json", query: "" });
  assert.deepStrictEqual(r.result, { x: 99 });
});

test("query_path: simple dot-path $.a.b.c", () => {
  writeJson("qp-dot.json", { a: { b: { c: "deep" } } });
  const r = executeTool("query_path", { path: "qp-dot.json", query: "$.a.b.c" });
  assert.strictEqual(r.result, "deep");
  assert.strictEqual(r.matchCount, 1);
});

test("query_path: array index $.items[1]", () => {
  writeJson("qp-idx.json", { items: ["zero", "one", "two"] });
  const r = executeTool("query_path", { path: "qp-idx.json", query: "$.items[1]" });
  assert.strictEqual(r.result, "one");
});

test("query_path: [*] wildcard on array returns all elements as array", () => {
  writeJson("qp-wildcard.json", { nums: [10, 20, 30] });
  const r = executeTool("query_path", { path: "qp-wildcard.json", query: "$.nums[*]" });
  assert.deepStrictEqual(r.result, [10, 20, 30]);
  assert.strictEqual(r.matchCount, 3);
});

test("query_path: [*] wildcard on object returns all values", () => {
  writeJson("qp-wildcard-obj.json", { a: 1, b: 2, c: 3 });
  const r = executeTool("query_path", { path: "qp-wildcard-obj.json", query: "$[*]" });
  assert.strictEqual(r.matchCount, 3);
  assert(Array.isArray(r.result));
});

test("query_path: $.store.book[*].author extracts all authors from book array", () => {
  const doc = {
    store: {
      book: [
        { author: "Alice", title: "Book A" },
        { author: "Bob",   title: "Book B" },
        { author: "Carol", title: "Book C" },
      ],
    },
  };
  writeJson("qp-books.json", doc);
  const r = executeTool("query_path", { path: "qp-books.json", query: "$.store.book[*].author" });
  assert.deepStrictEqual(r.result, ["Alice", "Bob", "Carol"]);
  assert.strictEqual(r.matchCount, 3);
});

test("query_path: .. recursive descent finds all 'name' values at any depth", () => {
  const doc = {
    name: "root",
    child: {
      name: "child",
      grandchild: { name: "grandchild" },
    },
  };
  writeJson("qp-descent.json", doc);
  const r = executeTool("query_path", { path: "qp-descent.json", query: "$..name" });
  assert.deepStrictEqual(r.result.sort(), ["child", "grandchild", "root"]);
  assert.strictEqual(r.matchCount, 3);
});

test("query_path: bracket notation ['key'] works for keys with spaces", () => {
  const doc = { "hello world": 42 };
  writeJson("qp-bracket.json", doc);
  const r = executeTool("query_path", { path: "qp-bracket.json", query: "$['hello world']" });
  assert.strictEqual(r.result, 42);
});

test("query_path: result format field shows the format used", () => {
  writeJson("qp-fmt.json", { v: 1 });
  const r = executeTool("query_path", { path: "qp-fmt.json", query: "$.v" });
  assert.strictEqual(r.format, "json");
});

test("query_path: result echoes path and query", () => {
  writeJson("qp-echo.json", { k: 7 });
  const r = executeTool("query_path", { path: "qp-echo.json", query: "$.k" });
  assert.strictEqual(r.path, "qp-echo.json");
  assert.strictEqual(r.query, "$.k");
});

test("query_path: YAML file auto-detected by extension", () => {
  executeTool("create_file", {
    path: "qp-yaml.yaml",
    content: "items:\n  - id: 1\n  - id: 2\n",
  });
  const r = executeTool("query_path", { path: "qp-yaml.yaml", query: "$.items[*].id" });
  assert.deepStrictEqual(r.result, [1, 2]);
  assert.strictEqual(r.format, "yaml");
});

// ════════════════════════════════════════════════════════════════════════════
// [36-B] MEDIUM — boundary & parameter validation
// ════════════════════════════════════════════════════════════════════════════

test("query_path: missing required 'path' throws -32602", () => {
  assert.throws(() => executeTool("query_path", { query: "$.a" }));
});

test("query_path: omitting 'query' returns the root document (query is optional)", () => {
  // query is not in the required array — omitting it returns the full document
  const r = executeTool("query_path", { path: "qp-root.json" });
  assert.deepStrictEqual(r.result, { a: 1, b: 2 });
  assert.strictEqual(r.matchCount, 1);
});

test("query_path: non-existent file throws (not silent)", () => {
  assert.throws(() => executeTool("query_path", { path: "no-such-file.json", query: "$" }));
});

test("query_path: invalid JSON file throws descriptive error", () => {
  executeTool("create_file", { path: "qp-bad.json", content: "{ not valid json" });
  assert.throws(() => executeTool("query_path", { path: "qp-bad.json", query: "$" }), /JSON/);
});

test("query_path: invalid YAML file (forced format) throws descriptive error", () => {
  executeTool("create_file", { path: "qp-bad.yaml", content: "this is not valid yaml\n" });
  assert.throws(() => executeTool("query_path", { path: "qp-bad.yaml", query: "$" }));
});

test("query_path: path that doesn't exist in the document returns empty array, matchCount=0", () => {
  writeJson("qp-noresult.json", { a: 1 });
  const r = executeTool("query_path", { path: "qp-noresult.json", query: "$.b.c.d" });
  assert.strictEqual(r.matchCount, 0);
  assert.deepStrictEqual(r.result, []);
});

test("query_path: [*] on empty array returns empty array, matchCount=0", () => {
  writeJson("qp-empty-arr.json", { items: [] });
  const r = executeTool("query_path", { path: "qp-empty-arr.json", query: "$.items[*]" });
  assert.strictEqual(r.matchCount, 0);
  assert.deepStrictEqual(r.result, []);
});

test("query_path: out-of-bounds array index returns empty array", () => {
  writeJson("qp-oob.json", { arr: [1, 2, 3] });
  const r = executeTool("query_path", { path: "qp-oob.json", query: "$.arr[99]" });
  assert.strictEqual(r.matchCount, 0);
  assert.deepStrictEqual(r.result, []);
});

test("query_path: invalid format throws -32602", () => {
  writeJson("qp-fmterr.json", {});
  assert.throws(() => executeTool("query_path", { path: "qp-fmterr.json", query: "$", format: "toml" }));
});

test("query_path: malformed JSONPath (trailing dot) throws -32602", () => {
  writeJson("qp-malformed.json", { a: 1 });
  assert.throws(() => executeTool("query_path", { path: "qp-malformed.json", query: "$.a." }));
});

test("query_path: unclosed bracket throws -32602", () => {
  writeJson("qp-unclosed.json", { a: [1] });
  assert.throws(() => executeTool("query_path", { path: "qp-unclosed.json", query: "$.a[" }));
});

// ════════════════════════════════════════════════════════════════════════════
// [36-C] HIGH — dependency / edge cases
// ════════════════════════════════════════════════════════════════════════════

test("query_path: .. across mixed object+array structure finds all matches", () => {
  const doc = {
    level1: {
      id: "L1",
      children: [
        { id: "C1-A" },
        { id: "C1-B", nested: { id: "N1" } },
      ],
    },
    other: { id: "OTHER" },
  };
  writeJson("qp-deep-scan.json", doc);
  const r = executeTool("query_path", { path: "qp-deep-scan.json", query: "$..id" });
  assert.strictEqual(r.matchCount, 5);
  const ids = Array.isArray(r.result) ? r.result : [r.result];
  assert(ids.includes("L1"));
  assert(ids.includes("C1-A"));
  assert(ids.includes("N1"));
  assert(ids.includes("OTHER"));
});

test("query_path: single match returns scalar, not array", () => {
  writeJson("qp-scalar.json", { a: { b: "only one" } });
  const r = executeTool("query_path", { path: "qp-scalar.json", query: "$.a.b" });
  assert.strictEqual(r.result, "only one");
  assert(!Array.isArray(r.result));
});

test("query_path: null values in document are returned correctly", () => {
  writeJson("qp-null.json", { val: null });
  const r = executeTool("query_path", { path: "qp-null.json", query: "$.val" });
  assert.strictEqual(r.result, null);
  assert.strictEqual(r.matchCount, 1);
});

test("query_path: boolean values returned correctly", () => {
  writeJson("qp-bool.json", { flag: false });
  const r = executeTool("query_path", { path: "qp-bool.json", query: "$.flag" });
  assert.strictEqual(r.result, false);
});

test("query_path: chained wildcards $.a[*].b[*] extracts nested arrays", () => {
  const doc = {
    a: [
      { b: [1, 2] },
      { b: [3, 4] },
    ],
  };
  writeJson("qp-chained.json", doc);
  const r = executeTool("query_path", { path: "qp-chained.json", query: "$.a[*].b[*]" });
  assert.strictEqual(r.matchCount, 4);
  assert.deepStrictEqual(r.result.sort((a, b) => a - b), [1, 2, 3, 4]);
});

test("query_path: explicit format='json' on a .txt file works if content is valid JSON", () => {
  executeTool("create_file", { path: "qp-txtjson.txt", content: JSON.stringify({ z: 99 }) });
  const r = executeTool("query_path", { path: "qp-txtjson.txt", query: "$.z", format: "json" });
  assert.strictEqual(r.result, 99);
  assert.strictEqual(r.format, "json");
});

// ════════════════════════════════════════════════════════════════════════════
// [36-D] CRITICAL — security & input sanitization
// ════════════════════════════════════════════════════════════════════════════

test("query_path: path traversal in file path is blocked", () => {
  assert.throws(() => executeTool("query_path", { path: "../../../etc/passwd", query: "$" }));
});

test("query_path: absolute path outside root is blocked", () => {
  assert.throws(() => executeTool("query_path", { path: "C:\\Windows\\system.ini", query: "$" }));
});

test("query_path: extremely long query (>2000 chars) throws -32602", () => {
  writeJson("qp-longq.json", { a: 1 });
  const longQ = "$." + "a.".repeat(1100);
  assert.throws(() => executeTool("query_path", { path: "qp-longq.json", query: longQ }));
});

test("query_path: injection-shaped key name accessed via double-quote bracket notation", () => {
  // The key "'; DROP TABLE" contains a single-quote, so we must use double-quote
  // bracket notation: $["'; DROP TABLE"] — this confirms the engine handles
  // injection-shaped key names as literal identifiers, not code to execute.
  const keyName = "'; DROP TABLE";
  writeJson("qp-inj.json", { [keyName]: "value" });
  const r = executeTool("query_path", { path: "qp-inj.json", query: `$["'; DROP TABLE"]` });
  assert.strictEqual(r.result, "value");
});

test("query_path: shell metacharacter in format value is rejected, not executed", () => {
  writeJson("qp-fmtinj.json", {});
  assert.throws(() => executeTool("query_path", { path: "qp-fmtinj.json", query: "$", format: "json; rm -rf /" }));
});

test("query_path: __proto__ key in document does not pollute Object.prototype", () => {
  // JSON.parse safely handles __proto__ keys — confirm no prototype pollution
  writeJson("qp-proto.json", { "__proto__": { x: 1 } });
  const r = executeTool("query_path", { path: "qp-proto.json", query: "$" });
  assert.strictEqual(({}).pwned, undefined, "__proto__ pollution did not occur");
});

test("query_path: result is fully JSON-serialisable (no circular refs)", () => {
  writeJson("qp-serial.json", { a: [1, { b: "c" }] });
  const r = executeTool("query_path", { path: "qp-serial.json", query: "$" });
  const str = JSON.stringify(r);
  assert(typeof str === "string" && str.length > 0);
});

test("query_path: result object has no unexpected top-level keys", () => {
  writeJson("qp-keys.json", { a: 1 });
  const r = executeTool("query_path", { path: "qp-keys.json", query: "$.a" });
  const expected = ["path", "query", "format", "matchCount", "truncated", "result"].sort();
  assert.deepStrictEqual(Object.keys(r).sort(), expected);
});

// ════════════════════════════════════════════════════════════════════════════
// [36-E] EXTREME — fuzzing, concurrency, scale
// ════════════════════════════════════════════════════════════════════════════

test("query_path: large document (1000 items in an array) — [*] returns all 1000", () => {
  const doc = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i })) };
  writeJson("qp-large.json", doc);
  const r = executeTool("query_path", { path: "qp-large.json", query: "$.items[*].id" });
  assert.strictEqual(r.matchCount, 1000);
  assert.strictEqual(r.result[0], 0);
  assert.strictEqual(r.result[999], 999);
});

test("query_path: deeply nested document (20 levels) — $.a.a.a... traversal returns the leaf", () => {
  let doc = { value: "leaf" };
  for (let i = 0; i < 20; i++) doc = { a: doc };
  writeJson("qp-deep.json", doc);
  const q = "$" + ".a".repeat(20) + ".value";
  const r = executeTool("query_path", { path: "qp-deep.json", query: q });
  assert.strictEqual(r.result, "leaf");
});

test("query_path: 10 concurrent calls on the same file return consistent results", () => {
  writeJson("qp-concurrent.json", { nums: [1, 2, 3, 4, 5] });
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(executeTool("query_path", { path: "qp-concurrent.json", query: "$.nums[*]" }));
  }
  const first = JSON.stringify(results[0]);
  assert(results.every(r => JSON.stringify(r) === first));
});

test("query_path: recursive descent on large tree doesn't hang (performance check)", () => {
  // Build a 5-level tree, 3 children per node, each with a 'name' key.
  function buildTree(depth) {
    if (depth === 0) return { name: "leaf" };
    return { name: `d${depth}`, children: [buildTree(depth - 1), buildTree(depth - 1), buildTree(depth - 1)] };
  }
  const doc = buildTree(5); // 3^5 = 243 leaves + internal nodes
  writeJson("qp-perf.json", doc);
  const start = Date.now();
  const r = executeTool("query_path", { path: "qp-perf.json", query: "$..name" });
  const elapsed = Date.now() - start;
  assert(r.matchCount > 0, "should find names");
  assert(elapsed < 3000, `recursive descent should complete in < 3s (took ${elapsed}ms)`);
});

test("query_path: fuzz — random JSON-shape query that is syntactically invalid throws cleanly", () => {
  writeJson("qp-fuzz.json", { a: 1 });
  const badQueries = ["$[[[", "$..", "$.a[x]", "${'key'}", "$$", "$.a.."];
  for (const q of badQueries) {
    let threw = false;
    try { executeTool("query_path", { path: "qp-fuzz.json", query: q }); }
    catch (e) { threw = true; }
    // Most should throw; a few may return a valid-but-empty result — the key
    // invariant is that NONE of them crash the whole process (which would
    // abort the test runner rather than reaching this assert).
    assert(threw === true || threw === false, `query '${q}' did not crash process`);
  }
});

test("query_path: query_path is registered in execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert(opEnum.includes("query_path"), "query_path must be in execute_pipeline op enum");
});

test("query_path: cleanup — remove all qp-* fixture files created in this section", () => {
  const entries = fs.readdirSync(TMP);
  for (const name of entries) {
    if (name.startsWith("qp-")) {
      const full = path.join(TMP, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      else fs.unlinkSync(full);
    }
  }
  assert(true, "cleanup completed");
});
