"use strict";
// lib/thriftClientOps.js
// Zero-dependency Apache Thrift binary & compact protocol encoder/decoder.
// Pure Node.js — no npm deps.
//
// Supports:
//   Binary protocol  (protocol: "binary", default)
//   Compact protocol (protocol: "compact")
//
// Thrift type system:
//   BOOL(2), BYTE/I8(3), DOUBLE(4), I16(6), I32(8), I64(10),
//   STRING/BINARY(11), STRUCT(12), MAP(13), SET(14), LIST(15),
//   UUID(16, compact only)
//
// Operations:
//   encode        — encode a JS value with a schema → hex+base64 or file
//   decode        — decode Thrift binary hex/base64/file → JS value
//   encode_file   — JSON file + schema → Thrift binary file
//   decode_file   — Thrift binary file → JSON value or file
//   inspect       — show wire-level field layout without full schema
//
// Security:
//   50 MB file cap; 64-level nesting depth limit; 1,000,000 element limit;
//   NUL-byte path guard; directory path rejected.

const fs   = require("fs");
const path = require("path");

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE  = 50 * 1024 * 1024; // 50 MB
const MAX_DEPTH      = 64;
const MAX_ELEMENTS   = 1_000_000;

// Thrift type IDs (shared across binary and compact protocols)
const T_STOP   = 0;
const T_VOID   = 1;
const T_BOOL   = 2;
const T_BYTE   = 3;
const T_DOUBLE = 4;
const T_I16    = 6;
const T_I32    = 8;
const T_I64    = 10;
const T_STRING = 11;
const T_STRUCT = 12;
const T_MAP    = 13;
const T_SET    = 14;
const T_LIST   = 15;
const T_UUID   = 16;

const TYPE_NAMES = {
  [T_STOP]:   "STOP",
  [T_VOID]:   "VOID",
  [T_BOOL]:   "BOOL",
  [T_BYTE]:   "BYTE",
  [T_DOUBLE]: "DOUBLE",
  [T_I16]:    "I16",
  [T_I32]:    "I32",
  [T_I64]:    "I64",
  [T_STRING]: "STRING",
  [T_STRUCT]: "STRUCT",
  [T_MAP]:    "MAP",
  [T_SET]:    "SET",
  [T_LIST]:   "LIST",
  [T_UUID]:   "UUID",
};

// Compact protocol type IDs → Thrift type IDs mapping
const COMPACT_TO_THRIFT = {
  1:  T_BOOL,   // BOOLEAN_TRUE
  2:  T_BOOL,   // BOOLEAN_FALSE
  3:  T_BYTE,
  4:  T_I16,
  5:  T_I32,
  6:  T_I64,
  7:  T_DOUBLE,
  8:  T_STRING,
  9:  T_LIST,
  10: T_SET,
  11: T_MAP,
  12: T_STRUCT,
  13: T_UUID,
};
const THRIFT_TO_COMPACT = {
  [T_BOOL]:   1,
  [T_BYTE]:   3,
  [T_I16]:    4,
  [T_I32]:    5,
  [T_I64]:    6,
  [T_DOUBLE]: 7,
  [T_STRING]: 8,
  [T_LIST]:   9,
  [T_SET]:    10,
  [T_MAP]:    11,
  [T_STRUCT]: 12,
  [T_UUID]:   13,
};

// ── Error ────────────────────────────────────────────────────────────────────

class ThriftError extends Error {
  constructor(msg) { super(msg); this.name = "ThriftError"; }
}

// ── Path guard ───────────────────────────────────────────────────────────────

function guardPath(p) {
  if (typeof p !== "string" || p.length === 0)
    throw new ThriftError("Path must be a non-empty string.");
  if (p.includes("\x00"))
    throw new ThriftError("Path must not contain NUL bytes.");
}

function readFileSafe(p) {
  guardPath(p);
  const stat = fs.statSync(p);
  if (stat.isDirectory())
    throw new ThriftError(`Path is a directory: ${p}`);
  if (stat.size > MAX_FILE_SIZE)
    throw new ThriftError(`File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE}).`);
  return fs.readFileSync(p);
}

// ── Buffer writer ────────────────────────────────────────────────────────────

class BufWriter {
  constructor() { this._chunks = []; this._len = 0; }
  push(buf) { this._chunks.push(buf); this._len += buf.length; }
  writeByte(v) { const b = Buffer.allocUnsafe(1); b[0] = v & 0xff; this.push(b); }
  toBuffer() { return Buffer.concat(this._chunks, this._len); }
}

// ── Buffer reader ────────────────────────────────────────────────────────────

class BufReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  remaining() { return this.buf.length - this.pos; }
  readByte() {
    if (this.pos >= this.buf.length) throw new ThriftError("Unexpected end of data (readByte).");
    return this.buf[this.pos++];
  }
  readBytes(n) {
    if (this.pos + n > this.buf.length)
      throw new ThriftError(`Unexpected end of data: need ${n} bytes, have ${this.buf.length - this.pos}.`);
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
  readInt16BE() {
    const b = this.readBytes(2);
    return b.readInt16BE(0);
  }
  readInt32BE() {
    const b = this.readBytes(4);
    return b.readInt32BE(0);
  }
  readInt64BE() {
    const b = this.readBytes(8);
    const hi = b.readInt32BE(0);
    const lo = b.readUInt32BE(4);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  readDoubleBE() {
    const b = this.readBytes(8);
    return b.readDoubleBE(0);
  }
}

// ── VarInt (compact protocol) ─────────────────────────────────────────────────

function writeVarI32(w, v) {
  v = v >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) { w.writeByte(v); return; }
    w.writeByte((v & 0x7f) | 0x80);
    v = v >>> 7;
  }
}

function writeVarI64(w, v) {
  let uv = BigInt.asUintN(64, v);
  for (let i = 0; i < 10; i++) {
    if (uv <= 0x7fn) { w.writeByte(Number(uv)); return; }
    w.writeByte(Number(uv & 0x7fn) | 0x80);
    uv >>= 7n;
  }
}

function readVarI32(r) {
  let result = 0, shift = 0;
  for (let i = 0; i < 5; i++) {
    const b = r.readByte();
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return result | 0;
    shift += 7;
  }
  throw new ThriftError("Malformed varint (> 5 bytes for I32).");
}

function readVarI64(r) {
  let result = 0n, shift = 0n;
  for (let i = 0; i < 10; i++) {
    const b = BigInt(r.readByte());
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return BigInt.asIntN(64, result);
    shift += 7n;
  }
  throw new ThriftError("Malformed varint (> 10 bytes for I64).");
}

function zigzagEncode32(v) { return ((v << 1) ^ (v >> 31)) >>> 0; }
function zigzagDecode32(v) { return ((v >>> 1) ^ -(v & 1)) | 0; }
function zigzagEncode64(v) { return (v << 1n) ^ (v >> 63n); }
function zigzagDecode64(v) { return (v >> 1n) ^ -(v & 1n); }

// ── Schema resolver ───────────────────────────────────────────────────────────

function resolveSchema(schema) {
  if (typeof schema === "string") {
    switch (schema.toLowerCase()) {
      case "bool":   return { kind: T_BOOL };
      case "byte": case "i8": return { kind: T_BYTE };
      case "i16":    return { kind: T_I16 };
      case "i32":    return { kind: T_I32 };
      case "i64":    return { kind: T_I64 };
      case "double": return { kind: T_DOUBLE };
      case "string": case "binary": return { kind: T_STRING };
      case "uuid":   return { kind: T_UUID };
      default:
        throw new ThriftError(`Unknown primitive type: '${schema}'.`);
    }
  }
  if (typeof schema !== "object" || schema === null)
    throw new ThriftError(`Invalid schema: expected string or object, got ${typeof schema}.`);
  const t = (schema.type || "").toLowerCase();
  switch (t) {
    case "bool":   return { kind: T_BOOL };
    case "byte": case "i8": return { kind: T_BYTE };
    case "i16":    return { kind: T_I16 };
    case "i32":    return { kind: T_I32 };
    case "i64":    return { kind: T_I64 };
    case "double": return { kind: T_DOUBLE };
    case "string": case "binary": return { kind: T_STRING };
    case "uuid":   return { kind: T_UUID };
    case "struct": {
      if (!Array.isArray(schema.fields))
        throw new ThriftError("Struct schema must have 'fields' array.");
      const fields = schema.fields.map((f, i) => {
        if (typeof f !== "object" || f === null)
          throw new ThriftError(`Field[${i}] must be an object.`);
        const fid = typeof f.id === "number" ? f.id : (i + 1);
        return {
          id:       fid,
          name:     f.name || `field_${fid}`,
          type:     resolveSchema(f.type),
          required: !!f.required,
          default:  f.default,
        };
      });
      return { kind: T_STRUCT, fields };
    }
    case "list":
      if (!schema.valueType)
        throw new ThriftError("List schema must have 'valueType'.");
      return { kind: T_LIST, valueType: resolveSchema(schema.valueType) };
    case "set":
      if (!schema.valueType)
        throw new ThriftError("Set schema must have 'valueType'.");
      return { kind: T_SET, valueType: resolveSchema(schema.valueType) };
    case "map":
      if (!schema.keyType)
        throw new ThriftError("Map schema must have 'keyType'.");
      if (!schema.valueType)
        throw new ThriftError("Map schema must have 'valueType'.");
      return {
        kind:      T_MAP,
        keyType:   resolveSchema(schema.keyType),
        valueType: resolveSchema(schema.valueType),
      };
    default:
      throw new ThriftError(`Unknown schema type: '${t}'. Expected: bool, byte, i16, i32, i64, double, string, binary, uuid, struct, list, set, map.`);
  }
}

// ── Binary encoder ────────────────────────────────────────────────────────────

