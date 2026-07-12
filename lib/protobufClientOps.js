"use strict";
// lib/protobufClientOps.js — protobuf_client tool
// Zero-dependency Protocol Buffers (proto3) binary encoder/decoder.
// Reference: https://protobuf.dev/programming-guides/encoding/
// Operations: encode, decode, encode_file, decode_file, inspect
//
// Wire types:
//   0  = varint        (int32, int64, uint32, uint64, sint32, sint64, bool, enum)
//   1  = 64-bit fixed  (fixed64, sfixed64, double)
//   2  = length-delim  (string, bytes, embedded message, packed repeated)
//   5  = 32-bit fixed  (fixed32, sfixed32, float)
//
// Schema descriptor format (JSON object):
//   { "<fieldNumber>": { "name": "<fieldName>", "type": "<protoType>", "fields": {...} } }
// Supported proto3 scalar types:
//   int32, int64, uint32, uint64, sint32, sint64,
//   bool, enum,
//   fixed64, sfixed64, double,
//   fixed32, sfixed32, float,
//   string, bytes,
//   message  (requires nested 'fields' descriptor)

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_DEPTH      = 64;               // nesting depth guard
const MAX_FIELDS     = 1_000_000;        // total field limit

// ── Wire type constants ───────────────────────────────────────────────────────
const WIRE_VARINT  = 0;
const WIRE_64BIT   = 1;
const WIRE_LENDELIM = 2;
const WIRE_32BIT   = 5;

// Maps proto3 type name → wire type
const PROTO_WIRE = {
  int32:    WIRE_VARINT,
  int64:    WIRE_VARINT,
  uint32:   WIRE_VARINT,
  uint64:   WIRE_VARINT,
  sint32:   WIRE_VARINT,
  sint64:   WIRE_VARINT,
  bool:     WIRE_VARINT,
  enum:     WIRE_VARINT,
  fixed64:  WIRE_64BIT,
  sfixed64: WIRE_64BIT,
  double:   WIRE_64BIT,
  fixed32:  WIRE_32BIT,
  sfixed32: WIRE_32BIT,
  float:    WIRE_32BIT,
  string:   WIRE_LENDELIM,
  bytes:    WIRE_LENDELIM,
  message:  WIRE_LENDELIM,
};

// ── Varint encoding / decoding ────────────────────────────────────────────────

