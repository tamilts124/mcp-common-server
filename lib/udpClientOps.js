"use strict";
// ── UDP_CLIENT — raw UDP/DTLS datagram client ─────────────────────────────────
// Zero npm dependencies — uses Node.js built-in dgram module.
// Binds a local ephemeral UDP socket, sends one or more datagrams to the
// target host:port, collects incoming datagrams with configurable timeouts
// and byte budgets, then closes the socket.
//
// Use cases:
//   • DNS queries (port 53 — send a raw DNS question, read the response)
//   • Syslog probes (port 514 — send RFC 5424 messages)
//   • SNMP GET requests (port 161 — send an SNMP v1/v2c PDU)
//   • NTP queries (port 123 — send an NTP request, read the timestamp)
//   • TFTP handshake initiation (port 69)
//   • Game/IoT UDP protocol testing
//   • Statsd metric injection (port 8125)
//   • Network reachability probes

const dgram     = require("dgram");
const dns       = require("dns");
const { ToolError } = require("./errors");

// ── Constants ──────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_S       = 5;      // wall-clock per-response wait
const MAX_TIMEOUT_S           = 60;
const DEFAULT_RECV_TIMEOUT_S  = 3;      // idle-recv timeout per round-trip
const MAX_RECV_TIMEOUT_S      = 30;
const DEFAULT_TOTAL_TIMEOUT_S = 15;
const MAX_TOTAL_TIMEOUT_S     = 120;

const MAX_MESSAGES           = 20;
const MAX_PAYLOAD_BYTES      = 64 * 1024;   // 64 KB per datagram (UDP hard limit is ~65 KB)
const DEFAULT_MAX_RECV_BYTES = 256 * 1024;  // 256 KB total receive budget
const MAX_RECV_BYTES_CAP     = 4 * 1024 * 1024; // 4 MB absolute
const DEFAULT_MAX_DATAGRAMS  = 100;
const MAX_DATAGRAMS_CAP      = 1000;

// ── Input validation ─────────────────────────────────────────────────────────
function validateInputs(opts) {
  // host
  const host = opts.host;
  if (!host || typeof host !== "string")
    throw new ToolError("udp_client: 'host' is required and must be a string.", -32602);
  if (host.length > 253)
    throw new ToolError("udp_client: 'host' exceeds maximum length (253 chars).", -32602);
  if (/[\r\n\x00]/.test(host))
    throw new ToolError("udp_client: 'host' must not contain control characters.", -32602);

  // port
  if (opts.port == null)
    throw new ToolError("udp_client: 'port' is required.", -32602);
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ToolError("udp_client: 'port' must be an integer between 1 and 65535.", -32602);

  // family (ipv4 / ipv6)
  const family = (opts.family ?? "ipv4").toLowerCase();
  if (!["ipv4", "ipv6"].includes(family))
    throw new ToolError("udp_client: 'family' must be 'ipv4' or 'ipv6'.", -32602);

  // messages
  const messages = opts.messages ?? [];
  if (!Array.isArray(messages))
    throw new ToolError("udp_client: 'messages' must be an array.", -32602);
  if (messages.length > MAX_MESSAGES)
    throw new ToolError(
      `udp_client: 'messages' may contain at most ${MAX_MESSAGES} entries.`, -32602);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object")
      throw new ToolError(`udp_client: messages[${i}] must be an object.`, -32602);
    if (m.data == null)
      throw new ToolError(`udp_client: messages[${i}].data is required.`, -32602);
    if (typeof m.data !== "string")
      throw new ToolError(`udp_client: messages[${i}].data must be a string.`, -32602);
    const enc = m.encoding ?? "utf8";
    if (!["utf8", "base64", "hex"].includes(enc))
      throw new ToolError(
        `udp_client: messages[${i}].encoding must be 'utf8', 'base64', or 'hex'.`, -32602);
    let payBuf;
    try {
      payBuf = Buffer.from(m.data, enc);
    } catch {
      throw new ToolError(
        `udp_client: messages[${i}].data cannot be decoded as ${enc}.`, -32602);
    }
    // Buffer.from() is lenient with hex/base64 — validate explicitly.
    if (enc === "hex") {
      // Valid hex: even length, only 0-9 a-f A-F chars
      if (m.data.length === 0 || m.data.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(m.data))
        throw new ToolError(
          `udp_client: messages[${i}].data is not valid hex (must be non-empty, even length, hex chars only).`, -32602);
    }
    if (payBuf.length > MAX_PAYLOAD_BYTES)
      throw new ToolError(
        `udp_client: messages[${i}] payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`, -32602);
    if (m.delay_ms != null) {
      if (typeof m.delay_ms !== "number" || m.delay_ms < 0 || m.delay_ms > 30000)
        throw new ToolError(
          `udp_client: messages[${i}].delay_ms must be 0–30000.`, -32602);
    }
    if (m.wait_replies != null) {
      if (typeof m.wait_replies !== "number" || !Number.isInteger(m.wait_replies) || m.wait_replies < 0)
        throw new ToolError(
          `udp_client: messages[${i}].wait_replies must be a non-negative integer.`, -32602);
    }
  }

  // timeouts
  let recvTimeout = DEFAULT_RECV_TIMEOUT_S;
  if (opts.recv_timeout != null) {
    if (typeof opts.recv_timeout !== "number" || opts.recv_timeout <= 0)
      throw new ToolError("udp_client: 'recv_timeout' must be a positive number.", -32602);
    recvTimeout = Math.min(opts.recv_timeout, MAX_RECV_TIMEOUT_S);
  }

  let totalTimeout = DEFAULT_TOTAL_TIMEOUT_S;
  if (opts.timeout != null) {
    if (typeof opts.timeout !== "number" || opts.timeout <= 0)
      throw new ToolError("udp_client: 'timeout' must be a positive number.", -32602);
    totalTimeout = Math.min(opts.timeout, MAX_TOTAL_TIMEOUT_S);
  }

  // receive budgets
  let maxRecvBytes = DEFAULT_MAX_RECV_BYTES;
  if (opts.max_recv_bytes != null) {
    if (typeof opts.max_recv_bytes !== "number" || opts.max_recv_bytes < 1)
      throw new ToolError("udp_client: 'max_recv_bytes' must be a positive number.", -32602);
    maxRecvBytes = Math.min(opts.max_recv_bytes, MAX_RECV_BYTES_CAP);
  }

  let maxDatagrams = DEFAULT_MAX_DATAGRAMS;
  if (opts.max_datagrams != null) {
    if (typeof opts.max_datagrams !== "number" || !Number.isInteger(opts.max_datagrams) || opts.max_datagrams < 1)
      throw new ToolError("udp_client: 'max_datagrams' must be a positive integer.", -32602);
    maxDatagrams = Math.min(opts.max_datagrams, MAX_DATAGRAMS_CAP);
  }

  // encoding for received datagrams
  const recvEncoding = opts.recv_encoding ?? "utf8";
  if (!["utf8", "base64", "hex"].includes(recvEncoding))
    throw new ToolError(
      "udp_client: 'recv_encoding' must be 'utf8', 'base64', or 'hex'.", -32602);

  // bind_port (optional: force a specific local port)
  let bindPort = 0; // 0 = OS assigns ephemeral port
  if (opts.bind_port != null) {
    const bp = Number(opts.bind_port);
    if (!Number.isInteger(bp) || bp < 0 || bp > 65535)
      throw new ToolError("udp_client: 'bind_port' must be an integer between 0 and 65535.", -32602);
    bindPort = bp;
  }

  return {
    host, port, family,
    messages,
    recvTimeout, totalTimeout,
    maxRecvBytes, maxDatagrams, recvEncoding,
    bindPort,
  };
}

