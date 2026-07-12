"use strict";
// lib/msgpackClientOps.js — msgpack_client tool
// Zero-dependency MessagePack encoder/decoder (pure Node.js; no npm deps).
// Implements the MessagePack specification: https://github.com/msgpack/msgpack/blob/master/spec.md
// Operations: encode, decode, encode_file, decode_file, inspect

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_INPUT_BYTES  = 50 * 1024 * 1024;  // 50 MB for file ops
const MAX_JSON_BYTES   = 10 * 1024 * 1024;  // 10 MB for inline JSON value
const MAX_DEPTH        = 100;               // nesting depth guard
const MAX_ELEMENTS     = 1_000_000;         // array/map element limit

// ── Encoder ──────────────────────────────────────────────────────────────────

/**
 * Encode a JavaScript value into MessagePack bytes.
 * Returns a Buffer.
 */
function encode(value, depth) {
  if ((depth || 0) > MAX_DEPTH)
    throw new ToolError("msgpack_client encode: nesting depth exceeds limit (" + MAX_DEPTH + ").", -32602);
  const d = (depth || 0) + 1;

  if (value === null)      return Buffer.from([0xc0]);
  if (value === true)      return Buffer.from([0xc3]);
  if (value === false)     return Buffer.from([0xc2]);
  if (value === undefined) return Buffer.from([0xc0]); // encode undefined as nil

  if (typeof value === "number") {
    return encodeNumber(value);
  }

  if (typeof value === "string") {
    return encodeStr(value);
  }

  if (Buffer.isBuffer(value)) {
    return encodeBin(value);
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ELEMENTS)
      throw new ToolError("msgpack_client encode: array too large (" + value.length + " elements; max " + MAX_ELEMENTS + ").", -32602);
    return encodeArray(value, d);
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > MAX_ELEMENTS)
      throw new ToolError("msgpack_client encode: map too large (" + keys.length + " keys; max " + MAX_ELEMENTS + ").", -32602);
    return encodeMap(value, keys, d);
  }

  if (typeof value === "bigint") {
    return encodeBigInt(value);
  }

  // Fallback: encode as string
  return encodeStr(String(value));
}

function encodeNumber(n) {
  // Integer check: Number.isInteger also matches -0, handle that
  if (Number.isInteger(n) && n !== -0) {
    if (n >= 0) {
      if (n <= 0x7f)        return Buffer.from([n]);                     // positive fixint
      if (n <= 0xff)        return Buffer.from([0xcc, n]);               // uint8
      if (n <= 0xffff)      { const b = Buffer.alloc(3); b[0]=0xcd; b.writeUInt16BE(n,1); return b; } // uint16
      if (n <= 0xffffffff)  { const b = Buffer.alloc(5); b[0]=0xce; b.writeUInt32BE(n,1); return b; } // uint32
      // uint64 — safe up to 2^53
      { const b = Buffer.alloc(9); b[0]=0xcf; writeUInt64BE(b, BigInt(n), 1); return b; }
    } else {
      if (n >= -32)         return Buffer.from([n & 0xff]);              // negative fixint
      if (n >= -128)        return Buffer.from([0xd0, n & 0xff]);        // int8
      if (n >= -32768)      { const b = Buffer.alloc(3); b[0]=0xd1; b.writeInt16BE(n,1); return b; }   // int16
      if (n >= -2147483648) { const b = Buffer.alloc(5); b[0]=0xd2; b.writeInt32BE(n,1); return b; }   // int32
      // int64
      { const b = Buffer.alloc(9); b[0]=0xd3; writeInt64BE(b, BigInt(n), 1); return b; }
    }
  }
  // Float64
  const b = Buffer.alloc(9);
  b[0] = 0xcb;
  b.writeDoubleBE(n, 1);
  return b;
}

function encodeBigInt(n) {
  if (n >= 0n) {
    const b = Buffer.alloc(9); b[0]=0xcf; writeUInt64BE(b, n, 1); return b;
  } else {
    const b = Buffer.alloc(9); b[0]=0xd3; writeInt64BE(b, n, 1); return b;
  }
}

