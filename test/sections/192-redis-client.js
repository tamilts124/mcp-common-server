"use strict";
// ── Section 192: redis_client tool tests ──────────────────────────────────────
// Tests the zero-dep RESP2 Redis client (lib/redisClientOps.js).
// No live Redis server is required — all tests mock net.createConnection
// and drive the RESP2 parser via autoSock (replies sent on write(), not
// synchronously, so the socket 'data' listener is always registered first).

const assert = require("assert");
const net    = require("net");
const { EventEmitter } = require("events");
const { redisClient } = require("../../lib/redisClientOps");

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (e) {
    process.stdout.write(`  ✗ ${name}\n    ${e.message}\n`);
    failed++;
  }
}

function section(name) {
  process.stdout.write(`\n${name}\n`);
}

// ── autoSock helper ───────────────────────────────────────────────────────────
// Creates a fake socket that:
//   • emits 'connect' on setImmediate
//   • captures all bytes written in .written
//   • dequeues one reply per write() call and emits 'data' via setImmediate
// This ensures the RESP2 parser's 'data' listener is ALWAYS registered before
// data arrives (replies are deferred, never synchronous).
function autoSock(replies) {
  const queue = [...replies];
  const sock = new EventEmitter();
  sock.written   = Buffer.alloc(0);
  sock.destroyed = false;
  sock.write = (data) => {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    sock.written = Buffer.concat([sock.written, buf]);
    const reply = queue.shift();
    if (reply !== undefined)
      setImmediate(() => sock.emit("data", Buffer.from(reply)));
    return true;
  };
  sock.destroy = (err) => {
    sock.destroyed = true;
    if (err) sock.emit("error", err);
    else     sock.emit("close");
  };
  setImmediate(() => sock.emit("connect"));
  return sock;
}

// ── Patch net.createConnection to return a mock ───────────────────────────────
function patchNet(socketOrFn) {
  const orig = net.createConnection;
  net.createConnection = (...args) => (
    typeof socketOrFn === "function" ? socketOrFn(...args) : socketOrFn
  );
  return { restore: () => { net.createConnection = orig; } };
}

// ── Simple RESP2 helpers ──────────────────────────────────────────────────────
const RESP = {
  ok:       "+OK\r\n",
  pong:     "+PONG\r\n",
  int:  (n) => `:${n}\r\n`,
  bulk: (s) => s === null ? "$-1\r\n" : `$${Buffer.byteLength(s)}\r\n${s}\r\n`,
  err:  (m) => `-ERR ${m}\r\n`,
  arr:  (items) => {
    if (items === null) return "*-1\r\n";
    let out = `*${items.length}\r\n`;
    for (const item of items)
      out += typeof item === "number" ? RESP.int(item) : RESP.bulk(item);
    return out;
  },
};

// ── Run tests ─────────────────────────────────────────────────────────────────

