"use strict";
// lib/avroClientOps.js — avro_client tool
// Zero-dependency Apache Avro binary encoder/decoder (pure Node.js; no npm deps).
// Reference: https://avro.apache.org/docs/current/spec.html
//
// Supported Avro types:
//   Primitives: null, boolean, int, long, float, double, bytes, string
//   Complex:    record, enum, array, map, union, fixed
//
// Binary encoding:
//   null    : 0 bytes
//   boolean : 1 byte (0x00=false, 0x01=true)
//   int     : zigzag VarInt, 32-bit signed
//   long    : zigzag VarInt, 64-bit signed (BigInt internally)
//   float   : 4 bytes IEEE 754 little-endian
//   double  : 8 bytes IEEE 754 little-endian
//   bytes   : long (byte count) + raw bytes
//   string  : long (UTF-8 byte count) + UTF-8 bytes
//   record  : each field encoded in schema declaration order
//   enum    : int (0-based index into symbols array)
//   array   : one or more blocks; each block = long count + items;
//             negative count = abs(count) items follow a long byte-count;
//             block sequence ends with count=0
//   map     : same as array but each item is string key + value
//   union   : long (branch index) + value encoded per branch schema
//   fixed   : exactly N raw bytes
//
// Object Container File (OCF):
//   Magic: 4 bytes  "Obj\x01"
//   Metadata: map<string,bytes> (must include "avro.schema" and optionally "avro.codec")
//   Sync marker: 16 random bytes
//   Data blocks: long (obj count) + long (byte count) + bytes + sync marker
//
// Schema fingerprint:
//   Rabin fingerprint (64-bit) as per the Avro spec for schema canonicalization.

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_BYTES   = 50 * 1024 * 1024; // 50 MB
const MAX_DEPTH        = 64;               // recursion guard
const MAX_ELEMENTS     = 1_000_000;        // array/map element limit
const MAX_STRING_BYTES = 64 * 1024 * 1024; // 64 MB string/bytes field cap

// ── ZigZag VarInt encoding (same as protobuf sint32/sint64) ──────────────────

function encodeZigzagInt(n) {
  const v = (n | 0);
  const z = ((v << 1) ^ (v >> 31)) >>> 0;
  return encodeVarUint32(z);
}

function encodeVarUint32(u) {
  const parts = [];
  let v = u >>> 0;
  do {
    let byte = v & 0x7F;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    parts.push(byte);
  } while (v !== 0);
  return Buffer.from(parts);
}

function encodeZigzagLong(n) {
  let v;
  if (typeof n === "bigint") {
    v = BigInt.asIntN(64, n);
  } else {
    v = BigInt(Math.trunc(n));
  }
  const z = ((v << 1n) ^ (v >> 63n)) & 0xFFFFFFFFFFFFFFFFn;
  return encodeVarUint64(z);
}

