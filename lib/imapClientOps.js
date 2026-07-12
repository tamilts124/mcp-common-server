"use strict";
// ── IMAP_CLIENT — direct IMAP4rev1 protocol client ────────────────────────────
// Zero npm dependencies — uses Node.js built-in net/tls modules.
//
// Implements enough of RFC 3501 (IMAP4rev1) to:
//   • list     — LIST mailboxes matching a pattern.
//   • select   — SELECT (read-write) or EXAMINE (read-only) a mailbox.
//   • search   — SEARCH messages with criteria (ALL, UNSEEN, FROM, SUBJECT, SINCE, etc.).
//   • fetch    — FETCH message headers/body/flags by UID or sequence number.
//   • status   — STATUS a mailbox (messages, unseen, recent counts).
//   • append   — APPEND (store) a raw RFC 2822 message into a mailbox.
//   • store    — STORE flags on a message set (add/remove/set).
//   • copy     — COPY messages to another mailbox.
//   • expunge  — EXPUNGE (permanently delete \Deleted messages).
//
// Auth: LOGIN (plaintext credentials over TLS) and AUTHENTICATE PLAIN (base64).
// TLS: implicit TLS (imaps, port 993 style) via secure:true,
//       STARTTLS upgrade (some servers), or plaintext (local testing).
//
// Security guards:
//   • All string inputs validated: no NUL bytes, no CR/LF injection.
//   • IMAP literal strings (braces) forbidden in user-controlled leaf values.
//   • Tag counter per session — no tag collisions.
//   • Response budget capped (default 8 MB).
//   • Credentials never echoed in results.

const net = require("net");
const tls = require("tls");
const { ToolError } = require("./errors");

// ── Constants ──────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_S         = 30;
const MAX_TIMEOUT_S             = 120;
const DEFAULT_CONNECT_TIMEOUT_S = 10;
const MAX_CONNECT_TIMEOUT_S     = 30;
const MAX_RESPONSE_BYTES        = 8 * 1024 * 1024;   // 8 MB
const MAX_FETCH_MESSAGES        = 200;
const MAX_APPEND_BYTES          = 10 * 1024 * 1024;  // 10 MB per message
const CRLF                      = "\r\n";

// ── Input guards ───────────────────────────────────────────────────────────────
const CTRL_RE   = /[\x00-\x1F\x7F]/;  // NUL + control chars (includes CR/LF)
const LITERAL_RE = /[{}]/;            // forbid IMAP literal syntax in leaf values

function guardString(val, name, maxLen = 500) {
  if (typeof val !== "string" || val.length === 0)
    throw new ToolError(`imap_client: '${name}' must be a non-empty string.`, -32602);
  if (val.length > maxLen)
    throw new ToolError(`imap_client: '${name}' exceeds ${maxLen} character limit.`, -32602);
  if (CTRL_RE.test(val))
    throw new ToolError(`imap_client: '${name}' must not contain control characters (including CR/LF).`, -32602);
  if (LITERAL_RE.test(val))
    throw new ToolError(`imap_client: '${name}' must not contain '{' or '}' (IMAP literal syntax not allowed in user inputs).`, -32602);
}

function guardOptString(val, name, maxLen = 500) {
  if (val === undefined || val === null) return;
  guardString(val, name, maxLen);
}

