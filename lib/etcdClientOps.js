"use strict";
/**
 * etcd_client — Zero-dependency etcd v3 client
 * (pure Node.js http/https built-ins; no npm deps)
 *
 * Uses the etcd v3 gRPC-gateway REST API (HTTP/1.1 + JSON).
 * All keys and values are base64-encoded in the wire protocol;
 * this client handles encoding/decoding transparently.
 *
 * References:
 *   etcd v3 API reference  — https://etcd.io/docs/v3.5/dev-guide/api_reference_v3/
 *   gRPC-gateway REST docs  — https://etcd.io/docs/v3.5/dev-guide/interacting_v3/
 *   Authentication          — https://etcd.io/docs/v3.5/op-guide/authentication/
 *
 * Default port: 2379
 *
 * Operations:
 *   get            — Read one or more keys (with optional range / prefix scan)
 *   put            — Create or update a key with a value (optionally with lease)
 *   delete         — Delete one or more keys (with optional range / prefix delete)
 *   list           — List keys under a prefix (no values by default)
 *   watch          — Short-poll a key/prefix for changes (non-streaming, one request)
 *   grant_lease    — Create a time-to-live lease
 *   revoke_lease   — Revoke a lease (immediately deletes all keys attached to it)
 *   keepalive      — Refresh a lease TTL
 *   lock           — Acquire a distributed mutex lock (via concurrency/v3lock API)
 *   unlock         — Release a distributed mutex lock
 *   status         — Return cluster member status (version, db size, leader, raft index)
 *   members        — List all cluster members (name, peer URLs, client URLs, isLeader)
 *   compact        — Compact revision history up to a given revision
 *   txn            — Execute a mini-transaction (compare → success/failure op list)
 *   auth_enable    — Enable authentication
 *   auth_disable   — Disable authentication
 *   info           — Return protocol / operation reference (no I/O)
 *
 * Wire encoding:
 *   Keys and values are UTF-8 strings sent as base64 in JSON requests.
 *   range_end for prefix scan = prefix with last byte incremented.
 *   All numeric fields (revision, lease ID, etc.) arrive as strings in JSON
 *   because protobuf int64 → JSON string in the gRPC-gateway.
 *
 * Security:
 *   NUL-byte guards on host, username, password, key, value.
 *   Timeout clamped 1000–120000 ms.
 *   Port validated 1–65535.
 *   Passwords never appear in returned objects.
 *   TLS via use_tls:true (https module); reject_unauthorized option.
 *   HTTP Basic Auth or etcd token auth (username + password).
 */

const http  = require("http");
const https = require("https");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT       = 2379;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MB

// ── Guard helpers ──────────────────────────────────────────────────────────

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

function guardString(val, name) {
  if (val !== undefined && val !== null) {
    if (typeof val !== "string") throw new Error(`${name} must be a string`);
    if (val.includes("\0")) throw new Error(`${name} must not contain NUL bytes`);
  }
}

// ── Base64 helpers ─────────────────────────────────────────────────────────

function toB64(str) {
  if (str === null || str === undefined) return "";
  return Buffer.from(String(str), "utf8").toString("base64");
}