function encodeVarUint64(u) {
  const parts = [];
  let v = BigInt.asUintN(64, u);
  do {
    let byte = Number(v & 0x7Fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    parts.push(byte);
  } while (v !== 0n);
  return Buffer.from(parts);
}

// ── AvroReader class ──────────────────────────────────────────────────────────

class AvroReader {
  constructor(buf) {
    this.buf  = buf;
    this.pos  = 0;
    this._elements = 0;
  }

  remaining() { return this.buf.length - this.pos; }

  readByte() {
    if (this.pos >= this.buf.length)
      throw new ToolError(
        "avro_client decode: unexpected end of data at offset " + this.pos + ".",
        -32602
      );
    return this.buf[this.pos++];
  }

  readBytes(n) {
    if (n < 0 || this.pos + n > this.buf.length)
      throw new ToolError(
        "avro_client decode: unexpected end of data reading " + n +
        " bytes at offset " + this.pos + ".",
        -32602
      );
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  trackElement() {
    this._elements++;
    if (this._elements > MAX_ELEMENTS)
      throw new ToolError(
        "avro_client decode: element count limit exceeded (" + MAX_ELEMENTS + ").",
        -32602
      );
  }

  readLong() {
    let result = 0n;
    let shift  = 0n;
    for (;;) {
      const byte = this.readByte();
      result |= BigInt(byte & 0x7F) << shift;
      shift  += 7n;
      if (!(byte & 0x80)) break;
      if (shift > 70n)
        throw new ToolError(
          "avro_client decode: varint overflow at offset " + this.pos + ".",
          -32602
        );
    }
    // zigzag decode: (n >>> 1) ^ -(n & 1)
    return (result >> 1n) ^ -(result & 1n);
  }

  readInt() {
    const v = this.readLong();
    return Number(BigInt.asIntN(32, v));
  }

  readFloat() {
    const b = this.readBytes(4);
    return b.readFloatLE(0);
  }

  readDouble() {
    const b = this.readBytes(8);
    return b.readDoubleLE(0);
  }

  readBoolean() {
    const b = this.readByte();
    return b !== 0;
  }

  readString() {
    const len = this.readLong();
    const lenN = Number(len);
    if (lenN < 0)
      throw new ToolError(
        "avro_client decode: negative string length at offset " + this.pos + ".",
        -32602
      );
    if (lenN > MAX_STRING_BYTES)
      throw new ToolError(
        "avro_client decode: string/bytes field too large (" + lenN + " bytes).",
        -32602
      );
    return this.readBytes(lenN).toString("utf8");
  }

  readBytesField() {
    const len = this.readLong();
    const lenN = Number(len);
    if (lenN < 0)
      throw new ToolError(
        "avro_client decode: negative bytes length at offset " + this.pos + ".",
        -32602
      );
    if (lenN > MAX_STRING_BYTES)
      throw new ToolError(
        "avro_client decode: bytes field too large (" + lenN + " bytes).",
        -32602
      );
    return this.readBytes(lenN);
  }
}

// ── Schema normalization & resolution ────────────────────────────────────────

function normalizeSchema(schema) {
  if (typeof schema === "string") {
    return { type: schema };
  }
  if (Array.isArray(schema)) {
    return { type: "union", branches: schema.map(normalizeSchema) };
  }
  if (typeof schema === "object" && schema !== null) {
    if (!schema.type)
      throw new ToolError("avro_client: schema object missing 'type' field.", -32602);
    return schema;
  }
  throw new ToolError("avro_client: invalid schema value: " + JSON.stringify(schema), -32602);
}

// ── Encoder ───────────────────────────────────────────────────────────────────

function encodeValue(value, schema, depth) {
  if (depth > MAX_DEPTH)
    throw new ToolError("avro_client encode: nesting depth exceeds limit (" + MAX_DEPTH + ").", -32602);

  const s = normalizeSchema(schema);
  const t = s.type;

  if (t === "union") {
    return encodeUnion(value, s.branches, depth);
  }

  switch (t) {
    case "null":
      if (value !== null && value !== undefined)
        throw new ToolError("avro_client encode: expected null for 'null' type, got: " + JSON.stringify(value), -32602);
      return Buffer.alloc(0);

    case "boolean":
      return Buffer.from([value ? 0x01 : 0x00]);

    case "int": {
      const n = typeof value === "bigint" ? Number(value) : Math.trunc(Number(value));
      if (n < -2147483648 || n > 2147483647)
        throw new ToolError("avro_client encode: int value out of range: " + n, -32602);
      return encodeZigzagInt(n);
    }

    case "long": {
      return encodeZigzagLong(value);
    }

    case "float": {
      const b = Buffer.alloc(4);
      b.writeFloatLE(Number(value), 0);
      return b;
    }

    case "double": {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(Number(value), 0);
      return b;
    }

    case "bytes": {
      let buf;
      if (Buffer.isBuffer(value))         buf = value;
      else if (typeof value === "string") buf = Buffer.from(value, "base64");
      else throw new ToolError("avro_client encode: 'bytes' requires a Buffer or base64 string.", -32602);
      return Buffer.concat([encodeZigzagLong(buf.length), buf]);
    }

    case "string": {
      const utf8 = Buffer.from(String(value), "utf8");
      return Buffer.concat([encodeZigzagLong(utf8.length), utf8]);
    }

    case "record":
      return encodeRecord(value, s, depth);

    case "enum":
      return encodeEnum(value, s);

    case "array":
      return encodeArray(value, s, depth);

    case "map":
      return encodeMap(value, s, depth);

    case "fixed":
      return encodeFixed(value, s);

    default:
      throw new ToolError("avro_client encode: unsupported type '" + t + "'.", -32602);
  }
}

function encodeRecord(obj, schema, depth) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw new ToolError("avro_client encode: record value must be an object.", -32602);
  if (!Array.isArray(schema.fields))
    throw new ToolError("avro_client encode: record schema must have 'fields' array.", -32602);

  const parts = [];
  for (const field of schema.fields) {
    const fname = field.name;
    if (!(fname in obj)) {
      if ("default" in field) {
        parts.push(encodeValue(field.default, field.type, depth + 1));
      } else {
        throw new ToolError("avro_client encode: missing required record field '" + fname + "'.", -32602);
      }
    } else {
      parts.push(encodeValue(obj[fname], field.type, depth + 1));
    }
  }
  return Buffer.concat(parts);
}

function encodeEnum(value, schema) {
  if (!Array.isArray(schema.symbols))
    throw new ToolError("avro_client encode: enum schema must have 'symbols' array.", -32602);
  let idx;
  if (typeof value === "number") {
    idx = value;
    if (idx < 0 || idx >= schema.symbols.length)
      throw new ToolError("avro_client encode: enum index " + idx + " out of range [0," + (schema.symbols.length - 1) + "].", -32602);
  } else if (typeof value === "string") {
    idx = schema.symbols.indexOf(value);
    if (idx === -1)
      throw new ToolError("avro_client encode: enum symbol '" + value + "' not found in [" + schema.symbols.join(", ") + "].", -32602);
  } else {
    throw new ToolError("avro_client encode: enum value must be a string symbol or integer index.", -32602);
  }
  return encodeZigzagInt(idx);
}

function encodeArray(items, schema, depth) {
  if (!Array.isArray(items))
    throw new ToolError("avro_client encode: array value must be a JS array.", -32602);
  if (!schema.items)
    throw new ToolError("avro_client encode: array schema must have 'items' field.", -32602);

  if (items.length === 0) return Buffer.from([0x00]);

  const parts = [];
  parts.push(encodeZigzagLong(items.length));
  for (const item of items) {
    parts.push(encodeValue(item, schema.items, depth + 1));
  }
  parts.push(Buffer.from([0x00]));
  return Buffer.concat(parts);
}

function encodeMap(obj, schema, depth) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw new ToolError("avro_client encode: map value must be an object (key->value pairs).", -32602);
  if (!schema.values)
    throw new ToolError("avro_client encode: map schema must have 'values' field.", -32602);

  const entries = Object.entries(obj);
  if (entries.length === 0) return Buffer.from([0x00]);

  const parts = [];
  parts.push(encodeZigzagLong(entries.length));
  for (const [key, val] of entries) {
    const keyBuf = Buffer.from(String(key), "utf8");
    parts.push(encodeZigzagLong(keyBuf.length), keyBuf);
    parts.push(encodeValue(val, schema.values, depth + 1));
  }
  parts.push(Buffer.from([0x00]));
  return Buffer.concat(parts);
}

