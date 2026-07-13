"use strict";
// lib/orcClientOps.js — Zero-dep Apache ORC file reader (pure Node.js; no npm deps)
// Supports: info, schema, read, stripe, to_json, to_csv
// Column encodings: DIRECT, DIRECT_V2, DICTIONARY, DICTIONARY_V2, DELTA, RLE_V1, RLE_V2
// Compression: NONE, ZLIB (node:zlib), SNAPPY (pure-JS), LZ4 (raw block decode)
// Column types: BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, STRING, BINARY,
//               TIMESTAMP, LIST, MAP, STRUCT, UNION, DECIMAL, DATE, VARCHAR, CHAR
// Security: 200 MB file cap; 10,000,000 row limit; NUL-byte path guard; dir path rejected

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB
const MAX_ROWS      = 10_000_000;

// ── ORC magic bytes ──────────────────────────────────────────────────────────
const ORC_MAGIC = Buffer.from("ORC");

// ── ORC type IDs ────────────────────────────────────────────────────────────
const TYPE_NAMES = [
  "BOOLEAN","BYTE","SHORT","INT","LONG","FLOAT","DOUBLE","STRING",
  "BINARY","TIMESTAMP","LIST","MAP","STRUCT","UNION","DECIMAL","DATE",
  "VARCHAR","CHAR","TIMESTAMP_INSTANT",
];

// ── Compression codecs ───────────────────────────────────────────────────────
const CODEC_NAMES = ["NONE","ZLIB","SNAPPY","LZO","LZ4","ZSTD","LZ4_RAW"];

// ── Column encodings ─────────────────────────────────────────────────────────
const ENCODING_NAMES = [
  "DIRECT","DICTIONARY","DIRECT_V2","DICTIONARY_V2",
];

// ────────────────────────────────────────────────────────────────────────────
// Minimal Protocol Buffer decoder (wire types 0=varint, 1=64-bit, 2=len, 5=32-bit)
// ────────────────────────────────────────────────────────────────────────────
class PbReader {
  constructor(buf, start, end) {
    this.buf = buf;
    this.pos = start || 0;
    this.end = (end !== undefined) ? end : buf.length;
  }

  eof()  { return this.pos >= this.end; }

  readByte() {
    if (this.pos >= this.end) throw new Error("PbReader: buffer underflow");
    return this.buf[this.pos++];
  }

  readVarint() {
    let result = 0n, shift = 0n;
    while (!this.eof()) {
      const b = this.readByte();
      result |= BigInt(b & 0x7F) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
      if (shift > 63n) throw new Error("PbReader: varint overflow");
    }
    return result;
  }

  readVarint32() { return Number(this.readVarint() & 0xFFFFFFFFn) >>> 0; }

  readFixed64() {
    if (this.pos + 8 > this.end) throw new Error("PbReader: buffer underflow at fixed64");
    const lo = this.buf.readUInt32LE(this.pos);
    const hi = this.buf.readUInt32LE(this.pos + 4);
    this.pos += 8;
    return hi * 0x100000000 + lo;
  }

