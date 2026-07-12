"use strict";
// ── Section 194: amqp_client tests ─────────────────────────────────────────────────
// Tests the zero-dep AMQP 0-9-1 client (lib/amqpClientOps.js).
// All network I/O is mocked via net.createConnection monkey-patching.
// No real TCP server or live broker required; tests finish in milliseconds.

const net              = require("net");
const { EventEmitter } = require("events");
const { amqpClient }   = require("../../lib/amqpClientOps");

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

// ============================================================================
// AMQP 0-9-1 frame builders (test-side, minimal implementation)
// ============================================================================

const FRAME_METHOD    = 1;
const FRAME_HEADER    = 2;
const FRAME_BODY      = 3;
const FRAME_END       = 0xce;

function encodeShortStr(str) {
  const b = Buffer.from(str || "", "utf8");
  const out = Buffer.alloc(1 + b.length);
  out[0] = b.length;
  b.copy(out, 1);
  return out;
}

function encodeLongStr(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data || "", "utf8");
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32BE(b.length, 0);
  b.copy(out, 4);
  return out;
}

function encodeTable(obj) {
  if (!obj || !Object.keys(obj).length) return Buffer.from([0, 0, 0, 0]);
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = encodeShortStr(k);
    const vb  = Buffer.from(String(v), "utf8");
    const val = Buffer.alloc(5 + vb.length);
    val[0] = 0x53; // 'S' longstr
    val.writeUInt32BE(vb.length, 1);
    vb.copy(val, 5);
    parts.push(key, val);
  }
  const body = Buffer.concat(parts);
  const out  = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function buildFrame(type, channel, payload) {
  const frame = Buffer.alloc(7 + payload.length + 1);
  frame[0] = type;
  frame.writeUInt16BE(channel, 1);
  frame.writeUInt32BE(payload.length, 3);
  payload.copy(frame, 7);
  frame[7 + payload.length] = FRAME_END;
  return frame;
}

function buildMethodFrame(channel, classId, methodId, payload) {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16BE(classId, 0);
  hdr.writeUInt16BE(methodId, 2);
  return buildFrame(FRAME_METHOD, channel,
    payload ? Buffer.concat([hdr, payload]) : hdr);
}

// Connection.Start (10.10)
function buildConnectionStart() {
  const serverProps = encodeTable({ product: "MockBroker", version: "1.0" });
  const mechanisms  = encodeLongStr("PLAIN AMQPLAIN");
  const locales     = encodeLongStr("en_US");
  // version-major, version-minor = 0, 9
  const payload = Buffer.concat([
    Buffer.from([0x00, 0x09]),
    serverProps,
    mechanisms,
    locales,
  ]);
  return buildMethodFrame(0, 10, 10, payload);
}

// Connection.Tune (10.30)
function buildConnectionTune(channelMax, frameMax, heartbeat) {
  const p = Buffer.alloc(8);
  p.writeUInt16BE(channelMax  || 2047, 0);
  p.writeUInt32BE(frameMax    || 131072, 2);
  p.writeUInt16BE(heartbeat   || 0, 6);
  return buildMethodFrame(0, 10, 30, p);
}

// Connection.OpenOk (10.41)
function buildConnectionOpenOk() {
  return buildMethodFrame(0, 10, 41, encodeShortStr(""));
}

// Connection.CloseOk (10.51)
function buildConnectionCloseOk() {
  return buildMethodFrame(0, 10, 51, Buffer.alloc(0));
}

// Channel.OpenOk (20.11)
function buildChannelOpenOk() {
  return buildMethodFrame(1, 20, 11, encodeLongStr(""));
}

// Channel.CloseOk (20.41)
function buildChannelCloseOk() {
  return buildMethodFrame(1, 20, 41, Buffer.alloc(0));
}

// Queue.DeclareOk (50.11)
function buildQueueDeclareOk(queue, msgCount, consumerCount) {
  const p = Buffer.alloc(8);
  p.writeUInt32BE(msgCount      || 0, 0);
  p.writeUInt32BE(consumerCount || 0, 4);
  return buildMethodFrame(1, 50, 11,
    Buffer.concat([encodeShortStr(queue || "test-q"), p]));
}

// Queue.DeleteOk (50.41)
function buildQueueDeleteOk(msgCount) {
  const p = Buffer.alloc(4); p.writeUInt32BE(msgCount || 0, 0);
  return buildMethodFrame(1, 50, 41, p);
}

