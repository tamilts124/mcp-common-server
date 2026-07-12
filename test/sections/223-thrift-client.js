"use strict";
// test/sections/223-thrift-client.js
// Isolated tests for the thrift_client tool (lib/thriftClientOps.js)
// Five rigor levels: A=validation, B=unit, C=happy-path, D=security, E=error-paths, F=concurrency

const path = require("path");
const fs   = require("fs");
const os   = require("os");

const {
  thriftClient, encode, decode, resolveSchema,
  binaryWriteValue, binaryReadValue,
  compactWriteValue, compactReadValue,
  BufWriter, BufReader,
  T_BOOL, T_BYTE, T_I16, T_I32, T_I64, T_DOUBLE, T_STRING, T_STRUCT,
  T_MAP, T_SET, T_LIST, T_UUID, T_STOP,
} = require("../../lib/thriftClientOps");

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message || String(e) });
    process.stderr.write(`  FAIL: ${name}\n       ${e.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || "not equal") + `\n  got:      ${sa}\n  expected: ${sb}`);
}

function assertThrows(fn, msgSubstr) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgSubstr && !e.message.includes(msgSubstr))
      throw new Error(`Expected error containing '${msgSubstr}' but got: ${e.message}`);
  }
  if (!threw) throw new Error(`Expected error containing '${msgSubstr || ""}' but none thrown`);
}

// Fake resolveClientPath for tests
function fakeResolve(p) {
  return { resolved: path.isAbsolute(p) ? p : path.resolve(p) };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thrift-test-"));
function tmpFile(name) { return path.join(tmpDir, name); }

// ── Helper schemas ────────────────────────────────────────────────────────────

const personSchema = {
  type: "struct",
  fields: [
    { id: 1, name: "name",   type: "string", required: true },
    { id: 2, name: "age",    type: "i32" },
    { id: 3, name: "active", type: "bool" },
    { id: 4, name: "score",  type: "double" },
  ],
};

const nestedSchema = {
  type: "struct",
  fields: [
    { id: 1, name: "id",     type: "i64" },
    { id: 2, name: "person", type: personSchema },
  ],
};

// ── A: Validation tests (x10) ────────────────────────────────────────────────

process.stderr.write("\n=== A: Validation ===\n");

test("A1 - missing operation throws", () => {
  assertThrows(() => thriftClient({}, fakeResolve), "Unknown operation");
});

test("A2 - invalid operation name throws", () => {
  assertThrows(() => thriftClient({ operation: "compress" }, fakeResolve), "Unknown operation");
});

test("A3 - invalid protocol throws", () => {
  assertThrows(
    () => thriftClient({ operation: "encode", schema: "i32", value: 1, protocol: "json" }, fakeResolve),
    "Unknown protocol"
  );
});

test("A4 - encode without schema throws", () => {
  assertThrows(
    () => thriftClient({ operation: "encode", value: 42 }, fakeResolve),
    "'schema' is required"
  );
});

test("A5 - encode without value or json_file throws", () => {
  assertThrows(
    () => thriftClient({ operation: "encode", schema: "i32" }, fakeResolve),
    "provide 'value' or 'json_file'"
  );
});

test("A6 - decode without schema throws", () => {
  assertThrows(
    () => thriftClient({ operation: "decode", hex: "00000001" }, fakeResolve),
    "'schema' is required"
  );
});

test("A7 - decode without binary input throws", () => {
  assertThrows(
    () => thriftClient({ operation: "decode", schema: "i32" }, fakeResolve),
    "Provide one of"
  );
});

test("A8 - encode_file missing path throws", () => {
  assertThrows(
    () => thriftClient({ operation: "encode_file", schema: "i32", output: "/tmp/x.bin" }, fakeResolve),
    "'path'"
  );
});

test("A9 - decode_file missing schema throws", () => {
  const bin = tmpFile("missing_schema.bin");
  fs.writeFileSync(bin, Buffer.from([0x00, 0x00, 0x00, 0x05]));
  assertThrows(
    () => thriftClient({ operation: "decode_file", path: bin }, fakeResolve),
    "'schema' is required"
  );
});

test("A10 - invalid schema type string throws", () => {
  assertThrows(
    () => thriftClient({ operation: "encode", schema: "uint32", value: 1 }, fakeResolve),
    "Unknown primitive type"
  );
});

// ── B: Unit tests — primitives and protocol details (x20) ────────────────────

process.stderr.write("\n=== B: Unit ===\n");

test("B1 - resolveSchema: 'i32' -> kind T_I32", () => {
  const s = resolveSchema("i32");
  assertEq(s.kind, T_I32);
});

test("B2 - resolveSchema: 'byte' -> kind T_BYTE", () => {
  const s = resolveSchema("byte");
  assertEq(s.kind, T_BYTE);
});

test("B3 - resolveSchema: 'i8' -> kind T_BYTE", () => {
  assertEq(resolveSchema("i8").kind, T_BYTE);
});

test("B4 - resolveSchema: 'uuid' -> kind T_UUID", () => {
  assertEq(resolveSchema("uuid").kind, T_UUID);
});

test("B5 - resolveSchema: unknown type throws", () => {
  assertThrows(() => resolveSchema({ type: "float" }), "Unknown schema type");
});

test("B6 - binary: encode/decode i32 round-trip", () => {
  const schema = resolveSchema("i32");
  const buf = encode(schema, -12345, "binary");
  assertEq(buf.length, 4);
  const { value } = decode(schema, buf, "binary");
  assertEq(value, -12345);
});

test("B7 - binary: encode/decode bool round-trip", () => {
  const schema = resolveSchema("bool");
  for (const v of [true, false]) {
    const { value } = decode(schema, encode(schema, v, "binary"), "binary");
    assertEq(value, v);
  }
});

test("B8 - binary: encode/decode double round-trip", () => {
  const schema = resolveSchema("double");
  const { value } = decode(schema, encode(schema, 3.14159, "binary"), "binary");
  assert(Math.abs(value - 3.14159) < 1e-10, `double mismatch: ${value}`);
});

test("B9 - binary: encode/decode i64 round-trip", () => {
  const schema = resolveSchema("i64");
  const { value } = decode(schema, encode(schema, 9007199254740993n, "binary"), "binary");
  assertEq(value, { __i64: "9007199254740993" });
});

test("B10 - binary: encode/decode string round-trip", () => {
  const schema = resolveSchema("string");
  const { value } = decode(schema, encode(schema, "Hello, Thrift!", "binary"), "binary");
  assertEq(value, "Hello, Thrift!");
});

test("B11 - binary: encode/decode struct round-trip", () => {
  const schema = resolveSchema(personSchema);
  const obj = { name: "Alice", age: 30, active: true, score: 9.5 };
  const { value } = decode(schema, encode(schema, obj, "binary"), "binary");
  assertEq(value.name, "Alice");
  assertEq(value.age, 30);
  assertEq(value.active, true);
  assert(Math.abs(value.score - 9.5) < 1e-9);
});

test("B12 - binary: encode/decode list round-trip", () => {
  const schema = resolveSchema({ type: "list", valueType: "i32" });
  const arr = [1, 2, 3, 100, -5];
  const { value } = decode(schema, encode(schema, arr, "binary"), "binary");
  assertEq(value, arr);
});

test("B13 - binary: encode/decode map round-trip", () => {
  const schema = resolveSchema({ type: "map", keyType: "string", valueType: "i32" });
  const obj = { a: 1, b: 2, c: 3 };
  const { value } = decode(schema, encode(schema, obj, "binary"), "binary");
  assertEq(value.a, 1); assertEq(value.b, 2); assertEq(value.c, 3);
});

test("B14 - binary: encode/decode set round-trip", () => {
  const schema = resolveSchema({ type: "set", valueType: "i32" });
  const s = [10, 20, 30];
  const { value } = decode(schema, encode(schema, s, "binary"), "binary");
  assertEq(value, s);
});

test("B15 - binary: encode UUID round-trip", () => {
  const schema = resolveSchema("uuid");
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const { value } = decode(schema, encode(schema, uuid, "binary"), "binary");
  assertEq(value, uuid);
});

test("B16 - compact: encode/decode i32 round-trip", () => {
  const schema = resolveSchema("i32");
  const buf = encode(schema, -99, "compact");
  const { value } = decode(schema, buf, "compact");
  assertEq(value, -99);
});

test("B17 - compact: encode/decode string round-trip", () => {
  const schema = resolveSchema("string");
  const { value } = decode(schema, encode(schema, "compact!", "compact"), "compact");
  assertEq(value, "compact!");
});

test("B18 - compact: encode/decode struct round-trip", () => {
  const schema = resolveSchema(personSchema);
  const obj = { name: "Bob", age: 25, active: false, score: 7.77 };
  const { value } = decode(schema, encode(schema, obj, "compact"), "compact");
  assertEq(value.name, "Bob");
  assertEq(value.age, 25);
  assertEq(value.active, false);
  assert(Math.abs(value.score - 7.77) < 1e-9);
});

test("B19 - compact is smaller than binary for large ints", () => {
  const schema = resolveSchema("i32");
  const binBuf = encode(schema, 1, "binary");
  const cmpBuf = encode(schema, 1, "compact");
  assert(binBuf.length > cmpBuf.length, `compact should be smaller: bin=${binBuf.length} compact=${cmpBuf.length}`);
});

test("B20 - nested struct round-trip (binary)", () => {
  const schema = resolveSchema(nestedSchema);
  const obj = { id: 42n, person: { name: "Carol", age: 35, active: true, score: 5.0 } };
  const { value } = decode(schema, encode(schema, obj, "binary"), "binary");
  assertEq(value.id, 42);
  assertEq(value.person.name, "Carol");
});

// ── C: Happy-path tests using thriftClient() (x20) ──────────────────────────

process.stderr.write("\n=== C: Happy-path ===\n");

test("C1 - encode i32 returns hex+base64", () => {
  const r = thriftClient({ operation: "encode", schema: "i32", value: 42 }, fakeResolve);
  assertEq(r.operation, "encode");
  assertEq(r.protocol, "binary");
  assertEq(r.sizeBytes, 4);
  assert(typeof r.hex === "string" && r.hex.length === 8);
  assert(typeof r.base64 === "string");
});

test("C2 - decode i32 from hex", () => {
  const enc = thriftClient({ operation: "encode", schema: "i32", value: 1234 }, fakeResolve);
  const dec = thriftClient({ operation: "decode", schema: "i32", hex: enc.hex }, fakeResolve);
  assertEq(dec.value, 1234);
  assertEq(dec.bytesConsumed, 4);
});

test("C3 - decode i32 from base64", () => {
  const enc = thriftClient({ operation: "encode", schema: "i32", value: -1 }, fakeResolve);
  const dec = thriftClient({ operation: "decode", schema: "i32", base64: enc.base64 }, fakeResolve);
  assertEq(dec.value, -1);
});

test("C4 - encode bool true", () => {
  const r = thriftClient({ operation: "encode", schema: "bool", value: true }, fakeResolve);
  assertEq(r.hex, "01");
});

test("C5 - encode bool false", () => {
  const r = thriftClient({ operation: "encode", schema: "bool", value: false }, fakeResolve);
  assertEq(r.hex, "00");
});

test("C6 - encode string", () => {
  const r = thriftClient({ operation: "encode", schema: "string", value: "hi" }, fakeResolve);
  // 4-byte length (0x00000002) + 2 bytes data
  assertEq(r.sizeBytes, 6);
});

test("C7 - encode struct (binary) and decode", () => {
  const enc = thriftClient({
    operation: "encode", schema: personSchema,
    value: { name: "Dave", age: 40, active: true, score: 100.0 },
  }, fakeResolve);
  const dec = thriftClient({ operation: "decode", schema: personSchema, hex: enc.hex }, fakeResolve);
  assertEq(dec.value.name, "Dave");
  assertEq(dec.value.age, 40);
  assertEq(dec.value.active, true);
});

test("C8 - encode struct (compact) and decode", () => {
  const enc = thriftClient({
    operation: "encode", schema: personSchema, protocol: "compact",
    value: { name: "Eve", age: 22, active: false, score: 0.5 },
  }, fakeResolve);
  const dec = thriftClient({ operation: "decode", schema: personSchema, hex: enc.hex, protocol: "compact" }, fakeResolve);
  assertEq(dec.value.name, "Eve");
  assertEq(dec.value.age, 22);
});

test("C9 - encode from json_file", () => {
  const jf = tmpFile("person.json");
  fs.writeFileSync(jf, JSON.stringify({ name: "Frank", age: 50, active: true, score: 3.14 }));
  const r = thriftClient({ operation: "encode", schema: personSchema, json_file: jf }, fakeResolve);
  assert(r.sizeBytes > 0);
});

test("C10 - encode to output_file", () => {
  const outF = tmpFile("out_i32.bin");
  const r = thriftClient({ operation: "encode", schema: "i32", value: 77, output_file: outF }, fakeResolve);
  assertEq(r.savedTo, outF);
  const bytes = fs.readFileSync(outF);
  assertEq(bytes.length, 4);
});

test("C11 - encode to output_file with include_hex", () => {
  const outF = tmpFile("out_hex.bin");
  const r = thriftClient({ operation: "encode", schema: "i32", value: 9, output_file: outF, include_hex: true }, fakeResolve);
  assert(typeof r.hex === "string");
  assert(r.base64 === undefined);
});

test("C12 - encode/decode i64 BigInt", () => {
  const large = 9007199254740993n;
  const enc = thriftClient({ operation: "encode", schema: "i64", value: large }, fakeResolve);
  const dec = thriftClient({ operation: "decode", schema: "i64", hex: enc.hex }, fakeResolve);
  assertEq(dec.value, { __i64: large.toString() });
});

test("C13 - decode from input_file", () => {
  const enc = thriftClient({ operation: "encode", schema: "i32", value: 321 }, fakeResolve);
  const binF = tmpFile("input.bin");
  fs.writeFileSync(binF, Buffer.from(enc.hex, "hex"));
  const dec = thriftClient({ operation: "decode", schema: "i32", input_file: binF }, fakeResolve);
  assertEq(dec.value, 321);
});

test("C14 - encode_file", () => {
  const jf  = tmpFile("ef_in.json");
  const out = tmpFile("ef_out.bin");
  fs.writeFileSync(jf, JSON.stringify({ name: "Grace", age: 28, active: true, score: 6.6 }));
  const r = thriftClient({ operation: "encode_file", schema: personSchema, path: jf, output: out }, fakeResolve);
  assertEq(r.operation, "encode_file");
  assert(fs.existsSync(out));
  assert(r.outputBytes > 0);
});

test("C15 - decode_file", () => {
  const jf  = tmpFile("df_in.json");
  const bin = tmpFile("df_in.bin");
  fs.writeFileSync(jf, JSON.stringify({ name: "Heidi", age: 19, active: false, score: 1.1 }));
  thriftClient({ operation: "encode_file", schema: personSchema, path: jf, output: bin }, fakeResolve);
  const r = thriftClient({ operation: "decode_file", schema: personSchema, path: bin }, fakeResolve);
  assertEq(r.value.name, "Heidi");
});

test("C16 - decode_file to output JSON file", () => {
  const jf  = tmpFile("dfout_in.json");
  const bin = tmpFile("dfout_in.bin");
  const out = tmpFile("dfout_out.json");
  fs.writeFileSync(jf, JSON.stringify({ name: "Ivan", age: 33, active: true, score: 4.4 }));
  thriftClient({ operation: "encode_file", schema: personSchema, path: jf, output: bin }, fakeResolve);
  thriftClient({ operation: "decode_file", schema: personSchema, path: bin, output: out, pretty: true }, fakeResolve);
  const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
  assertEq(parsed.name, "Ivan");
});

test("C17 - inspect with schema (schema-guided)", () => {
  const enc = thriftClient({ operation: "encode", schema: "i32", value: 55 }, fakeResolve);
  const r = thriftClient({ operation: "inspect", schema: "i32", hex: enc.hex }, fakeResolve);
  assertEq(r.mode, "schema_guided");
  assertEq(r.value, 55);
});

test("C18 - inspect without schema (raw struct wire)", () => {
  const enc = thriftClient({ operation: "encode", schema: personSchema, value: { name: "Judy", age: 20, active: true, score: 2.2 } }, fakeResolve);
  const r = thriftClient({ operation: "inspect", hex: enc.hex }, fakeResolve);
  assertEq(r.mode, "raw");
  assert(Array.isArray(r.layout));
  assert(r.fieldsFound > 0);
});

test("C19 - encode list and decode", () => {
  const schema = { type: "list", valueType: "string" };
  const enc = thriftClient({ operation: "encode", schema, value: ["a", "bb", "ccc"] }, fakeResolve);
  const dec = thriftClient({ operation: "decode", schema, hex: enc.hex }, fakeResolve);
  assertEq(dec.value, ["a", "bb", "ccc"]);
});

test("C20 - encode map and decode", () => {
  const schema = { type: "map", keyType: "string", valueType: "bool" };
  const enc = thriftClient({ operation: "encode", schema, value: { x: true, y: false } }, fakeResolve);
  const dec = thriftClient({ operation: "decode", schema, hex: enc.hex }, fakeResolve);
  assertEq(dec.value.x, true);
  assertEq(dec.value.y, false);
});

// ── D: Security tests (x10) ──────────────────────────────────────────────────

process.stderr.write("\n=== D: Security ===\n");

test("D1 - NUL byte in input_file path", () => {
  assertThrows(
    () => thriftClient({ operation: "decode", schema: "i32", input_file: "/tmp/a\x00b" }, fakeResolve),
    "NUL"
  );
});

test("D2 - NUL byte in encode json_file path", () => {
  // Node rejects NUL-containing paths with a native error before any ENOENT
  assertThrows(
    () => thriftClient({ operation: "encode", schema: "i32", json_file: "/tmp/a\x00b" }, fakeResolve),
    "null bytes"
  );
});

test("D3 - directory path rejected for decode", () => {
  assertThrows(
    () => thriftClient({ operation: "decode", schema: "i32", input_file: os.tmpdir() }, fakeResolve),
    "directory"
  );
});

test("D4 - oversized hex string (odd length)", () => {
  assertThrows(
    () => thriftClient({ operation: "decode", schema: "i32", hex: "abc" }, fakeResolve),
    "even length"
  );
});

test("D5 - empty base64 input rejected", () => {
  assertThrows(
    () => thriftClient({ operation: "decode", schema: "i32", base64: "   " }, fakeResolve),
    "empty"
  );
});

test("D6 - required struct field missing throws", () => {
  const schema = { type: "struct", fields: [{ id: 1, name: "name", type: "string", required: true }] };
  assertThrows(
    () => thriftClient({ operation: "encode", schema, value: {} }, fakeResolve),
    "Required field"
  );
});

test("D7 - invalid UUID format rejected", () => {
  assertThrows(
    () => thriftClient({ operation: "encode", schema: "uuid", value: "not-a-uuid" }, fakeResolve),
    "Invalid UUID"
  );
});

test("D8 - struct schema without fields array throws", () => {
  assertThrows(
    () => resolveSchema({ type: "struct", fields: "not-an-array" }),
    "'fields' array"
  );
});

test("D9 - map missing keyType throws", () => {
  assertThrows(
    () => resolveSchema({ type: "map", valueType: "i32" }),
    "'keyType'"
  );
});

test("D10 - list missing valueType throws", () => {
  assertThrows(
    () => resolveSchema({ type: "list" }),
    "'valueType'"
  );
});

// ── E: Error-path tests (x10) ────────────────────────────────────────────────

process.stderr.write("\n=== E: Error paths ===\n");

test("E1 - decode with truncated binary throws", () => {
  // i32 needs 4 bytes, give only 2
  assertThrows(
    () => thriftClient({ operation: "decode", schema: "i32", hex: "0001" }, fakeResolve),
    "Unexpected end"
  );
});

test("E2 - decode wrong schema type still reads (binary)", () => {
  // Encoding a bool (1 byte), decoding as i16 (needs 2 bytes) => error
  const enc = thriftClient({ operation: "encode", schema: "bool", value: true }, fakeResolve);
  assertThrows(
    () => thriftClient({ operation: "decode", schema: "i16", hex: enc.hex }, fakeResolve),
    "Unexpected end"
  );
});

test("E3 - decode_file for non-existent file throws", () => {
  assertThrows(
    () => thriftClient({ operation: "decode_file", schema: "i32", path: "/nonexistent/path.bin" }, fakeResolve),
    "ENOENT"
  );
});

test("E4 - encode_file JSON parse error throws", () => {
  const bad = tmpFile("bad.json");
  fs.writeFileSync(bad, "not json {");
  assertThrows(
    () => thriftClient({ operation: "encode_file", schema: "i32", path: bad, output: tmpFile("out_bad.bin") }, fakeResolve),
    "Unexpected"
  );
});

test("E5 - coerce non-bool to bool throws", () => {
  assertThrows(
    () => thriftClient({ operation: "encode", schema: "bool", value: "maybe" }, fakeResolve),
    "Cannot coerce"
  );
});

test("E6 - coerce string to i64 non-numeric throws", () => {
  assertThrows(
    () => thriftClient({ operation: "encode", schema: "i64", value: "not-a-number" }, fakeResolve),
    "Cannot parse"
  );
});

test("E7 - inspect on empty hex returns empty layout", () => {
  // Empty hex -> no bytes -> no fields parsed
  const r = thriftClient({ operation: "inspect", hex: "" }, fakeResolve);
  assert(r.mode === "raw");
  assertEq(r.fieldsFound, 0);
});

test("E8 - compact decode of binary-encoded data fails gracefully", () => {
  // Binary i32 is 4 bytes big-endian; decode as compact i32 (zigzag varint) will produce a different value but not crash
  const enc = thriftClient({ operation: "encode", schema: "i32", value: 100, protocol: "binary" }, fakeResolve);
  // Should not throw; just produce a different (garbage) value
  const r = thriftClient({ operation: "decode", schema: "i32", hex: enc.hex, protocol: "compact" }, fakeResolve);
  assert(r.value !== undefined);
});

test("E9 - JSON-string schema input is parsed", () => {
  const r = thriftClient({ operation: "encode", schema: JSON.stringify("i32"), value: 7 }, fakeResolve);
  assertEq(r.value, undefined); // encode returns no value field, just check no error
  assertEq(r.sizeBytes, 4);
});

test("E10 - inspect with max_depth=1 limits depth", () => {
  const enc = thriftClient({ operation: "encode", schema: nestedSchema, value: { id: 1n, person: { name: "X", age: 1, active: false, score: 0.0 } } }, fakeResolve);
  const r = thriftClient({ operation: "inspect", hex: enc.hex, max_depth: 1 }, fakeResolve);
  assertEq(r.mode, "raw");
  assert(Array.isArray(r.layout));
});

// ── F: Concurrency tests (x6) ────────────────────────────────────────────────

process.stderr.write("\n=== F: Concurrency ===\n");

test("F1 - parallel encode i32 (10 goroutines)", async () => {
  const schema = resolveSchema("i32");
  const tasks = Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => {
    const { value } = decode(schema, encode(schema, i * 100, "binary"), "binary");
    assertEq(value, i * 100);
  }));
  await Promise.all(tasks);
});

test("F2 - parallel encode/decode struct (binary)", async () => {
  const schema = resolveSchema(personSchema);
  const tasks = Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => {
    const obj = { name: `P${i}`, age: i * 2, active: i % 2 === 0, score: i * 1.5 };
    const { value } = decode(schema, encode(schema, obj, "binary"), "binary");
    assertEq(value.name, obj.name);
    assertEq(value.age, obj.age);
  }));
  await Promise.all(tasks);
});

test("F3 - parallel encode/decode struct (compact)", async () => {
  const schema = resolveSchema(personSchema);
  const tasks = Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => {
    const obj = { name: `CP${i}`, age: i, active: true, score: i * 0.7 };
    const { value } = decode(schema, encode(schema, obj, "compact"), "compact");
    assertEq(value.name, obj.name);
  }));
  await Promise.all(tasks);
});

test("F4 - parallel inspect calls", async () => {
  const schema = resolveSchema("i32");
  const tasks = Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => {
    const buf = encode(schema, i, "binary");
    const r = thriftClient({ operation: "inspect", schema: "i32", hex: buf.toString("hex") }, fakeResolve);
    assertEq(r.value, i);
  }));
  await Promise.all(tasks);
});

test("F5 - parallel encode_file / decode_file", async () => {
  const schema = resolveSchema(personSchema);
  const tasks = Array.from({ length: 5 }, (_, i) => Promise.resolve().then(() => {
    const jf  = tmpFile(`par${i}.json`);
    const bin = tmpFile(`par${i}.bin`);
    fs.writeFileSync(jf, JSON.stringify({ name: `Par${i}`, age: i + 10, active: true, score: i * 2.0 }));
    thriftClient({ operation: "encode_file", schema: personSchema, path: jf, output: bin }, fakeResolve);
    const r = thriftClient({ operation: "decode_file", schema: personSchema, path: bin }, fakeResolve);
    assertEq(r.value.name, `Par${i}`);
  }));
  await Promise.all(tasks);
});

test("F6 - parallel mixed protocols", async () => {
  const schema = resolveSchema("string");
  const texts  = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const tasks  = texts.flatMap(t => [
    Promise.resolve().then(() => {
      const { value } = decode(schema, encode(schema, t, "binary"),  "binary");
      assertEq(value, t);
    }),
    Promise.resolve().then(() => {
      const { value } = decode(schema, encode(schema, t, "compact"), "compact");
      assertEq(value, t);
    }),
  ]);
  await Promise.all(tasks);
});

// ── Cleanup ──────────────────────────────────────────────────────────────────

try {
  for (const f of fs.readdirSync(tmpDir))
    fs.unlinkSync(path.join(tmpDir, f));
  fs.rmdirSync(tmpDir);
} catch (_) {}

// ── Summary ──────────────────────────────────────────────────────────────────

process.stderr.write(`\n=== Results ===\nPassed: ${passed}\nFailed: ${failed}\n`);
if (failures.length) {
  process.stderr.write("\nFailed tests:\n");
  for (const { name, error } of failures)
    process.stderr.write(`  - ${name}: ${error}\n`);
}
process.exit(failed > 0 ? 1 : 0);
