"use strict";
/**
 * syslog_client — Zero-dependency Syslog client.
 * Pure Node.js (dgram + net + tls built-ins; no npm deps).
 *
 * Supported operations:
 *   send       — Send a single syslog message
 *   send_batch — Send multiple syslog messages in one call
 *   info       — Return facility/severity tables and format descriptions
 *
 * Formats:
 *   rfc5424 — Modern syslog (RFC 5424, default)
 *   rfc3164 — BSD legacy syslog (RFC 3164)
 *
 * Transports:
 *   udp  — UDP datagram (default, port 514)
 *   tcp  — TCP stream (port 514)
 *   tls  — TCP+TLS (port 6514)
 *
 * Security:
 *   - NUL-byte guards on host, app_name, hostname, message
 *   - Timeout clamped 1 s – 30 s
 *   - Message length capped at 64 KB (single) / 1000 messages in batch
 *   - TLS: rejectUnauthorized configurable (default true)
 *   - Credentials never logged
 */

const dgram = require("dgram");
const net   = require("net");
const tls   = require("tls");
const os    = require("os");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_HOST_UDP  = "127.0.0.1";
const DEFAULT_PORT_UDP  = 514;
const DEFAULT_PORT_TCP  = 514;
const DEFAULT_PORT_TLS  = 6514;
const DEFAULT_TIMEOUT   = 5_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 30_000;
const MAX_MSG_BYTES     = 65535;
const MAX_BATCH_MSGS    = 1000;
const NIL_VALUE         = "-";  // RFC 5424 nil-value

// ── Facility codes (RFC 5424 Table 1) ────────────────────────────────────────
const FACILITIES = {
  kern:     0,  kernel:       0,
  user:     1,
  mail:     2,
  daemon:   3,  system:       3,
  auth:     4,  security:     4,
  syslog:   5,
  lpr:      6,
  news:     7,
  uucp:     8,
  cron:     9,  clock:        9,
  authpriv: 10,
  ftp:      11,
  ntp:      12,
  logaudit: 13, audit:        13,
  logalert: 14, alert:        14,
  clock2:   15,
  local0:   16,
  local1:   17,
  local2:   18,
  local3:   19,
  local4:   20,
  local5:   21,
  local6:   22,
  local7:   23,
};

// ── Severity codes (RFC 5424 Table 2) ────────────────────────────────────────
const SEVERITIES = {
  emerg:   0, emergency:   0, panic:   0,
  alert:   1,
  crit:    2, critical:    2,
  err:     3, error:       3,
  warning: 4, warn:        4,
  notice:  5,
  info:    6, informational: 6,
  debug:   7,
};

// Human-readable names for the info op
const FACILITY_NAMES = [
  "kern", "user", "mail", "daemon", "auth", "syslog", "lpr", "news",
  "uucp", "cron", "authpriv", "ftp", "ntp", "logaudit", "logalert", "clock2",
  "local0", "local1", "local2", "local3", "local4", "local5", "local6", "local7",
];
const SEVERITY_NAMES = [
  "emerg", "alert", "crit", "err", "warning", "notice", "info", "debug",
];

// ── Guards ────────────────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`syslog_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.trunc(n)));
}

// ── Resolve facility code ─────────────────────────────────────────────────────
function resolveFacility(f) {
  if (f === undefined || f === null) return 1; // user
  if (typeof f === "number") {
    if (!Number.isInteger(f) || f < 0 || f > 23)
      throw new Error(`syslog_client: 'facility' number must be 0–23 (got ${f}).`);
    return f;
  }
  if (typeof f === "string") {
    const lower = f.toLowerCase();
    if (lower in FACILITIES) return FACILITIES[lower];
    throw new Error(`syslog_client: unknown facility '${f}'. Use a name (e.g. 'user', 'local0') or number 0–23.`);
  }
  throw new Error(`syslog_client: 'facility' must be a string name or integer 0–23.`);
}