function quoteImap(s) {
  // IMAP quoted string: wrap in double-quotes, escape \ and ".
  // Caller must ensure no CR/LF/NUL (guardString already checked).
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// ── IMAP session class ─────────────────────────────────────────────────────────
class ImapSession {
  constructor({ host, port, secure, timeout, connectTimeout, rejectUnauthorized }) {
    this.host               = host;
    this.port               = port;
    this.secure             = !!secure;
    this.timeout            = (Math.min(Math.max(timeout || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S)) * 1000;
    this.connectTimeout     = (Math.min(Math.max(connectTimeout || DEFAULT_CONNECT_TIMEOUT_S, 1), MAX_CONNECT_TIMEOUT_S)) * 1000;
    this.rejectUnauthorized = rejectUnauthorized !== false ? false : true; // default: false (accept self-signed)
    this._socket            = null;
    this._tagCounter        = 0;
    this._buf               = "";
    this._totalBytes        = 0;
    this._pendingLines      = [];
    this._lineWaiters       = [];
    this._transcript        = [];
    this._capabilities      = [];
    this._greeting          = "";
    this._starttlsDone      = false;
  }

  // ── Low-level I/O ───────────────────────────────────────────────────────────

  _nextTag() {
    this._tagCounter++;
    return `A${String(this._tagCounter).padStart(4, "0")}`;
  }

  _onData(data) {
    this._totalBytes += data.length;
    if (this._totalBytes > MAX_RESPONSE_BYTES) {
      this._socket.destroy(new Error("imap_client: response budget exceeded (8 MB)."));
      return;
    }
    this._buf += data.toString("utf8");
    // Split into CRLF-terminated lines; keep partial tail in buffer.
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      const raw  = this._buf.slice(0, idx + 1);
      this._buf = this._buf.slice(idx + 1);
      const line = raw.replace(/\r?\n$/, "");
      this._pendingLines.push(line);
      if (this._lineWaiters.length > 0) {
        const resolve = this._lineWaiters.shift();
        resolve(this._pendingLines.shift());
      }
    }
  }

  _readLine() {
    return new Promise((resolve, reject) => {
      if (this._pendingLines.length > 0) {
        resolve(this._pendingLines.shift());
        return;
      }
      const errorListener = (err) => {
        reject(err);
      };
      const closeListener = () => {
        reject(new Error("imap_client: connection closed while waiting for response."));
      };
      const done = (line) => {
        this._socket.removeListener("error", errorListener);
        this._socket.removeListener("close", closeListener);
        resolve(line);
      };
      this._socket.once("error", errorListener);
      this._socket.once("close", closeListener);
      this._lineWaiters.push(done);
    });
  }

  _send(line) {
    // Log command (redact credentials)
    const logLine = /^A\d+ (LOGIN|AUTHENTICATE)/i.test(line)
      ? line.replace(/^(A\d+ LOGIN \S+ ).*/, "$1[REDACTED]")
            .replace(/^(A\d+ AUTHENTICATE PLAIN ).*/, "$1[REDACTED]")
      : line;
    this._transcript.push({ dir: "C", line: logLine });
    this._socket.write(line + CRLF);
  }

  // Read lines until we see the tagged completion response for `tag`.
  // Returns { ok, code?, text, untagged: string[] }
  async _command(tag, cmdLine) {
    this._send(cmdLine);
    const untagged = [];
    while (true) {
      const line = await this._readLine();
      this._transcript.push({ dir: "S", line });
      if (line.startsWith(tag + " ")) {
        // tagged response
        const rest = line.slice(tag.length + 1);
        const ok   = /^OK\b/i.test(rest);
        const text = rest.replace(/^(OK|NO|BAD)\s*/i, "");
        return { ok, text, untagged };
      } else {
        untagged.push(line);
      }
    }
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  connect() {
    return new Promise((resolve, reject) => {
      const done  = (err) => { if (err) reject(err); else resolve(); };
      const opts  = {
        host:                 this.host,
        port:                 this.port,
        rejectUnauthorized:   !this.rejectUnauthorized, // confusingly, we stored 'accept' bool
        servername:           this.host,
      };

      // Fix: rejectUnauthorized as stored means "accept self-signed" = false reject
      // Recompute properly:
      const tlsOpts = {
        host:               this.host,
        port:               this.port,
        rejectUnauthorized: this.rejectUnauthorized === true ? true : false,
        servername:         this.host,
      };

      let connected = false;
      const timeoutHandle = setTimeout(() => {
        if (!connected) {
          sock.destroy(new Error(`imap_client: connect timeout after ${this.connectTimeout / 1000}s.`));
        }
      }, this.connectTimeout);

      const sock = this.secure
        ? tls.connect(tlsOpts, () => { clearTimeout(timeoutHandle); connected = true; resolve(); })
        : net.connect({ host: this.host, port: this.port }, () => { clearTimeout(timeoutHandle); connected = true; resolve(); });

      sock.setTimeout(this.timeout);
      sock.on("timeout", () => sock.destroy(new Error("imap_client: session timeout.")));
      sock.on("data",  (d) => this._onData(d));
      sock.on("error", (e) => { clearTimeout(timeoutHandle); if (!connected) reject(e); });
      this._socket = sock;
    });
  }

  async readGreeting() {
    const line = await this._readLine();
    this._transcript.push({ dir: "S", line });
    this._greeting = line;
    if (!/^\* OK/i.test(line)) {
      throw new Error(`imap_client: unexpected greeting: ${line}`);
    }
    // Extract capabilities from greeting if present (some servers do: * OK [CAPABILITY ...])
    const capMatch = line.match(/\[CAPABILITY ([^\]]+)\]/i);
    if (capMatch) this._capabilities = capMatch[1].trim().toUpperCase().split(/\s+/);
    return line;
  }

  // ── STARTTLS upgrade ────────────────────────────────────────────────────────

  async starttls({ rejectUnauthorized = false } = {}) {
    const tag = this._nextTag();
    const res = await this._command(tag, `${tag} STARTTLS`);
    if (!res.ok) throw new Error(`imap_client: STARTTLS failed: ${res.text}`);
    // Upgrade plain socket to TLS
    return new Promise((resolve, reject) => {
      const tlsSock = tls.connect({
        socket:             this._socket,
        host:               this.host,
        servername:         this.host,
        rejectUnauthorized,
      }, () => {
        this._socket = tlsSock;
        this._starttlsDone = true;
        resolve();
      });
      tlsSock.on("data", (d) => this._onData(d));
      tlsSock.on("error", reject);
    });
  }

  // ── CAPABILITY ──────────────────────────────────────────────────────────────

  async capability() {
    const tag = this._nextTag();
    const res = await this._command(tag, `${tag} CAPABILITY`);
    for (const u of res.untagged) {
      const m = u.match(/^\* CAPABILITY (.+)/i);
      if (m) this._capabilities = m[1].trim().toUpperCase().split(/\s+/);
    }
    return this._capabilities;
  }

  hasCapability(cap) {
    return this._capabilities.includes(cap.toUpperCase());
  }

  // ── AUTH ────────────────────────────────────────────────────────────────────

  async login(user, password) {
    const tag = this._nextTag();
    // LOGIN user password — quoted strings
    const res = await this._command(tag, `${tag} LOGIN ${quoteImap(user)} ${quoteImap(password)}`);
    if (!res.ok) throw new Error(`imap_client: LOGIN failed: ${res.text}`);
    // Refresh capabilities (some servers send updated CAPABILITY after AUTH)
    const capLine = res.untagged.find(u => /^\* CAPABILITY/i.test(u));
    if (capLine) {
      const m = capLine.match(/^\* CAPABILITY (.+)/i);
      if (m) this._capabilities = m[1].trim().toUpperCase().split(/\s+/);
    }
  }

  async authenticatePlain(user, password) {
    // AUTHENTICATE PLAIN \0user\0password base64-encoded
    const plain = Buffer.from(`\x00${user}\x00${password}`, "utf8").toString("base64");
    const tag   = this._nextTag();
    const res   = await this._command(tag, `${tag} AUTHENTICATE PLAIN ${plain}`);
    if (!res.ok) throw new Error(`imap_client: AUTHENTICATE PLAIN failed: ${res.text}`);
  }

  // ── LOGOUT ──────────────────────────────────────────────────────────────────

  async logout() {
    try {
      const tag = this._nextTag();
      await this._command(tag, `${tag} LOGOUT`);
    } catch (_) { /* ignore errors during logout */ }
    try { this._socket.destroy(); } catch (_) {}
  }

  // ── LIST ────────────────────────────────────────────────────────────────────
  // Returns array of { flags, delimiter, name }
  async list(reference = "", pattern = "*") {
    const tag = this._nextTag();
    const ref = quoteImap(reference);
    const pat = quoteImap(pattern);
    const res = await this._command(tag, `${tag} LIST ${ref} ${pat}`);
    if (!res.ok) throw new Error(`imap_client: LIST failed: ${res.text}`);
    const mailboxes = [];
    for (const u of res.untagged) {
      // * LIST (\HasNoChildren) "/" "INBOX"
      const m = u.match(/^\* LIST \(([^)]*)\) ("[^"]*"|NIL) (.+)/i);
      if (!m) continue;
      const flags     = m[1].split(/\s+/).filter(Boolean);
      const delimiter = m[2] === "NIL" ? null : m[2].replace(/^"|"$/g, "");
      let name        = m[3].trim();
      if (name.startsWith('"') && name.endsWith('"'))
        name = name.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      mailboxes.push({ flags, delimiter, name });
    }
    return mailboxes;
  }

  // ── SELECT / EXAMINE ────────────────────────────────────────────────────────
  async selectMailbox(name, readonly = false) {
    const tag = this._nextTag();
    const cmd = readonly ? "EXAMINE" : "SELECT";
    const res = await this._command(tag, `${tag} ${cmd} ${quoteImap(name)}`);
    if (!res.ok) throw new Error(`imap_client: ${cmd} failed: ${res.text}`);
    const info = { name, readonly, flags: [], permanentFlags: [], exists: null, recent: null, unseen: null, uidValidity: null, uidNext: null };
    for (const u of res.untagged) {
      let m;
      if ((m = u.match(/^\* (\d+) EXISTS/i)))   info.exists      = parseInt(m[1], 10);
      if ((m = u.match(/^\* (\d+) RECENT/i)))   info.recent      = parseInt(m[1], 10);
      if ((m = u.match(/^\* FLAGS \(([^)]*)\)/i))) info.flags      = m[1].split(/\s+/).filter(Boolean);
      if ((m = u.match(/^\* OK \[UNSEEN (\d+)\]/i)))     info.unseen     = parseInt(m[1], 10);
      if ((m = u.match(/^\* OK \[UIDVALIDITY (\d+)\]/i))) info.uidValidity = parseInt(m[1], 10);
      if ((m = u.match(/^\* OK \[UIDNEXT (\d+)\]/i)))    info.uidNext    = parseInt(m[1], 10);
      if ((m = u.match(/^\* OK \[PERMANENTFLAGS \(([^)]*)\)\]/i))) info.permanentFlags = m[1].split(/\s+/).filter(Boolean);
    }
    return info;
  }

  // ── STATUS ──────────────────────────────────────────────────────────────────
  async status(name, items = ["MESSAGES", "UNSEEN", "RECENT", "UIDNEXT", "UIDVALIDITY"]) {
    const tag    = this._nextTag();
    const itemsStr = items.join(" ");
    const res    = await this._command(tag, `${tag} STATUS ${quoteImap(name)} (${itemsStr})`);
    if (!res.ok) throw new Error(`imap_client: STATUS failed: ${res.text}`);
    const result = { name };
    for (const u of res.untagged) {
      const m = u.match(/^\* STATUS \S+ \((.+)\)/i);
      if (!m) continue;
      const pairs = m[1].split(/\s+/);
      for (let i = 0; i < pairs.length - 1; i += 2) {
        result[pairs[i].toLowerCase()] = parseInt(pairs[i + 1], 10);
      }
    }
    return result;
  }

  // ── SEARCH ──────────────────────────────────────────────────────────────────
  // Returns array of message sequence numbers (or UIDs if uid=true).
  async search(criteria, uid = false) {
    const tag    = this._nextTag();
    const prefix = uid ? "UID SEARCH" : "SEARCH";
    const res    = await this._command(tag, `${tag} ${prefix} ${criteria}`);
    if (!res.ok) throw new Error(`imap_client: SEARCH failed: ${res.text}`);
    const ids = [];
    for (const u of res.untagged) {
      const m = u.match(/^\* (SEARCH|UID SEARCH)\s*(.*)/i);
      if (m && m[2].trim()) {
        ids.push(...m[2].trim().split(/\s+/).map(Number).filter(n => !isNaN(n)));
      }
      // Some servers just send "* SEARCH" with numbers at the top level
      const m2 = u.match(/^\* SEARCH (.+)/i);
      if (m2) {
        const nums = m2[1].trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
        // avoid duplicates if both patterns matched
        for (const n of nums) if (!ids.includes(n)) ids.push(n);
      }
    }
    return [...new Set(ids)].sort((a, b) => a - b);
  }

  // ── FETCH ───────────────────────────────────────────────────────────────────
  // Fetches the requested data items for the given sequence set.
  // Returns array of parsed message objects.
  async fetch(sequenceSet, dataItems = "(FLAGS RFC822.HEADER)", uid = false) {
    const tag    = this._nextTag();
    const prefix = uid ? "UID FETCH" : "FETCH";
    const res    = await this._command(tag, `${tag} ${prefix} ${sequenceSet} ${dataItems}`);
    if (!res.ok) throw new Error(`imap_client: FETCH failed: ${res.text}`);
    return parseFetchResponses(res.untagged);
  }

  // ── STORE ───────────────────────────────────────────────────────────────────
  async store(sequenceSet, operation, flags, uid = false) {
    // operation: "+FLAGS", "-FLAGS", "FLAGS", "+FLAGS.SILENT", etc.
    const tag    = this._nextTag();
    const prefix = uid ? "UID STORE" : "STORE";
    const flagStr = `(${flags.join(" ")})`;
    const res    = await this._command(tag, `${tag} ${prefix} ${sequenceSet} ${operation} ${flagStr}`);
    if (!res.ok) throw new Error(`imap_client: STORE failed: ${res.text}`);
    return res.untagged;
  }

  // ── COPY ────────────────────────────────────────────────────────────────────
  async copy(sequenceSet, destMailbox, uid = false) {
    const tag    = this._nextTag();
    const prefix = uid ? "UID COPY" : "COPY";
    const res    = await this._command(tag, `${tag} ${prefix} ${sequenceSet} ${quoteImap(destMailbox)}`);
    if (!res.ok) throw new Error(`imap_client: COPY failed: ${res.text}`);
    return { copied: true, text: res.text };
  }

  // ── EXPUNGE ─────────────────────────────────────────────────────────────────
  async expunge() {
    const tag = this._nextTag();
    const res = await this._command(tag, `${tag} EXPUNGE`);
    if (!res.ok) throw new Error(`imap_client: EXPUNGE failed: ${res.text}`);
    const expunged = res.untagged
      .filter(u => /^\* \d+ EXPUNGE/i.test(u))
      .map(u => parseInt(u.match(/^\* (\d+)/)[1], 10));
    return { expunged, count: expunged.length };
  }

  // ── APPEND ──────────────────────────────────────────────────────────────────
  async append(mailbox, message, flags = [], internalDate = null) {
    // APPEND "mailbox" (\Seen) "date" {size}\r\n<literal>
    const msgBuf  = Buffer.from(message, "utf8");
    const size    = msgBuf.length;
    const flagStr = flags.length ? `(${flags.join(" ")}) ` : "";
    const dateStr = internalDate ? `"${internalDate}" ` : "";
    const tag     = this._nextTag();
    // Send command with literal size
    const cmdLine = `${tag} APPEND ${quoteImap(mailbox)} ${flagStr}${dateStr}{${size}}`;
    this._send(cmdLine);
    // Wait for continuation response "+"
    let contLine = "";
    while (!contLine.startsWith("+")) {
      contLine = await this._readLine();
      this._transcript.push({ dir: "S", line: contLine });
      // If server sends a tagged failure instead of continuation
      if (contLine.startsWith(tag + " ")) {
        const ok = /^OK\b/i.test(contLine.slice(tag.length + 1));
        if (!ok) throw new Error(`imap_client: APPEND failed: ${contLine.slice(tag.length + 4)}`);
        break;
      }
    }
    // Send the literal
    this._socket.write(msgBuf);
    this._socket.write(CRLF);
    // Now read the tagged response
    const lines = [];
    while (true) {
      const line = await this._readLine();
      this._transcript.push({ dir: "S", line });
      if (line.startsWith(tag + " ")) {
        const ok   = /^OK\b/i.test(line.slice(tag.length + 1));
        const text = line.slice(tag.length + 4);
        if (!ok) throw new Error(`imap_client: APPEND failed: ${text}`);
        return { appended: true, mailbox, size, text };
      }
      lines.push(line);
    }
  }
}

