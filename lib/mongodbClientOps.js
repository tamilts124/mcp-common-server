"use strict";
// ── MongoDB Wire Protocol Client ─────────────────────────────────────────────
// Zero-dependency pure Node.js implementation of the MongoDB Wire Protocol.
// Supports MongoDB 3.6+ (OP_MSG command protocol).
// Operations: info, find, find_one, insert, insert_many, update, update_many,
//             delete, delete_many, count, aggregate, list_collections,
//             create_collection, drop_collection, create_index, list_indexes
// Auth: SCRAM-SHA-1, SCRAM-SHA-256, unauthenticated.
// Security: 32 MB response cap; NUL-byte guards; timeout clamp 1-300s;
//           no credentials in error messages; BSON size guard.

const net    = require("net");
const tls    = require("tls");
const crypto = require("crypto");

const MAX_DOC_BYTES     = 32 * 1024 * 1024; // 32 MB
const MAX_DOCS_RETURNED = 10_000;
const DEFAULT_TIMEOUT   = 30_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 300_000;
const DEFAULT_PORT      = 27017;
const BSON_MAX_SIZE     = 16 * 1024 * 1024; // 16 MB max BSON doc

// ── Timeout clamp ────────────────────────────────────────────────────────────
function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT;
  return Math.min(Math.max(Math.trunc(n), MIN_TIMEOUT), MAX_TIMEOUT);
}

