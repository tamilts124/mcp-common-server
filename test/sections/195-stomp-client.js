"use strict";
/**
 * Section 195 — stomp_client tests
 * 70 tests across 6 sub-sections:
 *   A. Input validation          (10)
 *   B. Codec unit tests          (10)
 *   C. Security guards           (10)
 *   D. Happy-path mock           (30)
 *   E. Error paths               (5)
 *   F. Concurrency               (5)
 */

const net              = require("net");
const nodeAssert       = require("assert");
const { stompClient, StompParser, encodeFrame } = require("../../lib/stompClientOps");

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

// ── Mock STOMP Broker helpers ──────────────────────────────────────────────────

function buildFrame(command, headers, body) {
  let head = command + "\n";
  for (const [k, v] of Object.entries(headers || {})) head += `${k}:${v}\n`;
  const bodyBuf = body ? Buffer.from(body, "utf8") : Buffer.alloc(0);
  if (bodyBuf.length > 0) head += `content-length:${bodyBuf.length}\n`;
  head += "\n";
  return Buffer.concat([Buffer.from(head, "utf8"), bodyBuf, Buffer.from([0x00])]);
}

function startMockBroker(handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const parser = new StompParser();
      socket.on("data", (chunk) => {
        try { parser.feed(chunk); } catch (e) { socket.destroy(); return; }
        let frame;
        while ((frame = parser.shift()) !== null) handler(socket, frame);
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, close: () => new Promise(r => server.close(r)) });
    });
    server.on("error", reject);
  });
}

function createBroker(opHandler) {
  return startMockBroker((socket, frame) => {
    if (frame.command === "CONNECT") {
      socket.write(buildFrame("CONNECTED", {
        version: "1.2", session: "mock-session-1",
        server: "MockSTOMP/1.0", "heart-beat": "0,0",
      }));
    } else if (opHandler) {
      opHandler(socket, frame);
    }
  });
}

(async () => {

// ============================================================================
// A. Input validation (10 tests)
// ============================================================================
section("A. Input validation");

await test("A01: missing host throws", async () => {
  await nodeAssert.rejects(() => stompClient({ operation: "connect" }), /host.*required/i);
});

await test("A02: invalid operation throws", async () => {
  await nodeAssert.rejects(() => stompClient({ host: "127.0.0.1", operation: "fly" }), /operation.*must be/i);
});

await test("A03: send without destination throws", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "send" }),
    /destination.*required/i
  );
});

await test("A04: request without destination throws", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "request" }),
    /destination.*required/i
  );
});

await test("A05: subscribe without destination throws", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "subscribe" }),
    /subscribe_destination.*required|destination.*required/i
  );
});

await test("A06: max_messages 0 throws", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "subscribe", subscribe_destination: "/q/x", max_messages: 0 }),
    /max_messages.*1.500/i
  );
});

await test("A07: max_messages 501 throws", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "subscribe", subscribe_destination: "/q/x", max_messages: 501 }),
    /max_messages.*1.500/i
  );
});

await test("A08: body exceeding 10 MB throws", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "send", destination: "/q/x", body: "x".repeat(11 * 1024 * 1024) }),
    /body.*10.*MB/i
  );
});

await test("A09: base64 body size checked before decode", async () => {
  const hugeBase64 = Buffer.alloc(11 * 1024 * 1024, 0x41).toString("base64");
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "send", destination: "/q/x", body: hugeBase64, body_encoding: "base64" }),
    /body.*MB/i
  );
});

await test("A10: host as number throws", async () => {
  await nodeAssert.rejects(() => stompClient({ host: 12345, operation: "connect" }), /host.*required/i);
});

// ============================================================================
// B. Codec unit tests (10 tests)
// ============================================================================
section("B. Codec unit tests");

await test("B01: encodeFrame CONNECT has correct structure", async () => {
  const buf = encodeFrame("CONNECT", { "accept-version": "1.2", host: "/" }, null);
  assert(Buffer.isBuffer(buf), "must be Buffer");
  assert(buf[buf.length - 1] === 0x00, "last byte NUL");
  const text = buf.toString("utf8");
  assert(text.startsWith("CONNECT\n"), "starts with command");
  assert(text.includes("accept-version:1.2\n"), "contains header");
});