function encodeFixed(value, schema) {
  const size = schema.size;
  if (!Number.isInteger(size) || size <= 0)
    throw new ToolError("avro_client encode: fixed schema must have positive integer 'size'.", -32602);
  let buf;
  if (Buffer.isBuffer(value))         buf = value;
  else if (typeof value === "string") buf = Buffer.from(value, "base64");
  else throw new ToolError("avro_client encode: fixed requires a Buffer or base64 string.", -32602);
  if (buf.length !== size)
    throw new ToolError("avro_client encode: fixed size mismatch — expected " + size + " bytes, got " + buf.length + ".", -32602);
  return buf;
}

function encodeUnion(value, branches, depth) {
  if (value !== null && typeof value === "object" && "__avro_union" in value) {
    const u = value.__avro_union;
    const idx = u.index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= branches.length)
      throw new ToolError("avro_client encode: union __avro_union.index " + idx + " out of range.", -32602);
    return Buffer.concat([encodeZigzagLong(idx), encodeValue(u.value, branches[idx], depth + 1)]);
  }

  const idx = inferUnionBranch(value, branches);
  return Buffer.concat([encodeZigzagLong(idx), encodeValue(value, branches[idx], depth + 1)]);
}

function inferUnionBranch(value, branches) {
  for (let i = 0; i < branches.length; i++) {
    const s = normalizeSchema(branches[i]);
    const t = s.type;
    if (value === null && t === "null") return i;
    if (typeof value === "boolean" && t === "boolean") return i;
    if (typeof value === "number" && Number.isInteger(value) && (t === "int" || t === "long")) return i;
    if (typeof value === "number" && !Number.isInteger(value) && (t === "float" || t === "double")) return i;
    if (typeof value === "bigint" && (t === "long" || t === "int")) return i;
    if (typeof value === "string" && t === "string") return i;
    if (Buffer.isBuffer(value) && t === "bytes") return i;
    if (typeof value === "string" && t === "bytes") return i;
    if (Array.isArray(value) && t === "array") return i;
    if (typeof value === "object" && value !== null && !Array.isArray(value) &&
        (t === "record" || t === "map")) return i;
  }
  throw new ToolError(
    "avro_client encode: cannot infer union branch for value type '" +
    (value === null ? "null" : typeof value) + "'. " +
    "Use { \"__avro_union\": { \"index\": N, \"value\": V } } to specify branch explicitly.",
    -32602
  );
}