function encodeVarint(value) {
  // value may be Number or BigInt
  const parts = [];
  let v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  // Treat as unsigned 64-bit
  if (v < 0n) v = v & 0xFFFFFFFFFFFFFFFFn; // two's complement 64-bit
  do {
    let byte = Number(v & 0x7Fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    parts.push(byte);
  } while (v !== 0n);
  return Buffer.from(parts);
}

function encodeZigzag32(n) {
  // sint32 zigzag: (n << 1) ^ (n >> 31)
  const v = Math.trunc(n) | 0; // force int32
  return encodeVarint((v << 1) ^ (v >> 31));
}

function encodeZigzag64(n) {
  // sint64 zigzag: (n << 1) ^ (n >> 63)
  // BigInt arithmetic-right-shift is sign-extending, exactly what we need.
  const v = typeof n === "bigint" ? n : BigInt(Math.trunc(n));
  // Clamp to signed int64 range so BigInt >> behaves as arithmetic shift on 64-bit
  const s = BigInt.asIntN(64, v);
  const zigzag = ((s << 1n) ^ (s >> 63n)) & 0xFFFFFFFFFFFFFFFFn;
  return encodeVarint(zigzag);
}

class ProtoReader {
  constructor(buf) {
    this.buf  = buf;
    this.pos  = 0;
    this._fields = 0;
  }

  remaining() { return this.buf.length - this.pos; }

  readByte() {
    if (this.pos >= this.buf.length)
      throw new ToolError(
        "protobuf_client decode: unexpected end of data at offset " + this.pos + ".",
        -32602
      );
    return this.buf[this.pos++];
  }

  readBytes(n) {
    if (this.pos + n > this.buf.length)
      throw new ToolError(
        "protobuf_client decode: unexpected end of data reading " + n +
        " bytes at offset " + this.pos + ".",
        -32602
      );
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  trackField() {
    this._fields++;
    if (this._fields > MAX_FIELDS)
      throw new ToolError(
        "protobuf_client decode: field count limit exceeded (" + MAX_FIELDS + ").",
        -32602
      );
  }

  readVarint() {
    let result = 0n;
    let shift  = 0n;
    for (;;) {
      const byte = this.readByte();
      result |= BigInt(byte & 0x7F) << shift;
      shift  += 7n;
      if (!(byte & 0x80)) break;
      if (shift >= 70n)
        throw new ToolError(
          "protobuf_client decode: varint too long at offset " + (this.pos - 1) + ".",
          -32602
        );
    }
    return result; // returns BigInt
  }

  readFixed32() {
    return this.readBytes(4).readUInt32LE(0);
  }

  readFixed64() {
    const lo = this.readBytes(4).readUInt32LE(0);
    const hi = this.readBytes(4).readUInt32LE(0);
    return BigInt(hi) * 0x100000000n + BigInt(lo);
  }

  readLenDelim() {
    const lenBig = this.readVarint();
    const len = Number(lenBig);
    if (len < 0 || len > MAX_FILE_BYTES)
      throw new ToolError(
        "protobuf_client decode: length-delimited field too large (" + len + " bytes).",
        -32602
      );
    return this.readBytes(len);
  }

  // Read one tag (field_number << 3 | wire_type)
  readTag() {
    const raw = this.readVarint();
    const wireType   = Number(raw & 7n);
    const fieldNumber = Number(raw >> 3n);
    return { fieldNumber, wireType };
  }
}

// ── Encoder ───────────────────────────────────────────────────────────────────
//
// message: plain JS object with numeric-string or integer keys = field numbers.
// Each field value is { type, value } where type is a proto3 scalar type or 'message'.
// For repeated fields, value is an array.
//
// Simplified schema-driven encode:
//   args.message = { "1": value, "2": value, ... }
//   args.fields  = { "1": { name: "id", type: "int32" }, ... }
//
// Without schema, field types default to:
//   number (integer) → int64, number (float) → double, string → string,
//   boolean → bool, Buffer/base64 → bytes, object → message (raw encode)

function encodeField(fieldNum, type, value, fieldDesc, depth) {
  if (depth > MAX_DEPTH)
    throw new ToolError("protobuf_client encode: nesting depth exceeds limit (" + MAX_DEPTH + ").", -32602);

  const wireType = PROTO_WIRE[type];
  if (wireType === undefined)
    throw new ToolError("protobuf_client encode: unknown field type '" + type + "' for field " + fieldNum + ".", -32602);

  const tag = encodeVarint((fieldNum << 3) | wireType);

  switch (type) {
    // ── varint types ──
    case "bool":   return Buffer.concat([tag, encodeVarint(value ? 1 : 0)]);
    case "enum":
    case "int32":
    case "uint32": return Buffer.concat([tag, encodeVarint(value)]);
    case "int64":
    case "uint64": return Buffer.concat([tag, encodeVarint(typeof value === "bigint" ? value : BigInt(String(value)))]);
    case "sint32": return Buffer.concat([tag, encodeZigzag32(value)]);
    case "sint64": return Buffer.concat([tag, encodeZigzag64(value)]);

    // ── 64-bit fixed ──
    case "double": {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(value, 0);
      return Buffer.concat([tag, b]);
    }
    case "fixed64":
    case "sfixed64": {
      const v64 = typeof value === "bigint" ? value : BigInt(String(value));
      const b = Buffer.alloc(8);
      b.writeUInt32LE(Number(v64 & 0xFFFFFFFFn), 0);
      b.writeUInt32LE(Number((v64 >> 32n) & 0xFFFFFFFFn), 4);
      return Buffer.concat([tag, b]);
    }

    // ── 32-bit fixed ──
    case "float": {
      const b = Buffer.alloc(4);
      b.writeFloatLE(value, 0);
      return Buffer.concat([tag, b]);
    }
    case "fixed32": {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(value >>> 0, 0);
      return Buffer.concat([tag, b]);
    }
    case "sfixed32": {
      const b = Buffer.alloc(4);
      b.writeInt32LE(value | 0, 0);
      return Buffer.concat([tag, b]);
    }

    // ── length-delimited ──
    case "string": {
      const strBuf = Buffer.from(String(value), "utf8");
      return Buffer.concat([tag, encodeVarint(strBuf.length), strBuf]);
    }
    case "bytes": {
      let byteBuf;
      if (Buffer.isBuffer(value))        byteBuf = value;
      else if (typeof value === "string") byteBuf = Buffer.from(value, "base64");
      else throw new ToolError("protobuf_client encode: 'bytes' field " + fieldNum + " requires a Buffer or base64 string.", -32602);
      return Buffer.concat([tag, encodeVarint(byteBuf.length), byteBuf]);
    }
    case "message": {
      // value should be an object; fieldDesc.fields is the nested descriptor
      const nestedFields = (fieldDesc && fieldDesc.fields) ? fieldDesc.fields : null;
      const msgBuf = encodeMessage(value, nestedFields, depth + 1);
      return Buffer.concat([tag, encodeVarint(msgBuf.length), msgBuf]);
    }
    default:
      throw new ToolError("protobuf_client encode: unhandled type '" + type + "'.", -32602);
  }
}

function inferType(value) {
  if (typeof value === "boolean")  return "bool";
  if (typeof value === "bigint")   return "int64";
  if (typeof value === "string")   return "string";
  if (Buffer.isBuffer(value))      return "bytes";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "int64" : "double";
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return "message";
  return "string"; // fallback
}

function encodeMessage(obj, fieldsDesc, depth) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw new ToolError("protobuf_client encode: message value must be a non-null object.", -32602);

  const parts = [];
  for (const [key, val] of Object.entries(obj)) {
    const fieldNum = parseInt(key, 10);
    if (isNaN(fieldNum) || fieldNum <= 0)
      throw new ToolError("protobuf_client encode: field key '" + key + "' is not a valid positive integer field number.", -32602);

    const fieldDesc = fieldsDesc ? fieldsDesc[String(fieldNum)] || fieldsDesc[fieldNum] : null;
    const type = (fieldDesc && fieldDesc.type) ? fieldDesc.type : inferType(val);

    // Repeated fields: if val is an array, encode each element separately
    if (Array.isArray(val)) {
      for (const item of val) {
        parts.push(encodeField(fieldNum, type, item, fieldDesc, depth));
      }
    } else {
      parts.push(encodeField(fieldNum, type, val, fieldDesc, depth));
    }
  }
  return Buffer.concat(parts);
}

// ── Decoder ───────────────────────────────────────────────────────────────────

function decodeVarintSigned(v) {
  // Treat BigInt varint as signed int64
  const signed = v >= 0x8000000000000000n ? v - 0x10000000000000000n : v;
  // If fits in safe integer range, return number
  const abs = signed < 0n ? -signed : signed;
  if (abs <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(signed);
  return signed;
}

function decodeZigzag(v) {
  // v is a BigInt from readVarint
  const n = BigInt.asUintN(64, v);
  const decoded = (n >> 1n) ^ -(n & 1n);
  if (decoded >= BigInt(-Number.MAX_SAFE_INTEGER) && decoded <= BigInt(Number.MAX_SAFE_INTEGER))
    return Number(decoded);
  return decoded;
}

function interpretVarint(raw, type) {
  switch (type) {
    case "bool":   return raw !== 0n;
    case "int32":  return Number(BigInt.asIntN(32, raw));
    case "int64":  return decodeVarintSigned(raw);
    case "uint32": return Number(BigInt.asUintN(32, raw));
    case "uint64": {
      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(raw);
      return raw;
    }
    case "sint32": return decodeZigzag(BigInt.asUintN(32, raw));
    case "sint64": return decodeZigzag(raw);
    case "enum":   return Number(BigInt.asIntN(32, raw));
    default:       return decodeVarintSigned(raw);
  }
}

function interpret64bit(lo, hi, type) {
  const raw = BigInt(hi) * 0x100000000n + BigInt(lo);
  switch (type) {
    case "double":   {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(lo, 0);
      b.writeUInt32LE(hi, 4);
      return b.readDoubleLE(0);
    }
    case "sfixed64": {
      const signed = raw >= 0x8000000000000000n ? raw - 0x10000000000000000n : raw;
      if (signed >= BigInt(-Number.MAX_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER))
        return Number(signed);
      return signed;
    }
    case "fixed64":
    default: {
      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(raw);
      return raw;
    }
  }
}

function interpret32bit(rawUint32, type) {
  switch (type) {
    case "float":    {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(rawUint32, 0);
      return b.readFloatLE(0);
    }
    case "sfixed32": return rawUint32 | 0; // signed int32
    case "fixed32":
    default:         return rawUint32 >>> 0;
  }
}

function decodeMessage(buf, fieldsDesc, depth, reader) {
  if (depth > MAX_DEPTH)
    throw new ToolError("protobuf_client decode: nesting depth exceeds limit (" + MAX_DEPTH + ").", -32602);

  const r = reader || new ProtoReader(buf);
  const endPos = reader ? r.pos + buf.length : buf.length;
  // For the top-level call with an external reader, endPos is already buf.length
  // For nested calls, buf = the payload slice, and we use a fresh reader on that slice
  const nestedReader = reader ? null : r;
  const rr = reader ? new ProtoReader(buf) : r;
  const end = rr.buf.length;

  const result = Object.create(null);

  while (rr.pos < end) {
    rr.trackField();
    const { fieldNumber, wireType } = rr.readTag();
    const key   = String(fieldNumber);
    const fdesc = fieldsDesc ? (fieldsDesc[key] || fieldsDesc[fieldNumber] || null) : null;
    const type  = fdesc ? fdesc.type : null;
    const name  = fdesc ? fdesc.name : ("field_" + fieldNumber);

    let value;

    switch (wireType) {
      case WIRE_VARINT: {
        const raw = rr.readVarint();
        value = type ? interpretVarint(raw, type) : decodeVarintSigned(raw);
        break;
      }
      case WIRE_64BIT: {
        const lo = rr.readBytes(4).readUInt32LE(0);
        const hi = rr.readBytes(4).readUInt32LE(0);
        value = type ? interpret64bit(lo, hi, type) : interpret64bit(lo, hi, "fixed64");
        break;
      }
      case WIRE_LENDELIM: {
        const payload = rr.readLenDelim();
        if (type === "string") {
          value = payload.toString("utf8");
        } else if (type === "bytes") {
          value = { __bytes: payload.toString("base64"), length: payload.length };
        } else if (type === "message") {
          const nestedFields = fdesc && fdesc.fields ? fdesc.fields : null;
          value = decodeMessage(payload, nestedFields, depth + 1, null);
        } else {
          // Unknown type: try UTF-8 string, fallback to bytes
          try {
            const str = payload.toString("utf8");
            // Check it's valid UTF-8 by round-tripping
            if (Buffer.from(str, "utf8").equals(payload)) {
              value = str;
            } else {
              value = { __bytes: payload.toString("base64"), length: payload.length };
            }
          } catch {
            value = { __bytes: payload.toString("base64"), length: payload.length };
          }
        }
        break;
      }
      case WIRE_32BIT: {
        const raw32 = rr.readFixed32();
        value = type ? interpret32bit(raw32, type) : raw32;
        break;
      }
      default:
        throw new ToolError(
          "protobuf_client decode: unknown wire type " + wireType +
          " for field " + fieldNumber + " at offset " + (rr.pos - 1) + ".",
          -32602
        );
    }

    // Convert BigInt to string for JSON safety
    const jsonValue = toJsonSafe(value);

    // Build output: use name from schema if available, keyed by field number
    const outKey = name || key;
    if (outKey in result) {
      // Already present: make it a repeated field (array)
      if (Array.isArray(result[outKey])) {
        result[outKey].push(jsonValue);
      } else {
        result[outKey] = [result[outKey], jsonValue];
      }
    } else {
      result[outKey] = jsonValue;
    }

    // Also store by field number if we have a schema name (so both keys exist)
    if (name && name !== key && !(key in result)) {
      // store field number key for easy lookup
      // skip — outKey by name is more useful
    }
  }

  return result;
}

function toJsonSafe(value) {
  if (typeof value === "bigint") {
    // Return as string to preserve precision in JSON
    return { __int64: value.toString() };
  }
  if (Buffer.isBuffer(value))
    return { __bytes: value.toString("base64"), length: value.length };
  if (Array.isArray(value))
    return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

// ── Inspector ─────────────────────────────────────────────────────────────────

function inspectBuffer(buf, maxDepth) {
  const md = maxDepth == null ? 3 : Math.max(1, Math.min(10, Number(maxDepth)));
  const reader = new ProtoReader(buf);

  function inspectMessage(depth, endPos) {
    const fields = [];
    while (reader.pos < endPos) {
      const startPos = reader.pos;
      const { fieldNumber, wireType } = reader.readTag();
      const wireNames = { 0: "varint", 1: "64bit", 2: "len_delim", 5: "32bit" };
      const entry = {
        fieldNumber,
        wireType: wireNames[wireType] || String(wireType),
        offset: startPos,
      };

      switch (wireType) {
        case WIRE_VARINT: {
          const raw = reader.readVarint();
          entry.bytes = reader.pos - startPos;
          entry.rawVarint = raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw.toString();
          break;
        }
        case WIRE_64BIT: {
          reader.readBytes(8);
          entry.bytes = reader.pos - startPos;
          entry.fixedBits = 64;
          break;
        }
        case WIRE_LENDELIM: {
          const lenBig = reader.readVarint();
          const len = Number(lenBig);
          const payloadStart = reader.pos;
          reader.readBytes(len);
          entry.bytes = reader.pos - startPos;
          entry.payloadLength = len;
          // Try to sub-parse as message if depth allows
          if (depth < md && len > 0) {
            try {
              const savedPos = reader.pos;
              const subReader = new ProtoReader(buf.slice(payloadStart, payloadStart + len));
              const subFields = inspectMessageInner(subReader, subReader.buf.length, depth + 1);
              if (subFields !== null) entry.possibleMessage = subFields;
            } catch (_) { /* not a valid sub-message, ignore */ }
          }
          break;
        }
        case WIRE_32BIT: {
          reader.readBytes(4);
          entry.bytes = reader.pos - startPos;
          entry.fixedBits = 32;
          break;
        }
        default:
          throw new ToolError(
            "protobuf_client inspect: unknown wire type " + wireType +
            " at offset " + startPos + ".",
            -32602
          );
      }
      fields.push(entry);
    }
    return fields;
  }

  function inspectMessageInner(r, endPos, depth) {
    // Returns array of field entries or null if parsing fails
    const saved = r.pos;
    const fields = [];
    try {
      while (r.pos < endPos) {
        const startPos = r.pos;
        if (r.remaining() === 0) break;
        const rawTag = r.readVarint();
        const wireType = Number(rawTag & 7n);
        const fieldNum  = Number(rawTag >> 3n);
        if (fieldNum === 0) return null; // invalid field number
        const entry = { fieldNumber: fieldNum, wireType, offset: startPos };
        switch (wireType) {
          case WIRE_VARINT: {
            const raw = r.readVarint();
            entry.bytes = r.pos - startPos;
            entry.rawVarint = raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw.toString();
            break;
          }
          case WIRE_64BIT:  { r.readBytes(8); entry.bytes = r.pos - startPos; break; }
          case WIRE_32BIT:  { r.readBytes(4); entry.bytes = r.pos - startPos; break; }
          case WIRE_LENDELIM: {
            const len = Number(r.readVarint());
            if (len < 0 || len > MAX_FILE_BYTES) return null;
            r.readBytes(len);
            entry.bytes = r.pos - startPos;
            entry.payloadLength = len;
            break;
          }
          default: return null;
        }
        fields.push(entry);
      }
    } catch (_) { return null; }
    return fields;
  }

  const fields = inspectMessage(0, buf.length);
  return { totalBytes: buf.length, fieldCount: fields.length, fields };
}

// ── Path / file helpers ───────────────────────────────────────────────────────

function validatePath(p, op) {
  if (!p || p.includes("\0"))
    throw new ToolError("protobuf_client " + op + ": path contains NUL byte.", -32602);
}

function validateFileSize(absPath, op) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory())
    throw new ToolError("protobuf_client " + op + ": path is a directory.", -32602);
  if (stat.size > MAX_FILE_BYTES)
    throw new ToolError(
      "protobuf_client " + op + ": file too large (" + stat.size + " bytes; max " + MAX_FILE_BYTES + ").",
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
      throw new ToolError("protobuf_client " + op + ": input is empty.", -32602);
    const hexStr = args.hex.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hexStr) || hexStr.length % 2 !== 0)
      throw new ToolError(
        "protobuf_client " + op + ": 'hex' must be a valid even-length hex string.",
        -32602
      );
    return Buffer.from(hexStr, "hex");
  } else if (args.base64 !== undefined) {
    if (args.base64 === "")
      throw new ToolError("protobuf_client " + op + ": input is empty.", -32602);
    return Buffer.from(args.base64, "base64");
  } else {
    throw new ToolError(
      "protobuf_client " + op + ": 'input_file', 'hex', or 'base64' is required.",
      -32602
    );
  }
}

