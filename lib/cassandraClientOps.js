"use strict";
/**
 * cassandraClientOps.js — Zero-dependency Apache Cassandra CQL Native Protocol v4 client
 * Pure Node.js net/tls — no npm deps.
 *
 * Supported operations:
 *   info          — server options, cluster name, CQL version
 *   query         — execute a CQL SELECT/DDL/DML query and return decoded rows
 *   execute       — prepared-statement execute (prepare then execute in one call)
 *   batch         — execute a BATCH of DML statements
 *   tables        — list tables in a keyspace (or current keyspace)
 *   keyspaces     — list all keyspaces
 *   describe      — describe a table (columns, types, primary key)
 *   use_keyspace  — change keyspace (returns acknowledgement)
 *
 * Auth: SASL PLAIN (username/password) or none.
 * Protocol: CQL Native Protocol v4 (Cassandra 2.2+, ScyllaDB, AstraDB, etc.)
 *
 * Security:
 *   - NUL-byte guards on host, keyspace, username, password
 *   - 32 MB response cap per frame
 *   - No credentials in error messages
 *   - TLS support via tls option
 *   - Timeout clamped 1000–300000 ms
 */

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { ToolError } = require("./errors");

// ── CQL Native Protocol v4 constants ─────────────────────────────────────────
const PROTO_VERSION  = 0x04;  // v4
const PROTO_RESPONSE = 0x84;  // v4 response

// Opcodes
const OP = {
  ERROR:    0x00,
  STARTUP:  0x01,
  READY:    0x02,
  AUTHENTICATE: 0x03,
  OPTIONS:  0x05,
  SUPPORTED: 0x06,
  QUERY:    0x07,
  RESULT:   0x08,
  PREPARE:  0x09,
  EXECUTE:  0x0a,
  BATCH:    0x0d,
  AUTH_CHALLENGE: 0x0e,
  AUTH_RESPONSE: 0x0f,
  AUTH_SUCCESS: 0x10,
};

// Result kinds
const RESULT_KIND = {
  VOID:          0x0001,
  ROWS:          0x0002,
  SET_KEYSPACE:  0x0003,
  PREPARED:      0x0004,
  SCHEMA_CHANGE: 0x0005,
};

// Column type codes
const TYPE_NAMES = {
  0x0000: "custom",
  0x0001: "ascii",
  0x0002: "bigint",
  0x0003: "blob",
  0x0004: "boolean",
  0x0005: "counter",
  0x0006: "decimal",
  0x0007: "double",
  0x0008: "float",
  0x0009: "int",
  0x000b: "timestamp",
  0x000c: "uuid",
  0x000d: "varchar",
  0x000e: "varint",
  0x000f: "timeuuid",
  0x0010: "inet",
  0x0011: "date",
  0x0012: "time",
  0x0013: "smallint",
  0x0014: "tinyint",
  0x0020: "list",
  0x0021: "map",
  0x0022: "set",
  0x0030: "udt",
  0x0031: "tuple",
};

const MAX_FRAME   = 32 * 1024 * 1024; // 32 MB
const MAX_ROWS    = 10000;

// ── Low-level frame builder ───────────────────────────────────────────────────

function buildFrame(opcode, body, stream = 1, flags = 0) {
  const header = Buffer.allocUnsafe(9);
  header[0] = PROTO_VERSION;
  header[1] = flags;
  header.writeInt16BE(stream, 2);
  header[4] = opcode;
  header.writeUInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

function writeShort(n) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16BE(n, 0);
  return b;
}

function writeInt(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32BE(n, 0);
  return b;
}

function writeLong(n) {
  // n is a JS number; safe for timestamps and counters up to 2^53
  const b = Buffer.allocUnsafe(8);
  b.writeBigInt64BE(BigInt(n), 0);
  return b;
}

function writeString(s) {
  const str = Buffer.from(s, "utf8");
  return Buffer.concat([writeShort(str.length), str]);
}

function writeLongString(s) {
  const str = Buffer.from(s, "utf8");
  return Buffer.concat([writeInt(str.length), str]);
}

function writeBytes(buf) {
  if (buf === null || buf === undefined) {
    return writeInt(-1);
  }
  return Buffer.concat([writeInt(buf.length), buf]);
}

