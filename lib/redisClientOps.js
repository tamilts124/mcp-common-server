"use strict";
// ── redis_client: zero-dep RESP2 Redis protocol client ──────────────────────────
// Pure Node.js net/tls — no npm dependencies.
// Supports all common Redis data structures and meta-commands via RESP2.

const net  = require("net");
const tls  = require("tls");
const { ToolError } = require("./errors");

// ── Constants ───────────────────────────────────────────────────────────────
const MAX_KEY_LEN        = 4_096;          // 4 KB
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;   // 8 MB guard
const DEFAULT_TIMEOUT    = 30_000;         // 30 s
const DEFAULT_PORT       = 6379;

// ── Security guards ─────────────────────────────────────────────────────────

/** Guard a required string field — throws ToolError on bad input. */
function guardString(val, label) {
  if (typeof val !== "string")
    throw new ToolError(`redis_client: '${label}' must be a string.`, -32602);
  if (val.includes("\r") || val.includes("\n") || val.includes("\0"))
    throw new ToolError(
      `redis_client: '${label}' must not contain CR, LF, or NUL characters.`,
      -32602,
    );
  return val;
}

/** Guard an optional string field — returns undefined if absent. */
function guardOptString(val, label) {
  if (val === undefined || val === null) return undefined;
  return guardString(val, label);
}

/** Guard a key name (required string, no control chars, ≤ MAX_KEY_LEN). */
function guardKey(val, label = "key") {
  const s = guardString(val, label);
  if (s.length === 0)
    throw new ToolError(`redis_client: '${label}' must not be empty.`, -32602);
  if (s.length > MAX_KEY_LEN)
    throw new ToolError(
      `redis_client: '${label}' exceeds ${MAX_KEY_LEN}-byte limit.`,
      -32602,
    );
  return s;
}

/** Guard an array of keys. */
function guardKeys(arr, label = "keys") {
  if (!Array.isArray(arr) || arr.length === 0)
    throw new ToolError(`redis_client: '${label}' must be a non-empty array.`, -32602);
  return arr.map((k, i) => guardKey(k, `${label}[${i}]`));
}

// ── RESP2 encoder ───────────────────────────────────────────────────────────

/**
 * Encode an array of bulk strings as a RESP2 Array command.
 * All args must be strings; numbers will be converted.
 */
function encodeCommand(...args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const s = String(arg);
    out += `$${Buffer.byteLength(s, "utf8")}\r\n${s}\r\n`;
  }
  return out;
}

// ── RESP2 parser ────────────────────────────────────────────────────────────

/**
 * Minimal streaming RESP2 parser.
 * State machine over a Buffer; returns { replies: [], consumed: N }.
 * Each reply is: string | number | null | Error | Array.
 */
class RespParser {
  constructor() {
    this._buf   = Buffer.alloc(0);
    this._replies = [];
  }

  feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    let pos = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const [val, next] = this._parse(pos);
      if (next === -1) break; // incomplete
      this._replies.push(val);
      pos = next;
    }
    this._buf = this._buf.slice(pos);
  }

  take() {
    return this._replies.splice(0);
  }

  /** Returns [value, nextPos] or [undefined, -1] on incomplete. */
  _parse(pos) {
    if (pos >= this._buf.length) return [undefined, -1];
    const type = String.fromCharCode(this._buf[pos]);
    pos++;
    switch (type) {
      case "+": // Simple string
      case "-": // Error
      case ":": { // Integer
        const end = this._indexOf(pos, 13, 10); // \r\n
        if (end === -1) return [undefined, -1];
        const line = this._buf.toString("utf8", pos, end);
        const next = end + 2;
        if (type === ":") return [parseInt(line, 10), next];
        if (type === "-") return [new Error(line), next];
        return [line, next];
      }
      case "$": { // Bulk string
        const end = this._indexOf(pos, 13, 10);
        if (end === -1) return [undefined, -1];
        const len = parseInt(this._buf.toString("utf8", pos, end), 10);
        const after = end + 2;
        if (len === -1) return [null, after]; // null bulk
        if (after + len + 2 > this._buf.length) return [undefined, -1];
        const str = this._buf.toString("utf8", after, after + len);
        return [str, after + len + 2];
      }
      case "*": { // Array
        const end = this._indexOf(pos, 13, 10);
        if (end === -1) return [undefined, -1];
        const count = parseInt(this._buf.toString("utf8", pos, end), 10);
        let cur = end + 2;
        if (count === -1) return [null, cur]; // null array
        const arr = [];
        for (let i = 0; i < count; i++) {
          const [item, next] = this._parse(cur);
          if (next === -1) return [undefined, -1];
          arr.push(item);
          cur = next;
        }
        return [arr, cur];
      }
      default:
        throw new ToolError(
          `redis_client: unexpected RESP2 type byte '${type}' (0x${type.charCodeAt(0).toString(16)}).`,
          -32603,
        );
    }
  }

  /** Find \r\n starting from pos. */
  _indexOf(pos, b1, b2) {
    for (let i = pos; i < this._buf.length - 1; i++) {
      if (this._buf[i] === b1 && this._buf[i + 1] === b2) return i;
    }
    return -1;
  }
}

// ── Connection ───────────────────────────────────────────────────────────────

/**
 * Open a Redis connection, optionally authenticate, optionally select DB.
 * Returns { socket, parser, send }.
 */
