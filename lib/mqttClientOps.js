"use strict";
// ── mqtt_client: zero-dep MQTT v3.1.1 client ────────────────────────────────────
// Pure Node.js net/tls — no npm dependencies.
// Implements just enough of the MQTT v3.1.1 packet codec to support the most
// common IoT/messaging operations: connect, publish, subscribe, ping, pubsub.

const net = require("net");
const tls = require("tls");
const { ToolError } = require("./errors");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_PORT       = 1883;
const DEFAULT_TLS_PORT   = 8883;
const DEFAULT_TIMEOUT    = 30_000;       // 30 s wall-clock
const DEFAULT_CONN_TIMEOUT = 10_000;     // 10 s connect
const MAX_PAYLOAD_BYTES  = 1_048_576;    // 1 MB
const MAX_TOPIC_LEN      = 65_535;       // MQTT spec max
const MAX_CLIENT_ID_LEN  = 23;          // MQTT 3.1.1 spec (some brokers allow more)
const MAX_MESSAGES       = 500;          // subscribe result cap

// ── MQTT v3.1.1 packet type constants ────────────────────────────────────────
const PT = {
  CONNECT:     1,
  CONNACK:     2,
  PUBLISH:     3,
  PUBACK:      4,
  SUBSCRIBE:   8,
  SUBACK:      9,
  UNSUBSCRIBE: 10,
  UNSUBACK:    11,
  PINGREQ:     12,
  PINGRESP:    13,
  DISCONNECT:  14,
};

// ── Security guards ──────────────────────────────────────────────────────────

/** Validate a topic string — no wildcard chars in topic names, no NUL bytes. */
function guardTopic(val, label = "topic") {
  if (typeof val !== "string")
    throw new ToolError(`mqtt_client: '${label}' must be a string.`, -32602);
  if (val.length === 0)
    throw new ToolError(`mqtt_client: '${label}' must not be empty.`, -32602);
  if (val.length > MAX_TOPIC_LEN)
    throw new ToolError(
      `mqtt_client: '${label}' exceeds ${MAX_TOPIC_LEN}-byte limit.`,
      -32602,
    );
  if (val.includes("\0"))
    throw new ToolError(
      `mqtt_client: '${label}' must not contain NUL bytes.`,
      -32602,
    );
  if (val.includes("+") || val.includes("#"))
    throw new ToolError(
      `mqtt_client: '${label}' must not contain wildcard characters '+' or '#' (use topic_filters for subscriptions).`,
      -32602,
    );
  return val;
}

/** Validate a topic filter (wildcards allowed: # and +). */
function guardTopicFilter(val, label = "topic_filter") {
  // Same constraints as guardTopic but allow # and +
  if (typeof val !== "string")
    throw new ToolError(`mqtt_client: '${label}' must be a string.`, -32602);
  if (val.length === 0)
    throw new ToolError(`mqtt_client: '${label}' must not be empty.`, -32602);
  if (val.length > MAX_TOPIC_LEN)
    throw new ToolError(
      `mqtt_client: '${label}' exceeds ${MAX_TOPIC_LEN}-byte limit.`,
      -32602,
    );
  if (val.includes("\0"))
    throw new ToolError(
      `mqtt_client: '${label}' must not contain NUL bytes.`,
      -32602,
    );
  return val;
}

/** Validate optional string — returns undefined if absent/null. */
function guardOptStr(val, label) {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "string")
    throw new ToolError(`mqtt_client: '${label}' must be a string.`, -32602);
  if (val.includes("\0"))
    throw new ToolError(
      `mqtt_client: '${label}' must not contain NUL bytes.`,
      -32602,
    );
  return val;
}

// ── Variable-length encoding (remaining-length field) ────────────────────────

