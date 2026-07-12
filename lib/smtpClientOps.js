"use strict";
// ── SMTP_CLIENT — direct SMTP protocol client ─────────────────────────────────
// Zero npm dependencies — uses Node.js built-in net/tls modules.
//
// Implements enough of RFC 5321 (SMTP) and RFC 3207 (STARTTLS) to:
//   • probe:    Connect, grab banner, send EHLO, collect capabilities.
//   • send:     Full email delivery: EHLO → (optional STARTTLS) → (optional AUTH) →
//               MAIL FROM → RCPT TO → DATA → QUIT.
//   • verify:   VRFY or EXPN a mailbox (server permitting).
//   • noop:     EHLO + NOOP — connectivity / latency check.
//
// Auth methods: PLAIN and LOGIN (the two universally supported mechanisms).
// TLS: native TLS (port 465 style) via `secure:true`, or STARTTLS upgrade.
//
// Security guards:
//   • Addresses / usernames validated: no null bytes, control chars, shell chars.
//   • Response lines capped at 512 bytes each (RFC 5321 §4.5.3.1).
//   • Total response budget capped (default 512 KB).
//   • Auth credentials never echoed in the result object.

const net  = require("net");
const tls  = require("tls");
const { ToolError } = require("./errors");

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_S          = 30;
const MAX_TIMEOUT_S              = 120;
const DEFAULT_CONNECT_TIMEOUT_S  = 10;
const MAX_CONNECT_TIMEOUT_S      = 30;
const MAX_RESPONSE_BYTES         = 512 * 1024;  // 512 KB total
const MAX_RESPONSE_LINE_BYTES    = 4096;         // per line safety cap
const MAX_RCPT_TO                = 50;
const MAX_BODY_BYTES             = 10 * 1024 * 1024; // 10 MB message cap
const CRLF                       = "\r\n";

// ── Input validation ───────────────────────────────────────────────────────────
const CTRL_PATTERN = /[\x00-\x1F\x7F]/;   // NUL + control chars
const SAFE_EMAIL_RE = /^[^\x00-\x1F\x7F<>]{1,254}@[^\x00-\x1F\x7F<>\s]{1,253}$/;

function guardString(val, name, maxLen = 1000) {
  if (typeof val !== "string" || val.length === 0)
    throw new ToolError(`smtp_client: '${name}' must be a non-empty string.`, -32602);
  if (val.length > maxLen)
    throw new ToolError(`smtp_client: '${name}' exceeds ${maxLen} character limit.`, -32602);
  if (CTRL_PATTERN.test(val))
    throw new ToolError(`smtp_client: '${name}' must not contain control characters.`, -32602);
}

function guardEmail(addr, field) {
  if (typeof addr !== "string") throw new ToolError(`smtp_client: '${field}' must be a string.`, -32602);
  const clean = addr.replace(/^<|>$/g, "").trim();
  if (clean.length === 0) throw new ToolError(`smtp_client: '${field}' is empty.`, -32602);
  if (CTRL_PATTERN.test(clean))
    throw new ToolError(`smtp_client: '${field}' contains control characters.`, -32602);
  if (clean.length > 254)
    throw new ToolError(`smtp_client: '${field}' exceeds maximum email address length of 254 chars.`, -32602);
  if (!SAFE_EMAIL_RE.test(clean))
    throw new ToolError(`smtp_client: '${field}' is not a valid email address (got: '${addr}').`, -32602);
  return clean;
}

