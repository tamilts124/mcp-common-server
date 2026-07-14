"use strict";
/**
 * zookeeper_client — Zero-dependency Apache ZooKeeper client
 * (pure Node.js net/tls built-ins; no npm deps)
 *
 * Implements the ZooKeeper binary protocol (Jute serialization over TCP/TLS)
 *
 * References:
 *   ZooKeeper Protocol — https://zookeeper.apache.org/doc/current/zookeeperInternals.html
 *   Jute serialization — big-endian length-prefixed records
 *   ZooKeeper client port default: 2181
 *
 * Operations:
 *   connect      — Open a session, get sessionId/timeout, close gracefully
 *   get          — Get data bytes and Stat for a znode
 *   set          — Set data bytes on a znode (versioned)
 *   create       — Create a new znode with data and ACLs
 *   delete       — Delete a znode (versioned)
 *   exists       — Check whether a znode exists (returns Stat or null)
 *   get_children — List child znodes under a path
 *   get_acl      — Get the ACL list and Stat for a znode
 *   info         — Return protocol/config/operation reference (no I/O)
 *
 * Jute wire format (simplified ZooKeeper protocol):
 *   Each packet: [ 4-byte big-endian length ] [ payload ]
 *   Request header: xid (int32), type (int32)
 *   Connect request: protocolVersion, lastZxidSeen, timeOut, sessionId, passwd[]
 *   String: 4-byte length + UTF-8 bytes  (-1 = null)
 *   Bytes:  4-byte length + raw bytes     (-1 = null)
 *   Bool:   1 byte (0/1)
 *   Int32:  4 bytes big-endian
 *   Int64:  8 bytes big-endian
 *
 * ZooKeeper Op codes:
 *   create=1, delete=2, exists=3, getData=4, setData=5,
 *   getACL=6, setACL=7, getChildren=8, closeSession=-11, ping=11
 *
 * Error codes (subset used here):
 *   0=OK, -1=SystemError, -2=RuntimeInconsistency, -4=ConnectionLoss,
 *   -5=MarshallingError, -6=Unimplemented, -7=OperationTimeout,
 *   -100=NoNode, -101=NodeExists, -102=NoChildrenForEphemerals,
 *   -103=InvalidACL, -108=SessionExpired, -110=InvalidCallback,
 *   -112=SessionMovedOrNotAvailable, -118=RequestTimeout
 */

const net = require("net");
const tls = require("tls");

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_PORT          = 2181;
const MAX_RESPONSE_BYTES    = 8 * 1024 * 1024;  // 8 MB total buffer
const MAX_DATA_BYTES        = 1 * 1024 * 1024;  // 1 MB per znode data
const CONNECT_TIMEOUT_MS    = 10000;
const DEFAULT_TIMEOUT_MS    = 15000;

// ZooKeeper op codes
const OpCode = {
  create:      1,
  delete:      2,
  exists:      3,
  getData:     4,
  setData:     5,
  getACL:      6,
  setACL:      7,
  getChildren: 8,
  ping:        11,
  close:       -11,
};

// ZooKeeper error codes → human-readable
const ZK_ERRORS = {
  0:    "OK",
  "-1": "SystemError",
  "-2": "RuntimeInconsistency",
  "-3": "DataInconsistency",
  "-4": "ConnectionLoss",
  "-5": "MarshallingError",
  "-6": "Unimplemented",
  "-7": "OperationTimeout",
  "-8": "BadArguments",
  "-100": "NoNode",
  "-101": "NodeExists",
  "-102": "NoChildrenForEphemerals",
  "-103": "InvalidACL",
  "-108": "SessionExpired",
  "-110": "InvalidCallback",
  "-112": "SessionMovedOrNotAvailable",
  "-118": "RequestTimeout",
};

function zkError(code) {
  const name = ZK_ERRORS[String(code)] || `UnknownError(${code})`;
  return new Error(`ZooKeeper error ${code}: ${name}`);
}

// ── Jute encoder ──────────────────────────────────────────────────────────────

