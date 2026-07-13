"use strict";
/**
 * pop3_client — Zero-dependency POP3 client
 * (pure Node.js net/tls built-ins; no npm deps)
 *
 * RFC 1939  — Post Office Protocol version 3 (POP3)
 * RFC 2449  — POP3 Extension Mechanism (CAPA command)
 * RFC 2595  — Using TLS with IMAP, POP3 and ACAP (STLS)
 * RFC 5034  — POP3 SASL Authentication Mechanism (AUTH)
 *
 * Operations:
 *   stat      — STAT: return mailbox message count and total size
 *   list      — LIST: enumerate messages with individual sizes
 *   uidl      — UIDL: list unique message identifiers
 *   retrieve  — RETR: download one or more full messages
 *   top       — TOP:  retrieve message headers + first N body lines
 *   delete    — DELE: mark messages for deletion (QUIT commits them)
 *   reset     — RSET: unmark all pending deletions
 *   capa      — CAPA (RFC 2449): list server capabilities
 *   info      — Return protocol/config table (no I/O)
 *
 * Transport:
 *   Plain TCP  (default port 110)
 *   TLS        (default port 995, use_tls: true)
 *   STLS       (upgrade plain TCP to TLS after CAPA confirms it)
 *
 * Authentication:
 *   USER/PASS  — plaintext credentials (RFC 1939)
 *   APOP       — MD5 challenge-response (RFC 1939 §7)
 */

const net    = require("net");
const tls    = require("tls");
const crypto = require("crypto");

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_PORT_PLAIN = 110;
const DEFAULT_PORT_TLS   = 995;
const MAX_RESPONSE       = 10 * 1024 * 1024;  // 10 MB total per session
const MAX_MESSAGE_SIZE   = 5  * 1024 * 1024;  // 5 MB per retrieved message

// ── TCP/TLS connection ─────────────────────────────────────────────────────────

/**
 * Low-level POP3 connection abstraction.
 * Manages a single TCP or TLS socket, reads lines, sends commands.
 */
class Pop3Connection {
  constructor(socket, timeoutMs) {
    this._socket    = socket;
    this._timeoutMs = timeoutMs;
    this._buf       = "";
    this._closed    = false;
    this._totalBytes = 0;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this._totalBytes += chunk.length;
      if (this._totalBytes > MAX_RESPONSE) {
        this._closed = true;
        socket.destroy(new Error("POP3 response exceeded 10 MB cap"));
        return;
      }
      this._buf += chunk;
      // Wake up any pending reader
      if (this._resolver) {
        const r = this._resolver;
        this._resolver = null;
        r();
      }
    });

    socket.on("error",  (err) => { this._closed = true; this._rejectPending(err); });
    socket.on("close",  ()    => { this._closed = true; this._rejectPending(new Error("Connection closed unexpectedly")); });
    socket.on("end",    ()    => { this._closed = true; this._rejectPending(new Error("Server closed connection")); });
  }

  _rejectPending(err) {
    if (this._rejecter) {
      const r = this._rejecter;
      this._resolver = null;
      this._rejecter = null;
      r(err);
    }
  }

  /** Wait for more data, with timeout */
  _waitForData() {
    return new Promise((resolve, reject) => {
      if (this._buf.length > 0) { resolve(); return; }
      if (this._closed) { reject(new Error("Connection closed")); return; }
      const timer = setTimeout(() => {
        this._resolver = null;
        this._rejecter = null;
        reject(new Error(`POP3 server did not respond within ${this._timeoutMs}ms`));
      }, this._timeoutMs);
      this._resolver = () => { clearTimeout(timer); resolve(); };
      this._rejecter = (err) => { clearTimeout(timer); reject(err); };
    });
  }

  /** Read a single \r\n-terminated line */
  async readLine() {
    while (true) {
      const idx = this._buf.indexOf("\r\n");
      if (idx !== -1) {
        const line = this._buf.slice(0, idx);
        this._buf = this._buf.slice(idx + 2);
        return line;
      }
      await this._waitForData();
    }
  }

  /**
   * Read a POP3 single-line response (+OK ... or -ERR ...).
   * Throws on -ERR or unexpected format.
   */
  async readResponse() {
    const line = await this.readLine();
    if (line.startsWith("+OK")) return line.slice(3).trim();
    if (line.startsWith("-ERR")) throw new Error(`POP3 server error: ${line.slice(4).trim()}`);
    throw new Error(`Unexpected POP3 response: ${line}`);
  }

  /**
   * Read a multi-line response terminated by a lone "." line.
   * Returns the joined body lines (the "." terminator removed).
   * Dot-stuffing (RFC 1939 §3) is undone: leading ".." → ".".
   */
  async readMultiLine() {
    const lines = [];
    while (true) {
      const line = await this.readLine();
      if (line === ".") break;
      lines.push(line.startsWith("..") ? line.slice(1) : line);
    }
    return lines.join("\r\n");
  }

  /** Send a command (appends \r\n) */
  send(cmd) {
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error("Connection closed")); return; }
      this._socket.write(cmd + "\r\n", "utf8", (err) => {
        if (err) reject(new Error(`POP3 write error: ${err.message}`));
        else resolve();
      });
    });
  }

  destroy() {
    this._closed = true;
    try { this._socket.destroy(); } catch (_) {}
  }
}