function binaryWriteValue(w, schema, value, depth) {
  if (depth > MAX_DEPTH)
    throw new ThriftError(`Nesting depth exceeded (max ${MAX_DEPTH}).`);
  switch (schema.kind) {
    case T_BOOL: {
      const v = boolCoerce(value);
      w.writeByte(v ? 1 : 0);
      break;
    }
    case T_BYTE: {
      const v = numCoerce(value, "byte");
      w.writeByte(v & 0xff);
      break;
    }
    case T_I16: {
      const v = numCoerce(value, "i16");
      const b = Buffer.allocUnsafe(2);
      b.writeInt16BE(v, 0);
      w.push(b);
      break;
    }
    case T_I32: {
      const v = numCoerce(value, "i32");
      const b = Buffer.allocUnsafe(4);
      b.writeInt32BE(v, 0);
      w.push(b);
      break;
    }
    case T_I64: {
      const v = bigintCoerce(value, "i64");
      const b = Buffer.allocUnsafe(8);
      const hi = Number(BigInt.asIntN(32, v >> 32n));
      const lo = Number(BigInt.asUintN(32, v));
      b.writeInt32BE(hi, 0);
      b.writeUInt32BE(lo, 4);
      w.push(b);
      break;
    }
    case T_DOUBLE: {
      const v = typeof value === "number" ? value : Number(value);
      const b = Buffer.allocUnsafe(8);
      b.writeDoubleBE(v, 0);
      w.push(b);
      break;
    }
    case T_STRING: {
      const buf = stringToBuf(value);
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeInt32BE(buf.length, 0);
      w.push(lenBuf);
      w.push(buf);
      break;
    }
    case T_UUID: {
      w.push(uuidToBuf(value));
      break;
    }
    case T_STRUCT: {
      if (typeof value !== "object" || value === null)
        throw new ThriftError(`Expected object for struct, got ${typeof value}.`);
      for (const f of schema.fields) {
        const fval = value[f.name];
        if (fval === undefined || fval === null) {
          if (f.required)
            throw new ThriftError(`Required field '${f.name}' (id=${f.id}) is missing.`);
          continue;
        }
        w.writeByte(f.type.kind);
        const fhBuf = Buffer.allocUnsafe(2);
        fhBuf.writeInt16BE(f.id, 0);
        w.push(fhBuf);
        binaryWriteValue(w, f.type, fval, depth + 1);
      }
      w.writeByte(T_STOP);
      break;
    }
    case T_LIST:
    case T_SET: {
      const arr = Array.isArray(value) ? value : Array.from(value);
      if (arr.length > MAX_ELEMENTS)
        throw new ThriftError(`Collection too large: ${arr.length} elements.`);
      w.writeByte(schema.valueType.kind);
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeInt32BE(arr.length, 0);
      w.push(lenBuf);
      for (const elem of arr)
        binaryWriteValue(w, schema.valueType, elem, depth + 1);
      break;
    }
    case T_MAP: {
      const entries = Object.entries(value);
      if (entries.length > MAX_ELEMENTS)
        throw new ThriftError(`Map too large: ${entries.length}.`);
      w.writeByte(schema.keyType.kind);
      w.writeByte(schema.valueType.kind);
      const lenBuf = Buffer.allocUnsafe(4);
      lenBuf.writeInt32BE(entries.length, 0);
      w.push(lenBuf);
      for (const [k, v2] of entries) {
        binaryWriteValue(w, schema.keyType,   k,  depth + 1);
        binaryWriteValue(w, schema.valueType, v2, depth + 1);
      }
      break;
    }
    default:
      throw new ThriftError(`Unsupported type id: ${schema.kind}`);
  }
}

// ── Binary decoder ────────────────────────────────────────────────────────────

function binaryReadValue(r, schema, depth) {
  if (depth > MAX_DEPTH)
    throw new ThriftError(`Nesting depth exceeded (max ${MAX_DEPTH}).`);
  switch (schema.kind) {
    case T_BOOL:   return r.readByte() !== 0;
    case T_BYTE:   return r.readByte() << 24 >> 24;
    case T_I16:    return r.readInt16BE();
    case T_I32:    return r.readInt32BE();
    case T_I64:    return i64ToJson(r.readInt64BE());
    case T_DOUBLE: return r.readDoubleBE();
    case T_STRING: {
      const len = r.readInt32BE();
      if (len < 0 || len > MAX_ELEMENTS)
        throw new ThriftError(`Invalid string/binary length: ${len}.`);
      const buf = r.readBytes(len);
      try {
        const s = buf.toString("utf8");
        if (Buffer.from(s, "utf8").equals(buf)) return s;
      } catch (_) { /* fall through */ }
      return { __binary: buf.toString("base64"), length: len };
    }
    case T_UUID:   return bufToUuid(r.readBytes(16));
    case T_STRUCT: {
      const obj = {};
      const byId = {};
      if (schema.fields) {
        for (const f of schema.fields) byId[f.id] = f;
      }
      let elems = 0;
      while (true) {
        const typeId = r.readByte();
        if (typeId === T_STOP) break;
        const fid = r.readInt16BE();
        if (++elems > MAX_ELEMENTS)
          throw new ThriftError(`Struct field count exceeded ${MAX_ELEMENTS}.`);
        const field = byId[fid];
        if (field) {
          obj[field.name] = binaryReadValue(r, field.type, depth + 1);
        } else {
          binarySkipField(r, typeId, depth + 1);
          obj[`__unknown_field_${fid}`] = { typeId };
        }
      }
      return obj;
    }
    case T_LIST:
    case T_SET: {
      const elemTypeId = r.readByte();
      const count = r.readInt32BE();
      if (count < 0 || count > MAX_ELEMENTS)
        throw new ThriftError(`Invalid list/set count: ${count}.`);
      const elemSchema = schema.valueType || { kind: elemTypeId };
      const arr = [];
      for (let i = 0; i < count; i++)
        arr.push(binaryReadValue(r, elemSchema, depth + 1));
      return arr;
    }
    case T_MAP: {
      const keyTypeId = r.readByte();
      const valTypeId = r.readByte();
      const count     = r.readInt32BE();
      if (count < 0 || count > MAX_ELEMENTS)
        throw new ThriftError(`Invalid map count: ${count}.`);
      const keySchema = schema.keyType   || { kind: keyTypeId };
      const valSchema = schema.valueType || { kind: valTypeId };
      const obj = {};
      for (let i = 0; i < count; i++) {
        const k = binaryReadValue(r, keySchema, depth + 1);
        const v = binaryReadValue(r, valSchema, depth + 1);
        obj[String(k)] = v;
      }
      return obj;
    }
    default:
      throw new ThriftError(`Unknown type id during decode: ${schema.kind}.`);
  }
}

