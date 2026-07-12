"use strict";
// lib/kafkaClientOps.js — Zero-dependency Apache Kafka client
// Uses Node.js built-in `net` only. No npm dependencies.
//
// Implements Kafka protocol v2 wire format (compatible with Kafka 0.10+)
// API versions used:
//   ApiVersions       v0  (ApiKey 18)
//   Metadata          v1  (ApiKey  3)
//   Produce           v2  (ApiKey  0)
//   Fetch             v4  (ApiKey  1)
//   ListOffsets       v1  (ApiKey  2)
//   CreateTopics      v0  (ApiKey 19)
//   DeleteTopics      v0  (ApiKey 20)
//   SaslHandshake     v0  (ApiKey 17)
//   SaslAuthenticate  v0  (ApiKey 36)

const net = require("net");

// ─── Kafka API Keys ─────────────────────────────────────────────────────────
const API = {
  PRODUCE:           0,
  FETCH:             1,
  LIST_OFFSETS:      2,
  METADATA:          3,
  SASL_HANDSHAKE:   17,
  API_VERSIONS:     18,
  CREATE_TOPICS:    19,
  DELETE_TOPICS:    20,
  SASL_AUTHENTICATE:36,
};

// ─── Kafka Error Codes ───────────────────────────────────────────────────────
const KAFKA_ERRORS = {
  0:   "NONE",
  1:   "OFFSET_OUT_OF_RANGE",
  2:   "CORRUPT_MESSAGE",
  3:   "UNKNOWN_TOPIC_OR_PARTITION",
  4:   "INVALID_FETCH_SIZE",
  5:   "LEADER_NOT_AVAILABLE",
  6:   "NOT_LEADER_OR_FOLLOWER",
  7:   "REQUEST_TIMED_OUT",
  8:   "BROKER_NOT_AVAILABLE",
  9:   "REPLICA_NOT_AVAILABLE",
  10:  "MESSAGE_TOO_LARGE",
  12:  "OFFSET_METADATA_TOO_LARGE",
  13:  "NETWORK_EXCEPTION",
  14:  "COORDINATOR_LOAD_IN_PROGRESS",
  15:  "COORDINATOR_NOT_AVAILABLE",
  16:  "NOT_COORDINATOR",
  17:  "INVALID_TOPIC_EXCEPTION",
  18:  "RECORD_LIST_TOO_LARGE",
  19:  "NOT_ENOUGH_REPLICAS",
  20:  "NOT_ENOUGH_REPLICAS_AFTER_APPEND",
  21:  "INVALID_REQUIRED_ACKS",
  22:  "ILLEGAL_GENERATION",
  25:  "UNKNOWN_MEMBER_ID",
  26:  "INVALID_SESSION_TIMEOUT",
  29:  "INVALID_COMMIT_OFFSET_SIZE",
  35:  "SASL_AUTHENTICATION_FAILED",
  36:  "UNKNOWN_SASL_MECHANISM",
  37:  "INVALID_SASL_STATE",
  38:  "UNSUPPORTED_VERSION",
  39:  "TOPIC_ALREADY_EXISTS",
  40:  "INVALID_PARTITIONS",
  41:  "INVALID_REPLICATION_FACTOR",
  42:  "INVALID_REPLICA_ASSIGNMENT",
  43:  "INVALID_CONFIG",
  44:  "NOT_CONTROLLER",
  45:  "INVALID_REQUEST",
  47:  "UNSUPPORTED_FOR_MESSAGE_FORMAT",
  48:  "POLICY_VIOLATION",
  56:  "REASSIGNMENT_IN_PROGRESS",
};

function kafkaErrorName(code) {
  return KAFKA_ERRORS[code] || `UNKNOWN_ERROR(${code})`;
}

// ─── Binary Codec Helpers ─────────────────────────────────────────────────────

// INT8
function writeInt8(buf, offset, val) {
  buf.writeInt8(val, offset); return offset + 1;
}
// INT16 big-endian
function writeInt16(buf, offset, val) {
  buf.writeInt16BE(val, offset); return offset + 2;
}
// INT32 big-endian
function writeInt32(buf, offset, val) {
  buf.writeInt32BE(val, offset); return offset + 4;
}
// INT64 big-endian (as two 32-bit halves; JS safe for display)
function writeInt64(buf, offset, hi, lo) {
  buf.writeUInt32BE(hi >>> 0, offset);
  buf.writeUInt32BE(lo >>> 0, offset + 4);
  return offset + 8;
}
// NULLABLE STRING (-1 for null, else INT16 + bytes)
function writeString(buf, offset, str) {
  if (str === null || str === undefined) {
    buf.writeInt16BE(-1, offset); return offset + 2;
  }
  const bytes = Buffer.from(str, "utf8");
  buf.writeInt16BE(bytes.length, offset); offset += 2;
  bytes.copy(buf, offset); return offset + bytes.length;
}
// NULLABLE BYTES (-1 for null, else INT32 + bytes)
function writeBytes(buf, offset, bytes) {
  if (bytes === null || bytes === undefined) {
    buf.writeInt32BE(-1, offset); return offset + 4;
  }
  buf.writeInt32BE(bytes.length, offset); offset += 4;
  bytes.copy(buf, offset); return offset + bytes.length;
}
// STRING byte size
function strSize(str) {
  if (str === null || str === undefined) return 2;
  return 2 + Buffer.byteLength(str, "utf8");
}
// BYTES byte size
function bytesSize(bytes) {
  if (bytes === null || bytes === undefined) return 4;
  return 4 + bytes.length;
}

