"use strict";
/**
 * test/sections/220-protobuf-client.js
 * Comprehensive tests for protobuf_client tool (section 220)
 * Rigor levels:
 *   A = validation (10 tests)
 *   B = unit/wire-type (20 tests)
 *   C = happy-path / round-trip (20 tests)
 *   D = security (10 tests)
 *   E = error paths (10 tests)
 *   F = concurrency (6 tests)
 * Total: 76 tests
 */

const path = require("path");
const fs   = require("fs");
const os   = require("os");

const {
  protobufClient,
  encodeMessage,
  decodeMessage,
  inspectBuffer,
  encodeVarint,
} = require("../../lib/protobufClientOps");

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const errors = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stderr.write("  ✓ " + name + "\n");
  } catch (e) {
    failed++;
    errors.push({ name, error: e.message });
    process.stderr.write("  ✗ " + name + " — " + e.message + "\n");
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    process.stderr.write("  ✓ " + name + "\n");
  } catch (e) {
    failed++;
    errors.push({ name, error: e.message });
    process.stderr.write("  ✗ " + name + " — " + e.message + "\n");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected)
    throw new Error((label || "assertEqual") + ": got " + JSON.stringify(actual) + ", expected " + JSON.stringify(expected));
}

function assertThrows(fn, substr, label) {
  try {
    fn();
    throw new Error((label || "assertThrows") + ": expected an error but none was thrown");
  } catch (e) {
    if (e.message.includes("expected an error but none was thrown")) throw e;
    if (substr && !e.message.includes(substr))
      throw new Error((label || "assertThrows") + ": error '" + e.message + "' does not contain '" + substr + "'");
  }
}

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "proto-test-"));
function tmpFile(name) { return path.join(TMPDIR, name); }

// Fake resolveClientPath
function resolvePath(p) { return { resolved: path.isAbsolute(p) ? p : path.join(TMPDIR, p) }; }

process.stderr.write("\n=== Section 220: protobuf_client tests ===\n\n");

// ────────────────────────────────────────────────────────────────────────────
// A — Validation tests (10)
// ────────────────────────────────────────────────────────────────────────────
process.stderr.write("A. Validation\n");

test("A01 missing operation throws", () => {
  assertThrows(() => protobufClient({}, resolvePath), "'operation' is required");
});

test("A02 invalid operation throws", () => {
  assertThrows(() => protobufClient({ operation: "banana" }, resolvePath), "unknown operation");
});

test("A03 encode: no message or json_file throws", () => {
  assertThrows(() => protobufClient({ operation: "encode" }, resolvePath), "'message' or 'json_file' is required");
});

test("A04 encode: non-object message throws", () => {
  assertThrows(() => encodeMessage("hello", null, 0), "must be a non-null object");
});

test("A05 encode: array message throws", () => {
  assertThrows(() => encodeMessage([1, 2, 3], null, 0), "must be a non-null object");
});

test("A06 encode: non-integer field key throws", () => {
  assertThrows(() => encodeMessage({ notAnInt: 42 }, null, 0), "not a valid positive integer");
});

test("A07 encode: field number 0 throws", () => {
  assertThrows(() => encodeMessage({ "0": 42 }, null, 0), "not a valid positive integer");
});

test("A08 decode: empty hex throws", () => {
  assertThrows(() => protobufClient({ operation: "decode", hex: "" }, resolvePath), "input is empty");
});

test("A09 decode: invalid hex throws", () => {
  assertThrows(() => protobufClient({ operation: "decode", hex: "zzzz" }, resolvePath), "valid even-length hex string");
});

test("A10 decode: odd-length hex throws", () => {
  assertThrows(() => protobufClient({ operation: "decode", hex: "abc" }, resolvePath), "valid even-length hex string");
});

// ────────────────────────────────────────────────────────────────────────────
// B — Unit / wire-type tests (20)
// ────────────────────────────────────────────────────────────────────────────
process.stderr.write("\nB. Unit / Wire Types\n");