// Queue.PurgeOk (50.31)
function buildQueuePurgeOk(msgCount) {
  const p = Buffer.alloc(4); p.writeUInt32BE(msgCount || 0, 0);
  return buildMethodFrame(1, 50, 31, p);
}

// Basic.QosOk (60.11)
function buildBasicQosOk() {
  return buildMethodFrame(1, 60, 11, Buffer.alloc(0));
}

// Basic.ConsumeOk (60.21)
function buildBasicConsumeOk(consumerTag) {
  return buildMethodFrame(1, 60, 21, encodeShortStr(consumerTag || "mock-tag"));
}

// Basic.CancelOk (60.31)
function buildBasicCancelOk(consumerTag) {
  return buildMethodFrame(1, 60, 31, encodeShortStr(consumerTag || "mock-tag"));
}

// Basic.GetOk (60.71)
function buildBasicGetOk(deliveryTag, exchange, routingKey, msgCount) {
  const p = Buffer.alloc(8);
  p.writeBigUInt64BE(BigInt(deliveryTag || 1), 0);
  const flags = Buffer.from([0x00]); // redelivered=false
  const mc = Buffer.alloc(4); mc.writeUInt32BE(msgCount || 0, 0);
  return buildMethodFrame(1, 60, 71, Buffer.concat([
    p,
    flags,
    encodeShortStr(exchange || ""),
    encodeShortStr(routingKey || "test.key"),
    mc,
  ]));
}

// Basic.GetEmpty (60.72)
function buildBasicGetEmpty() {
  return buildMethodFrame(1, 60, 72, encodeShortStr(""));
}

// Basic.Deliver (60.60)
function buildBasicDeliver(consumerTag, deliveryTag, exchange, routingKey) {
  const dtBuf = Buffer.alloc(8);
  dtBuf.writeBigUInt64BE(BigInt(deliveryTag || 1), 0);
  return buildMethodFrame(1, 60, 60, Buffer.concat([
    encodeShortStr(consumerTag || "mock-tag"),
    dtBuf,
    Buffer.from([0x00]), // redelivered
    encodeShortStr(exchange || ""),
    encodeShortStr(routingKey || "rk"),
  ]));
}

// Content header frame for Basic class
function buildContentHeader(channel, bodySize) {
  const hdr = Buffer.alloc(14);
  hdr.writeUInt16BE(60, 0);          // class-id: Basic
  hdr.writeUInt16BE(0, 2);           // weight
  hdr.writeBigUInt64BE(BigInt(bodySize), 4);
  hdr.writeUInt16BE(0, 12);          // no property flags
  return buildFrame(FRAME_HEADER, channel, hdr);
}

// Body frame
function buildBodyFrame(channel, payload) {
  return buildFrame(FRAME_BODY, channel,
    Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8"));
}

// ============================================================================
// Mock socket factory
// ============================================================================

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
  sock.end = () => {
    if (!sock.destroyed) { sock.destroyed = true; setImmediate(() => sock.emit("close")); }
  };
  sock.write = (data) => {
    if (sock.destroyed) return false;
    const responses = handler(data);
    if (responses && responses.length) {
      setImmediate(() => {
        for (const r of responses)
          if (!sock.destroyed) sock.emit("data", r);
      });
    }
    return true;
  };
  setImmediate(() => { if (!sock.destroyed) sock.emit("connect"); });
  return sock;
}

async function withMock(socketFactory, fn) {
  const orig = net.createConnection;
  net.createConnection = socketFactory;
  try { return await fn(); }
  finally { net.createConnection = orig; }
}

// ============================================================================
// Stateful AMQP broker mock
// The handshake sequence is:
//   client → protocol header (8 bytes: 'AMQP\0\0\x09\x01')
//   broker → Connection.Start
//   client → Connection.StartOk
//   broker → Connection.Tune
//   client → Connection.TuneOk
//   client → Connection.Open
//   broker → Connection.OpenOk
//   client → Channel.Open (ch=1)
//   broker → Channel.OpenOk (ch=1)
// Then per-operation frames are dispatched.
// ============================================================================

// Parse a raw AMQP frame from `data` (may be partial; we just parse the first complete frame).
function parseFirstFrame(data) {
  if (data.length < 7) return null;
  const type    = data[0];
  const channel = data.readUInt16BE(1);
  const size    = data.readUInt32BE(3);
  if (data.length < 7 + size + 1) return null;
  const payload  = data.slice(7, 7 + size);
  const classId  = (type === FRAME_METHOD) ? payload.readUInt16BE(0) : null;
  const methodId = (type === FRAME_METHOD) ? payload.readUInt16BE(2) : null;
  return { type, channel, classId, methodId, payload, args: (type === FRAME_METHOD) ? payload.slice(4) : payload };
}

