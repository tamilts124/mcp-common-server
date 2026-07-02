"use strict";
// ── EMAIL (IMAP) OPS — zero-dependency raw IMAP client + MIME parser ───────────
// Ported from a user-supplied Python imaplib-based EmailReader. Pure JS,
// no npm imap/mailparser deps (matches project's zero-dep-for-core-tools
// philosophy — see lib/yamlOps.js, lib/archiveOps.js for prior art).
//
// Two tools consume this module: email_list_mailboxes, email_search.
// Both are always-available (not exec-gated) — same trust tier as
// http_fetch: outbound network only, using caller-supplied credentials,
// no local filesystem writes or shell exec.

const tls = require("tls");
const { ToolError } = require("./errors");

const DEFAULT_PORT = 993;
const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 20000;

// ── RFC 2047 encoded-word header decoding ──────────────────────────────────
function decodeQP(str) {
  return str.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function bytesToString(bytes, charset) {
  const cs = (charset || "utf-8").toLowerCase();
  try {
    if (cs === "utf-8" || cs === "utf8") return Buffer.from(bytes).toString("utf8");
    if (cs === "us-ascii" || cs === "ascii") return Buffer.from(bytes).toString("ascii");
    if (cs === "iso-8859-1" || cs === "latin1" || cs === "windows-1252") return Buffer.from(bytes).toString("latin1");
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return Buffer.from(bytes).toString("latin1");
  }
}

function decodeMimeWords(input) {
  if (!input) return "";
  const re = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  // Fold whitespace-only gaps between adjacent encoded-words per RFC 2047.
  const collapsed = input.replace(/\?=(\s+)=\?/g, "?==?");
  let out = "";
  let lastIndex = 0;
  let m;
  while ((m = re.exec(collapsed)) !== null) {
    out += collapsed.slice(lastIndex, m.index);
    const [, charset, enc, data] = m;
    try {
      if (enc.toLowerCase() === "b") {
        out += bytesToString(Buffer.from(data, "base64"), charset);
      } else {
        const bytes = [];
        const decodedQ = decodeQP(data);
        for (let i = 0; i < decodedQ.length; i++) bytes.push(decodedQ.charCodeAt(i));
        out += bytesToString(Buffer.from(bytes), charset);
      }
    } catch {
      out += data;
    }
    lastIndex = re.lastIndex;
  }
  out += collapsed.slice(lastIndex);
  return out;
}

// ── Quoted-printable body decoding ──────────────────────────────────────────
function decodeQuotedPrintableBody(text) {
  const soft = text.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// ── Header parsing (unfolds continuation lines) ─────────────────────────────
function parseHeaders(headerBlock) {
  const rawLines = headerBlock.split(/\r\n/);
  const lines = [];
  for (const line of rawLines) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += " " + line.trim();
    } else if (line.trim() !== "") {
      lines.push(line);
    }
  }
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (!(key in headers)) headers[key] = val;
  }
  return headers;
}

function getContentTypeParams(contentTypeHeader) {
  const parts = (contentTypeHeader || "text/plain").split(";");
  const type = parts[0].trim().toLowerCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const m = /^\s*([^=]+)=(.*)$/.exec(parts[i]);
    if (m) params[m[1].trim().toLowerCase()] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return { type, params };
}

function splitHeaderBody(buf) {
  const str = buf.toString("latin1");
  const idx = str.indexOf("\r\n\r\n");
  const idx2 = idx === -1 ? str.indexOf("\n\n") : idx;
  const sepLen = idx !== -1 ? 4 : 2;
  const cut = idx !== -1 ? idx : idx2;
  if (cut === -1) return { headerBlock: str, bodyBuf: Buffer.alloc(0) };
  return { headerBlock: str.slice(0, cut), bodyBuf: buf.slice(cut + sepLen) };
}

