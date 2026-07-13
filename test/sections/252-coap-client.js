"use strict";
/**
 * Section 252 — coap_client tests
 * 76 tests across 6 rigor levels:
 *   A. Validation / schema           (10 tests)
 *   B. Unit / packet codec           (20 tests)
 *   C. Mock-network happy-path       (20 tests)
 *   D. Security                      (10 tests)
 *   E. Error paths                   (10 tests)
 *   F. Concurrency / stress          ( 6 tests)
 *                                  ──────────
 *   Total                            76
 */

const dgram  = require("dgram");
const crypto = require("crypto");
const assert = require("assert");

const {
  coapClient,
  buildPacket,
  parsePacket,
  encodeOptions,
  parseLinkFormat,
  parseCoapUri,
} = require("../../lib/coapClientOps");

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

function ok(condition, label) {
  if (condition) {
    passed++;
    results.push(`  PASS: ${label}`);
  } else {
    failed++;
    results.push(`  FAIL: ${label}`);
  }
}

async function assertRejects(fn, pattern, label) {
  try {
    await fn();
    failed++;
    results.push(`  FAIL: ${label} (expected rejection, got success)`);
  } catch (e) {
    const match = pattern instanceof RegExp ? pattern.test(e.message) : e.message.includes(pattern);
    if (match) {
      passed++;
      results.push(`  PASS: ${label}`);
    } else {
      failed++;
      results.push(`  FAIL: ${label} (error: ${e.message})`);
    }
  }
}

function assertThrows(fn, pattern, label) {
  try {
    fn();
    failed++;
    results.push(`  FAIL: ${label} (expected throw, got success)`);
  } catch (e) {
    const match = pattern instanceof RegExp ? pattern.test(e.message) : e.message.includes(pattern);
    if (match) {
      passed++;
      results.push(`  PASS: ${label}`);
    } else {
      failed++;
      results.push(`  FAIL: ${label} (error: ${e.message})`);
    }
  }
}

function startMockCoAPServer(handler) {
  return new Promise((resolve) => {
    const server = dgram.createSocket("udp4");
    server.on("message", (msg, rinfo) => {
      try { handler(server, msg, rinfo); } catch (_) {}
    });
    server.on("error", () => {});
    server.bind(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, close: () => new Promise(r => server.close(r)) });
    });
  });
}

function makeAckResponse(reqMsgId, reqToken, payloadStr) {
  const CODE_CONTENT = 0x45;
  const TYPE_ACK = 2;
  const tkl = reqToken.length;
  const header = Buffer.alloc(4);
  header[0] = ((1 & 0x3) << 6) | ((TYPE_ACK & 0x3) << 4) | (tkl & 0xF);
  header[1] = CODE_CONTENT;
  header.writeUInt16BE(reqMsgId, 2);
  const payload = Buffer.from(payloadStr, "utf8");
  return Buffer.concat([header, reqToken, Buffer.from([0xFF]), payload]);
}

function makeCreatedAck(reqMsgId, reqToken) {
  const CODE_CREATED = 0x41;
  const TYPE_ACK = 2;
  const tkl = reqToken.length;
  const header = Buffer.alloc(4);
  header[0] = ((1 & 0x3) << 6) | ((TYPE_ACK & 0x3) << 4) | (tkl & 0xF);
  header[1] = CODE_CREATED;
  header.writeUInt16BE(reqMsgId, 2);
  return Buffer.concat([header, reqToken]);
}

function makeRstResponse(reqMsgId) {
  const TYPE_RST = 3;
  const header = Buffer.alloc(4);
  header[0] = ((1 & 0x3) << 6) | ((TYPE_RST & 0x3) << 4) | 0;
  header[1] = 0x00;
  header.writeUInt16BE(reqMsgId, 2);
  return header;
}

function makeNotFoundAck(reqMsgId, reqToken) {
  const CODE_NOT_FOUND = 0x84;
  const TYPE_ACK = 2;
  const tkl = reqToken.length;
  const header = Buffer.alloc(4);
  header[0] = ((1 & 0x3) << 6) | ((TYPE_ACK & 0x3) << 4) | (tkl & 0xF);
  header[1] = CODE_NOT_FOUND;
  header.writeUInt16BE(reqMsgId, 2);
  return Buffer.concat([header, reqToken]);
}

