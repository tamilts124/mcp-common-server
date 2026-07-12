"use strict";
// ── Section 193: mqtt_client tests ───────────────────────────────────────────
// Tests the zero-dep MQTT v3.1.1 client (lib/mqttClientOps.js).
// All network I/O is mocked via net.createConnection monkey-patching.
// No real TCP server or live broker required; tests finish in milliseconds.

const net            = require("net");
const { EventEmitter } = require("events");
const { mqttClient } = require("../../lib/mqttClientOps");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  \u2713 ${name}\n`);
    passed++;
  } catch (e) {
    process.stdout.write(`  \u2717 ${name}\n    ${e.message}\n`);
    failed++;
  }
}

function section(name) {
  process.stdout.write(`\n${name}\n`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

// ── MQTT v3.1.1 packet constants & builders (test-side) ──────────────────────
const PT = {
  CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4,
  SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14,
};

function buildConnack(code, sessionPresent) {
  return Buffer.from([PT.CONNACK << 4, 2, sessionPresent ? 1 : 0, code || 0]);
}
function buildPingresp() {
  return Buffer.from([PT.PINGRESP << 4, 0]);
}
function buildSuback(pid, returnCodes) {
  const p = Buffer.alloc(2); p.writeUInt16BE(pid, 0);
  return Buffer.concat([
    Buffer.from([(PT.SUBACK << 4), 2 + returnCodes.length]),
    p, Buffer.from(returnCodes),
  ]);
}
function buildPuback(pid) {
  const p = Buffer.alloc(2); p.writeUInt16BE(pid, 0);
  return Buffer.concat([Buffer.from([PT.PUBACK << 4, 2]), p]);
}
function buildPublishPkt(topic, payload, qos, pid) {
  qos = qos || 0; pid = pid || 0;
  const tb = Buffer.from(topic, "utf8");
  const tl = Buffer.alloc(2); tl.writeUInt16BE(tb.length, 0);
  let vh = Buffer.concat([tl, tb]);
  if (qos > 0) { const pb = Buffer.alloc(2); pb.writeUInt16BE(pid, 0); vh = Buffer.concat([vh, pb]); }
  const payBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const body = Buffer.concat([vh, payBuf]);
  return Buffer.concat([Buffer.from([(PT.PUBLISH << 4) | (qos << 1), body.length]), body]);
}

// ── Mock socket factory ───────────────────────────────────────────────────────
// Creates a fake duplex socket that mimics net.Socket.
// `handler` is called with (writtenData) => responseBuffer[] whenever the
// client writes bytes.  Responses are emitted as 'data' events on nextTick.
function makeMockSocket(handler) {
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.destroy = (err) => {
    if (sock.destroyed) return;
    sock.destroyed = true;
    setImmediate(() => {
      if (err) sock.emit("error", err);
      sock.emit("close");
    });
  };
  sock.end = () => { if (!sock.destroyed) { sock.destroyed = true; setImmediate(() => sock.emit("close")); } };
  sock.write = (data) => {
    if (sock.destroyed) return false;
    const responses = handler(data);
    if (responses && responses.length) {
      setImmediate(() => {
        for (const r of responses) {
          if (!sock.destroyed) sock.emit("data", r);
        }
      });
    }
    return true;
  };
  // Simulate connect on next tick
  setImmediate(() => { if (!sock.destroyed) sock.emit("connect"); });
  return sock;
}

// Installs a mock and restores after fn() resolves/rejects
async function withMock(socketFactory, fn) {
  const orig = net.createConnection;
  net.createConnection = socketFactory;
  try {
    return await fn();
  } finally {
    net.createConnection = orig;
  }
}

// ── Stateful broker mock ──────────────────────────────────────────────────────
// Tracks CONNECT → CONNACK, then dispatches based on first byte type.
// `dispatch` is called for each complete packet after CONNECT.
function makeBrokerFactory(connackCode, dispatch) {
  // Each connection gets its own per-connection state so concurrent tests
  // don't share connackDone across multiple sockets.
  return () => {
    let connackDone = false;
    const state = {}; // per-connection mutable state
    return makeMockSocket((data) => {
      const type = (data[0] >> 4) & 0x0f;
      if (!connackDone && type === PT.CONNECT) {
        connackDone = true;
        const replies = [buildConnack(connackCode || 0, false)];
        const extra = dispatch ? dispatch(type, data, state) : null;
        if (extra) replies.push(...(Array.isArray(extra) ? extra : [extra]));
        return replies;
      }
      if (dispatch) {
        const r = dispatch(type, data, state);
        if (r) return Array.isArray(r) ? r : [r];
      }
      return [];
    });
  };
}

// ============================================================================
(async () => {

// ============================================================================
// A — Input validation (all throw before connecting)
// ============================================================================
section("A — Input validation");

await test("A01 missing host throws", async () => {
  await assert(await mqttClient({ operation: "connect" }).catch(e => e.message.includes("host") && "ok") === "ok");
});
await test("A02 invalid operation throws", async () => {
  await assert(await mqttClient({ host: "h", operation: "bad_op" }).catch(e => e.message.includes("operation") && "ok") === "ok");
});
await test("A03 empty topic rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "publish", topic: "" }).catch(e => e.message.includes("empty") && "ok") === "ok");
});
await test("A04 qos=2 rejected for publish", async () => {
  await assert(await mqttClient({ host: "h", operation: "publish", topic: "t", qos: 2 }).catch(e => e.message.includes("qos") && "ok") === "ok");
});
await test("A05 missing topic_filters throws", async () => {
  await assert(await mqttClient({ host: "h", operation: "subscribe" }).catch(e => e.message.includes("topic_filters") && "ok") === "ok");
});
await test("A06 max_messages=0 throws", async () => {
  await assert(await mqttClient({ host: "h", operation: "subscribe", topic_filters: "t", max_messages: 0 }).catch(e => e.message.includes("max_messages") && "ok") === "ok");
});
await test("A07 max_messages>500 throws", async () => {
  await assert(await mqttClient({ host: "h", operation: "subscribe", topic_filters: "t", max_messages: 501 }).catch(e => e.message.includes("max_messages") && "ok") === "ok");
});
await test("A08 qos=3 rejected for pubsub", async () => {
  await assert(await mqttClient({ host: "h", operation: "pubsub", topic: "t", qos: 3 }).catch(e => e.message.includes("qos") && "ok") === "ok");
});
await test("A09 payload >1 MB rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "publish", topic: "t", payload: "x".repeat(1_048_577) }).catch(e => e.message.includes("payload exceeds") && "ok") === "ok");
});
await test("A10 NUL byte in topic rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "publish", topic: "t\x00bad" }).catch(e => e.message.includes("NUL") && "ok") === "ok");
});

// ============================================================================
// B — Packet codec unit tests
// ============================================================================
section("B — Packet codec stubs");

await test("B01 CONNACK stub is 4 bytes", async () => {
  const p = buildConnack(0, false); assert(p.length === 4);
});
await test("B02 CONNACK first-byte type correct", async () => {
  const p = buildConnack(0, false); assert((p[0] >> 4) === PT.CONNACK);
});
await test("B03 CONNACK return code 0", async () => {
  const p = buildConnack(0, false); assert(p[3] === 0);
});
await test("B04 PINGRESP is 2 bytes", async () => {
  const p = buildPingresp(); assert(p.length === 2);
});
await test("B05 PINGRESP type byte correct", async () => {
  const p = buildPingresp(); assert((p[0] >> 4) === PT.PINGRESP);
});
await test("B06 SUBACK type byte correct", async () => {
  const p = buildSuback(42, [0]); assert((p[0] >> 4) === PT.SUBACK);
});
await test("B07 SUBACK packet-id round-trips", async () => {
  const p = buildSuback(42, [0]); assert(((p[2] << 8) | p[3]) === 42);
});
await test("B08 PUBACK type byte correct", async () => {
  const p = buildPuback(100); assert((p[0] >> 4) === PT.PUBACK);
});
await test("B09 PUBACK packet-id round-trips", async () => {
  const p = buildPuback(100); assert(((p[2] << 8) | p[3]) === 100);
});
await test("B10 PUBLISH type byte correct", async () => {
  const p = buildPublishPkt("t", "data"); assert((p[0] >> 4) === PT.PUBLISH);
});

// ============================================================================
// C — Security injection guards (all throw before connecting)
// ============================================================================
section("C — Security injection guards");

const NUL = "\x00";
await test("C01 NUL in publish topic rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "publish", topic: `t${NUL}inject` }).catch(e => e.message.includes("NUL") && "ok") === "ok");
});
await test("C02 NUL in subscribe filter rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "subscribe", topic_filters: `t${NUL}x` }).catch(e => e.message.includes("NUL") && "ok") === "ok");
});
await test("C03 NUL in username rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "connect", username: `user${NUL}x` }).catch(e => e.message.includes("NUL") && "ok") === "ok");
});
await test("C04 NUL in password rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "connect", password: `pass${NUL}x` }).catch(e => e.message.includes("NUL") && "ok") === "ok");
});
await test("C05 NUL in will_topic rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "publish", topic: "t", will_topic: `will${NUL}bad` }).catch(e => e.message.includes("NUL") && "ok") === "ok");
});
await test("C06 topic > 65535 bytes rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "publish", topic: "a".repeat(65_536) }).catch(e => e.message.includes("exceeds") && "ok") === "ok");
});
await test("C07 base64 payload > 1 MB rejected", async () => {
  const overB64 = Buffer.alloc(1_048_577, 0x61).toString("base64");
  await assert(await mqttClient({ host: "h", operation: "publish", topic: "t", payload: overB64, payload_encoding: "base64" }).catch(e => e.message.includes("payload exceeds") && "ok") === "ok");
});
await test("C08 NUL in one of multiple filters rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "subscribe", topic_filters: ["ok", `bad${NUL}`] }).catch(e => e.message.includes("NUL") && "ok") === "ok");
});
await test("C09 '+' wildcard in publish topic rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "publish", topic: "a/+/b" }).catch(e => e.message && "ok") === "ok");
});
await test("C10 '#' wildcard in pubsub topic rejected", async () => {
  await assert(await mqttClient({ host: "h", operation: "pubsub", topic: "test/#" }).catch(e => e.message && "ok") === "ok");
});

// ============================================================================
// D — Happy-path mock broker tests
// ============================================================================
section("D — Happy-path mock broker");

// D01-D05: connect operation
await test("D01 connect returns connected:true", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "127.0.0.1", port: 1883, operation: "connect", timeout: 5 }));
  assert(r.connected === true);
});
await test("D02 operation field correct", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "127.0.0.1", port: 1883, operation: "connect", timeout: 5 }));
  assert(r.operation === "connect");
});
await test("D03 clientId auto-generated", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "127.0.0.1", port: 1883, operation: "connect", timeout: 5 }));
  assert(typeof r.clientId === "string" && r.clientId.length > 0);
});
await test("D04 elapsedMs is a number", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "127.0.0.1", port: 1883, operation: "connect", timeout: 5 }));
  assert(typeof r.elapsedMs === "number");
});
await test("D05 port echoed in result", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "127.0.0.1", port: 1883, operation: "connect", timeout: 5 }));
  assert(r.port === 1883);
});

// D06-D07: ping operation
await test("D06 ping returns pong:true", async () => {
  const r = await withMock(makeBrokerFactory(0, (type) => {
    if (type === PT.PINGREQ) return buildPingresp();
  }), () => mqttClient({ host: "127.0.0.1", port: 1883, operation: "ping", timeout: 5 }));
  assert(r.pong === true);
});
await test("D07 latencyMs non-negative", async () => {
  const r = await withMock(makeBrokerFactory(0, (type) => {
    if (type === PT.PINGREQ) return buildPingresp();
  }), () => mqttClient({ host: "127.0.0.1", port: 1883, operation: "ping", timeout: 5 }));
  assert(typeof r.latencyMs === "number" && r.latencyMs >= 0);
});

// D08-D11: publish QoS 0
await test("D08 publish qos0 succeeds", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "h", port: 1883, operation: "publish", topic: "test/topic", payload: "hello world", qos: 0, timeout: 5 }));
  assert(r.published === true);
});
await test("D09 result.qos=0", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "h", port: 1883, operation: "publish", topic: "test/topic", payload: "hello world", qos: 0, timeout: 5 }));
  assert(r.qos === 0);
});
await test("D10 topic echoed", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "h", port: 1883, operation: "publish", topic: "test/topic", payload: "hello world", qos: 0, timeout: 5 }));
  assert(r.topic === "test/topic");
});
await test("D11 payloadBytes correct", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "h", port: 1883, operation: "publish", topic: "test/topic", payload: "hello world", qos: 0, timeout: 5 }));
  assert(r.payloadBytes === 11);
});

// D12-D15: publish QoS 1 with PUBACK
// The mock must parse the pid from the PUBLISH packet to send matching PUBACK
await test("D12 qos1 publish succeeds", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt) => {
    if (type === PT.PUBLISH) {
      const qos = (pkt[0] >> 1) & 0x03;
      if (qos === 1) {
        const tl = (pkt[2] << 8) | pkt[3];
        const pid = (pkt[4 + tl] << 8) | pkt[4 + tl + 1];
        return buildPuback(pid);
      }
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "publish", topic: "t", payload: "ack me", qos: 1, timeout: 5 }));
  assert(r.published === true);
});
await test("D13 acknowledged:true", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt) => {
    if (type === PT.PUBLISH) {
      const qos = (pkt[0] >> 1) & 0x03;
      if (qos === 1) { const tl = (pkt[2] << 8) | pkt[3]; const pid = (pkt[4+tl] << 8) | pkt[4+tl+1]; return buildPuback(pid); }
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "publish", topic: "t", payload: "ack", qos: 1, timeout: 5 }));
  assert(r.acknowledged === true);
});
await test("D14 result.qos=1", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt) => {
    if (type === PT.PUBLISH) {
      const qos = (pkt[0] >> 1) & 0x03;
      if (qos === 1) { const tl = (pkt[2] << 8) | pkt[3]; const pid = (pkt[4+tl] << 8) | pkt[4+tl+1]; return buildPuback(pid); }
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "publish", topic: "t", payload: "x", qos: 1, timeout: 5 }));
  assert(r.qos === 1);
});
await test("D15 packetId set", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt) => {
    if (type === PT.PUBLISH) {
      const qos = (pkt[0] >> 1) & 0x03;
      if (qos === 1) { const tl = (pkt[2] << 8) | pkt[3]; const pid = (pkt[4+tl] << 8) | pkt[4+tl+1]; return buildPuback(pid); }
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "publish", topic: "t", payload: "x", qos: 1, timeout: 5 }));
  assert(typeof r.packetId === "number" && r.packetId > 0);
});

// D16-D20: subscribe and collect messages
// Mock sends SUBACK then floods 3 PUBLISH packets immediately
await test("D16 subscribe returns subscribed:true", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.subackSent) {
      state.subackSent = true;
      const pid = (pkt[2] << 8) | pkt[3];
      return [
        buildSuback(pid, [0]),
        buildPublishPkt("data/feed", "msg0"),
        buildPublishPkt("data/feed", "msg1"),
        buildPublishPkt("data/feed", "msg2"),
      ];
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: "data/feed", max_messages: 3, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.subscribed === true);
});
await test("D17 messages is an array", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.done) {
      state.done = true;
      const pid = (pkt[2] << 8) | pkt[3];
      return [buildSuback(pid, [0]), buildPublishPkt("f", "v1"), buildPublishPkt("f", "v2")];
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: "f", max_messages: 2, subscribe_timeout: 0.05, timeout: 5 }));
  assert(Array.isArray(r.messages));
});
await test("D18 at least 3 messages received", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.done) {
      state.done = true;
      const pid = (pkt[2] << 8) | pkt[3];
      return [
        buildSuback(pid, [0]),
        buildPublishPkt("data/feed", "msg0"),
        buildPublishPkt("data/feed", "msg1"),
        buildPublishPkt("data/feed", "msg2"),
      ];
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: "data/feed", max_messages: 10, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.messageCount >= 3, `expected >=3 got ${r.messageCount}`);
});
await test("D19 message topic correct", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.done) {
      state.done = true;
      const pid = (pkt[2] << 8) | pkt[3];
      return [buildSuback(pid, [0]), buildPublishPkt("data/feed", "msg0")];
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: "data/feed", max_messages: 1, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.messages[0] && r.messages[0].topic === "data/feed");
});
await test("D20 message payload correct", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.done) {
      state.done = true;
      const pid = (pkt[2] << 8) | pkt[3];
      return [buildSuback(pid, [0]), buildPublishPkt("data/feed", "msg0")];
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: "data/feed", max_messages: 1, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.messages[0] && r.messages[0].payload === "msg0");
});

// D21-D24: pubsub round-trip
await test("D21 pubsub published:true", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.subDone) { state.subDone = true; const pid=(pkt[2]<<8)|pkt[3]; return buildSuback(pid,[0]); }
    if (type === PT.PUBLISH) return buildPublishPkt("roundtrip", "pingpong");
  }), () => mqttClient({ host: "h", port: 1883, operation: "pubsub",
    topic: "roundtrip", payload: "pingpong", qos: 0, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.published === true);
});
await test("D22 pubsub received:true", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.subDone) { state.subDone = true; const pid=(pkt[2]<<8)|pkt[3]; return buildSuback(pid,[0]); }
    if (type === PT.PUBLISH) return buildPublishPkt("roundtrip", "pingpong");
  }), () => mqttClient({ host: "h", port: 1883, operation: "pubsub",
    topic: "roundtrip", payload: "pingpong", qos: 0, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.received === true);
});
await test("D23 pubsub message not null", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.subDone) { state.subDone = true; const pid=(pkt[2]<<8)|pkt[3]; return buildSuback(pid,[0]); }
    if (type === PT.PUBLISH) return buildPublishPkt("rt", "pp");
  }), () => mqttClient({ host: "h", port: 1883, operation: "pubsub",
    topic: "rt", payload: "pp", qos: 0, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.message !== null);
});
await test("D24 pubsub payload matches", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.subDone) { state.subDone = true; const pid=(pkt[2]<<8)|pkt[3]; return buildSuback(pid,[0]); }
    if (type === PT.PUBLISH) return buildPublishPkt("rt", "pingpong");
  }), () => mqttClient({ host: "h", port: 1883, operation: "pubsub",
    topic: "rt", payload: "pingpong", qos: 0, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.message && r.message.payload === "pingpong");
});

// D25-D27: subscribe with array of topic filters
await test("D25 array topic_filters succeeds", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE) { const pid=(pkt[2]<<8)|pkt[3]; return buildSuback(pid,[0,0]); }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: ["a/+", "b/#"], subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.subscribed === true);
});
await test("D26 two filters in result", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE) { const pid=(pkt[2]<<8)|pkt[3]; return buildSuback(pid,[0,0]); }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: ["a/+", "b/#"], subscribe_timeout: 0.05, timeout: 5 }));
  assert(Array.isArray(r.filters) && r.filters.length === 2);
});
await test("D27 grantedQos has two entries", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE) { const pid=(pkt[2]<<8)|pkt[3]; return buildSuback(pid,[0,0]); }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: ["a/+", "b/#"], subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.grantedQos && r.grantedQos.length === 2);
});

// D28-D29: base64 payload encoding
await test("D28 base64 payload publish succeeds", async () => {
  const b64 = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString("base64");
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "h", port: 1883, operation: "publish",
      topic: "binary", payload: b64, payload_encoding: "base64", timeout: 5 }));
  assert(r.published === true);
});
await test("D29 base64 decodes to 4 bytes", async () => {
  const b64 = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString("base64");
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "h", port: 1883, operation: "publish",
      topic: "binary", payload: b64, payload_encoding: "base64", timeout: 5 }));
  assert(r.payloadBytes === 4, `expected 4 got ${r.payloadBytes}`);
});

// D30: retain flag
await test("D30 retain flag echoed in result", async () => {
  const r = await withMock(makeBrokerFactory(0, null), () =>
    mqttClient({ host: "h", port: 1883, operation: "publish",
      topic: "cfg", payload: "v", retain: true, timeout: 5 }));
  assert(r.retain === true);
});

// ============================================================================
// E — Error paths
// ============================================================================
section("E — Error paths");

// E01: connection refused — mock immediately emits ECONNREFUSED-style error
await test("E01 connection refused throws", async () => {
  const refusedFactory = () => {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = (err) => {
      if (sock.destroyed) return;
      sock.destroyed = true;
      setImmediate(() => { if (err) sock.emit("error", err); sock.emit("close"); });
    };
    sock.end = sock.destroy;
    sock.write = () => false;
    // Emit ECONNREFUSED on next tick (before connect)
    setImmediate(() => {
      const e = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19999"), { code: "ECONNREFUSED" });
      sock.emit("error", e);
    });
    return sock;
  };
  const err = await withMock(refusedFactory, () =>
    mqttClient({ host: "127.0.0.1", port: 19999, operation: "connect", timeout: 5 })
  ).catch(e => e);
  assert(err instanceof Error);
});

// E02: CONNACK error code (broker refuses)
await test("E02 CONNACK error code rejects", async () => {
  const err = await withMock(makeBrokerFactory(4, null), () =>
    mqttClient({ host: "h", port: 1883, operation: "connect", timeout: 5 })
  ).catch(e => e);
  assert(err instanceof Error && err.message.includes("refused"), `got: ${err.message}`);
});

// E03: timeout when CONNACK never arrives — mock ignores all data
await test("E03 timeout waiting for CONNACK", async () => {
  const silentFactory = () => {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; setImmediate(() => sock.emit("close")); };
    sock.end = sock.destroy;
    sock.write = () => true; // never respond
    setImmediate(() => sock.emit("connect"));
    return sock;
  };
  const err = await withMock(silentFactory, () =>
    mqttClient({ host: "h", port: 1883, operation: "connect", timeout: 0.1 })
  ).catch(e => e);
  assert(err instanceof Error && err.message.includes("timed out"), `got: ${err.message}`);
});

// E04: ping timeout (CONNACK OK, PINGRESP never)
await test("E04 ping timeout", async () => {
  // Mock: reply to CONNECT with CONNACK, but ignore PINGREQ
  const factory = makeBrokerFactory(0, (type) => {
    if (type === PT.PINGREQ) return []; // no response
  });
  const err = await withMock(factory, () =>
    mqttClient({ host: "h", port: 1883, operation: "ping", timeout: 0.1 })
  ).catch(e => e);
  assert(err instanceof Error && err.message.includes("timed out"), `got: ${err.message}`);
});

// E05: broker closes immediately after CONNACK — connect still succeeds
await test("E05 connect succeeds even if broker closes after CONNACK", async () => {
  let sockRef;
  const factory = () => {
    const sock = makeMockSocket((data) => {
      const type = (data[0] >> 4) & 0x0f;
      if (type === PT.CONNECT) {
        // Schedule CONNACK then close
        setImmediate(() => {
          if (!sock.destroyed) {
            sock.emit("data", buildConnack(0, false));
            setImmediate(() => sock.emit("close"));
          }
        });
      }
      return [];
    });
    sockRef = sock;
    return sock;
  };
  const r = await withMock(factory, () =>
    mqttClient({ host: "h", port: 1883, operation: "connect", timeout: 5 }));
  assert(r.connected === true);
});

// ============================================================================
// F — Concurrency / stress
// ============================================================================
section("F — Concurrency");

// F01-F02: 10 concurrent connects
await test("F01 10 concurrent connects succeed", async () => {
  const results = await withMock(makeBrokerFactory(0, null), () =>
    Promise.all(Array.from({ length: 10 }, () =>
      mqttClient({ host: "h", port: 1883, operation: "connect", timeout: 5 })
    ))
  );
  assert(results.every(r => r.connected === true), "not all connected");
});
await test("F02 all results have elapsedMs", async () => {
  const results = await withMock(makeBrokerFactory(0, null), () =>
    Promise.all(Array.from({ length: 10 }, () =>
      mqttClient({ host: "h", port: 1883, operation: "connect", timeout: 5 })
    ))
  );
  assert(results.every(r => typeof r.elapsedMs === "number"), "missing elapsedMs");
});

// F03: 5 concurrent publishes
await test("F03 5 concurrent publishes succeed", async () => {
  const results = await withMock(makeBrokerFactory(0, null), () =>
    Promise.all(Array.from({ length: 5 }, (_, i) =>
      mqttClient({ host: "h", port: 1883, operation: "publish",
        topic: `stress/t${i}`, payload: `p${i}`, timeout: 5 })
    ))
  );
  assert(results.every(r => r.published === true), "not all published");
});

// F04: 5 sequential QoS 1 publishes, all acknowledged
await test("F04 5 sequential QoS1 publishes all acknowledged", async () => {
  const results = [];
  await withMock(makeBrokerFactory(0, (type, pkt) => {
    if (type === PT.PUBLISH) {
      const qos = (pkt[0] >> 1) & 0x03;
      if (qos === 1) { const tl=(pkt[2]<<8)|pkt[3]; const pid=(pkt[4+tl]<<8)|pkt[4+tl+1]; return buildPuback(pid); }
    }
  }), async () => {
    for (let i = 0; i < 5; i++) {
      results.push(await mqttClient({ host: "h", port: 1883, operation: "publish",
        topic: `seq/${i}`, payload: `v${i}`, qos: 1, timeout: 5 }));
    }
  });
  assert(results.every(r => r.acknowledged === true), "not all acknowledged");
});

// F05: max_messages cap enforced when broker floods messages
await test("F05 max_messages cap enforced", async () => {
  const r = await withMock(makeBrokerFactory(0, (type, pkt, state) => {
    if (type === PT.SUBSCRIBE && !state.done) {
      state.done = true;
      const pid = (pkt[2] << 8) | pkt[3];
      const pkts = [buildSuback(pid, [0])];
      for (let i = 0; i < 20; i++) pkts.push(buildPublishPkt("flood", `item${i}`));
      return pkts;
    }
  }), () => mqttClient({ host: "h", port: 1883, operation: "subscribe",
    topic_filters: "flood", max_messages: 5, subscribe_timeout: 0.05, timeout: 5 }));
  assert(r.messageCount <= 5, `expected <=5 got ${r.messageCount}`);
});

// ============================================================================
// Summary
// ============================================================================
process.stdout.write(`\n${'='.repeat(50)}\n`);
process.stdout.write(`mqtt_client: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
else process.exit(0);

})();