// ── Decoder helpers ──────────────────────────────────────────────────────────
function readInt8(buf, offset) {
  return { value: buf.readInt8(offset), offset: offset + 1 };
}
function readInt16(buf, offset) {
  return { value: buf.readInt16BE(offset), offset: offset + 2 };
}
function readInt32(buf, offset) {
  return { value: buf.readInt32BE(offset), offset: offset + 4 };
}
function readInt64(buf, offset) {
  const hi = buf.readInt32BE(offset);
  const lo = buf.readUInt32BE(offset + 4);
  // Return as number (precise up to 2^53)
  const value = hi * 4294967296 + lo;
  return { value, offset: offset + 8 };
}
function readString(buf, offset) {
  const len = buf.readInt16BE(offset); offset += 2;
  if (len < 0) return { value: null, offset };
  const value = buf.toString("utf8", offset, offset + len);
  return { value, offset: offset + len };
}
function readBytes(buf, offset) {
  const len = buf.readInt32BE(offset); offset += 4;
  if (len < 0) return { value: null, offset };
  const value = buf.slice(offset, offset + len);
  return { value, offset: offset + len };
}

// ─── Correlation ID counter ───────────────────────────────────────────────────
let _correlationId = 1;
function nextCorrelationId() {
  return (_correlationId++ & 0x7fffffff) || 1;
}

// ─── Request Header (v0/v1) ───────────────────────────────────────────────────
// RequestHeader = [api_key INT16] [api_version INT16] [correlation_id INT32] [client_id STRING]
function buildRequestHeader(apiKey, apiVersion, correlationId, clientId) {
  const cidBuf = clientId || "kafka_client";
  const headerSize = 2 + 2 + 4 + strSize(cidBuf);
  const buf = Buffer.allocUnsafe(headerSize);
  let off = 0;
  off = writeInt16(buf, off, apiKey);
  off = writeInt16(buf, off, apiVersion);
  off = writeInt32(buf, off, correlationId);
  off = writeString(buf, off, cidBuf);
  return buf;
}

// Wrap a request body with the 4-byte length prefix
function frameRequest(headerBuf, bodyBuf) {
  const totalLen = headerBuf.length + (bodyBuf ? bodyBuf.length : 0);
  const frame = Buffer.allocUnsafe(4 + totalLen);
  frame.writeInt32BE(totalLen, 0);
  headerBuf.copy(frame, 4);
  if (bodyBuf) bodyBuf.copy(frame, 4 + headerBuf.length);
  return frame;
}

// ─── TCP Connection Helper ───────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Open a TCP connection, do SASL handshake if needed,
 * then return a { sendRequest, close } handle.
 */