(async () => {

// ═════════════════════════════════════════════════════════════════════════════
section("A — RESP2 Parser unit tests");
// ═════════════════════════════════════════════════════════════════════════════
// All tests use autoSock so replies are deferred to after the 'data'
// listener is registered.  This avoids the synchronous-inject hang.

await test("A01 parse +OK simple string", async () => {
  const p = patchNet(autoSock([RESP.pong]));
  try {
    const r = await redisClient({ host: "127.0.0.1", operation: "ping" });
    assert.strictEqual(r.pong, true);
    assert.strictEqual(r.response, "PONG");
  } finally { p.restore(); }
});

await test("A02 parse $N bulk string", async () => {
  const p = patchNet(autoSock([RESP.bulk("world")]));
  try {
    const r = await redisClient({ host: "127.0.0.1", operation: "get", key: "hello" });
    assert.strictEqual(r.value, "world");
  } finally { p.restore(); }
});

await test("A03 parse $-1 null bulk", async () => {
  const p = patchNet(autoSock([RESP.bulk(null)]));
  try {
    const r = await redisClient({ host: "127.0.0.1", operation: "get", key: "missing" });
    assert.strictEqual(r.value, null);
    assert.strictEqual(r.exists, false);
  } finally { p.restore(); }
});

await test("A04 parse :N integer", async () => {
  const p = patchNet(autoSock([RESP.int(42)]));
  try {
    const r = await redisClient({ host: "127.0.0.1", operation: "dbsize" });
    assert.strictEqual(r.dbsize, 42);
  } finally { p.restore(); }
});

await test("A05 parse *N array", async () => {
  const p = patchNet(autoSock([RESP.arr(["a", "b", "c"])]));
  try {
    const r = await redisClient({ host: "127.0.0.1", operation: "keys", key: "*" });
    assert.deepStrictEqual(r.keys, ["a", "b", "c"]);
    assert.strictEqual(r.count, 3);
  } finally { p.restore(); }
});

await test("A06 parse -ERR error reply", async () => {
  const p = patchNet(autoSock([RESP.err("WRONGTYPE wrong kind")]));
  try {
    await assert.rejects(
      () => redisClient({ host: "127.0.0.1", operation: "get", key: "k" }),
      /WRONGTYPE/,
    );
  } finally { p.restore(); }
});

await test("A07 parse fragmented bulk string (multi-chunk)", async () => {
  // Emit 3 fragments across nested setImmediate ticks on first write.
  const full = RESP.bulk("helloworld");
  const frags = [
    Buffer.from(full.slice(0, 4)),
    Buffer.from(full.slice(4, 8)),
    Buffer.from(full.slice(8)),
  ];
  const sock = new EventEmitter();
  sock.written   = Buffer.alloc(0);
  sock.destroyed = false;
  let firstWrite = true;
  sock.write = (data) => {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    sock.written = Buffer.concat([sock.written, buf]);
    if (firstWrite) {
      firstWrite = false;
      setImmediate(() => {
        sock.emit("data", frags[0]);
        setImmediate(() => {
          sock.emit("data", frags[1]);
          setImmediate(() => sock.emit("data", frags[2]));
        });
      });
    }
    return true;
  };
  sock.destroy = () => { sock.destroyed = true; };
  setImmediate(() => sock.emit("connect"));
  const p = patchNet(sock);
  try {
    const r = await redisClient({ host: "127.0.0.1", operation: "get", key: "k" });
    assert.strictEqual(r.value, "helloworld");
  } finally { p.restore(); }
});

await test("A08 parse *-1 null array", async () => {
  const p = patchNet(autoSock(["*-1\r\n"]));
  try {
    const r = await redisClient({ host: "127.0.0.1", operation: "keys", key: "nomatch" });
    assert.strictEqual(r.keys, null);
  } finally { p.restore(); }
});

await test("A09 parse nested array (HGETALL flat array → object)", async () => {
  const p = patchNet(autoSock([RESP.arr(["field1", "val1", "field2", "val2"])]));
  try {
    const r = await redisClient({ host: "127.0.0.1", operation: "hgetall", key: "myhash" });
    assert.deepStrictEqual(r.hash, { field1: "val1", field2: "val2" });
    assert.strictEqual(r.fieldCount, 2);
  } finally { p.restore(); }
});

await test("A10 parse RESP2 consecutive replies (pipeline)", async () => {
  // 3 pipelined commands → 3 replies concatenated in one data event.
  const combined = RESP.ok + RESP.bulk("myval") + RESP.int(1);
  const p = patchNet(autoSock([combined]));
  try {
    const r = await redisClient({
      host: "127.0.0.1",
      operation: "pipeline",
      commands: [["SET", "k", "v"], ["GET", "k"], ["DEL", "k"]],
    });
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.succeeded, 3);
    assert.strictEqual(r.results[0].reply, "OK");
    assert.strictEqual(r.results[1].reply, "myval");
    assert.strictEqual(r.results[2].reply, 1);
  } finally { p.restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════
section("B — Input validation tests");
// ═════════════════════════════════════════════════════════════════════════════

await test("B01 missing host throws", async () => {
  await assert.rejects(
    () => redisClient({ operation: "ping" }),
    /host.*required/i,
  );
});

await test("B02 invalid operation throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "INVALID_OP" }),
    /unknown operation/i,
  );
});

await test("B03 empty key for 'get' throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "get", key: "" }),
    /must not be empty/i,
  );
});

await test("B04 missing keys for 'mget' throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "mget", keys: [] }),
    /non-empty array/i,
  );
});

await test("B05 negative select_db throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "select", select_db: -1 }),
    /non-negative integer/i,
  );
});

await test("B06 missing 'value' for 'set' throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "set", key: "k" }),
    /value.*required/i,
  );
});

await test("B07 missing ex for 'expire' throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "expire", key: "k" }),
    /ex.*required/i,
  );
});

await test("B08 non-integer amount for incrby throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "incrby", key: "k", amount: 1.5 }),
    /must be an integer/i,
  );
});

await test("B09 invalid float for incrbyfloat throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "incrbyfloat", key: "k", amount: NaN }),
    /finite number/i,
  );
});

await test("B10 pipeline with empty commands throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "pipeline", commands: [] }),
    /non-empty array/i,
  );
});

await test("B11 pipeline exceeds 500 command limit throws", async () => {
  const cmds = Array.from({ length: 501 }, () => ["PING"]);
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "pipeline", commands: cmds }),
    /exceeds 500/i,
  );
});

await test("B12 empty field_values for mset throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "mset", field_values: {} }),
    /must not be empty/i,
  );
});

await test("B13 zadd with non-finite score throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "zadd", key: "z", score: Infinity, member: "m" }),
    /finite number/i,
  );
});

await test("B14 setrange with negative offset throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "setrange", key: "k", offset: -1, value: "x" }),
    /non-negative integer/i,
  );
});

await test("B15 zincrby with NaN amount throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "zincrby", key: "z", amount: NaN, member: "m" }),
    /finite number/i,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
section("C — Security / injection guard tests");
// ═════════════════════════════════════════════════════════════════════════════

await test("C01 key with \\r\\n rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "get", key: "bad\r\nkey" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C02 key with NUL byte rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "get", key: "ba\x00d" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C03 key exceeding 4096 bytes rejected", async () => {
  const longKey = "k".repeat(4097);
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "get", key: longKey }),
    /4096-byte limit/i,
  );
});

await test("C04 channel with \\n rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "publish", channel: "chan\nnel", message: "msg" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C05 field with \\r rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "hget", key: "h", field: "f\rield" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C06 message with NUL byte rejected for ping", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "ping", message: "hel\x00lo" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C07 username with \\r\\n rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "ping", username: "user\r\nname", password: "pass" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C08 info_section with \\n rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "info", info_section: "se\nction" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C09 mset key with NUL byte rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "mset", field_values: { ["k\x00ey"]: "val" } }),
    /CR.*LF.*NUL/i,
  );
});