function writeUInt64BE(buf, value, offset) {
  // Write BigInt as unsigned 64-bit big-endian
  const hi = Number(value >> 32n) >>> 0;
  const lo = Number(value & 0xffffffffn) >>> 0;
  buf.writeUInt32BE(hi, offset);
  buf.writeUInt32BE(lo, offset + 4);
}

function writeInt64BE(buf, value, offset) {
  // Write BigInt as signed 64-bit big-endian (two's complement)
  const unsigned = BigInt.asUintN(64, value);
  writeUInt64BE(buf, unsigned, offset);
}

function encodeStr(s) {
  const bytes = Buffer.from(s, "utf8");
  const len = bytes.length;
  let header;
  if (len <= 31)       header = Buffer.from([0xa0 | len]);
  else if (len <= 0xff)  header = Buffer.from([0xd9, len]);
  else if (len <= 0xffff) { header = Buffer.alloc(3); header[0]=0xda; header.writeUInt16BE(len,1); }
  else { header = Buffer.alloc(5); header[0]=0xdb; header.writeUInt32BE(len,1); }
  return Buffer.concat([header, bytes]);
}

function encodeBin(buf) {
  const len = buf.length;
  let header;
  if (len <= 0xff)     header = Buffer.from([0xc4, len]);
  else if (len <= 0xffff) { header = Buffer.alloc(3); header[0]=0xc5; header.writeUInt16BE(len,1); }
  else { header = Buffer.alloc(5); header[0]=0xc6; header.writeUInt32BE(len,1); }
  return Buffer.concat([header, buf]);
}

function encodeArray(arr, depth) {
  const len = arr.length;
  let header;
  if (len <= 15)       header = Buffer.from([0x90 | len]);
  else if (len <= 0xffff) { header = Buffer.alloc(3); header[0]=0xdc; header.writeUInt16BE(len,1); }
  else { header = Buffer.alloc(5); header[0]=0xdd; header.writeUInt32BE(len,1); }
  const parts = [header];
  for (const item of arr) parts.push(encode(item, depth));
  return Buffer.concat(parts);
}

function encodeMap(obj, keys, depth) {
  const len = keys.length;
  let header;
  if (len <= 15)       header = Buffer.from([0x80 | len]);
  else if (len <= 0xffff) { header = Buffer.alloc(3); header[0]=0xde; header.writeUInt16BE(len,1); }
  else { header = Buffer.alloc(5); header[0]=0xdf; header.writeUInt32BE(len,1); }
  const parts = [header];
  for (const k of keys) {
    parts.push(encodeStr(k));
    parts.push(encode(obj[k], depth));
  }
  return Buffer.concat(parts);
}

// ── Decoder ──────────────────────────────────────────────────────────────────

class MsgpackReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this._elementCount = 0;
  }

  remaining() { return this.buf.length - this.pos; }

  readByte() {
    if (this.pos >= this.buf.length)
      throw new ToolError("msgpack_client decode: unexpected end of data at offset " + this.pos + ".", -32602);
    return this.buf[this.pos++];
  }

  readBytes(n) {
    if (this.pos + n > this.buf.length)
      throw new ToolError("msgpack_client decode: unexpected end of data reading " + n + " bytes at offset " + this.pos + ".", -32602);
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  readUInt8()  { return this.readBytes(1).readUInt8(0); }
  readUInt16() { return this.readBytes(2).readUInt16BE(0); }
  readUInt32() { return this.readBytes(4).readUInt32BE(0); }
  readInt8()   { return this.readBytes(1).readInt8(0); }
  readInt16()  { return this.readBytes(2).readInt16BE(0); }
  readInt32()  { return this.readBytes(4).readInt32BE(0); }
  readFloat32(){ return this.readBytes(4).readFloatBE(0); }
  readFloat64(){ return this.readBytes(8).readDoubleBE(0); }

  readUInt64() {
    const hi = this.readUInt32();
    const lo = this.readUInt32();
    const val = BigInt(hi) * 0x100000000n + BigInt(lo);
    // Return as number if it fits safely
    if (val <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(val);
    return val;
  }

  readInt64() {
    const hi = this.readUInt32();
    const lo = this.readUInt32();
    let val = (BigInt(hi) << 32n) | BigInt(lo);
    // Sign extend
    if (val >= 0x8000000000000000n) val -= 0x10000000000000000n;
    if (val >= BigInt(Number.MIN_SAFE_INTEGER) && val <= BigInt(Number.MAX_SAFE_INTEGER))
      return Number(val);
    return val;
  }

  trackElement() {
    this._elementCount++;
    if (this._elementCount > MAX_ELEMENTS)
      throw new ToolError("msgpack_client decode: element count limit exceeded (" + MAX_ELEMENTS + ").", -32602);
  }

  decode(depth) {
    if ((depth || 0) > MAX_DEPTH)
      throw new ToolError("msgpack_client decode: nesting depth exceeds limit (" + MAX_DEPTH + ").", -32602);
    const d = (depth || 0) + 1;
    this.trackElement();

    const byte = this.readByte();

    // Positive fixint: 0x00–0x7f
    if (byte <= 0x7f) return byte;

    // Fixmap: 0x80–0x8f
    if (byte >= 0x80 && byte <= 0x8f) return this.decodeMap(byte & 0x0f, d);

    // Fixarray: 0x90–0x9f
    if (byte >= 0x90 && byte <= 0x9f) return this.decodeArray(byte & 0x0f, d);

    // Fixstr: 0xa0–0xbf
    if (byte >= 0xa0 && byte <= 0xbf) return this.decodeStr(byte & 0x1f);

    // Negative fixint: 0xe0–0xff
    if (byte >= 0xe0) return byte - 0x100;

    switch (byte) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      // bin
      case 0xc4: return this.readBytes(this.readUInt8());
      case 0xc5: return this.readBytes(this.readUInt16());
      case 0xc6: return this.readBytes(this.readUInt32());
      // ext
      case 0xc7: { const n=this.readUInt8();  const t=this.readInt8();  const d2=this.readBytes(n);  return { __ext: t, data: d2.toString("base64") }; }
      case 0xc8: { const n=this.readUInt16(); const t=this.readInt8();  const d2=this.readBytes(n);  return { __ext: t, data: d2.toString("base64") }; }
      case 0xc9: { const n=this.readUInt32(); const t=this.readInt8();  const d2=this.readBytes(n);  return { __ext: t, data: d2.toString("base64") }; }
      // float
      case 0xca: return this.readFloat32();
      case 0xcb: return this.readFloat64();
      // uint
      case 0xcc: return this.readUInt8();
      case 0xcd: return this.readUInt16();
      case 0xce: return this.readUInt32();
      case 0xcf: return this.readUInt64();
      // int
      case 0xd0: return this.readInt8();
      case 0xd1: return this.readInt16();
      case 0xd2: return this.readInt32();
      case 0xd3: return this.readInt64();
      // fixext
      case 0xd4: { const t=this.readInt8();  const d2=this.readBytes(1);  return { __ext: t, data: d2.toString("base64") }; }
      case 0xd5: { const t=this.readInt8();  const d2=this.readBytes(2);  return { __ext: t, data: d2.toString("base64") }; }
      case 0xd6: { const t=this.readInt8();  const d2=this.readBytes(4);  return { __ext: t, data: d2.toString("base64") }; }
      case 0xd7: { const t=this.readInt8();  const d2=this.readBytes(8);  return { __ext: t, data: d2.toString("base64") }; }
      case 0xd8: { const t=this.readInt8();  const d2=this.readBytes(16); return { __ext: t, data: d2.toString("base64") }; }
      // str
      case 0xd9: return this.decodeStr(this.readUInt8());
      case 0xda: return this.decodeStr(this.readUInt16());
      case 0xdb: return this.decodeStr(this.readUInt32());
      // array
      case 0xdc: return this.decodeArray(this.readUInt16(), d);
      case 0xdd: return this.decodeArray(this.readUInt32(), d);
      // map
      case 0xde: return this.decodeMap(this.readUInt16(), d);
      case 0xdf: return this.decodeMap(this.readUInt32(), d);
      default:
        throw new ToolError("msgpack_client decode: unknown format byte 0x" + byte.toString(16).padStart(2, "0") + " at offset " + (this.pos - 1) + ".", -32602);
    }
  }

  decodeStr(len) {
    return this.readBytes(len).toString("utf8");
  }

  decodeArray(len, depth) {
    const arr = new Array(len);
    for (let i = 0; i < len; i++) arr[i] = this.decode(depth);
    return arr;
  }

  decodeMap(len, depth) {
    const obj = Object.create(null);
    for (let i = 0; i < len; i++) {
      const key = this.decode(depth);
      const val = this.decode(depth);
      obj[String(key)] = val;
    }
    return obj;
  }
}