// ── Connection factory ─────────────────────────────────────────────────────────

/**
 * Connect to a POP3 server (plain TCP or TLS) and return a Pop3Connection.
 */
function connectPop3(host, port, useTls, rejectUnauthorized, timeoutMs) {
  return new Promise((resolve, reject) => {
    let sock;
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { sock && sock.destroy(); } catch (_) {}
        reject(new Error(`Connection to ${host}:${port} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const onConnect = () => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      resolve(new Pop3Connection(sock, timeoutMs));
    };

    const onError = (err) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      reject(new Error(`Cannot connect to POP3 server ${host}:${port}: ${err.message}`));
    };

    if (useTls) {
      sock = tls.connect({
        host, port,
        rejectUnauthorized: rejectUnauthorized !== false,
        servername: host,
      });
      sock.once("secureConnect", onConnect);
    } else {
      sock = net.connect({ host, port });
      sock.once("connect", onConnect);
    }
    sock.once("error", onError);
  });
}

/**
 * Perform STARTTLS upgrade on an existing plain-text connection.
 * Returns a new Pop3Connection wrapping the upgraded TLS socket.
 */
function upgradeTls(existingConn, host, rejectUnauthorized, timeoutMs) {
  return new Promise((resolve, reject) => {
    const raw = existingConn._socket;
    existingConn._closed = true; // stop old conn from processing events

    const tlsSock = tls.connect({
      socket: raw,
      host,
      servername: host,
      rejectUnauthorized: rejectUnauthorized !== false,
    });

    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        tlsSock.destroy();
        reject(new Error(`STLS upgrade timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    tlsSock.once("secureConnect", () => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        resolve(new Pop3Connection(tlsSock, timeoutMs));
      }
    });
    tlsSock.once("error", (err) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(new Error(`STLS upgrade failed: ${err.message}`));
      }
    });
  });
}

// ── Authentication ─────────────────────────────────────────────────────────────

/**
 * POP3 USER/PASS authentication (RFC 1939 §7).
 */
async function authUserPass(conn, username, password) {
  await conn.send(`USER ${username}`);
  await conn.readResponse(); // +OK ...
  await conn.send(`PASS ${password}`);
  await conn.readResponse(); // +OK maildrop has N messages
}

/**
 * APOP authentication (RFC 1939 §7).
 * MD5(timestamp + password)
 */
async function authApop(conn, username, password, timestamp) {
  const digest = crypto.createHash("md5")
    .update(timestamp + password)
    .digest("hex");
  await conn.send(`APOP ${username} ${digest}`);
  await conn.readResponse();
}

// ── Guard helpers ──────────────────────────────────────────────────────────────