// ── Decoder ───────────────────────────────────────────────────────────────────

function decodeValue(reader, schema, depth) {
  if (depth > MAX_DEPTH)
    throw new ToolError("avro_client decode: nesting depth exceeds limit (" + MAX_DEPTH + ").", -32602);

  const s = normalizeSchema(schema);
  const t = s.type;

  if (t === "union") {
    return decodeUnion(reader, s.branches, depth);
  }

  switch (t) {
    case "null":     return null;
    case "boolean":  return reader.readBoolean();
    case "int":      return reader.readInt();
    case "long": {
      const v = reader.readLong();
      if (v >= BigInt(-Number.MAX_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER))
        return Number(v);
      return { __long: v.toString() };
    }
    case "float":    return reader.readFloat();
    case "double":   return reader.readDouble();
    case "bytes": {
      const buf = reader.readBytesField();
      return { __bytes: buf.toString("base64"), length: buf.length };
    }
    case "string":   return reader.readString();
    case "record":   return decodeRecord(reader, s, depth);
    case "enum":     return decodeEnum(reader, s);
    case "array":    return decodeArray(reader, s, depth);
    case "map":      return decodeMap(reader, s, depth);
    case "fixed":    return decodeFixed(reader, s);
    default:
      throw new ToolError("avro_client decode: unsupported type '" + t + "'.", -32602);
  }
}

function decodeRecord(reader, schema, depth) {
  if (!Array.isArray(schema.fields))
    throw new ToolError("avro_client decode: record schema must have 'fields' array.", -32602);
  const result = Object.create(null);
  for (const field of schema.fields) {
    reader.trackElement();
    result[field.name] = decodeValue(reader, field.type, depth + 1);
  }
  return result;
}

function decodeEnum(reader, schema) {
  if (!Array.isArray(schema.symbols))
    throw new ToolError("avro_client decode: enum schema must have 'symbols' array.", -32602);
  const idx = reader.readInt();
  if (idx < 0 || idx >= schema.symbols.length)
    throw new ToolError("avro_client decode: enum index " + idx + " out of range.", -32602);
  return schema.symbols[idx];
}

function decodeArray(reader, schema, depth) {
  if (!schema.items)
    throw new ToolError("avro_client decode: array schema must have 'items' field.", -32602);
  const result = [];
  for (;;) {
    let count = reader.readLong();
    const countN = Number(count < 0n ? -count : count);
    if (count === 0n) break;
    if (count < 0n) reader.readLong(); // skip byte count
    for (let i = 0; i < countN; i++) {
      reader.trackElement();
      result.push(decodeValue(reader, schema.items, depth + 1));
    }
  }
  return result;
}

function decodeMap(reader, schema, depth) {
  if (!schema.values)
    throw new ToolError("avro_client decode: map schema must have 'values' field.", -32602);
  const result = Object.create(null);
  for (;;) {
    let count = reader.readLong();
    const countN = Number(count < 0n ? -count : count);
    if (count === 0n) break;
    if (count < 0n) reader.readLong();
    for (let i = 0; i < countN; i++) {
      reader.trackElement();
      const key = reader.readString();
      result[key] = decodeValue(reader, schema.values, depth + 1);
    }
  }
  return result;
}

function decodeFixed(reader, schema) {
  const size = schema.size;
  if (!Number.isInteger(size) || size <= 0)
    throw new ToolError("avro_client decode: fixed schema must have positive integer 'size'.", -32602);
  const buf = reader.readBytes(size);
  return { __fixed: buf.toString("base64"), size };
}

function decodeUnion(reader, branches, depth) {
  const idx = reader.readLong();
  const idxN = Number(idx);
  if (idxN < 0 || idxN >= branches.length)
    throw new ToolError("avro_client decode: union branch index " + idxN + " out of range [0," + (branches.length - 1) + "].", -32602);
  const value = decodeValue(reader, branches[idxN], depth + 1);
  const branchSchema = normalizeSchema(branches[idxN]);
  if (branchSchema.type === "null") return null;
  return { __avro_branch: idxN, value };
}