function fromB64(b64) {
  if (!b64) return "";
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Compute the range_end for prefix scanning.
 * Increment the last byte of the prefix; if overflow, use \x00 sentinel.
 */
function prefixRangeEnd(prefix) {
  const buf = Buffer.from(prefix, "utf8");
  if (buf.length === 0) return toB64("\x00"); // empty prefix = all keys
  let i = buf.length - 1;
  while (i >= 0 && buf[i] === 0xff) i--;
  if (i < 0) return toB64("\x00"); // all bytes 0xff → sentinel
  buf[i]++;
  return buf.slice(0, i + 1).toString("base64");
}

// ── HTTP helper ────────────────────────────────────────────────────────────

/**
 * Send a POST request to the etcd gRPC-gateway JSON API.
 * Returns the parsed JSON response body.
 */
function etcdPost(opts, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const reqBody = JSON.stringify(body);
    const headers = {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(reqBody),
    };
    if (opts.token) headers["Authorization"] = opts.token;

    const reqOpts = {
      hostname: opts.host,
      port:     opts.port,
      path,
      method:   "POST",
      headers,
    };
    if (opts.useTls) {
      reqOpts.rejectUnauthorized = opts.rejectUnauthorized !== false;
      reqOpts.servername         = opts.host;
    }

    const mod = opts.useTls ? https : http;
    let totalBytes = 0;
    let settled = false;
    const chunks = [];

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`etcd request to ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = mod.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("etcd response exceeded 32 MB cap"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) {
          reject(new Error(`etcd: invalid JSON response from ${path}: ${raw.slice(0, 200)}`));
          return;
        }
        // etcd gRPC-gateway returns HTTP 200 even for errors; check error field
        if (parsed.error) {
          reject(new Error(`etcd error: ${parsed.error} (code=${parsed.code || "?"})`));
          return;
        }
        resolve(parsed);
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`etcd response error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to etcd ${opts.host}:${opts.port}: ${err.message}`));
    });

    req.write(reqBody);
    req.end();
  });
}

// ── Auth helper ────────────────────────────────────────────────────────────

/**
 * Authenticate and retrieve a token if username+password are provided.
 * Returns the token string or null.
 */
async function authenticate(opts) {
  if (!opts.username || !opts.password) return null;
  const res = await etcdPost(opts, "/v3/auth/authenticate", {
    name:     opts.username,
    password: opts.password,
  }, opts.timeoutMs);
  if (!res.token) throw new Error("etcd auth: no token in authenticate response");
  return res.token;
}

/**
 * Build opts object from args, authenticate if needed, return opts with token.
 */
async function buildOpts(args) {
  requireString(args.host, "host");
  guardString(args.username, "username");
  guardString(args.password, "password");
  guardString(args.key, "key");
  guardString(args.value, "value");
  guardString(args.prefix, "prefix");

  const host      = args.host.trim();
  const port      = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");
  const timeoutMs = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  const useTls    = !!args.use_tls;
  const rejectUnauthorized = args.reject_unauthorized !== false;

  const opts = { host, port, timeoutMs, useTls, rejectUnauthorized,
                 username: args.username, password: args.password, token: null };

  opts.token = await authenticate(opts);
  return opts;
}

// ── KV helpers ─────────────────────────────────────────────────────────────

function decodeKv(kv) {
  return {
    key:            fromB64(kv.key),
    value:          fromB64(kv.value),
    version:        kv.version        || "0",
    create_revision: kv.create_revision || "0",
    mod_revision:   kv.mod_revision   || "0",
    lease:          kv.lease          || "0",
  };
}

// ── Operations ─────────────────────────────────────────────────────────────

/**
 * get — Read one key, a range, or all keys with a prefix.
 * If prefix is set, performs a range scan.
 * If range_end is set explicitly, uses that range.
 * Returns { count, kvs[] }
 */
async function opGet(args) {
  const opts = await buildOpts(args);
  const key  = args.key || args.prefix || "";
  if (!key) throw new Error("get requires 'key' or 'prefix'");
  guardString(key, "key/prefix");

  const reqBody = { key: toB64(key) };

  if (args.prefix) {
    reqBody.range_end = prefixRangeEnd(args.prefix);
  } else if (args.range_end) {
    guardString(args.range_end, "range_end");
    reqBody.range_end = toB64(args.range_end);
  }

  if (args.limit) reqBody.limit     = String(clampInt(args.limit, 100, 1, 100000, "limit"));
  if (args.revision) reqBody.revision = String(args.revision);
  if (args.keys_only) reqBody.keys_only = true;
  if (args.sort_target) reqBody.sort_target = args.sort_target;
  if (args.sort_order)  reqBody.sort_order  = args.sort_order;

  const res = await etcdPost(opts, "/v3/kv/range", reqBody, opts.timeoutMs);

  const kvs = (res.kvs || []).map(decodeKv);
  return {
    ok:        true,
    operation: "get",
    server:    `${opts.host}:${opts.port}`,
    count:     Number(res.count || kvs.length),
    more:      !!res.more,
    revision:  res.header && res.header.revision ? res.header.revision : null,
    kvs,
  };
}

/**
 * put — Create or update a key.
 * Returns the previous value if prev_kv:true.
 */
async function opPut(args) {
  const opts = await buildOpts(args);
  if (!args.key) throw new Error("put requires 'key'");
  guardString(args.key, "key");

  const reqBody = {
    key:   toB64(args.key),
    value: toB64(args.value || ""),
  };
  if (args.lease)   reqBody.lease    = String(args.lease);
  if (args.prev_kv) reqBody.prev_kv  = true;
  if (args.ignore_value) reqBody.ignore_value = true;
  if (args.ignore_lease) reqBody.ignore_lease = true;

  const res = await etcdPost(opts, "/v3/kv/put", reqBody, opts.timeoutMs);

  return {
    ok:        true,
    operation: "put",
    server:    `${opts.host}:${opts.port}`,
    key:       args.key,
    value:     args.value || "",
    revision:  res.header && res.header.revision ? res.header.revision : null,
    prev_kv:   res.prev_kv ? decodeKv(res.prev_kv) : null,
  };
}

/**
 * delete — Delete a key, range, or prefix.
 */
async function opDelete(args) {
  const opts = await buildOpts(args);
  const key  = args.key || args.prefix || "";
  if (!key) throw new Error("delete requires 'key' or 'prefix'");

  const reqBody = { key: toB64(key) };

  if (args.prefix) {
    reqBody.range_end = prefixRangeEnd(args.prefix);
  } else if (args.range_end) {
    guardString(args.range_end, "range_end");
    reqBody.range_end = toB64(args.range_end);
  }
  if (args.prev_kv) reqBody.prev_kv = true;

  const res = await etcdPost(opts, "/v3/kv/deleterange", reqBody, opts.timeoutMs);

  return {
    ok:        true,
    operation: "delete",
    server:    `${opts.host}:${opts.port}`,
    deleted:   Number(res.deleted || 0),
    revision:  res.header && res.header.revision ? res.header.revision : null,
    prev_kvs:  (res.prev_kvs || []).map(decodeKv),
  };
}

/**
 * list — List keys under a prefix (keys only by default).
 */
async function opList(args) {
  const opts   = await buildOpts(args);
  const prefix = args.prefix || "";
  const limit  = clampInt(args.limit, 1000, 1, 100000, "limit");

  const reqBody = {
    key:       toB64(prefix || "\x00"),
    range_end: prefix ? prefixRangeEnd(prefix) : toB64("\x00"),
    keys_only: args.include_values ? false : true,
    limit:     String(limit),
  };
  if (args.sort_target) reqBody.sort_target = args.sort_target;
  if (args.sort_order)  reqBody.sort_order  = args.sort_order;

  const res = await etcdPost(opts, "/v3/kv/range", reqBody, opts.timeoutMs);

  const kvs = (res.kvs || []).map(decodeKv);
  return {
    ok:        true,
    operation: "list",
    server:    `${opts.host}:${opts.port}`,
    prefix:    prefix,
    count:     Number(res.count || kvs.length),
    more:      !!res.more,
    revision:  res.header && res.header.revision ? res.header.revision : null,
    keys:      kvs.map(kv => kv.key),
    kvs:       args.include_values ? kvs : undefined,
  };
}

/**
 * watch — Short-poll: issue a single watch request and collect events
 * for up to `duration_ms` milliseconds (or until first event if
 * one_event:true). Uses /v3/watch with HTTP/1.1 streaming response.
 *
 * This is a best-effort, non-persistent watch — suitable for
 * one-shot change detection. For persistent watches, use a dedicated
 * etcd client library.
 */
async function opWatch(args) {
  const opts = await buildOpts(args);
  const key  = args.key || args.prefix || "";
  if (!key) throw new Error("watch requires 'key' or 'prefix'");

  const durationMs  = clampInt(args.duration_ms, 2000, 100, 30000, "duration_ms");
  const startRevision = args.start_revision ? String(args.start_revision) : undefined;

  const createRequest = {
    key: toB64(key),
  };
  if (args.prefix)         createRequest.range_end     = prefixRangeEnd(args.prefix);
  if (args.range_end)      createRequest.range_end     = toB64(args.range_end);
  if (startRevision)       createRequest.start_revision = startRevision;
  if (args.prev_kv)        createRequest.prev_kv       = true;
  if (args.filters)        createRequest.filters       = args.filters; // ["NOPUT","NODELETE"]

  const reqBody = { create_request: createRequest };

  // Collect streaming newline-delimited JSON events
  return new Promise((resolve, reject) => {
    const reqBodyStr = JSON.stringify(reqBody);
    const headers    = {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(reqBodyStr),
    };
    if (opts.token) headers["Authorization"] = opts.token;

    const reqOpts = {
      hostname: opts.host,
      port:     opts.port,
      path:     "/v3/watch",
      method:   "POST",
      headers,
    };
    if (opts.useTls) {
      reqOpts.rejectUnauthorized = opts.rejectUnauthorized !== false;
      reqOpts.servername         = opts.host;
    }

    const mod    = opts.useTls ? https : http;
    const events = [];
    let   settled = false;
    let   totalBytes = 0;
    let   watchId    = null;
    let   buf        = "";
    let   timer, durationTimer;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(durationTimer);
      req.destroy();
      resolve({
        ok:        true,
        operation: "watch",
        server:    `${opts.host}:${opts.port}`,
        watch_id:  watchId,
        key:       args.key || null,
        prefix:    args.prefix || null,
        eventCount: events.length,
        events,
      });
    };

    const req = mod.request(reqOpts, (res) => {
      durationTimer = setTimeout(finish, durationMs);

      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(durationTimer);
          req.destroy();
          reject(new Error("etcd watch response exceeded 32 MB cap"));
          return;
        }
        buf += chunk.toString("utf8");
        // Parse complete JSON lines (one JSON object per newline)
        const parts = buf.split("\n");
        buf = parts.pop(); // incomplete line
        for (const line of parts) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch (_) { continue; }
          if (obj.error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(durationTimer);
            req.destroy();
            reject(new Error(`etcd watch error: ${obj.error}`));
            return;
          }
          if (obj.result) {
            if (!watchId && obj.result.watch_id) watchId = obj.result.watch_id;
            if (Array.isArray(obj.result.events)) {
              for (const ev of obj.result.events) {
                events.push({
                  type:   ev.type || "PUT",
                  kv:     ev.kv     ? decodeKv(ev.kv)     : null,
                  prev_kv: ev.prev_kv ? decodeKv(ev.prev_kv) : null,
                });
              }
              if (args.one_event && events.length > 0) finish();
            }
          }
        }
      });

      res.on("end",   finish);
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(durationTimer);
        reject(new Error(`etcd watch stream error: ${err.message}`));
      });
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(durationTimer);
      req.destroy();
      reject(new Error(`etcd watch connect timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(durationTimer);
      reject(new Error(`Cannot connect to etcd ${opts.host}:${opts.port}: ${err.message}`));
    });

    req.write(reqBodyStr);
    req.end();
  });
}