// ── DNS resolution (needed so dgram.send gets an IP, not a hostname on some
//    versions of Node where it resolves inside libuv but doesn't honour family)
function resolveHost(host, family) {
  // If already a numeric address, skip DNS.
  if (/^[\d.]+$/.test(host) || /^[0-9a-fA-F:]+$/.test(host)) {
    return Promise.resolve(host);
  }
  const dnsFamily = family === "ipv6" ? 6 : 4;
  return new Promise((resolve, reject) => {
    dns.lookup(host, { family: dnsFamily }, (err, address) => {
      if (err) reject(err);
      else resolve(address);
    });
  });
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string}   opts.host             Target hostname or IP
 * @param {number}   opts.port             Target UDP port (1–65535)
 * @param {string}   [opts.family]         'ipv4' (default) | 'ipv6'
 * @param {Array}    [opts.messages]       [{data, encoding?, delay_ms?, wait_replies?}]
 * @param {number}   [opts.recv_timeout]   Idle-recv timeout in seconds per round-trip (default 3, max 30)
 * @param {number}   [opts.timeout]        Total wall-clock timeout (default 15, max 120)
 * @param {number}   [opts.max_recv_bytes] Total receive budget (default 256 KB, max 4 MB)
 * @param {number}   [opts.max_datagrams]  Max datagrams to record (default 100, max 1000)
 * @param {string}   [opts.recv_encoding]  Encoding for received datagrams: utf8 | base64 | hex
 * @param {number}   [opts.bind_port]      Local port to bind to (default 0 = OS-assigned)
 * @returns {Promise<object>}
 */