// ── Operations ────────────────────────────────────────────────────────────────

function opEncode(args, resolveClientPath) {
  let message;
  if (args.json_file) {
    validatePath(args.json_file, "encode");
    const { resolved } = resolveClientPath(args.json_file);
    validateFileSize(resolved, "encode");
    const src = fs.readFileSync(resolved, "utf8");
    try { message = JSON.parse(src); }
    catch (e) { throw new ToolError("protobuf_client encode: json_file is not valid JSON — " + e.message, -32602); }
  } else if (args.message !== undefined) {
    message = args.message;
  } else {
    throw new ToolError("protobuf_client encode: 'message' or 'json_file' is required.", -32602);
  }

  const fieldsDesc = args.fields || null;
  const encoded = encodeMessage(message, fieldsDesc, 0);

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
    sizeBytes:  encoded.length,
    hex:        encoded.toString("hex"),
    base64:     encoded.toString("base64"),
  };
}

function opDecode(args, resolveClientPath) {
  const buf = resolveBuf(args, "decode", resolveClientPath);
  if (buf.length === 0)
    throw new ToolError("protobuf_client decode: input is empty.", -32602);
  if (buf.length > MAX_FILE_BYTES)
    throw new ToolError("protobuf_client decode: input too large (" + buf.length + " bytes; max " + MAX_FILE_BYTES + ").", -32602);

  const fieldsDesc = args.fields || null;
  const decoded = decodeMessage(buf, fieldsDesc, 0, null);

  return { operation: "decode", inputBytes: buf.length, message: decoded };
}

