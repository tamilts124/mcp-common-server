"use strict";
// lib/parquetClientOps.js — Zero-dep Apache Parquet file reader (pure Node.js; no npm deps)
// Supports: read, info, schema, row_group, to_json, to_csv
// Encoding: PLAIN, RLE, BIT_PACKED, DELTA_BINARY_PACKED, PLAIN_DICTIONARY, RLE_DICTIONARY
// Compression: UNCOMPRESSED, SNAPPY (pure-JS), GZIP (node:zlib)
// Column types: BOOLEAN, INT32, INT64, INT96, FLOAT, DOUBLE, BYTE_ARRAY, FIXED_LEN_BYTE_ARRAY
// Logical types: STRING, DATE, TIMESTAMP, DECIMAL, UUID, ENUM, JSON, BSON, LIST, MAP
// Security: 200 MB file cap; 10,000,000 row limit; NUL-byte path guard; dir path rejected

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const MAX_ROWS      = 10_000_000;

// ─── Parquet magic bytes ────────────────────────────────────────────────────
const MAGIC = Buffer.from("PAR1");

// ─── Thrift compact protocol constants ─────────────────────────────────────
const T_BOOLEAN_TRUE  = 1;
const T_BOOLEAN_FALSE = 2;
const T_BYTE          = 3;
const T_I16           = 4;
const T_I32           = 5;
const T_I64           = 6;
const T_DOUBLE        = 7;
const T_BINARY        = 8;
const T_LIST          = 9;
const T_SET           = 10;
const T_MAP           = 11;
const T_STRUCT        = 12;

// ─── Thrift Compact decoder ─────────────────────────────────────────────────
class ThriftCompact {
  constructor(buf, offset) {
    this.buf = buf;
    this.pos = offset || 0;
  }

  readByte() {
    if (this.pos >= this.buf.length) throw new Error("ThriftCompact: buffer underflow");
    return this.buf[this.pos++];
  }

  readVarInt() {
    let result = 0n, shift = 0n;
    for (;;) {
      const b = this.readByte();
      result |= BigInt(b & 0x7F) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
      if (shift > 63n) throw new Error("ThriftCompact: varint overflow");
    }
    return result;
  }

  readZigZagI32() {
    const n = Number(this.readVarInt() & 0xFFFFFFFFn);
    return (n >>> 1) ^ -(n & 1);
  }

  readZigZagI64() {
    const n = this.readVarInt();
    return n % 2n === 0n ? n >> 1n : -((n + 1n) >> 1n);
  }

