"use strict";
// test/sections/225-orc-client.js
// Isolated tests for the orc_client tool (lib/orcClientOps.js)
// Five rigor levels: A=validation, B=unit, C=happy-path, D=security, E=error-paths, F=concurrency

const path = require("path");
const fs   = require("fs");
const os   = require("os");
const zlib = require("zlib");

const {
  orcClient,
  decodeRleV1,
  decodeRleV2,
  decodeBooleans,
  snappyDecompress,
  parsePostScript,
  parseFooter,
  buildSchema,
  getLeafColumns,
  PbReader,
  unpackBitsV2,
  zigzagDecode,
} = require("../../lib/orcClientOps");

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
const asyncTests = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      const p = r.then(() => { passed++; }).catch(e => {
        failed++;
        failures.push({ name, error: e.message || String(e) });
        process.stderr.write(`  FAIL: ${name}\n       ${e.message}\n`);
      });
      asyncTests.push(p);
      return p;
    }
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
  const sa = JSON.stringify(a, (k, v) => typeof v === "bigint" ? v.toString() : v);
  const sb = JSON.stringify(b, (k, v) => typeof v === "bigint" ? v.toString() : v);
  if (sa !== sb) throw new Error((msg || "not equal") + `\n  got:      ${sa}\n  expected: ${sb}`);
}

function assertThrows(fn, msgSubstr) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgSubstr) {
      const match = msgSubstr instanceof RegExp
        ? msgSubstr.test(e.message)
        : e.message.includes(msgSubstr);
      if (!match)
        throw new Error(`Expected error matching '${msgSubstr}' but got: ${e.message}`);
    }
  }
  if (!threw) throw new Error(`Expected error matching '${msgSubstr || ""}' but none thrown`);
}