function binarySkipField(r, typeId, depth) {
  if (depth > MAX_DEPTH) throw new ThriftError("Max depth exceeded while skipping.");
  switch (typeId) {
    case T_BOOL:   r.readBytes(1); break;
    case T_BYTE:   r.readBytes(1); break;
    case T_I16:    r.readBytes(2); break;
    case T_I32:    r.readBytes(4); break;
    case T_I64:    r.readBytes(8); break;
    case T_DOUBLE: r.readBytes(8); break;
    case T_UUID:   r.readBytes(16); break;
    case T_STRING: { const len = r.readInt32BE(); r.readBytes(len); break; }
    case T_STRUCT: {
      while (true) {
        const t = r.readByte();
        if (t === T_STOP) break;
        r.readBytes(2);
        binarySkipField(r, t, depth + 1);
      }
      break;
    }
    case T_LIST:
    case T_SET: {
      const et = r.readByte(), cnt = r.readInt32BE();
      for (let i = 0; i < cnt; i++) binarySkipField(r, et, depth + 1);
      break;
    }
    case T_MAP: {
      const kt = r.readByte(), vt = r.readByte(), cnt = r.readInt32BE();
      for (let i = 0; i < cnt; i++) {
        binarySkipField(r, kt, depth + 1);
        binarySkipField(r, vt, depth + 1);
      }
      break;
    }
    default:
      throw new ThriftError(`Cannot skip unknown type id: ${typeId}.`);
  }
}

// ── Compact encoder ───────────────────────────────────────────────────────────

function compactWriteValue(w, schema, value, depth) {
  if (depth > MAX_DEPTH)
    throw new ThriftError(`Nesting depth exceeded (max ${MAX_DEPTH}).`);
  switch (schema.kind) {
    case T_BOOL:   w.writeByte(boolCoerce(value) ? 1 : 2); break;
    case T_BYTE:   w.writeByte(numCoerce(value, "byte") & 0xff); break;
    case T_I16:    writeVarI32(w, zigzagEncode32(numCoerce(value, "i16"))); break;
    case T_I32:    writeVarI32(w, zigzagEncode32(numCoerce(value, "i32"))); break;
    case T_I64: {
      const v = bigintCoerce(value, "i64");
      writeVarI64(w, zigzagEncode64(v));
      break;
    }
    case T_DOUBLE: {
      const b = Buffer.allocUnsafe(8);
      b.writeDoubleBE(typeof value === "number" ? value : Number(value), 0);
      b.swap64(); // compact uses little-endian
      w.push(b);
      break;
    }
    case T_STRING: {
      const buf = stringToBuf(value);
      writeVarI32(w, buf.length);
      w.push(buf);
      break;
    }
    case T_UUID: {
      w.push(uuidToBuf(value));
      break;
    }
    case T_STRUCT: {
      if (typeof value !== "object" || value === null)
        throw new ThriftError(`Expected object for struct, got ${typeof value}.`);
      let lastFid = 0;
      for (const f of schema.fields) {
        const fval = value[f.name];
        if (fval === undefined || fval === null) {
          if (f.required)
            throw new ThriftError(`Required field '${f.name}' (id=${f.id}) is missing.`);
          continue;
        }
        const ctype = f.type.kind === T_BOOL
          ? (boolCoerce(fval) ? 1 : 2)
          : THRIFT_TO_COMPACT[f.type.kind];
        if (!ctype)
          throw new ThriftError(`No compact type for kind ${f.type.kind}.`);
        const delta = f.id - lastFid;
        if (delta > 0 && delta <= 15) {
          w.writeByte((delta << 4) | ctype);
        } else {
          w.writeByte(ctype);
          writeVarI32(w, zigzagEncode32(f.id));
        }
        lastFid = f.id;
        // Bool value is embedded in type byte
        if (f.type.kind !== T_BOOL)
          compactWriteValue(w, f.type, fval, depth + 1);
      }
      w.writeByte(T_STOP);
      break;
    }
    case T_LIST:
    case T_SET: {
      const arr = Array.isArray(value) ? value : Array.from(value);
      if (arr.length > MAX_ELEMENTS)
        throw new ThriftError(`Collection too large: ${arr.length}.`);
      const ctype = THRIFT_TO_COMPACT[schema.valueType.kind] || 0;
      if (arr.length <= 14) {
        w.writeByte((arr.length << 4) | ctype);
      } else {
        w.writeByte(0xf0 | ctype);
        writeVarI32(w, arr.length);
      }
      for (const elem of arr)
        compactWriteValue(w, schema.valueType, elem, depth + 1);
      break;
    }
    case T_MAP: {
      const entries = Object.entries(value);
      if (entries.length > MAX_ELEMENTS)
        throw new ThriftError(`Map too large: ${entries.length}.`);
      writeVarI32(w, entries.length);
      if (entries.length > 0) {
        const kt = THRIFT_TO_COMPACT[schema.keyType.kind] || 0;
        const vt = THRIFT_TO_COMPACT[schema.valueType.kind] || 0;
        w.writeByte((kt << 4) | vt);
        for (const [k, v2] of entries) {
          compactWriteValue(w, schema.keyType,   k,  depth + 1);
          compactWriteValue(w, schema.valueType, v2, depth + 1);
        }
      }
      break;
    }
    default:
      throw new ThriftError(`Unsupported type id: ${schema.kind}`);
  }
}