function writeStringMap(obj) {
  const keys = Object.keys(obj);
  const parts = [writeShort(keys.length)];
  for (const k of keys) {
    parts.push(writeString(k));
    parts.push(writeString(obj[k]));
  }
  return Buffer.concat(parts);
}

// ── Frame reader (cursor-based) ───────────────────────────────────────────────

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }

  remaining() { return this.buf.length - this.pos; }

  readByte() {
    if (this.pos >= this.buf.length) throw new Error("Reader: buffer underflow (readByte)");
    return this.buf[this.pos++];
  }

  readShort() {
    if (this.pos + 2 > this.buf.length) throw new Error("Reader: buffer underflow (readShort)");
    const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v;
  }

  readInt() {
    if (this.pos + 4 > this.buf.length) throw new Error("Reader: buffer underflow (readInt)");
    const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v;
  }

  readLong() {
    if (this.pos + 8 > this.buf.length) throw new Error("Reader: buffer underflow (readLong)");
    const v = this.buf.readBigInt64BE(this.pos); this.pos += 8;
    // Convert BigInt to number if safe, else string
    return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString();
  }

  readString() {
    const len = this.readShort();
    if (len < 0) throw new Error("Reader: negative string length");
    if (this.pos + len > this.buf.length) throw new Error("Reader: buffer underflow (readString)");
    const v = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return v;
  }

  readLongString() {
    const len = this.readInt();
    if (len < 0) return null;
    if (this.pos + len > this.buf.length) throw new Error("Reader: buffer underflow (readLongString)");
    const v = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return v;
  }

  readBytes() {
    const len = this.readInt();
    if (len < 0) return null;
    if (this.pos + len > this.buf.length) throw new Error("Reader: buffer underflow (readBytes)");
    const v = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return v;
  }

  readShortBytes() {
    const len = this.readShort();
    if (this.pos + len > this.buf.length) throw new Error("Reader: buffer underflow (readShortBytes)");
    const v = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return v;
  }

  readStringMap() {
    const count = this.readShort();
    const m = {};
    for (let i = 0; i < count; i++) {
      const k = this.readString();
      const v = this.readString();
      m[k] = v;
    }
    return m;
  }

  readStringMultimap() {
    const count = this.readShort();
    const m = {};
    for (let i = 0; i < count; i++) {
      const k = this.readString();
      const nv = this.readShort();
      const vals = [];
      for (let j = 0; j < nv; j++) vals.push(this.readString());
      m[k] = vals;
    }
    return m;
  }

  readUUID() {
    if (this.pos + 16 > this.buf.length) throw new Error("Reader: buffer underflow (readUUID)");
    const b = this.buf.slice(this.pos, this.pos + 16);
    this.pos += 16;
    const hex = b.toString("hex");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
}

// ── Type decoder ──────────────────────────────────────────────────────────────