await test("B02: encodeFrame with body includes content-length", async () => {
  const body = "hello world";
  const buf  = encodeFrame("SEND", { destination: "/q" }, body);
  assert(buf.toString("utf8").includes(`content-length:${Buffer.byteLength(body)}\n`));
});

await test("B03: encodeFrame with Buffer body", async () => {
  const bodyBuf = Buffer.from([0x01, 0x02, 0x03]);
  const frame   = encodeFrame("SEND", {}, bodyBuf);
  assert(frame[frame.length - 1] === 0x00, "NUL terminator");
  assert(frame[frame.length - 2] === 0x03);
  assert(frame[frame.length - 3] === 0x02);
  assert(frame[frame.length - 4] === 0x01);
});

await test("B04: StompParser parses single CONNECTED frame", async () => {
  const parser = new StompParser();
  parser.feed(buildFrame("CONNECTED", { version: "1.2", session: "abc" }));
  const f = parser.shift();
  assert(f !== null, "frame present");
  assert(f.command === "CONNECTED", `got ${f.command}`);
  assert(f.headers["version"] === "1.2");
  assert(f.headers["session"] === "abc");
});

await test("B05: StompParser handles fragmented chunks", async () => {
  const parser = new StompParser();
  const frame  = buildFrame("MESSAGE", { "message-id": "1" }, "test body");
  for (let i = 0; i < frame.length; i++) parser.feed(frame.slice(i, i + 1));
  const f = parser.shift();
  assert(f !== null, "frame present");
  assert(f.command === "MESSAGE");
  assert(f.bodyStr === "test body", `got '${f.bodyStr}'`);
});

await test("B06: StompParser handles multiple frames in one chunk", async () => {
  const parser = new StompParser();
  parser.feed(Buffer.concat([buildFrame("CONNECTED", { version: "1.2" }), buildFrame("RECEIPT", { "receipt-id": "r1" })]));
  const a = parser.shift();
  const b = parser.shift();
  assert(a.command === "CONNECTED");
  assert(b.command === "RECEIPT");
  assert(parser.shift() === null);
});

await test("B07: StompParser skips heartbeat newlines", async () => {
  const parser = new StompParser();
  parser.feed(Buffer.concat([Buffer.from([0x0a, 0x0a]), buildFrame("CONNECTED", { version: "1.2" })]));
  const f = parser.shift();
  assert(f !== null);
  assert(f.command === "CONNECTED");
});

await test("B08: StompParser respects content-length for binary body with embedded NUL", async () => {
  const parser  = new StompParser();
  const bodyBuf = Buffer.from([0x41, 0x00, 0x42]); // 'A'\0'B'
  const head    = Buffer.from(`MESSAGE\ncontent-length:${bodyBuf.length}\n\n`, "utf8");
  parser.feed(Buffer.concat([head, bodyBuf, Buffer.from([0x00])]));
  const f = parser.shift();
  assert(f !== null);
  assert(f.body.length === 3, `expected 3, got ${f.body.length}`);
  assert(f.body[1] === 0x00);
});

await test("B09: StompParser first-header-wins for duplicates", async () => {
  const parser = new StompParser();
  parser.feed(Buffer.from("MESSAGE\nfoo:first\nfoo:second\n\n\x00", "utf8"));
  const f = parser.shift();
  assert(f.headers["foo"] === "first", `expected 'first', got '${f.headers["foo"]}'`);
});

await test("B10: StompParser available count tracks correctly", async () => {
  const parser = new StompParser();
  assert(parser.available === 0);
  parser.feed(Buffer.concat([buildFrame("CONNECTED", {}), buildFrame("RECEIPT", { "receipt-id": "r1" })]));
  assert(parser.available === 2, `expected 2, got ${parser.available}`);
  parser.shift();
  assert(parser.available === 1);
  parser.shift();
  assert(parser.available === 0);
});

// ============================================================================
// C. Security guards (10 tests)
// ============================================================================
section("C. Security guards");

await test("C01: NUL byte in destination rejected", async () => {
  await nodeAssert.rejects(() => stompClient({ host: "127.0.0.1", operation: "send", destination: "/q/foo\0bar" }), /NUL/i);
});

await test("C02: CR in destination rejected", async () => {
  await nodeAssert.rejects(() => stompClient({ host: "127.0.0.1", operation: "send", destination: "/q\rfoo" }), /CR\/LF|header injection/i);
});

