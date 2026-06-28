"use strict";
/**
 * [9] YAML / QUERY_DATA TOOL — query_data (JSON or YAML by extension),
 * and the underlying lib/yamlOps.js parser.
 *
 * Rigor levels covered:
 *   Normal:   happy-path parsing of representative YAML/JSON documents
 *   Medium:   boundary/param validation (missing path, bad format, empty file)
 *   High:     "dependency failure" analogues — malformed YAML, non-existent file
 *   Critical: path traversal, injection-shaped content stored as literal scalars
 *   Extreme:  large/deeply-nested documents, fuzz input, format-override edge cases
 */
const { fs, path, assert, test, executeTool } = require("../test-harness");
const { parseYaml } = require("../../lib/yamlOps");

console.log(`\n[9] YAML / QUERY_DATA TOOL — query_data, lib/yamlOps.js`);

// ── NORMAL — happy path ──────────────────────────────────────────────────────
test("query_data: simple YAML mapping, top-level scalar", () => {
  executeTool("create_file", { path: "simple.yaml", content: "name: widget\nversion: 2\nactive: true\n" });
  const r = executeTool("query_data", { path: "simple.yaml", query: "name" });
  assert.strictEqual(r.value, "widget");
  assert.strictEqual(r.type, "string");
  assert.strictEqual(r.format, "yaml");
});

test("query_data: .yml extension also detected as YAML", () => {
  executeTool("create_file", { path: "simple.yml", content: "key: value\n" });
  const r = executeTool("query_data", { path: "simple.yml", query: "key" });
  assert.strictEqual(r.value, "value");
  assert.strictEqual(r.format, "yaml");
});

test("query_data: nested mapping dot-path traversal", () => {
  executeTool("create_file", { path: "nested.yaml", content: "a:\n  b:\n    c: 42\n" });
  const r = executeTool("query_data", { path: "nested.yaml", query: "a.b.c" });
  assert.strictEqual(r.value, 42);
  assert.strictEqual(r.type, "number");
});

test("query_data: sequence of mappings, index + field traversal", () => {
  executeTool("create_file", {
    path: "items.yaml",
    content: "items:\n  - id: 1\n    label: one\n  - id: 2\n    label: two\n",
  });
  const r = executeTool("query_data", { path: "items.yaml", query: "items.1.label" });
  assert.strictEqual(r.value, "two");
});

test("query_data: flow sequence and flow mapping", () => {
  executeTool("create_file", { path: "flow.yaml", content: "nums: [1, 2, 3]\nobj: {a: 1, b: 2}\n" });
  const r1 = executeTool("query_data", { path: "flow.yaml", query: "nums" });
  assert.deepStrictEqual(r1.value, [1, 2, 3]);
  assert.strictEqual(r1.type, "array");
  const r2 = executeTool("query_data", { path: "flow.yaml", query: "obj.b" });
  assert.strictEqual(r2.value, 2);
});

test("query_data: empty query returns full YAML document", () => {
  executeTool("create_file", { path: "root.yaml", content: "a: 1\nb: 2\n" });
  const r = executeTool("query_data", { path: "root.yaml" });
  assert.deepStrictEqual(r.value, { a: 1, b: 2 });
  assert.strictEqual(r.type, "object");
});

test("query_data: .json extension still resolves to JSON parsing (no regression)", () => {
  executeTool("create_file", { path: "plain.json", content: JSON.stringify({ x: { y: 9 } }) });
  const r = executeTool("query_data", { path: "plain.json", query: "x.y" });
  assert.strictEqual(r.value, 9);
  assert.strictEqual(r.format, "json");
});

test("query_data: explicit format='yaml' override on a non-standard extension", () => {
  executeTool("create_file", { path: "config.conf", content: "mode: production\n" });
  const r = executeTool("query_data", { path: "config.conf", query: "mode", format: "yaml" });
  assert.strictEqual(r.value, "production");
  assert.strictEqual(r.format, "yaml");
});

test("query_json is unaffected by query_data's existence (backward compatibility)", () => {
  executeTool("create_file", { path: "compat.json", content: JSON.stringify({ ok: true }) });
  const r = executeTool("query_json", { path: "compat.json", query: "ok" });
  assert.strictEqual(r.value, true);
  assert.ok(!("format" in r), "query_json result should not include a format field");
});