  readDouble() {
    if (this.pos + 8 > this.buf.length) throw new Error("ThriftCompact: buffer underflow at double");
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  readBinary() {
    const len = Number(this.readVarInt());
    if (len < 0 || this.pos + len > this.buf.length) throw new Error("ThriftCompact: binary length invalid");
    const data = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return data;
  }

  readString() {
    return this.readBinary().toString("utf8");
  }

  readStruct(fieldHandlers, ctx) {
    ctx = ctx || this;
    let prevFieldId = 0;
    for (;;) {
      const header = this.readByte();
      if (header === 0) break;
      const delta  = (header >> 4) & 0x0F;
      const typeId = header & 0x0F;
      const fieldId = delta === 0 ? prevFieldId + this.readZigZagI32() : prevFieldId + delta;
      prevFieldId = fieldId;
      const handler = fieldHandlers[fieldId];
      if (handler) {
        handler.call(this, this, typeId);
      } else {
        this.skipType(typeId);
      }
    }
    return ctx;
  }

  skipType(typeId) {
    switch (typeId) {
      case T_BOOLEAN_TRUE:
      case T_BOOLEAN_FALSE: break;
      case T_BYTE:  this.readByte(); break;
      case T_I16:
      case T_I32:
      case T_I64:   this.readVarInt(); break;
      case T_DOUBLE: this.pos += 8; break;
      case T_BINARY: this.readBinary(); break;
      case T_LIST:
      case T_SET: {
        const h = this.readByte();
        let size = (h >> 4) & 0x0F;
        const et = h & 0x0F;
        if (size === 0x0F) size = Number(this.readVarInt());
        for (let i = 0; i < size; i++) this.skipType(et);
        break;
      }
      case T_MAP: {
        const size = Number(this.readVarInt());
        if (size > 0) {
          const kv = this.readByte();
          for (let i = 0; i < size; i++) {
            this.skipType((kv >> 4) & 0x0F);
            this.skipType(kv & 0x0F);
          }
        }
        break;
      }
      case T_STRUCT:
        for (;;) {
          const b = this.readByte();
          if (b === 0) break;
          const delta = (b >> 4) & 0x0F;
          const t     = b & 0x0F;
          if (delta === 0) this.readVarInt(); // read field id
          this.skipType(t);
        }
        break;
      default:
        throw new Error(`ThriftCompact: unknown typeId ${typeId} to skip`);
    }
  }

  readList(elemReader) {
    const h = this.readByte();
    let size = (h >> 4) & 0x0F;
    if (size === 0x0F) size = Number(this.readVarInt());
    const out = [];
    for (let i = 0; i < size; i++) out.push(elemReader.call(this));
    return out;
  }
}

// ─── Parquet physical type names ────────────────────────────────────────────
const PHYSICAL_TYPE = [
  "BOOLEAN","INT32","INT64","INT96","FLOAT","DOUBLE","BYTE_ARRAY","FIXED_LEN_BYTE_ARRAY"
];

const CONVERTED_TYPE = [
  "UTF8","MAP","MAP_KEY_VALUE","LIST","ENUM","DECIMAL","DATE","TIME_MILLIS","TIME_MICROS",
  "TIMESTAMP_MILLIS","TIMESTAMP_MICROS","UINT_8","UINT_16","UINT_32","UINT_64",
  "INT_8","INT_16","INT_32","INT_64","JSON","BSON","INTERVAL",
];

const COMPRESSION = [
  "UNCOMPRESSED","SNAPPY","GZIP","LZO","BROTLI","LZ4","ZSTD","LZ4_RAW"
];

// ─── Thrift schema element parser ───────────────────────────────────────────
function parseSchemaElement(tc) {
  const el = {};
  tc.readStruct({
    1(t) { el.type = this.readZigZagI32(); },
    2()  { el.typeLength    = this.readZigZagI32(); },
    3()  { el.repetition    = this.readZigZagI32(); },
    4()  { el.name          = this.readString(); },
    5()  { el.numChildren   = this.readZigZagI32(); },
    6()  { el.convertedType = this.readZigZagI32(); },
    7()  { el.scale         = this.readZigZagI32(); },
    8()  { el.precision     = this.readZigZagI32(); },
    9()  { el.fieldId       = this.readZigZagI32(); },
    10(t){ if (t === T_STRUCT) {
      const lt = {};
      this.readStruct({
        1()  { lt.type = "STRING";    this.skipType(T_STRUCT); },
        2()  { lt.type = "MAP";       this.skipType(T_STRUCT); },
        3()  { lt.type = "LIST";      this.skipType(T_STRUCT); },
        4()  { lt.type = "ENUM";      this.skipType(T_STRUCT); },
        5()  { lt.type = "DECIMAL";   this.skipType(T_STRUCT); },
        6()  { lt.type = "DATE";      this.skipType(T_STRUCT); },
        7()  { lt.type = "TIME";      this.skipType(T_STRUCT); },
        8()  { lt.type = "TIMESTAMP"; this.skipType(T_STRUCT); },
        10() { lt.type = "INTEGER";   this.skipType(T_STRUCT); },
        11() { lt.type = "UNKNOWN";   this.skipType(T_STRUCT); },
        12() { lt.type = "JSON";      this.skipType(T_STRUCT); },
        13() { lt.type = "BSON";      this.skipType(T_STRUCT); },
        14() { lt.type = "UUID";      this.skipType(T_STRUCT); },
        15() { lt.type = "FLOAT16";   this.skipType(T_STRUCT); },
      });
      el.logicalType = lt;
    } else {
      this.skipType(t);
    }},
  });
  return el;
}

function parseKeyValue(tc) {
  const kv = {};
  tc.readStruct({
    1() { kv.key   = this.readString(); },
    2() { kv.value = this.readString(); },
  });
  return kv;
}

function parseColumnMetaData(tc) {
  const meta = {};
  tc.readStruct({
    1()  { meta.type               = this.readZigZagI32(); },
    2()  { meta.encodings          = this.readList(() => this.readZigZagI32()); },
    3()  { meta.pathInSchema       = this.readList(() => this.readString()); },
    4()  { meta.codec              = this.readZigZagI32(); },
    5()  { meta.numValues          = this.readZigZagI64(); },
    6()  { meta.totalUncompressed  = this.readZigZagI64(); },
    7()  { meta.totalCompressed    = this.readZigZagI64(); },
    9()  { meta.dataPageOffset     = this.readZigZagI64(); },
    10() { meta.indexPageOffset    = this.readZigZagI64(); },
    11() { meta.dictionaryPageOffset = this.readZigZagI64(); },
  });
  return meta;
}

function parseColumnChunk(tc) {
  const cc = {};
  tc.readStruct({
    1() { cc.filePath   = this.readString(); },
    2() { cc.fileOffset = this.readZigZagI64(); },
    3() { cc.metaData   = parseColumnMetaData(this); },
    4() { cc.offsetIndexOffset = this.readZigZagI64(); },
    5() { cc.offsetIndexLength = this.readZigZagI32(); },
    6() { cc.columnIndexOffset = this.readZigZagI64(); },
    7() { cc.columnIndexLength = this.readZigZagI32(); },
  });
  return cc;
}

function parseRowGroup(tc) {
  const rg = {};
  tc.readStruct({
    1() { rg.columns        = this.readList(() => parseColumnChunk(this)); },
    2() { rg.totalByteSize  = this.readZigZagI64(); },
    3() { rg.numRows        = this.readZigZagI64(); },
    4() { rg.sortingColumns = this.readList(() => { const s = {}; this.readStruct({}); return s; }); },
    5() { rg.fileOffset     = this.readZigZagI64(); },
    6() { rg.totalCompressed = this.readZigZagI64(); },
    7() { rg.ordinal        = this.readZigZagI32(); },
  });
  return rg;
}

function parseFileMetaData(buf) {
  const tc   = new ThriftCompact(buf, 0);
  const meta = { schema: [], rowGroups: [], keyValueMetadata: [] };
  tc.readStruct({
    1() { meta.version           = this.readZigZagI32(); },
    2() { meta.schema            = this.readList(() => parseSchemaElement(this)); },
    3() { meta.numRows           = this.readZigZagI64(); },
    4() { meta.rowGroups         = this.readList(() => parseRowGroup(this)); },
    5() { meta.keyValueMetadata  = this.readList(() => parseKeyValue(this)); },
    6() { meta.createdBy         = this.readString(); },
  });
  return meta;
}

// ─── Load and parse Parquet file ────────────────────────────────────────────
function loadParquet(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new ToolError(`parquet_client: '${filePath}' is a directory.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(`parquet_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`, -32602);

  const buf = fs.readFileSync(filePath);
  if (buf.length < 8) throw new ToolError("parquet_client: file too small.", -32602);
  if (!buf.slice(0, 4).equals(MAGIC)) throw new ToolError("parquet_client: invalid magic (expected PAR1).", -32602);
  if (!buf.slice(buf.length - 4).equals(MAGIC)) throw new ToolError("parquet_client: missing PAR1 footer magic.", -32602);

  const footerLen = buf.readUInt32LE(buf.length - 8);
  if (footerLen === 0 || footerLen > buf.length - 8)
    throw new ToolError(`parquet_client: invalid footer length ${footerLen}.`, -32602);

  const footerStart = buf.length - 8 - footerLen;
  const meta        = parseFileMetaData(buf.slice(footerStart, footerStart + footerLen));
  return { buf, meta, filePath };
}

// ─── Schema utilities ────────────────────────────────────────────────────────
function buildSchemaTree(schemaElements) {
  function buildChildren(elements, idx, count) {
    const children = [];
    let i = idx;
    while (children.length < count && i < elements.length) {
      const el   = elements[i];
      const node = {
        name:       el.name,
        repetition: ["REQUIRED","OPTIONAL","REPEATED"][el.repetition] || String(el.repetition),
      };
      if (el.type !== undefined) {
        node.physicalType = PHYSICAL_TYPE[el.type] || `TYPE_${el.type}`;
        if (el.typeLength !== undefined) node.typeLength = el.typeLength;
      }
      if (el.convertedType !== undefined) node.convertedType = CONVERTED_TYPE[el.convertedType] || `CONV_${el.convertedType}`;
      if (el.logicalType) node.logicalType = el.logicalType.type;
      if (el.numChildren) {
        const [kids, consumed] = buildChildren(elements, i + 1, el.numChildren);
        node.children = kids;
        i += consumed + 1;
      } else {
        i++;
      }
      children.push(node);
    }
    return [children, i - idx];
  }
  if (!schemaElements || schemaElements.length === 0) return [];
  const root = schemaElements[0];
  if (!root.numChildren) return [];
  return buildChildren(schemaElements, 1, root.numChildren)[0];
}

function flattenSchema(schemaElements) {
  const leaves = [];
  function traverse(elements, idx, pathPrefix, count) {
    let i = idx, processed = 0;
    while (processed < count && i < elements.length) {
      const el      = elements[i];
      const curPath = pathPrefix ? `${pathPrefix}.${el.name}` : el.name;
      if (el.numChildren) {
        const consumed = traverse(elements, i + 1, curPath, el.numChildren);
        i += consumed + 1;
      } else {
        leaves.push({
          path:       curPath,
          name:       el.name,
          type:       el.type,
          typeLen:    el.typeLength,
          converted:  el.convertedType,
          logical:    el.logicalType?.type,
          repetition: el.repetition,
        });
        i++;
      }
      processed++;
    }
    return i - idx;
  }
  if (!schemaElements || schemaElements.length === 0) return leaves;
  const root = schemaElements[0];
  if (!root.numChildren) return leaves;
  traverse(schemaElements, 1, "", root.numChildren);
  return leaves;
}

function computeMaxLevels(schemaElements) {
  const result = {};
  function traverse(elements, idx, count, defLevel, repLevel) {
    let i = idx, processed = 0;
    while (processed < count && i < elements.length) {
      const el = elements[i];
      let d = defLevel, r = repLevel;
      if (el.repetition === 1) d++;       // OPTIONAL
      if (el.repetition === 2) { d++; r++; } // REPEATED
      if (el.numChildren) {
        const consumed = traverse(elements, i + 1, el.numChildren, d, r);
        i += consumed + 1;
      } else {
        result[el.name] = { maxDef: d, maxRep: r };
        i++;
      }
      processed++;
    }
    return i - idx;
  }
  if (!schemaElements || schemaElements.length === 0) return result;
  const root = schemaElements[0];
  if (!root.numChildren) return result;
  traverse(schemaElements, 1, root.numChildren, 0, 0);
  return result;
}

// ─── Pure-JS Snappy decompressor ───────────────────────────────────────────
function snappyDecompress(src) {
  let pos = 0;
  let uncompLen = 0, shift = 0;
  while (pos < src.length) {
    const b = src[pos++];
    uncompLen |= (b & 0x7F) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }

  const dst = Buffer.allocUnsafe(uncompLen);
  let out = 0;

  while (pos < src.length) {
    const tag  = src[pos++];
    const type = tag & 0x03;

    if (type === 0) {
      const lenBits = (tag >> 2) & 0x3F;
      let len;
      if (lenBits < 60) {
        len = lenBits + 1;
      } else {
        const extra = lenBits - 59;
        len = 0;
        for (let i = 0; i < extra; i++) len |= src[pos++] << (i * 8);
        len++;
      }
      src.copy(dst, out, pos, pos + len);
      out += len; pos += len;
    } else if (type === 1) {
      const len    = ((tag >> 2) & 0x07) + 4;
      const offset = ((tag >> 5) << 8) | src[pos++];
      const start  = out - offset;
      for (let i = 0; i < len; i++) dst[out + i] = dst[start + (i % offset)];
      out += len;
    } else if (type === 2) {
      const len    = ((tag >> 2) & 0x3F) + 1;
      const offset = src.readUInt16LE(pos); pos += 2;
      const start  = out - offset;
      for (let i = 0; i < len; i++) dst[out + i] = dst[start + (i % offset)];
      out += len;
    } else {
      const len    = ((tag >> 2) & 0x3F) + 1;
      const offset = src.readUInt32LE(pos); pos += 4;
      const start  = out - offset;
      for (let i = 0; i < len; i++) dst[out + i] = dst[start + (i % offset)];
      out += len;
    }
  }
  return dst.slice(0, out);
}

function decompressData(codec, data) {
  switch (codec) {
    case 0: return data;                            // UNCOMPRESSED
    case 1: return snappyDecompress(data);          // SNAPPY
    case 2: return zlib.gunzipSync(data);           // GZIP
    case 5: return zlib.inflateRawSync(data);       // LZ4 (loose compatibility)
    default:
      throw new ToolError(
        `parquet_client: unsupported compression '${COMPRESSION[codec] || codec}'. Supported: UNCOMPRESSED, SNAPPY, GZIP.`,
        -32602,
      );
  }
}

// ─── Bit packing / RLE utilities ────────────────────────────────────────────
function readUvarint32(buf, pos) {
  let val = 0, shift = 0, p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    val |= (b & 0x7F) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: val, bytesRead: p - pos };
}

function unpackBits(buf, bitWidth, count) {
  if (bitWidth === 0) return new Array(count).fill(0);
  const out = new Array(count);
  let bitPos = 0;
  const mask = (1 << bitWidth) - 1;
  for (let i = 0; i < count; i++) {
    const byteIdx = bitPos >> 3;
    const bitOff  = bitPos & 7;
    let val = 0;
    for (let b = 0; b < bitWidth; b++) {
      const bi = (bitPos + b) >> 3;
      if (bi < buf.length) val |= ((buf[bi] >> ((bitPos + b) & 7)) & 1) << b;
    }
    out[i] = val & mask;
    bitPos += bitWidth;
  }
  return out;
}

function readRleBpHybrid(buf, pos, bitWidth, maxValues) {
  if (bitWidth === 0) return new Array(maxValues).fill(0);
  const values = [];
  let p = pos;
  while (p < buf.length && values.length < maxValues) {
    const hdr = readUvarint32(buf, p);
    p += hdr.bytesRead;
    const indicator = hdr.value;
    const isRle      = (indicator & 1) === 1;
    const count      = indicator >> 1;

    if (isRle) {
      const bytesNeeded = Math.ceil(bitWidth / 8);
      let val = 0;
      for (let i = 0; i < bytesNeeded && p + i < buf.length; i++) val |= buf[p + i] << (i * 8);
      p += bytesNeeded;
      for (let i = 0; i < count && values.length < maxValues; i++) values.push(val);
    } else {
      const numVals     = count * 8;
      const bytesNeeded = Math.ceil(numVals * bitWidth / 8);
      const chunk       = buf.slice(p, p + bytesNeeded);
      p += bytesNeeded;
      const unpacked = unpackBits(chunk, bitWidth, numVals);
      for (const v of unpacked) {
        if (values.length >= maxValues) break;
        values.push(v);
      }
    }
  }
  return values;
}

function readLevelsRleBp(buf, pos, maxLevel, maxValues) {
  if (maxLevel === 0) return { levels: new Array(maxValues).fill(0), bytesRead: 0 };
  const bitWidth = Math.ceil(Math.log2(maxLevel + 1)) || 1;
  const len = buf.readUInt32LE(pos); pos += 4;
  const levels = readRleBpHybrid(buf.slice(pos, pos + len), 0, bitWidth, maxValues);
  return { levels, bytesRead: 4 + len };
}

// ─── Delta binary packed decoder ───────────────────────────────────────────
function decodeDeltaBinaryPacked(buf) {
  const tc           = new ThriftCompact(buf, 0);
  const blockSize    = Number(tc.readVarInt());
  const miniPerBlock = Number(tc.readVarInt());
  const totalCount   = Number(tc.readVarInt());
  const firstValue   = Number(tc.readZigZagI64());

  const values = [firstValue];
  let prev     = firstValue;
  const valsPerMini = blockSize / miniPerBlock;

  while (values.length < totalCount && tc.pos < buf.length) {
    const minDelta = Number(tc.readZigZagI64());
    const bitWidths = [];
    for (let m = 0; m < miniPerBlock && tc.pos < buf.length; m++) bitWidths.push(buf[tc.pos++]);

    for (let m = 0; m < miniPerBlock; m++) {
      const bw = bitWidths[m] || 0;
      if (bw === 0) {
        for (let j = 0; j < valsPerMini && values.length < totalCount; j++) {
          prev += minDelta;
          values.push(prev);
        }
      } else {
        const bytesNeeded = Math.ceil(valsPerMini * bw / 8);
        const chunk = buf.slice(tc.pos, tc.pos + bytesNeeded);
        tc.pos += bytesNeeded;
        const unpacked = unpackBits(chunk, bw, valsPerMini);
        for (const delta of unpacked) {
          if (values.length >= totalCount) break;
          prev += minDelta + delta;
          values.push(prev);
        }
      }
    }
  }
  return values.slice(0, totalCount);
}

// ─── Page header parser ─────────────────────────────────────────────────────
function parsePageHeader(buf, pos) {
  const tc  = new ThriftCompact(buf, pos);
  const hdr = {};
  tc.readStruct({
    1() { hdr.type             = this.readZigZagI32(); },
    2() { hdr.uncompressedSize = this.readZigZagI32(); },
    3() { hdr.compressedSize   = this.readZigZagI32(); },
    4() { hdr.crc              = this.readZigZagI32(); },
    5() { // DataPageHeader
      hdr.dataPage = {};
      this.readStruct({
        1() { hdr.dataPage.numValues        = this.readZigZagI32(); },
        2() { hdr.dataPage.encoding         = this.readZigZagI32(); },
        3() { hdr.dataPage.defLevelEncoding = this.readZigZagI32(); },
        4() { hdr.dataPage.repLevelEncoding = this.readZigZagI32(); },
        5() { hdr.dataPage.statistics = {}; this.skipType(T_STRUCT); },
      });
    },
    7() { // DictionaryPageHeader
      hdr.dictPage = {};
      this.readStruct({
        1() { hdr.dictPage.numValues = this.readZigZagI32(); },
        2() { hdr.dictPage.encoding  = this.readZigZagI32(); },
        3() { hdr.dictPage.isSorted  = this.readByte() !== 0; },
      });
    },
    8() { // DataPageHeaderV2
      hdr.dataPageV2 = {};
      this.readStruct({
        1() { hdr.dataPageV2.numValues         = this.readZigZagI32(); },
        2() { hdr.dataPageV2.numNulls          = this.readZigZagI32(); },
        3() { hdr.dataPageV2.numRows           = this.readZigZagI32(); },
        4() { hdr.dataPageV2.encoding          = this.readZigZagI32(); },
        5() { hdr.dataPageV2.defLevelsByteLen  = this.readZigZagI32(); },
        6() { hdr.dataPageV2.repLevelsByteLen  = this.readZigZagI32(); },
        7() { hdr.dataPageV2.isCompressed      = this.readByte() !== 0; },
      });
    },
  });
  return { header: hdr, bytesRead: tc.pos - pos };
}

// ─── Plain value reader ─────────────────────────────────────────────────────
function readPlainValues(buf, pos, physType, count, typeLen) {
  const values = [];
  let p = pos;

  if (physType === 0) { // BOOLEAN: bit-packed
    for (let i = 0; i < count; i++) {
      const byteIdx = pos + Math.floor(i / 8);
      const bit     = i % 8;
      values.push(byteIdx < buf.length ? !!((buf[byteIdx] >> bit) & 1) : false);
    }
    return { values, bytesRead: Math.ceil(count / 8) };
  }

  for (let i = 0; i < count; i++) {
    if (p >= buf.length) { values.push(null); continue; }
    switch (physType) {
      case 1: // INT32
        values.push(p + 4 <= buf.length ? buf.readInt32LE(p) : null); p += 4; break;
      case 2: // INT64
        if (p + 8 <= buf.length) {
          const lo = buf.readUInt32LE(p), hi = buf.readInt32LE(p + 4);
          values.push(hi * 0x100000000 + lo);
        } else { values.push(null); }
        p += 8; break;
      case 3: // INT96 (Julian days + nanoseconds)
        if (p + 12 <= buf.length) {
          const nanos = Number(buf.readBigInt64LE(p));
          const julianDay = buf.readInt32LE(p + 8);
          values.push((julianDay - 2440588) * 86400000 + Math.floor(nanos / 1e6));
        } else { values.push(null); }
        p += 12; break;
      case 4: // FLOAT
        values.push(p + 4 <= buf.length ? buf.readFloatLE(p) : null); p += 4; break;
      case 5: // DOUBLE
        values.push(p + 8 <= buf.length ? buf.readDoubleLE(p) : null); p += 8; break;
      case 6: { // BYTE_ARRAY
        if (p + 4 > buf.length) { values.push(null); break; }
        const len = buf.readUInt32LE(p); p += 4;
        values.push(p + len <= buf.length ? buf.slice(p, p + len) : null);
        p += len; break;
      }
      case 7: { // FIXED_LEN_BYTE_ARRAY
        const fl = typeLen || 1;
        values.push(p + fl <= buf.length ? buf.slice(p, p + fl) : null);
        p += fl; break;
      }
      default: values.push(null);
    }
  }
  return { values, bytesRead: p - pos };
}

// ─── Convert raw value → JS ─────────────────────────────────────────────────
function convertValue(raw, leaf) {
  if (raw === null || raw === undefined) return null;

  if (Buffer.isBuffer(raw)) {
    const logical   = leaf.logical;
    const converted = leaf.converted;
    if (logical === "STRING" || converted === 0 || converted === 4) return raw.toString("utf8");  // UTF8 / ENUM
    if (logical === "UUID" && raw.length === 16) {
      const h = raw.toString("hex");
      return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    }
    if (logical === "JSON") { try { return JSON.parse(raw.toString("utf8")); } catch { return raw.toString("utf8"); } }
    return raw.toString("base64");
  }

  if (leaf.type === 1 /* INT32 */) {
    if (leaf.logical === "DATE" || leaf.converted === 6) return new Date(raw * 86400000).toISOString().slice(0, 10);
    return raw;
  }

  if (leaf.type === 2 /* INT64 */) {
    if (leaf.logical === "TIMESTAMP" || leaf.converted === 9) return new Date(raw).toISOString();
    if (leaf.converted === 10) return new Date(Math.round(raw / 1000)).toISOString();
    return raw;
  }

  if (leaf.type === 3 /* INT96 */) return new Date(raw).toISOString();

  return raw;
}

// ─── Read one column chunk ───────────────────────────────────────────────────
function readColumnChunk(fileBuf, colChunk, schemaLeaf, maxDefLevel, maxRepLevel) {
  const meta     = colChunk.metaData;
  if (!meta) return [];
  const numValues = Number(meta.numValues || 0n);
  if (numValues === 0) return [];

  const codec    = meta.codec || 0;
  const physType = meta.type;

  // Start reading at dict page offset (if exists) else data page offset
  let readPos = meta.dictionaryPageOffset != null
    ? Number(meta.dictionaryPageOffset)
    : Number(meta.dataPageOffset || 0n);

  let dictionary = null;
  const allValues = [];

  while (allValues.length < numValues && readPos < fileBuf.length) {
    let parsedHdr;
    try { parsedHdr = parsePageHeader(fileBuf, readPos); }
    catch { break; }
    const { header, bytesRead: hdrBytes } = parsedHdr;
    readPos += hdrBytes;

    const compSize = header.compressedSize || 0;
    const compData = fileBuf.slice(readPos, readPos + compSize);
    readPos       += compSize;

    const pageType = header.type; // 0=DATA_PAGE, 2=DICT_PAGE, 3=DATA_PAGE_V2

    let pageData;
    try {
      if (pageType === 3) {
        pageData = compData; // v2 body handled per-section
      } else {
        pageData = decompressData(codec, compData);
      }
    } catch { break; }

    // ── Dictionary page ───────────────────────────────────────────────────
    if (pageType === 2) {
      const dph     = header.dictPage || {};
      const numDict = dph.numValues || 0;
      const { values } = readPlainValues(pageData, 0, physType, numDict, schemaLeaf.typeLen);
      dictionary = values;
      continue;
    }

    // ── Data page (v1 or v2) ──────────────────────────────────────────────
    if (pageType === 0 || pageType === 3) {
      const dph     = header.dataPage || header.dataPageV2 || {};
      const numVals = dph.numValues || 0;
      const encoding = dph.encoding || 0;
      let pagePos   = 0;

      let defLevels = [], repLevels = [];

      if (pageType === 3) {
        // V2: levels are uncompressed before compressed data
        const repLen = header.dataPageV2?.repLevelsByteLen || 0;
        const defLen = header.dataPageV2?.defLevelsByteLen || 0;
        if (repLen > 0 && maxRepLevel > 0) {
          const bw = Math.ceil(Math.log2(maxRepLevel + 1)) || 1;
          repLevels = readRleBpHybrid(pageData.slice(pagePos, pagePos + repLen), 0, bw, numVals);
        }
        pagePos += repLen;
        if (defLen > 0 && maxDefLevel > 0) {
          const bw = Math.ceil(Math.log2(maxDefLevel + 1)) || 1;
          defLevels = readRleBpHybrid(pageData.slice(pagePos, pagePos + defLen), 0, bw, numVals);
        }
        pagePos += defLen;
        // Decompress values portion if needed
        if ((header.dataPageV2?.isCompressed !== false) && codec !== 0) {
          try {
            const decompValues = decompressData(codec, pageData.slice(pagePos));
            pageData = Buffer.concat([pageData.slice(0, pagePos), decompValues]);
          } catch { /* use as-is */ }
        }
      } else {
        // V1: RLE/bit-packed levels, length prefixed
        if (maxRepLevel > 0) {
          const res = readLevelsRleBp(pageData, pagePos, maxRepLevel, numVals);
          repLevels = res.levels; pagePos += res.bytesRead;
        }
        if (maxDefLevel > 0) {
          const res = readLevelsRleBp(pageData, pagePos, maxDefLevel, numVals);
          defLevels = res.levels; pagePos += res.bytesRead;
        }
      }

      const pageBuf    = pageData.slice(pagePos);
      const isNullable = maxDefLevel > 0;
      const numNonNull = isNullable
        ? defLevels.filter(d => d >= maxDefLevel).length
        : numVals;

      let rawValues;
      if (encoding === 8 || encoding === 2) {
        // RLE_DICTIONARY or PLAIN_DICTIONARY
        if (!dictionary) { for (let i = 0; i < numNonNull; i++) allValues.push(null); continue; }
        const bw      = pageBuf.length > 0 ? pageBuf[0] : 0;
        const indices = readRleBpHybrid(pageBuf, 1, bw, numNonNull);
        rawValues     = indices.map(idx => dictionary[idx] !== undefined ? dictionary[idx] : null);
      } else if (encoding === 0) {
        rawValues = readPlainValues(pageBuf, 0, physType, numNonNull, schemaLeaf.typeLen).values;
      } else if (encoding === 5) {
        rawValues = decodeDeltaBinaryPacked(pageBuf).slice(0, numNonNull);
      } else if (encoding === 6) {
        // DELTA_LENGTH_BYTE_ARRAY: delta-encoded lengths followed by bytes
        try {
          const lengths = decodeDeltaBinaryPacked(pageBuf);
          // estimate byte offset for lengths portion (heuristic)
          let bp = 0;
          rawValues = [];
          for (const len of lengths) {
            if (rawValues.length >= numNonNull) break;
            rawValues.push(pageBuf.slice(bp, bp + len));
            bp += len;
          }
        } catch { rawValues = new Array(numNonNull).fill(null); }
      } else if (encoding === 3) {
        // RLE (used for boolean columns)
        const bw   = physType === 0 ? 1 : 1;
        const vals = readRleBpHybrid(pageBuf, 0, bw, numNonNull);
        rawValues  = physType === 0 ? vals.map(v => !!v) : vals;
      } else if (encoding === 4) {
        // BIT_PACKED (deprecated, 8-value groups)
        const bw  = dictionary ? Math.ceil(Math.log2(dictionary.length + 1)) || 1 : 1;
        rawValues = unpackBits(pageBuf, bw, numNonNull);
      } else {
        rawValues = new Array(numNonNull).fill(null);
      }

      // Merge nulls via def levels
      if (isNullable && defLevels.length > 0) {
        let ri = 0;
        for (let vi = 0; vi < numVals; vi++) {
          const def = defLevels[vi] !== undefined ? defLevels[vi] : maxDefLevel;
          allValues.push(def < maxDefLevel ? null : (rawValues[ri++] ?? null));
        }
      } else {
        for (const v of rawValues) allValues.push(v);
      }
    }
  }

  return allValues;
}

// ─── Read all columns of a row group ────────────────────────────────────────
function readRowGroupData(fileBuf, rowGroup, schemaElements, colFilter) {
  const leaves    = flattenSchema(schemaElements);
  const maxLevels = computeMaxLevels(schemaElements);
  const columns   = {};

  for (const cc of (rowGroup.columns || [])) {
    const meta = cc.metaData;
    if (!meta) continue;
    const colPath = (meta.pathInSchema || []).join(".");
    if (colFilter && colFilter.length > 0 && !colFilter.includes(colPath)) continue;

    const leaf = leaves.find(l => l.path === colPath || l.name === colPath);
    if (!leaf) continue;

    const levels = maxLevels[leaf.name] || { maxDef: 0, maxRep: 0 };
    try {
      const rawVals     = readColumnChunk(fileBuf, cc, leaf, levels.maxDef, levels.maxRep);
      columns[colPath]  = rawVals.map(v => convertValue(v, leaf));
    } catch (e) {
      columns[colPath] = [];
    }
  }
  return columns;
}

// ─── Operations ─────────────────────────────────────────────────────────────
function opInfo(args, resolved) {
  const { meta } = loadParquet(resolved);
  const stat = fs.statSync(resolved);
  return {
    path:         args.path,
    fileSizeBytes: stat.size,
    parquetVersion: meta.version,
    createdBy:    meta.createdBy || null,
    numRows:      Number(meta.numRows || 0n),
    numRowGroups: (meta.rowGroups || []).length,
    numColumns:   flattenSchema(meta.schema).length,
    keyValueMetadata: (meta.keyValueMetadata || []).reduce((o, kv) => { o[kv.key] = kv.value; return o; }, {}),
    rowGroups: (meta.rowGroups || []).map((rg, idx) => ({
      index:        idx,
      numRows:      Number(rg.numRows || 0n),
      totalBytes:   Number(rg.totalByteSize || 0n),
      numColumns:   (rg.columns || []).length,
      compressions: [...new Set((rg.columns || []).map(cc => COMPRESSION[cc.metaData?.codec || 0] || "UNKNOWN"))],
    })),
    schemaTree: buildSchemaTree(meta.schema),
  };
}

function opSchema(args, resolved) {
  const { meta } = loadParquet(resolved);
  const leaves   = flattenSchema(meta.schema);
  return {
    path:       args.path,
    numColumns: leaves.length,
    columns:    leaves.map(l => ({
      name:         l.name,
      path:         l.path,
      physicalType: PHYSICAL_TYPE[l.type] || String(l.type),
      logicalType:  l.logical || null,
      convertedType: l.converted !== undefined ? (CONVERTED_TYPE[l.converted] || String(l.converted)) : null,
      repetition:   ["REQUIRED","OPTIONAL","REPEATED"][l.repetition] || String(l.repetition),
      typeLength:   l.typeLen || null,
    })),
    schemaTree: buildSchemaTree(meta.schema),
  };
}

function opRowGroup(args, resolved) {
  const { buf, meta } = loadParquet(resolved);
  const rgs  = meta.rowGroups || [];
  const idx  = args.row_group_index || 0;
  if (idx < 0 || idx >= rgs.length)
    throw new ToolError(`parquet_client: row_group_index ${idx} out of range (file has ${rgs.length}).`, -32602);

  const rg       = rgs[idx];
  const numRows  = Number(rg.numRows || 0n);
  const columns  = readRowGroupData(buf, rg, meta.schema, args.columns || null);
  const colNames = Object.keys(columns);
  const rowCount = colNames.length > 0 ? (columns[colNames[0]] || []).length : 0;
  const offset   = args.offset || 0;
  const limit    = Math.min(rowCount - offset, args.limit || rowCount, MAX_ROWS);
  const rows     = [];

  for (let i = offset; i < offset + limit && i < rowCount; i++) {
    const row = {};
    for (const col of colNames) row[col] = columns[col][i] ?? null;
    rows.push(row);
  }

  return {
    path:         args.path,
    rowGroupIndex: idx,
    totalRows:    numRows,
    offset,
    returnedRows: rows.length,
    columns:      colNames,
    rows,
  };
}

function opRead(args, resolved) {
  const { buf, meta } = loadParquet(resolved);
  const rgs       = meta.rowGroups || [];
  const colFilter = args.columns || null;
  const limit     = args.limit || MAX_ROWS;
  const offset    = args.offset || 0;
  const allRows   = [];
  let skipped     = 0;

  for (const rg of rgs) {
    if (allRows.length >= limit) break;
    const numRows = Number(rg.numRows || 0n);

    if (skipped + numRows <= offset) { skipped += numRows; continue; }

    const rgOffset = Math.max(0, offset - skipped);
    skipped       += numRows;

    const columns  = readRowGroupData(buf, rg, meta.schema, colFilter);
    const colNames = Object.keys(columns);
    const rowCount = colNames.length > 0 ? (columns[colNames[0]] || []).length : 0;

    for (let i = rgOffset; i < rowCount && allRows.length < limit; i++) {
      const row = {};
      for (const col of colNames) row[col] = columns[col][i] ?? null;
      allRows.push(row);
    }
  }

  return {
    path:         args.path,
    totalRows:    Number(meta.numRows || 0n),
    offset,
    returnedRows: allRows.length,
    columns:      allRows.length > 0 ? Object.keys(allRows[0]) : (colFilter || []),
    rows:         allRows,
  };
}

function opToJson(args, resolved) {
  const result = opRead(args, resolved);
  const json   = JSON.stringify(result.rows, null, args.pretty ? 2 : undefined);

  if (args.output_file) {
    const outPath = args.output_file;
    if (outPath.includes("\0")) throw new ToolError("parquet_client: NUL byte in output_file.", -32602);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, json, "utf8");
    return { path: args.path, outputFile: outPath, writtenRows: result.rows.length, sizeBytes: Buffer.byteLength(json) };
  }

  return { path: args.path, totalRows: result.totalRows, returnedRows: result.rows.length, json };
}

function opToCsv(args, resolved) {
  const result  = opRead(args, resolved);
  const rows    = result.rows;
  const columns = result.columns || (rows.length > 0 ? Object.keys(rows[0]) : []);
  const sep     = args.separator || ",";

  function esc(val) {
    if (val === null || val === undefined) return "";
    const s = String(val);
    return (s.includes(sep) || s.includes('"') || s.includes("\n"))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  const lines = [columns.map(esc).join(sep)];
  for (const row of rows) lines.push(columns.map(c => esc(row[c])).join(sep));
  const csv   = lines.join("\n");

  if (args.output_file) {
    const outPath = args.output_file;
    if (outPath.includes("\0")) throw new ToolError("parquet_client: NUL byte in output_file.", -32602);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, csv, "utf8");
    return { path: args.path, outputFile: outPath, writtenRows: rows.length, sizeBytes: Buffer.byteLength(csv) };
  }

  return { path: args.path, totalRows: result.totalRows, returnedRows: rows.length, csv };
}

// ─── Public API ─────────────────────────────────────────────────────────────
function parquetClient(args, resolveClientPath) {
  if (!args.operation) throw new ToolError("parquet_client: 'operation' is required.", -32602);
  if (!args.path)      throw new ToolError("parquet_client: 'path' is required.", -32602);
  if (args.path.includes("\0")) throw new ToolError("parquet_client: NUL byte in path.", -32602);

  const { resolved } = resolveClientPath(args.path);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) throw new ToolError(`parquet_client: '${args.path}' is a directory.`, -32602);

  switch (args.operation) {
    case "info":      return opInfo(args, resolved);
    case "schema":    return opSchema(args, resolved);
    case "row_group": return opRowGroup(args, resolved);
    case "read":      return opRead(args, resolved);
    case "to_json":   return opToJson(args, resolved);
    case "to_csv":    return opToCsv(args, resolved);
    default:
      throw new ToolError(
        `parquet_client: unknown operation '${args.operation}'. Valid: info, schema, row_group, read, to_json, to_csv.`,
        -32602,
      );
  }
}

module.exports = {
  parquetClient,
  // Exported for tests
  snappyDecompress,
  parseFileMetaData,
  flattenSchema,
  buildSchemaTree,
  readRleBpHybrid,
  unpackBits,
  decodeDeltaBinaryPacked,
  convertValue,
  ThriftCompact,
};
