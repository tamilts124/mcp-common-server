"use strict";
// ── amqp_client: zero-dep AMQP 0-9-1 client ─────────────────────────────────
// Pure Node.js net/tls — no npm dependencies.
// Implements AMQP 0-9-1 (RabbitMQ, Azure Service Bus, CloudAMQP):
//   connect, publish, get, consume, declare_queue, delete_queue, purge, ack, nack
//
// Protocol reference: https://www.rabbitmq.com/amqp-0-9-1-reference.html

const net = require("net");
const tls = require("tls");
const { ToolError } = require("./errors");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_PORT        = 5672;
const DEFAULT_TLS_PORT    = 5671;
const DEFAULT_TIMEOUT_MS  = 30_000;
const DEFAULT_CONN_TO_MS  = 10_000;
const MAX_BODY_BYTES      = 10 * 1024 * 1024;  // 10 MB
const AMQP_PROTOCOL_HEADER = Buffer.from([0x41, 0x4d, 0x51, 0x50, 0x00, 0x00, 0x09, 0x01]);

// AMQP frame types
const FRAME = { METHOD: 1, HEADER: 2, BODY: 3, HEARTBEAT: 8, END: 0xce };

// AMQP class IDs
const CLS = { CONNECTION: 10, CHANNEL: 20, EXCHANGE: 40, QUEUE: 50, BASIC: 60, TX: 90 };

// AMQP method IDs per class (class.method pairs)
const METHOD = {
  CONNECTION_START:     [10, 10],
  CONNECTION_START_OK:  [10, 11],
  CONNECTION_TUNE:      [10, 30],
  CONNECTION_TUNE_OK:   [10, 31],
  CONNECTION_OPEN:      [10, 40],
  CONNECTION_OPEN_OK:   [10, 41],
  CONNECTION_CLOSE:     [10, 50],
  CONNECTION_CLOSE_OK:  [10, 51],
  CHANNEL_OPEN:         [20, 10],
  CHANNEL_OPEN_OK:      [20, 11],
  CHANNEL_CLOSE:        [20, 40],
  CHANNEL_CLOSE_OK:     [20, 41],
  EXCHANGE_DECLARE:     [40, 10],
  EXCHANGE_DECLARE_OK:  [40, 11],
  QUEUE_DECLARE:        [50, 10],
  QUEUE_DECLARE_OK:     [50, 11],
  QUEUE_DELETE:         [50, 40],
  QUEUE_DELETE_OK:      [50, 41],
  QUEUE_PURGE:          [50, 30],
  QUEUE_PURGE_OK:       [50, 31],
  BASIC_PUBLISH:        [60, 40],
  BASIC_GET:            [60, 70],
  BASIC_GET_OK:         [60, 71],
  BASIC_GET_EMPTY:      [60, 72],
  BASIC_DELIVER:        [60, 60],
  BASIC_CONSUME:        [60, 20],
  BASIC_CONSUME_OK:     [60, 21],
  BASIC_CANCEL:         [60, 30],
  BASIC_CANCEL_OK:      [60, 31],
  BASIC_ACK:            [60, 80],
  BASIC_NACK:           [60, 120],
  BASIC_QOS:            [60, 10],
  BASIC_QOS_OK:         [60, 11],
};

// ── Security guards ──────────────────────────────────────────────────────────

function guardStr(val, label, maxLen = 255) {
  if (typeof val !== "string")
    throw new ToolError(`amqp_client: '${label}' must be a string.`, -32602);
  if (val.includes("\0"))
    throw new ToolError(`amqp_client: '${label}' must not contain NUL bytes.`, -32602);
  if (val.length > maxLen)
    throw new ToolError(
      `amqp_client: '${label}' exceeds ${maxLen}-char limit (got ${val.length}).`, -32602);
  return val;
}

function guardOptStr(val, label, maxLen = 255) {
  if (val === undefined || val === null) return undefined;
  return guardStr(val, label, maxLen);
}

// ── AMQP encoding helpers ─────────────────────────────────────────────────────

/**
 * Write a big-endian integer into a Buffer at offset.
 */
function writeUInt(buf, value, offset, bytes) {
  for (let i = bytes - 1; i >= 0; i--) {
    buf[offset + i] = value & 0xff;
    value >>>= 8;
  }
}

/**
 * Encode an AMQP shortstr (1-byte length + UTF-8 bytes).
 */
function encodeShortStr(str) {
  const encoded = Buffer.from(str || "", "utf8");
  if (encoded.length > 255)
    throw new ToolError(`amqp_client: shortstr '${str.slice(0,20)}...' too long (max 255 bytes).`, -32603);
  const buf = Buffer.alloc(1 + encoded.length);
  buf[0] = encoded.length;
  encoded.copy(buf, 1);
  return buf;
}

/**
 * Encode an AMQP longstr (4-byte length + bytes).
 */
function encodeLongStr(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || "", "utf8");
  const out = Buffer.alloc(4 + buf.length);
  out.writeUInt32BE(buf.length, 0);
  buf.copy(out, 4);
  return out;
}

/**
 * Encode an AMQP field table (simplified: supports string and number values).
 */