/**
 * grant_lease — Create a lease with a TTL (seconds).
 */
async function opGrantLease(args) {
  const opts = await buildOpts(args);
  const ttl  = clampInt(args.ttl, 30, 1, 86400, "ttl");
  const id   = args.id ? String(args.id) : "0"; // 0 = let etcd choose

  const res = await etcdPost(opts, "/v3/lease/grant", { TTL: String(ttl), ID: id }, opts.timeoutMs);

  return {
    ok:        true,
    operation: "grant_lease",
    server:    `${opts.host}:${opts.port}`,
    lease_id:  res.ID || res.id || null,
    ttl:       Number(res.TTL || res.ttl || ttl),
  };
}

/**
 * revoke_lease — Revoke a lease by ID (also deletes all attached keys).
 */
async function opRevokeLease(args) {
  const opts = await buildOpts(args);
  if (!args.lease_id) throw new Error("revoke_lease requires 'lease_id'");

  await etcdPost(opts, "/v3/lease/revoke", { ID: String(args.lease_id) }, opts.timeoutMs);

  return {
    ok:        true,
    operation: "revoke_lease",
    server:    `${opts.host}:${opts.port}`,
    lease_id:  String(args.lease_id),
    revoked:   true,
  };
}

/**
 * keepalive — Refresh a lease TTL to keep it alive.
 */
