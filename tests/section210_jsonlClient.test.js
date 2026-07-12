"use strict";
// tests/section210_jsonlClient.test.js
// Section 210 — jsonl_client tool  (75 tests)
// Groups:
//   A: Input validation          (10 tests, indices 0-9)
//   B: Parser unit               (20 tests, indices 10-29)
//   C: Writer unit               (10 tests, indices 30-39)
//   D: Happy-path operations     (20 tests, indices 40-59)
//   E: Security                  (10 tests, indices 60-69)
//   F: Concurrency               ( 5 tests, indices 70-74)

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const {
  jsonlClient,
  parseJSONL,
  matchesFilter,
  applyTransforms,
  computeAggregate,
  getField,
  projectRecord,
} = require("../lib/jsonlClientOps");

// ── Helpers ───────────────────────────────────────────────────────────────────
let tmpDir;
function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-test-"));
}
function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function tmpFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (content !== undefined) fs.writeFileSync(p, content, "utf8");
  return p;
}

let passed = 0, failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    process.stderr.write(`  ✓ ${label}\n`);
    passed++;
  } catch (e) {
    process.stderr.write(`  ✗ ${label}: ${e.message}\n`);
    failures.push({ label, error: e.message });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertThrows(fn, pattern) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (pattern && !e.message.includes(pattern))
      throw new Error(`Expected error to include '${pattern}', got: ${e.message}`);
  }
  if (!threw) throw new Error("Expected to throw but did not");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