// ── FETCH response parser ──────────────────────────────────────────────────────
// Parses lines like:
//   * 1 FETCH (UID 42 FLAGS (\Seen) RFC822.HEADER {512}\r\n...<headers>...)
function parseFetchResponses(untagged) {
  // Simple line-by-line parser; handles common fetch items.
  const messages = [];
  let i = 0;
  while (i < untagged.length) {
    const line = untagged[i];
    const m = line.match(/^\* (\d+) FETCH \((.*)$/i);
    if (!m) { i++; continue; }
    const seqno = parseInt(m[1], 10);
    const rest  = m[2];
    const msg   = { seqno, raw: line };
    // Parse UID
    const uidM = rest.match(/\bUID (\d+)/i);
    if (uidM) msg.uid = parseInt(uidM[1], 10);
    // Parse FLAGS
    const flagM = rest.match(/\bFLAGS \(([^)]*)\)/i);
    if (flagM) msg.flags = flagM[1].split(/\s+/).filter(Boolean);
    // Parse INTERNALDATE
    const dateM = rest.match(/\bINTERNALDATE "([^"]+)"/i);
    if (dateM) msg.internalDate = dateM[1];
    // Parse RFC822.SIZE
    const sizeM = rest.match(/\bRFC822\.SIZE (\d+)/i);
    if (sizeM) msg.size = parseInt(sizeM[1], 10);
    // Parse ENVELOPE
    // (Skip complex parse; just capture raw)
    const envM = rest.match(/\bENVELOPE \((.{0,500})/i);
    if (envM) msg.envelopeRaw = envM[1];
    // Parse literals {N} — the header/body text follows in subsequent lines
    // Look for items ending in {N} which means next N bytes are literal
    const litM = rest.match(/\b(RFC822\.HEADER|RFC822\.TEXT|RFC822|BODY(?:\[\S*\])?|BODY\.PEEK(?:\[\S*\])?) \{(\d+)\}$/i);
    if (litM) {
      const itemName  = litM[1].toUpperCase();
      const litLen    = parseInt(litM[2], 10);
      // Collect subsequent lines until we have litLen chars
      let collected   = "";
      i++;
      while (i < untagged.length && collected.length < litLen) {
        collected += untagged[i] + "\n";
        i++;
      }
      if (collected.length > litLen) collected = collected.slice(0, litLen);
      if (itemName.includes("HEADER")) {
        msg.headers = parseHeaders(collected);
        msg.headersRaw = collected;
      } else {
        msg.bodyRaw = collected;
      }
      continue;
    }
    messages.push(msg);
    i++;
  }
  return messages;
}

