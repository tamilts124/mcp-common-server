"use strict";
/**
 * Section 196 — nats_client tests
 * 70 tests across 6 sub-sections:
 *   A. Input validation          (10)
 *   B. Codec unit tests          (10)
 *   C. Security guards           (10)
 *   D. Happy-path mock           (30)
 *   E. Error paths               ( 5)
 *   F. Concurrency               ( 5)
 */

const net = require("net");
const {
  natsClient,
  NatsParser,
  encodeConnect,
  encodePub,
  encodeSub,
} = require("../../lib/natsClientOps");

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

// ── Mock NATS Server helpers ──────────────────────────────────────────────────

function buildInfo(extra) {
  const info = Object.assign(
    { server_id: "MOCK-SERVER-ID", server_name: "mock-nats", version: "2.10.0", max_payload: 1048576 },
    extra,
  );
  return `INFO ${JSON.stringify(info)}\r\n`;
}

function buildMsg(subject, sid, payload, replyTo) {
  const payBuf = Buffer.from(payload, "utf8");
  const parts  = replyTo
    ? `${subject} ${sid} ${replyTo} ${payBuf.length}`
    : `${subject} ${sid} ${payBuf.length}`;
  return Buffer.concat([
    Buffer.from(`MSG ${parts}\r\n`, "utf8"),
    payBuf,
    Buffer.from("\r\n", "utf8"),
  ]);
}

function startMockNats(handler) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.write(buildInfo());
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (line === "") continue;
          if (line === "PING") { socket.write("PONG\r\n"); continue; }
          if (handler) handler(socket, line);
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, close: () => new Promise(r => server.close(r)) });
    });
    server.on("error", reject);
  });
}

(async () => {

// ============================================================================
// A. Input validation (10 tests)
// ============================================================================
section("A. Input validation");

await test("A01 — missing host throws ToolError", async () => {
  try { await natsClient({ operation: "ping" }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("host"), `Expected 'host' error: ${e.message}`); }
});

await test("A02 — invalid operation throws ToolError", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "blargh" }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("operation"), `Expected 'operation' error: ${e.message}`); }
});

await test("A03 — publish without subject throws", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "publish" }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("subject"), `Expected 'subject' error: ${e.message}`); }
});

await test("A04 — request without subject throws", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "request" }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("subject"), `Expected 'subject' error: ${e.message}`); }
});

await test("A05 — subscribe without subject throws", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "subscribe" }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("subject") || e.message.includes("subscribe_subject"), `Got: ${e.message}`); }
});

await test("A06 — max_messages < 1 throws", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "subscribe", subject: "t", max_messages: 0 }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("max_messages"), `Got: ${e.message}`); }
});

await test("A07 — max_messages > 1000 throws", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "subscribe", subject: "t", max_messages: 1001 }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("max_messages"), `Got: ${e.message}`); }
});

await test("A08 — oversized utf8 payload throws", async () => {
  const big = "x".repeat(8 * 1024 * 1024 + 1);
  try { await natsClient({ host: "127.0.0.1", operation: "publish", subject: "x", payload: big }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("payload") || e.message.includes("MB"), `Got: ${e.message}`); }
});

await test("A09 — valid operations listed in error message", async () => {
  let msg = "";
  try { await natsClient({ host: "127.0.0.1", operation: "bad_op" }); } catch (e) { msg = e.message; }
  for (const op of ["connect", "publish", "subscribe", "request", "ping"])
    assert(msg.includes(op), `VALID_OPS error should list '${op}': ${msg}`);
});

await test("A10 — small base64 payload not rejected on size", async () => {
  const b64 = Buffer.from("hello nats").toString("base64");
  try {
    await natsClient({ host: "127.0.0.1", port: 1, operation: "publish", subject: "t", payload: b64, payload_encoding: "base64", timeout: 1 });
  } catch (e) {
    assert(!e.message.includes("payload exceeds"), `Should not fail on size: ${e.message}`);
  }
});

// ============================================================================
// B. Codec unit tests (10 tests)
// ============================================================================
section("B. Codec unit tests");