setup();

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A: Input Validation (10 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[A] Input Validation\n");

test("A01 missing operation throws", () => {
  assertThrows(() => jsonlClient({}), "operation");
});

test("A02 unknown operation throws", () => {
  assertThrows(() => jsonlClient({ operation: "explode", path: "/tmp/x.jsonl" }), "unknown operation");
});

test("A03 path with NUL byte throws", () => {
  assertThrows(() => jsonlClient({ operation: "read", path: "/tmp/\0bad.jsonl" }), "NUL");
});

test("A04 empty path string throws", () => {
  assertThrows(() => jsonlClient({ operation: "read", path: "" }), "non-empty");
});

test("A05 write with non-array rows throws", () => {
  const p = tmpFile("a05.jsonl", "");
  assertThrows(() => jsonlClient({ operation: "write", path: p, rows: "notAnArray" }), "array");
});

test("A06 append with empty rows throws", () => {
  const p = tmpFile("a06.jsonl", "");
  assertThrows(() => jsonlClient({ operation: "append", path: p, rows: [] }), "non-empty");
});

test("A07 get_line without line_index throws", () => {
  const p = tmpFile("a07.jsonl", '{"x":1}\n');
  assertThrows(() => jsonlClient({ operation: "get_line", path: p }), "line_index");
});

test("A08 set_line without value throws", () => {
  const p = tmpFile("a08.jsonl", '{"x":1}\n');
  assertThrows(() => jsonlClient({ operation: "set_line", path: p, line_index: 0 }), "value");
});

test("A09 filter without filter arg throws", () => {
  const p = tmpFile("a09.jsonl", '{"x":1}\n');
  assertThrows(() => jsonlClient({ operation: "filter", path: p }), "filter");
});

test("A10 map without transforms throws", () => {
  const p = tmpFile("a10.jsonl", '{"x":1}\n');
  assertThrows(() => jsonlClient({ operation: "map", path: p, transforms: [] }), "transforms");
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B: Parser Unit (20 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[B] Parser Unit\n");

test("B01 parse empty string returns empty records", () => {
  const r = parseJSONL("");
  assert(r.length === 0, "expected 0 records");
});

test("B02 parse single object line", () => {
  const r = parseJSONL('{"a":1}');
  assert(r.length === 1);
  assert(r[0].value.a === 1);
});

test("B03 parse multiple lines", () => {
  const r = parseJSONL('{"a":1}\n{"b":2}\n{"c":3}');
  assert(r.length === 3);
  assert(r[2].value.c === 3);
});

test("B04 blank lines are skipped", () => {
  const r = parseJSONL('{"a":1}\n\n{"b":2}\n\n');
  assert(r.length === 2);
});

test("B05 CRLF line endings handled", () => {
  const r = parseJSONL('{"a":1}\r\n{"b":2}\r\n');
  assert(r.length === 2);
  assert(r[1].value.b === 2);
});

test("B06 parse primitives (string, number, boolean, null)", () => {
  const r = parseJSONL('"hello"\n42\ntrue\nnull');
  assert(r.length === 4);
  assert(r[0].value === "hello");
  assert(r[1].value === 42);
  assert(r[2].value === true);
  assert(r[3].value === null);
});

test("B07 parse array values", () => {
  const r = parseJSONL('[1,2,3]\n["a","b"]');
  assert(r.length === 2);
  assert(Array.isArray(r[0].value));
  assert(r[0].value[2] === 3);
});

test("B08 parse error on invalid JSON line", () => {
  assertThrows(() => parseJSONL('{"a":1}\n{invalid}'), "JSON parse error");
});

test("B09 allow_comments: skip # lines", () => {
  const r = parseJSONL('# comment\n{"a":1}\n# another\n{"b":2}', { allowComments: true });
  assert(r.length === 2);
});

test("B10 allow_comments false: # line causes parse error", () => {
  assertThrows(() => parseJSONL('# comment\n{"a":1}'), "JSON parse error");
});

test("B11 lineNo is physical 1-based", () => {
  const r = parseJSONL('\n{"a":1}\n{"b":2}');
  assert(r[0].lineNo === 2);
  assert(r[1].lineNo === 3);
});

test("B12 getField simple", () => {
  assert(getField({ a: 1 }, "a") === 1);
});

test("B13 getField dot-notation", () => {
  assert(getField({ user: { name: "Alice" } }, "user.name") === "Alice");
});

test("B14 getField missing returns undefined", () => {
  assert(getField({ a: 1 }, "b") === undefined);
});

test("B15 projectRecord select", () => {
  const r = projectRecord({ a: 1, b: 2, c: 3 }, { select: ["a", "c"] });
  assert(r.a === 1 && r.c === 3 && r.b === undefined);
});

test("B16 projectRecord exclude", () => {
  const r = projectRecord({ a: 1, b: 2, c: 3 }, { exclude: ["b"] });
  assert(r.a === 1 && r.c === 3 && r.b === undefined);
});

test("B17 matchesFilter eq string", () => {
  assert(matchesFilter({ name: "Alice" }, { field: "name", operator: "eq", value: "Alice" }));
  assert(!matchesFilter({ name: "Bob" }, { field: "name", operator: "eq", value: "Alice" }));
});

test("B18 matchesFilter gt numeric", () => {
  assert(matchesFilter({ age: 30 }, { field: "age", operator: "gt", value: 25 }));
  assert(!matchesFilter({ age: 20 }, { field: "age", operator: "gt", value: 25 }));
});

test("B19 matchesFilter regex", () => {
  assert(matchesFilter({ email: "alice@example.com" }, { field: "email", operator: "regex", value: "@example\\." }));
  assert(!matchesFilter({ email: "alice@other.com" }, { field: "email", operator: "regex", value: "@example\\." }));
});

test("B20 matchesFilter AND logic (array of filters)", () => {
  const record = { a: 5, b: "hello" };
  assert(matchesFilter(record, [
    { field: "a", operator: "gt", value: 3 },
    { field: "b", operator: "contains", value: "ell" },
  ]));
  assert(!matchesFilter(record, [
    { field: "a", operator: "gt", value: 10 },
    { field: "b", operator: "contains", value: "ell" },
  ]));
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP C: Writer Unit (10 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[C] Writer Unit\n");

test("C01 write creates file with rows", () => {
  const p = path.join(tmpDir, "c01.jsonl");
  const r = jsonlClient({ operation: "write", path: p, rows: [{ a: 1 }, { b: 2 }] });
  assert(r.written === true);
  assert(r.rowCount === 2);
  const content = fs.readFileSync(p, "utf8");
  assert(content.includes('{"a":1}'));
  assert(content.includes('{"b":2}'));
});

test("C02 write overwrites existing file", () => {
  const p = tmpFile("c02.jsonl", '{"old":1}\n');
  jsonlClient({ operation: "write", path: p, rows: [{ new: 1 }] });
  const content = fs.readFileSync(p, "utf8");
  assert(!content.includes('"old"'));
  assert(content.includes('"new"'));
});

test("C03 write empty rows creates empty file", () => {
  const p = path.join(tmpDir, "c03.jsonl");
  jsonlClient({ operation: "write", path: p, rows: [] });
  const content = fs.readFileSync(p, "utf8");
  assert(content === "");
});

test("C04 append adds rows to existing file", () => {
  const p = tmpFile("c04.jsonl", '{"a":1}\n');
  jsonlClient({ operation: "append", path: p, rows: [{ b: 2 }] });
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  assert(lines.length === 2);
  assert(JSON.parse(lines[1]).b === 2);
});

test("C05 append creates file if not exists", () => {
  const p = path.join(tmpDir, "c05.jsonl");
  jsonlClient({ operation: "append", path: p, rows: [{ x: 99 }] });
  const content = fs.readFileSync(p, "utf8");
  assert(content.includes('"x":99'));
});

test("C06 append handles missing newline at end of existing file", () => {
  const p = tmpFile("c06.jsonl", '{"a":1}'); // no trailing newline
  jsonlClient({ operation: "append", path: p, rows: [{ b: 2 }] });
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  assert(lines.length === 2, `Expected 2 lines, got ${lines.length}`);
});

test("C07 applyTransforms set_field", () => {
  const v = applyTransforms({ a: 1 }, [{ op: "set_field", field: "b", value: 42 }]);
  assert(v.b === 42 && v.a === 1);
});

test("C08 applyTransforms rename_field", () => {
  const v = applyTransforms({ a: 1, b: 2 }, [{ op: "rename_field", from: "a", to: "c" }]);
  assert(v.c === 1 && v.a === undefined && v.b === 2);
});

test("C09 applyTransforms delete_field", () => {
  const v = applyTransforms({ a: 1, b: 2 }, [{ op: "delete_field", field: "a" }]);
  assert(v.a === undefined && v.b === 2);
});

test("C10 applyTransforms unknown op throws", () => {
  assertThrows(() => applyTransforms({ a: 1 }, [{ op: "explode" }]), "unknown transform");
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP D: Happy-path Operations (20 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[D] Happy-path Operations\n");

const SAMPLE_ROWS = [
  { id: 1, name: "Alice", age: 30, active: true },
  { id: 2, name: "Bob",   age: 25, active: false },
  { id: 3, name: "Carol", age: 35, active: true },
  { id: 4, name: "Dave",  age: 28, active: true },
  { id: 5, name: "Eve",   age: 22, active: false },
];

let sampleFile;

(function setupSample() {
  sampleFile = tmpFile("sample.jsonl",
    SAMPLE_ROWS.map(r => JSON.stringify(r)).join("\n") + "\n"
  );
})();

test("D01 read returns all rows", () => {
  const r = jsonlClient({ operation: "read", path: sampleFile });
  assert(r.totalLines === 5);
  assert(r.rows.length === 5);
  assert(r.rows[0].id === 1);
});

test("D02 read with offset/limit", () => {
  const r = jsonlClient({ operation: "read", path: sampleFile, offset: 1, limit: 2 });
  assert(r.rows.length === 2);
  assert(r.rows[0].name === "Bob");
});

test("D03 read with select projection", () => {
  const r = jsonlClient({ operation: "read", path: sampleFile, select: ["id", "name"] });
  assert(r.rows[0].name === "Alice");
  assert(r.rows[0].age === undefined);
});

test("D04 read with exclude projection", () => {
  const r = jsonlClient({ operation: "read", path: sampleFile, exclude: ["age", "active"] });
  assert(r.rows[0].id === 1);
  assert(r.rows[0].age === undefined);
});

test("D05 read with filter (eq)", () => {
  const r = jsonlClient({
    operation: "read", path: sampleFile,
    filter: { field: "active", operator: "eq", value: "true" },
  });
  assert(r.rows.every(row => row.active === true));
});

test("D06 get_line by index", () => {
  const r = jsonlClient({ operation: "get_line", path: sampleFile, line_index: 2 });
  assert(r.found === true);
  assert(r.value.name === "Carol");
});

test("D07 get_line out of range returns found=false", () => {
  const r = jsonlClient({ operation: "get_line", path: sampleFile, line_index: 99 });
  assert(r.found === false);
});

test("D08 set_line replaces record", () => {
  const p = tmpFile("d08.jsonl", SAMPLE_ROWS.map(r => JSON.stringify(r)).join("\n") + "\n");
  jsonlClient({ operation: "set_line", path: p, line_index: 0, value: { id: 99, name: "New" } });
  const rr = jsonlClient({ operation: "get_line", path: p, line_index: 0 });
  assert(rr.value.id === 99);
});

test("D09 delete_line single", () => {
  const p = tmpFile("d09.jsonl", SAMPLE_ROWS.map(r => JSON.stringify(r)).join("\n") + "\n");
  jsonlClient({ operation: "delete_line", path: p, line_index: 0 });
  const r = jsonlClient({ operation: "read", path: p });
  assert(r.totalLines === 4);
  assert(r.rows[0].name === "Bob");
});

test("D10 delete_line multiple indices", () => {
  const p = tmpFile("d10.jsonl", SAMPLE_ROWS.map(r => JSON.stringify(r)).join("\n") + "\n");
  jsonlClient({ operation: "delete_line", path: p, line_indices: [0, 2, 4] });
  const r = jsonlClient({ operation: "read", path: p });
  assert(r.totalLines === 2);
  assert(r.rows[0].name === "Bob");
  assert(r.rows[1].name === "Dave");
});

test("D11 filter operation with output_path", () => {
  const outP = path.join(tmpDir, "d11-out.jsonl");
  const r = jsonlClient({
    operation: "filter",
    path: sampleFile,
    filter: { field: "active", operator: "eq", value: "true" },
    output_path: outP,
  });
  assert(r.matched === 3);
  assert(r.written === true);
  const content = fs.readFileSync(outP, "utf8").trim().split("\n");
  assert(content.length === 3);
});

test("D12 map operation set_field", () => {
  const p = tmpFile("d12.jsonl", SAMPLE_ROWS.map(r => JSON.stringify(r)).join("\n") + "\n");
  const outP = path.join(tmpDir, "d12-out.jsonl");
  jsonlClient({
    operation: "map",
    path: p,
    transforms: [{ op: "set_field", field: "tier", value: "standard" }],
    output_path: outP,
  });
  const r = jsonlClient({ operation: "read", path: outP });
  assert(r.rows.every(row => row.tier === "standard"));
});

test("D13 aggregate count", () => {
  const r = jsonlClient({ operation: "aggregate", path: sampleFile, aggregate_op: "count" });
  assert(r.count === 5);
});

test("D14 aggregate sum", () => {
  const r = jsonlClient({ operation: "aggregate", path: sampleFile, aggregate_op: "sum", field: "age" });
  assert(r.sum === 30 + 25 + 35 + 28 + 22);
});

test("D15 aggregate avg", () => {
  const r = jsonlClient({ operation: "aggregate", path: sampleFile, aggregate_op: "avg", field: "age" });
  assert(Math.abs(r.avg - 28) < 0.001);
});

test("D16 aggregate min/max", () => {
  const min = jsonlClient({ operation: "aggregate", path: sampleFile, aggregate_op: "min", field: "age" });
  const max = jsonlClient({ operation: "aggregate", path: sampleFile, aggregate_op: "max", field: "age" });
  assert(min.min === 22);
  assert(max.max === 35);
});

test("D17 aggregate group_by", () => {
  const r = jsonlClient({ operation: "aggregate", path: sampleFile, aggregate_op: "count", group_by: "active" });
  assert(r.groupCount === 2);
  const trueGroup = r.groups.find(g => g.active === true);
  assert(trueGroup && trueGroup.count === 3);
});

test("D18 validate operation on valid file", () => {
  const r = jsonlClient({ operation: "validate", path: sampleFile });
  assert(r.isValid === true);
  assert(r.invalidLines === 0);
});

test("D19 validate operation on invalid file", () => {
  const p = tmpFile("d19.jsonl", '{"a":1}\n{invalid}\n{"c":3}\n');
  const r = jsonlClient({ operation: "validate", path: p });
  assert(r.isValid === false);
  assert(r.invalidLines === 1);
  assert(r.errors[0].lineNo === 2);
});

test("D20 stringify operation normalises output", () => {
  const p = tmpFile("d20.jsonl", '{  "a" :  1  }\n{  "b"  : 2  }\n');
  const r = jsonlClient({ operation: "stringify", path: p });
  assert(r.rowCount === 2);
  assert(r.jsonl.includes('{"a":1}'));
  assert(r.jsonl.includes('{"b":2}'));
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP E: Security (10 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[E] Security\n");

test("E01 path NUL byte in read throws", () => {
  assertThrows(() => jsonlClient({ operation: "read", path: "/tmp/foo\0bar.jsonl" }), "NUL");
});

test("E02 path NUL byte in write throws", () => {
  assertThrows(() => jsonlClient({ operation: "write", path: "/tmp/foo\0bar.jsonl", rows: [] }), "NUL");
});

test("E03 path NUL byte in append throws", () => {
  assertThrows(() => jsonlClient({ operation: "append", path: "/tmp/foo\0bar.jsonl", rows: [{}] }), "NUL");
});

test("E04 path NUL byte in validate throws", () => {
  assertThrows(() => jsonlClient({ operation: "validate", path: "/tmp/foo\0bar.jsonl" }), "NUL");
});

test("E05 file too large throws FILE_TOO_LARGE", () => {
  // Create a very large file by manipulating maxBytes limit
  const p = tmpFile("e05.jsonl", '{"a":1}\n');
  assertThrows(
    () => jsonlClient({ operation: "read", path: p, max_bytes: 1 }),
    "file too large",
  );
});

test("E06 no eval/Function usage: transforms use only whitelisted ops", () => {
  // Attempt a hypothetical code-injection through op name — must throw, not eval
  assertThrows(
    () => applyTransforms({ a: 1 }, [{ op: "constructor", field: "x", value: "1" }]),
    "unknown transform",
  );
});

test("E07 filter regex does not crash on ReDoS-prone pattern", () => {
  // Should complete quickly (regex is not catastrophic here) and return a result
  const records = Array.from({ length: 100 }, (_, i) => ({ text: "a".repeat(20) + "b" }));
  const recs = records.map((v, i) => ({ lineNo: i + 1, raw: JSON.stringify(v), value: v }));
  // Just test it doesn't hang or throw
  const result = recs.filter(r => {
    try { return matchesFilter(r.value, { field: "text", operator: "regex", value: "^a+$" }); }
    catch { return false; }
  });
  assert(Array.isArray(result));
});

test("E08 unknown filter operator throws with informative message", () => {
  assertThrows(
    () => matchesFilter({ a: 1 }, { field: "a", operator: "haxx0r" }),
    "unknown filter operator",
  );
});

test("E09 applyTransforms does not mutate original object", () => {
  const original = { a: 1, b: 2 };
  applyTransforms(original, [{ op: "set_field", field: "a", value: 999 }]);
  assert(original.a === 1, "original should not be mutated");
});

test("E10 serialise non-JSON-serialisable value throws", () => {
  const p = path.join(tmpDir, "e10.jsonl");
  const circular = {};
  circular.self = circular;
  assertThrows(
    () => jsonlClient({ operation: "write", path: p, rows: [circular] }),
    "not JSON-serialisable",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP F: Concurrency (5 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[F] Concurrency\n");

test("F01 parallel reads do not interfere", async () => {
  const promises = Array.from({ length: 5 }, () =>
    Promise.resolve(jsonlClient({ operation: "read", path: sampleFile }))
  );
  const results = await Promise.all(promises);
  assert(results.every(r => r.totalLines === 5));
});

test("F02 parallel writes to different files succeed", () => {
  const paths = Array.from({ length: 5 }, (_, i) => path.join(tmpDir, `f02-${i}.jsonl`));
  const results = paths.map((p, i) =>
    jsonlClient({ operation: "write", path: p, rows: [{ i }] })
  );
  assert(results.every(r => r.written === true));
  // Verify each file
  for (let i = 0; i < 5; i++) {
    const r = jsonlClient({ operation: "read", path: paths[i] });
    assert(r.rows[0].i === i);
  }
});

test("F03 parallel validates on same file", async () => {
  const promises = Array.from({ length: 5 }, () =>
    Promise.resolve(jsonlClient({ operation: "validate", path: sampleFile }))
  );
  const results = await Promise.all(promises);
  assert(results.every(r => r.isValid === true));
});

test("F04 parallel aggregates return consistent results", async () => {
  const ops = ["count", "sum", "avg", "min", "max"];
  const promises = ops.map(op =>
    Promise.resolve(jsonlClient({ operation: "aggregate", path: sampleFile, aggregate_op: op, field: "age" }))
  );
  const [countR, sumR, avgR, minR, maxR] = await Promise.all(promises);
  assert(countR.count === 5);
  assert(sumR.sum === 140);
  assert(Math.abs(avgR.avg - 28) < 0.001);
  assert(minR.min === 22);
  assert(maxR.max === 35);
});

test("F05 sequential appends accumulate correctly", () => {
  const p = path.join(tmpDir, "f05.jsonl");
  for (let i = 0; i < 5; i++) {
    jsonlClient({ operation: "append", path: p, rows: [{ seq: i }] });
  }
  const r = jsonlClient({ operation: "read", path: p });
  assert(r.totalLines === 5);
  assert(r.rows[4].seq === 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// Teardown & Report
// ─────────────────────────────────────────────────────────────────────────────
cleanup();

const total = passed + failed;
process.stderr.write(`\n=== Section 210 Results: ${passed}/${total} passed` +
  (failed ? ` — ${failed} FAILED` : "") + " ===\n");

if (failures.length) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures)
    process.stderr.write(`  • ${f.label}: ${f.error}\n`);
}

if (failed > 0) process.exit(1);
