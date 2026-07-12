"use strict";
// ── stomp_client: zero-dep STOMP 1.2 client ──────────────────────────────────
// Pure Node.js net/tls — no npm dependencies.
// Implements STOMP 1.2 (ActiveMQ, RabbitMQ, Apollo, Artemis):
//   connect, send, subscribe, request, disconnect
//
// Protocol reference: https://stomp.github.io/stomp-specification-1.2.html

const net = require("net");
const tls = require("tls");
const { ToolError } = require("./errors");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_PORT         = 61613;
const DEFAULT_TLS_PORT     = 61614;
const DEFAULT_TIMEOUT_MS   = 30_000;
const DEFAULT_CONN_TO_MS   = 10_000;
const MAX_BODY_BYTES       = 10 * 1024 * 1024; // 10 MB
const MAX_HEADER_VALUE_LEN = 4096;

// ── Security guards ──────────────────────────────────────────────────────────

function guardStr(val, label, maxLen) {
  maxLen = maxLen || MAX_HEADER_VALUE_LEN;
  if (typeof val !== "string")
    throw new ToolError(`stomp_client: '${label}' must be a string.`, -32602);
  if (val.includes("\0"))
    throw new ToolError(`stomp_client: '${label}' must not contain NUL bytes.`, -32602);
  if (val.includes("\r") || val.includes("\n"))
    throw new ToolError(`stomp_client: '${label}' must not contain CR/LF (STOMP header injection).`, -32602);
  if (val.length > maxLen)
    throw new ToolError(
      `stomp_client: '${label}' exceeds ${maxLen}-char limit (got ${val.length}).`, -32602);
  return val;
}

function guardOptStr(val, label, maxLen) {
  if (val === undefined || val === null) return undefined;
  return guardStr(val, label, maxLen);
}

// ── STOMP Frame Encoder ───────────────────────────────────────────────────────

/**
 * Encode a STOMP frame to a Buffer.
 * STOMP 1.2 frame format:
 *   COMMAND\n
 *   header1:value1\n
 *   \n
 *   BODY\0
 */
function encodeFrame(command, headers, body) {
  const bodyBuf = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")) : Buffer.alloc(0);
  let head = command + "\n";
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (v !== undefined && v !== null) {
        head += `${k}:${v}\n`;
      }
    }
  }
  if (bodyBuf.length > 0) {
    head += `content-length:${bodyBuf.length}\n`;
  }
  head += "\n"; // blank line separates headers from body
  return Buffer.concat([Buffer.from(head, "utf8"), bodyBuf, Buffer.from([0x00])]);
}

// ── STOMP Frame Parser ────────────────────────────────────────────────────────

/**
 * Streaming STOMP 1.2 frame parser.
 * Accumulates incoming chunks and emits complete parsed frames.
 *
 * Binary body safety: when content-length is present in the headers, the
 * terminal NUL is located at exactly headerEnd+contentLength, so embedded
 * NUL bytes inside a binary body are NOT mistaken for the frame terminator.
 */
class StompParser {
  constructor() {
    this._buf    = Buffer.alloc(0);
    this._frames = [];   // completed, parsed frames
    this._maxBuf = MAX_BODY_BYTES + 65536;
  }

  feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (this._buf.length > this._maxBuf)
      throw new ToolError(
        `stomp_client: incoming data exceeds ${MAX_BODY_BYTES / 1024 / 1024} MB limit.`, -32603);
    this._parse();
  }

  _parse() {
    while (true) {
      // Skip leading newlines (heartbeats / keepalive)
      let start = 0;
      while (start < this._buf.length &&
             (this._buf[start] === 0x0a || this._buf[start] === 0x0d)) {
        start++;
      }
      if (start > 0) this._buf = this._buf.slice(start);
      if (this._buf.length === 0) break;

      // Find the blank line separating headers from body (\n\n or \r\n\r\n).
      // We must do this BEFORE searching for the terminal NUL so that we can
      // read content-length and correctly skip binary body bytes containing NUL.
      let headerEnd = -1;
      for (let i = 0; i < this._buf.length - 1; i++) {
        if (this._buf[i] === 0x0a && this._buf[i + 1] === 0x0a) {
          headerEnd = i + 2; break;
        }
        if (this._buf[i] === 0x0a && this._buf[i + 1] === 0x0d &&
            i + 2 < this._buf.length && this._buf[i + 2] === 0x0a) {
          headerEnd = i + 3; break;
        }
      }
      if (headerEnd === -1) break; // headers not fully received yet — wait for more data

      // Extract content-length from raw header bytes
      let contentLength = -1;
      {
        const headerSec = this._buf.slice(0, headerEnd).toString("utf8");
        const clMatch   = headerSec.match(/(?:^|\n)content-length:(\d+)/i);
        if (clMatch) contentLength = parseInt(clMatch[1], 10);
      }

      // Locate the terminal NUL:
      //   • content-length known → NUL must be at headerEnd + contentLength
      //   • otherwise           → first NUL after headerEnd (no binary NUL expected)
      let nullIdx;
      if (contentLength >= 0) {
        const expectedNul = headerEnd + contentLength;
        if (this._buf.length <= expectedNul) break; // body not yet fully buffered
        nullIdx = (this._buf[expectedNul] === 0x00)
          ? expectedNul
          : this._buf.indexOf(0x00, headerEnd); // malformed fallback
      } else {
        nullIdx = this._buf.indexOf(0x00, headerEnd);
      }
      if (nullIdx === -1) break; // incomplete frame — wait for more data

      const frameBytes = this._buf.slice(0, nullIdx);
      this._buf        = this._buf.slice(nullIdx + 1);

      const frame = this._parseFrame(frameBytes);
      if (frame) this._frames.push(frame);
    }
  }

  _parseFrame(buf) {
    const text  = buf.toString("utf8");
    const nlIdx = text.indexOf("\n");
    if (nlIdx === -1) return null;

    // Command is first line (strip trailing \r)
    const command = text.slice(0, nlIdx).replace(/\r$/, "").trim();
    if (!command) return null;

    // Parse headers until blank line
    const headers = {};
    let bodyStart = nlIdx + 1;
    while (bodyStart < text.length) {
      const eol  = text.indexOf("\n", bodyStart);
      if (eol === -1) { bodyStart = text.length; break; }
      const line = text.slice(bodyStart, eol).replace(/\r$/, "");
      bodyStart  = eol + 1;
      if (line === "") break; // blank line = end of headers
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const val = line.slice(colon + 1); // no trim — value may have leading space
      if (!(key in headers)) headers[key] = val; // first occurrence wins
    }

    // Extract body as raw bytes from the original buffer
    let bodyBufStart = -1;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0x0a && buf[i + 1] === 0x0a) { bodyBufStart = i + 2; break; }
      if (buf[i] === 0x0a && buf[i + 1] === 0x0d && i + 2 < buf.length && buf[i + 2] === 0x0a) {
        bodyBufStart = i + 3; break;
      }
    }
    const rawBody = (bodyBufStart >= 0 && bodyBufStart < buf.length)
      ? buf.slice(bodyBufStart)
      : Buffer.alloc(0);

    // Honour content-length if provided
    const cl = parseInt(headers["content-length"], 10);
    const trimmedBody = (!isNaN(cl) && cl >= 0 && cl <= rawBody.length)
      ? rawBody.slice(0, cl)
      : rawBody;

    return {
      command,
      headers,
      body:    trimmedBody,
      bodyStr: trimmedBody.toString("utf8"),
    };
  }

  shift()          { return this._frames.length > 0 ? this._frames.shift() : null; }
  get available()  { return this._frames.length; }
}

// ── Connection helpers ────────────────────────────────────────────────────────

/**
 * Open a STOMP connection and complete the CONNECT/CONNECTED handshake.
 *
 * @param {object} opts - Connection options.
 * @param {object} [socketRef] - Optional mutable object; .socket is set as
 *   soon as the socket is created so callers can destroy it externally even
 *   when the returned Promise has not resolved yet (e.g. global timeout fires
 *   during the TCP connect or handshake phase).
 */
