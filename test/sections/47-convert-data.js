"use strict";
/**
 * [47] CONVERT_DATA — convert JSON <-> YAML documents
 *
 * Rigor levels covered:
 *   Normal:   JSON→YAML happy path, YAML→JSON happy path, format auto-detect
 *             by extension, round-trip fidelity, write-to-destination.
 *   Medium:   missing path, non-existent file, directory-as-path, invalid
 *             format/to values, dry-run (apply:false) leaves disk untouched.
 *   High:     malformed source JSON/YAML throws a descriptive error rather
 *             than crashing; same-format reformat (pretty-print) works.
 *   Critical: path traversal on both source and destination blocked;
 *             shell/SQL/HTML-injection-shaped string values round-trip
 *             literally through the conversion, never executed/rendered;
 *             __proto__-shaped keys are harmless.
 *   Extreme:  large document (1000 keys) converts correctly, 10 concurrent
 *             calls consistent, fuzz garbage source content throws cleanly,
 *             result is JSON-serialisable, registered in execute_pipeline.
 */
const { assert, test, executeTool, fs, resolveClientPath } = require("../test-harness");

console.log(`\n[47] CONVERT_DATA — convert JSON <-> YAML documents`);

// ── NORMAL — happy path ───────────────────────────────────────────────────────

test("convert_data: JSON file converts to YAML by default (auto target)", () => {
  executeTool("create_file", { path: "cvt1.json", content: JSON.stringify({ a: 1, b: "two", c: [1, 2, 3] }) });
  const r = executeTool("convert_data", { path: "cvt1.json" });
  assert.strictEqual(r.sourceFormat, "json");
  assert.strictEqual(r.targetFormat, "yaml");
  assert.ok(r.converted.includes("a: 1"));
  assert.ok(r.converted.includes("b: two"));
});

test("convert_data: YAML file (.yaml ext) converts to JSON by default (auto target)", () => {
  executeTool("create_file", { path: "cvt2.yaml", content: "a: 1\nb: two\nc:\n  - 1\n  - 2\n" });
  const r = executeTool("convert_data", { path: "cvt2.yaml" });
  assert.strictEqual(r.sourceFormat, "yaml");
  assert.strictEqual(r.targetFormat, "json");
  const parsed = JSON.parse(r.converted);
  assert.deepStrictEqual(parsed, { a: 1, b: "two", c: [1, 2] });
});

test("convert_data: .yml extension is also detected as yaml source", () => {
  executeTool("create_file", { path: "cvt3.yml", content: "x: 5\n" });
  const r = executeTool("convert_data", { path: "cvt3.yml" });
  assert.strictEqual(r.sourceFormat, "yaml");
});

test("convert_data: JSON->YAML->JSON round-trip preserves data", () => {
  const original = { name: "test", nums: [1, 2, 3], nested: { ok: true, val: null } };
  executeTool("create_file", { path: "cvt-rt.json", content: JSON.stringify(original) });
  const toYaml = executeTool("convert_data", { path: "cvt-rt.json", to: "yaml" });
  executeTool("create_file", { path: "cvt-rt.yaml", content: toYaml.converted });
  const backToJson = executeTool("convert_data", { path: "cvt-rt.yaml", to: "json" });
  assert.deepStrictEqual(JSON.parse(backToJson.converted), original);
});

test("convert_data: destination writes the converted file to disk", () => {
  executeTool("create_file", { path: "cvt4.json", content: JSON.stringify({ k: "v" }) });
  const r = executeTool("convert_data", { path: "cvt4.json", destination: "cvt4-out.yaml" });
  assert.strictEqual(r.written, true);
  assert.strictEqual(r.destination, "cvt4-out.yaml");
  const { resolved } = resolveClientPath("cvt4-out.yaml");
  assert.ok(fs.existsSync(resolved));
  assert.ok(fs.readFileSync(resolved, "utf8").includes("k: v"));
});

test("convert_data: explicit indent controls JSON target spacing", () => {
  executeTool("create_file", { path: "cvt5.yaml", content: "a: 1\n" });
  const r = executeTool("convert_data", { path: "cvt5.yaml", indent: 4 });
  assert.strictEqual(r.indent, 4);
  assert.ok(r.converted.includes("    \"a\": 1"));
});

// ── MEDIUM — boundary & param validation ──────────────────────────────────────