function opEncodeFile(args, resolveClientPath) {
  if (!args.path)   throw new ToolError("protobuf_client encode_file: 'path' (JSON input) is required.", -32602);
  if (!args.output) throw new ToolError("protobuf_client encode_file: 'output' (protobuf output path) is required.", -32602);

  validatePath(args.path, "encode_file");
  validatePath(args.output, "encode_file");
  const { resolved: absIn  } = resolveClientPath(args.path);
  const { resolved: absOut } = resolveClientPath(args.output);
  validateFileSize(absIn, "encode_file");

  const src = fs.readFileSync(absIn, "utf8");
  let message;
  try { message = JSON.parse(src); }
  catch (e) { throw new ToolError("protobuf_client encode_file: input is not valid JSON — " + e.message, -32602); }

  const fieldsDesc = args.fields || null;
  const encoded = encodeMessage(message, fieldsDesc, 0);

  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, encoded);

  const inputBytes  = Buffer.byteLength(src, "utf8");
  const outputBytes = encoded.length;
  return {
    operation:   "encode_file",
    inputPath:   args.path,
    outputPath:  args.output,
    inputBytes,
    outputBytes,
    ratio:       (outputBytes / inputBytes).toFixed(3),
  };
}

function opDecodeFile(args, resolveClientPath) {
  if (!args.path) throw new ToolError("protobuf_client decode_file: 'path' (protobuf input) is required.", -32602);

  validatePath(args.path, "decode_file");
  const { resolved: absIn } = resolveClientPath(args.path);
  validateFileSize(absIn, "decode_file");

  const buf = fs.readFileSync(absIn);
  if (buf.length === 0)
    throw new ToolError("protobuf_client decode_file: input file is empty.", -32602);

  const fieldsDesc = args.fields || null;
  const decoded = decodeMessage(buf, fieldsDesc, 0, null);
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
    };
  }

  return { operation: "decode_file", inputPath: args.path, inputBytes: buf.length, message: decoded };
}