async function opKeepalive(args) {
  const opts = await buildOpts(args);
  if (!args.lease_id) throw new Error("keepalive requires 'lease_id'");

  const res = await etcdPost(opts, "/v3/lease/keepalive", { ID: String(args.lease_id) }, opts.timeoutMs);

  // keepalive returns a streaming response; parse first JSON result
  let result = res;
  if (res.result) result = res.result;

  return {
    ok:        true,
    operation: "keepalive",
    server:    `${opts.host}:${opts.port}`,
    lease_id:  result.ID || result.id || String(args.lease_id),
    ttl:       Number(result.TTL || result.ttl || 0),
  };
}

/**
 * lock — Acquire a distributed mutex via /v3/lock/lock.
 * Blocks until the lock is acquired or the request times out.
 */
async function opLock(args) {
  const opts = await buildOpts(args);
  if (!args.name) throw new Error("lock requires 'name'");
  guardString(args.name, "name");

  const reqBody = { name: toB64(args.name) };
  if (args.lease_id) reqBody.lease = String(args.lease_id);

  const res = await etcdPost(opts, "/v3/lock/lock", reqBody, opts.timeoutMs);

  return {
    ok:        true,
    operation: "lock",
    server:    `${opts.host}:${opts.port}`,
    name:      args.name,
    key:       fromB64(res.key || ""),
    revision:  res.header && res.header.revision ? res.header.revision : null,
  };
}