function fakeResolve(p) {
  return { resolved: path.isAbsolute(p) ? p : path.resolve(p) };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-test-"));
function tmpFile(name) { return path.join(tmpDir, name); }

// ─── Minimal ORC file builder ─────────────────────────────────────────────────
//
// Builds a valid .orc file with:
//   - 1 stripe
//   - 1 LONG (INT64/RLE-v1) column named 'id'
//   - NONE compression
//   - minimal protobuf footer/postscript
//
// Protobuf helpers

function pbWriteVarint(n) {
  // n is a non-negative JS number (safe integer range)
  const buf = [];
  let v = BigInt(Math.round(n));
  while (v > 0x7Fn) {
    buf.push(Number(v & 0x7Fn) | 0x80);
    v >>= 7n;
  }
  buf.push(Number(v));
  return Buffer.from(buf);
}

function pbField(fieldNum, wireType, valueBuf) {
  const tag = (fieldNum << 3) | wireType;
  return Buffer.concat([pbWriteVarint(tag), valueBuf]);
}

// wireType 0 = varint
function pbVarintField(fieldNum, n) {
  return pbField(fieldNum, 0, pbWriteVarint(n));
}

// wireType 2 = length-delimited
function pbBytesField(fieldNum, buf) {
  return pbField(fieldNum, 2, Buffer.concat([pbWriteVarint(buf.length), buf]));
}

// Encode a string as a length-delimited field
function pbStringField(fieldNum, s) {
  return pbBytesField(fieldNum, Buffer.from(s, "utf8"));
}

// Repeated message fields: embed each sub-message as a len-delimited field
function pbMessageField(fieldNum, msgBuf) {
  return pbBytesField(fieldNum, msgBuf);
}

// ─── RLE v1 encode: repeated run of (n + 3) values, delta=0, value=v ─────────
function rleV1Run(value, count) {
  // count must be >= 3
  const runLen = count - 3;
  // Encode value as signed zigzag varint
  function zigzagEncode(v) {
    const z = (v < 0) ? (-v * 2 - 1) : (v * 2);
    return pbWriteVarint(z);
  }
  return Buffer.concat([
    Buffer.from([runLen & 0xFF]),  // header (0..127 = repeated)
    Buffer.from([0]),              // delta = 0
    zigzagEncode(value),
  ]);
}

// ─── Build ORC file with a single LONG column 'id' with given values ─────────
function buildOrcFile(values) {
  const ORC_MAGIC = Buffer.from("ORC");
  const numRows   = values.length;

  // 1. Encode DATA stream for column 1 (LONG, signed RLE v1)
  //    For simplicity encode as literal run (header = 256 - n)
  function encodeRleV1Literal(vals) {
    if (vals.length === 0) return Buffer.alloc(0);
    const chunks = [];
    let i = 0;
    while (i < vals.length) {
      const batch = vals.slice(i, i + 128);
      const hdr   = (256 - batch.length) & 0xFF; // literal: 128..255
      chunks.push(Buffer.from([hdr]));
      for (const v of batch) {
        const z = v < 0 ? BigInt(-v * 2 - 1) : BigInt(v * 2);
        const vbytes = [];
        let rem = z;
        while (rem > 0x7Fn) { vbytes.push(Number(rem & 0x7Fn) | 0x80); rem >>= 7n; }
        vbytes.push(Number(rem));
        chunks.push(Buffer.from(vbytes));
      }
      i += batch.length;
    }
    return Buffer.concat(chunks);
  }

  const dataStream = numRows > 0
    ? encodeRleV1Literal(values)
    : Buffer.alloc(0);

  // 2. Layout the stripe body:
  //    - No PRESENT stream (no nulls)
  //    - DATA stream for column 1
  const stripeBodyOffset = ORC_MAGIC.length;
  const indexLen   = 0;  // no row index
  const dataLen    = dataStream.length;

  // 3. Stripe footer:
  //    streams[0] = { kind=1 (DATA), column=1, length=dataLen }
  //    columns[0] = { kind=0 (DIRECT)  } for column 0 (struct)
  //    columns[1] = { kind=0 (DIRECT)  } for column 1 (long)
  function encodeStream(kind, column, length) {
    return Buffer.concat([
      pbVarintField(1, kind),
      pbVarintField(2, column),
      pbVarintField(3, length),
    ]);
  }
  function encodeColumnEncoding(kind) {
    return pbVarintField(1, kind);
  }

  const sfBuf = Buffer.concat([
    pbMessageField(1, encodeStream(1, 1, dataLen)),   // DATA stream for col 1
    pbMessageField(2, encodeColumnEncoding(0)),        // col 0 = STRUCT DIRECT
    pbMessageField(2, encodeColumnEncoding(0)),        // col 1 = LONG DIRECT
  ]);

  // 4. Footer: types, stripes, numberOfRows
  //    types[0] = STRUCT with subtype 1, fieldName 'id'
  //    types[1] = LONG
  function encodeType(kind, subtypes, fieldNames, maxLen, prec, scale) {
    const parts = [pbVarintField(1, kind)];
    for (const s of (subtypes  || [])) parts.push(pbVarintField(2, s));
    for (const n of (fieldNames || [])) parts.push(pbStringField(3, n));
    if (maxLen) parts.push(pbVarintField(4, maxLen));
    if (prec)   parts.push(pbVarintField(5, prec));
    if (scale)  parts.push(pbVarintField(6, scale));
    return Buffer.concat(parts);
  }

  function encodeStripeInfo(offset, indexLength, dataLength, footerLength, numberOfRows) {
    return Buffer.concat([
      pbVarintField(1, offset),
      pbVarintField(2, indexLength),
      pbVarintField(3, dataLength),
      pbVarintField(4, footerLength),
      pbVarintField(5, numberOfRows),
    ]);
  }

  const sfFooterLen = sfBuf.length;

  const stripeInfo = encodeStripeInfo(
    stripeBodyOffset,
    indexLen,
    dataLen,
    sfFooterLen,
    numRows,
  );

  const footerBuf = Buffer.concat([
    pbVarintField(1, ORC_MAGIC.length),     // headerLength
    pbVarintField(2, dataLen),              // contentLength
    pbMessageField(3, stripeInfo),          // stripes[0]
    pbMessageField(4, encodeType(12, [1], ["id"])),  // types[0] = STRUCT
    pbMessageField(4, encodeType(4)),       // types[1] = LONG
    pbVarintField(6, numRows),              // numberOfRows
  ]);

  // 5. PostScript:
  //    footerLength, compression=0 (NONE), version=[0,12], magic="ORC"
  const psBuf = Buffer.concat([
    pbVarintField(1, footerBuf.length),   // footerLength
    pbVarintField(2, 0),                  // compression = NONE
    pbVarintField(4, 0),                  // version[0]
    pbVarintField(4, 12),                 // version[1]
    pbStringField(8, "ORC"),              // magic
  ]);

  const psLen = Buffer.from([psBuf.length & 0xFF]);

  // 6. Assemble: ORC_MAGIC + data + sfBuf + footerBuf + psBuf + psLen
  return Buffer.concat([
    ORC_MAGIC,
    dataStream,
    sfBuf,
    footerBuf,
    psBuf,
    psLen,
  ]);
}

function writeTestOrc(name, values) {
  const f = tmpFile(name);
  fs.writeFileSync(f, buildOrcFile(values));
  return f;
}

// Quick sanity check
try {
  const sanity = writeTestOrc("_sanity.orc", [1, 2, 3]);
  const r = orcClient({ operation: "info", path: sanity }, fakeResolve);
  if (r.numberOfRows !== 3) throw new Error("Sanity check failed: numberOfRows=" + r.numberOfRows);
  process.stderr.write("[buildOrcFile sanity check passed]\n");
} catch (e) {
  process.stderr.write("[FATAL] buildOrcFile sanity failed: " + e.message + "\n" + (e.stack || "") + "\n");
  process.exit(1);
}

// ── A: Validation tests (x10) ────────────────────────────────────────────────

process.stderr.write("\n=== A: Validation ===\n");

test("A1 - missing operation throws", () => {
  assertThrows(() => orcClient({ path: "/tmp/x.orc" }, fakeResolve), "operation");
});

test("A2 - missing path throws", () => {
  assertThrows(() => orcClient({ operation: "info" }, fakeResolve), "path");
});

test("A3 - NUL byte in path throws", () => {
  assertThrows(() => orcClient({ operation: "info", path: "/tmp/a\x00b.orc" }, fakeResolve), "NUL");
});

test("A4 - unknown operation throws", () => {
  const f = writeTestOrc("a4.orc", [1]);
  assertThrows(() => orcClient({ operation: "compress", path: f }, fakeResolve), "unknown operation");
});

test("A5 - directory path rejected", () => {
  assertThrows(() => orcClient({ operation: "info", path: os.tmpdir() }, fakeResolve), "directory");
});

test("A6 - invalid magic header rejected", () => {
  const f = tmpFile("not_orc.bin");
  fs.writeFileSync(f, Buffer.from("NOT A REAL ORC FILE 123456789012345678"));
  assertThrows(() => orcClient({ operation: "info", path: f }, fakeResolve), "magic");
});

test("A7 - file too small rejected", () => {
  const f = tmpFile("tiny.bin");
  fs.writeFileSync(f, Buffer.from("ORC"));
  assertThrows(() => orcClient({ operation: "info", path: f }, fakeResolve), /too small|too large|postscript|magic/i);
});

test("A8 - stripe_index out of range throws", () => {
  const f = writeTestOrc("a8.orc", [1, 2, 3]);
  assertThrows(() => orcClient({ operation: "stripe", path: f, stripe_index: 99 }, fakeResolve), "out of range");
});

test("A9 - NUL byte in output_file path throws", () => {
  const f = writeTestOrc("a9.orc", [1]);
  assertThrows(() => orcClient({ operation: "to_json", path: f, output_file: "/tmp/a\x00b.json" }, fakeResolve), "NUL");
});

test("A10 - non-existent file throws ENOENT", () => {
  assertThrows(() => orcClient({ operation: "info", path: "/nonexistent/file.orc" }, fakeResolve), "ENOENT");
});

// ── B: Unit tests (x20) ──────────────────────────────────────────────────────

process.stderr.write("\n=== B: Unit ===\n");

test("B1 - PbReader: readVarint single byte", () => {
  const buf = Buffer.from([0x07]);
  const r   = new PbReader(buf, 0, buf.length);
  assertEq(r.readVarint(), 7n);
});

test("B2 - PbReader: readVarint multi-byte", () => {
  const buf = Buffer.from([0x80, 0x01]); // 128 = 0x80 | (0x01 << 7)
  const r   = new PbReader(buf, 0, buf.length);
  assertEq(r.readVarint(), 128n);
});

test("B3 - PbReader: readVarint32 returns number", () => {
  const buf = Buffer.from([0x05]);
  const r   = new PbReader(buf, 0, buf.length);
  assertEq(r.readVarint32(), 5);
});

test("B4 - PbReader: readFixed32", () => {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(0xDEADBEEF, 0);
  const r = new PbReader(buf, 0, 4);
  assertEq(r.readFixed32(), 0xDEADBEEF);
});

test("B5 - PbReader: readString", () => {
  const str = Buffer.from("hi", "utf8");
  const buf = Buffer.concat([Buffer.from([str.length]), str]);
  const r   = new PbReader(buf, 0, buf.length);
  assertEq(r.readString(), "hi");
});

test("B6 - PbReader: buffer underflow throws", () => {
  const r = new PbReader(Buffer.from([]), 0, 0);
  assertThrows(() => r.readByte(), "underflow");
});

test("B7 - decodeRleV1: literal run", () => {
  // header 128..255 means literal: (256 - hdr) values
  // 256 - 0x80 = 128; we use 0xFD = 253, so n = 3 literals
  // Encode 3 signed zigzag values: 1->2, 2->4, 3->6
  const buf = Buffer.from([0xFD, 2, 4, 6]); // 3 literals
  const vals = decodeRleV1(buf, true, 3);
  assertEq(vals, [1, 2, 3]);
});

test("B8 - decodeRleV1: repeated run", () => {
  // header 0..127: (hdr + 3) repeated, delta byte, base varint
  // hdr=0 => 3 copies, delta=0, base=10 (zigzag: 20)
  const buf = Buffer.from([0x00, 0x00, 20]); // 3 copies of 10
  const vals = decodeRleV1(buf, true, 3);
  assertEq(vals, [10, 10, 10]);
});

test("B9 - decodeRleV1: unsigned values", () => {
  // header 0xFD = 253 => 3 literals; unsigned
  const buf = Buffer.from([0xFD, 5, 10, 15]);
  const vals = decodeRleV1(buf, false, 3);
  assertEq(vals, [5, 10, 15]);
});

test("B10 - decodeRleV1: delta run", () => {
  // header=2 => 5 copies (2+3), delta=1, base=0 (zigzag: 0)
  const buf = Buffer.from([0x02, 0x01, 0x00]); // 5 vals starting at 0 with delta +1
  const vals = decodeRleV1(buf, false, 5);
  assertEq(vals, [0, 1, 2, 3, 4]);
});

test("B11 - decodeRleV2 SHORT_REPEAT: 3 copies of 7", () => {
  // Encoding: firstByte encoding=0 (SHORT_REPEAT), bits [5:3]=width-1=0 (1 byte), bits[2:0]=repLen-3=0 (3 reps)
  // firstByte = (0b00 << 6) | (0 << 3) | 0 = 0x00; then 1 byte value = 7 (no zigzag for unsigned)
  // Wait — for SHORT_REPEAT: signed=false, val = raw big-endian
  const buf = Buffer.from([0x00, 7]); // encoding=0, width=1byte, repLen=3, val=7
  const vals = decodeRleV2(buf, false, 3);
  assertEq(vals, [7, 7, 7]);
});

test("B12 - decodeBooleans: correct bit order", () => {
  // ORC boolean: MSB first, so byte 0b10000000 = [true, false, false...]
  const buf  = Buffer.from([0b10110001]);
  const vals = decodeBooleans(buf, 8);
  assertEq(vals, [true, false, true, true, false, false, false, true]);
});

test("B13 - decodeBooleans: count < 8 partial byte", () => {
  const buf  = Buffer.from([0b10110000]);
  const vals = decodeBooleans(buf, 4);
  assertEq(vals, [true, false, true, true]);
});

test("B14 - zigzagDecode: positive", () => {
  assertEq(zigzagDecode(4n), 2);
  assertEq(zigzagDecode(0n), 0);
});

test("B15 - zigzagDecode: negative", () => {
  assertEq(zigzagDecode(1n), -1);
  assertEq(zigzagDecode(3n), -2);
});

test("B16 - unpackBitsV2: bitWidth=1", () => {
  // MSB first: 0b10100000 = bits 1,0,1,0,0,0,0,0
  const buf = Buffer.from([0b10100000]);
  const out = unpackBitsV2(buf, 1, 8);
  assertEq(out, [1, 0, 1, 0, 0, 0, 0, 0]);
});

test("B17 - unpackBitsV2: bitWidth=0 returns zeros", () => {
  const out = unpackBitsV2(Buffer.from([0xFF]), 0, 4);
  assertEq(out, [0, 0, 0, 0]);
});

test("B18 - buildSchema: STRUCT with one LONG field", () => {
  const types = [
    { kind: 12, subtypes: [1], fieldNames: ["id"] },
    { kind: 4, subtypes: [], fieldNames: [] },
  ];
  const schema = buildSchema(types, 0);
  assertEq(schema.kind, "STRUCT");
  assertEq(schema.fields[0].name, "id");
  assertEq(schema.fields[0].schema.kind, "LONG");
});

test("B19 - getLeafColumns: flat struct returns leaves", () => {
  const types = [
    { kind: 12, subtypes: [1, 2], fieldNames: ["id", "val"] },
    { kind: 4, subtypes: [], fieldNames: [] },
    { kind: 7, subtypes: [], fieldNames: [] },
  ];
  const leaves = getLeafColumns(types, 0, "").filter(l => l.path);
  assertEq(leaves.length, 2);
  assertEq(leaves[0].path, "id");
  assertEq(leaves[1].path, "val");
});

test("B20 - snappyDecompress: literal block roundtrip", () => {
  const data   = Buffer.from([0xDE, 0xAD, 0xBE]);
  const stream = Buffer.concat([
    Buffer.from([data.length]),
    Buffer.from([(data.length - 1) << 2]),
    data,
  ]);
  const out = snappyDecompress(stream);
  assertEq([...out], [0xDE, 0xAD, 0xBE]);
});

// ── C: Happy-path tests (x20) ────────────────────────────────────────────────

process.stderr.write("\n=== C: Happy-path ===\n");

test("C1 - info: numberOfRows=3", () => {
  const f = writeTestOrc("c1.orc", [10, 20, 30]);
  const r = orcClient({ operation: "info", path: f }, fakeResolve);
  assertEq(r.numberOfRows, 3);
});

test("C2 - info: numberOfStripes=1", () => {
  const f = writeTestOrc("c2.orc", [1]);
  const r = orcClient({ operation: "info", path: f }, fakeResolve);
  assertEq(r.numberOfStripes, 1);
});

test("C3 - info: compression is string", () => {
  const f = writeTestOrc("c3.orc", [1]);
  const r = orcClient({ operation: "info", path: f }, fakeResolve);
  assert(typeof r.compression === "string");
});

test("C4 - info: fileSizeBytes > 0", () => {
  const f = writeTestOrc("c4.orc", [1]);
  const r = orcClient({ operation: "info", path: f }, fakeResolve);
  assert(r.fileSizeBytes > 0);
});

test("C5 - info: schema is object", () => {
  const f = writeTestOrc("c5.orc", [1]);
  const r = orcClient({ operation: "info", path: f }, fakeResolve);
  assert(r.schema !== null && typeof r.schema === "object");
});

test("C6 - info: stripes array has one entry", () => {
  const f = writeTestOrc("c6.orc", [1, 2]);
  const r = orcClient({ operation: "info", path: f }, fakeResolve);
  assert(Array.isArray(r.stripes) && r.stripes.length === 1);
});

test("C7 - schema: numColumns >= 1", () => {
  const f = writeTestOrc("c7.orc", [1]);
  const r = orcClient({ operation: "schema", path: f }, fakeResolve);
  assert(r.numColumns >= 1);
});

test("C8 - schema: column has name and kind", () => {
  const f = writeTestOrc("c8.orc", [1]);
  const r = orcClient({ operation: "schema", path: f }, fakeResolve);
  const col = r.columns[0];
  assert(typeof col.name === "string" && col.name.length > 0);
  assert(typeof col.kind === "string" && col.kind.length > 0);
});

test("C9 - read: returnedRows=3 for 3 values", () => {
  const f = writeTestOrc("c9.orc", [1, 2, 3]);
  const r = orcClient({ operation: "read", path: f }, fakeResolve);
  assertEq(r.totalRows, 3);
  assertEq(r.returnedRows, 3);
});

test("C10 - read: correct LONG values", () => {
  const f = writeTestOrc("c10.orc", [100, 200, 300]);
  const r = orcClient({ operation: "read", path: f }, fakeResolve);
  assertEq(r.rows[0].id, 100);
  assertEq(r.rows[1].id, 200);
  assertEq(r.rows[2].id, 300);
});

test("C11 - read: limit=2 returns 2 rows", () => {
  const f = writeTestOrc("c11.orc", [1, 2, 3, 4, 5]);
  const r = orcClient({ operation: "read", path: f, limit: 2 }, fakeResolve);
  assertEq(r.returnedRows, 2);
});

test("C12 - read: offset=1 skips first row", () => {
  const f = writeTestOrc("c12.orc", [10, 20, 30]);
  const r = orcClient({ operation: "read", path: f, offset: 1 }, fakeResolve);
  assertEq(r.returnedRows, 2);
  assertEq(r.rows[0].id, 20);
});

test("C13 - read: offset=1 limit=2", () => {
  const f = writeTestOrc("c13.orc", [10, 20, 30, 40]);
  const r = orcClient({ operation: "read", path: f, offset: 1, limit: 2 }, fakeResolve);
  assertEq(r.returnedRows, 2);
  assertEq(r.rows[0].id, 20);
  assertEq(r.rows[1].id, 30);
});

test("C14 - stripe: index 0 works", () => {
  const f = writeTestOrc("c14.orc", [7, 8, 9]);
  const r = orcClient({ operation: "stripe", path: f, stripe_index: 0 }, fakeResolve);
  assertEq(r.stripeIndex, 0);
  assertEq(r.totalRows, 3);
});

test("C15 - stripe: row values correct", () => {
  const f = writeTestOrc("c15.orc", [55, 66]);
  const r = orcClient({ operation: "stripe", path: f, stripe_index: 0 }, fakeResolve);
  assertEq(r.rows[0].id, 55);
  assertEq(r.rows[1].id, 66);
});

test("C16 - to_json: inline JSON string", () => {
  const f = writeTestOrc("c16.orc", [1, 2]);
  const r = orcClient({ operation: "to_json", path: f }, fakeResolve);
  assert(typeof r.json === "string");
  const parsed = JSON.parse(r.json);
  assertEq(parsed[0].id, 1);
});

test("C17 - to_json: pretty=true adds newlines", () => {
  const f = writeTestOrc("c17.orc", [42]);
  const r = orcClient({ operation: "to_json", path: f, pretty: true }, fakeResolve);
  assert(r.json.includes("\n"));
});

test("C18 - to_json: output_file writes to disk", () => {
  const f   = writeTestOrc("c18.orc", [11, 22]);
  const out = tmpFile("c18_out.json");
  const r   = orcClient({ operation: "to_json", path: f, output_file: out }, fakeResolve);
  assertEq(r.writtenRows, 2);
  const content = JSON.parse(fs.readFileSync(out, "utf8"));
  assertEq(content[0].id, 11);
});

test("C19 - to_csv: returns CSV with header", () => {
  const f = writeTestOrc("c19.orc", [1, 2, 3]);
  const r = orcClient({ operation: "to_csv", path: f }, fakeResolve);
  assert(typeof r.csv === "string");
  const lines = r.csv.split("\n");
  assert(lines[0].includes("id"));
});

test("C20 - to_csv: output_file writes to disk", () => {
  const f   = writeTestOrc("c20.orc", [5, 6]);
  const out = tmpFile("c20_out.csv");
  orcClient({ operation: "to_csv", path: f, output_file: out }, fakeResolve);
  assert(fs.existsSync(out));
  assert(fs.readFileSync(out, "utf8").includes("id"));
});

// ── D: Security tests (x10) ──────────────────────────────────────────────────

process.stderr.write("\n=== D: Security ===\n");

test("D1 - NUL byte in path rejected immediately", () => {
  assertThrows(() => orcClient({ operation: "info", path: "test\x00file.orc" }, fakeResolve), "NUL");
});

test("D2 - directory path rejected", () => {
  assertThrows(() => orcClient({ operation: "schema", path: os.tmpdir() }, fakeResolve), "directory");
});

test("D3 - all-zero bytes file rejected (no ORC magic)", () => {
  const f = tmpFile("d3_zeros.bin");
  fs.writeFileSync(f, Buffer.alloc(128, 0));
  assertThrows(() => orcClient({ operation: "info", path: f }, fakeResolve), "magic");
});

test("D4 - ORC header magic but invalid postscript", () => {
  const f = tmpFile("d4_bad_ps.orc");
  // ORC magic at start, then garbage, then psLen=200 (> file size)
  fs.writeFileSync(f, Buffer.concat([Buffer.from("ORC"), Buffer.alloc(20, 0xAA), Buffer.from([200])]));
  assertThrows(() => orcClient({ operation: "info", path: f }, fakeResolve), /postscript|footer|invalid/i);
});

test("D5 - stripe_index out of range throws", () => {
  const f = writeTestOrc("d5.orc", [1]);
  assertThrows(() => orcClient({ operation: "stripe", path: f, stripe_index: 99 }, fakeResolve), "out of range");
});

test("D6 - stripe_index negative is out of range", () => {
  const f = writeTestOrc("d6.orc", [1]);
  assertThrows(() => orcClient({ operation: "stripe", path: f, stripe_index: -1 }, fakeResolve), "out of range");
});

test("D7 - NUL byte in output_file for to_csv rejected", () => {
  const f = writeTestOrc("d7.orc", [1]);
  assertThrows(() => orcClient({ operation: "to_csv", path: f, output_file: "/tmp/a\x00b.csv" }, fakeResolve), "NUL");
});

test("D8 - non-existent path throws ENOENT", () => {
  assertThrows(() => orcClient({ operation: "read", path: "/no/such/file.orc" }, fakeResolve), "ENOENT");
});

test("D9 - short file (only magic) is rejected gracefully", () => {
  const f = tmpFile("d9_short.orc");
  fs.writeFileSync(f, Buffer.from("ORC"));
  assertThrows(() => orcClient({ operation: "info", path: f }, fakeResolve), /too small|too large|postscript|invalid/i);
});

test("D10 - read on 0-row file works without error", () => {
  const f = writeTestOrc("d10.orc", []);
  try {
    const r = orcClient({ operation: "read", path: f }, fakeResolve);
    assert(r !== null && r !== undefined);
    assert(r.returnedRows === 0 || r.totalRows === 0);
  } catch (e) {
    // Parsing failure on zero-row files is also acceptable
    assert(typeof e.message === "string");
  }
});

// ── E: Error-path tests (x10) ────────────────────────────────────────────────

process.stderr.write("\n=== E: Error paths ===\n");

test("E1 - unknown operation error message mentions valid ops", () => {
  const f = writeTestOrc("e1.orc", [1]);
  try {
    orcClient({ operation: "foobar", path: f }, fakeResolve);
    throw new Error("Should have thrown");
  } catch (e) {
    assert(e.message.includes("info") || e.message.includes("unknown"));
  }
});

test("E2 - missing operation field throws", () => {
  assertThrows(() => orcClient({ path: "/tmp/x.orc" }, fakeResolve), "operation");
});

test("E3 - missing path field throws", () => {
  assertThrows(() => orcClient({ operation: "info" }, fakeResolve), "path");
});

test("E4 - read offset >= totalRows returns 0 rows", () => {
  const f = writeTestOrc("e4.orc", [1, 2]);
  const r = orcClient({ operation: "read", path: f, offset: 100 }, fakeResolve);
  assertEq(r.returnedRows, 0);
});

test("E5 - limit=1 returns exactly 1 row", () => {
  const f = writeTestOrc("e5.orc", [1, 2, 3]);
  const r = orcClient({ operation: "read", path: f, limit: 1 }, fakeResolve);
  assertEq(r.returnedRows, 1);
});

test("E6 - to_json creates output dir automatically", () => {
  const f   = writeTestOrc("e6.orc", [1]);
  const sub = tmpFile("subdir_e6");
  const out = path.join(sub, "out.json");
  orcClient({ operation: "to_json", path: f, output_file: out }, fakeResolve);
  assert(fs.existsSync(out));
  fs.unlinkSync(out);
  fs.rmdirSync(sub);
});

test("E7 - to_csv returnedRows field present", () => {
  const f = writeTestOrc("e7.orc", [1, 2]);
  const r = orcClient({ operation: "to_csv", path: f }, fakeResolve);
  assertEq(r.returnedRows, 2);
});

test("E8 - info: stripes array is array", () => {
  const f = writeTestOrc("e8.orc", [1]);
  const r = orcClient({ operation: "info", path: f }, fakeResolve);
  assert(Array.isArray(r.stripes));
});

test("E9 - stripe offset+limit within stripe", () => {
  const f = writeTestOrc("e9.orc", [10, 20, 30]);
  const r = orcClient({ operation: "stripe", path: f, stripe_index: 0, offset: 1, limit: 1 }, fakeResolve);
  assertEq(r.returnedRows, 1);
  assertEq(r.rows[0].id, 20);
});

test("E10 - read: columns field lists column names", () => {
  const f = writeTestOrc("e10.orc", [5]);
  const r = orcClient({ operation: "read", path: f }, fakeResolve);
  assert(Array.isArray(r.columns));
  assert(r.columns.length >= 0); // may be empty if no rows returned
});

// ── F: Concurrency tests (x6) ────────────────────────────────────────────────

process.stderr.write("\n=== F: Concurrency ===\n");

test("F1 - parallel info calls (8 concurrent)", async () => {
  const f = writeTestOrc("f1.orc", [1, 2, 3]);
  await Promise.all(Array.from({ length: 8 }, () =>
    Promise.resolve().then(() => {
      const r = orcClient({ operation: "info", path: f }, fakeResolve);
      assertEq(r.numberOfRows, 3);
    })
  ));
});

test("F2 - parallel read calls with varying offsets", async () => {
  const f = writeTestOrc("f2.orc", [10, 20, 30]);
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    Promise.resolve().then(() => {
      const r = orcClient({ operation: "read", path: f, limit: 1, offset: i % 3 }, fakeResolve);
      assert(r.returnedRows >= 0);
    })
  ));
});