// ── Resolve severity code ─────────────────────────────────────────────────────
function resolveSeverity(s) {
  if (s === undefined || s === null) return 6; // info
  if (typeof s === "number") {
    if (!Number.isInteger(s) || s < 0 || s > 7)
      throw new Error(`syslog_client: 'severity' number must be 0–7 (got ${s}).`);
    return s;
  }
  if (typeof s === "string") {
    const lower = s.toLowerCase();
    if (lower in SEVERITIES) return SEVERITIES[lower];
    throw new Error(`syslog_client: unknown severity '${s}'. Use a name (e.g. 'info', 'err', 'debug') or number 0–7.`);
  }
  throw new Error(`syslog_client: 'severity' must be a string name or integer 0–7.`);
}

// ── Sanitise ASCII printable, no spaces (RFC 5424 PRINTUSASCII ≤ 127, ≥ 33) ──
function sanitisePrintUS(v, maxLen, fieldName) {
  if (!v || typeof v !== "string") return NIL_VALUE;
  const s = v.slice(0, maxLen).replace(/[\x00-\x1f\x7f ]/g, "_");
  if (!s) return NIL_VALUE;
  return s;
}

// ── Format: RFC 5424 ──────────────────────────────────────────────────────────
// <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID SP STRUCTURED-DATA SP MSG
function formatRfc5424(opts) {
  const {
    facility, severity, timestamp, hostname, appName,
    procId, msgId, structuredData, message,
  } = opts;

  const pri  = (facility << 3) | severity;
  const ts   = timestamp || new Date().toISOString();
  const host = sanitisePrintUS(hostname, 255, "hostname");
  const app  = sanitisePrintUS(appName,   48, "app_name");
  const proc = sanitisePrintUS(procId,   128, "proc_id");
  const mid  = sanitisePrintUS(msgId,      32, "msg_id");

  // Structured data: pass through as-is or use NIL_VALUE
  // Caller can supply a raw RFC 5424 SD string like '[exampleSDID@32473 key="val"]'
  let sd = NIL_VALUE;
  if (typeof structuredData === "string" && structuredData.trim()) {
    sd = structuredData.trim();
  } else if (structuredData && typeof structuredData === "object") {
    // Build SD from object: { sdId: { key: value, ... }, ... }
    const parts = [];
    for (const [sdId, params] of Object.entries(structuredData)) {
      const sanitisedId = sanitisePrintUS(sdId, 32, "sd_id");
      if (!params || typeof params !== "object") {
        parts.push(`[${sanitisedId}]`);
        continue;
      }
      const kvParts = [];
      for (const [k, v] of Object.entries(params)) {
        const sk = sanitisePrintUS(k, 32, "sd_param_name");
        // Escape ", \, ] in param values (RFC 5424 §6.3.3)
        const sv = String(v == null ? "" : v)
          .replace(/\\/g, "\\\\")
          .replace(/"/g,  "\\\"")
          .replace(/]/g,  "\\]");
        kvParts.push(`${sk}="${sv}"`);
      }
      parts.push(`[${sanitisedId} ${kvParts.join(" ")}]`);
    }
    if (parts.length) sd = parts.join("");
  }

  // Message: prefix BOM for UTF-8 (RFC 5424 §6.4)
  const msgStr = typeof message === "string" ? message : "";
  const msgPart = msgStr ? ("\xef\xbb\xbf" + msgStr) : "";

  return `<${pri}>1 ${ts} ${host} ${app} ${proc} ${mid} ${sd}${msgPart ? " " + msgPart : ""}`;
}

// ── Format: RFC 3164 ──────────────────────────────────────────────────────────
// <PRI>TIMESTAMP HOSTNAME TAG: MSG
const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];