function udpClient(opts = {}) {
  let validated;
  try {
    validated = validateInputs(opts);
  } catch (err) {
    return Promise.reject(err);
  }

  const {
    host, port, family,
    messages,
    recvTimeout, totalTimeout,
    maxRecvBytes, maxDatagrams, recvEncoding,
    bindPort,
  } = validated;

  const socketType = family === "ipv6" ? "udp6" : "udp4";

  return new Promise((resolve) => {
    const startMs    = Date.now();
    const datagrams  = [];       // {index, remoteAddr, remotePort, elapsedMs, sizeBytes, data}
    let   totalRecv  = 0;
    let   msgsSent   = 0;
    let   settled    = false;
    let   truncated  = false;
    let   resolvedIp = null;

    let totalTimer = null;
    let recvTimer  = null;

    const socket = dgram.createSocket(socketType);

    function finish(errorMsg) {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (recvTimer)  clearTimeout(recvTimer);
      totalTimer = recvTimer = null;
      try { socket.close(); } catch (_) {}

      const result = {
        host,
        resolvedIp,
        port,
        family,
        localPort: socket.address ? (() => { try { return socket.address().port; } catch { return null; } })() : null,
        messagesSent: msgsSent,
        datagramsReceived: datagrams.length,
        totalReceivedBytes: totalRecv,
        truncated,
        datagrams,
        elapsedMs: Date.now() - startMs,
      };
      if (errorMsg) result.error = String(errorMsg);
      resolve(result);
    }

    // ── Idle-receive timer ───────────────────────────────────────────────────
    function resetRecvTimer(timeoutSec) {
      if (recvTimer) clearTimeout(recvTimer);
      if (settled)   return;
      recvTimer = setTimeout(() => finish(), (timeoutSec ?? recvTimeout) * 1000);
    }

    // ── Receive a fixed number of datagrams from the server ──────────────────
    // Returns a Promise that resolves when 'count' datagrams arrive or
    // recvTimeout elapses (whichever first). Always resolves (never rejects).
    function waitForReplies(count, perCallRecvTimeout) {
      if (count === 0) return Promise.resolve();
      return new Promise((res) => {
        let received = 0;
        let timer;
        function done() {
          if (timer) clearTimeout(timer);
          off();
          res();
        }
        function onDgram() {
          received++;
          if (received >= count) done();
        }
        // Listen for internal signal: each received datagram fires an event.
        socket.on("_dgram_received", onDgram);
        function off() { socket.off("_dgram_received", onDgram); }
        timer = setTimeout(done, (perCallRecvTimeout ?? recvTimeout) * 1000);
      });
    }

    // ── Sequential message sender ────────────────────────────────────────────
    async function sendMessages(ip) {
      for (const msg of messages) {
        if (settled) break;

        if (msg.delay_ms && msg.delay_ms > 0) {
          await new Promise((r) => setTimeout(r, msg.delay_ms));
        }
        if (settled) break;

        const enc     = msg.encoding ?? "utf8";
        const payload = Buffer.from(msg.data, enc);

        await new Promise((res, rej) => {
          socket.send(payload, 0, payload.length, port, ip, (err) => {
            if (err) rej(err);
            else res();
          });
        });
        msgsSent++;

        // If caller wants to wait for N replies before sending next message
        const waitN = msg.wait_replies ?? 0;
        if (waitN > 0) {
          await waitForReplies(waitN);
          if (settled) return;
        }
      }

      // All messages sent — arm the idle-receive timer for final responses
      if (!settled) {
        resetRecvTimer();
      }
    }

    // ── Socket event handlers ────────────────────────────────────────────────
    socket.on("message", (msg, rinfo) => {
      if (settled) return;

      totalRecv += msg.length;
      if (totalRecv > maxRecvBytes) {
        truncated = true;
        finish();
        return;
      }
      if (datagrams.length >= maxDatagrams) {
        truncated = true;
        finish();
        return;
      }

      datagrams.push({
        index:      datagrams.length,
        remoteAddr: rinfo.address,
        remotePort: rinfo.port,
        elapsedMs:  Date.now() - startMs,
        sizeBytes:  msg.length,
        data:       msg.toString(recvEncoding),
        encoding:   recvEncoding,
      });

      // Signal waiting waitForReplies() listeners
      socket.emit("_dgram_received");

      // Reset idle timer — we have more time to receive
      if (messages.length === 0) {
        resetRecvTimer();
      }
    });

    socket.on("error", (e) => {
      if (!settled) finish(e.message);
    });

    // ── Bind + kick off ──────────────────────────────────────────────────────
    socket.bind(bindPort, () => {
      if (settled) return;

      // Total wall-clock deadline
      totalTimer = setTimeout(() => {
        finish(`Session timed out after ${totalTimeout}s`);
      }, totalTimeout * 1000);

      // Resolve hostname then proceed
      resolveHost(host, family)
        .then((ip) => {
          if (settled) return;
          resolvedIp = ip;

          if (messages.length === 0) {
            // Listen-only mode: just arm the idle timer and receive
            resetRecvTimer();
          } else {
            sendMessages(ip).catch((e) => {
              if (!settled) finish(e.message);
            });
          }
        })
        .catch((e) => {
          if (!settled) finish(`DNS resolution failed: ${e.message}`);
        });
    });
  });
}

module.exports = { udpClient };