function parseIncomingBasics(buf) {
  const msgId = buf.readUInt16BE(2);
  const tkl   = buf[0] & 0xF;
  const token = buf.slice(4, 4 + tkl);
  return { msgId, token };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Validation / schema (10 tests)
// ─────────────────────────────────────────────────────────────────────────────
async function sectionA() {
  console.log("\nA. Validation / schema");

  await assertRejects(() => coapClient({}), "operation",
    "A01: rejects missing operation");

  await assertRejects(() => coapClient({ operation: "read" }), "unknown operation",
    "A02: rejects unknown operation");

  const r = await coapClient({ operation: "info" });
  ok(r.ok === true, "A03: info ok:true");
  ok(Array.isArray(r.operations) && r.operations.includes("get"), "A03: info has operations list");

  ok(r.port === 5683, "A04: info default port is 5683");

  ok(r.confirmable === true, "A05: info confirmable defaults to true");

  const rLow = await coapClient({ operation: "info", timeout: 0 });
  ok(rLow.timeoutMs >= 500, "A06: timeout clamped to >= 500ms");

  const rHigh = await coapClient({ operation: "info", timeout: 999999 });
  ok(rHigh.timeoutMs <= 60000, "A07: timeout clamped to <= 60000ms");

  const rCustom = await coapClient({ operation: "info", host: "10.0.0.1", port: 5684 });
  ok(rCustom.port === 5684 && rCustom.host === "10.0.0.1", "A08: custom host/port accepted");

  const rNon = await coapClient({ operation: "info", confirmable: false });
  ok(rNon.confirmable === false, "A09: NON mode accepted");

  ok(r.contentFormats && r.contentFormats["application/json"] === 50, "A10: content formats include json=50");
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Unit / packet codec (20 tests)
// ─────────────────────────────────────────────────────────────────────────────
async function sectionB() {
  console.log("\nB. Unit / packet codec");

  // B01-B04: buildPacket
  const pktCon = buildPacket({ type: 0, code: 0x01, msgId: 1, token: null, options: [], payload: null });
  ok(pktCon.length >= 4, "B01: buildPacket produces >= 4 bytes");
  ok(pktCon[0] === 0x40, "B01: byte0 = 0x40 for CON GET no-token");

  const pktId = buildPacket({ type: 1, code: 0x01, msgId: 0xABCD, token: null, options: [], payload: null });
  ok(pktId.readUInt16BE(2) === 0xABCD, "B02: message ID encoded big-endian");

  const token4 = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
  const pktTok = buildPacket({ type: 0, code: 0x01, msgId: 1, token: token4, options: [], payload: null });
  ok((pktTok[0] & 0xF) === 4, "B03: TKL nibble is 4");
  ok(pktTok.slice(4, 8).equals(token4), "B03: token bytes present in packet");

  const payload4 = Buffer.from("hello");
  const pktPay = buildPacket({ type: 0, code: 0x01, msgId: 1, token: null, options: [], payload: payload4 });
  const ffIdx = pktPay.indexOf(0xFF, 4);
  ok(ffIdx !== -1, "B04: 0xFF payload marker present");
  ok(pktPay.slice(ffIdx + 1).equals(payload4), "B04: payload follows 0xFF marker");

  // B05: round-trip
  const tknRt  = crypto.randomBytes(4);
  const payRt  = Buffer.from("test payload");
  const pktRt  = buildPacket({ type: 0, code: 0x01, msgId: 0x1234, token: tknRt, options: [], payload: payRt });
  const parsed = parsePacket(pktRt);
  ok(parsed.type === 0 && parsed.code === 0x01 && parsed.msgId === 0x1234, "B05: round-trip header");
  ok(parsed.token.equals(tknRt) && parsed.payload.equals(payRt), "B05: round-trip token/payload");

  // B06-B09: parsePacket error cases
  assertThrows(() => parsePacket(Buffer.from([0x40, 0x01])), "too short", "B06: too short throws");
  assertThrows(() => parsePacket(Buffer.from([0x80, 0x01, 0x00, 0x01])), "version", "B07: bad version throws");
  assertThrows(() => parsePacket(Buffer.from([0x40 | 9, 0x01, 0x00, 0x01])), "TKL", "B08: TKL>8 throws");
  assertThrows(() => parsePacket(Buffer.from([0x40, 0x01, 0x00, 0x01, 0xFF])), "no payload bytes", "B09: empty payload after 0xFF throws");

  // B10-B12: encodeOptions
  const encSorted = encodeOptions([
    { number: 11, value: "temp" },
    { number: 3,  value: "host" },
  ]);
  ok(((encSorted[0] >> 4) & 0xF) === 3, "B10: options sorted ascending (first delta=3)");

  const encNum = encodeOptions([{ number: 12, value: 50 }]);
  ok((encNum[0] & 0xF) === 1, "B11: number value 50 → len nibble=1");

  const encZero = encodeOptions([{ number: 6, value: 0 }]);
  ok((encZero[0] & 0xF) === 0, "B12: value=0 encodes as empty (len nibble=0)");

  // B13-B14: parseLinkFormat
  const lf = parseLinkFormat("</sensors/temp>;rt=\"temperature\",</actuators/led>;if=\"core.a\"");
  ok(lf.length === 2 && lf[0].uri === "/sensors/temp", "B13: parseLinkFormat extracts URIs");
  ok(lf[0].attributes.rt === "temperature", "B13: parseLinkFormat extracts attributes");
  const lfFlag = parseLinkFormat("</time>;obs");
  ok(lfFlag[0].attributes.obs === true, "B14: flag attribute is true");

  // B15-B18: parseCoapUri
  const pu1 = parseCoapUri("coap://192.168.1.10:1234/sensors/temp?unit=celsius", "127.0.0.1", 5683);
  ok(pu1.host === "192.168.1.10" && pu1.port === 1234, "B15: full URI host/port");
  ok(JSON.stringify(pu1.pathSegments) === JSON.stringify(["sensors","temp"]), "B15: full URI path segments");

  const pu2 = parseCoapUri("coap://[::1]:5683/path", "127.0.0.1", 5683);
  ok(pu2.host === "::1", "B16: IPv6 bracket notation");

  const pu3 = parseCoapUri("/sensors/temp", "10.0.0.1", 5683);
  ok(pu3.host === "10.0.0.1" && JSON.stringify(pu3.pathSegments) === JSON.stringify(["sensors","temp"]), "B17: bare path uses defaults");

  const pu4 = parseCoapUri(null, "127.0.0.1", 5683);
  ok(pu4.host === "127.0.0.1", "B18: null uri uses defaults");

  // B19-B20: NON type and response code string
  const pktNon = buildPacket({ type: 1, code: 0x01, msgId: 1, token: null, options: [], payload: null });
  ok(((pktNon[0] >> 4) & 0x3) === 1, "B19: NON type nibble=1");

  const pktAck = buildPacket({ type: 2, code: 0x45, msgId: 0x42, token: Buffer.alloc(0), options: [], payload: Buffer.from("OK") });
  const parsedAck = parsePacket(pktAck);
  ok(parsedAck.codeStr === "2.05 Content", "B20: 2.05 Content code string");
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Mock-network happy-path (20 tests)
// ─────────────────────────────────────────────────────────────────────────────
async function sectionC() {
  console.log("\nC. Mock-network happy-path");

  // C01: GET ok:true
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "25.5");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: "/sensors/temp", timeout: 3000 });
      ok(r.ok === true && r.operation === "get", "C01: GET ok:true");
    } finally { await mock.close(); }
  }

  // C02: GET elapsedMs
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "ok");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: "/", timeout: 3000 });
      ok(typeof r.elapsedMs === "number" && r.elapsedMs >= 0, "C02: elapsedMs is non-negative number");
    } finally { await mock.close(); }
  }

  // C03: POST 2.01 Created
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeCreatedAck(msgId, token);
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "post", host: "127.0.0.1", port: mock.port, uri: "/resources", payload: "data", timeout: 3000 });
      ok(r.ok === true && r.code.startsWith("2.01"), "C03: POST 2.01 Created");
    } finally { await mock.close(); }
  }

  // C04: PUT 2.04 Changed
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const CODE_CHANGED = 0x44; const TYPE_ACK = 2;
      const hdr = Buffer.alloc(4);
      hdr[0] = ((1 & 0x3) << 6) | ((TYPE_ACK & 0x3) << 4) | token.length;
      hdr[1] = CODE_CHANGED; hdr.writeUInt16BE(msgId, 2);
      const resp = Buffer.concat([hdr, token]);
      sock.send(resp, 0, resp.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "put", host: "127.0.0.1", port: mock.port, uri: "/config", payload: "val=1", timeout: 3000 });
      ok(r.ok === true && r.code.startsWith("2.04"), "C04: PUT 2.04 Changed");
    } finally { await mock.close(); }
  }

  // C05: DELETE 2.02 Deleted
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const CODE_DELETED = 0x42; const TYPE_ACK = 2;
      const hdr = Buffer.alloc(4);
      hdr[0] = ((1 & 0x3) << 6) | ((TYPE_ACK & 0x3) << 4) | token.length;
      hdr[1] = CODE_DELETED; hdr.writeUInt16BE(msgId, 2);
      const resp = Buffer.concat([hdr, token]);
      sock.send(resp, 0, resp.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "delete", host: "127.0.0.1", port: mock.port, uri: "/resource/1", timeout: 3000 });
      ok(r.ok === true && r.code.startsWith("2.02"), "C05: DELETE 2.02 Deleted");
    } finally { await mock.close(); }
  }

  // C06: ping → RST → reachable:true
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId } = parseIncomingBasics(msg);
      const rst = makeRstResponse(msgId);
      sock.send(rst, 0, rst.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "ping", host: "127.0.0.1", port: mock.port, timeout: 3000 });
      ok(r.ok === true && r.reachable === true, "C06: ping reachable:true");
    } finally { await mock.close(); }
  }

  // C07: NON GET works
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "NON response");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: "/data", confirmable: false, timeout: 3000 });
      ok(r.ok === true, "C07: NON GET succeeds");
    } finally { await mock.close(); }
  }

  // C08: token field is 8-char hex
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "data");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: "/", timeout: 3000 });
      ok(typeof r.token === "string" && r.token.length === 8, "C08: token is 8-char hex");
    } finally { await mock.close(); }
  }

  // C09: code is '2.05 Content'
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "hello");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: "/", timeout: 3000 });
      ok(r.code === "2.05 Content", "C09: code is '2.05 Content'");
    } finally { await mock.close(); }
  }

  // C10: full coap:// URI overrides host arg
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "uri-test");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", uri: `coap://127.0.0.1:${mock.port}/test`, timeout: 3000 });
      ok(r.ok === true && r.payload && r.payload.includes("uri-test"), "C10: full coap:// URI");
    } finally { await mock.close(); }
  }

  // C11: 4.04 → ok:false
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeNotFoundAck(msgId, token);
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: "/missing", timeout: 3000 });
      ok(r.ok === false && r.code.startsWith("4.04"), "C11: 4.04 Not Found → ok:false");
      ok(!!r.error, "C11: error field set on failure");
    } finally { await mock.close(); }
  }

  // C12: POST sends payload bytes
  {
    let receivedPayload = null;
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const ffIdx = msg.indexOf(0xFF, 4);
      if (ffIdx !== -1) receivedPayload = msg.slice(ffIdx + 1).toString("utf8");
      const r = makeCreatedAck(msgId, token);
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      await coapClient({ operation: "post", host: "127.0.0.1", port: mock.port, uri: "/items", payload: "sensor=1&value=42", timeout: 3000 });
      ok(receivedPayload === "sensor=1&value=42", "C12: POST payload sent to server");
    } finally { await mock.close(); }
  }

  // C13: custom timeout in info
  {
    const r = await coapClient({ operation: "info", timeout: 10000 });
    ok(r.timeoutMs === 10000, "C13: custom timeout 10000 preserved");
  }

  // C14: discover → resources array
  {
    const linkPayload = "</s/temp>;rt=\"temperature\",</s/hum>;rt=\"humidity\"";
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, linkPayload);
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "discover", host: "127.0.0.1", port: mock.port, timeout: 3000 });
      ok(r.ok === true && Array.isArray(r.resources) && r.resources.length >= 2, "C14: discover returns resources");
      ok(r.resources[0].uri === "/s/temp", "C14: first resource URI correct");
    } finally { await mock.close(); }
  }

  // C15: observe → notifications array
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "25.5");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "observe", host: "127.0.0.1", port: mock.port, uri: "/temp", max_notifications: 1, timeout: 1500 });
      ok(r.operation === "observe" && Array.isArray(r.notifications), "C15: observe returns notifications array");
    } finally { await mock.close(); }
  }

  // C16: msgId is a number
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "data");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: "/", timeout: 3000 });
      ok(typeof r.msgId === "number", "C16: msgId field is a number");
    } finally { await mock.close(); }
  }

  // C17: payloadSize matches
  {
    const body = "temperature=25.3";
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, body);
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: "/", timeout: 3000 });
      ok(r.payloadSize === Buffer.byteLength(body, "utf8"), "C17: payloadSize matches payload length");
    } finally { await mock.close(); }
  }

  // C18: POST with object payload auto-serialises
  {
    let receivedPayload = null;
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const ffIdx = msg.indexOf(0xFF, 4);
      if (ffIdx !== -1) receivedPayload = msg.slice(ffIdx + 1).toString("utf8");
      const r = makeCreatedAck(msgId, token);
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      await coapClient({ operation: "post", host: "127.0.0.1", port: mock.port, uri: "/api", payload: { sensor: "temp", value: 22 }, timeout: 3000 });
      let parsed; try { parsed = JSON.parse(receivedPayload); } catch { parsed = null; }
      ok(parsed && parsed.sensor === "temp", "C18: object payload JSON-serialised");
    } finally { await mock.close(); }
  }

  // C19: ping response field is RST or ACK
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId } = parseIncomingBasics(msg);
      const rst = makeRstResponse(msgId);
      sock.send(rst, 0, rst.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "ping", host: "127.0.0.1", port: mock.port, timeout: 3000 });
      ok(r.response === "RST" || r.response === "ACK", "C19: ping response is RST or ACK");
    } finally { await mock.close(); }
  }

  // C20: GET with path argument (no uri)
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      const r = makeAckResponse(msgId, token, "path-test");
      sock.send(r, 0, r.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, path: "/sensors/light", timeout: 3000 });
      ok(r.ok === true && r.payload && r.payload.includes("path-test"), "C20: GET with path arg works");
    } finally { await mock.close(); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Security (10 tests)
// ─────────────────────────────────────────────────────────────────────────────
async function sectionD() {
  console.log("\nD. Security");

  await assertRejects(() => coapClient({ operation: "get", host: "127.0.0\x001", uri: "/", timeout: 500 }), "NUL",
    "D01: NUL byte in host rejected");

  await assertRejects(() => coapClient({ operation: "get", host: "127.0.0.1", uri: "/path\x00evil", timeout: 500 }), "NUL",
    "D02: NUL byte in URI rejected");

  await assertRejects(() => coapClient({ operation: "get", host: "127.0.0.1", port: 0, uri: "/", timeout: 500 }), "port",
    "D03: port 0 rejected");

  await assertRejects(() => coapClient({ operation: "get", host: "127.0.0.1", port: 65536, uri: "/", timeout: 500 }), "port",
    "D04: port 65536 rejected");

  await assertRejects(() => coapClient({ operation: "get", host: "127.0.0.1", port: -1, uri: "/", timeout: 500 }), "port",
    "D05: negative port rejected");

  await assertRejects(() => coapClient({ operation: "get", host: "127.0.0.1", port: 5683.5, uri: "/", timeout: 500 }), "port",
    "D06: fractional port rejected");

  const rMin = await coapClient({ operation: "info", timeout: 1 });
  ok(rMin.timeoutMs >= 500, "D07: timeout min clamped to >= 500ms");

  const rMax = await coapClient({ operation: "info", timeout: 1000000 });
  ok(rMax.timeoutMs <= 60000, "D08: timeout max clamped to <= 60000ms");

  const rInfo = await coapClient({ operation: "info" });
  ok(rInfo.limits.maxObserveNotifs === 20, "D09: maxObserveNotifs is 20");
  ok(rInfo.limits.maxPayloadBytes === 256 * 1024, "D10: maxPayloadBytes is 256KB");
}

// ─────────────────────────────────────────────────────────────────────────────
// E. Error paths (10 tests)
// ─────────────────────────────────────────────────────────────────────────────
async function sectionE() {
  console.log("\nE. Error paths");

  await assertRejects(
    () => coapClient({ operation: "get", host: "127.0.0.1", port: 1, uri: "/", timeout: 600 }),
    "timed out", "E01: GET times out on unreachable port");

  await assertRejects(
    () => coapClient({ operation: "ping", host: "127.0.0.1", port: 1, timeout: 600 }),
    "timed out", "E02: ping times out on unreachable port");

  await assertRejects(
    () => coapClient({ operation: "get", host: "127.0.0.1", port: 5683, uri: "/", content_format: "application/bogus", timeout: 500 }),
    "unknown content-format", "E03: unknown content_format name throws");

  await assertRejects(
    () => coapClient({ operation: "get", uri: "coap://[::1/path", timeout: 500 }),
    "malformed IPv6", "E04: malformed IPv6 URI throws");

  assertThrows(() => parsePacket(Buffer.from([0x40, 0x45, 0x00, 0x01, 0xF0])), "reserved",
    "E05: option delta nibble=15 reserved throws");

  assertThrows(() => parsePacket(Buffer.from([0x40, 0x45, 0x00, 0x01, 0xD0])), "delta13 truncated",
    "E06: truncated delta13 ext throws");

  await assertRejects(
    () => coapClient({ operation: "discover", host: "127.0.0.1", port: 1, timeout: 600 }),
    "timed out", "E07: discover times out");

  const rObs = await coapClient({ operation: "observe", host: "127.0.0.1", port: 1, uri: "/temp", timeout: 600 });
  ok(Array.isArray(rObs.notifications) && rObs.notifications.length === 0, "E08: observe timeout returns empty notifications");

  await assertRejects(() => coapClient({ operation: "subscribe" }), "unknown operation",
    "E09: unknown operation gives clear message");

  assertThrows(() => encodeOptions([{ number: 70000, value: "x" }]), "too large",
    "E10: option delta > 65804 throws");
}

// ─────────────────────────────────────────────────────────────────────────────
// F. Concurrency / stress (6 tests)
// ─────────────────────────────────────────────────────────────────────────────
async function sectionF() {
  console.log("\nF. Concurrency / stress");

  // F01: 5 concurrent GETs
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId, token } = parseIncomingBasics(msg);
      setTimeout(() => {
        const r = makeAckResponse(msgId, token, `ok-${msgId}`);
        sock.send(r, 0, r.length, rinfo.port, rinfo.address);
      }, Math.random() * 20);
    });
    try {
      const rs = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          coapClient({ operation: "get", host: "127.0.0.1", port: mock.port, uri: `/r${i}`, timeout: 3000 })
        )
      );
      ok(rs.length === 5 && rs.every(r => r.ok === true), "F01: 5 concurrent GETs all ok");
    } finally { await mock.close(); }
  }

  // F02: 10 concurrent info calls
  {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: 10 }, () => coapClient({ operation: "info" })));
    ok(rs.length === 10 && (Date.now() - t0) < 1000, "F02: 10 concurrent info calls < 1s");
  }

  // F03: 100 encode/decode round-trips
  {
    let allOk = true;
    for (let i = 0; i < 100; i++) {
      const payload = crypto.randomBytes(Math.floor(Math.random() * 200));
      const token   = crypto.randomBytes(4);
      const pkt     = buildPacket({ type: 0, code: 0x45, msgId: i % 0x10000, token, options: [], payload });
      const parsed  = parsePacket(pkt);
      if (!parsed.payload.equals(payload) || !parsed.token.equals(token)) { allOk = false; break; }
    }
    ok(allOk, "F03: 100 random encode/decode round-trips all preserve payload/token");
  }

  // F04: 100 distinct msgIds encode uniquely
  {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      const pkt = buildPacket({ type: 0, code: 0x01, msgId: i, token: null, options: [] });
      ids.add(pkt.readUInt16BE(2));
    }
    ok(ids.size === 100, "F04: 100 distinct msgIds all encode uniquely");
  }

  // F05: 3 concurrent pings
  {
    const mock = await startMockCoAPServer((sock, msg, rinfo) => {
      const { msgId } = parseIncomingBasics(msg);
      const rst = makeRstResponse(msgId);
      sock.send(rst, 0, rst.length, rinfo.port, rinfo.address);
    });
    try {
      const rs = await Promise.all(
        Array.from({ length: 3 }, () =>
          coapClient({ operation: "ping", host: "127.0.0.1", port: mock.port, timeout: 3000 })
        )
      );
      ok(rs.length === 3 && rs.every(r => r.ok && r.reachable), "F05: 3 concurrent pings reachable");
    } finally { await mock.close(); }
  }

  // F06: parseLinkFormat 50 entries < 100ms
  {
    const entries = Array.from({ length: 50 }, (_, i) => `</r${i}>;rt="type-${i}"`).join(",");
    const t0 = Date.now();
    const resources = parseLinkFormat(entries);
    const elapsed = Date.now() - t0;
    ok(resources.length === 50 && elapsed < 100, `F06: parseLinkFormat 50 entries in ${elapsed}ms`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Section 252: coap_client tests ===");
  try {
    await sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
    await sectionE();
    await sectionF();
  } catch (e) {
    console.error("UNEXPECTED ERROR:", e);
    failed++;
  }

  console.log("\nResults:");
  for (const r of results) console.log(r);
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