await test("B01 — NatsParser parses INFO frame", async () => {
  const p = new NatsParser();
  p.feed(Buffer.from(`INFO {"server_id":"S1","version":"2.10.0"}\r\n`, "utf8"));
  const ev = p.shift();
  assert(ev && ev.type === "INFO");
  assert(ev.data.server_id === "S1" && ev.data.version === "2.10.0");
});

await test("B02 — NatsParser parses PING and PONG", async () => {
  const p = new NatsParser();
  p.feed(Buffer.from("PING\r\nPONG\r\n", "utf8"));
  const e1 = p.shift(); const e2 = p.shift();
  assert(e1 && e1.type === "PING");
  assert(e2 && e2.type === "PONG");
});

await test("B03 — NatsParser parses +OK and -ERR", async () => {
  const p = new NatsParser();
  p.feed(Buffer.from("+OK\r\n-ERR 'Unknown Protocol'\r\n", "utf8"));
  const ok = p.shift(); const err = p.shift();
  assert(ok && ok.type === "+OK");
  assert(err && err.type === "-ERR" && err.message.includes("Unknown Protocol"));
});

await test("B04 — NatsParser parses MSG without reply-to", async () => {
  const p = new NatsParser();
  const pl = "hello world";
  p.feed(Buffer.from(`MSG foo.bar sid1 ${pl.length}\r\n${pl}\r\n`, "utf8"));
  const ev = p.shift();
  assert(ev && ev.type === "MSG" && ev.subject === "foo.bar" && ev.sid === "sid1");
  assert(ev.replyTo === undefined && ev.payloadStr === pl);
});

await test("B05 — NatsParser parses MSG with reply-to", async () => {
  const p = new NatsParser();
  const pl = "reply-data";
  p.feed(Buffer.from(`MSG req.s sid2 _INBOX.r ${pl.length}\r\n${pl}\r\n`, "utf8"));
  const ev = p.shift();
  assert(ev && ev.type === "MSG" && ev.replyTo === "_INBOX.r" && ev.payloadStr === pl);
});

await test("B06 — NatsParser handles fragmented chunks", async () => {
  const p = new NatsParser();
  const full = "PING\r\nPONG\r\n";
  for (let i = 0; i < full.length; i++) p.feed(Buffer.from(full[i], "utf8"));
  const e1 = p.shift(); const e2 = p.shift();
  assert(e1 && e1.type === "PING" && e2 && e2.type === "PONG");
});

await test("B07 — NatsParser handles multiple events in one chunk", async () => {
  const p = new NatsParser();
  const pl1 = "m1"; const pl2 = "m2";
  p.feed(Buffer.from(`MSG s1 sid1 ${pl1.length}\r\n${pl1}\r\nMSG s2 sid2 ${pl2.length}\r\n${pl2}\r\n`, "utf8"));
  const e1 = p.shift(); const e2 = p.shift();
  assert(e1 && e1.payloadStr === pl1 && e2 && e2.payloadStr === pl2);
});

await test("B08 — encodeConnect includes user/pass and protocol=1", async () => {
  const frame = encodeConnect({ user: "alice", pass: "secret", name: "test" });
  assert(frame.startsWith("CONNECT "));
  const json = JSON.parse(frame.slice(8).trim());
  assert(json.user === "alice" && json.pass === "secret");
  assert(json.protocol === 1 && json.verbose === false);
});

await test("B09 — encodePub builds correct frame without reply-to", async () => {
  const pl = Buffer.from("hello", "utf8");
  const buf = encodePub("test.s", pl, undefined);
  const str = buf.toString("utf8");
  assert(str.startsWith("PUB test.s 5\r\n") && str.includes("hello") && str.endsWith("\r\n"));
});

await test("B10 — encodePub with reply-to", async () => {
  const pl = Buffer.from("req", "utf8");
  const buf = encodePub("svc.add", pl, "_INBOX.1");
  assert(buf.toString("utf8").startsWith("PUB svc.add _INBOX.1 3\r\n"));
});

