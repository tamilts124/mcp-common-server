"use strict";
// ── TCP_CLIENT — raw TCP/TLS socket client ────────────────────────────────────
// Zero npm dependencies — uses Node.js built-in net/tls modules.
// Connects to a TCP (or TLS) endpoint, sends zero or more messages,
// collects responses with configurable read timeout/byte budget,
// then closes the connection.
//
// Use cases: Redis, SMTP banner grabs, Memcached, custom TCP daemons,
// protocol debugging, health-checks that need a full handshake.

const net = require("net");
const tls = require("tls");
const { ToolError } = require("./errors");

// ── Constants ──────────────────────────────────────────────────────────────
// Timeouts
const DEFAULT_CONNECT_TIMEOUT_S = 10;
const MAX_CONNECT_TIMEOUT_S     = 30;
const DEFAULT_RECV_TIMEOUT_S    = 5;    // idle-read timeout per message
const MAX_RECV_TIMEOUT_S        = 60;
const DEFAULT_TOTAL_TIMEOUT_S   = 30;
const MAX_TOTAL_TIMEOUT_S       = 120;

// Size caps
const MAX_SEND_MESSAGES         = 50;
const MAX_SEND_PAYLOAD_BYTES    = 64 * 1024;  // 64 KB per message
const DEFAULT_MAX_RECV_BYTES    = 256 * 1024; // 256 KB total receive budget
const MAX_RECV_BYTES_HARD_CAP   = 4 * 1024 * 1024; // 4 MB absolute
const DEFAULT_MAX_CHUNKS        = 100;         // max response chunks to record
const MAX_CHUNKS_HARD_CAP       = 1000;
const MAX_EXTRA_HEADERS         = 30;
const MAX_HEADER_VALUE_LEN      = 4000;

