"use strict";
// ── EMAIL (SMTP) SEND OPS — zero-dependency raw TLS SMTP client ────────────
// Mirrors emailOps.js (IMAP): same trust tier (network only, no fs/exec),
// same .env fallback pattern (EMAIL_USERNAME/EMAIL_APP_PASSWORD/EMAIL_HOST/
// EMAIL_PORT for IMAP; SMTP_HOST/SMTP_PORT here, username/password shared
// with EMAIL_USERNAME/EMAIL_APP_PASSWORD since most providers use the same
// account for IMAP+SMTP). Explicit args always win over env.

const tls = require("tls");
const { ToolError } = require("./errors");

const DEFAULT_SMTP_PORT = 465; // implicit TLS (no STARTTLS support — matches zero-dep scope)
const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 20000;
const CTRL_CHARS = /[\r\n\x00]/;
const EMAIL_RE = /^[^\s@<>\r\n\x00]+@[^\s@<>\r\n\x00]+\.[^\s@<>\r\n\x00]+$/;

function validateSendParams(args) {
  if (!args || typeof args !== "object") throw new ToolError("email_send: arguments must be an object.", -32602);
  const username = args.username || process.env.EMAIL_USERNAME || "";
  const password = args.password || process.env.EMAIL_APP_PASSWORD || "";
  if (!username) throw new ToolError("email_send: 'username' is required — pass it explicitly or set EMAIL_USERNAME in .env.", -32602);
  if (!password) throw new ToolError("email_send: 'password' is required — pass it explicitly or set EMAIL_APP_PASSWORD in .env.", -32602);
  if (CTRL_CHARS.test(String(username)) || CTRL_CHARS.test(String(password))) {
    throw new ToolError("email_send: credentials must not contain control characters.", -32602);
  }
  const host = args.host || process.env.SMTP_HOST || process.env.EMAIL_HOST || "smtp.gmail.com";
  const port = args.port || (process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : DEFAULT_SMTP_PORT);
  if (typeof port !== "number" || Number.isNaN(port) || port < 1 || port > 65535) {
    throw new ToolError("email_send: 'port' must be a valid port number.", -32602);
  }

  const toList = normalizeAddrList(args.to, "to", true);
  const ccList = normalizeAddrList(args.cc, "cc", false);
  const bccList = normalizeAddrList(args.bcc, "bcc", false);

  const subject = args.subject != null ? String(args.subject) : "";
  if (CTRL_CHARS.test(subject)) throw new ToolError("email_send: 'subject' must not contain control characters.", -32602);

  const bodyText = args.body != null ? String(args.body) : "";
  const bodyHtml = args.body_html != null ? String(args.body_html) : null;
  if (!bodyText && !bodyHtml) throw new ToolError("email_send: either 'body' or 'body_html' is required.", -32602);

  return { username, password, host, port, to: toList, cc: ccList, bcc: bccList, subject, bodyText, bodyHtml };
}

function normalizeAddrList(val, field, required) {
  if (val == null || val === "") {
    if (required) throw new ToolError(`email_send: '${field}' is required.`, -32602);
    return [];
  }
  const arr = Array.isArray(val) ? val : String(val).split(",");
  const out = arr.map(s => String(s).trim()).filter(Boolean);
  if (required && out.length === 0) throw new ToolError(`email_send: '${field}' is required.`, -32602);
  for (const addr of out) {
    if (CTRL_CHARS.test(addr)) throw new ToolError(`email_send: '${field}' address must not contain control characters (possible header injection).`, -32602);
    if (!EMAIL_RE.test(addr)) throw new ToolError(`email_send: '${field}' contains an invalid email address: ${JSON.stringify(addr).slice(0, 80)}`, -32602);
  }
  return out;
}

// Encode a header value as an RFC 2047 base64 word if it contains non-ASCII;
// otherwise return as-is. Prevents raw UTF-8 bytes from corrupting headers.
function encodeHeaderValue(val) {
  if (/^[\x20-\x7e]*$/.test(val)) return val;
  return "=?UTF-8?B?" + Buffer.from(val, "utf8").toString("base64") + "?=";
}

function dotStuff(text) {
  // RFC 5321: lines beginning with '.' must be escaped to '..' inside DATA.
  return text.split(/\r\n|\n/).map(l => (l.startsWith(".") ? "." + l : l)).join("\r\n");
}