await test("C10 hset field with \\r\\n rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "hset", key: "h", field_values: { ["f\r\nield"]: "v" } }),
    /CR.*LF.*NUL/i,
  );
});

await test("C11 keys array element with NUL rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "mget", keys: ["ok", "bad\x00key"] }),
    /CR.*LF.*NUL/i,
  );
});

await test("C12 new_key with \\n rejected for rename", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "rename", key: "src", new_key: "dst\nkey" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C13 password with NUL byte rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "ping", password: "pass\x00word" }),
    /CR.*LF.*NUL/i,
  );
});

await test("C14 pipeline RESP2 encodes value with \\r\\n safely", async () => {
  // RESP2 uses byte-length encoding, so \r\n inside a value is safe;
  // only key/channel/field identifiers are injection-guarded.
  const sock = autoSock([RESP.ok + RESP.ok]);
  const p = patchNet(sock);
  try {
    const r = await redisClient({
      host: "127.0.0.1",
      operation: "pipeline",
      commands: [["SET", "k", "value with\r\nnewline"], ["DEL", "k"]],
    });
    assert.ok(sock.written.toString().includes("value with"));
    assert.strictEqual(r.count, 2);
  } finally { p.restore(); }
});

await test("C15 empty string key rejected", async () => {
  await assert.rejects(
    () => redisClient({ host: "127.0.0.1", operation: "del", key: "" }),
    /must not be empty/i,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
section("D — Happy path mock tests (all operation groups)");
// ═════════════════════════════════════════════════════════════════════════════

await test("D01 ping", async () => {
  const p = patchNet(autoSock([RESP.pong]));
  try {
    const r = await redisClient({ host: "h", operation: "ping" });
    assert.strictEqual(r.pong, true);
    assert.strictEqual(r.response, "PONG");
    assert.ok(typeof r.elapsedMs === "number");
  } finally { p.restore(); }
});

await test("D02 ping with message", async () => {
  const p = patchNet(autoSock([RESP.bulk("hello")]));
  try {
    const r = await redisClient({ host: "h", operation: "ping", message: "hello" });
    assert.strictEqual(r.response, "hello");
  } finally { p.restore(); }
});

await test("D03 info", async () => {
  const infoRaw = "# Server\r\nredis_version:7.0.0\r\nos:Linux\r\n";
  const p = patchNet(autoSock([RESP.bulk(infoRaw)]));
  try {
    const r = await redisClient({ host: "h", operation: "info" });
    assert.strictEqual(r.parsed.redis_version, "7.0.0");
    assert.strictEqual(r.parsed.os, "Linux");
  } finally { p.restore(); }
});

await test("D04 dbsize", async () => {
  const p = patchNet(autoSock([RESP.int(100)]));
  try {
    const r = await redisClient({ host: "h", operation: "dbsize" });
    assert.strictEqual(r.dbsize, 100);
  } finally { p.restore(); }
});

await test("D05 select", async () => {
  const p = patchNet(autoSock([RESP.ok]));
  try {
    const r = await redisClient({ host: "h", operation: "select", select_db: 3 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.db, 3);
  } finally { p.restore(); }
});

await test("D06 flushdb", async () => {
  const p = patchNet(autoSock([RESP.ok]));
  try {
    const r = await redisClient({ host: "h", operation: "flushdb" });
    assert.strictEqual(r.ok, true);
  } finally { p.restore(); }
});

await test("D07 flushdb async", async () => {
  const sock = autoSock([RESP.ok]);
  const p = patchNet(sock);
  try {
    const r = await redisClient({ host: "h", operation: "flushdb", async_flush: true });
    assert.strictEqual(r.ok, true);
    assert.ok(sock.written.toString().includes("ASYNC"));
  } finally { p.restore(); }
});

await test("D08 get existing key", async () => {
  const p = patchNet(autoSock([RESP.bulk("myvalue")]));
  try {
    const r = await redisClient({ host: "h", operation: "get", key: "mykey" });
    assert.strictEqual(r.value, "myvalue");
    assert.strictEqual(r.exists, true);
  } finally { p.restore(); }
});

await test("D09 set", async () => {
  const p = patchNet(autoSock([RESP.ok]));
  try {
    const r = await redisClient({ host: "h", operation: "set", key: "k", value: "v" });
    assert.strictEqual(r.ok, true);
  } finally { p.restore(); }
});

await test("D10 set with EX option encodes correctly", async () => {
  const sock = autoSock([RESP.ok]);
  const p = patchNet(sock);
  try {
    await redisClient({ host: "h", operation: "set", key: "k", value: "v", ex: 60 });
    const cmd = sock.written.toString();
    assert.ok(cmd.includes("EX"));
    assert.ok(cmd.includes("60"));
  } finally { p.restore(); }
});

await test("D11 set with NX flag (key exists → null)", async () => {
  const p = patchNet(autoSock([RESP.bulk(null)])); // NX rejected → null
  try {
    const r = await redisClient({ host: "h", operation: "set", key: "k", value: "v", nx: true });
    assert.strictEqual(r.ok, false);
  } finally { p.restore(); }
});

await test("D12 del multi-key", async () => {
  const p = patchNet(autoSock([RESP.int(2)]));
  try {
    const r = await redisClient({ host: "h", operation: "del", keys: ["k1", "k2"] });
    assert.strictEqual(r.deleted, 2);
  } finally { p.restore(); }
});

await test("D13 exists multi-key", async () => {
  const p = patchNet(autoSock([RESP.int(3)]));
  try {
    const r = await redisClient({ host: "h", operation: "exists", keys: ["a", "b", "b"] });
    assert.strictEqual(r.count, 3);
  } finally { p.restore(); }
});

await test("D14 expire", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "expire", key: "k", ex: 120 });
    assert.strictEqual(r.set, true);
  } finally { p.restore(); }
});

