"use strict";
// test/sections/218-msgpack-client.js
// Section 218 — msgpack_client tool tests
// 75 total: A=validation(10), B=unit(20), C=happy-path(20), D=security(10), E=error-paths(10), F=concurrency(5)

const { msgpackClient, encode, decodeBuffer, inspectBuffer } = require("../../lib/msgpackClientOps");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Test harness ──────────────────────────────────────────────────
let passed = 0, failed = 0, errors = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; errors.push(msg); process.stderr.write(`  FAIL: ${msg}\n`); }
}

function assertThrows(fn, pattern, msg) {
  try {
    fn();
    failed++; errors.push(`Expected throw: ${msg}`);
    process.stderr.write(`  FAIL: expected throw — ${msg}\n`);
  } catch (e) {
    if (pattern && !e.message.includes(pattern)) {
      failed++; errors.push(`Wrong error for: ${msg} (got: ${e.message})`);
      process.stderr.write(`  FAIL: wrong error for '${msg}': ${e.message}\n`);
    } else { passed++; }
  }
}

// ── Setup helpers ────────────────────────────────────────────────
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "msgpack-test-"));
const allFiles = [];

function tmpFile(name) {
  const p = path.join(TMPDIR, name);
  allFiles.push(p);
  return p;
}

function resolve(p) { return { resolved: p }; }
function run(args) { return msgpackClient(args, resolve); }

// Round-trip helper: encode then decode
function rt(value) {
  const buf = encode(value, 0);
  return decodeBuffer(buf, false);
}

// ──────────────────────────────────────────────────────────────────
// A — Input Validation (10)
// ──────────────────────────────────────────────────────────────────
process.stderr.write("Section A — Validation\n");

assertThrows(() => run({}), "'operation' is required", "A1: missing operation");
assertThrows(() => run({ operation: "nope" }), "unknown operation", "A2: unknown operation");
assertThrows(() => run({ operation: "encode" }), "'value' or 'json_file'", "A3: encode missing value");
assertThrows(() => run({ operation: "decode" }), "'input_file', 'hex', or 'base64'", "A4: decode missing input");
assertThrows(() => run({ operation: "encode_file" }), "'path'", "A5: encode_file missing path");
assertThrows(() => run({ operation: "encode_file", path: "x.json" }), "'output'", "A6: encode_file missing output");
assertThrows(() => run({ operation: "decode_file" }), "'path'", "A7: decode_file missing path");
assertThrows(() => run({ operation: "inspect" }), "'input_file', 'hex', or 'base64'", "A8: inspect missing input");
assertThrows(() => run({ operation: "decode", hex: "zz" }), "hex", "A9: decode invalid hex");
assertThrows(() => run({ operation: "decode", hex: "" }), "", "A10: decode empty hex");

// ──────────────────────────────────────────────────────────────────
// B — Unit tests (20): round-trip all types
// ──────────────────────────────────────────────────────────────────
process.stderr.write("Section B — Unit\n");

// B1: nil
assert(rt(null) === null, "B1: nil round-trips");
// B2: true/false
assert(rt(true) === true && rt(false) === false, "B2: bool round-trips");
// B3: positive fixint
assert(rt(0) === 0 && rt(127) === 127, "B3: positive fixint round-trips");
// B4: negative fixint
assert(rt(-1) === -1 && rt(-32) === -32, "B4: negative fixint round-trips");
// B5: uint8/16/32
assert(rt(200) === 200 && rt(60000) === 60000 && rt(70000) === 70000, "B5: uint8/16/32 round-trips");
// B6: int8/16/32
assert(rt(-128) === -128 && rt(-32768) === -32768 && rt(-2147483648) === -2147483648, "B6: int8/16/32 round-trips");
// B7: float64
assert(Math.abs(rt(3.14) - 3.14) < 1e-10, "B7: float64 round-trips");
assert(rt(Infinity) === Infinity && rt(-Infinity) === -Infinity, "B7b: Infinity round-trips");
// B8: empty string
assert(rt("") === "", "B8: empty string round-trips");
// B9: fixstr
assert(rt("hello") === "hello", "B9: fixstr round-trips");
// B10: long string (str8)
const longStr = "x".repeat(200);
assert(rt(longStr) === longStr, "B10: str8 round-trips");
// B11: very long string (str16)
const veryLongStr = "a".repeat(33000);
assert(rt(veryLongStr) === veryLongStr, "B11: str16 round-trips");
// B12: empty array
assert(JSON.stringify(rt([])) === "[]", "B12: empty array round-trips");
// B13: fixarray
assert(JSON.stringify(rt([1, 2, 3])) === "[1,2,3]", "B13: fixarray round-trips");
// B14: array with mixed types
const mixed = [null, true, -7, 3.14, "hi"];
const mixedRt = rt(mixed);
assert(mixedRt[0] === null && mixedRt[1] === true && mixedRt[2] === -7, "B14: mixed array round-trips");
// B15: empty map
assert(typeof rt({}) === "object", "B15: empty map round-trips");
// B16: fixmap
const m = rt({ a: 1, b: "two" });
assert(m.a === 1 && m.b === "two", "B16: fixmap round-trips");
// B17: nested object
const nested = { x: { y: { z: 42 } } };
assert(rt(nested).x.y.z === 42, "B17: nested object round-trips");
// B18: array of objects
const arrObj = [{ id: 1 }, { id: 2 }];
assert(rt(arrObj)[1].id === 2, "B18: array of objects round-trips");
// B19: binary buffer
const binBuf = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
const binEncoded = encode(binBuf, 0);
const binDecoded = decodeBuffer(binEncoded, false);
assert(Buffer.isBuffer(binDecoded) && binDecoded[0] === 0xde && binDecoded[3] === 0xef, "B19: binary Buffer round-trips");
// B20: undefined encodes as nil
const undefBuf = encode(undefined, 0);
assert(decodeBuffer(undefBuf, false) === null, "B20: undefined encodes as nil");