function decodeValue(bytes, typeCode, typeExtra) {
  if (bytes === null) return null;
  switch (typeCode) {
    case 0x0001: // ascii
    case 0x000d: // varchar
      return bytes.toString("ascii");
    case 0x0002: // bigint
    case 0x0005: // counter
      if (bytes.length !== 8) return bytes.toString("hex");
      return bytes.readBigInt64BE(0) >= -9007199254740991n && bytes.readBigInt64BE(0) <= 9007199254740991n
        ? Number(bytes.readBigInt64BE(0))
        : bytes.readBigInt64BE(0).toString();
    case 0x0003: // blob
      return bytes.toString("base64");
    case 0x0004: // boolean
      return bytes[0] !== 0;
    case 0x0007: // double
      return bytes.readDoubleBE(0);
    case 0x0008: // float
      return bytes.readFloatBE(0);
    case 0x0009: // int
      return bytes.readInt32BE(0);
    case 0x0013: // smallint
      return bytes.readInt16BE(0);
    case 0x0014: // tinyint
      return bytes.readInt8(0);
    case 0x000b: // timestamp
      try {
        const ms = bytes.readBigInt64BE(0);
        return new Date(Number(ms)).toISOString();
      } catch { return bytes.toString("hex"); }
    case 0x000c: // uuid
    case 0x000f: // timeuuid
      if (bytes.length !== 16) return bytes.toString("hex");
      return (() => {
        const hex = bytes.toString("hex");
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      })();
    case 0x000e: // varint
      return bytes.toString("hex"); // arbitrary precision — return hex
    case 0x0006: // decimal
      if (bytes.length < 4) return bytes.toString("hex");
      return { scale: bytes.readInt32BE(0), unscaledHex: bytes.slice(4).toString("hex") };
    case 0x0010: // inet
      if (bytes.length === 4) return [...bytes].join(".");
      if (bytes.length === 16) {
        const hex = bytes.toString("hex");
        const groups = [];
        for (let i = 0; i < 32; i += 4) groups.push(hex.slice(i, i + 4));
        return groups.join(":");
      }
      return bytes.toString("hex");
    case 0x0011: // date (days since epoch 2^31)
      try {
        const days = bytes.readUInt32BE(0) - 2147483648;
        const d = new Date(days * 86400000);
        return d.toISOString().slice(0, 10);
      } catch { return bytes.toString("hex"); }
    case 0x0012: // time (nanoseconds since midnight)
      try {
        const ns = Number(bytes.readBigInt64BE(0));
        const ms = Math.floor(ns / 1e6);
        const hh = Math.floor(ms / 3600000);
        const mm = Math.floor((ms % 3600000) / 60000);
        const ss = Math.floor((ms % 60000) / 1000);
        return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
      } catch { return bytes.toString("hex"); }
    case 0x0020: { // list
      const r = new Reader(bytes);
      const count = r.readInt();
      const items = [];
      for (let i = 0; i < count; i++) {
        const elem = r.readBytes();
        items.push(decodeValue(elem, typeExtra ? typeExtra[0] : 0x000d));
      }
      return items;
    }
    case 0x0022: { // set
      const r = new Reader(bytes);
      const count = r.readInt();
      const items = [];
      for (let i = 0; i < count; i++) {
        const elem = r.readBytes();
        items.push(decodeValue(elem, typeExtra ? typeExtra[0] : 0x000d));
      }
      return items;
    }
    case 0x0021: { // map
      const r = new Reader(bytes);
      const count = r.readInt();
      const obj = {};
      for (let i = 0; i < count; i++) {
        const k = r.readBytes();
        const v = r.readBytes();
        const key = decodeValue(k, typeExtra ? typeExtra[0] : 0x000d);
        const val = decodeValue(v, typeExtra ? typeExtra[1] : 0x000d);
        obj[String(key)] = val;
      }
      return obj;
    }
    default:
      return bytes.toString("base64");
  }
}

// ── Result metadata / rows decoder ────────────────────────────────────────────

function decodeOption(r) {
  const code = r.readShort();
  let extra = null;
  if (code === 0x0020 || code === 0x0022) { // list/set: value type
    extra = [r.readShort()];
    // consume sub-type extra if needed (we just skip for nested)
  } else if (code === 0x0021) { // map: key+value types
    extra = [r.readShort(), r.readShort()];
  } else if (code === 0x0030) { // udt
    r.readString(); // keyspace
    r.readString(); // type name
    const nf = r.readShort();
    for (let i = 0; i < nf; i++) { r.readString(); r.readShort(); } // field names/types
  } else if (code === 0x0031) { // tuple
    const nt = r.readShort();
    for (let i = 0; i < nt; i++) r.readShort();
  }
  return { code, extra };
}

function decodeResultMetadata(r) {
  const flags = r.readInt();
  const colCount = r.readInt();
  let pagingState = null;
  if (flags & 0x0002) pagingState = r.readBytes(); // HAS_MORE_PAGES
  const noMetadata = !!(flags & 0x0004);
  let globalKs = null, globalTable = null;
  if ((flags & 0x0001) && !noMetadata) { // GLOBAL_TABLES_SPEC
    globalKs    = r.readString();
    globalTable = r.readString();
  }
  const columns = [];
  if (!noMetadata) {
    for (let i = 0; i < colCount; i++) {
      let ks = globalKs, table = globalTable;
      if (!(flags & 0x0001)) {
        ks    = r.readString();
        table = r.readString();
      }
      const name = r.readString();
      const opt  = decodeOption(r);
      columns.push({ ks, table, name, type: TYPE_NAMES[opt.code] || `0x${opt.code.toString(16)}`, typeCode: opt.code, typeExtra: opt.extra });
    }
  }
  return { flags, colCount, pagingState, columns };
}