await test("C03: LF in destination rejected", async () => {
  await nodeAssert.rejects(() => stompClient({ host: "127.0.0.1", operation: "send", destination: "/q\nfoo" }), /CR\/LF|header injection/i);
});

await test("C04: NUL byte in login rejected", async () => {
  await nodeAssert.rejects(() => stompClient({ host: "127.0.0.1", operation: "connect", login: "user\0name" }), /NUL/i);
});

await test("C05: NUL byte in passcode rejected", async () => {
  await nodeAssert.rejects(() => stompClient({ host: "127.0.0.1", operation: "connect", passcode: "p\0ss" }), /NUL/i);
});

await test("C06: LF in vhost rejected", async () => {
  await nodeAssert.rejects(() => stompClient({ host: "127.0.0.1", operation: "connect", vhost: "/\ninjected" }), /CR\/LF|header injection/i);
});

await test("C07: extra header key with NUL rejected", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "send", destination: "/q/test", headers: { "x-custom\0key": "value" } }),
    /NUL/i
  );
});

await test("C08: extra header value with CR rejected", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "send", destination: "/q/test", headers: { "x-custom": "val\rue" } }),
    /CR\/LF|header injection/i
  );
});

await test("C09: destination exceeding 4096 chars rejected", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "send", destination: "/q/" + "a".repeat(4100) }),
    /exceeds.*4096/i
  );
});

await test("C10: subscribe_destination with LF rejected", async () => {
  await nodeAssert.rejects(
    () => stompClient({ host: "127.0.0.1", operation: "subscribe", subscribe_destination: "/queue/foo\nbar" }),
    /CR\/LF|header injection/i
  );
});

// ============================================================================
// D. Happy-path mock (30 tests)
// ============================================================================
section("D. Happy-path mock");

await test("D01: connect returns version + sessionId + serverInfo", async () => {
  const broker = await createBroker(null);
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 });
    assert(res.connected   === true,          "connected");
    assert(res.version     === "1.2",         `version: ${res.version}`);
    assert(res.sessionId   === "mock-session-1");
    assert(res.serverInfo  === "MockSTOMP/1.0");
    assert(res.operation   === "connect");
    assert(res.host        === "127.0.0.1");
    assert(res.port        === broker.port);
    assert(typeof res.elapsedMs === "number" && res.elapsedMs >= 0);
  } finally { await broker.close(); }
});

await test("D02: connect includes heartBeat field", async () => {
  const broker = await createBroker(null);
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 });
    assert(typeof res.heartBeat === "string");
    assert(/^\d+,\d+$/.test(res.heartBeat), `heartBeat: ${res.heartBeat}`);
  } finally { await broker.close(); }
});

await test("D03: connect with login/passcode (credentials not echoed)", async () => {
  let rxHeaders = {};
  const broker = await startMockBroker((socket, frame) => {
    if (frame.command === "CONNECT") {
      Object.assign(rxHeaders, frame.headers);
      socket.write(buildFrame("CONNECTED", { version: "1.2", "heart-beat": "0,0" }));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", login: "testuser", passcode: "testpass", timeout: 5 });
    assert(res.connected === true);
    assert(rxHeaders["login"]    === "testuser",  "broker got login");
    assert(rxHeaders["passcode"] === "testpass",  "broker got passcode");
    assert(!("login"    in res), "login not in result");
    assert(!("passcode" in res), "passcode not in result");
  } finally { await broker.close(); }
});

await test("D04: connect with custom vhost", async () => {
  let rxHeaders = {};
  const broker = await startMockBroker((socket, frame) => {
    if (frame.command === "CONNECT") {
      Object.assign(rxHeaders, frame.headers);
      socket.write(buildFrame("CONNECTED", { version: "1.2", "heart-beat": "0,0" }));
    }
  });
  try {
    await stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", vhost: "/myapp", timeout: 5 });
    assert(rxHeaders["host"] === "/myapp", `vhost: ${rxHeaders["host"]}`);
  } finally { await broker.close(); }
});

await test("D05: connect with heart-beat negotiation", async () => {
  let rxHeaders = {};
  const broker = await startMockBroker((socket, frame) => {
    if (frame.command === "CONNECT") {
      Object.assign(rxHeaders, frame.headers);
      socket.write(buildFrame("CONNECTED", { version: "1.2", "heart-beat": "500,500" }));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", heartbeat_send: 500, heartbeat_recv: 500, timeout: 5 });
    assert(rxHeaders["heart-beat"] === "500,500");
    assert(res.heartBeat === "500,500");
  } finally { await broker.close(); }
});

await test("D06: result includes vhost", async () => {
  const broker = await createBroker(null);
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", vhost: "/test", timeout: 5 });
    assert(res.vhost === "/test", `vhost: ${res.vhost}`);
  } finally { await broker.close(); }
});

await test("D07: send basic message", async () => {
  let rxSend = null;
  const broker = await createBroker((socket, frame) => { if (frame.command === "SEND") rxSend = frame; });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "send", destination: "/queue/test", body: "hello STOMP", timeout: 5 });
    assert(res.sent === true);
    assert(res.destination === "/queue/test");
    assert(res.bodyBytes > 0);
    assert(rxSend !== null);
    assert(rxSend.headers["destination"] === "/queue/test");
    assert(rxSend.bodyStr === "hello STOMP");
  } finally { await broker.close(); }
});