// ── NUL guard ────────────────────────────────────────────────────────────────
function guardNul(v, name) {
  if (typeof v === "string" && v.includes("\0"))
    throw new Error(`mongodb_client: '${name}' must not contain NUL bytes.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal BSON encoder / decoder
// Only the types actually needed: double, string, document, array,
// binary, boolean, UTC datetime, null, int32, int64, objectid, timestamp.
// ─────────────────────────────────────────────────────────────────────────────

const BSON_DOUBLE   = 0x01;
const BSON_STRING   = 0x02;
const BSON_DOC      = 0x03;
const BSON_ARRAY    = 0x04;
const BSON_BINARY   = 0x05;
const BSON_BOOL     = 0x08;
const BSON_DATETIME = 0x09;
const BSON_NULL     = 0x0A;
const BSON_INT32    = 0x10;
const BSON_TIMESTAMP= 0x11;
const BSON_INT64    = 0x12;
const BSON_OBJECTID = 0x07;
const BSON_REGEX    = 0x0B;

// Encode a JS value to BSON bytes (returns Buffer)
function bsonEncodeValue(key, value, buf) {
  const keyBuf = Buffer.from(key, "utf8");

  if (value === null || value === undefined) {
    buf.push(Buffer.from([BSON_NULL]));
    buf.push(keyBuf); buf.push(Buffer.from([0]));
    return;
  }
  if (typeof value === "boolean") {
    buf.push(Buffer.from([BSON_BOOL]));
    buf.push(keyBuf); buf.push(Buffer.from([0]));
    buf.push(Buffer.from([value ? 1 : 0]));
    return;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      buf.push(Buffer.from([BSON_INT32]));
      buf.push(keyBuf); buf.push(Buffer.from([0]));
      const b = Buffer.allocUnsafe(4);
      b.writeInt32LE(value, 0);
      buf.push(b);
    } else if (Number.isInteger(value)) {
      // int64
      buf.push(Buffer.from([BSON_INT64]));
      buf.push(keyBuf); buf.push(Buffer.from([0]));
      const b = Buffer.allocUnsafe(8);
      const lo = value & 0xFFFFFFFF;
      const hi = Math.floor(value / 0x100000000);
      b.writeInt32LE(lo >>> 0, 0);
      b.writeInt32LE(hi, 4);
      buf.push(b);
    } else {
      buf.push(Buffer.from([BSON_DOUBLE]));
      buf.push(keyBuf); buf.push(Buffer.from([0]));
      const b2 = Buffer.allocUnsafe(8);
      b2.writeDoubleLE(value, 0);
      buf.push(b2);
    }
    return;
  }
  if (typeof value === "string") {
    buf.push(Buffer.from([BSON_STRING]));
    buf.push(keyBuf); buf.push(Buffer.from([0]));
    const strBuf = Buffer.from(value, "utf8");
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeInt32LE(strBuf.length + 1, 0);
    buf.push(lenBuf);
    buf.push(strBuf);
    buf.push(Buffer.from([0]));
    return;
  }
  if (Array.isArray(value)) {
    buf.push(Buffer.from([BSON_ARRAY]));
    buf.push(keyBuf); buf.push(Buffer.from([0]));
    const inner = [];
    for (let i = 0; i < value.length; i++)
      bsonEncodeValue(String(i), value[i], inner);
    const innerBuf = Buffer.concat(inner);
    const size = innerBuf.length + 5;
    const sizeBuf = Buffer.allocUnsafe(4);
    sizeBuf.writeInt32LE(size, 0);
    buf.push(sizeBuf); buf.push(innerBuf); buf.push(Buffer.from([0]));
    return;
  }
  if (value instanceof Date) {
    buf.push(Buffer.from([BSON_DATETIME]));
    buf.push(keyBuf); buf.push(Buffer.from([0]));
    const ms = BigInt(value.getTime());
    const b = Buffer.allocUnsafe(8);
    b.writeBigInt64LE(ms, 0);
    buf.push(b);
    return;
  }
  if (typeof value === "object") {
    buf.push(Buffer.from([BSON_DOC]));
    buf.push(keyBuf); buf.push(Buffer.from([0]));
    buf.push(bsonEncodeDoc(value));
    return;
  }
  // Fallback: encode as string
  buf.push(Buffer.from([BSON_STRING]));
  buf.push(keyBuf); buf.push(Buffer.from([0]));
  const strBuf = Buffer.from(String(value), "utf8");
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeInt32LE(strBuf.length + 1, 0);
  buf.push(lenBuf); buf.push(strBuf); buf.push(Buffer.from([0]));
}

function bsonEncodeDoc(doc) {
  const parts = [];
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    for (const [k, v] of Object.entries(doc))
      bsonEncodeValue(k, v, parts);
  }
  const body = Buffer.concat(parts);
  const size = body.length + 5;
  if (size > BSON_MAX_SIZE)
    throw new Error(`mongodb_client: document too large (${size} bytes; max ${BSON_MAX_SIZE}).`);
  const sizeBuf = Buffer.allocUnsafe(4);
  sizeBuf.writeInt32LE(size, 0);
  return Buffer.concat([sizeBuf, body, Buffer.from([0])]);
}

// Decode BSON bytes → JS object
function bsonDecodeDoc(buf, offset = 0) {
  if (buf.length - offset < 5) return { value: {}, end: offset };
  const docSize = buf.readInt32LE(offset);
  const end = offset + docSize;
  const doc = {};
  let pos = offset + 4;
  while (pos < end - 1) {
    const type = buf[pos++];
    if (type === 0) break; // terminal byte
    // read key (cstring)
    let keyEnd = pos;
    while (keyEnd < buf.length && buf[keyEnd] !== 0) keyEnd++;
    const key = buf.slice(pos, keyEnd).toString("utf8");
    pos = keyEnd + 1;
    let value;
    switch (type) {
      case BSON_DOUBLE: {
        value = buf.readDoubleLE(pos); pos += 8; break;
      }
      case BSON_STRING: {
        const slen = buf.readInt32LE(pos); pos += 4;
        value = buf.slice(pos, pos + slen - 1).toString("utf8");
        pos += slen; break;
      }
      case BSON_DOC: {
        const nested = bsonDecodeDoc(buf, pos);
        value = nested.value; pos = nested.end; break;
      }
      case BSON_ARRAY: {
        const nested = bsonDecodeDoc(buf, pos);
        // Convert object with numeric keys to array
        const arrObj = nested.value;
        const arr = [];
        for (const k of Object.keys(arrObj).sort((a, b) => +a - +b))
          arr.push(arrObj[k]);
        value = arr; pos = nested.end; break;
      }
      case BSON_BINARY: {
        const blen = buf.readInt32LE(pos); pos += 4;
        const _subtype = buf[pos++];
        value = buf.slice(pos, pos + blen).toString("base64"); pos += blen; break;
      }
      case BSON_BOOL: {
        value = buf[pos++] === 1; break;
      }
      case BSON_DATETIME: {
        const ms = buf.readBigInt64LE(pos); pos += 8;
        value = new Date(Number(ms)).toISOString(); break;
      }
      case BSON_NULL: {
        value = null; break;
      }
      case BSON_INT32: {
        value = buf.readInt32LE(pos); pos += 4; break;
      }
      case BSON_TIMESTAMP: {
        const inc  = buf.readUInt32LE(pos);
        const secs = buf.readUInt32LE(pos + 4);
        pos += 8;
        value = { t: secs, i: inc }; break;
      }
      case BSON_INT64: {
        try {
          const lo = buf.readInt32LE(pos);
          const hi = buf.readInt32LE(pos + 4);
          value = hi * 0x100000000 + (lo >>> 0);
        } catch { value = 0; }
        pos += 8; break;
      }
      case BSON_OBJECTID: {
        value = buf.slice(pos, pos + 12).toString("hex"); pos += 12; break;
      }
      case BSON_REGEX: {
        // pattern (cstring) + flags (cstring)
        let pEnd = pos;
        while (pEnd < buf.length && buf[pEnd] !== 0) pEnd++;
        const pattern = buf.slice(pos, pEnd).toString("utf8");
        pos = pEnd + 1;
        let fEnd = pos;
        while (fEnd < buf.length && buf[fEnd] !== 0) fEnd++;
        const flags = buf.slice(pos, fEnd).toString("utf8");
        pos = fEnd + 1;
        value = `/${pattern}/${flags}`; break;
      }
      default: {
        // unknown type — skip to end of doc
        pos = end; break;
      }
    }
    doc[key] = value;
  }
  return { value: doc, end };
}

// ── OP_MSG frame builder ──────────────────────────────────────────────────────
let _requestId = 1;
function nextRequestId() { return (_requestId = (_requestId & 0x7FFFFFFF) + 1); }

function buildOpMsg(commandDoc) {
  const reqId   = nextRequestId();
  const flagBits = Buffer.from([0, 0, 0, 0]);       // flagBits = 0
  const sectionKind = Buffer.from([0]);              // section kind = body
  const body = bsonEncodeDoc(commandDoc);
  const msgLen = 4 + 4 + 4 + 4 + 4 + 1 + body.length; // header(16) + flagBits(4) + sectionKind(1) + body
  const header = Buffer.allocUnsafe(16);
  header.writeInt32LE(msgLen, 0);          // messageLength
  header.writeInt32LE(reqId, 4);           // requestID
  header.writeInt32LE(0, 8);              // responseTo
  header.writeInt32LE(2013, 12);          // opCode = OP_MSG
  return Buffer.concat([header, flagBits, sectionKind, body]);
}

// ── TCP/TLS connection ────────────────────────────────────────────────────────
function openConnection(host, port, opts) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    let sock;
    if (opts.tls) {
      sock = tls.connect({
        host, port,
        rejectUnauthorized: opts.rejectUnauthorized !== false,
        servername: opts.servername || host,
      });
    } else {
      sock = net.createConnection({ host, port });
    }
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`mongodb_client: connection to ${host}:${port} timed out.`));
    }, timeout);
    sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
    sock.once("secureConnect", () => { clearTimeout(timer); resolve(sock); });
    sock.once("error", (err) => {
      clearTimeout(timer);
      // redact any password from error
      reject(new Error(`mongodb_client: ${err.message.replace(/:[^@/]+@/, ":***@")}`));
    });
  });
}

// ── Send command and read single OP_MSG reply ─────────────────────────────────
function sendCommand(sock, commandDoc, timeoutMs) {
  return new Promise((resolve, reject) => {
    const msg = buildOpMsg(commandDoc);
    const chunks = [];
    let totalBytes = 0;
    let headerRead = false;
    let expectedLen = 0;

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`mongodb_client: command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    function onData(chunk) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_DOC_BYTES) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        sock.removeListener("error", onErr);
        reject(new Error(`mongodb_client: response too large (>${MAX_DOC_BYTES} bytes).`));
        return;
      }
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (!headerRead && buf.length >= 4) {
        expectedLen = buf.readInt32LE(0);
        headerRead = true;
      }
      if (headerRead && buf.length >= expectedLen) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        sock.removeListener("error", onErr);
        try {
          // OP_MSG response: header(16) + flagBits(4) + sectionKind(1) + bson
          const bsonStart = 21;
          const { value } = bsonDecodeDoc(buf, bsonStart);
          resolve(value);
        } catch (e) {
          reject(new Error(`mongodb_client: failed to decode response: ${e.message}`));
        }
      }
    }
    function onErr(err) {
      clearTimeout(timer);
      reject(new Error(`mongodb_client: ${err.message}`));
    }
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.write(msg);
  });
}

