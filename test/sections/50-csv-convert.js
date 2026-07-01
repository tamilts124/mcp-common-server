"use strict";
/**
 * [50] CSV_CONVERT — convert CSV <-> JSON documents
 *
 * Complements convert_data (JSON<->YAML) and csv_query (read-only CSV
 * querying) by covering the CSV<->JSON round-trip, including a write-back
 * destination. Mirrors convert_data's test structure closely since the two
 * tools share the same destination/apply/dry-run/format-override contract.
 *
 * Rigor levels covered:
 *   Normal:   CSV->JSON happy path (array of objects), JSON->CSV happy path
 *             (array of objects), format auto-detect by extension,
 *             has_header:false raw-row mode both directions, round-trip
 *             fidelity, write-to-destination, array-of-arrays JSON->CSV mode.
 *   Medium:   missing path, non-existent file, directory-as-path, invalid
 *             format/to values, same-format (nothing-to-convert) rejected,
 *             dry-run (apply:false) leaves disk untouched, empty CSV/empty
 *             JSON array boundaries.
 *   High:     malformed source JSON throws a descriptive error; JSON source
 *             that isn't an array throws a descriptive error; mixed/invalid
 *             array-element shapes (object + array in the same array, or a
 *             bare primitive) are rejected rather than silently coerced;
 *             quoted CSV fields with embedded commas/newlines round-trip
 *             correctly (RFC 4180 compliance via the shared parseCsvText).
 *   Critical: path traversal on both source and destination blocked;
 *             shell/SQL-injection-shaped and comma/quote-containing field
 *             values round-trip literally through the conversion, never
 *             executed/interpreted; __proto__-shaped keys are harmless.
 *   Extreme:  large document (500 rows) converts correctly both directions,
 *             10 concurrent calls consistent, fuzz garbage source content
 *             throws cleanly, result is JSON-serialisable, registered in
 *             execute_pipeline and WRITE_TOOLS.
 */
const { assert, test, executeTool, fs, resolveClientPath } = require("../test-harness");

console.log(`\n[50] CSV_CONVERT — convert CSV <-> JSON documents`);

// ── NORMAL — happy path ───────────────────────────────────────────────────────

test("csv_convert: CSV file converts to JSON by default (array of objects)", () => {
  executeTool("create_file", { path: "csvcvt1.csv", content: "a,b\r\n1,2\r\n3,4\r\n" });
  const r = executeTool("csv_convert", { path: "csvcvt1.csv" });
  assert.strictEqual(r.sourceFormat, "csv");
  assert.strictEqual(r.targetFormat, "json");
  assert.strictEqual(r.hasHeader, true);
  assert.deepStrictEqual(JSON.parse(r.converted), [{ a: "1", b: "2" }, { a: "3", b: "4" }]);
});

test("csv_convert: JSON file (array of flat objects) converts to CSV by default", () => {
  executeTool("create_file", { path: "csvcvt2.json", content: JSON.stringify([{ x: 1, y: "hi" }, { x: 2, y: "yo" }]) });
  const r = executeTool("csv_convert", { path: "csvcvt2.json" });
  assert.strictEqual(r.sourceFormat, "json");
  assert.strictEqual(r.targetFormat, "csv");
  const lines = r.converted.split("\r\n").filter(Boolean);
  assert.strictEqual(lines[0], "x,y");
  assert.strictEqual(lines[1], "1,hi");
  assert.strictEqual(lines[2], "2,yo");
});

test("csv_convert: has_header:false on CSV source returns raw string-array rows", () => {
  executeTool("create_file", { path: "csvcvt3.csv", content: "a,b\n1,2\n" });
  const r = executeTool("csv_convert", { path: "csvcvt3.csv", has_header: false });
  assert.deepStrictEqual(JSON.parse(r.converted), [["a", "b"], ["1", "2"]]);
});

test("csv_convert: has_header:false on JSON->CSV omits the header row", () => {
  executeTool("create_file", { path: "csvcvt4.json", content: JSON.stringify([{ a: 1, b: 2 }]) });
  const r = executeTool("csv_convert", { path: "csvcvt4.json", has_header: false });
  const lines = r.converted.split("\r\n").filter(Boolean);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], "1,2");
});