/**
 * unlock — Release a distributed mutex.
 */
async function opUnlock(args) {
  const opts = await buildOpts(args);
  if (!args.key) throw new Error("unlock requires 'key' (the lock key returned by lock)");
  guardString(args.key, "key");

  await etcdPost(opts, "/v3/lock/unlock", { key: toB64(args.key) }, opts.timeoutMs);

  return {
    ok:        true,
    operation: "unlock",
    server:    `${opts.host}:${opts.port}`,
    key:       args.key,
    released:  true,
  };
}

/**
 * status — Return the status of the etcd member.
 */
async function opStatus(args) {
  const opts = await buildOpts(args);

  const res = await etcdPost(opts, "/v3/maintenance/status", {}, opts.timeoutMs);

  return {
    ok:           true,
    operation:    "status",
    server:       `${opts.host}:${opts.port}`,
    version:      res.version      || null,
    db_size:      Number(res.dbSize      || 0),
    db_size_in_use: Number(res.dbSizeInUse || 0),
    leader:       res.leader       || null,
    raft_index:   res.raftIndex    || null,
    raft_term:    res.raftTerm     || null,
    raft_applied_index: res.raftAppliedIndex || null,
    is_learner:   !!res.isLearner,
  };
}

/**
 * members — List all cluster members.
 */
async function opMembers(args) {
  const opts = await buildOpts(args);

  const res = await etcdPost(opts, "/v3/cluster/member/list", {}, opts.timeoutMs);

  const members = (res.members || []).map(m => ({
    id:          m.ID   || m.id   || null,
    name:        m.name || null,
    peer_urls:   m.peerURLs   || m.peerUrls   || [],
    client_urls: m.clientURLs || m.clientUrls || [],
    is_learner:  !!m.isLearner,
  }));

  return {
    ok:        true,
    operation: "members",
    server:    `${opts.host}:${opts.port}`,
    count:     members.length,
    members,
    revision:  res.header && res.header.revision ? res.header.revision : null,
  };
}

/**
 * compact — Compact etcd revision history up to (and including) a revision.
 */