// ============================================================================
// C. Security guards (10 tests)
// ============================================================================
section("C. Security guards");

await test("C01 — CR in subject rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "publish", subject: "foo\rbar" }); throw new Error("should throw"); }
  catch (e) { assert(/CR|LF|NUL|inject/i.test(e.message), `Got: ${e.message}`); }
});

await test("C02 — LF in subject rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "publish", subject: "foo\nbar" }); throw new Error("should throw"); }
  catch (e) { assert(/CR|LF|NUL|inject/i.test(e.message), `Got: ${e.message}`); }
});

await test("C03 — NUL byte in subject rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "publish", subject: "foo\x00bar" }); throw new Error("should throw"); }
  catch (e) { assert(/NUL|CR|inject/i.test(e.message), `Got: ${e.message}`); }
});

await test("C04 — empty subject rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "publish", subject: "" }); throw new Error("should throw"); }
  catch (e) { assert(e.message.toLowerCase().includes("subject") || e.message.toLowerCase().includes("empty"), `Got: ${e.message}`); }
});

await test("C05 — subject exceeding 4096 chars rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "publish", subject: "x".repeat(4097) }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("subject") || e.message.includes("4096") || e.message.includes("limit"), `Got: ${e.message}`); }
});

await test("C06 — CR in token rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "connect", token: "tok\ren" }); throw new Error("should throw"); }
  catch (e) { assert(/CR|LF|NUL|token/i.test(e.message), `Got: ${e.message}`); }
});

await test("C07 — LF in user rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "connect", user: "us\ner", pass: "p" }); throw new Error("should throw"); }
  catch (e) { assert(/CR|LF|NUL|user/i.test(e.message), `Got: ${e.message}`); }
});

await test("C08 — NUL in subscribe_subject rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "subscribe", subscribe_subject: "foo\x00bar" }); throw new Error("should throw"); }
  catch (e) { assert(/NUL|CR|inject/i.test(e.message), `Got: ${e.message}`); }
});

await test("C09 — oversized base64 payload rejected", async () => {
  const rawBytes = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41);
  const b64 = rawBytes.toString("base64");
  try { await natsClient({ host: "127.0.0.1", operation: "publish", subject: "x", payload: b64, payload_encoding: "base64" }); throw new Error("should throw"); }
  catch (e) { assert(e.message.includes("payload") || e.message.includes("MB") || e.message.includes("limit"), `Got: ${e.message}`); }
});

await test("C10 — CR in queue_group rejected", async () => {
  try { await natsClient({ host: "127.0.0.1", operation: "subscribe", subject: "x", queue_group: "grp\rname" }); throw new Error("should throw"); }
  catch (e) { assert(/CR|LF|NUL|queue/i.test(e.message), `Got: ${e.message}`); }
});

// ============================================================================
// D. Happy-path mock (30 tests)
// ============================================================================
section("D. Happy-path mock");

await test("D01 — connect: handshake succeeds, returns serverId/version", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 });
    assert(r.connected === true);
    assert(r.serverId === "MOCK-SERVER-ID", `serverId: ${r.serverId}`);
    assert(r.serverName === "mock-nats");
    assert(r.version === "2.10.0");
    assert(typeof r.elapsedMs === "number");
  } finally { await broker.close(); }
});

await test("D02 — ping: returns pong=true and latencyMs", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "ping", timeout: 5 });
    assert(r.pong === true && typeof r.latencyMs === "number" && r.latencyMs >= 0);
  } finally { await broker.close(); }
});

await test("D03 — publish: returns published=true and payloadBytes", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "publish", subject: "events.test", payload: "hello nats", timeout: 5 });
    assert(r.published === true && r.subject === "events.test");
    assert(r.payloadBytes === Buffer.byteLength("hello nats", "utf8"));
  } finally { await broker.close(); }
});

await test("D04 — publish base64 payload decoded correctly", async () => {
  const broker = await startMockNats(null);
  const raw = "binary\x00data";
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "publish", subject: "bin.t", payload: b64, payload_encoding: "base64", timeout: 5 });
    assert(r.published === true && r.payloadBytes === Buffer.from(raw, "utf8").length);
  } finally { await broker.close(); }
});