// ── OCF (Object Container File) ───────────────────────────────────────────────

const OCF_MAGIC = Buffer.from([0x4F, 0x62, 0x6A, 0x01]); // "Obj\x01"

function generateSyncMarker() {
  try {
    const crypto = require("crypto");
    const buf = Buffer.alloc(16);
    crypto.randomFillSync(buf);
    return buf;
  } catch (_) {
    const buf = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
    return buf;
  }
}

function encodeOcfMetadata(metadata) {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return Buffer.from([0x00]);
  const parts = [];
  parts.push(encodeZigzagLong(entries.length));
  for (const [key, val] of entries) {
    const keyBuf = Buffer.from(key, "utf8");
    parts.push(encodeZigzagLong(keyBuf.length), keyBuf);
    const valBuf = Buffer.isBuffer(val) ? val : Buffer.from(String(val), "utf8");
    parts.push(encodeZigzagLong(valBuf.length), valBuf);
  }
  parts.push(Buffer.from([0x00]));
  return Buffer.concat(parts);
}

function buildOcf(records, schema, syncMarker) {
  const schemaJson = JSON.stringify(schema);
  const metadata = {
    "avro.schema": Buffer.from(schemaJson, "utf8"),
    "avro.codec":  Buffer.from("null", "utf8"),
  };

  const header = Buffer.concat([
    OCF_MAGIC,
    encodeOcfMetadata(metadata),
    syncMarker,
  ]);

  const encoded = records.map(r => encodeValue(r, schema, 0));
  const blockData = Buffer.concat(encoded);

  const block = Buffer.concat([
    encodeZigzagLong(records.length),
    encodeZigzagLong(blockData.length),
    blockData,
    syncMarker,
  ]);

  return Buffer.concat([header, block, Buffer.from([0x00])]);
}

function parseOcfMetadata(reader) {
  const metadata = Object.create(null);
  for (;;) {
    const count = reader.readLong();
    const absCount = count < 0n ? -count : count;
    const n = Number(absCount);
    if (count < 0n) reader.readLong();
    if (n === 0) break;
    for (let i = 0; i < n; i++) {
      const key = reader.readString();
      const valBuf = reader.readBytesField();
      metadata[key] = valBuf;
    }
  }
  return metadata;
}

function readOcf(buf) {
  const reader = new AvroReader(buf);

  const magic = reader.readBytes(4);
  if (!magic.equals(OCF_MAGIC))
    throw new ToolError(
      "avro_client: not an Avro OCF file — expected magic 'Obj\\x01', got: 0x" +
      magic.toString("hex") + ".",
      -32602
    );

  const metadata = parseOcfMetadata(reader);

  const schemaBuf = metadata["avro.schema"];
  if (!schemaBuf)
    throw new ToolError("avro_client: OCF file missing 'avro.schema' metadata.", -32602);
  let schema;
  try {
    schema = JSON.parse(schemaBuf.toString("utf8"));
  } catch (e) {
    throw new ToolError("avro_client: failed to parse OCF avro.schema: " + e.message, -32602);
  }

  const syncMarker = reader.readBytes(16);

  const codec = metadata["avro.codec"] ? metadata["avro.codec"].toString("utf8") : "null";
  if (codec !== "null" && codec !== "deflate")
    throw new ToolError("avro_client: unsupported OCF codec '" + codec + "'. Only 'null' and 'deflate' are supported.", -32602);

  const records = [];
  let blockCount = 0;

  while (reader.remaining() > 0) {
    let objCount;
    try {
      objCount = reader.readLong();
    } catch (_) { break; }

    const objCountN = Number(objCount);
    if (objCountN === 0) break;

    const byteCount = reader.readLong();
    const byteCountN = Number(byteCount);
    const blockBytes = reader.readBytes(byteCountN);

    const syncCheck = reader.readBytes(16);
    if (!syncCheck.equals(syncMarker))
      throw new ToolError(
        "avro_client: OCF sync marker mismatch at block " + blockCount + ". File may be corrupt.",
        -32602
      );

    let decodeBytes;
    if (codec === "deflate") {
      try {
        const zlib = require("zlib");
        decodeBytes = zlib.inflateRawSync(blockBytes);
      } catch (e) {
        throw new ToolError("avro_client: failed to decompress deflate block: " + e.message, -32602);
      }
    } else {
      decodeBytes = blockBytes;
    }

    const blockReader = new AvroReader(decodeBytes);
    for (let i = 0; i < objCountN; i++) {
      blockReader.trackElement();
      records.push(decodeValue(blockReader, schema, 0));
    }
    blockCount++;
  }

  return { schema, records, blockCount, syncMarker: syncMarker.toString("hex"), metadata };
}

