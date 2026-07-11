"use strict";
/**
 * Section 181: port_check + wait_for_port + port_scan_range + dns_lookup tools
 * All 5 rigor levels across 10 sub-sections (A–J).
 *
 * A: port_check — input validation
 * B: port_check — happy path (open/closed)
 * C: wait_for_port — input validation
 * D: wait_for_port — happy path (immediate open, delayed open, timeout)
 * E: port_scan_range — input validation
 * F: port_scan_range — happy path (finds locally-open ports)
 * G: dns_lookup — input validation
 * H: dns_lookup — happy path (localhost A record, PTR, error cases)
 * I: security / injection-shaped inputs handled as literals
 * J: concurrency stress (port_check + dns_lookup)
 */

const net = require("net");
const { counters, TMP } = require("../test-harness");

// Load ops directly (no executeTool dispatch needed since schemas are now wired,
// but we test both the pure logic AND schema presence).
const { portCheck, waitForPort, portScanRange } = require("../../lib/portCheckOps");
const { dnsLookup } = require("../../lib/dnsLookupOps");
const { ToolError } = require("../../lib/errors");

function ok(label, pass, detail = "") {
  counters[pass ? "pass" : "fail"]++;
  const sym = pass ? "✓" : "✗";
  const msg = detail ? `  ${sym} ${label}: ${detail}` : `  ${sym} ${label}`;
  if (!pass) process.stderr.write(msg + "\n");
  else console.log(msg);
}

async function asyncThrows(fn, msgPart) {
  try { await fn(); return false; }
  catch (e) { return !msgPart || e.message.includes(msgPart); }
}

/** Start a minimal TCP server on a random port; returns { server, port }. */
function startTcpServer() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.destroy());
    srv.listen(0, "127.0.0.1", () => resolve({ server: srv, port: srv.address().port }));
  });
}

/** Start a server after delayMs, resolving port immediately. */
function startDelayedServer(delayMs) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => {
        const srv = net.createServer((sock) => sock.destroy());
        setTimeout(() => srv.listen(port, "127.0.0.1"), delayMs);
        resolve({ server: srv, port });
      });
    });
  });
}

console.log("[181-A] port_check: input validation");