/**
 * Make a full AMQP broker factory.
 * `dispatchOp` is called after the handshake completes for each frame written
 * by the client.  It receives (frame, state, replies[]) and should push
 * Buffer objects into `replies`.
 */
function makeAmqpBroker(dispatchOp) {
  return () => {
    let buf      = Buffer.alloc(0);
    let step     = 0; // 0=await header, 1=await StartOk, 2=await TuneOk/Open, 3=await ChannelOpen, 4=ready
    const state  = {};

    return makeMockSocket((data) => {
      buf = Buffer.concat([buf, data]);
      const replies = [];

      // Process all complete frames in the buffer
      while (true) {
        // Step 0: awaiting 8-byte AMQP protocol header
        if (step === 0) {
          if (buf.length < 8) break;
          // Consume header (AMQP\0\0\x09\x01)
          buf = buf.slice(8);
          step = 1;
          replies.push(buildConnectionStart());
          continue;
        }

        // Parse next AMQP frame
        if (buf.length < 7) break;
        const frameSize = buf.readUInt32BE(3);
        const frameTotal = 7 + frameSize + 1;
        if (buf.length < frameTotal) break;

        const frame = parseFirstFrame(buf);
        buf = buf.slice(frameTotal);
        if (!frame) break;

        if (step === 1) {
          // Await Connection.StartOk (10.11)
          if (frame.type === FRAME_METHOD && frame.classId === 10 && frame.methodId === 11) {
            step = 2;
            replies.push(buildConnectionTune());
          }
          continue;
        }

        if (step === 2) {
          // Await Connection.TuneOk (10.31) or Connection.Open (10.40)
          if (frame.type === FRAME_METHOD && frame.classId === 10 && frame.methodId === 40) {
            // Connection.Open
            replies.push(buildConnectionOpenOk());
            step = 3;
          }
          // TuneOk is swallowed (no reply needed)
          continue;
        }

        if (step === 3) {
          // Await Channel.Open (20.10)
          if (frame.type === FRAME_METHOD && frame.classId === 20 && frame.methodId === 10) {
            step = 4;
            replies.push(buildChannelOpenOk());
          }
          continue;
        }

        if (step === 4) {
          // Handshake done. Handle close frames and dispatch ops.
          if (frame.type === FRAME_METHOD) {
            // Channel.Close (20.40)
            if (frame.classId === 20 && frame.methodId === 40) {
              replies.push(buildChannelCloseOk());
              continue;
            }
            // Connection.Close (10.50)
            if (frame.classId === 10 && frame.methodId === 50) {
              replies.push(buildConnectionCloseOk());
              continue;
            }
          }
          // Delegate to per-test dispatch
          if (dispatchOp) dispatchOp(frame, state, replies);
        }
      }

      return replies;
    });
  };
}

// Convenience: broker that just handles OP dispatch with a callback.
function simpleBroker(opDispatch) {
  return makeAmqpBroker(opDispatch || null);
}