// ── Schema Fingerprint (Rabin, 64-bit) ───────────────────────────────────────

const RABIN_EMPTY = 0xC15D213AA4D7A795n;

function buildRabinTable() {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let fp = BigInt(i);
    for (let j = 0; j < 8; j++) {
      const lsb = fp & 1n;
      fp >>= 1n;
      if (lsb) fp ^= 0xC96C5795D7870F42n;
    }
    table[i] = fp;
  }
  return table;
}

const RABIN_TABLE = buildRabinTable();

function rabinFingerprint(data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let fp = RABIN_EMPTY;
  for (let i = 0; i < buf.length; i++) {
    fp = (fp >> 8n) ^ RABIN_TABLE[Number(fp & 0xFFn) ^ buf[i]];
  }
  return BigInt.asUintN(64, fp);
}

function canonicalSchema(schema) {
  if (typeof schema === "string") return JSON.stringify(schema);
  if (Array.isArray(schema)) {
    return "[" + schema.map(canonicalSchema).join(",") + "]";
  }
  if (typeof schema !== "object" || schema === null)
    return JSON.stringify(schema);
  const t = schema.type;
  if (["null","boolean","int","long","float","double","bytes","string"].includes(t)) {
    return JSON.stringify(t);
  }
  if (t === "record") {
    const fields = (schema.fields || []).map(f =>
      '{"name":' + JSON.stringify(f.name) + ',"type":' + canonicalSchema(f.type) + '}'
    );
    return '{"name":' + JSON.stringify(schema.name || "") + ',"type":"record","fields":[' + fields.join(",") + ']}';
  }
  if (t === "enum") {
    const syms = (schema.symbols || []).map(sym => JSON.stringify(sym)).join(",");
    return '{"name":' + JSON.stringify(schema.name || "") + ',"type":"enum","symbols":[' + syms + ']}';
  }
  if (t === "array") {
    return '{"type":"array","items":' + canonicalSchema(schema.items) + '}';
  }
  if (t === "map") {
    return '{"type":"map","values":' + canonicalSchema(schema.values) + '}';
  }
  if (t === "fixed") {
    return '{"name":' + JSON.stringify(schema.name || "") + ',"type":"fixed","size":' + (schema.size || 0) + '}';
  }
  return JSON.stringify(schema);
}

// ── Path / file helpers ───────────────────────────────────────────────────────

function validatePath(p, op) {
  if (!p || p.includes("\0"))
    throw new ToolError("avro_client " + op + ": path contains NUL byte.", -32602);
}

function validateFileSize(absPath, op) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory())
    throw new ToolError("avro_client " + op + ": path is a directory.", -32602);
  if (stat.size > MAX_FILE_BYTES)
    throw new ToolError(
      "avro_client " + op + ": file too large (" + stat.size + " bytes; max " + MAX_FILE_BYTES + ").",
      -32602
    );
}

function resolveBuf(args, op, resolveClientPath) {
  if (args.input_file) {
    validatePath(args.input_file, op);
    const { resolved } = resolveClientPath(args.input_file);
    validateFileSize(resolved, op);
    return fs.readFileSync(resolved);
  } else if (args.hex !== undefined) {
    if (args.hex === "")
      throw new ToolError("avro_client " + op + ": 'hex' input is empty.", -32602);
    const hexStr = args.hex.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hexStr) || hexStr.length % 2 !== 0)
      throw new ToolError("avro_client " + op + ": 'hex' must be a valid even-length hex string.", -32602);
    return Buffer.from(hexStr, "hex");
  } else if (args.base64 !== undefined) {
    if (args.base64 === "")
      throw new ToolError("avro_client " + op + ": 'base64' input is empty.", -32602);
    return Buffer.from(args.base64, "base64");
  } else {
    throw new ToolError(
      "avro_client " + op + ": 'input_file', 'hex', or 'base64' is required.",
      -32602
    );
  }
}

function parseSchemaArg(args, op) {
  if (!args.schema)
    throw new ToolError("avro_client " + op + ": 'schema' is required.", -32602);
  let s = args.schema;
  if (typeof s === "string") {
    try { s = JSON.parse(s); } catch (_) {
      if (["null","boolean","int","long","float","double","bytes","string"].includes(s))
        return s;
      throw new ToolError("avro_client " + op + ": 'schema' is not valid JSON.", -32602);
    }
  }
  return s;
}