class JuteEncoder {
  constructor() {
    this._bufs = [];
    this._len  = 0;
  }

  writeInt32(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(v >>> 0 !== v ? v : v, 0); // signed
    // Use signed interpretation
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32BE(v | 0, 0);
    this._bufs.push(buf);
    this._len += 4;
    return this;
  }

  writeInt64(v) {
    // v is a JS number; for ZK we only need small values (session IDs, zxids)
    // Represent as two 32-bit halves (big-endian)
    const hi = Math.floor(v / 0x100000000);
    const lo = v >>> 0;
    const buf = Buffer.allocUnsafe(8);
    buf.writeInt32BE(hi, 0);
    buf.writeUInt32BE(lo, 4);
    this._bufs.push(buf);
    this._len += 8;
    return this;
  }

  writeBool(v) {
    const buf = Buffer.allocUnsafe(1);
    buf[0] = v ? 1 : 0;
    this._bufs.push(buf);
    this._len += 1;
    return this;
  }

  writeString(s) {
    if (s === null || s === undefined) {
      this.writeInt32(-1);
      return this;
    }
    const strBuf = Buffer.from(s, "utf8");
    this.writeInt32(strBuf.length);
    this._bufs.push(strBuf);
    this._len += strBuf.length;
    return this;
  }

  writeBytes(b) {
    if (b === null || b === undefined) {
      this.writeInt32(-1);
      return this;
    }
    if (typeof b === "string") b = Buffer.from(b, "utf8");
    this.writeInt32(b.length);
    this._bufs.push(b);
    this._len += b.length;
    return this;
  }

  toBuffer() {
    return Buffer.concat(this._bufs, this._len);
  }

  /** Wrap payload with 4-byte length prefix */
  toPacket() {
    const payload = this.toBuffer();
    const header  = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
  }
}

// ── Jute decoder ──────────────────────────────────────────────────────────────

class JuteDecoder {
  constructor(buf) {
    this._buf = buf;
    this._pos = 0;
  }

  get remaining() { return this._buf.length - this._pos; }

  readInt32() {
    if (this.remaining < 4) throw new Error("Buffer underflow reading int32");
    const v = this._buf.readInt32BE(this._pos);
    this._pos += 4;
    return v;
  }

  readUInt32() {
    if (this.remaining < 4) throw new Error("Buffer underflow reading uint32");
    const v = this._buf.readUInt32BE(this._pos);
    this._pos += 4;
    return v;
  }

  readInt64() {
    if (this.remaining < 8) throw new Error("Buffer underflow reading int64");
    const hi = this._buf.readInt32BE(this._pos);
    const lo = this._buf.readUInt32BE(this._pos + 4);
    this._pos += 8;
    // Return as number (loses precision for very large int64, ok for ZK usage)
    return hi * 0x100000000 + lo;
  }

  readBool() {
    if (this.remaining < 1) throw new Error("Buffer underflow reading bool");
    return this._buf[this._pos++] !== 0;
  }

  readString() {
    const len = this.readInt32();
    if (len === -1) return null;
    if (len < 0) throw new Error(`Invalid string length: ${len}`);
    if (this.remaining < len) throw new Error("Buffer underflow reading string");
    const s = this._buf.toString("utf8", this._pos, this._pos + len);
    this._pos += len;
    return s;
  }

  readBytes() {
    const len = this.readInt32();
    if (len === -1) return null;
    if (len < 0) throw new Error(`Invalid bytes length: ${len}`);
    if (this.remaining < len) throw new Error("Buffer underflow reading bytes");
    const b = this._buf.slice(this._pos, this._pos + len);
    this._pos += len;
    return b;
  }

  /** Read a ZooKeeper Stat structure (17 fields × int64/int32) */
  readStat() {
    return {
      czxid:          this.readInt64(),
      mzxid:          this.readInt64(),
      ctime:          new Date(this.readInt64()).toISOString(),
      mtime:          new Date(this.readInt64()).toISOString(),
      version:        this.readInt32(),
      cversion:       this.readInt32(),
      aversion:       this.readInt32(),
      ephemeralOwner: this.readInt64(),
      dataLength:     this.readInt32(),
      numChildren:    this.readInt32(),
      pzxid:          this.readInt64(),
    };
  }