test("csv_convert: JSON array-of-arrays converts to CSV rows as-is", () => {
  executeTool("create_file", { path: "csvcvt5.json", content: JSON.stringify([["a", "b"], ["1", "2"], ["3", "4"]]) });
  const r = executeTool("csv_convert", { path: "csvcvt5.json" });
  const lines = r.converted.split("\r\n").filter(Boolean);
  assert.deepStrictEqual(lines, ["a,b", "1,2", "3,4"]);
});

test("csv_convert: CSV->JSON->CSV round-trip preserves data (object mode)", () => {
  executeTool("create_file", { path: "csvcvt-rt.csv", content: "name,age\r\nAlice,30\r\nBob,25\r\n" });
  const toJson = executeTool("csv_convert", { path: "csvcvt-rt.csv" });
  executeTool("create_file", { path: "csvcvt-rt.json", content: toJson.converted });
  const backToCsv = executeTool("csv_convert", { path: "csvcvt-rt.json" });
  const lines = backToCsv.converted.split("\r\n").filter(Boolean);
  assert.deepStrictEqual(lines, ["name,age", "Alice,30", "Bob,25"]);
});

test("csv_convert: destination writes the converted file to disk", () => {
  executeTool("create_file", { path: "csvcvt6.csv", content: "k,v\r\nfoo,bar\r\n" });
  const r = executeTool("csv_convert", { path: "csvcvt6.csv", destination: "csvcvt6-out.json" });
  assert.strictEqual(r.written, true);
  assert.strictEqual(r.destination, "csvcvt6-out.json");
  const { resolved } = resolveClientPath("csvcvt6-out.json");
  assert.ok(fs.existsSync(resolved));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(resolved, "utf8")), [{ k: "foo", v: "bar" }]);
});

test("csv_convert: explicit indent controls JSON target spacing", () => {
  executeTool("create_file", { path: "csvcvt7.csv", content: "a\r\n1\r\n" });
  const r = executeTool("csv_convert", { path: "csvcvt7.csv", indent: 4 });
  assert.strictEqual(r.indent, 4);
  assert.ok(r.converted.includes('    "a": "1"'));
});

// ── MEDIUM — boundary & param validation ──────────────────────────────────────