function rfc3164Timestamp(d) {
  const month = MONTH_ABBR[d.getUTCMonth()];
  const day   = d.getUTCDate();
  const H     = String(d.getUTCHours()).padStart(2, "0");
  const M     = String(d.getUTCMinutes()).padStart(2, "0");
  const S     = String(d.getUTCSeconds()).padStart(2, "0");
  return `${month} ${day < 10 ? " " + day : day} ${H}:${M}:${S}`;
}

function formatRfc3164(opts) {
  const { facility, severity, hostname, appName, procId, message } = opts;

  const pri  = (facility << 3) | severity;
  const ts   = rfc3164Timestamp(new Date());
  const host = (hostname || os.hostname()).replace(/[\x00-\x1f\x7f ]/g, "_").slice(0, 255) || "-";
  const tag  = (appName  || "syslog").replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 32) || "syslog";
  const pid  = procId ? `[${String(procId).replace(/[\[\]]/g, "_")}]` : "";
  const msgStr = typeof message === "string" ? message : "";

  return `<${pri}>${ts} ${host} ${tag}${pid}: ${msgStr}`;
}

// ── Build a formatted message buffer ────────────────────────────────────────
function buildMessage(msgArgs, defaults = {}) {
  const facility = resolveFacility(msgArgs.facility ?? defaults.facility);
  const severity = resolveSeverity(msgArgs.severity ?? defaults.severity);
  const format   = (msgArgs.format   ?? defaults.format   ?? "rfc5424").toLowerCase();
  const message  = msgArgs.message ?? "";
  const hostname = msgArgs.hostname ?? defaults.hostname ?? os.hostname();
  const appName  = msgArgs.app_name ?? defaults.app_name ?? "syslog_client";
  const procId   = msgArgs.proc_id  ?? defaults.proc_id  ?? String(process.pid);
  const msgId    = msgArgs.msg_id   ?? defaults.msg_id;
  const structuredData = msgArgs.structured_data ?? defaults.structured_data;
  const timestamp = msgArgs.timestamp ?? defaults.timestamp;

  guardNul(String(hostname), "hostname");
  guardNul(String(appName),  "app_name");
  guardNul(String(message),  "message");

  let formatted;
  if (format === "rfc5424") {
    formatted = formatRfc5424({ facility, severity, timestamp, hostname, appName, procId, msgId, structuredData, message });
  } else if (format === "rfc3164") {
    formatted = formatRfc3164({ facility, severity, hostname, appName, procId, message });
  } else {
    throw new Error(`syslog_client: unknown format '${format}'. Use 'rfc5424' or 'rfc3164'.`);
  }

  const buf = Buffer.from(formatted, "utf8");
  if (buf.length > MAX_MSG_BYTES)
    throw new Error(`syslog_client: message too large (${buf.length} bytes; max ${MAX_MSG_BYTES}).`);

  return { buf, formatted, facility, severity, format };
}

