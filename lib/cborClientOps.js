"use strict";
// lib/cborClientOps.js — cbor_client tool
// Zero-dependency CBOR (RFC 8949) encoder/decoder (pure Node.js; no npm deps).
// Reference: https://www.rfc-editor.org/rfc/rfc8949
// Operations: encode, decode, encode_file, decode_file, inspect

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_BYTES  = 50 * 1024 * 1024; // 50 MB
const MAX_DEPTH       = 100;              // nesting depth guard
const MAX_ELEMENTS    = 1_000_000;        // total item limit

// ── CBOR Major Types ─────────────────────────────────────────────────────────
// MT 0: unsigned int
// MT 1: negative int  (value = -1 - n)
// MT 2: byte string
// MT 3: text string
// MT 4: array
// MT 5: map
// MT 6: tag
// MT 7: float / simple

// ── Encoder ──────────────────────────────────────────────────────────────────

function encodeHead(mt, value) {
  // mt: 0-7, value: the argument (uint)
  const prefix = mt << 5;
  if (value <= 23)         return Buffer.from([prefix | value]);
  if (value <= 0xff)       return Buffer.from([prefix | 24, value]);
  if (value <= 0xffff)     { const b = Buffer.alloc(3); b[0]=prefix|25; b.writeUInt16BE(value,1); return b; }
  if (value <= 0xffffffff) { const b = Buffer.alloc(5); b[0]=prefix|26; b.writeUInt32BE(value,1); return b; }
  // 64-bit — use BigInt path
  const b = Buffer.alloc(9); b[0]=prefix|27;
  const v = BigInt(value);
  b.writeUInt32BE(Number(v >> 32n) >>> 0, 1);
  b.writeUInt32BE(Number(v & 0xffffffffn) >>> 0, 5);
  return b;
}

function encodeHeadBig(mt, value) {
  // value is BigInt
  const prefix = mt << 5;
  const b = Buffer.alloc(9); b[0]=prefix|27;
  b.writeUInt32BE(Number(value >> 32n) >>> 0, 1);
  b.writeUInt32BE(Number(value & 0xffffffffn) >>> 0, 5);
  return b;
}

function encode(value, depth, elementCount) {
  if ((depth || 0) > MAX_DEPTH)
    throw new ToolError("cbor_client encode: nesting depth exceeds limit (" + MAX_DEPTH + ").", -32602);
  if (!elementCount) elementCount = { n: 0 };
  elementCount.n++;
  if (elementCount.n > MAX_ELEMENTS)
    throw new ToolError("cbor_client encode: element count limit exceeded (" + MAX_ELEMENTS + ").", -32602);

  const d = (depth || 0) + 1;

  // null / undefined → CBOR null (simple 22)
  if (value === null || value === undefined)
    return Buffer.from([0xf6]);

  // Boolean
  if (value === true)  return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);

  // BigInt
  if (typeof value === "bigint") {
    return encodeBigInt(value);
  }

  // Number
  if (typeof value === "number") {
    return encodeNumber(value);
  }

  // String
  if (typeof value === "string") {
    return encodeText(value);
  }

  // Buffer / Uint8Array → byte string
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([encodeHead(2, buf.length), buf]);
  }

  // Array
  if (Array.isArray(value)) {
    if (value.length > MAX_ELEMENTS)
      throw new ToolError("cbor_client encode: array too large (" + value.length + " elements; max " + MAX_ELEMENTS + ").", -32602);
    const parts = [encodeHead(4, value.length)];
    for (const item of value) parts.push(encode(item, d, elementCount));
    return Buffer.concat(parts);
  }

  // Map (plain object)
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > MAX_ELEMENTS)
      throw new ToolError("cbor_client encode: map too large (" + keys.length + " keys; max " + MAX_ELEMENTS + ").", -32602);
    const parts = [encodeHead(5, keys.length)];
    for (const k of keys) {
      parts.push(encodeText(k));
      parts.push(encode(value[k], d, elementCount));
    }
    return Buffer.concat(parts);
  }

  // Fallback: encode as text
  return encodeText(String(value));
}

function encodeText(s) {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([encodeHead(3, bytes.length), bytes]);
}

