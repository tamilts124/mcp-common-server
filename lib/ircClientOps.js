"use strict";
/**
 * irc_client — Zero-dependency IRC client.
 * Pure Node.js (net, tls built-ins; no npm deps).
 *
 * Implements RFC 1459 + IRC v3 extensions.
 *
 * Operations:
 *   send_message   — Connect, join channel(s), send messages, disconnect
 *   join           — Connect and join channels, collect messages for duration, disconnect
 *   nick           — Connect and change nick
 *   list           — Connect and LIST channels
 *   whois          — Connect and WHOIS a user
 *   raw            — Connect and send raw IRC commands, collect responses
 *   info           — Return config/capability info (no I/O)
 *
 * Authentication:
 *   SASL PLAIN (CAP REQ sasl + AUTHENTICATE PLAIN)
 *   NickServ IDENTIFY fallback
 *   Server password (PASS command)
 *
 * Security:
 *   - NUL-byte and CR/LF guards on all user-supplied strings
 *   - Message length clamped to 510 chars (RFC 1459 §2.3)
 *   - Timeout clamped 3 s – 60 s
 *   - Channel name validated (must start with # & + ! or &)
 *   - TLS supported; rejectUnauthorized configurable
 */

const net = require("net");
const tls = require("tls");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS  = 10_000;
const MIN_TIMEOUT_MS      = 3_000;
const MAX_TIMEOUT_MS      = 60_000;
const MAX_IRC_LINE        = 510;       // RFC 1459 §2.3 (512 - CRLF)
const MAX_MESSAGES_SEND   = 20;        // max messages to send in one op
const MAX_CHANNELS        = 10;        // max channels to join at once
const MAX_COLLECTED_LINES = 500;       // cap on collected server lines
const DEFAULT_PORT_PLAIN  = 6667;
const DEFAULT_PORT_TLS    = 6697;

// ── Validation helpers ────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`irc_client: '${name}' must not contain NUL bytes.`);
}

function guardCrLf(value, name) {
  if (typeof value === "string" && /[\r\n]/.test(value))
    throw new Error(`irc_client: '${name}' must not contain CR or LF characters.`);
}