await test("D15 pexpire", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "pexpire", key: "k", px: 5000 });
    assert.strictEqual(r.set, true);
  } finally { p.restore(); }
});

await test("D16 ttl", async () => {
  const p = patchNet(autoSock([RESP.int(59)]));
  try {
    const r = await redisClient({ host: "h", operation: "ttl", key: "k" });
    assert.strictEqual(r.ttl, 59);
  } finally { p.restore(); }
});

await test("D17 pttl", async () => {
  const p = patchNet(autoSock([RESP.int(4321)]));
  try {
    const r = await redisClient({ host: "h", operation: "pttl", key: "k" });
    assert.strictEqual(r.pttl, 4321);
  } finally { p.restore(); }
});

await test("D18 persist", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "persist", key: "k" });
    assert.strictEqual(r.removed, true);
  } finally { p.restore(); }
});

await test("D19 keys pattern", async () => {
  const p = patchNet(autoSock([RESP.arr(["user:1", "user:2"])]));
  try {
    const r = await redisClient({ host: "h", operation: "keys", key: "user:*" });
    assert.deepStrictEqual(r.keys, ["user:1", "user:2"]);
    assert.strictEqual(r.pattern, "user:*");
  } finally { p.restore(); }
});

await test("D20 type", async () => {
  const p = patchNet(autoSock(["+string\r\n"]));
  try {
    const r = await redisClient({ host: "h", operation: "type", key: "k" });
    assert.strictEqual(r.type, "string");
  } finally { p.restore(); }
});

await test("D21 rename", async () => {
  const p = patchNet(autoSock([RESP.ok]));
  try {
    const r = await redisClient({ host: "h", operation: "rename", key: "old", new_key: "new" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.from, "old");
    assert.strictEqual(r.to, "new");
  } finally { p.restore(); }
});

await test("D22 incr", async () => {
  const p = patchNet(autoSock([RESP.int(5)]));
  try {
    const r = await redisClient({ host: "h", operation: "incr", key: "counter" });
    assert.strictEqual(r.value, 5);
  } finally { p.restore(); }
});

await test("D23 decr", async () => {
  const p = patchNet(autoSock([RESP.int(3)]));
  try {
    const r = await redisClient({ host: "h", operation: "decr", key: "counter" });
    assert.strictEqual(r.value, 3);
  } finally { p.restore(); }
});

await test("D24 incrby", async () => {
  const p = patchNet(autoSock([RESP.int(15)]));
  try {
    const r = await redisClient({ host: "h", operation: "incrby", key: "counter", amount: 10 });
    assert.strictEqual(r.value, 15);
  } finally { p.restore(); }
});

await test("D25 decrby", async () => {
  const p = patchNet(autoSock([RESP.int(0)]));
  try {
    const r = await redisClient({ host: "h", operation: "decrby", key: "counter", amount: 5 });
    assert.strictEqual(r.value, 0);
  } finally { p.restore(); }
});

await test("D26 incrbyfloat", async () => {
  const p = patchNet(autoSock([RESP.bulk("10.5")]));
  try {
    const r = await redisClient({ host: "h", operation: "incrbyfloat", key: "f", amount: 0.5 });
    assert.strictEqual(r.value, "10.5");
  } finally { p.restore(); }
});

await test("D27 append_str", async () => {
  const p = patchNet(autoSock([RESP.int(11)]));
  try {
    const r = await redisClient({ host: "h", operation: "append_str", key: "k", value: " world" });
    assert.strictEqual(r.length, 11);
  } finally { p.restore(); }
});

await test("D28 getrange", async () => {
  const p = patchNet(autoSock([RESP.bulk("hello")]));
  try {
    const r = await redisClient({ host: "h", operation: "getrange", key: "k", range_start: 0, range_end: 4 });
    assert.strictEqual(r.value, "hello");
  } finally { p.restore(); }
});

await test("D29 setrange", async () => {
  const p = patchNet(autoSock([RESP.int(11)]));
  try {
    const r = await redisClient({ host: "h", operation: "setrange", key: "k", offset: 6, value: "Redis" });
    assert.strictEqual(r.length, 11);
  } finally { p.restore(); }
});

await test("D30 mget", async () => {
  const p = patchNet(autoSock([RESP.arr(["val1", null, "val3"])]));
  try {
    const r = await redisClient({ host: "h", operation: "mget", keys: ["k1", "k2", "k3"] });
    assert.deepStrictEqual(r.values, { k1: "val1", k2: null, k3: "val3" });
  } finally { p.restore(); }
});

await test("D31 mset", async () => {
  const p = patchNet(autoSock([RESP.ok]));
  try {
    const r = await redisClient({ host: "h", operation: "mset", field_values: { a: "1", b: "2" } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
  } finally { p.restore(); }
});

await test("D32 hget", async () => {
  const p = patchNet(autoSock([RESP.bulk("fieldval")]));
  try {
    const r = await redisClient({ host: "h", operation: "hget", key: "h", field: "f" });
    assert.strictEqual(r.value, "fieldval");
  } finally { p.restore(); }
});

await test("D33 hset single", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "hset", key: "h", field: "f", value: "v" });
    assert.strictEqual(r.added, 1);
  } finally { p.restore(); }
});

