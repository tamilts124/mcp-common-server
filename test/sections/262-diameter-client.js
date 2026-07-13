"use strict";
/**
 * Section 262: diameter_client tests
 * Five rigor levels:
 *   A) Pure-helper / protocol-logic tests (no I/O)
 *   B) Validation tests (bad inputs → specific errors)
 *   C) Mock-network tests (real TCP server, fake Diameter peer)
 *   D) Security tests (NUL bytes, malformed packets, oversized data)
 *   E) Concurrency tests (parallel requests, rapid sequential)
 */

const net    = require("net");
const crypto = require("crypto");
const assert = require("assert").strict;

// Import main entry point AND internal helpers for unit testing
const ops = require("../../lib/diameterClientOps");
const {
  buildMessage, parseMessage, encodeAvp, encodeAvpUtf8, encodeAvpUint32,
  encodeAvpAddress, parseAvps, decodeAvpValue, getAvp, expandIPv6,
  CMD, AVP, APP_ID, FLAG, AVP_FLAG, RESULT_CODE, RESULT_CODE_NAMES,
  DISCONNECT_CAUSE, AVP_META, AVP_TYPE,
} = ops;

// ── test runner ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stderr.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
    failures.push({ name, err });
    failed++;
  }
}

// ── Mock Diameter server helpers ──────────────────────────────────────────────────

/**
 * Build a Diameter answer (mirroring the request's Hop-by-Hop/End-to-End IDs).
 */
function buildAnswer(request, extraAvps) {
  const parsed = parseMessage(request);
  const avps = [
    encodeAvpUtf8(AVP.ORIGIN_HOST,   "mock.server.example.com"),
    encodeAvpUtf8(AVP.ORIGIN_REALM,  "example.com"),
    encodeAvpUint32(AVP.RESULT_CODE, RESULT_CODE.SUCCESS),
    ...(extraAvps || []),
  ];
  const { buf } = buildMessage({
    commandCode:  parsed.commandCode,
    appId:        parsed.appId,
    isRequest:    false,          // answer
    hopByHopId:   parsed.hopByHopId,
    endToEndId:   parsed.endToEndId,
    avps,
  });
  return buf;
}

/**
 * Start a minimal mock Diameter TCP server.
 * handler(requestBuf) → Buffer | null
 */
function startMockServer(port, handler) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // Try to extract full Diameter messages
        while (buf.length >= 4) {
          const msgLen = (buf[1] << 16) | (buf[2] << 8) | buf[3];
          if (msgLen < 20 || buf.length < msgLen) break;
          const msg  = buf.slice(0, msgLen);
          buf = buf.slice(msgLen);
          const resp = handler(msg);
          if (resp) socket.write(resp);
        }
      });
      socket.on("error", () => {});
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", (err) => { throw err; });
  });
}

/** Get a free TCP port */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

// ────────────────────────────────────────────────────────────────────────────