// ── Operations ────────────────────────────────────────────────────────────────

function opEncode(args, resolveClientPath) {
  const schema = parseSchemaArg(args, "encode");

  let value;
  if (args.json_file) {
    validatePath(args.json_file, "encode");
    const { resolved } = resolveClientPath(args.json_file);
    validateFileSize(resolved, "encode");
    try { value = JSON.parse(fs.readFileSync(resolved, "utf8")); }
    catch (e) { throw new ToolError("avro_client encode: json_file is not valid JSON — " + e.message, -32602); }
  } else if (args.value !== undefined) {
    value = args.value;
  } else {
    throw new ToolError("avro_client encode: 'value' or 'json_file' is required.", -32602);
  }

  const encoded = encodeValue(value, schema, 0);

  if (args.output_file) {
    validatePath(args.output_file, "encode");
    const { resolved: absOut } = resolveClientPath(args.output_file);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, encoded);
    return {
      operation:  "encode",
      outputFile: args.output_file,
      sizeBytes:  encoded.length,
      hex:        args.include_hex    ? encoded.toString("hex")    : undefined,
      base64:     args.include_base64 ? encoded.toString("base64") : undefined,
    };
  }

  return {
    operation: "encode",
    sizeBytes: encoded.length,
    hex:       encoded.toString("hex"),
    base64:    encoded.toString("base64"),
  };
}

function opDecode(args, resolveClientPath) {
  const schema = parseSchemaArg(args, "decode");
  const buf = resolveBuf(args, "decode", resolveClientPath);
  if (buf.length === 0)
    throw new ToolError("avro_client decode: input is empty.", -32602);

  const reader = new AvroReader(buf);
  const decoded = decodeValue(reader, schema, 0);

  const result = { operation: "decode", inputBytes: buf.length, value: decoded };
  if (reader.pos < buf.length) {
    result.warning = (buf.length - reader.pos) + " trailing bytes not consumed.";
    result.trailingBytes = buf.length - reader.pos;
  }
  return result;
}

function opEncodeFile(args, resolveClientPath) {
  if (!args.path)   throw new ToolError("avro_client encode_file: 'path' (JSON input) is required.", -32602);
  if (!args.output) throw new ToolError("avro_client encode_file: 'output' is required.", -32602);

  validatePath(args.path,   "encode_file");
  validatePath(args.output, "encode_file");
  const { resolved: absIn  } = resolveClientPath(args.path);
  const { resolved: absOut } = resolveClientPath(args.output);
  validateFileSize(absIn, "encode_file");

  const schema = parseSchemaArg(args, "encode_file");

  let value;
  try { value = JSON.parse(fs.readFileSync(absIn, "utf8")); }
  catch (e) { throw new ToolError("avro_client encode_file: input is not valid JSON — " + e.message, -32602); }

  const isRecord = typeof schema === "object" && schema !== null && schema.type === "record";
  const isArray  = Array.isArray(value);

  let outputBuf;
  if (isRecord && isArray) {
    const syncMarker = generateSyncMarker();
    outputBuf = buildOcf(value, schema, syncMarker);
  } else {
    outputBuf = encodeValue(value, schema, 0);
  }

  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, outputBuf);

  const inputBytes  = fs.statSync(absIn).size;
  const outputBytes = outputBuf.length;
  return {
    operation:   "encode_file",
    inputPath:   args.path,
    outputPath:  args.output,
    inputBytes,
    outputBytes,
    format:      (isRecord && isArray) ? "ocf" : "binary",
    ratio:       (outputBytes / Math.max(inputBytes, 1)).toFixed(3),
  };
}