await test("D34 hset bulk via field_values", async () => {
  const p = patchNet(autoSock([RESP.int(2)]));
  try {
    const r = await redisClient({ host: "h", operation: "hset", key: "h", field_values: { f1: "v1", f2: "v2" } });
    assert.strictEqual(r.added, 2);
  } finally { p.restore(); }
});

await test("D35 hmget", async () => {
  const p = patchNet(autoSock([RESP.arr(["v1", null])]));
  try {
    const r = await redisClient({ host: "h", operation: "hmget", key: "h", fields: ["f1", "f2"] });
    assert.deepStrictEqual(r.values, { f1: "v1", f2: null });
  } finally { p.restore(); }
});

await test("D36 hmset", async () => {
  const p = patchNet(autoSock([RESP.ok]));
  try {
    const r = await redisClient({ host: "h", operation: "hmset", key: "h", field_values: { a: "1", b: "2" } });
    assert.strictEqual(r.ok, true);
  } finally { p.restore(); }
});

await test("D37 hdel", async () => {
  const p = patchNet(autoSock([RESP.int(2)]));
  try {
    const r = await redisClient({ host: "h", operation: "hdel", key: "h", fields: ["f1", "f2"] });
    assert.strictEqual(r.deleted, 2);
  } finally { p.restore(); }
});

await test("D38 hgetall", async () => {
  const p = patchNet(autoSock([RESP.arr(["f1", "v1", "f2", "v2"])]));
  try {
    const r = await redisClient({ host: "h", operation: "hgetall", key: "h" });
    assert.deepStrictEqual(r.hash, { f1: "v1", f2: "v2" });
    assert.strictEqual(r.fieldCount, 2);
  } finally { p.restore(); }
});

await test("D39 hkeys", async () => {
  const p = patchNet(autoSock([RESP.arr(["f1", "f2"])]));
  try {
    const r = await redisClient({ host: "h", operation: "hkeys", key: "h" });
    assert.deepStrictEqual(r.fields, ["f1", "f2"]);
    assert.strictEqual(r.count, 2);
  } finally { p.restore(); }
});

await test("D40 hvals", async () => {
  const p = patchNet(autoSock([RESP.arr(["v1", "v2"])]));
  try {
    const r = await redisClient({ host: "h", operation: "hvals", key: "h" });
    assert.deepStrictEqual(r.values, ["v1", "v2"]);
  } finally { p.restore(); }
});

await test("D41 hlen", async () => {
  const p = patchNet(autoSock([RESP.int(3)]));
  try {
    const r = await redisClient({ host: "h", operation: "hlen", key: "h" });
    assert.strictEqual(r.length, 3);
  } finally { p.restore(); }
});

await test("D42 hexists", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "hexists", key: "h", field: "f" });
    assert.strictEqual(r.exists, true);
  } finally { p.restore(); }
});

await test("D43 lpush", async () => {
  const p = patchNet(autoSock([RESP.int(3)]));
  try {
    const r = await redisClient({ host: "h", operation: "lpush", key: "mylist", elements: ["a", "b", "c"] });
    assert.strictEqual(r.length, 3);
  } finally { p.restore(); }
});

await test("D44 rpush", async () => {
  const p = patchNet(autoSock([RESP.int(2)]));
  try {
    const r = await redisClient({ host: "h", operation: "rpush", key: "mylist", value: "x" });
    assert.strictEqual(r.length, 2);
  } finally { p.restore(); }
});

await test("D45 lpop", async () => {
  const p = patchNet(autoSock([RESP.bulk("first")]));
  try {
    const r = await redisClient({ host: "h", operation: "lpop", key: "mylist" });
    assert.strictEqual(r.value, "first");
  } finally { p.restore(); }
});

await test("D46 rpop", async () => {
  const p = patchNet(autoSock([RESP.bulk("last")]));
  try {
    const r = await redisClient({ host: "h", operation: "rpop", key: "mylist" });
    assert.strictEqual(r.value, "last");
  } finally { p.restore(); }
});

await test("D47 llen", async () => {
  const p = patchNet(autoSock([RESP.int(5)]));
  try {
    const r = await redisClient({ host: "h", operation: "llen", key: "mylist" });
    assert.strictEqual(r.length, 5);
  } finally { p.restore(); }
});

await test("D48 lrange", async () => {
  const p = patchNet(autoSock([RESP.arr(["a", "b", "c"])]));
  try {
    const r = await redisClient({ host: "h", operation: "lrange", key: "mylist", start: 0, stop: -1 });
    assert.deepStrictEqual(r.elements, ["a", "b", "c"]);
    assert.strictEqual(r.count, 3);
  } finally { p.restore(); }
});

await test("D49 lindex", async () => {
  const p = patchNet(autoSock([RESP.bulk("b")]));
  try {
    const r = await redisClient({ host: "h", operation: "lindex", key: "mylist", index: 1 });
    assert.strictEqual(r.value, "b");
  } finally { p.restore(); }
});

await test("D50 lset", async () => {
  const p = patchNet(autoSock([RESP.ok]));
  try {
    const r = await redisClient({ host: "h", operation: "lset", key: "mylist", index: 0, value: "new" });
    assert.strictEqual(r.ok, true);
  } finally { p.restore(); }
});

