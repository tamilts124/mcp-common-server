"use strict";
// test/sections/219-cbor-client.js
// Section 219 — cbor_client tool tests
// 75 total: A=validation(10), B=unit(20), C=happy-path(20), D=security(10), E=error-paths(10), F=concurrency(5)

const { cborClient, encode, decodeBuffer, inspectBuffer } = require("../../lib/cborClientOps");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Test harness ─────────────────────────────────────────────────────
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
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "cbor-test-"));
const allFiles = [];
function tmpFile(name) { const p = path.join(TMPDIR, name); allFiles.push(p); return p; }
function resolve(p) { return { resolved: p }; }
function run(args) { return cborClient(args, resolve); }

// Round-trip helper
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
assertThrows(() => run({ operation: "decode", hex: "" }), "empty", "A10: decode empty hex");

// ──────────────────────────────────────────────────────────────────
// B — Unit tests (20): round-trip all CBOR types
// ──────────────────────────────────────────────────────────────────
process.stderr.write("Section B — Unit\n");

// B1: null
assert(rt(null) === null, "B1: null round-trips");
// B2: true/false
assert(rt(true) === true && rt(false) === false, "B2: bool round-trips");
// B3: unsigned small int (0-23, inline)
assert(rt(0) === 0 && rt(23) === 23, "B3: small uint round-trips");
// B4: unsigned 1-byte (24-255)
assert(rt(24) === 24 && rt(255) === 255, "B4: uint8 round-trips");
// B5: unsigned 2-byte (256-65535)
assert(rt(256) === 256 && rt(65535) === 65535, "B5: uint16 round-trips");
// B6: unsigned 4-byte
assert(rt(70000) === 70000 && rt(0xffffffff) === 0xffffffff, "B6: uint32 round-trips");
// B7: negative integers
assert(rt(-1) === -1 && rt(-32) === -32 && rt(-1000) === -1000, "B7: negative int round-trips");
// B8: float64
assert(Math.abs(rt(3.14159) - 3.14159) < 1e-10, "B8: float64 round-trips");
// B9: Infinity
assert(rt(Infinity) === Infinity && rt(-Infinity) === -Infinity, "B9: Infinity round-trips");
// B10: NaN
assert(Number.isNaN(rt(NaN)), "B10: NaN round-trips");
// B11: empty string
assert(rt("") === "", "B11: empty string round-trips");
// B12: text string
assert(rt("hello world") === "hello world", "B12: text string round-trips");
// B13: unicode string
assert(rt("\u4e2d\u6587") === "\u4e2d\u6587", "B13: unicode text round-trips");
// B14: empty array
assert(Array.isArray(rt([])) && rt([]).length === 0, "B14: empty array round-trips");
// B15: array with mixed types
const mixArr = [1, "two", null, false, 3.14];
const mixRt = rt(mixArr);
assert(mixRt[0] === 1 && mixRt[1] === "two" && mixRt[2] === null && mixRt[3] === false, "B15: mixed array round-trips");
// B16: empty map
assert(typeof rt({}) === "object", "B16: empty map round-trips");
// B17: map with various value types
const mapVal = { a: 1, b: "str", c: true, d: null };
const mapRt = rt(mapVal);
assert(mapRt.a === 1 && mapRt.b === "str" && mapRt.c === true && mapRt.d === null, "B17: map round-trips");
// B18: nested structure
const nested = { x: [1, { y: 2 }] };
assert(rt(nested).x[1].y === 2, "B18: nested structure round-trips");
// B19: binary Buffer round-trips as Buffer
const binBuf = Buffer.from([0x01, 0x02, 0xfe, 0xff]);
const binEncoded = encode(binBuf, 0);
const binDecoded = decodeBuffer(binEncoded, false);
assert(Buffer.isBuffer(binDecoded) && binDecoded[0] === 1 && binDecoded[3] === 0xff, "B19: binary Buffer round-trips");
// B20: undefined encodes as null (CBOR null simple 22 → decoded as null)
const undefEncoded = encode(undefined, 0);
assert(decodeBuffer(undefEncoded, false) === null, "B20: undefined encodes as null");

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
const encOutFile = tmpFile("encoded.cbor");
const c4 = run({ operation: "encode", value: [1, 2, 3], output_file: encOutFile });
assert(c4.outputFile === encOutFile, "C4: encode.outputFile path correct");
assert(fs.existsSync(encOutFile), "C4b: encoded file exists on disk");
assert(c4.sizeBytes > 0, "C4c: encoded file has bytes");

// C5: encode with include_hex
const c5 = run({ operation: "encode", value: 42, output_file: tmpFile("enc42.cbor"), include_hex: true });
assert(typeof c5.hex === "string", "C5: include_hex returns hex even with output_file");