function encodeTable(obj) {
  if (!obj || typeof obj !== "object") return Buffer.from([0, 0, 0, 0]);
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = encodeShortStr(k);
    let val;
    if (typeof v === "string") {
      const vb = Buffer.from(v, "utf8");
      val = Buffer.alloc(5 + vb.length);
      val[0] = 0x53; // 'S' longstr
      val.writeUInt32BE(vb.length, 1);
      vb.copy(val, 5);
    } else if (typeof v === "number" && Number.isInteger(v)) {
      val = Buffer.alloc(5);
      val[0] = 0x6c; // 'l' long-long int
      val.writeBigInt64BE(BigInt(v), 1);
    } else if (typeof v === "boolean") {
      val = Buffer.from([0x74, v ? 1 : 0]); // 't' boolean
    } else {
      // Skip unsupported types
      continue;
    }
    parts.push(key, val);
  }
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/**
 * Build an AMQP method frame.
 */
function buildMethodFrame(channel, classId, methodId, payload) {
  const body = Buffer.alloc(4 + (payload ? payload.length : 0));
  body.writeUInt16BE(classId, 0);
  body.writeUInt16BE(methodId, 2);
  if (payload) payload.copy(body, 4);
  return buildFrame(FRAME.METHOD, channel, body);
}

function buildFrame(type, channel, payload) {
  const frame = Buffer.alloc(7 + payload.length + 1);
  frame[0] = type;
  frame.writeUInt16BE(channel, 1);
  frame.writeUInt32BE(payload.length, 3);
  payload.copy(frame, 7);
  frame[7 + payload.length] = FRAME.END;
  return frame;
}

/**
 * Build a content header frame.
 */
function buildHeaderFrame(channel, classId, bodySize, props) {
  // props = { content_type, delivery_mode, headers }
  // Property flags: bit 15=content-type, bit 12=delivery-mode
  let flags = 0;
  const parts = [];
  if (props.content_type) {
    flags |= 0x8000;
    parts.push(encodeShortStr(props.content_type));
  }
  if (props.delivery_mode !== undefined) {
    // content-encoding bit (0x4000) is skipped; delivery-mode is bit 0x1000
    flags |= 0x1000;
    parts.push(Buffer.from([props.delivery_mode & 0xff]));
  }
  const propsBytes = Buffer.concat(parts);

  const payload = Buffer.alloc(12 + propsBytes.length);
  payload.writeUInt16BE(classId, 0);    // class-id
  payload.writeUInt16BE(0, 2);          // weight (always 0)
  payload.writeBigUInt64BE(BigInt(bodySize), 4);  // body size
  payload.writeUInt16BE(flags, 12);     // property flags
  // Wait — recalculate offset. struct is:
  //   class-id   2 bytes
  //   weight     2 bytes
  //   body-size  8 bytes
  //   prop-flags 2 bytes  -> offset 12
  //   prop-list  N bytes
  const header = Buffer.alloc(14 + propsBytes.length);
  header.writeUInt16BE(classId, 0);
  header.writeUInt16BE(0, 2);
  header.writeBigUInt64BE(BigInt(bodySize), 4);
  header.writeUInt16BE(flags, 12);
  propsBytes.copy(header, 14);
  return buildFrame(FRAME.HEADER, channel, header);
}

/**
 * Build a body frame.
 */
function buildBodyFrame(channel, payload) {
  return buildFrame(FRAME.BODY, channel, payload);
}

// ── AMQP decoding helpers ─────────────────────────────────────────────────────

/**
 * Decode shortstr at buf[pos]. Returns { value, end }.
 */
function readShortStr(buf, pos) {
  const len = buf[pos];
  const value = buf.toString("utf8", pos + 1, pos + 1 + len);
  return { value, end: pos + 1 + len };
}

/**
 * Decode longstr at buf[pos]. Returns { value (Buffer), end }.
 */
function readLongStr(buf, pos) {
  const len = buf.readUInt32BE(pos);
  const value = buf.slice(pos + 4, pos + 4 + len);
  return { value, end: pos + 4 + len };
}

/**
 * Decode field table at buf[pos]. Returns { value (object), end }.
 */
function readTable(buf, pos) {
  const tableLen = buf.readUInt32BE(pos);
  const tableEnd = pos + 4 + tableLen;
  const obj = {};
  let p = pos + 4;
  while (p < tableEnd) {
    const { value: key, end: kEnd } = readShortStr(buf, p);
    p = kEnd;
    const type = buf[p]; p++;
    switch (type) {
      case 0x53: { // longstr
        const { value, end } = readLongStr(buf, p);
        obj[key] = value.toString("utf8");
        p = end; break;
      }
      case 0x74: // boolean
        obj[key] = buf[p] !== 0; p++; break;
      case 0x62: // short-short-int (octet)
        obj[key] = buf.readInt8(p); p++; break;
      case 0x42: // short-short-uint (octet unsigned)
        obj[key] = buf.readUInt8(p); p++; break;
      case 0x55: // short-int
        obj[key] = buf.readInt16BE(p); p += 2; break;
      case 0x75: // short-uint
        obj[key] = buf.readUInt16BE(p); p += 2; break;
      case 0x49: // long-int
        obj[key] = buf.readInt32BE(p); p += 4; break;
      case 0x69: // long-uint
        obj[key] = buf.readUInt32BE(p); p += 4; break;
      case 0x4c: // long-long-int
      case 0x6c: // alternate long-long
        obj[key] = Number(buf.readBigInt64BE(p)); p += 8; break;
      case 0x4c:
      case 0x4c:
        obj[key] = Number(buf.readBigUInt64BE(p)); p += 8; break;
      case 0x66: // float
        obj[key] = buf.readFloatBE(p); p += 4; break;
      case 0x64: // double
        obj[key] = buf.readDoubleBE(p); p += 8; break;
      case 0x44: { // decimal — skip
        const places = buf[p]; p++;
        p += 4; break;
      }
      case 0x46: { // nested table
        const { value, end } = readTable(buf, p);
        obj[key] = value;
        p = end; break;
      }
      case 0x41: { // array — skip to end
        const arrLen = buf.readUInt32BE(p); p += 4 + arrLen; break;
      }
      case 0x78: { // byte array
        const { value, end } = readLongStr(buf, p);
        obj[key] = value;
        p = end; break;
      }
      default: {
        // Unknown type: bail — skip to end of table
        p = tableEnd; break;
      }
    }
  }
  return { value: obj, end: tableEnd };
}