function encodeVarLen(n) {
  const bytes = [];
  do {
    let byte = n & 0x7f;
    n >>= 7;
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return Buffer.from(bytes);
}

/** Decode variable-length integer from a buffer starting at pos.
 * Returns { value, consumed } or null if not enough bytes. */
function decodeVarLen(buf, pos) {
  let value = 0;
  let multiplier = 1;
  let i = 0;
  while (pos + i < buf.length) {
    const byte = buf[pos + i];
    value += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    i++;
    if ((byte & 0x80) === 0) return { value, consumed: i };
    if (i > 4) throw new ToolError("mqtt_client: malformed remaining-length field.", -32603);
  }
  return null; // incomplete
}

// ── MQTT string encoding (2-byte length prefix + UTF-8) ─────────────────────

function encodeMqttStr(str) {
  const encoded = Buffer.from(str, "utf8");
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(encoded.length, 0);
  return Buffer.concat([lenBuf, encoded]);
}

// ── Packet builders ──────────────────────────────────────────────────────────

/**
 * Build a CONNECT packet.
 * @param {object} opts
 */
function buildConnect(opts) {
  const {
    clientId = "",
    username,
    password,
    keepAlive = 60,
    cleanSession = true,
    will,
  } = opts;

  // Variable header: protocol name + version + connect flags + keep-alive
  const protocolName = encodeMqttStr("MQTT");
  const protocolLevel = Buffer.from([0x04]); // MQTT 3.1.1

  // Connect flags
  let flags = 0;
  if (cleanSession) flags |= 0x02;
  if (will) {
    flags |= 0x04;
    if (will.qos) flags |= ((will.qos & 0x03) << 3);
    if (will.retain) flags |= 0x20;
  }
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;

  const connectFlagsBuf = Buffer.from([flags]);
  const keepAliveBuf = Buffer.alloc(2);
  keepAliveBuf.writeUInt16BE(keepAlive, 0);

  // Payload
  const payloadParts = [encodeMqttStr(clientId)];
  if (will) {
    payloadParts.push(encodeMqttStr(will.topic || ""));
    const willPayload = Buffer.from(will.payload || "", "utf8");
    const willLen = Buffer.alloc(2);
    willLen.writeUInt16BE(willPayload.length, 0);
    payloadParts.push(willLen, willPayload);
  }
  if (username) payloadParts.push(encodeMqttStr(username));
  if (password) payloadParts.push(encodeMqttStr(password));

  const varHeader = Buffer.concat([
    protocolName, protocolLevel, connectFlagsBuf, keepAliveBuf,
  ]);
  const payload = Buffer.concat(payloadParts);
  const remaining = Buffer.concat([varHeader, payload]);
  const fixedHeader = Buffer.concat([
    Buffer.from([(PT.CONNECT << 4)]),
    encodeVarLen(remaining.length),
  ]);
  return Buffer.concat([fixedHeader, remaining]);
}

/** Build a DISCONNECT packet. */
function buildDisconnect() {
  return Buffer.from([PT.DISCONNECT << 4, 0x00]);
}

/** Build a PUBLISH packet.
 * @param {string} topic
 * @param {Buffer} payload
 * @param {number} qos  0 or 1
 * @param {boolean} retain
 * @param {number} packetId  required for qos>0
 */
function buildPublish(topic, payload, qos, retain, packetId) {
  const topicBuf = encodeMqttStr(topic);
  let varHeader;
  if (qos > 0) {
    const pidBuf = Buffer.alloc(2);
    pidBuf.writeUInt16BE(packetId, 0);
    varHeader = Buffer.concat([topicBuf, pidBuf]);
  } else {
    varHeader = topicBuf;
  }
  const remaining = Buffer.concat([varHeader, payload]);
  let firstByte = (PT.PUBLISH << 4);
  if (retain) firstByte |= 0x01;
  if (qos > 0) firstByte |= (qos << 1);
  return Buffer.concat([
    Buffer.from([firstByte]),
    encodeVarLen(remaining.length),
    remaining,
  ]);
}

/** Build a SUBSCRIBE packet. */
function buildSubscribe(topicFilters, packetId) {
  const pidBuf = Buffer.alloc(2);
  pidBuf.writeUInt16BE(packetId, 0);
  const subs = topicFilters.map(({ filter, qos }) => {
    return Buffer.concat([encodeMqttStr(filter), Buffer.from([qos & 0x03])]);
  });
  const remaining = Buffer.concat([pidBuf, ...subs]);
  return Buffer.concat([
    Buffer.from([(PT.SUBSCRIBE << 4) | 0x02]),
    encodeVarLen(remaining.length),
    remaining,
  ]);
}

/** Build a PINGREQ packet. */
function buildPingreq() {
  return Buffer.from([PT.PINGREQ << 4, 0x00]);
}

// ── Streaming MQTT packet parser ─────────────────────────────────────────────

class MqttParser {
  constructor() {
    this._buf = Buffer.alloc(0);
    this._packets = [];
  }

  feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 2) {
      if (this._buf.length === 0) break;
      const varLen = decodeVarLen(this._buf, 1);
      if (!varLen) break; // incomplete length field
      const { value: remLen, consumed } = varLen;
      const totalLen = 1 + consumed + remLen;
      if (this._buf.length < totalLen) break; // wait for more data
      const pkt = this._buf.slice(0, totalLen);
      this._buf = this._buf.slice(totalLen);
      this._packets.push(this._parsePacket(pkt, consumed));
    }
  }

  take() {
    return this._packets.splice(0);
  }

  _parsePacket(buf, varLenConsumed) {
    const firstByte = buf[0];
    const type = (firstByte >> 4) & 0x0f;
    const flags = firstByte & 0x0f;
    const headerEnd = 1 + varLenConsumed;
    const payload = buf.slice(headerEnd);

    switch (type) {
      case PT.CONNACK: {
        const sessionPresent = !!(payload[0] & 0x01);
        const returnCode = payload[1];
        const CONNACK_CODES = [
          "Connection Accepted",
          "Connection Refused: Unacceptable Protocol Version",
          "Connection Refused: Identifier Rejected",
          "Connection Refused: Server Unavailable",
          "Connection Refused: Bad User Name or Password",
          "Connection Refused: Not Authorized",
        ];
        return {
          type: "CONNACK",
          sessionPresent,
          returnCode,
          accepted: returnCode === 0,
          reason: CONNACK_CODES[returnCode] || `Unknown return code ${returnCode}`,
        };
      }
      case PT.PUBACK: {
        const packetId = payload.readUInt16BE(0);
        return { type: "PUBACK", packetId };
      }
      case PT.SUBACK: {
        const packetId = payload.readUInt16BE(0);
        const returnCodes = [...payload.slice(2)];
        return { type: "SUBACK", packetId, returnCodes };
      }
      case PT.PUBLISH: {
        const qos     = (flags >> 1) & 0x03;
        const retain  = !!(flags & 0x01);
        const dup     = !!(flags & 0x08);
        const topicLen = payload.readUInt16BE(0);
        const topic    = payload.toString("utf8", 2, 2 + topicLen);
        let rest = payload.slice(2 + topicLen);
        let packetId;
        if (qos > 0) {
          packetId = rest.readUInt16BE(0);
          rest = rest.slice(2);
        }
        return {
          type: "PUBLISH",
          topic,
          payload: rest,
          payloadStr: rest.toString("utf8"),
          qos,
          retain,
          dup,
          packetId,
        };
      }
      case PT.UNSUBACK: {
        const packetId = payload.readUInt16BE(0);
        return { type: "UNSUBACK", packetId };
      }
      case PT.PINGRESP:
        return { type: "PINGRESP" };
      default:
        return { type: `UNKNOWN_${type}`, raw: buf.toString("hex") };
    }
  }
}