// ── Input validation ─────────────────────────────────────────────────────────
function validateInputs(opts) {
  // host
  const host = opts.host;
  if (!host || typeof host !== "string")
    throw new ToolError("tcp_client: 'host' is required and must be a string.", -32602);
  if (host.length > 253)
    throw new ToolError("tcp_client: 'host' is too long (max 253 characters).", -32602);
  if (/[\r\n\x00]/.test(host))
    throw new ToolError("tcp_client: 'host' must not contain control characters.", -32602);

  // port
  if (opts.port == null)
    throw new ToolError("tcp_client: 'port' is required.", -32602);
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ToolError("tcp_client: 'port' must be an integer between 1 and 65535.", -32602);

  // secure
  const secure = !!opts.secure;

  // TLS servername
  let servername = opts.servername;
  if (servername != null && typeof servername !== "string")
    throw new ToolError("tcp_client: 'servername' must be a string.", -32602);
  if (servername && /[\r\n\x00]/.test(servername))
    throw new ToolError("tcp_client: 'servername' must not contain control characters.", -32602);

  // messages
  const messages = opts.messages ?? [];
  if (!Array.isArray(messages))
    throw new ToolError("tcp_client: 'messages' must be an array.", -32602);
  if (messages.length > MAX_SEND_MESSAGES)
    throw new ToolError(
      `tcp_client: 'messages' may contain at most ${MAX_SEND_MESSAGES} entries.`, -32602);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object")
      throw new ToolError(`tcp_client: messages[${i}] must be an object.`, -32602);
    if (m.data == null)
      throw new ToolError(`tcp_client: messages[${i}].data is required.`, -32602);
    if (typeof m.data !== "string")
      throw new ToolError(`tcp_client: messages[${i}].data must be a string.`, -32602);
    const enc = m.encoding ?? "utf8";
    if (!["utf8", "base64", "hex"].includes(enc))
      throw new ToolError(
        `tcp_client: messages[${i}].encoding must be 'utf8', 'base64', or 'hex'.`, -32602);
    let payBuf;
    try {
      payBuf = Buffer.from(m.data, enc);
    } catch {
      throw new ToolError(
        `tcp_client: messages[${i}].data cannot be decoded as ${enc}.`, -32602);
    }
    if (payBuf.length > MAX_SEND_PAYLOAD_BYTES)
      throw new ToolError(
        `tcp_client: messages[${i}] payload exceeds ${MAX_SEND_PAYLOAD_BYTES} bytes.`, -32602);
    if (m.delay_ms != null &&
        (typeof m.delay_ms !== "number" || m.delay_ms < 0 || m.delay_ms > 30000))
      throw new ToolError(
        `tcp_client: messages[${i}].delay_ms must be 0–30000.`, -32602);
    if (m.recv_until != null && typeof m.recv_until !== "string")
      throw new ToolError(
        `tcp_client: messages[${i}].recv_until must be a string.`, -32602);
    if (m.recv_until != null && m.recv_until.length > 200)
      throw new ToolError(
        `tcp_client: messages[${i}].recv_until is too long.`, -32602);
  }

  // timeouts
  let connectTimeout = DEFAULT_CONNECT_TIMEOUT_S;
  if (opts.connect_timeout != null) {
    if (typeof opts.connect_timeout !== "number" || opts.connect_timeout <= 0)
      throw new ToolError("tcp_client: 'connect_timeout' must be a positive number.", -32602);
    connectTimeout = Math.min(opts.connect_timeout, MAX_CONNECT_TIMEOUT_S);
  }

  let recvTimeout = DEFAULT_RECV_TIMEOUT_S;
  if (opts.recv_timeout != null) {
    if (typeof opts.recv_timeout !== "number" || opts.recv_timeout <= 0)
      throw new ToolError("tcp_client: 'recv_timeout' must be a positive number.", -32602);
    recvTimeout = Math.min(opts.recv_timeout, MAX_RECV_TIMEOUT_S);
  }

  let totalTimeout = DEFAULT_TOTAL_TIMEOUT_S;
  if (opts.timeout != null) {
    if (typeof opts.timeout !== "number" || opts.timeout <= 0)
      throw new ToolError("tcp_client: 'timeout' must be a positive number.", -32602);
    totalTimeout = Math.min(opts.timeout, MAX_TOTAL_TIMEOUT_S);
  }

  // receive budget
  let maxRecvBytes = DEFAULT_MAX_RECV_BYTES;
  if (opts.max_recv_bytes != null) {
    if (typeof opts.max_recv_bytes !== "number" || opts.max_recv_bytes < 1)
      throw new ToolError("tcp_client: 'max_recv_bytes' must be a positive number.", -32602);
    maxRecvBytes = Math.min(opts.max_recv_bytes, MAX_RECV_BYTES_HARD_CAP);
  }

  let maxChunks = DEFAULT_MAX_CHUNKS;
  if (opts.max_chunks != null) {
    if (typeof opts.max_chunks !== "number" || !Number.isInteger(opts.max_chunks) || opts.max_chunks < 1)
      throw new ToolError("tcp_client: 'max_chunks' must be a positive integer.", -32602);
    maxChunks = Math.min(opts.max_chunks, MAX_CHUNKS_HARD_CAP);
  }

  // encoding for received data
  const recvEncoding = opts.recv_encoding ?? "utf8";
  if (!["utf8", "base64", "hex"].includes(recvEncoding))
    throw new ToolError(
      "tcp_client: 'recv_encoding' must be 'utf8', 'base64', or 'hex'.", -32602);

  return {
    host, port, secure, servername,
    messages,
    connectTimeout, recvTimeout, totalTimeout,
    maxRecvBytes, maxChunks, recvEncoding,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string}   opts.host            Hostname or IP address to connect to
 * @param {number}   opts.port            TCP port (1–65535)
 * @param {boolean}  [opts.secure]        Use TLS (default false)
 * @param {string}   [opts.servername]    TLS SNI override (default = host)
 * @param {Array}    [opts.messages]      [{data, encoding?, add_newline?, delay_ms?, recv_until?, recv_timeout?}]
 * @param {number}   [opts.connect_timeout]  seconds to wait for TCP connect (default 10, max 30)
 * @param {number}   [opts.recv_timeout]     seconds to wait for next data chunk (default 5, max 60)
 * @param {number}   [opts.timeout]          total session wall-clock timeout (default 30, max 120)
 * @param {number}   [opts.max_recv_bytes]   total byte budget for incoming data (default 256 KB, max 4 MB)
 * @param {number}   [opts.max_chunks]       max response chunks to record (default 100, max 1000)
 * @param {string}   [opts.recv_encoding]    how to encode received bytes: utf8 (default) | base64 | hex
 * @returns {Promise<object>}
 */