function requireString(val, name) {
  if (typeof val !== "string" || val.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
}

function clampInt(val, def, min, max, name) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

// ── Session helper ─────────────────────────────────────────────────────────────

/**
 * Open a POP3 session, authenticate, run the callback, then QUIT.
 * Returns whatever the callback returns.
 * Guarantees QUIT is sent (or socket destroyed) on error.
 */
async function withSession(args, callback) {
  requireString(args.host,     "host");
  requireString(args.username, "username");
  requireString(args.password, "password");

  const host             = args.host.trim();
  const useTls           = !!args.use_tls;
  const useStls          = !!args.use_stls;
  const rejectUnauth     = args.reject_unauthorized !== false;
  const authMethod       = (args.auth_method || "userpass").toLowerCase();
  const timeoutMs        = clampInt(args.timeout, 15000, 1000, 120000, "timeout");
  const defaultPort      = useTls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN;
  const port             = clampInt(args.port, defaultPort, 1, 65535, "port");

  if (!["userpass", "apop"].includes(authMethod))
    throw new Error(`auth_method must be 'userpass' or 'apop', got: ${authMethod}`);

  let conn = await connectPop3(host, port, useTls, rejectUnauth, timeoutMs);
  let greeting;
  try {
    // Read server greeting
    const greetLine = await conn.readLine();
    if (!greetLine.startsWith("+OK"))
      throw new Error(`Expected +OK greeting, got: ${greetLine}`);
    greeting = greetLine.slice(3).trim();

    // STLS upgrade on plain connection
    if (useStls && !useTls) {
      // Issue STLS command
      await conn.send("STLS");
      await conn.readResponse();
      // Upgrade to TLS
      conn = await upgradeTls(conn, host, rejectUnauth, timeoutMs);
    }

    // Authenticate
    if (authMethod === "apop") {
      // Extract APOP timestamp from greeting: <timestamp@host>
      const match = greeting.match(/<[^>]+>/);
      if (!match) throw new Error("APOP requested but server greeting contains no timestamp");
      await authApop(conn, args.username, args.password, match[0]);
    } else {
      await authUserPass(conn, args.username, args.password);
    }

    // Run the actual operation
    const result = await callback(conn);

    // Graceful QUIT
    await conn.send("QUIT");
    try { await conn.readResponse(); } catch (_) {} // ignore QUIT response errors
    conn.destroy();

    return { greeting, result };
  } catch (err) {
    conn.destroy();
    throw err;
  }
}

// ── Parsers ────────────────────────────────────────────────────────────────────

/**
 * Parse a LIST response line: "N SIZE"
 */
function parseListLine(line) {
  const parts = line.trim().split(/\s+/);
  return { msgNum: parseInt(parts[0], 10), size: parseInt(parts[1], 10) };
}

/**
 * Parse a UIDL response line: "N UNIQUE-ID"
 */
function parseUidlLine(line) {
  const idx = line.indexOf(" ");
  if (idx === -1) return { msgNum: parseInt(line, 10), uid: "" };
  return {
    msgNum: parseInt(line.slice(0, idx), 10),
    uid:    line.slice(idx + 1).trim(),
  };
}

/**
 * Parse an RFC 2822 message into { headers, body }.
 * Headers is an object (last value wins for duplicates, except Received which is an array).
 */
function parseMessage(raw) {
  const headerBodySep = raw.indexOf("\r\n\r\n");
  let headerStr, body;
  if (headerBodySep === -1) {
    headerStr = raw;
    body = "";
  } else {
    headerStr = raw.slice(0, headerBodySep);
    body = raw.slice(headerBodySep + 4);
  }

  // Unfold headers (RFC 2822 §2.2.3: lines starting with WSP continue previous header)
  const unfolded = headerStr.replace(/\r\n([ \t])/g, " $1");
  const headerLines = unfolded.split("\r\n");

  const headers = {};
  for (const line of headerLines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key   = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "received") {
      if (!headers.received) headers.received = [];
      headers.received.push(value);
    } else {
      headers[key] = value;
    }
  }

  return { headers, body, rawSize: raw.length };
}

// ── Operations ─────────────────────────────────────────────────────────────────

/**
 * STAT — Return message count and total mailbox size.
 */