await test("D51 ltrim", async () => {
  const p = patchNet(autoSock([RESP.ok]));
  try {
    const r = await redisClient({ host: "h", operation: "ltrim", key: "mylist", start: 0, stop: 2 });
    assert.strictEqual(r.ok, true);
  } finally { p.restore(); }
});

await test("D52 sadd", async () => {
  const p = patchNet(autoSock([RESP.int(2)]));
  try {
    const r = await redisClient({ host: "h", operation: "sadd", key: "myset", members: ["a", "b"] });
    assert.strictEqual(r.added, 2);
  } finally { p.restore(); }
});

await test("D53 smembers", async () => {
  const p = patchNet(autoSock([RESP.arr(["a", "b"])]));
  try {
    const r = await redisClient({ host: "h", operation: "smembers", key: "myset" });
    assert.deepStrictEqual(r.members, ["a", "b"]);
  } finally { p.restore(); }
});

await test("D54 srem", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "srem", key: "myset", members: ["a"] });
    assert.strictEqual(r.removed, 1);
  } finally { p.restore(); }
});

await test("D55 sismember", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "sismember", key: "myset", member: "a" });
    assert.strictEqual(r.isMember, true);
  } finally { p.restore(); }
});

await test("D56 scard", async () => {
  const p = patchNet(autoSock([RESP.int(4)]));
  try {
    const r = await redisClient({ host: "h", operation: "scard", key: "myset" });
    assert.strictEqual(r.count, 4);
  } finally { p.restore(); }
});

await test("D57 sinter", async () => {
  const p = patchNet(autoSock([RESP.arr(["b", "c"])]));
  try {
    const r = await redisClient({ host: "h", operation: "sinter", keys: ["s1", "s2"] });
    assert.deepStrictEqual(r.members, ["b", "c"]);
  } finally { p.restore(); }
});

await test("D58 sunion", async () => {
  const p = patchNet(autoSock([RESP.arr(["a", "b", "c"])]));
  try {
    const r = await redisClient({ host: "h", operation: "sunion", keys: ["s1", "s2"] });
    assert.strictEqual(r.count, 3);
  } finally { p.restore(); }
});

await test("D59 sdiff", async () => {
  const p = patchNet(autoSock([RESP.arr(["a"])]));
  try {
    const r = await redisClient({ host: "h", operation: "sdiff", keys: ["s1", "s2"] });
    assert.deepStrictEqual(r.members, ["a"]);
  } finally { p.restore(); }
});

await test("D60 zadd single member", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "zadd", key: "z", score: 1.5, member: "m" });
    assert.strictEqual(r.added, 1);
  } finally { p.restore(); }
});

await test("D61 zadd multi via field_values", async () => {
  const p = patchNet(autoSock([RESP.int(2)]));
  try {
    const r = await redisClient({ host: "h", operation: "zadd", key: "z", field_values: { m1: 1, m2: 2 } });
    assert.strictEqual(r.added, 2);
  } finally { p.restore(); }
});

await test("D62 zrange without scores", async () => {
  const p = patchNet(autoSock([RESP.arr(["m1", "m2"])]));
  try {
    const r = await redisClient({ host: "h", operation: "zrange", key: "z", start: 0, stop: -1 });
    assert.deepStrictEqual(r.members, ["m1", "m2"]);
  } finally { p.restore(); }
});

await test("D63 zrange with scores", async () => {
  const p = patchNet(autoSock([RESP.arr(["m1", "1.5", "m2", "2.5"])]));
  try {
    const r = await redisClient({ host: "h", operation: "zrange", key: "z", start: 0, stop: -1, with_scores: true });
    assert.deepStrictEqual(r.members, [{ member: "m1", score: 1.5 }, { member: "m2", score: 2.5 }]);
  } finally { p.restore(); }
});

await test("D64 zrangebyscore", async () => {
  const p = patchNet(autoSock([RESP.arr(["m1", "m2"])]));
  try {
    const r = await redisClient({ host: "h", operation: "zrangebyscore", key: "z", min: 0, max: 5 });
    assert.deepStrictEqual(r.members, ["m1", "m2"]);
  } finally { p.restore(); }
});

await test("D65 zrangebyscore rev uses ZREVRANGEBYSCORE", async () => {
  const sock = autoSock([RESP.arr(["m2", "m1"])]);
  const p = patchNet(sock);
  try {
    await redisClient({ host: "h", operation: "zrangebyscore", key: "z", rev: true });
    assert.ok(sock.written.toString().includes("ZREVRANGEBYSCORE"));
  } finally { p.restore(); }
});

await test("D66 zrank", async () => {
  const p = patchNet(autoSock([RESP.int(0)]));
  try {
    const r = await redisClient({ host: "h", operation: "zrank", key: "z", member: "m1" });
    assert.strictEqual(r.rank, 0);
  } finally { p.restore(); }
});

await test("D67 zscore", async () => {
  const p = patchNet(autoSock([RESP.bulk("1.5")]));
  try {
    const r = await redisClient({ host: "h", operation: "zscore", key: "z", member: "m1" });
    assert.strictEqual(r.score, 1.5);
  } finally { p.restore(); }
});

await test("D68 zrem", async () => {
  const p = patchNet(autoSock([RESP.int(1)]));
  try {
    const r = await redisClient({ host: "h", operation: "zrem", key: "z", members: ["m1"] });
    assert.strictEqual(r.removed, 1);
  } finally { p.restore(); }
});