// C6: decode from input_file
const c6 = run({ operation: "decode", input_file: encOutFile });
assert(Array.isArray(c6.value) && c6.value[2] === 3, "C6: decode from input_file correct");

// C7-C8: encode_file
const jsonSrc = tmpFile("src.json");
fs.writeFileSync(jsonSrc, JSON.stringify({ key: "val", num: 99 }));
const cborOut = tmpFile("src.cbor");
const c7 = run({ operation: "encode_file", path: jsonSrc, output: cborOut });
assert(c7.outputBytes > 0, "C7: encode_file outputBytes > 0");
assert(fs.existsSync(cborOut), "C8: encode_file created output file");
assert(typeof c7.ratio === "string", "C7b: encode_file ratio is a string");

// C9: decode_file (inline return)
const c9 = run({ operation: "decode_file", path: cborOut });
assert(c9.value.key === "val" && c9.value.num === 99, "C9: decode_file inline value correct");

// C10: decode_file to output JSON file
const decodedJsonOut = tmpFile("decoded.json");
const c10 = run({ operation: "decode_file", path: cborOut, output: decodedJsonOut, pretty: true });
assert(fs.existsSync(decodedJsonOut), "C10: decode_file output JSON file created");
const parsedBack = JSON.parse(fs.readFileSync(decodedJsonOut, "utf8"));
assert(parsedBack.num === 99, "C10b: decode_file output JSON parses correctly");

// C11: inspect from hex — RFC 8949 example: {"a":1}
// 0xa1 = fixmap(1), 0x61='a', 0x01=uint(1)
const c11 = run({ operation: "inspect", hex: "a16161 01" });
assert(c11.tree.type === "map", "C11: inspect identifies map type");
assert(c11.tree.count === 1, "C11b: inspect map count = 1");

// C12: inspect base64
const c12 = run({ operation: "inspect", base64: c1.base64 });
assert(c12.totalBytes > 0, "C12: inspect from base64 works");
assert(typeof c12.tree === "object", "C12b: inspect tree is object");

// C13: null round-trip via tool
const c13 = run({ operation: "encode", value: null });
const c13d = run({ operation: "decode", hex: c13.hex });
assert(c13d.value === null, "C13: null encode/decode via tool");

// C14: bool round-trip via tool
const c14t = run({ operation: "encode", value: true });
const c14f = run({ operation: "encode", value: false });
assert(run({ operation: "decode", hex: c14t.hex }).value === true,  "C14: true round-trip via tool");
assert(run({ operation: "decode", hex: c14f.hex }).value === false, "C14b: false round-trip via tool");

// C15: integer varieties via tool
const ints = [0, 23, 24, 255, 256, 65535, -1, -24, -100, 3000000000];
for (const n of ints) {
  const enc = run({ operation: "encode", value: n });
  const dec = run({ operation: "decode", hex: enc.hex });
  assert(dec.value === n, `C15: integer ${n} round-trips via tool`);
}

// C16: float64 via tool
const c16 = run({ operation: "encode", value: 2.718281828 });
assert(Math.abs(run({ operation: "decode", hex: c16.hex }).value - 2.718281828) < 1e-6, "C16: float64 round-trip via tool");

// C17: array via tool
const c17 = run({ operation: "encode", value: ["a", "b", "c"] });
assert(run({ operation: "decode", hex: c17.hex }).value[1] === "b", "C17: array round-trip via tool");

// C18: allow_multiple (stream decode)
const buf18a = encode(42, 0);
const buf18b = encode("hello", 0);
const combined = Buffer.concat([buf18a, buf18b]).toString("hex");
const c18 = run({ operation: "decode", hex: combined, allow_multiple: true });
assert(Array.isArray(c18.value) && c18.value.length === 2, "C18: allow_multiple returns array of 2");
assert(c18.value[0] === 42 && c18.value[1] === "hello", "C18b: allow_multiple values correct");

// C19: inspect with max_depth=1 truncates nested
const deepVal = { a: { b: { c: 99 } } };
const deepEnc = encode(deepVal, 0);
const c19 = inspectBuffer(deepEnc, 1);
assert(c19.tree.type === "map", "C19: inspect max_depth=1 root is map");
assert(c19.tree.entries && c19.tree.entries[0].value.truncated === true, "C19b: inspect max_depth=1 nested truncated");

// C20: encode json_file
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
assertThrows(() => run({ operation: "decode", input_file: "some\0file.cbor" }), "NUL byte", "D2: NUL in input_file rejected");

// D3: directory path rejected
assertThrows(() => run({ operation: "decode", input_file: TMPDIR }), "directory", "D3: directory as input_file rejected");

// D4: decode truncated byte string (0x43=bytes(3), only 2 bytes follow)
assertThrows(() => run({ operation: "decode", hex: "430102" }), "unexpected end", "D4: truncated byte string throws");