await test("D08: send with base64 body", async () => {
  let rxSend = null;
  const broker = await createBroker((socket, frame) => { if (frame.command === "SEND") rxSend = frame; });
  const payload = Buffer.from("binary\x00data");
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "send", destination: "/queue/bin", body: payload.toString("base64"), body_encoding: "base64", timeout: 5 });
    assert(res.sent === true);
    assert(res.bodyBytes === payload.length);
    assert(rxSend !== null);
    assert(Buffer.compare(rxSend.body, payload) === 0, "body content matches");
  } finally { await broker.close(); }
});

await test("D09: send with content-type header", async () => {
  let rxSend = null;
  const broker = await createBroker((socket, frame) => { if (frame.command === "SEND") rxSend = frame; });
  try {
    await stompClient({ host: "127.0.0.1", port: broker.port, operation: "send", destination: "/queue/json", body: '{"k":1}', content_type: "application/json", timeout: 5 });
    assert(rxSend.headers["content-type"] === "application/json");
  } finally { await broker.close(); }
});

await test("D10: send with extra custom headers", async () => {
  let rxSend = null;
  const broker = await createBroker((socket, frame) => { if (frame.command === "SEND") rxSend = frame; });
  try {
    await stompClient({ host: "127.0.0.1", port: broker.port, operation: "send", destination: "/queue/hdr", body: "msg", headers: { "x-priority": "high", "x-retry": "3" }, timeout: 5 });
    assert(rxSend.headers["x-priority"] === "high");
    assert(rxSend.headers["x-retry"]    === "3");
  } finally { await broker.close(); }
});

await test("D11: send with receipt (request_receipt:true)", async () => {
  let receiptId = null;
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SEND") {
      receiptId = frame.headers["receipt"];
      if (receiptId) socket.write(buildFrame("RECEIPT", { "receipt-id": receiptId }));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "send", destination: "/queue/rcpt", body: "ack me", request_receipt: true, timeout: 5 });
    assert(res.sent === true);
    assert(res.receiptId, "receiptId present");
    assert(res.receiptId === receiptId);
  } finally { await broker.close(); }
});

await test("D12: send without receipt has no receiptId field", async () => {
  const broker = await createBroker(null);
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "send", destination: "/queue/noreceipt", body: "msg", timeout: 5 });
    assert(res.sent === true);
    assert(!("receiptId" in res), "no receiptId without request_receipt");
  } finally { await broker.close(); }
});

await test("D13: subscribe collects messages", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") {
      const rcpt = frame.headers["receipt"];
      if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt }));
      for (let i = 1; i <= 3; i++) socket.write(buildFrame("MESSAGE", { "message-id": `msg-${i}`, destination: frame.headers["destination"], subscription: frame.headers["id"] }, `Message ${i}`));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/msgs", max_messages: 3, subscribe_timeout: 2, timeout: 5 });
    assert(res.messageCount === 3, `got ${res.messageCount}`);
    assert(res.messages.length === 3);
    assert(res.messages[0].body === "Message 1");
    assert(res.messages[2].body === "Message 3");
    assert(res.destination === "/queue/msgs");
  } finally { await broker.close(); }
});