function validateInputs(opts) {
  const operation = opts.operation ?? "probe";
  const VALID_OPS = ["probe", "send", "verify", "noop"];
  if (!VALID_OPS.includes(operation))
    throw new ToolError(
      `smtp_client: 'operation' must be one of: ${VALID_OPS.join(", ")} (got '${operation}').`, -32602);

  // host / port
  if (!opts.host || typeof opts.host !== "string")
    throw new ToolError("smtp_client: 'host' is required.", -32602);
  if (opts.host.length > 253 || CTRL_PATTERN.test(opts.host))
    throw new ToolError("smtp_client: 'host' is invalid.", -32602);

  const port = opts.port != null ? Number(opts.port) :
    (opts.secure ? 465 : 25);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ToolError("smtp_client: 'port' must be 1–65535.", -32602);

  const secure  = !!opts.secure;          // native TLS from the start (port 465)
  const starttls = opts.starttls !== false && !secure; // STARTTLS upgrade (default true unless native TLS)
  // Note: if secure=true, starttls is irrelevant.

  // helo_name — what we advertise in EHLO
  let helo = opts.helo_name ?? "mcp-client";
  guardString(helo, "helo_name", 253);

  // Timeouts
  let timeout = DEFAULT_TIMEOUT_S;
  if (opts.timeout != null) {
    if (typeof opts.timeout !== "number" || opts.timeout <= 0)
      throw new ToolError("smtp_client: 'timeout' must be a positive number.", -32602);
    timeout = Math.min(opts.timeout, MAX_TIMEOUT_S);
  }
  let connectTimeout = DEFAULT_CONNECT_TIMEOUT_S;
  if (opts.connect_timeout != null) {
    if (typeof opts.connect_timeout !== "number" || opts.connect_timeout <= 0)
      throw new ToolError("smtp_client: 'connect_timeout' must be a positive number.", -32602);
    connectTimeout = Math.min(opts.connect_timeout, MAX_CONNECT_TIMEOUT_S);
  }

  // Auth
  let auth = null;
  if (opts.auth) {
    if (typeof opts.auth !== "object")
      throw new ToolError("smtp_client: 'auth' must be an object.", -32602);
    const method = (opts.auth.method ?? "PLAIN").toUpperCase();
    if (!["PLAIN", "LOGIN"].includes(method))
      throw new ToolError("smtp_client: 'auth.method' must be 'PLAIN' or 'LOGIN'.", -32602);
    if (!opts.auth.user || typeof opts.auth.user !== "string")
      throw new ToolError("smtp_client: 'auth.user' is required.", -32602);
    if (CTRL_PATTERN.test(opts.auth.user))
      throw new ToolError("smtp_client: 'auth.user' contains invalid characters.", -32602);
    if (typeof opts.auth.password !== "string")
      throw new ToolError("smtp_client: 'auth.password' must be a string.", -32602);
    auth = { method, user: opts.auth.user, password: opts.auth.password };
  }

  // send-specific
  let from = null, to = null, cc = null, bcc = null;
  let subject = null, bodyText = null, bodyHtml = null;
  let extraHeaders = {};

  if (operation === "send") {
    if (!opts.from) throw new ToolError("smtp_client: 'from' is required for 'send'.", -32602);
    from = guardEmail(opts.from, "from");

    if (!opts.to || (Array.isArray(opts.to) && opts.to.length === 0))
      throw new ToolError("smtp_client: 'to' is required for 'send'.", -32602);
    const toArr = Array.isArray(opts.to) ? opts.to : [opts.to];
    if (toArr.length > MAX_RCPT_TO)
      throw new ToolError(`smtp_client: 'to' may have at most ${MAX_RCPT_TO} recipients.`, -32602);
    to = toArr.map((a, i) => guardEmail(a, `to[${i}]`));

    if (opts.cc) {
      const ccArr = Array.isArray(opts.cc) ? opts.cc : [opts.cc];
      if (toArr.length + ccArr.length > MAX_RCPT_TO)
        throw new ToolError("smtp_client: too many recipients (to+cc combined).", -32602);
      cc = ccArr.map((a, i) => guardEmail(a, `cc[${i}]`));
    }
    if (opts.bcc) {
      const bccArr = Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc];
      bcc = bccArr.map((a, i) => guardEmail(a, `bcc[${i}]`));
    }

    if (opts.subject != null) {
      if (typeof opts.subject !== "string")
        throw new ToolError("smtp_client: 'subject' must be a string.", -32602);
      // RFC 5321: subject line must not contain raw CR/LF
      if (/[\r\n]/.test(opts.subject))
        throw new ToolError("smtp_client: 'subject' must not contain CR or LF.", -32602);
      subject = opts.subject;
    }
    if (opts.body_text != null) {
      if (typeof opts.body_text !== "string")
        throw new ToolError("smtp_client: 'body_text' must be a string.", -32602);
      bodyText = opts.body_text;
    }
    if (opts.body_html != null) {
      if (typeof opts.body_html !== "string")
        throw new ToolError("smtp_client: 'body_html' must be a string.", -32602);
      bodyHtml = opts.body_html;
    }
    if (bodyText == null && bodyHtml == null)
      throw new ToolError("smtp_client: 'send' requires 'body_text' and/or 'body_html'.", -32602);

    if (opts.extra_headers != null) {
      if (typeof opts.extra_headers !== "object" || Array.isArray(opts.extra_headers))
        throw new ToolError("smtp_client: 'extra_headers' must be a plain object.", -32602);
      for (const [k, v] of Object.entries(opts.extra_headers)) {
        if (/[\r\n:]/.test(k) || /[\r\n]/.test(String(v)))
          throw new ToolError(
            `smtp_client: 'extra_headers' contains header injection in key '${k}'.`, -32602);
      }
      extraHeaders = opts.extra_headers;
    }
  }

  // verify-specific
  let vrfyTarget = null;
  if (operation === "verify") {
    if (!opts.target) throw new ToolError("smtp_client: 'target' is required for 'verify'.", -32602);
    guardString(opts.target, "target", 512);
    if (/[\r\n]/.test(opts.target))
      throw new ToolError("smtp_client: 'target' must not contain CR or LF.", -32602);
    vrfyTarget = opts.target;
  }

  const rejectUnauthorized = opts.reject_unauthorized === true;
  const vrfyMode = (opts.vrfy_mode ?? "vrfy").toUpperCase();
  if (!["VRFY", "EXPN"].includes(vrfyMode))
    throw new ToolError("smtp_client: 'vrfy_mode' must be 'vrfy' or 'expn'.", -32602);

  return {
    operation, host: opts.host, port, secure, starttls, helo,
    timeout, connectTimeout, auth,
    from, to, cc, bcc, subject, bodyText, bodyHtml, extraHeaders,
    vrfyTarget, vrfyMode, rejectUnauthorized,
  };
}