await test("D05 — publish with reply_to sets replyTo in result", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "publish", subject: "svc.call", payload: "req", reply_to: "_INBOX.myapp.123", timeout: 5 });
    assert(r.published === true && r.replyTo === "_INBOX.myapp.123");
  } finally { await broker.close(); }
});

await test("D06 — subscribe: collects 3 messages from server", async () => {
  let subSid = null;
  const broker = await startMockNats((socket, line) => {
    if (line.startsWith("SUB ")) {
      const parts = line.slice(4).split(" ");
      subSid = parts[parts.length - 1];
      setTimeout(() => {
        if (subSid) {
          socket.write(buildMsg("test.events", subSid, "msg-1"));
          socket.write(buildMsg("test.events", subSid, "msg-2"));
          socket.write(buildMsg("test.events", subSid, "msg-3"));
        }
      }, 20);
    }
  });
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "test.events", max_messages: 3, subscribe_timeout: 2, timeout: 5 });
    assert(r.messageCount === 3, `Expected 3, got ${r.messageCount}`);
    assert(r.messages[0].payload === "msg-1" && r.messages[2].payload === "msg-3");
  } finally { await broker.close(); }
});

await test("D07 — subscribe_subject overrides subject", async () => {
  let receivedSubject = null;
  const broker = await startMockNats((socket, line) => {
    if (line.startsWith("SUB ")) receivedSubject = line.slice(4).split(" ")[0];
  });
  try {
    await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "wrong", subscribe_subject: "correct.subject", subscribe_timeout: 0.5, timeout: 3 });
    assert(receivedSubject === "correct.subject", `Got: ${receivedSubject}`);
  } finally { await broker.close(); }
});

await test("D08 — queue_group included in SUB frame", async () => {
  let subLine = null;
  const broker = await startMockNats((socket, line) => { if (line.startsWith("SUB ")) subLine = line; });
  try {
    await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "work.q", queue_group: "workers", subscribe_timeout: 0.3, timeout: 3 });
    assert(subLine !== null && subLine.includes("workers"), `Got: ${subLine}`);
  } finally { await broker.close(); }
});

await test("D09 — subscribe returns 0 messages when none sent", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "empty", subscribe_timeout: 0.3, timeout: 3 });
    assert(r.messageCount === 0 && r.messages.length === 0);
  } finally { await broker.close(); }
});

await test("D10 — subscribe stops at max_messages cap", async () => {
  const broker = await startMockNats((socket, line) => {
    if (line.startsWith("SUB ")) {
      const sid = line.slice(4).split(" ").pop();
      for (let i = 0; i < 5; i++) socket.write(buildMsg("bulk", sid, `m${i}`));
    }
  });
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "bulk", max_messages: 2, subscribe_timeout: 1, timeout: 5 });
    assert(r.messageCount <= 2, `Got ${r.messageCount}`);
  } finally { await broker.close(); }
});

await test("D11 — request: reply received on inbox", async () => {
  const sids = {};
  const broker = await startMockNats((socket, line) => {
    if (line.startsWith("SUB ")) {
      const parts = line.slice(4).split(" ");
      sids[parts[0]] = parts[parts.length - 1];
    }
    if (line.startsWith("PUB ")) {
      const parts = line.slice(4).split(" ");
      if (parts.length >= 3) {
        const replySubject = parts[1];
        const sid = sids[replySubject];
        if (sid) setTimeout(() => socket.write(buildMsg(replySubject, sid, "reply-data")), 5);
      }
    }
  });
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "request", subject: "svc.echo", payload: "ping", request_timeout: 2, timeout: 5 });
    assert(r.replied === true, `Expected replied=true: ${JSON.stringify(r)}`);
    assert(r.payload === "reply-data", `payload: ${r.payload}`);
  } finally { await broker.close(); }
});

await test("D12 — request: timedOut=true when no reply", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "request", subject: "nowhere", request_timeout: 0.3, timeout: 3 });
    assert(r.replied === false && r.timedOut === true);
  } finally { await broker.close(); }
});