await test("D14: subscribe stops at max_messages", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") {
      const rcpt = frame.headers["receipt"];
      if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt }));
      for (let i = 1; i <= 10; i++) socket.write(buildFrame("MESSAGE", { "message-id": `m${i}`, destination: frame.headers["destination"], subscription: frame.headers["id"] }, `m${i}`));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/lots", max_messages: 2, subscribe_timeout: 3, timeout: 5 });
    assert(res.messageCount <= 2, `got ${res.messageCount}`);
  } finally { await broker.close(); }
});

await test("D15: subscribe returns subscription ID", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/noop", id: "my-sub-1", subscribe_timeout: 0.5, timeout: 5 });
    assert(res.subscription === "my-sub-1", `sub: ${res.subscription}`);
  } finally { await broker.close(); }
});

await test("D16: subscribe with destination fallback", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", destination: "/queue/fallback", subscribe_timeout: 0.5, timeout: 5 });
    assert(res.destination === "/queue/fallback");
  } finally { await broker.close(); }
});

await test("D17: subscribe client-ack sends ACK frames", async () => {
  const ackIds = [];
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") {
      const rcpt = frame.headers["receipt"];
      if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt }));
      socket.write(buildFrame("MESSAGE", { "message-id": "ack-me", "ack": "ack-me", destination: frame.headers["destination"], subscription: frame.headers["id"] }, "ack body"));
    } else if (frame.command === "ACK") {
      ackIds.push(frame.headers["id"]);
    }
  });
  try {
    await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/ack-test", ack_mode: "client", max_messages: 1, subscribe_timeout: 2, timeout: 5 });
    await new Promise(r => setTimeout(r, 100));
    assert(ackIds.length > 0, "should have sent ACK");
    assert(ackIds[0] === "ack-me");
  } finally { await broker.close(); }
});

await test("D18: subscribe zero messages when none arrive", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/empty", max_messages: 10, subscribe_timeout: 0.5, timeout: 5 });
    assert(res.messageCount === 0);
    assert(res.messages.length === 0);
  } finally { await broker.close(); }
});

await test("D19: subscribe message has bodyBytes", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") {
      const rcpt = frame.headers["receipt"];
      if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt }));
      socket.write(buildFrame("MESSAGE", { "message-id": "bk1", destination: frame.headers["destination"], subscription: frame.headers["id"] }, "body text"));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/bk", max_messages: 1, subscribe_timeout: 2, timeout: 5 });
    assert(res.messages[0].bodyBytes > 0);
  } finally { await broker.close(); }
});

await test("D20: subscribe sends UNSUBSCRIBE after", async () => {
  let unsubReceived = false;
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
    else if (frame.command === "UNSUBSCRIBE") { unsubReceived = true; }
  });
  try {
    await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/unsub", subscribe_timeout: 0.3, timeout: 5 });
    await new Promise(r => setTimeout(r, 100));
    assert(unsubReceived, "UNSUBSCRIBE sent");
  } finally { await broker.close(); }
});

await test("D21: subscribe message includes full headers map", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") {
      const rcpt = frame.headers["receipt"];
      if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt }));
      socket.write(buildFrame("MESSAGE", { "message-id": "x1", destination: frame.headers["destination"], subscription: frame.headers["id"], "x-custom": "myvalue" }, "hdr body"));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/hdr", max_messages: 1, subscribe_timeout: 2, timeout: 5 });
    assert(res.messages[0].headers["x-custom"] === "myvalue");
  } finally { await broker.close(); }
});

await test("D22: request receives reply", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
    else if (frame.command === "SEND") {
      const replyTo = frame.headers["reply-to"];
      const corrId  = frame.headers["correlation-id"];
      if (replyTo) socket.write(buildFrame("MESSAGE", { destination: replyTo, subscription: "mcp-reply-sub-0", "message-id": "reply-1", "correlation-id": corrId || "" }, "the reply body"));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "request", destination: "/queue/srv", body: "ping", request_timeout: 2, timeout: 5 });
    assert(res.replied === true);
    assert(res.body === "the reply body", `body: ${res.body}`);
    assert(res.bodyBytes > 0);
    assert(res.replyHeaders != null);
  } finally { await broker.close(); }
});