// ── Low-level SMTP session ────────────────────────────────────────────────────
// We use a Promise-based line-by-line reader over a raw socket.
// SMTP responses are multi-line: "250-..." continues, "250 ..." is final.

class SmtpSession {
  constructor(socket, opts) {
    this._socket = socket;
    this._recvBuf = Buffer.alloc(0);
    this._totalRecv = 0;
    this._transcript = [];  // [{dir, line}]
    this._pendingResolve = null;
    this._pendingReject  = null;
    this._pendingLines   = [];  // accumulated multi-line response
    this._settled        = false;
    this._opts           = opts;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (e) => this._onError(e));
    socket.on("close", () => this._onClose());
  }

  _onData(chunk) {
    this._totalRecv += chunk.length;
    if (this._totalRecv > MAX_RESPONSE_BYTES) {
      this._onError(new Error("smtp_client: response budget exceeded (512 KB)."));
      return;
    }
    this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
    this._drain();
  }

  _drain() {
    while (true) {
      const idx = this._recvBuf.indexOf("\n");
      if (idx === -1) break;
      const rawLine = this._recvBuf.slice(0, idx + 1).toString("utf8").replace(/\r?\n$/, "");
      this._recvBuf = this._recvBuf.slice(idx + 1);

      // Safety: cap line length
      const line = rawLine.length > MAX_RESPONSE_LINE_BYTES
        ? rawLine.slice(0, MAX_RESPONSE_LINE_BYTES) + "...[truncated]"
        : rawLine;

      this._transcript.push({ dir: "<", line });
      this._pendingLines.push(line);

      // Parse: "XYZ-..." = continues, "XYZ " or "XYZ" = final
      if (line.length >= 3) {
        const code = line.slice(0, 3);
        const sep  = line.length > 3 ? line[3] : " ";
        if (sep !== "-") {
          // Final line of response
          if (this._pendingResolve) {
            const lines = this._pendingLines.slice();
            this._pendingLines = [];
            const r = this._pendingResolve;
            this._pendingResolve = null;
            this._pendingReject  = null;
            r({ code: parseInt(code, 10), lines });
          }
        }
      }
    }
  }

  _onError(e) {
    if (this._pendingReject) {
      const rej = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject  = null;
      this._pendingLines   = [];
      rej(e);
    }
  }

  _onClose() {
    if (this._pendingReject) {
      const rej = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject  = null;
      this._pendingLines   = [];
      rej(new Error("smtp_client: connection closed unexpectedly."));
    }
  }

  // Wait for the next complete SMTP response (resolves to {code, lines})
  readResponse(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        this._pendingResolve = null;
        this._pendingReject  = null;
        resolve(val);
      };
      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        this._pendingResolve = null;
        this._pendingReject  = null;
        this._pendingLines   = [];
        reject(e);
      };

      this._pendingResolve = finish;
      this._pendingReject  = fail;

      const t = setTimeout(() => {
        fail(new Error(`smtp_client: timeout waiting for server response (${timeoutMs}ms).`));
      }, timeoutMs);

      // First: drain any raw bytes not yet line-split
      this._drain();

      // Second: if _pendingLines already contains a complete response (final line
      // arrived before readResponse was called — no _pendingResolve was set at
      // that point so _drain() stored lines but couldn't resolve), handle it now.
      if (!settled && this._pendingLines.length > 0) {
        // Check whether the last buffered line is a final line (no '-' separator)
        const lastLine = this._pendingLines[this._pendingLines.length - 1];
        if (lastLine.length >= 3) {
          const sep = lastLine.length > 3 ? lastLine[3] : " ";
          if (sep !== "-") {
            // We have a complete response already buffered — resolve immediately
            const code = parseInt(lastLine.slice(0, 3), 10);
            const lines = this._pendingLines.slice();
            this._pendingLines = [];
            finish({ code, lines });
          }
        }
      }
    });
  }

  // Send a line (appending CRLF)
  send(line) {
    // Redact AUTH responses in transcript
    this._transcript.push({ dir: ">", line });
    return new Promise((resolve, reject) => {
      this._socket.write(line + CRLF, (err) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  // Replace the underlying socket (for STARTTLS upgrade)
  upgradeSocket(newSocket) {
    this._socket.removeAllListeners("data");
    this._socket.removeAllListeners("error");
    this._socket.removeAllListeners("close");
    this._socket = newSocket;
    this._socket.on("data", (chunk) => this._onData(chunk));
    this._socket.on("error", (e) => this._onError(e));
    this._socket.on("close", () => this._onClose());
  }

  get transcript() { return this._transcript; }
}

// ── Build RFC 5321-compliant email body ────────────────────────────────────────
function buildMessage(opts) {
  const { from, to, cc, subject, bodyText, bodyHtml, extraHeaders } = opts;
  const date = new Date().toUTCString();
  const allTo = to.join(", ");

  // Boundary for multipart/alternative
  const boundary = `boundary_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  const lines = [];
  lines.push(`Date: ${date}`);
  lines.push(`From: ${from}`);
  lines.push(`To: ${allTo}`);
  if (cc && cc.length) lines.push(`Cc: ${cc.join(", ")}`);
  lines.push(`Subject: ${subject ?? "(no subject)"}`);
  lines.push(`MIME-Version: 1.0`);

  for (const [k, v] of Object.entries(extraHeaders || {})) {
    lines.push(`${k}: ${v}`);
  }

  if (bodyText != null && bodyHtml != null) {
    // multipart/alternative
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push("");
    lines.push(qpEncode(bodyText));
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/html; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push("");
    lines.push(qpEncode(bodyHtml));
    lines.push(`--${boundary}--`);
  } else if (bodyHtml != null) {
    lines.push(`Content-Type: text/html; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push("");
    lines.push(qpEncode(bodyHtml));
  } else {
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push("");
    lines.push(qpEncode(bodyText));
  }

  return lines.join(CRLF);
}

// ── Minimal Quoted-Printable encoder (RFC 2045) ────────────────────────────────
// Only encodes bytes that require it. Lines ≤ 76 chars.
function qpEncode(text) {
  const MAX_LINE = 76;
  const buf = Buffer.from(text, "utf8");
  const output = [];
  let line = "";

  function flush(soft) {
    if (soft) {
      output.push(line + "=");
    } else {
      output.push(line);
    }
    line = "";
  }

  function append(s) {
    if (line.length + s.length > MAX_LINE) flush(true);
    line += s;
  }

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0D && buf[i + 1] === 0x0A) {
      // CRLF → keep as line break
      output.push(line);
      line = "";
      i++; // skip LF
    } else if (b === 0x0A) {
      // bare LF
      output.push(line);
      line = "";
    } else if (b === 0x09 || b === 0x20) {
      append(String.fromCharCode(b));
    } else if (b >= 0x21 && b <= 0x7E && b !== 0x3D) {
      append(String.fromCharCode(b));
    } else {
      append("=" + b.toString(16).toUpperCase().padStart(2, "0"));
    }
  }
  // trailing whitespace on last line must be encoded
  if (line.endsWith(" ") || line.endsWith("\t")) {
    const last = line.slice(-1);
    line = line.slice(0, -1);
    line += "=" + last.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  }
  output.push(line);
  return output.join(CRLF);
}