test("B01 encodeVarint(0) = 0x00", () => {
  assertEqual(encodeVarint(0).toString("hex"), "00");
});

test("B02 encodeVarint(1) = 0x01", () => {
  assertEqual(encodeVarint(1).toString("hex"), "01");
});

test("B03 encodeVarint(127) = 0x7f", () => {
  assertEqual(encodeVarint(127).toString("hex"), "7f");
});

test("B04 encodeVarint(128) = 0x8001", () => {
  assertEqual(encodeVarint(128).toString("hex"), "8001");
});

test("B05 encodeVarint(300) = 0xac02", () => {
  assertEqual(encodeVarint(300).toString("hex"), "ac02");
});

test("B06 encodeVarint(2^14=16384) = 0x808001", () => {
  assertEqual(encodeVarint(16384).toString("hex"), "808001");
});

test("B07 encode field 1 int32=1", () => {
  const buf = encodeMessage({ "1": 1 }, { "1": { name: "x", type: "int32" } }, 0);
  assertEqual(buf.toString("hex"), "0801"); // tag=0x08 (field1 varint), value=0x01
});

test("B08 encode field 1 string='A'", () => {
  const buf = encodeMessage({ "1": "A" }, { "1": { name: "x", type: "string" } }, 0);
  // tag=0x0a (field1 len-delim), length=0x01, 'A'=0x41
  assertEqual(buf.toString("hex"), "0a0141");
});

test("B09 encode field 2 bool=true", () => {
  const buf = encodeMessage({ "2": true }, { "2": { name: "b", type: "bool" } }, 0);
  // tag=0x10 (field2 varint), value=0x01
  assertEqual(buf.toString("hex"), "1001");
});

test("B10 encode field 1 double=1.0", () => {
  const buf = encodeMessage({ "1": 1.0 }, { "1": { name: "x", type: "double" } }, 0);
  // field1 64-bit: tag=0x09, then 8 bytes little-endian for 1.0
  assertEqual(buf.length, 9); // 1 byte tag + 8 bytes
  const decoded = decodeMessage(buf, { "1": { name: "x", type: "double" } }, 0, null);
  assert(Math.abs(decoded.x - 1.0) < 1e-9);
});

test("B11 encode field 1 float=3.14", () => {
  const buf = encodeMessage({ "1": 3.14 }, { "1": { name: "x", type: "float" } }, 0);
  assertEqual(buf.length, 5); // 1 byte tag + 4 bytes
  const decoded = decodeMessage(buf, { "1": { name: "x", type: "float" } }, 0, null);
  assert(Math.abs(decoded.x - 3.14) < 0.001);
});

test("B12 encode field 1 fixed32=255", () => {
  const buf = encodeMessage({ "1": 255 }, { "1": { name: "x", type: "fixed32" } }, 0);
  // tag=0x0d (field1 32-bit wire), then 4 LE bytes
  assertEqual(buf[0], 0x0d); // field 1, wire type 5
  assertEqual(buf.length, 5);
});

test("B13 encode field 1 sint32=-1", () => {
  // zigzag: -1 -> 1
  const buf = encodeMessage({ "1": -1 }, { "1": { name: "x", type: "sint32" } }, 0);
  const dec = decodeMessage(buf, { "1": { name: "x", type: "sint32" } }, 0, null);
  assertEqual(dec.x, -1);
});

test("B14 encode field 1 sint64=-2 BigInt", () => {
  const buf = encodeMessage({ "1": -2n }, { "1": { name: "x", type: "sint64" } }, 0);
  const dec = decodeMessage(buf, { "1": { name: "x", type: "sint64" } }, 0, null);
  assertEqual(dec.x, -2);
});

test("B15 encode field 1 bytes (base64)", () => {
  const input = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const buf = encodeMessage(
    { "1": input.toString("base64") },
    { "1": { name: "data", type: "bytes" } },
    0
  );
  const dec = decodeMessage(buf, { "1": { name: "data", type: "bytes" } }, 0, null);
  assertEqual(dec.data.__bytes, input.toString("base64"));
});