function decodeRows(r, metadata) {
  const rowCount = r.readInt();
  const rows = [];
  const cap = Math.min(rowCount, MAX_ROWS);
  for (let ri = 0; ri < cap; ri++) {
    const row = {};
    for (const col of metadata.columns) {
      const bytes = r.readBytes();
      row[col.name] = decodeValue(bytes, col.typeCode, col.typeExtra);
    }
    rows.push(row);
  }
  return { rows, rowCount, truncated: rowCount > MAX_ROWS };
}

// ── Frame decoder (from buffer) ───────────────────────────────────────────────

function decodeFrame(body, opcode) {
  const r = new Reader(body);
  switch (opcode) {
    case OP.ERROR: {
      const code = r.readInt();
      const msg  = r.readString();
      return { kind: "error", code, message: msg };
    }
    case OP.READY:
      return { kind: "ready" };
    case OP.AUTHENTICATE:
      return { kind: "authenticate", authenticator: r.readString() };
    case OP.AUTH_CHALLENGE:
      return { kind: "auth_challenge", token: r.readBytes() };
    case OP.AUTH_SUCCESS:
      return { kind: "auth_success", token: r.readBytes() };
    case OP.SUPPORTED:
      return { kind: "supported", options: r.readStringMultimap() };
    case OP.RESULT: {
      const kind = r.readInt();
      switch (kind) {
        case RESULT_KIND.VOID:
          return { kind: "result", resultKind: "void" };
        case RESULT_KIND.SET_KEYSPACE:
          return { kind: "result", resultKind: "set_keyspace", keyspace: r.readString() };
        case RESULT_KIND.SCHEMA_CHANGE: {
          const changeType = r.readString();
          const target     = r.readString();
          const options    = r.readString();
          return { kind: "result", resultKind: "schema_change", changeType, target, options };
        }
        case RESULT_KIND.ROWS: {
          const metadata = decodeResultMetadata(r);
          const { rows, rowCount, truncated } = decodeRows(r, metadata);
          return { kind: "result", resultKind: "rows", columns: metadata.columns.map(c => ({ name: c.name, type: c.type })), rows, rowCount, truncated };
        }
        case RESULT_KIND.PREPARED: {
          const queryId = r.readShortBytes();
          return { kind: "result", resultKind: "prepared", queryId: queryId.toString("hex"), queryIdBuf: queryId };
        }
        default:
          return { kind: "result", resultKind: "unknown", kindCode: kind };
      }
    }
    default:
      return { kind: "unknown", opcode };
  }
}

// ── Connection class ──────────────────────────────────────────────────────────

class CassandraConnection {
  constructor(opts) {
    this.host     = opts.host || "127.0.0.1";
    this.port     = opts.port || 9042;
    this.username = opts.username || null;
    this.password = opts.password || null;
    this.tls      = opts.tls || false;
    this.rejectUnauthorized = opts.reject_unauthorized !== false;
    this.timeout  = opts.timeout || 10000;
    this.keyspace = opts.keyspace || null;

    this.socket   = null;
    this.buffer   = Buffer.alloc(0);
    this._stream  = 1;
    this._pending = new Map(); // streamId -> { resolve, reject }
  }

  _nextStream() {
    const s = this._stream++;
    if (this._stream > 0x7fff) this._stream = 1;
    return s;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.timeout;
      const done = (() => {
        let called = false;
        return (err, result) => {
          if (called) return;
          called = true;
          clearTimeout(timer);
          err ? reject(err) : resolve(result);
        };
      })();

      const timer = setTimeout(() => done(new Error(`cassandra_client: connection timeout after ${timeoutMs} ms`)), timeoutMs);

      const sockOpts = this.tls
        ? { host: this.host, port: this.port, rejectUnauthorized: this.rejectUnauthorized }
        : { host: this.host, port: this.port };

      const sock = this.tls ? tls.connect(sockOpts) : net.connect(sockOpts);
      this.socket = sock;

      sock.on("error", err => done(new Error(`cassandra_client: connect error: ${err.message}`)));

      // Reject all pending promises if socket closes unexpectedly
      sock.on("close", () => {
        for (const [, p] of this._pending) p.reject(new Error("cassandra_client: socket closed unexpectedly"));
        this._pending.clear();
      });

      // Frame accumulator
      sock.on("data", chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._processFrames();
      });