/**
 * Decode a MessagePack buffer. Returns the decoded JavaScript value.
 * If allow_multiple is true, returns an array of all top-level values.
 */
function decodeBuffer(buf, allowMultiple) {
  const reader = new MsgpackReader(buf);
  if (!allowMultiple) {
    const value = reader.decode(0);
    if (reader.remaining() > 0)
      throw new ToolError(
        "msgpack_client decode: " + reader.remaining() + " trailing bytes after first value. Use allow_multiple to decode a stream.",
        -32602
      );
    return value;
  }
  // Stream mode: decode until buffer exhausted
  const values = [];
  while (reader.remaining() > 0) values.push(reader.decode(0));
  return values;
}

// ── Inspector: describe the type tree without full decoding ──────────────────

function inspectBuffer(buf, maxDepth) {
  const reader = new MsgpackReader(buf);
  const md = (maxDepth == null ? 3 : Math.max(1, Math.min(10, Number(maxDepth))));

  function inspectNode(depth) {
    if (reader.remaining() === 0) return { type: "eof" };
    const byte = reader.readByte();

    if (byte <= 0x7f) return { type: "uint",  value: byte, bytes: 1 };
    if (byte >= 0x80 && byte <= 0x8f) return inspectMap(byte & 0x0f, depth, 1);
    if (byte >= 0x90 && byte <= 0x9f) return inspectArray(byte & 0x0f, depth, 1);
    if (byte >= 0xa0 && byte <= 0xbf) {
      const len = byte & 0x1f;
      reader.readBytes(len);
      return { type: "str", length: len, bytes: 1 + len };
    }
    if (byte >= 0xe0) return { type: "int",  value: byte - 0x100, bytes: 1 };

    switch (byte) {
      case 0xc0: return { type: "nil",   bytes: 1 };
      case 0xc2: return { type: "bool",  value: false, bytes: 1 };
      case 0xc3: return { type: "bool",  value: true,  bytes: 1 };
      case 0xc4: { const n=reader.readUInt8();  reader.readBytes(n); return { type: "bin",  length: n, bytes: 2+n }; }
      case 0xc5: { const n=reader.readUInt16(); reader.readBytes(n); return { type: "bin",  length: n, bytes: 3+n }; }
      case 0xc6: { const n=reader.readUInt32(); reader.readBytes(n); return { type: "bin",  length: n, bytes: 5+n }; }
      case 0xc7: { const n=reader.readUInt8();  reader.readBytes(1+n); return { type: "ext",  length: n, bytes: 3+n }; }
      case 0xc8: { const n=reader.readUInt16(); reader.readBytes(1+n); return { type: "ext",  length: n, bytes: 4+n }; }
      case 0xc9: { const n=reader.readUInt32(); reader.readBytes(1+n); return { type: "ext",  length: n, bytes: 6+n }; }
      case 0xca: { reader.readBytes(4); return { type: "float32", bytes: 5 }; }
      case 0xcb: { reader.readBytes(8); return { type: "float64", bytes: 9 }; }
      case 0xcc: { reader.readUInt8();  return { type: "uint8",   bytes: 2 }; }
      case 0xcd: { reader.readUInt16(); return { type: "uint16",  bytes: 3 }; }
      case 0xce: { reader.readUInt32(); return { type: "uint32",  bytes: 5 }; }
      case 0xcf: { reader.readBytes(8); return { type: "uint64",  bytes: 9 }; }
      case 0xd0: { reader.readInt8();   return { type: "int8",    bytes: 2 }; }
      case 0xd1: { reader.readInt16();  return { type: "int16",   bytes: 3 }; }
      case 0xd2: { reader.readInt32();  return { type: "int32",   bytes: 5 }; }
      case 0xd3: { reader.readBytes(8); return { type: "int64",   bytes: 9 }; }
      case 0xd4: { reader.readBytes(2); return { type: "fixext1", bytes: 3 }; }
      case 0xd5: { reader.readBytes(3); return { type: "fixext2", bytes: 4 }; }
      case 0xd6: { reader.readBytes(5); return { type: "fixext4", bytes: 6 }; }
      case 0xd7: { reader.readBytes(9); return { type: "fixext8", bytes: 10 }; }
      case 0xd8: { reader.readBytes(17); return { type: "fixext16", bytes: 18 }; }
      case 0xd9: { const n=reader.readUInt8();  reader.readBytes(n); return { type: "str8",  length: n, bytes: 2+n }; }
      case 0xda: { const n=reader.readUInt16(); reader.readBytes(n); return { type: "str16", length: n, bytes: 3+n }; }
      case 0xdb: { const n=reader.readUInt32(); reader.readBytes(n); return { type: "str32", length: n, bytes: 5+n }; }
      case 0xdc: return inspectArray(reader.readUInt16(), depth, 3);
      case 0xdd: return inspectArray(reader.readUInt32(), depth, 5);
      case 0xde: return inspectMap(reader.readUInt16(), depth, 3);
      case 0xdf: return inspectMap(reader.readUInt32(), depth, 5);
      default:   throw new ToolError("msgpack_client inspect: unknown format byte 0x" + byte.toString(16).padStart(2, "0") + " at offset " + (reader.pos - 1) + ".", -32602);
    }
  }

  function inspectArray(count, depth, headerBytes) {
    const node = { type: "array", count, bytes: headerBytes };
    if (depth < md) {
      node.items = [];
      for (let i = 0; i < count; i++) {
        const item = inspectNode(depth + 1);
        node.bytes += (item.bytes || 0);
        node.items.push(item);
      }
    } else {
      // Skip contents
      for (let i = 0; i < count; i++) {
        const item = inspectNode(depth + 1);
        node.bytes += (item.bytes || 0);
      }
      node.truncated = true;
    }
    return node;
  }

  function inspectMap(count, depth, headerBytes) {
    const node = { type: "map", count, bytes: headerBytes };
    if (depth < md) {
      node.entries = [];
      for (let i = 0; i < count; i++) {
        const k = inspectNode(depth + 1);
        const v = inspectNode(depth + 1);
        node.bytes += (k.bytes || 0) + (v.bytes || 0);
        node.entries.push({ key: k, value: v });
      }
    } else {
      for (let i = 0; i < count; i++) {
        const k = inspectNode(depth + 1);
        const v = inspectNode(depth + 1);
        node.bytes += (k.bytes || 0) + (v.bytes || 0);
      }
      node.truncated = true;
    }
    return node;
  }

  const tree = inspectNode(0);
  return { totalBytes: buf.length, tree };
}