function opDecodeFile(args, resolveClientPath) {
  if (!args.path) throw new ToolError("avro_client decode_file: 'path' is required.", -32602);

  validatePath(args.path, "decode_file");
  const { resolved: absIn } = resolveClientPath(args.path);
  validateFileSize(absIn, "decode_file");

  const buf = fs.readFileSync(absIn);
  if (buf.length === 0)
    throw new ToolError("avro_client decode_file: input file is empty.", -32602);

  let decoded;
  let schema = null;
  let format = "binary";

  if (buf.length >= 4 && buf.slice(0, 4).equals(OCF_MAGIC)) {
    const ocfResult = readOcf(buf);
    schema  = ocfResult.schema;
    decoded = ocfResult.records;
    format  = "ocf";
  } else {
    schema = parseSchemaArg(args, "decode_file");
    const reader = new AvroReader(buf);
    decoded = decodeValue(reader, schema, 0);
  }

  const jsonStr = JSON.stringify(decoded, null, args.pretty ? 2 : undefined);

  if (args.output) {
    validatePath(args.output, "decode_file");
    const { resolved: absOut } = resolveClientPath(args.output);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, jsonStr, "utf8");
    return {
      operation:   "decode_file",
      inputPath:   args.path,
      outputPath:  args.output,
      inputBytes:  buf.length,
      outputBytes: Buffer.byteLength(jsonStr, "utf8"),
      format,
      schema,
    };
  }

  return {
    operation:  "decode_file",
    inputPath:  args.path,
    inputBytes: buf.length,
    format,
    schema,
    value: decoded,
  };
}

function opInspect(args, resolveClientPath) {
  const buf = resolveBuf(args, "inspect", resolveClientPath);
  if (buf.length === 0)
    throw new ToolError("avro_client inspect: input is empty.", -32602);

  if (buf.length >= 4 && buf.slice(0, 4).equals(OCF_MAGIC)) {
    const { schema, records, blockCount, syncMarker } = readOcf(buf);
    return {
      operation:    "inspect",
      format:       "ocf",
      totalBytes:   buf.length,
      schema,
      blockCount,
      recordCount:  records.length,
      syncMarker,
      sampleRecord: records.length > 0 ? records[0] : null,
    };
  }

  if (args.schema) {
    const schema = parseSchemaArg(args, "inspect");
    const reader = new AvroReader(buf);
    const decoded = decodeValue(reader, schema, 0);
    return {
      operation:     "inspect",
      format:        "binary",
      totalBytes:    buf.length,
      schema,
      bytesConsumed: reader.pos,
      trailingBytes: buf.length - reader.pos,
      value:         decoded,
    };
  }

  // No schema: raw varint layout
  const reader = new AvroReader(buf);
  const entries = [];
  let count = 0;
  while (reader.remaining() > 0 && count < 50) {
    const startPos = reader.pos;
    try {
      const v = reader.readLong();
      entries.push({
        offset:     startPos,
        bytes:      reader.pos - startPos,
        zigzagLong: Number(v >= BigInt(-Number.MAX_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? v : v),
        hex:        buf.slice(startPos, reader.pos).toString("hex"),
      });
    } catch (_) { break; }
    count++;
  }

  return {
    operation:  "inspect",
    format:     "binary_raw",
    totalBytes: buf.length,
    note:       "Provide 'schema' for structured decode. Showing raw zigzag varint layout.",
    layout:     entries,
  };
}

function opSchemaFingerprint(args) {
  let schema = args.schema;
  if (!schema)
    throw new ToolError("avro_client schema_fingerprint: 'schema' is required.", -32602);
  if (typeof schema === "string") {
    try { schema = JSON.parse(schema); } catch (_) { /* primitive type name */ }
  }

  const canonical = canonicalSchema(schema);
  const fp = rabinFingerprint(canonical);
  const fpHex = fp.toString(16).padStart(16, "0");

  return {
    operation:         "schema_fingerprint",
    canonicalForm:     canonical,
    fingerprint_hex:   fpHex,
    fingerprint_int64: fp.toString(),
    algorithm:         "Rabin-64",
  };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

function avroClient(args, resolveClientPath) {
  const op = args.operation;
  if (!op) throw new ToolError("avro_client: 'operation' is required.", -32602);

  const VALID_OPS = ["encode", "decode", "encode_file", "decode_file", "inspect", "schema_fingerprint"];
  if (!VALID_OPS.includes(op))
    throw new ToolError(
      "avro_client: unknown operation '" + op + "'. Valid: " + VALID_OPS.join(", ") + ".",
      -32602
    );

  switch (op) {
    case "encode":             return opEncode(args, resolveClientPath);
    case "decode":             return opDecode(args, resolveClientPath);
    case "encode_file":        return opEncodeFile(args, resolveClientPath);
    case "decode_file":        return opDecodeFile(args, resolveClientPath);
    case "inspect":            return opInspect(args, resolveClientPath);
    case "schema_fingerprint": return opSchemaFingerprint(args);
  }
}

module.exports = {
  avroClient,
  encodeValue,
  decodeValue,
  buildOcf,
  readOcf,
  rabinFingerprint,
  canonicalSchema,
  AvroReader,
  encodeZigzagInt,
  encodeZigzagLong,
};