test("B16 repeated field encodes as multiple tags", () => {
  const buf = encodeMessage(
    { "1": [1, 2, 3] },
    { "1": { name: "nums", type: "int32" } },
    0
  );
  // Should have 3 field entries: 0x08 0x01, 0x08 0x02, 0x08 0x03
  assertEqual(buf.toString("hex"), "08010802080 3".replace(/\s/g, ""));
});

test("B17 nested message encode/decode", () => {
  const fieldsDesc = {
    "1": { name: "address", type: "message", fields: {
      "1": { name: "street", type: "string" },
      "2": { name: "zip", type: "int32" },
    }},
  };
  const msg = { "1": { "1": "Main St", "2": 90210 } };
  const buf = encodeMessage(msg, fieldsDesc, 0);
  const dec = decodeMessage(buf, fieldsDesc, 0, null);
  assertEqual(dec.address.street, "Main St");
  assertEqual(dec.address.zip, 90210);
});

test("B18 inspectBuffer finds all fields", () => {
  const buf = encodeMessage(
    { "1": 42, "2": "hello", "3": true },
    { "1": { type: "int32" }, "2": { type: "string" }, "3": { type: "bool" } },
    0
  );
  const result = inspectBuffer(buf, 3);
  assertEqual(result.totalBytes, buf.length);
  assertEqual(result.fieldCount, 3);
  assertEqual(result.fields[0].fieldNumber, 1);
  assertEqual(result.fields[1].fieldNumber, 2);
  assertEqual(result.fields[2].fieldNumber, 3);
});

test("B19 inspectBuffer identifies wire types", () => {
  const buf = encodeMessage(
    { "1": 42, "2": "hello", "10": 3.14 },
    { "1": { type: "int32" }, "2": { type: "string" }, "10": { type: "float" } },
    0
  );
  const result = inspectBuffer(buf, 2);
  assertEqual(result.fields[0].wireType, "varint");
  assertEqual(result.fields[1].wireType, "len_delim");
  assertEqual(result.fields[2].wireType, "32bit");
});

test("B20 encode enum field", () => {
  const buf = encodeMessage({ "1": 2 }, { "1": { name: "status", type: "enum" } }, 0);
  const dec = decodeMessage(buf, { "1": { name: "status", type: "enum" } }, 0, null);
  assertEqual(dec.status, 2);
});

// ────────────────────────────────────────────────────────────────────────────
// C — Happy-path / round-trip tests (20)
// ────────────────────────────────────────────────────────────────────────────
process.stderr.write("\nC. Happy-path / Round-trip\n");

test("C01 encode+decode round-trip: basic scalars", () => {
  const fields = {
    "1": { name: "id",    type: "int32" },
    "2": { name: "name",  type: "string" },
    "3": { name: "score", type: "double" },
    "4": { name: "ok",    type: "bool" },
  };
  const msg = { "1": 99, "2": "Alice", "3": 9.5, "4": true };
  const buf = encodeMessage(msg, fields, 0);
  const dec = decodeMessage(buf, fields, 0, null);
  assertEqual(dec.id, 99);
  assertEqual(dec.name, "Alice");
  assert(Math.abs(dec.score - 9.5) < 1e-9);
  assertEqual(dec.ok, true);
});

test("C02 encode+decode round-trip: negative int32", () => {
  const fields = { "1": { name: "n", type: "int32" } };
  const buf = encodeMessage({ "1": -100 }, fields, 0);
  const dec = decodeMessage(buf, fields, 0, null);
  assertEqual(dec.n, -100);
});