// ── Helpers for serializing decoded values to JSON-safe form ─────────────────

function toJsonSafe(value) {
  if (Buffer.isBuffer(value))
    return { __bin: value.toString("base64"), length: value.length };
  if (typeof value === "bigint")
    return value.toString();
  if (Array.isArray(value))
    return value.map(toJsonSafe);
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

// ── Path validation ──────────────────────────────────────────────────────────

function validatePath(p, op) {
  if (!p || p.includes("\0"))
    throw new ToolError("msgpack_client " + op + ": path contains NUL byte.", -32602);
}

function validateFileSize(absPath, op) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory())
    throw new ToolError("msgpack_client " + op + ": path is a directory.", -32602);
  if (stat.size > MAX_INPUT_BYTES)
    throw new ToolError("msgpack_client " + op + ": file too large (" + stat.size + " bytes; max " + MAX_INPUT_BYTES + ").", -32602);
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * encode — encode a JSON value (provided inline or via json_file) to MessagePack.
 */
function opEncode(args, resolveClientPath) {
  let value;
  if (args.json_file) {
    validatePath(args.json_file, "encode");
    const { resolved } = resolveClientPath(args.json_file);
    validateFileSize(resolved, "encode");
    const src = fs.readFileSync(resolved, "utf8");
    try { value = JSON.parse(src); }
    catch (e) { throw new ToolError("msgpack_client encode: json_file is not valid JSON — " + e.message, -32602); }
  } else if (args.value !== undefined) {
    value = args.value;
  } else {
    throw new ToolError("msgpack_client encode: 'value' or 'json_file' is required.", -32602);
  }

  const encoded = encode(value, 0);

  if (args.output_file) {
    validatePath(args.output_file, "encode");
    const { resolved: absOut } = resolveClientPath(args.output_file);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, encoded);
    return {
      operation:  "encode",
      outputFile: args.output_file,
      sizeBytes:  encoded.length,
      hex:        args.include_hex ? encoded.toString("hex") : undefined,
      base64:     args.include_base64 ? encoded.toString("base64") : undefined,
    };
  }

  // Return inline
  return {
    operation:  "encode",
    sizeBytes:  encoded.length,
    hex:        encoded.toString("hex"),
    base64:     encoded.toString("base64"),
  };
}