// ── Compact decoder ───────────────────────────────────────────────────────────

function compactReadValue(r, schema, depth) {
  if (depth > MAX_DEPTH)
    throw new ThriftError(`Nesting depth exceeded (max ${MAX_DEPTH}).`);
  switch (schema.kind) {
    case T_BOOL:   return r.readByte() === 1;
    case T_BYTE: {
      const b = r.readByte();
      return b << 24 >> 24;
    }
    case T_I16:    return zigzagDecode32(readVarI32(r));
    case T_I32:    return zigzagDecode32(readVarI32(r));
    case T_I64:    return i64ToJson(zigzagDecode64(readVarI64(r)));
    case T_DOUBLE: {
      const buf = Buffer.from(r.readBytes(8));
      buf.swap64();
      return buf.readDoubleBE(0);
    }
    case T_STRING: {
      const len = readVarI32(r);
      if (len < 0 || len > MAX_ELEMENTS)
        throw new ThriftError(`Invalid string length: ${len}.`);
      const buf = r.readBytes(len);
      try {
        const s = buf.toString("utf8");
        if (Buffer.from(s, "utf8").equals(buf)) return s;
      } catch (_) { /* fall through */ }
      return { __binary: buf.toString("base64"), length: len };
    }
    case T_UUID:   return bufToUuid(r.readBytes(16));
    case T_STRUCT: {
      const obj = {};
      const byId = {};
      if (schema.fields) for (const f of schema.fields) byId[f.id] = f;
      let lastFid = 0;
      let elems = 0;
      while (true) {
        const hdr = r.readByte();
        if (hdr === T_STOP) break;
        const delta = (hdr >> 4) & 0x0f;
        const ctype = hdr & 0x0f;
        const fid = delta === 0 ? zigzagDecode32(readVarI32(r)) : lastFid + delta;
        lastFid = fid;
        if (++elems > MAX_ELEMENTS) throw new ThriftError(`Struct field count exceeded ${MAX_ELEMENTS}.`);
        const thriftType = COMPACT_TO_THRIFT[ctype];
        if (thriftType === undefined)
          throw new ThriftError(`Unknown compact type nibble: ${ctype}.`);
        const field = byId[fid];
        if (field) {
          if (field.type.kind === T_BOOL) {
            obj[field.name] = (ctype === 1);
          } else {
            obj[field.name] = compactReadValue(r, field.type, depth + 1);
          }
        } else {
          if (thriftType !== T_BOOL) compactSkipField(r, thriftType, depth + 1);
          obj[`__unknown_field_${fid}`] = { thriftType };
        }
      }
      return obj;
    }
    case T_LIST:
    case T_SET: {
      const hdr = r.readByte();
      let count, ctype;
      if ((hdr & 0xf0) === 0xf0) { ctype = hdr & 0x0f; count = readVarI32(r); }
      else { count = (hdr >> 4) & 0x0f; ctype = hdr & 0x0f; }
      if (count < 0 || count > MAX_ELEMENTS)
        throw new ThriftError(`Invalid list/set count: ${count}.`);
      const thriftType = COMPACT_TO_THRIFT[ctype];
      const elemSchema = schema.valueType || { kind: thriftType };
      const arr = [];
      for (let i = 0; i < count; i++) {
        if (thriftType === T_BOOL) arr.push(ctype === 1);
        else arr.push(compactReadValue(r, elemSchema, depth + 1));
      }
      return arr;
    }
    case T_MAP: {
      const count = readVarI32(r);
      if (count < 0 || count > MAX_ELEMENTS)
        throw new ThriftError(`Invalid map count: ${count}.`);
      const obj = {};
      if (count > 0) {
        const kv  = r.readByte();
        const kt  = COMPACT_TO_THRIFT[(kv >> 4) & 0x0f];
        const vt  = COMPACT_TO_THRIFT[kv & 0x0f];
        const keySchema = schema.keyType   || { kind: kt };
        const valSchema = schema.valueType || { kind: vt };
        for (let i = 0; i < count; i++) {
          const k = compactReadValue(r, keySchema, depth + 1);
          const v = compactReadValue(r, valSchema, depth + 1);
          obj[String(k)] = v;
        }
      }
      return obj;
    }
    default:
      throw new ThriftError(`Unknown type id during compact decode: ${schema.kind}.`);
  }
}