// ── Frame parser ─────────────────────────────────────────────────────────────

class AmqpParser {
  constructor() {
    this._buf = Buffer.alloc(0);
    this._frames = [];
  }

  feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (true) {
      if (this._buf.length < 7) break; // need frame header
      const type    = this._buf[0];
      const channel = this._buf.readUInt16BE(1);
      const size    = this._buf.readUInt32BE(3);
      const total   = 7 + size + 1; // header + payload + frame-end
      if (this._buf.length < total) break;
      if (this._buf[7 + size] !== FRAME.END)
        throw new ToolError("amqp_client: frame-end marker missing — protocol error.", -32603);
      const payload = this._buf.slice(7, 7 + size);
      this._buf = this._buf.slice(total);
      this._frames.push(this._parseFrame(type, channel, payload));
    }
  }

  take() { return this._frames.splice(0); }

  _parseFrame(type, channel, payload) {
    if (type === FRAME.HEARTBEAT) return { type: "HEARTBEAT", channel };
    if (type === FRAME.BODY)      return { type: "BODY",      channel, data: payload };
    if (type === FRAME.HEADER) {
      const classId  = payload.readUInt16BE(0);
      const bodySize = Number(payload.readBigUInt64BE(4));
      const flags    = payload.readUInt16BE(12);
      return { type: "HEADER", channel, classId, bodySize, flags };
    }
    if (type === FRAME.METHOD) {
      const classId  = payload.readUInt16BE(0);
      const methodId = payload.readUInt16BE(2);
      const args     = payload.slice(4);
      const name     = this._methodName(classId, methodId);
      const decoded  = this._decodeMethod(classId, methodId, args);
      return { type: "METHOD", channel, classId, methodId, name, ...decoded };
    }
    return { type: `UNKNOWN_${type}`, channel };
  }

  _methodName(c, m) {
    for (const [k, [ci, mi]] of Object.entries(METHOD))
      if (ci === c && mi === m) return k;
    return `${c}.${m}`;
  }

  _decodeMethod(c, m, buf) {
    let pos = 0;
    // CONNECTION_START
    if (c === 10 && m === 10) {
      const major = buf[pos++]; const minor = buf[pos++];
      const { value: serverProps, end: e1 } = readTable(buf, pos); pos = e1;
      const { value: mechanisms } = readLongStr(buf, pos);
      return { major, minor, serverProps, mechanisms: mechanisms.toString() };
    }
    // CONNECTION_TUNE
    if (c === 10 && m === 30) {
      const channelMax = buf.readUInt16BE(0);
      const frameMax   = buf.readUInt32BE(2);
      const heartbeat  = buf.readUInt16BE(6);
      return { channelMax, frameMax, heartbeat };
    }
    // CONNECTION_OPEN_OK
    if (c === 10 && m === 41) {
      const { value: reserved } = readShortStr(buf, 0);
      return { reserved };
    }
    // CONNECTION_CLOSE
    if (c === 10 && m === 50) {
      const replyCode = buf.readUInt16BE(0);
      const { value: replyText, end: e1 } = readShortStr(buf, 2); pos = e1;
      const failClass  = buf.readUInt16BE(pos);
      const failMethod = buf.readUInt16BE(pos + 2);
      return { replyCode, replyText, failClass, failMethod };
    }
    // CHANNEL_OPEN_OK / CHANNEL_CLOSE_OK
    if (c === 20 && (m === 11 || m === 41)) return {};
    // CHANNEL_CLOSE
    if (c === 20 && m === 40) {
      const replyCode = buf.readUInt16BE(0);
      const { value: replyText, end: e1 } = readShortStr(buf, 2); pos = e1;
      return { replyCode, replyText };
    }
    // QUEUE_DECLARE_OK
    if (c === 50 && m === 11) {
      const { value: queue, end: e1 } = readShortStr(buf, 0);
      const messageCount  = buf.readUInt32BE(e1);
      const consumerCount = buf.readUInt32BE(e1 + 4);
      return { queue, messageCount, consumerCount };
    }
    // QUEUE_DELETE_OK / QUEUE_PURGE_OK
    if (c === 50 && (m === 41 || m === 31)) {
      const messageCount = buf.readUInt32BE(0);
      return { messageCount };
    }
    // EXCHANGE_DECLARE_OK
    if (c === 40 && m === 11) return {};
    // BASIC_QOS_OK
    if (c === 60 && m === 11) return {};
    // BASIC_CONSUME_OK
    if (c === 60 && m === 21) {
      const { value: consumerTag } = readShortStr(buf, 0);
      return { consumerTag };
    }
    // BASIC_CANCEL_OK
    if (c === 60 && m === 31) {
      const { value: consumerTag } = readShortStr(buf, 0);
      return { consumerTag };
    }
    // BASIC_GET_OK
    if (c === 60 && m === 71) {
      const deliveryTag  = Number(buf.readBigUInt64BE(0));
      const redelivered  = !!(buf[8] & 0x01);
      const { value: exchange, end: e1 }    = readShortStr(buf, 9);
      const { value: routingKey, end: e2 }  = readShortStr(buf, e1);
      const messageCount = buf.readUInt32BE(e2);
      return { deliveryTag, redelivered, exchange, routingKey, messageCount };
    }
    // BASIC_GET_EMPTY
    if (c === 60 && m === 72) return { empty: true };
    // BASIC_DELIVER
    if (c === 60 && m === 60) {
      const { value: consumerTag, end: e1 } = readShortStr(buf, 0);
      const deliveryTag  = Number(buf.readBigUInt64BE(e1));
      const redelivered  = !!(buf[e1 + 8] & 0x01);
      const { value: exchange, end: e2 }   = readShortStr(buf, e1 + 9);
      const { value: routingKey, end: e3 } = readShortStr(buf, e2);
      return { consumerTag, deliveryTag, redelivered, exchange, routingKey };
    }
    // BASIC_ACK (sent by broker in publisher confirm mode, or by client)
    if (c === 60 && m === 80) {
      const deliveryTag = Number(buf.readBigUInt64BE(0));
      const multiple = !!(buf[8] & 0x01);
      return { deliveryTag, multiple };
    }
    return { raw: buf.toString("hex").slice(0, 40) };
  }
}