await test("D13 — request: custom reply_to used as inbox subject", async () => {
  let pubLine = null;
  const broker = await startMockNats((socket, line) => { if (line.startsWith("PUB ")) pubLine = line; });
  try {
    await natsClient({ host: "127.0.0.1", port: broker.port, operation: "request", subject: "svc.t", payload: "r", reply_to: "custom.inbox.1", request_timeout: 0.3, timeout: 3 });
  } catch (_) {}
  assert(pubLine !== null && pubLine.includes("custom.inbox.1"), `Got: ${pubLine}`);
  await broker.close();
});

await test("D14 — connect result has host, port, operation", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 });
    assert(r.host === "127.0.0.1" && r.port === broker.port && r.operation === "connect");
  } finally { await broker.close(); }
});

await test("D15 — elapsedMs is positive number < 5000", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "ping", timeout: 5 });
    assert(typeof r.elapsedMs === "number" && r.elapsedMs >= 0 && r.elapsedMs < 5000);
  } finally { await broker.close(); }
});

await test("D16 — subscribe: message shape correct", async () => {
  const broker = await startMockNats((socket, line) => {
    if (line.startsWith("SUB ")) {
      const sid = line.slice(4).split(" ").pop();
      socket.write(buildMsg("shape.t", sid, "some-data"));
    }
  });
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "shape.t", max_messages: 1, subscribe_timeout: 1, timeout: 5 });
    assert(r.messageCount === 1);
    const msg = r.messages[0];
    assert(msg.subject === "shape.t" && msg.payload === "some-data");
    assert(msg.payloadBytes === Buffer.byteLength("some-data", "utf8"));
  } finally { await broker.close(); }
});

await test("D17 — subscribe: message replyTo field set", async () => {
  const broker = await startMockNats((socket, line) => {
    if (line.startsWith("SUB ")) {
      const sid = line.slice(4).split(" ").pop();
      socket.write(buildMsg("rpc.req", sid, "req-body", "_INBOX.c.1"));
    }
  });
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "rpc.req", max_messages: 1, subscribe_timeout: 1, timeout: 5 });
    assert(r.messageCount === 1 && r.messages[0].replyTo === "_INBOX.c.1");
  } finally { await broker.close(); }
});

await test("D18 — subscribe: UNSUB sent with max_messages limit", async () => {
  let unsubLine = null;
  const broker = await startMockNats((socket, line) => { if (line.startsWith("UNSUB ")) unsubLine = line; });
  try {
    await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "limit.t", max_messages: 3, subscribe_timeout: 0.5, timeout: 3 });
    assert(unsubLine !== null, "UNSUB should be sent");
    assert(unsubLine.includes("3"), `UNSUB should contain count 3: ${unsubLine}`);
  } finally { await broker.close(); }
});

await test("D19 — publish: empty payload is valid (0 bytes)", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "publish", subject: "heartbeat", payload: "", timeout: 5 });
    assert(r.published === true && r.payloadBytes === 0);
  } finally { await broker.close(); }
});

await test("D20 — NatsParser: unknown lines silently skipped", async () => {
  const p = new NatsParser();
  p.feed(Buffer.from("UNKNOWN_CMD data\r\nPING\r\n", "utf8"));
  const ev = p.shift();
  assert(ev && ev.type === "PING", `Expected PING, got ${ev && ev.type}`);
});

await test("D21 — subscribe SIDs are unique across calls", async () => {
  const sids = [];
  const broker = await startMockNats((socket, line) => {
    if (line.startsWith("SUB ")) sids.push(line.slice(4).split(" ").pop());
  });
  try {
    await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "a", subscribe_timeout: 0.2, timeout: 3 });
    await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "b", subscribe_timeout: 0.2, timeout: 3 });
    assert(sids.length >= 2 && sids[0] !== sids[1], `SIDs should differ: ${sids[0]} vs ${sids[1]}`);
  } finally { await broker.close(); }
});