function buildMessage({ username, to, cc, subject, bodyText, bodyHtml }) {
  const boundary = "----mcp-boundary-" + Buffer.from(String(Date.now()) + Math.random()).toString("hex").slice(0, 20);
  const headers = [
    `From: ${encodeHeaderValue(username)}`,
    `To: ${to.join(", ")}`,
  ];
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`MIME-Version: 1.0`);

  let body;
  if (bodyHtml && bodyText) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body =
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${bodyText}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${bodyHtml}\r\n` +
      `--${boundary}--`;
  } else if (bodyHtml) {
    headers.push(`Content-Type: text/html; charset=UTF-8`);
    body = bodyHtml;
  } else {
    headers.push(`Content-Type: text/plain; charset=UTF-8`);
    body = bodyText;
  }
  return dotStuff(headers.join("\r\n") + "\r\n\r\n" + body);
}

// ── Minimal line-buffered SMTP reply reader ────────────────────────────────
class SmtpReader {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) { this.buf = Buffer.concat([this.buf, chunk]); }
  // Drains complete \r\n-terminated lines from the buffer.
  drain() {
    const out = [];
    let idx;
    while ((idx = this.buf.indexOf("\r\n")) !== -1) {
      out.push(this.buf.slice(0, idx).toString("latin1"));
      this.buf = this.buf.slice(idx + 2);
    }
    return out;
  }
}

function runSmtpSession(args, sessionFn) {
  const params = validateSendParams(args);
  const { host, port } = params;

  return new Promise((resolve, reject) => {
    let settled = false;
    const reader = new SmtpReader();
    let pending = null; // { resolve, reject, timer }
    let replyBuf = [];

    const socket = tls.connect({ host, port, servername: host, timeout: CONNECT_TIMEOUT_MS }, () => {});

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      reject(err instanceof ToolError ? err : new ToolError(`email_send: connection failed — ${err.message}`, -32603));
    };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("connection timed out")));
    socket.on("error", (e) => fail(e));
    socket.on("close", () => { if (!settled) fail(new Error("connection closed unexpectedly")); });

    function readReply() {
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending = null;
          rej(new ToolError("email_send: SMTP reply timed out.", -32603));
        }, COMMAND_TIMEOUT_MS);
        pending = { res, rej, timer };
      });
    }

    function checkLines() {
      const lines = reader.drain();
      for (const line of lines) {
        replyBuf.push(line);
        const m = /^(\d{3})([ -])/.exec(line);
        if (m && m[2] === " ") {
          const code = m[1];
          const full = replyBuf.join("\n");
          replyBuf = [];
          if (pending) {
            const { res, rej, timer } = pending;
            pending = null;
            clearTimeout(timer);
            if (code.startsWith("2") || code.startsWith("3")) res({ code, text: full });
            else rej(new ToolError(`email_send: SMTP error — ${full.trim()}`, -32603));
          }
        }
      }
    }

    socket.on("data", (chunk) => { reader.push(chunk); checkLines(); });

    async function send(cmd) {
      socket.write(cmd + "\r\n");
      return readReply();
    }

    socket.once("secureConnect", async () => {
      try {
        await readReply(); // greeting (220)
        await send(`EHLO mcp-common-server`);
        await send(`AUTH LOGIN`);
        await send(Buffer.from(params.username, "utf8").toString("base64"));
        await send(Buffer.from(params.password, "utf8").toString("base64"));
        const result = await sessionFn({ send, params });
        try { await send("QUIT"); } catch { /* best-effort */ }
        socket.end();
        finish(result);
      } catch (e) {
        fail(e);
      }
    });
  });
}

async function smtpSendEmail(args) {
  return runSmtpSession(args, async ({ send, params }) => {
    await send(`MAIL FROM:<${params.username}>`);
    const recipients = [...params.to, ...params.cc, ...params.bcc];
    for (const addr of recipients) {
      await send(`RCPT TO:<${addr}>`);
    }
    await send(`DATA`);
    const message = buildMessage(params);
    await send(message + "\r\n.");
    return {
      sent: true,
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
    };
  });
}

module.exports = { smtpSendEmail, validateSendParams, buildMessage, dotStuff, encodeHeaderValue, normalizeAddrList };