function decodeBodyPart(bodyBuf, headers) {
  const cte = (headers["content-transfer-encoding"] || "7bit").toLowerCase().trim();
  const { params } = getContentTypeParams(headers["content-type"]);
  const charset = params.charset || "utf-8";
  if (cte === "base64") {
    const clean = bodyBuf.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
    return bytesToString(Buffer.from(clean, "base64"), charset);
  }
  if (cte === "quoted-printable") {
    return decodeQuotedPrintableBody(bodyBuf.toString("latin1"));
  }
  return bytesToString(bodyBuf, charset);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// Recursively walks a MIME body looking for the best text/plain (or, failing
// that, text/html-stripped) part. Returns decoded text or null.
function findTextPart(headers, bodyBuf, depth) {
  if (depth > 8) return null;
  const { type, params } = getContentTypeParams(headers["content-type"]);

  if (type.startsWith("multipart/") && params.boundary) {
    const boundary = "--" + params.boundary;
    const bodyStr = bodyBuf.toString("latin1");
    const rawParts = bodyStr.split(boundary).slice(1, -1);
    let plain = null, html = null;
    for (const rawPart of rawParts) {
      const trimmed = rawPart.replace(/^\r?\n/, "");
      const partBuf = Buffer.from(trimmed, "latin1");
      const { headerBlock, bodyBuf: partBody } = splitHeaderBody(partBuf);
      const partHeaders = parseHeaders(headerBlock);
      const { type: partType } = getContentTypeParams(partHeaders["content-type"]);
      if (partType.startsWith("multipart/")) {
        const nested = findTextPart(partHeaders, partBody, depth + 1);
        if (nested && plain === null) plain = nested;
      } else if (partType === "text/plain" && plain === null) {
        plain = decodeBodyPart(partBody, partHeaders);
      } else if (partType === "text/html" && html === null) {
        html = decodeBodyPart(partBody, partHeaders);
      }
    }
    return plain !== null ? plain : (html !== null ? stripHtml(html) : null);
  }

  if (type === "text/html") return stripHtml(decodeBodyPart(bodyBuf, headers));
  return decodeBodyPart(bodyBuf, headers);
}

// Parses a raw RFC822 message buffer into { subject, sender, body, date }.
function parseRawMessage(rawBuf) {
  const { headerBlock, bodyBuf } = splitHeaderBody(rawBuf);
  const headers = parseHeaders(headerBlock);
  const subject = decodeMimeWords(headers["subject"] || "");
  const sender = decodeMimeWords(headers["from"] || "");
  let date = null;
  if (headers["date"]) {
    const d = new Date(headers["date"]);
    if (!isNaN(d.getTime())) date = d.toISOString();
  }
  let body = null;
  try {
    body = findTextPart(headers, bodyBuf, 0);
  } catch {
    body = null;
  }
  return { subject, sender, body, date };
}

// ── IMAP search-criteria builder (injection-safe) ───────────────────────────
function imapQuote(str) {
  if (/[\r\n\x00]/.test(str)) {
    throw new ToolError("email_search: field values must not contain control characters.", -32602);
  }
  return '"' + String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function toImapDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new ToolError("email_search: 'date' must be in YYYY-MM-DD format.", -32602);
  }
  const [y, mo, d] = isoDate.split("-").map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new ToolError("email_search: 'date' is not a valid calendar date.", -32602);
  }
  return `${String(d).padStart(2, "0")}-${MONTHS[mo - 1]}-${y}`;
}

function buildSearchCriteria({ subject_keyword, sender, date }) {
  const parts = [];
  if (subject_keyword) parts.push("SUBJECT " + imapQuote(subject_keyword));
  if (sender) parts.push("FROM " + imapQuote(sender));
  if (date) parts.push("ON " + toImapDate(date));
  return parts.length ? parts.join(" ") : "ALL";
}

// ── Low-level line/literal-aware IMAP response reader ───────────────────────
class ImapReader {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.pendingLiteral = 0;
    this.parts = [];
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
  }
  // Yields complete logical response lines as Buffers (embedded CRLFs from
  // literals are preserved inside the buffer's content, delimiter CRLFs are
  // stripped).
  drain() {
    const out = [];
    for (;;) {
      if (this.pendingLiteral > 0) {
        if (this.buf.length < this.pendingLiteral) break;
        this.parts.push(this.buf.slice(0, this.pendingLiteral));
        this.buf = this.buf.slice(this.pendingLiteral);
        this.pendingLiteral = 0;
        continue;
      }
      const idx = this.buf.indexOf("\r\n");
      if (idx === -1) break;
      const segment = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.parts.push(segment);
      const tail = segment.toString("latin1");
      const m = /\{(\d+)\}\s*$/.exec(tail);
      if (m) {
        this.pendingLiteral = parseInt(m[1], 10);
        continue;
      }
      out.push(Buffer.concat(this.parts));
      this.parts = [];
    }
    return out;
  }
}

// ── IMAP session runner ──────────────────────────────────────────────────────
function validateConnParams(args) {
  if (!args || typeof args !== "object") throw new ToolError("email: arguments must be an object.", -32602);
  if (!args.username) throw new ToolError("email: 'username' is required.", -32602);
  if (!args.password) throw new ToolError("email: 'password' is required.", -32602);
  const host = args.host || "imap.gmail.com";
  const port = args.port || DEFAULT_PORT;
  if (typeof port !== "number" || port < 1 || port > 65535) {
    throw new ToolError("email: 'port' must be a valid port number.", -32602);
  }
  if (/[\r\n\x00]/.test(String(args.username)) || /[\r\n\x00]/.test(String(args.password))) {
    throw new ToolError("email: credentials must not contain control characters.", -32602);
  }
  return { host, port };
}