// ── SCRAM authentication ──────────────────────────────────────────────────────
function generateClientNonce() {
  return crypto.randomBytes(24).toString("base64");
}

async function scramAuth(sock, db, username, password, mechanism, timeoutMs) {
  // mechanism: 'SCRAM-SHA-1' or 'SCRAM-SHA-256'
  const isS256 = mechanism === "SCRAM-SHA-256";
  const hashAlgo = isS256 ? "sha256" : "sha1";
  const clientNonce = generateClientNonce();
  const clientFirstBare = `n=${username},r=${clientNonce}`;
  const clientFirst = "n,," + clientFirstBare;

  // saslStart
  const startResp = await sendCommand(sock, {
    saslStart: 1,
    mechanism,
    payload: { $binary: { base64: Buffer.from(clientFirst).toString("base64"), subType: "0" } },
    options: { skipEmptyExchange: true },
    $db: db,
  }, timeoutMs);

  if (startResp.ok !== 1)
    throw new Error(`mongodb_client: SCRAM saslStart failed: ${JSON.stringify(startResp.errmsg || startResp)}`);

  const conversationId = startResp.conversationId;
  const serverFirstRaw = startResp.payload
    ? Buffer.from(startResp.payload, "base64").toString("utf8")
    : "";

  // Parse server-first-message
  const sfm = {};
  for (const part of serverFirstRaw.split(",")) {
    const idx = part.indexOf("=");
    if (idx > 0) sfm[part.slice(0, idx)] = part.slice(idx + 1);
  }
  const serverNonce  = sfm.r || "";
  const salt         = Buffer.from(sfm.s || "", "base64");
  const iterations   = parseInt(sfm.i || "4096", 10);

  if (!serverNonce.startsWith(clientNonce))
    throw new Error("mongodb_client: SCRAM server nonce does not start with client nonce (possible MITM).");

  // Derive SaltedPassword
  let normalizedPassword;
  if (isS256) {
    // SASLprep (simplified: only NFC normalize)
    try { normalizedPassword = password.normalize("NFC"); } catch { normalizedPassword = password; }
  } else {
    normalizedPassword = password;
  }
  const saltedPassword = crypto.pbkdf2Sync(
    normalizedPassword, salt, iterations, isS256 ? 32 : 20, hashAlgo
  );

  function hmacOf(key, data) {
    return crypto.createHmac(hashAlgo, key).update(data).digest();
  }
  function h(data) { return crypto.createHash(hashAlgo).update(data).digest(); }

  const clientKey = hmacOf(saltedPassword, "Client Key");
  const storedKey = h(clientKey);
  const serverKey = hmacOf(saltedPassword, "Server Key");

  const channelBinding = "c=biws"; // base64("n,,")
  const clientFinalWithoutProof = `${channelBinding},r=${serverNonce}`;
  const authMessage = `${clientFirstBare},${serverFirstRaw},${clientFinalWithoutProof}`;

  const clientSignature = hmacOf(storedKey, authMessage);
  const clientProofBuf  = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++)
    clientProofBuf[i] = clientKey[i] ^ clientSignature[i];
  const clientProof = clientProofBuf.toString("base64");

  const clientFinal = `${clientFinalWithoutProof},p=${clientProof}`;

  // saslContinue
  const contResp = await sendCommand(sock, {
    saslContinue: 1,
    conversationId,
    payload: Buffer.from(clientFinal).toString("base64"),
    $db: db,
  }, timeoutMs);

  if (contResp.ok !== 1)
    throw new Error(`mongodb_client: SCRAM saslContinue failed: ${JSON.stringify(contResp.errmsg || contResp)}`);

  // Optionally verify server signature
  if (contResp.payload) {
    const serverFinalRaw = Buffer.from(contResp.payload, "base64").toString("utf8");
    const sfFinal = {};
    for (const part of serverFinalRaw.split(",")) {
      const idx = part.indexOf("=");
      if (idx > 0) sfFinal[part.slice(0, idx)] = part.slice(idx + 1);
    }
    if (sfFinal.v) {
      const expectedServerSig = hmacOf(serverKey, authMessage).toString("base64");
      if (sfFinal.v !== expectedServerSig)
        throw new Error("mongodb_client: SCRAM server signature verification failed.");
    }
    // If done=false, need one more saslContinue with empty payload
    if (contResp.done === false) {
      const finalResp = await sendCommand(sock, {
        saslContinue: 1,
        conversationId,
        payload: "",
        $db: db,
      }, timeoutMs);
      if (finalResp.ok !== 1)
        throw new Error(`mongodb_client: SCRAM final step failed: ${finalResp.errmsg}`);
    }
  }
}