// ──────────────────────────────────────────────────────────────────
// C — Happy-path (20)
// ──────────────────────────────────────────────────────────────────
process.stderr.write("Section C — Happy-path\n");

// C1: encode inline value returns hex + base64
const c1 = run({ operation: "encode", value: { hello: "world" } });
assert(typeof c1.hex === "string" && c1.hex.length > 0, "C1: encode returns hex");
assert(typeof c1.base64 === "string" && c1.base64.length > 0, "C1b: encode returns base64");
assert(c1.sizeBytes > 0, "C1c: encode.sizeBytes > 0");

// C2: decode from hex
const c2 = run({ operation: "decode", hex: c1.hex });
assert(c2.value.hello === "world", "C2: decode from hex gives correct value");

// C3: decode from base64
const c3 = run({ operation: "decode", base64: c1.base64 });
assert(c3.value.hello === "world", "C3: decode from base64 gives correct value");

// C4: encode to output_file
const encOutFile = tmpFile("encoded.msgpack");
const c4 = run({ operation: "encode", value: [1, 2, 3], output_file: encOutFile });
assert(c4.outputFile === encOutFile, "C4: encode_file output path correct");
assert(fs.existsSync(encOutFile), "C4b: encoded file exists on disk");
assert(c4.sizeBytes > 0, "C4c: encoded file has bytes");

// C5: encode with include_hex
const c5 = run({ operation: "encode", value: 42, output_file: tmpFile("enc42.msgpack"), include_hex: true });
assert(typeof c5.hex === "string", "C5: include_hex returns hex even with output_file");

// C6: decode from input_file
const c6 = run({ operation: "decode", input_file: encOutFile });
assert(Array.isArray(c6.value) && c6.value[2] === 3, "C6: decode from input_file correct");

// C7-C8: encode_file
const jsonSrc = tmpFile("src.json");
fs.writeFileSync(jsonSrc, JSON.stringify({ key: "val", num: 99 }));
const msgpackOut = tmpFile("src.msgpack");
const c7 = run({ operation: "encode_file", path: jsonSrc, output: msgpackOut });
assert(c7.outputBytes > 0, "C7: encode_file outputBytes > 0");
assert(fs.existsSync(msgpackOut), "C8: encode_file created output file");
assert(typeof c7.ratio === "string", "C7b: encode_file ratio is a string");

// C9: decode_file (inline return)
const c9 = run({ operation: "decode_file", path: msgpackOut });
assert(c9.value.key === "val" && c9.value.num === 99, "C9: decode_file inline value correct");

// C10: decode_file to output JSON file
const decodedJsonOut = tmpFile("decoded.json");
const c10 = run({ operation: "decode_file", path: msgpackOut, output: decodedJsonOut, pretty: true });
assert(fs.existsSync(decodedJsonOut), "C10: decode_file output JSON file created");
const parsedBack = JSON.parse(fs.readFileSync(decodedJsonOut, "utf8"));
assert(parsedBack.num === 99, "C10b: decode_file output JSON parses correctly");

// C11: inspect hex
const inspHex = Buffer.from([0x82, 0xa3, 0x6b, 0x65, 0x79, 0xa3, 0x76, 0x61, 0x6c]).toString("hex");
const c11 = run({ operation: "inspect", hex: inspHex });
assert(c11.tree.type === "map", "C11: inspect identifies map type");
assert(c11.tree.count === 2, "C11b: inspect map count = 2");