/**
 * decode — decode MessagePack bytes (provided as hex, base64, or from a file).
 */
function opDecode(args, resolveClientPath) {
  let buf;

  if (args.input_file) {
    validatePath(args.input_file, "decode");
    const { resolved } = resolveClientPath(args.input_file);
    validateFileSize(resolved, "decode");
    buf = fs.readFileSync(resolved);
  } else if (args.hex) {
    const hexStr = args.hex.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hexStr) || hexStr.length % 2 !== 0)
      throw new ToolError("msgpack_client decode: 'hex' must be a valid even-length hex string.", -32602);
    buf = Buffer.from(hexStr, "hex");
  } else if (args.base64 !== undefined) {
    if (args.base64 === "")
      throw new ToolError("msgpack_client decode: input is empty.", -32602);
    buf = Buffer.from(args.base64, "base64");
  } else {
    throw new ToolError("msgpack_client decode: 'input_file', 'hex', or 'base64' is required.", -32602);
  }

  if (buf.length === 0)
    throw new ToolError("msgpack_client decode: input is empty.", -32602);
  if (buf.length > MAX_INPUT_BYTES)
    throw new ToolError("msgpack_client decode: input too large (" + buf.length + " bytes; max " + MAX_INPUT_BYTES + ").", -32602);

  const allowMultiple = !!args.allow_multiple;
  const decoded = decodeBuffer(buf, allowMultiple);
  const jsonSafe = toJsonSafe(decoded);

  return {
    operation:     "decode",
    inputBytes:    buf.length,
    allowMultiple,
    value:         jsonSafe,
  };
}

/**
 * encode_file — read a JSON file, encode to MessagePack, write to output.
 */