function compactSkipField(r, thriftType, depth) {
  if (depth > MAX_DEPTH) throw new ThriftError("Max depth exceeded while skipping compact field.");
  switch (thriftType) {
    case T_BOOL:   break; // embedded in type nibble
    case T_BYTE:   r.readBytes(1); break;
    case T_I16: case T_I32: readVarI32(r); break;
    case T_I64:    readVarI64(r); break;
    case T_DOUBLE: r.readBytes(8); break;
    case T_UUID:   r.readBytes(16); break;
    case T_STRING: { const len = readVarI32(r); r.readBytes(len); break; }
    case T_STRUCT: {
      let lastFid = 0;
      while (true) {
        const hdr = r.readByte();
        if (hdr === T_STOP) break;
        const delta = (hdr >> 4) & 0x0f;
        const ctype = hdr & 0x0f;
        if (delta === 0) readVarI32(r);
        const tt = COMPACT_TO_THRIFT[ctype];
        if (tt !== T_BOOL) compactSkipField(r, tt, depth + 1);
      }
      break;
    }
    case T_LIST:
    case T_SET: {
      const hdr = r.readByte();
      let count, ctype;
      if ((hdr & 0xf0) === 0xf0) { ctype = hdr & 0x0f; count = readVarI32(r); }
      else { count = (hdr >> 4) & 0x0f; ctype = hdr & 0x0f; }
      const tt = COMPACT_TO_THRIFT[ctype];
      for (let i = 0; i < count; i++) if (tt !== T_BOOL) compactSkipField(r, tt, depth + 1);
      break;
    }
    case T_MAP: {
      const count = readVarI32(r);
      if (count > 0) {
        const kv = r.readByte();
        const kt = COMPACT_TO_THRIFT[(kv >> 4) & 0x0f];
        const vt = COMPACT_TO_THRIFT[kv & 0x0f];
        for (let i = 0; i < count; i++) {
          if (kt !== T_BOOL) compactSkipField(r, kt, depth + 1);
          if (vt !== T_BOOL) compactSkipField(r, vt, depth + 1);
        }
      }
      break;
    }
    default:
      throw new ThriftError(`Cannot skip compact type: ${thriftType}.`);
  }
}

// ── Binary inspector (schema-less) ────────────────────────────────────────────

function binaryInspect(r, depth, maxDepth, elements) {
  if (depth > maxDepth) return [{ kind: "truncated" }];
  const fields = [];
  while (r.remaining() >= 1) {
    const offset = r.pos;
    const typeId = r.readByte();
    if (typeId === T_STOP) {
      fields.push({ offset, kind: "STOP" });
      break;
    }
    if (r.remaining() < 2) {
      fields.push({ offset, kind: "error", message: "truncated field header" });
      break;
    }
    const fid = r.readInt16BE();
    if (++elements.count > MAX_ELEMENTS) {
      fields.push({ kind: "truncated", message: "element limit" });
      break;
    }
    const entry = {
      fieldId:  fid,
      typeId,
      typeName: TYPE_NAMES[typeId] || `UNKNOWN(${typeId})`,
      offset,
    };
    try {
      entry.value = binaryInspectValue(r, typeId, depth + 1, maxDepth, elements);
    } catch (e) {
      entry.error = e.message;
    }
    fields.push(entry);
  }
  return fields;
}