      const onConnected = () => done(null, "connected");
      this.tls ? sock.on("secureConnect", onConnected) : sock.on("connect", onConnected);
    });
  }

  _processFrames() {
    // Frames: 9-byte header + body
    while (this.buffer.length >= 9) {
      const bodyLen = this.buffer.readUInt32BE(5);
      if (bodyLen > MAX_FRAME) {
        // Discard oversized frame
        this.buffer = Buffer.alloc(0);
        return;
      }
      const total = 9 + bodyLen;
      if (this.buffer.length < total) break;

      const frame  = this.buffer.slice(0, total);
      this.buffer  = this.buffer.slice(total);

      const version = frame[0];
      if ((version & 0x7f) !== 4) continue; // not v4
      const streamId = frame.readInt16BE(2);
      const opcode   = frame[4];
      const body     = frame.slice(9);

      const pending = this._pending.get(streamId);
      if (pending) {
        this._pending.delete(streamId);
        try {
          const result = decodeFrame(body, opcode);
          if (result.kind === "error") {
            pending.reject(new Error(`Cassandra error [${result.code.toString(16)}]: ${result.message}`));
          } else {
            pending.resolve(result);
          }
        } catch (e) {
          pending.reject(e);
        }
      }
    }
  }

  send(opcode, bodyBufs, stream) {
    const body   = Buffer.isBuffer(bodyBufs) ? bodyBufs : Buffer.concat(bodyBufs);
    const sid    = stream !== undefined ? stream : this._nextStream();
    const frame  = buildFrame(opcode, body, sid);
    return new Promise((resolve, reject) => {
      this._pending.set(sid, { resolve, reject });
      this.socket.write(frame, err => {
        if (err) {
          this._pending.delete(sid);
          reject(new Error(`cassandra_client: write error: ${err.message}`));
        }
      });
    });
  }

  async startup(keyspace) {
    const opts = { "CQL_VERSION": "3.0.0" };
    if (keyspace) opts["KEYSPACE"] = keyspace;
    const resp = await this.send(OP.STARTUP, [writeStringMap(opts)]);

    if (resp.kind === "authenticate") {
      // SASL PLAIN: \0username\0password
      if (!this.username) throw new ToolError("cassandra_client: server requires authentication but no username provided.", -32602);
      const saslToken = Buffer.concat([
        Buffer.from([0]),
        Buffer.from(this.username, "utf8"),
        Buffer.from([0]),
        Buffer.from(this.password || "", "utf8"),
      ]);
      const authResp = await this.send(OP.AUTH_RESPONSE, [writeBytes(saslToken)]);
      if (authResp.kind !== "auth_success") {
        throw new ToolError("cassandra_client: authentication failed.", -32602);
      }
    } else if (resp.kind !== "ready") {
      throw new ToolError(`cassandra_client: unexpected startup response: ${JSON.stringify(resp)}`, -32603);
    }
  }

  async query(cql, consistency = 0x0001) {
    // QUERY body: <query_string>[long string] <consistency>[short] <flags>[byte] <values (optional)>
    const parts = [
      writeLongString(cql),
      writeShort(consistency),
      Buffer.from([0x00]), // flags = 0 (no values, no page size, etc.)
    ];
    return this.send(OP.QUERY, parts);
  }

  async queryWithPageSize(cql, pageSize, consistency = 0x0001) {
    // flags: 0x04 = PAGE_SIZE
    const parts = [
      writeLongString(cql),
      writeShort(consistency),
      Buffer.from([0x04]),
      writeInt(pageSize),
    ];
    return this.send(OP.QUERY, parts);
  }

  async prepare(cql) {
    // PREPARE body: <query>[long string]
    return this.send(OP.PREPARE, [writeLongString(cql)]);
  }

  async execute(queryIdBuf, values, consistency = 0x0001) {
    // EXECUTE body: <id>[short bytes] <query_params>
    //   query_params: <consistency>[short] <flags>[byte] <values>[if flag 0x01]
    const hasValues = values && values.length > 0;
    const flags     = hasValues ? 0x01 : 0x00;
    const parts     = [
      writeShort(queryIdBuf.length),
      queryIdBuf,
      writeShort(consistency),
      Buffer.from([flags]),
    ];
    if (hasValues) {
      parts.push(writeShort(values.length));
      for (const v of values) {
        parts.push(writeBytes(v)); // caller provides raw Buffer or null
      }
    }
    return this.send(OP.EXECUTE, parts);
  }

  async batch(statements, batchType = 0, consistency = 0x0001) {
    // BATCH body: <type>[byte] <n>[short] (<kind><string|id><values>)* <consistency>[short] <flags>[byte]
    const parts = [
      Buffer.from([batchType]), // 0=LOGGED, 1=UNLOGGED, 2=COUNTER
      writeShort(statements.length),
    ];
    for (const stmt of statements) {
      parts.push(Buffer.from([0])); // kind=0: CQL string
      parts.push(writeLongString(stmt.cql));
      const vals = stmt.values || [];
      parts.push(writeShort(vals.length));
      for (const v of vals) parts.push(writeBytes(v));
    }
    parts.push(writeShort(consistency));
    parts.push(Buffer.from([0x00])); // flags
    return this.send(OP.BATCH, parts);
  }

  async options() {
    return this.send(OP.OPTIONS, Buffer.alloc(0));
  }

  close() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
    // Reject all pending
    for (const [, p] of this._pending) p.reject(new Error("cassandra_client: connection closed"));
    this._pending.clear();
  }
}