await test("D69 zcard", async () => {
  const p = patchNet(autoSock([RESP.int(3)]));
  try {
    const r = await redisClient({ host: "h", operation: "zcard", key: "z" });
    assert.strictEqual(r.count, 3);
  } finally { p.restore(); }
});

await test("D70 zincrby", async () => {
  const p = patchNet(autoSock([RESP.bulk("3.5")]));
  try {
    const r = await redisClient({ host: "h", operation: "zincrby", key: "z", member: "m1", amount: 2.0 });
    assert.strictEqual(r.score, 3.5);
  } finally { p.restore(); }
});

await test("D71 publish", async () => {
  const p = patchNet(autoSock([RESP.int(3)]));
  try {
    const r = await redisClient({ host: "h", operation: "publish", channel: "news", message: "hello" });
    assert.strictEqual(r.receivers, 3);
    assert.strictEqual(r.channel, "news");
  } finally { p.restore(); }
});

await test("D72 pipeline success and partial failure", async () => {
  const replies = [RESP.ok, RESP.err("WRONGTYPE"), RESP.int(1)];
  let idx = 0;
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.write = (data) => {
    const reply = replies[idx++];
    if (reply) setImmediate(() => sock.emit("data", Buffer.from(reply)));
    return true;
  };
  sock.destroy = () => { sock.destroyed = true; };
  setImmediate(() => sock.emit("connect"));
  const p = patchNet(sock);
  try {
    const r = await redisClient({
      host: "h",
      operation: "pipeline",
      commands: [["SET", "k", "v"], ["LPUSH", "k", "x"], ["DEL", "k"]],
    });
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.succeeded, 2);
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.results[1].ok, false);
    assert.ok(r.results[1].error.includes("WRONGTYPE"));
  } finally { p.restore(); }
});

await test("D73 set with GET returns old value", async () => {
  const p = patchNet(autoSock([RESP.bulk("oldval")]));
  try {
    const r = await redisClient({ host: "h", operation: "set", key: "k", value: "newval", get_old: true });
    assert.strictEqual(r.oldValue, "oldval");
  } finally { p.restore(); }
});

await test("D74 zrangebyscore with LIMIT", async () => {
  const sock = autoSock([RESP.arr(["m2"])]);
  const p = patchNet(sock);
  try {
    await redisClient({ host: "h", operation: "zrangebyscore", key: "z", offset: 1, limit: 1 });
    assert.ok(sock.written.toString().includes("LIMIT"));
  } finally { p.restore(); }
});

await test("D75 zrank rev uses ZREVRANK", async () => {
  const sock = autoSock([RESP.int(2)]);
  const p = patchNet(sock);
  try {
    await redisClient({ host: "h", operation: "zrank", key: "z", member: "m", rev: true });
    assert.ok(sock.written.toString().includes("ZREVRANK"));
  } finally { p.restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════
section("E — Error path tests");
// ═════════════════════════════════════════════════════════════════════════════

await test("E01 connection refused → throws with socket error", async () => {
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.write = () => true;
  sock.destroy = () => { sock.destroyed = true; };
  setImmediate(() => sock.emit("error", new Error("ECONNREFUSED")));
  const p = patchNet(sock);
  try {
    await assert.rejects(
      () => redisClient({ host: "127.0.0.1", operation: "ping" }),
      /socket error.*ECONNREFUSED/i,
    );
  } finally { p.restore(); }
});

await test("E02 AUTH failure → throws", async () => {
  const p = patchNet(autoSock([RESP.err("WRONGPASS invalid username-password pair")]));
  try {
    await assert.rejects(
      () => redisClient({ host: "h", operation: "ping", password: "wrongpass" }),
      /AUTH failed/i,
    );
  } finally { p.restore(); }
});

await test("E03 connection closed mid-reply drains waiters with error", async () => {
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.write = () => {
    setImmediate(() => sock.emit("close"));
    return true;
  };
  sock.destroy = () => { sock.destroyed = true; };
  setImmediate(() => sock.emit("connect"));
  const p = patchNet(sock);
  try {
    await assert.rejects(
      () => redisClient({ host: "h", operation: "get", key: "k" }),
      /closed unexpectedly/i,
    );
  } finally { p.restore(); }
});

await test("E04 Redis error reply for GET → throws", async () => {
  const p = patchNet(autoSock([RESP.err("WRONGTYPE Operation against a key holding the wrong kind of value")]));
  try {
    await assert.rejects(
      () => redisClient({ host: "h", operation: "get", key: "k" }),
      /WRONGTYPE/,
    );
  } finally { p.restore(); }
});

await test("E05 response exceeds 8 MB budget → socket destroyed", async () => {
  const BUDGET = 8 * 1024 * 1024;
  const bigBuf = Buffer.concat([
    Buffer.from(`$${BUDGET + 1024 * 1024}\r\n`),
    Buffer.alloc(BUDGET + 1, 0x41),
  ]);
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.write = () => {
    setImmediate(() => sock.emit("data", bigBuf));
    return true;
  };
  sock.destroy = (err) => {
    sock.destroyed = true;
    if (err) sock.emit("error", err);
    else     sock.emit("close");
  };
  setImmediate(() => sock.emit("connect"));
  const p = patchNet(sock);
  try {
    await assert.rejects(
      () => redisClient({ host: "h", operation: "get", key: "k" }),
      /budget|closed/i,
    );
  } finally { p.restore(); }
});

await test("E06 timeout fires → throws timeout error", async () => {
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.write = () => true; // never replies
  sock.destroy = () => { sock.destroyed = true; sock.emit("close"); };
  setImmediate(() => sock.emit("connect"));
  const p = patchNet(sock);
  try {
    await assert.rejects(
      () => redisClient({ host: "h", operation: "get", key: "k", timeout: 0.05 }),
      /timed out/i,
    );
  } finally { p.restore(); }
});

await test("E07 SELECT failure in connection setup → throws", async () => {
  const p = patchNet(autoSock([RESP.err("ERR DB index is out of range")]));
  try {
    await assert.rejects(
      () => redisClient({ host: "h", operation: "ping", db: 1 }),
      /SELECT.*failed/i,
    );
  } finally { p.restore(); }
});

await test("E08 RENAME when key does not exist → Redis error propagated", async () => {
  const p = patchNet(autoSock([RESP.err("ERR no such key")]));
  try {
    await assert.rejects(
      () => redisClient({ host: "h", operation: "rename", key: "nokey", new_key: "dst" }),
      /ERR no such key/,
    );
  } finally { p.restore(); }
});

await test("E09 LSET out of range → Redis error propagated", async () => {
  const p = patchNet(autoSock([RESP.err("ERR index out of range")]));
  try {
    await assert.rejects(
      () => redisClient({ host: "h", operation: "lset", key: "mylist", index: 999, value: "x" }),
      /ERR index out of range/,
    );
  } finally { p.restore(); }
});

await test("E10 pipeline with empty sub-command throws", async () => {
  await assert.rejects(
    () => redisClient({ host: "h", operation: "pipeline", commands: [["SET", "k", "v"], []] }),
    /non-empty array/i,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
section("F — Concurrency / stress tests");
// ═════════════════════════════════════════════════════════════════════════════

await test("F01 10 concurrent pings", async () => {
  const orig = net.createConnection;
  let connCount = 0;
  net.createConnection = () => { connCount++; return autoSock([RESP.pong]); };
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => redisClient({ host: "h", operation: "ping" })),
    );
    assert.strictEqual(results.length, 10);
    assert.ok(results.every(r => r.pong === true));
    assert.strictEqual(connCount, 10);
  } finally { net.createConnection = orig; }
});

await test("F02 20 concurrent get operations", async () => {
  const orig = net.createConnection;
  let connCount = 0;
  net.createConnection = () => { connCount++; return autoSock([RESP.bulk("somevalue")]); };
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => redisClient({ host: "h", operation: "get", key: `key${i}` })),
    );
    assert.strictEqual(results.length, 20);
    assert.ok(results.every(r => r.value === "somevalue"));
    assert.strictEqual(connCount, 20);
  } finally { net.createConnection = orig; }
});

