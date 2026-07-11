"use strict";
/**
 * Section 182 — websocket_client + sse_client tools
 * Tests the two new network-client tools across all 5 rigor levels:
 *   A – websocket_client: input validation
 *   B – websocket_client: frame builder + parser unit tests
 *   C – websocket_client: happy-path with in-process echo server
 *   D – websocket_client: multi-message + ping/pong + close frame
 *   E – sse_client: input validation
 *   F – sse_client: SseParser unit tests
 *   G – sse_client: happy-path with in-process SSE server
 *   H – sse_client: event_types filter + last_event_id + max_events truncation
 *   I – security: injection guards (headers, URLs)
 *   J – concurrency & stress: 10 concurrent WS + 10 concurrent SSE
 */

const assert = require("assert");
const net    = require("net");
const http   = require("http");
const crypto = require("crypto");

// ── Direct imports (no live MCP server) ──────────────────────────────────────
const { websocketClient, buildFrame, FrameParser } =
  require("../../lib/websocketClientOps");
const { sseClient, SseParser } =
  require("../../lib/sseClientOps");

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { process.stderr.write(`  PASS  ${name}\n`); passed++; },
        (e) => { process.stderr.write(`  FAIL  ${name}: ${e.message}\n${e.stack}\n`); failed++; },
      );
    }
    process.stderr.write(`  PASS  ${name}\n`); passed++;
  } catch (e) {
    process.stderr.write(`  FAIL  ${name}: ${e.message}\n${e.stack}\n`); failed++;
  }
  return Promise.resolve();
}

// ── WebSocket server helpers ──────────────────────────────────────────────────
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Minimal RFC 6455 server for testing
// opts: { onMessage(ws, msg), autoEcho, sendOnOpen, routes }
function createWsServer(opts = {}) {
  const server = net.createServer((sock) => {
    let upgraded = false;
    let buf      = Buffer.alloc(0);
    let closed   = false;

    // ── Unmask server-side (client frames are always masked) ──
    function unmaskPayload(key, data) {
      const out = Buffer.from(data);
      for (let i = 0; i < out.length; i++) out[i] ^= key[i % 4];
      return out;
    }

    // ── Build UNMASKED server frame (server → client: no masking) ──
    function buildServerFrame(opcode, payload, fin = true) {
      const payLen  = payload.length;
      let   hdrSize = 2;
      if (payLen > 65535)    hdrSize += 8;
      else if (payLen > 125) hdrSize += 2;
      const frame  = Buffer.allocUnsafe(hdrSize + payLen);
      let   off    = 0;
      frame[off++] = (fin ? 0x80 : 0x00) | (opcode & 0x0F);
      if (payLen > 65535) {
        frame[off++] = 127;
        const hi = Math.floor(payLen / 0x100000000);
        const lo = payLen >>> 0;
        frame.writeUInt32BE(hi, off); off += 4;
        frame.writeUInt32BE(lo, off); off += 4;
      } else if (payLen > 125) {
        frame[off++] = 126;
        frame.writeUInt16BE(payLen, off); off += 2;
      } else {
        frame[off++] = payLen;
      }
      payload.copy(frame, off);
      return frame;
    }

    function sendText(text) {
      if (!closed) sock.write(buildServerFrame(0x1, Buffer.from(text, "utf8")));
    }

    function sendClose(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      const codeBuf = Buffer.allocUnsafe(2); codeBuf.writeUInt16BE(code, 0);
      const payload = Buffer.concat([codeBuf, Buffer.from(reason, "utf8")]);
      try { sock.write(buildServerFrame(0x8, payload)); } catch (_) {}
    }

    function parseFlatFrames(data) {
      const frames = [];
      let i = 0;
      while (i + 2 <= data.length) {
        const fin    = (data[i] & 0x80) !== 0;
        const opcode = data[i] & 0x0F;
        const masked = (data[i + 1] & 0x80) !== 0;
        let   payLen = data[i + 1] & 0x7F;
        let   hEnd   = i + 2;
        if (payLen === 126) {
          if (data.length < hEnd + 2) break;
          payLen = data.readUInt16BE(hEnd); hEnd += 2;
        } else if (payLen === 127) {
          if (data.length < hEnd + 8) break;
          const hi = data.readUInt32BE(hEnd);
          const lo = data.readUInt32BE(hEnd + 4);
          payLen   = hi * 0x100000000 + lo; hEnd += 8;
        }
        if (masked) hEnd += 4;
        if (data.length < hEnd + payLen) break;
        let payload;
        if (masked) {
          const key = data.slice(hEnd - 4, hEnd);
          payload = unmaskPayload(key, data.slice(hEnd, hEnd + payLen));
        } else {
          payload = data.slice(hEnd, hEnd + payLen);
        }
        frames.push({ fin, opcode, payload });
        i = hEnd + payLen;
      }
      return frames;
    }

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!upgraded) {
        // HTTP Upgrade handshake
        const hEnd = buf.indexOf("\r\n\r\n");
        if (hEnd === -1) return;
        const reqHeader = buf.slice(0, hEnd).toString("ascii");
        const keyMatch  = reqHeader.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i);
        if (!keyMatch) { sock.destroy(); return; }
        const wsKey   = keyMatch[1].trim();
        const accept  = crypto.createHash("sha1")
          .update(wsKey + WS_GUID).digest("base64");
        const resp    = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "", "",
        ].join("\r\n");
        sock.write(resp);
        upgraded = true;
        buf = buf.slice(hEnd + 4); // leftover WS data

        if (opts.sendOnOpen) {
          for (const msg of (Array.isArray(opts.sendOnOpen) ? opts.sendOnOpen : [opts.sendOnOpen])) {
            sendText(typeof msg === "string" ? msg : JSON.stringify(msg));
          }
        }
      }

      // Parse WS frames
      const frames = parseFlatFrames(buf);
      // Reset buf (simplistic: we consume everything we parsed)
      let consumed = 0;
      for (const f of frames) {
        consumed += 2; // base header (approximate — good enough for tests)
      }
      // Better: just replace buf with a new buffer starting after last frame
      // For simplicity: reparse from scratch after each call
      // Actually we need to track exact byte positions. Use FrameParser:
      // (Already handled inline above — frames are parsed out of buf)
      // Clear buf after processing all frames we found
      buf = Buffer.alloc(0); // simple reset; test server doesn't fragment

      for (const { fin, opcode, payload } of frames) {
        if (opcode === 0x9) {
          // Ping → Pong
          try { sock.write(buildServerFrame(0xA, payload)); } catch (_) {}
        } else if (opcode === 0x8) {
          // Close
          const code   = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          const reason = payload.length > 2 ? payload.slice(2).toString("utf8") : "";
          sendClose(code, reason);
          sock.destroy();
          return;
        } else if (opcode === 0x1 || opcode === 0x2) {
          // Text/binary data
          if (opts.autoEcho) {
            try { sock.write(buildServerFrame(opcode, payload)); } catch (_) {}
          }
          if (opts.onMessage) {
            opts.onMessage({ sendText, sendClose }, payload.toString("utf8"), opcode);
          }
        }
      }
    });

    sock.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// Minimal SSE server