// ── Socket + connection helpers ───────────────────────────────────────────────

/**
 * Open a socket, send CONNECT, await CONNACK.
 * Returns { socket, parser, send, nextPacket, waitForType }.
 */
function openMqttConnection(opts) {
  const {
    host,
    port,
    tls: useTls,
    reject_unauthorized = true,
    timeout      = DEFAULT_TIMEOUT,
    connect_timeout,
    clientId,
    username,
    password,
    keepAlive    = 60,
    cleanSession = true,
    will,
  } = opts;

  const connTimeoutMs = typeof connect_timeout === "number"
    ? connect_timeout * 1000
    : Math.min(timeout, DEFAULT_CONN_TIMEOUT);

  return new Promise((resolve, reject) => {
    const parser = new MqttParser();
    const waiters = [];
    const packetBuf = [];
    let settled = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    const onData = (chunk) => {
      parser.feed(chunk);
      const pkts = parser.take();
      for (const pkt of pkts) {
        const w = waiters.shift();
        if (w) w.resolve(pkt);
        else packetBuf.push(pkt);
      }
    };

    /** Send raw bytes down the socket. */
    const send = (buf) => socket.write(buf);

    /**
     * Wait for the next incoming packet.
     * @returns {Promise<object>}
     */
    const nextPacket = () => {
      if (packetBuf.length > 0) return Promise.resolve(packetBuf.shift());
      return new Promise((res, rej) => waiters.push({ resolve: res, reject: rej }));
    };

    /**
     * Wait for the next packet of a given type; reject on any other type.
     */
    const waitForType = async (expectedType) => {
      const pkt = await nextPacket();
      if (pkt.type !== expectedType)
        throw new ToolError(
          `mqtt_client: expected ${expectedType} but got ${pkt.type}.`,
          -32603,
        );
      return pkt;
    };

    // ── Create socket ────────────────────────────────────────────────────────
    const socketOpts = { host, port };
    const socket = useTls
      ? tls.connect({
          ...socketOpts,
          rejectUnauthorized: reject_unauthorized,
          servername: host,
        })
      : net.createConnection(socketOpts);

    let connTimer = setTimeout(() => {
      socket.destroy(
        new ToolError(
          `mqtt_client: TCP connection timed out after ${connTimeoutMs} ms.`,
          -32603,
        ),
      );
    }, connTimeoutMs);

    socket.on("data", onData);
    socket.on("error", (e) =>
      done(new ToolError(`mqtt_client: socket error: ${e.message}`, -32603)),
    );
    socket.on("close", () => {
      while (waiters.length)
        waiters.shift().reject(
          new ToolError("mqtt_client: connection closed unexpectedly.", -32603),
        );
    });

    const onConnect = async () => {
      clearTimeout(connTimer);
      connTimer = null;
      try {
        // Send CONNECT
        const connectPkt = buildConnect({
          clientId, username, password, keepAlive, cleanSession, will,
        });
        send(connectPkt);

        // Await CONNACK
        const connack = await nextPacket();
        if (connack.type !== "CONNACK")
          throw new ToolError(
            `mqtt_client: expected CONNACK, got ${connack.type}.`,
            -32603,
          );
        if (!connack.accepted)
          throw new ToolError(
            `mqtt_client: broker refused connection — ${connack.reason}.`,
            -32603,
          );
        done(null, { socket, parser, send, nextPacket, waitForType, connack });
      } catch (e) {
        socket.destroy();
        done(e);
      }
    };

    socket.once(useTls ? "secureConnect" : "connect", onConnect);
  });
}