async function opStat(args) {
  const { greeting, result } = await withSession(args, async (conn) => {
    await conn.send("STAT");
    const resp = await conn.readResponse(); // e.g. "2 320"
    const parts = resp.trim().split(/\s+/);
    return {
      messageCount: parseInt(parts[0], 10) || 0,
      totalSize:    parseInt(parts[1], 10) || 0,
    };
  });
  return {
    ok:           true,
    operation:    "stat",
    server:       args.host.trim(),
    port:         clampInt(args.port, args.use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN, 1, 65535, "port"),
    greeting,
    ...result,
  };
}

/**
 * LIST — Enumerate all messages with their sizes.
 * Optionally retrieves a single message's size if msg_num is provided.
 */
async function opList(args) {
  const { greeting, result } = await withSession(args, async (conn) => {
    if (args.msg_num !== undefined) {
      const n = clampInt(args.msg_num, null, 1, 999999, "msg_num");
      if (n === null) throw new Error("msg_num must be a positive integer");
      await conn.send(`LIST ${n}`);
      const resp = await conn.readResponse();
      const parsed = parseListLine(resp);
      return { messages: [parsed], messageCount: 1 };
    } else {
      await conn.send("LIST");
      await conn.readResponse(); // +OK N messages (M octets)
      const body = await conn.readMultiLine();
      const lines = body.split("\r\n").filter(l => l.trim());
      const messages = lines.map(parseListLine);
      return { messages, messageCount: messages.length };
    }
  });
  return {
    ok:        true,
    operation: "list",
    server:    args.host.trim(),
    port:      clampInt(args.port, args.use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN, 1, 65535, "port"),
    greeting,
    ...result,
  };
}

/**
 * UIDL — Return unique IDs for all messages (or a specific one).
 */
async function opUidl(args) {
  const { greeting, result } = await withSession(args, async (conn) => {
    if (args.msg_num !== undefined) {
      const n = clampInt(args.msg_num, null, 1, 999999, "msg_num");
      if (n === null) throw new Error("msg_num must be a positive integer");
      await conn.send(`UIDL ${n}`);
      const resp = await conn.readResponse();
      const parsed = parseUidlLine(resp);
      return { messages: [parsed], messageCount: 1 };
    } else {
      await conn.send("UIDL");
      await conn.readResponse(); // +OK
      const body = await conn.readMultiLine();
      const lines = body.split("\r\n").filter(l => l.trim());
      const messages = lines.map(parseUidlLine);
      return { messages, messageCount: messages.length };
    }
  });
  return {
    ok:        true,
    operation: "uidl",
    server:    args.host.trim(),
    port:      clampInt(args.port, args.use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN, 1, 65535, "port"),
    greeting,
    ...result,
  };
}

/**
 * RETR — Retrieve one or more full messages.
 * If msg_nums is an array, retrieves each in sequence.
 * If msg_num is a number, retrieves that single message.
 */
async function opRetrieve(args) {
  const timeoutMs = clampInt(args.timeout, 15000, 1000, 120000, "timeout");

  const { greeting, result } = await withSession(args, async (conn) => {
    let nums;
    if (Array.isArray(args.msg_nums)) {
      nums = args.msg_nums.map(n => clampInt(n, null, 1, 999999, "msg_nums item"));
    } else if (args.msg_num !== undefined) {
      const n = clampInt(args.msg_num, null, 1, 999999, "msg_num");
      if (n === null) throw new Error("msg_num must be a positive integer");
      nums = [n];
    } else {
      throw new Error("retrieve requires msg_num (single) or msg_nums (array)");
    }

    const includeRaw     = args.include_raw !== false;
    const parseHeaders   = args.parse_headers !== false;
    const maxMessages    = clampInt(args.max_messages, 10, 1, 100, "max_messages");
    nums = nums.slice(0, maxMessages);

    const retrieved = [];
    for (const n of nums) {
      await conn.send(`RETR ${n}`);
      await conn.readResponse(); // +OK N octets
      const raw = await conn.readMultiLine();
      if (raw.length > MAX_MESSAGE_SIZE) {
        retrieved.push({ msgNum: n, error: `Message ${n} exceeds 5 MB size limit`, size: raw.length });
        continue;
      }
      const entry = { msgNum: n, size: raw.length };
      if (parseHeaders) {
        const parsed = parseMessage(raw);
        entry.headers = parsed.headers;
        entry.bodyPreview = parsed.body.slice(0, 512); // first 512 chars of body
        entry.bodySize = parsed.body.length;
      }
      if (includeRaw) entry.raw = raw;
      retrieved.push(entry);
    }

    return { retrieved, retrievedCount: retrieved.length };
  });

  return {
    ok:        true,
    operation: "retrieve",
    server:    args.host.trim(),
    port:      clampInt(args.port, args.use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN, 1, 65535, "port"),
    greeting,
    ...result,
  };
}