function openConnection(opts) {
  const {
    host        = "127.0.0.1",
    port        = DEFAULT_PORT,
    tls: useTls = false,
    password,
    username,
    db,
    timeout     = DEFAULT_TIMEOUT,
    connect_timeout,
    reject_unauthorized = true,
  } = opts;

  const connTimeoutMs = typeof connect_timeout === "number"
    ? Math.min(connect_timeout * 1000, 30_000)
    : Math.min(timeout, 10_000);

  return new Promise((resolve, reject) => {
    const parser = new RespParser();
    let totalBytes = 0;
    let settled = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    // ── Queue system for sequential command send/receive ──────────────────
    const waiters  = [];  // [{ resolve, reject }] for in-flight send() calls
    const replyBuf = [];  // parsed replies that arrived before send() was called

    function onData(chunk) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        const budgetErr = new ToolError(
          `redis_client: response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB budget.`,
          -32603,
        );
        // Drain pending waiters and destroy socket.
        while (waiters.length) waiters.shift().reject(budgetErr);
        socket.destroy(budgetErr);
        return;
      }
      let replies;
      try {
        parser.feed(chunk);
        replies = parser.take();
      } catch (parseErr) {
        // Malformed RESP2 data or budget already exceeded — drain waiters.
        const err = totalBytes > MAX_RESPONSE_BYTES
          ? new ToolError(
              `redis_client: response exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB budget.`,
              -32603,
            )
          : parseErr;
        while (waiters.length) waiters.shift().reject(err);
        socket.destroy(err);
        return;
      }
      for (const reply of replies) {
        const waiter = waiters.shift();
        if (waiter) {
          if (reply instanceof Error) waiter.reject(reply);
          else waiter.resolve(reply);
        } else {
          // Reply arrived before any send() — buffer it.
          replyBuf.push(reply);
        }
      }
    }

    /** Send one command, return a promise for its reply. */
    function send(...cmdArgs) {
      const encoded = encodeCommand(...cmdArgs);
      socket.write(encoded);
      // If a reply already arrived before send() was called, consume it immediately.
      if (replyBuf.length > 0) {
        const reply = replyBuf.shift();
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve(reply);
      }
      return new Promise((res, rej) => {
        waiters.push({ resolve: res, reject: rej });
      });
    }

    // ── Establish socket ─────────────────────────────────────────────────
    const socketOpts = { host, port };
    const socket = useTls
      ? tls.connect({
          ...socketOpts,
          rejectUnauthorized: reject_unauthorized,
          servername: host,
        })
      : net.createConnection(socketOpts);

    let connTimer = setTimeout(() => {
      socket.destroy(new ToolError(
        `redis_client: connection timed out after ${connTimeoutMs} ms.`,
        -32603,
      ));
    }, connTimeoutMs);

    const onConnect = async () => {
      clearTimeout(connTimer);
      connTimer = null;
      try {
        // AUTH
        if (password) {
          const authCmd = username
            ? ["AUTH", username, password]
            : ["AUTH", password];
          let authReply;
          try {
            authReply = await send(...authCmd);
          } catch (authErr) {
            throw new ToolError(`redis_client: AUTH failed: ${authErr.message}`, -32603);
          }
          if (authReply instanceof Error || authReply !== "OK")
            throw new ToolError(
              `redis_client: AUTH failed: ${authReply instanceof Error ? authReply.message : authReply}`,
              -32603,
            );
        }
        // SELECT db
        if (typeof db === "number" && db !== 0) {
          let selReply;
          try {
            selReply = await send("SELECT", String(db));
          } catch (selErr) {
            throw new ToolError(`redis_client: SELECT ${db} failed: ${selErr.message}`, -32603);
          }
          if (selReply instanceof Error || selReply !== "OK")
            throw new ToolError(
              `redis_client: SELECT ${db} failed: ${selReply instanceof Error ? selReply.message : selReply}`,
              -32603,
            );
        }
        done(null, { socket, parser, send, waiters });
      } catch (e) {
        socket.destroy();
        // Pass ToolErrors through directly; wrap raw Errors with context.
        const wrapped = (e && (e.code === -32603 || e.code === -32602))
          ? e
          : new ToolError(`redis_client: connection setup failed: ${e.message}`, -32603);
        done(wrapped);
      }
    };

    socket.once(useTls ? "secureConnect" : "connect", onConnect);
    socket.on("data", onData);
    socket.on("error", (e) => done(new ToolError(`redis_client: socket error: ${e.message}`, -32603)));
    socket.on("close", () => {
      // Drain any queued waiters with an error
      while (waiters.length) {
        const w = waiters.shift();
        w.reject(new ToolError("redis_client: connection closed unexpectedly.", -32603));
      }
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert RESP bulk array [k, v, k, v, ...] → plain object. */
function arrayToObject(arr) {
  if (!Array.isArray(arr)) return {};
  const obj = {};
  for (let i = 0; i < arr.length - 1; i += 2)
    obj[arr[i]] = arr[i + 1];
  return obj;
}

/** Parse Redis INFO section into a flat object. */
function parseInfo(raw) {
  const obj = {};
  for (const line of (raw || "").split("\r\n")) {
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    obj[line.slice(0, colon)] = line.slice(colon + 1);
  }
  return obj;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Execute a Redis operation.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function redisClient(opts) {
  const {
    host            = "127.0.0.1",
    port            = DEFAULT_PORT,
    tls: useTls     = false,
    password,
    username,
    db,
    timeout         = DEFAULT_TIMEOUT,
    connect_timeout,
    reject_unauthorized = true,
    operation       = "ping",
    // key/value params
    key,
    keys,
    value,
    values,
    field,
    fields,
    field_values,
    // set/expire params
    ex,
    px,
    nx,
    xx,
    get_old,
    // list params
    elements,
    index,
    start,
    stop,
    count,
    // sorted set params
    score,
    min,
    max,
    member,
    members,
    with_scores,
    // rename
    new_key,
    // channels / pub-sub
    channel,
    message,
    // pipeline
    commands,
    // info
    info_section,
    // range
    offset,
    limit,
    // incr / decr by
    amount,
    // getrange / setrange / append_str
    range_start,
    range_end,
    // zrangebyscore options
    rev,
    // select
    select_db,
    // flushdb
    async_flush,
  } = opts || {};

  if (!opts || !opts.host || typeof opts.host !== "string")
    throw new ToolError("redis_client: 'host' is required (string).", -32602);

  const timeoutMs = typeof timeout === "number" && timeout > 0
    ? timeout * 1000
    : DEFAULT_TIMEOUT;

  const startTime = Date.now();
  let socket;
  let send;

  const VALID_OPS = [
    "ping", "info", "dbsize", "select", "flushdb",
    "get", "set", "del", "exists", "expire", "pexpire", "ttl", "pttl",
    "keys", "type", "rename", "persist",
    "incr", "decr", "incrby", "decrby", "incrbyfloat",
    "append_str", "getrange", "setrange",
    "mget", "mset",
    "hget", "hset", "hmget", "hmset", "hdel",
    "hgetall", "hkeys", "hvals", "hlen", "hexists",
    "lpush", "rpush", "lpop", "rpop", "llen", "lrange",
    "lindex", "lset", "ltrim",
    "sadd", "smembers", "srem", "sismember", "scard",
    "sinter", "sunion", "sdiff",
    "zadd", "zrange", "zrank", "zscore", "zrem",
    "zcard", "zrangebyscore", "zincrby",
    "publish", "pipeline",
  ];

  if (!VALID_OPS.includes(operation))
    throw new ToolError(
      `redis_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`,
      -32602,
    );

  // ── Pre-connection validation ────────────────────────────────────────────
  // Validate all per-operation params BEFORE opening a TCP connection so
  // argument-level errors throw synchronously without touching the network.
  switch (operation) {
    // Single-key ops that just need a valid key
    case "get": case "incr": case "decr": case "type":
    case "persist": case "hgetall": case "hkeys": case "hvals":
    case "hlen": case "smembers": case "scard": case "zcard":
    case "llen": case "ttl": case "pttl": case "getrange":
    case "lrange": case "lindex": case "ltrim":
    case "sadd": case "srem": case "sismember":
    case "zrange": case "zrangebyscore": case "zrank": case "zscore": case "zrem":
      guardKey(key); break;

    case "set":
      guardKey(key);
      if (value === undefined || value === null)
        throw new ToolError("redis_client SET: 'value' is required.", -32602);
      break;

    case "del": case "exists":
      if (keys) guardKeys(keys); else guardKey(key); break;

    case "expire":
      guardKey(key);
      if (typeof ex !== "number")
        throw new ToolError("redis_client EXPIRE: 'ex' (seconds) is required.", -32602);
      break;

    case "pexpire":
      guardKey(key);
      if (typeof px !== "number")
        throw new ToolError("redis_client PEXPIRE: 'px' (milliseconds) is required.", -32602);
      break;

    case "rename":
      guardKey(key); guardKey(new_key, "new_key"); break;

    case "incrby": case "decrby": {
      guardKey(key);
      const by_ = typeof amount === "number" ? amount : parseInt(amount, 10);
      if (!Number.isInteger(by_))
        throw new ToolError(`redis_client ${operation.toUpperCase()}: 'amount' must be an integer.`, -32602);
      break;
    }

    case "incrbyfloat": {
      guardKey(key);
      const fby_ = parseFloat(amount);
      if (!Number.isFinite(fby_))
        throw new ToolError("redis_client INCRBYFLOAT: 'amount' must be a finite number.", -32602);
      break;
    }

    case "append_str":
      guardKey(key);
      if (value === undefined || value === null)
        throw new ToolError("redis_client APPEND: 'value' is required.", -32602);
      break;

    case "setrange": {
      guardKey(key);
      const off_ = typeof offset === "number" ? offset : parseInt(offset, 10);
      if (!Number.isInteger(off_) || off_ < 0)
        throw new ToolError("redis_client SETRANGE: 'offset' must be a non-negative integer.", -32602);
      if (value === undefined || value === null)
        throw new ToolError("redis_client SETRANGE: 'value' is required.", -32602);
      break;
    }

    case "mget": case "sinter": case "sunion": case "sdiff":
      guardKeys(keys); break;

    case "mset":
      if (!field_values || typeof field_values !== "object" || Array.isArray(field_values))
        throw new ToolError("redis_client MSET: 'field_values' must be a plain object.", -32602);
      if (Object.keys(field_values).length === 0)
        throw new ToolError("redis_client MSET: 'field_values' must not be empty.", -32602);
      for (const k_ of Object.keys(field_values)) guardKey(k_, "field_values key");
      break;

    case "hget": case "hexists":
      guardKey(key); guardString(field, "field"); break;

    case "hset":
      guardKey(key);
      if (field_values && typeof field_values === "object" && !Array.isArray(field_values)) {
        if (Object.keys(field_values).length === 0)
          throw new ToolError("redis_client HSET: 'field_values' must not be empty.", -32602);
        for (const f_ of Object.keys(field_values)) guardString(f_, "field_values key");
      } else {
        guardString(field, "field");
        if (value === undefined || value === null)
          throw new ToolError("redis_client HSET: 'value' is required.", -32602);
      }
      break;

    case "hmget":
      guardKey(key);
      if (Array.isArray(fields)) fields.forEach((f_, i) => guardString(f_, `fields[${i}]`));
      else guardString(field, "field");
      break;

    case "hmset":
      guardKey(key);
      if (!field_values || typeof field_values !== "object" || Array.isArray(field_values))
        throw new ToolError("redis_client HMSET: 'field_values' must be a plain object.", -32602);
      if (Object.keys(field_values).length === 0)
        throw new ToolError("redis_client HMSET: 'field_values' must not be empty.", -32602);
      for (const f_ of Object.keys(field_values)) guardString(f_, "field_values key");
      break;

    case "hdel":
      guardKey(key);
      if (Array.isArray(fields)) fields.forEach((f_, i) => guardString(f_, `fields[${i}]`));
      else guardString(field, "field"); break;

    case "lset":
      guardKey(key);
      if (value === undefined || value === null)
        throw new ToolError("redis_client LSET: 'value' is required.", -32602);
      break;

    case "zadd": {
      guardKey(key);
      if (!(field_values && typeof field_values === "object" && !Array.isArray(field_values))) {
        const sc_ = typeof score === "number" ? score : parseFloat(score);
        if (!Number.isFinite(sc_))
          throw new ToolError("redis_client ZADD: 'score' must be a finite number.", -32602);
      }
      break;
    }

    case "zincrby": {
      guardKey(key);
      const zfby = parseFloat(amount);
      if (!Number.isFinite(zfby))
        throw new ToolError("redis_client ZINCRBY: 'amount' must be a finite number.", -32602);
      break;
    }

    case "publish":
      guardString(channel, "channel"); break;

    case "pipeline":
      if (!Array.isArray(commands) || commands.length === 0)
        throw new ToolError("redis_client pipeline: 'commands' must be a non-empty array.", -32602);
      if (commands.length > 500)
        throw new ToolError("redis_client pipeline: 'commands' exceeds 500-command limit.", -32602);
      for (const cmd_ of commands)
        if (!Array.isArray(cmd_) || cmd_.length === 0)
          throw new ToolError("redis_client pipeline: each command must be a non-empty array.", -32602);
      break;

    case "select": {
      const dbNum_ = typeof select_db === "number" ? select_db : parseInt(select_db, 10);
      if (!Number.isInteger(dbNum_) || dbNum_ < 0)
        throw new ToolError("redis_client: 'select_db' must be a non-negative integer.", -32602);
      break;
    }

    case "ping":
      guardOptString(message, "message"); break;

    case "info":
      guardOptString(info_section, "info_section"); break;

    // dbsize, flushdb: no key-level validation needed
    default: break;
  }

  // Guard connection-level auth params upfront
  if (password !== undefined) guardString(password, "password");
  if (username !== undefined) guardString(username, "username");

  // ── Set a wall-clock timeout over the entire operation ───────────────────
  let globalTimer;
  const timeoutPromise = new Promise((_, rej) => {
    globalTimer = setTimeout(
      () => rej(new ToolError(`redis_client: operation timed out after ${timeoutMs} ms.`, -32603)),
      timeoutMs,
    );
  });

  async function run() {
    const conn = await openConnection({
      host, port, tls: useTls, password, username, db,
      timeout: timeoutMs, connect_timeout, reject_unauthorized,
    });
    socket = conn.socket;
    send   = conn.send;

    let result;

    switch (operation) {

      // ── Connectivity / server ─────────────────────────────────────────────
      case "ping": {
        const message_ = guardOptString(message, "message");
        const reply = message_ !== undefined
          ? await send("PING", message_)
          : await send("PING");
        if (reply instanceof Error) throw new ToolError(`redis_client PING: ${reply.message}`, -32603);
        result = { pong: true, response: reply };
        break;
      }

      case "info": {
        const section = guardOptString(info_section, "info_section");
        const reply = section ? await send("INFO", section) : await send("INFO");
        if (reply instanceof Error) throw new ToolError(`redis_client INFO: ${reply.message}`, -32603);
        result = { raw: reply, parsed: parseInfo(reply) };
        break;
      }

      case "dbsize": {
        const reply = await send("DBSIZE");
        if (reply instanceof Error) throw new ToolError(`redis_client DBSIZE: ${reply.message}`, -32603);
        result = { dbsize: reply };
        break;
      }

      case "select": {
        const dbNum = typeof select_db === "number" ? select_db : parseInt(select_db, 10);
        const reply = await send("SELECT", String(dbNum));
        if (reply instanceof Error) throw new ToolError(`redis_client SELECT: ${reply.message}`, -32603);
        result = { ok: reply === "OK", db: dbNum };
        break;
      }

      case "flushdb": {
        const args_ = async_flush ? ["FLUSHDB", "ASYNC"] : ["FLUSHDB"];
        const reply = await send(...args_);
        if (reply instanceof Error) throw new ToolError(`redis_client FLUSHDB: ${reply.message}`, -32603);
        result = { ok: reply === "OK" };
        break;
      }

      // ── String operations ─────────────────────────────────────────────────
      case "get": {
        const k = guardKey(key);
        const reply = await send("GET", k);
        if (reply instanceof Error) throw new ToolError(`redis_client GET: ${reply.message}`, -32603);
        result = { key: k, value: reply, exists: reply !== null };
        break;
      }

      case "set": {
        const k = guardKey(key);
        const v = String(value);
        const cmd = ["SET", k, v];
        if (typeof ex === "number" && ex > 0)   { cmd.push("EX", String(Math.trunc(ex))); }
        else if (typeof px === "number" && px > 0) { cmd.push("PX", String(Math.trunc(px))); }
        if (nx) cmd.push("NX");
        else if (xx) cmd.push("XX");
        if (get_old) cmd.push("GET");
        const reply = await send(...cmd);
        if (reply instanceof Error) throw new ToolError(`redis_client SET: ${reply.message}`, -32603);
        // SET with GET returns old value or null
        result = get_old
          ? { key: k, ok: reply !== null || !nx, oldValue: reply }
          : { key: k, ok: reply === "OK" };
        break;
      }

      case "del": {
        const ks = keys ? guardKeys(keys) : [guardKey(key)];
        const reply = await send("DEL", ...ks);
        if (reply instanceof Error) throw new ToolError(`redis_client DEL: ${reply.message}`, -32603);
        result = { deleted: reply, keys: ks };
        break;
      }

      case "exists": {
        const ks = keys ? guardKeys(keys) : [guardKey(key)];
        const reply = await send("EXISTS", ...ks);
        if (reply instanceof Error) throw new ToolError(`redis_client EXISTS: ${reply.message}`, -32603);
        result = { count: reply, keys: ks };
        break;
      }

      case "expire": {
        const k = guardKey(key);
        const reply = await send("EXPIRE", k, String(Math.trunc(ex)));
        if (reply instanceof Error) throw new ToolError(`redis_client EXPIRE: ${reply.message}`, -32603);
        result = { key: k, set: reply === 1, ex: Math.trunc(ex) };
        break;
      }

      case "pexpire": {
        const k = guardKey(key);
        const reply = await send("PEXPIRE", k, String(Math.trunc(px)));
        if (reply instanceof Error) throw new ToolError(`redis_client PEXPIRE: ${reply.message}`, -32603);
        result = { key: k, set: reply === 1, px: Math.trunc(px) };
        break;
      }

      case "ttl": {
        const k = guardKey(key);
        const reply = await send("TTL", k);
        if (reply instanceof Error) throw new ToolError(`redis_client TTL: ${reply.message}`, -32603);
        result = { key: k, ttl: reply }; // -1 = no expire, -2 = not found
        break;
      }

      case "pttl": {
        const k = guardKey(key);
        const reply = await send("PTTL", k);
        if (reply instanceof Error) throw new ToolError(`redis_client PTTL: ${reply.message}`, -32603);
        result = { key: k, pttl: reply };
        break;
      }

      case "persist": {
        const k = guardKey(key);
        const reply = await send("PERSIST", k);
        if (reply instanceof Error) throw new ToolError(`redis_client PERSIST: ${reply.message}`, -32603);
        result = { key: k, removed: reply === 1 };
        break;
      }

      case "keys": {
        const pattern_ = guardOptString(key, "key") ?? "*";
        const reply = await send("KEYS", pattern_);
        if (reply instanceof Error) throw new ToolError(`redis_client KEYS: ${reply.message}`, -32603);
        result = { pattern: pattern_, keys: reply, count: Array.isArray(reply) ? reply.length : 0 };
        break;
      }

      case "type": {
        const k = guardKey(key);
        const reply = await send("TYPE", k);
        if (reply instanceof Error) throw new ToolError(`redis_client TYPE: ${reply.message}`, -32603);
        result = { key: k, type: reply };
        break;
      }

      case "rename": {
        const k    = guardKey(key);
        const newK = guardKey(new_key, "new_key");
        const reply = await send("RENAME", k, newK);
        if (reply instanceof Error) throw new ToolError(`redis_client RENAME: ${reply.message}`, -32603);
        result = { from: k, to: newK, ok: reply === "OK" };
        break;
      }

      // ── Numeric operations ────────────────────────────────────────────────
      case "incr": {
        const k = guardKey(key);
        const reply = await send("INCR", k);
        if (reply instanceof Error) throw new ToolError(`redis_client INCR: ${reply.message}`, -32603);
        result = { key: k, value: reply };
        break;
      }

      case "decr": {
        const k = guardKey(key);
        const reply = await send("DECR", k);
        if (reply instanceof Error) throw new ToolError(`redis_client DECR: ${reply.message}`, -32603);
        result = { key: k, value: reply };
        break;
      }

      case "incrby": {
        const k  = guardKey(key);
        const by = typeof amount === "number" ? amount : parseInt(amount, 10);
        const reply = await send("INCRBY", k, String(by));
        if (reply instanceof Error) throw new ToolError(`redis_client INCRBY: ${reply.message}`, -32603);
        result = { key: k, value: reply };
        break;
      }

      case "decrby": {
        const k  = guardKey(key);
        const by = typeof amount === "number" ? amount : parseInt(amount, 10);
        const reply = await send("DECRBY", k, String(by));
        if (reply instanceof Error) throw new ToolError(`redis_client DECRBY: ${reply.message}`, -32603);
        result = { key: k, value: reply };
        break;
      }

      case "incrbyfloat": {
        const k  = guardKey(key);
        const by = parseFloat(amount);
        const reply = await send("INCRBYFLOAT", k, String(by));
        if (reply instanceof Error) throw new ToolError(`redis_client INCRBYFLOAT: ${reply.message}`, -32603);
        result = { key: k, value: reply };
        break;
      }

      // ── String sub-ops ────────────────────────────────────────────────────
      case "append_str": {
        const k = guardKey(key);
        const reply = await send("APPEND", k, String(value));
        if (reply instanceof Error) throw new ToolError(`redis_client APPEND: ${reply.message}`, -32603);
        result = { key: k, length: reply };
        break;
      }

      case "getrange": {
        const k   = guardKey(key);
        const s   = typeof range_start === "number" ? range_start : parseInt(range_start, 10);
        const e_  = typeof range_end   === "number" ? range_end   : parseInt(range_end, 10);
        const reply = await send("GETRANGE", k, String(s), String(e_));
        if (reply instanceof Error) throw new ToolError(`redis_client GETRANGE: ${reply.message}`, -32603);
        result = { key: k, value: reply };
        break;
      }

      case "setrange": {
        const k   = guardKey(key);
        const off = typeof offset === "number" ? offset : parseInt(offset, 10);
        const reply = await send("SETRANGE", k, String(off), String(value));
        if (reply instanceof Error) throw new ToolError(`redis_client SETRANGE: ${reply.message}`, -32603);
        result = { key: k, length: reply };
        break;
      }

      // ── Multi-key string ops ──────────────────────────────────────────────
      case "mget": {
        const ks = guardKeys(keys);
        const reply = await send("MGET", ...ks);
        if (reply instanceof Error) throw new ToolError(`redis_client MGET: ${reply.message}`, -32603);
        const obj = {};
        ks.forEach((k, i) => { obj[k] = Array.isArray(reply) ? reply[i] : null; });
        result = { values: obj, count: ks.length };
        break;
      }

      case "mset": {
        const entries = Object.entries(field_values);
        const cmd = ["MSET"];
        for (const [k, v] of entries) {
          guardKey(k, "field_values key");
          cmd.push(k, String(v));
        }
        const reply = await send(...cmd);
        if (reply instanceof Error) throw new ToolError(`redis_client MSET: ${reply.message}`, -32603);
        result = { ok: reply === "OK", count: entries.length };
        break;
      }

      // ── Hash operations ───────────────────────────────────────────────────
      case "hget": {
        const k = guardKey(key);
        const f = guardString(field, "field");
        const reply = await send("HGET", k, f);
        if (reply instanceof Error) throw new ToolError(`redis_client HGET: ${reply.message}`, -32603);
        result = { key: k, field: f, value: reply };
        break;
      }

      case "hset": {
        const k = guardKey(key);
        if (field_values && typeof field_values === "object" && !Array.isArray(field_values)) {
          const entries = Object.entries(field_values);
          const cmd = ["HSET", k];
          for (const [f, v] of entries) {
            guardString(f, "field_values key");
            cmd.push(f, String(v));
          }
          const reply = await send(...cmd);
          if (reply instanceof Error) throw new ToolError(`redis_client HSET: ${reply.message}`, -32603);
          result = { key: k, added: reply };
        } else {
          const f = guardString(field, "field");
          const reply = await send("HSET", k, f, String(value));
          if (reply instanceof Error) throw new ToolError(`redis_client HSET: ${reply.message}`, -32603);
          result = { key: k, field: f, added: reply };
        }
        break;
      }

      case "hmget": {
        const k  = guardKey(key);
        const fs = Array.isArray(fields)
          ? fields.map((f, i) => guardString(f, `fields[${i}]`))
          : [guardString(field, "field")];
        const reply = await send("HMGET", k, ...fs);
        if (reply instanceof Error) throw new ToolError(`redis_client HMGET: ${reply.message}`, -32603);
        const obj = {};
        fs.forEach((f, i) => { obj[f] = Array.isArray(reply) ? reply[i] : null; });
        result = { key: k, values: obj };
        break;
      }

      case "hmset": {
        const k = guardKey(key);
        const entries = Object.entries(field_values);
        const cmd = ["HMSET", k];
        for (const [f, v] of entries) {
          guardString(f, "field_values key");
          cmd.push(f, String(v));
        }
        const reply = await send(...cmd);
        if (reply instanceof Error) throw new ToolError(`redis_client HMSET: ${reply.message}`, -32603);
        result = { key: k, ok: reply === "OK" };
        break;
      }

      case "hdel": {
        const k  = guardKey(key);
        const fs = Array.isArray(fields)
          ? fields.map((f, i) => guardString(f, `fields[${i}]`))
          : [guardString(field, "field")];
        const reply = await send("HDEL", k, ...fs);
        if (reply instanceof Error) throw new ToolError(`redis_client HDEL: ${reply.message}`, -32603);
        result = { key: k, deleted: reply };
        break;
      }

      case "hgetall": {
        const k = guardKey(key);
        const reply = await send("HGETALL", k);
        if (reply instanceof Error) throw new ToolError(`redis_client HGETALL: ${reply.message}`, -32603);
        result = { key: k, hash: Array.isArray(reply) ? arrayToObject(reply) : {}, fieldCount: Array.isArray(reply) ? reply.length / 2 : 0 };
        break;
      }

      case "hkeys": {
        const k = guardKey(key);
        const reply = await send("HKEYS", k);
        if (reply instanceof Error) throw new ToolError(`redis_client HKEYS: ${reply.message}`, -32603);
        result = { key: k, fields: reply, count: Array.isArray(reply) ? reply.length : 0 };
        break;
      }

      case "hvals": {
        const k = guardKey(key);
        const reply = await send("HVALS", k);
        if (reply instanceof Error) throw new ToolError(`redis_client HVALS: ${reply.message}`, -32603);
        result = { key: k, values: reply, count: Array.isArray(reply) ? reply.length : 0 };
        break;
      }

      case "hlen": {
        const k = guardKey(key);
        const reply = await send("HLEN", k);
        if (reply instanceof Error) throw new ToolError(`redis_client HLEN: ${reply.message}`, -32603);
        result = { key: k, length: reply };
        break;
      }

      case "hexists": {
        const k = guardKey(key);
        const f = guardString(field, "field");
        const reply = await send("HEXISTS", k, f);
        if (reply instanceof Error) throw new ToolError(`redis_client HEXISTS: ${reply.message}`, -32603);
        result = { key: k, field: f, exists: reply === 1 };
        break;
      }

      // ── List operations ───────────────────────────────────────────────────
      case "lpush": {
        const k    = guardKey(key);
        const elms = elements ? elements.map(String) : [String(value)];
        if (elms.length === 0)
          throw new ToolError("redis_client LPUSH: 'elements' or 'value' is required.", -32602);
        const reply = await send("LPUSH", k, ...elms);
        if (reply instanceof Error) throw new ToolError(`redis_client LPUSH: ${reply.message}`, -32603);
        result = { key: k, length: reply };
        break;
      }

      case "rpush": {
        const k    = guardKey(key);
        const elms = elements ? elements.map(String) : [String(value)];
        if (elms.length === 0)
          throw new ToolError("redis_client RPUSH: 'elements' or 'value' is required.", -32602);
        const reply = await send("RPUSH", k, ...elms);
        if (reply instanceof Error) throw new ToolError(`redis_client RPUSH: ${reply.message}`, -32603);
        result = { key: k, length: reply };
        break;
      }

      case "lpop": {
        const k    = guardKey(key);
        const cnt  = typeof count === "number" && count > 1 ? count : undefined;
        const reply = cnt !== undefined
          ? await send("LPOP", k, String(Math.trunc(cnt)))
          : await send("LPOP", k);
        if (reply instanceof Error) throw new ToolError(`redis_client LPOP: ${reply.message}`, -32603);
        result = { key: k, value: reply };
        break;
      }

      case "rpop": {
        const k    = guardKey(key);
        const cnt  = typeof count === "number" && count > 1 ? count : undefined;
        const reply = cnt !== undefined
          ? await send("RPOP", k, String(Math.trunc(cnt)))
          : await send("RPOP", k);
        if (reply instanceof Error) throw new ToolError(`redis_client RPOP: ${reply.message}`, -32603);
        result = { key: k, value: reply };
        break;
      }

      case "llen": {
        const k = guardKey(key);
        const reply = await send("LLEN", k);
        if (reply instanceof Error) throw new ToolError(`redis_client LLEN: ${reply.message}`, -32603);
        result = { key: k, length: reply };
        break;
      }

      case "lrange": {
        const k  = guardKey(key);
        const s_ = typeof start === "number" ? start : parseInt(start ?? "0", 10);
        const e_ = typeof stop  === "number" ? stop  : parseInt(stop  ?? "-1", 10);
        const reply = await send("LRANGE", k, String(s_), String(e_));
        if (reply instanceof Error) throw new ToolError(`redis_client LRANGE: ${reply.message}`, -32603);
        result = { key: k, elements: reply, count: Array.isArray(reply) ? reply.length : 0 };
        break;
      }

      case "lindex": {
        const k   = guardKey(key);
        const idx = typeof index === "number" ? index : parseInt(index, 10);
        const reply = await send("LINDEX", k, String(idx));
        if (reply instanceof Error) throw new ToolError(`redis_client LINDEX: ${reply.message}`, -32603);
        result = { key: k, index: idx, value: reply };
        break;
      }

      case "lset": {
        const k   = guardKey(key);
        const idx = typeof index === "number" ? index : parseInt(index, 10);
        const reply = await send("LSET", k, String(idx), String(value));
        if (reply instanceof Error) throw new ToolError(`redis_client LSET: ${reply.message}`, -32603);
        result = { key: k, index: idx, ok: reply === "OK" };
        break;
      }

      case "ltrim": {
        const k  = guardKey(key);
        const s_ = typeof start === "number" ? start : parseInt(start ?? "0", 10);
        const e_ = typeof stop  === "number" ? stop  : parseInt(stop  ?? "-1", 10);
        const reply = await send("LTRIM", k, String(s_), String(e_));
        if (reply instanceof Error) throw new ToolError(`redis_client LTRIM: ${reply.message}`, -32603);
        result = { key: k, ok: reply === "OK" };
        break;
      }

      // ── Set operations ────────────────────────────────────────────────────
      case "sadd": {
        const k    = guardKey(key);
        const mems = members ? members.map(String) : [String(value)];
        if (mems.length === 0)
          throw new ToolError("redis_client SADD: 'members' or 'value' is required.", -32602);
        const reply = await send("SADD", k, ...mems);
        if (reply instanceof Error) throw new ToolError(`redis_client SADD: ${reply.message}`, -32603);
        result = { key: k, added: reply };
        break;
      }

      case "smembers": {
        const k = guardKey(key);
        const reply = await send("SMEMBERS", k);
        if (reply instanceof Error) throw new ToolError(`redis_client SMEMBERS: ${reply.message}`, -32603);
        result = { key: k, members: reply, count: Array.isArray(reply) ? reply.length : 0 };
        break;
      }

      case "srem": {
        const k    = guardKey(key);
        const mems = members ? members.map(String) : [String(member ?? value)];
        const reply = await send("SREM", k, ...mems);
        if (reply instanceof Error) throw new ToolError(`redis_client SREM: ${reply.message}`, -32603);
        result = { key: k, removed: reply };
        break;
      }

      case "sismember": {
        const k   = guardKey(key);
        const mem = String(member ?? value);
        const reply = await send("SISMEMBER", k, mem);
        if (reply instanceof Error) throw new ToolError(`redis_client SISMEMBER: ${reply.message}`, -32603);
        result = { key: k, member: mem, isMember: reply === 1 };
        break;
      }

      case "scard": {
        const k = guardKey(key);
        const reply = await send("SCARD", k);
        if (reply instanceof Error) throw new ToolError(`redis_client SCARD: ${reply.message}`, -32603);
        result = { key: k, count: reply };
        break;
      }

      case "sinter": {
        const ks = guardKeys(keys);
        const reply = await send("SINTER", ...ks);
        if (reply instanceof Error) throw new ToolError(`redis_client SINTER: ${reply.message}`, -32603);
        result = { keys: ks, members: reply, count: Array.isArray(reply) ? reply.length : 0 };
        break;
      }

      case "sunion": {
        const ks = guardKeys(keys);
        const reply = await send("SUNION", ...ks);
        if (reply instanceof Error) throw new ToolError(`redis_client SUNION: ${reply.message}`, -32603);
        result = { keys: ks, members: reply, count: Array.isArray(reply) ? reply.length : 0 };
        break;
      }

      case "sdiff": {
        const ks = guardKeys(keys);
        const reply = await send("SDIFF", ...ks);
        if (reply instanceof Error) throw new ToolError(`redis_client SDIFF: ${reply.message}`, -32603);
        result = { keys: ks, members: reply, count: Array.isArray(reply) ? reply.length : 0 };
        break;
      }

      // ── Sorted set operations ─────────────────────────────────────────────
      case "zadd": {
        const k = guardKey(key);
        const cmd = ["ZADD", k];
        if (nx) cmd.push("NX");
        else if (xx) cmd.push("XX");
        if (field_values && typeof field_values === "object" && !Array.isArray(field_values)) {
          for (const [mem, sc] of Object.entries(field_values)) {
            cmd.push(String(sc), mem);
          }
        } else {
          const sc  = typeof score === "number" ? score : parseFloat(score);
          const mem = String(member ?? value);
          cmd.push(String(sc), mem);
        }
        const reply = await send(...cmd);
        if (reply instanceof Error) throw new ToolError(`redis_client ZADD: ${reply.message}`, -32603);
        result = { key: k, added: reply };
        break;
      }

      case "zrange": {
        const k  = guardKey(key);
        const s_ = typeof start === "number" ? start : parseInt(start ?? "0", 10);
        const e_ = typeof stop  === "number" ? stop  : parseInt(stop  ?? "-1", 10);
        const cmd = ["ZRANGE", k, String(s_), String(e_)];
        if (with_scores) cmd.push("WITHSCORES");
        const reply = await send(...cmd);
        if (reply instanceof Error) throw new ToolError(`redis_client ZRANGE: ${reply.message}`, -32603);
        if (with_scores && Array.isArray(reply)) {
          const pairs = [];
          for (let i = 0; i < reply.length; i += 2)
            pairs.push({ member: reply[i], score: parseFloat(reply[i + 1]) });
          result = { key: k, members: pairs, count: pairs.length };
        } else {
          result = { key: k, members: reply, count: Array.isArray(reply) ? reply.length : 0 };
        }
        break;
      }

      case "zrangebyscore": {
        const k    = guardKey(key);
        const minV = min !== undefined ? String(min) : "-inf";
        const maxV = max !== undefined ? String(max) : "+inf";
        const cmd  = rev
          ? ["ZREVRANGEBYSCORE", k, maxV, minV]
          : ["ZRANGEBYSCORE",    k, minV, maxV];
        if (with_scores) cmd.push("WITHSCORES");
        if (typeof offset === "number" && typeof limit === "number")
          cmd.push("LIMIT", String(offset), String(limit));
        const reply = await send(...cmd);
        if (reply instanceof Error) throw new ToolError(`redis_client ZRANGEBYSCORE: ${reply.message}`, -32603);
        if (with_scores && Array.isArray(reply)) {
          const pairs = [];
          for (let i = 0; i < reply.length; i += 2)
            pairs.push({ member: reply[i], score: parseFloat(reply[i + 1]) });
          result = { key: k, members: pairs, count: pairs.length };
        } else {
          result = { key: k, members: reply, count: Array.isArray(reply) ? reply.length : 0 };
        }
        break;
      }

      case "zrank": {
        const k   = guardKey(key);
        const mem = String(member ?? value);
        const reply = rev
          ? await send("ZREVRANK", k, mem)
          : await send("ZRANK", k, mem);
        if (reply instanceof Error) throw new ToolError(`redis_client ZRANK: ${reply.message}`, -32603);
        result = { key: k, member: mem, rank: reply }; // null if not exists
        break;
      }

      case "zscore": {
        const k   = guardKey(key);
        const mem = String(member ?? value);
        const reply = await send("ZSCORE", k, mem);
        if (reply instanceof Error) throw new ToolError(`redis_client ZSCORE: ${reply.message}`, -32603);
        result = { key: k, member: mem, score: reply !== null ? parseFloat(reply) : null };
        break;
      }

      case "zrem": {
        const k    = guardKey(key);
        const mems = members ? members.map(String) : [String(member ?? value)];
        const reply = await send("ZREM", k, ...mems);
        if (reply instanceof Error) throw new ToolError(`redis_client ZREM: ${reply.message}`, -32603);
        result = { key: k, removed: reply };
        break;
      }

      case "zcard": {
        const k = guardKey(key);
        const reply = await send("ZCARD", k);
        if (reply instanceof Error) throw new ToolError(`redis_client ZCARD: ${reply.message}`, -32603);
        result = { key: k, count: reply };
        break;
      }

      case "zincrby": {
        const k   = guardKey(key);
        const inc = typeof amount === "number" ? amount : parseFloat(amount);
        const mem = String(member ?? value);
        const reply = await send("ZINCRBY", k, String(inc), mem);
        if (reply instanceof Error) throw new ToolError(`redis_client ZINCRBY: ${reply.message}`, -32603);
        result = { key: k, member: mem, score: reply !== null ? parseFloat(reply) : null };
        break;
      }

      // ── Pub/sub ───────────────────────────────────────────────────────────
      case "publish": {
        const ch  = guardString(channel, "channel");
        const msg = message !== undefined && message !== null ? String(message) : "";
        const reply = await send("PUBLISH", ch, msg);
        if (reply instanceof Error) throw new ToolError(`redis_client PUBLISH: ${reply.message}`, -32603);
        result = { channel: ch, receivers: reply };
        break;
      }

      // ── Pipeline ──────────────────────────────────────────────────────────
      case "pipeline": {
        // Pre-connection validation already checked commands; send all.
        const promises = commands.map((cmd) => send(...cmd.map(String)).catch(e => e));
        const replies  = await Promise.all(promises);
        const results  = replies.map((r, i) => ({
          index:   i,
          command: commands[i],
          ok:      !(r instanceof Error),
          reply:   r instanceof Error ? null : r,
          error:   r instanceof Error ? r.message : null,
        }));
        result = {
          count:     commands.length,
          succeeded: results.filter(r => r.ok).length,
          failed:    results.filter(r => !r.ok).length,
          results,
        };
        break;
      }

      default:
        throw new ToolError(`redis_client: unhandled operation '${operation}'.`, -32603);
    }

    return {
      host,
      port,
      operation,
      elapsedMs: Date.now() - startTime,
      ...result,
    };
  }

  try {
    // Attach a no-op catch to run() so that if timeoutPromise wins the race
    // and we then destroy the socket (which rejects pending send() waiters),
    // the resulting run() rejection does not become an unhandled promise
    // rejection that keeps the Node.js event loop alive.
    const runPromise = run();
    runPromise.catch(() => {});
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(globalTimer);
    if (socket && !socket.destroyed) socket.destroy();
  }
}

module.exports = { redisClient };