// ============================================================================
(async () => {

// ============================================================================
// A — Input validation (all throw before connecting)
// ============================================================================
section("A — Input validation");

await test("A01 missing host throws", async () => {
  const e = await amqpClient({ operation: "connect" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("host"), `got: ${e.message}`);
});
await test("A02 missing operation throws", async () => {
  const e = await amqpClient({ host: "h" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("operation"), `got: ${e.message}`);
});
await test("A03 invalid operation throws", async () => {
  const e = await amqpClient({ host: "h", operation: "invalid_op" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("operation"), `got: ${e.message}`);
});
await test("A04 get without queue throws", async () => {
  const e = await amqpClient({ host: "h", operation: "get" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("queue"), `got: ${e.message}`);
});
await test("A05 consume without queue throws", async () => {
  const e = await amqpClient({ host: "h", operation: "consume" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("queue"), `got: ${e.message}`);
});
await test("A06 declare_queue without queue throws", async () => {
  const e = await amqpClient({ host: "h", operation: "declare_queue" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("queue"), `got: ${e.message}`);
});
await test("A07 ack without delivery_tag throws", async () => {
  const e = await amqpClient({ host: "h", operation: "ack" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("delivery_tag"), `got: ${e.message}`);
});
await test("A08 nack without delivery_tag throws", async () => {
  const e = await amqpClient({ host: "h", operation: "nack" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("delivery_tag"), `got: ${e.message}`);
});
await test("A09 consume max_messages=0 throws", async () => {
  const e = await amqpClient({ host: "h", operation: "consume", queue: "q", max_messages: 0 }).catch(e => e);
  assert(e instanceof Error && e.message.includes("max_messages"), `got: ${e.message}`);
});
await test("A10 consume max_messages=501 throws", async () => {
  const e = await amqpClient({ host: "h", operation: "consume", queue: "q", max_messages: 501 }).catch(e => e);
  assert(e instanceof Error && e.message.includes("max_messages"), `got: ${e.message}`);
});

// ============================================================================
// B — Frame codec unit tests (pure test-side helpers)
// ============================================================================
section("B — Frame codec stubs");

await test("B01 buildFrame produces correct type byte", async () => {
  const f = buildMethodFrame(0, 10, 10, Buffer.alloc(4));
  assert(f[0] === FRAME_METHOD, `got ${f[0]}`);
});
await test("B02 buildFrame frame-end byte is 0xce", async () => {
  const f = buildMethodFrame(0, 10, 10, Buffer.alloc(4));
  assert(f[f.length - 1] === FRAME_END);
});
await test("B03 buildConnectionStart type=METHOD", async () => {
  const f = buildConnectionStart();
  assert(f[0] === FRAME_METHOD);
});
await test("B04 buildConnectionTune encodes channelMax", async () => {
  const f = buildConnectionTune(100, 131072, 0);
  // Payload starts at offset 7. method bytes are 4. So channelMax at offset 11.
  const payload = f.slice(7, f.length - 1);
  const chanMax = payload.readUInt16BE(4); // skip classId(2)+methodId(2)
  assert(chanMax === 100, `got ${chanMax}`);
});
await test("B05 buildQueueDeclareOk encodes queue name", async () => {
  const f = buildQueueDeclareOk("my-q", 5, 2);
  // payload starts at offset 7 (after frame header), then +4 (class+method), then shortstr
  const payload = f.slice(11, f.length - 1); // skip class+method
  const nameLen = payload[0];
  const name = payload.slice(1, 1 + nameLen).toString("utf8");
  assert(name === "my-q", `got '${name}'`);
});
await test("B06 buildBasicGetOk has correct classId", async () => {
  const f = buildBasicGetOk(1, "", "rk", 0);
  const classId = f.readUInt16BE(7);
  assert(classId === 60, `got ${classId}`);
});
await test("B07 buildBasicGetEmpty has correct methodId", async () => {
  const f = buildBasicGetEmpty();
  const methodId = f.readUInt16BE(9);
  assert(methodId === 72, `got ${methodId}`);
});
await test("B08 buildContentHeader has correct classId", async () => {
  const f = buildContentHeader(1, 12);
  assert(f[0] === FRAME_HEADER);
  const classId = f.readUInt16BE(7);
  assert(classId === 60, `got ${classId}`);
});
await test("B09 buildBodyFrame type=BODY", async () => {
  const f = buildBodyFrame(1, "test");
  assert(f[0] === FRAME_BODY);
});
await test("B10 encodeShortStr roundtrip", async () => {
  const b = encodeShortStr("hello");
  assert(b[0] === 5 && b.slice(1).toString("utf8") === "hello");
});

// ============================================================================
// C — Security injection guards (throw before connecting)
// ============================================================================
section("C — Security injection guards");

const NUL = "\x00";
await test("C01 NUL in queue name rejected", async () => {
  const e = await amqpClient({ host: "h", operation: "get", queue: `q${NUL}x` }).catch(e => e);
  assert(e instanceof Error && e.message.includes("NUL"), `got: ${e.message}`);
});
await test("C02 NUL in exchange rejected", async () => {
  const e = await amqpClient({ host: "h", operation: "publish", exchange: `ex${NUL}` }).catch(e => e);
  assert(e instanceof Error && e.message.includes("NUL"), `got: ${e.message}`);
});
await test("C03 NUL in routing_key rejected", async () => {
  const e = await amqpClient({ host: "h", operation: "publish", routing_key: `rk${NUL}bad` }).catch(e => e);
  assert(e instanceof Error && e.message.includes("NUL"), `got: ${e.message}`);
});
await test("C04 NUL in username rejected", async () => {
  const e = await amqpClient({ host: "h", operation: "connect", username: `user${NUL}` }).catch(e => e);
  assert(e instanceof Error && e.message.includes("NUL"), `got: ${e.message}`);
});
await test("C05 queue name > 255 chars rejected", async () => {
  const e = await amqpClient({ host: "h", operation: "get", queue: "q".repeat(256) }).catch(e => e);
  assert(e instanceof Error && e.message.includes("exceeds"), `got: ${e.message}`);
});
await test("C06 body > 10 MB rejected", async () => {
  const bigBody = "x".repeat(10 * 1024 * 1024 + 1);
  const e = await amqpClient({ host: "h", operation: "publish", body: bigBody }).catch(e => e);
  assert(e instanceof Error && e.message.includes("MB"), `got: ${e.message}`);
});
await test("C07 base64 body > 10 MB rejected", async () => {
  const overBuf = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
  const e = await amqpClient({ host: "h", operation: "publish", body: overBuf.toString("base64"), body_encoding: "base64" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("MB"), `got: ${e.message}`);
});
await test("C08 purge without queue rejected", async () => {
  const e = await amqpClient({ host: "h", operation: "purge" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("queue"), `got: ${e.message}`);
});
await test("C09 delete_queue without queue rejected", async () => {
  const e = await amqpClient({ host: "h", operation: "delete_queue" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("queue"), `got: ${e.message}`);
});
await test("C10 host=null rejected", async () => {
  const e = await amqpClient({ host: null, operation: "connect" }).catch(e => e);
  assert(e instanceof Error && e.message.includes("host"), `got: ${e.message}`);
});

// ============================================================================
// D — Happy-path mock broker tests
// ============================================================================
section("D — Happy-path mock broker");

// D01-D05: connect
await test("D01 connect returns connected:true", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "127.0.0.1", port: 5672, operation: "connect", timeout: 5 }));
  assert(r.connected === true, `connected=${r.connected}`);
});
await test("D02 operation echoed in result", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "127.0.0.1", port: 5672, operation: "connect", timeout: 5 }));
  assert(r.operation === "connect");
});
await test("D03 elapsedMs is a number", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "127.0.0.1", port: 5672, operation: "connect", timeout: 5 }));
  assert(typeof r.elapsedMs === "number");
});
await test("D04 vhost echoed in result", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", port: 5672, operation: "connect", vhost: "/my-vhost", timeout: 5 }));
  assert(r.vhost === "/my-vhost");
});
await test("D05 frameMax returned", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", port: 5672, operation: "connect", timeout: 5 }));
  assert(typeof r.frameMax === "number" && r.frameMax > 0);
});