await test("D23: request with explicit reply_to", async () => {
  let subscribedDest = null;
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { subscribedDest = frame.headers["destination"]; const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
    else if (frame.command === "SEND") {
      const replyTo = frame.headers["reply-to"];
      if (replyTo) socket.write(buildFrame("MESSAGE", { destination: replyTo, subscription: "any", "message-id": "r2" }, "reply2"));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "request", destination: "/queue/svc", reply_to: "/queue/my-replies", request_timeout: 2, timeout: 5 });
    assert(subscribedDest === "/queue/my-replies", `subscribed: ${subscribedDest}`);
    assert(res.replied === true);
  } finally { await broker.close(); }
});

await test("D24: request timeout returns replied:false", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
    // No reply sent
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "request", destination: "/queue/nosvc", request_timeout: 0.5, timeout: 5 });
    assert(res.replied  === false);
    assert(res.timedOut === true);
  } finally { await broker.close(); }
});

await test("D25: request with custom correlation_id", async () => {
  let sentCorrId = null;
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
    else if (frame.command === "SEND") {
      sentCorrId = frame.headers["correlation-id"];
      const replyTo = frame.headers["reply-to"];
      if (replyTo) socket.write(buildFrame("MESSAGE", { destination: replyTo, subscription: "any", "message-id": "r3", "correlation-id": sentCorrId }, "corr reply"));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "request", destination: "/queue/svc", correlation_id: "MY-CORR-123", request_timeout: 2, timeout: 5 });
    assert(sentCorrId === "MY-CORR-123");
    assert(res.replied === true);
    assert(res.correlationId.includes("MY-CORR-123"), `corrId: ${res.correlationId}`);
  } finally { await broker.close(); }
});

await test("D26: request sends body to destination", async () => {
  let sentBody = null;
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
    else if (frame.command === "SEND") {
      sentBody = frame.bodyStr;
      const replyTo = frame.headers["reply-to"];
      if (replyTo) socket.write(buildFrame("MESSAGE", { destination: replyTo, subscription: "any", "message-id": "r4" }, "ok"));
    }
  });
  try {
    await stompClient({ host: "127.0.0.1", port: broker.port, operation: "request", destination: "/queue/svc", body: "request payload", request_timeout: 2, timeout: 5 });
    assert(sentBody === "request payload", `body: ${sentBody}`);
  } finally { await broker.close(); }
});

await test("D27: disconnect sends DISCONNECT frame", async () => {
  let disconnectReceived = false;
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "DISCONNECT") {
      disconnectReceived = true;
      const rcpt = frame.headers["receipt"];
      if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt }));
    }
  });
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "disconnect", timeout: 5 });
    assert(res.disconnected === true);
    await new Promise(r => setTimeout(r, 100));
    assert(disconnectReceived, "DISCONNECT frame sent");
  } finally { await broker.close(); }
});

await test("D28: result always includes elapsedMs", async () => {
  const broker = await createBroker(null);
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 });
    assert(typeof res.elapsedMs === "number" && res.elapsedMs >= 0);
  } finally { await broker.close(); }
});

await test("D29: port echoed in result", async () => {
  const broker = await createBroker(null);
  try {
    const res = await stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 });
    assert(res.port === broker.port, `port: ${res.port}`);
  } finally { await broker.close(); }
});

await test("D30: broker ERROR during subscribe throws", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") {
      const rcpt = frame.headers["receipt"];
      if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt }));
      socket.write(buildFrame("ERROR", { message: "Not authorized" }, "Permission denied"));
    }
  });
  try {
    await nodeAssert.rejects(
      () => stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/queue/forbidden", subscribe_timeout: 2, timeout: 5 }),
      /Not authorized|Permission denied/i
    );
  } finally { await broker.close(); }
});

// ============================================================================
// E. Error paths (5 tests)
// ============================================================================
section("E. Error paths");

await test("E01: ECONNREFUSED gives socket error (mocked)", async () => {
  const { EventEmitter } = require("events");
  const originalCreate = net.createConnection;
  net.createConnection = () => {
    const sock = new EventEmitter();
    sock.write   = () => {};
    sock.destroy = () => { sock.emit("close"); };
    setImmediate(() => {
      const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19991"), { code: "ECONNREFUSED" });
      sock.emit("error", err);
    });
    return sock;
  };
  try {
    await nodeAssert.rejects(
      () => stompClient({ host: "127.0.0.1", port: 19991, operation: "connect", timeout: 2 }),
      /ECONNREFUSED|socket error/i
    );
  } finally { net.createConnection = originalCreate; }
});