// ── AMQP payload builders ─────────────────────────────────────────────────────

function buildConnectionStartOk(username, password, clientProps) {
  // client properties table
  const props = encodeTable(clientProps || {
    product:      "mcp-common-server",
    version:      "4.165.0",
    platform:     `Node.js ${process.version}`,
    capabilities: {},
  });
  const mechanism = encodeShortStr("PLAIN");
  // PLAIN: \0username\0password
  const sasl = encodeLongStr(
    Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from(username, "utf8"),
      Buffer.from([0x00]),
      Buffer.from(password, "utf8"),
    ]),
  );
  const locale = encodeShortStr("en_US");
  return Buffer.concat([props, mechanism, sasl, locale]);
}

function buildConnectionTuneOk(channelMax, frameMax, heartbeat) {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(channelMax, 0);
  buf.writeUInt32BE(frameMax, 2);
  buf.writeUInt16BE(heartbeat, 6);
  return buf;
}

function buildConnectionOpen(vhost) {
  const v  = encodeShortStr(vhost || "/");
  const reserved = encodeShortStr("");
  return Buffer.concat([v, reserved, Buffer.from([0x00])]);
}

function buildConnectionClose(code, text) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(code, 0);
  return Buffer.concat([buf, encodeShortStr(text || "bye"), Buffer.from([0, 0, 0, 0])]);
}

function buildChannelOpen() {
  return encodeShortStr(""); // reserved
}

function buildQueueDeclare(queue, passive, durable, exclusive, autoDelete, noWait, args) {
  const flags =
    ((passive    ? 1 : 0) << 0) |
    ((durable    ? 1 : 0) << 1) |
    ((exclusive  ? 1 : 0) << 2) |
    ((autoDelete ? 1 : 0) << 3) |
    ((noWait     ? 1 : 0) << 4);
  const reserved = Buffer.alloc(2); // reserved-1 (uint16)
  return Buffer.concat([
    reserved,
    encodeShortStr(queue || ""),
    Buffer.from([flags]),
    encodeTable(args || {}),
  ]);
}

function buildQueueDelete(queue, ifUnused, ifEmpty, noWait) {
  const flags =
    ((ifUnused ? 1 : 0) << 0) |
    ((ifEmpty  ? 1 : 0) << 1) |
    ((noWait   ? 1 : 0) << 2);
  const reserved = Buffer.alloc(2);
  return Buffer.concat([
    reserved,
    encodeShortStr(queue || ""),
    Buffer.from([flags]),
  ]);
}

function buildQueuePurge(queue, noWait) {
  const reserved = Buffer.alloc(2);
  return Buffer.concat([
    reserved,
    encodeShortStr(queue || ""),
    Buffer.from([noWait ? 1 : 0]),
  ]);
}

function buildBasicPublish(exchange, routingKey, mandatory, immediate) {
  const flags =
    ((mandatory  ? 1 : 0) << 0) |
    ((immediate  ? 1 : 0) << 1);
  const reserved = Buffer.alloc(2);
  return Buffer.concat([
    reserved,
    encodeShortStr(exchange || ""),
    encodeShortStr(routingKey || ""),
    Buffer.from([flags]),
  ]);
}

function buildBasicGet(queue, noAck) {
  const reserved = Buffer.alloc(2);
  return Buffer.concat([
    reserved,
    encodeShortStr(queue || ""),
    Buffer.from([noAck ? 1 : 0]),
  ]);
}