// D06-D09: declare_queue
await test("D06 declare_queue returns queue name", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 10)
      replies.push(buildQueueDeclareOk("test-q", 0, 0));
  }), () => amqpClient({ host: "h", operation: "declare_queue", queue: "test-q", timeout: 5 }));
  assert(r.queue === "test-q", `got '${r.queue}'`);
});
await test("D07 declare_queue messageCount is number", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 10)
      replies.push(buildQueueDeclareOk("q", 7, 2));
  }), () => amqpClient({ host: "h", operation: "declare_queue", queue: "q", timeout: 5 }));
  assert(typeof r.messageCount === "number");
});
await test("D08 declare_queue consumerCount echoed", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 10)
      replies.push(buildQueueDeclareOk("q", 0, 3));
  }), () => amqpClient({ host: "h", operation: "declare_queue", queue: "q", timeout: 5 }));
  assert(r.consumerCount === 3);
});
await test("D09 durable flag echoed", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 10)
      replies.push(buildQueueDeclareOk("q", 0, 0));
  }), () => amqpClient({ host: "h", operation: "declare_queue", queue: "q", durable: true, timeout: 5 }));
  assert(r.durable === true);
});

// D10-D12: delete_queue
await test("D10 delete_queue returns deleted:true", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 40)
      replies.push(buildQueueDeleteOk(5));
  }), () => amqpClient({ host: "h", operation: "delete_queue", queue: "test-q", timeout: 5 }));
  assert(r.deleted === true);
});
await test("D11 delete_queue messageCount returned", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 40)
      replies.push(buildQueueDeleteOk(5));
  }), () => amqpClient({ host: "h", operation: "delete_queue", queue: "test-q", timeout: 5 }));
  assert(r.messageCount === 5);
});
await test("D12 purge returns purged:true", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 30)
      replies.push(buildQueuePurgeOk(12));
  }), () => amqpClient({ host: "h", operation: "purge", queue: "test-q", timeout: 5 }));
  assert(r.purged === true);
});