async function openKafkaConnection(opts) {
  const {
    host, port, timeout, connectTimeout,
    saslMechanism, saslUsername, saslPassword,
    clientId,
  } = opts;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    let rxBuf = Buffer.alloc(0);
    const pendingRequests = new Map(); // correlationId -> { resolve, reject }

    // Global timeout
    const globalTimer = setTimeout(() => {
      if (done) return;
      done = true;
      socket.destroy(new Error(`kafka_client: connection timeout after ${timeout}ms`));
    }, timeout);

    // Connect timeout
    const connectTimer = setTimeout(() => {
      if (!socket.connecting) return;
      socket.destroy(new Error(`kafka_client: connect timeout after ${connectTimeout}ms (${host}:${port})`));
    }, connectTimeout);

    socket.on("error", (err) => {
      clearTimeout(globalTimer);
      clearTimeout(connectTimer);
      if (!done) { done = true; reject(err); }
      // Reject all pending requests
      for (const [, p] of pendingRequests) p.reject(err);
      pendingRequests.clear();
    });

    socket.on("close", () => {
      clearTimeout(globalTimer);
      clearTimeout(connectTimer);
      const err = new Error("kafka_client: connection closed");
      for (const [, p] of pendingRequests) p.reject(err);
      pendingRequests.clear();
    });

    socket.on("data", (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      if (rxBuf.length > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error(`kafka_client: response exceeded ${MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      // Parse as many complete frames as possible
      while (rxBuf.length >= 4) {
        const msgLen = rxBuf.readInt32BE(0);
        if (rxBuf.length < 4 + msgLen) break;
        const frame = rxBuf.slice(4, 4 + msgLen);
        rxBuf = rxBuf.slice(4 + msgLen);
        // Read correlation_id from frame
        if (frame.length < 4) continue;
        const corrId = frame.readInt32BE(0);
        const payload = frame.slice(4);
        const pending = pendingRequests.get(corrId);
        if (pending) {
          pendingRequests.delete(corrId);
          pending.resolve(payload);
        }
      }
    });

    // Helper: send one request and await its response
    function sendRequest(apiKey, apiVersion, bodyBuf) {
      return new Promise((res, rej) => {
        const corrId = nextCorrelationId();
        pendingRequests.set(corrId, { resolve: res, reject: rej });
        const header = buildRequestHeader(apiKey, apiVersion, corrId, clientId);
        const frame  = frameRequest(header, bodyBuf);
        socket.write(frame, (err) => {
          if (err) {
            pendingRequests.delete(corrId);
            rej(err);
          }
        });
      });
    }

    function close() {
      clearTimeout(globalTimer);
      socket.destroy();
    }

    socket.on("connect", async () => {
      clearTimeout(connectTimer);
      try {
        // SASL authentication if requested
        if (saslMechanism) {
          await doSaslHandshake(sendRequest, saslMechanism);
          await doSaslAuthenticate(sendRequest, saslMechanism, saslUsername, saslPassword);
        }
        resolve({ sendRequest, close, socket });
      } catch (err) {
        clearTimeout(globalTimer);
        socket.destroy();
        if (!done) { done = true; reject(err); }
      }
    });
  });
}

// ─── SASL Handshake (ApiKey 17, v0) ─────────────────────────────────────────
async function doSaslHandshake(sendRequest, mechanism) {
  // Body: [mechanism STRING]
  const bodySize = strSize(mechanism);
  const body = Buffer.allocUnsafe(bodySize);
  writeString(body, 0, mechanism);

  const resp = await sendRequest(API.SASL_HANDSHAKE, 0, body);
  const errCode = resp.readInt16BE(0);
  if (errCode !== 0)
    throw new Error(`kafka_client: SASL handshake failed: ${kafkaErrorName(errCode)} (${errCode})`);
}

// ─── SASL Authenticate (ApiKey 36, v0) ──────────────────────────────────────
async function doSaslAuthenticate(sendRequest, mechanism, username, password) {
  // PLAIN: \x00username\x00password
  let authBytes;
  if (mechanism === "PLAIN") {
    const user = username || "";
    const pass = password || "";
    authBytes = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from(user, "utf8"),
      Buffer.from([0x00]),
      Buffer.from(pass, "utf8"),
    ]);
  } else {
    throw new Error(`kafka_client: unsupported SASL mechanism '${mechanism}'. Supported: PLAIN`);
  }

  // Body: [auth_bytes BYTES]
  const body = Buffer.allocUnsafe(4 + authBytes.length);
  writeBytes(body, 0, authBytes);

  const resp = await sendRequest(API.SASL_AUTHENTICATE, 0, body);
  const { value: errCode, offset: off1 } = readInt16(resp, 0);
  if (errCode !== 0) {
    const { value: errMsg } = readString(resp, off1);
    throw new Error(`kafka_client: SASL authentication failed: ${kafkaErrorName(errCode)}: ${errMsg || ""}`);
  }
}

// ─── Metadata Request (ApiKey 3, v1) ─────────────────────────────────────────
// Request: [topics ARRAY<STRING>] (null = all topics)
async function doMetadata(sendRequest, topics) {
  // Build: [array_len INT32] [topic STRING ...]
  // null topics list = fetch all
  let bodySize, body, off;
  if (!topics || topics.length === 0) {
    // null array = all topics
    bodySize = 4;
    body = Buffer.allocUnsafe(bodySize);
    body.writeInt32BE(-1, 0); // null array
  } else {
    bodySize = 4 + topics.reduce((s, t) => s + strSize(t), 0);
    body = Buffer.allocUnsafe(bodySize);
    off = 0;
    off = writeInt32(body, off, topics.length);
    for (const t of topics) off = writeString(body, off, t);
  }

  const resp = await sendRequest(API.METADATA, 1, body);
  return parseMetadataResponse(resp);
}

function parseMetadataResponse(buf) {
  let off = 0;
  // throttle_time_ms (v1+): INT32
  const { value: throttle, offset: o0 } = readInt32(buf, off); off = o0;
  // brokers: ARRAY
  const { value: brokerCount, offset: o1 } = readInt32(buf, off); off = o1;
  const brokers = [];
  for (let i = 0; i < brokerCount; i++) {
    const { value: nodeId, offset: o2 } = readInt32(buf, off); off = o2;
    const { value: bHost, offset: o3 } = readString(buf, off); off = o3;
    const { value: bPort, offset: o4 } = readInt32(buf, off); off = o4;
    const { value: rack, offset: o5 } = readString(buf, off); off = o5; // v1+
    brokers.push({ nodeId, host: bHost, port: bPort, rack });
  }
  // cluster_id STRING (v2+): not present in v1; we skip controllerId
  // controller_id INT32 (v1+)
  const { value: controllerId, offset: o6 } = readInt32(buf, off); off = o6;
  // topic_metadata: ARRAY
  const { value: topicCount, offset: o7 } = readInt32(buf, off); off = o7;
  const topicMetadata = [];
  for (let i = 0; i < topicCount; i++) {
    const { value: topicError, offset: oa } = readInt16(buf, off); off = oa;
    const { value: topicName, offset: ob } = readString(buf, off); off = ob;
    const { value: isInternal, offset: oc } = readInt8(buf, off); off = oc; // v1+
    const { value: partCount, offset: od } = readInt32(buf, off); off = od;
    const partitions = [];
    for (let p = 0; p < partCount; p++) {
      const { value: partError, offset: oe } = readInt16(buf, off); off = oe;
      const { value: partId,    offset: of_ } = readInt32(buf, off); off = of_;
      const { value: leader,    offset: og } = readInt32(buf, off); off = og;
      const { value: repCount,  offset: oh } = readInt32(buf, off); off = oh;
      const replicas = [];
      for (let r = 0; r < repCount; r++) {
        const { value: rep, offset: oi } = readInt32(buf, off); off = oi;
        replicas.push(rep);
      }
      const { value: isrCount, offset: oj } = readInt32(buf, off); off = oj;
      const isrs = [];
      for (let r = 0; r < isrCount; r++) {
        const { value: isr, offset: ok } = readInt32(buf, off); off = ok;
        isrs.push(isr);
      }
      partitions.push({
        errorCode: partError,
        error: partError !== 0 ? kafkaErrorName(partError) : null,
        partitionIndex: partId,
        leaderId: leader,
        replicaNodes: replicas,
        isrNodes: isrs,
      });
    }
    topicMetadata.push({
      errorCode: topicError,
      error: topicError !== 0 ? kafkaErrorName(topicError) : null,
      name: topicName,
      isInternal: !!isInternal,
      partitions,
    });
  }
  return { brokers, controllerId, topics: topicMetadata };
}

// ─── Produce Request (ApiKey 0, v2) ─────────────────────────────────────────
// Produce v2:
//   transactional_id (nullable string) — always null here
//   acks INT16
//   timeout INT32
//   [topic_data ARRAY]
//     topic STRING
//     [data ARRAY]
//       partition INT32
//       record_set BYTES  (MessageSet v1 format)
async function doProduce(sendRequest, opts) {
  const {
    topic, partition, messages, acks, timeoutMs,
  } = opts;

  // Build MessageSet v1 (each message: offset INT64 + message_size INT32 + Message)
  // Message v1: crc INT32 + magic INT8(1) + attributes INT8(0) + timestamp INT64 + key BYTES + value BYTES
  const msgSetParts = [];
  for (const msg of messages) {
    const keyBuf   = msg.key   != null ? Buffer.from(String(msg.key),   "utf8") : null;
    const valueBuf = msg.value != null ? Buffer.from(String(msg.value), "utf8") : null;
    // Message body (before CRC)
    const msgBody = Buffer.allocUnsafe(
      1 + 1 + 8 + bytesSize(keyBuf) + bytesSize(valueBuf)
    );
    let mo = 0;
    mo = writeInt8(msgBody, mo, 1);  // magic = 1 (v1)
    mo = writeInt8(msgBody, mo, 0);  // attributes = 0 (no compression)
    // timestamp: ms since epoch
    const ts = msg.timestamp != null ? msg.timestamp : Date.now();
    mo = writeInt64(msgBody, mo, Math.floor(ts / 4294967296), ts >>> 0);
    mo = writeBytes(msgBody, mo, keyBuf);
    mo = writeBytes(msgBody, mo, valueBuf);

    // CRC32 of msgBody
    const crc = crc32(msgBody);
    const msgFull = Buffer.allocUnsafe(4 + msgBody.length);
    msgFull.writeInt32BE(crc, 0);
    msgBody.copy(msgFull, 4);

    // offset (INT64) + message_size (INT32) + message
    const entry = Buffer.allocUnsafe(8 + 4 + msgFull.length);
    let eo = 0;
    eo = writeInt64(entry, eo, 0, 0); // offset 0 (server assigns real offset)
    entry.writeInt32BE(msgFull.length, eo); eo += 4;
    msgFull.copy(entry, eo);
    msgSetParts.push(entry);
  }
  const messageSetBuf = Buffer.concat(msgSetParts);

  // Build produce body
  // transactional_id: null string
  // acks INT16
  // timeout INT32
  // [topic_data]
  //   [partition_data]
  const partDataSize = 4 + 4 + messageSetBuf.length; // partition + BYTES
  const topicDataSize = strSize(topic) + 4 + partDataSize;
  const bodySize = 2 + 2 + 4 + 4 + topicDataSize; // null_str + acks + timeout + array(1 topic)
  const body = Buffer.allocUnsafe(bodySize);
  let off = 0;
  off = writeString(body, off, null);           // transactional_id: null
  off = writeInt16(body, off, acks != null ? acks : -1); // acks: -1=all
  off = writeInt32(body, off, timeoutMs || 30000);
  // topic_data array: 1 topic
  off = writeInt32(body, off, 1);
  off = writeString(body, off, topic);
  // partition_data array: 1 partition
  off = writeInt32(body, off, 1);
  off = writeInt32(body, off, partition || 0);
  off = writeBytes(body, off, messageSetBuf);

  const resp = await sendRequest(API.PRODUCE, 2, body);
  return parseProduceResponse(resp);
}

function parseProduceResponse(buf) {
  let off = 0;
  const { value: topicCount, offset: o1 } = readInt32(buf, off); off = o1;
  const results = [];
  for (let i = 0; i < topicCount; i++) {
    const { value: topicName,  offset: o2 } = readString(buf, off); off = o2;
    const { value: partCount,  offset: o3 } = readInt32(buf, off); off = o3;
    for (let p = 0; p < partCount; p++) {
      const { value: partId,     offset: o4 } = readInt32(buf, off); off = o4;
      const { value: errCode,    offset: o5 } = readInt16(buf, off); off = o5;
      const { value: baseOffset, offset: o6 } = readInt64(buf, off); off = o6;
      const { value: logAppendTime, offset: o7 } = readInt64(buf, off); off = o7; // v2+
      results.push({
        topic: topicName,
        partition: partId,
        errorCode: errCode,
        error: errCode !== 0 ? kafkaErrorName(errCode) : null,
        baseOffset,
        logAppendTime,
      });
    }
  }
  return results;
}

// ─── Fetch Request (ApiKey 1, v4) ────────────────────────────────────────────
// Fetch v4:
//   replica_id INT32 (-1 for consumers)
//   max_wait_ms INT32
//   min_bytes INT32
//   max_bytes INT32  (v3+)
//   isolation_level INT8 (v4+) -- 0=READ_UNCOMMITTED
//   [topics ARRAY]
//     topic STRING
//     [partitions ARRAY]
//       partition INT32
//       fetch_offset INT64
//       max_bytes INT32
async function doFetch(sendRequest, opts) {
  const {
    topic, partition, fetchOffset, maxBytes, maxWaitMs, minBytes,
  } = opts;

  const partDataSize = 4 + 8 + 4; // partition + fetch_offset + max_bytes
  const topicSize = strSize(topic) + 4 + partDataSize;
  const bodySize = 4 + 4 + 4 + 4 + 1 + 4 + topicSize;
  const body = Buffer.allocUnsafe(bodySize);
  let off = 0;
  off = writeInt32(body, off, -1);            // replica_id: -1 (consumer)
  off = writeInt32(body, off, maxWaitMs || 500); // max_wait_ms
  off = writeInt32(body, off, minBytes || 1);    // min_bytes
  off = writeInt32(body, off, maxBytes || 1048576); // max_bytes (v3+)
  off = writeInt8(body, off, 0);              // isolation_level: READ_UNCOMMITTED
  // topics array: 1 topic
  off = writeInt32(body, off, 1);
  off = writeString(body, off, topic);
  // partitions array: 1 partition
  off = writeInt32(body, off, 1);
  off = writeInt32(body, off, partition || 0);
  // fetch_offset INT64
  const fo = fetchOffset || 0;
  off = writeInt64(body, off, Math.floor(fo / 4294967296), fo >>> 0);
  off = writeInt32(body, off, maxBytes || 1048576); // partition max_bytes

  const resp = await sendRequest(API.FETCH, 4, body);
  return parseFetchResponse(resp);
}

function parseFetchResponse(buf) {
  let off = 0;
  const { value: throttle,   offset: o0 } = readInt32(buf, off); off = o0;
  const { value: topicCount, offset: o1 } = readInt32(buf, off); off = o1;
  const results = [];
  for (let i = 0; i < topicCount; i++) {
    const { value: topicName,  offset: o2 } = readString(buf, off); off = o2;
    const { value: partCount,  offset: o3 } = readInt32(buf, off); off = o3;
    for (let p = 0; p < partCount; p++) {
      const { value: partId,       offset: o4 } = readInt32(buf, off); off = o4;
      const { value: errCode,      offset: o5 } = readInt16(buf, off); off = o5;
      const { value: highWatermark,offset: o6 } = readInt64(buf, off); off = o6;
      const { value: lastStable,   offset: o7 } = readInt64(buf, off); off = o7; // v4+
      // aborted transactions (v4+): ARRAY
      const { value: abortedCount, offset: o8 } = readInt32(buf, off); off = o8;
      for (let a = 0; a < Math.max(0, abortedCount); a++) {
        // producer_id INT64, first_offset INT64
        off += 16;
      }
      // record_set BYTES
      const { value: recordSetBuf, offset: o9 } = readBytes(buf, off); off = o9;
      const messages = recordSetBuf ? parseMessageSet(recordSetBuf) : [];
      results.push({
        topic: topicName,
        partition: partId,
        errorCode: errCode,
        error: errCode !== 0 ? kafkaErrorName(errCode) : null,
        highWatermark,
        messages,
        messageCount: messages.length,
      });
    }
  }
  return results;
}

function parseMessageSet(buf) {
  const messages = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    // offset INT64
    const { value: msgOffset, offset: o1 } = readInt64(buf, off); off = o1;
    // message_size INT32
    const { value: msgSize, offset: o2 } = readInt32(buf, off); off = o2;
    if (msgSize < 0 || off + msgSize > buf.length) break;
    const msgBuf = buf.slice(off, off + msgSize);
    off += msgSize;
    if (msgBuf.length < 6) continue;
    // crc INT32 + magic INT8 + attributes INT8 ...
    const magic = msgBuf.readInt8(4);
    let moff = 5;
    const attrs = msgBuf.readInt8(moff); moff++;
    let timestamp = null;
    if (magic >= 1) {
      const { value: ts } = readInt64(msgBuf, moff); moff += 8;
      timestamp = ts;
    }
    const { value: key,   offset: mk } = readBytes(msgBuf, moff); moff = mk;
    const { value: value, offset: mv } = readBytes(msgBuf, moff); moff = mv;
    messages.push({
      offset: msgOffset,
      timestamp,
      key:   key   ? key.toString("utf8")   : null,
      value: value ? value.toString("utf8") : null,
    });
  }
  return messages;
}

// ─── ListOffsets Request (ApiKey 2, v1) ─────────────────────────────────────
// v1: replica_id INT32 + [topics: [topic STRING + [partitions: [partition INT32 + timestamp INT64]]]]
async function doListOffsets(sendRequest, opts) {
  const { topic, partition, timestamp } = opts;
  // timestamp: -2=EARLIEST, -1=LATEST, or specific ms
  const ts = timestamp != null ? timestamp : -1;

  const partDataSize = 4 + 8; // partition + timestamp
  const topicSize = strSize(topic) + 4 + partDataSize;
  const bodySize = 4 + 4 + topicSize;
  const body = Buffer.allocUnsafe(bodySize);
  let off = 0;
  off = writeInt32(body, off, -1); // replica_id: -1
  off = writeInt32(body, off, 1);  // topics count
  off = writeString(body, off, topic);
  off = writeInt32(body, off, 1);  // partitions count
  off = writeInt32(body, off, partition || 0);
  off = writeInt64(body, off, Math.floor(ts / 4294967296), ts < 0 ? ts : ts >>> 0);

  const resp = await sendRequest(API.LIST_OFFSETS, 1, body);
  return parseListOffsetsResponse(resp);
}

function parseListOffsetsResponse(buf) {
  let off = 0;
  const { value: throttle,   offset: o0 } = readInt32(buf, off); off = o0;
  const { value: topicCount, offset: o1 } = readInt32(buf, off); off = o1;
  const results = [];
  for (let i = 0; i < topicCount; i++) {
    const { value: topicName, offset: o2 } = readString(buf, off); off = o2;
    const { value: partCount, offset: o3 } = readInt32(buf, off); off = o3;
    for (let p = 0; p < partCount; p++) {
      const { value: partId,    offset: o4 } = readInt32(buf, off); off = o4;
      const { value: errCode,   offset: o5 } = readInt16(buf, off); off = o5;
      const { value: timestamp, offset: o6 } = readInt64(buf, off); off = o6;
      const { value: msgOffset, offset: o7 } = readInt64(buf, off); off = o7;
      results.push({
        topic: topicName,
        partition: partId,
        errorCode: errCode,
        error: errCode !== 0 ? kafkaErrorName(errCode) : null,
        timestamp,
        offset: msgOffset,
      });
    }
  }
  return results;
}

// ─── CreateTopics Request (ApiKey 19, v0) ────────────────────────────────────
// v0: [createTopicRequests: [topic STRING + num_partitions INT32 + replication_factor INT16
//        + [assignments] + [configs: [name STRING + value STRING]]]]
//   + timeout_ms INT32
async function doCreateTopics(sendRequest, opts) {
  const { topics, timeoutMs } = opts;

  // Compute body size
  let bodySize = 4; // array count
  for (const t of topics) {
    bodySize += strSize(t.name);
    bodySize += 4; // num_partitions
    bodySize += 2; // replication_factor
    bodySize += 4; // assignments count (0)
    bodySize += 4; // configs count
    const configs = t.configs || {};
    for (const [k, v] of Object.entries(configs)) {
      bodySize += strSize(k) + strSize(v);
    }
  }
  bodySize += 4; // timeout_ms

  const body = Buffer.allocUnsafe(bodySize);
  let off = 0;
  off = writeInt32(body, off, topics.length);
  for (const t of topics) {
    off = writeString(body, off, t.name);
    off = writeInt32(body, off, t.numPartitions || 1);
    off = writeInt16(body, off, t.replicationFactor || 1);
    off = writeInt32(body, off, 0); // no replica assignments
    const configs = t.configs || {};
    const configEntries = Object.entries(configs);
    off = writeInt32(body, off, configEntries.length);
    for (const [k, v] of configEntries) {
      off = writeString(body, off, k);
      off = writeString(body, off, v);
    }
  }
  off = writeInt32(body, off, timeoutMs || 30000);

  const resp = await sendRequest(API.CREATE_TOPICS, 0, body);
  return parseCreateTopicsResponse(resp);
}

function parseCreateTopicsResponse(buf) {
  let off = 0;
  const { value: topicCount, offset: o1 } = readInt32(buf, off); off = o1;
  const results = [];
  for (let i = 0; i < topicCount; i++) {
    const { value: topicName, offset: o2 } = readString(buf, off); off = o2;
    const { value: errCode,   offset: o3 } = readInt16(buf, off); off = o3;
    const { value: errMsg,    offset: o4 } = readString(buf, off); off = o4;
    results.push({
      name: topicName,
      errorCode: errCode,
      error: errCode !== 0 ? kafkaErrorName(errCode) : null,
      errorMessage: errMsg,
    });
  }
  return results;
}

// ─── DeleteTopics Request (ApiKey 20, v0) ────────────────────────────────────
async function doDeleteTopics(sendRequest, opts) {
  const { topics, timeoutMs } = opts;
  let bodySize = 4; // topics array count
  for (const t of topics) bodySize += strSize(t);
  bodySize += 4; // timeout_ms

  const body = Buffer.allocUnsafe(bodySize);
  let off = 0;
  off = writeInt32(body, off, topics.length);
  for (const t of topics) off = writeString(body, off, t);
  off = writeInt32(body, off, timeoutMs || 30000);

  const resp = await sendRequest(API.DELETE_TOPICS, 0, body);
  return parseDeleteTopicsResponse(resp);
}

function parseDeleteTopicsResponse(buf) {
  let off = 0;
  const { value: topicCount, offset: o1 } = readInt32(buf, off); off = o1;
  const results = [];
  for (let i = 0; i < topicCount; i++) {
    const { value: topicName, offset: o2 } = readString(buf, off); off = o2;
    const { value: errCode,   offset: o3 } = readInt16(buf, off); off = o3;
    results.push({
      name: topicName,
      errorCode: errCode,
      error: errCode !== 0 ? kafkaErrorName(errCode) : null,
    });
  }
  return results;
}

// ─── CRC32 (for Kafka MessageSet) ────────────────────────────────────────────
// Standard CRC-32 (IEEE 802.3 polynomial)
const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++)
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) | 0; // signed 32-bit
}

// ─── Security Guards ─────────────────────────────────────────────────────────
function guardKafkaString(val, name, maxLen) {
  if (typeof val !== "string")
    throw new Error(`kafka_client: '${name}' must be a string`);
  if (val.includes("\x00"))
    throw new Error(`kafka_client: '${name}' must not contain NUL bytes`);
  if (val.includes("\r") || val.includes("\n"))
    throw new Error(`kafka_client: '${name}' must not contain CRLF characters`);
  if (maxLen && val.length > maxLen)
    throw new Error(`kafka_client: '${name}' exceeds maximum length of ${maxLen} characters`);
}

function guardTopicName(topic) {
  if (typeof topic !== "string" || topic.length === 0)
    throw new Error("kafka_client: 'topic' must be a non-empty string");
  if (topic.includes("\x00"))
    throw new Error(`kafka_client: topic name must not contain NUL bytes`);
  if (topic.includes("\r") || topic.includes("\n"))
    throw new Error(`kafka_client: topic name must not contain CRLF characters`);
  if (!/^[a-zA-Z0-9._\-]+$/.test(topic))
    throw new Error(`kafka_client: invalid topic name '${topic}'. Only letters, digits, '.', '_', '-' are allowed`);
  if (topic.length > 249)
    throw new Error("kafka_client: topic name exceeds 249 character limit");
}

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024; // 10 MB per message

// ─── Main Entry Point ─────────────────────────────────────────────────────────
async function kafkaClient(args) {
  const t0 = Date.now();

  // ── Required params ──────────────────────────────────────────────────────────
  const host      = args.host      || "localhost";
  const port      = args.port      || 9092;
  const operation = args.operation;
  const timeout   = Math.round((args.timeout || 30) * 1000);
  const connectTimeout = Math.min(timeout, Math.round((args.connect_timeout || 10) * 1000));
  const clientId  = args.client_id || "kafka_client";

  if (!operation)
    throw new Error("kafka_client: 'operation' is required");

  const validOps = ["produce", "fetch", "list_offsets", "metadata", "create_topics", "delete_topics", "list_topics"];
  if (!validOps.includes(operation))
    throw new Error(`kafka_client: unknown operation '${operation}'. Valid: ${validOps.join(", ")}`);

  guardKafkaString(host, "host", 253);
  guardKafkaString(clientId, "client_id", 255);

  // SASL
  const saslMechanism = args.sasl_mechanism || null;
  const saslUsername  = args.sasl_username  || null;
  const saslPassword  = args.sasl_password  || null;
  if (saslMechanism && saslMechanism !== "PLAIN")
    throw new Error(`kafka_client: unsupported sasl_mechanism '${saslMechanism}'. Supported: PLAIN`);

  // ── Early validation (before opening TCP connection) ───────────────────
  if (operation === "produce" || operation === "fetch" || operation === "list_offsets") {
    const earlyTopic = args.topic;
    if (!earlyTopic) throw new Error(`kafka_client: 'topic' is required for ${operation}`);
    guardTopicName(earlyTopic);
  }
  if (operation === "produce") {
    const messages = args.messages;
    if (!Array.isArray(messages) || messages.length === 0)
      throw new Error("kafka_client: 'messages' must be a non-empty array");
    if (messages.length > 1000)
      throw new Error("kafka_client: maximum 1000 messages per produce call");
    for (const msg of messages) {
      if (msg.value == null && msg.key == null)
        throw new Error("kafka_client: each message must have at least 'value' or 'key'");
      const valStr = msg.value != null ? String(msg.value) : "";
      if (Buffer.byteLength(valStr, 'utf8') > MAX_MESSAGE_BYTES)
        throw new Error(`kafka_client: message value exceeds ${MAX_MESSAGE_BYTES} bytes`);
    }
  }
  if (operation === "create_topics") {
    const topicsSpec = args.topics;
    if (!Array.isArray(topicsSpec) || topicsSpec.length === 0)
      throw new Error("kafka_client: 'topics' must be a non-empty array of {name, num_partitions, replication_factor} objects");
    for (const t of topicsSpec) {
      if (!t.name) throw new Error("kafka_client: each topic spec must have a 'name'");
      guardTopicName(t.name);
    }
  }
  if (operation === "delete_topics") {
    const topicsToDelete = args.topics;
    if (!Array.isArray(topicsToDelete) || topicsToDelete.length === 0)
      throw new Error("kafka_client: 'topics' must be a non-empty array of topic name strings");
    for (const t of topicsToDelete) {
      if (typeof t !== 'string') throw new Error("kafka_client: each topic in 'topics' must be a string");
      guardTopicName(t);
    }
  }

  const elapsedMs = () => Date.now() - t0;
  const base = { host, port, operation };

  // ── Open connection ──────────────────────────────────────────────────────────
  let conn;
  try {
    conn = await openKafkaConnection({
      host, port, timeout, connectTimeout, clientId,
      saslMechanism, saslUsername, saslPassword,
    });
  } catch (err) {
    throw new Error(`kafka_client: connection failed: ${err.message}`);
  }

  const { sendRequest, close } = conn;

  try {
    switch (operation) {

      // ── PRODUCE ────────────────────────────────────────────────────────────
      case "produce": {
        const topic = args.topic;
        if (!topic) throw new Error("kafka_client: 'topic' is required for produce");
        guardTopicName(topic);

        const messages = args.messages;
        if (!Array.isArray(messages) || messages.length === 0)
          throw new Error("kafka_client: 'messages' must be a non-empty array");
        if (messages.length > 1000)
          throw new Error("kafka_client: maximum 1000 messages per produce call");

        for (const msg of messages) {
          if (msg.value == null && msg.key == null)
            throw new Error("kafka_client: each message must have at least 'value' or 'key'");
          const valStr = msg.value != null ? String(msg.value) : "";
          if (Buffer.byteLength(valStr, "utf8") > MAX_MESSAGE_BYTES)
            throw new Error(`kafka_client: message value exceeds ${MAX_MESSAGE_BYTES} bytes`);
        }

        const results = await doProduce(sendRequest, {
          topic,
          partition: args.partition || 0,
          messages,
          acks: args.acks,
          timeoutMs: Math.min(timeout, 30000),
        });

        const firstResult = results[0] || {};
        if (firstResult.errorCode && firstResult.errorCode !== 0)
          throw new Error(`kafka_client: produce error: ${firstResult.error} (code=${firstResult.errorCode})`);

        return {
          ...base, elapsedMs: elapsedMs(),
          topic,
          partition: firstResult.partition || 0,
          baseOffset: firstResult.baseOffset,
          messageCount: messages.length,
          results,
        };
      }

      // ── FETCH ──────────────────────────────────────────────────────────────
      case "fetch": {
        const topic = args.topic;
        if (!topic) throw new Error("kafka_client: 'topic' is required for fetch");
        guardTopicName(topic);

        const results = await doFetch(sendRequest, {
          topic,
          partition:   args.partition   || 0,
          fetchOffset: args.fetch_offset != null ? args.fetch_offset : 0,
          maxBytes:    Math.min(args.max_bytes    || 1048576, MAX_RESPONSE_BYTES),
          maxWaitMs:   args.max_wait_ms || 500,
          minBytes:    args.min_bytes   || 1,
        });

        const firstResult = results[0] || {};
        if (firstResult.errorCode && firstResult.errorCode !== 0)
          throw new Error(`kafka_client: fetch error: ${firstResult.error} (code=${firstResult.errorCode})`);

        return {
          ...base, elapsedMs: elapsedMs(),
          topic,
          partition: firstResult.partition || 0,
          highWatermark: firstResult.highWatermark,
          messages: firstResult.messages || [],
          messageCount: (firstResult.messages || []).length,
        };
      }

      // ── LIST_OFFSETS ───────────────────────────────────────────────────────
      case "list_offsets": {
        const topic = args.topic;
        if (!topic) throw new Error("kafka_client: 'topic' is required for list_offsets");
        guardTopicName(topic);

        // timestamp: -2=EARLIEST, -1=LATEST
        const timestamp = args.timestamp != null ? args.timestamp : -1;

        const results = await doListOffsets(sendRequest, {
          topic,
          partition: args.partition || 0,
          timestamp,
        });

        const firstResult = results[0] || {};
        if (firstResult.errorCode && firstResult.errorCode !== 0)
          throw new Error(`kafka_client: list_offsets error: ${firstResult.error} (code=${firstResult.errorCode})`);

        return {
          ...base, elapsedMs: elapsedMs(),
          topic,
          partition: firstResult.partition || 0,
          offset: firstResult.offset,
          timestamp: firstResult.timestamp,
          results,
        };
      }

      // ── METADATA ───────────────────────────────────────────────────────────
      case "metadata":
      case "list_topics": {
        const topicFilter = args.topics  // array of topic names to filter; null = all
          ? (Array.isArray(args.topics) ? args.topics : [args.topics])
          : (args.topic ? [args.topic] : null);

        if (topicFilter) {
          for (const t of topicFilter) guardTopicName(t);
        }

        const meta = await doMetadata(sendRequest, topicFilter);

        return {
          ...base, elapsedMs: elapsedMs(),
          brokers: meta.brokers,
          controllerId: meta.controllerId,
          topics: meta.topics,
          topicCount: meta.topics.length,
          brokerCount: meta.brokers.length,
        };
      }

      // ── CREATE_TOPICS ──────────────────────────────────────────────────────
      case "create_topics": {
        const topicsSpec = args.topics;
        if (!Array.isArray(topicsSpec) || topicsSpec.length === 0)
          throw new Error("kafka_client: 'topics' must be a non-empty array of {name, num_partitions, replication_factor} objects");

        for (const t of topicsSpec) {
          if (!t.name) throw new Error("kafka_client: each topic spec must have a 'name'");
          guardTopicName(t.name);
        }

        const results = await doCreateTopics(sendRequest, {
          topics: topicsSpec.map(t => ({
            name:              t.name,
            numPartitions:     t.num_partitions     || 1,
            replicationFactor: t.replication_factor || 1,
            configs:           t.configs            || {},
          })),
          timeoutMs: Math.min(timeout, 30000),
        });

        const errors = results.filter(r => r.errorCode !== 0);
        return {
          ...base, elapsedMs: elapsedMs(),
          results,
          created: results.filter(r => r.errorCode === 0).map(r => r.name),
          errors: errors.map(r => `${r.name}: ${r.error}`),
          success: errors.length === 0,
        };
      }

      // ── DELETE_TOPICS ──────────────────────────────────────────────────────
      case "delete_topics": {
        const topicsToDelete = args.topics;
        if (!Array.isArray(topicsToDelete) || topicsToDelete.length === 0)
          throw new Error("kafka_client: 'topics' must be a non-empty array of topic name strings");

        for (const t of topicsToDelete) {
          if (typeof t !== "string") throw new Error("kafka_client: each topic in 'topics' must be a string");
          guardTopicName(t);
        }

        const results = await doDeleteTopics(sendRequest, {
          topics: topicsToDelete,
          timeoutMs: Math.min(timeout, 30000),
        });

        const errors = results.filter(r => r.errorCode !== 0);
        return {
          ...base, elapsedMs: elapsedMs(),
          results,
          deleted: results.filter(r => r.errorCode === 0).map(r => r.name),
          errors: errors.map(r => `${r.name}: ${r.error}`),
          success: errors.length === 0,
        };
      }

      default:
        throw new Error(`kafka_client: unhandled operation '${operation}'`);
    }
  } finally {
    close();
  }
}

// ─── Codec exports (for unit tests) ──────────────────────────────────────────
module.exports = {
  kafkaClient,
  _codec: {
    writeInt8, writeInt16, writeInt32, writeInt64, writeString, writeBytes,
    readInt8, readInt16, readInt32, readInt64, readString, readBytes,
    strSize, bytesSize,
    buildRequestHeader, frameRequest,
    crc32,
    parseMetadataResponse, parseProduceResponse, parseFetchResponse,
    parseListOffsetsResponse, parseCreateTopicsResponse, parseDeleteTopicsResponse,
    parseMessageSet,
  },
  _kafkaErrorName: kafkaErrorName,
  _doSaslHandshake: doSaslHandshake,
};