// ── MEDIUM — boundary & param validation ────────────────────────────────────
test("query_data: missing path throws -32602", () => {
  try {
    executeTool("query_data", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("query_data: empty YAML file returns null root", () => {
  executeTool("create_file", { path: "empty.yaml", content: "" });
  const r = executeTool("query_data", { path: "empty.yaml" });
  assert.strictEqual(r.value, null);
  assert.strictEqual(r.type, "null");
});

test("query_data: invalid explicit format throws descriptive error", () => {
  executeTool("create_file", { path: "x.yaml", content: "a: 1\n" });
  assert.throws(
    () => executeTool("query_data", { path: "x.yaml", format: "toml" }),
    /Unsupported format/,
  );
});

test("query_data: nonexistent path in document throws descriptive error", () => {
  executeTool("create_file", { path: "y.yaml", content: "a: 1\n" });
  assert.throws(
    () => executeTool("query_data", { path: "y.yaml", query: "a.b.c" }),
    /does not exist/,
  );
});

test("query_data: nonexistent file throws (not silent)", () => {
  assert.throws(() => executeTool("query_data", { path: "ghost.yaml" }));
});

// ── HIGH — malformed input / parser-failure handling ────────────────────────
test("query_data: malformed YAML (no colon) throws descriptive error, not a crash", () => {
  executeTool("create_file", { path: "bad.yaml", content: "this is not valid yaml\n" });
  assert.throws(
    () => executeTool("query_data", { path: "bad.yaml" }),
    /expected/,
  );
});

test("query_data: YAML anchors throw a clear unsupported-feature error", () => {
  executeTool("create_file", { path: "anchor.yaml", content: "a: &ref value\nb: *ref\n" });
  assert.throws(
    () => executeTool("query_data", { path: "anchor.yaml" }),
    /anchors|aliases/,
  );
});

test("query_data: invalid JSON via .json extension still throws SyntaxError-style error", () => {
  executeTool("create_file", { path: "bad-data.json", content: "{ not valid [}" });
  assert.throws(() => executeTool("query_data", { path: "bad-data.json" }), /JSON/i);
});

test("query_data: malformed flow mapping (missing colon) throws descriptive error", () => {
  executeTool("create_file", { path: "badflow.yaml", content: "obj: {a, b}\n" });
  assert.throws(
    () => executeTool("query_data", { path: "badflow.yaml" }),
    /malformed flow mapping/,
  );
});

// ── CRITICAL — security & input sanitization ────────────────────────────────
test("query_data: path traversal blocked", () => {
  assert.throws(
    () => executeTool("query_data", { path: "../../../etc/passwd" }),
    /Access denied/,
  );
});

test("query_data: shell/HTML-injection-shaped content is stored and read back literally", () => {
  executeTool("create_file", {
    path: "inject.yaml",
    content: 'cmd: "; rm -rf / #"\nhtml: "<script>alert(1)</script>"\n',
  });
  const r1 = executeTool("query_data", { path: "inject.yaml", query: "cmd" });
  assert.strictEqual(r1.value, "; rm -rf / #");
  const r2 = executeTool("query_data", { path: "inject.yaml", query: "html" });
  assert.strictEqual(r2.value, "<script>alert(1)</script>");
});

test("query_data: SQL-injection-shaped string round-trips as a literal scalar", () => {
  executeTool("create_file", { path: "sqli.yaml", content: "q: \"' OR '1'='1\"\n" });
  const r = executeTool("query_data", { path: "sqli.yaml", query: "q" });
  assert.strictEqual(r.value, "' OR '1'='1");
});

test("query_data: format param is validated, not passed through to fs/exec unsanitized", () => {
  executeTool("create_file", { path: "z.yaml", content: "a: 1\n" });
  assert.throws(
    () => executeTool("query_data", { path: "z.yaml", format: "; rm -rf /" }),
    /Unsupported format/,
  );
});

// ── EXTREME — fuzzing, large/deep documents, edge cases ─────────────────────
test("query_data: deeply nested YAML (50 levels) parses without stack issues", () => {
  let content = "";
  for (let i = 0; i < 50; i++) content += `${"  ".repeat(i)}l${i}:\n`;
  content += `${"  ".repeat(50)}value: deep\n`;
  executeTool("create_file", { path: "deep.yaml", content });
  const query = Array.from({ length: 50 }, (_, i) => `l${i}`).join(".") + ".value";
  const r = executeTool("query_data", { path: "deep.yaml", query });
  assert.strictEqual(r.value, "deep");
});

test("query_data: large YAML sequence (2000 items) parses and indexes correctly", () => {
  const lines = ["items:"];
  for (let i = 0; i < 2000; i++) lines.push(`  - item${i}`);
  executeTool("create_file", { path: "biglist.yaml", content: lines.join("\n") + "\n" });
  const r = executeTool("query_data", { path: "biglist.yaml", query: "items.1999" });
  assert.strictEqual(r.value, "item1999");
});

test("query_data: random fuzz bytes as YAML content do not crash the process (throw cleanly instead)", () => {
  const fuzz = Buffer.from(Array.from({ length: 500 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  executeTool("create_file", { path: "fuzz.yaml", content: fuzz });
  // Fuzz input should either parse to *something* or throw a descriptive Error —
  // it must never hang, segfault, or throw a non-Error value.
  try {
    executeTool("query_data", { path: "fuzz.yaml" });
  } catch (e) {
    assert.ok(e instanceof Error, "fuzz input must fail with a proper Error, not crash");
  }
});

test("parseYaml (direct): extremely long single-line value does not hang the regex engine", () => {
  const longVal = "x".repeat(200000);
  const start = Date.now();
  const result = parseYaml(`key: ${longVal}`);
  const elapsed = Date.now() - start;
  assert.strictEqual(result.key.length, 200000);
  assert.ok(elapsed < 5000, `parseYaml took too long (${elapsed}ms) on a long scalar — possible ReDoS`);
});

test("query_data: concurrent reads of the same YAML file return consistent results", () => {
  executeTool("create_file", { path: "conc.yaml", content: "n: 7\n" });
  const results = Array.from({ length: 10 }, () => executeTool("query_data", { path: "conc.yaml", query: "n" }));
  for (const r of results) assert.strictEqual(r.value, 7);
});

test("cleanup: remove YAML/JSON fixture files created in this section", () => {
  const files = [
    "simple.yaml", "simple.yml", "nested.yaml", "items.yaml", "flow.yaml", "root.yaml",
    "plain.json", "config.conf", "compat.json", "empty.yaml", "x.yaml", "y.yaml",
    "bad.yaml", "anchor.yaml", "bad-data.json", "badflow.yaml", "inject.yaml", "sqli.yaml",
    "z.yaml", "deep.yaml", "biglist.yaml", "fuzz.yaml", "conc.yaml",
  ];
  for (const f of files) {
    const p = path.join(require("../test-harness").TMP, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  assert.ok(true);
});