test("C03 encode+decode round-trip: sint32 zigzag", () => {
  const fields = { "1": { name: "n", type: "sint32" } };
  for (const v of [-1, -2, -128, 0, 127]) {
    const buf = encodeMessage({ "1": v }, fields, 0);
    const dec = decodeMessage(buf, fields, 0, null);
    assertEqual(dec.n, v, "sint32 " + v);
  }
});

test("C04 encode+decode round-trip: uint32 max", () => {
  const fields = { "1": { name: "n", type: "uint32" } };
  const buf = encodeMessage({ "1": 0xFFFFFFFF }, fields, 0);
  const dec = decodeMessage(buf, fields, 0, null);
  assertEqual(dec.n, 0xFFFFFFFF);
});

test("C05 encode+decode round-trip: fixed32 / sfixed32", () => {
  const f1 = { "1": { name: "u", type: "fixed32" } };
  const f2 = { "1": { name: "s", type: "sfixed32" } };
  const d1 = decodeMessage(encodeMessage({ "1": 123456 }, f1, 0), f1, 0, null);
  assertEqual(d1.u, 123456);
  const d2 = decodeMessage(encodeMessage({ "1": -9 }, f2, 0), f2, 0, null);
  assertEqual(d2.s, -9);
});

test("C06 encode+decode round-trip: float", () => {
  const f = { "1": { name: "v", type: "float" } };
  const dec = decodeMessage(encodeMessage({ "1": 0.5 }, f, 0), f, 0, null);
  assert(Math.abs(dec.v - 0.5) < 1e-6);
});

test("C07 encode+decode round-trip: empty string", () => {
  const f = { "1": { name: "s", type: "string" } };
  const dec = decodeMessage(encodeMessage({ "1": "" }, f, 0), f, 0, null);
  assertEqual(dec.s, "");
});

test("C08 encode+decode round-trip: UTF-8 string with emoji", () => {
  const f = { "1": { name: "s", type: "string" } };
  const emoji = "Hello 🌍";
  const dec = decodeMessage(encodeMessage({ "1": emoji }, f, 0), f, 0, null);
  assertEqual(dec.s, emoji);
});

test("C09 encode+decode round-trip: repeated int32", () => {
  const f = { "1": { name: "items", type: "int32" } };
  const dec = decodeMessage(encodeMessage({ "1": [10, 20, 30] }, f, 0), f, 0, null);
  assert(Array.isArray(dec.items));
  assertEqual(dec.items.length, 3);
  assertEqual(dec.items[0], 10);
  assertEqual(dec.items[2], 30);
});

test("C10 encode+decode round-trip: repeated string", () => {
  const f = { "1": { name: "tags", type: "string" } };
  const dec = decodeMessage(encodeMessage({ "1": ["a", "bb", "ccc"] }, f, 0), f, 0, null);
  assert(Array.isArray(dec.tags));
  assertEqual(dec.tags.join(","), "a,bb,ccc");
});

test("C11 encode+decode round-trip: nested message", () => {
  const f = {
    "1": { name: "user", type: "message", fields: {
      "1": { name: "id",   type: "int32" },
      "2": { name: "name", type: "string" },
    }},
  };
  const dec = decodeMessage(
    encodeMessage({ "1": { "1": 7, "2": "Bob" } }, f, 0),
    f, 0, null
  );
  assertEqual(dec.user.id, 7);
  assertEqual(dec.user.name, "Bob");
});

test("C12 encode+decode round-trip: bool=false", () => {
  const f = { "1": { name: "flag", type: "bool" } };
  const dec = decodeMessage(encodeMessage({ "1": false }, f, 0), f, 0, null);
  assertEqual(dec.flag, false);
});

test("C13 protobufClient encode operation returns hex+base64", () => {
  const result = protobufClient({
    operation: "encode",
    message: { "1": 1 },
    fields: { "1": { name: "x", type: "int32" } },
  }, resolvePath);
  assert(result.hex, "hex missing");
  assert(result.base64, "base64 missing");
  assertEqual(result.sizeBytes, 2);
});