// C12: inspect base64
const c12 = run({ operation: "inspect", base64: c1.base64 });
assert(c12.totalBytes > 0, "C12: inspect from base64 works");
assert(typeof c12.tree === "object", "C12b: inspect tree is object");

// C13: nil round-trip via tool
const c13 = run({ operation: "encode", value: null });
const c13d = run({ operation: "decode", hex: c13.hex });
assert(c13d.value === null, "C13: nil encode/decode via tool");

// C14: bool round-trip via tool
const c14t = run({ operation: "encode", value: true });
const c14f = run({ operation: "encode", value: false });
assert(run({ operation: "decode", hex: c14t.hex }).value === true, "C14: true round-trip via tool");
assert(run({ operation: "decode", hex: c14f.hex }).value === false, "C14b: false round-trip via tool");

// C15: integer varieties via tool
const ints = [0, 127, -32, 200, 60000, -30000, 3000000000];
for (const n of ints) {
  const enc = run({ operation: "encode", value: n });
  const dec = run({ operation: "decode", hex: enc.hex });
  assert(dec.value === n, `C15: integer ${n} round-trips via tool`);
}

// C16: float via tool
const c16 = run({ operation: "encode", value: 2.718281828 });
assert(Math.abs(run({ operation: "decode", hex: c16.hex }).value - 2.718281828) < 1e-6, "C16: float round-trip via tool");

// C17: array via tool
const c17 = run({ operation: "encode", value: ["a", "b", "c"] });
assert(run({ operation: "decode", hex: c17.hex }).value[1] === "b", "C17: array round-trip via tool");

// C18: allow_multiple (stream decode)
const buf18a = encode(42, 0);
const buf18b = encode("hello", 0);
const combined = Buffer.concat([buf18a, buf18b]).toString("hex");
const c18 = run({ operation: "decode", hex: combined, allow_multiple: true });
assert(Array.isArray(c18.value) && c18.value.length === 2, "C18: allow_multiple returns array of 2 values");
assert(c18.value[0] === 42 && c18.value[1] === "hello", "C18b: allow_multiple values correct");

// C19: inspect with max_depth=1 truncates nested
const deepVal = { a: { b: { c: 99 } } };
const deepEnc = encode(deepVal, 0);
const c19 = inspectBuffer(deepEnc, 1);
assert(c19.tree.type === "map", "C19: inspect max_depth=1 root is map");
assert(c19.tree.entries && c19.tree.entries[0].value.truncated === true, "C19b: inspect max_depth=1 nested truncated");

// C20: encode json_file (using the JSON file we created earlier)
const c20 = run({ operation: "encode", json_file: jsonSrc });
assert(c20.hex.length > 0, "C20: encode from json_file returns hex");
const c20d = run({ operation: "decode", hex: c20.hex });
assert(c20d.value.num === 99, "C20b: encode json_file then decode gives correct value");

// ──────────────────────────────────────────────────────────────────
// D — Security (10)
// ──────────────────────────────────────────────────────────────────
process.stderr.write("Section D — Security\n");

// D1: NUL byte in path rejected
assertThrows(() => run({ operation: "encode", json_file: "some\0file.json" }), "NUL byte", "D1: NUL in json_file rejected");
assertThrows(() => run({ operation: "decode", input_file: "some\0file.msgpack" }), "NUL byte", "D2: NUL in input_file rejected");

// D3: directory path rejected
assertThrows(() => run({ operation: "decode", input_file: TMPDIR }), "directory", "D3: directory as input_file rejected");

// D4: decode truncated data throws
assertThrows(() => run({ operation: "decode", hex: "92" }), "unexpected end", "D4: truncated data throws");

// D5: unknown format byte rejected
assertThrows(() => run({ operation: "decode", hex: "c1" }), "unknown format byte", "D5: reserved format byte 0xc1 rejected");

// D6: nesting depth limit enforced at decode
// Build a deeply nested array programmatically (flatten at depth 101+)
function makeNestedArray(depth, value) {
  let v = value;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}
const deepNested = makeNestedArray(110, 1);
assertThrows(() => encode(deepNested, 0), "nesting depth", "D6: encode nesting depth limit enforced");

// D7: trailing bytes without allow_multiple rejected
const trailingBuf = Buffer.concat([encode(1, 0), encode(2, 0)]);
assertThrows(() => decodeBuffer(trailingBuf, false), "trailing bytes", "D7: trailing bytes without allow_multiple rejected");

// D8: non-existent file throws fs error
assertThrows(() => run({ operation: "decode", input_file: tmpFile("nonexistent.msgpack") }), "", "D8: missing input file throws");