/**
 * TOP — Retrieve headers + first N body lines of a message.
 */
async function opTop(args) {
  if (args.msg_num === undefined) throw new Error("top requires msg_num");
  const n    = clampInt(args.msg_num, null, 1, 999999, "msg_num");
  if (n === null) throw new Error("msg_num must be a positive integer");
  const lines = clampInt(args.lines, 10, 0, 1000, "lines");

  const { greeting, result } = await withSession(args, async (conn) => {
    await conn.send(`TOP ${n} ${lines}`);
    await conn.readResponse(); // +OK
    const raw = await conn.readMultiLine();
    const parsed = parseMessage(raw);
    return {
      msgNum:  n,
      lines,
      headers: parsed.headers,
      body:    parsed.body,
      rawSize: raw.length,
    };
  });

  return {
    ok:        true,
    operation: "top",
    server:    args.host.trim(),
    port:      clampInt(args.port, args.use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN, 1, 65535, "port"),
    greeting,
    ...result,
  };
}

/**
 * DELE — Mark messages for deletion.
 * Deletions are only committed when the session ends with QUIT.
 * Pass msg_num for single, msg_nums for multiple.
 */
async function opDelete(args) {
  const { greeting, result } = await withSession(args, async (conn) => {
    let nums;
    if (Array.isArray(args.msg_nums)) {
      nums = args.msg_nums.map(n => clampInt(n, null, 1, 999999, "msg_nums item"));
    } else if (args.msg_num !== undefined) {
      const n = clampInt(args.msg_num, null, 1, 999999, "msg_num");
      if (n === null) throw new Error("msg_num must be a positive integer");
      nums = [n];
    } else {
      throw new Error("delete requires msg_num (single) or msg_nums (array)");
    }

    const deleted = [];
    const errors  = [];
    for (const n of nums) {
      try {
        await conn.send(`DELE ${n}`);
        await conn.readResponse();
        deleted.push(n);
      } catch (err) {
        errors.push({ msgNum: n, error: err.message });
      }
    }
    return { deleted, deletedCount: deleted.length, errors };
  });

  return {
    ok:        true,
    operation: "delete",
    server:    args.host.trim(),
    port:      clampInt(args.port, args.use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN, 1, 65535, "port"),
    greeting,
    ...result,
    note: "Deletions committed when session ends with QUIT (done automatically)",
  };
}

/**
 * RSET — Reset (unmark pending deletions).
 */
async function opReset(args) {
  const { greeting, result } = await withSession(args, async (conn) => {
    await conn.send("RSET");
    const resp = await conn.readResponse();
    return { response: resp };
  });
  return {
    ok:        true,
    operation: "reset",
    server:    args.host.trim(),
    port:      clampInt(args.port, args.use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN, 1, 65535, "port"),
    greeting,
    note: "All pending DELE marks cleared",
    ...result,
  };
}

/**
 * CAPA (RFC 2449) — List server capabilities.
 */