// D13-D17: publish
await test("D13 publish returns published:true", async () => {
  // Publish is fire-and-forget (no broker reply needed)
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", operation: "publish", exchange: "", routing_key: "test.rk",
      body: "hello amqp", timeout: 5 }));
  assert(r.published === true);
});
await test("D14 publish routing_key echoed", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", operation: "publish", routing_key: "my.rk", body: "hello", timeout: 5 }));
  assert(r.routing_key === "my.rk");
});
await test("D15 publish bodyBytes correct", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", operation: "publish", routing_key: "rk", body: "hello amqp", timeout: 5 }));
  assert(r.bodyBytes === 10, `got ${r.bodyBytes}`);
});
await test("D16 publish persistent flag echoed", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", operation: "publish", routing_key: "rk", body: "msg",
      persistent: true, timeout: 5 }));
  assert(r.persistent === true);
});
await test("D17 publish base64 body decoded correctly", async () => {
  const b64 = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]).toString("base64");
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", operation: "publish", routing_key: "bin",
      body: b64, body_encoding: "base64", timeout: 5 }));
  assert(r.bodyBytes === 4, `got ${r.bodyBytes}`);
});

// D18-D22: basic.get
await test("D18 get returns message when available", async () => {
  const msgBody = "got a message";
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 70) { // Basic.Get
      replies.push(buildBasicGetOk(1, "", "rk", 0));
      replies.push(buildContentHeader(1, msgBody.length));
      replies.push(buildBodyFrame(1, msgBody));
    }
  }), () => amqpClient({ host: "h", operation: "get", queue: "test-q", timeout: 5 }));
  assert(r.empty === false, "expected empty=false");
});
await test("D19 get body content correct", async () => {
  const msgBody = "the content";
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 70) {
      replies.push(buildBasicGetOk(1, "", "rk", 0));
      replies.push(buildContentHeader(1, msgBody.length));
      replies.push(buildBodyFrame(1, msgBody));
    }
  }), () => amqpClient({ host: "h", operation: "get", queue: "q", timeout: 5 }));
  assert(r.body === msgBody, `got '${r.body}'`);
});
await test("D20 get empty queue returns empty:true", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 70)
      replies.push(buildBasicGetEmpty());
  }), () => amqpClient({ host: "h", operation: "get", queue: "empty-q", timeout: 5 }));
  assert(r.empty === true);
});
await test("D21 get empty message=null", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 70)
      replies.push(buildBasicGetEmpty());
  }), () => amqpClient({ host: "h", operation: "get", queue: "q", timeout: 5 }));
  assert(r.message === null);
});
await test("D22 get deliveryTag is number", async () => {
  const msgBody = "x";
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 70) {
      replies.push(buildBasicGetOk(42, "", "rk", 0));
      replies.push(buildContentHeader(1, msgBody.length));
      replies.push(buildBodyFrame(1, msgBody));
    }
  }), () => amqpClient({ host: "h", operation: "get", queue: "q", timeout: 5 }));
  assert(typeof r.deliveryTag === "number");
});