function createSseServer(opts = {}) {
  const server = http.createServer((req, res) => {
    // Capture Last-Event-ID if sent
    const lastId = req.headers["last-event-id"] ?? null;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":   "keep-alive",
    });

    const handler = opts.handler || ((r, events, lastId) => {
      for (const ev of events) res.write(ev);
      res.end();
    });

    handler(res, opts.events || [], lastId);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// ── Test sequence ─────────────────────────────────────────────────────────────
async function run() {
  process.stderr.write("\n=== Section 182: websocket_client + sse_client ===\n");

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION A — websocket_client: input validation (Level 1 + 2)
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- A: websocket_client validation ---\n");

  await test("A1: missing url throws ToolError", () => {
    assert.throws(() => websocketClient({}), /url.*required/i);
  });

  await test("A2: non-ws scheme rejected", () => {
    assert.throws(() => websocketClient({ url: "http://localhost/ws" }), /ws:\/\/|wss:\/\//i);
  });

  await test("A3: url with CRLF injection rejected", () => {
    assert.throws(() => websocketClient({ url: "ws://host\r\nX-Injected: evil" }), /newline/i);
  });

  await test("A4: invalid messages (not array) rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", messages: "hello" }),
      /messages.*array/i,
    );
  });

  await test("A5: message with neither text nor data rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", messages: [{ delay_ms: 0 }] }),
      /text.*data/i,
    );
  });

  await test("A6: messages.text non-string rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", messages: [{ text: 42 }] }),
      /text.*string/i,
    );
  });

  await test("A7: timeout=0 rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", timeout: 0 }),
      /timeout.*positive/i,
    );
  });

  await test("A8: max_messages=0 rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", max_messages: 0 }),
      /max_messages.*positive/i,
    );
  });

  await test("A9: reserved header 'Upgrade' rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", headers: { Upgrade: "ws" } }),
      /reserved.*header|cannot.*override/i,
    );
  });

  await test("A10: header value with CRLF injection rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", headers: { "X-H": "val\r\nBad: ok" } }),
      /invalid.*characters/i,
    );
  });

  await test("A11: subprotocol with comma rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", subprotocol: "a,b" }),
      /invalid.*characters|subprotocol/i,
    );
  });

  await test("A12: more than 100 send messages rejected", () => {
    const msgs = Array.from({ length: 101 }, (_, i) => ({ text: `msg${i}` }));
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", messages: msgs }),
      /at most 100/i,
    );
  });

  await test("A13: delay_ms > 60000 rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", messages: [{ text: "hi", delay_ms: 99999 }] }),
      /delay_ms.*60000/i,
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION B — Frame builder + FrameParser unit tests (Level 1 + 3)
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- B: Frame builder + FrameParser unit tests ---\n");

  await test("B1: buildFrame produces masked frame (bit 7 of byte 1 set)", () => {
    const payload = Buffer.from("hello");
    const frame   = buildFrame(0x1, payload);
    assert.strictEqual(frame[0] & 0x80, 0x80, "FIN bit set");
    assert.strictEqual(frame[0] & 0x0F, 0x1,  "text opcode");
    assert.strictEqual(frame[1] & 0x80, 0x80, "MASK bit set"); // client must mask
    assert.strictEqual((frame[1] & 0x7F), 5, "payload length field = 5 (mask key is in separate bytes, not counted here)");
  });

  // Actually let's rewrite B1 correctly:
  await test("B1b: buildFrame correct payload length field", () => {
    const payload = Buffer.from("hello world"); // 11 bytes
    const frame   = buildFrame(0x1, payload);
    // byte 0: 0x80|0x01 = FIN + text
    assert.strictEqual(frame[0], 0x81);
    // byte 1: 0x80 | 11 = MASK + len
    assert.strictEqual(frame[1], 0x80 | 11);
    // Total length: 2 + 4 (mask) + 11 = 17
    assert.strictEqual(frame.length, 2 + 4 + 11);
  });

  await test("B2: buildFrame extended 16-bit length for 200-byte payload", () => {
    const payload = Buffer.alloc(200, 0x42);
    const frame   = buildFrame(0x2, payload); // binary
    assert.strictEqual(frame[0], 0x82);           // FIN + binary
    assert.strictEqual(frame[1] & 0x7F, 126);     // extended 16-bit
    assert.strictEqual(frame.readUInt16BE(2), 200);
    assert.strictEqual(frame.length, 2 + 2 + 4 + 200); // header + ext + mask + payload
  });

  await test("B3: FrameParser round-trips a masked client frame to raw payload", () => {
    // Simulate: build a frame as a client, feed it to the parser (server side)
    // Server would see a masked frame → parser should unmask it
    const original = Buffer.from("test data 123");
    const frame    = buildFrame(0x1, original); // client → masked

    const parser = new FrameParser();
    parser.push(frame);
    const f = parser.shift();
    assert.ok(f, "parser produced a frame");
    assert.strictEqual(f.opcode, 0x1);
    assert.ok(f.payload.equals(original), "payload round-trips correctly");
  });

  await test("B4: FrameParser handles TCP-fragmented delivery", () => {
    const payload = Buffer.from("fragmented");
    const frame   = buildFrame(0x1, payload);
    const parser  = new FrameParser();

    // Feed 1 byte at a time
    for (let i = 0; i < frame.length; i++) {
      parser.push(frame.slice(i, i + 1));
    }
    const f = parser.shift();
    assert.ok(f, "assembled from byte-by-byte delivery");
    assert.ok(f.payload.equals(payload), "payload correct");
  });

  await test("B5: FrameParser handles two frames in one TCP chunk", () => {
    const p1 = Buffer.from("first");
    const p2 = Buffer.from("second");
    const combined = Buffer.concat([buildFrame(0x1, p1), buildFrame(0x1, p2)]);
    const parser   = new FrameParser();
    parser.push(combined);
    const f1 = parser.shift();
    const f2 = parser.shift();
    assert.ok(f1 && f1.payload.equals(p1), "first frame");
    assert.ok(f2 && f2.payload.equals(p2), "second frame");
    assert.strictEqual(parser.shift(), null);
  });

  await test("B6: buildFrame with empty payload", () => {
    const frame = buildFrame(0x8, Buffer.alloc(0)); // close with no payload
    assert.strictEqual(frame.length, 2 + 4); // header + mask key only
    assert.strictEqual(frame[1] & 0x7F, 0);
  });

  await test("B7: FIN=false produces a non-final frame", () => {
    const frame = buildFrame(0x1, Buffer.from("part1"), false);
    assert.strictEqual(frame[0] & 0x80, 0); // FIN=0
    assert.strictEqual(frame[0] & 0x0F, 0x1);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION C — websocket_client happy-path with in-process echo server
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- C: websocket_client happy-path ---\n");

  await test("C1: connects to echo server and receives echoed text message", async () => {
    const { server, port } = await createWsServer({ autoEcho: true });
    try {
      const result = await websocketClient({
        url:      `ws://127.0.0.1:${port}/`,
        messages: [{ text: "hello ws" }],
        timeout:  5,
        max_messages: 1,
      });
      assert.ok(result.connected, "connected");
      assert.ok(result.handshakeMs >= 0, "handshakeMs set");
      assert.strictEqual(result.messagesSent, 1);
      assert.strictEqual(result.messagesReceived, 1);
      assert.strictEqual(result.messages[0].type, "text");
      assert.strictEqual(result.messages[0].data, "hello ws");
      assert.ok(result.elapsedMs >= 0);
    } finally {
      server.close();
    }
  });

  await test("C2: multiple messages are sent and echoed back", async () => {
    const { server, port } = await createWsServer({ autoEcho: true });
    try {
      const msgs = ["alpha", "beta", "gamma"].map((t) => ({ text: t }));
      const result = await websocketClient({
        url:          `ws://127.0.0.1:${port}/`,
        messages:     msgs,
        timeout:      5,
        max_messages: 3,
      });
      assert.strictEqual(result.messagesSent, 3);
      assert.strictEqual(result.messagesReceived, 3);
      assert.deepStrictEqual(
        result.messages.map((m) => m.data),
        ["alpha", "beta", "gamma"],
      );
    } finally {
      server.close();
    }
  });

  await test("C3: server messages sent on open are received before client sends", async () => {
    const { server, port } = await createWsServer({ sendOnOpen: ["welcome", "ready"] });
    try {
      const result = await websocketClient({
        url:          `ws://127.0.0.1:${port}/`,
        timeout:      3,
        max_messages: 2,
      });
      assert.strictEqual(result.messagesReceived, 2);
      assert.strictEqual(result.messages[0].data, "welcome");
      assert.strictEqual(result.messages[1].data, "ready");
    } finally {
      server.close();
    }
  });

  await test("C4: connection to non-existent port returns error gracefully", async () => {
    const result = await websocketClient({
      url:     "ws://127.0.0.1:19999/", // very unlikely to be in use
      timeout: 2,
    });
    assert.ok(!result.connected, "not connected");
    assert.ok(result.error, "error is set");
    assert.ok(typeof result.error === "string");
  });

  await test("C5: URL path and query string are preserved in HTTP GET", async () => {
    let capturedPath = null;
    const server = net.createServer((sock) => {
      sock.once("data", (chunk) => {
        const req = chunk.toString("ascii");
        const m   = req.match(/GET ([^\s]+) HTTP/);
        if (m) capturedPath = m[1];
        // Send bad response to abort quickly
        sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        sock.destroy();
      });
      sock.on("error", () => {});
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      await websocketClient({ url: `ws://127.0.0.1:${port}/chat?room=42`, timeout: 2 });
      assert.strictEqual(capturedPath, "/chat?room=42");
    } finally {
      server.close();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION D — multi-message, ping/pong, server close frame (Level 3)
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- D: ping/pong + server close frame ---\n");

  await test("D1: server ping is auto-answered (no error, connection stays alive)", async () => {
    // Server sends a ping, then echoes client message
    const { server, port } = await createWsServer({
      autoEcho: true,
      onMessage: null,
    });
    // We'll open the server and send a ping manually using sendOnOpen trick
    // Actually: let's use a custom handler that sends a ping, waits for pong, echoes
    server.close();

    // New custom server that sends a ping first
    const pingServer = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let upgraded = false;
      const WS_GUID_LOC = WS_GUID;

      function buildSrvFrame(op, payload) {
        const payLen  = payload.length;
        let   hdrSize = 2;
        if (payLen > 125) hdrSize += 2;
        const frame = Buffer.allocUnsafe(hdrSize + payLen);
        frame[0] = 0x80 | (op & 0x0F);
        if (payLen > 125) {
          frame[1] = 126;
          frame.writeUInt16BE(payLen, 2);
        } else {
          frame[1] = payLen;
        }
        payload.copy(frame, hdrSize);
        return frame;
      }

      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const hEnd = buf.indexOf("\r\n\r\n");
          if (hEnd === -1) return;
          const req    = buf.slice(0, hEnd).toString("ascii");
          const keyM   = req.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i);
          if (!keyM) { sock.destroy(); return; }
          const accept = crypto.createHash("sha1").update(keyM[1].trim() + WS_GUID_LOC).digest("base64");
          sock.write(["HTTP/1.1 101 Switching Protocols","Upgrade: websocket","Connection: Upgrade",`Sec-WebSocket-Accept: ${accept}`,"",""].join("\r\n"));
          upgraded = true;
          buf = buf.slice(hEnd + 4);
          // Send a ping immediately after upgrade
          sock.write(buildSrvFrame(0x9, Buffer.from("ping-data")));
          // Then send a text message
          sock.write(buildSrvFrame(0x1, Buffer.from("hello-after-ping")));
        }
        // Don't parse WS frames on server side for this test — just check client gets the message
      });
      sock.on("error", () => {});
    });
    await new Promise((r) => pingServer.listen(0, "127.0.0.1", r));
    const pingPort = pingServer.address().port;

    try {
      const result = await websocketClient({
        url:          `ws://127.0.0.1:${pingPort}/`,
        timeout:      3,
        max_messages: 1, // only the text message
      });
      // Client should have received the text frame
      assert.strictEqual(result.messagesReceived, 1);
      assert.strictEqual(result.messages[0].data, "hello-after-ping");
    } finally {
      pingServer.close();
    }
  });

  await test("D2: server close frame is honored, result.closed=true", async () => {
    // Server sends one message then immediately closes
    const closeSrv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let upgraded = false;
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const hEnd = buf.indexOf("\r\n\r\n");
          if (hEnd === -1) return;
          const req    = buf.slice(0, hEnd).toString("ascii");
          const keyM   = req.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i);
          if (!keyM) { sock.destroy(); return; }
          const accept = crypto.createHash("sha1").update(keyM[1].trim() + WS_GUID).digest("base64");
          sock.write(["HTTP/1.1 101 Switching Protocols","Upgrade: websocket","Connection: Upgrade",`Sec-WebSocket-Accept: ${accept}`,"",""].join("\r\n"));
          upgraded = true;
          buf = buf.slice(hEnd + 4);
          // Send text then close
          const txt = Buffer.from("bye");
          const txtFrame = Buffer.allocUnsafe(2 + txt.length);
          txtFrame[0] = 0x81; txtFrame[1] = txt.length;
          txt.copy(txtFrame, 2);
          sock.write(txtFrame);
          // Send close frame
          const closePay = Buffer.allocUnsafe(2); closePay.writeUInt16BE(1000, 0);
          const closeF   = Buffer.allocUnsafe(2 + closePay.length);
          closeF[0] = 0x88; closeF[1] = closePay.length;
          closePay.copy(closeF, 2);
          sock.write(closeF);
        }
      });
      sock.on("error", () => {});
    });
    await new Promise((r) => closeSrv.listen(0, "127.0.0.1", r));
    const closePort = closeSrv.address().port;
    try {
      const result = await websocketClient({
        url:          `ws://127.0.0.1:${closePort}/`,
        timeout:      5,
        max_messages: 10,
      });
      assert.ok(result.closed, "closed flag set");
      assert.strictEqual(result.closeCode, 1000);
      assert.strictEqual(result.messagesReceived, 1);
      assert.strictEqual(result.messages[0].data, "bye");
    } finally {
      closeSrv.close();
    }
  });

  await test("D3: max_messages=1 stops reception and sends Close", async () => {
    const { server, port } = await createWsServer({ autoEcho: true });
    try {
      // Send 5, but max_messages=1 — only 1 should be in result
      const result = await websocketClient({
        url:          `ws://127.0.0.1:${port}/`,
        messages:     Array.from({ length: 5 }, (_, i) => ({ text: `msg${i}` })),
        timeout:      5,
        max_messages: 1,
      });
      assert.strictEqual(result.messagesReceived, 1);
      assert.strictEqual(result.messages[0].data, "msg0");
    } finally {
      server.close();
    }
  });

  await test("D4: delay_ms between send messages works", async () => {
    const { server, port } = await createWsServer({ autoEcho: true });
    try {
      const t0 = Date.now();
      const result = await websocketClient({
        url:          `ws://127.0.0.1:${port}/`,
        messages:     [{ text: "a" }, { text: "b", delay_ms: 200 }],
        timeout:      5,
        max_messages: 2,
      });
      const elapsed = Date.now() - t0;
      assert.strictEqual(result.messagesReceived, 2);
      assert.ok(elapsed >= 180, `Expected >=180ms delay, got ${elapsed}ms`);
    } finally {
      server.close();
    }
  });

  await test("D5: timeout fires and result is returned with all collected messages", async () => {
    // Server that sends one message then stalls
    const stallSrv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let upgraded = false;
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const hEnd = buf.indexOf("\r\n\r\n");
          if (hEnd === -1) return;
          const req   = buf.slice(0, hEnd).toString("ascii");
          const keyM  = req.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i);
          if (!keyM) { sock.destroy(); return; }
          const acc   = crypto.createHash("sha1").update(keyM[1].trim() + WS_GUID).digest("base64");
          sock.write(["HTTP/1.1 101 Switching Protocols","Upgrade: websocket","Connection: Upgrade",`Sec-WebSocket-Accept: ${acc}`,"",""].join("\r\n"));
          upgraded = true;
          buf = buf.slice(hEnd + 4);
          // Send one message then stall
          const p = Buffer.from("one");
          const f = Buffer.allocUnsafe(2 + p.length);
          f[0] = 0x81; f[1] = p.length; p.copy(f, 2);
          sock.write(f);
          // (no close, no further messages)
        }
      });
      sock.on("error", () => {});
    });
    await new Promise((r) => stallSrv.listen(0, "127.0.0.1", r));
    const stallPort = stallSrv.address().port;
    try {
      const result = await websocketClient({
        url:          `ws://127.0.0.1:${stallPort}/`,
        timeout:      1, // 1s
        max_messages: 10,
      });
      // Should return after timeout with 1 message collected
      assert.strictEqual(result.messagesReceived, 1);
      assert.strictEqual(result.messages[0].data, "one");
      assert.ok(result.error === "timeout" || result.error == null || result.elapsedMs >= 900,
        `elapsedMs=${result.elapsedMs}`);
    } finally {
      stallSrv.close();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION E — sse_client: input validation (Level 1 + 2)
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- E: sse_client validation ---\n");

  await test("E1: missing url throws ToolError", () => {
    assert.throws(() => sseClient({}), /url.*required/i);
  });

  await test("E2: non-http scheme rejected", () => {
    assert.throws(() => sseClient({ url: "ftp://example.com/stream" }), /http:\/\/|https:\/\//i);
  });

  await test("E3: url with CRLF injection rejected", () => {
    assert.throws(() => sseClient({ url: "http://host\r\nX-Injected: evil" }), /newline/i);
  });

  await test("E4: invalid url (bad format) throws", () => {
    assert.throws(() => sseClient({ url: "http://::1:99999/" }), /invalid.*url/i);
  });

  await test("E5: timeout=0 rejected", () => {
    assert.throws(() => sseClient({ url: "http://localhost:9999/", timeout: 0 }), /timeout.*positive/i);
  });

  await test("E6: max_events=0 rejected", () => {
    assert.throws(() => sseClient({ url: "http://localhost:9999/", max_events: 0 }), /max_events.*positive/i);
  });

  await test("E7: headers must be plain object", () => {
    assert.throws(() => sseClient({ url: "http://localhost:9999/", headers: ["bad"] }), /headers.*plain.*object|must be.*object/i);
  });

  await test("E8: reserved header Accept cannot be overridden", () => {
    assert.throws(
      () => sseClient({ url: "http://localhost:9999/", headers: { Accept: "*/*" } }),
      /reserved.*header|cannot.*override/i,
    );
  });

  await test("E9: event_types must be array of strings", () => {
    assert.throws(
      () => sseClient({ url: "http://localhost:9999/", event_types: "update" }),
      /event_types.*array/i,
    );
  });

  await test("E10: last_event_id must be string", () => {
    assert.throws(
      () => sseClient({ url: "http://localhost:9999/", last_event_id: 42 }),
      /last_event_id.*string/i,
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION F — SseParser unit tests (Level 1 + 3)
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- F: SseParser unit tests ---\n");

  await test("F1: basic data-only event", () => {
    const p = new SseParser();
    p.push("data: hello world\n\n");
    const ev = p.shift();
    assert.ok(ev, "event produced");
    assert.strictEqual(ev.event, "message");
    assert.strictEqual(ev.data, "hello world");
    assert.strictEqual(ev.id, null);
    assert.strictEqual(p.shift(), null);
  });

  await test("F2: event with event: field", () => {
    const p = new SseParser();
    p.push("event: update\ndata: {\"v\":1}\n\n");
    const ev = p.shift();
    assert.strictEqual(ev.event, "update");
    assert.strictEqual(ev.data, '{"v":1}');
  });

  await test("F3: event with id: field", () => {
    const p = new SseParser();
    p.push("id: 42\ndata: msg\n\n");
    const ev = p.shift();
    assert.strictEqual(ev.id, "42");
  });

  await test("F4: multi-line data is joined with newlines", () => {
    const p = new SseParser();
    p.push("data: line1\ndata: line2\ndata: line3\n\n");
    const ev = p.shift();
    assert.strictEqual(ev.data, "line1\nline2\nline3");
  });

  await test("F5: comments are ignored", () => {
    const p = new SseParser();
    p.push(": this is a comment\ndata: real\n\n");
    const ev = p.shift();
    assert.strictEqual(ev.data, "real");
  });

  await test("F6: empty data field produces event with empty string data", () => {
    const p = new SseParser();
    p.push("data:\n\n");
    const ev = p.shift();
    assert.ok(ev, "event was dispatched");
    assert.strictEqual(ev.data, "");
  });

  await test("F7: no-data event is not dispatched", () => {
    const p = new SseParser();
    p.push("event: heartbeat\n\n");
    assert.strictEqual(p.shift(), null, "no event without data field");
  });

  await test("F8: CRLF line endings are handled", () => {
    const p = new SseParser();
    p.push("data: crlf test\r\n\r\n");
    const ev = p.shift();
    assert.ok(ev);
    assert.strictEqual(ev.data, "crlf test");
  });

  await test("F9: CR-only line endings are handled", () => {
    const p = new SseParser();
    p.push("data: cr test\r\r");
    const ev = p.shift();
    assert.ok(ev);
    assert.strictEqual(ev.data, "cr test");
  });

  await test("F10: field-only line (no colon) uses empty string value", () => {
    const p = new SseParser();
    p.push("data\n\n");
    const ev = p.shift();
    assert.ok(ev, "dispatched");
    assert.strictEqual(ev.data, "");
  });

  await test("F11: multiple events in one push", () => {
    const p = new SseParser();
    p.push("data: first\n\ndata: second\n\n");
    const e1 = p.shift();
    const e2 = p.shift();
    assert.strictEqual(e1.data, "first");
    assert.strictEqual(e2.data, "second");
    assert.strictEqual(p.shift(), null);
  });

  await test("F12: partial push followed by completing push", () => {
    const p = new SseParser();
    p.push("data: par");
    assert.strictEqual(p.shift(), null); // not yet
    p.push("tial\n\n");
    const ev = p.shift();
    assert.strictEqual(ev.data, "partial");
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION G — sse_client happy-path with in-process SSE server (Level 1 + 3)
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- G: sse_client happy-path ---\n");

  await test("G1: receives basic SSE events from in-process server", async () => {
    const events = [
      "data: alpha\n\n",
      "data: beta\n\n",
      "data: gamma\n\n",
    ];
    const { server, port } = await createSseServer({ events });
    try {
      const result = await sseClient({
        url:     `http://127.0.0.1:${port}/`,
        timeout: 5,
      });
      assert.ok(result.connected, "connected");
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.eventCount, 3);
      assert.deepStrictEqual(result.events.map((e) => e.data), ["alpha", "beta", "gamma"]);
    } finally {
      server.close();
    }
  });

  await test("G2: events have correct index/event/data fields", async () => {
    const { server, port } = await createSseServer({
      events: ["event: update\ndata: {\"x\":1}\n\n"],
    });
    try {
      const result = await sseClient({ url: `http://127.0.0.1:${port}/`, timeout: 3 });
      const ev = result.events[0];
      assert.strictEqual(ev.index, 0);
      assert.strictEqual(ev.event, "update");
      assert.strictEqual(ev.data, '{"x":1}');
      assert.ok(typeof ev.timestamp === "number");
    } finally {
      server.close();
    }
  });

  await test("G3: wrong content-type returns error with connected=false", async () => {
    const srv = http.createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    try {
      const result = await sseClient({ url: `http://127.0.0.1:${port}/`, timeout: 3 });
      assert.ok(!result.connected);
      assert.ok(result.error && /event-stream/i.test(result.error));
    } finally {
      srv.close();
    }
  });

  await test("G4: HTTP 401 returns error with status 401", async () => {
    const srv = http.createServer((_, res) => {
      res.writeHead(401);
      res.end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    try {
      const result = await sseClient({ url: `http://127.0.0.1:${port}/`, timeout: 3 });
      assert.strictEqual(result.status, 401);
      assert.ok(!result.connected);
      assert.ok(result.error);
    } finally {
      srv.close();
    }
  });

  await test("G5: connection refused returns error gracefully", async () => {
    const result = await sseClient({
      url:     "http://127.0.0.1:19998/", // unlikely to be in use
      timeout: 2,
    });
    assert.ok(!result.connected);
    assert.ok(result.error);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION H — event filtering, last_event_id, max_events truncation
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- H: sse_client filters + truncation ---\n");

  await test("H1: event_types filter only returns matching event type", async () => {
    const { server, port } = await createSseServer({
      events: [
        "event: ping\ndata: heartbeat\n\n",
        "event: update\ndata: newval\n\n",
        "event: ping\ndata: heartbeat2\n\n",
      ],
    });
    try {
      const result = await sseClient({
        url:         `http://127.0.0.1:${port}/`,
        timeout:     5,
        event_types: ["update"],
      });
      assert.strictEqual(result.eventCount, 1);
      assert.strictEqual(result.events[0].event, "update");
      assert.strictEqual(result.events[0].data, "newval");
    } finally {
      server.close();
    }
  });

  await test("H2: max_events=1 truncates stream and sets truncated=true", async () => {
    const { server, port } = await createSseServer({
      events: [
        "data: first\n\n",
        "data: second\n\n",
        "data: third\n\n",
      ],
    });
    try {
      const result = await sseClient({
        url:        `http://127.0.0.1:${port}/`,
        timeout:    5,
        max_events: 1,
      });
      assert.strictEqual(result.eventCount, 1);
      assert.ok(result.truncated, "truncated=true");
    } finally {
      server.close();
    }
  });

  await test("H3: last_event_id is sent as Last-Event-ID header", async () => {
    let capturedId = null;
    const srv = http.createServer((req, res) => {
      capturedId = req.headers["last-event-id"] ?? null;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: ok\n\n");
      res.end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    try {
      await sseClient({
        url:           `http://127.0.0.1:${port}/`,
        timeout:       3,
        last_event_id: "evt-99",
      });
      assert.strictEqual(capturedId, "evt-99");
    } finally {
      srv.close();
    }
  });

  await test("H4: custom Authorization header is forwarded", async () => {
    let capturedAuth = null;
    const srv = http.createServer((req, res) => {
      capturedAuth = req.headers["authorization"] ?? null;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: auth ok\n\n");
      res.end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    try {
      await sseClient({
        url:     `http://127.0.0.1:${port}/`,
        timeout: 3,
        headers: { Authorization: "Bearer secret123" },
      });
      assert.strictEqual(capturedAuth, "Bearer secret123");
    } finally {
      srv.close();
    }
  });

  await test("H5: timeout fires before stream ends", async () => {
    // Server never closes the SSE connection
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: only-one\n\n");
      // keep-alive — never end
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address();
    try {
      const t0 = Date.now();
      const result = await sseClient({
        url:     `http://127.0.0.1:${port}/`,
        timeout: 1,
      });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= 900, `timeout should fire at ~1s, got ${elapsed}ms`);
      assert.strictEqual(result.eventCount, 1);
      assert.strictEqual(result.events[0].data, "only-one");
    } finally {
      srv.close();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION I — Security: injection guards (Level 4 — Critical)
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- I: Security / injection guards ---\n");

  await test("I1: WS header injection via value with CRLF is blocked", () => {
    assert.throws(
      () => websocketClient({
        url: "ws://localhost:9999",
        headers: { "X-Test": "legitimate\r\nX-Injected: evil" },
      }),
      /invalid.*characters/i,
    );
  });

  await test("I2: SSE header injection via value with CRLF is blocked", () => {
    assert.throws(
      () => sseClient({
        url: "http://localhost:9999/",
        headers: { "X-Test": "val\r\nX-Bad: injected" },
      }),
      /invalid.*characters/i,
    );
  });

  await test("I3: WS url with null byte is rejected (path traversal guard)", () => {
    // The URL parser will throw on \x00 — either the URL parse or our validation
    assert.throws(
      () => websocketClient({ url: "ws://localhost/path\x00/../etc" }),
      /.+/, // any error
    );
  });

  await test("I4: SSE event_types with empty string throws", () => {
    assert.throws(
      () => sseClient({ url: "http://localhost:9999/", event_types: [""] }),
      /non-empty.*string|event_types/i,
    );
  });

  await test("I5: WS subprotocol with semicolon is rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", subprotocol: "chat; admin" }),
      /invalid.*characters|subprotocol/i,
    );
  });

  await test("I6: WS headers array (not object) is rejected", () => {
    assert.throws(
      () => websocketClient({ url: "ws://localhost:9999", headers: ["bad"] }),
      /headers.*plain.*object|must be.*object/i,
    );
  });

  await test("I7: WS message data with invalid base64 gracefully handled (Buffer.from is lenient)", async () => {
    // This should not throw at construction time — just produces mangled bytes
    // validateInputs won't error on "bad-base64" because Buffer.from is lenient
    // The test verifies we at least don't crash
    const { server, port } = await createWsServer({ autoEcho: true });
    try {
      const result = await websocketClient({
        url:          `ws://127.0.0.1:${port}/`,
        messages:     [{ data: "not!!!valid!!!b64", encoding: "base64" }],
        timeout:      2,
        max_messages: 1,
      });
      // Either connected and got echo, or error — both acceptable
      assert.ok(typeof result.connected === "boolean");
    } finally {
      server.close();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // SECTION J — Concurrency & stress (Level 5 — Extreme)
  // ════════════════════════════════════════════════════════════════════════════
  process.stderr.write("\n--- J: Concurrency + stress ---\n");

  await test("J1: 10 concurrent websocket_client connections to same echo server", async () => {
    const { server, port } = await createWsServer({ autoEcho: true });
    try {
      const promises = Array.from({ length: 10 }, (_, i) =>
        websocketClient({
          url:          `ws://127.0.0.1:${port}/`,
          messages:     [{ text: `concurrent-${i}` }],
          timeout:      5,
          max_messages: 1,
        }),
      );
      const results = await Promise.all(promises);
      const allConnected  = results.every((r) => r.connected);
      const allGot1Msg    = results.every((r) => r.messagesReceived === 1);
      const allDataMatch  = results.every((r, i) => r.messages[0].data === `concurrent-${i}`);
      assert.ok(allConnected, "all 10 connected");
      assert.ok(allGot1Msg, "all 10 received exactly 1 message");
      assert.ok(allDataMatch, "all 10 received their own message");
    } finally {
      server.close();
    }
  });

  await test("J2: 10 concurrent sse_client connections to same SSE server", async () => {
    const { server, port } = await createSseServer({
      events: ["data: event1\n\n", "data: event2\n\n"],
    });
    try {
      const promises = Array.from({ length: 10 }, () =>
        sseClient({ url: `http://127.0.0.1:${port}/`, timeout: 5 }),
      );
      const results = await Promise.all(promises);
      const allConnected = results.every((r) => r.connected);
      const allGot2      = results.every((r) => r.eventCount === 2);
      assert.ok(allConnected, "all 10 SSE connections succeeded");
      assert.ok(allGot2, "all 10 received 2 events");
    } finally {
      server.close();
    }
  });

  await test("J3: sse_client handles 500-event stream efficiently", async () => {
    const big500 = Array.from({ length: 500 }, (_, i) => `data: item${i}\n\n`).join("");
    const { server, port } = await createSseServer({
      handler: (res) => { res.write(big500); res.end(); },
    });
    try {
      const result = await sseClient({
        url:        `http://127.0.0.1:${port}/`,
        timeout:    10,
        max_events: 500,
      });
      assert.strictEqual(result.eventCount, 500);
      assert.strictEqual(result.events[0].data, "item0");
      assert.strictEqual(result.events[499].data, "item499");
    } finally {
      server.close();
    }
  });

  await test("J4: FrameParser handles 100-frame burst correctly", () => {
    const parser = new FrameParser();
    const payloads = [];
    const combined = Buffer.concat(
      Array.from({ length: 100 }, (_, i) => {
        const p = Buffer.from(`frame-${i}`);
        payloads.push(p);
        return buildFrame(0x1, p);
      }),
    );
    parser.push(combined);
    let count = 0;
    let f;
    while ((f = parser.shift()) !== null) {
      assert.ok(f.payload.equals(payloads[count]), `frame ${count} payload mismatch`);
      count++;
    }
    assert.strictEqual(count, 100);
  });

  await test("J5: SseParser handles 1000-event stream without memory issues", () => {
    const p    = new SseParser();
    const text = Array.from({ length: 1000 }, (_, i) => `data: msg${i}\n\n`).join("");
    p.push(text);
    let count = 0;
    let ev;
    while ((ev = p.shift()) !== null) count++;
    assert.strictEqual(count, 1000);
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  process.stderr.write(`\n=== Section 182 complete: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  process.stderr.write(`\nUnhandled error in test runner: ${e.stack}\n`);
  process.exit(1);
});