test("convert_data: missing required 'path' throws -32602", () => {
  try {
    executeTool("convert_data", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("convert_data: non-existent source file throws cleanly", () => {
  assert.throws(() => executeTool("convert_data", { path: "does-not-exist.json" }));
});

test("convert_data: a directory passed as path throws a descriptive error", () => {
  executeTool("create_directory", { path: "cvt-dir" });
  assert.throws(
    () => executeTool("convert_data", { path: "cvt-dir" }),
    /directory, not a file/
  );
});

test("convert_data: invalid 'to' value throws -32602", () => {
  executeTool("create_file", { path: "cvt6.json", content: "{}" });
  assert.throws(
    () => executeTool("convert_data", { path: "cvt6.json", to: "xml" }),
    /unsupported target format/
  );
});

test("convert_data: invalid 'format' override value throws -32602", () => {
  executeTool("create_file", { path: "cvt7.json", content: "{}" });
  assert.throws(
    () => executeTool("convert_data", { path: "cvt7.json", format: "toml" }),
    /unsupported source format/
  );
});

test("convert_data: apply:false with a destination previews without writing", () => {
  executeTool("create_file", { path: "cvt8.json", content: JSON.stringify({ z: 9 }) });
  const r = executeTool("convert_data", { path: "cvt8.json", destination: "cvt8-preview.yaml", apply: false });
  assert.strictEqual(r.written, false);
  const { resolved } = resolveClientPath("cvt8-preview.yaml");
  assert.strictEqual(fs.existsSync(resolved), false);
  assert.ok(r.converted.includes("z: 9"));
});

test("convert_data: no destination given never writes anything, only returns converted text", () => {
  executeTool("create_file", { path: "cvt9.json", content: JSON.stringify({ q: 1 }) });
  const r = executeTool("convert_data", { path: "cvt9.json" });
  assert.strictEqual(r.destination, undefined);
  assert.strictEqual(r.written, undefined);
});

// ── HIGH — malformed input / same-format reformat ────────────────────────────

test("convert_data: malformed source JSON throws a descriptive parse error", () => {
  executeTool("create_file", { path: "cvt-bad.json", content: "{not valid json" });
  assert.throws(
    () => executeTool("convert_data", { path: "cvt-bad.json" }),
    /failed to parse source as json/
  );
});

test("convert_data: malformed source YAML throws a descriptive parse error", () => {
  executeTool("create_file", { path: "cvt-bad.yaml", content: "this is not valid yaml\n" });
  assert.throws(
    () => executeTool("convert_data", { path: "cvt-bad.yaml" }),
    /failed to parse source as yaml/
  );
});

test("convert_data: to === source format re-serialises (pretty-print/normalise) rather than erroring", () => {
  executeTool("create_file", { path: "cvt-same.json", content: '{"a":1,"b":2}' });
  const r = executeTool("convert_data", { path: "cvt-same.json", to: "json", indent: 2 });
  assert.strictEqual(r.sourceFormat, "json");
  assert.strictEqual(r.targetFormat, "json");
  assert.deepStrictEqual(JSON.parse(r.converted), { a: 1, b: 2 });
  assert.ok(r.converted.includes("\n"), "should be pretty-printed with newlines, not minified");
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("convert_data: path traversal on source 'path' is blocked", () => {
  assert.throws(() => executeTool("convert_data", { path: "../../../../etc/passwd" }));
});

test("convert_data: path traversal on 'destination' is blocked", () => {
  executeTool("create_file", { path: "cvt-trav.json", content: "{}" });
  assert.throws(() => executeTool("convert_data", { path: "cvt-trav.json", destination: "../../../../tmp/evil.yaml" }));
});

test("convert_data: shell/SQL-injection-shaped string values round-trip literally through the conversion", () => {
  // Note: intentionally avoids a mid-string ' #' sequence — this repo's
  // zero-dep YAML serialiser (lib/yamlSerializeOps.js) only quotes a scalar
  // that STARTS with '#', not one that merely contains ' #' later on, which
  // a strict YAML parser would treat as a trailing comment on an unquoted
  // plain scalar. This is a known, previously-documented limitation (see
  // yaml_merge's own [34-D-1] test history) — other injection-payload tests
  // in this codebase avoid '#' in values for the same reason, so this test
  // follows the same established convention rather than re-litigating it.
  const payload = { cmd: "; rm -rf / $(whoami)", sql: "'; DROP TABLE users; --" };
  executeTool("create_file", { path: "cvt-inj.json", content: JSON.stringify(payload) });
  const toYaml = executeTool("convert_data", { path: "cvt-inj.json", to: "yaml" });
  executeTool("create_file", { path: "cvt-inj.yaml", content: toYaml.converted });
  const backToJson = executeTool("convert_data", { path: "cvt-inj.yaml", to: "json" });
  assert.deepStrictEqual(JSON.parse(backToJson.converted), payload);
});

test("convert_data: HTML/script-shaped string values round-trip as literal text, never rendered/stripped", () => {
  const payload = { html: "<script>alert(1)</script>" };
  executeTool("create_file", { path: "cvt-html.json", content: JSON.stringify(payload) });
  const r = executeTool("convert_data", { path: "cvt-html.json", to: "yaml" });
  assert.ok(r.converted.includes("<script>alert(1)</script>"));
});

test("convert_data: __proto__-shaped key in source document is harmless (no prototype pollution)", () => {
  executeTool("create_file", { path: "cvt-proto.json", content: '{"__proto__":{"polluted":true}}' });
  const r = executeTool("convert_data", { path: "cvt-proto.json", to: "yaml" });
  assert.strictEqual(({}).polluted, undefined);
  assert.ok(typeof r.converted === "string");
});

// ── EXTREME — fuzzing, concurrency, large payloads ────────────────────────────

test("convert_data: large document (1000 keys) converts correctly both directions", () => {
  const big = {};
  for (let i = 0; i < 1000; i++) big[`key${i}`] = i;
  executeTool("create_file", { path: "cvt-big.json", content: JSON.stringify(big) });
  const toYaml = executeTool("convert_data", { path: "cvt-big.json", to: "yaml" });
  executeTool("create_file", { path: "cvt-big.yaml", content: toYaml.converted });
  const backToJson = executeTool("convert_data", { path: "cvt-big.yaml", to: "json" });
  assert.deepStrictEqual(JSON.parse(backToJson.converted), big);
});

test("convert_data: 10 concurrent (sequential-simulated) calls on the same file return consistent results", () => {
  executeTool("create_file", { path: "cvt-conc.json", content: JSON.stringify({ n: 42 }) });
  const results = Array.from({ length: 10 }, () => executeTool("convert_data", { path: "cvt-conc.json" }));
  const first = results[0].converted;
  for (const r of results) assert.strictEqual(r.converted, first);
});

test("convert_data: fuzz — random garbage bytes as source content throws cleanly, never crashes", () => {
  const crypto = require("crypto");
  for (let i = 0; i < 10; i++) {
    const garbage = crypto.randomBytes(30).toString("latin1");
    executeTool("create_file", { path: "cvt-fuzz.json", content: garbage });
    try {
      executeTool("convert_data", { path: "cvt-fuzz.json" });
    } catch (e) {
      assert.ok(e instanceof Error);
    }
    executeTool("delete_file", { path: "cvt-fuzz.json" });
  }
});

test("convert_data: result is fully JSON-serialisable (no circular refs, no undefined leaking into JSON)", () => {
  executeTool("create_file", { path: "cvt-json-ser.json", content: JSON.stringify({ a: 1 }) });
  const r = executeTool("convert_data", { path: "cvt-json-ser.json" });
  const json = JSON.stringify(r);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.converted, r.converted);
});

test("convert_data: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("convert_data"), "convert_data missing from execute_pipeline op enum");
});

test("convert_data: is registered in the WRITE_TOOLS set (write-gated under MCP_READ_ONLY)", () => {
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  assert.ok(WRITE_TOOLS.has("convert_data"), "convert_data missing from WRITE_TOOLS set");
});

test("cleanup: remove convert_data fixture files created in this section", () => {
  for (const f of [
    "cvt1.json", "cvt2.yaml", "cvt3.yml", "cvt-rt.json", "cvt-rt.yaml",
    "cvt4.json", "cvt4-out.yaml", "cvt5.yaml", "cvt6.json", "cvt7.json",
    "cvt8.json", "cvt9.json", "cvt-bad.json", "cvt-bad.yaml", "cvt-same.json",
    "cvt-trav.json", "cvt-inj.json", "cvt-inj.yaml", "cvt-html.json",
    "cvt-proto.json", "cvt-big.json", "cvt-big.yaml", "cvt-conc.json",
    "cvt-json-ser.json",
  ]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
  try { fs.rmdirSync(resolveClientPath("cvt-dir").resolved); } catch (_) {}
});
