"use strict";
// lib/memcachedClientOps.js — Zero-dependency Memcached client
// Uses Node.js built-in `net` only. No npm dependencies.
//
// Implements the Memcached text protocol (ASCII protocol) as documented in
// https://github.com/memcached/memcached/blob/master/doc/protocol.txt
//
// Supported operations:
//   get          — retrieve one or more keys (multi-get supported)
//   set          — store a value (unconditional)
//   add          — store only if key does NOT exist
//   replace      — store only if key DOES exist
//   append       — append data to existing value
//   prepend      — prepend data to existing value
//   delete       — remove a key
//   increment    — atomically increment a numeric value
//   decrement    — atomically decrement a numeric value
//   flush_all    — invalidate all items (optional delay)
//   stats        — retrieve server statistics
//   version      — retrieve server version string

const net = require("net");

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_KEY_LENGTH     = 250;              // Memcached spec: 250 bytes max
const MAX_VALUE_SIZE     = 1024 * 1024;      // 1 MB default value cap
const MAX_RESPONSE_SIZE  = 32 * 1024 * 1024; // 32 MB total response cap
const DEFAULT_TIMEOUT    = 30_000;           // ms
const DEFAULT_CONNECT_TO = 10_000;           // ms

// Memcached error response prefixes
const ERROR_PREFIXES = ["ERROR", "CLIENT_ERROR", "SERVER_ERROR"];

// ─── Security Guards ─────────────────────────────────────────────────────────

/**
 * Validate a Memcached key: no whitespace, no control chars, no NUL/CRLF,
 * max 250 bytes, must be non-empty.
 */
function validateKey(key) {
  if (typeof key !== "string" || key.length === 0)
    throw new Error("memcached_client: key must be a non-empty string.");
  if (key.length > MAX_KEY_LENGTH)
    throw new Error(`memcached_client: key too long (${key.length} chars; max ${MAX_KEY_LENGTH}).`);
  // Keys cannot contain whitespace or control characters (Memcached protocol)
  if (/[\x00-\x20\x7f]/.test(key))
    throw new Error("memcached_client: key must not contain whitespace or control characters (including NUL/CR/LF/space).");
}

/**
 * Validate a value for storage. Accept strings or numbers; return Buffer.
 */
function coerceValue(value) {
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) {
    if (value.length > MAX_VALUE_SIZE)
      throw new Error(`memcached_client: value too large (${value.length} bytes; max ${MAX_VALUE_SIZE}).`);
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint")
    value = String(value);
  if (typeof value !== "string")
    throw new Error("memcached_client: value must be a string.");
  const buf = Buffer.from(value, "utf8");
  if (buf.length > MAX_VALUE_SIZE)
    throw new Error(`memcached_client: value too large (${buf.length} bytes; max ${MAX_VALUE_SIZE}).`);
  return buf;
}

/**
 * Validate flags (0–65535 integer, stored in the protocol header).
 */
function validateFlags(flags) {
  if (flags === undefined || flags === null) return 0;
  const n = Number(flags);
  if (!Number.isInteger(n) || n < 0 || n > 65535)
    throw new Error("memcached_client: flags must be an integer 0–65535.");
  return n;
}

/**
 * Validate exptime (0 = never, positive = TTL in seconds, up to 30 days or
 * Unix timestamp for longer values). Memcached allows 0–2147483647.
 */
function validateExptime(exptime) {
  if (exptime === undefined || exptime === null) return 0;
  const n = Number(exptime);
  if (!Number.isInteger(n) || n < 0 || n > 2_147_483_647)
    throw new Error("memcached_client: exptime must be an integer 0–2147483647.");
  return n;
}

/**
 * Validate delta for incr/decr (non-negative integer).
 */
function validateDelta(delta) {
  if (delta === undefined || delta === null) return 1;
  const n = Number(delta);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
    throw new Error("memcached_client: delta must be a non-negative integer.");
  return n;
}

// ─── TCP Connection Helper ────────────────────────────────────────────────────

/**
 * Open a TCP connection to host:port, send `request` (Buffer or string),
 * and collect the response until `isDone(chunk, accumulated)` returns true
 * or a timeout fires.
 *
 * Returns the full accumulated Buffer.
 */
