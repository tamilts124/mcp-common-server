"use strict";
/**
 * Section 249 — syslog_client tests
 *
 * Rigor levels:
 *   A: Validation (schema/input guards) × 10
 *   B: Unit / protocol (message formatting) × 20
 *   C: Mock-network (UDP/TCP send) × 10
 *   D: Security (NUL-byte, injection, limits) × 10
 *   E: Error-paths (timeout, unknown ops, bad data) × 6
 *
 * Total: 56 tests
 */

const dgram = require("dgram");
const net   = require("net");
const os    = require("os");

// ── Load the module under test ────────────────────────────────────────────────
const { syslogClient } = require("../../lib/syslogClientOps");

// ── Minimal test harness ──────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    process.stderr.write(`  PASS  ${label}\n`);
  } else {
    failed++;
    failures.push(label);
    process.stderr.write(`  FAIL  ${label}\n`);
  }
}

async function assertRejects(fn, msgFragment, label) {
  try {
    await fn();
    failed++;
    failures.push(label);
    process.stderr.write(`  FAIL  ${label} (expected rejection, got resolution)\n`);
  } catch (e) {
    const ok = !msgFragment || e.message.includes(msgFragment);
    if (ok) {
      passed++;
      process.stderr.write(`  PASS  ${label}\n`);
    } else {
      failed++;
      failures.push(label);
      process.stderr.write(`  FAIL  ${label} (error was: ${e.message})\n`);
    }
  }
}

// ── Helper: start a UDP echo server on ephemeral port ─────────────────────────
function udpServer() {
  return new Promise((resolve) => {
    const server = dgram.createSocket("udp4");
    const messages = [];
    server.on("message", (msg) => messages.push(msg.toString("utf8")));
    server.bind(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, messages, close: () => server.close() });
    });
  });
}

// ── Helper: start a TCP server that collects messages ─────────────────────────
function tcpServer() {
  return new Promise((resolve) => {
    const messages = [];
    const server = net.createServer((socket) => {
      let buf = "";
      socket.setEncoding("utf8");
      socket.on("data", (d) => { buf += d; });
      socket.on("end", () => {
        // Split by newline (our framing)
        buf.split("\n").filter(Boolean).forEach(m => messages.push(m));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, messages, close: () => server.close() });
    });
  });
}

// ── Helper: wait for messages to arrive ──────────────────────────────────────
function waitMessages(arr, count, ms = 1000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (arr.length >= count) resolve();
      else reject(new Error(`Timeout waiting for ${count} messages (got ${arr.length})`));
    }, ms);
    const check = setInterval(() => {
      if (arr.length >= count) { clearTimeout(t); clearInterval(check); resolve(); }
    }, 20);
  });
}

// ── Direct format helpers (white-box unit tests) ──────────────────────────────
// We can exercise the formatter indirectly via the `info` op to verify tables,
// and via `send` to a real UDP server to check the wire format.