async function opCapa(args) {
  requireString(args.host, "host");
  const host       = args.host.trim();
  const useTls     = !!args.use_tls;
  const rejectUnauth = args.reject_unauthorized !== false;
  const timeoutMs  = clampInt(args.timeout, 15000, 1000, 120000, "timeout");
  const defaultPort = useTls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN;
  const port       = clampInt(args.port, defaultPort, 1, 65535, "port");

  // CAPA does not require authentication — send before USER/PASS
  const conn = await connectPop3(host, port, useTls, rejectUnauth, timeoutMs);
  let greeting;
  try {
    const greetLine = await conn.readLine();
    if (!greetLine.startsWith("+OK"))
      throw new Error(`Expected +OK greeting, got: ${greetLine}`);
    greeting = greetLine.slice(3).trim();

    await conn.send("CAPA");
    let capabilities = [];
    try {
      await conn.readResponse(); // +OK
      const body = await conn.readMultiLine();
      capabilities = body.split("\r\n").filter(l => l.trim());
    } catch (_) {
      // Server may not support CAPA
      capabilities = ["(CAPA not supported by this server)"];
    }

    await conn.send("QUIT");
    try { await conn.readResponse(); } catch (_) {}
    conn.destroy();

    return {
      ok:           true,
      operation:    "capa",
      server:       host,
      port,
      greeting,
      capabilities,
      capabilityCount: capabilities.length,
    };
  } catch (err) {
    conn.destroy();
    throw err;
  }
}

/** Return protocol/config info table — no I/O */
function opInfo() {
  return {
    protocol:    "POP3 (Post Office Protocol version 3)",
    rfcs:        ["RFC 1939 (POP3 base)", "RFC 2449 (CAPA extension)", "RFC 2595 (STLS/TLS)", "RFC 5034 (SASL AUTH)"],
    defaultPorts: { plain: DEFAULT_PORT_PLAIN, tls: DEFAULT_PORT_TLS },
    operations: [
      { op: "stat",     description: "STAT — mailbox message count and total byte size" },
      { op: "list",     description: "LIST — enumerate messages with per-message size" },
      { op: "uidl",     description: "UIDL — unique message identifiers (persistent across sessions)" },
      { op: "retrieve", description: "RETR — download full message(s); optionally parse headers" },
      { op: "top",      description: "TOP N — retrieve headers + first N body lines" },
      { op: "delete",   description: "DELE — mark messages for deletion (committed on QUIT)" },
      { op: "reset",    description: "RSET — unmark all pending deletions" },
      { op: "capa",     description: "CAPA — list server capability extensions (RFC 2449)" },
      { op: "info",     description: "Return protocol/config table (no I/O)" },
    ],
    authMethods: [
      { method: "userpass", description: "USER + PASS commands (plaintext, standard)" },
      { method: "apop",     description: "APOP MD5 challenge-response (RFC 1939 §7)" },
    ],
    tlsOptions: [
      { flag: "use_tls",  description: "Direct TLS on port 995" },
      { flag: "use_stls", description: "Upgrade plain TCP to TLS via STLS (RFC 2595)" },
    ],
    pop3VsImap: "POP3 downloads and optionally deletes messages; IMAP keeps messages on server. Use POP3 for offline access, IMAP for multi-device access.",
    notes: [
      "POP3 sessions are stateful: DELE marks are only committed when QUIT is sent.",
      "Message numbers are session-local; use UIDL for persistent identifiers.",
      "RFC 1939 §8: mail is accessible via POP3 only after a 'maildrop' is locked.",
    ],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────────

async function pop3Client(args) {
  const operation = (args.operation || "").toLowerCase();
  switch (operation) {
    case "stat":     return opStat(args);
    case "list":     return opList(args);
    case "uidl":     return opUidl(args);
    case "retrieve": return opRetrieve(args);
    case "top":      return opTop(args);
    case "delete":   return opDelete(args);
    case "reset":    return opReset(args);
    case "capa":     return opCapa(args);
    case "info":     return opInfo();
    default:
      throw new Error(
        `Unknown pop3_client operation: '${operation}'. ` +
        "Valid: stat, list, uidl, retrieve, top, delete, reset, capa, info"
      );
  }
}

module.exports = {
  pop3Client,
  // Exported for testing
  Pop3Connection, parseMessage, parseListLine, parseUidlLine,
  authUserPass, authApop,
};