function opInspect(args, resolveClientPath) {
  const buf = resolveBuf(args, "inspect", resolveClientPath);
  if (buf.length === 0)
    throw new ToolError("protobuf_client inspect: input is empty.", -32602);

  const { totalBytes, fieldCount, fields } = inspectBuffer(buf, args.max_depth);
  return { operation: "inspect", totalBytes, fieldCount, fields };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

function protobufClient(args, resolveClientPath) {
  const op = args.operation;
  if (!op) throw new ToolError("protobuf_client: 'operation' is required.", -32602);

  const VALID_OPS = ["encode", "decode", "encode_file", "decode_file", "inspect"];
  if (!VALID_OPS.includes(op))
    throw new ToolError(
      "protobuf_client: unknown operation '" + op + "'. Valid: " + VALID_OPS.join(", ") + ".",
      -32602
    );

  switch (op) {
    case "encode":      return opEncode(args, resolveClientPath);
    case "decode":      return opDecode(args, resolveClientPath);
    case "encode_file": return opEncodeFile(args, resolveClientPath);
    case "decode_file": return opDecodeFile(args, resolveClientPath);
    case "inspect":     return opInspect(args, resolveClientPath);
  }
}

module.exports = {
  protobufClient,
  encodeMessage,
  decodeMessage,
  inspectBuffer,
  encodeVarint,
};