  /** Read an ACL entry: perms (int32), id (scheme string + id string) */
  readAcl() {
    const perms  = this.readInt32();
    const scheme = this.readString();
    const id     = this.readString();
    return { perms, scheme, id };
  }

  /** Read a vector of ACL entries */
  readAclList() {
    const count = this.readInt32();
    const acls  = [];
    for (let i = 0; i < count; i++) acls.push(this.readAcl());
    return acls;
  }

  /** Read a vector of strings */
  readStringVector() {
    const count = this.readInt32();
    const items = [];
    for (let i = 0; i < count; i++) items.push(this.readString());
    return items;
  }
}

// ── ACL helpers ───────────────────────────────────────────────────────────────

/** Encode a ZooKeeper ACL entry */
function encodeAcl(enc, acl) {
  enc.writeInt32(acl.perms);
  enc.writeString(acl.scheme);
  enc.writeString(acl.id);
}

/** Encode a list of ACL entries */
function encodeAclList(enc, acls) {
  enc.writeInt32(acls.length);
  for (const acl of acls) encodeAcl(enc, acl);
}

/** Default ACL: world:anyone with all permissions */
const OPEN_ACL_UNSAFE = [{ perms: 31, scheme: "world", id: "anyone" }];

/** ACL permission flags */
const Perms = {
  READ:   1,
  WRITE:  2,
  CREATE: 4,
  DELETE: 8,
  ADMIN:  16,
  ALL:    31,
};

// ── ZooKeeper connection class ────────────────────────────────────────────────