test("C14 protobufClient decode operation from hex", () => {
  const encoded = encodeMessage({ "1": 42 }, { "1": { name: "x", type: "int32" } }, 0);
  const result = protobufClient({
    operation: "decode",
    hex: encoded.toString("hex"),
    fields: { "1": { name: "x", type: "int32" } },
  }, resolvePath);
  assertEqual(result.message.x, 42);
});

test("C15 protobufClient decode from base64", () => {
  const encoded = encodeMessage({ "1": 99 }, { "1": { name: "val", type: "int32" } }, 0);
  const result = protobufClient({
    operation: "decode",
    base64: encoded.toString("base64"),
    fields: { "1": { name: "val", type: "int32" } },
  }, resolvePath);
  assertEqual(result.message.val, 99);
});

test("C16 encode_file + decode_file round-trip", () => {
  const jsonPath  = tmpFile("c16_in.json");
  const protoPath = tmpFile("c16_out.pb");
  const fields = { "1": { name: "x", type: "int32" }, "2": { name: "s", type: "string" } };
  fs.writeFileSync(jsonPath, JSON.stringify({ "1": 77, "2": "test" }));

  protobufClient({ operation: "encode_file", path: jsonPath, output: protoPath, fields }, resolvePath);
  assert(fs.existsSync(protoPath));

  const result = protobufClient({ operation: "decode_file", path: protoPath, fields }, resolvePath);
  assertEqual(result.message.x, 77);
  assertEqual(result.message.s, "test");
});

test("C17 decode_file with output writes JSON", () => {
  const jsonPath  = tmpFile("c17_in.json");
  const protoPath = tmpFile("c17_out.pb");
  const outJson   = tmpFile("c17_decoded.json");
  const fields = { "1": { name: "n", type: "int32" } };
  fs.writeFileSync(jsonPath, JSON.stringify({ "1": 555 }));
  protobufClient({ operation: "encode_file", path: jsonPath, output: protoPath, fields }, resolvePath);
  protobufClient({ operation: "decode_file", path: protoPath, output: outJson, pretty: true, fields }, resolvePath);
  const out = JSON.parse(fs.readFileSync(outJson, "utf8"));
  assertEqual(out.n, 555);
});

test("C18 inspect operation returns field layout", () => {
  const buf = encodeMessage(
    { "1": 42, "2": "hello" },
    { "1": { type: "int32" }, "2": { type: "string" } },
    0
  );
  const result = protobufClient({
    operation: "inspect",
    hex: buf.toString("hex"),
  }, resolvePath);
  assertEqual(result.fieldCount, 2);
  assertEqual(result.totalBytes, buf.length);
  assertEqual(result.fields[0].fieldNumber, 1);
  assertEqual(result.fields[0].wireType, "varint");
  assertEqual(result.fields[1].fieldNumber, 2);
  assertEqual(result.fields[1].wireType, "len_delim");
});

test("C19 decode without schema returns best-effort field_N keys", () => {
  const buf = encodeMessage({ "1": 42, "2": "world" }, null, 0);
  const dec = decodeMessage(buf, null, 0, null);
  // Without schema, field names default to field_N
  assert("field_1" in dec || "1" in dec || dec.field_1 !== undefined || dec["field_1"] !== undefined);
});

test("C20 encode+decode round-trip: multiple high field numbers", () => {
  const fields = {
    "100": { name: "a", type: "int32" },
    "200": { name: "b", type: "string" },
    "500": { name: "c", type: "bool" },
  };
  const msg = { "100": 1, "200": "hi", "500": true };
  const buf = encodeMessage(msg, fields, 0);
  const dec = decodeMessage(buf, fields, 0, null);
  assertEqual(dec.a, 1);
  assertEqual(dec.b, "hi");
  assertEqual(dec.c, true);
});

// ────────────────────────────────────────────────────────────────────────────
// D — Security tests (10)
// ────────────────────────────────────────────────────────────────────────────
process.stderr.write("\nD. Security\n");