function binaryInspectValue(r, typeId, depth, maxDepth, elements) {
  if (depth > maxDepth) return "(depth limit)";
  switch (typeId) {
    case T_BOOL:   return r.readByte() !== 0;
    case T_BYTE:   return r.readByte() << 24 >> 24;
    case T_I16:    return r.readInt16BE();
    case T_I32:    return r.readInt32BE();
    case T_I64:    return i64ToJson(r.readInt64BE());
    case T_DOUBLE: return r.readDoubleBE();
    case T_UUID:   return bufToUuid(r.readBytes(16));
    case T_STRING: {
      const len = r.readInt32BE();
      if (len < 0 || len > MAX_ELEMENTS) throw new ThriftError(`Invalid string length: ${len}`);
      const buf = r.readBytes(len);
      try { return buf.toString("utf8"); } catch (_) { return { __binary: buf.toString("base64"), length: len }; }
    }
    case T_STRUCT: return { __struct: binaryInspect(r, depth, maxDepth, elements) };
    case T_LIST:
    case T_SET: {
      const et = r.readByte(), count = r.readInt32BE();
      if (count < 0 || count > MAX_ELEMENTS) throw new ThriftError(`Invalid count: ${count}`);
      const arr = [];
      for (let i = 0; i < count && i < 100; i++)
        arr.push(binaryInspectValue(r, et, depth + 1, maxDepth, elements));
      if (count > 100) arr.push(`... +${count - 100} more`);
      return arr;
    }
    case T_MAP: {
      const kt = r.readByte(), vt = r.readByte(), count = r.readInt32BE();
      if (count < 0 || count > MAX_ELEMENTS) throw new ThriftError(`Invalid count: ${count}`);
      const obj = {};
      for (let i = 0; i < count && i < 100; i++) {
        const k = binaryInspectValue(r, kt, depth + 1, maxDepth, elements);
        const v = binaryInspectValue(r, vt, depth + 1, maxDepth, elements);
        obj[String(k)] = v;
      }
      return obj;
    }
    default:
      throw new ThriftError(`Unknown type ${typeId} during inspect`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function boolCoerce(v) {
  if (v === true  || v === 1 || v === "true"  || v === "1") return true;
  if (v === false || v === 0 || v === "false" || v === "0") return false;
  throw new ThriftError(`Cannot coerce '${v}' to bool.`);
}

function numCoerce(v, label) {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") { const n = Number(v); if (!isNaN(n)) return Math.trunc(n); }
  if (typeof v === "bigint") return Number(v);
  throw new ThriftError(`Cannot coerce '${v}' to ${label}.`);
}

function bigintCoerce(v, label) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") { try { return BigInt(v); } catch (_) { throw new ThriftError(`Cannot parse '${v}' as ${label}.`); } }
  throw new ThriftError(`Cannot coerce '${typeof v}' to ${label}.`);
}

function stringToBuf(v) {
  if (typeof v === "string") return Buffer.from(v, "utf8");
  if (Buffer.isBuffer(v))    return v;
  if (v && typeof v === "object" && typeof v.__binary === "string")
    return Buffer.from(v.__binary, "base64");
  throw new ThriftError(`Cannot coerce value to string/binary: ${JSON.stringify(v)}`);
}

function uuidToBuf(v) {
  if (typeof v !== "string")
    throw new ThriftError(`UUID must be a string, got ${typeof v}.`);
  const hex = v.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex))
    throw new ThriftError(`Invalid UUID: '${v}'. Expected 8-4-4-4-12 hex.`);
  return Buffer.from(hex, "hex");
}

function bufToUuid(buf) {
  const h = buf.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function i64ToJson(big) {
  if (big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER))
    return Number(big);
  return { __i64: big.toString() };
}

function parseBinaryInput(args) {
  if (args.hex != null) {
    const clean = args.hex.replace(/\s/g, "");
    if (clean.length % 2 !== 0) throw new ThriftError("Hex string must have even length.");
    return Buffer.from(clean, "hex");
  }
  if (args.base64 != null) {
    if (!args.base64 || args.base64.trim().length === 0)
      throw new ThriftError("base64 input is empty.");
    return Buffer.from(args.base64, "base64");
  }
  if (args.input_file != null) return readFileSafe(args.input_file);
  throw new ThriftError("Provide one of: 'hex', 'base64', or 'input_file'.");
}

function parseSchema(rawSchema) {
  if (typeof rawSchema === "string") {
    try { return resolveSchema(JSON.parse(rawSchema)); } catch (_) { return resolveSchema(rawSchema); }
  }
  return resolveSchema(rawSchema);
}

function getProtocol(args) {
  const p = (args.protocol || "binary").toLowerCase();
  if (p !== "binary" && p !== "compact")
    throw new ThriftError(`Unknown protocol '${args.protocol}'. Use 'binary' or 'compact'.`);
  return p;
}

function encode(schema, value, protocol) {
  const w = new BufWriter();
  if (protocol === "compact") compactWriteValue(w, schema, value, 0);
  else binaryWriteValue(w, schema, value, 0);
  return w.toBuffer();
}

function decode(schema, buf, protocol) {
  const r = new BufReader(buf);
  const value = protocol === "compact"
    ? compactReadValue(r, schema, 0)
    : binaryReadValue(r, schema, 0);
  return { value, bytesConsumed: r.pos };
}

// ── JSON replacer ─────────────────────────────────────────────────────────────
function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  return value;
}

// ── Main exported function ────────────────────────────────────────────────────