class ZkConnection {
  constructor(socket, timeoutMs) {
    this._socket    = socket;
    this._timeoutMs = timeoutMs;
    this._recvBuf   = Buffer.alloc(0);
    this._totalBytes = 0;
    this._closed    = false;
    this._xid       = 1;
    // Map from xid → { resolve, reject, timer }
    this._pending   = new Map();
    // Session info filled in after Connect
    this.sessionId  = 0;
    this.passwd     = Buffer.alloc(16, 0);
    this.negotiatedTimeout = 0;
    this.protocolVersion   = 0;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err)  => this._onError(err));
    socket.on("close", ()     => this._onError(new Error("ZooKeeper connection closed unexpectedly")));
    socket.on("end",   ()     => this._onError(new Error("ZooKeeper server closed connection")));
  }

  _onData(chunk) {
    this._totalBytes += chunk.length;
    if (this._totalBytes > MAX_RESPONSE_BYTES) {
      this._onError(new Error("ZooKeeper response exceeded 8 MB cap"));
      return;
    }
    this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
    this._processPackets();
  }

  _processPackets() {
    while (this._recvBuf.length >= 4) {
      const pktLen = this._recvBuf.readUInt32BE(0);
      if (this._recvBuf.length < 4 + pktLen) break;
      const payload = this._recvBuf.slice(4, 4 + pktLen);
      this._recvBuf = this._recvBuf.slice(4 + pktLen);
      this._dispatchPacket(payload);
    }
  }

  _dispatchPacket(payload) {
    // Response header: xid (int32), zxid (int64), err (int32)
    if (payload.length < 16) return;
    const dec  = new JuteDecoder(payload);
    const xid  = dec.readInt32();
    const zxid = dec.readInt64();
    const err  = dec.readInt32();

    const entry = this._pending.get(xid);
    if (!entry) return; // Unsolicited packet (watchers etc.)

    clearTimeout(entry.timer);
    this._pending.delete(xid);

    if (err !== 0) {
      entry.reject(zkError(err));
    } else {
      entry.resolve({ dec, zxid });
    }
  }

  _onError(err) {
    if (this._closed) return;
    this._closed = true;
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
    try { this._socket.destroy(); } catch (_) {}
  }

  /** Send a framed packet (adds 4-byte length prefix) */
  _send(payload) {
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error("Connection is closed")); return; }
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(payload.length, 0);
      const pkt = Buffer.concat([header, payload]);
      this._socket.write(pkt, (err) => {
        if (err) reject(new Error(`ZooKeeper send error: ${err.message}`));
        else resolve();
      });
    });
  }

  /** Assign an xid, send request, await response with timeout */
  _request(payload) {
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error("Connection is closed")); return; }
      const xid = this._xid++;
      // Prepend request header (xid + opcode already encoded by caller)
      const timer = setTimeout(() => {
        this._pending.delete(xid);
        reject(new Error(`ZooKeeper request timed out after ${this._timeoutMs}ms`));
      }, this._timeoutMs);
      this._pending.set(xid, { resolve, reject, timer });
      this._send(payload).catch((err) => {
        clearTimeout(timer);
        this._pending.delete(xid);
        reject(err);
      });
    });
  }

  /**
   * ZooKeeper Connect handshake.
   * Connect request is special — no xid/opcode header; reply has no xid/err header.
   */
  async connect(sessionTimeout = 30000) {
    // Build ConnectRequest:
    // protocolVersion(int32), lastZxidSeen(int64), timeOut(int32),
    // sessionId(int64), passwd(bytes)
    const enc = new JuteEncoder();
    enc.writeInt32(0);           // protocolVersion
    enc.writeInt64(0);           // lastZxidSeen
    enc.writeInt32(sessionTimeout); // timeOut
    enc.writeInt64(0);           // sessionId
    enc.writeBytes(Buffer.alloc(16, 0)); // passwd
    enc.writeBool(false);        // readOnly

    await this._send(enc.toBuffer());

    // Read ConnectResponse — just a framed packet, no xid
    const pkt = await this._readFramed();
    const dec = new JuteDecoder(pkt);
    this.protocolVersion    = dec.readInt32();
    this.negotiatedTimeout  = dec.readInt32();
    this.sessionId          = dec.readInt64();
    const passwdBuf         = dec.readBytes();
    if (passwdBuf && passwdBuf.length === 16) this.passwd = passwdBuf;
    return {
      protocolVersion:   this.protocolVersion,
      negotiatedTimeout: this.negotiatedTimeout,
      sessionId:         this.sessionId,
    };
  }

  /** Read a single framed packet from the wire (used only for ConnectResponse) */
  _readFramed() {
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error("Connection is closed")); return; }
      const timer = setTimeout(() => {
        reject(new Error(`ZooKeeper connect response timed out after ${this._timeoutMs}ms`));
      }, this._timeoutMs);

      // Save previous data handler; restore after we consume the connect response
      const onData = (chunk) => {
        this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
        if (this._recvBuf.length >= 4) {
          const pktLen = this._recvBuf.readUInt32BE(0);
          if (this._recvBuf.length >= 4 + pktLen) {
            clearTimeout(timer);
            const payload = this._recvBuf.slice(4, 4 + pktLen);
            this._recvBuf = this._recvBuf.slice(4 + pktLen);
            // Restore normal data handler
            this._socket.removeListener("data", onData);
            this._socket.on("data", (c) => this._onData(c));
            resolve(payload);
          }
        }
      };
      // Temporarily override data handler
      this._socket.removeAllListeners("data");
      this._socket.on("data", onData);
    });
  }

  /**
   * Send a Close session request and wait for ack.
   * ZK close uses xid=-11 and opCode=-11.
   */
  async closeSession() {
    if (this._closed) return;
    try {
      const enc = new JuteEncoder();
      enc.writeInt32(-11); // xid = -11 (closeSession)
      enc.writeInt32(-11); // type = closeSession
      await this._send(enc.toBuffer());
      // Don't wait for a response; ZK closes the connection immediately
    } catch (_) {
    } finally {
      this._closed = true;
      try { this._socket.destroy(); } catch (_) {}
    }
  }

  /** Helper: allocate an xid; encode request header + payload; send and await */
  async _op(opCode, bodyEnc) {
    const xid = this._xid++;
    const hdr = new JuteEncoder();
    hdr.writeInt32(xid);
    hdr.writeInt32(opCode);
    const body    = bodyEnc ? bodyEnc.toBuffer() : Buffer.alloc(0);
    const payload = Buffer.concat([hdr.toBuffer(), body]);
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error("Connection is closed")); return; }
      const timer = setTimeout(() => {
        this._pending.delete(xid);
        reject(new Error(`ZooKeeper operation timed out after ${this._timeoutMs}ms`));
      }, this._timeoutMs);
      this._pending.set(xid, { resolve, reject, timer });
      this._send(payload).catch((err) => {
        clearTimeout(timer);
        this._pending.delete(xid);
        reject(err);
      });
    });
  }
}