function opEncodeFile(args, resolveClientPath) {
  if (!args.path)   throw new ToolError("msgpack_client encode_file: 'path' (JSON input) is required.", -32602);
  if (!args.output) throw new ToolError("msgpack_client encode_file: 'output' (msgpack output path) is required.", -32602);

  validatePath(args.path, "encode_file");
  validatePath(args.output, "encode_file");
  const { resolved: absIn  } = resolveClientPath(args.path);
  const { resolved: absOut } = resolveClientPath(args.output);
  validateFileSize(absIn, "encode_file");

  const src = fs.readFileSync(absIn, "utf8");
  let value;
  try { value = JSON.parse(src); }
  catch (e) { throw new ToolError("msgpack_client encode_file: input is not valid JSON — " + e.message, -32602); }

  const encoded = encode(value, 0);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, encoded);

  return {
    operation:   "encode_file",
    inputPath:   args.path,
    outputPath:  args.output,
    inputBytes:  Buffer.byteLength(src, "utf8"),
    outputBytes: encoded.length,
    ratio:       (encoded.length / Buffer.byteLength(src, "utf8")).toFixed(3),
  };
}

/**
 * decode_file — read a MessagePack file, decode to JSON, optionally write JSON output.
 */
function opDecodeFile(args, resolveClientPath) {
  if (!args.path) throw new ToolError("msgpack_client decode_file: 'path' (msgpack input) is required.", -32602);

  validatePath(args.path, "decode_file");
  const { resolved: absIn } = resolveClientPath(args.path);
  validateFileSize(absIn, "decode_file");

  const buf = fs.readFileSync(absIn);
  if (buf.length === 0) throw new ToolError("msgpack_client decode_file: input file is empty.", -32602);

  const allowMultiple = !!args.allow_multiple;
  const decoded = decodeBuffer(buf, allowMultiple);
  const jsonSafe = toJsonSafe(decoded);
  const jsonStr = JSON.stringify(jsonSafe, null, args.pretty ? 2 : undefined);

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
      allowMultiple,
    };
  }

  return {
    operation:    "decode_file",
    inputPath:    args.path,
    inputBytes:   buf.length,
    allowMultiple,
    value:        jsonSafe,
  };
}

/**
 * inspect — return the type tree of a MessagePack buffer without fully decoding it.
 */
function opInspect(args, resolveClientPath) {
  let buf;

  if (args.input_file) {
    validatePath(args.input_file, "inspect");
    const { resolved } = resolveClientPath(args.input_file);
    validateFileSize(resolved, "inspect");
    buf = fs.readFileSync(resolved);
  } else if (args.hex) {
    const hexStr = args.hex.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hexStr) || hexStr.length % 2 !== 0)
      throw new ToolError("msgpack_client inspect: 'hex' must be a valid even-length hex string.", -32602);
    buf = Buffer.from(hexStr, "hex");
  } else if (args.base64) {
    buf = Buffer.from(args.base64, "base64");
  } else {
    throw new ToolError("msgpack_client inspect: 'input_file', 'hex', or 'base64' is required.", -32602);
  }

  if (buf.length === 0) throw new ToolError("msgpack_client inspect: input is empty.", -32602);

  const { totalBytes, tree } = inspectBuffer(buf, args.max_depth);
  return {
    operation:  "inspect",
    totalBytes,
    tree,
  };
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

function msgpackClient(args, resolveClientPath) {
  const op = args.operation;
  if (!op) throw new ToolError("msgpack_client: 'operation' is required.", -32602);

  const VALID_OPS = ["encode", "decode", "encode_file", "decode_file", "inspect"];
  if (!VALID_OPS.includes(op))
    throw new ToolError("msgpack_client: unknown operation '" + op + "'. Valid: " + VALID_OPS.join(", ") + ".", -32602);

  switch (op) {
    case "encode":      return opEncode(args, resolveClientPath);
    case "decode":      return opDecode(args, resolveClientPath);
    case "encode_file": return opEncodeFile(args, resolveClientPath);
    case "decode_file": return opDecodeFile(args, resolveClientPath);
    case "inspect":     return opInspect(args, resolveClientPath);
  }
}

module.exports = { msgpackClient, encode, decodeBuffer, inspectBuffer };