function tcpClient(opts = {}) {
  // Validate synchronously, but return a rejected Promise rather than throwing,
  // so callers can always use .then()/.catch() without wrapping in try-catch.
  let validated;
  try {
    validated = validateInputs(opts);
  } catch (err) {
    return Promise.reject(err);
  }
  const {
    host, port, secure, servername,
    messages,
    connectTimeout, recvTimeout, totalTimeout,
    maxRecvBytes, maxChunks, recvEncoding,
  } = validated;

  return new Promise((resolve) => {
    const startMs = Date.now();
    const chunks  = [];       // { index, elapsedMs, sizeBytes, data }
    let   totalRecv   = 0;
    let   msgsSent    = 0;
    let   connectMs   = null;
    let   settled     = false;
    let   truncated   = false;

    // Timers
    let totalTimer   = null;
    let recvTimer    = null;

    function finish(errorMsg) {
      if (settled) return;
      settled = true;
      if (totalTimer)  clearTimeout(totalTimer);
      if (recvTimer)   clearTimeout(recvTimer);
      totalTimer = recvTimer = null;

      try { socket.destroy(); } catch (_) {}

      const result = {
        host,
        port,
        secure,
        connected: connectMs !== null,
        connectMs,
        messagesSent: msgsSent,
        chunksReceived: chunks.length,
        totalReceivedBytes: totalRecv,
        truncated,
        chunks,
        elapsedMs: Date.now() - startMs,
      };
      if (errorMsg) result.error = String(errorMsg);
      resolve(result);
    }

    // ── Reset idle-receive timer (restarts on each incoming chunk) ────────────
    function resetRecvTimer(timeoutSec) {
      if (recvTimer) clearTimeout(recvTimer);
      if (settled)   return;
      const t = timeoutSec ?? recvTimeout;
      recvTimer = setTimeout(() => {
        // Idle timeout: normal end-of-response for many protocols.
        // Do NOT flag as error — just finish cleanly.
        finish();
      }, t * 1000);
    }

    // ── Open TCP / TLS socket ──────────────────────────────────────────
    const socket = secure
      ? tls.connect({
          host,
          port,
          servername: servername || host,
          rejectUnauthorized: false,   // allow self-signed certs in dev
        })
      : net.createConnection({ host, port });

    // Connection-level timeout (applied before connect event fires)
    socket.setTimeout(connectTimeout * 1000);
    socket.once("timeout", () => {
      if (connectMs === null) {
        // Still connecting
        socket.destroy();
        finish(`Connection timed out after ${connectTimeout}s`);
      } else {
        // Shouldn’t happen — we clear this after connect
        finish();
      }
    });

    // Total wall-clock deadline
    totalTimer = setTimeout(() => {
      finish(`Session timed out after ${totalTimeout}s`);
    }, totalTimeout * 1000);

    // ── Track pending recv_until pattern across messages ──────────────────
    // We keep a rolling "pending data" accumulator per send+wait cycle.
    let pendingPattern = null;
    let pendingBuf     = Buffer.alloc(0);
    let pendingResolve = null; // resolve for the current "wait until" promise

    // Feed incoming data into the chunk array and optionally into a
    // pending recv_until resolver.
    function onData(chunk) {
      if (settled) return;
      totalRecv += chunk.length;
      if (totalRecv > maxRecvBytes) {
        truncated = true;
        // Record the last partial chunk up to budget then finish
        const excess = totalRecv - maxRecvBytes;
        const partial = chunk.slice(0, chunk.length - excess);
        if (partial.length > 0) recordChunk(partial);
        finish();
        return;
      }
      recordChunk(chunk);
      resetRecvTimer();

      if (pendingPattern !== null && pendingResolve !== null) {
        pendingBuf = Buffer.concat([pendingBuf, chunk]);
        if (pendingBuf.indexOf(pendingPattern) !== -1) {
          const res = pendingResolve;
          pendingPattern = null;
          pendingBuf     = Buffer.alloc(0);
          pendingResolve = null;
          if (recvTimer) clearTimeout(recvTimer);
          recvTimer = null;
          res(); // unblock the next send
        }
      }
    }

    function recordChunk(buf) {
      if (chunks.length >= maxChunks) {
        truncated = true;
        return;
      }
      chunks.push({
        index:     chunks.length,
        elapsedMs: Date.now() - startMs,
        sizeBytes: buf.length,
        data:      buf.toString(recvEncoding),
        encoding:  recvEncoding,
      });
    }

    // ── Wait for a delimiter pattern in the receive stream ──────────────
    // Returns a Promise that resolves when the pattern appears, or when
    // the per-message recv_timeout elapses.
    function waitForPattern(pattern, perMsgTimeoutS) {
      return new Promise((res) => {
        const buf = Buffer.from(pattern, "utf8");
        // Already in accumulated buffer?
        if (pendingBuf.indexOf(buf) !== -1) {
          pendingBuf = Buffer.alloc(0);
          res();
          return;
        }
        pendingPattern = buf;
        pendingResolve = res;
        // Arm a per-message idle timeout
        const t = perMsgTimeoutS ?? recvTimeout;
        recvTimer = setTimeout(() => {
          if (pendingResolve === res) {
            // Timed out waiting for pattern — proceed anyway
            pendingPattern = null;
            pendingBuf     = Buffer.alloc(0);
            pendingResolve = null;
            res();
          }
        }, t * 1000);
      });
    }

    // ── Sequential message sender with optional delay / recv_until ────────
    async function sendMessages() {
      for (const msg of messages) {
        if (settled) break;

        // Optional inter-message delay
        if (msg.delay_ms && msg.delay_ms > 0) {
          await new Promise((r) => setTimeout(r, msg.delay_ms));
        }
        if (settled) break;

        // Build payload
        const enc = msg.encoding ?? "utf8";
        let payload = Buffer.from(msg.data, enc);
        if (msg.add_newline !== false && enc === "utf8") {
          // By default, append \r\n for line-oriented protocols (SMTP, Redis inline, etc.)
          // unless caller explicitly sets add_newline:false
          // Only do this for utf8 messages (binary payloads should not be line-terminated)
          payload = Buffer.concat([payload, Buffer.from("\r\n")]);
        } else if (msg.add_newline === true) {
          // Explicit request even for binary
          payload = Buffer.concat([payload, Buffer.from("\r\n")]);
        }

        try {
          socket.write(payload);
        } catch (e) {
          if (!settled) finish(e.message);
          return;
        }
        msgsSent++;

        // If caller asked to wait for a pattern before sending next message
        if (msg.recv_until) {
          const patTimeout = msg.recv_timeout ?? recvTimeout;
          await waitForPattern(msg.recv_until, patTimeout);
          if (settled) return;
        }
      }

      // All messages sent. If there are no pending recv_until waits,
      // arm the idle receive timer to collect the final response.
      if (!settled && pendingResolve === null) {
        resetRecvTimer();
      }
    }

    // ── Socket event handlers ────────────────────────────────────────
    const connectEvent = secure ? "secureConnect" : "connect";

    socket.once(connectEvent, () => {
      connectMs = Date.now() - startMs;
      // Cancel the connect-phase timeout; switch to full-session timer
      socket.setTimeout(0);

      // If no messages, just arm the receive timer and wait for server banner
      if (messages.length === 0) {
        resetRecvTimer();
      } else {
        sendMessages().catch((e) => {
          if (!settled) finish(e.message);
        });
      }
    });

    socket.on("data", onData);

    socket.once("error", (e) => {
      if (!settled) finish(e.message);
    });

    socket.once("close", () => {
      if (!settled) finish();
    });

    socket.once("end", () => {
      // Server half-closed the connection — finish cleanly
      if (!settled) finish();
    });
  });
}

module.exports = { tcpClient };