// ── Connection factory ────────────────────────────────────────────────────────

function connectTcp(host, port, useTls, rejectUnauthorized, connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    let sock;
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { sock && sock.destroy(); } catch (_) {}
        reject(new Error(`Connection to ${host}:${port} timed out after ${connectTimeoutMs}ms`));
      }
    }, connectTimeoutMs);

    const onConnect = () => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      resolve(sock);
    };
    const onError = (err) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      reject(new Error(`Cannot connect to ZooKeeper ${host}:${port}: ${err.message}`));
    };

    if (useTls) {
      sock = tls.connect({ host, port, rejectUnauthorized: rejectUnauthorized !== false, servername: host });
      sock.once("secureConnect", onConnect);
    } else {
      sock = net.connect({ host, port });
      sock.once("connect", onConnect);
    }
    sock.once("error", onError);
  });
}

/** Open a ZkConnection, run callback(conn, sessionInfo), then close session. */
async function withZkSession(args, callback) {
  requireString(args.host, "host");
  const host             = args.host.trim();
  const port             = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");
  const useTls           = !!args.use_tls;
  const rejectUnauth     = args.reject_unauthorized !== false;
  const timeoutMs        = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  const connectTimeout   = clampInt(args.connect_timeout, CONNECT_TIMEOUT_MS, 1000, 60000, "connect_timeout");
  const sessionTimeout   = clampInt(args.session_timeout, 30000, 2000, 120000, "session_timeout");

  const sock = await connectTcp(host, port, useTls, rejectUnauth, connectTimeout);
  const conn = new ZkConnection(sock, timeoutMs);

  try {
    const sessionInfo = await conn.connect(sessionTimeout);
    const result = await callback(conn, sessionInfo);
    await conn.closeSession();
    return { sessionInfo, result };
  } catch (err) {
    try { conn._socket.destroy(); } catch (_) {}
    throw err;
  }
}

// ── Guard helpers ─────────────────────────────────────────────────────────────