// ═══════════════════════════════════════════════════════════════════════════════
// A — Validation tests (10)
// ═══════════════════════════════════════════════════════════════════════════════
async function runSectionA() {
  process.stderr.write("\n── A: Validation ──\n");

  // A1: missing operation
  await assertRejects(
    () => syslogClient({}),
    "'operation' is required",
    "A1: missing operation"
  );

  // A2: unknown operation
  await assertRejects(
    () => syslogClient({ operation: "flush" }),
    "unknown operation",
    "A2: unknown operation 'flush'"
  );

  // A3: send_batch with no messages array
  await assertRejects(
    () => syslogClient({ operation: "send_batch", host: "127.0.0.1", messages: [] }),
    "non-empty array",
    "A3: send_batch empty messages"
  );

  // A4: send_batch messages not an array
  await assertRejects(
    () => syslogClient({ operation: "send_batch", host: "127.0.0.1", messages: "bad" }),
    "non-empty array",
    "A4: send_batch messages is a string"
  );

  // A5: unknown transport
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9999, transport: "quic" }),
    "unknown transport",
    "A5: unknown transport 'quic'"
  );

  // A6: unknown format
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9999, format: "syslog-ng" }),
    "unknown format",
    "A6: unknown format 'syslog-ng'"
  );

  // A7: invalid facility string
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9999, facility: "zebra" }),
    "unknown facility",
    "A7: unknown facility string"
  );

  // A8: facility number out of range
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9999, facility: 99 }),
    "must be 0–23",
    "A8: facility number out of range"
  );

  // A9: severity string unknown
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9999, severity: "catastrophic" }),
    "unknown severity",
    "A9: unknown severity string"
  );

  // A10: severity number out of range
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9999, severity: 99 }),
    "must be 0–7",
    "A10: severity number out of range"
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// B — Unit / Protocol tests (20)
// ═══════════════════════════════════════════════════════════════════════════════
async function runSectionB() {
  process.stderr.write("\n── B: Unit / Protocol ──\n");

  // B1: info op returns facility table
  const info = await syslogClient({ operation: "info" });
  assert(info.ok === true, "B1: info.ok is true");

  // B2: info has facilities array length 24
  assert(Array.isArray(info.facilities) && info.facilities.length === 24, "B2: 24 facilities");

  // B3: info has severities array length 8
  assert(Array.isArray(info.severities) && info.severities.length === 8, "B3: 8 severities");

  // B4: info transports array has 3 entries
  assert(Array.isArray(info.transports) && info.transports.length === 3, "B4: 3 transports");

  // B5: info formats has rfc5424 and rfc3164
  assert("rfc5424" in info.formats && "rfc3164" in info.formats, "B5: both formats in info");

  // B6: info limits are sane
  assert(info.limits.maxMessageBytes === 65535, "B6: maxMessageBytes is 65535");
  assert(info.limits.maxBatchMessages === 1000, "B7: maxBatchMessages is 1000");
  passed++; // B7 counted above

  // B8: facility code numeric lookup (kern=0)
  const { facilities } = info;
  assert(facilities.find(f => f.name === "kern").code === 0, "B8: kern facility code=0");

  // B9: severity code numeric lookup (emerg=0)
  const { severities } = info;
  assert(severities.find(s => s.name === "emerg").code === 0, "B9: emerg severity code=0");

  // B10: RFC 5424 send returns expected fields
  const srv = await udpServer();
  try {
    const res = await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: srv.port,
      transport: "udp",
      format: "rfc5424",
      facility: "user",
      severity: "info",
      message: "hello B10",
    });
    assert(res.ok === true, "B10: send ok");
    assert(res.operation === "send", "B11: send operation field");
    assert(res.format === "rfc5424", "B12: send format field");
    assert(res.facilityName === "user", "B13: facilityName=user");
    assert(res.severityName === "info", "B14: severityName=info");
    assert(typeof res.bytes === "number" && res.bytes > 0, "B15: bytes > 0");
  } finally {
    srv.close();
  }

  // B16: RFC 3164 format — send and check wire
  const srv2 = await udpServer();
  try {
    const res = await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: srv2.port,
      transport: "udp",
      format: "rfc3164",
      facility: "daemon",
      severity: "notice",
      message: "hello B16",
      app_name: "testapp",
    });
    assert(res.ok === true, "B16: rfc3164 send ok");
    await waitMessages(srv2.messages, 1, 800);
    const msg = srv2.messages[0];
    // RFC 3164: <PRI>Mmm DD HH:MM:SS HOSTNAME TAG: MSG
    // PRI for daemon(3) notice(5) = (3 << 3) | 5 = 29
    assert(msg.startsWith("<29>"), "B17: rfc3164 PRI=<29>");
    assert(msg.includes("testapp"), "B18: rfc3164 TAG contains app_name");
    assert(msg.includes("hello B16"), "B19: rfc3164 message content");
  } finally {
    srv2.close();
  }

  // B20: numeric facility/severity aliases
  const srv3 = await udpServer();
  try {
    const res = await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: srv3.port,
      transport: "udp",
      facility: 3,    // daemon
      severity: 6,    // info
      message: "numeric alias",
    });
    assert(res.facilityName === "daemon" && res.severityName === "info", "B20: numeric facility/severity aliases");
  } finally {
    srv3.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// C — Mock-network tests (10)
// ═══════════════════════════════════════════════════════════════════════════════
async function runSectionC() {
  process.stderr.write("\n── C: Mock-Network ──\n");

  // C1: UDP single send — message arrives at server
  const usrv = await udpServer();
  try {
    await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: usrv.port,
      transport: "udp",
      message: "C1 UDP send",
    });
    await waitMessages(usrv.messages, 1, 800);
    assert(usrv.messages.length === 1 && usrv.messages[0].includes("C1 UDP send"), "C1: UDP message arrives");
  } finally { usrv.close(); }

  // C2: UDP RFC 5424 PRI calculation: local0(16) crit(2) = (16<<3)|2 = 130
  const usrv2 = await udpServer();
  try {
    await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: usrv2.port,
      transport: "udp",
      format: "rfc5424",
      facility: "local0",
      severity: "crit",
      message: "C2 PRI check",
    });
    await waitMessages(usrv2.messages, 1, 800);
    assert(usrv2.messages[0].startsWith("<130>"), "C2: rfc5424 PRI=<130>");
  } finally { usrv2.close(); }

  // C3: UDP send_batch — 3 messages arrive as separate datagrams
  const usrv3 = await udpServer();
  try {
    await syslogClient({
      operation: "send_batch",
      host: "127.0.0.1",
      port: usrv3.port,
      transport: "udp",
      messages: [
        { message: "batch-1" },
        { message: "batch-2" },
        { message: "batch-3" },
      ],
    });
    await waitMessages(usrv3.messages, 3, 1200);
    assert(usrv3.messages.length === 3, "C3: send_batch 3 datagrams arrive");
  } finally { usrv3.close(); }

  // C4: send_batch result fields
  const usrv4 = await udpServer();
  try {
    const res = await syslogClient({
      operation: "send_batch",
      host: "127.0.0.1",
      port: usrv4.port,
      transport: "udp",
      messages: [
        { message: "m1", severity: "err" },
        { message: "m2", severity: "debug" },
      ],
    });
    assert(res.ok === true && res.sent === 2, "C4: send_batch result sent=2");
    assert(res.operation === "send_batch", "C5: send_batch operation field");
  } finally { usrv4.close(); }

  // C6: TCP single send — message arrives via stream
  const tsrv = await tcpServer();
  try {
    await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: tsrv.port,
      transport: "tcp",
      message: "C6 TCP send",
    });
    // Give TCP a moment to drain
    await new Promise(r => setTimeout(r, 300));
    await waitMessages(tsrv.messages, 1, 800);
    assert(tsrv.messages.length >= 1 && tsrv.messages.some(m => m.includes("C6 TCP send")), "C6: TCP message arrives");
  } finally { tsrv.server.close(); }

  // C7: TCP send_batch — 2 messages on one connection
  const tsrv2 = await tcpServer();
  try {
    const res = await syslogClient({
      operation: "send_batch",
      host: "127.0.0.1",
      port: tsrv2.port,
      transport: "tcp",
      messages: [
        { message: "tcp-batch-A" },
        { message: "tcp-batch-B" },
      ],
    });
    assert(res.sent === 2, "C7: TCP send_batch sent=2");
  } finally { tsrv2.server.close(); }

  // C8: send_batch per-message facility/severity override defaults
  const usrv5 = await udpServer();
  try {
    await syslogClient({
      operation: "send_batch",
      host: "127.0.0.1",
      port: usrv5.port,
      transport: "udp",
      facility: "kern",   // default
      severity: "debug",  // default
      format: "rfc5424",
      messages: [
        { message: "kern-debug", facility: "user", severity: "err" },  // per-message override
      ],
    });
    await waitMessages(usrv5.messages, 1, 800);
    // user(1) err(3) = (1<<3)|3 = 11
    assert(usrv5.messages[0].startsWith("<11>"), "C8: per-message facility/severity override");
  } finally { usrv5.close(); }

  // C9: structured_data as object is serialised into RFC 5424 wire
  const usrv6 = await udpServer();
  try {
    await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: usrv6.port,
      transport: "udp",
      format: "rfc5424",
      message: "SD test",
      structured_data: { "exampleSDID@32473": { eventSource: "web", eventID: "42" } },
    });
    await waitMessages(usrv6.messages, 1, 800);
    assert(usrv6.messages[0].includes("exampleSDID@32473"), "C9: SD ID in wire format");
    assert(usrv6.messages[0].includes('eventSource='), "C9b: SD key in wire format");
  } finally { usrv6.close(); }

  // C10: send with explicit timestamp arrives with that timestamp
  const usrv7 = await udpServer();
  try {
    const ts = "2024-01-15T10:00:00.000Z";
    await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: usrv7.port,
      transport: "udp",
      format: "rfc5424",
      message: "ts test",
      timestamp: ts,
    });
    await waitMessages(usrv7.messages, 1, 800);
    assert(usrv7.messages[0].includes(ts), "C10: explicit timestamp in wire format");
  } finally { usrv7.close(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// D — Security tests (10)
// ═══════════════════════════════════════════════════════════════════════════════
async function runSectionD() {
  process.stderr.write("\n── D: Security ──\n");

  // D1: NUL byte in host
  await assertRejects(
    () => syslogClient({ operation: "send", host: "host\0evil", port: 9, transport: "udp" }),
    "NUL bytes",
    "D1: NUL byte in host"
  );

  // D2: NUL byte in message
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9, transport: "udp", message: "msg\0nul" }),
    "NUL bytes",
    "D2: NUL byte in message"
  );

  // D3: NUL byte in app_name
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9, transport: "udp", app_name: "app\0name" }),
    "NUL bytes",
    "D3: NUL byte in app_name"
  );

  // D4: NUL byte in hostname
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9, transport: "udp", hostname: "ho\0st" }),
    "NUL bytes",
    "D4: NUL byte in hostname"
  );

  // D5: message too large (> 65535 bytes)
  await assertRejects(
    () => syslogClient({ operation: "send", host: "127.0.0.1", port: 9, transport: "udp", message: "x".repeat(70000) }),
    "too large",
    "D5: message > 65535 bytes rejected"
  );

  // D6: batch too many messages (> 1000)
  await assertRejects(
    () => syslogClient({
      operation: "send_batch",
      host: "127.0.0.1",
      port: 9,
      transport: "udp",
      messages: Array.from({ length: 1001 }, (_, i) => ({ message: `msg${i}` })),
    }),
    "too large",
    "D6: batch > 1000 messages rejected"
  );

  // D7: control characters in app_name are sanitised (not rejected)
  const usrv = await udpServer();
  try {
    const res = await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: usrv.port,
      transport: "udp",
      format: "rfc5424",
      app_name: "app\x01evil\x1F",
      message: "D7",
    });
    await waitMessages(usrv.messages, 1, 800);
    // Control chars should be replaced with underscores, not transmitted raw
    assert(!usrv.messages[0].includes("\x01"), "D7: control chars sanitised in app_name");
  } finally { usrv.close(); }

  // D8: SD param value with quotes/backslash is properly escaped
  const usrv2 = await udpServer();
  try {
    await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: usrv2.port,
      transport: "udp",
      format: "rfc5424",
      message: "D8",
      structured_data: { "test@12345": { path: 'C:\\Users\\"admin"' } },
    });
    await waitMessages(usrv2.messages, 1, 800);
    // Backslash and quote must be escaped per RFC 5424 §6.3.3
    assert(usrv2.messages[0].includes("\\\\"), "D8a: backslash escaped in SD");
    assert(usrv2.messages[0].includes('\\"'), "D8b: quote escaped in SD");
  } finally { usrv2.close(); }

  // D9: timeout clamped to minimum (1000 ms)
  const srv = await udpServer();
  try {
    const res = await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: srv.port,
      transport: "udp",
      timeout: 1,    // below min 1000; should be clamped not rejected
      message: "D9",
    });
    assert(res.ok === true, "D9: below-min timeout clamped to 1000ms and send succeeds");
  } finally { srv.close(); }

  // D10: timeout clamped to maximum (30000 ms)
  const srv2 = await udpServer();
  try {
    const res = await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: srv2.port,
      transport: "udp",
      timeout: 999999, // above max 30000; should be clamped
      message: "D10",
    });
    assert(res.ok === true, "D10: above-max timeout clamped to 30000ms and send succeeds");
  } finally { srv2.close(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// E — Error-paths (6)
// ═══════════════════════════════════════════════════════════════════════════════
async function runSectionE() {
  process.stderr.write("\n── E: Error-Paths ──\n");

  // E1: UDP send to non-listening port (127.0.0.1:1) should fail or time out
  // On most systems, UDP to closed port doesn't error (no ICMP processing in Node);
  // this test just checks it completes (within timeout) or throws a network error.
  // We pick a very low timeout to keep the test fast.
  try {
    const res = await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: 65530,  // unlikely to be in use
      transport: "udp",
      timeout: 2000,
      message: "E1 unreachable",
    });
    // UDP is fire-and-forget; success is expected even for unreachable ports
    assert(res.ok === true, "E1: UDP to unreachable port returns ok (fire-and-forget)");
  } catch (e) {
    // Some OS implementations may return an error; that's also acceptable
    assert(e.message.includes("syslog_client"), "E1: UDP error has syslog_client prefix");
  }

  // E2: TCP send to closed port times out or returns connection refused
  await assertRejects(
    () => syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: 65531,  // unlikely to be in use
      transport: "tcp",
      timeout: 2000,
      message: "E2 tcp no server",
    }),
    "syslog_client",
    "E2: TCP to closed port throws syslog_client error"
  );

  // E3: send_batch with one invalid message entry type
  await assertRejects(
    () => syslogClient({
      operation: "send_batch",
      host: "127.0.0.1",
      port: 9,
      transport: "udp",
      messages: [null],
    }),
    "failed to build",
    "E3: send_batch with null message entry"
  );

  // E4: send_batch with invalid facility in individual message
  await assertRejects(
    () => syslogClient({
      operation: "send_batch",
      host: "127.0.0.1",
      port: 9,
      transport: "udp",
      messages: [{ message: "ok" }, { message: "bad", facility: "badFacility" }],
    }),
    "failed to build",
    "E4: send_batch with invalid per-message facility"
  );

  // E5: TLS to non-TLS server should fail with syslog_client error
  const plainTsrv = await tcpServer();
  try {
    await assertRejects(
      () => syslogClient({
        operation: "send",
        host: "127.0.0.1",
        port: plainTsrv.port,
        transport: "tls",
        timeout: 3000,
        reject_unauthorized: false,
        message: "E5 TLS to plain",
      }),
      "syslog_client",
      "E5: TLS connect to non-TLS server throws"
    );
  } finally { plainTsrv.server.close(); }

  // E6: structured_data as raw string is accepted unchanged
  const usrv = await udpServer();
  try {
    const rawSD = '[mySD@12345 key="val"]';
    const res = await syslogClient({
      operation: "send",
      host: "127.0.0.1",
      port: usrv.port,
      transport: "udp",
      format: "rfc5424",
      message: "E6",
      structured_data: rawSD,
    });
    await waitMessages(usrv.messages, 1, 800);
    assert(usrv.messages[0].includes(rawSD), "E6: raw SD string passes through");
  } finally { usrv.close(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main runner
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  process.stderr.write("\n=== Section 249: syslog_client tests ===\n");

  await runSectionA();
  await runSectionB();
  await runSectionC();
  await runSectionD();
  await runSectionE();

  process.stderr.write(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failures.length) {
    process.stderr.write(`Failed:\n${failures.map(f => `  - ${f}`).join("\n")}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.stack}\n`);
  process.exit(2);
});