function tcpRequest(host, port, request, isDone, opts) {
  const timeout        = opts.timeout        || DEFAULT_TIMEOUT;
  const connectTimeout = opts.connectTimeout  || Math.min(timeout, DEFAULT_CONNECT_TO);

  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let accumulated  = Buffer.alloc(0);
    let settled      = false;
    let connectTimer = null;
    let globalTimer  = null;

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(globalTimer);
      sock.destroy();
      if (err) reject(err);
      else     resolve(result);
    }

    connectTimer = setTimeout(() => {
      settle(new Error(`memcached_client: connect timeout after ${connectTimeout}ms (${host}:${port}).`));
    }, connectTimeout);

    sock.connect(port, host, () => {
      clearTimeout(connectTimer);
      connectTimer = null;

      globalTimer = setTimeout(() => {
        settle(new Error(`memcached_client: operation timeout after ${timeout}ms.`));
      }, timeout);

      // Send request
      const reqBuf = Buffer.isBuffer(request) ? request : Buffer.from(request, "utf8");
      sock.write(reqBuf);
    });

    sock.on("data", (chunk) => {
      accumulated = Buffer.concat([accumulated, chunk]);
      if (accumulated.length > MAX_RESPONSE_SIZE) {
        settle(new Error(`memcached_client: response too large (>${MAX_RESPONSE_SIZE} bytes).`));
        return;
      }
      if (isDone(chunk, accumulated)) {
        settle(null, accumulated);
      }
    });

    sock.on("error", (err) => settle(new Error(`memcached_client: socket error — ${err.message}`)));
    sock.on("close", () => {
      // Server closed connection (e.g. after flush_all on some versions)
      if (!settled) settle(null, accumulated);
    });
  });
}

// ─── Response Parsers ─────────────────────────────────────────────────────────

/**
 * Parse VALUE blocks from a GET multi-value response.
 * Format per item:
 *   VALUE <key> <flags> <bytes> [<cas>]\r\n
 *   <data block — exactly <bytes> bytes>\r\n
 *   ...
 *   END\r\n
 */
function parseGetResponse(raw) {
  const text  = raw.toString("utf8");
  const items = [];
  let pos = 0;

  while (pos < text.length) {
    const lineEnd = text.indexOf("\r\n", pos);
    if (lineEnd === -1) break;
    const line = text.slice(pos, lineEnd);
    pos = lineEnd + 2; // advance past \r\n

    if (line === "END") break;

    // Check for server error responses
    for (const prefix of ERROR_PREFIXES) {
      if (line.startsWith(prefix))
        throw new Error(`memcached_client: server error — ${line}`);
    }

    if (line.startsWith("VALUE ")) {
      const parts = line.split(" ");
      // VALUE <key> <flags> <bytes> [<cas>]
      const key   = parts[1];
      const flags = parseInt(parts[2], 10);
      const bytes = parseInt(parts[3], 10);
      const cas   = parts[4] !== undefined ? parts[4] : undefined;

      // Read exactly `bytes` bytes from the current position
      const value = text.slice(pos, pos + bytes);
      pos += bytes + 2; // skip the data bytes + trailing \r\n

      items.push({ key, flags, bytes, value, cas });
    }
  }
  return items;
}

/**
 * Parse a simple single-line response (STORED, NOT_STORED, DELETED, OK, etc.)
 */
function parseSingleLineResponse(raw) {
  const text = raw.toString("utf8").trim();
  for (const prefix of ERROR_PREFIXES) {
    if (text.startsWith(prefix))
      throw new Error(`memcached_client: server error — ${text}`);
  }
  return text;
}

/**
 * Parse stats response.
 * Format:
 *   STAT <name> <value>\r\n
 *   ...
 *   END\r\n
 */
function parseStatsResponse(raw) {
  const text  = raw.toString("utf8");
  const lines = text.split("\r\n");
  const stats = {};

  for (const line of lines) {
    if (line === "END" || line === "") continue;
    for (const prefix of ERROR_PREFIXES) {
      if (line.startsWith(prefix))
        throw new Error(`memcached_client: server error — ${line}`);
    }
    if (line.startsWith("STAT ")) {
      const parts = line.split(" ");
      // STAT <name> <value>
      const name  = parts[1];
      const value = parts.slice(2).join(" ");
      // Try numeric coercion for numeric-looking values
      const num = Number(value);
      stats[name] = Number.isFinite(num) && String(num) === value ? num : value;
    }
  }
  return stats;
}

// ─── "isDone" Predicates ──────────────────────────────────────────────────────

/** For GET: done when accumulated text ends with "END\r\n" */
function isDoneGet(_, acc) {
  const END = Buffer.from("END\r\n");
  if (acc.length < END.length) return false;
  return acc.slice(-END.length).equals(END);
}