function requireString(val, name) {
  if (typeof val !== "string" || val.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
}

function clampInt(val, def, min, max, name) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

function requirePath(path) {
  requireString(path, "path");
  if (!path.startsWith("/"))
    throw new Error(`ZooKeeper path must start with '/': ${path}`);
  if (path.length > 512)
    throw new Error(`ZooKeeper path too long (max 512 chars): ${path.length}`);
}

/** Encode data argument: string→Buffer, Buffer→Buffer, null→null */
function encodeData(data) {
  if (data === null || data === undefined) return null;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  throw new Error("data must be a string, Buffer, or null");
}

/** Format session info for output */
function fmtSession(host, port, sessionInfo) {
  return {
    server:            `${host}:${port}`,
    sessionId:         sessionInfo.sessionId,
    negotiatedTimeout: sessionInfo.negotiatedTimeout,
    protocolVersion:   sessionInfo.protocolVersion,
  };
}

// ── Operations ────────────────────────────────────────────────────────────────

/**
 * connect — Open a session, retrieve session info, then close.
 * Useful as a connectivity check.
 */
async function opConnect(args) {
  requireString(args.host, "host");
  const host = args.host.trim();
  const port = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");

  const { sessionInfo } = await withZkSession(args, async (conn, si) => si);
  return {
    ok:        true,
    operation: "connect",
    ...fmtSession(host, port, sessionInfo),
  };
}

/**
 * get — Retrieve the data stored at a znode path, plus its Stat.
 */
async function opGet(args) {
  requirePath(args.path);
  const host = args.host.trim();
  const port = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");

  const { sessionInfo, result } = await withZkSession(args, async (conn) => {
    const body = new JuteEncoder();
    body.writeString(args.path);
    body.writeBool(false); // watch = false

    const { dec } = await conn._op(OpCode.getData, body);
    const data    = dec.readBytes();
    const stat    = dec.readStat();

    const dataStr = data ? data.toString("utf8") : null;
    const dataB64 = data ? data.toString("base64") : null;
    return {
      path:      args.path,
      data:      dataStr,
      dataBase64: dataB64,
      dataBytes: data ? data.length : 0,
      stat,
    };
  });

  return {
    ok:        true,
    operation: "get",
    ...fmtSession(host, port, sessionInfo),
    ...result,
  };
}

/**
 * set — Write new data to an existing znode.
 * version: -1 to match any version (no check).
 */
async function opSet(args) {
  requirePath(args.path);
  const host    = args.host.trim();
  const port    = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");
  const version = clampInt(args.version, -1, -1, 2147483647, "version");
  const dataBuf = encodeData(args.data);

  if (dataBuf && dataBuf.length > MAX_DATA_BYTES)
    throw new Error(`data exceeds 1 MB limit (${dataBuf.length} bytes)`);

  const { sessionInfo, result } = await withZkSession(args, async (conn) => {
    const body = new JuteEncoder();
    body.writeString(args.path);
    body.writeBytes(dataBuf);
    body.writeInt32(version);

    const { dec } = await conn._op(OpCode.setData, body);
    const stat    = dec.readStat();
    return {
      path:    args.path,
      version: stat.version,
      stat,
    };
  });

  return {
    ok:        true,
    operation: "set",
    ...fmtSession(host, port, sessionInfo),
    ...result,
  };
}

/**
 * create — Create a new znode at path with data and optional flags.
 * flags: 0=persistent, 1=ephemeral, 2=sequential persistent, 3=ephemeral+sequential
 */
async function opCreate(args) {
  requirePath(args.path);
  const host    = args.host.trim();
  const port    = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");
  const flags   = clampInt(args.flags, 0, 0, 3, "flags");
  const dataBuf = encodeData(args.data);

  if (dataBuf && dataBuf.length > MAX_DATA_BYTES)
    throw new Error(`data exceeds 1 MB limit (${dataBuf.length} bytes)`);

  // Parse ACL list or use default open ACL
  let acls = OPEN_ACL_UNSAFE;
  if (Array.isArray(args.acl) && args.acl.length > 0) {
    acls = args.acl.map(a => ({
      perms:  typeof a.perms === "number" ? a.perms : Perms.ALL,
      scheme: String(a.scheme || "world"),
      id:     String(a.id || "anyone"),
    }));
  }

  const { sessionInfo, result } = await withZkSession(args, async (conn) => {
    const body = new JuteEncoder();
    body.writeString(args.path);
    body.writeBytes(dataBuf);
    encodeAclList(body, acls);
    body.writeInt32(flags);

    const { dec } = await conn._op(OpCode.create, body);
    const createdPath = dec.readString();
    return { path: args.path, createdPath };
  });

  return {
    ok:        true,
    operation: "create",
    ...fmtSession(host, port, sessionInfo),
    ...result,
    flags,
    note: flags === 1 ? "Ephemeral node: auto-deleted when session closes" :
          flags === 2 ? "Sequential persistent node" :
          flags === 3 ? "Sequential ephemeral node" : "Persistent node",
  };
}

/**
 * delete — Delete a znode.
 * version: -1 to match any version (no check).
 */
async function opDelete(args) {
  requirePath(args.path);
  const host    = args.host.trim();
  const port    = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");
  const version = clampInt(args.version, -1, -1, 2147483647, "version");

  const { sessionInfo, result } = await withZkSession(args, async (conn) => {
    const body = new JuteEncoder();
    body.writeString(args.path);
    body.writeInt32(version);

    await conn._op(OpCode.delete, body);
    return { path: args.path, deleted: true };
  });

  return {
    ok:        true,
    operation: "delete",
    ...fmtSession(host, port, sessionInfo),
    ...result,
  };
}

/**
 * exists — Check whether a znode exists.
 * Returns Stat if it exists, null stat otherwise.
 */
async function opExists(args) {
  requirePath(args.path);
  const host = args.host.trim();
  const port = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");

  let stat = null;
  let exists = false;
  let sessionInfo;

  try {
    const res = await withZkSession(args, async (conn) => {
      const body = new JuteEncoder();
      body.writeString(args.path);
      body.writeBool(false); // watch = false

      const { dec } = await conn._op(OpCode.exists, body);
      return dec.readStat();
    });
    sessionInfo = res.sessionInfo;
    stat = res.result;
    exists = true;
  } catch (err) {
    if (!err.message.includes("NoNode")) throw err;
    // NoNode error means the node doesn't exist — that's ok
    // We still need sessionInfo; do a minimal connect
    const res = await withZkSession(args, async (conn, si) => si);
    sessionInfo = res.sessionInfo;
  }

  return {
    ok:        true,
    operation: "exists",
    ...fmtSession(host, port, sessionInfo),
    path:      args.path,
    exists,
    stat,
  };
}

/**
 * get_children — List child node names under a path.
 */
async function opGetChildren(args) {
  requirePath(args.path);
  const host = args.host.trim();
  const port = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");

  const { sessionInfo, result } = await withZkSession(args, async (conn) => {
    const body = new JuteEncoder();
    body.writeString(args.path);
    body.writeBool(false); // watch = false

    const { dec } = await conn._op(OpCode.getChildren, body);
    const children = dec.readStringVector();
    return { path: args.path, children, childCount: children.length };
  });

  return {
    ok:        true,
    operation: "get_children",
    ...fmtSession(host, port, sessionInfo),
    ...result,
  };
}

/**
 * get_acl — Get the ACL list for a znode.
 */
async function opGetAcl(args) {
  requirePath(args.path);
  const host = args.host.trim();
  const port = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");

  const { sessionInfo, result } = await withZkSession(args, async (conn) => {
    const body = new JuteEncoder();
    body.writeString(args.path);

    const { dec } = await conn._op(OpCode.getACL, body);
    const acl  = dec.readAclList();
    const stat = dec.readStat();
    return { path: args.path, acl, stat };
  });

  return {
    ok:        true,
    operation: "get_acl",
    ...fmtSession(host, port, sessionInfo),
    ...result,
  };
}

/** Return protocol/config/operation reference table — no I/O */
function opInfo() {
  return {
    protocol: "Apache ZooKeeper binary protocol (Jute serialization over TCP)",
    version:  "Compatible with ZooKeeper 3.4+ (protocol version 0)",
    defaultPort: DEFAULT_PORT,
    operations: [
      { op: "connect",      description: "Open a session and verify connectivity; returns sessionId and negotiated timeout" },
      { op: "get",          description: "Retrieve data bytes and Stat for a znode path" },
      { op: "set",          description: "Write new data to an existing znode (optionally versioned)" },
      { op: "create",       description: "Create a new znode with data, ACL, and flags (persistent/ephemeral/sequential)" },
      { op: "delete",       description: "Delete a znode by path (optionally versioned)" },
      { op: "exists",       description: "Check if a znode exists; returns Stat or null" },
      { op: "get_children", description: "List immediate child node names under a path" },
      { op: "get_acl",      description: "Retrieve the ACL list and Stat for a znode" },
      { op: "info",         description: "Return this protocol/config reference table (no I/O)" },
    ],
    znodeFlags: [
      { flag: 0, name: "PERSISTENT",           description: "Node persists after client session ends (default)" },
      { flag: 1, name: "EPHEMERAL",             description: "Node auto-deleted when creating session closes" },
      { flag: 2, name: "PERSISTENT_SEQUENTIAL", description: "Persistent + ZK appends a monotonic counter to the path" },
      { flag: 3, name: "EPHEMERAL_SEQUENTIAL",  description: "Ephemeral + sequential counter" },
    ],
    aclPerms: [
      { perm: 1,  name: "READ",   description: "Permission to read node data and children" },
      { perm: 2,  name: "WRITE",  description: "Permission to set data on the node" },
      { perm: 4,  name: "CREATE", description: "Permission to create child nodes" },
      { perm: 8,  name: "DELETE", description: "Permission to delete child nodes" },
      { perm: 16, name: "ADMIN",  description: "Permission to set ACL on the node" },
      { perm: 31, name: "ALL",    description: "All of the above" },
    ],
    defaultAcl: {
      perms: 31, scheme: "world", id: "anyone",
      description: "OPEN_ACL_UNSAFE — grants all permissions to everyone",
    },
    statFields: {
      czxid:          "Transaction ID of the change that created this znode",
      mzxid:          "Transaction ID of the change that last modified this znode",
      ctime:          "Creation time (ISO 8601)",
      mtime:          "Last modification time (ISO 8601)",
      version:        "Number of changes to this znode's data",
      cversion:       "Number of changes to this znode's children",
      aversion:       "Number of changes to this znode's ACL",
      ephemeralOwner: "Session ID of the owner (0 if not ephemeral)",
      dataLength:     "Length of the data field of this znode",
      numChildren:    "Number of children of this znode",
      pzxid:          "Transaction ID of the last change to children of this znode",
    },
    errorCodes: ZK_ERRORS,
    tlsNote: "ZooKeeper 3.5+ supports TLS. Pass use_tls:true and use port 2281 (or your configured secureClientPort).",
    useCases: [
      "Distributed configuration management",
      "Leader election coordination",
      "Distributed locks via ephemeral znodes",
      "Service discovery registration",
      "Distributed barrier synchronization",
    ],
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function zookeeperClient(args) {
  const operation = (args.operation || "").toLowerCase().replace(/-/g, "_");

  // Validate shared numeric args eagerly (even for info) so callers get
  // consistent validation errors regardless of operation.
  if (args.timeout         !== undefined && args.timeout         !== null)
    clampInt(args.timeout,         DEFAULT_TIMEOUT_MS,    1000,  120000, "timeout");
  if (args.connect_timeout !== undefined && args.connect_timeout !== null)
    clampInt(args.connect_timeout, CONNECT_TIMEOUT_MS,    1000,   60000, "connect_timeout");
  if (args.session_timeout !== undefined && args.session_timeout !== null)
    clampInt(args.session_timeout, 30000,                 2000,  120000, "session_timeout");
  if (args.port            !== undefined && args.port            !== null)
    clampInt(args.port,            DEFAULT_PORT,          1,      65535, "port");

  switch (operation) {
    case "connect":      return opConnect(args);
    case "get":          return opGet(args);
    case "set":          return opSet(args);
    case "create":       return opCreate(args);
    case "delete":       return opDelete(args);
    case "exists":       return opExists(args);
    case "get_children": return opGetChildren(args);
    case "get_acl":      return opGetAcl(args);
    case "info":         return opInfo();
    default:
      throw new Error(
        `Unknown zookeeper_client operation: '${args.operation}'. ` +
        "Valid: connect, get, set, create, delete, exists, get_children, get_acl, info"
      );
  }
}

module.exports = {
  zookeeperClient,
  // Exported for testing
  JuteEncoder, JuteDecoder,
  requirePath, encodeData, clampInt, requireString,
  OPEN_ACL_UNSAFE, Perms, OpCode, ZK_ERRORS, zkError,
};