// ── Connection + Auth helper ──────────────────────────────────────────────────
async function connect(cfg) {
  const sock = await openConnection(cfg.host, cfg.port, {
    timeout:           cfg.timeout,
    tls:               cfg.tls,
    rejectUnauthorized: cfg.rejectUnauthorized,
    servername:        cfg.servername,
  });

  if (cfg.username && cfg.password) {
    const mechanism = cfg.mechanism || "SCRAM-SHA-256";
    const authDb = cfg.authDb || cfg.db || "admin";
    await scramAuth(sock, authDb, cfg.username, cfg.password, mechanism, cfg.timeout);
  }
  return sock;
}

// ── Parse MongoDB connection URI ──────────────────────────────────────────────
function parseMongoUri(uri) {
  // mongodb://[user:pass@]host[:port][/db][?opts]
  // mongodb+srv not supported (requires DNS SRV)
  if (!uri) return null;
  const m = uri.match(
    /^mongodb:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^/:?]+)(?::(\d+))?(?:\/([^?]*))?(?:\?(.*))?$/i
  );
  if (!m) return null;
  const [, user, pass, host, port, dbPart, query] = m;
  const opts = {};
  if (query) for (const kv of query.split("&")) {
    const [k, v] = kv.split("=");
    opts[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return {
    username: user ? decodeURIComponent(user) : undefined,
    password: pass != null ? decodeURIComponent(pass) : undefined,
    host: host || "localhost",
    port: port ? parseInt(port, 10) : DEFAULT_PORT,
    db:   dbPart || "test",
    tls:  opts.tls === "true" || opts.ssl === "true",
    authSource: opts.authSource,
    authMechanism: opts.authMechanism,
  };
}

// ── Build connection config from args ─────────────────────────────────────────
function buildCfg(args) {
  let cfg;
  if (args.uri) {
    const parsed = parseMongoUri(args.uri);
    if (!parsed)
      throw new Error(`mongodb_client: invalid MongoDB URI: ${args.uri.replace(/:[^@/]+@/, ":***@")}`);
    cfg = {
      host:     parsed.host,
      port:     parsed.port,
      db:       args.db || parsed.db || "test",
      username: args.username || parsed.username,
      password: args.password || parsed.password,
      tls:      args.tls ?? parsed.tls ?? false,
      authDb:   args.auth_db || parsed.authSource || parsed.db || "admin",
      mechanism: args.auth_mechanism || parsed.authMechanism || "SCRAM-SHA-256",
    };
  } else {
    cfg = {
      host:     args.host || "localhost",
      port:     args.port || DEFAULT_PORT,
      db:       args.db || "test",
      username: args.username,
      password: args.password,
      tls:      args.tls ?? false,
      authDb:   args.auth_db || "admin",
      mechanism: args.auth_mechanism || "SCRAM-SHA-256",
    };
  }
  cfg.timeout           = clampTimeout(args.timeout);
  cfg.rejectUnauthorized = args.reject_unauthorized !== false;
  return cfg;
}

// ── Helper: run a command and close connection ─────────────────────────────────
async function runCommand(cfg, doc) {
  const sock = await connect(cfg);
  try {
    const resp = await sendCommand(sock, { ...doc, $db: cfg.db }, cfg.timeout);
    return resp;
  } finally {
    sock.destroy();
  }
}

// ── sanitize documents for output (remove internal _id representation quirks) ─
function sanitizeDoc(doc) {
  if (!doc || typeof doc !== "object") return doc;
  if (Array.isArray(doc)) return doc.map(sanitizeDoc);
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "_id" && typeof v === "string" && /^[0-9a-f]{24}$/.test(v)) {
      out["_id"] = { $oid: v };
    } else {
      out[k] = sanitizeDoc(v);
    }
  }
  return out;
}