/** For single-line responses: done when a \r\n appears */
function isDoneSingleLine(_, acc) {
  return acc.includes(Buffer.from("\r\n"));
}

/** For STATS: same as GET — ends with "END\r\n" */
const isDoneStats = isDoneGet;

// ─── Public API ───────────────────────────────────────────────────────────────

async function memcachedClient(args) {
  const host    = args.host    ?? "127.0.0.1";
  const port    = args.port    ?? 11211;
  const op      = args.operation;
  const timeout = ((args.timeout != null) ? args.timeout : 30) * 1000; // seconds → ms
  const connectTimeout = (args.connect_timeout != null)
    ? args.connect_timeout * 1000
    : Math.min(timeout, DEFAULT_CONNECT_TO);

  const tcpOpts = { timeout, connectTimeout };

  // ── Validate host ──────────────────────────────────────────────────────────
  if (typeof host !== "string" || host.length === 0)
    throw new Error("memcached_client: 'host' must be a non-empty string.");
  if (/[\x00\r\n]/.test(host))
    throw new Error("memcached_client: 'host' contains invalid characters (NUL/CR/LF).");
  if (host.length > 253)
    throw new Error("memcached_client: 'host' too long (max 253 chars).");

  // ── Validate port ──────────────────────────────────────────────────────────
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("memcached_client: 'port' must be an integer 1–65535.");

  // ─────────────────────────────────────────────────────────────────────────
  // OPERATION DISPATCH
  // ─────────────────────────────────────────────────────────────────────────

  switch (op) {

    // ── GET ────────────────────────────────────────────────────────────────
    case "get": {
      // 'keys' array takes priority over single 'key'; empty key string must still be validated.
      const useArray = Array.isArray(args.keys);
      const keys = useArray
        ? args.keys
        : (args.key !== undefined && args.key !== null ? [args.key] : []);
      if (keys.length === 0)
        throw new Error("memcached_client get: provide 'key' (string) or 'keys' (array).");
      if (keys.length > 100)
        throw new Error("memcached_client get: too many keys (max 100 per request).");
      keys.forEach(validateKey);

      const request = `get ${keys.join(" ")}\r\n`;
      const raw     = await tcpRequest(host, port, request, isDoneGet, tcpOpts);
      const items   = parseGetResponse(raw);

      // Single-key shorthand ('key' param, not 'keys' array) → flat result
      if (!useArray && keys.length === 1) {
        const item = items.find(i => i.key === keys[0]);
        if (!item) return { key: keys[0], found: false, value: null, flags: null };
        return { key: item.key, found: true, value: item.value, flags: item.flags };
      }
      // Multi-get result (always a result map when 'keys' array was given)
      const result = {};
      for (const k of keys) {
        const item = items.find(i => i.key === k);
        result[k] = item
          ? { found: true,  value: item.value, flags: item.flags }
          : { found: false, value: null,        flags: null       };
      }
      return { keys, found: items.length, result };
    }

    // ── SET ───────────────────────────────────────────────────────────────
    case "set": {
      validateKey(args.key);
      const flags   = validateFlags(args.flags);
      const exptime = validateExptime(args.exptime);
      const value   = coerceValue(args.value);
      const cmd     = `set ${args.key} ${flags} ${exptime} ${value.length}\r\n`;
      const request = Buffer.concat([
        Buffer.from(cmd, "utf8"),
        value,
        Buffer.from("\r\n", "utf8"),
      ]);
      const raw  = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp = parseSingleLineResponse(raw);
      return { key: args.key, stored: resp === "STORED", response: resp };
    }

    // ── ADD ───────────────────────────────────────────────────────────────
    case "add": {
      validateKey(args.key);
      const flags   = validateFlags(args.flags);
      const exptime = validateExptime(args.exptime);
      const value   = coerceValue(args.value);
      const cmd     = `add ${args.key} ${flags} ${exptime} ${value.length}\r\n`;
      const request = Buffer.concat([
        Buffer.from(cmd, "utf8"),
        value,
        Buffer.from("\r\n", "utf8"),
      ]);
      const raw  = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp = parseSingleLineResponse(raw);
      return { key: args.key, stored: resp === "STORED", response: resp };
    }

    // ── REPLACE ───────────────────────────────────────────────────────────
    case "replace": {
      validateKey(args.key);
      const flags   = validateFlags(args.flags);
      const exptime = validateExptime(args.exptime);
      const value   = coerceValue(args.value);
      const cmd     = `replace ${args.key} ${flags} ${exptime} ${value.length}\r\n`;
      const request = Buffer.concat([
        Buffer.from(cmd, "utf8"),
        value,
        Buffer.from("\r\n", "utf8"),
      ]);
      const raw  = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp = parseSingleLineResponse(raw);
      return { key: args.key, stored: resp === "STORED", response: resp };
    }

    // ── APPEND ────────────────────────────────────────────────────────────
    case "append": {
      validateKey(args.key);
      const value   = coerceValue(args.value);
      const cmd     = `append ${args.key} 0 0 ${value.length}\r\n`;
      const request = Buffer.concat([
        Buffer.from(cmd, "utf8"),
        value,
        Buffer.from("\r\n", "utf8"),
      ]);
      const raw  = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp = parseSingleLineResponse(raw);
      return { key: args.key, stored: resp === "STORED", response: resp };
    }

    // ── PREPEND ───────────────────────────────────────────────────────────
    case "prepend": {
      validateKey(args.key);
      const value   = coerceValue(args.value);
      const cmd     = `prepend ${args.key} 0 0 ${value.length}\r\n`;
      const request = Buffer.concat([
        Buffer.from(cmd, "utf8"),
        value,
        Buffer.from("\r\n", "utf8"),
      ]);
      const raw  = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp = parseSingleLineResponse(raw);
      return { key: args.key, stored: resp === "STORED", response: resp };
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    case "delete": {
      validateKey(args.key);
      const request = `delete ${args.key}\r\n`;
      const raw     = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp    = parseSingleLineResponse(raw);
      return { key: args.key, deleted: resp === "DELETED", response: resp };
    }

    // ── INCREMENT ─────────────────────────────────────────────────────────
    case "increment": {
      validateKey(args.key);
      const delta   = validateDelta(args.delta);
      const request = `incr ${args.key} ${delta}\r\n`;
      const raw     = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp    = parseSingleLineResponse(raw);
      if (resp === "NOT_FOUND")
        return { key: args.key, found: false, value: null, response: resp };
      const newValue = parseInt(resp, 10);
      return { key: args.key, found: true, value: newValue, response: resp };
    }

    // ── DECREMENT ─────────────────────────────────────────────────────────
    case "decrement": {
      validateKey(args.key);
      const delta   = validateDelta(args.delta);
      const request = `decr ${args.key} ${delta}\r\n`;
      const raw     = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp    = parseSingleLineResponse(raw);
      if (resp === "NOT_FOUND")
        return { key: args.key, found: false, value: null, response: resp };
      const newValue = parseInt(resp, 10);
      return { key: args.key, found: true, value: newValue, response: resp };
    }

    // ── FLUSH_ALL ─────────────────────────────────────────────────────────
    case "flush_all": {
      const delay = (args.delay != null) ? Number(args.delay) : 0;
      if (!Number.isInteger(delay) || delay < 0)
        throw new Error("memcached_client flush_all: 'delay' must be a non-negative integer (seconds).");
      const request = delay > 0 ? `flush_all ${delay}\r\n` : `flush_all\r\n`;
      const raw     = await tcpRequest(host, port, request, isDoneSingleLine, tcpOpts);
      const resp    = parseSingleLineResponse(raw);
      return { flushed: resp === "OK", response: resp, delay };
    }

    // ── STATS ─────────────────────────────────────────────────────────────
    case "stats": {
      const subcommand = args.subcommand || "";
      const request    = subcommand ? `stats ${subcommand}\r\n` : `stats\r\n`;
      const raw        = await tcpRequest(host, port, request, isDoneStats, tcpOpts);
      const stats      = parseStatsResponse(raw);
      return { subcommand: subcommand || "general", statCount: Object.keys(stats).length, stats };
    }

    // ── VERSION ───────────────────────────────────────────────────────────
    case "version": {
      const raw  = await tcpRequest(host, port, `version\r\n`, isDoneSingleLine, tcpOpts);
      const resp = parseSingleLineResponse(raw);
      // Response is "VERSION <version_string>"
      const version = resp.startsWith("VERSION ") ? resp.slice(8) : resp;
      return { version, raw: resp };
    }

    default:
      throw new Error(
        `memcached_client: unknown operation '${op}'. Valid: get, set, add, replace, append, prepend, delete, increment, decrement, flush_all, stats, version.`,
      );
  }
}

module.exports = { memcachedClient };