test("D01 NUL byte in input_file path rejected", () => {
  assertThrows(
    () => protobufClient({ operation: "decode", input_file: "/tmp/file\0" }, resolvePath),
    "NUL byte"
  );
});

test("D02 NUL byte in json_file path rejected", () => {
  assertThrows(
    () => protobufClient({ operation: "encode", json_file: "file\0.json" }, resolvePath),
    "NUL byte"
  );
});

test("D03 NUL byte in output_file path rejected (encode)", () => {
  assertThrows(
    () => protobufClient({ operation: "encode", message: { "1": 1 }, output_file: "out\0.pb" }, resolvePath),
    "NUL byte"
  );
});

test("D04 directory as input_file rejected", () => {
  assertThrows(
    () => protobufClient({ operation: "decode", input_file: os.tmpdir() }, resolvePath),
    "directory"
  );
});

test("D05 nesting depth limit enforced", () => {
  // Build 65 levels of nesting
  function nestedMsg(depth) {
    if (depth === 0) return { "1": 42 };
    return { "1": nestedMsg(depth - 1) };
  }
  const f = { "1": { name: "inner", type: "message", fields: { "1": { name: "inner", type: "message" } } } };
  assertThrows(() => encodeMessage(nestedMsg(66), f, 0), "nesting depth exceeds limit");
});

test("D06 oversized file rejected (mock stat)", () => {
  // Write a regular file but give it a fake oversized stat
  const p = tmpFile("d06.pb");
  fs.writeFileSync(p, Buffer.alloc(10));
  // Patch statSync temporarily to return large size
  const origStat = fs.statSync.bind(fs);
  const fsModule = require("fs");
  const savedStat = fsModule.statSync;
  fsModule.statSync = (fp) => {
    const s = savedStat(fp);
    if (fp === p) return { ...s, size: 51 * 1024 * 1024, isDirectory: () => false };
    return s;
  };
  try {
    assertThrows(
      () => protobufClient({ operation: "decode", input_file: p }, resolvePath),
      "too large"
    );
  } finally {
    fsModule.statSync = savedStat;
  }
});

test("D07 unknown wire type in binary data throws", () => {
  // Wire type 3 (group start) is not supported
  const buf = Buffer.from([0x03]); // field 0, wire type 3 — but field 0 is invalid, so:
  // Actually: create field 1 with wire type 3: (1 << 3) | 3 = 0x0b
  const maliciousBuf = Buffer.from([0x0b]);
  assertThrows(
    () => decodeMessage(maliciousBuf, null, 0, null),
    "unknown wire type"
  );
});

test("D08 truncated buffer (varint cut off) throws", () => {
  // Encode a valid message then truncate
  const buf = encodeMessage({ "1": 42, "2": "hello world" }, null, 0);
  const truncated = buf.slice(0, buf.length - 3);
  assertThrows(
    () => decodeMessage(truncated, null, 0, null),
    "unexpected end of data"
  );
});

test("D09 varint too long (11 bytes) throws", () => {
  // Build a varint with 11 continuation bytes (all 0x80)
  const tooLong = Buffer.alloc(12);
  tooLong[0] = 0x08; // tag: field 1, wire type 0
  for (let i = 1; i <= 10; i++) tooLong[i] = 0x80; // continuation bytes
  tooLong[11] = 0x00; // final byte
  assertThrows(
    () => decodeMessage(tooLong, null, 0, null),
    "varint too long"
  );
});

test("D10 excessively large length-delimited field throws", () => {
  // Manually craft a length-delimited field claiming 60MB
  const buf = Buffer.alloc(6);
  buf[0] = 0x0a; // field 1, wire type 2
  // 60 MB = 62914560 -> encoded as varint
  const len = 62914560;
  let v = BigInt(len), i = 1;
  while (v > 0n) {
    const byte = Number(v & 0x7Fn);
    v >>= 7n;
    buf[i++] = v !== 0n ? byte | 0x80 : byte;
    if (i >= buf.length) break;
  }
  assertThrows(
    () => decodeMessage(buf, null, 0, null),
    // Either: file too large, or unexpected end (payload not present)
    /too large|unexpected end/
  );
});