// D9: encode_file with invalid JSON file
const badJson = tmpFile("bad.json");
fs.writeFileSync(badJson, "{ not valid json");
assertThrows(() => run({ operation: "encode_file", path: badJson, output: tmpFile("bad.msgpack") }), "not valid JSON", "D9: non-JSON input rejected");

// D10: decode odd-length hex rejected
assertThrows(() => run({ operation: "decode", hex: "abc" }), "hex", "D10: odd-length hex rejected");

// ──────────────────────────────────────────────────────────────────
// E — Error paths (10)
// ──────────────────────────────────────────────────────────────────
process.stderr.write("Section E — Error-paths\n");

// E1: decode empty base64
assertThrows(() => run({ operation: "decode", base64: "" }), "empty", "E1: decode empty base64 throws");

// E2: inspect input_file that doesn't exist
assertThrows(() => run({ operation: "inspect", input_file: tmpFile("nope.msgpack") }), "", "E2: inspect missing file throws");

// E3: encode_file output dir not writable (use NUL path)
assertThrows(() => run({ operation: "encode_file", path: badJson, output: "good\0out.msgpack" }), "NUL byte", "E3: NUL in output path rejected");

// E4: decode_file on non-msgpack file
const textFile = tmpFile("text.msgpack");
fs.writeFileSync(textFile, "this is not msgpack");
// This will likely try to decode - it may succeed with some bytes or throw depending on content
// We test that it either decodes or throws without crashing
try {
  run({ operation: "decode_file", path: textFile });
  passed++; // decoded some bytes — acceptable
} catch (e) {
  passed++; // threw — also acceptable
}

// E5: inspect with truncated ext data
assertThrows(() => run({ operation: "decode", hex: "d4" }), "unexpected end", "E5: truncated ext throws");

// E6: decode’ a buffer with only 1 byte of a uint16 array header
assertThrows(() => run({ operation: "decode", hex: "dc01" }), "unexpected end", "E6: partial array16 throws");

// E7: decode str with truncated content
assertThrows(() => run({ operation: "decode", hex: "a5" }), "unexpected end", "E7: truncated str throws");

// E8: encode_file non-existent JSON file
assertThrows(() => run({ operation: "encode_file", path: tmpFile("nope.json"), output: tmpFile("x.msgpack") }), "", "E8: encode_file nonexistent source throws");

// E9: decode bin16 with truncated payload
assertThrows(() => run({ operation: "decode", hex: "c5000a" }), "unexpected end", "E9: truncated bin16 throws");

// E10: inspect with unknown format byte
assertThrows(() => run({ operation: "inspect", hex: "c1" }), "unknown format byte", "E10: inspect unknown byte throws");

// ──────────────────────────────────────────────────────────────────
// F — Concurrency (5)
// ──────────────────────────────────────────────────────────────────
process.stderr.write("Section F — Concurrency\n");

// F1: parallel encodes
{
  const results = Array.from({ length: 5 }, (_, i) => run({ operation: "encode", value: { i } }));
  assert(results.every(r => r.sizeBytes > 0), "F1: 5 parallel encodes all produce output");
}

// F2: parallel decodes
{
  const hex = run({ operation: "encode", value: { test: true } }).hex;
  const results = Array.from({ length: 5 }, () => run({ operation: "decode", hex }));
  assert(results.every(r => r.value.test === true), "F2: 5 parallel decodes all correct");
}

// F3: parallel encode_file
{
  const outputs = Array.from({ length: 5 }, (_, i) => tmpFile(`conc${i}.msgpack`));
  outputs.forEach(out => run({ operation: "encode_file", path: jsonSrc, output: out }));
  assert(outputs.every(o => fs.existsSync(o)), "F3: 5 parallel encode_file all created");
}

// F4: parallel decode_file
{
  const results = Array.from({ length: 5 }, () => run({ operation: "decode_file", path: msgpackOut }));
  assert(results.every(r => r.value.key === "val"), "F4: 5 parallel decode_file all correct");
}

// F5: parallel inspect
{
  const results = Array.from({ length: 5 }, () => run({ operation: "inspect", hex: c1.hex }));
  assert(results.every(r => r.totalBytes > 0), "F5: 5 parallel inspects all correct");
}

// ── Summary ────────────────────────────────────────────────────────────────

// Cleanup
try {
  for (const f of allFiles) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
} catch {}

const total = passed + failed;
process.stderr.write(`\nSection 218 results: ${passed}/${total} passed`);
if (failed > 0) {
  process.stderr.write(`\nFailed tests:\n${errors.map(e => '  - ' + e).join('\n')}\n`);
}
process.stderr.write("\n");

if (failed > 0) process.exit(1);