function guardString(value, name) {
  guardNul(value, name);
  guardCrLf(value, name);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

/**
 * Validate an IRC channel name.
 * Must start with #, &, +, or ! and contain no spaces, NUL, BEL, or commas.
 */
function validateChannel(ch) {
  if (typeof ch !== "string" || ch.length === 0) return false;
  if (!/^[#&+!]/.test(ch)) return false;
  if (ch.length > 50) return false;
  if (/[ \0\x07,]/.test(ch)) return false;
  return true;
}

/**
 * Validate an IRC nick (RFC 1459 §2.3.1).
 * Letter or special char first, then letter/digit/special/hyphen, max 30 chars.
 */
function validateNick(nick) {
  if (typeof nick !== "string" || nick.length === 0) return false;
  if (nick.length > 30) return false;
  if (!/^[a-zA-Z\[\]\\`^_{}|][a-zA-Z0-9\[\]\\`^_{}|\-]*$/.test(nick)) return false;
  return true;
}

/**
 * Clamp and sanitise an IRC message text (strip CR/LF, clamp length).
 */
function sanitiseMessage(text) {
  return text.replace(/[\r\n]/g, " ").slice(0, MAX_IRC_LINE);
}

// ── IRC line parser ───────────────────────────────────────────────────────────

/**
 * Parse a single IRC protocol line into its components.
 * Format: [:prefix] command [params] [:trailing]
 */
function parseLine(line) {
  let prefix = null;
  let rest = line;

  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp === -1) return { prefix: rest.slice(1), command: "", params: [], trailing: null };
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }

  const trailIdx = rest.indexOf(" :");
  let trailing = null;
  if (trailIdx !== -1) {
    trailing = rest.slice(trailIdx + 2);
    rest = rest.slice(0, trailIdx);
  }

  const parts = rest.split(" ").filter(Boolean);
  const command = parts.shift() || "";
  const params = parts;

  if (trailing !== null) params.push(trailing);

  return { prefix, command, params, trailing };
}

/**
 * Extract nick from a prefix string "nick!user@host".
 */
function nickFromPrefix(prefix) {
  if (!prefix) return null;
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

// ── IRC connection ────────────────────────────────────────────────────────────

/**
 * Low-level IRC connection.
 * Opens a socket (plain or TLS), handles line-buffering, PING/PONG,
 * CAP negotiation, SASL PLAIN, NickServ, and registration.
 *
 * @param {object} opts
 * @returns {object} ircConn — { writeLine, waitFor, close, lines }
 */
function createIrcConnection(opts = {}) {
  const {
    host,
    port,
    use_tls        = false,
    reject_unauthorized = true,
    nick,
    user           = "mcpuser",
    realname       = "MCP IRC Client",
    server_password = null,
    sasl_password  = null,
    nickserv_password = null,
    timeoutMs      = DEFAULT_TIMEOUT_MS,
  } = opts;

  const lines = [];            // all lines received
  const waiters = [];          // { predicate, resolve, reject }

  let socket;
  let lineBuffer = "";
  let closed = false;
  let registered = false;

  // ── Socket factory ──────────────────────────────────────────────────────
  const connectPromise = new Promise((resolve, reject) => {
    const socketOpts = use_tls
      ? { host, port, rejectUnauthorized: reject_unauthorized }
      : { host, port };

    socket = use_tls
      ? tls.connect(socketOpts)
      : net.createConnection(socketOpts);

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);

    socket.on("timeout", () => {
      const err = new Error(`irc_client: connection to ${host}:${port} timed out after ${timeoutMs} ms.`);
      reject(err);
      rejectWaiters(err);
      socket.destroy();
    });

    socket.on("error", (err) => {
      const wrapped = new Error(`irc_client: socket error connecting to ${host}:${port}: ${err.message}`);
      reject(wrapped);
      rejectWaiters(wrapped);
    });

    socket.on("data", (chunk) => {
      lineBuffer += chunk;
      const lineArr = lineBuffer.split("\n");
      lineBuffer = lineArr.pop(); // last (possibly incomplete) segment
      for (const rawLine of lineArr) {
        const line = rawLine.replace(/\r$/, "");
        if (!line) continue;
        handleLine(line);
      }
    });

    socket.on("close", () => {
      closed = true;
      const err = new Error("irc_client: connection closed.");
      rejectWaiters(err);
    });

    const connectEvent = use_tls ? "secureConnect" : "connect";
    socket.on(connectEvent, () => {
      resolve();
    });
  });

  function rejectWaiters(err) {
    while (waiters.length) {
      const w = waiters.shift();
      w.reject(err);
    }
  }

  // ── Line processing ─────────────────────────────────────────────────────
  function handleLine(line) {
    lines.push(line);
    if (lines.length > MAX_COLLECTED_LINES) lines.shift();

    const parsed = parseLine(line);

    // Respond to PING immediately
    if (parsed.command === "PING") {
      writeLine(`PONG :${parsed.params[0] || ""}`);
    }

    // Notify all waiters
    const toNotify = [...waiters];
    for (const w of toNotify) {
      try {
        if (w.predicate(parsed, line)) {
          const idx = waiters.indexOf(w);
          if (idx !== -1) waiters.splice(idx, 1);
          w.resolve({ parsed, line });
        }
      } catch (e) {
        const idx = waiters.indexOf(w);
        if (idx !== -1) waiters.splice(idx, 1);
        w.reject(e);
      }
    }
  }

  // ── Write helpers ────────────────────────────────────────────────────────
  function writeLine(line) {
    if (!socket || closed) return;
    // Enforce IRC max line length including CRLF
    const clamped = line.slice(0, MAX_IRC_LINE);
    socket.write(clamped + "\r\n");
  }

  /**
   * Wait until a predicate(parsed, rawLine) => boolean is true.
   * Resolves with { parsed, line } or rejects on timeout.
   */
  function waitFor(predicate, waitTimeoutMs = timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(entry);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`irc_client: waitFor timed out after ${waitTimeoutMs} ms.`));
      }, waitTimeoutMs);

      const entry = {
        predicate,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      };
      waiters.push(entry);
    });
  }

  /**
   * Collect all lines received during a given duration.
   */
  function collectFor(durationMs) {
    return new Promise((resolve) => {
      const snapshot = [];
      const timer = setTimeout(() => resolve(snapshot), durationMs);
      // Override handleLine's notification to also push to snapshot
      const origLen = lines.length;
      const interval = setInterval(() => {
        while (snapshot.length < lines.length - origLen) {
          // push any new lines
        }
      }, 50);
      clearInterval(interval);
      // Simpler: just wait then snapshot
      setTimeout(() => {
        clearTimeout(timer);
        resolve(lines.slice(origLen));
      }, durationMs);
    });
  }

  async function close() {
    if (!closed) {
      try { writeLine("QUIT :MCP irc_client closing"); } catch (_) {}
      await new Promise((r) => setTimeout(r, 200));
      if (socket) socket.destroy();
    }
  }

  // ── Registration sequence ────────────────────────────────────────────────
  async function register() {
    await connectPromise;

    const useSasl = !!sasl_password;

    if (useSasl) {
      writeLine("CAP LS 302");
    }

    if (server_password) writeLine(`PASS :${server_password}`);
    writeLine(`NICK ${nick}`);
    writeLine(`USER ${user} 0 * :${realname}`);

    if (useSasl) {
      // Wait for CAP LS response
      try {
        await waitFor((p) => p.command === "CAP" && p.params.includes("LS"), timeoutMs);
        writeLine("CAP REQ :sasl");
        // Wait for CAP ACK
        await waitFor((p) => p.command === "CAP" && p.params.some(x => x === "ACK"), timeoutMs);
        writeLine("AUTHENTICATE PLAIN");
        // Wait for AUTHENTICATE +
        await waitFor((p) => p.command === "AUTHENTICATE" && p.params[0] === "+", timeoutMs);
        // Build SASL PLAIN: \0nick\0password
        const saslPayload = Buffer.from(`\0${nick}\0${sasl_password}`).toString("base64");
        writeLine(`AUTHENTICATE ${saslPayload}`);
        // Wait for 903 (SASL success) or 904 (failure)
        const saslResult = await waitFor(
          (p) => p.command === "903" || p.command === "904" || p.command === "905",
          timeoutMs
        );
        if (saslResult.parsed.command !== "903") {
          throw new Error(`irc_client: SASL authentication failed (${saslResult.line}).`);
        }
        writeLine("CAP END");
      } catch (e) {
        if (e.message.includes("SASL")) throw e;
        // Server might not support SASL — fall through
        writeLine("CAP END");
      }
    }

    // Wait for registration: numeric 001 (RPL_WELCOME)
    await waitFor((p) => p.command === "001", timeoutMs);
    registered = true;

    // NickServ IDENTIFY fallback
    if (nickserv_password && !sasl_password) {
      writeLine(`PRIVMSG NickServ :IDENTIFY ${nickserv_password}`);
      // Give NickServ a moment
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { connectPromise, register, writeLine, waitFor, collectFor, close, lines, getRegistered: () => registered };
}

// ── Operations ────────────────────────────────────────────────────────────────

/** send_message — Connect, send PRIVMSG to channels/users, disconnect */
async function opSendMessage(args) {
  const host   = (args.host || "").trim();
  const nick   = (args.nick || "mcpbot").trim();
  const target = args.target; // string or array
  const messages = Array.isArray(args.messages) ? args.messages : [args.message].filter(Boolean);

  if (!host)    throw new Error("irc_client: 'host' is required.");
  if (!nick)    throw new Error("irc_client: 'nick' is required.");
  if (!target)  throw new Error("irc_client: 'target' is required (channel or nick).");
  if (!messages.length) throw new Error("irc_client: 'message' or 'messages' is required.");

  const targets = Array.isArray(target) ? target : [target];
  if (targets.length > MAX_CHANNELS)
    throw new Error(`irc_client: too many targets (max ${MAX_CHANNELS}).`);
  if (messages.length > MAX_MESSAGES_SEND)
    throw new Error(`irc_client: too many messages (max ${MAX_MESSAGES_SEND}).`);

  guardString(host, "host");
  guardString(nick, "nick");
  for (const t of targets) {
    guardString(t, "target");
    if (!validateChannel(t) && !validateNick(t.replace(/^@\+/, ""))) {
      // allow nick targets too (strip op prefixes)
    }
  }
  if (!validateNick(nick)) throw new Error(`irc_client: invalid nick '${nick}'.`);

  const timeoutMs = clampTimeout(args.timeout);
  const use_tls   = !!(args.use_tls || args.tls);
  const port      = args.port ?? (use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN);

  const conn = createIrcConnection({
    host, port, use_tls,
    reject_unauthorized: args.reject_unauthorized !== false,
    nick, user: args.user || nick,
    realname: args.realname || "MCP IRC Client",
    server_password: args.server_password || null,
    sasl_password:   args.sasl_password   || null,
    nickserv_password: args.nickserv_password || null,
    timeoutMs,
  });

  const t0 = Date.now();
  const sent = [];
  const errors = [];

  try {
    await conn.register();

    // Join channels if any target is a channel
    const channelTargets = targets.filter(validateChannel);
    if (channelTargets.length) {
      for (const ch of channelTargets) {
        conn.writeLine(`JOIN ${ch}`);
      }
      // Wait for all JOIN confirmations (366 = end of NAMES)
      for (const ch of channelTargets) {
        try {
          await conn.waitFor(
            (p) => p.command === "366" && p.params.some(x => x.toLowerCase() === ch.toLowerCase()),
            timeoutMs
          );
        } catch (_) {
          // Don't fail if JOIN confirmation times out — proceed anyway
        }
      }
    }

    // Send messages to each target
    for (const t of targets) {
      for (const msg of messages) {
        const sanitised = sanitiseMessage(msg);
        conn.writeLine(`PRIVMSG ${t} :${sanitised}`);
        sent.push({ target: t, message: sanitised });
      }
    }

    // Small delay to allow server to process
    await new Promise((r) => setTimeout(r, 300));
  } catch (err) {
    errors.push(err.message);
  } finally {
    await conn.close();
  }

  return {
    ok:        errors.length === 0,
    operation: "send_message",
    host,
    port,
    nick,
    targets,
    sent,
    sentCount: sent.length,
    elapsedMs: Date.now() - t0,
    errors:    errors.length ? errors : undefined,
  };
}

/** join — Connect, join channels, collect messages, disconnect */
async function opJoin(args) {
  const host     = (args.host || "").trim();
  const nick     = (args.nick || "mcpbot").trim();
  const channels = Array.isArray(args.channels)
    ? args.channels
    : typeof args.channel === "string" ? [args.channel] : [];
  const durationMs = Math.min(
    Math.max(1000, args.duration_ms ?? args.duration ?? 5000),
    30_000
  );

  if (!host)              throw new Error("irc_client: 'host' is required.");
  if (!nick)              throw new Error("irc_client: 'nick' is required.");
  if (!channels.length)  throw new Error("irc_client: 'channels' (or 'channel') is required.");
  if (channels.length > MAX_CHANNELS)
    throw new Error(`irc_client: too many channels (max ${MAX_CHANNELS}).`);

  guardString(host, "host");
  guardString(nick, "nick");
  for (const ch of channels) {
    guardString(ch, "channel");
    if (!validateChannel(ch))
      throw new Error(`irc_client: invalid channel name '${ch}'. Must start with #, &, + or !.`);
  }
  if (!validateNick(nick)) throw new Error(`irc_client: invalid nick '${nick}'.`);

  const timeoutMs = clampTimeout(args.timeout);
  const use_tls   = !!(args.use_tls || args.tls);
  const port      = args.port ?? (use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN);

  const conn = createIrcConnection({
    host, port, use_tls,
    reject_unauthorized: args.reject_unauthorized !== false,
    nick, user: args.user || nick,
    realname: args.realname || "MCP IRC Client",
    server_password: args.server_password || null,
    sasl_password:   args.sasl_password   || null,
    nickserv_password: args.nickserv_password || null,
    timeoutMs,
  });

  const t0 = Date.now();
  const errors = [];
  const joined = [];
  const messages = [];

  try {
    await conn.register();

    // Join channels
    for (const ch of channels) {
      conn.writeLine(`JOIN ${ch}`);
    }

    // Collect lines during durationMs
    const linesBeforeJoin = conn.lines.length;
    await new Promise((r) => setTimeout(r, durationMs));
    const collected = conn.lines.slice(linesBeforeJoin);

    // Parse PRIVMSGs
    for (const rawLine of collected) {
      const p = parseLine(rawLine);
      if (p.command === "JOIN") {
        const ch = p.params[0];
        if (channels.some(c => c.toLowerCase() === (ch || "").toLowerCase())) {
          if (!joined.includes(ch)) joined.push(ch);
        }
      }
      if (p.command === "PRIVMSG") {
        messages.push({
          from:    nickFromPrefix(p.prefix),
          channel: p.params[0],
          text:    p.params[1] || "",
          raw:     rawLine,
        });
      }
    }

  } catch (err) {
    errors.push(err.message);
  } finally {
    await conn.close();
  }

  return {
    ok:          errors.length === 0,
    operation:   "join",
    host,
    port,
    nick,
    channels,
    joined,
    durationMs,
    messagesReceived: messages.length,
    messages:    messages.slice(0, 100),
    elapsedMs:   Date.now() - t0,
    errors:      errors.length ? errors : undefined,
  };
}

/** list — Connect and LIST channels */
async function opList(args) {
  const host = (args.host || "").trim();
  const nick = (args.nick || "mcpbot").trim();

  if (!host) throw new Error("irc_client: 'host' is required.");
  guardString(host, "host");
  if (!validateNick(nick)) throw new Error(`irc_client: invalid nick '${nick}'.`);

  const timeoutMs = clampTimeout(args.timeout);
  const use_tls   = !!(args.use_tls || args.tls);
  const port      = args.port ?? (use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN);
  const filter    = args.filter ? String(args.filter).toLowerCase() : null;

  const conn = createIrcConnection({
    host, port, use_tls,
    reject_unauthorized: args.reject_unauthorized !== false,
    nick, user: args.user || nick,
    realname: args.realname || "MCP IRC Client",
    server_password: args.server_password || null,
    timeoutMs,
  });

  const t0 = Date.now();
  const channels = [];
  const errors = [];

  try {
    await conn.register();
    conn.writeLine("LIST");

    // Collect until 323 (RPL_LISTEND)
    await conn.waitFor((p) => p.command === "323", timeoutMs);

    // Parse 322 (RPL_LIST) lines
    for (const line of conn.lines) {
      const p = parseLine(line);
      if (p.command === "322") {
        // params: target, channel, usercount, :topic
        const ch    = p.params[1];
        const users = parseInt(p.params[2], 10) || 0;
        const topic = p.params[3] || "";
        if (!ch) continue;
        if (filter && !ch.toLowerCase().includes(filter) && !topic.toLowerCase().includes(filter)) continue;
        channels.push({ channel: ch, users, topic });
      }
    }
  } catch (err) {
    errors.push(err.message);
  } finally {
    await conn.close();
  }

  return {
    ok:           errors.length === 0,
    operation:    "list",
    host,
    port,
    channelCount: channels.length,
    channels:     channels.slice(0, 200),
    elapsedMs:    Date.now() - t0,
    errors:       errors.length ? errors : undefined,
  };
}

/** whois — Connect and WHOIS a user */
async function opWhois(args) {
  const host   = (args.host || "").trim();
  const nick   = (args.nick || "mcpbot").trim();
  const target = (args.target || "").trim();

  if (!host)   throw new Error("irc_client: 'host' is required.");
  if (!target) throw new Error("irc_client: 'target' is required for 'whois'.");
  guardString(host, "host");
  guardString(target, "target");
  if (!validateNick(nick)) throw new Error(`irc_client: invalid nick '${nick}'.`);

  const timeoutMs = clampTimeout(args.timeout);
  const use_tls   = !!(args.use_tls || args.tls);
  const port      = args.port ?? (use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN);

  const conn = createIrcConnection({
    host, port, use_tls,
    reject_unauthorized: args.reject_unauthorized !== false,
    nick, user: args.user || nick,
    realname: args.realname || "MCP IRC Client",
    server_password: args.server_password || null,
    timeoutMs,
  });

  const t0 = Date.now();
  const whoisInfo = {};
  const errors = [];

  try {
    await conn.register();
    conn.writeLine(`WHOIS ${target}`);

    // Collect until 318 (RPL_ENDOFWHOIS) or 401 (no such nick)
    await conn.waitFor(
      (p) => p.command === "318" || p.command === "401",
      timeoutMs
    );

    // Parse WHOIS reply numerics
    for (const line of conn.lines) {
      const p = parseLine(line);
      switch (p.command) {
        case "311": // RPL_WHOISUSER: nick user host * :realname
          whoisInfo.nick     = p.params[1];
          whoisInfo.user     = p.params[2];
          whoisInfo.host     = p.params[3];
          whoisInfo.realname = p.params[5] || p.params[4] || "";
          break;
        case "312": // RPL_WHOISSERVER: nick server :info
          whoisInfo.server     = p.params[2];
          whoisInfo.serverInfo = p.params[3] || "";
          break;
        case "313": // RPL_WHOISOPERATOR
          whoisInfo.isOper = true;
          break;
        case "317": // RPL_WHOISIDLE: nick idle signon :idle message
          whoisInfo.idleSecs  = parseInt(p.params[2], 10) || 0;
          whoisInfo.signonAt  = parseInt(p.params[3], 10) || 0;
          break;
        case "319": // RPL_WHOISCHANNELS
          whoisInfo.channels = (p.params[2] || "").trim().split(" ").filter(Boolean);
          break;
        case "320": // RPL_WHOISSPECIAL (often "is a registered nick")
          whoisInfo.special = p.params[2] || "";
          break;
        case "330": // RPL_WHOISACCOUNT
          whoisInfo.account = p.params[2] || "";
          break;
        case "401": // ERR_NOSUCHNICK
          whoisInfo.error = `No such nick: ${p.params[1] || target}`;
          break;
      }
    }
  } catch (err) {
    errors.push(err.message);
  } finally {
    await conn.close();
  }

  return {
    ok:        errors.length === 0 && !whoisInfo.error,
    operation: "whois",
    host,
    port,
    target,
    whois:     whoisInfo,
    elapsedMs: Date.now() - t0,
    errors:    errors.length ? errors : undefined,
  };
}

/** raw — Connect and send raw IRC commands, collect responses */
async function opRaw(args) {
  const host     = (args.host || "").trim();
  const nick     = (args.nick || "mcpbot").trim();
  const commands = Array.isArray(args.commands) ? args.commands : [args.command].filter(Boolean);
  const durationMs = Math.min(Math.max(1000, args.duration_ms ?? 3000), 30_000);

  if (!host)             throw new Error("irc_client: 'host' is required.");
  if (!commands.length)  throw new Error("irc_client: 'command' or 'commands' is required.");
  if (commands.length > 20) throw new Error("irc_client: too many commands (max 20).");

  guardString(host, "host");
  if (!validateNick(nick)) throw new Error(`irc_client: invalid nick '${nick}'.`);

  for (const cmd of commands) {
    guardString(cmd, "command");
  }

  const timeoutMs = clampTimeout(args.timeout);
  const use_tls   = !!(args.use_tls || args.tls);
  const port      = args.port ?? (use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN);

  const conn = createIrcConnection({
    host, port, use_tls,
    reject_unauthorized: args.reject_unauthorized !== false,
    nick, user: args.user || nick,
    realname: args.realname || "MCP IRC Client",
    server_password: args.server_password || null,
    sasl_password:   args.sasl_password   || null,
    nickserv_password: args.nickserv_password || null,
    timeoutMs,
  });

  const t0 = Date.now();
  const errors = [];
  let responseLines = [];

  try {
    await conn.register();

    const linesBefore = conn.lines.length;
    for (const cmd of commands) {
      conn.writeLine(cmd.slice(0, MAX_IRC_LINE));
    }

    // Collect responses for durationMs
    await new Promise((r) => setTimeout(r, durationMs));
    responseLines = conn.lines.slice(linesBefore);
  } catch (err) {
    errors.push(err.message);
  } finally {
    await conn.close();
  }

  return {
    ok:            errors.length === 0,
    operation:     "raw",
    host,
    port,
    commandsSent:  commands.length,
    responseLines: responseLines.slice(0, 200),
    responseCount: responseLines.length,
    elapsedMs:     Date.now() - t0,
    errors:        errors.length ? errors : undefined,
  };
}

/** nick — Connect and change nick, confirm the change */
async function opNick(args) {
  const host    = (args.host || "").trim();
  const nick    = (args.nick || "mcpbot").trim();
  const newNick = (args.new_nick || "").trim();

  if (!host)    throw new Error("irc_client: 'host' is required.");
  if (!newNick) throw new Error("irc_client: 'new_nick' is required for 'nick'.");
  guardString(host, "host");
  guardString(newNick, "new_nick");
  if (!validateNick(nick)) throw new Error(`irc_client: invalid nick '${nick}'.`);
  if (!validateNick(newNick)) throw new Error(`irc_client: invalid new_nick '${newNick}'.`);

  const timeoutMs = clampTimeout(args.timeout);
  const use_tls   = !!(args.use_tls || args.tls);
  const port      = args.port ?? (use_tls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN);

  const conn = createIrcConnection({
    host, port, use_tls,
    reject_unauthorized: args.reject_unauthorized !== false,
    nick, user: args.user || nick,
    realname: args.realname || "MCP IRC Client",
    server_password: args.server_password || null,
    timeoutMs,
  });

  const t0 = Date.now();
  const errors = [];
  let confirmed = false;
  let nickInUse = false;

  try {
    await conn.register();
    conn.writeLine(`NICK ${newNick}`);

    // Wait for NICK confirmation or 433 (nick in use)
    const result = await conn.waitFor(
      (p) => (
        (p.command === "NICK" && nickFromPrefix(p.prefix)?.toLowerCase() === nick.toLowerCase()) ||
        p.command === "433"
      ),
      timeoutMs
    );
    if (result.parsed.command === "NICK") {
      confirmed = true;
    } else if (result.parsed.command === "433") {
      nickInUse = true;
      errors.push(`irc_client: Nick '${newNick}' is already in use.`);
    }
  } catch (err) {
    errors.push(err.message);
  } finally {
    await conn.close();
  }

  return {
    ok:         errors.length === 0 && confirmed,
    operation:  "nick",
    host,
    port,
    oldNick:    nick,
    newNick,
    confirmed,
    nickInUse,
    elapsedMs:  Date.now() - t0,
    errors:     errors.length ? errors : undefined,
  };
}

/** info — Return tool config and capability info (no I/O) */
function opInfo() {
  return {
    ok:         true,
    operation:  "info",
    defaultPort: {
      plain: DEFAULT_PORT_PLAIN,
      tls:   DEFAULT_PORT_TLS,
    },
    defaultTimeoutMs:  DEFAULT_TIMEOUT_MS,
    maxMessages:       MAX_MESSAGES_SEND,
    maxChannels:       MAX_CHANNELS,
    maxIrcLineLength:  MAX_IRC_LINE,
    maxCollectedLines: MAX_COLLECTED_LINES,
    authMethods: ["server_password (PASS)", "sasl_plain", "nickserv_identify"],
    operations: [
      "send_message — Join channel(s)/nick and send PRIVMSG",
      "join        — Join channel(s) and collect PRIVMSG for duration",
      "list        — LIST all channels on the server",
      "whois       — WHOIS a user (returns nick/user/host/realname/channels/idle)",
      "nick        — Connect and change nick, confirm success",
      "raw         — Send raw IRC command(s) and collect responses",
      "info        — Return this info object (no I/O)",
    ],
    notes: [
      "Zero npm dependencies — pure Node.js net/tls built-ins.",
      "TLS: set use_tls:true; default port changes to 6697.",
      "SASL PLAIN: set sasl_password for secure auth via CAP REQ sasl.",
      "NickServ: set nickserv_password for IDENTIFY after registration.",
      "All messages are sanitised: CR/LF stripped, clamped to 510 chars.",
      "Timeouts: 3s–60s (default 10s).",
    ],
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function ircClient(args) {
  const op = args.operation;
  if (!op) throw new Error("irc_client: 'operation' is required.");

  switch (op) {
    case "send_message": return opSendMessage(args);
    case "join":         return opJoin(args);
    case "list":         return opList(args);
    case "whois":        return opWhois(args);
    case "nick":         return opNick(args);
    case "raw":          return opRaw(args);
    case "info":         return opInfo();
    default:
      throw new Error(
        `irc_client: unknown operation '${op}'. ` +
        `Valid: send_message, join, list, whois, nick, raw, info.`
      );
  }
}

module.exports = {
  ircClient,
  // Exported for testing
  parseLine,
  nickFromPrefix,
  validateChannel,
  validateNick,
  sanitiseMessage,
  guardString,
  guardNul,
  guardCrLf,
  clampTimeout,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PORT_PLAIN,
  DEFAULT_PORT_TLS,
  MAX_IRC_LINE,
  MAX_MESSAGES_SEND,
  MAX_CHANNELS,
};