async function runAll() {

  // ── A) Pure-helper / protocol-logic tests ───────────────────────────────────────
  process.stderr.write("\n== A) Pure-helper / protocol-logic ==\n");

  await test("info op returns correct protocol", async () => {
    const r = await ops.diameterClient({ operation: "info" });
    assert.ok(r.protocol.includes("RFC 6733"));
    assert.ok(Array.isArray(r.operations));
    assert.ok(r.operations.find(o => o.op === "capabilities_exchange"));
    assert.ok(r.operations.find(o => o.op === "device_watchdog"));
    assert.ok(r.operations.find(o => o.op === "disconnect_peer"));
    assert.ok(r.operations.find(o => o.op === "send_request"));
  });

  await test("info op returns default ports 3868 (TCP) and 5658 (TLS)", async () => {
    const r = await ops.diameterClient({ operation: "info" });
    assert.equal(r.defaultPorts.tcp, 3868);
    assert.equal(r.defaultPorts.tls, 5658);
  });

  await test("info op returns applicationIds including Base, NASREQ, CCA", async () => {
    const r = await ops.diameterClient({ operation: "info" });
    const ids = r.applicationIds.map(a => a.name);
    assert.ok(ids.includes("BASE"));
    assert.ok(ids.includes("NASREQ"));
    assert.ok(ids.includes("CREDIT_CONTROL"));
  });

  await test("info op returns result codes including SUCCESS", async () => {
    const r = await ops.diameterClient({ operation: "info" });
    const codes = r.resultCodes.map(c => c.name);
    assert.ok(codes.includes("SUCCESS"));
    assert.ok(codes.includes("NO_COMMON_APPLICATION"));
  });

  await test("encodeAvp: string value sets code, flags, length, value", async () => {
    const val = Buffer.from("hello");
    const avp = encodeAvp(AVP.USER_NAME, val);
    assert.equal(avp.readUInt32BE(0), AVP.USER_NAME); // code
    // flags byte: M=0x40
    assert.equal(avp[4] & AVP_FLAG.MANDATORY, AVP_FLAG.MANDATORY);
    // length bytes 5-7: 8 + 5 = 13
    const rawLen = (avp[5] << 16) | (avp[6] << 8) | avp[7];
    assert.equal(rawLen, 8 + val.length);
    // value starts at offset 8
    assert.equal(avp.slice(8, 8 + val.length).toString("utf8"), "hello");
  });

  await test("encodeAvp: padded to 4-byte boundary", async () => {
    // Value of 5 bytes: rawLen=13, padded to 16
    const avp = encodeAvp(1, Buffer.from("hello"));
    assert.equal(avp.length % 4, 0);
    assert.equal(avp.length, 16);
  });

  await test("encodeAvp: no padding needed for 4-byte-aligned value", async () => {
    // Value of 4 bytes: rawLen=12, already aligned
    const avp = encodeAvp(1, Buffer.alloc(4));
    assert.equal(avp.length, 12);
  });

  await test("encodeAvp: vendor AVP sets V flag and vendor-id", async () => {
    const avp = encodeAvp(999, Buffer.from("val"), { mandatory: true, vendorId: 10415 });
    assert.equal(avp[4] & AVP_FLAG.VENDOR, AVP_FLAG.VENDOR);
    assert.equal(avp.readUInt32BE(8), 10415);
    assert.equal(avp.slice(12, 15).toString("utf8"), "val");
  });

  await test("encodeAvp: non-mandatory AVP clears M flag", async () => {
    const avp = encodeAvp(1, Buffer.from("x"), { mandatory: false });
    assert.equal(avp[4] & AVP_FLAG.MANDATORY, 0);
  });

  await test("encodeAvpUtf8: encodes string correctly", async () => {
    const avp = encodeAvpUtf8(AVP.ORIGIN_HOST, "client.example.com");
    const rawLen = (avp[5] << 16) | (avp[6] << 8) | avp[7];
    const valLen = rawLen - 8;
    assert.equal(avp.slice(8, 8 + valLen).toString("utf8"), "client.example.com");
  });

  await test("encodeAvpUint32: encodes 32-bit integer correctly", async () => {
    const avp = encodeAvpUint32(AVP.RESULT_CODE, RESULT_CODE.SUCCESS);
    assert.equal(avp.readUInt32BE(8), RESULT_CODE.SUCCESS); // 2001
  });

  await test("encodeAvpAddress: IPv4 address uses family=1 and 4 bytes", async () => {
    const avp = encodeAvpAddress(AVP.HOST_IP_ADDRESS, "192.168.1.1");
    // value starts at offset 8: 2-byte family + 4-byte IP = 6 bytes
    assert.equal(avp.readUInt16BE(8), 1); // family IPv4
    assert.equal(avp[10], 192);
    assert.equal(avp[11], 168);
    assert.equal(avp[12], 1);
    assert.equal(avp[13], 1);
  });

  await test("encodeAvpAddress: IPv6 loopback uses family=2 and 16 bytes", async () => {
    const avp = encodeAvpAddress(AVP.HOST_IP_ADDRESS, "::1");
    assert.equal(avp.readUInt16BE(8), 2); // family IPv6
    // Last 2 bytes of 16-byte address should be 0x0001
    assert.equal(avp.readUInt16BE(8 + 2 + 14), 1);
  });

  await test("expandIPv6: ::1 expands to correct 16 bytes", async () => {
    const buf = expandIPv6("::1");
    assert.equal(buf.length, 16);
    // Last 2 bytes = 1
    assert.equal(buf.readUInt16BE(14), 1);
    // All preceding bytes = 0
    for (let i = 0; i < 14; i++) assert.equal(buf[i], 0);
  });

  await test("expandIPv6: 2001:db8::1 expands correctly", async () => {
    const buf = expandIPv6("2001:db8::1");
    assert.equal(buf.length, 16);
    assert.equal(buf.readUInt16BE(0), 0x2001);
    assert.equal(buf.readUInt16BE(2), 0x0db8);
    assert.equal(buf.readUInt16BE(14), 1);
  });

  await test("buildMessage: version byte = 1", async () => {
    const { buf } = buildMessage({
      commandCode: CMD.CAPABILITIES_EXCHANGE, appId: APP_ID.BASE,
      isRequest: true, avps: [],
    });
    assert.equal(buf[0], 1);
  });

  await test("buildMessage: length field matches actual buffer length", async () => {
    const avp = encodeAvpUtf8(AVP.ORIGIN_HOST, "test.example.com");
    const { buf } = buildMessage({
      commandCode: CMD.CAPABILITIES_EXCHANGE, appId: APP_ID.BASE,
      isRequest: true, avps: [avp],
    });
    const reportedLen = (buf[1] << 16) | (buf[2] << 8) | buf[3];
    assert.equal(reportedLen, buf.length);
  });

  await test("buildMessage: request flag set for isRequest=true", async () => {
    const { buf } = buildMessage({
      commandCode: CMD.WATCHDOG, appId: APP_ID.BASE,
      isRequest: true, avps: [],
    });
    assert.equal(buf[4] & FLAG.REQUEST, FLAG.REQUEST);
  });

  await test("buildMessage: request flag not set for isRequest=false", async () => {
    const { buf } = buildMessage({
      commandCode: CMD.WATCHDOG, appId: APP_ID.BASE,
      isRequest: false, avps: [],
    });
    assert.equal(buf[4] & FLAG.REQUEST, 0);
  });

  await test("buildMessage: command code written in bytes 5-7", async () => {
    const { buf } = buildMessage({
      commandCode: CMD.CAPABILITIES_EXCHANGE, appId: APP_ID.BASE,
      isRequest: true, avps: [],
    });
    const code = (buf[5] << 16) | (buf[6] << 8) | buf[7];
    assert.equal(code, CMD.CAPABILITIES_EXCHANGE);
  });

  await test("buildMessage: application-id written at bytes 8-11", async () => {
    const { buf } = buildMessage({
      commandCode: CMD.CAPABILITIES_EXCHANGE, appId: APP_ID.NASREQ,
      isRequest: true, avps: [],
    });
    assert.equal(buf.readUInt32BE(8), APP_ID.NASREQ);
  });

  await test("buildMessage: hop-by-hop ID and end-to-end ID returned correctly", async () => {
    const { buf, hopByHopId, endToEndId } = buildMessage({
      commandCode: CMD.WATCHDOG, appId: APP_ID.BASE,
      isRequest: true, avps: [],
      hopByHopId: 0xDEADBEEF, endToEndId: 0xCAFEBABE,
    });
    assert.equal(hopByHopId, 0xDEADBEEF);
    assert.equal(endToEndId, 0xCAFEBABE);
    assert.equal(buf.readUInt32BE(12), 0xDEADBEEF);
    assert.equal(buf.readUInt32BE(16), 0xCAFEBABE);
  });

  await test("parseMessage: parses minimal 20-byte header", async () => {
    const { buf } = buildMessage({
      commandCode: CMD.WATCHDOG, appId: APP_ID.BASE,
      isRequest: true, avps: [],
      hopByHopId: 42, endToEndId: 99,
    });
    const parsed = parseMessage(buf);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.commandCode, CMD.WATCHDOG);
    assert.equal(parsed.appId, APP_ID.BASE);
    assert.equal(parsed.isRequest, true);
    assert.equal(parsed.hopByHopId, 42);
    assert.equal(parsed.endToEndId, 99);
    assert.equal(parsed.avps.length, 0);
  });

  await test("parseMessage: parses message with AVPs", async () => {
    const avps = [
      encodeAvpUtf8(AVP.ORIGIN_HOST, "host.example.com"),
      encodeAvpUint32(AVP.RESULT_CODE, RESULT_CODE.SUCCESS),
    ];
    const { buf } = buildMessage({
      commandCode: CMD.CAPABILITIES_EXCHANGE, appId: APP_ID.BASE,
      isRequest: false, avps,
    });
    const parsed = parseMessage(buf);
    assert.equal(parsed.avps.length, 2);
    const hostAvp = parsed.avps.find(a => a.code === AVP.ORIGIN_HOST);
    assert.ok(hostAvp);
    assert.equal(hostAvp.decoded, "host.example.com");
    const rcAvp = parsed.avps.find(a => a.code === AVP.RESULT_CODE);
    assert.equal(rcAvp.decoded, RESULT_CODE.SUCCESS);
  });

  await test("parseMessage: throws on buffer shorter than 20 bytes", async () => {
    assert.throws(() => parseMessage(Buffer.alloc(10)), /too short/);
  });

  await test("parseMessage: throws on non-v1 version byte", async () => {
    const buf = Buffer.alloc(20);
    buf[0] = 2; // version 2 is invalid
    buf.writeUInt32BE(20, 1); // encode length in wrong position but pass length check
    // Actually set length field bytes 1-3
    buf[1] = 0; buf[2] = 0; buf[3] = 20;
    assert.throws(() => parseMessage(buf), /version/);
  });

  await test("decodeAvpValue: UTF8String decoded correctly", async () => {
    const result = decodeAvpValue(Buffer.from("hello world"), AVP_TYPE.UTF8STRING, 0);
    assert.equal(result, "hello world");
  });

  await test("decodeAvpValue: Unsigned32 decoded as number", async () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(2001, 0);
    const result = decodeAvpValue(buf, AVP_TYPE.UNSIGNED32, 0);
    assert.equal(result, 2001);
  });

  await test("decodeAvpValue: Address/IPv4 decoded correctly", async () => {
    // 2-byte family + 4-byte IPv4
    const buf = Buffer.alloc(6);
    buf.writeUInt16BE(1, 0);
    buf[2] = 10; buf[3] = 20; buf[4] = 30; buf[5] = 40;
    const result = decodeAvpValue(buf, AVP_TYPE.ADDRESS, 0);
    assert.equal(result, "10.20.30.40");
  });

  await test("decodeAvpValue: empty value returns null", async () => {
    const result = decodeAvpValue(Buffer.alloc(0), AVP_TYPE.UTF8STRING, 0);
    assert.equal(result, null);
  });

  await test("decodeAvpValue: null value returns null", async () => {
    const result = decodeAvpValue(null, AVP_TYPE.UTF8STRING, 0);
    assert.equal(result, null);
  });

  await test("getAvp: returns decoded value for existing code", async () => {
    const avps = [
      { code: AVP.RESULT_CODE, decoded: 2001 },
      { code: AVP.ORIGIN_HOST, decoded: "h.example.com" },
    ];
    assert.equal(getAvp(avps, AVP.RESULT_CODE), 2001);
    assert.equal(getAvp(avps, AVP.ORIGIN_HOST), "h.example.com");
  });

  await test("getAvp: returns undefined for missing code", async () => {
    assert.equal(getAvp([], AVP.RESULT_CODE), undefined);
  });

  await test("parseAvps: parses multiple AVPs with padding", async () => {
    // Build a buffer with two AVPs: User-Name (5 bytes) + Result-Code (4 bytes)
    const a1 = encodeAvpUtf8(AVP.USER_NAME, "alice"); // 5 bytes value
    const a2 = encodeAvpUint32(AVP.RESULT_CODE, 2001);
    const buf = Buffer.concat([a1, a2]);
    const avps = parseAvps(buf, 0, buf.length);
    assert.equal(avps.length, 2);
    assert.equal(avps[0].code, AVP.USER_NAME);
    assert.equal(avps[0].decoded, "alice");
    assert.equal(avps[1].code, AVP.RESULT_CODE);
    assert.equal(avps[1].decoded, 2001);
  });

  await test("RESULT_CODE_NAMES maps 2001 to SUCCESS", async () => {
    assert.equal(RESULT_CODE_NAMES[2001], "SUCCESS");
  });

  await test("RESULT_CODE_NAMES maps 3007 to APPLICATION_UNSUPPORTED", async () => {
    assert.equal(RESULT_CODE_NAMES[3007], "APPLICATION_UNSUPPORTED");
  });

  await test("CMD.CAPABILITIES_EXCHANGE is 257", async () => {
    assert.equal(CMD.CAPABILITIES_EXCHANGE, 257);
  });

  await test("CMD.WATCHDOG is 280", async () => {
    assert.equal(CMD.WATCHDOG, 280);
  });

  await test("CMD.DISCONNECT_PEER is 282", async () => {
    assert.equal(CMD.DISCONNECT_PEER, 282);
  });

  await test("buildMessage + parseMessage round-trip preserves all fields", async () => {
    const avp = encodeAvpUtf8(AVP.ORIGIN_HOST, "node.example.com");
    const { buf, hopByHopId, endToEndId } = buildMessage({
      commandCode: CMD.CAPABILITIES_EXCHANGE,
      appId: APP_ID.NASREQ,
      isRequest: true,
      avps: [avp],
    });
    const parsed = parseMessage(buf);
    assert.equal(parsed.commandCode, CMD.CAPABILITIES_EXCHANGE);
    assert.equal(parsed.appId, APP_ID.NASREQ);
    assert.equal(parsed.isRequest, true);
    assert.equal(parsed.hopByHopId, hopByHopId);
    assert.equal(parsed.endToEndId, endToEndId);
    assert.equal(parsed.avps.length, 1);
    assert.equal(parsed.avps[0].decoded, "node.example.com");
  });

  await test("proxiable flag set by default", async () => {
    const { buf } = buildMessage({
      commandCode: CMD.WATCHDOG, appId: APP_ID.BASE,
      isRequest: true, avps: [],
    });
    assert.equal(buf[4] & FLAG.PROXIABLE, FLAG.PROXIABLE);
  });

  await test("proxiable flag can be disabled", async () => {
    const { buf } = buildMessage({
      commandCode: CMD.WATCHDOG, appId: APP_ID.BASE,
      isRequest: true, avps: [], proxiable: false,
    });
    assert.equal(buf[4] & FLAG.PROXIABLE, 0);
  });

  await test("encodeAvp: vendor AVP has larger header (12 bytes before value)", async () => {
    const val = Buffer.from("data");
    const avp = encodeAvp(1000, val, { mandatory: false, vendorId: 193 }); // Ericsson
    // rawLen = 12 + 4 = 16, no padding needed
    const rawLen = (avp[5] << 16) | (avp[6] << 8) | avp[7];
    assert.equal(rawLen, 12 + 4);
    assert.equal(avp.readUInt32BE(8), 193);
    assert.ok(avp.slice(12, 16).equals(val));
  });

  await test("parseMessage: vendor AVP decoded with vendorId and hasVendor flag", async () => {
    const val = Buffer.from("test");
    const avp = encodeAvp(1000, val, { mandatory: true, vendorId: 193 });
    const { buf } = buildMessage({
      commandCode: CMD.WATCHDOG, appId: APP_ID.BASE,
      isRequest: false, avps: [avp],
    });
    const parsed = parseMessage(buf);
    assert.equal(parsed.avps.length, 1);
    assert.equal(parsed.avps[0].hasVendor, true);
    assert.equal(parsed.avps[0].vendorId, 193);
  });

  await test("decodeAvpValue: Enumerated treated same as Unsigned32", async () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(0, 0);
    const result = decodeAvpValue(buf, AVP_TYPE.ENUMERATED, 0);
    assert.equal(result, 0);
  });

  await test("buildAnswer helper produces isRequest=false message", async () => {
    const { buf: req } = buildMessage({
      commandCode: CMD.WATCHDOG, appId: APP_ID.BASE,
      isRequest: true, avps: [],
      hopByHopId: 111, endToEndId: 222,
    });
    const ans = buildAnswer(req);
    const parsed = parseMessage(ans);
    assert.equal(parsed.isRequest, false);
    assert.equal(parsed.hopByHopId, 111);
    assert.equal(parsed.endToEndId, 222);
  });

  await test("info op lists disconnect causes including rebooting", async () => {
    const r = await ops.diameterClient({ operation: "info" });
    const names = r.disconnectCauses.map(d => d.name);
    assert.ok(names.includes("rebooting"));
    assert.ok(names.includes("busy"));
    assert.ok(names.includes("do_not_want_to_talk"));
  });

  // ── B) Validation tests ───────────────────────────────────────────────────────────────
  process.stderr.write("\n== B) Validation ==\n");

  await test("unknown operation throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "bad_op" }),
      /Unknown diameter_client operation/
    );
  });

  await test("capabilities_exchange: missing host throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        origin_host: "h.example.com", origin_realm: "example.com" }),
      /host must be a non-empty string/
    );
  });

  await test("capabilities_exchange: missing origin_host throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        host: "127.0.0.1", origin_realm: "example.com" }),
      /origin_host must be a non-empty string/
    );
  });

  await test("capabilities_exchange: missing origin_realm throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        host: "127.0.0.1", origin_host: "h.example.com" }),
      /origin_realm must be a non-empty string/
    );
  });

  await test("device_watchdog: missing host throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "device_watchdog",
        origin_host: "h.example.com", origin_realm: "example.com" }),
      /host must be a non-empty string/
    );
  });

  await test("disconnect_peer: invalid disconnect_cause throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "disconnect_peer",
        host: "127.0.0.1", origin_host: "h.example.com", origin_realm: "example.com",
        disconnect_cause: "bad_cause", timeout: 1000 }),
      /disconnect_cause must be one of/
    );
  });

  await test("send_request: missing origin_host throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "send_request",
        host: "127.0.0.1", origin_realm: "example.com" }),
      /origin_host must be a non-empty string/
    );
  });

  await test("port out of range 0 throws on capabilities_exchange", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        host: "127.0.0.1", port: 0,
        origin_host: "h.example.com", origin_realm: "example.com", timeout: 1000 }),
      /port must be between/
    );
  });

  await test("port out of range 65536 throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "device_watchdog",
        host: "127.0.0.1", port: 65536,
        origin_host: "h.example.com", origin_realm: "example.com", timeout: 1000 }),
      /port must be between/
    );
  });

  await test("timeout below 1000 throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        host: "127.0.0.1", timeout: 500,
        origin_host: "h.example.com", origin_realm: "example.com" }),
      /timeout must be between/
    );
  });

  await test("timeout above 60000 throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        host: "127.0.0.1", timeout: 99999,
        origin_host: "h.example.com", origin_realm: "example.com" }),
      /timeout must be between/
    );
  });

  await test("empty host string throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        host: "", origin_host: "h.example.com", origin_realm: "example.com" }),
      /host must be a non-empty string/
    );
  });

  await test("empty origin_realm string throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "device_watchdog",
        host: "127.0.0.1", origin_host: "h.example.com", origin_realm: "" }),
      /origin_realm must be a non-empty string/
    );
  });

  await test("send_request: command_code out of range (negative) throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "send_request",
        host: "127.0.0.1", origin_host: "h.example.com", origin_realm: "example.com",
        command_code: -1, timeout: 1000 }),
      /command_code must be between/
    );
  });

  await test("send_request: command_code > 0xFFFFFF throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "send_request",
        host: "127.0.0.1", origin_host: "h.example.com", origin_realm: "example.com",
        command_code: 0x1000000, timeout: 1000 }),
      /command_code must be between/
    );
  });

  // ── C) Mock-network tests ─────────────────────────────────────────────────────────────
  process.stderr.write("\n== C) Mock-network ==\n");

  await test("capabilities_exchange: receives CEA with SUCCESS result code", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req, [
      encodeAvpUtf8(AVP.PRODUCT_NAME, "FreeRADIUS-Diameter"),
      encodeAvpUint32(AVP.VENDOR_ID, 0),
      encodeAvpUint32(AVP.AUTH_APPLICATION_ID, APP_ID.BASE),
    ]));
    try {
      const r = await ops.diameterClient({
        operation: "capabilities_exchange",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        timeout: 5000,
      });
      assert.equal(r.ok, true);
      assert.equal(r.operation, "capabilities_exchange");
      assert.equal(r.resultCode, RESULT_CODE.SUCCESS);
      assert.equal(r.resultCodeName, "SUCCESS");
      assert.equal(r.peer.originHost, "mock.server.example.com");
      assert.equal(r.peer.productName, "FreeRADIUS-Diameter");
      assert.ok(r.elapsedMs >= 0);
    } finally { srv.close(); }
  });

  await test("capabilities_exchange: avpCount matches server response", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      const r = await ops.diameterClient({
        operation: "capabilities_exchange",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        timeout: 5000,
      });
      assert.ok(r.avpCount >= 3); // Origin-Host, Origin-Realm, Result-Code at minimum
    } finally { srv.close(); }
  });

  await test("device_watchdog: receives DWA with SUCCESS", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      const r = await ops.diameterClient({
        operation: "device_watchdog",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        timeout: 5000,
      });
      assert.equal(r.ok, true);
      assert.equal(r.operation, "device_watchdog");
      assert.equal(r.resultCode, RESULT_CODE.SUCCESS);
      assert.equal(r.peerHost, "mock.server.example.com");
      assert.ok(typeof r.elapsedMs === "number");
    } finally { srv.close(); }
  });

  await test("disconnect_peer: receives DPA with SUCCESS", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      const r = await ops.diameterClient({
        operation: "disconnect_peer",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        disconnect_cause: "rebooting",
        timeout: 5000,
      });
      assert.equal(r.ok, true);
      assert.equal(r.operation, "disconnect_peer");
      assert.equal(r.disconnectCause, "rebooting");
    } finally { srv.close(); }
  });

  await test("disconnect_peer: all three causes accepted", async () => {
    for (const cause of ["rebooting", "busy", "do_not_want_to_talk"]) {
      const port = await getFreePort();
      const srv = await startMockServer(port, (req) => buildAnswer(req));
      try {
        const r = await ops.diameterClient({
          operation: "disconnect_peer",
          host: "127.0.0.1", port,
          origin_host: "client.example.com", origin_realm: "example.com",
          disconnect_cause: cause,
          timeout: 5000,
        });
        assert.equal(r.disconnectCause, cause);
        assert.equal(r.ok, true);
      } finally { srv.close(); }
    }
  });

  await test("send_request: receives answer with decoded AVPs", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req, [
      encodeAvpUtf8(AVP.USER_NAME, "alice@example.com"),
      encodeAvpUint32(AVP.SESSION_TIMEOUT, 3600),
    ]));
    try {
      const r = await ops.diameterClient({
        operation: "send_request",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        command_code: CMD.CAPABILITIES_EXCHANGE,
        application_id: APP_ID.BASE,
        timeout: 5000,
      });
      assert.equal(r.ok, true);
      assert.ok(Array.isArray(r.avps));
      const rcAvp = r.avps.find(a => a.code === AVP.RESULT_CODE);
      assert.equal(rcAvp.decoded, RESULT_CODE.SUCCESS);
      const stAvp = r.avps.find(a => a.code === AVP.SESSION_TIMEOUT);
      assert.equal(stAvp.decoded, 3600);
    } finally { srv.close(); }
  });

  await test("send_request: extra_avps included in request", async () => {
    const port = await getFreePort();
    let receivedAvps = null;
    const srv = await startMockServer(port, (req) => {
      receivedAvps = parseMessage(req).avps;
      return buildAnswer(req);
    });
    try {
      await ops.diameterClient({
        operation: "send_request",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        command_code: CMD.CAPABILITIES_EXCHANGE,
        application_id: APP_ID.BASE,
        extra_avps: [
          { code: AVP.USER_NAME, value_string: "testuser@realm.com" },
          { code: AVP.SESSION_TIMEOUT, value_uint32: 7200 },
        ],
        timeout: 5000,
      });
      assert.ok(receivedAvps);
      const userAvp = receivedAvps.find(a => a.code === AVP.USER_NAME);
      assert.ok(userAvp);
      assert.equal(userAvp.decoded, "testuser@realm.com");
      const stAvp = receivedAvps.find(a => a.code === AVP.SESSION_TIMEOUT);
      assert.ok(stAvp);
      assert.equal(stAvp.decoded, 7200);
    } finally { srv.close(); }
  });

  await test("send_request: extra_avps with value_hex included correctly", async () => {
    const port = await getFreePort();
    let receivedAvps = null;
    const srv = await startMockServer(port, (req) => {
      receivedAvps = parseMessage(req).avps;
      return buildAnswer(req);
    });
    try {
      await ops.diameterClient({
        operation: "send_request",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        command_code: CMD.CAPABILITIES_EXCHANGE,
        extra_avps: [{ code: 9999, value_hex: "deadbeef" }],
        timeout: 5000,
      });
      const customAvp = receivedAvps.find(a => a.code === 9999);
      assert.ok(customAvp);
      assert.equal(customAvp.value.toString("hex"), "deadbeef");
    } finally { srv.close(); }
  });

  await test("server unreachable returns a connection error", async () => {
    const port = await getFreePort(); // Nothing listening
    await assert.rejects(
      () => ops.diameterClient({
        operation: "capabilities_exchange",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        timeout: 1000,
      }),
      /Socket error|Connection refused|ECONNREFUSED/i
    );
  });

  await test("timeout triggers error message with peer info", async () => {
    const port = await getFreePort();
    // Server that never replies
    const srv = await startMockServer(port, () => null);
    try {
      await assert.rejects(
        () => ops.diameterClient({
          operation: "device_watchdog",
          host: "127.0.0.1", port,
          origin_host: "client.example.com", origin_realm: "example.com",
          timeout: 1000,
        }),
        /did not respond within/i
      );
    } finally { srv.close(); }
  });

  await test("hop-by-hop ID matching: correct response delivered", async () => {
    const port = await getFreePort();
    // Server echoes back the hop-by-hop ID correctly via buildAnswer
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      const r = await ops.diameterClient({
        operation: "device_watchdog",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        timeout: 5000,
      });
      assert.equal(r.ok, true);
      assert.ok(typeof r.hopByHopId === "number");
    } finally { srv.close(); }
  });

  await test("capabilities_exchange sends correct command code 257", async () => {
    const port = await getFreePort();
    let rcvCmdCode = null;
    const srv = await startMockServer(port, (req) => {
      rcvCmdCode = parseMessage(req).commandCode;
      return buildAnswer(req);
    });
    try {
      await ops.diameterClient({
        operation: "capabilities_exchange",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        timeout: 5000,
      });
      assert.equal(rcvCmdCode, 257);
    } finally { srv.close(); }
  });

  await test("device_watchdog sends command code 280", async () => {
    const port = await getFreePort();
    let rcvCmdCode = null;
    const srv = await startMockServer(port, (req) => {
      rcvCmdCode = parseMessage(req).commandCode;
      return buildAnswer(req);
    });
    try {
      await ops.diameterClient({
        operation: "device_watchdog",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        timeout: 5000,
      });
      assert.equal(rcvCmdCode, 280);
    } finally { srv.close(); }
  });

  await test("disconnect_peer sends command code 282", async () => {
    const port = await getFreePort();
    let rcvCmdCode = null;
    const srv = await startMockServer(port, (req) => {
      rcvCmdCode = parseMessage(req).commandCode;
      return buildAnswer(req);
    });
    try {
      await ops.diameterClient({
        operation: "disconnect_peer",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        timeout: 5000,
      });
      assert.equal(rcvCmdCode, 282);
    } finally { srv.close(); }
  });

  // ── D) Security tests ───────────────────────────────────────────────────────────────
  process.stderr.write("\n== D) Security ==\n");

  await test("NUL byte in host throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        host: "127.0.0\x001", origin_host: "h.example.com", origin_realm: "example.com" }),
      /NUL bytes/
    );
  });

  await test("NUL byte in origin_host throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "capabilities_exchange",
        host: "127.0.0.1", origin_host: "h.example\x00.com", origin_realm: "example.com" }),
      /NUL bytes/
    );
  });

  await test("NUL byte in origin_realm throws", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "device_watchdog",
        host: "127.0.0.1", origin_host: "h.example.com", origin_realm: "examp\x00le.com" }),
      /NUL bytes/
    );
  });

  await test("empty host throws consistent error", async () => {
    await assert.rejects(
      () => ops.diameterClient({ operation: "disconnect_peer",
        host: "", origin_host: "h.example.com", origin_realm: "example.com" }),
      /host must be a non-empty string/
    );
  });

  await test("parseMessage: malformed message throws on bad version", async () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0xFF; // invalid version
    buf[1] = 0; buf[2] = 0; buf[3] = 20; // length
    assert.throws(() => parseMessage(buf), /version/);
  });

  await test("parseMessage: buffer too short throws", async () => {
    assert.throws(() => parseMessage(Buffer.alloc(5)), /too short/);
  });

  await test("encodeAvp: value of length 0 produces valid 8-byte AVP with no padding", async () => {
    const avp = encodeAvp(AVP.RESULT_CODE, Buffer.alloc(0));
    // rawLen = 8, total = 8
    assert.equal(avp.length, 8);
    const rawLen = (avp[5] << 16) | (avp[6] << 8) | avp[7];
    assert.equal(rawLen, 8);
  });

  await test("send_request: extra_avp without value is skipped (no crash)", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      // No value_hex/value_string/value_uint32 — should be silently skipped
      const r = await ops.diameterClient({
        operation: "send_request",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        command_code: CMD.WATCHDOG,
        extra_avps: [{ code: 999 }], // no value — skip
        timeout: 5000,
      });
      assert.equal(r.ok, true);
    } finally { srv.close(); }
  });

  await test("extra_avp: non-object entries are skipped without crash", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      const r = await ops.diameterClient({
        operation: "send_request",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        command_code: CMD.WATCHDOG,
        extra_avps: [null, undefined, "string", 42], // all should be skipped
        timeout: 5000,
      });
      assert.equal(r.ok, true);
    } finally { srv.close(); }
  });

  await test("buildMessage: all-zero 20-byte message is minimum valid", async () => {
    const { buf } = buildMessage({
      commandCode: 0, appId: 0, isRequest: false, avps: [],
    });
    assert.equal(buf.length, 20);
    assert.equal(buf[0], 1); // version
  });

  // ── E) Concurrency tests ───────────────────────────────────────────────────────────────
  process.stderr.write("\n== E) Concurrency ==\n");

  await test("10 parallel capabilities_exchange requests all succeed", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          ops.diameterClient({
            operation: "capabilities_exchange",
            host: "127.0.0.1", port,
            origin_host: "client.example.com", origin_realm: "example.com",
            timeout: 10000,
          })
        )
      );
      assert.ok(results.every(r => r.ok === true));
      assert.ok(results.every(r => r.resultCode === RESULT_CODE.SUCCESS));
    } finally { srv.close(); }
  });

  await test("5 parallel device_watchdog requests all succeed", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          ops.diameterClient({
            operation: "device_watchdog",
            host: "127.0.0.1", port,
            origin_host: "client.example.com", origin_realm: "example.com",
            timeout: 10000,
          })
        )
      );
      assert.ok(results.every(r => r.ok === true));
    } finally { srv.close(); }
  });

  await test("mixed parallel CER + DWR + send_request (15 total) all succeed", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    try {
      const cerReqs = Array.from({ length: 5 }, () =>
        ops.diameterClient({
          operation: "capabilities_exchange",
          host: "127.0.0.1", port,
          origin_host: "client.example.com", origin_realm: "example.com",
          timeout: 10000,
        })
      );
      const dwrReqs = Array.from({ length: 5 }, () =>
        ops.diameterClient({
          operation: "device_watchdog",
          host: "127.0.0.1", port,
          origin_host: "client.example.com", origin_realm: "example.com",
          timeout: 10000,
        })
      );
      const srReqs = Array.from({ length: 5 }, () =>
        ops.diameterClient({
          operation: "send_request",
          host: "127.0.0.1", port,
          origin_host: "client.example.com", origin_realm: "example.com",
          command_code: CMD.WATCHDOG,
          timeout: 10000,
        })
      );
      const results = await Promise.all([...cerReqs, ...dwrReqs, ...srReqs]);
      assert.ok(results.every(r => r.ok === true));
    } finally { srv.close(); }
  });

  await test("rapid sequential 30 DWR requests all succeed", async () => {
    const port = await getFreePort();
    let count = 0;
    const srv = await startMockServer(port, (req) => {
      count++;
      return buildAnswer(req);
    });
    try {
      for (let i = 0; i < 30; i++) {
        const r = await ops.diameterClient({
          operation: "device_watchdog",
          host: "127.0.0.1", port,
          origin_host: "client.example.com", origin_realm: "example.com",
          timeout: 5000,
        });
        assert.equal(r.ok, true);
      }
      assert.equal(count, 30);
    } finally { srv.close(); }
  });

  await test("concurrent requests produce unique hop-by-hop IDs", async () => {
    const port = await getFreePort();
    const receivedHbhs = new Set();
    const srv = await startMockServer(port, (req) => {
      receivedHbhs.add(req.readUInt32BE(12));
      return buildAnswer(req);
    });
    try {
      await Promise.all(
        Array.from({ length: 20 }, () =>
          ops.diameterClient({
            operation: "device_watchdog",
            host: "127.0.0.1", port,
            origin_host: "client.example.com", origin_realm: "example.com",
            timeout: 10000,
          })
        )
      );
      // With random 32-bit IDs, we expect close to 20 unique IDs
      assert.ok(receivedHbhs.size >= 15, `Expected 15+ unique HbH IDs, got ${receivedHbhs.size}`);
    } finally { srv.close(); }
  });

  await test("no memory leak: 100 DWR requests do not grow heap unboundedly", async () => {
    const port = await getFreePort();
    const srv = await startMockServer(port, (req) => buildAnswer(req));
    const before = process.memoryUsage().heapUsed;
    try {
      await Promise.all(
        Array.from({ length: 100 }, () =>
          ops.diameterClient({
            operation: "device_watchdog",
            host: "127.0.0.1", port,
            origin_host: "client.example.com", origin_realm: "example.com",
            timeout: 10000,
          })
        )
      );
      if (global.gc) global.gc();
      const after = process.memoryUsage().heapUsed;
      assert.ok((after - before) < 20 * 1024 * 1024,
        `Heap grew by ${Math.round((after - before) / 1024)} KB for 100 requests`);
    } finally { srv.close(); }
  });

  await test("socket always closed after connection refused (no leak)", async () => {
    const port = await getFreePort();
    // Make two failed requests in a row; neither should crash with EMFILE
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        () => ops.diameterClient({
          operation: "capabilities_exchange",
          host: "127.0.0.1", port,
          origin_host: "client.example.com", origin_realm: "example.com",
          timeout: 1000,
        }),
        /Socket error|ECONNREFUSED/i
      );
    }
  });

  await test("send_request with user_name AVP sent correctly", async () => {
    const port = await getFreePort();
    let rcvAvps = null;
    const srv = await startMockServer(port, (req) => {
      rcvAvps = parseMessage(req).avps;
      return buildAnswer(req);
    });
    try {
      await ops.diameterClient({
        operation: "send_request",
        host: "127.0.0.1", port,
        origin_host: "client.example.com", origin_realm: "example.com",
        command_code: CMD.CAPABILITIES_EXCHANGE,
        user_name: "testuser@example.com",
        timeout: 5000,
      });
      const unAvp = rcvAvps.find(a => a.code === AVP.USER_NAME);
      assert.ok(unAvp);
      assert.equal(unAvp.decoded, "testuser@example.com");
    } finally { srv.close(); }
  });

  // ── Final report ────────────────────────────────────────────────────────────────────
  const total = passed + failed + skipped;
  process.stderr.write(`\n== Section 262 diameter_client: ${passed}/${total} passed`);
  if (skipped) process.stderr.write(` (${skipped} skipped)`);
  if (failed)  process.stderr.write(` [${failed} FAILED]`);
  process.stderr.write(" ==\n");
  if (failures.length) {
    for (const f of failures) process.stderr.write(`   FAIL: ${f.name}: ${f.err.message}\n`);
    process.exit(1);
  }
}

runAll().catch(err => {
  process.stderr.write(`Unexpected error: ${err.stack || err}\n`);
  process.exit(1);
});