// Fix: assertThrows with regex
function assertThrows(fn, matchArg, label) {
  try {
    fn();
    throw new Error((label || "assertThrows") + ": expected an error but none was thrown");
  } catch (e) {
    if (e.message.includes("expected an error but none was thrown")) throw e;
    if (!matchArg) return;
    if (matchArg instanceof RegExp) {
      if (!matchArg.test(e.message))
        throw new Error((label || "assertThrows") + ": error '" + e.message + "' does not match " + matchArg);
    } else {
      if (!e.message.includes(matchArg))
        throw new Error((label || "assertThrows") + ": error '" + e.message + "' does not contain '" + matchArg + "'");
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// E — Error path tests (10)
// ────────────────────────────────────────────────────────────────────────────
process.stderr.write("\nE. Error Paths\n");

test("E01 decode_file: missing path throws", () => {
  assertThrows(
    () => protobufClient({ operation: "decode_file" }, resolvePath),
    "'path' (protobuf input) is required"
  );
});

test("E02 encode_file: missing path throws", () => {
  assertThrows(
    () => protobufClient({ operation: "encode_file" }, resolvePath),
    "'path' (JSON input) is required"
  );
});

test("E03 encode_file: missing output throws", () => {
  assertThrows(
    () => protobufClient({ operation: "encode_file", path: tmpFile("x.json") }, resolvePath),
    "'output' (protobuf output path) is required"
  );
});

test("E04 encode_file: invalid JSON throws", () => {
  const p = tmpFile("e04.json");
  fs.writeFileSync(p, "not valid json");
  assertThrows(
    () => protobufClient({ operation: "encode_file", path: p, output: tmpFile("e04.pb") }, resolvePath),
    "not valid JSON"
  );
});

test("E05 decode_file: empty file throws", () => {
  const p = tmpFile("e05.pb");
  fs.writeFileSync(p, Buffer.alloc(0));
  assertThrows(
    () => protobufClient({ operation: "decode_file", path: p }, resolvePath),
    "empty"
  );
});

test("E06 decode: missing all input sources throws", () => {
  assertThrows(
    () => protobufClient({ operation: "decode" }, resolvePath),
    "'input_file', 'hex', or 'base64' is required"
  );
});

test("E07 inspect: empty base64 throws", () => {
  assertThrows(
    () => protobufClient({ operation: "inspect", base64: "" }, resolvePath),
    "input is empty"
  );
});

test("E08 encode: unknown type throws", () => {
  assertThrows(
    () => encodeMessage({ "1": 42 }, { "1": { name: "x", type: "unknownType" } }, 0),
    "unknown field type"
  );
});

test("E09 encode: bytes field with non-buffer non-string throws", () => {
  assertThrows(
    () => encodeMessage({ "1": 12345 }, { "1": { name: "data", type: "bytes" } }, 0),
    "requires a Buffer or base64 string"
  );
});

test("E10 json_file with invalid JSON throws", () => {
  const p = tmpFile("e10.json");
  fs.writeFileSync(p, "{ bad json }]");
  assertThrows(
    () => protobufClient({ operation: "encode", json_file: p }, resolvePath),
    "not valid JSON"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// F — Concurrency tests (6)
// ────────────────────────────────────────────────────────────────────────────
process.stderr.write("\nF. Concurrency\n");

async function runConcurrency() {
  await testAsync("F01 concurrent encodes are independent", async () => {
    const iterations = 50;
    const promises = Array.from({ length: iterations }, (_, i) =>
      Promise.resolve().then(() => {
        const fields = { "1": { name: "n", type: "int32" } };
        const buf = encodeMessage({ "1": i }, fields, 0);
        const dec = decodeMessage(buf, fields, 0, null);
        assert(dec.n === i, "mismatch at iteration " + i);
      })
    );
    await Promise.all(promises);
  });

  await testAsync("F02 concurrent decode from hex", async () => {
    const fields = { "1": { name: "s", type: "string" } };
    const items = ["alpha", "beta", "gamma", "delta", "epsilon"].map(s => ({
      s,
      hex: encodeMessage({ "1": s }, fields, 0).toString("hex"),
    }));
    const results = await Promise.all(
      items.map(({ s, hex }) =>
        Promise.resolve(protobufClient({ operation: "decode", hex, fields }, resolvePath))
      )
    );
    for (let i = 0; i < items.length; i++) {
      assertEqual(results[i].message.s, items[i].s, "concurrent decode item " + i);
    }
  });

  await testAsync("F03 concurrent file encode (different files)", async () => {
    const count = 10;
    await Promise.all(Array.from({ length: count }, (_, i) => {
      return Promise.resolve().then(() => {
        const jsonPath  = tmpFile("f03_" + i + ".json");
        const protoPath = tmpFile("f03_" + i + ".pb");
        const fields = { "1": { name: "n", type: "int32" } };
        fs.writeFileSync(jsonPath, JSON.stringify({ "1": i * 10 }));
        protobufClient({ operation: "encode_file", path: jsonPath, output: protoPath, fields }, resolvePath);
        const r = protobufClient({ operation: "decode_file", path: protoPath, fields }, resolvePath);
        assertEqual(r.message.n, i * 10);
      });
    }));
  });

  await testAsync("F04 concurrent inspect calls", async () => {
    const bufs = [1, 2, 3, 4, 5].map(n => encodeMessage({ "1": n }, null, 0));
    const results = await Promise.all(bufs.map(buf =>
      Promise.resolve(inspectBuffer(buf, 2))
    ));
    results.forEach((r, i) => {
      assertEqual(r.fieldCount, 1, "fieldCount at " + i);
    });
  });

  await testAsync("F05 concurrent round-trip with nested messages", async () => {
    const f = {
      "1": { name: "outer", type: "message", fields: {
        "1": { name: "val", type: "int32" },
      }},
    };
    const nums = [7, 13, 21, 42, 99];
    const results = await Promise.all(nums.map(n =>
      Promise.resolve().then(() => {
        const buf = encodeMessage({ "1": { "1": n } }, f, 0);
        return decodeMessage(buf, f, 0, null);
      })
    ));
    nums.forEach((n, i) => assertEqual(results[i].outer.val, n, "nested val " + i));
  });

  await testAsync("F06 high-volume repeated field concurrent", async () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve().then(() => {
        const arr = Array.from({ length: 100 }, (__, j) => i * 100 + j);
        const f = { "1": { name: "items", type: "int32" } };
        const buf = encodeMessage({ "1": arr }, f, 0);
        const dec = decodeMessage(buf, f, 0, null);
        assert(Array.isArray(dec.items));
        assertEqual(dec.items.length, 100);
        assertEqual(dec.items[99], i * 100 + 99);
      })
    );
    await Promise.all(tasks);
  });
}

// Run all
runConcurrency().then(() => {
  // Cleanup
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {}

  process.stderr.write("\n--- Section 220 Results ---\n");
  process.stderr.write("Passed: " + passed + "\n");
  process.stderr.write("Failed: " + failed + "\n");
  if (errors.length > 0) {
    process.stderr.write("Failures:\n");
    errors.forEach(e => process.stderr.write("  " + e.name + ": " + e.error + "\n"));
  }

  const total = passed + failed;
  process.stdout.write(JSON.stringify({
    section: 220,
    tool: "protobuf_client",
    passed,
    failed,
    total,
    status: failed === 0 ? "ok" : "failed",
  }) + "\n");

  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  process.stderr.write("Fatal error: " + err.message + "\n" + err.stack + "\n");
  process.exit(1);
});