await test("E02: broker sends ERROR on CONNECT", async () => {
  const broker = await startMockBroker((socket, frame) => {
    if (frame.command === "CONNECT") socket.write(buildFrame("ERROR", { message: "Bad login" }, "Wrong credentials"));
  });
  try {
    await nodeAssert.rejects(
      () => stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 }),
      /Bad login|Wrong credentials|broker returned ERROR/i
    );
  } finally { await broker.close(); }
});

await test("E03: unexpected command instead of CONNECTED", async () => {
  const broker = await startMockBroker((socket, frame) => {
    if (frame.command === "CONNECT") socket.write(buildFrame("RECEIPT", { "receipt-id": "unexpected" }));
  });
  try {
    await nodeAssert.rejects(
      () => stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 }),
      /expected CONNECTED/i
    );
  } finally { await broker.close(); }
});

await test("E04: global timeout fires", async () => {
  const broker = await startMockBroker(() => { /* Never responds */ });
  try {
    await nodeAssert.rejects(
      () => stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 0.5, connect_timeout: 10 }),
      /timed out/i
    );
  } finally { await broker.close(); }
});

await test("E05: ERROR during request throws", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
    else if (frame.command === "SEND") socket.write(buildFrame("ERROR", { message: "Service down" }, "unavailable"));
  });
  try {
    await nodeAssert.rejects(
      () => stompClient({ host: "127.0.0.1", port: broker.port, operation: "request", destination: "/queue/svc", request_timeout: 2, timeout: 5 }),
      /Service down|broker ERROR/i
    );
  } finally { await broker.close(); }
});

// ============================================================================
// F. Concurrency (5 tests)
// ============================================================================
section("F. Concurrency");

await test("F01: 5 concurrent connects", async () => {
  const broker = await createBroker(null);
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 })
    ));
    assert(results.length === 5);
    for (const r of results) assert(r.connected === true, `connected: ${r.connected}`);
  } finally { await broker.close(); }
});

await test("F02: 5 concurrent sends", async () => {
  const broker = await createBroker(null);
  try {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      stompClient({ host: "127.0.0.1", port: broker.port, operation: "send", destination: `/queue/t${i}`, body: `m${i}`, timeout: 5 })
    ));
    assert(results.length === 5);
    for (const r of results) assert(r.sent === true);
  } finally { await broker.close(); }
});

await test("F03: concurrent connects get independent sessions", async () => {
  let counter = 0;
  const broker = await startMockBroker((socket, frame) => {
    if (frame.command === "CONNECT") {
      socket.write(buildFrame("CONNECTED", { version: "1.2", session: `session-${++counter}`, "heart-beat": "0,0" }));
    }
  });
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 })
    ));
    const sessions = results.map(r => r.sessionId);
    const unique   = new Set(sessions);
    assert(unique.size === 5, `expected 5 unique sessions, got: ${sessions.join(",")}`);
  } finally { await broker.close(); }
});

await test("F04: mix of operations concurrently", async () => {
  const broker = await createBroker((socket, frame) => {
    if (frame.command === "SUBSCRIBE") { const rcpt = frame.headers["receipt"]; if (rcpt) socket.write(buildFrame("RECEIPT", { "receipt-id": rcpt })); }
  });
  try {
    const [c, s, sub] = await Promise.all([
      stompClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 }),
      stompClient({ host: "127.0.0.1", port: broker.port, operation: "send",    destination: "/q/mix", body: "x", timeout: 5 }),
      stompClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subscribe_destination: "/q/mix", subscribe_timeout: 0.3, timeout: 5 }),
    ]);
    assert(c.connected === true);
    assert(s.sent     === true);
    assert(typeof sub.messageCount === "number");
  } finally { await broker.close(); }
});

await test("F05: concurrent validation failures don't bleed", async () => {
  const errors = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      stompClient({ host: "127.0.0.1", operation: i % 2 === 0 ? "fly" : "hover" })
        .then(() => null)
        .catch(e => e.message)
    )
  );
  assert(errors.every(e => e && /operation.*must be/i.test(e)), "all should be validation errors");
});

// ============================================================================
// Summary
// ============================================================================
process.stdout.write(`\n${'='.repeat(60)}\n`);
process.stdout.write(`Section 195 — stomp_client: ${passed}/${passed + failed} tests passed\n`);
if (failed > 0) process.exit(1);
else process.exit(0);

})();