// Runs `sessionFn(ctx)` against a fresh authenticated IMAP connection, then
// always logs out and closes the socket. `ctx.command(cmd)` sends a tagged
// command and resolves with { ok, statusLine, untagged: Buffer[] }.
function runImapSession(args, sessionFn) {
  const { host, port } = validateConnParams(args);
  const { username, password } = args;

  return new Promise((resolve, reject) => {
    let settled = false;
    let tagCounter = 0;
    const reader = new ImapReader();
    let waiters = [];

    const socket = tls.connect({ host, port, servername: host, timeout: CONNECT_TIMEOUT_MS }, () => {});

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      reject(err instanceof ToolError ? err : new ToolError(`email: connection failed — ${err.message}`, -32603));
    };

    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("connection timed out")));
    socket.on("error", (e) => fail(e));
    socket.on("close", () => {
      if (!settled) fail(new Error("connection closed unexpectedly"));
    });

    socket.once("secureConnect", async () => {
      try {
        // Wait for the untagged greeting line before issuing commands.
        await waitForLine(() => true);

        const command = (cmd) => {
          const tag = "A" + (++tagCounter);
          socket.write(`${tag} ${cmd}\r\n`);
          return new Promise((res, rej) => {
            const untagged = [];
            const timer = setTimeout(() => {
              removeWaiter();
              rej(new ToolError(`email: command timed out (${cmd.split(" ")[0]}).`, -32603));
            }, COMMAND_TIMEOUT_MS);
            const waiter = (line) => {
              const text = line.toString("latin1");
              if (text.startsWith(tag + " ")) {
                clearTimeout(timer);
                removeWaiter();
                const ok = /^\S+\s+OK/i.test(text);
                if (ok) res({ ok: true, statusLine: text, untagged });
                else rej(new ToolError(`email: IMAP command failed — ${text.trim()}`, -32603));
                return true;
              }
              untagged.push(line);
              return false;
            };
            const removeWaiter = () => { waiters = waiters.filter(w => w !== waiter); };
            waiters.push(waiter);
          });
        };

        function waitForLine(predicate) {
          return new Promise((res) => {
            const check = () => {
              const lines = reader.drain();
              for (const line of lines) {
                if (predicate(line)) { res(line); return true; }
                for (const w of [...waiters]) w(line);
              }
              return false;
            };
            if (check()) return;
            const onData = (chunk) => {
              reader.push(chunk);
              if (check()) socket.removeListener("data", onData);
            };
            socket.on("data", onData);
          });
        }

        socket.on("data", (chunk) => {
          reader.push(chunk);
          const lines = reader.drain();
          for (const line of lines) {
            for (const w of [...waiters]) w(line);
          }
        });

        await command(`LOGIN ${imapQuote(username)} ${imapQuote(password)}`);
        const result = await sessionFn({ command });
        try { await command("LOGOUT"); } catch { /* best-effort */ }
        socket.end();
        finish(result);
      } catch (e) {
        fail(e);
      }
    });
  });
}

function parseListLine(line) {
  const text = line.toString("latin1");
  // * LIST (\HasNoChildren) "/" "INBOX"
  const m = /^\*\s+LIST\s+\([^)]*\)\s+"?[^"]*"?\s+"?([^"\r\n]+)"?\s*$/i.exec(text);
  return m ? m[1] : null;
}

async function imapListMailboxes(args) {
  return runImapSession(args, async ({ command }) => {
    const { untagged } = await command('LIST "" "*"');
    const mailboxes = untagged.map(parseListLine).filter(Boolean);
    return { mailboxes, count: mailboxes.length };
  });
}

function parseSearchIds(untagged) {
  for (const line of untagged) {
    const text = line.toString("latin1");
    const m = /^\*\s+SEARCH\s*(.*)$/i.exec(text);
    if (m) return m[1].trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function extractFetchLiteral(line) {
  // The reader collapses "* N FETCH (... {123}\r\n<literal>\r\n)\r\n" into a
  // single buffer with the literal inline. Find it via the {N} marker.
  const text = line.toString("latin1");
  const m = /\{(\d+)\}/.exec(text);
  if (!m) return null;
  const declaredLen = parseInt(m[1], 10);
  const markerEnd = m.index + m[0].length;
  const literal = line.slice(markerEnd, markerEnd + declaredLen);
  return literal;
}

async function imapSearchEmails(args) {
  const mailbox = args.mailbox || "INBOX";
  const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
  if (/[\r\n\x00"]/.test(mailbox)) {
    throw new ToolError("email_search: 'mailbox' must not contain control characters or quotes.", -32602);
  }
  const criteria = buildSearchCriteria({
    subject_keyword: args.subject_keyword,
    sender: args.sender,
    date: args.date,
  });

  return runImapSession(args, async ({ command }) => {
    await command(`SELECT "${mailbox}"`);
    const { untagged: searchUntagged } = await command(`UID SEARCH ${criteria}`);
    let ids = parseSearchIds(searchUntagged);
    if (ids.length === 0) return { mailbox, count: 0, emails: [] };

    ids = ids.slice(-limit).reverse(); // newest first
    const emails = [];
    for (const uid of ids) {
      const { untagged } = await command(`UID FETCH ${uid} (BODY.PEEK[])`);
      const fetchLine = untagged.find(l => /FETCH/i.test(l.toString("latin1")));
      if (!fetchLine) continue;
      const literal = extractFetchLiteral(fetchLine);
      if (!literal) continue;
      emails.push(parseRawMessage(literal));
    }
    return { mailbox, count: emails.length, emails };
  });
}

module.exports = {
  decodeMimeWords,
  decodeQuotedPrintableBody,
  parseHeaders,
  parseRawMessage,
  buildSearchCriteria,
  toImapDate,
  imapQuote,
  imapListMailboxes,
  imapSearchEmails,
  ImapReader,
};