// ── UDP send ─────────────────────────────────────────────────────────────────
function sendUdp({ host, port, buf, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled  = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) { /* ignore */ }
      if (err) reject(err); else resolve();
    };

    const timer = setTimeout(() => {
      done(new Error(`syslog_client: UDP send to ${host}:${port} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    socket.on("error", (e) => done(new Error(`syslog_client: UDP socket error: ${e.message}`)));
    socket.send(buf, 0, buf.length, port, host, (err) => {
      if (err) done(new Error(`syslog_client: UDP send error: ${err.message}`));
      else done(null);
    });
  });
}

// ── TCP send (plain or TLS) ──────────────────────────────────────────────────
function sendTcp({ host, port, bufs, timeoutMs, useTls, rejectUnauthorized, servername }) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) { try { socket.destroy(); } catch (_) { /* ignore */ } }
      if (err) reject(err); else resolve();
    };

    const timer = setTimeout(() => {
      done(new Error(`syslog_client: TCP${useTls ? "+TLS" : ""} send to ${host}:${port} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    const connectOpts = { host, port };

    const onConnect = () => {
      // Write all buffers; each message framed with trailing newline (octet-counting optional)
      let i = 0;
      const writeNext = () => {
        if (i >= bufs.length) {
          // All written; give server a moment then close
          socket.end(() => done(null));
          return;
        }
        const frame = Buffer.concat([bufs[i++], Buffer.from("\n", "ascii")]);
        const ok = socket.write(frame, (err) => {
          if (err) done(new Error(`syslog_client: TCP write error: ${err.message}`));
          else writeNext();
        });
        // If write returns false (backpressure), drain before continuing
        if (!ok) socket.once("drain", writeNext);
      };
      writeNext();
    };

    const onError = (e) => done(new Error(`syslog_client: TCP${useTls ? "+TLS" : ""} error: ${e.message}`));

    if (useTls) {
      socket = tls.connect({
        ...connectOpts,
        rejectUnauthorized: rejectUnauthorized !== false,
        servername: servername || host,
      });
      socket.on("secureConnect", onConnect);
    } else {
      socket = net.createConnection(connectOpts);
      socket.on("connect", onConnect);
    }

    socket.on("error", onError);
    socket.on("close", () => done(new Error(`syslog_client: TCP connection closed before all messages were sent.`)));
  });
}

// ── Core transport dispatcher ─────────────────────────────────────────────────
async function transmit({ transport, host, port, timeoutMs, bufs, rejectUnauthorized, servername }) {
  const t = (transport || "udp").toLowerCase();

  if (t === "udp") {
    // For UDP, send each message as a separate datagram
    for (const buf of bufs)
      await sendUdp({ host, port: port ?? DEFAULT_PORT_UDP, buf, timeoutMs });
    return;
  }

  if (t === "tcp") {
    await sendTcp({ host, port: port ?? DEFAULT_PORT_TCP, bufs, timeoutMs, useTls: false, rejectUnauthorized, servername });
    return;
  }

  if (t === "tls") {
    await sendTcp({ host, port: port ?? DEFAULT_PORT_TLS, bufs, timeoutMs, useTls: true, rejectUnauthorized, servername });
    return;
  }

  throw new Error(`syslog_client: unknown transport '${transport}'. Use 'udp', 'tcp', or 'tls'.`);
}

// ── Operations ────────────────────────────────────────────────────────────────

/** send — send a single syslog message */
async function opSend(args) {
  const host      = args.host || DEFAULT_HOST_UDP;
  const port      = args.port ?? undefined;
  const timeoutMs = clampTimeout(args.timeout);
  const transport = (args.transport || "udp").toLowerCase();

  guardNul(host, "host");
  if (typeof args.host === "string" && !args.host) throw new Error("syslog_client: 'host' must not be empty.");

  const { buf, formatted, facility, severity, format } = buildMessage(args, {
    app_name: "syslog_client",
    format:   args.format || "rfc5424",
  });

  await transmit({
    transport,
    host,
    port,
    timeoutMs,
    bufs: [buf],
    rejectUnauthorized: args.reject_unauthorized,
    servername:         args.servername,
  });

  return {
    ok:         true,
    operation:  "send",
    transport,
    host,
    port:       port ?? (transport === "tls" ? DEFAULT_PORT_TLS : DEFAULT_PORT_UDP),
    format,
    facility,
    facilityName: FACILITY_NAMES[facility] || String(facility),
    severity,
    severityName: SEVERITY_NAMES[severity] || String(severity),
    bytes:      buf.length,
    formatted,
  };
}

/** send_batch — send multiple syslog messages */
async function opSendBatch(args) {
  const host      = args.host || DEFAULT_HOST_UDP;
  const port      = args.port ?? undefined;
  const timeoutMs = clampTimeout(args.timeout);
  const transport = (args.transport || "udp").toLowerCase();

  guardNul(host, "host");

  const messages = args.messages;
  if (!Array.isArray(messages) || messages.length === 0)
    throw new Error("syslog_client: 'messages' must be a non-empty array.");
  if (messages.length > MAX_BATCH_MSGS)
    throw new Error(`syslog_client: 'messages' array too large (${messages.length}; max ${MAX_BATCH_MSGS}).`);

  // Build defaults from top-level args (excluding messages)
  const defaults = {
    facility:        args.facility,
    severity:        args.severity,
    format:          args.format   || "rfc5424",
    hostname:        args.hostname,
    app_name:        args.app_name || "syslog_client",
    proc_id:         args.proc_id,
    msg_id:          args.msg_id,
    structured_data: args.structured_data,
    timestamp:       args.timestamp,
  };

  const bufs      = [];
  const formatted = [];
  const errors    = [];
  let totalBytes  = 0;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") {
      errors.push({ index: i, error: "Message entry must be an object." });
      continue;
    }
    try {
      const { buf, formatted: fmtStr } = buildMessage(m, defaults);
      bufs.push(buf);
      formatted.push(fmtStr);
      totalBytes += buf.length;
    } catch (e) {
      errors.push({ index: i, error: e.message });
    }
  }

  if (errors.length) {
    throw new Error(
      `syslog_client: ${errors.length} message(s) failed to build:\n` +
      errors.map(e => `  [${e.index}]: ${e.error}`).join("\n")
    );
  }

  if (bufs.length === 0)
    throw new Error("syslog_client: no valid messages to send after building.");

  await transmit({
    transport,
    host,
    port,
    timeoutMs,
    bufs,
    rejectUnauthorized: args.reject_unauthorized,
    servername:         args.servername,
  });

  return {
    ok:          true,
    operation:   "send_batch",
    transport,
    host,
    port:        port ?? (transport === "tls" ? DEFAULT_PORT_TLS : DEFAULT_PORT_UDP),
    sent:        bufs.length,
    totalBytes,
    messages:    formatted,
  };
}

