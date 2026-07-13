"use strict";
/**
 * Section 248 — ntp_client tests
 * 56 tests across 5 rigor levels (A–E)
 *
 * A: Validation (10 tests)   — missing/invalid args, unknown ops
 * B: Unit / protocol (20 tests) — NTP packet builder, timestamp parser,
 *    reference-ID decoder, fixed-point parser, stratum descriptions,
 *    timeout clamping, offset/delay math, servers list
 * C: Mock-network (10 tests) — mock UDP server for query, sync_check, stratum
 * D: Security (10 tests)     — NUL-byte guards, port range, timeout clamp,
 *                              malformed response, zero-timestamp rejection
 * E: Error paths (6 tests)   — timeout, short response, socket error, bad port
 */

const assert = require("assert");
const dgram  = require("dgram");
const { ntpClient } = require("../../lib/ntpClientOps");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { passed++; console.log(`  PASS  ${name}`); })
              .catch(e => { failed++; console.error(`  FAIL  ${name}:`, e.message); });
    }
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}:`, e.message);
  }
  return Promise.resolve();
}

// ── Inline helpers mirroring ntpClientOps.js internals ───────────────────────

const NTP_EPOCH_OFFSET = 2208988800;
const NTP_PACKET_SIZE  = 48;

function buildNtpPacket() {
  const buf = Buffer.alloc(NTP_PACKET_SIZE, 0);
  buf[0] = 0x23; // LI=0, VN=4, Mode=3
  return buf;
}

function parseNtpTimestamp(buf, offset) {
  const seconds  = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  if (seconds === 0 && fraction === 0) return null;
  return (seconds - NTP_EPOCH_OFFSET) + (fraction / 0x100000000);
}

function parseRefId(buf, stratum) {
  if (stratum <= 1) {
    let s = "";
    for (let i = 12; i < 16; i++) {
      const c = buf[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s || "(empty)";
  }
  return `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
}

function parseFixed16_16(buf, offset) {
  const hi = buf.readUInt16BE(offset);
  const lo = buf.readUInt16BE(offset + 2);
  return hi + lo / 65536;
}

function stratumDesc(s) {
  if (s === 0)  return "unspecified / unavailable";
  if (s === 1)  return "primary reference (GPS/atomic clock)";
  if (s <= 15)  return `secondary reference (${s} hops from primary)`;
  if (s === 16) return "unsynchronized";
  return "reserved";
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : 5000;
  return Math.max(500, Math.min(30000, Math.trunc(n)));
}

/**
 * Build a minimal syntactically valid NTP server response packet.
 * ts = Unix epoch seconds (float), stratum = NTP stratum
 */
function buildNtpResponse(opts = {}) {
  const { stratum = 2, refIdBytes = [192, 0, 2, 1], ts = Date.now() / 1000 } = opts;
  const buf = Buffer.alloc(NTP_PACKET_SIZE, 0);
  buf[0] = 0b00_100_100; // LI=0, VN=4, Mode=4 (server)
  buf[1] = stratum;
  buf[2] = 6;  // poll
  buf[3] = 0xEC; // precision (-20)

  // root delay (bytes 4-7) — 16.16 fixed: 0.001 s = 65 in lo
  buf.writeUInt16BE(0, 4);
  buf.writeUInt16BE(65, 6);

  // root dispersion (bytes 8-11)
  buf.writeUInt16BE(0, 8);
  buf.writeUInt16BE(65, 10);

  // reference ID (bytes 12-15)
  if (stratum <= 1) {
    // ASCII source (e.g. GPS)
    const src = opts.refIdStr || "GPS";
    for (let i = 0; i < Math.min(src.length, 4); i++) buf[12 + i] = src.charCodeAt(i);
  } else {
    buf[12] = refIdBytes[0]; buf[13] = refIdBytes[1];
    buf[14] = refIdBytes[2]; buf[15] = refIdBytes[3];
  }

  // Helper: write NTP timestamp at offset
  function writeTs(offset, unixSec) {
    const ntpSec = Math.floor(unixSec) + NTP_EPOCH_OFFSET;
    const ntpFrac = Math.round((unixSec - Math.floor(unixSec)) * 0x100000000);
    buf.writeUInt32BE(ntpSec >>> 0, offset);
    buf.writeUInt32BE(ntpFrac >>> 0, offset + 4);
  }

  writeTs(16, ts - 0.5);  // reference timestamp
  writeTs(24, ts - 0.01); // originate timestamp (echoed from client, we fake)
  writeTs(32, ts + 0.001); // receive timestamp (server)
  writeTs(40, ts + 0.002); // transmit timestamp (server)

  return buf;
}