function thriftClient(args, resolveClientPath) {
  const op       = args.operation;
  const protocol = getProtocol(args);

  switch (op) {

    case "encode": {
      if (!args.schema) throw new ThriftError("encode: 'schema' is required.");
      let value;
      if (args.value !== undefined) {
        value = args.value;
      } else if (args.json_file) {
        const { resolved } = resolveClientPath(args.json_file);
        const stat = fs.statSync(resolved);
        if (stat.size > MAX_FILE_SIZE) throw new ThriftError(`json_file too large: ${stat.size} bytes.`);
        value = JSON.parse(fs.readFileSync(resolved, "utf8"));
      } else {
        throw new ThriftError("encode: provide 'value' or 'json_file'.");
      }
      const schema = parseSchema(args.schema);
      const buf = encode(schema, value, protocol);
      if (args.output_file) {
        const { resolved } = resolveClientPath(args.output_file);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, buf);
        const result = { operation: "encode", protocol, savedTo: args.output_file, sizeBytes: buf.length };
        if (args.include_hex)    result.hex    = buf.toString("hex");
        if (args.include_base64) result.base64 = buf.toString("base64");
        return result;
      }
      return { operation: "encode", protocol, sizeBytes: buf.length, hex: buf.toString("hex"), base64: buf.toString("base64") };
    }

    case "decode": {
      if (!args.schema) throw new ThriftError("decode: 'schema' is required.");
      const buf = parseBinaryInput(args);
      const schema = parseSchema(args.schema);
      const { value, bytesConsumed } = decode(schema, buf, protocol);
      return { operation: "decode", protocol, value, bytesConsumed, bytesTotal: buf.length, trailingBytes: buf.length - bytesConsumed };
    }

    case "encode_file": {
      if (!args.schema) throw new ThriftError("encode_file: 'schema' is required.");
      if (!args.path)   throw new ThriftError("encode_file: 'path' (JSON input) is required.");
      if (!args.output) throw new ThriftError("encode_file: 'output' (binary output) is required.");
      const { resolved: inResolved } = resolveClientPath(args.path);
      const stat = fs.statSync(inResolved);
      if (stat.size > MAX_FILE_SIZE) throw new ThriftError(`Input file too large: ${stat.size} bytes.`);
      const value = JSON.parse(fs.readFileSync(inResolved, "utf8"));
      const schema = parseSchema(args.schema);
      const buf = encode(schema, value, protocol);
      const { resolved: outResolved } = resolveClientPath(args.output);
      fs.mkdirSync(path.dirname(outResolved), { recursive: true });
      fs.writeFileSync(outResolved, buf);
      return {
        operation: "encode_file", protocol,
        inputFile: args.path, outputFile: args.output,
        inputBytes: stat.size, outputBytes: buf.length,
        ratio: stat.size > 0 ? (buf.length / stat.size).toFixed(3) : "N/A",
      };
    }

    case "decode_file": {
      if (!args.path)   throw new ThriftError("decode_file: 'path' is required.");
      if (!args.schema) throw new ThriftError("decode_file: 'schema' is required.");
      const { resolved } = resolveClientPath(args.path);
      const buf = readFileSafe(resolved);
      const schema = parseSchema(args.schema);
      const { value, bytesConsumed } = decode(schema, buf, protocol);
      if (args.output) {
        const { resolved: outResolved } = resolveClientPath(args.output);
        fs.mkdirSync(path.dirname(outResolved), { recursive: true });
        const jsonStr = args.pretty ? JSON.stringify(value, jsonReplacer, 2) : JSON.stringify(value, jsonReplacer);
        fs.writeFileSync(outResolved, jsonStr, "utf8");
        return { operation: "decode_file", protocol, inputFile: args.path, outputFile: args.output, bytesConsumed, trailingBytes: buf.length - bytesConsumed };
      }
      return { operation: "decode_file", protocol, inputFile: args.path, value, bytesConsumed, trailingBytes: buf.length - bytesConsumed };
    }

    case "inspect": {
      const buf      = parseBinaryInput(args);
      const maxDepth = Math.min(Math.max(1, args.max_depth || 3), 10);
      if (args.schema) {
        const schema = parseSchema(args.schema);
        try {
          const { value, bytesConsumed } = decode(schema, buf, protocol);
          return { operation: "inspect", protocol, mode: "schema_guided", sizeBytes: buf.length, bytesConsumed, trailingBytes: buf.length - bytesConsumed, value };
        } catch (e) {
          return { operation: "inspect", protocol, mode: "schema_guided", sizeBytes: buf.length, error: e.message };
        }
      }
      const r = new BufReader(buf);
      const elements = { count: 0 };
      const fields = binaryInspect(r, 0, maxDepth, elements);
      return {
        operation: "inspect", protocol: "binary", mode: "raw",
        sizeBytes: buf.length, bytesConsumed: r.pos, trailingBytes: buf.length - r.pos,
        fieldsFound: fields.filter(f => f.kind !== "STOP").length,
        layout: fields,
      };
    }

    default:
      throw new ThriftError(`Unknown operation: '${op}'. Valid: encode, decode, encode_file, decode_file, inspect.`);
  }
}

module.exports = {
  thriftClient,
  encode, decode, resolveSchema,
  binaryWriteValue, binaryReadValue,
  compactWriteValue, compactReadValue,
  BufWriter, BufReader,
  T_BOOL, T_BYTE, T_I16, T_I32, T_I64, T_DOUBLE, T_STRING, T_STRUCT,
  T_MAP, T_SET, T_LIST, T_UUID, T_STOP,
};