/** info — return facility/severity tables and format info */
function opInfo() {
  const facilities = FACILITY_NAMES.map((name, code) => ({ code, name }));
  const severities = SEVERITY_NAMES.map((name, code) => ({ code, name }));

  return {
    ok:        true,
    operation: "info",
    formats: {
      rfc5424: {
        description: "RFC 5424 (modern syslog, 2009). Structured data, UTF-8 BOM, IANA-registered facilities/severities.",
        structure:   "<PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG",
        defaultPort: { udp: 514, tcp: 514, tls: 6514 },
      },
      rfc3164: {
        description: "RFC 3164 (BSD legacy syslog, 2001). Simpler format, widely supported.",
        structure:   "<PRI>TIMESTAMP HOSTNAME TAG[PID]: MSG",
        defaultPort: { udp: 514, tcp: 514 },
      },
    },
    transports: [
      { name: "udp",  description: "UDP datagram (unreliable, low overhead)",   defaultPort: 514  },
      { name: "tcp",  description: "TCP stream (reliable, plain-text)",          defaultPort: 514  },
      { name: "tls",  description: "TCP+TLS (reliable, encrypted, RFC 5425)",   defaultPort: 6514 },
    ],
    facilities,
    severities,
    limits: {
      maxMessageBytes: MAX_MSG_BYTES,
      maxBatchMessages: MAX_BATCH_MSGS,
      minTimeoutMs: MIN_TIMEOUT,
      maxTimeoutMs: MAX_TIMEOUT,
    },
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

async function syslogClient(args) {
  const op = args.operation;
  if (!op) throw new Error("syslog_client: 'operation' is required.");

  switch (op) {
    case "send":       return opSend(args);
    case "send_batch": return opSendBatch(args);
    case "info":       return opInfo();
    default:
      throw new Error(
        `syslog_client: unknown operation '${op}'. ` +
        `Valid: send, send_batch, info.`
      );
  }
}

module.exports = { syslogClient };