// ── Dot-stuffing for DATA ────────────────────────────────────────────────────
function dotStuff(messageText) {
  // RFC 5321 §4.5.2: any line starting with "." gets an extra "." prepended
  return messageText
    .split(CRLF)
    .map(l => (l.startsWith(".") ? "." + l : l))
    .join(CRLF);
}

// ── Open socket (plain or TLS) ─────────────────────────────────────────────────
function openSocket(host, port, secure, rejectUnauthorized, connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      clearTimeout(timer);
      resolve(sock);
    };
    const onError = (e) => {
      clearTimeout(timer);
      reject(e);
    };

    let sock;
    if (secure) {
      sock = tls.connect({ host, port, servername: host, rejectUnauthorized });
      sock.once("secureConnect", onConnect);
    } else {
      sock = net.createConnection({ host, port });
      sock.once("connect", onConnect);
    }
    sock.once("error", onError);

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`smtp_client: connection to ${host}:${port} timed out after ${connectTimeoutMs}ms.`));
    }, connectTimeoutMs);
  });
}

// ── Parse EHLO capabilities ─────────────────────────────────────────────────────
function parseCapabilities(ehloLines) {
  // Lines: first is greeting, rest are extensions like "250-SIZE 10240000"
  const caps = {};
  for (let i = 1; i < ehloLines.length; i++) {
    const txt = ehloLines[i].slice(4).trim(); // strip "250-" or "250 "
    const spaceIdx = txt.indexOf(" ");
    const key   = spaceIdx === -1 ? txt.toUpperCase() : txt.slice(0, spaceIdx).toUpperCase();
    const value = spaceIdx === -1 ? true : txt.slice(spaceIdx + 1);
    caps[key] = value;
  }
  return caps;
}