test("csv_convert: missing required 'path' throws -32602", () => {
  try {
    executeTool("csv_convert", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("csv_convert: non-existent source file throws cleanly", () => {
  assert.throws(() => executeTool("csv_convert", { path: "does-not-exist.csv" }));
});

test("csv_convert: a directory passed as path throws a descriptive error", () => {
  executeTool("create_directory", { path: "csvcvt-dir" });
  assert.throws(
    () => executeTool("csv_convert", { path: "csvcvt-dir" }),
    /directory, not a file/
  );
});

test("csv_convert: invalid 'to' value throws -32602", () => {
  executeTool("create_file", { path: "csvcvt8.csv", content: "a\n1\n" });
  assert.throws(
    () => executeTool("csv_convert", { path: "csvcvt8.csv", to: "xml" }),
    /unsupported target format/
  );
});

test("csv_convert: invalid 'format' override value throws -32602", () => {
  executeTool("create_file", { path: "csvcvt9.csv", content: "a\n1\n" });
  assert.throws(
    () => executeTool("csv_convert", { path: "csvcvt9.csv", format: "tsv" }),
    /unsupported source format/
  );
});

test("csv_convert: source and target format both the same is rejected (nothing to convert)", () => {
  executeTool("create_file", { path: "csvcvt10.csv", content: "a\n1\n" });
  assert.throws(
    () => executeTool("csv_convert", { path: "csvcvt10.csv", to: "csv" }),
    /nothing to convert/
  );
});

test("csv_convert: apply:false with a destination previews without writing", () => {
  executeTool("create_file", { path: "csvcvt11.csv", content: "z\r\n9\r\n" });
  const r = executeTool("csv_convert", { path: "csvcvt11.csv", destination: "csvcvt11-preview.json", apply: false });
  assert.strictEqual(r.written, false);
  const { resolved } = resolveClientPath("csvcvt11-preview.json");
  assert.strictEqual(fs.existsSync(resolved), false);
  assert.ok(r.converted.includes('"9"'));
});

test("csv_convert: no destination given never writes anything, only returns converted text", () => {
  executeTool("create_file", { path: "csvcvt12.csv", content: "q\r\n1\r\n" });
  const r = executeTool("csv_convert", { path: "csvcvt12.csv" });
  assert.strictEqual(r.destination, undefined);
  assert.strictEqual(r.written, undefined);
});

test("csv_convert: empty CSV (header only, no data rows) converts to an empty JSON array", () => {
  executeTool("create_file", { path: "csvcvt-empty.csv", content: "a,b\r\n" });
  const r = executeTool("csv_convert", { path: "csvcvt-empty.csv" });
  assert.deepStrictEqual(JSON.parse(r.converted), []);
});

test("csv_convert: empty JSON array converts to empty CSV text", () => {
  executeTool("create_file", { path: "csvcvt-empty.json", content: "[]" });
  const r = executeTool("csv_convert", { path: "csvcvt-empty.json" });
  assert.strictEqual(r.converted, "");
});

// ── HIGH — malformed input / shape validation ─────────────────────────────────

test("csv_convert: malformed source JSON throws a descriptive parse error", () => {
  executeTool("create_file", { path: "csvcvt-bad.json", content: "{not valid json" });
  assert.throws(
    () => executeTool("csv_convert", { path: "csvcvt-bad.json" }),
    /failed to parse source as json/
  );
});

test("csv_convert: JSON source that is not an array throws a descriptive error", () => {
  executeTool("create_file", { path: "csvcvt-notarr.json", content: JSON.stringify({ a: 1 }) });
  assert.throws(
    () => executeTool("csv_convert", { path: "csvcvt-notarr.json" }),
    /must be an array/
  );
});

test("csv_convert: mixed object+array elements in the JSON source array throws a descriptive error", () => {
  executeTool("create_file", { path: "csvcvt-mixed.json", content: JSON.stringify([{ a: 1 }, ["b", 2]]) });
  assert.throws(
    () => executeTool("csv_convert", { path: "csvcvt-mixed.json" }),
    /flat object.*every element must be an array|Mixed\/invalid shapes/
  );
});

test("csv_convert: array of bare primitives (not objects/arrays) in the JSON source throws a descriptive error", () => {
  executeTool("create_file", { path: "csvcvt-prim.json", content: JSON.stringify([1, 2, 3]) });
  assert.throws(
    () => executeTool("csv_convert", { path: "csvcvt-prim.json" }),
    /flat object|Mixed\/invalid shapes/
  );
});

test("csv_convert: quoted CSV fields with embedded commas/newlines round-trip correctly (RFC 4180)", () => {
  executeTool("create_file", { path: "csvcvt-quoted.csv", content: 'a,b\r\n"hello, world","line1\nline2"\r\n' });
  const r = executeTool("csv_convert", { path: "csvcvt-quoted.csv" });
  assert.deepStrictEqual(JSON.parse(r.converted), [{ a: "hello, world", b: "line1\nline2" }]);
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("csv_convert: path traversal on source 'path' is blocked", () => {
  assert.throws(() => executeTool("csv_convert", { path: "../../../../etc/passwd.csv" }));
});

test("csv_convert: path traversal on 'destination' is blocked", () => {
  executeTool("create_file", { path: "csvcvt-trav.csv", content: "a\n1\n" });
  assert.throws(() => executeTool("csv_convert", { path: "csvcvt-trav.csv", destination: "../../../../tmp/evil.json" }));
});

test("csv_convert: shell/SQL-injection-shaped field values round-trip literally through the conversion", () => {
  const payload = [{ cmd: "; rm -rf / $(whoami)", sql: "'; DROP TABLE users; --" }];
  executeTool("create_file", { path: "csvcvt-inj.json", content: JSON.stringify(payload) });
  const toCsv = executeTool("csv_convert", { path: "csvcvt-inj.json" });
  executeTool("create_file", { path: "csvcvt-inj.csv", content: toCsv.converted });
  const backToJson = executeTool("csv_convert", { path: "csvcvt-inj.csv" });
  assert.deepStrictEqual(JSON.parse(backToJson.converted), payload);
});

test("csv_convert: field values containing commas/quotes are correctly quoted/escaped, never break CSV structure", () => {
  const payload = [{ note: 'has "quotes" and, a comma' }];
  executeTool("create_file", { path: "csvcvt-esc.json", content: JSON.stringify(payload) });
  const toCsv = executeTool("csv_convert", { path: "csvcvt-esc.json" });
  executeTool("create_file", { path: "csvcvt-esc.csv", content: toCsv.converted });
  const backToJson = executeTool("csv_convert", { path: "csvcvt-esc.csv" });
  assert.deepStrictEqual(JSON.parse(backToJson.converted), payload);
});

test("csv_convert: __proto__-shaped key in JSON source is harmless (no prototype pollution)", () => {
  executeTool("create_file", { path: "csvcvt-proto.json", content: '[{"__proto__":{"polluted":true}}]' });
  const r = executeTool("csv_convert", { path: "csvcvt-proto.json" });
  assert.strictEqual(({}).polluted, undefined);
  assert.ok(typeof r.converted === "string");
});

// ── EXTREME — fuzzing, concurrency, large payloads ────────────────────────────

test("csv_convert: large document (500 rows) converts correctly both directions", () => {
  const rows = [];
  for (let i = 0; i < 500; i++) rows.push({ id: i, name: `row${i}` });
  executeTool("create_file", { path: "csvcvt-big.json", content: JSON.stringify(rows) });
  const toCsv = executeTool("csv_convert", { path: "csvcvt-big.json" });
  executeTool("create_file", { path: "csvcvt-big.csv", content: toCsv.converted });
  const backToJson = executeTool("csv_convert", { path: "csvcvt-big.csv" });
  const parsed = JSON.parse(backToJson.converted);
  assert.strictEqual(parsed.length, 500);
  assert.strictEqual(parsed[0].id, "0");
  assert.strictEqual(parsed[499].name, "row499");
});

test("csv_convert: 10 concurrent (sequential-simulated) calls on the same file return consistent results", () => {
  executeTool("create_file", { path: "csvcvt-conc.csv", content: "n\r\n42\r\n" });
  const results = Array.from({ length: 10 }, () => executeTool("csv_convert", { path: "csvcvt-conc.csv" }));
  const first = results[0].converted;
  for (const r of results) assert.strictEqual(r.converted, first);
});

test("csv_convert: fuzz — random garbage bytes as JSON source content throws cleanly, never crashes", () => {
  const crypto = require("crypto");
  for (let i = 0; i < 10; i++) {
    const garbage = crypto.randomBytes(30).toString("latin1");
    executeTool("create_file", { path: "csvcvt-fuzz.json", content: garbage });
    try {
      executeTool("csv_convert", { path: "csvcvt-fuzz.json" });
    } catch (e) {
      assert.ok(e instanceof Error);
    }
    executeTool("delete_file", { path: "csvcvt-fuzz.json" });
  }
});

test("csv_convert: result is fully JSON-serialisable (no circular refs, no undefined leaking into JSON)", () => {
  executeTool("create_file", { path: "csvcvt-json-ser.csv", content: "a\r\n1\r\n" });
  const r = executeTool("csv_convert", { path: "csvcvt-json-ser.csv" });
  const json = JSON.stringify(r);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.converted, r.converted);
});

test("csv_convert: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("csv_convert"), "csv_convert missing from execute_pipeline op enum");
});

test("csv_convert: is registered in the WRITE_TOOLS set (write-gated under MCP_READ_ONLY)", () => {
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  assert.ok(WRITE_TOOLS.has("csv_convert"), "csv_convert missing from WRITE_TOOLS set");
});

test("cleanup: remove csv_convert fixture files created in this section", () => {
  for (const f of [
    "csvcvt1.csv", "csvcvt2.json", "csvcvt3.csv", "csvcvt4.json", "csvcvt5.json",
    "csvcvt-rt.csv", "csvcvt-rt.json", "csvcvt6.csv", "csvcvt6-out.json",
    "csvcvt7.csv", "csvcvt8.csv", "csvcvt9.csv", "csvcvt10.csv", "csvcvt11.csv",
    "csvcvt11-preview.json", "csvcvt12.csv", "csvcvt-empty.csv", "csvcvt-empty.json",
    "csvcvt-bad.json", "csvcvt-notarr.json", "csvcvt-mixed.json", "csvcvt-prim.json",
    "csvcvt-quoted.csv", "csvcvt-trav.csv", "csvcvt-inj.json", "csvcvt-inj.csv",
    "csvcvt-esc.json", "csvcvt-esc.csv", "csvcvt-proto.json", "csvcvt-big.json",
    "csvcvt-big.csv", "csvcvt-conc.csv", "csvcvt-json-ser.csv",
  ]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
  try { fs.rmdirSync(resolveClientPath("csvcvt-dir").resolved); } catch (_) {}
});