async function openStompConnection(opts, socketRef) {
  const {
    host,
    port,
    tls:          useTls = false,
    reject_unauthorized  = true,
    login,
    passcode,
    vhost          = "/",
    heartbeat_send = 0,
    heartbeat_recv = 0,
    connect_timeout,
    timeout        = DEFAULT_TIMEOUT_MS,
  } = opts;

  const connToMs = typeof connect_timeout === "number"
    ? connect_timeout * 1000
    : Math.min(timeout, DEFAULT_CONN_TO_MS);

  return new Promise((resolve, reject) => {
    const parser   = new StompParser();
    const waiters  = [];  // pending { resolve, reject }
    const frameBuf = [];  // buffered frames not yet consumed
    let settled    = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    };

    const onData = (chunk) => {
      try { parser.feed(chunk); }
      catch (e) {
        done(new ToolError(`stomp_client: parse error: ${e.message}`, -32603));
        // Destroy socket so the event loop is not kept alive by a leaked connection
        if (!socket.destroyed) socket.destroy();
        return;
      }
      let frame;
      while ((frame = parser.shift()) !== null) {
        if (waiters.length > 0) waiters.shift().resolve(frame);
        else frameBuf.push(frame);
      }
    };

    const send = (data) => { if (!socket.destroyed) socket.write(data); };

    const nextFrame = () => {
      if (frameBuf.length > 0) return Promise.resolve(frameBuf.shift());
      return new Promise((res, rej) => waiters.push({ resolve: res, reject: rej }));
    };

    const drainWaiters = () => { while (waiters.length) waiters.shift().resolve(null); };

    const waitFor = async (expectedCommand) => {
      const f = await nextFrame();
      if (!f) throw new ToolError(`stomp_client: expected ${expectedCommand}, got null`, -32603);
      if (f.command !== expectedCommand)
        throw new ToolError(
          `stomp_client: expected ${expectedCommand}, got ${f.command}`, -32603);
      return f;
    };

    // ── Socket ────────────────────────────────────────────────────────────────
    const socketOpts = { host, port };
    const socket = useTls
      ? tls.connect({ ...socketOpts, rejectUnauthorized: reject_unauthorized, servername: host })
      : net.createConnection(socketOpts);

    // Expose socket immediately so callers can destroy it externally
    // (e.g. when a global timeout fires before this Promise resolves).
    if (socketRef) socketRef.socket = socket;

    let connTimer = setTimeout(() => {
      socket.destroy(
        new ToolError(`stomp_client: TCP connection timed out after ${connToMs} ms.`, -32603));
    }, connToMs);

    socket.on("data",  onData);
    socket.on("error", (e) => {
      done(new ToolError(`stomp_client: socket error: ${e.message}`, -32603));
      // socket error already causes socket to close, no explicit destroy needed
    });
    socket.on("close", () => {
      // Drain any pending waiters so they don't keep the event loop alive
      drainWaiters();
      while (waiters.length)
        waiters.shift().reject(
          new ToolError("stomp_client: connection closed unexpectedly.", -32603));
    });

    const onConnect = async () => {
      clearTimeout(connTimer);
      connTimer = null;
      try {
        const connectHeaders = {
          "accept-version": "1.2,1.1,1.0",
          "host":           vhost,
          "heart-beat":     `${heartbeat_send},${heartbeat_recv}`,
        };
        if (login    != null) connectHeaders["login"]    = login;
        if (passcode != null) connectHeaders["passcode"] = passcode;

        send(encodeFrame("CONNECT", connectHeaders, null));

        const frame = await nextFrame();
        if (!frame)
          throw new ToolError("stomp_client: connection closed before CONNECTED.", -32603);
        if (frame.command === "ERROR")
          throw new ToolError(
            `stomp_client: broker returned ERROR: ${frame.headers["message"] || frame.bodyStr || "(no message)"}`,
            -32603);
        if (frame.command !== "CONNECTED")
          throw new ToolError(
            `stomp_client: expected CONNECTED, got ${frame.command}`, -32603);

        const version    = frame.headers["version"]    || "1.0";
        const sessionId  = frame.headers["session"]    || undefined;
        const serverInfo = frame.headers["server"]     || undefined;
        const heartBeat  = frame.headers["heart-beat"] || "0,0";

        done(null, { socket, parser, send, nextFrame, waitFor, drainWaiters,
                     version, sessionId, serverInfo, heartBeat });
      } catch (e) {
        done(e instanceof ToolError ? e :
             new ToolError(`stomp_client: handshake error: ${e.message}`, -32603));
        // Destroy socket to prevent event-loop leak (leaked open connections
        // keep Node.js alive indefinitely when tests call broker.close())
        if (!socket.destroyed) socket.destroy();
      }
    };

    if (useTls) socket.on("secureConnect", onConnect);
    else        socket.on("connect",       onConnect);
  });
}