async function opCompact(args) {
  const opts = await buildOpts(args);
  if (!args.revision) throw new Error("compact requires 'revision'");

  const reqBody = {
    revision: String(args.revision),
    physical: !!args.physical, // wait for physical compaction
  };

  await etcdPost(opts, "/v3/kv/compaction", reqBody, opts.timeoutMs);

  return {
    ok:        true,
    operation: "compact",
    server:    `${opts.host}:${opts.port}`,
    revision:  String(args.revision),
    physical:  !!args.physical,
  };
}

/**
 * txn — Execute a mini-transaction.
 * compare: array of Compare objects
 * success: array of RequestOp (put/delete/range) if all compares pass
 * failure: array of RequestOp if any compare fails
 *
 * Compare object: { key, target ("VERSION"|"CREATE"|"MOD"|"VALUE"), result ("EQUAL"|"GREATER"|"LESS"|"NOT_EQUAL"), value? }
 * RequestOp: { request_put?: {key,value,lease?}, request_delete_range?: {key,range_end?}, request_range?: {key,range_end?} }
 */
async function opTxn(args) {
  const opts = await buildOpts(args);

  // Build compare array
  const compare = (args.compare || []).map(c => {
    const obj = {
      key:    toB64(c.key || ""),
      target: c.target || "VALUE",
      result: c.result || "EQUAL",
    };
    if (c.value       !== undefined) obj.value        = toB64(String(c.value));
    if (c.version     !== undefined) obj.version      = String(c.version);
    if (c.create_revision !== undefined) obj.create_revision = String(c.create_revision);
    if (c.mod_revision    !== undefined) obj.mod_revision    = String(c.mod_revision);
    return obj;
  });

  const encodeOp = (op) => {
    const out = {};
    if (op.request_put) {
      out.request_put = {
        key:   toB64(op.request_put.key || ""),
        value: toB64(op.request_put.value || ""),
      };
      if (op.request_put.lease) out.request_put.lease = String(op.request_put.lease);
    }
    if (op.request_delete_range) {
      out.request_delete_range = { key: toB64(op.request_delete_range.key || "") };
      if (op.request_delete_range.range_end)
        out.request_delete_range.range_end = toB64(op.request_delete_range.range_end);
    }
    if (op.request_range) {
      out.request_range = { key: toB64(op.request_range.key || "") };
      if (op.request_range.range_end)
        out.request_range.range_end = toB64(op.request_range.range_end);
    }
    return out;
  };

  const reqBody = {
    compare: compare,
    success: (args.success || []).map(encodeOp),
    failure: (args.failure || []).map(encodeOp),
  };

  const res = await etcdPost(opts, "/v3/kv/txn", reqBody, opts.timeoutMs);

  return {
    ok:        true,
    operation: "txn",
    server:    `${opts.host}:${opts.port}`,
    succeeded: !!res.succeeded,
    revision:  res.header && res.header.revision ? res.header.revision : null,
    responses: res.responses || [],
  };
}

/**
 * auth_enable — Enable authentication on the etcd cluster.
 */
async function opAuthEnable(args) {
  const opts = await buildOpts(args);
  await etcdPost(opts, "/v3/auth/enable", {}, opts.timeoutMs);
  return { ok: true, operation: "auth_enable", server: `${opts.host}:${opts.port}`, enabled: true };
}

/**
 * auth_disable — Disable authentication on the etcd cluster.
 */
async function opAuthDisable(args) {
  const opts = await buildOpts(args);
  await etcdPost(opts, "/v3/auth/disable", {}, opts.timeoutMs);
  return { ok: true, operation: "auth_disable", server: `${opts.host}:${opts.port}`, disabled: true };
}