function encodeNumber(n) {
  // NaN → 0xf97e00 (float16 NaN)
  if (Number.isNaN(n)) return Buffer.from([0xf9, 0x7e, 0x00]);
  // Infinity
  if (!Number.isFinite(n)) {
    return n > 0
      ? Buffer.from([0xf9, 0x7c, 0x00])  // +Infinity float16
      : Buffer.from([0xf9, 0xfc, 0x00]); // -Infinity float16
  }
  // Integer
  if (Number.isInteger(n)) {
    if (n >= 0) {
      return encodeHead(0, n); // MT0 unsigned
    } else {
      // MT1 negative: value = -1 - n, so -1 maps to 0
      const neg = -1 - n;
      if (neg <= 0xffffffff) return encodeHead(1, neg);
      // large negative: use bignum tag
      return encodeHead(1, neg);
    }
  }
  // Float64
  const b = Buffer.alloc(9);
  b[0] = 0xfb; // float64
  b.writeDoubleBE(n, 1);
  return b;
}

function encodeBigInt(n) {
  if (n >= 0n) {
    // tag 2: unsigned bignum
    const hex = n.toString(16);
    const padded = hex.length % 2 === 0 ? hex : "0" + hex;
    const bytes = Buffer.from(padded, "hex");
    return Buffer.concat([
      Buffer.from([0xc2]),          // tag(2)
      encodeHead(2, bytes.length),  // bytes header
      bytes
    ]);
  } else {
    // tag 3: negative bignum — value = -1 - n (so n=-1 → 0)
    const m = -1n - n;
    const hex = m.toString(16);
    const padded = hex.length % 2 === 0 ? hex : "0" + hex;
    const bytes = Buffer.from(padded, "hex");
    return Buffer.concat([
      Buffer.from([0xc3]),          // tag(3)
      encodeHead(2, bytes.length),
      bytes
    ]);
  }
}

// ── Decoder ──────────────────────────────────────────────────────────────────

class CborReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
    this._elements = 0;
  }

  remaining() { return this.buf.length - this.pos; }

  readByte() {
    if (this.pos >= this.buf.length)
      throw new ToolError("cbor_client decode: unexpected end of data at offset " + this.pos + ".", -32602);
    return this.buf[this.pos++];
  }

  readBytes(n) {
    if (this.pos + n > this.buf.length)
      throw new ToolError("cbor_client decode: unexpected end of data reading " + n + " bytes at offset " + this.pos + ".", -32602);
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  trackElement() {
    this._elements++;
    if (this._elements > MAX_ELEMENTS)
      throw new ToolError("cbor_client decode: element count limit exceeded (" + MAX_ELEMENTS + ").", -32602);
  }

  // Read argument value for a given additional info byte
  readArgument(ai) {
    if (ai <= 23)  return ai;
    if (ai === 24) return this.readBytes(1).readUInt8(0);
    if (ai === 25) return this.readBytes(2).readUInt16BE(0);
    if (ai === 26) return this.readBytes(4).readUInt32BE(0);
    if (ai === 27) {
      const hi = this.readBytes(4).readUInt32BE(0);
      const lo = this.readBytes(4).readUInt32BE(0);
      const v = BigInt(hi) * 0x100000000n + BigInt(lo);
      // Return number if fits safely
      if (v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
      return v;
    }
    if (ai === 31) return -1; // indefinite length sentinel
    throw new ToolError("cbor_client decode: reserved additional info " + ai + " at offset " + (this.pos - 1) + ".", -32602);
  }

  decode(depth) {
    if ((depth || 0) > MAX_DEPTH)
      throw new ToolError("cbor_client decode: nesting depth exceeds limit (" + MAX_DEPTH + ").", -32602);
    this.trackElement();

    const byte = this.readByte();
    const mt = byte >> 5;   // major type 0-7
    const ai = byte & 0x1f; // additional info
    const d = (depth || 0) + 1;

    switch (mt) {
      case 0: { // unsigned int
        return this.readArgument(ai);
      }

      case 1: { // negative int: value = -1 - n
        const n = this.readArgument(ai);
        if (typeof n === "bigint") return -1n - n;
        return -1 - n;
      }

      case 2: { // byte string
        if (ai === 31) return this.decodeIndefiniteBytes();
        const len = this.readArgument(ai);
        return this.readBytes(typeof len === "bigint" ? Number(len) : len);
      }

      case 3: { // text string
        if (ai === 31) return this.decodeIndefiniteText();
        const len = this.readArgument(ai);
        return this.readBytes(typeof len === "bigint" ? Number(len) : len).toString("utf8");
      }

      case 4: { // array
        if (ai === 31) return this.decodeIndefiniteArray(d);
        const len = this.readArgument(ai);
        return this.decodeArray(typeof len === "bigint" ? Number(len) : len, d);
      }

      case 5: { // map
        if (ai === 31) return this.decodeIndefiniteMap(d);
        const len = this.readArgument(ai);
        return this.decodeMap(typeof len === "bigint" ? Number(len) : len, d);
      }

      case 6: { // tag
        const tagNum = this.readArgument(ai);
        const tagVal = this.decode(d);
        return this.applyTag(tagNum, tagVal);
      }

      case 7: { // float / simple
        return this.decodeSimpleOrFloat(ai);
      }
    }
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

  decodeIndefiniteBytes() {
    const chunks = [];
    for (;;) {
      const b = this.readByte();
      if (b === 0xff) break; // break code
      const mt = b >> 5;
      const ai = b & 0x1f;
      if (mt !== 2)
        throw new ToolError("cbor_client decode: indefinite byte string chunk has wrong major type at offset " + (this.pos - 1) + ".", -32602);
      const len = this.readArgument(ai);
      chunks.push(this.readBytes(typeof len === "bigint" ? Number(len) : len));
    }
    return Buffer.concat(chunks);
  }

  decodeIndefiniteText() {
    const parts = [];
    for (;;) {
      const b = this.readByte();
      if (b === 0xff) break;
      const mt = b >> 5;
      const ai = b & 0x1f;
      if (mt !== 3)
        throw new ToolError("cbor_client decode: indefinite text string chunk has wrong major type at offset " + (this.pos - 1) + ".", -32602);
      const len = this.readArgument(ai);
      parts.push(this.readBytes(typeof len === "bigint" ? Number(len) : len).toString("utf8"));
    }
    return parts.join("");
  }

  decodeIndefiniteArray(depth) {
    const arr = [];
    for (;;) {
      if (this.remaining() === 0)
        throw new ToolError("cbor_client decode: missing break code for indefinite array.", -32602);
      if (this.buf[this.pos] === 0xff) { this.pos++; break; }
      arr.push(this.decode(depth));
    }
    return arr;
  }

  decodeIndefiniteMap(depth) {
    const obj = Object.create(null);
    for (;;) {
      if (this.remaining() === 0)
        throw new ToolError("cbor_client decode: missing break code for indefinite map.", -32602);
      if (this.buf[this.pos] === 0xff) { this.pos++; break; }
      const key = this.decode(depth);
      const val = this.decode(depth);
      obj[String(key)] = val;
    }
    return obj;
  }

  applyTag(tagNum, value) {
    const t = typeof tagNum === "bigint" ? tagNum : BigInt(tagNum);
    // Tag 2: unsigned bignum — value is a Buffer of big-endian bytes
    if (t === 2n) {
      if (!Buffer.isBuffer(value))
        throw new ToolError("cbor_client decode: tag 2 (unsigned bignum) expected byte string.", -32602);
      let v = 0n;
      for (const byte of value) v = (v << 8n) | BigInt(byte);
      return v;
    }
    // Tag 3: negative bignum
    if (t === 3n) {
      if (!Buffer.isBuffer(value))
        throw new ToolError("cbor_client decode: tag 3 (negative bignum) expected byte string.", -32602);
      let v = 0n;
      for (const byte of value) v = (v << 8n) | BigInt(byte);
      return -1n - v;
    }
    // All other tags: return as annotated object preserving the value
    return { __tag: typeof tagNum === "bigint" ? tagNum.toString() : tagNum, value };
  }

  decodeSimpleOrFloat(ai) {
    switch (ai) {
      case 20: return false;
      case 21: return true;
      case 22: return null;
      case 23: return undefined; // "undefined" simple value
      case 24: { // simple value (one-byte)
        const v = this.readBytes(1).readUInt8(0);
        return { __simple: v };
      }
      case 25: return this.readFloat16();
      case 26: return this.readBytes(4).readFloatBE(0);
      case 27: return this.readBytes(8).readDoubleBE(0);
      case 31: throw new ToolError("cbor_client decode: unexpected break code 0xff outside indefinite-length item.", -32602);
      default:
        if (ai <= 19) return { __simple: ai };
        throw new ToolError("cbor_client decode: reserved simple value additional info " + ai + " at offset " + (this.pos - 1) + ".", -32602);
    }
  }

  readFloat16() {
    const b = this.readBytes(2);
    const raw = b.readUInt16BE(0);
    const sign  = (raw >> 15) & 1;
    const exp   = (raw >> 10) & 0x1f;
    const frac  = raw & 0x3ff;
    if (exp === 0x1f) {
      if (frac === 0) return sign ? -Infinity : Infinity;
      return NaN;
    }
    const m = exp === 0 ? frac / 1024.0 : (frac / 1024.0 + 1.0);
    const e = exp === 0 ? -14 : exp - 15;
    return (sign ? -1 : 1) * m * Math.pow(2, e);
  }
}

function decodeBuffer(buf, allowMultiple) {
  const reader = new CborReader(buf);
  if (!allowMultiple) {
    const value = reader.decode(0);
    if (reader.remaining() > 0)
      throw new ToolError(
        "cbor_client decode: " + reader.remaining() + " trailing bytes after first value. Use allow_multiple to decode a stream.",
        -32602
      );
    return value;
  }
  const values = [];
  while (reader.remaining() > 0) values.push(reader.decode(0));
  return values;
}

// ── Inspector ─────────────────────────────────────────────────────────────────

function inspectBuffer(buf, maxDepth) {
  const reader = new CborReader(buf);
  const md = maxDepth == null ? 3 : Math.max(1, Math.min(10, Number(maxDepth)));

  function inspectNode(depth) {
    if (reader.remaining() === 0) return { type: "eof", bytes: 0 };
    const startPos = reader.pos;
    const byte = reader.readByte();
    const mt = byte >> 5;
    const ai = byte & 0x1f;

    function argBytes() {
      if (ai <= 23)  return 0;
      if (ai === 24) return 1;
      if (ai === 25) return 2;
      if (ai === 26) return 4;
      if (ai === 27) return 8;
      return 0;
    }

    function readArgNoTrack() {
      if (ai <= 23) return ai;
      if (ai === 24) return reader.readBytes(1).readUInt8(0);
      if (ai === 25) return reader.readBytes(2).readUInt16BE(0);
      if (ai === 26) return reader.readBytes(4).readUInt32BE(0);
      if (ai === 27) {
        const hi = reader.readBytes(4).readUInt32BE(0);
        const lo = reader.readBytes(4).readUInt32BE(0);
        return Number(BigInt(hi) * 0x100000000n + BigInt(lo));
      }
      if (ai === 31) return -1;
      return 0;
    }

    const mtNames = ["uint", "negint", "bytes", "text", "array", "map", "tag", "special"];
    const typeName = mtNames[mt] || "unknown";

    switch (mt) {
      case 0: { const v = readArgNoTrack(); return { type: "uint", value: v, bytes: reader.pos - startPos }; }
      case 1: { const v = readArgNoTrack(); return { type: "negint", value: -1 - v, bytes: reader.pos - startPos }; }
      case 2: {
        if (ai === 31) {
          const node = { type: "bytes", indefinite: true, bytes: 1 };
          const chunks = [];
          for (;;) {
            if (reader.remaining() === 0) break;
            if (reader.buf[reader.pos] === 0xff) { reader.pos++; node.bytes++; break; }
            const cb = reader.readByte();
            const cl = reader.readArgument(cb & 0x1f);
            const cn = typeof cl === "bigint" ? Number(cl) : cl;
            reader.readBytes(cn);
            node.bytes += 1 + argBytes() + cn;
            chunks.push(cn);
          }
          node.chunkSizes = chunks;
          return node;
        }
        const len = readArgNoTrack();
        reader.readBytes(len);
        return { type: "bytes", length: len, bytes: reader.pos - startPos };
      }
      case 3: {
        if (ai === 31) {
          const node = { type: "text", indefinite: true, bytes: 1 };
          const chunks = [];
          for (;;) {
            if (reader.remaining() === 0) break;
            if (reader.buf[reader.pos] === 0xff) { reader.pos++; node.bytes++; break; }
            const cb = reader.readByte();
            const cl = reader.readArgument(cb & 0x1f);
            const cn = typeof cl === "bigint" ? Number(cl) : cl;
            reader.readBytes(cn);
            node.bytes += 1 + argBytes() + cn;
            chunks.push(cn);
          }
          node.chunkSizes = chunks;
          return node;
        }
        const len = readArgNoTrack();
        reader.readBytes(len);
        return { type: "text", length: len, bytes: reader.pos - startPos };
      }
      case 4: {
        if (ai === 31) {
          const node = { type: "array", indefinite: true, bytes: 1 };
          if (depth < md) {
            node.items = [];
            for (;;) {
              if (reader.remaining() === 0) break;
              if (reader.buf[reader.pos] === 0xff) { reader.pos++; node.bytes++; break; }
              const item = inspectNode(depth + 1);
              node.bytes += item.bytes || 0;
              node.items.push(item);
            }
            node.count = node.items.length;
          } else {
            node.truncated = true;
            let count = 0;
            for (;;) {
              if (reader.remaining() === 0) break;
              if (reader.buf[reader.pos] === 0xff) { reader.pos++; break; }
              const item = inspectNode(depth + 1);
              node.bytes += item.bytes || 0;
              count++;
            }
            node.count = count;
          }
          return node;
        }
        const len = readArgNoTrack();
        const node = { type: "array", count: len, bytes: reader.pos - startPos };
        if (depth < md) {
          node.items = [];
          for (let i = 0; i < len; i++) {
            const item = inspectNode(depth + 1);
            node.bytes += item.bytes || 0;
            node.items.push(item);
          }
        } else {
          for (let i = 0; i < len; i++) {
            const item = inspectNode(depth + 1);
            node.bytes += item.bytes || 0;
          }
          node.truncated = true;
        }
        return node;
      }
      case 5: {
        if (ai === 31) {
          const node = { type: "map", indefinite: true, bytes: 1 };
          if (depth < md) {
            node.entries = [];
            for (;;) {
              if (reader.remaining() === 0) break;
              if (reader.buf[reader.pos] === 0xff) { reader.pos++; node.bytes++; break; }
              const k = inspectNode(depth + 1);
              const v = inspectNode(depth + 1);
              node.bytes += (k.bytes || 0) + (v.bytes || 0);
              node.entries.push({ key: k, value: v });
            }
            node.count = node.entries.length;
          } else {
            node.truncated = true;
            let count = 0;
            for (;;) {
              if (reader.remaining() === 0) break;
              if (reader.buf[reader.pos] === 0xff) { reader.pos++; break; }
              const k = inspectNode(depth + 1);
              const v = inspectNode(depth + 1);
              node.bytes += (k.bytes || 0) + (v.bytes || 0);
              count++;
            }
            node.count = count;
          }
          return node;
        }
        const len = readArgNoTrack();
        const node = { type: "map", count: len, bytes: reader.pos - startPos };
        if (depth < md) {
          node.entries = [];
          for (let i = 0; i < len; i++) {
            const k = inspectNode(depth + 1);
            const v = inspectNode(depth + 1);
            node.bytes += (k.bytes || 0) + (v.bytes || 0);
            node.entries.push({ key: k, value: v });
          }
        } else {
          for (let i = 0; i < len; i++) {
            const k = inspectNode(depth + 1);
            const v = inspectNode(depth + 1);
            node.bytes += (k.bytes || 0) + (v.bytes || 0);
          }
          node.truncated = true;
        }
        return node;
      }
      case 6: {
        const tagNum = readArgNoTrack();
        const inner = inspectNode(depth + 1);
        return { type: "tag", tag: tagNum, inner, bytes: (reader.pos - startPos) };
      }
      case 7: {
        if (ai === 20) return { type: "bool", value: false, bytes: 1 };
        if (ai === 21) return { type: "bool", value: true,  bytes: 1 };
        if (ai === 22) return { type: "null",  bytes: 1 };
        if (ai === 23) return { type: "undefined", bytes: 1 };
        if (ai === 24) { reader.readBytes(1); return { type: "simple", bytes: 2 }; }
        if (ai === 25) { reader.readBytes(2); return { type: "float16", bytes: 3 }; }
        if (ai === 26) { reader.readBytes(4); return { type: "float32", bytes: 5 }; }
        if (ai === 27) { reader.readBytes(8); return { type: "float64", bytes: 9 }; }
        if (ai === 31) throw new ToolError("cbor_client inspect: unexpected break code at top level.", -32602);
        return { type: "simple", ai, bytes: 1 };
      }
      default:
        throw new ToolError("cbor_client inspect: unknown major type " + mt + " at offset " + startPos + ".", -32602);
    }
  }

  const tree = inspectNode(0);
  return { totalBytes: buf.length, tree };
}

// ── JSON-safe conversion ──────────────────────────────────────────────────────

function toJsonSafe(value) {
  if (value === undefined) return null; // CBOR undefined → null in JSON
  if (Buffer.isBuffer(value))
    return { __bytes: value.toString("base64"), length: value.length };
  if (typeof value === "bigint")
    return { __bigint: value.toString() };
  if (Array.isArray(value))
    return value.map(toJsonSafe);
  if (value !== null && typeof value === "object") {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

// ── Path validation ──────────────────────────────────────────────────────────

function validatePath(p, op) {
  if (!p || p.includes("\0"))
    throw new ToolError("cbor_client " + op + ": path contains NUL byte.", -32602);
}

function validateFileSize(absPath, op) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory())
    throw new ToolError("cbor_client " + op + ": path is a directory.", -32602);
  if (stat.size > MAX_FILE_BYTES)
    throw new ToolError("cbor_client " + op + ": file too large (" + stat.size + " bytes; max " + MAX_FILE_BYTES + ").", -32602);
}

// ── Operations ───────────────────────────────────────────────────────────────

function opEncode(args, resolveClientPath) {
  let value;
  if (args.json_file) {
    validatePath(args.json_file, "encode");
    const { resolved } = resolveClientPath(args.json_file);
    validateFileSize(resolved, "encode");
    const src = fs.readFileSync(resolved, "utf8");
    try { value = JSON.parse(src); }
    catch (e) { throw new ToolError("cbor_client encode: json_file is not valid JSON — " + e.message, -32602); }
  } else if (args.value !== undefined) {
    value = args.value;
  } else {
    throw new ToolError("cbor_client encode: 'value' or 'json_file' is required.", -32602);
  }

  const encoded = encode(value, 0);

  if (args.output_file) {
    validatePath(args.output_file, "encode");
    const { resolved: absOut } = resolveClientPath(args.output_file);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, encoded);
    return {
      operation: "encode",
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
  let buf;

  if (args.input_file) {
    validatePath(args.input_file, "decode");
    const { resolved } = resolveClientPath(args.input_file);
    validateFileSize(resolved, "decode");
    buf = fs.readFileSync(resolved);
  } else if (args.hex !== undefined) {
    if (args.hex === "")
      throw new ToolError("cbor_client decode: input is empty.", -32602);
    const hexStr = args.hex.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hexStr) || hexStr.length % 2 !== 0)
      throw new ToolError("cbor_client decode: 'hex' must be a valid even-length hex string.", -32602);
    buf = Buffer.from(hexStr, "hex");
  } else if (args.base64 !== undefined) {
    if (args.base64 === "")
      throw new ToolError("cbor_client decode: input is empty.", -32602);
    buf = Buffer.from(args.base64, "base64");
  } else {
    throw new ToolError("cbor_client decode: 'input_file', 'hex', or 'base64' is required.", -32602);
  }

  if (buf.length === 0)
    throw new ToolError("cbor_client decode: input is empty.", -32602);
  if (buf.length > MAX_FILE_BYTES)
    throw new ToolError("cbor_client decode: input too large (" + buf.length + " bytes; max " + MAX_FILE_BYTES + ").", -32602);

  const allowMultiple = !!args.allow_multiple;
  const decoded = decodeBuffer(buf, allowMultiple);
  const jsonSafe = toJsonSafe(decoded);

  return { operation: "decode", inputBytes: buf.length, allowMultiple, value: jsonSafe };
}

function opEncodeFile(args, resolveClientPath) {
  if (!args.path)   throw new ToolError("cbor_client encode_file: 'path' (JSON input) is required.", -32602);
  if (!args.output) throw new ToolError("cbor_client encode_file: 'output' (CBOR output path) is required.", -32602);

  validatePath(args.path, "encode_file");
  validatePath(args.output, "encode_file");
  const { resolved: absIn  } = resolveClientPath(args.path);
  const { resolved: absOut } = resolveClientPath(args.output);
  validateFileSize(absIn, "encode_file");

  const src = fs.readFileSync(absIn, "utf8");
  let value;
  try { value = JSON.parse(src); }
  catch (e) { throw new ToolError("cbor_client encode_file: input is not valid JSON — " + e.message, -32602); }

  const encoded = encode(value, 0);
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
  if (!args.path) throw new ToolError("cbor_client decode_file: 'path' (CBOR input) is required.", -32602);

  validatePath(args.path, "decode_file");
  const { resolved: absIn } = resolveClientPath(args.path);
  validateFileSize(absIn, "decode_file");

  const buf = fs.readFileSync(absIn);
  if (buf.length === 0)
    throw new ToolError("cbor_client decode_file: input file is empty.", -32602);

  const allowMultiple = !!args.allow_multiple;
  const decoded  = decodeBuffer(buf, allowMultiple);
  const jsonSafe = toJsonSafe(decoded);
  const jsonStr  = JSON.stringify(jsonSafe, null, args.pretty ? 2 : undefined);

  if (args.output) {
    validatePath(args.output, "decode_file");
    const { resolved: absOut } = resolveClientPath(args.output);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, jsonStr, "utf8");
    return {
      operation:    "decode_file",
      inputPath:    args.path,
      outputPath:   args.output,
      inputBytes:   buf.length,
      outputBytes:  Buffer.byteLength(jsonStr, "utf8"),
      allowMultiple,
    };
  }

  return { operation: "decode_file", inputPath: args.path, inputBytes: buf.length, allowMultiple, value: jsonSafe };
}