await test("D22 — encodeSub without queue group", async () => {
  const frame = encodeSub("test.s", "sid1", undefined);
  assert(frame === "SUB test.s sid1\r\n", `Got: ${frame}`);
});

await test("D23 — encodeSub with queue group", async () => {
  const frame = encodeSub("work.q", "sid2", "workers");
  assert(frame === "SUB work.q workers sid2\r\n", `Got: ${frame}`);
});

await test("D24 — NatsParser INFO with empty JSON", async () => {
  const p = new NatsParser();
  p.feed(Buffer.from("INFO {}\r\n", "utf8"));
  const ev = p.shift();
  assert(ev && ev.type === "INFO" && typeof ev.data === "object");
});

await test("D25 — encodeConnect: protocol=1 and lang=node", async () => {
  const frame = encodeConnect({});
  const json = JSON.parse(frame.slice(8).trim());
  assert(json.protocol === 1 && json.lang === "node");
});

await test("D26 — connect: maxPayload from server INFO", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 });
    assert(typeof r.maxPayload === "number" && r.maxPayload > 0, `maxPayload: ${r.maxPayload}`);
  } finally { await broker.close(); }
});

await test("D27 — ping latency < 500ms on loopback", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "ping", timeout: 5 });
    assert(r.latencyMs < 500, `latencyMs: ${r.latencyMs}`);
  } finally { await broker.close(); }
});

await test("D28 — subscribe result has subscription and subject", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "my.topic", subscribe_timeout: 0.3, timeout: 3 });
    assert(typeof r.subscription === "string" && r.subscription.length > 0);
    assert(r.subject === "my.topic");
  } finally { await broker.close(); }
});

await test("D29 — subscribe result has queueGroup when set", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "grp.t", queue_group: "mygroup", subscribe_timeout: 0.3, timeout: 3 });
    assert(r.queueGroup === "mygroup", `queueGroup: ${r.queueGroup}`);
  } finally { await broker.close(); }
});

await test("D30 — request timedOut result includes replySubject", async () => {
  const broker = await startMockNats(null);
  try {
    const r = await natsClient({ host: "127.0.0.1", port: broker.port, operation: "request", subject: "silent", request_timeout: 0.3, timeout: 3 });
    assert(r.timedOut === true && typeof r.replySubject === "string" && r.replySubject.length > 0);
  } finally { await broker.close(); }
});

// ============================================================================
// E. Error paths (5 tests)
// ============================================================================
section("E. Error paths");

await test("E01 — connection refused throws socket error", async () => {
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const unusedPort = probe.address().port;
  await new Promise(r => probe.close(r));
  try {
    await natsClient({ host: "127.0.0.1", port: unusedPort, operation: "connect", timeout: 3, connect_timeout: 2 });
    throw new Error("Should have thrown");
  } catch (e) {
    assert(
      e.message.includes("ECONNREFUSED") || e.message.includes("socket") || e.message.includes("timed out"),
      `Expected connection error: ${e.message}`);
  }
});

await test("E02 — server -ERR during handshake throws", async () => {
  const badSrv = net.createServer((socket) => {
    socket.write(buildInfo());
    socket.once("data", () => { socket.write("-ERR 'Authorization Violation'\r\n"); socket.destroy(); });
  });
  const port = await new Promise((res, rej) => { badSrv.listen(0, "127.0.0.1", () => res(badSrv.address().port)); badSrv.on("error", rej); });
  try {
    await natsClient({ host: "127.0.0.1", port, operation: "connect", timeout: 3 });
    throw new Error("Should have thrown");
  } catch (e) {
    assert(/Authorization|ERR|error/i.test(e.message), `Expected auth error: ${e.message}`);
  } finally { await new Promise(r => badSrv.close(r)); }
});

await test("E03 — server closes before INFO throws", async () => {
  const rudeSrv = net.createServer((socket) => socket.destroy());
  const port = await new Promise((res, rej) => { rudeSrv.listen(0, "127.0.0.1", () => res(rudeSrv.address().port)); rudeSrv.on("error", rej); });
  try {
    await natsClient({ host: "127.0.0.1", port, operation: "connect", timeout: 3 });
    throw new Error("Should have thrown");
  } catch (e) {
    assert(/INFO|closed|socket/i.test(e.message), `Expected close error: ${e.message}`);
  } finally { await new Promise(r => rudeSrv.close(r)); }
});

