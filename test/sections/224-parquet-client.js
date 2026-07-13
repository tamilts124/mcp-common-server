"use strict";
// test/sections/224-parquet-client.js
// Isolated tests for the parquet_client tool (lib/parquetClientOps.js)
// Five rigor levels: A=validation, B=unit, C=happy-path, D=security, E=error-paths, F=concurrency

const path = require("path");
const fs   = require("fs");
const os   = require("os");

const {
  parquetClient,
  snappyDecompress,
  flattenSchema,
  buildSchemaTree,
  readRleBpHybrid,
  unpackBits,
  decodeDeltaBinaryPacked,
  convertValue,
  ThriftCompact,
} = require("../../lib/parquetClientOps");

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
  // Convert BigInt to string for comparison
  const sa = JSON.stringify(a, (k, v) => typeof v === "bigint" ? v.toString() : v);
  const sb = JSON.stringify(b, (k, v) => typeof v === "bigint" ? v.toString() : v);
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

function fakeResolve(p) {
  return { resolved: path.isAbsolute(p) ? p : path.resolve(p) };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parquet-test-"));
function tmpFile(name) { return path.join(tmpDir, name); }

// ─── Minimal Parquet file builder (compact thrift, single INT32 column) ──────
//
// Encodes a valid Parquet v2 file with:
//   - single column 'id' (INT32, REQUIRED, PLAIN, UNCOMPRESSED)
//   - one row group
//   - one DATA_PAGE (v1)

function encodeVarInt(n) {
  // Encode a non-negative integer as a compact-thrift varint
  const bytes = [];
  let v = n;
  while (v > 0x7F) {
    bytes.push((v & 0x7F) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeZigzag32(v) {
  // ZigZag encode int32 then write as varint
  const z = (v << 1) ^ (v >> 31);
  return encodeVarInt(z >>> 0); // treat as unsigned
}

function encodeZigzag64(v) {
  // v is a JS safe integer; zigzag encode
  const b = BigInt(v);
  const z = (b << 1n) ^ (b >> 63n);
  // Write as varint (z is always non-negative)
  const bytes = [];
  let rem = z;
  while (rem > 0x7Fn) {
    bytes.push(Number(rem & 0x7Fn) | 0x80);
    rem >>= 7n;
  }
  bytes.push(Number(rem));
  return Buffer.from(bytes);
}

// T_ constants for compact thrift field types
const CT_BOOL_TRUE  = 1;
const CT_I32        = 5;
const CT_I64        = 6;
const CT_BINARY     = 8;
const CT_LIST       = 9;
const CT_STRUCT     = 12;

function structField(id, type, value) {
  return { id, type, value };
}

function encodeStruct(fields) {
  const parts = [];
  let prevId = 0;
  for (const f of fields) {
    const delta = f.id - prevId;
    if (delta > 0 && delta <= 15) {
      parts.push(Buffer.from([(delta << 4) | (f.type & 0x0F)]));
    } else {
      parts.push(Buffer.from([f.type & 0x0F]));
      parts.push(encodeZigzag32(f.id));
    }
    parts.push(f.value);
    prevId = f.id;
  }
  parts.push(Buffer.from([0x00])); // STOP byte
  return Buffer.concat(parts);
}

function encodeString(s) {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([encodeVarInt(b.length), b]);
}

function encodeListHeader(elemType, count) {
  if (count < 15) {
    return Buffer.from([(count << 4) | (elemType & 0x0F)]);
  }
  return Buffer.concat([Buffer.from([0xF0 | (elemType & 0x0F)]), encodeVarInt(count)]);
}

/**
 * Build a minimal .parquet file bytes for an array of INT32 values in column 'id'.
 */
function buildParquetFile(values) {
  const MAGIC = Buffer.from("PAR1");
  const numRows = values.length;

  // ---- Page body: PLAIN INT32 (4 bytes LE each) ----
  const pageBody = Buffer.allocUnsafe(numRows * 4);
  for (let i = 0; i < numRows; i++) pageBody.writeInt32LE(values[i], i * 4);

  // ---- DataPageHeader (field 5 inside page header) ----
  const dataPageHdrFields = encodeStruct([
    structField(1, CT_I32, encodeZigzag32(numRows)),  // numValues
    structField(2, CT_I32, encodeZigzag32(0)),         // encoding = PLAIN
    structField(3, CT_I32, encodeZigzag32(0)),         // defLevelEncoding = PLAIN
    structField(4, CT_I32, encodeZigzag32(0)),         // repLevelEncoding = PLAIN
  ]);

  // ---- Page header (type 0=DATA_PAGE, sizes, DataPageHeader) ----
  const pageHdr = encodeStruct([
    structField(1, CT_I32, encodeZigzag32(0)),                   // type = DATA_PAGE
    structField(2, CT_I32, encodeZigzag32(pageBody.length)),     // uncompressedSize
    structField(3, CT_I32, encodeZigzag32(pageBody.length)),     // compressedSize
    structField(5, CT_STRUCT, dataPageHdrFields),                // DataPageHeader
  ]);

  // Data starts right after MAGIC
  const dataPageOffset = MAGIC.length;

  // ---- Column chunk metadata ----
  // pathInSchema = ["id"] -- list of string
  const pathInSchema = Buffer.concat([
    encodeListHeader(CT_BINARY, 1),
    encodeString("id"),
  ]);
  // encodings = [0 (PLAIN)] -- list of i32
  const encodingsList = Buffer.concat([
    encodeListHeader(CT_I32, 1),
    encodeZigzag32(0),
  ]);
  const colMeta = encodeStruct([
    structField(1, CT_I32, encodeZigzag32(1)),              // type = INT32
    structField(2, CT_LIST, encodingsList),                  // encodings
    structField(3, CT_LIST, pathInSchema),                   // pathInSchema
    structField(4, CT_I32, encodeZigzag32(0)),              // codec = UNCOMPRESSED
    structField(5, CT_I64, encodeZigzag64(numRows)),        // numValues
    structField(6, CT_I64, encodeZigzag64(pageBody.length)), // totalUncompressed
    structField(7, CT_I64, encodeZigzag64(pageBody.length)), // totalCompressed
    structField(9, CT_I64, encodeZigzag64(dataPageOffset)), // dataPageOffset
  ]);

  // Column chunk: just the metaData field (field 3)
  const colChunk = encodeStruct([
    structField(3, CT_STRUCT, colMeta),
  ]);

  // ---- Row group ----
  // columns = list<ColumnChunk> (1 column)
  const columnsList = Buffer.concat([
    encodeListHeader(CT_STRUCT, 1),
    colChunk,
  ]);
  const rowGroup = encodeStruct([
    structField(1, CT_LIST, columnsList),
    structField(2, CT_I64, encodeZigzag64(pageBody.length)), // totalByteSize
    structField(3, CT_I64, encodeZigzag64(numRows)),          // numRows
  ]);

  // ---- Schema elements ----
  // Root element: message schema (numChildren=1)
  const schemaRoot = encodeStruct([
    structField(4, CT_BINARY, encodeString("schema")),  // name
    structField(5, CT_I32,    encodeZigzag32(1)),        // numChildren
  ]);
  // Leaf: id INT32 REQUIRED
  const schemaLeaf = encodeStruct([
    structField(1, CT_I32,    encodeZigzag32(1)),       // type = INT32
    structField(3, CT_I32,    encodeZigzag32(0)),       // repetition = REQUIRED
    structField(4, CT_BINARY, encodeString("id")),      // name
  ]);

  // Schema list: [root, leaf]
  const schemaList = Buffer.concat([
    encodeListHeader(CT_STRUCT, 2),
    schemaRoot,
    schemaLeaf,
  ]);

  // Row groups list: [rowGroup]
  const rgList = Buffer.concat([
    encodeListHeader(CT_STRUCT, 1),
    rowGroup,
  ]);

  // ---- File metadata ----
  const fileMeta = encodeStruct([
    structField(1, CT_I32,  encodeZigzag32(2)),           // version = 2
    structField(2, CT_LIST, schemaList),                   // schema
    structField(3, CT_I64,  encodeZigzag64(numRows)),     // numRows
    structField(4, CT_LIST, rgList),                       // rowGroups
  ]);

  const footerLen = Buffer.allocUnsafe(4);
  footerLen.writeUInt32LE(fileMeta.length, 0);

  return Buffer.concat([
    MAGIC,
    pageHdr,
    pageBody,
    fileMeta,
    footerLen,
    MAGIC,
  ]);
}

function writeTestParquet(name, values) {
  const f = tmpFile(name);
  fs.writeFileSync(f, buildParquetFile(values));
  return f;
}

// Quick sanity check that our builder produces a parseable file:
try {
  const sanity = writeTestParquet("_sanity.parquet", [1, 2, 3]);
  const r = parquetClient({ operation: "info", path: sanity }, fakeResolve);
  if (r.numRows !== 3) throw new Error("Sanity check failed: numRows=" + r.numRows);
  process.stderr.write("[buildParquetFile sanity check passed]\n");
} catch (e) {
  process.stderr.write("[FATAL] buildParquetFile sanity failed: " + e.message + "\n" + (e.stack || "") + "\n");
  process.exit(1);
}

// ── A: Validation tests (x10) ────────────────────────────────────────────────

process.stderr.write("\n=== A: Validation ===\n");

test("A1 - missing operation throws", () => {
  assertThrows(() => parquetClient({ path: "/tmp/x.parquet" }, fakeResolve), "operation");
});

test("A2 - missing path throws", () => {
  assertThrows(() => parquetClient({ operation: "info" }, fakeResolve), "path");
});

test("A3 - NUL byte in path throws", () => {
  assertThrows(() => parquetClient({ operation: "info", path: "/tmp/a\x00b.parquet" }, fakeResolve), "NUL");
});

test("A4 - unknown operation throws", () => {
  const f = writeTestParquet("a4.parquet", [1]);
  assertThrows(() => parquetClient({ operation: "compress", path: f }, fakeResolve), "unknown operation");
});

test("A5 - directory path rejected", () => {
  assertThrows(() => parquetClient({ operation: "info", path: os.tmpdir() }, fakeResolve), "directory");
});

test("A6 - invalid magic header rejected", () => {
  const f = tmpFile("not_parquet.bin");
  fs.writeFileSync(f, Buffer.from("NOT A REAL PARQUET FILE 123456789012345"));
  assertThrows(() => parquetClient({ operation: "info", path: f }, fakeResolve), "magic");
});

test("A7 - file too small rejected", () => {
  const f = tmpFile("tiny.bin");
  fs.writeFileSync(f, Buffer.from("PAR1"));
  assertThrows(() => parquetClient({ operation: "info", path: f }, fakeResolve), "too small");
});

test("A8 - row_group_index out of range throws", () => {
  const f = writeTestParquet("a8.parquet", [1, 2, 3]);
  assertThrows(() => parquetClient({ operation: "row_group", path: f, row_group_index: 99 }, fakeResolve), "out of range");
});

test("A9 - NUL byte in output_file path throws", () => {
  const f = writeTestParquet("a9.parquet", [1]);
  assertThrows(() => parquetClient({ operation: "to_json", path: f, output_file: "/tmp/a\x00b.json" }, fakeResolve), "NUL");
});

test("A10 - non-existent file throws ENOENT", () => {
  assertThrows(() => parquetClient({ operation: "info", path: "/nonexistent/file.parquet" }, fakeResolve), "ENOENT");
});

// ── B: Unit tests (x20) ────────────────────────────────────────────────────────────

process.stderr.write("\n=== B: Unit ===\n");

test("B1 - ThriftCompact: readVarInt returns BigInt", () => {
  const buf = Buffer.from([0x80, 0x01]); // 128 encoded
  const tc  = new ThriftCompact(buf, 0);
  const v   = tc.readVarInt();
  assert(typeof v === "bigint", `expected bigint, got ${typeof v}`);
  assert(v === 128n, `expected 128n, got ${v}`);
});

test("B2 - ThriftCompact: readZigZagI32 positive", () => {
  // zigzag(5) = 10 = 0x0A
  const buf = Buffer.from([0x0A]);
  const tc  = new ThriftCompact(buf, 0);
  assertEq(tc.readZigZagI32(), 5);
});

test("B3 - ThriftCompact: readZigZagI32 negative", () => {
  // zigzag(-1) = 1
  const buf = Buffer.from([0x01]);
  const tc  = new ThriftCompact(buf, 0);
  assertEq(tc.readZigZagI32(), -1);
});

test("B4 - ThriftCompact: readDouble", () => {
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleLE(3.14, 0);
  const tc  = new ThriftCompact(buf, 0);
  const v   = tc.readDouble();
  assert(Math.abs(v - 3.14) < 1e-10, `double mismatch: ${v}`);
});

test("B5 - ThriftCompact: readString", () => {
  const str = Buffer.from("hello", "utf8");
  const buf = Buffer.concat([Buffer.from([str.length]), str]);
  const tc  = new ThriftCompact(buf, 0);
  assertEq(tc.readString(), "hello");
});

test("B6 - ThriftCompact: buffer underflow throws", () => {
  const tc = new ThriftCompact(Buffer.from([]), 0);
  assertThrows(() => tc.readByte(), "underflow");
});

test("B7 - flattenSchema: empty array returns []", () => {
  assertEq(flattenSchema([]), []);
});

test("B8 - flattenSchema: single leaf", () => {
  const schema = [
    { name: "root", numChildren: 1 },
    { name: "id", type: 1, repetition: 0 },
  ];
  const leaves = flattenSchema(schema);
  assertEq(leaves.length, 1);
  assertEq(leaves[0].name, "id");
  assertEq(leaves[0].type, 1);
});

test("B9 - buildSchemaTree: produces tree nodes", () => {
  const schema = [
    { name: "schema", numChildren: 2 },
    { name: "id",   type: 1, repetition: 0 },
    { name: "name", type: 6, repetition: 1 },
  ];
  const tree = buildSchemaTree(schema);
  assertEq(tree.length, 2);
  assertEq(tree[0].name, "id");
  assertEq(tree[1].name, "name");
  assertEq(tree[1].repetition, "OPTIONAL");
});

test("B10 - unpackBits: bitWidth=1", () => {
  // Byte 0xA5 = 10100101b; LSB-first bits: 1,0,1,0,0,1,0,1
  const buf = Buffer.from([0xA5]);
  const out = unpackBits(buf, 1, 8);
  assertEq(out, [1, 0, 1, 0, 0, 1, 0, 1]);
});

test("B11 - unpackBits: bitWidth=2", () => {
  // 0b11100100 => 2-bit groups LSB first: 00,01,10,11 = [0,1,2,3]
  const buf = Buffer.from([0b11100100]);
  const out = unpackBits(buf, 2, 4);
  assertEq(out, [0, 1, 2, 3]);
});

test("B12 - unpackBits: bitWidth=0 returns all zeros", () => {
  const out = unpackBits(Buffer.from([0xFF]), 0, 5);
  assertEq(out, [0, 0, 0, 0, 0]);
});

test("B13 - readRleBpHybrid: RLE run of same value", () => {
  // RLE header: (count<<1)|1; count=3, value=7 bitWidth=3 => 1 byte
  const count = 3;
  const hdr   = ((count << 1) | 1) & 0xFF; // 0x07
  const buf   = Buffer.from([hdr, 7]);      // 3 copies of 7
  const vals  = readRleBpHybrid(buf, 0, 3, 3);
  assertEq(vals, [7, 7, 7]);
});

test("B14 - decodeDeltaBinaryPacked: [0,1,2,3]", () => {
  function writeZZVI(v) {
    const z = v < 0 ? (-v * 2 - 1) : v * 2;
    const out = [];
    let rem = z;
    while (rem >= 128) { out.push((rem & 0x7F) | 0x80); rem >>= 7; }
    out.push(rem);
    return Buffer.from(out);
  }
  function writeVI(v) {
    const out = [];
    while (v >= 128) { out.push((v & 0x7F) | 0x80); v >>= 7; }
    out.push(v);
    return Buffer.from(out);
  }
  const buf = Buffer.concat([
    writeVI(4),   // blockSize
    writeVI(1),   // miniBlocksPerBlock
    writeVI(4),   // totalValueCount
    writeZZVI(0), // firstValue = 0
    writeZZVI(1), // minDelta = 1
    Buffer.from([0]), // bitWidth = 0 for 3 remaining values (all delta = 0)
  ]);
  const vals = decodeDeltaBinaryPacked(buf);
  assertEq(vals.slice(0, 4), [0, 1, 2, 3]);
});

test("B15 - convertValue: INT32 passthrough", () => {
  const leaf = { type: 1 };
  assertEq(convertValue(42, leaf), 42);
  assert(convertValue(null, leaf) === null);
});

test("B16 - convertValue: BYTE_ARRAY with STRING logical type", () => {
  const leaf = { type: 6, logical: "STRING" };
  assertEq(convertValue(Buffer.from("hello"), leaf), "hello");
});

test("B17 - convertValue: BYTE_ARRAY without string => base64", () => {
  const leaf = { type: 6 };
  const b64  = convertValue(Buffer.from([1, 2, 3]), leaf);
  assertEq(b64, Buffer.from([1, 2, 3]).toString("base64"));
});

test("B18 - convertValue: INT32 DATE", () => {
  const leaf = { type: 1, logical: "DATE" };
  assertEq(convertValue(0, leaf), "1970-01-01"); // epoch day 0
});

test("B19 - convertValue: UUID 16 bytes", () => {
  const leaf   = { type: 7, logical: "UUID" };
  const uuidBuf = Buffer.from("550e8400e29b41d4a716446655440000", "hex");
  assertEq(convertValue(uuidBuf, leaf), "550e8400-e29b-41d4-a716-446655440000");
});

test("B20 - snappyDecompress: literal block", () => {
  // Snappy literal: uncompressed length = 3, literal tag = (len-1)<<2 = 0x08
  const data   = Buffer.from([0xAA, 0xBB, 0xCC]);
  const stream = Buffer.concat([
    Buffer.from([data.length]),              // uncompressed length varint
    Buffer.from([(data.length - 1) << 2]),  // literal tag
    data,
  ]);
  const out = snappyDecompress(stream);
  assertEq([...out], [0xAA, 0xBB, 0xCC]);
});

// ── C: Happy-path tests (x20) ────────────────────────────────────────────────

process.stderr.write("\n=== C: Happy-path ===\n");

test("C1 - info: numRows=3", () => {
  const f = writeTestParquet("c1.parquet", [10, 20, 30]);
  const r = parquetClient({ operation: "info", path: f }, fakeResolve);
  assertEq(r.numRows, 3);
  assertEq(r.numRowGroups, 1);
  assertEq(r.numColumns, 1);
});

test("C2 - info: parquetVersion is number", () => {
  const f = writeTestParquet("c2.parquet", [1]);
  const r = parquetClient({ operation: "info", path: f }, fakeResolve);
  assert(typeof r.parquetVersion === "number", "parquetVersion should be number");
});

test("C3 - info: fileSizeBytes > 0", () => {
  const f = writeTestParquet("c3.parquet", [1]);
  const r = parquetClient({ operation: "info", path: f }, fakeResolve);
  assert(r.fileSizeBytes > 0);
});

test("C4 - info: rowGroups array shape", () => {
  const f = writeTestParquet("c4.parquet", [5, 6, 7]);
  const r = parquetClient({ operation: "info", path: f }, fakeResolve);
  assert(Array.isArray(r.rowGroups));
  assertEq(r.rowGroups[0].numRows, 3);
});

test("C5 - schema: numColumns=1", () => {
  const f = writeTestParquet("c5.parquet", [1]);
  const r = parquetClient({ operation: "schema", path: f }, fakeResolve);
  assertEq(r.numColumns, 1);
});

test("C6 - schema: column metadata name/type", () => {
  const f = writeTestParquet("c6.parquet", [1]);
  const r = parquetClient({ operation: "schema", path: f }, fakeResolve);
  assertEq(r.columns[0].name, "id");
  assertEq(r.columns[0].physicalType, "INT32");
  assertEq(r.columns[0].repetition, "REQUIRED");
});

test("C7 - schema: schemaTree is array", () => {
  const f = writeTestParquet("c7.parquet", [1]);
  const r = parquetClient({ operation: "schema", path: f }, fakeResolve);
  assert(Array.isArray(r.schemaTree));
});

test("C8 - read: returnedRows=5 for 5 values", () => {
  const f = writeTestParquet("c8.parquet", [1, 2, 3, 4, 5]);
  const r = parquetClient({ operation: "read", path: f }, fakeResolve);
  assertEq(r.totalRows, 5);
  assertEq(r.returnedRows, 5);
});

test("C9 - read: correct INT32 values", () => {
  const f = writeTestParquet("c9.parquet", [100, 200, 300]);
  const r = parquetClient({ operation: "read", path: f }, fakeResolve);
  assertEq(r.rows[0].id, 100);
  assertEq(r.rows[1].id, 200);
  assertEq(r.rows[2].id, 300);
});

test("C10 - read: limit=2 returns 2 rows", () => {
  const f = writeTestParquet("c10.parquet", [1, 2, 3, 4, 5]);
  const r = parquetClient({ operation: "read", path: f, limit: 2 }, fakeResolve);
  assertEq(r.returnedRows, 2);
});

test("C11 - read: offset=1 skips first row", () => {
  const f = writeTestParquet("c11.parquet", [10, 20, 30]);
  const r = parquetClient({ operation: "read", path: f, offset: 1 }, fakeResolve);
  assertEq(r.returnedRows, 2);
  assertEq(r.rows[0].id, 20);
});

test("C12 - read: offset=1 limit=2", () => {
  const f = writeTestParquet("c12.parquet", [10, 20, 30, 40]);
  const r = parquetClient({ operation: "read", path: f, offset: 1, limit: 2 }, fakeResolve);
  assertEq(r.returnedRows, 2);
  assertEq(r.rows[0].id, 20);
  assertEq(r.rows[1].id, 30);
});

test("C13 - row_group: index 0 works", () => {
  const f = writeTestParquet("c13.parquet", [7, 8, 9]);
  const r = parquetClient({ operation: "row_group", path: f, row_group_index: 0 }, fakeResolve);
  assertEq(r.rowGroupIndex, 0);
  assertEq(r.totalRows, 3);
});

test("C14 - row_group: row values", () => {
  const f = writeTestParquet("c14.parquet", [55, 66]);
  const r = parquetClient({ operation: "row_group", path: f, row_group_index: 0 }, fakeResolve);
  assertEq(r.rows[0].id, 55);
  assertEq(r.rows[1].id, 66);
});

test("C15 - to_json: inline JSON string", () => {
  const f = writeTestParquet("c15.parquet", [1, 2]);
  const r = parquetClient({ operation: "to_json", path: f }, fakeResolve);
  assert(typeof r.json === "string");
  const parsed = JSON.parse(r.json);
  assertEq(parsed[0].id, 1);
});

test("C16 - to_json: pretty=true adds newlines", () => {
  const f = writeTestParquet("c16.parquet", [42]);
  const r = parquetClient({ operation: "to_json", path: f, pretty: true }, fakeResolve);
  assert(r.json.includes("\n"));
});

test("C17 - to_json: output_file writes to disk", () => {
  const f   = writeTestParquet("c17.parquet", [11, 22]);
  const out = tmpFile("c17_out.json");
  const r   = parquetClient({ operation: "to_json", path: f, output_file: out }, fakeResolve);
  assertEq(r.writtenRows, 2);
  const content = JSON.parse(fs.readFileSync(out, "utf8"));
  assertEq(content[0].id, 11);
});

test("C18 - to_csv: returns CSV with header", () => {
  const f = writeTestParquet("c18.parquet", [1, 2, 3]);
  const r = parquetClient({ operation: "to_csv", path: f }, fakeResolve);
  assert(typeof r.csv === "string");
  const lines = r.csv.split("\n");
  assert(lines[0].includes("id"));
  assertEq(lines[1], "1");
});

test("C19 - to_csv: output_file writes to disk", () => {
  const f   = writeTestParquet("c19.parquet", [5, 6]);
  const out = tmpFile("c19_out.csv");
  parquetClient({ operation: "to_csv", path: f, output_file: out }, fakeResolve);
  assert(fs.existsSync(out));
  assert(fs.readFileSync(out, "utf8").includes("id"));
});

test("C20 - to_csv: returnedRows field", () => {
  const f = writeTestParquet("c20.parquet", [1, 2]);
  const r = parquetClient({ operation: "to_csv", path: f }, fakeResolve);
  assertEq(r.returnedRows, 2);
});

// ── D: Security tests (x10) ──────────────────────────────────────────────────

process.stderr.write("\n=== D: Security ===\n");

test("D1 - NUL byte in path rejected immediately", () => {
  assertThrows(() => parquetClient({ operation: "info", path: "test\x00file.parquet" }, fakeResolve), "NUL");
});

test("D2 - directory path rejected", () => {
  assertThrows(() => parquetClient({ operation: "schema", path: os.tmpdir() }, fakeResolve), "directory");
});

test("D3 - all-zero bytes file rejected (no PAR1 magic)", () => {
  const f = tmpFile("d3_zeros.bin");
  fs.writeFileSync(f, Buffer.alloc(128, 0));
  assertThrows(() => parquetClient({ operation: "info", path: f }, fakeResolve), "magic");
});

test("D4 - PAR1 header magic but invalid footer length", () => {
  const MAGIC = Buffer.from("PAR1");
  const f = tmpFile("d4_bad_footer.parquet");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32LE(99999, 0);
  fs.writeFileSync(f, Buffer.concat([MAGIC, Buffer.alloc(20, 0), len, MAGIC]));
  assertThrows(() => parquetClient({ operation: "info", path: f }, fakeResolve), "footer");
});

test("D5 - missing trailing PAR1 magic", () => {
  const MAGIC = Buffer.from("PAR1");
  const f = tmpFile("d5_no_trail.parquet");
  fs.writeFileSync(f, Buffer.concat([MAGIC, Buffer.alloc(16, 0xAA), Buffer.from("NOPE")]));
  assertThrows(() => parquetClient({ operation: "info", path: f }, fakeResolve), "PAR1");
});

test("D6 - row_group_index negative rejected (out of range)", () => {
  const f = writeTestParquet("d6.parquet", [1]);
  assertThrows(() => parquetClient({ operation: "row_group", path: f, row_group_index: -1 }, fakeResolve), "out of range");
});

test("D7 - NUL byte in output_file for to_csv rejected", () => {
  const f = writeTestParquet("d7.parquet", [1]);
  assertThrows(() => parquetClient({ operation: "to_csv", path: f, output_file: "/tmp/a\x00b.csv" }, fakeResolve), "NUL");
});

test("D8 - non-existent path throws ENOENT", () => {
  assertThrows(() => parquetClient({ operation: "read", path: "/no/such/file.parquet" }, fakeResolve), "ENOENT");
});

test("D9 - zero footer-length file handled without crash", () => {
  const MAGIC = Buffer.from("PAR1");
  const f     = tmpFile("d9_zero_footer.parquet");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32LE(0, 0);
  fs.writeFileSync(f, Buffer.concat([MAGIC, len, MAGIC]));
  try {
    parquetClient({ operation: "info", path: f }, fakeResolve);
  } catch (e) {
    assert(typeof e.message === "string" && e.message.length > 0);
  }
});

test("D10 - row_group on 0-row file: graceful handling", () => {
  const f = writeTestParquet("d10.parquet", []);
  try {
    const r = parquetClient({ operation: "row_group", path: f, row_group_index: 0 }, fakeResolve);
    assert(r !== null && r !== undefined);
  } catch (e) {
    assert(typeof e.message === "string");
  }
});

// ── E: Error-path tests (x10) ────────────────────────────────────────────────

process.stderr.write("\n=== E: Error paths ===\n");

test("E1 - unknown operation error message mentions valid ops", () => {
  const f = writeTestParquet("e1.parquet", [1]);
  try {
    parquetClient({ operation: "foobar", path: f }, fakeResolve);
    throw new Error("Should have thrown");
  } catch (e) {
    assert(e.message.includes("info") || e.message.includes("unknown"));
  }
});

test("E2 - missing operation field throws", () => {
  assertThrows(() => parquetClient({ path: "/tmp/x.parquet" }, fakeResolve), "operation");
});

test("E3 - missing path field throws", () => {
  assertThrows(() => parquetClient({ operation: "info" }, fakeResolve), "path");
});

test("E4 - read offset >= totalRows returns 0 rows", () => {
  const f = writeTestParquet("e4.parquet", [1, 2]);
  const r = parquetClient({ operation: "read", path: f, offset: 100 }, fakeResolve);
  assertEq(r.returnedRows, 0);
});

test("E5 - limit=1 returns exactly 1 row", () => {
  const f = writeTestParquet("e5.parquet", [1, 2, 3]);
  const r = parquetClient({ operation: "read", path: f, limit: 1 }, fakeResolve);
  assertEq(r.returnedRows, 1);
});

test("E6 - to_json creates output dir automatically", () => {
  const f   = writeTestParquet("e6.parquet", [1]);
  const sub = tmpFile("subdir_e6");
  const out = path.join(sub, "out.json");
  parquetClient({ operation: "to_json", path: f, output_file: out }, fakeResolve);
  assert(fs.existsSync(out));
  fs.unlinkSync(out);
  fs.rmdirSync(sub);
});

test("E7 - to_csv returnedRows field present", () => {
  const f = writeTestParquet("e7.parquet", [1, 2]);
  const r = parquetClient({ operation: "to_csv", path: f }, fakeResolve);
  assertEq(r.returnedRows, 2);
});

test("E8 - info: keyValueMetadata is object", () => {
  const f = writeTestParquet("e8.parquet", [1]);
  const r = parquetClient({ operation: "info", path: f }, fakeResolve);
  assert(typeof r.keyValueMetadata === "object" && r.keyValueMetadata !== null);
});

test("E9 - row_group offset+limit within group", () => {
  const f = writeTestParquet("e9.parquet", [10, 20, 30]);
  const r = parquetClient({ operation: "row_group", path: f, row_group_index: 0, offset: 1, limit: 1 }, fakeResolve);
  assertEq(r.returnedRows, 1);
  assertEq(r.rows[0].id, 20);
});

test("E10 - read: columns field lists column names", () => {
  const f = writeTestParquet("e10.parquet", [5]);
  const r = parquetClient({ operation: "read", path: f }, fakeResolve);
  assert(Array.isArray(r.columns) && r.columns.includes("id"));
});

// ── F: Concurrency tests (x6) ────────────────────────────────────────────────

process.stderr.write("\n=== F: Concurrency ===\n");

test("F1 - parallel info calls (8 concurrent)", async () => {
  const f = writeTestParquet("f1.parquet", [1, 2, 3]);
  await Promise.all(Array.from({ length: 8 }, () =>
    Promise.resolve().then(() => {
      const r = parquetClient({ operation: "info", path: f }, fakeResolve);
      assertEq(r.numRows, 3);
    })
  ));
});

test("F2 - parallel read calls with varying offsets", async () => {
  const f = writeTestParquet("f2.parquet", [10, 20, 30]);
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    Promise.resolve().then(() => {
      const r = parquetClient({ operation: "read", path: f, limit: 1, offset: i % 3 }, fakeResolve);
      assert(r.returnedRows >= 0);
    })
  ));
});

test("F3 - parallel to_json inline", async () => {
  const f = writeTestParquet("f3.parquet", [1, 2]);
  await Promise.all(Array.from({ length: 5 }, () =>
    Promise.resolve().then(() => {
      const r      = parquetClient({ operation: "to_json", path: f }, fakeResolve);
      const parsed = JSON.parse(r.json);
      assertEq(parsed.length, 2);
    })
  ));
});

test("F4 - parallel to_csv inline", async () => {
  const f = writeTestParquet("f4.parquet", [5, 6, 7]);
  await Promise.all(Array.from({ length: 5 }, () =>
    Promise.resolve().then(() => {
      const r = parquetClient({ operation: "to_csv", path: f }, fakeResolve);
      assert(r.csv.includes("id"));
    })
  ));
});

test("F5 - parallel to_json to different output files", async () => {
  const f = writeTestParquet("f5.parquet", [99, 100]);
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    Promise.resolve().then(() => {
      const out = tmpFile(`f5_out${i}.json`);
      const r   = parquetClient({ operation: "to_json", path: f, output_file: out }, fakeResolve);
      assertEq(r.writtenRows, 2);
      assert(fs.existsSync(out));
    })
  ));
});

test("F6 - parallel mixed operations on same file", async () => {
  const f   = writeTestParquet("f6.parquet", [1, 2, 3, 4, 5]);
  const ops = ["info", "schema", "read", "to_json", "to_csv", "row_group"];
  await Promise.all(ops.map(op =>
    Promise.resolve().then(() => {
      const r = parquetClient({ operation: op, path: f, row_group_index: 0 }, fakeResolve);
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