function buildBasicConsume(queue, consumerTag, noLocal, noAck, exclusive, noWait, args) {
  const flags =
    ((noLocal   ? 1 : 0) << 0) |
    ((noAck     ? 1 : 0) << 1) |
    ((exclusive ? 1 : 0) << 2) |
    ((noWait    ? 1 : 0) << 3);
  const reserved = Buffer.alloc(2);
  return Buffer.concat([
    reserved,
    encodeShortStr(queue || ""),
    encodeShortStr(consumerTag || ""),
    Buffer.from([flags]),
    encodeTable(args || {}),
  ]);
}

function buildBasicCancel(consumerTag, noWait) {
  return Buffer.concat([
    encodeShortStr(consumerTag),
    Buffer.from([noWait ? 1 : 0]),
  ]);
}

function buildBasicAckNack(deliveryTag, multiple, isNack, requeue) {
  const methodId = isNack ? METHOD.BASIC_NACK[1] : METHOD.BASIC_ACK[1];
  let flags = (multiple ? 1 : 0);
  if (isNack) flags |= ((requeue ? 1 : 0) << 1);
  const payload = Buffer.alloc(9);
  payload.writeBigUInt64BE(BigInt(deliveryTag), 0);
  payload[8] = flags;
  return { classId: CLS.BASIC, methodId, payload };
}

function buildBasicQos(prefetchCount) {
  const buf = Buffer.alloc(7);
  buf.writeUInt32BE(0, 0);                  // prefetch-size (0 = no limit)
  buf.writeUInt16BE(prefetchCount || 1, 4); // prefetch-count
  buf[6] = 0;                               // global flag
  return buf;
}

// ── Connection setup ─────────────────────────────────────────────────────────

/**
 * Open an AMQP connection, perform handshake, open channel 1.
 * Returns { socket, parser, send, nextFrame, waitForMethod, channelMax, frameMax }.
 */
async function openAmqpConnection(opts) {
  const {
    host,
    port,
    tls:          useTls = false,
    reject_unauthorized = true,
    username      = "guest",
    password      = "guest",
    vhost         = "/",
    timeout       = DEFAULT_TIMEOUT_MS,
    connect_timeout,
    heartbeat     = 0,
    channel       = 1,
  } = opts;

  const connToMs = typeof connect_timeout === "number"
    ? connect_timeout * 1000
    : Math.min(timeout, DEFAULT_CONN_TO_MS);

  return new Promise((resolve, reject) => {
    const parser   = new AmqpParser();
    const waiters  = [];     // { resolve, reject } promise waiters
    const frameBuf = [];     // buffered frames (delivered before waiter registered)
    let settled    = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    };

    const onData = (chunk) => {
      try {
        parser.feed(chunk);
      } catch (e) {
        done(new ToolError(`amqp_client: parse error: ${e.message}`, -32603));
        return;
      }
      for (const frame of parser.take()) {
        if (frame.type === "HEARTBEAT") continue; // ignore heartbeats
        const w = waiters.shift();
        if (w) w.resolve(frame);
        else frameBuf.push(frame);
      }
    };

    const send = (data) => { if (!socket.destroyed) socket.write(data); };

    const nextFrame = () => {
      if (frameBuf.length > 0) return Promise.resolve(frameBuf.shift());
      return new Promise((res, rej) => waiters.push({ resolve: res, reject: rej }));
    };

    // Resolve all pending waiters with null (used to drain stale waiters
    // from a consume loop before sending BASIC_CANCEL).
    const drainWaiters = () => {
      while (waiters.length) waiters.shift().resolve(null);
    };

    const waitForMethod = async (expectedName) => {
      const f = await nextFrame();
      if (!f || f.type !== "METHOD" || f.name !== expectedName)
        throw new ToolError(
          `amqp_client: expected ${expectedName}, got ${f ? `${f.type}/${f.name || ""}` : "null"}`, -32603);
      return f;
    };

    // ── Socket ────────────────────────────────────────────────────────────────
    const socketOpts = { host, port };
    const socket = useTls
      ? tls.connect({ ...socketOpts, rejectUnauthorized: reject_unauthorized, servername: host })
      : net.createConnection(socketOpts);

    let connTimer = setTimeout(() => {
      socket.destroy(
        new ToolError(
          `amqp_client: TCP connection timed out after ${connToMs} ms.`, -32603));
    }, connToMs);

    socket.on("data", onData);
    socket.on("error", (e) =>
      done(new ToolError(`amqp_client: socket error: ${e.message}`, -32603)));
    socket.on("close", () => {
      while (waiters.length)
        waiters.shift().reject(new ToolError("amqp_client: connection closed unexpectedly.", -32603));
    });

    // ── AMQP handshake ────────────────────────────────────────────────────────
    const onConnect = async () => {
      clearTimeout(connTimer);
      connTimer = null;
      try {
        // 1. Send protocol header
        send(AMQP_PROTOCOL_HEADER);

        // 2. Receive Connection.Start
        const start = await waitForMethod("CONNECTION_START");
        if (!start.mechanisms || !start.mechanisms.includes("PLAIN"))
          throw new ToolError(
            `amqp_client: broker does not support PLAIN auth (got: ${start.mechanisms}).`, -32603);

        // 3. Send Connection.StartOk
        send(buildMethodFrame(0, CLS.CONNECTION, METHOD.CONNECTION_START_OK[1],
          buildConnectionStartOk(username, password)));

        // 4. Receive Connection.Tune
        const tune = await waitForMethod("CONNECTION_TUNE");
        const negotiatedFrameMax  = tune.frameMax  || 131072;
        const negotiatedHeartbeat = heartbeat !== undefined ? heartbeat : tune.heartbeat;
        const negotiatedChanMax   = tune.channelMax || 2047;

        // 5. Send Connection.TuneOk
        send(buildMethodFrame(0, CLS.CONNECTION, METHOD.CONNECTION_TUNE_OK[1],
          buildConnectionTuneOk(negotiatedChanMax, negotiatedFrameMax, negotiatedHeartbeat)));

        // 6. Send Connection.Open
        send(buildMethodFrame(0, CLS.CONNECTION, METHOD.CONNECTION_OPEN[1],
          buildConnectionOpen(vhost)));

        // 7. Receive Connection.OpenOk
        await waitForMethod("CONNECTION_OPEN_OK");

        // 8. Open channel 1
        send(buildMethodFrame(channel, CLS.CHANNEL, METHOD.CHANNEL_OPEN[1],
          buildChannelOpen()));

        // 9. Receive Channel.OpenOk
        await waitForMethod("CHANNEL_OPEN_OK");

        done(null, {
          socket, parser, send, nextFrame, waitForMethod, drainWaiters,
          channelMax: negotiatedChanMax,
          frameMax:   negotiatedFrameMax,
          channel,
        });
      } catch (e) {
        socket.destroy();
        done(e);
      }
    };

    socket.once(useTls ? "secureConnect" : "connect", onConnect);
  });
}