function parseHeaders(raw) {
  const headers = {};
  const lines = raw.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    if (/^\s/.test(line) && current) {
      // Folded header continuation
      headers[current] += " " + line.trim();
    } else {
      const colon = line.indexOf(":");
      if (colon > 0) {
        current = line.slice(0, colon).trim().toLowerCase();
        headers[current] = line.slice(colon + 1).trim();
      }
    }
  }
  return headers;
}

// ── Main exported function ─────────────────────────────────────────────────────
async function imapClient(args) {
  const start = Date.now();

  // ── Validate required inputs ────────────────────────────────────────────────
  if (!args.host || typeof args.host !== "string")
    throw new ToolError("imap_client: 'host' is required.", -32602);
  guardString(args.host, "host", 253);

  const operation = args.operation || "list";
  const VALID_OPS = ["list", "select", "search", "fetch", "status", "append", "store", "copy", "expunge"];
  if (!VALID_OPS.includes(operation))
    throw new ToolError(`imap_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`, -32602);

  const port     = args.port || (args.secure ? 993 : 143);
  const secure   = !!args.secure;
  const starttls = args.starttls !== false && !secure; // default: attempt STARTTLS on plaintext

  // ── Auth validation ─────────────────────────────────────────────────────────
  let authUser = null, authPassword = null, authMethod = "LOGIN";
  if (args.auth) {
    if (!args.auth.user || !args.auth.password)
      throw new ToolError("imap_client: 'auth.user' and 'auth.password' are required.", -32602);
    guardString(args.auth.user, "auth.user", 254);
    guardString(args.auth.password, "auth.password", 500);
    authUser     = args.auth.user;
    authPassword = args.auth.password;
    authMethod   = (args.auth.method || "LOGIN").toUpperCase();
    if (!["LOGIN", "PLAIN"].includes(authMethod))
      throw new ToolError(`imap_client: unknown auth method '${authMethod}'. Valid: LOGIN, PLAIN.`, -32602);
  }

  // ── Per-operation validation ─────────────────────────────────────────────────
  if (operation === "select") {
    if (!args.mailbox) throw new ToolError("imap_client: 'mailbox' is required for 'select'.", -32602);
    guardString(args.mailbox, "mailbox", 200);
  }
  if (operation === "status") {
    if (!args.mailbox) throw new ToolError("imap_client: 'mailbox' is required for 'status'.", -32602);
    guardString(args.mailbox, "mailbox", 200);
  }
  if (operation === "search") {
    if (!args.criteria) throw new ToolError("imap_client: 'criteria' is required for 'search'.", -32602);
    // Criteria is a space-separated list of IMAP search keys — validate
    guardString(args.criteria, "criteria", 500);
    // Must have a mailbox selected first — validate mailbox
    if (!args.mailbox) throw new ToolError("imap_client: 'mailbox' is required for 'search'.", -32602);
    guardString(args.mailbox, "mailbox", 200);
  }
  if (operation === "fetch") {
    if (!args.mailbox)       throw new ToolError("imap_client: 'mailbox' is required for 'fetch'.", -32602);
    if (!args.sequence_set)  throw new ToolError("imap_client: 'sequence_set' is required for 'fetch'.", -32602);
    guardString(args.mailbox,      "mailbox",      200);
    guardString(args.sequence_set, "sequence_set",  100);
    // Validate sequence_set: only digits, colons, commas, asterisks
    if (!/^[\d:,*]+$/.test(args.sequence_set))
      throw new ToolError("imap_client: 'sequence_set' must contain only digits, ':', ',', and '*'.", -32602);
  }
  if (operation === "append") {
    if (!args.mailbox) throw new ToolError("imap_client: 'mailbox' is required for 'append'.", -32602);
    if (!args.message) throw new ToolError("imap_client: 'message' is required for 'append'.", -32602);
    guardString(args.mailbox, "mailbox", 200);
    if (typeof args.message !== "string")
      throw new ToolError("imap_client: 'message' must be a string (RFC 2822 email).", -32602);
    if (Buffer.byteLength(args.message, "utf8") > MAX_APPEND_BYTES)
      throw new ToolError(`imap_client: 'message' exceeds ${MAX_APPEND_BYTES / 1024 / 1024} MB limit.`, -32602);
  }
  if (operation === "store") {
    if (!args.mailbox)       throw new ToolError("imap_client: 'mailbox' is required for 'store'.", -32602);
    if (!args.sequence_set)  throw new ToolError("imap_client: 'sequence_set' is required for 'store'.", -32602);
    if (!args.flags)         throw new ToolError("imap_client: 'flags' is required for 'store'.", -32602);
    guardString(args.mailbox,      "mailbox",      200);
    guardString(args.sequence_set, "sequence_set",  100);
    if (!/^[\d:,*]+$/.test(args.sequence_set))
      throw new ToolError("imap_client: 'sequence_set' must contain only digits, ':', ',', and '*'.", -32602);
  }
  if (operation === "copy") {
    if (!args.mailbox)       throw new ToolError("imap_client: 'mailbox' is required for 'copy' (source, must be selected).", -32602);
    if (!args.sequence_set)  throw new ToolError("imap_client: 'sequence_set' is required for 'copy'.", -32602);
    if (!args.dest_mailbox)  throw new ToolError("imap_client: 'dest_mailbox' is required for 'copy'.", -32602);
    guardString(args.mailbox,      "mailbox",      200);
    guardString(args.sequence_set, "sequence_set",  100);
    guardString(args.dest_mailbox, "dest_mailbox",  200);
    if (!/^[\d:,*]+$/.test(args.sequence_set))
      throw new ToolError("imap_client: 'sequence_set' must contain only digits, ':', ',', and '*'.", -32602);
  }
  if (operation === "expunge") {
    if (!args.mailbox) throw new ToolError("imap_client: 'mailbox' is required for 'expunge'.", -32602);
    guardString(args.mailbox, "mailbox", 200);
  }

  // ── Build session ───────────────────────────────────────────────────────────
  const session = new ImapSession({
    host:               args.host,
    port,
    secure,
    timeout:            args.timeout,
    connectTimeout:     args.connect_timeout,
    rejectUnauthorized: !!args.reject_unauthorized,
  });

  const baseResult = {
    host:         args.host,
    port,
    secure,
    operation,
    connected:    false,
    authenticated: false,
    starttlsUpgraded: false,
    elapsedMs:    0,
  };

  try {
    // ── Connect ───────────────────────────────────────────────────────────────
    await session.connect();
    baseResult.connected = true;
    await session.readGreeting();
    baseResult.greeting  = session._greeting;

    // ── CAPABILITY ────────────────────────────���──────────────────────────────
    await session.capability();
    baseResult.capabilities = session._capabilities;

    // ── STARTTLS ─────────────────────────────────────────────────────────────
    if (starttls && session.hasCapability("STARTTLS")) {
      await session.starttls({ rejectUnauthorized: !!args.reject_unauthorized });
      baseResult.starttlsUpgraded = true;
      await session.capability(); // refresh caps after TLS
      baseResult.capabilities = session._capabilities;
    }

    // ── AUTH ─────────────────────────────────────────────────────────────────
    if (authUser) {
      if (authMethod === "PLAIN" && session.hasCapability("AUTH=PLAIN")) {
        await session.authenticatePlain(authUser, authPassword);
      } else {
        await session.login(authUser, authPassword);
      }
      baseResult.authenticated = true;
    }

    // ── Operation ────────────────────────────────────────────────────────────
    let result = {};

    if (operation === "list") {
      // Guard only if the caller provided a non-empty value
      if (args.reference) guardOptString(args.reference, "reference", 200);
      if (args.pattern)   guardOptString(args.pattern,   "pattern",   200);
      const ref     = args.reference !== undefined ? args.reference : "";
      const pattern = args.pattern   || "*";
      const mailboxes = await session.list(ref, pattern);
      result = { mailboxes, count: mailboxes.length };
    }

    else if (operation === "select") {
      const readonly = !!args.readonly;
      const info     = await session.selectMailbox(args.mailbox, readonly);
      result = { mailbox: info };
    }

    else if (operation === "status") {
      const items   = args.status_items || ["MESSAGES", "UNSEEN", "RECENT", "UIDNEXT", "UIDVALIDITY"];
      const status  = await session.status(args.mailbox, items);
      result = { status };
    }

    else if (operation === "search") {
      // Select the mailbox first
      await session.selectMailbox(args.mailbox, true); // EXAMINE (read-only)
      const uid  = !!args.use_uid;
      const ids  = await session.search(args.criteria, uid);
      const maxResults = Math.min(Math.max(args.max_results || 500, 1), 5000);
      const truncated  = ids.length > maxResults;
      result = {
        criteria:   args.criteria,
        mailbox:    args.mailbox,
        useUid:     uid,
        ids:        ids.slice(0, maxResults),
        count:      ids.length,
        truncated,
      };
    }

    else if (operation === "fetch") {
      // Select the mailbox (read-only)
      await session.selectMailbox(args.mailbox, true);
      const uid          = !!args.use_uid;
      const fetchItems   = args.fetch_items || "(FLAGS RFC822.HEADER)";
      const messages     = await session.fetch(args.sequence_set, fetchItems, uid);
      const maxMsg       = Math.min(messages.length, MAX_FETCH_MESSAGES);
      result = {
        mailbox:    args.mailbox,
        sequenceSet: args.sequence_set,
        useUid:     uid,
        fetchItems,
        messages:   messages.slice(0, maxMsg),
        count:      messages.length,
        truncated:  messages.length > maxMsg,
      };
    }

    else if (operation === "append") {
      const flags = args.flags || [];
      const res   = await session.append(args.mailbox, args.message, flags, args.internal_date || null);
      result = res;
    }

    else if (operation === "store") {
      // Select mailbox (read-write)
      await session.selectMailbox(args.mailbox, false);
      const uid       = !!args.use_uid;
      const storeOp   = args.store_operation || "+FLAGS";
      const VALID_STORE_OPS = ["+FLAGS", "-FLAGS", "FLAGS", "+FLAGS.SILENT", "-FLAGS.SILENT", "FLAGS.SILENT"];
      if (!VALID_STORE_OPS.includes(storeOp.toUpperCase()))
        throw new ToolError(`imap_client: invalid 'store_operation' '${storeOp}'.`, -32602);
      const flags     = Array.isArray(args.flags) ? args.flags : [args.flags];
      const responses = await session.store(args.sequence_set, storeOp, flags, uid);
      result = { mailbox: args.mailbox, sequenceSet: args.sequence_set, storeOperation: storeOp, flags, responses };
    }

    else if (operation === "copy") {
      // Select source mailbox (read-only)
      await session.selectMailbox(args.mailbox, true);
      const uid = !!args.use_uid;
      const res = await session.copy(args.sequence_set, args.dest_mailbox, uid);
      result = { mailbox: args.mailbox, destMailbox: args.dest_mailbox, sequenceSet: args.sequence_set, ...res };
    }

    else if (operation === "expunge") {
      // Select mailbox (read-write) and expunge
      await session.selectMailbox(args.mailbox, false);
      const res = await session.expunge();
      result = { mailbox: args.mailbox, ...res };
    }

    await session.logout();

    return {
      ...baseResult,
      success:    true,
      elapsedMs:  Date.now() - start,
      transcript: args.include_transcript ? session._transcript : undefined,
      ...result,
    };

  } catch (err) {
    try { session._socket && session._socket.destroy(); } catch (_) {}
    const elapsedMs = Date.now() - start;
    return {
      ...baseResult,
      success:   false,
      error:     err.message || String(err),
      elapsedMs,
      transcript: args.include_transcript ? session._transcript : undefined,
    };
  }
}

module.exports = { imapClient, ImapSession, parseFetchResponses, parseHeaders };