// ── Packet ID counter ─────────────────────────────────────────────────────────
let _pid = 1;
function nextPid() {
  const id = _pid;
  _pid = (_pid % 65535) + 1;
  return id;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Execute an MQTT operation.
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function mqttClient(opts) {
  const {
    // Connection
    host,
    port,
    tls: useTls      = false,
    reject_unauthorized = true,
    client_id,
    username,
    password,
    keep_alive       = 60,
    clean_session    = true,
    timeout          = 30,
    connect_timeout,
    // Will message
    will_topic,
    will_payload,
    will_qos         = 0,
    will_retain      = false,
    // Operation
    operation,
    // Publish
    topic,
    payload          = "",
    payload_encoding = "utf8",
    qos              = 0,
    retain           = false,
    // Subscribe
    topic_filters,
    subscribe_qos    = 0,
    max_messages     = 10,
    subscribe_timeout = 5,
    // PubSub
    wait_for_own     = true,
  } = opts || {};

  // ── Required field validation ─────────────────────────────────────────────
  if (!opts || !host || typeof host !== "string")
    throw new ToolError("mqtt_client: 'host' is required (string).", -32602);

  const VALID_OPS = ["connect", "publish", "subscribe", "ping", "pubsub"];
  if (!operation || !VALID_OPS.includes(operation))
    throw new ToolError(
      `mqtt_client: 'operation' must be one of: ${VALID_OPS.join(", ")}.`,
      -32602,
    );

  const timeoutMs = typeof timeout === "number" && timeout > 0
    ? timeout * 1000
    : DEFAULT_TIMEOUT;

  const resolvedPort = typeof port === "number"
    ? port
    : (useTls ? DEFAULT_TLS_PORT : DEFAULT_PORT);

  // ── Per-operation pre-connection validation ──────────────────────────────
  switch (operation) {
    case "publish": {
      guardTopic(topic, "topic");
      if (qos !== 0 && qos !== 1)
        throw new ToolError("mqtt_client PUBLISH: 'qos' must be 0 or 1.", -32602);
      const payBuf = payload_encoding === "base64"
        ? Buffer.from(payload || "", "base64")
        : Buffer.from(payload || "", "utf8");
      if (payBuf.length > MAX_PAYLOAD_BYTES)
        throw new ToolError(
          `mqtt_client PUBLISH: payload exceeds ${MAX_PAYLOAD_BYTES / 1024} KB limit.`,
          -32602,
        );
      break;
    }
    case "subscribe": {
      if (!topic_filters || (typeof topic_filters !== "string" && !Array.isArray(topic_filters)))
        throw new ToolError(
          "mqtt_client SUBSCRIBE: 'topic_filters' must be a string or array.",
          -32602,
        );
      const filters = Array.isArray(topic_filters) ? topic_filters : [topic_filters];
      filters.forEach((f, i) => guardTopicFilter(f, `topic_filters[${i}]`));
      if (max_messages < 1 || max_messages > MAX_MESSAGES)
        throw new ToolError(
          `mqtt_client SUBSCRIBE: 'max_messages' must be 1–${MAX_MESSAGES}.`,
          -32602,
        );
      break;
    }
    case "pubsub": {
      guardTopic(topic, "topic");
      if (qos !== 0 && qos !== 1)
        throw new ToolError("mqtt_client PUBSUB: 'qos' must be 0 or 1.", -32602);
      const payBuf = payload_encoding === "base64"
        ? Buffer.from(payload || "", "base64")
        : Buffer.from(payload || "", "utf8");
      if (payBuf.length > MAX_PAYLOAD_BYTES)
        throw new ToolError(
          `mqtt_client PUBSUB: payload exceeds ${MAX_PAYLOAD_BYTES / 1024} KB limit.`,
          -32602,
        );
      break;
    }
    case "connect":
    case "ping":
      break;
  }

  // Validate credentials
  if (username !== undefined) guardOptStr(username, "username");
  if (password !== undefined) guardOptStr(password, "password");

  // Validate will
  let will;
  if (will_topic !== undefined) {
    guardTopic(will_topic, "will_topic");
    will = {
      topic:   will_topic,
      payload: will_payload || "",
      qos:     will_qos || 0,
      retain:  !!will_retain,
    };
  }

  // Build a safe client ID if not provided
  const clientId = client_id
    ? String(client_id).slice(0, MAX_CLIENT_ID_LEN)
    : `mcp_${Date.now().toString(36).slice(-8)}`;

  // ── Wall-clock timeout ────────────────────────────────────────────────────
  const startTime = Date.now();
  let socket;
  let globalTimer;

  const timeoutPromise = new Promise((_, rej) => {
    globalTimer = setTimeout(
      () =>
        rej(
          new ToolError(
            `mqtt_client: operation timed out after ${timeoutMs} ms.`,
            -32603,
          ),
        ),
      timeoutMs,
    );
  });

  async function run() {
    const conn = await openMqttConnection({
      host,
      port:              resolvedPort,
      tls:               useTls,
      reject_unauthorized,
      timeout:           timeoutMs,
      connect_timeout,
      clientId,
      username,
      password,
      keepAlive:         keep_alive,
      cleanSession:      clean_session,
      will,
    });
    socket = conn.socket;
    const { send, nextPacket, waitForType, connack } = conn;

    let result;

    switch (operation) {

      // ── connect ───────────────────────────────────────────────────────────
      case "connect": {
        // Just CONNECT → CONNACK → DISCONNECT
        result = {
          connected:      true,
          sessionPresent: connack.sessionPresent,
          clientId,
          host,
          port:           resolvedPort,
          tls:            useTls,
        };
        break;
      }

      // ── ping ──────────────────────────────────────────────────────────────
      case "ping": {
        const t0 = Date.now();
        send(buildPingreq());
        await waitForType("PINGRESP");
        const latencyMs = Date.now() - t0;
        result = { pong: true, latencyMs, clientId, host, port: resolvedPort };
        break;
      }

      // ── publish ───────────────────────────────────────────────────────────
      case "publish": {
        const payBuf = payload_encoding === "base64"
          ? Buffer.from(payload || "", "base64")
          : Buffer.from(payload || "", "utf8");

        const guardedTopic = guardTopic(topic, "topic");

        if (qos === 0) {
          send(buildPublish(guardedTopic, payBuf, 0, !!retain, 0));
          result = {
            published: true,
            topic:     guardedTopic,
            qos:       0,
            payloadBytes: payBuf.length,
            retain:    !!retain,
          };
        } else {
          // QoS 1 — wait for PUBACK
          const pid = nextPid();
          send(buildPublish(guardedTopic, payBuf, 1, !!retain, pid));
          const puback = await waitForType("PUBACK");
          result = {
            published: true,
            topic:     guardedTopic,
            qos:       1,
            packetId:  pid,
            pubackId:  puback.packetId,
            acknowledged: puback.packetId === pid,
            payloadBytes: payBuf.length,
            retain:    !!retain,
          };
        }
        break;
      }

      // ── subscribe ─────────────────────────────────────────────────────────
      case "subscribe": {
        const filters = Array.isArray(topic_filters)
          ? topic_filters.map((f) => guardTopicFilter(f))
          : [guardTopicFilter(topic_filters)];

        const pid = nextPid();
        const subscriptions = filters.map((f) => ({ filter: f, qos: subscribe_qos || 0 }));
        send(buildSubscribe(subscriptions, pid));

        // Await SUBACK
        const suback = await waitForType("SUBACK");
        const grantedQos = suback.returnCodes;
        const allGranted = grantedQos.every((c) => c !== 0x80);

        // Collect messages for subscribe_timeout seconds
        const messages = [];
        const deadline = Date.now() + (subscribe_timeout || 5) * 1000;
        const maxMsgs = Math.min(max_messages, MAX_MESSAGES);

        while (messages.length < maxMsgs && Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const pkt = await Promise.race([
            nextPacket(),
            new Promise((res) => setTimeout(() => res(null), remaining)),
          ]);
          if (!pkt) break; // timeout
          if (pkt.type === "PUBLISH") {
            messages.push({
              topic:   pkt.topic,
              payload: pkt.payloadStr,
              qos:     pkt.qos,
              retain:  pkt.retain,
            });
            // Auto-acknowledge QoS 1 publish from broker
            if (pkt.qos === 1 && pkt.packetId) {
              const puackBuf = Buffer.alloc(4);
              puackBuf[0] = PT.PUBACK << 4;
              puackBuf[1] = 2;
              puackBuf.writeUInt16BE(pkt.packetId, 2);
              send(puackBuf);
            }
          }
        }

        result = {
          subscribed:  true,
          filters,
          grantedQos,
          allGranted,
          messageCount: messages.length,
          messages,
        };
        break;
      }

      // ── pubsub (publish then subscribe to verify delivery) ─────────────────
      case "pubsub": {
        const guardedTopic = guardTopic(topic, "topic");
        const payBuf = payload_encoding === "base64"
          ? Buffer.from(payload || "", "base64")
          : Buffer.from(payload || "", "utf8");
        const payStr = payBuf.toString("utf8");

        // First SUBSCRIBE to the topic (before publishing to avoid race)
        const subPid = nextPid();
        send(buildSubscribe([{ filter: guardedTopic, qos: qos || 0 }], subPid));
        const suback = await waitForType("SUBACK");
        const subscribed = suback.returnCodes[0] !== 0x80;

        // Now PUBLISH
        const pubPid = nextPid();
        let acknowledged = false;
        if (qos === 1) {
          send(buildPublish(guardedTopic, payBuf, 1, !!retain, pubPid));
        } else {
          send(buildPublish(guardedTopic, payBuf, 0, !!retain, 0));
        }

        // For QoS 1, we will get a PUBACK; we also wait for the echoed PUBLISH
        const maxWaitMs = (subscribe_timeout || 5) * 1000;
        const deadline = Date.now() + maxWaitMs;
        let received = null;

        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const pkt = await Promise.race([
            nextPacket(),
            new Promise((res) => setTimeout(() => res(null), remaining)),
          ]);
          if (!pkt) break;
          if (pkt.type === "PUBACK" && pkt.packetId === pubPid) {
            acknowledged = true;
          } else if (pkt.type === "PUBLISH" && pkt.topic === guardedTopic) {
            const matchPayload = !wait_for_own || pkt.payloadStr === payStr;
            if (matchPayload || !wait_for_own) {
              received = {
                topic:   pkt.topic,
                payload: pkt.payloadStr,
                qos:     pkt.qos,
                retain:  pkt.retain,
              };
              if (pkt.qos === 1 && pkt.packetId) {
                const puackBuf = Buffer.alloc(4);
                puackBuf[0] = PT.PUBACK << 4;
                puackBuf[1] = 2;
                puackBuf.writeUInt16BE(pkt.packetId, 2);
                send(puackBuf);
              }
              break;
            }
          }
          if (received && (qos === 0 || acknowledged)) break;
        }

        result = {
          published:    true,
          topic:        guardedTopic,
          qos:          qos || 0,
          subscribed,
          acknowledged: qos === 1 ? acknowledged : null,
          received:     received !== null,
          message:      received,
          payloadBytes: payBuf.length,
        };
        break;
      }

      default:
        throw new ToolError(`mqtt_client: unhandled operation '${operation}'.`, -32603);
    }

    // Graceful DISCONNECT
    try { send(buildDisconnect()); } catch (_) { /* ignore */ }

    return {
      host,
      port:       resolvedPort,
      operation,
      clientId,
      elapsedMs:  Date.now() - startTime,
      ...result,
    };
  }

  try {
    const runPromise = run();
    runPromise.catch(() => {});
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(globalTimer);
    if (socket && !socket.destroyed) {
      try { socket.write(buildDisconnect()); } catch (_) { /* ignore */ }
      socket.destroy();
    }
  }
}

module.exports = { mqttClient };