module.exports = (async () => {

  // ──────────────────────────────────────────────────────────────────────
  // [181-A] port_check: input validation
  // ──────────────────────────────────────────────────────────────────────

  ok("A1: missing host throws",
    await asyncThrows(() => portCheck({ host: "", port: 80 }), "'host' is required"));
  ok("A2: missing port (undefined) throws",
    await asyncThrows(() => portCheck({ host: "127.0.0.1", port: undefined }), "'port' must be"));
  ok("A3: port 0 throws",
    await asyncThrows(() => portCheck({ host: "127.0.0.1", port: 0 }), "'port' must be"));
  ok("A4: port 70000 throws",
    await asyncThrows(() => portCheck({ host: "127.0.0.1", port: 70000 }), "'port' must be"));
  ok("A5: non-integer port (3.14) throws",
    await asyncThrows(() => portCheck({ host: "127.0.0.1", port: 3.14 }), "'port' must be"));
  ok("A6: string port throws",
    await asyncThrows(() => portCheck({ host: "127.0.0.1", port: "80" }), "'port' must be"));
  ok("A7: negative timeout throws",
    await asyncThrows(() => portCheck({ host: "127.0.0.1", port: 80, timeout: -1 }), "'timeout'"));
  ok("A8: zero timeout throws",
    await asyncThrows(() => portCheck({ host: "127.0.0.1", port: 80, timeout: 0 }), "'timeout'"));

  // ──────────────────────────────────────────────────────────────────────
  // [181-B] port_check: happy path
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-B] port_check: happy path");

  const { server: srvB, port: openPort } = await startTcpServer();
  try {
    const b1 = await portCheck({ host: "127.0.0.1", port: openPort });
    ok("B1: open port → open:true",    b1.open === true);
    ok("B2: returns host",              b1.host === "127.0.0.1");
    ok("B3: returns port",              b1.port === openPort);
    ok("B4: timeMs is number",          typeof b1.timeMs === "number" && b1.timeMs >= 0);
    ok("B5: no error on open port",     b1.error === undefined);

    // port 1 is almost certainly closed on loopback
    const b6 = await portCheck({ host: "127.0.0.1", port: 1, timeout: 2 });
    ok("B6: closed port → open:false",  b6.open === false);
    ok("B7: error field on closed",     typeof b6.error === "string" && b6.error.length > 0);

    // timeout clamped at 30s — use a fast value
    const b8 = await portCheck({ host: "127.0.0.1", port: openPort, timeout: 5 });
    ok("B8: explicit timeout ok",       b8.open === true);

    // unresolvable host returns open:false, no throw
    const b9 = await portCheck({ host: "this-host-does-not-exist.invalid", port: 80, timeout: 3 });
    ok("B9: unresolvable host→false",   b9.open === false && typeof b9.error === "string");

  } finally {
    await new Promise(r => srvB.close(r));
  }

  // ──────────────────────────────────────────────────────────────────────
  // [181-C] wait_for_port: input validation
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-C] wait_for_port: input validation");

  ok("C1: missing host throws",
    await asyncThrows(() => waitForPort({ host: "", port: 80 }), "'host' is required"));
  ok("C2: port 0 throws",
    await asyncThrows(() => waitForPort({ host: "127.0.0.1", port: 0 }), "'port' must be"));
  ok("C3: port 70000 throws",
    await asyncThrows(() => waitForPort({ host: "127.0.0.1", port: 70000 }), "'port' must be"));
  ok("C4: negative timeout throws",
    await asyncThrows(() => waitForPort({ host: "127.0.0.1", port: 80, timeout: -1 }), "'timeout'"));
  ok("C5: interval below 0.1 throws",
    await asyncThrows(() => waitForPort({ host: "127.0.0.1", port: 80, interval: 0.01 }), "'interval'"));
  ok("C6: invalid connect_timeout throws",
    await asyncThrows(() => waitForPort({ host: "127.0.0.1", port: 80, connect_timeout: -5 }), "'connect_timeout'"));

  // ──────────────────────────────────────────────────────────────────────
  // [181-D] wait_for_port: happy path
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-D] wait_for_port: happy path");

  const { server: srvD, port: openD } = await startTcpServer();
  try {
    // D1–D4: immediately-open port
    const d1 = await waitForPort({ host: "127.0.0.1", port: openD, timeout: 5 });
    ok("D1: immediate open → open:true",  d1.open === true);
    ok("D2: attempts=1",                  d1.attempts === 1);
    ok("D3: elapsedMs is number",          typeof d1.elapsedMs === "number");
    ok("D4: no error",                    d1.error === undefined);

    // D5–D6: port never opens → timeout
    const t0 = Date.now();
    const d5 = await waitForPort({ host: "127.0.0.1", port: 1, timeout: 1, interval: 0.3 });
    ok("D5: closed port → open:false",    d5.open === false);
    ok("D6: elapsed ≥ 1000ms",            Date.now() - t0 >= 900);

    // D7: huge timeout clamped (should not throw, resolves fast since port open)
    const d7 = await waitForPort({ host: "127.0.0.1", port: openD, timeout: 9999 });
    ok("D7: huge timeout clamped, ok",    d7.open === true);

  } finally {
    await new Promise(r => srvD.close(r));
  }

  // D8: delayed open (port opens 400ms into polling)
  const { server: srvD8, port: portD8 } = await startDelayedServer(400);
  try {
    const d8 = await waitForPort({ host: "127.0.0.1", port: portD8, timeout: 5, interval: 0.2 });
    ok("D8: delayed open found",          d8.open === true);
    ok("D9: attempts > 1 for delayed",   d8.attempts > 1);
  } finally {
    await new Promise(r => srvD8.close(r));
  }

  // ──────────────────────────────────────────────────────────────────────
  // [181-E] port_scan_range: input validation
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-E] port_scan_range: input validation");

  ok("E1: missing host throws",
    await asyncThrows(() => portScanRange({ host: "", start_port: 80, end_port: 90 }), "'host' is required"));
  ok("E2: end < start throws",
    await asyncThrows(() => portScanRange({ host: "127.0.0.1", start_port: 90, end_port: 80 }), "end_port"));
  ok("E3: range > 1000 throws",
    await asyncThrows(() => portScanRange({ host: "127.0.0.1", start_port: 1, end_port: 1001 }), "1000"));
  ok("E4: port 0 start throws",
    await asyncThrows(() => portScanRange({ host: "127.0.0.1", start_port: 0, end_port: 10 }), "start_port"));
  ok("E5: bad timeout throws",
    await asyncThrows(() => portScanRange({ host: "127.0.0.1", start_port: 80, end_port: 90, timeout: -1 }), "'timeout'"));
  ok("E6: concurrency 0 throws",
    await asyncThrows(() => portScanRange({ host: "127.0.0.1", start_port: 80, end_port: 90, concurrency: 0 }), "concurrency"));

  // ──────────────────────────────────────────────────────────────────────
  // [181-F] port_scan_range: happy path
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-F] port_scan_range: happy path");

  // Open 3 servers on consecutive ports to test detection
  const srvF1 = await startTcpServer();
  const srvF2 = await startTcpServer();
  const srvF3 = await startTcpServer();
  const portsOpen = [srvF1.port, srvF2.port, srvF3.port].sort((a, b) => a - b);
  const scanMin = portsOpen[0];
  const scanMax = portsOpen[portsOpen.length - 1];

  try {
    const f1 = await portScanRange({
      host: "127.0.0.1", start_port: scanMin, end_port: scanMax,
      timeout: 2, concurrency: 20,
    });
    ok("F1: returns openPorts array",   Array.isArray(f1.openPorts));
    ok("F2: all 3 ports found",
      portsOpen.every(p => f1.openPorts.includes(p)));
    ok("F3: returns host",              f1.host === "127.0.0.1");
    ok("F4: totalPorts correct",        f1.totalPorts === scanMax - scanMin + 1);
    ok("F5: closedCount = total - open", f1.closedCount === f1.totalPorts - f1.openPorts.length);
    ok("F6: elapsedMs is number",       typeof f1.elapsedMs === "number" && f1.elapsedMs >= 0);
    ok("F7: openPorts sorted asc",
      f1.openPorts.every((p, i) => i === 0 || f1.openPorts[i - 1] <= p));

    // single-port range
    const f8 = await portScanRange({ host: "127.0.0.1", start_port: srvF1.port, end_port: srvF1.port });
    ok("F8: single-port range works",   f8.totalPorts === 1 && f8.openPorts.length === 1);

    // range of 10 closed ports
    const f9 = await portScanRange({ host: "127.0.0.1", start_port: 2, end_port: 11, timeout: 1 });
    ok("F9: all closed → openPorts=[]", f9.openPorts.length === 0 && f9.closedCount === 10);

  } finally {
    await new Promise(r => srvF1.server.close(r));
    await new Promise(r => srvF2.server.close(r));
    await new Promise(r => srvF3.server.close(r));
  }

  // ──────────────────────────────────────────────────────────────────────
  // [181-G] dns_lookup: input validation
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-G] dns_lookup: input validation");

  ok("G1: missing host throws",
    await asyncThrows(() => dnsLookup({ host: "" }), "'host' is required"));
  ok("G2: invalid type throws",
    await asyncThrows(() => dnsLookup({ host: "example.com", type: "BOGUS" }), "'type' must be one of"));
  ok("G3: PTR on hostname throws",
    await asyncThrows(() => dnsLookup({ host: "example.com", type: "PTR" }), "PTR"));
  ok("G4: A-type on IP throws",
    await asyncThrows(() => dnsLookup({ host: "8.8.8.8", type: "A" }), "PTR"));
  ok("G5: negative timeout throws",
    await asyncThrows(() => dnsLookup({ host: "example.com", timeout: -1 }), "'timeout'"));

  // ──────────────────────────────────────────────────────────────────────
  // [181-H] dns_lookup: happy path
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-H] dns_lookup: happy path");

  // H1–H4: localhost A lookup (always returns 127.0.0.1)
  const h1 = await dnsLookup({ host: "localhost" });
  ok("H1: localhost → records array",    Array.isArray(h1.records));
  ok("H2: elapsedMs is number",           typeof h1.elapsedMs === "number");
  ok("H3: type defaults to A",            h1.type === "A");
  ok("H4: host echoed back",              h1.host === "localhost");

  // H5: NXDOMAIN returns error, not throw
  const h5 = await dnsLookup({ host: "this-nxdomain-host.invalid.nonexistent" });
  ok("H5: NXDOMAIN → records=[]",        Array.isArray(h5.records) && h5.records.length === 0);
  ok("H6: NXDOMAIN has error field",     typeof h5.error === "string" && h5.error.length > 0);

  // H7: PTR on 127.0.0.1 (may or may not resolve; either way no throw)
  const h7 = await dnsLookup({ host: "127.0.0.1" });
  ok("H7: PTR on IP auto-detected",      h7.type === "PTR" && Array.isArray(h7.records));

  // H8: explicit PTR on 127.0.0.1
  const h8 = await dnsLookup({ host: "127.0.0.1", type: "PTR" });
  ok("H8: explicit PTR works",           h8.type === "PTR" && Array.isArray(h8.records));

  // H9: timeout returns gracefully
  const h9 = await dnsLookup({ host: "localhost", timeout: 30 });
  ok("H9: explicit timeout ok",          Array.isArray(h9.records));

  // ──────────────────────────────────────────────────────────────────────
  // [181-I] Security: injection-shaped inputs handled as literal hostnames
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-I] security: injection-shaped inputs");

  // I1: shell-injection host for portCheck
  const i1 = await portCheck({ host: "$(whoami)", port: 80, timeout: 2 });
  ok("I1: shell-inject host → open:false", i1.open === false);

  // I2: path-traversal-shaped host
  const i2 = await portCheck({ host: "../../../../etc/passwd", port: 80, timeout: 2 });
  ok("I2: path-traversal host → false", i2.open === false);

  // I3: very long garbage host
  const i3 = await portCheck({ host: "x".repeat(5000), port: 80, timeout: 2 });
  ok("I3: 5000-char host → false",      i3.open === false);

  // I4: injection host for dns_lookup
  const i4 = await dnsLookup({ host: "$(id).invalid" });
  ok("I4: dns shell-inject → no throw",  Array.isArray(i4.records) && i4.records.length === 0);

  // I5: null-byte in host for portCheck
  const i5 = await portCheck({ host: "127.0.0.1\x00evil", port: 80, timeout: 2 });
  ok("I5: null-byte host → false",       i5.open === false);

  // I6: portScanRange with injection host
  const i6 = await portScanRange({ host: "$(curl malicious.example)", start_port: 80, end_port: 81, timeout: 1 });
  ok("I6: portScan inject host → no open", i6.openPorts.length === 0);

  // I7: waitForPort with injection host (fast timeout)
  const i7 = await waitForPort({ host: "'; rm -rf /'", port: 80, timeout: 1, interval: 0.3 });
  ok("I7: waitForPort inject host → false", i7.open === false);

  // ──────────────────────────────────────────────────────────────────────
  // [181-J] Concurrency stress
  // ──────────────────────────────────────────────────────────────────────
  console.log("[181-J] concurrency stress");

  const { server: srvJ, port: portJ } = await startTcpServer();
  try {
    // J1: 20 parallel portCheck calls against open port
    const pcResults = await Promise.all(
      Array.from({ length: 20 }, () => portCheck({ host: "127.0.0.1", port: portJ }))
    );
    ok("J1: 20 concurrent portCheck all open", pcResults.every(r => r.open === true));

    // J2: 20 parallel portCheck calls against closed port
    const pcClosed = await Promise.all(
      Array.from({ length: 20 }, () => portCheck({ host: "127.0.0.1", port: 3, timeout: 1 }))
    );
    ok("J2: 20 concurrent closed all false", pcClosed.every(r => r.open === false));

    // J3: 10 parallel dns_lookup calls (localhost)
    const dnsResults = await Promise.all(
      Array.from({ length: 10 }, () => dnsLookup({ host: "localhost" }))
    );
    ok("J3: 10 concurrent dns_lookup ok",  dnsResults.every(r => Array.isArray(r.records)));

    // J4: port_scan_range scan of a 50-port window containing our open port
    const scanBase = Math.max(1, portJ - 25);
    const scanEnd  = Math.min(65535, scanBase + 49);
    const j4 = await portScanRange({
      host: "127.0.0.1", start_port: scanBase, end_port: scanEnd,
      concurrency: 50, timeout: 2,
    });
    ok("J4: scan finds open port",         j4.openPorts.includes(portJ));
    ok("J5: scan totalPorts correct",      j4.totalPorts === scanEnd - scanBase + 1);

  } finally {
    await new Promise(r => srvJ.close(r));
  }

  console.log("");
})();