// D23-D27: consume
await test("D23 consume returns messages array", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 20 && !state.consumeOkSent) { // Basic.Consume
      state.consumeOkSent = true;
      replies.push(buildBasicConsumeOk("mock-tag"));
      // Push 3 messages immediately
      for (let i = 0; i < 3; i++) {
        const body = `msg${i}`;
        replies.push(buildBasicDeliver("mock-tag", i + 1, "", "rk"));
        replies.push(buildContentHeader(1, body.length));
        replies.push(buildBodyFrame(1, body));
      }
    }
    if (frame.classId === 60 && frame.methodId === 30) // Basic.Cancel
      replies.push(buildBasicCancelOk("mock-tag"));
  }), () => amqpClient({ host: "h", operation: "consume", queue: "q",
    max_messages: 3, consume_timeout: 0.1, no_ack: true, timeout: 5 }));
  assert(Array.isArray(r.messages));
});
await test("D24 consume messageCount correct", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 20 && !state.done) {
      state.done = true;
      replies.push(buildBasicConsumeOk("t"));
      for (let i = 0; i < 3; i++) {
        const b = `m${i}`;
        replies.push(buildBasicDeliver("t", i + 1, "", "r"));
        replies.push(buildContentHeader(1, b.length));
        replies.push(buildBodyFrame(1, b));
      }
    }
    if (frame.classId === 60 && frame.methodId === 30)
      replies.push(buildBasicCancelOk("t"));
  }), () => amqpClient({ host: "h", operation: "consume", queue: "q",
    max_messages: 10, consume_timeout: 0.1, no_ack: true, timeout: 5 }));
  assert(r.messageCount === 3, `got ${r.messageCount}`);
});
await test("D25 consume message body correct", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 20 && !state.done) {
      state.done = true;
      const body = "hello-consumer";
      replies.push(buildBasicConsumeOk("t"));
      replies.push(buildBasicDeliver("t", 1, "", "rk"));
      replies.push(buildContentHeader(1, body.length));
      replies.push(buildBodyFrame(1, body));
    }
    if (frame.classId === 60 && frame.methodId === 30)
      replies.push(buildBasicCancelOk("t"));
  }), () => amqpClient({ host: "h", operation: "consume", queue: "q",
    max_messages: 1, consume_timeout: 0.1, no_ack: true, timeout: 5 }));
  assert(r.messages[0].body === "hello-consumer", `got '${r.messages[0].body}'`);
});
await test("D26 consume with QoS (prefetch_count) sends QosOk", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 10)  // Basic.Qos
      replies.push(buildBasicQosOk());
    if (frame.classId === 60 && frame.methodId === 20 && !state.done) {
      state.done = true;
      replies.push(buildBasicConsumeOk("t"));
    }
    if (frame.classId === 60 && frame.methodId === 30)
      replies.push(buildBasicCancelOk("t"));
  }), () => amqpClient({ host: "h", operation: "consume", queue: "q",
    max_messages: 1, consume_timeout: 0.05, no_ack: false,
    prefetch_count: 5, timeout: 5 }));
  assert(r.queue === "q");
});
await test("D27 consume empty queue returns messageCount=0", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 20 && !state.done) {
      state.done = true;
      replies.push(buildBasicConsumeOk("t"));
      // No messages delivered
    }
    if (frame.classId === 60 && frame.methodId === 30)
      replies.push(buildBasicCancelOk("t"));
  }), () => amqpClient({ host: "h", operation: "consume", queue: "q",
    max_messages: 5, consume_timeout: 0.05, no_ack: true, timeout: 5 }));
  assert(r.messageCount === 0);
});

// D28-D29: ack / nack (fire-and-forget, no broker reply expected)
await test("D28 ack returns acknowledged:true", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", operation: "ack", delivery_tag: 1, timeout: 5 }));
  assert(r.acknowledged === true);
});
await test("D29 nack returns nacked:true", async () => {
  const r = await withMock(simpleBroker(), () =>
    amqpClient({ host: "h", operation: "nack", delivery_tag: 2, requeue: true, timeout: 5 }));
  assert(r.nacked === true);
});
await test("D30 purge messageCount returned", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 30)
      replies.push(buildQueuePurgeOk(42));
  }), () => amqpClient({ host: "h", operation: "purge", queue: "test-q", timeout: 5 }));
  assert(r.messageCount === 42);
});

// ============================================================================
// E — Error paths
// ============================================================================
section("E — Error paths");

// E01: connection refused — mock immediately emits error before connect
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
    setImmediate(() => {
      const e = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5672"), { code: "ECONNREFUSED" });
      sock.emit("error", e);
    });
    return sock;
  };
  const err = await withMock(refusedFactory, () =>
    amqpClient({ host: "127.0.0.1", port: 5672, operation: "connect", timeout: 5 })
  ).catch(e => e);
  assert(err instanceof Error, `expected Error, got ${err}`);
});

// E02: timeout — mock sends nothing, operation times out
await test("E02 timeout waiting for handshake", async () => {
  const silentFactory = () => {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; setImmediate(() => sock.emit("close")); };
    sock.end = sock.destroy;
    sock.write = () => true;
    setImmediate(() => sock.emit("connect"));
    return sock;
  };
  const err = await withMock(silentFactory, () =>
    amqpClient({ host: "h", port: 5672, operation: "connect", timeout: 0.15 })
  ).catch(e => e);
  assert(err instanceof Error && err.message.includes("timed out"), `got: ${err.message}`);
});

// E03: socket closes mid-handshake
await test("E03 socket close mid-handshake throws", async () => {
  const earlyClose = () => {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.destroy = () => { sock.destroyed = true; setImmediate(() => sock.emit("close")); };
    sock.end = sock.destroy;
    sock.write = () => {
      // After receiving the protocol header, immediately close
      setImmediate(() => { if (!sock.destroyed) { sock.destroyed = true; sock.emit("close"); } });
      return true;
    };
    setImmediate(() => sock.emit("connect"));
    return sock;
  };
  const err = await withMock(earlyClose, () =>
    amqpClient({ host: "h", port: 5672, operation: "connect", timeout: 2 })
  ).catch(e => e);
  assert(err instanceof Error, `expected Error, got ${err}`);
});