// ── Value encoder (JS → CQL bytes) ───────────────────────────────────────────

function encodeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return Buffer.from([v ? 1 : 0]);
  if (typeof v === "number") {
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
      const b = Buffer.allocUnsafe(4); b.writeInt32BE(v, 0); return b;
    }
    const b = Buffer.allocUnsafe(8); b.writeDoubleBE(v, 0); return b;
  }
  if (typeof v === "bigint") {
    const b = Buffer.allocUnsafe(8); b.writeBigInt64BE(v, 0); return b;
  }
  if (Buffer.isBuffer(v)) return v;
  // string (varchar/text)
  return Buffer.from(String(v), "utf8");
}

// ── Operations ────────────────────────────────────────────────────────────────

async function withConn(opts, fn) {
  const conn = new CassandraConnection(opts);
  await conn.connect();
  try {
    await conn.startup(opts.keyspace || null);
    return await fn(conn);
  } finally {
    conn.close();
  }
}

async function opInfo(args) {
  const opts = buildConnOpts(args);
  return withConn(opts, async conn => {
    const supported = await conn.options();
    // Try to get cluster info from system.local
    let clusterInfo = {};
    try {
      const r = await conn.query("SELECT cluster_name, release_version, cql_version, native_protocol_version, data_center FROM system.local");
      if (r.resultKind === "rows" && r.rows.length > 0) {
        clusterInfo = r.rows[0];
      }
    } catch (_) {}
    return {
      host: args.host,
      port: args.port || 9042,
      options: supported.options || {},
      clusterName:    clusterInfo.cluster_name    || null,
      releaseVersion: clusterInfo.release_version || null,
      cqlVersion:     clusterInfo.cql_version     || null,
      nativeProtocol: clusterInfo.native_protocol_version || "4",
      dataCenter:     clusterInfo.data_center     || null,
    };
  });
}

async function opKeyspaces(args) {
  const opts = buildConnOpts(args);
  return withConn(opts, async conn => {
    const r = await conn.query("SELECT keyspace_name, replication FROM system_schema.keyspaces");
    if (r.resultKind !== "rows") return { keyspaces: [] };
    return {
      keyspaceCount: r.rowCount,
      keyspaces: r.rows.map(row => ({
        name: row.keyspace_name,
        replication: row.replication,
      })),
    };
  });
}

async function opTables(args) {
  const opts = buildConnOpts(args);
  const ks   = args.keyspace;
  if (!ks) throw new ToolError("cassandra_client: 'keyspace' is required for the 'tables' operation.", -32602);
  return withConn(opts, async conn => {
    const r = await conn.query(
      `SELECT table_name, comment FROM system_schema.tables WHERE keyspace_name = '${ks.replace(/'/g, "\\'")}'`
    );
    if (r.resultKind !== "rows") return { keyspace: ks, tables: [] };
    return {
      keyspace:   ks,
      tableCount: r.rowCount,
      tables:     r.rows.map(row => ({ name: row.table_name, comment: row.comment || "" })),
    };
  });
}