// ── Graceful close ─────────────────────────────────────────────────────────

async function closeAmqpConnection(conn) {
  const { socket, send, waitForMethod, drainWaiters, channel } = conn;
  try {
    // Drain any stale pending waiters before sending close frames
    if (typeof drainWaiters === "function") drainWaiters();

    // Close channel
    send(buildMethodFrame(channel, CLS.CHANNEL, METHOD.CHANNEL_CLOSE[1],
      Buffer.concat([
        Buffer.from([0, 0]),  // reply-code
        encodeShortStr("bye"),
        Buffer.from([0, 0, 0, 0]),  // class+method
      ])));
    const p1 = waitForMethod("CHANNEL_CLOSE_OK").catch(() => {});

    // Close connection
    send(buildMethodFrame(0, CLS.CONNECTION, METHOD.CONNECTION_CLOSE[1],
      buildConnectionClose(200, "bye")));
    const p2 = waitForMethod("CONNECTION_CLOSE_OK").catch(() => {});

    await Promise.race([Promise.all([p1, p2]), new Promise(r => setTimeout(r, 1000))]);
  } catch (_) { /* ignore close errors */ }
  finally {
    if (!socket.destroyed) socket.destroy();
  }
}

// ── Collect a full message (HEADER + BODY frames) ─────────────────────────

async function collectMessage(conn) {
  const { nextFrame } = conn;
  // Expect HEADER frame
  const header = await nextFrame();
  if (header.type !== "HEADER")
    throw new ToolError(
      `amqp_client: expected HEADER frame, got ${header.type}`, -32603);

  const totalSize = header.bodySize;
  if (totalSize > MAX_BODY_BYTES)
    throw new ToolError(
      `amqp_client: message body ${totalSize} bytes exceeds ${MAX_BODY_BYTES} byte limit.`, -32603);

  const chunks = [];
  let received = 0;
  while (received < totalSize) {
    const body = await nextFrame();
    if (body.type !== "BODY")
      throw new ToolError(`amqp_client: expected BODY frame, got ${body.type}`, -32603);
    chunks.push(body.data);
    received += body.data.length;
  }
  const bodyBuf = Buffer.concat(chunks);
  return { bodyBytes: totalSize, body: bodyBuf, bodyStr: bodyBuf.toString("utf8") };
}

// ── Main entry ───────────────────────────────────────────────────────────────

