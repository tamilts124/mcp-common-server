"use strict";
// ── nats_client: zero-dep NATS protocol client ───────────────────────────────
// Pure Node.js net/tls — no npm dependencies.
// Implements the NATS 2.x text protocol (NATS Messaging, Synadia/Apcera/VMware):
//   connect, publish, subscribe, request, ping
//
// Protocol reference: https://docs.nats.io/reference/reference-protocols/nats

const net = require("net");
const tls = require("tls");
const { ToolError } = require("./errors");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_PORT       = 4222;
const DEFAULT_TLS_PORT   = 4443;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONN_TO_MS = 10_000;
const MAX_PAYLOAD_BYTES  = 8 * 1024 * 1024;  // 8 MB (NATS default max_payload)
const MAX_SUBJECT_LEN    = 4096;

// ── Security guards ──────────────────────────────────────────────────────────

function guardSubject(val, label) {
  if (typeof val !== "string")
    throw new ToolError(`nats_client: '${label}' must be a string.`, -32602);
  if (val.length === 0)
    throw new ToolError(`nats_client: '${label}' must not be empty.`, -32602);
  if (val.length > MAX_SUBJECT_LEN)
    throw new ToolError(`nats_client: '${label}' exceeds ${MAX_SUBJECT_LEN}-char limit.`, -32602);
  if (/[\r\n\0]/.test(val))
    throw new ToolError(
      `nats_client: '${label}' must not contain CR, LF, or NUL bytes (NATS protocol injection).`, -32602);
  // NATS subjects use . as separator, * and > as wildcards in sub only
  return val;
}

function guardStr(val, label) {
  if (typeof val !== "string")
    throw new ToolError(`nats_client: '${label}' must be a string.`, -32602);
  if (/[\r\n\0]/.test(val))
    throw new ToolError(
      `nats_client: '${label}' must not contain CR, LF, or NUL bytes.`, -32602);
  return val;
}

function guardOptStr(val, label) {
  if (val === undefined || val === null) return undefined;
  return guardStr(String(val), label);
}

// ── NATS Line Parser ─────────────────────────────────────────────────────────
/**
 * Streaming NATS protocol parser.
 * NATS is a line-based protocol; MSG frames have a payload on the next line.
 *
 * Emitted event types:
 *   { type: 'INFO', data: object }         — server INFO on connect
 *   { type: 'MSG', subject, sid, replyTo, payload: Buffer, payloadStr: string }
 *   { type: 'PING' }                       — server PING
 *   { type: 'PONG' }                       — server PONG
 *   { type: '+OK' }                        — verbose mode acknowledgement
 *   { type: '-ERR', message: string }      — server error
 */
class NatsParser {
  constructor() {
    this._buf     = Buffer.alloc(0);
    this._events  = [];     // parsed, ready events
    this._maxBuf  = MAX_PAYLOAD_BYTES + 65536;
    // State for multi-line MSG parsing
    this._pendingMsg = null; // { subject, sid, replyTo, size }
  }

  feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    if (this._buf.length > this._maxBuf)
      throw new ToolError(
        `nats_client: incoming data exceeds ${MAX_PAYLOAD_BYTES / 1024 / 1024} MB limit.`, -32603);
    this._parse();
  }

  _parse() {
    while (true) {
      if (this._pendingMsg !== null) {
        // We are waiting for the payload bytes of a MSG.
        const needed = this._pendingMsg.size + 2; // payload + CRLF
        if (this._buf.length < needed) break;     // wait for more data

        const payload = this._buf.slice(0, this._pendingMsg.size);
        this._buf     = this._buf.slice(needed);  // skip payload + CRLF

        this._events.push({
          type:       "MSG",
          subject:    this._pendingMsg.subject,
          sid:        this._pendingMsg.sid,
          replyTo:    this._pendingMsg.replyTo || undefined,
          payload,
          payloadStr: payload.toString("utf8"),
        });
        this._pendingMsg = null;
        continue;
      }

      // Find end of line (\r\n)
      const eoIdx = this._buf.indexOf("\r\n");
      if (eoIdx === -1) break; // incomplete line

      const line = this._buf.slice(0, eoIdx).toString("utf8");
      this._buf  = this._buf.slice(eoIdx + 2);

      if (line === "") continue; // empty line, skip

      if (line.startsWith("INFO ")) {
        try {
          const info = JSON.parse(line.slice(5));
          this._events.push({ type: "INFO", data: info });
        } catch (_) {
          this._events.push({ type: "INFO", data: {} });
        }
      } else if (line.startsWith("MSG ")) {
        // MSG <subject> <sid> [<reply>] <#bytes>\r\n<payload>\r\n
        const parts = line.slice(4).split(" ");
        // parts: subject, sid, [reply,] size
        if (parts.length < 3) continue; // malformed
        const subject  = parts[0];
        const sid      = parts[1];
        let replyTo, size;
        if (parts.length === 3) {
          replyTo = null;
          size    = parseInt(parts[2], 10);
        } else {
          replyTo = parts[2];
          size    = parseInt(parts[3], 10);
        }
        if (isNaN(size) || size < 0) continue;
        this._pendingMsg = { subject, sid, replyTo, size };
        continue; // payload comes next
      } else if (line === "PING") {
        this._events.push({ type: "PING" });
      } else if (line === "PONG") {
        this._events.push({ type: "PONG" });
      } else if (line === "+OK") {
        this._events.push({ type: "+OK" });
      } else if (line.startsWith("-ERR ")) {
        this._events.push({ type: "-ERR", message: line.slice(5).replace(/'/g, "") });
      } else if (line.startsWith("-ERR")) {
        this._events.push({ type: "-ERR", message: line.slice(4).trim().replace(/'/g, "") });
      }
      // Unknown lines are silently skipped
    }
  }

  shift()         { return this._events.length > 0 ? this._events.shift() : null; }
  get available() { return this._events.length; }
}

// ── NATS Frame Encoders ───────────────────────────────────────────────────────

function encodeConnect(opts) {
  const info = {
    verbose:   false,
    pedantic:  false,
    name:      opts.name || "mcp-nats-client",
    lang:      "node",
    version:   "0.0.1",
    protocol:  1,
  };
  if (opts.user)  info.user = opts.user;
  if (opts.pass)  info.pass = opts.pass;
  if (opts.token) info.auth_token = opts.token;
  if (opts.nkey)  info.nkey = opts.nkey;
  return `CONNECT ${JSON.stringify(info)}\r\n`;
}

function encodePub(subject, payload, replyTo) {
  const hdr = replyTo
    ? `PUB ${subject} ${replyTo} ${payload.length}\r\n`
    : `PUB ${subject} ${payload.length}\r\n`;
  return Buffer.concat([Buffer.from(hdr, "utf8"), payload, Buffer.from("\r\n", "utf8")]);
}

function encodeSub(subject, sid, queue) {
  return queue
    ? `SUB ${subject} ${queue} ${sid}\r\n`
    : `SUB ${subject} ${sid}\r\n`;
}

function encodeUnsub(sid, maxMsgs) {
  return maxMsgs != null
    ? `UNSUB ${sid} ${maxMsgs}\r\n`
    : `UNSUB ${sid}\r\n`;
}

// ── Connection helpers ────────────────────────────────────────────────────────

async function openNatsConnection(opts, socketRef) {
  const {
    host,
    port,
    tls:                useTls = false,
    reject_unauthorized         = true,
    user,
    pass,
    token,
    connect_timeout,
    timeout = DEFAULT_TIMEOUT_MS,
  } = opts;

  const connToMs = typeof connect_timeout === "number"
    ? connect_timeout * 1000
    : Math.min(timeout, DEFAULT_CONN_TO_MS);

  return new Promise((resolve, reject) => {
    const parser   = new NatsParser();
    const waiters  = [];   // { resolve, reject }
    const eventBuf = [];   // buffered events not yet consumed
    let settled    = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    };

    const onData = (chunk) => {
      try { parser.feed(chunk); }
      catch (e) {
        done(new ToolError(`nats_client: parse error: ${e.message}`, -32603));
        if (!socket.destroyed) socket.destroy();
        return;
      }
      let ev;
      while ((ev = parser.shift()) !== null) {
        // Auto-respond to server PINGs
        if (ev.type === "PING") {
          send("PONG\r\n");
          continue; // don't surface PING events — they're keepalives
        }
        if (waiters.length > 0) waiters.shift().resolve(ev);
        else eventBuf.push(ev);
      }
    };

    const send = (data) => {
      if (!socket.destroyed)
        socket.write(typeof data === "string" ? data : data);
    };

    const nextEvent = () => {
      if (eventBuf.length > 0) return Promise.resolve(eventBuf.shift());
      return new Promise((res, rej) => waiters.push({ resolve: res, reject: rej }));
    };

    const drainWaiters = () => { while (waiters.length) waiters.shift().resolve(null); };

    // ── Socket ────────────────────────────────────────────────────────────────
    const socketOpts = { host, port };
    const socket = useTls
      ? tls.connect({ ...socketOpts, rejectUnauthorized: reject_unauthorized, servername: host })
      : net.createConnection(socketOpts);

    if (socketRef) socketRef.socket = socket;

    let connTimer = setTimeout(() => {
      socket.destroy(
        new ToolError(`nats_client: TCP connection timed out after ${connToMs} ms.`, -32603));
    }, connToMs);
    connTimer.unref();

    socket.on("data",  onData);
    socket.on("error", (e) => {
      done(new ToolError(`nats_client: socket error: ${e.message}`, -32603));
    });
    socket.on("close", () => {
      drainWaiters();
    });

    const onConnect = async () => {
      clearTimeout(connTimer);
      connTimer = null;
      try {
        // Wait for INFO from server
        const ev = await nextEvent();
        if (!ev)
          throw new ToolError("nats_client: connection closed before INFO.", -32603);
        if (ev.type !== "INFO")
          throw new ToolError(`nats_client: expected INFO, got ${ev.type}`, -32603);

        const serverInfo = ev.data;

        // Send CONNECT
        send(encodeConnect({ user, pass, token }));

        // Send PING to confirm connection is live (NATS always responds with PONG)
        send("PING\r\n");

        // Wait for PONG (or -ERR on auth failure)
        let pongReceived = false;
        const deadline = Date.now() + connToMs;
        while (!pongReceived) {
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw new ToolError("nats_client: timed out waiting for PONG after CONNECT.", -32603);
          const cev = await Promise.race([
            nextEvent(),
            new Promise((_, rej) => setTimeout(() => rej(new ToolError("nats_client: PONG timeout.", -32603)), remaining).unref()),
          ]);
          if (!cev) throw new ToolError("nats_client: connection closed before PONG.", -32603);
          if (cev.type === "-ERR")
            throw new ToolError(`nats_client: server error: ${cev.message}`, -32603);
          if (cev.type === "PONG") { pongReceived = true; break; }
          // +OK or other events: buffer or ignore
          if (cev.type !== "+OK") eventBuf.push(cev);
        }

        done(null, {
          socket, parser, send, nextEvent, drainWaiters,
          serverInfo,
          serverId:    serverInfo.server_id    || undefined,
          serverName:  serverInfo.server_name  || serverInfo.server_id || undefined,
          version:     serverInfo.version      || undefined,
          maxPayload:  serverInfo.max_payload  || MAX_PAYLOAD_BYTES,
          tlsRequired: !!serverInfo.tls_required,
        });
      } catch (e) {
        done(e instanceof ToolError ? e :
             new ToolError(`nats_client: handshake error: ${e.message}`, -32603));
        if (!socket.destroyed) socket.destroy();
      }
    };

    if (useTls) socket.on("secureConnect", onConnect);
    else        socket.on("connect",       onConnect);
  });
}

async function closeNatsConnection(conn) {
  const { socket, drainWaiters } = conn;
  try {
    if (typeof drainWaiters === "function") drainWaiters();
    if (!socket.destroyed) {
      socket.write("\r\n"); // harmless no-op to flush any buffered writes
      socket.destroy();
    }
  } catch (_) { /* ignore */ }
}

// ── Unique subscription ID generator ─────────────────────────────────────────
let _sidCounter = 0;
function nextSid() { return `mcp-${(++_sidCounter).toString(36)}`; }

// ── Main exported function ────────────────────────────────────────────────────

async function natsClient(opts) {
  opts = opts || {};

  const {
    host,
    port,
    tls:                useTls             = false,
    reject_unauthorized                    = true,
    user,
    pass,
    token,
    timeout                                = 30,
    connect_timeout,
    operation,
    subject,
    reply_to,
    payload                                = "",
    payload_encoding                       = "utf8",
    queue_group,
    subscribe_subject,
    max_messages                           = 10,
    subscribe_timeout                      = 5,
    request_timeout                        = 5,
  } = opts;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!host || typeof host !== "string")
    throw new ToolError("nats_client: 'host' is required (string).", -32602);

  const VALID_OPS = ["connect", "publish", "subscribe", "request", "ping"];
  if (!operation || !VALID_OPS.includes(operation))
    throw new ToolError(
      `nats_client: 'operation' must be one of: ${VALID_OPS.join(", ")}.`, -32602);

  if (["publish", "request"].includes(operation)) {
    if (!subject)
      throw new ToolError(
        `nats_client: 'subject' is required for operation '${operation}'.`, -32602);
    guardSubject(subject, "subject");
  }
  if (operation === "subscribe") {
    const sub = subscribe_subject || subject;
    if (!sub)
      throw new ToolError(
        "nats_client: 'subscribe_subject' (or 'subject') is required for subscribe.", -32602);
    guardSubject(sub, "subscribe_subject");
    if (max_messages < 1 || max_messages > 1000)
      throw new ToolError("nats_client: 'max_messages' must be 1\u20131000.", -32602);
  }
  if (operation === "request") {
    if (reply_to !== undefined) guardSubject(reply_to, "reply_to");
  }

  if (user  != null) guardOptStr(user,  "user");
  if (pass  != null) guardOptStr(pass,  "pass");
  if (token != null) guardOptStr(token, "token");
  if (queue_group != null) guardSubject(queue_group, "queue_group");

  const payloadBuf = payload_encoding === "base64"
    ? Buffer.from(payload || "", "base64")
    : Buffer.from(payload || "", "utf8");
  if (payloadBuf.length > MAX_PAYLOAD_BYTES)
    throw new ToolError(
      `nats_client: payload exceeds ${MAX_PAYLOAD_BYTES / 1024 / 1024} MB limit.`, -32602);

  const timeoutMs    = (typeof timeout === "number" && timeout > 0) ? timeout * 1000 : DEFAULT_TIMEOUT_MS;
  const resolvedPort = typeof port === "number" ? port : (useTls ? DEFAULT_TLS_PORT : DEFAULT_PORT);

  const startTime = Date.now();
  let globalTimer;
  let conn;
  const socketRef = { socket: null };

  const timeoutPromise = new Promise((_, rej) => {
    globalTimer = setTimeout(() =>
      rej(new ToolError(`nats_client: operation timed out after ${timeoutMs} ms.`, -32603)),
      timeoutMs);
    globalTimer.unref();
  });

  async function run() {
    conn = await openNatsConnection({
      host, port: resolvedPort, tls: useTls, reject_unauthorized,
      user, pass, token, timeout: timeoutMs, connect_timeout,
    }, socketRef);

    const { send, nextEvent, drainWaiters, serverId, serverName, version, maxPayload } = conn;
    let result;

    switch (operation) {

      // ── connect ─────────────────────────────────────────────────────────────
      case "connect": {
        result = { connected: true, serverId, serverName, version, maxPayload };
        break;
      }

      // ── ping ─────────────────────────────────────────────────────────────────
      case "ping": {
        const t0 = Date.now();
        send("PING\r\n");
        const ev = await nextEvent();
        if (!ev)
          throw new ToolError("nats_client: connection closed waiting for PONG.", -32603);
        if (ev.type === "-ERR")
          throw new ToolError(`nats_client: server error: ${ev.message}`, -32603);
        if (ev.type !== "PONG")
          throw new ToolError(`nats_client: expected PONG, got ${ev.type}`, -32603);
        result = { pong: true, latencyMs: Date.now() - t0 };
        break;
      }

      // ── publish ──────────────────────────────────────────────────────────────
      case "publish": {
        const pubReplyTo = reply_to || undefined;
        send(encodePub(subject, payloadBuf, pubReplyTo));
        result = { published: true, subject, payloadBytes: payloadBuf.length, replyTo: pubReplyTo || undefined };
        break;
      }

      // ── subscribe ────────────────────────────────────────────────────────────
      case "subscribe": {
        const subSubject  = subscribe_subject || subject;
        const sid         = nextSid();
        const maxMsgs     = Math.min(max_messages, 1000);
        const subToMs     = (typeof subscribe_timeout === "number" && subscribe_timeout > 0)
          ? subscribe_timeout * 1000 : 5000;

        // UNSUB with maxMsgs so server auto-unsubs once limit is reached
        send(encodeSub(subSubject, sid, queue_group || undefined));
        send(encodeUnsub(sid, maxMsgs));

        const messages = [];
        const deadline  = Date.now() + subToMs;

        while (messages.length < maxMsgs && Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const ev = await Promise.race([
            nextEvent(),
            new Promise(res => setTimeout(() => res(null), Math.max(0, remaining)).unref()),
          ]);
          if (!ev) break;
          if (ev.type === "MSG" && ev.sid === sid) {
            messages.push({
              subject:    ev.subject,
              replyTo:    ev.replyTo || undefined,
              payload:    ev.payloadStr,
              payloadBytes: ev.payload.length,
            });
          } else if (ev.type === "-ERR") {
            throw new ToolError(`nats_client: server error during subscribe: ${ev.message}`, -32603);
          } else {
            // Non-MSG event (e.g. +OK); ignore
          }
        }

        drainWaiters();
        result = { subscription: sid, subject: subSubject,
                   queueGroup: queue_group || undefined,
                   messageCount: messages.length, messages };
        break;
      }

      // ── request ──────────────────────────────────────────────────────────────
      case "request": {
        const replySubject = reply_to || `_INBOX.mcp.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
        const replySid     = nextSid();
        const reqToMs      = (typeof request_timeout === "number" && request_timeout > 0)
          ? request_timeout * 1000 : 5000;

        // Subscribe to the reply inbox first, then publish
        send(encodeSub(replySubject, replySid));
        send(encodeUnsub(replySid, 1)); // auto-unsub after first reply
        send(encodePub(subject, payloadBuf, replySubject));

        const deadline = Date.now() + reqToMs;
        let replyEv    = null;
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const ev = await Promise.race([
            nextEvent(),
            new Promise(res => setTimeout(() => res(null), Math.max(0, remaining)).unref()),
          ]);
          if (!ev) break;
          if (ev.type === "MSG" && ev.sid === replySid) {
            replyEv = ev; break;
          }
          if (ev.type === "-ERR")
            throw new ToolError(`nats_client: server error during request: ${ev.message}`, -32603);
        }

        drainWaiters();
        result = replyEv ? {
          replied:      true,
          replySubject: replyEv.subject,
          payload:      replyEv.payloadStr,
          payloadBytes: replyEv.payload.length,
        } : {
          replied:      false,
          timedOut:     true,
          replySubject,
        };
        break;
      }

      default:
        throw new ToolError(`nats_client: unhandled operation '${operation}'.`, -32603);
    }

    return {
      host, port: resolvedPort, operation,
      elapsedMs: Date.now() - startTime,
      serverId, serverName, version,
      ...result,
    };
  }

  try {
    const runPromise = run();
    runPromise.catch(() => {});
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(globalTimer);
    if (conn) {
      await closeNatsConnection(conn).catch(() => {});
    } else if (socketRef.socket && !socketRef.socket.destroyed) {
      socketRef.socket.destroy();
    }
  }
}

module.exports = { natsClient, NatsParser, encodeConnect, encodePub, encodeSub };