  readFixed32() {
    if (this.pos + 4 > this.end) throw new Error("PbReader: buffer underflow at fixed32");
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readBytes() {
    const len = this.readVarint32();
    if (this.pos + len > this.end) throw new Error(`PbReader: bytes length ${len} exceeds buffer`);
    const data = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return data;
  }

  readString() { return this.readBytes().toString("utf8"); }

  // Read all fields as {fieldNum, wireType, value} into a map (last wins per field)
  readMessage(start, end) {
    const saved = { pos: this.pos, end: this.end };
    if (start !== undefined) { this.pos = start; this.end = end !== undefined ? end : this.buf.length; }
    const fields = {};
    while (!this.eof()) {
      const tag = this.readVarint32();
      const fieldNum = tag >>> 3;
      const wireType = tag & 7;
      let value;
      switch (wireType) {
        case 0: value = this.readVarint(); break;
        case 1: value = this.readFixed64(); break;
        case 2: value = this.readBytes(); break;
        case 5: value = this.readFixed32(); break;
        default: throw new Error(`PbReader: unknown wire type ${wireType} at pos ${this.pos}`);
      }
      if (!(fieldNum in fields)) fields[fieldNum] = value;
      else {
        if (!Array.isArray(fields[fieldNum])) fields[fieldNum] = [fields[fieldNum]];
        fields[fieldNum].push(value);
      }
    }
    this.pos = saved.pos; this.end = saved.end;
    return fields;
  }

  sub(bytes) { return new PbReader(this.buf, this.pos - bytes.length, this.pos); }
}

function pb(buf) { return new PbReader(buf, 0, buf.length); }

function pbArr(fields, fn, num) {
  const v = fields[num];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.map(fn);
  return [fn(v)];
}

function pbI(f, n, def) {
  const v = f[n];
  if (v === undefined) return def !== undefined ? def : 0;
  const x = Array.isArray(v) ? v[v.length-1] : v;
  return typeof x === "bigint" ? Number(x) : x;
}

function pbB(f, n) {
  const v = f[n];
  if (v === undefined || !Buffer.isBuffer(v)) return Buffer.alloc(0);
  return Array.isArray(v) ? v[v.length-1] : v;
}

function pbS(f, n, def) {
  const v = f[n];
  if (v === undefined) return def !== undefined ? def : "";
  const x = Array.isArray(v) ? v[v.length-1] : v;
  return Buffer.isBuffer(x) ? x.toString("utf8") : String(x);
}

// ── Parse ORC PostScript (last bytes of file before 1-byte ps_len) ──────────
function parsePostScript(buf) {
  const f = pb(buf).readMessage(0, buf.length);
  return {
    footerLength:       pbI(f, 1),
    compression:        pbI(f, 2, 0),
    compressionBlockSize: pbI(f, 3, 256 * 1024),
    version:            pbArr(f, x => Number(x), 4),
    metadataLength:     pbI(f, 5, 0),
    writerVersion:      pbI(f, 6, 0),
    magic:              pbS(f, 8),
  };
}

// ── Parse ORC Type (schema node) ─────────────────────────────────────────────
function parseType(buf) {
  const f = pb(buf).readMessage();
  return {
    kind:         pbI(f, 1),
    subtypes:     pbArr(f, x => Number(x), 2),
    fieldNames:   pbArr(f, x => Buffer.isBuffer(x) ? x.toString("utf8") : String(x), 3),
    maximumLength: pbI(f, 4, 0),
    precision:    pbI(f, 5, 0),
    scale:        pbI(f, 6, 0),
  };
}

// ── Parse ColStats (optional per-column stats) ──────────────────────────────
function parseColStats(buf) {
  const f = pb(buf).readMessage();
  const stats = { numberOfValues: pbI(f, 1, 0) };
  if (f[2]) {
    const i = pb(pbB(f, 2)).readMessage(); stats.intStats = { minimum: pbI(i,1), maximum: pbI(i,2), sum: pbI(i,3) };
  }
  if (f[3]) {
    const d = pb(pbB(f, 3)).readMessage(); stats.doubleStats = { minimum: d[1], maximum: d[2], sum: d[3] };
  }
  if (f[4]) {
    const s = pb(pbB(f, 4)).readMessage(); stats.stringStats = { minimum: pbS(s,1), maximum: pbS(s,2), sum: pbI(s,3) };
  }
  return stats;
}

// ── Parse StripeInformation ──────────────────────────────────────────────────
function parseStripeInfo(buf) {
  const f = pb(buf).readMessage();
  return {
    offset:        pbI(f, 1),
    indexLength:   pbI(f, 2),
    dataLength:    pbI(f, 3),
    footerLength:  pbI(f, 4),
    numberOfRows:  pbI(f, 5),
  };
}

// ── Parse ORC Footer ──────────────────────────────────────────────────────────
function parseFooter(buf) {
  const f = pb(buf).readMessage();
  return {
    headerLength:   pbI(f, 1, 3),
    contentLength:  pbI(f, 2, 0),
    stripes:        pbArr(f, b => parseStripeInfo(Buffer.isBuffer(b) ? b : Buffer.from([Number(b)])), 3),
    types:          pbArr(f, b => parseType(Buffer.isBuffer(b) ? b : Buffer.alloc(0)), 4),
    metadata:       pbArr(f, b => parseColStats(Buffer.isBuffer(b) ? b : Buffer.alloc(0)), 5),
    numberOfRows:   pbI(f, 6, 0),
    statistics:     pbArr(f, b => parseColStats(Buffer.isBuffer(b) ? b : Buffer.alloc(0)), 7),
    rowIndexStride: pbI(f, 8, 10000),
  };
}

// ── Parse StripeFooter ────────────────────────────────────────────────────────
function parseStripeFooter(buf) {
  const f = pb(buf).readMessage();
  return {
    streams:  pbArr(f, b => {
      if (!Buffer.isBuffer(b)) return {};
      const sf = pb(b).readMessage();
      return {
        kind:   pbI(sf, 1),
        column: pbI(sf, 2),
        length: pbI(sf, 3),
      };
    }, 1),
    columns: pbArr(f, b => {
      if (!Buffer.isBuffer(b)) return {};
      const cf = pb(b).readMessage();
      return {
        kind:        pbI(cf, 1),
        dictionarySize: pbI(cf, 2, 0),
      };
    }, 2),
    writerTimezone: pbS(f, 3, "UTC"),
  };
}

// ── Load ORC file ─────────────────────────────────────────────────────────────
function loadOrc(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new ToolError(`orc_client: '${filePath}' is a directory.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(`orc_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`, -32602);

  const buf = fs.readFileSync(filePath);
  if (buf.length < 4) throw new ToolError("orc_client: file too small.", -32602);

  // Validate magic bytes at start
  if (!buf.slice(0, 3).equals(ORC_MAGIC))
    throw new ToolError("orc_client: invalid magic (expected ORC).", -32602);

  // Read postscript: last byte is the postscript length
  const psLen = buf[buf.length - 1];
  if (psLen === 0 || psLen > buf.length - 4)
    throw new ToolError(`orc_client: invalid postscript length ${psLen}.`, -32602);

  const psStart = buf.length - 1 - psLen;
  const ps = parsePostScript(buf.slice(psStart, psStart + psLen));

  // Validate footer presence
  const footerStart = psStart - ps.footerLength - ps.metadataLength;
  if (footerStart < 3 || ps.footerLength <= 0)
    throw new ToolError(`orc_client: invalid footer length ${ps.footerLength}.`, -32602);

  const metaEnd    = psStart - ps.footerLength;
  const metaStart  = metaEnd - ps.metadataLength;
  const footerRaw  = buf.slice(metaEnd, metaEnd + ps.footerLength);

  const footerDecompressed = decompressBlock(ps.compression, footerRaw, ps.compressionBlockSize);
  const footer = parseFooter(footerDecompressed);

  return { buf, ps, footer, filePath };
}

// ────────────────────────────────────────────────────────────────────────────
// Decompression helpers
// ────────────────────────────────────────────────────────────────────────────

// Pure-JS Snappy decompressor (same as parquetClientOps)
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
      for (let i = 0; i < len; i++) dst[out + i] = dst[start + (i % offset || offset)];
      out += len;
    } else if (type === 2) {
      const len    = ((tag >> 2) & 0x3F) + 1;
      const offset = src.readUInt16LE(pos); pos += 2;
      const start  = out - offset;
      for (let i = 0; i < len; i++) dst[out + i] = dst[start + (i % offset || offset)];
      out += len;
    } else {
      const len    = ((tag >> 2) & 0x3F) + 1;
      const offset = src.readUInt32LE(pos); pos += 4;
      const start  = out - offset;
      for (let i = 0; i < len; i++) dst[out + i] = dst[start + (i % offset || offset)];
      out += len;
    }
  }
  return dst.slice(0, out);
}

// ORC chunk header: 3-byte little-endian (isOriginal bit + length)
function decompressOrcStream(codec, compBuf, blockSize) {
  if (codec === 0) return compBuf; // NONE
  const chunks = [];
  let pos = 0;
  while (pos < compBuf.length) {
    if (pos + 3 > compBuf.length) break;
    const b0 = compBuf[pos], b1 = compBuf[pos+1], b2 = compBuf[pos+2];
    pos += 3;
    const isOriginal = (b0 & 1) !== 0;
    const chunkLen   = (b0 >>> 1) | (b1 << 7) | (b2 << 15);
    const chunk = compBuf.slice(pos, pos + chunkLen);
    pos += chunkLen;
    if (isOriginal) {
      chunks.push(chunk);
    } else {
      chunks.push(decompressBlock(codec, chunk, blockSize));
    }
  }
  return chunks.length === 0 ? Buffer.alloc(0) :
         chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

function decompressBlock(codec, data, blockSize) {
  switch (codec) {
    case 0: return data;                              // NONE
    case 1: return zlib.inflateRawSync(data);         // ZLIB (deflate, no header)
    case 2: return snappyDecompress(data);            // SNAPPY
    case 4: return lz4Decompress(data);               // LZ4
    default:
      throw new ToolError(
        `orc_client: unsupported compression '${CODEC_NAMES[codec] || codec}'. Supported: NONE, ZLIB, SNAPPY, LZ4.`,
        -32602,
      );
  }
}

// LZ4 raw block decompressor
function lz4Decompress(src) {
  let pos = 0;
  const out = [];
  let totalOut = 0;
  while (pos < src.length) {
    const token  = src[pos++];
    let litLen   = token >> 4;
    if (litLen === 15) {
      let extra;
      do { extra = src[pos++]; litLen += extra; } while (extra === 255);
    }
    const lits = src.slice(pos, pos + litLen);
    out.push(lits); totalOut += litLen; pos += litLen;
    if (pos >= src.length) break;
    const matchOff = src[pos] | (src[pos+1] << 8); pos += 2;
    let matchLen = (token & 0x0F) + 4;
    if (matchLen - 4 === 15) {
      let extra;
      do { extra = src[pos++]; matchLen += extra; } while (extra === 255);
    }
    const copyStart = totalOut - matchOff;
    const matchBuf  = Buffer.allocUnsafe(matchLen);
    for (let i = 0; i < matchLen; i++) {
      // Walk the already-written bytes
      let srcIdx = copyStart + (i % matchOff);
      matchBuf[i] = out.reduce((acc, b) => {
        if (srcIdx < b.length) return b[srcIdx];
        srcIdx -= b.length;
        return acc;
      }, 0);
    }
    out.push(matchBuf); totalOut += matchLen;
  }
  return Buffer.concat(out);
}

// ────────────────────────────────────────────────────────────────────────────
// Integer RLE decoders
// ────────────────────────────────────────────────────────────────────────────

// RLE v1: runs of repeated values or literal runs
function decodeRleV1(buf, signed, count) {
  const vals = [];
  let pos = 0;
  while (pos < buf.length && vals.length < count) {
    const hdr = buf[pos++];
    if (hdr >= 128) {
      // literal run: (256 - hdr) values
      const n = 256 - hdr;
      for (let i = 0; i < n && pos < buf.length && vals.length < count; i++) {
        let v = readVarIntBuf(buf, pos);
        pos += v.bytesRead;
        vals.push(signed ? zigzagDecode(v.value) : Number(v.value));
      }
    } else {
      // repeated run: (hdr + 3) copies
      const n = hdr + 3;
      const delta = buf[pos++]; // always signed byte
      let v = readVarIntBuf(buf, pos);
      pos += v.bytesRead;
      let cur = signed ? zigzagDecode(v.value) : Number(v.value);
      for (let i = 0; i < n && vals.length < count; i++) {
        vals.push(cur);
        cur += delta;
      }
    }
  }
  return vals;
}

function readVarIntBuf(buf, pos) {
  let result = 0n, shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result |= BigInt(b & 0x7F) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("varint overflow");
  }
  return { value: result, bytesRead: p - pos };
}

function zigzagDecode(n) {
  // n is BigInt
  return Number(n % 2n === 0n ? n >> 1n : -((n + 1n) >> 1n));
}

// RLE v2 sub-encodings
const RLEV2_SHORT_REPEAT = 0;
const RLEV2_DIRECT       = 1;
const RLEV2_PATCHED_BASE = 2;
const RLEV2_DELTA        = 3;

function decodeRleV2(buf, signed, count) {
  const vals = [];
  let pos = 0;
  while (pos < buf.length && vals.length < count) {
    const firstByte = buf[pos];
    const encoding  = (firstByte >> 6) & 3;
    if (encoding === RLEV2_SHORT_REPEAT) {
      pos = decodeShortRepeat(buf, pos, signed, vals, count);
    } else if (encoding === RLEV2_DIRECT) {
      pos = decodeDirect(buf, pos, signed, vals, count);
    } else if (encoding === RLEV2_PATCHED_BASE) {
      pos = decodePatchedBase(buf, pos, signed, vals, count);
    } else {
      pos = decodeDelta(buf, pos, signed, vals, count);
    }
  }
  return vals;
}

function decodeShortRepeat(buf, pos, signed, vals, count) {
  const hdr    = buf[pos++];
  const width  = ((hdr >> 3) & 7) + 1; // bytes in value
  const repLen = (hdr & 7) + 3;
  let val = 0n;
  for (let i = 0; i < width; i++) val = (val << 8n) | BigInt(buf[pos++]);
  const v = signed ? Number(val % 2n === 0n ? val >> 1n : -((val+1n)>>1n)) : Number(val);
  for (let i = 0; i < repLen && vals.length < count; i++) vals.push(v);
  return pos;
}

function decodeDirect(buf, pos, signed, vals, count) {
  const b1 = buf[pos++], b2 = buf[pos++];
  const w  = ((b1 >> 1) & 31) + 1; // bit-width (encoded as w-1)
  const bw = encodedWidth(w);
  const n  = (((b1 & 1) << 8) | b2) + 1;
  const bytesNeeded = Math.ceil(n * bw / 8);
  const chunk = buf.slice(pos, pos + bytesNeeded);
  pos += bytesNeeded;
  const rawVals = unpackBitsV2(chunk, bw, n);
  for (const rv of rawVals) {
    if (vals.length >= count) break;
    vals.push(signed ? zigzagDecodeNum(rv) : rv);
  }
  return pos;
}

function decodePatchedBase(buf, pos, signed, vals, count) {
  const b1  = buf[pos++], b2 = buf[pos++], b3 = buf[pos++], b4 = buf[pos++];
  const bw  = encodedWidth(((b1 >> 1) & 31) + 1);
  const n   = (((b1 & 1) << 8) | b2) + 1;
  const baseW = ((b3 >> 5) & 7) + 1;           // bytes for base value
  const patchW = encodedWidth((b3 & 31) + 1);  // patch width
  const pgap  = (b4 >> 5) & 7;                  // patch gap width = pgap+1 bits
  const pcnt  = b4 & 31;                         // patch list count

  // Read base value (big-endian, signed MSB)
  let base = 0n;
  for (let i = 0; i < baseW; i++) base = (base << 8n) | BigInt(buf[pos++]);
  const baseSigned = (base >> BigInt((baseW * 8) - 1)) !== 0n
    ? base - (1n << BigInt(baseW * 8))
    : base;

  const bytesNeeded = Math.ceil(n * bw / 8);
  const chunk = buf.slice(pos, pos + bytesNeeded); pos += bytesNeeded;
  const rawVals = unpackBitsV2(chunk, bw, n);

  // patch list
  const patchBits = (pgap + 1) + patchW;
  const patchBytes = Math.ceil(pcnt * patchBits / 8);
  const patchBuf  = buf.slice(pos, pos + patchBytes); pos += patchBytes;
  const patchList = unpackBitsV2(patchBuf, patchBits, pcnt);

  // Apply patches
  let gapShift = 0, patchIdx = 0;
  const patched = rawVals.map(v => Number(baseSigned) + v);
  for (const pEntry of patchList) {
    const gapBits   = pEntry >>> patchW;
    const patchVal  = pEntry & ((1 << patchW) - 1);
    gapShift += gapBits;
    if (gapShift < patched.length) {
      patched[gapShift] |= (patchVal << bw);
    }
    patchIdx++;
  }

  for (const v of patched) {
    if (vals.length >= count) break;
    vals.push(v);
  }
  return pos;
}

function decodeDelta(buf, pos, signed, vals, count) {
  const b1 = buf[pos++], b2 = buf[pos++];
  const bw = encodedWidth(((b1 >> 1) & 31)); // may be 0 for fixed-delta
  const n  = (((b1 & 1) << 8) | b2) + 1;

  // First value
  let v0 = readVarIntBuf(buf, pos); pos += v0.bytesRead;
  const base = signed ? zigzagDecode(v0.value) : Number(v0.value);

  // Delta (signed zigzag encoded)
  let dv = readVarIntBuf(buf, pos); pos += dv.bytesRead;
  const delta = zigzagDecode(dv.value);

  vals.push(base);
  if (n === 1) return pos;

  if (bw === 0) {
    // Fixed delta
    let cur = base;
    for (let i = 1; i < n && vals.length < count; i++) { cur += delta; vals.push(cur); }
    return pos;
  }

  // Variable deltas
  const bytesNeeded = Math.ceil((n - 2) * bw / 8);
  const chunk = buf.slice(pos, pos + bytesNeeded); pos += bytesNeeded;
  const deltaVals = unpackBitsV2(chunk, bw, n - 2);

  // second value = base + delta
  vals.push(base + delta);
  let cur = base + delta;
  for (const dv2 of deltaVals) {
    if (vals.length >= count) break;
    // deltaDelta: positive means +, negative means -
    cur += (delta >= 0 ? dv2 : -dv2);
    vals.push(cur);
  }
  return pos;
}

// Decode ORC "encoded width" table (see ORC spec Table 1)
function encodedWidth(w) {
  const TABLE = [
    1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
    17,18,19,20,21,22,23,24,26,28,30,32,40,48,56,64,
  ];
  return (w >= 1 && w <= 32) ? TABLE[w-1] : w;
}

function zigzagDecodeNum(n) {
  return (n & 1) !== 0 ? -((n + 1) >> 1) : n >> 1;
}

// Bit-pack unpack (big-endian, MSB first) for RLE V2
function unpackBitsV2(buf, bitWidth, count) {
  if (bitWidth === 0) return new Array(count).fill(0);
  const out = new Array(count);
  let bitPos = 0;
  for (let i = 0; i < count; i++) {
    let val = 0;
    for (let b = bitWidth - 1; b >= 0; b--) {
      const byteIdx = bitPos >> 3;
      const bitOff  = 7 - (bitPos & 7);
      if (byteIdx < buf.length) val |= ((buf[byteIdx] >> bitOff) & 1) << b;
      bitPos++;
    }
    out[i] = val;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Boolean RLE reader
// ────────────────────────────────────────────────────────────────────────────
function decodeBooleans(buf, count) {
  // ORC boolean: byte stream, 8 booleans per byte, MSB first
  const vals = [];
  for (let bi = 0; bi < buf.length && vals.length < count; bi++) {
    const b = buf[bi];
    for (let bit = 7; bit >= 0 && vals.length < count; bit--) {
      vals.push(((b >> bit) & 1) !== 0);
    }
  }
  return vals;
}

// ────────────────────────────────────────────────────────────────────────────
// Build schema tree from ORC types
// ────────────────────────────────────────────────────────────────────────────
function buildSchema(types, idx) {
  if (!types || idx >= types.length) return null;
  const t = types[idx];
  const node = {
    columnId:  idx,
    kind:      TYPE_NAMES[t.kind] || `TYPE_${t.kind}`,
  };
  if (t.maximumLength) node.maximumLength = t.maximumLength;
  if (t.precision)     node.precision     = t.precision;
  if (t.scale)         node.scale         = t.scale;
  if (t.subtypes && t.subtypes.length) {
    if (t.kind === 12) { // STRUCT
      node.fields = t.subtypes.map((sub, i) => ({
        name:   t.fieldNames[i] || `field_${i}`,
        schema: buildSchema(types, sub),
      }));
    } else if (t.kind === 10) { // LIST
      node.elementType = buildSchema(types, t.subtypes[0]);
    } else if (t.kind === 11) { // MAP
      node.keyType   = buildSchema(types, t.subtypes[0]);
      node.valueType = buildSchema(types, t.subtypes[1]);
    } else if (t.kind === 13) { // UNION
      node.variants = t.subtypes.map(sub => buildSchema(types, sub));
    }
  }
  return node;
}

function getLeafColumns(types, idx, parentPath) {
  if (!types || idx >= types.length) return [];
  const t = types[idx];
  const name = (parentPath !== undefined && parentPath !== null) ? parentPath : `col${idx}`;
  if (!t.subtypes || t.subtypes.length === 0) {
    return [{ columnId: idx, path: name, kind: TYPE_NAMES[t.kind] || `TYPE_${t.kind}`,
               precision: t.precision, scale: t.scale, maxLen: t.maximumLength }];
  }
  if (t.kind === 12) { // STRUCT
    return t.subtypes.flatMap((sub, i) =>
      getLeafColumns(types, sub, (name ? name + "." : "") + (t.fieldNames[i] || `field_${i}`))
    );
  }
  if (t.kind === 10) { // LIST
    return getLeafColumns(types, t.subtypes[0], name + "[]");
  }
  if (t.kind === 11) { // MAP
    return [
      ...getLeafColumns(types, t.subtypes[0], name + ".key"),
      ...getLeafColumns(types, t.subtypes[1], name + ".value"),
    ];
  }
  return [{ columnId: idx, path: name, kind: TYPE_NAMES[t.kind] || `TYPE_${t.kind}` }];
}

// ────────────────────────────────────────────────────────────────────────────
// Stripe data reading
// ────────────────────────────────────────────────────────────────────────────

function readStripe(fileBuf, stripeInfo, footer, ps, colFilter) {
  const { offset, indexLength, dataLength, footerLength, numberOfRows } = stripeInfo;
  const numRows = numberOfRows;

  // Read stripe footer
  const sfStart  = offset + indexLength + dataLength;
  const sfRaw    = fileBuf.slice(sfStart, sfStart + footerLength);
  const sfDecomp = decompressOrcStream(ps.compression, sfRaw, ps.compressionBlockSize);
  const sf       = parseStripeFooter(sfDecomp);

  // Build stream map: stream data is stored sequentially after the index
  const streams = sf.streams || [];
  const streamMap = new Map(); // (column, kind) -> Buffer
  let pos = offset + indexLength;
  for (const s of streams) {
    const data = fileBuf.slice(pos, pos + s.length);
    pos += s.length;
    streamMap.set(`${s.column}:${s.kind}`, data);
  }

  // Column encodings
  const colEncodings = sf.columns || [];

  // Get top-level struct field names and column IDs
  const types = footer.types || [];
  const rootType = types[0];
  if (!rootType || rootType.kind !== 12) {
    // Non-struct root: return single column
    return readColumnData(fileBuf, 0, types, streamMap, colEncodings, ps, numRows);
  }

  const result = {};
  for (let fi = 0; fi < rootType.subtypes.length; fi++) {
    const subColId = rootType.subtypes[fi];
    const colName  = rootType.fieldNames[fi] || `col${fi}`;
    if (colFilter && colFilter.length > 0 && !colFilter.includes(colName)) continue;
    try {
      result[colName] = readColumnData(fileBuf, subColId, types, streamMap, colEncodings, ps, numRows);
    } catch (e) {
      result[colName] = new Array(numRows).fill(null);
    }
  }
  return result;
}

function getStream(streamMap, col, kind, codec, blockSize) {
  const raw = streamMap.get(`${col}:${kind}`);
  if (!raw || raw.length === 0) return Buffer.alloc(0);
  return decompressOrcStream(codec, raw, blockSize);
}

function readColumnData(fileBuf, colId, types, streamMap, colEncodings, ps, numRows) {
  if (!types || colId >= types.length) return new Array(numRows).fill(null);
  const typeInfo = types[colId];
  const encoding = colEncodings[colId] || { kind: 0 };
  const kind     = typeInfo.kind;
  const codec    = ps.compression;
  const blockSize = ps.compressionBlockSize;

  // Stream kinds:
  // 0=PRESENT, 1=DATA, 2=LENGTH, 3=DICTIONARY_DATA, 4=PRESENT(2), 5=SECONDARY
  const STREAM_PRESENT    = 0;
  const STREAM_DATA       = 1;
  const STREAM_LENGTH     = 2;
  const STREAM_DICT_DATA  = 3;
  const STREAM_SECONDARY  = 5;

  // Read present stream (nulls)
  const presentRaw = getStream(streamMap, colId, STREAM_PRESENT, codec, blockSize);
  let present = null;
  if (presentRaw.length > 0) {
    // Present stream: byte RLE, then unpack bits
    const presentBytes = decodeRleV1(presentRaw, false, Math.ceil(numRows / 8));
    const presentBuf   = Buffer.from(presentBytes);
    present = decodeBooleans(presentBuf, numRows);
  }

  const numNonNull = present ? present.filter(Boolean).length : numRows;

  function applyNulls(rawVals) {
    if (!present) return rawVals;
    const out = [];
    let ri = 0;
    for (let i = 0; i < numRows; i++) {
      out.push(present[i] ? (rawVals[ri++] ?? null) : null);
    }
    return out;
  }

  // BOOLEAN
  if (kind === 0) {
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    // boolean: byte RLE then unpack bits
    const bytes   = decodeRleV1(dataRaw, false, Math.ceil(numNonNull / 8) + 1);
    const boolBuf = Buffer.from(bytes);
    const bools   = decodeBooleans(boolBuf, numNonNull);
    return applyNulls(bools);
  }

  // BYTE (tinyint)
  if (kind === 1) {
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    // Byte: RLE v1, signed
    const vals = decodeRleV1(dataRaw, true, numNonNull);
    return applyNulls(vals);
  }

  // SHORT (2), INT (3), LONG (4)
  if (kind >= 2 && kind <= 4) {
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    const encKind = encoding.kind;
    // DIRECT=0/1: RLE v1; DIRECT_V2=2/3: RLE v2
    let vals;
    if (encKind <= 1) {
      vals = decodeRleV1(dataRaw, true, numNonNull);
    } else {
      vals = decodeRleV2(dataRaw, true, numNonNull);
    }
    return applyNulls(vals);
  }

  // FLOAT (5)
  if (kind === 5) {
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    const vals = [];
    for (let i = 0; i + 4 <= dataRaw.length && vals.length < numNonNull; i += 4)
      vals.push(dataRaw.readFloatLE(i));
    return applyNulls(vals);
  }

  // DOUBLE (6)
  if (kind === 6) {
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    const vals = [];
    for (let i = 0; i + 8 <= dataRaw.length && vals.length < numNonNull; i += 8)
      vals.push(dataRaw.readDoubleLE(i));
    return applyNulls(vals);
  }

  // STRING (7), VARCHAR (16), CHAR (17)
  if (kind === 7 || kind === 16 || kind === 17) {
    const encKind  = encoding.kind;
    const isDirect = (encKind === 0 || encKind === 2);
    if (isDirect) {
      // DIRECT / DIRECT_V2: DATA + LENGTH streams
      const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
      const lenRaw  = getStream(streamMap, colId, STREAM_LENGTH, codec, blockSize);
      const lengths = encKind <= 1
        ? decodeRleV1(lenRaw, false, numNonNull)
        : decodeRleV2(lenRaw, false, numNonNull);
      const vals = [];
      let bp = 0;
      for (const len of lengths) {
        if (vals.length >= numNonNull) break;
        vals.push(dataRaw.slice(bp, bp + len).toString("utf8"));
        bp += len;
      }
      return applyNulls(vals);
    } else {
      // DICTIONARY / DICTIONARY_V2
      const dictRaw  = getStream(streamMap, colId, STREAM_DICT_DATA, codec, blockSize);
      const lenRaw   = getStream(streamMap, colId, STREAM_LENGTH, codec, blockSize);
      const dataRaw  = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
      const dictSize = encoding.dictionarySize || 0;
      const lengths  = encKind <= 1
        ? decodeRleV1(lenRaw, false, dictSize)
        : decodeRleV2(lenRaw, false, dictSize);
      // Build dictionary
      const dict = [];
      let bp = 0;
      for (const len of lengths) {
        dict.push(dictRaw.slice(bp, bp + len).toString("utf8"));
        bp += len;
      }
      // Read indices
      const indices = encKind <= 1
        ? decodeRleV1(dataRaw, false, numNonNull)
        : decodeRleV2(dataRaw, false, numNonNull);
      const vals = indices.map(idx => dict[idx] ?? null);
      return applyNulls(vals);
    }
  }

  // BINARY (8)
  if (kind === 8) {
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    const lenRaw  = getStream(streamMap, colId, STREAM_LENGTH, codec, blockSize);
    const encKind = encoding.kind;
    const lengths = encKind <= 1
      ? decodeRleV1(lenRaw, false, numNonNull)
      : decodeRleV2(lenRaw, false, numNonNull);
    const vals = [];
    let bp = 0;
    for (const len of lengths) {
      if (vals.length >= numNonNull) break;
      vals.push(dataRaw.slice(bp, bp + len).toString("base64"));
      bp += len;
    }
    return applyNulls(vals);
  }

  // TIMESTAMP (9) — seconds in DATA, nanos in SECONDARY
  if (kind === 9) {
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    const secRaw  = getStream(streamMap, colId, STREAM_SECONDARY, codec, blockSize);
    const encKind = encoding.kind;
    const seconds = encKind <= 1
      ? decodeRleV1(dataRaw, true, numNonNull)
      : decodeRleV2(dataRaw, true, numNonNull);
    const nanos = encKind <= 1
      ? decodeRleV1(secRaw, false, numNonNull)
      : decodeRleV2(secRaw, false, numNonNull);
    // ORC epoch is 1 Jan 2015
    const ORC_EPOCH_MS = 1420070400000;
    const vals = seconds.map((s, i) => {
      const totalMs = ORC_EPOCH_MS + s * 1000 + Math.floor((nanos[i] || 0) / 1e6);
      return new Date(totalMs).toISOString();
    });
    return applyNulls(vals);
  }

  // DATE (15): days since epoch
  if (kind === 15) {
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    const encKind = encoding.kind;
    const days    = encKind <= 1
      ? decodeRleV1(dataRaw, true, numNonNull)
      : decodeRleV2(dataRaw, true, numNonNull);
    const vals    = days.map(d => new Date(d * 86400000).toISOString().slice(0, 10));
    return applyNulls(vals);
  }

  // DECIMAL (14): unscaled value + scale
  if (kind === 14) {
    const dataRaw  = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    const scaleRaw = getStream(streamMap, colId, STREAM_SECONDARY, codec, blockSize);
    const encKind  = encoding.kind;
    const scales   = encKind <= 1
      ? decodeRleV1(scaleRaw, false, numNonNull)
      : decodeRleV2(scaleRaw, false, numNonNull);
    // Unscaled values are zigzag-encoded varints
    const vals = [];
    let pos = 0;
    for (let i = 0; i < numNonNull && pos < dataRaw.length; i++) {
      const v  = readVarIntBuf(dataRaw, pos);
      pos     += v.bytesRead;
      const unscaled = zigzagDecode(v.value);
      const scale    = scales[i] || 0;
      vals.push(scale === 0 ? unscaled : unscaled / Math.pow(10, scale));
    }
    return applyNulls(vals);
  }

  // STRUCT (12): read each field recursively
  if (kind === 12) {
    const t = types[colId];
    const row = {};
    for (let fi = 0; fi < t.subtypes.length; fi++) {
      const subColId = t.subtypes[fi];
      const fieldName = t.fieldNames[fi] || `field_${fi}`;
      try {
        const fieldVals = readColumnData(fileBuf, subColId, types, streamMap, colEncodings, ps, numRows);
        row[fieldName] = fieldVals;
      } catch {
        row[fieldName] = new Array(numRows).fill(null);
      }
    }
    // Transpose to array of objects
    const fieldNames = Object.keys(row);
    const result = [];
    for (let i = 0; i < numRows; i++) {
      const obj = {};
      for (const fn of fieldNames) obj[fn] = row[fn][i] ?? null;
      result.push(present ? (present[i] ? obj : null) : obj);
    }
    return result;
  }

  // LIST (10): length in LENGTH stream, elements in sub-column
  if (kind === 10) {
    const t = types[colId];
    const lenRaw  = getStream(streamMap, colId, STREAM_LENGTH, codec, blockSize);
    const encKind = encoding.kind;
    const lengths = encKind <= 1
      ? decodeRleV1(lenRaw, false, numNonNull)
      : decodeRleV2(lenRaw, false, numNonNull);
    const totalElems = lengths.reduce((a, b) => a + b, 0);
    const subColId = t.subtypes[0];
    let subVals;
    try {
      subVals = readColumnData(fileBuf, subColId, types, streamMap, colEncodings, ps, totalElems);
    } catch { subVals = new Array(totalElems).fill(null); }
    const result = [];
    let si = 0;
    for (const len of lengths) {
      result.push(subVals.slice(si, si + len));
      si += len;
    }
    return applyNulls(result);
  }

  // MAP (11)
  if (kind === 11) {
    const t = types[colId];
    const lenRaw  = getStream(streamMap, colId, STREAM_LENGTH, codec, blockSize);
    const encKind = encoding.kind;
    const lengths = encKind <= 1
      ? decodeRleV1(lenRaw, false, numNonNull)
      : decodeRleV2(lenRaw, false, numNonNull);
    const totalElems = lengths.reduce((a, b) => a + b, 0);
    let keys, vals;
    try { keys = readColumnData(fileBuf, t.subtypes[0], types, streamMap, colEncodings, ps, totalElems); } catch { keys = new Array(totalElems).fill(null); }
    try { vals = readColumnData(fileBuf, t.subtypes[1], types, streamMap, colEncodings, ps, totalElems); } catch { vals = new Array(totalElems).fill(null); }
    const result = [];
    let si = 0;
    for (const len of lengths) {
      const entry = {};
      for (let i = 0; i < len; i++) entry[String(keys[si+i])] = vals[si+i];
      result.push(entry);
      si += len;
    }
    return applyNulls(result);
  }

  // UNION (13)
  if (kind === 13) {
    // Union: DIRECT byte stream for tag, then sub-column per variant
    const t = types[colId];
    const dataRaw = getStream(streamMap, colId, STREAM_DATA, codec, blockSize);
    const tags    = decodeRleV1(dataRaw, false, numNonNull);
    const variantCounts = new Array(t.subtypes.length).fill(0);
    for (const tag of tags) { if (tag < variantCounts.length) variantCounts[tag]++; }
    const variantVals = [];
    for (let vi = 0; vi < t.subtypes.length; vi++) {
      try {
        variantVals.push(readColumnData(fileBuf, t.subtypes[vi], types, streamMap, colEncodings, ps, variantCounts[vi]));
      } catch { variantVals.push(new Array(variantCounts[vi]).fill(null)); }
    }
    const variantIdx = new Array(t.subtypes.length).fill(0);
    const result = tags.map(tag => {
      const v = variantVals[tag] && variantVals[tag][variantIdx[tag]];
      variantIdx[tag]++;
      return v ?? null;
    });
    return applyNulls(result);
  }

  // Fallback: unsupported type
  return new Array(numRows).fill(null);
}

// ────────────────────────────────────────────────────────────────────────────
// Operations
// ────────────────────────────────────────────────────────────────────────────

function opInfo(args, resolved) {
  const { ps, footer, filePath } = loadOrc(resolved);
  const stat = fs.statSync(resolved);
  const types = footer.types || [];
  const leaves = types[0] && types[0].kind === 12
    ? getLeafColumns(types, 0, "").filter(l => l.path !== "")
    : getLeafColumns(types, 0, "root");

  return {
    path:          args.path,
    fileSizeBytes: stat.size,
    compression:   CODEC_NAMES[ps.compression] || `CODEC_${ps.compression}`,
    orcVersion:    ps.version.join("."),
    writerVersion: ps.writerVersion,
    numberOfRows:  footer.numberOfRows,
    numberOfStripes: (footer.stripes || []).length,
    numberOfColumns: types.length,
    rowIndexStride: footer.rowIndexStride,
    stripes: (footer.stripes || []).map((s, i) => ({
      index:        i,
      numberOfRows: s.numberOfRows,
      offset:       s.offset,
      indexLength:  s.indexLength,
      dataLength:   s.dataLength,
      footerLength: s.footerLength,
    })),
    schema: buildSchema(types, 0),
  };
}

function opSchema(args, resolved) {
  const { footer } = loadOrc(resolved);
  const types = footer.types || [];
  const leaves = types[0] && types[0].kind === 12
    ? getLeafColumns(types, 0, "").filter(l => l.path !== "")
    : getLeafColumns(types, 0, "root");
  return {
    path:       args.path,
    numColumns: leaves.length,
    columns:    leaves.map(l => ({
      columnId:  l.columnId,
      name:      l.path,
      kind:      l.kind,
      precision: l.precision || null,
      scale:     l.scale || null,
      maxLength: l.maxLen || null,
    })),
    schemaTree: buildSchema(types, 0),
  };
}

function opStripe(args, resolved) {
  const { buf, ps, footer } = loadOrc(resolved);
  const stripes = footer.stripes || [];
  const idx     = args.stripe_index || 0;
  if (idx < 0 || idx >= stripes.length)
    throw new ToolError(`orc_client: stripe_index ${idx} out of range (file has ${stripes.length}).`, -32602);

  const si         = stripes[idx];
  const colFilter  = args.columns || null;
  const columns    = readStripe(buf, si, footer, ps, colFilter);
  const colNames   = Object.keys(columns);
  const rowCount   = colNames.length > 0 ? (columns[colNames[0]] || []).length : 0;
  const offset     = args.offset || 0;
  const limit      = Math.min(rowCount - offset, args.limit || rowCount, MAX_ROWS);
  const rows       = [];

  for (let i = offset; i < offset + limit && i < rowCount; i++) {
    const row = {};
    for (const col of colNames) row[col] = columns[col][i] ?? null;
    rows.push(row);
  }

  return {
    path:        args.path,
    stripeIndex: idx,
    totalRows:   si.numberOfRows,
    offset,
    returnedRows: rows.length,
    columns:     colNames,
    rows,
  };
}

function opRead(args, resolved) {
  const { buf, ps, footer } = loadOrc(resolved);
  const stripes    = footer.stripes || [];
  const colFilter  = args.columns || null;
  const limit      = args.limit || MAX_ROWS;
  const targetOffset = args.offset || 0;
  const allRows    = [];
  let   skipped    = 0;

  for (const si of stripes) {
    if (allRows.length >= limit) break;
    const stripeRows = si.numberOfRows;
    if (skipped + stripeRows <= targetOffset) { skipped += stripeRows; continue; }

    let columns;
    try { columns = readStripe(buf, si, footer, ps, colFilter); }
    catch { skipped += stripeRows; continue; }

    const colNames = Object.keys(columns);
    const rowCount = colNames.length > 0 ? (columns[colNames[0]] || []).length : 0;
    const stripeOffset = Math.max(0, targetOffset - skipped);
    skipped += stripeRows;

    for (let i = stripeOffset; i < rowCount && allRows.length < limit; i++) {
      const row = {};
      for (const col of colNames) row[col] = columns[col][i] ?? null;
      allRows.push(row);
    }
  }

  return {
    path:         args.path,
    totalRows:    footer.numberOfRows,
    offset:       targetOffset,
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
    if (outPath.includes("\0")) throw new ToolError("orc_client: NUL byte in output_file.", -32602);
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
    if (typeof val === "object") return esc(JSON.stringify(val));
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
    if (outPath.includes("\0")) throw new ToolError("orc_client: NUL byte in output_file.", -32602);
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, csv, "utf8");
    return { path: args.path, outputFile: outPath, writtenRows: rows.length, sizeBytes: Buffer.byteLength(csv) };
  }
  return { path: args.path, totalRows: result.totalRows, returnedRows: rows.length, csv };
}

// ── Public API ───────────────────────────────────────────────────────────────
function orcClient(args, resolveClientPath) {
  if (!args.operation) throw new ToolError("orc_client: 'operation' is required.", -32602);
  if (!args.path)      throw new ToolError("orc_client: 'path' is required.", -32602);
  if (args.path.includes("\0")) throw new ToolError("orc_client: NUL byte in path.", -32602);

  const { resolved } = resolveClientPath(args.path);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) throw new ToolError(`orc_client: '${args.path}' is a directory.`, -32602);

  switch (args.operation) {
    case "info":    return opInfo(args, resolved);
    case "schema":  return opSchema(args, resolved);
    case "stripe":  return opStripe(args, resolved);
    case "read":    return opRead(args, resolved);
    case "to_json": return opToJson(args, resolved);
    case "to_csv":  return opToCsv(args, resolved);
    default:
      throw new ToolError(
        `orc_client: unknown operation '${args.operation}'. Valid: info, schema, stripe, read, to_json, to_csv.`,
        -32602,
      );
  }
}

module.exports = {
  orcClient,
  // Exported for tests
  decodeRleV1,
  decodeRleV2,
  decodeBooleans,
  snappyDecompress,
  lz4Decompress,
  parsePostScript,
  parseFooter,
  buildSchema,
  getLeafColumns,
  PbReader,
  unpackBitsV2,
  zigzagDecode,
};