// ── AUTH PLAIN ─────────────────────────────────────────────────────────────────
// credential: \0username\0password, base64-encoded
function authPlain(user, pass) {
  return Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function smtpClient(rawOpts = {}) {
  let opts;
  try {
    opts = validateInputs(rawOpts);
  } catch (e) {
    throw e;
  }

  const {
    operation, host, port, secure, starttls, helo,
    timeout, connectTimeout, auth,
    from, to, cc, bcc, subject, bodyText, bodyHtml, extraHeaders,
    vrfyTarget, vrfyMode, rejectUnauthorized,
  } = opts;

  const startMs = Date.now();
  const timeoutMs = timeout * 1000;
  const responseTimeout = Math.min(timeoutMs, 15000); // per-command response timeout

  // Total deadline
  let timedOut = false;
  const totalTimer = setTimeout(() => { timedOut = true; }, timeoutMs);
  const checkTimeout = () => {
    if (timedOut) throw new ToolError(`smtp_client: total timeout of ${timeout}s exceeded.`, -32000);
  };

  let sock;
  let sess;
  const result = {
    host, port, secure, operation,
    connected: false,
    starttlsUpgraded: false,
    authenticated: false,
    banner: null,
    capabilities: {},
    transcript: [],
    elapsedMs: 0,
  };

  try {
    // ── 1. Connect ────────────────────────────────────────────────────────────
    sock = await openSocket(host, port, secure, rejectUnauthorized, connectTimeout * 1000);
    result.connected = true;
    sess  = new SmtpSession(sock, opts);

    // ── 2. Read banner (220) ──────────────────────────────────────────────────
    checkTimeout();
    const banner = await sess.readResponse(responseTimeout);
    if (banner.code !== 220)
      throw new Error(`smtp_client: unexpected banner code ${banner.code}: ${banner.lines[0]}`);
    result.banner = banner.lines[0];

    // ── 3. EHLO ───────────────────────────────────────────────────────────────
    checkTimeout();
    await sess.send(`EHLO ${helo}`);
    const ehloResp = await sess.readResponse(responseTimeout);
    if (ehloResp.code !== 250) {
      // Fall back to HELO
      await sess.send(`HELO ${helo}`);
      const heloResp = await sess.readResponse(responseTimeout);
      if (heloResp.code !== 250)
        throw new Error(`smtp_client: HELO rejected: ${heloResp.lines[0]}`);
    } else {
      result.capabilities = parseCapabilities(ehloResp.lines);
    }

    // ── 4. STARTTLS upgrade (if applicable) ───────────────────────────────────
    if (starttls && result.capabilities["STARTTLS"]) {
      checkTimeout();
      await sess.send("STARTTLS");
      const stResp = await sess.readResponse(responseTimeout);
      if (stResp.code !== 220)
        throw new Error(`smtp_client: STARTTLS rejected: ${stResp.lines[0]}`);

      // Upgrade plain socket to TLS
      const tlsSock = tls.connect({
        socket: sock,
        servername: host,
        rejectUnauthorized,
      });
      await new Promise((resolve, reject) => {
        tlsSock.once("secureConnect", resolve);
        tlsSock.once("error", reject);
      });
      sess.upgradeSocket(tlsSock);
      sock = tlsSock;
      result.starttlsUpgraded = true;

      // Re-EHLO after TLS
      checkTimeout();
      await sess.send(`EHLO ${helo}`);
      const ehlo2 = await sess.readResponse(responseTimeout);
      if (ehlo2.code === 250)
        result.capabilities = parseCapabilities(ehlo2.lines);
    }

    // ── 5. AUTH ───────────────────────────────────────────────────────────────
    if (auth) {
      checkTimeout();
      if (auth.method === "PLAIN") {
        const cred = authPlain(auth.user, auth.password);
        await sess.send(`AUTH PLAIN ${cred}`);
        const authResp = await sess.readResponse(responseTimeout);
        if (authResp.code !== 235)
          throw new Error(`smtp_client: AUTH PLAIN failed (${authResp.code}): ${authResp.lines[0]}`);
      } else if (auth.method === "LOGIN") {
        await sess.send("AUTH LOGIN");
        const r1 = await sess.readResponse(responseTimeout);
        if (r1.code !== 334)
          throw new Error(`smtp_client: AUTH LOGIN challenge failed (${r1.code}): ${r1.lines[0]}`);
        // Server sends base64("Username:") — we respond with base64(user)
        await sess.send(Buffer.from(auth.user, "utf8").toString("base64"));
        const r2 = await sess.readResponse(responseTimeout);
        if (r2.code !== 334)
          throw new Error(`smtp_client: AUTH LOGIN username rejected (${r2.code}): ${r2.lines[0]}`);
        await sess.send(Buffer.from(auth.password, "utf8").toString("base64"));
        const r3 = await sess.readResponse(responseTimeout);
        if (r3.code !== 235)
          throw new Error(`smtp_client: AUTH LOGIN password rejected (${r3.code}): ${r3.lines[0]}`);
      }
      result.authenticated = true;
    }

    // ── 6. Operation-specific logic ───────────────────────────────────────────
    if (operation === "probe") {
      // We have banner + capabilities already — done.
      result.success = true;

    } else if (operation === "noop") {
      checkTimeout();
      await sess.send("NOOP");
      const noopResp = await sess.readResponse(responseTimeout);
      result.success = noopResp.code === 250;
      result.noopResponse = noopResp.lines[0];

    } else if (operation === "verify") {
      checkTimeout();
      await sess.send(`${vrfyMode} ${vrfyTarget}`);
      const vrfyResp = await sess.readResponse(responseTimeout);
      result.vrfyCode    = vrfyResp.code;
      result.vrfyLines   = vrfyResp.lines.map(l => l.slice(4).trim());
      result.success     = vrfyResp.code >= 200 && vrfyResp.code < 300;
      result.vrfyMode    = vrfyMode;
      result.target      = vrfyTarget;

    } else if (operation === "send") {
      checkTimeout();
      // MAIL FROM
      await sess.send(`MAIL FROM:<${from}>`);
      const mfResp = await sess.readResponse(responseTimeout);
      if (mfResp.code !== 250)
        throw new Error(`smtp_client: MAIL FROM rejected (${mfResp.code}): ${mfResp.lines[0]}`);

      // RCPT TO — collect individual statuses
      const rcptResults = [];
      const allRcpt = [...to, ...(cc || []), ...(bcc || [])];
      for (const rcpt of allRcpt) {
        checkTimeout();
        await sess.send(`RCPT TO:<${rcpt}>`);
        const rr = await sess.readResponse(responseTimeout);
        rcptResults.push({ address: rcpt, code: rr.code, message: rr.lines[0] });
      }
      const accepted = rcptResults.filter(r => r.code >= 200 && r.code < 300);
      if (accepted.length === 0)
        throw new Error(`smtp_client: all RCPT TO recipients were rejected.`);

      // DATA
      checkTimeout();
      await sess.send("DATA");
      const dataResp = await sess.readResponse(responseTimeout);
      if (dataResp.code !== 354)
        throw new Error(`smtp_client: DATA rejected (${dataResp.code}): ${dataResp.lines[0]}`);

      // Build + dot-stuff message body
      const rawMsg = buildMessage({ from, to, cc, subject, bodyText, bodyHtml, extraHeaders });
      const stuffed = dotStuff(rawMsg);

      if (Buffer.byteLength(stuffed, "utf8") > MAX_BODY_BYTES)
        throw new ToolError(
          `smtp_client: message body exceeds ${MAX_BODY_BYTES} byte limit.`, -32602);

      // Send the body terminated by CRLF.CRLF
      await new Promise((resolve, reject) => {
        sock.write(stuffed + CRLF + "." + CRLF, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      sess.transcript.push({ dir: ">", line: "<message body + CRLF.CRLF>" });

      const endResp = await sess.readResponse(responseTimeout);
      if (endResp.code !== 250)
        throw new Error(
          `smtp_client: message rejected by server (${endResp.code}): ${endResp.lines[0]}`);

      result.messageId = endResp.lines[0].match(/id=([\w.@<>]+)/i)?.[1] ?? null;
      result.rcptResults = rcptResults;
      result.rcptAccepted = accepted.length;
      result.rcptRejected = rcptResults.length - accepted.length;
      result.success = true;
    }

    // ── 7. QUIT ───────────────────────────────────────────────────────────────
    try {
      checkTimeout();
      await sess.send("QUIT");
      await sess.readResponse(responseTimeout);
    } catch (_) { /* ignore quit errors */ }

  } catch (e) {
    result.success = false;
    result.error = e.message;
  } finally {
    clearTimeout(totalTimer);
    try { sock && sock.destroy(); } catch (_) {}
    result.elapsedMs = Date.now() - startMs;
    // Attach redacted transcript (mask AUTH credentials lines)
    result.transcript = (sess?.transcript ?? []).map(entry => {
      const l = entry.line;
      if (/^AUTH\s+PLAIN\s+/i.test(l))
        return { ...entry, line: "AUTH PLAIN [credential redacted]" };
      if (/^[A-Za-z0-9+/=]{20,}$/.test(l))
        return { ...entry, line: "[base64 credential redacted]" };
      return entry;
    });
  }

  return result;
}

module.exports = { smtpClient };