/** Return protocol / operation reference — no I/O */
function opInfo() {
  return {
    protocol:    "etcd v3 gRPC-gateway HTTP/JSON API",
    version:     "Compatible with etcd 3.3+ (v3 API)",
    defaultPort: DEFAULT_PORT,
    apiBase:     "http[s]://<host>:<port>/v3/...",
    operations: [
      { op: "get",          description: "Read one key, a range, or all keys under a prefix" },
      { op: "put",          description: "Create or update a key with an optional lease" },
      { op: "delete",       description: "Delete a key, range, or all keys under a prefix" },
      { op: "list",         description: "List keys (or key+value) under a prefix" },
      { op: "watch",        description: "Short-poll for changes on a key or prefix" },
      { op: "grant_lease",  description: "Create a TTL lease for ephemeral keys" },
      { op: "revoke_lease", description: "Revoke a lease and delete all keys attached to it" },
      { op: "keepalive",    description: "Refresh a lease TTL" },
      { op: "lock",         description: "Acquire a distributed mutex lock" },
      { op: "unlock",       description: "Release a distributed mutex lock" },
      { op: "status",       description: "Return etcd member status (version, db size, raft index)" },
      { op: "members",      description: "List all etcd cluster members" },
      { op: "compact",      description: "Compact revision history up to a given revision" },
      { op: "txn",          description: "Execute a compare-and-swap mini-transaction" },
      { op: "auth_enable",  description: "Enable authentication on the cluster" },
      { op: "auth_disable", description: "Disable authentication on the cluster" },
      { op: "info",         description: "Return this protocol/config reference (no I/O)" },
    ],
    kvEncoding: {
      wire:   "Base64-encoded UTF-8 in JSON (gRPC-gateway convention)",
      decode: "This client decodes keys/values to UTF-8 strings automatically",
    },
    auth: {
      method:  "username + password → token (Bearer token in Authorization header)",
      useTls:  "Set use_tls:true to use HTTPS (etcd TLS port, default 2379)",
    },
    leases: {
      description: "Leases allow ephemeral keys that auto-expire when the TTL elapses",
      workflow:    "grant_lease → put (with lease_id) → keepalive in a loop → revoke_lease",
    },
    locks: {
      description: "Distributed mutex via etcd concurrency/v3lock — requires a lease",
      workflow:    "grant_lease → lock (with lease_id) → ... → unlock → revoke_lease",
    },
    transactions: {
      description: "Atomic compare-and-swap: compare conditions → success or failure ops",
      targets:     ["VERSION", "CREATE", "MOD", "VALUE"],
      results:     ["EQUAL", "GREATER", "LESS", "NOT_EQUAL"],
    },
    useCases: [
      "Distributed configuration management",
      "Service discovery and registration",
      "Distributed locking and leader election",
      "Kubernetes cluster state storage",
      "Feature flags with TTL-based expiry",
      "Optimistic concurrency via compare-and-swap transactions",
    ],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

async function etcdClient(args) {
  // Validate shared numeric/string args eagerly (even for info)
  if (args.timeout !== undefined && args.timeout !== null)
    clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  if (args.port !== undefined && args.port !== null)
    clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");

  const operation = (args.operation || "").toLowerCase().replace(/-/g, "_");
  switch (operation) {
    case "get":          return opGet(args);
    case "put":          return opPut(args);
    case "delete":       return opDelete(args);
    case "list":         return opList(args);
    case "watch":        return opWatch(args);
    case "grant_lease":  return opGrantLease(args);
    case "revoke_lease": return opRevokeLease(args);
    case "keepalive":    return opKeepalive(args);
    case "lock":         return opLock(args);
    case "unlock":       return opUnlock(args);
    case "status":       return opStatus(args);
    case "members":      return opMembers(args);
    case "compact":      return opCompact(args);
    case "txn":          return opTxn(args);
    case "auth_enable":  return opAuthEnable(args);
    case "auth_disable": return opAuthDisable(args);
    case "info":         return opInfo();
    default:
      throw new Error(
        `Unknown etcd_client operation: '${args.operation}'. ` +
        "Valid: get, put, delete, list, watch, grant_lease, revoke_lease, keepalive, " +
        "lock, unlock, status, members, compact, txn, auth_enable, auth_disable, info"
      );
  }
}

module.exports = {
  etcdClient,
  // Exported for testing
  toB64, fromB64, prefixRangeEnd, decodeKv,
  requireString, guardString, clampInt,
};