async function amqpClient(opts) {
  const {
    // Connection
    host,
    port,
    tls:                useTls = false,
    reject_unauthorized        = true,
    username                   = "guest",
    password                   = "guest",
    vhost                      = "/",
    timeout                    = 30,
    connect_timeout,
    heartbeat                  = 0,
    // Operation
    operation,
    // Exchange/Queue names
    exchange                   = "",
    routing_key                = "",
    queue,
    // Publish
    body                       = "",
    body_encoding              = "utf8",
    content_type,
    persistent                 = false,
    mandatory                  = false,
    // Queue.Declare
    durable                    = false,
    exclusive                  = false,
    auto_delete                = false,
    passive                    = false,
    queue_args,
    // Consume
    max_messages               = 10,
    consume_timeout            = 5,
    no_ack                     = false,
    prefetch_count             = 1,
    // Get
    ack_mode                   = "auto",
    // Ack/Nack
    delivery_tag,
    multiple                   = false,
    requeue                    = true,
  } = opts || {};

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!host || typeof host !== "string")
    throw new ToolError("amqp_client: 'host' is required (string).", -32602);

  const VALID_OPS = [
    "connect", "publish", "get", "consume",
    "declare_queue", "delete_queue", "purge", "ack", "nack",
  ];
  if (!operation || !VALID_OPS.includes(operation))
    throw new ToolError(
      `amqp_client: 'operation' must be one of: ${VALID_OPS.join(", ")}.`, -32602);

  // Per-operation field validation
  if (["publish"].includes(operation)) {
    if (routing_key !== undefined) guardOptStr(routing_key, "routing_key");
    guardOptStr(exchange, "exchange");
    // Validate body size
    const bodyBuf = body_encoding === "base64"
      ? Buffer.from(body || "", "base64")
      : Buffer.from(body || "", "utf8");
    if (bodyBuf.length > MAX_BODY_BYTES)
      throw new ToolError(
        `amqp_client: body exceeds ${MAX_BODY_BYTES / 1024 / 1024} MB limit.`, -32602);
  }
  if (["get", "consume", "declare_queue", "delete_queue", "purge"].includes(operation)) {
    if (!queue)
      throw new ToolError(`amqp_client: 'queue' is required for operation '${operation}'.`, -32602);
    guardStr(queue, "queue");
  }
  if (operation === "consume") {
    if (max_messages < 1 || max_messages > 500)
      throw new ToolError("amqp_client: 'max_messages' must be 1–500.", -32602);
  }
  if (["ack", "nack"].includes(operation)) {
    if (delivery_tag === undefined || delivery_tag === null)
      throw new ToolError(`amqp_client: 'delivery_tag' is required for '${operation}'.`, -32602);
  }

  // Guard credential NUL bytes
  if (username) guardStr(username, "username");
  // Never echo password

  const timeoutMs = (typeof timeout === "number" && timeout > 0)
    ? timeout * 1000
    : DEFAULT_TIMEOUT_MS;
  const resolvedPort = typeof port === "number" ? port
    : (useTls ? DEFAULT_TLS_PORT : DEFAULT_PORT);

  // ── Wall-clock timeout ─────────────────────────────────────────────────────
  const startTime = Date.now();
  let globalTimer;
  let conn;

  const timeoutPromise = new Promise((_, rej) => {
    globalTimer = setTimeout(() =>
      rej(new ToolError(`amqp_client: operation timed out after ${timeoutMs} ms.`, -32603)),
      timeoutMs);
  });

  async function run() {
    conn = await openAmqpConnection({
      host,
      port:               resolvedPort,
      tls:                useTls,
      reject_unauthorized,
      username,
      password,
      vhost,
      timeout:            timeoutMs,
      connect_timeout,
      heartbeat,
    });

    const { send, waitForMethod, nextFrame, drainWaiters, channel } = conn;
    let result;

    switch (operation) {

      // ── connect (probe) ────────────────────────────────────────────────────
      case "connect": {
        result = {
          connected: true,
          vhost,
          frameMax: conn.frameMax,
          channelMax: conn.channelMax,
        };
        break;
      }

      // ── declare_queue ──────────────────────────────────────────────────────
      case "declare_queue": {
        send(buildMethodFrame(channel, CLS.QUEUE, METHOD.QUEUE_DECLARE[1],
          buildQueueDeclare(queue, passive, durable, exclusive, auto_delete, false, queue_args)));
        const ok = await waitForMethod("QUEUE_DECLARE_OK");
        result = {
          queue:         ok.queue,
          messageCount:  ok.messageCount,
          consumerCount: ok.consumerCount,
          durable, exclusive, autoDelete: auto_delete,
        };
        break;
      }

      // ── delete_queue ───────────────────────────────────────────────────────
      case "delete_queue": {
        send(buildMethodFrame(channel, CLS.QUEUE, METHOD.QUEUE_DELETE[1],
          buildQueueDelete(queue, false, false, false)));
        const ok = await waitForMethod("QUEUE_DELETE_OK");
        result = { queue, messageCount: ok.messageCount, deleted: true };
        break;
      }

      // ── purge ──────────────────────────────────────────────────────────────
      case "purge": {
        send(buildMethodFrame(channel, CLS.QUEUE, METHOD.QUEUE_PURGE[1],
          buildQueuePurge(queue, false)));
        const ok = await waitForMethod("QUEUE_PURGE_OK");
        result = { queue, messageCount: ok.messageCount, purged: true };
        break;
      }

      // ── publish ────────────────────────────────────────────────────────────
      case "publish": {
        const bodyBuf = body_encoding === "base64"
          ? Buffer.from(body || "", "base64")
          : Buffer.from(body || "", "utf8");

        // Basic.Publish
        send(buildMethodFrame(channel, CLS.BASIC, METHOD.BASIC_PUBLISH[1],
          buildBasicPublish(exchange, routing_key, mandatory, false)));

        // Content header
        const deliveryMode = persistent ? 2 : 1;
        send(buildHeaderFrame(channel, CLS.BASIC, bodyBuf.length, {
          content_type: content_type || "text/plain",
          delivery_mode: deliveryMode,
        }));

        // Body frame(s) — split at frameMax if needed
        const frameMax = conn.frameMax || 131072;
        const FRAME_OVERHEAD = 8; // 7 header + 1 frame-end
        const maxBody = frameMax - FRAME_OVERHEAD;
        for (let off = 0; off < bodyBuf.length || off === 0; off += maxBody) {
          const chunk = bodyBuf.slice(off, off + maxBody);
          send(buildBodyFrame(channel, chunk));
          if (bodyBuf.length === 0) break;
        }

        result = {
          published:    true,
          exchange:     exchange || "",
          routing_key:  routing_key || "",
          bodyBytes:    bodyBuf.length,
          persistent,
        };
        break;
      }

      // ── get (poll one message) ─────────────────────────────────────────────
      case "get": {
        const autoAck = ack_mode === "auto";
        send(buildMethodFrame(channel, CLS.BASIC, METHOD.BASIC_GET[1],
          buildBasicGet(queue, autoAck)));

        const f = await nextFrame();
        if (f.type !== "METHOD")
          throw new ToolError(`amqp_client: expected METHOD frame, got ${f.type}`, -32603);

        if (f.name === "BASIC_GET_EMPTY") {
          result = { queue, empty: true, message: null };
        } else if (f.name === "BASIC_GET_OK") {
          const msg = await collectMessage(conn);
          result = {
            queue,
            empty:        false,
            deliveryTag:  f.deliveryTag,
            redelivered:  f.redelivered,
            exchange:     f.exchange,
            routingKey:   f.routingKey,
            messageCount: f.messageCount,
            bodyBytes:    msg.bodyBytes,
            body:         msg.bodyStr,
          };
          // Auto-ack
          if (autoAck === false) {
            // Leave for caller to ack manually
            result.ackRequired = true;
          }
        } else {
          throw new ToolError(
            `amqp_client: unexpected response to Basic.Get: ${f.name}`, -32603);
        }
        break;
      }

      // ── consume (subscribe + collect N messages) ───────────────────────────
      case "consume": {
        const autoAck = ack_mode === "auto" || no_ack;

        // Set prefetch
        if (!autoAck && prefetch_count > 0) {
          send(buildMethodFrame(channel, CLS.BASIC, METHOD.BASIC_QOS[1],
            buildBasicQos(prefetch_count)));
          await waitForMethod("BASIC_QOS_OK");
        }

        // Subscribe
        const consumerTag = `mcp-${Date.now().toString(36)}`;
        send(buildMethodFrame(channel, CLS.BASIC, METHOD.BASIC_CONSUME[1],
          buildBasicConsume(queue, consumerTag, false, autoAck, false, false)));
        const consumeOk = await waitForMethod("BASIC_CONSUME_OK");

        // Collect messages until max_messages or timeout
        const messages = [];
        const deadline = Date.now() + (consume_timeout || 5) * 1000;
        const maxMsgs  = Math.min(max_messages, 500);

        while (messages.length < maxMsgs && Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const frame = await Promise.race([
            nextFrame(),
            new Promise(res => setTimeout(() => res(null), remaining)),
          ]);
          if (!frame) break; // timeout
          if (frame.type !== "METHOD" || frame.name !== "BASIC_DELIVER") continue;

          // Collect body
          const msg = await collectMessage(conn);
          const entry = {
            deliveryTag: frame.deliveryTag,
            exchange:    frame.exchange,
            routingKey:  frame.routingKey,
            redelivered: frame.redelivered,
            bodyBytes:   msg.bodyBytes,
            body:        msg.bodyStr,
          };
          messages.push(entry);

          // Auto-ack
          if (autoAck === false) {
            const { classId, methodId, payload } = buildBasicAckNack(
              frame.deliveryTag, false, false, false);
            send(buildMethodFrame(channel, classId, methodId, payload));
          }
        }

        // Drain any pending nextFrame waiter from the consume loop before
        // sending BASIC_CANCEL — otherwise the stale waiter would consume
        // BASIC_CANCEL_OK before waitForMethod("BASIC_CANCEL_OK") can see it.
        drainWaiters();

        // Cancel consumer
        send(buildMethodFrame(channel, CLS.BASIC, METHOD.BASIC_CANCEL[1],
          buildBasicCancel(consumeOk.consumerTag || consumerTag, false)));
        await waitForMethod("BASIC_CANCEL_OK").catch(() => {});

        result = {
          queue,
          consumerTag: consumeOk.consumerTag || consumerTag,
          messageCount: messages.length,
          messages,
        };
        break;
      }

      // ── ack ────────────────────────────────────────────────────────────────
      case "ack": {
        const { classId, methodId, payload } = buildBasicAckNack(
          Number(delivery_tag), multiple, false, false);
        send(buildMethodFrame(channel, classId, methodId, payload));
        result = { acknowledged: true, deliveryTag: Number(delivery_tag), multiple };
        break;
      }

      // ── nack ───────────────────────────────────────────────────────────────
      case "nack": {
        const { classId, methodId, payload } = buildBasicAckNack(
          Number(delivery_tag), multiple, true, requeue);
        send(buildMethodFrame(channel, classId, methodId, payload));
        result = { nacked: true, deliveryTag: Number(delivery_tag), multiple, requeue };
        break;
      }

      default:
        throw new ToolError(`amqp_client: unhandled operation '${operation}'.`, -32603);
    }

    return {
      host,
      port:      resolvedPort,
      vhost,
      operation,
      elapsedMs: Date.now() - startTime,
      ...result,
    };
  }

  try {
    const runPromise = run();
    runPromise.catch(() => {});
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(globalTimer);
    if (conn) await closeAmqpConnection(conn).catch(() => {});
  }
}

module.exports = { amqpClient };