// E04: Connection.Start missing PLAIN mechanism
await test("E04 broker without PLAIN auth throws", async () => {
  const noPlainBroker = () => {
    let buf = Buffer.alloc(0);
    return makeMockSocket((data) => {
      buf = Buffer.concat([buf, data]);
      if (buf.length >= 8 && buf.slice(0, 4).toString() === "AMQP") {
        buf = Buffer.alloc(0);
        // Send Connection.Start with ANONYMOUS mechanism only
        const serverProps = encodeTable({ product: "MockBroker" });
        const mechanisms  = encodeLongStr("ANONYMOUS");
        const locales     = encodeLongStr("en_US");
        const payload = Buffer.concat([Buffer.from([0x00, 0x09]), serverProps, mechanisms, locales]);
        return [buildMethodFrame(0, 10, 10, payload)];
      }
      return [];
    });
  };
  const err = await withMock(noPlainBroker, () =>
    amqpClient({ host: "h", operation: "connect", timeout: 5 })
  ).catch(e => e);
  assert(err instanceof Error && err.message.includes("PLAIN"), `got: ${err.message}`);
});

// E05: consume timeout with no messages returns empty result
await test("E05 consume with no messages returns messageCount=0", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 20 && !state.done) {
      state.done = true;
      replies.push(buildBasicConsumeOk("t"));
    }
    if (frame.classId === 60 && frame.methodId === 30)
      replies.push(buildBasicCancelOk("t"));
  }), () => amqpClient({ host: "h", operation: "consume", queue: "empty",
    max_messages: 10, consume_timeout: 0.05, no_ack: true, timeout: 5 }));
  assert(r.messageCount === 0 && Array.isArray(r.messages));
});

// ============================================================================
// F — Concurrency / stress
// ============================================================================
section("F — Concurrency");

// F01: 10 concurrent connects
await test("F01 10 concurrent connects all succeed", async () => {
  const results = await withMock(simpleBroker(), () =>
    Promise.all(Array.from({ length: 10 }, () =>
      amqpClient({ host: "h", port: 5672, operation: "connect", timeout: 5 })
    ))
  );
  assert(results.every(r => r.connected === true), `not all connected`);
});
await test("F02 all concurrent results have elapsedMs", async () => {
  const results = await withMock(simpleBroker(), () =>
    Promise.all(Array.from({ length: 10 }, () =>
      amqpClient({ host: "h", port: 5672, operation: "connect", timeout: 5 })
    ))
  );
  assert(results.every(r => typeof r.elapsedMs === "number"), "missing elapsedMs");
});
await test("F03 5 concurrent publishes succeed", async () => {
  const results = await withMock(simpleBroker(), () =>
    Promise.all(Array.from({ length: 5 }, (_, i) =>
      amqpClient({ host: "h", port: 5672, operation: "publish",
        routing_key: `stress.${i}`, body: `payload-${i}`, timeout: 5 })
    ))
  );
  assert(results.every(r => r.published === true), "not all published");
});
await test("F04 5 sequential declare_queue calls succeed", async () => {
  const results = [];
  await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 50 && frame.methodId === 10)
      replies.push(buildQueueDeclareOk("q", 0, 0));
  }), async () => {
    for (let i = 0; i < 5; i++)
      results.push(await amqpClient({ host: "h", operation: "declare_queue",
        queue: `q${i}`, timeout: 5 }));
  });
  assert(results.every(r => r.queue === "q"), "not all declared");
});
await test("F05 max_messages cap enforced when broker floods", async () => {
  const r = await withMock(simpleBroker((frame, state, replies) => {
    if (frame.classId === 60 && frame.methodId === 20 && !state.done) {
      state.done = true;
      replies.push(buildBasicConsumeOk("t"));
      for (let i = 0; i < 50; i++) {
        const b = `item${i}`;
        replies.push(buildBasicDeliver("t", i + 1, "", "r"));
        replies.push(buildContentHeader(1, b.length));
        replies.push(buildBodyFrame(1, b));
      }
    }
    if (frame.classId === 60 && frame.methodId === 30)
      replies.push(buildBasicCancelOk("t"));
  }), () => amqpClient({ host: "h", operation: "consume", queue: "flood",
    max_messages: 5, consume_timeout: 0.1, no_ack: true, timeout: 5 }));
  assert(r.messageCount <= 5, `expected <=5 got ${r.messageCount}`);
});

// ============================================================================
// Summary
// ============================================================================
process.stdout.write(`\n${'='.repeat(50)}\n`);
process.stdout.write(`amqp_client: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
else process.exit(0);

})();