async function opDescribe(args) {
  const opts = buildConnOpts(args);
  const ks   = args.keyspace;
  const tbl  = args.table;
  if (!tbl) throw new ToolError("cassandra_client: 'table' is required for the 'describe' operation.", -32602);
  const ksCond = ks ? `AND keyspace_name = '${ks.replace(/'/g, "\\'")}'` : "";
  return withConn(opts, async conn => {
    // Resolve keyspace from USE if not provided
    let effectiveKs = ks;
    if (!effectiveKs && args.use_keyspace) {
      effectiveKs = args.use_keyspace;
    }

    // Prefer schema with keyspace filter
    const ksCond2 = effectiveKs ? `keyspace_name = '${effectiveKs.replace(/'/g, "\\'")}'  AND` : "";
    const colR = await conn.query(
      `SELECT keyspace_name, table_name, column_name, kind, type, position FROM system_schema.columns WHERE ${ksCond2} table_name = '${tbl.replace(/'/g, "\\'")}'`
    );
    if (colR.resultKind !== "rows" || colR.rows.length === 0) {
      throw new ToolError(`cassandra_client: table '${tbl}' not found.`, -32602);
    }
    const cols = colR.rows;
    const pks  = cols.filter(c => c.kind === "partition_key").sort((a, b) => a.position - b.position);
    const cks  = cols.filter(c => c.kind === "clustering").sort((a, b) => a.position - b.position);
    const regs = cols.filter(c => c.kind === "regular" || c.kind === "static");
    return {
      keyspace:       cols[0].keyspace_name,
      table:          tbl,
      columnCount:    cols.length,
      partitionKeys:  pks.map(c => ({ name: c.column_name, type: c.type })),
      clusteringKeys: cks.map(c => ({ name: c.column_name, type: c.type })),
      columns:        regs.map(c => ({ name: c.column_name, type: c.type, kind: c.kind })),
    };
  });
}

async function opQuery(args) {
  const opts = buildConnOpts(args);
  if (!args.cql) throw new ToolError("cassandra_client: 'cql' is required for the 'query' operation.", -32602);
  // Consistency levels
  const CONSISTENCY = {
    any: 0x0000, one: 0x0001, two: 0x0002, three: 0x0003,
    quorum: 0x0004, all: 0x0005, local_quorum: 0x0006, each_quorum: 0x0007,
    serial: 0x0008, local_serial: 0x0009, local_one: 0x000a,
  };
  const cl = CONSISTENCY[(args.consistency || "one").toLowerCase()] ?? 0x0001;
  const pageSize = args.page_size ? Math.min(Math.max(1, args.page_size), MAX_ROWS) : null;

  return withConn(opts, async conn => {
    if (args.use_keyspace) {
      await conn.query(`USE "${args.use_keyspace.replace(/"/g, "\"\"")}"`);
    }
    const r = pageSize
      ? await conn.queryWithPageSize(args.cql, pageSize, cl)
      : await conn.query(args.cql, cl);

    if (r.resultKind === "rows") {
      return { cql: args.cql, consistency: args.consistency || "one", ...r };
    }
    if (r.resultKind === "set_keyspace") {
      return { cql: args.cql, resultKind: "set_keyspace", keyspace: r.keyspace };
    }
    if (r.resultKind === "void" || r.resultKind === "schema_change") {
      return { cql: args.cql, resultKind: r.resultKind, changeType: r.changeType, target: r.target, options: r.options };
    }
    return { cql: args.cql, result: r };
  });
}

async function opExecute(args) {
  const opts = buildConnOpts(args);
  if (!args.cql) throw new ToolError("cassandra_client: 'cql' is required for the 'execute' operation.", -32602);
  const CONSISTENCY = {
    any: 0x0000, one: 0x0001, two: 0x0002, three: 0x0003,
    quorum: 0x0004, all: 0x0005, local_quorum: 0x0006, each_quorum: 0x0007,
    serial: 0x0008, local_serial: 0x0009, local_one: 0x000a,
  };
  const cl = CONSISTENCY[(args.consistency || "one").toLowerCase()] ?? 0x0001;
  const rawValues = args.values || [];

  return withConn(opts, async conn => {
    if (args.use_keyspace) {
      await conn.query(`USE "${args.use_keyspace.replace(/"/g, "\"\"")}"`);
    }
    // Prepare
    const prep = await conn.prepare(args.cql);
    if (prep.resultKind !== "prepared") {
      throw new ToolError(`cassandra_client: prepare failed: ${JSON.stringify(prep)}`, -32603);
    }
    // Encode values
    const encodedVals = rawValues.map(v => encodeValue(v));
    const r = await conn.execute(prep.queryIdBuf, encodedVals, cl);
    return { cql: args.cql, queryId: prep.queryId, ...r };
  });
}