async function closeStompConnection(conn) {
  const { socket, send, nextFrame, drainWaiters } = conn;
  try {
    if (typeof drainWaiters === "function") drainWaiters();
    const receiptId = `mcp-disc-${Date.now().toString(36)}`;
    send(encodeFrame("DISCONNECT", { receipt: receiptId }, null));
    await Promise.race([
      nextFrame().catch(() => {}),
      new Promise(r => setTimeout(r, 1000)),
    ]);
  } catch (_) { /* ignore */ }
  finally {
    if (!socket.destroyed) socket.destroy();
  }
}

// ── Main exported function ────────────────────────────────────────────────────

async function stompClient(opts) {
  opts = opts || {};

  const {
    host,
    port,
    tls:                useTls             = false,
    reject_unauthorized                    = true,
    login,
    passcode,
    vhost                                  = "/",
    heartbeat_send                         = 0,
    heartbeat_recv                         = 0,
    timeout                                = 30,
    connect_timeout,
    operation,
    destination,
    body                                   = "",
    body_encoding                          = "utf8",
    content_type,
    headers: extraHeaders,
    subscribe_destination,
    id: subscriptionId,
    ack_mode                               = "auto",
    max_messages                           = 10,
    subscribe_timeout                      = 5,
    reply_to,
    correlation_id,
    request_timeout                        = 5,
    request_receipt                        = false,
  } = opts;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!host || typeof host !== "string")
    throw new ToolError("stomp_client: 'host' is required (string).", -32602);

  const VALID_OPS = ["connect", "send", "subscribe", "request", "disconnect"];
  if (!operation || !VALID_OPS.includes(operation))
    throw new ToolError(
      `stomp_client: 'operation' must be one of: ${VALID_OPS.join(", ")}.`, -32602);

  if (["send", "request"].includes(operation)) {
    if (!destination)
      throw new ToolError(
        `stomp_client: 'destination' is required for operation '${operation}'.`, -32602);
    guardStr(destination, "destination");
  }
  if (operation === "subscribe") {
    const dest = subscribe_destination || destination;
    if (!dest)
      throw new ToolError(
        "stomp_client: 'subscribe_destination' (or 'destination') is required for subscribe.", -32602);
    guardStr(dest, "subscribe_destination");
    if (max_messages < 1 || max_messages > 500)
      throw new ToolError("stomp_client: 'max_messages' must be 1\u2013500.", -32602);
  }
  if (operation === "request" && reply_to !== undefined) guardStr(reply_to, "reply_to");

  if (login    != null) guardStr(login,    "login");
  if (passcode != null) guardStr(passcode, "passcode");
  guardStr(vhost, "vhost");

  if (extraHeaders && typeof extraHeaders === "object") {
    for (const [k, v] of Object.entries(extraHeaders)) {
      guardStr(k, `headers key '${k}'`);
      if (v != null) guardStr(String(v), `headers['${k}']`);
    }
  }

  const bodyBuf = body_encoding === "base64"
    ? Buffer.from(body || "", "base64")
    : Buffer.from(body || "", "utf8");
  if (bodyBuf.length > MAX_BODY_BYTES)
    throw new ToolError(
      `stomp_client: body exceeds ${MAX_BODY_BYTES / 1024 / 1024} MB limit.`, -32602);

  const timeoutMs    = (typeof timeout === "number" && timeout > 0) ? timeout * 1000 : DEFAULT_TIMEOUT_MS;
  const resolvedPort = typeof port === "number" ? port : (useTls ? DEFAULT_TLS_PORT : DEFAULT_PORT);

  const startTime = Date.now();
  let globalTimer;
  let conn;
  // socketRef is populated by openStompConnection as soon as the underlying
  // socket is created. This lets the finally block destroy the socket even
  // when the global timeout fires before openStompConnection resolves (i.e.
  // when conn is still undefined and the socket is still mid-connect or
  // waiting for the CONNECTED frame).
  const socketRef = { socket: null };

  const timeoutPromise = new Promise((_, rej) => {
    globalTimer = setTimeout(() =>
      rej(new ToolError(`stomp_client: operation timed out after ${timeoutMs} ms.`, -32603)),
      timeoutMs);
  });

  async function run() {
    conn = await openStompConnection({
      host, port: resolvedPort, tls: useTls, reject_unauthorized,
      login, passcode, vhost, heartbeat_send, heartbeat_recv,
      timeout: timeoutMs, connect_timeout,
    }, socketRef);

    const { send, waitFor, nextFrame, drainWaiters, version, sessionId, serverInfo, heartBeat } = conn;
    let result;

    switch (operation) {

      // ── connect ─────────────────────────────────────────────────────────────
      case "connect": {
        result = { connected: true, version, sessionId, serverInfo, heartBeat };
        break;
      }

      // ── send ─────────────────────────────────────────────────────────────────
      case "send": {
        const sendHeaders = {
          destination,
          ...(content_type ? { "content-type": content_type } : {}),
          ...(extraHeaders || {}),
        };
        let receiptId;
        if (request_receipt) {
          receiptId = `mcp-rcpt-${Date.now().toString(36)}`;
          sendHeaders["receipt"] = receiptId;
        }
        send(encodeFrame("SEND", sendHeaders, bodyBuf));
        if (request_receipt) {
          const receiptFrame = await waitFor("RECEIPT");
          result = { sent: true, destination, bodyBytes: bodyBuf.length,
                     receiptId: receiptFrame.headers["receipt-id"] || receiptId };
        } else {
          result = { sent: true, destination, bodyBytes: bodyBuf.length };
        }
        break;
      }

      // ── subscribe ────────────────────────────────────────────────────────────
      case "subscribe": {
        const subDest      = subscribe_destination || destination;
        const subId        = subscriptionId || `mcp-sub-${Date.now().toString(36)}`;
        const maxMsgs      = Math.min(max_messages, 500);
        const subTimeoutMs = (typeof subscribe_timeout === "number" && subscribe_timeout > 0)
          ? subscribe_timeout * 1000 : 5000;

        const subReceiptId = `mcp-sub-rcpt-${Date.now().toString(36)}`;
        send(encodeFrame("SUBSCRIBE", {
          destination: subDest,
          id:          subId,
          ack:         ack_mode === "client" ? "client" : "auto",
          receipt:     subReceiptId,
        }, null));
        await waitFor("RECEIPT");

        const messages = [];
        const deadline = Date.now() + subTimeoutMs;

        while (messages.length < maxMsgs && Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const frame = await Promise.race([
            nextFrame(),
            new Promise(res => setTimeout(() => res(null), Math.max(0, remaining))),
          ]);
          if (!frame) break;
          if (frame.command === "MESSAGE") {
            messages.push({
              messageId:    frame.headers["message-id"]   || undefined,
              destination:  frame.headers["destination"]  || subDest,
              subscription: frame.headers["subscription"] || subId,
              body:         frame.bodyStr,
              bodyBytes:    frame.body.length,
              headers:      frame.headers,
            });
            if (ack_mode === "client") {
              const ackId = frame.headers["ack"] || frame.headers["message-id"];
              if (ackId) send(encodeFrame("ACK", { id: ackId }, null));
            }
          } else if (frame.command === "ERROR") {
            throw new ToolError(
              `stomp_client: broker ERROR during subscribe: ${frame.headers["message"] || frame.bodyStr}`,
              -32603);
          }
        }

        drainWaiters();
        const unsubReceiptId = `mcp-unsub-${Date.now().toString(36)}`;
        send(encodeFrame("UNSUBSCRIBE", { id: subId, receipt: unsubReceiptId }, null));
        await Promise.race([
          nextFrame().catch(() => {}),
          new Promise(r => setTimeout(r, 1000)),
        ]);

        result = { subscription: subId, destination: subDest,
                   messageCount: messages.length, messages };
        break;
      }

      // ── request ──────────────────────────────────────────────────────────────
      case "request": {
        const replyDest  = reply_to || `/temp-queue/mcp-reply-${Date.now().toString(36)}`;
        const corrId     = correlation_id || `mcp-corr-${Date.now().toString(36)}`;
        const reqTimeout = (typeof request_timeout === "number" && request_timeout > 0)
          ? request_timeout * 1000 : 5000;

        const replySubId     = `mcp-reply-sub-${Date.now().toString(36)}`;
        const replyReceiptId = `mcp-reply-rcpt-${Date.now().toString(36)}`;
        send(encodeFrame("SUBSCRIBE", {
          destination: replyDest, id: replySubId, ack: "auto", receipt: replyReceiptId,
        }, null));
        await waitFor("RECEIPT");

        const reqHeaders = {
          destination,
          "reply-to":       replyDest,
          "correlation-id": corrId,
          ...(content_type ? { "content-type": content_type } : {}),
          ...(extraHeaders || {}),
        };
        send(encodeFrame("SEND", reqHeaders, bodyBuf));

        const deadline = Date.now() + reqTimeout;
        let replyFrame = null;
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const frame = await Promise.race([
            nextFrame(),
            new Promise(res => setTimeout(() => res(null), Math.max(0, remaining))),
          ]);
          if (!frame) break;
          if (frame.command === "MESSAGE" &&
              (frame.headers["subscription"] === replySubId ||
               frame.headers["destination"]  === replyDest)) {
            replyFrame = frame; break;
          }
          if (frame.command === "ERROR")
            throw new ToolError(
              `stomp_client: broker ERROR during request: ${frame.headers["message"] || frame.bodyStr}`,
              -32603);
        }

        drainWaiters();
        send(encodeFrame("UNSUBSCRIBE", { id: replySubId }, null));

        result = replyFrame ? {
          replied:       true,
          correlationId: replyFrame.headers["correlation-id"] || corrId,
          body:          replyFrame.bodyStr,
          bodyBytes:     replyFrame.body.length,
          replyHeaders:  replyFrame.headers,
        } : { replied: false, correlationId: corrId, timedOut: true };
        break;
      }

      // ── disconnect ───────────────────────────────────────────────────────────
      case "disconnect": {
        result = { disconnected: true };
        break;
      }

      default:
        throw new ToolError(`stomp_client: unhandled operation '${operation}'.`, -32603);
    }

    return {
      host, port: resolvedPort, vhost, operation,
      elapsedMs: Date.now() - startTime,
      version, ...result,
    };
  }

  try {
    const runPromise = run();
    runPromise.catch(() => {});
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(globalTimer);
    // Close the connection if it was established.
    if (conn) {
      await closeStompConnection(conn).catch(() => {});
    } else if (socketRef.socket && !socketRef.socket.destroyed) {
      // Timeout fired before openStompConnection resolved — destroy the socket
      // directly so the event loop is not kept alive by the pending handshake.
      socketRef.socket.destroy();
    }
  }
}

module.exports = { stompClient, StompParser, encodeFrame };