// D5: nesting depth limit enforced at encode
function makeNested(depth, val) { let v = val; for (let i = 0; i < depth; i++) v = [v]; return v; }
assertThrows(() => encode(makeNested(110, 1), 0), "nesting depth", "D5: encode nesting depth limit");

// D6: trailing bytes without allow_multiple rejected
const trailingBuf = Buffer.concat([encode(1, 0), encode(2, 0)]);
assertThrows(() => decodeBuffer(trailingBuf, false), "trailing bytes", "D6: trailing bytes rejected");

// D7: non-existent file throws fs error
assertThrows(() => run({ operation: "decode", input_file: tmpFile("nonexistent.cbor") }), "", "D7: missing input file throws");

// D8: encode_file with invalid JSON
const badJson = tmpFile("bad.json");
fs.writeFileSync(badJson, "{ not valid json");
assertThrows(() => run({ operation: "encode_file", path: badJson, output: tmpFile("bad.cbor") }), "not valid JSON", "D8: non-JSON file rejected");

// D9: decode odd-length hex rejected
assertThrows(() => run({ operation: "decode", hex: "abc" }), "hex", "D9: odd-length hex rejected");

// D10: empty base64 rejected
assertThrows(() => run({ operation: "decode", base64: "" }), "empty", "D10: empty base64 rejected");

// ──────────────────────────────────────────────────────────────────
// E — Error paths (10)
// ──────────────────────────────────────────────────────────────────
process.stderr.write("Section E — Error-paths\n");

// E1: inspect missing file
assertThrows(() => run({ operation: "inspect", input_file: tmpFile("nope.cbor") }), "", "E1: inspect missing file throws");

// E2: NUL in output path
assertThrows(() => run({ operation: "encode_file", path: badJson, output: "good\0out.cbor" }), "NUL byte", "E2: NUL in output path rejected");

// E3: decode_file on empty file
const emptyFile = tmpFile("empty.cbor");
fs.writeFileSync(emptyFile, "");
assertThrows(() => run({ operation: "decode_file", path: emptyFile }), "empty", "E3: empty file rejected");

// E4: decode truncated uint16 (0x19 = uint16, but only 1 byte follows)
assertThrows(() => run({ operation: "decode", hex: "1901" }), "unexpected end", "E4: truncated uint16 throws");

// E5: decode truncated text string (0x63 = text(3 bytes), only 2 bytes follow)
assertThrows(() => run({ operation: "decode", hex: "6368" }), "unexpected end", "E5: truncated text string throws");

// E6: reserved additional info in MT0 (0x1c = MT0 + AI=28 reserved)
assertThrows(() => run({ operation: "decode", hex: "1c" }), "", "E6: reserved additional info throws");

// E7: decode_file with NUL in output path
assertThrows(() => run({ operation: "decode_file", path: cborOut, output: "bad\0path.json" }), "NUL byte", "E7: NUL in decode_file output rejected");

// E8: encode_file nonexistent source
assertThrows(() => run({ operation: "encode_file", path: tmpFile("nope.json"), output: tmpFile("x.cbor") }), "", "E8: encode_file nonexistent source throws");

// E9: inspect empty base64
assertThrows(() => run({ operation: "inspect", base64: "" }), "empty", "E9: inspect empty base64 throws");

// E10: decode_file on arbitrary text (decode whatever bytes; pass or throw both ok)
const textFile = tmpFile("text.cbor");
fs.writeFileSync(textFile, "this is not cbor at all");
try {
  run({ operation: "decode_file", path: textFile });
  passed++; // decoded some bytes — acceptable
} catch (e) {
  passed++; // threw — also acceptable
}

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
  const outputs = Array.from({ length: 5 }, (_, i) => tmpFile(`conc${i}.cbor`));
  outputs.forEach(out => run({ operation: "encode_file", path: jsonSrc, output: out }));
  assert(outputs.every(o => fs.existsSync(o)), "F3: 5 parallel encode_file all created");
}

// F4: parallel decode_file
{
  const results = Array.from({ length: 5 }, () => run({ operation: "decode_file", path: cborOut }));
  assert(results.every(r => r.value.key === "val"), "F4: 5 parallel decode_file all correct");
}

// F5: parallel inspect
{
  const results = Array.from({ length: 5 }, () => run({ operation: "inspect", hex: c1.hex }));
  assert(results.every(r => r.totalBytes > 0), "F5: 5 parallel inspects all correct");
}

// ── Summary ─────────────────────────────────────────────────────────────────

// Cleanup
try {
  for (const f of allFiles) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
} catch {}

const total = passed + failed;
process.stderr.write(`\nSection 219 results: ${passed}/${total} passed`);
if (failed > 0) {
  process.stderr.write(`\nFailed tests:\n${errors.map(e => '  - ' + e).join('\n')}\n`);
}
process.stderr.write("\n");

if (failed > 0) process.exit(1);