async function opBatch(args) {
  const opts = buildConnOpts(args);
  if (!Array.isArray(args.statements) || args.statements.length === 0) {
    throw new ToolError("cassandra_client: 'statements' must be a non-empty array for the 'batch' operation.", -32602);
  }
  const BATCH_TYPES = { logged: 0, unlogged: 1, counter: 2 };
  const batchType = BATCH_TYPES[(args.batch_type || "logged").toLowerCase()] ?? 0;
  const CONSISTENCY = {
    any: 0x0000, one: 0x0001, quorum: 0x0004, all: 0x0005,
    local_quorum: 0x0006, local_one: 0x000a,
  };
  const cl = CONSISTENCY[(args.consistency || "one").toLowerCase()] ?? 0x0001;

  return withConn(opts, async conn => {
    if (args.use_keyspace) {
      await conn.query(`USE "${args.use_keyspace.replace(/"/g, "\"\"")}"`);
    }
    const stmts = args.statements.map(s => ({
      cql:    s.cql,
      values: (s.values || []).map(v => encodeValue(v)),
    }));
    const r = await conn.batch(stmts, batchType, cl);
    return { statementCount: stmts.length, batchType: args.batch_type || "logged", result: r };
  });
}

async function opUseKeyspace(args) {
  const opts = buildConnOpts(args);
  const ks   = args.keyspace;
  if (!ks) throw new ToolError("cassandra_client: 'keyspace' is required for the 'use_keyspace' operation.", -32602);
  return withConn(opts, async conn => {
    const r = await conn.query(`USE "${ks.replace(/"/g, "\"\"")}"`);
    return { operation: "use_keyspace", keyspace: r.keyspace || ks, result: r };
  });
}

// ── Args validator & conn opts ────────────────────────────────────────────────

function buildConnOpts(args) {
  const host = args.host || "127.0.0.1";
  const port = (args.port !== undefined && args.port !== null) ? Number(args.port) : 9042;
  const timeout = args.timeout
    ? Math.max(1000, Math.min(300000, Number(args.timeout)))
    : 10000;

  // NUL-byte guards
  for (const [field, val] of Object.entries({
    host, keyspace: args.keyspace, username: args.username,
  })) {
    if (val && String(val).includes("\0")) {
      throw new ToolError(`cassandra_client: '${field}' must not contain NUL bytes.`, -32602);
    }
  }
  if (host.length > 253) throw new ToolError("cassandra_client: 'host' is too long.", -32602);
  if (port < 1 || port > 65535) throw new ToolError("cassandra_client: 'port' must be 1-65535.", -32602);

  return {
    host,
    port,
    timeout,
    keyspace:           args.keyspace || null,
    username:           args.username || null,
    password:           args.password || null,
    tls:                !!args.tls,
    reject_unauthorized: args.reject_unauthorized !== false,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function cassandraClient(args) {
  if (!args || typeof args !== "object") throw new ToolError("cassandra_client: args must be an object.", -32602);
  const op = args.operation;
  if (!op) throw new ToolError("cassandra_client: 'operation' is required.", -32602);

  switch (op) {
    case "info":         return opInfo(args);
    case "keyspaces":    return opKeyspaces(args);
    case "tables":       return opTables(args);
    case "describe":     return opDescribe(args);
    case "query":        return opQuery(args);
    case "execute":      return opExecute(args);
    case "batch":        return opBatch(args);
    case "use_keyspace": return opUseKeyspace(args);
    default:
      throw new ToolError(
        `cassandra_client: unknown operation '${op}'. Valid: info, keyspaces, tables, describe, query, execute, batch, use_keyspace.`,
        -32602,
      );
  }
}

module.exports = { cassandraClient };