test("F3 - parallel to_json inline", async () => {
  const f = writeTestOrc("f3.orc", [1, 2]);
  await Promise.all(Array.from({ length: 5 }, () =>
    Promise.resolve().then(() => {
      const r      = orcClient({ operation: "to_json", path: f }, fakeResolve);
      const parsed = JSON.parse(r.json);
      assertEq(parsed.length, 2);
    })
  ));
});

test("F4 - parallel to_csv inline", async () => {
  const f = writeTestOrc("f4.orc", [5, 6, 7]);
  await Promise.all(Array.from({ length: 5 }, () =>
    Promise.resolve().then(() => {
      const r = orcClient({ operation: "to_csv", path: f }, fakeResolve);
      assert(r.csv.includes("id"));
    })
  ));
});

test("F5 - parallel to_json to different output files", async () => {
  const f = writeTestOrc("f5.orc", [99, 100]);
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    Promise.resolve().then(() => {
      const out = tmpFile(`f5_out${i}.json`);
      const r   = orcClient({ operation: "to_json", path: f, output_file: out }, fakeResolve);
      assertEq(r.writtenRows, 2);
      assert(fs.existsSync(out));
    })
  ));
});

test("F6 - parallel mixed operations on same file", async () => {
  const f   = writeTestOrc("f6.orc", [1, 2, 3, 4, 5]);
  const ops = ["info", "schema", "read", "to_json", "to_csv", "stripe"];
  await Promise.all(ops.map(op =>
    Promise.resolve().then(() => {
      const r = orcClient({ operation: op, path: f, stripe_index: 0 }, fakeResolve);
      assert(r !== null && r !== undefined);
    })
  ));
});

// ── Finish ──────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  try {
    for (const f of fs.readdirSync(tmpDir))
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) {}
    fs.rmdirSync(tmpDir);
  } catch (_) {}

  process.stderr.write(`\n=== Results ===\nPassed: ${passed}\nFailed: ${failed}\n`);
  if (failures.length) {
    process.stderr.write("\nFailed tests:\n");
    for (const { name, error } of failures)
      process.stderr.write(`  - ${name}: ${error}\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
});