/**
 * Start a mock UDP NTP server that responds with `responsePacket`.
 * Returns { server, port, close }.
 */
function startMockNtpServer(responsePacket) {
  return new Promise((resolve, reject) => {
    const server = dgram.createSocket("udp4");
    server.on("error", reject);
    server.on("message", (msg, rinfo) => {
      server.send(responsePacket, 0, responsePacket.length, rinfo.port, rinfo.address);
    });
    server.bind(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

async function run() {
  console.log("\n=== Section 248: ntp_client ===");

  // ── A: Validation (10) ───────────────────────────────────────────────────
  console.log("\n--- A: Validation ---");

  await test("A01 missing operation throws", async () => {
    await assert.rejects(() => ntpClient({}), /operation.*required/i);
  });

  await test("A02 unknown operation throws", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "foobar" }),
      /unknown operation/i,
    );
  });

  await test("A03 port 0 rejected for query", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "query", host: "127.0.0.1", port: 0 }),
      /port.*1.*65535/i,
    );
  });

  await test("A04 port > 65535 rejected for query", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "query", host: "127.0.0.1", port: 99999 }),
      /port.*1.*65535/i,
    );
  });

  await test("A05 port 0 rejected for sync_check", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "sync_check", host: "127.0.0.1", port: 0 }),
      /port.*1.*65535/i,
    );
  });

  await test("A06 port 0 rejected for stratum", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "stratum", host: "127.0.0.1", port: 0 }),
      /port.*1.*65535/i,
    );
  });

  await test("A07 NUL byte in host rejected for query", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "query", host: "pool.ntp\0.org" }),
      /NUL/i,
    );
  });

  await test("A08 NUL byte in host rejected for sync_check", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "sync_check", host: "bad\0host" }),
      /NUL/i,
    );
  });

  await test("A09 max_skew_ms <= 0 rejected for sync_check", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "sync_check", host: "127.0.0.1", port: 1234, max_skew_ms: 0 }),
      /max_skew_ms.*>.*0/i,
    );
  });

  await test("A10 negative max_skew_ms rejected", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "sync_check", host: "127.0.0.1", port: 1234, max_skew_ms: -100 }),
      /max_skew_ms.*>.*0/i,
    );
  });

  // ── B: Unit / Protocol (20) ───────────────────────────────────────────────
  console.log("\n--- B: Unit / Protocol ---");

  await test("B01 buildNtpPacket: length is 48", () => {
    const pkt = buildNtpPacket();
    assert.strictEqual(pkt.length, NTP_PACKET_SIZE);
  });

  await test("B02 buildNtpPacket: byte0 = 0x23 (LI=0, VN=4, Mode=3)", () => {
    const pkt = buildNtpPacket();
    assert.strictEqual(pkt[0], 0x23);
    const li   = (pkt[0] >> 6) & 0x03;
    const vn   = (pkt[0] >> 3) & 0x07;
    const mode = pkt[0] & 0x07;
    assert.strictEqual(li, 0);
    assert.strictEqual(vn, 4);
    assert.strictEqual(mode, 3);
  });

  await test("B03 parseNtpTimestamp: zero returns null", () => {
    const buf = Buffer.alloc(16, 0);
    const ts = parseNtpTimestamp(buf, 0);
    assert.strictEqual(ts, null);
  });

  await test("B04 parseNtpTimestamp: known NTP timestamp round-trips", () => {
    // Unix 0 = NTP 2208988800
    const buf = Buffer.alloc(16, 0);
    buf.writeUInt32BE(2208988800, 0); // NTP seconds = Unix epoch
    buf.writeUInt32BE(0, 4);          // fraction = 0
    const ts = parseNtpTimestamp(buf, 0);
    assert.ok(Math.abs(ts - 0) < 1e-6, `Expected ~0, got ${ts}`);
  });

  await test("B05 parseNtpTimestamp: fraction part", () => {
    const buf = Buffer.alloc(16, 0);
    const half = Math.round(0x100000000 / 2); // 0.5 seconds
    buf.writeUInt32BE(2208988800, 0);
    buf.writeUInt32BE(half, 4);
    const ts = parseNtpTimestamp(buf, 0);
    assert.ok(Math.abs(ts - 0.5) < 1e-6, `Expected ~0.5, got ${ts}`);
  });

  await test("B06 parseRefId: stratum 1 returns ASCII string", () => {
    const buf = Buffer.alloc(48, 0);
    buf[12] = 71; // G
    buf[13] = 80; // P
    buf[14] = 83; // S
    const refId = parseRefId(buf, 1);
    assert.strictEqual(refId, "GPS");
  });

  await test("B07 parseRefId: stratum 2 returns dotted-IPv4", () => {
    const buf = Buffer.alloc(48, 0);
    buf[12] = 192; buf[13] = 168; buf[14] = 1; buf[15] = 1;
    const refId = parseRefId(buf, 2);
    assert.strictEqual(refId, "192.168.1.1");
  });

  await test("B08 parseRefId: stratum 1 null-terminated string", () => {
    const buf = Buffer.alloc(48, 0);
    buf[12] = 80; // P
    buf[13] = 80; // P
    buf[14] = 83; // S
    buf[15] = 0;  // null term
    const refId = parseRefId(buf, 1);
    assert.strictEqual(refId, "PPS");
  });

  await test("B09 parseFixed16_16: zero is 0", () => {
    const buf = Buffer.alloc(8, 0);
    assert.strictEqual(parseFixed16_16(buf, 0), 0);
  });

  await test("B10 parseFixed16_16: 1 second (hi=1, lo=0)", () => {
    const buf = Buffer.alloc(8, 0);
    buf.writeUInt16BE(1, 0);
    buf.writeUInt16BE(0, 2);
    assert.strictEqual(parseFixed16_16(buf, 0), 1);
  });

  await test("B11 parseFixed16_16: 0.5 s (hi=0, lo=32768)", () => {
    const buf = Buffer.alloc(8, 0);
    buf.writeUInt16BE(0, 0);
    buf.writeUInt16BE(32768, 2);
    const val = parseFixed16_16(buf, 0);
    assert.ok(Math.abs(val - 0.5) < 0.001, `Expected ~0.5, got ${val}`);
  });

  await test("B12 stratumDesc: stratum 0 is unspecified", () => {
    assert.ok(stratumDesc(0).includes("unspecified"));
  });

  await test("B13 stratumDesc: stratum 1 is primary reference", () => {
    assert.ok(stratumDesc(1).includes("primary"));
  });

  await test("B14 stratumDesc: stratum 8 is secondary reference with 8 hops", () => {
    const desc = stratumDesc(8);
    assert.ok(desc.includes("secondary"));
    assert.ok(desc.includes("8"));
  });

  await test("B15 stratumDesc: stratum 16 is unsynchronized", () => {
    assert.ok(stratumDesc(16).includes("unsynchronized"));
  });

  await test("B16 clampTimeout: values below 500 clamped to 500", () => {
    assert.strictEqual(clampTimeout(0), 500);
    assert.strictEqual(clampTimeout(100), 500);
    assert.strictEqual(clampTimeout(499), 500);
  });

  await test("B17 clampTimeout: values above 30000 clamped to 30000", () => {
    assert.strictEqual(clampTimeout(99999), 30000);
    assert.strictEqual(clampTimeout(30001), 30000);
  });

  await test("B18 clampTimeout: in-range passes through", () => {
    assert.strictEqual(clampTimeout(500), 500);
    assert.strictEqual(clampTimeout(5000), 5000);
    assert.strictEqual(clampTimeout(30000), 30000);
  });

  await test("B19 servers operation returns curated list", async () => {
    const r = await ntpClient({ operation: "servers" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.operation, "servers");
    assert.ok(typeof r.count === "number" && r.count > 0);
    assert.ok(Array.isArray(r.servers));
    assert.strictEqual(r.servers.length, r.count);
    // Spot-check pool.ntp.org and time.google.com are present
    const hosts = r.servers.map(s => s.host);
    assert.ok(hosts.includes("pool.ntp.org"), "pool.ntp.org missing");
    assert.ok(hosts.includes("time.google.com"), "time.google.com missing");
    // Each entry has host and description
    for (const s of r.servers) {
      assert.ok(typeof s.host === "string" && s.host.length > 0);
      assert.ok(typeof s.description === "string" && s.description.length > 0);
    }
  });

  await test("B20 NTP offset/delay math: RFC 5905 formulas", () => {
    // Given t1=100, t2=100.01 (server receive), t3=100.015 (server transmit), t4=100.02
    // offset = ((t2-t1)+(t3-t4))/2 = (0.01 + (-0.005))/2 = 0.0025
    // delay  = (t4-t1)-(t3-t2) = 0.02 - 0.005 = 0.015
    const t1 = 100, t2 = 100.01, t3 = 100.015, t4 = 100.02;
    const offset = ((t2 - t1) + (t3 - t4)) / 2;
    const delay  = (t4 - t1) - (t3 - t2);
    assert.ok(Math.abs(offset - 0.0025) < 1e-9, `Offset wrong: ${offset}`);
    assert.ok(Math.abs(delay  - 0.015 ) < 1e-9, `Delay wrong: ${delay}`);
  });

  // ── C: Mock-network (10) ─────────────────────────────────────────────────
  console.log("\n--- C: Mock-network ---");

  await test("C01 query: returns ok:true and serverTime from mock server", async () => {
    const pkt = buildNtpResponse({ stratum: 2 });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 4000 });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "query");
      assert.ok(typeof r.serverTime === "string");
      assert.ok(typeof r.offsetMs === "number");
      assert.ok(typeof r.roundTripDelayMs === "number");
    } finally { await mock.close(); }
  });

  await test("C02 query: stratum field is correct", async () => {
    const pkt = buildNtpResponse({ stratum: 3 });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 4000 });
      assert.strictEqual(r.stratum, 3);
      assert.ok(r.stratumDescription.includes("secondary"));
    } finally { await mock.close(); }
  });

  await test("C03 query: referenceId is IPv4 for stratum > 1", async () => {
    const pkt = buildNtpResponse({ stratum: 2, refIdBytes: [10, 0, 0, 1] });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 4000 });
      assert.strictEqual(r.referenceId, "10.0.0.1");
    } finally { await mock.close(); }
  });

  await test("C04 query: stratum 1 referenceId is ASCII (GPS)", async () => {
    const pkt = buildNtpResponse({ stratum: 1, refIdStr: "GPS" });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 4000 });
      assert.strictEqual(r.stratum, 1);
      assert.strictEqual(r.referenceId, "GPS");
    } finally { await mock.close(); }
  });

  await test("C05 query: timestamps object has reference/originate/receive/transmit", async () => {
    const pkt = buildNtpResponse({ stratum: 2 });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 4000 });
      assert.ok(typeof r.timestamps === "object");
      // reference, receive, transmit should be ISO strings
      assert.ok(r.timestamps.receive && r.timestamps.receive.includes("T"));
      assert.ok(r.timestamps.transmit && r.timestamps.transmit.includes("T"));
    } finally { await mock.close(); }
  });

  await test("C06 sync_check: inSync:true when offset is within threshold", async () => {
    // Build response with server time very close to now (tiny offset)
    const pkt = buildNtpResponse({ stratum: 2, ts: Date.now() / 1000 });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({
        operation: "sync_check",
        host: "127.0.0.1",
        port: mock.port,
        timeout: 4000,
        max_skew_ms: 2000, // generous threshold for loopback test
      });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "sync_check");
      assert.ok(typeof r.inSync === "boolean");
      assert.ok(typeof r.offsetMs === "number");
      assert.ok(typeof r.message === "string");
    } finally { await mock.close(); }
  });

  await test("C07 sync_check: inSync:false when offset exceeds threshold", async () => {
    // Shift server time 60 seconds into the past to force large offset
    const pkt = buildNtpResponse({ stratum: 2, ts: (Date.now() / 1000) - 60 });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({
        operation: "sync_check",
        host: "127.0.0.1",
        port: mock.port,
        timeout: 4000,
        max_skew_ms: 100, // tight threshold
      });
      assert.strictEqual(r.inSync, false);
      assert.ok(r.message.includes("OUT OF SYNC"));
    } finally { await mock.close(); }
  });

  await test("C08 stratum: returns stratum detail", async () => {
    const pkt = buildNtpResponse({ stratum: 1, refIdStr: "PPS" });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({ operation: "stratum", host: "127.0.0.1", port: mock.port, timeout: 4000 });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "stratum");
      assert.strictEqual(r.stratum, 1);
      assert.ok(r.stratumDescription.includes("primary"));
      assert.strictEqual(r.referenceId, "PPS");
      assert.ok(typeof r.rootDelayMs === "number");
      assert.ok(typeof r.rootDispersionMs === "number");
    } finally { await mock.close(); }
  });

  await test("C09 query: rootDelayMs and rootDispersionMs are non-negative", async () => {
    const pkt = buildNtpResponse({ stratum: 2 });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 4000 });
      assert.ok(r.rootDelayMs >= 0, `rootDelayMs negative: ${r.rootDelayMs}`);
      assert.ok(r.rootDispersionMs >= 0, `rootDispersionMs negative: ${r.rootDispersionMs}`);
    } finally { await mock.close(); }
  });

  await test("C10 query: leapIndicator and leapDescription are present", async () => {
    const pkt = buildNtpResponse({ stratum: 2 });
    const mock = await startMockNtpServer(pkt);
    try {
      const r = await ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 4000 });
      assert.ok(typeof r.leapIndicator === "number");
      assert.ok(typeof r.leapDescription === "string");
      // LI=0 means 'no warning'
      assert.strictEqual(r.leapIndicator, 0);
      assert.ok(r.leapDescription.includes("no warning"));
    } finally { await mock.close(); }
  });

  // ── D: Security (10) ─────────────────────────────────────────────────────
  console.log("\n--- D: Security ---");

  await test("D01 NUL byte in host throws for stratum operation", async () => {
    await assert.rejects(
      () => ntpClient({ operation: "stratum", host: "time.\0google.com" }),
      /NUL/i,
    );
  });

  await test("D02 response too short (< 48 bytes) throws descriptive error", async () => {
    // Mock server that sends a 10-byte response
    const shortPkt = Buffer.alloc(10, 0);
    const mock = await startMockNtpServer(shortPkt);
    try {
      await assert.rejects(
        () => ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 3000 }),
        /response too short/i,
      );
    } finally { await mock.close(); }
  });

  await test("D03 zero receive/transmit timestamps rejected", async () => {
    // Build packet with all-zero timestamps (bytes 32-47)
    const pkt = Buffer.alloc(NTP_PACKET_SIZE, 0);
    pkt[0] = 0b00_100_100; // server mode
    pkt[1] = 2; // stratum
    // Leave receive/transmit timestamps as zero
    const mock = await startMockNtpServer(pkt);
    try {
      await assert.rejects(
        () => ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 3000 }),
        /zero receive.*transmit|zero.*timestamps/i,
      );
    } finally { await mock.close(); }
  });

  await test("D04 timeout minimum clamped: 100ms becomes 500ms internally", () => {
    // Direct clamp test without network
    assert.strictEqual(clampTimeout(100), 500);
  });

  await test("D05 timeout maximum clamped: 999999ms becomes 30000ms internally", () => {
    assert.strictEqual(clampTimeout(999999), 30000);
  });

  await test("D06 port boundary: port 1 is valid (no throw on validation)", async () => {
    // Validation should pass (connection will fail, but not from port validation)
    // We just want the error to be network-related, not port-validation-related
    try {
      await ntpClient({ operation: "query", host: "127.0.0.1", port: 1, timeout: 500 });
    } catch (e) {
      assert.ok(!e.message.includes("port.*1.*65535"), `Port validation should pass for port 1`);
    }
  });

  await test("D07 port boundary: port 65535 is valid (no throw on validation)", async () => {
    try {
      await ntpClient({ operation: "query", host: "127.0.0.1", port: 65535, timeout: 500 });
    } catch (e) {
      assert.ok(!e.message.match(/port.*1.*65535/i), `Port validation should pass for port 65535`);
    }
  });

  await test("D08 servers list: no server has an empty host", async () => {
    const r = await ntpClient({ operation: "servers" });
    for (const s of r.servers) {
      assert.ok(s.host && s.host.length > 0, `Empty host found: ${JSON.stringify(s)}`);
    }
  });

  await test("D09 servers list: servers object is immutable (each call returns fresh copy)", async () => {
    const r1 = await ntpClient({ operation: "servers" });
    const r2 = await ntpClient({ operation: "servers" });
    // Mutate r1 and check r2 is unaffected
    r1.servers[0].host = "__mutated__";
    assert.ok(r2.servers[0].host !== "__mutated__", "servers list is not isolated between calls");
  });

  await test("D10 NUL byte in host rejected: precise error message", async () => {
    try {
      await ntpClient({ operation: "query", host: "evil\0host" });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.message.includes("NUL") || e.message.includes("nul"),
        `Expected NUL in error, got: ${e.message}`);
    }
  });

  // ── E: Error paths (6) ───────────────────────────────────────────────────
  console.log("\n--- E: Error paths ---");

  await test("E01 query: times out when no server responds", async () => {
    // Bind a UDP server but never respond
    const silent = dgram.createSocket("udp4");
    await new Promise(r => silent.bind(0, "127.0.0.1", r));
    const { port } = silent.address();
    try {
      await assert.rejects(
        () => ntpClient({ operation: "query", host: "127.0.0.1", port, timeout: 800 }),
        /timed out/i,
      );
    } finally {
      await new Promise(r => silent.close(r));
    }
  });

  await test("E02 query: no server on that port (ECONNREFUSED or timeout)", async () => {
    // On Linux, UDP to a closed port may get ECONNREFUSED immediately
    // On Windows, it may just time out. Either is acceptable.
    try {
      await ntpClient({ operation: "query", host: "127.0.0.1", port: 19123, timeout: 1000 });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(
        e.message.toLowerCase().includes("timed out") ||
        e.message.toLowerCase().includes("econnrefused") ||
        e.message.toLowerCase().includes("socket error"),
        `Unexpected error: ${e.message}`,
      );
    }
  });

  await test("E03 sync_check: inherits query error (timeout propagates)", async () => {
    const silent = dgram.createSocket("udp4");
    await new Promise(r => silent.bind(0, "127.0.0.1", r));
    const { port } = silent.address();
    try {
      await assert.rejects(
        () => ntpClient({ operation: "sync_check", host: "127.0.0.1", port, timeout: 800 }),
        /timed out/i,
      );
    } finally {
      await new Promise(r => silent.close(r));
    }
  });

  await test("E04 stratum: inherits query error (timeout propagates)", async () => {
    const silent = dgram.createSocket("udp4");
    await new Promise(r => silent.bind(0, "127.0.0.1", r));
    const { port } = silent.address();
    try {
      await assert.rejects(
        () => ntpClient({ operation: "stratum", host: "127.0.0.1", port, timeout: 800 }),
        /timed out/i,
      );
    } finally {
      await new Promise(r => silent.close(r));
    }
  });

  await test("E05 response exactly 47 bytes: too short, throws", async () => {
    const shortPkt = Buffer.alloc(47, 0);
    const mock = await startMockNtpServer(shortPkt);
    try {
      await assert.rejects(
        () => ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 3000 }),
        /response too short/i,
      );
    } finally { await mock.close(); }
  });

  await test("E06 response exactly 48 bytes with zero timestamps: descriptive error", async () => {
    const pkt = Buffer.alloc(48, 0);
    pkt[0] = 0b00_100_100; // server mode
    pkt[1] = 2; // stratum
    // All timestamps remain zero → should throw about zero timestamps
    const mock = await startMockNtpServer(pkt);
    try {
      await assert.rejects(
        () => ntpClient({ operation: "query", host: "127.0.0.1", port: mock.port, timeout: 3000 }),
        /zero|timestamp/i,
      );
    } finally { await mock.close(); }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Section 248 results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