await test("F03 mixed operations concurrently", async () => {
  const orig = net.createConnection;
  const replies = [
    [RESP.pong], [RESP.int(1)], [RESP.bulk("val")], [RESP.ok], [RESP.int(3)],
  ];
  let callIdx = 0;
  net.createConnection = () => autoSock(replies[callIdx++]);
  try {
    const tasks = [
      redisClient({ host: "h", operation: "ping" }),
      redisClient({ host: "h", operation: "dbsize" }),
      redisClient({ host: "h", operation: "get", key: "k" }),
      redisClient({ host: "h", operation: "set", key: "k", value: "v" }),
      redisClient({ host: "h", operation: "llen", key: "list" }),
    ];
    const results = await Promise.all(tasks);
    assert.strictEqual(results[0].pong, true);
    assert.strictEqual(results[1].dbsize, 1);
    assert.strictEqual(results[2].value, "val");
    assert.strictEqual(results[3].ok, true);
    assert.strictEqual(results[4].length, 3);
  } finally { net.createConnection = orig; }
});

await test("F04 pipeline with 100 commands", async () => {
  const n = 100;
  let writeCount = 0;
  const allReplies = Array.from({ length: n }, () => RESP.ok).join("");
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.destroy = () => { sock.destroyed = true; };
  sock.write = () => {
    writeCount++;
    if (writeCount === 1) setImmediate(() => sock.emit("data", Buffer.from(allReplies)));
    return true;
  };
  setImmediate(() => sock.emit("connect"));
  const orig = net.createConnection;
  net.createConnection = () => sock;
  try {
    const cmds = Array.from({ length: n }, (_, i) => ["SET", `k${i}`, `v${i}`]);
    const r = await redisClient({ host: "h", operation: "pipeline", commands: cmds });
    assert.strictEqual(r.count, n);
    assert.strictEqual(r.succeeded, n);
  } finally { net.createConnection = orig; }
});

await test("F05 5 concurrent timeout races (all reject)", async () => {
  const orig = net.createConnection;
  net.createConnection = () => {
    const s = new EventEmitter();
    s.destroyed = false;
    s.write = () => true; // never replies
    s.destroy = () => { s.destroyed = true; s.emit("close"); };
    setImmediate(() => s.emit("connect"));
    return s;
  };
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        redisClient({ host: "h", operation: "ping", timeout: 0.05 }),
      ),
    );
    assert.ok(results.every(r => r.status === "rejected"));
    assert.ok(results.every(r => /timed out/i.test(r.reason.message)));
  } finally { net.createConnection = orig; }
});

// ─── Summary ────────────────────────────────────────────────────────────────
process.stdout.write(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
else process.exit(0);

})();