// ── Operations ─────────────────────────────────────────────────────────────────

async function opInfo(cfg) {
  const r = await runCommand(cfg, { buildInfo: 1 });
  if (r.ok !== 1)
    throw new Error(`mongodb_client info: ${r.errmsg || JSON.stringify(r)}`);
  const h = await runCommand(cfg, { hello: 1 });
  return {
    operation:    "info",
    version:      r.version,
    gitVersion:   r.gitVersion,
    modules:      r.modules,
    allocator:    r.allocator,
    bits:         r.bits,
    maxBsonSize:  r.maxBsonObjectSize,
    // hello response
    isWritablePrimary: h.isWritablePrimary ?? h.ismaster,
    setName:      h.setName,
    hosts:        h.hosts,
    me:           h.me,
    readOnly:     h.readOnly,
    connectionId: h.connectionId,
  };
}

async function opFind(cfg, args) {
  const coll = args.collection;
  if (!coll) throw new Error("mongodb_client find: 'collection' is required.");
  const limit = Math.min(args.limit ?? 100, MAX_DOCS_RETURNED);
  const cmd = {
    find: coll,
    filter: args.filter || {},
    limit,
    skip: args.skip || 0,
  };
  if (args.projection) cmd.projection = args.projection;
  if (args.sort)       cmd.sort       = args.sort;
  if (args.hint)       cmd.hint       = args.hint;
  const r = await runCommand(cfg, cmd);
  if (r.ok !== 1)
    throw new Error(`mongodb_client find: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  const docs = r.cursor?.firstBatch || [];
  return {
    operation:  "find",
    collection: coll,
    filter:     args.filter || {},
    count:      docs.length,
    limit,
    skip:       args.skip || 0,
    documents:  docs.map(sanitizeDoc),
    cursorId:   r.cursor?.id,
  };
}

async function opFindOne(cfg, args) {
  const r = await opFind(cfg, { ...args, limit: 1 });
  return {
    operation:  "find_one",
    collection: args.collection,
    filter:     args.filter || {},
    found:      r.documents.length > 0,
    document:   r.documents[0] || null,
  };
}

async function opInsert(cfg, args) {
  const coll = args.collection;
  if (!coll) throw new Error("mongodb_client insert: 'collection' is required.");
  if (!args.document) throw new Error("mongodb_client insert: 'document' is required.");
  const r = await runCommand(cfg, {
    insert: coll,
    documents: [args.document],
    ordered: true,
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client insert: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:  "insert",
    collection: coll,
    insertedCount: r.n || 0,
    writeErrors: r.writeErrors || [],
  };
}

async function opInsertMany(cfg, args) {
  const coll = args.collection;
  if (!coll) throw new Error("mongodb_client insert_many: 'collection' is required.");
  if (!Array.isArray(args.documents) || args.documents.length === 0)
    throw new Error("mongodb_client insert_many: 'documents' must be a non-empty array.");
  const r = await runCommand(cfg, {
    insert: coll,
    documents: args.documents,
    ordered:   args.ordered !== false,
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client insert_many: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:     "insert_many",
    collection:    coll,
    insertedCount: r.n || 0,
    writeErrors:   r.writeErrors || [],
  };
}

async function opUpdate(cfg, args) {
  const coll = args.collection;
  if (!coll)          throw new Error("mongodb_client update: 'collection' is required.");
  if (!args.filter)   throw new Error("mongodb_client update: 'filter' is required.");
  if (!args.update)   throw new Error("mongodb_client update: 'update' is required.");
  const r = await runCommand(cfg, {
    update: coll,
    updates: [{
      q:      args.filter,
      u:      args.update,
      multi:  false,
      upsert: args.upsert || false,
    }],
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client update: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:     "update",
    collection:    coll,
    matchedCount:  r.n || 0,
    modifiedCount: r.nModified || 0,
    upsertedId:    r.upserted?.[0]?._id || null,
    writeErrors:   r.writeErrors || [],
  };
}

async function opUpdateMany(cfg, args) {
  const coll = args.collection;
  if (!coll)        throw new Error("mongodb_client update_many: 'collection' is required.");
  if (!args.filter) throw new Error("mongodb_client update_many: 'filter' is required.");
  if (!args.update) throw new Error("mongodb_client update_many: 'update' is required.");
  const r = await runCommand(cfg, {
    update: coll,
    updates: [{
      q:      args.filter,
      u:      args.update,
      multi:  true,
      upsert: args.upsert || false,
    }],
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client update_many: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:     "update_many",
    collection:    coll,
    matchedCount:  r.n || 0,
    modifiedCount: r.nModified || 0,
    writeErrors:   r.writeErrors || [],
  };
}

async function opDelete(cfg, args) {
  const coll = args.collection;
  if (!coll)        throw new Error("mongodb_client delete: 'collection' is required.");
  if (!args.filter) throw new Error("mongodb_client delete: 'filter' is required.");
  const r = await runCommand(cfg, {
    delete: coll,
    deletes: [{ q: args.filter, limit: 1 }],
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client delete: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:    "delete",
    collection:   coll,
    deletedCount: r.n || 0,
    writeErrors:  r.writeErrors || [],
  };
}

async function opDeleteMany(cfg, args) {
  const coll = args.collection;
  if (!coll)        throw new Error("mongodb_client delete_many: 'collection' is required.");
  if (!args.filter) throw new Error("mongodb_client delete_many: 'filter' is required.");
  const r = await runCommand(cfg, {
    delete: coll,
    deletes: [{ q: args.filter, limit: 0 }], // 0 = no limit (delete all matching)
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client delete_many: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:    "delete_many",
    collection:   coll,
    deletedCount: r.n || 0,
    writeErrors:  r.writeErrors || [],
  };
}

async function opCount(cfg, args) {
  const coll = args.collection;
  if (!coll) throw new Error("mongodb_client count: 'collection' is required.");
  const r = await runCommand(cfg, {
    count: coll,
    query: args.filter || {},
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client count: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:  "count",
    collection: coll,
    filter:     args.filter || {},
    count:      r.n || 0,
  };
}

async function opAggregate(cfg, args) {
  const coll = args.collection;
  if (!coll) throw new Error("mongodb_client aggregate: 'collection' is required.");
  if (!Array.isArray(args.pipeline))
    throw new Error("mongodb_client aggregate: 'pipeline' must be an array.");
  const r = await runCommand(cfg, {
    aggregate: coll,
    pipeline: args.pipeline,
    cursor: { batchSize: Math.min(args.batch_size || 100, MAX_DOCS_RETURNED) },
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client aggregate: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  const docs = r.cursor?.firstBatch || [];
  return {
    operation:  "aggregate",
    collection: coll,
    count:      docs.length,
    results:    docs.map(sanitizeDoc),
    cursorId:   r.cursor?.id,
  };
}

async function opListCollections(cfg, args) {
  const r = await runCommand(cfg, {
    listCollections: 1,
    filter: args.filter || {},
    nameOnly: args.name_only !== false,
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client list_collections: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  const colls = r.cursor?.firstBatch || [];
  return {
    operation:   "list_collections",
    database:    cfg.db,
    count:       colls.length,
    collections: colls.map(c => ({
      name:    c.name,
      type:    c.type,
      options: c.options,
      info:    c.idIndex ? { idIndex: c.idIndex } : undefined,
    })),
  };
}

async function opCreateCollection(cfg, args) {
  const name = args.collection;
  if (!name) throw new Error("mongodb_client create_collection: 'collection' is required.");
  const cmd = { create: name };
  if (args.capped)    cmd.capped = args.capped;
  if (args.size)      cmd.size   = args.size;
  if (args.max)       cmd.max    = args.max;
  if (args.validator) cmd.validator = args.validator;
  const r = await runCommand(cfg, cmd);
  if (r.ok !== 1)
    throw new Error(`mongodb_client create_collection: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:    "create_collection",
    collection:   name,
    acknowledged: r.ok === 1,
  };
}