function opInspect(args, resolveClientPath) {
  let buf;

  if (args.input_file) {
    validatePath(args.input_file, "inspect");
    const { resolved } = resolveClientPath(args.input_file);
    validateFileSize(resolved, "inspect");
    buf = fs.readFileSync(resolved);
  } else if (args.hex !== undefined) {
    if (args.hex === "")
      throw new ToolError("cbor_client inspect: input is empty.", -32602);
    const hexStr = args.hex.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hexStr) || hexStr.length % 2 !== 0)
      throw new ToolError("cbor_client inspect: 'hex' must be a valid even-length hex string.", -32602);
    buf = Buffer.from(hexStr, "hex");
  } else if (args.base64 !== undefined) {
    if (args.base64 === "")
      throw new ToolError("cbor_client inspect: input is empty.", -32602);
    buf = Buffer.from(args.base64, "base64");
  } else {
    throw new ToolError("cbor_client inspect: 'input_file', 'hex', or 'base64' is required.", -32602);
  }

  if (buf.length === 0)
    throw new ToolError("cbor_client inspect: input is empty.", -32602);

  const { totalBytes, tree } = inspectBuffer(buf, args.max_depth);
  return { operation: "inspect", totalBytes, tree };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

function cborClient(args, resolveClientPath) {
  const op = args.operation;
  if (!op) throw new ToolError("cbor_client: 'operation' is required.", -32602);

  const VALID_OPS = ["encode", "decode", "encode_file", "decode_file", "inspect"];
  if (!VALID_OPS.includes(op))
    throw new ToolError("cbor_client: unknown operation '" + op + "'. Valid: " + VALID_OPS.join(", ") + ".", -32602);

  switch (op) {
    case "encode":      return opEncode(args, resolveClientPath);
    case "decode":      return opDecode(args, resolveClientPath);
    case "encode_file": return opEncodeFile(args, resolveClientPath);
    case "decode_file": return opDecodeFile(args, resolveClientPath);
    case "inspect":     return opInspect(args, resolveClientPath);
  }
}

module.exports = { cborClient, encode, decodeBuffer, inspectBuffer };