await test("E04 — subscribe -ERR from server throws", async () => {
  const broker = await startMockNats((socket, line) => {
    if (line.startsWith("SUB ")) socket.write("-ERR 'Subscriptions Violation'\r\n");
  });
  try {
    await natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: "restricted", subscribe_timeout: 1, timeout: 5 });
    throw new Error("Should have thrown");
  } catch (e) {
    assert(/ERR|error|Subscription/i.test(e.message), `Expected subscription error: ${e.message}`);
  } finally { await broker.close(); }
});

await test("E05 — global timeout fires when server hangs", async () => {
  const srvSockets = [];
  const hangSrv = net.createServer((socket) => {
    srvSockets.push(socket);
    socket.write(buildInfo()); /* never sends PONG */
    socket.on("error", () => {});
  });
  const port = await new Promise((res, rej) => { hangSrv.listen(0, "127.0.0.1", () => res(hangSrv.address().port)); hangSrv.on("error", rej); });
  const t0 = Date.now();
  try {
    await natsClient({ host: "127.0.0.1", port, operation: "connect", timeout: 1, connect_timeout: 10 });
    throw new Error("Should have thrown");
  } catch (e) {
    const elapsed = Date.now() - t0;
    assert(elapsed < 8000, `Should timeout in <8s, took ${elapsed}ms`);
    assert(/timed out|timeout|PONG/i.test(e.message), `Expected timeout error: ${e.message}`);
  } finally {
    for (const s of srvSockets) { try { s.destroy(); } catch (_) {} }
    await new Promise(r => hangSrv.close(r));
  }
});

// ============================================================================
// F. Concurrency (5 tests)
// ============================================================================
section("F. Concurrency");

await test("F01 — 5 concurrent connects succeed", async () => {
  const broker = await startMockNats(null);
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      natsClient({ host: "127.0.0.1", port: broker.port, operation: "connect", timeout: 5 })));
    assert(results.every(r => r.connected === true));
  } finally { await broker.close(); }
});

await test("F02 — 5 concurrent pings succeed", async () => {
  const broker = await startMockNats(null);
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      natsClient({ host: "127.0.0.1", port: broker.port, operation: "ping", timeout: 5 })));
    assert(results.every(r => r.pong === true) && results.every(r => typeof r.latencyMs === "number"));
  } finally { await broker.close(); }
});

await test("F03 — 5 concurrent publishes succeed", async () => {
  const broker = await startMockNats(null);
  try {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      natsClient({ host: "127.0.0.1", port: broker.port, operation: "publish", subject: `events.${i}`, payload: `msg-${i}`, timeout: 5 })));
    assert(results.every(r => r.published === true));
  } finally { await broker.close(); }
});

await test("F04 — 5 concurrent subscribes timeout cleanly", async () => {
  const broker = await startMockNats(null);
  try {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      natsClient({ host: "127.0.0.1", port: broker.port, operation: "subscribe", subject: `topic.${i}`, subscribe_timeout: 0.3, timeout: 3 })));
    assert(results.every(r => r.messageCount === 0));
  } finally { await broker.close(); }
});

await test("F05 — 10 concurrent requests timeout cleanly", async () => {
  const broker = await startMockNats(null);
  try {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      natsClient({ host: "127.0.0.1", port: broker.port, operation: "request", subject: `svc.${i}`, payload: `r${i}`, request_timeout: 0.3, timeout: 3 })));
    assert(results.every(r => r.timedOut === true && r.replied === false));
  } finally { await broker.close(); }
});

// ============================================================================
// Summary
// ============================================================================
process.stdout.write(`\n${'='.repeat(60)}\n`);
process.stdout.write(`Section 196 — nats_client: ${passed}/${passed + failed} tests passed\n`);
if (failed > 0) process.exit(1);
else process.exit(0);

})();