async function opDropCollection(cfg, args) {
  const name = args.collection;
  if (!name) throw new Error("mongodb_client drop_collection: 'collection' is required.");
  const r = await runCommand(cfg, { drop: name });
  // ok=0 + ns not found is acceptable (collection didn't exist)
  if (r.ok !== 1 && r.code !== 26)
    throw new Error(`mongodb_client drop_collection: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:    "drop_collection",
    collection:   name,
    dropped:      r.ok === 1,
    ns:           r.ns,
  };
}

async function opCreateIndex(cfg, args) {
  const coll = args.collection;
  if (!coll)      throw new Error("mongodb_client create_index: 'collection' is required.");
  if (!args.keys) throw new Error("mongodb_client create_index: 'keys' is required.");
  const indexSpec = { key: args.keys, name: args.name || Object.keys(args.keys).join("_") };
  if (args.unique)  indexSpec.unique  = args.unique;
  if (args.sparse)  indexSpec.sparse  = args.sparse;
  if (args.expire_after_seconds != null) indexSpec.expireAfterSeconds = args.expire_after_seconds;
  const r = await runCommand(cfg, {
    createIndexes: coll,
    indexes: [indexSpec],
  });
  if (r.ok !== 1)
    throw new Error(`mongodb_client create_index: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  return {
    operation:    "create_index",
    collection:   coll,
    indexName:    indexSpec.name,
    numIndexesAfter: r.numIndexesAfter,
    acknowledged: r.ok === 1,
    note:         r.note,
  };
}

async function opListIndexes(cfg, args) {
  const coll = args.collection;
  if (!coll) throw new Error("mongodb_client list_indexes: 'collection' is required.");
  const r = await runCommand(cfg, { listIndexes: coll, cursor: {} });
  if (r.ok !== 1)
    throw new Error(`mongodb_client list_indexes: ${r.errmsg || JSON.stringify(r).slice(0, 400)}`);
  const indexes = r.cursor?.firstBatch || [];
  return {
    operation:  "list_indexes",
    collection: coll,
    count:      indexes.length,
    indexes:    indexes.map(ix => ({
      name:     ix.name,
      key:      ix.key,
      unique:   ix.unique || false,
      sparse:   ix.sparse || false,
      expireAfterSeconds: ix.expireAfterSeconds,
    })),
  };
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function mongodbClient(args) {
  const {
    operation, uri, host, port, db, username, password, tls, reject_unauthorized,
    auth_db, auth_mechanism, timeout,
    collection, filter, document, documents, update, pipeline,
    projection, sort, skip, limit, upsert, ordered,
    keys, name, unique, sparse, expire_after_seconds,
    capped, size, max, validator,
    name_only, batch_size, hint,
  } = args;

  const VALID_OPS = [
    "info", "find", "find_one", "insert", "insert_many",
    "update", "update_many", "delete", "delete_many",
    "count", "aggregate", "list_collections",
    "create_collection", "drop_collection",
    "create_index", "list_indexes",
  ];

  if (!operation)
    throw new Error("mongodb_client: 'operation' is required.");
  if (!VALID_OPS.includes(operation))
    throw new Error(`mongodb_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`);

  // Require either uri or host
  if (!uri && !host && operation !== "info")
    throw new Error("mongodb_client: provide 'uri' or 'host'.");
  if (!uri && !host)
    throw new Error("mongodb_client: provide 'uri' or 'host'.");

  // NUL guards
  if (uri)      guardNul(uri, "uri");
  if (host)     guardNul(host, "host");
  if (db)       guardNul(db, "db");
  if (username) guardNul(username, "username");
  if (collection) guardNul(collection, "collection");

  const cfg = buildCfg(args);

  switch (operation) {
    case "info":              return opInfo(cfg);
    case "find":              return opFind(cfg, args);
    case "find_one":          return opFindOne(cfg, args);
    case "insert":            return opInsert(cfg, args);
    case "insert_many":       return opInsertMany(cfg, args);
    case "update":            return opUpdate(cfg, args);
    case "update_many":       return opUpdateMany(cfg, args);
    case "delete":            return opDelete(cfg, args);
    case "delete_many":       return opDeleteMany(cfg, args);
    case "count":             return opCount(cfg, args);
    case "aggregate":         return opAggregate(cfg, args);
    case "list_collections":  return opListCollections(cfg, args);
    case "create_collection": return opCreateCollection(cfg, args);
    case "drop_collection":   return opDropCollection(cfg, args);
    case "create_index":      return opCreateIndex(cfg, args);
    case "list_indexes":      return opListIndexes(cfg, args);
    default:
      throw new Error(`mongodb_client: unhandled operation '${operation}'.`);
  }
}

module.exports = { mongodbClient };
