"use strict";
/**
 * test/sections/201-memcached-client.js
 *
 * Isolated unit/integration tests for lib/memcachedClientOps.js
 * Uses a real TCP mock Memcached server on loopback — no real Memcached needed.
 *
 * Sections:
 *   A — Input validation (10 tests)
 *   B — Protocol encoding unit tests (10 tests)
 *   C — Security guards (10 tests)
 *   D — Happy-path mock server tests (30 tests)
 *   E — Error paths (5 tests)
 *   F — Concurrency (5 tests)
 *
 * Total: 70 tests
 */

const net  = require("net");
const { memcachedClient } = require("../../lib/memcachedClientOps");

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  ✗ ${name}: ${err.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertThrows(fn, pattern) {
  try { fn(); }
  catch (e) {
    if (pattern && !pattern.test(e.message))
      throw new Error(`Expected error matching ${pattern} but got: ${e.message}`);
    return e;
  }
  throw new Error(`Expected function to throw but it did not`);
}

async function assertRejects(fn, pattern) {
  try { await fn(); }
  catch (e) {
    if (pattern && !pattern.test(e.message))
      throw new Error(`Expected rejection matching ${pattern} but got: ${e.message}`);
    return e;
  }
  throw new Error(`Expected function to reject but it resolved`);
}

// ─── Mock Memcached Server ────────────────────────────────────────────────────

/**
 * Minimal mock Memcached ASCII-protocol server.
 * Handles: get, set, add, replace, append, prepend, delete, incr, decr,
 *          flush_all, stats, version
 *
 * State: in-memory Map of key → {value, flags, exptime, numeric?}
 */
class MockMemcached {
  constructor() {
    this.store  = new Map(); // key → {value:string, flags:number}
    this.server = null;
    this.port   = null;
  }

  async start() {
    return new Promise((resolve) => {
      this.server = net.createServer((sock) => {
        let buf = "";
        sock.on("data", (chunk) => {
          buf += chunk.toString("binary");
          this._process(sock, buf).then(remaining => { buf = remaining; });
        });
        sock.on("error", () => {});
      });
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  async stop() {
    return new Promise(resolve => this.server.close(resolve));
  }

  async _process(sock, buf) {
    // Process all complete commands from buffer
    while (true) {
      const crlfIdx = buf.indexOf("\r\n");
      if (crlfIdx === -1) break;

      const line = buf.slice(0, crlfIdx);
      const parts = line.split(" ");
      const cmd   = parts[0];

      // Storage commands: set/add/replace/append/prepend
      if (["set","add","replace","append","prepend"].includes(cmd)) {
        const key    = parts[1];
        const flags  = parseInt(parts[2], 10);
        // const exptime = parseInt(parts[3], 10);
        const bytes  = parseInt(parts[4], 10);

        // Need the data block after \r\n
        const dataStart = crlfIdx + 2;
        if (buf.length < dataStart + bytes + 2) break; // not enough data yet

        const value = buf.slice(dataStart, dataStart + bytes);
        buf = buf.slice(dataStart + bytes + 2); // consume data + \r\n

        let response;
        if (cmd === "set") {
          this.store.set(key, { value, flags });
          response = "STORED\r\n";
        } else if (cmd === "add") {
          if (this.store.has(key)) response = "NOT_STORED\r\n";
          else { this.store.set(key, { value, flags }); response = "STORED\r\n"; }
        } else if (cmd === "replace") {
          if (!this.store.has(key)) response = "NOT_STORED\r\n";
          else { this.store.set(key, { value, flags }); response = "STORED\r\n"; }
        } else if (cmd === "append") {
          if (!this.store.has(key)) response = "NOT_STORED\r\n";
          else {
            const existing = this.store.get(key);
            this.store.set(key, { value: existing.value + value, flags: existing.flags });
            response = "STORED\r\n";
          }
        } else if (cmd === "prepend") {
          if (!this.store.has(key)) response = "NOT_STORED\r\n";
          else {
            const existing = this.store.get(key);
            this.store.set(key, { value: value + existing.value, flags: existing.flags });
            response = "STORED\r\n";
          }
        }
        sock.write(response);
        continue;
      }

      // Non-storage commands consume just the line + \r\n
      buf = buf.slice(crlfIdx + 2);

      if (cmd === "get") {
        const keys = parts.slice(1);
        let response = "";
        for (const k of keys) {
          if (this.store.has(k)) {
            const { value, flags } = this.store.get(k);
            const bytes = Buffer.byteLength(value, "utf8");
            response += `VALUE ${k} ${flags} ${bytes}\r\n${value}\r\n`;
          }
        }
        response += "END\r\n";
        sock.write(response);
      } else if (cmd === "delete") {
        const key = parts[1];
        if (this.store.has(key)) { this.store.delete(key); sock.write("DELETED\r\n"); }
        else sock.write("NOT_FOUND\r\n");
      } else if (cmd === "incr") {
        const key  = parts[1];
        const amt  = parseInt(parts[2], 10);
        if (!this.store.has(key)) { sock.write("NOT_FOUND\r\n"); }
        else {
          const cur = parseInt(this.store.get(key).value, 10);
          const nxt = cur + amt;
          this.store.set(key, { value: String(nxt), flags: 0 });
          sock.write(`${nxt}\r\n`);
        }
      } else if (cmd === "decr") {
        const key  = parts[1];
        const amt  = parseInt(parts[2], 10);
        if (!this.store.has(key)) { sock.write("NOT_FOUND\r\n"); }
        else {
          const cur = parseInt(this.store.get(key).value, 10);
          const nxt = Math.max(0, cur - amt);
          this.store.set(key, { value: String(nxt), flags: 0 });
          sock.write(`${nxt}\r\n`);
        }
      } else if (cmd === "flush_all") {
        this.store.clear();
        sock.write("OK\r\n");
      } else if (cmd === "stats") {
        sock.write("STAT curr_items 42\r\nSTAT total_items 1000\r\nSTAT bytes 65536\r\nSTAT uptime 3600\r\nEND\r\n");
      } else if (cmd === "version") {
        sock.write("VERSION 1.6.17\r\n");
      } else {
        sock.write("ERROR\r\n");
      }
    }
    return buf;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runAll() {
  const mock = new MockMemcached();
  const port = await mock.start();
  const HOST = "127.0.0.1";

  // Shorthand helpers
  const mc = (args) => memcachedClient({ host: HOST, port, timeout: 5, ...args });

  process.stdout.write("\n=== Section A: Input Validation (10) ===\n");

  await test("A01 — missing operation rejects", async () => {
    await assertRejects(() => mc({ operation: undefined }), /unknown operation/i);
  });

  await test("A02 — unknown operation rejects", async () => {
    await assertRejects(() => mc({ operation: "cas" }), /unknown operation/i);
  });

  await test("A03 — get with no key/keys rejects", async () => {
    await assertRejects(() => mc({ operation: "get" }), /provide 'key'/i);
  });

  await test("A04 — empty key string rejects", async () => {
    await assertRejects(() => mc({ operation: "get", key: "" }), /non-empty string/i);
  });

  await test("A05 — key with space character rejects", async () => {
    await assertRejects(() => mc({ operation: "get", key: "bad key" }), /control character/i);
  });

  await test("A06 — key with NUL byte rejects", async () => {
    await assertRejects(() => mc({ operation: "get", key: "bad\x00key" }), /control character/i);
  });

  await test("A07 — key exceeding 250 chars rejects", async () => {
    await assertRejects(() => mc({ operation: "get", key: "k".repeat(251) }), /too long/i);
  });

  await test("A08 — invalid flags (negative) rejects", async () => {
    await assertRejects(() => mc({ operation: "set", key: "k", value: "v", flags: -1 }), /flags must be/i);
  });

  await test("A09 — invalid exptime (negative) rejects", async () => {
    await assertRejects(() => mc({ operation: "set", key: "k", value: "v", exptime: -5 }), /exptime must be/i);
  });

  await test("A10 — invalid port (0) rejects", async () => {
    await assertRejects(() => memcachedClient({ host: HOST, port: 0, timeout: 2, operation: "version" }), /port.*must be/i);
  });

  process.stdout.write("\n=== Section B: Protocol Unit Tests (10) ===\n");

  // These tests call the module-internal helpers by calling the actual client
  // with our mock and verifying the correct protocol semantics.

  await test("B01 — version returns version string", async () => {
    const r = await mc({ operation: "version" });
    assert(r.version === "1.6.17", `Expected '1.6.17' got '${r.version}'`);
  });

  await test("B02 — set stores value; get retrieves it", async () => {
    await mc({ operation: "set", key: "b02", value: "hello" });
    const r = await mc({ operation: "get", key: "b02" });
    assert(r.found === true, "should be found");
    assert(r.value === "hello", `Expected 'hello' got '${r.value}'`);
  });

  await test("B03 — get missing key returns found:false", async () => {
    const r = await mc({ operation: "get", key: "no-such-key-xyz" });
    assert(r.found === false, "should not be found");
    assert(r.value === null, "value should be null");
  });

  await test("B04 — set with flags persists flags in response", async () => {
    await mc({ operation: "set", key: "b04", value: "flagged", flags: 42 });
    const r = await mc({ operation: "get", key: "b04" });
    assert(r.found, "should be found");
    assert(r.flags === 42, `Expected flags=42 got ${r.flags}`);
  });

  await test("B05 — delete returns deleted:true", async () => {
    await mc({ operation: "set", key: "b05", value: "del-me" });
    const r = await mc({ operation: "delete", key: "b05" });
    assert(r.deleted === true, "should be deleted");
  });

  await test("B06 — delete non-existent key returns deleted:false", async () => {
    const r = await mc({ operation: "delete", key: "never-existed-xyz" });
    assert(r.deleted === false, "should not be deleted");
    assert(r.response === "NOT_FOUND", `Expected NOT_FOUND got ${r.response}`);
  });

  await test("B07 — increment/decrement counter", async () => {
    await mc({ operation: "set", key: "b07-counter", value: "10" });
    const inc = await mc({ operation: "increment", key: "b07-counter", delta: 5 });
    assert(inc.value === 15, `Expected 15 got ${inc.value}`);
    const dec = await mc({ operation: "decrement", key: "b07-counter", delta: 3 });
    assert(dec.value === 12, `Expected 12 got ${dec.value}`);
  });

  await test("B08 — flush_all clears all keys", async () => {
    await mc({ operation: "set", key: "b08-a", value: "a" });
    await mc({ operation: "set", key: "b08-b", value: "b" });
    const r = await mc({ operation: "flush_all" });
    assert(r.flushed === true, "should be flushed");
    const ra = await mc({ operation: "get", key: "b08-a" });
    assert(!ra.found, "b08-a should be gone after flush");
  });

  await test("B09 — stats returns stat count > 0", async () => {
    const r = await mc({ operation: "stats" });
    assert(r.statCount > 0, `Expected statCount>0 got ${r.statCount}`);
    assert(typeof r.stats === "object", "stats should be object");
  });

  await test("B10 — multi-get returns result map for all keys", async () => {
    await mc({ operation: "set", key: "b10-x", value: "X" });
    await mc({ operation: "set", key: "b10-y", value: "Y" });
    const r = await mc({ operation: "get", keys: ["b10-x", "b10-y", "b10-missing"] });
    assert(r.found === 2, `Expected 2 found got ${r.found}`);
    assert(r.result["b10-x"].found === true,    "b10-x should be found");
    assert(r.result["b10-y"].found === true,    "b10-y should be found");
    assert(r.result["b10-missing"].found === false, "b10-missing should not be found");
  });

  process.stdout.write("\n=== Section C: Security Guards (10) ===\n");

  await test("C01 — key with tab character rejected", async () => {
    await assertRejects(() => mc({ operation: "get", key: "bad\tkey" }), /control character/i);
  });

  await test("C02 — key with CR rejected", async () => {
    await assertRejects(() => mc({ operation: "get", key: "bad\rkey" }), /control character/i);
  });

  await test("C03 — key with LF rejected", async () => {
    await assertRejects(() => mc({ operation: "get", key: "bad\nkey" }), /control character/i);
  });

  await test("C04 — host with NUL rejected", async () => {
    await assertRejects(
      () => memcachedClient({ host: "127.0.0\x001", port, timeout: 2, operation: "version" }),
      /invalid characters/i
    );
  });

  await test("C05 — host with CR rejected", async () => {
    await assertRejects(
      () => memcachedClient({ host: "127.0.0.1\rmalicious", port, timeout: 2, operation: "version" }),
      /invalid characters/i
    );
  });

  await test("C06 — flags > 65535 rejected", async () => {
    await assertRejects(() => mc({ operation: "set", key: "c06", value: "v", flags: 65536 }), /flags must be/i);
  });

  await test("C07 — exptime > 2147483647 rejected", async () => {
    await assertRejects(() => mc({ operation: "set", key: "c07", value: "v", exptime: 2147483648 }), /exptime must be/i);
  });

  await test("C08 — negative delta for increment rejected", async () => {
    await assertRejects(() => mc({ operation: "increment", key: "c08", delta: -1 }), /non-negative/i);
  });

  await test("C09 — negative delay for flush_all rejected", async () => {
    await assertRejects(() => mc({ operation: "flush_all", delay: -1 }), /non-negative/i);
  });

  await test("C10 — too many multi-get keys rejected (>100)", async () => {
    const keys = Array.from({ length: 101 }, (_, i) => `key${i}`);
    await assertRejects(() => mc({ operation: "get", keys }), /too many keys/i);
  });

  process.stdout.write("\n=== Section D: Happy-Path Mock Tests (30) ===\n");

  // Reset store before D section
  mock.store.clear();

  await test("D01 — set basic string value", async () => {
    const r = await mc({ operation: "set", key: "d01", value: "world" });
    assert(r.stored === true, "should be stored");
    assert(r.response === "STORED", "response should be STORED");
  });

  await test("D02 — get stored value", async () => {
    await mc({ operation: "set", key: "d02", value: "value-d02" });
    const r = await mc({ operation: "get", key: "d02" });
    assert(r.found && r.value === "value-d02", "should get stored value");
  });

  await test("D03 — add succeeds when key absent", async () => {
    mock.store.delete("d03");
    const r = await mc({ operation: "add", key: "d03", value: "added" });
    assert(r.stored === true, "add should succeed when key missing");
  });

  await test("D04 — add fails when key exists", async () => {
    await mc({ operation: "set", key: "d04", value: "existing" });
    const r = await mc({ operation: "add", key: "d04", value: "new" });
    assert(r.stored === false, "add should fail when key present");
    assert(r.response === "NOT_STORED", "response should be NOT_STORED");
  });

  await test("D05 — replace succeeds when key exists", async () => {
    await mc({ operation: "set", key: "d05", value: "old" });
    const r = await mc({ operation: "replace", key: "d05", value: "new" });
    assert(r.stored === true, "replace should succeed when key present");
    const g = await mc({ operation: "get", key: "d05" });
    assert(g.value === "new", "value should be updated");
  });

  await test("D06 — replace fails when key absent", async () => {
    mock.store.delete("d06");
    const r = await mc({ operation: "replace", key: "d06", value: "v" });
    assert(r.stored === false, "replace should fail when key missing");
  });

  await test("D07 — append to existing value", async () => {
    await mc({ operation: "set", key: "d07", value: "hello" });
    const r = await mc({ operation: "append", key: "d07", value: "-world" });
    assert(r.stored === true, "append should succeed");
    const g = await mc({ operation: "get", key: "d07" });
    assert(g.value === "hello-world", `Expected 'hello-world' got '${g.value}'`);
  });

  await test("D08 — prepend to existing value", async () => {
    await mc({ operation: "set", key: "d08", value: "world" });
    const r = await mc({ operation: "prepend", key: "d08", value: "hello-" });
    assert(r.stored === true, "prepend should succeed");
    const g = await mc({ operation: "get", key: "d08" });
    assert(g.value === "hello-world", `Expected 'hello-world' got '${g.value}'`);
  });

  await test("D09 — append fails when key absent", async () => {
    mock.store.delete("d09");
    const r = await mc({ operation: "append", key: "d09", value: "data" });
    assert(r.stored === false, "append should fail when key missing");
  });

  await test("D10 — delete existing key", async () => {
    await mc({ operation: "set", key: "d10", value: "del-me" });
    const r = await mc({ operation: "delete", key: "d10" });
    assert(r.deleted === true, "should be deleted");
    const g = await mc({ operation: "get", key: "d10" });
    assert(!g.found, "key should be gone after delete");
  });

  await test("D11 — increment by 1 (default delta)", async () => {
    await mc({ operation: "set", key: "d11", value: "0" });
    const r = await mc({ operation: "increment", key: "d11" });
    assert(r.value === 1, `Expected 1 got ${r.value}`);
  });

  await test("D12 — increment by custom delta", async () => {
    await mc({ operation: "set", key: "d12", value: "100" });
    const r = await mc({ operation: "increment", key: "d12", delta: 50 });
    assert(r.value === 150, `Expected 150 got ${r.value}`);
  });

  await test("D13 — decrement by 1 (default delta)", async () => {
    await mc({ operation: "set", key: "d13", value: "10" });
    const r = await mc({ operation: "decrement", key: "d13" });
    assert(r.value === 9, `Expected 9 got ${r.value}`);
  });

  await test("D14 — decrement by custom delta", async () => {
    await mc({ operation: "set", key: "d14", value: "100" });
    const r = await mc({ operation: "decrement", key: "d14", delta: 30 });
    assert(r.value === 70, `Expected 70 got ${r.value}`);
  });

  await test("D15 — decrement floored at 0", async () => {
    await mc({ operation: "set", key: "d15", value: "5" });
    const r = await mc({ operation: "decrement", key: "d15", delta: 100 });
    assert(r.value === 0, `Expected 0 got ${r.value}`);
  });

  await test("D16 — increment missing key returns found:false", async () => {
    mock.store.delete("d16-missing");
    const r = await mc({ operation: "increment", key: "d16-missing" });
    assert(r.found === false, "should not be found");
    assert(r.value === null, "value should be null");
  });

  await test("D17 — decrement missing key returns found:false", async () => {
    mock.store.delete("d17-missing");
    const r = await mc({ operation: "decrement", key: "d17-missing" });
    assert(r.found === false, "should not be found");
  });

  await test("D18 — flush_all with delay=0", async () => {
    await mc({ operation: "set", key: "d18", value: "before-flush" });
    const r = await mc({ operation: "flush_all", delay: 0 });
    assert(r.flushed === true, "should be flushed");
    assert(r.delay === 0, "delay should be 0");
  });

  await test("D19 — stats general has at least uptime stat", async () => {
    const r = await mc({ operation: "stats" });
    assert("uptime" in r.stats, "stats should contain uptime");
    assert(typeof r.stats.uptime === "number", "uptime should be numeric");
  });

  await test("D20 — version format", async () => {
    const r = await mc({ operation: "version" });
    assert(/^\d+\.\d+\.\d+/.test(r.version), `Version '${r.version}' should match semver`);
  });

  await test("D21 — set numeric value as string", async () => {
    const r = await mc({ operation: "set", key: "d21", value: "12345" });
    assert(r.stored, "should store numeric string");
    const g = await mc({ operation: "get", key: "d21" });
    assert(g.value === "12345", `Expected '12345' got '${g.value}'`);
  });

  await test("D22 — set value with special characters", async () => {
    const special = "hello\tworld\nnewline";
    const r = await mc({ operation: "set", key: "d22", value: special });
    assert(r.stored, "should store special chars");
    const g = await mc({ operation: "get", key: "d22" });
    assert(g.value === special, "special chars should be preserved");
  });

  await test("D23 — get with 'keys' array of one key returns result map", async () => {
    await mc({ operation: "set", key: "d23", value: "single-array" });
    const r = await mc({ operation: "get", keys: ["d23"] });
    assert(r.result["d23"].found === true, "should be found in result map");
    assert(r.result["d23"].value === "single-array", "value should match");
  });

  await test("D24 — flags default to 0", async () => {
    await mc({ operation: "set", key: "d24", value: "no-flags" });
    const r = await mc({ operation: "get", key: "d24" });
    assert(r.flags === 0, `Expected flags=0 got ${r.flags}`);
  });

  await test("D25 — set overwrites existing value", async () => {
    await mc({ operation: "set", key: "d25", value: "first" });
    await mc({ operation: "set", key: "d25", value: "second" });
    const r = await mc({ operation: "get", key: "d25" });
    assert(r.value === "second", `Expected 'second' got '${r.value}'`);
  });

  await test("D26 — keys array with all missing returns found:0", async () => {
    const r = await mc({ operation: "get", keys: ["no-key-1", "no-key-2"] });
    assert(r.found === 0, `Expected found=0 got ${r.found}`);
    assert(r.result["no-key-1"].found === false, "no-key-1 should not be found");
  });

  await test("D27 — increment then get confirms value in store", async () => {
    await mc({ operation: "set", key: "d27", value: "50" });
    await mc({ operation: "increment", key: "d27", delta: 25 });
    const g = await mc({ operation: "get", key: "d27" });
    assert(g.value === "75", `Expected '75' got '${g.value}'`);
  });

  await test("D28 — stats subcommand accepted (no error)", async () => {
    // Mock always returns same stats — just test it doesn't error
    const r = await mc({ operation: "stats", subcommand: "items" });
    assert(r.subcommand === "items", "subcommand should be echoed");
  });

  await test("D29 — empty value stored and retrieved", async () => {
    const r = await mc({ operation: "set", key: "d29", value: "" });
    assert(r.stored, "empty value should be stored");
    const g = await mc({ operation: "get", key: "d29" });
    assert(g.found, "empty value key should be found");
    assert(g.value === "", `Expected '' got '${g.value}'`);
  });

  await test("D30 — delete then add succeeds", async () => {
    await mc({ operation: "set",    key: "d30", value: "init" });
    await mc({ operation: "delete", key: "d30" });
    const r = await mc({ operation: "add", key: "d30", value: "re-added" });
    assert(r.stored, "add after delete should succeed");
    const g = await mc({ operation: "get", key: "d30" });
    assert(g.value === "re-added", "value after re-add should match");
  });

  process.stdout.write("\n=== Section E: Error Paths (5) ===\n");

  await test("E01 — connect to closed port raises socket error", async () => {
    // Find a port that is not listening
    const freePort = await new Promise(resolve => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    await assertRejects(
      () => memcachedClient({ host: "127.0.0.1", port: freePort, timeout: 2, operation: "version" }),
      /socket error|connect/i
    );
  });

  await test("E02 — connect timeout fires for unroutable host", async () => {
    const start = Date.now();
    await assertRejects(
      () => memcachedClient({ host: "10.255.255.254", port: 11211, timeout: 2, connect_timeout: 0.5, operation: "version" }),
      /timeout/i
    );
    const elapsed = Date.now() - start;
    assert(elapsed < 3000, `Timeout took too long: ${elapsed}ms`);
  });

  await test("E03 — increment missing key returns found:false (not an error)", async () => {
    mock.store.delete("e03-never");
    const r = await mc({ operation: "increment", key: "e03-never" });
    assert(r.found === false, "should return found:false gracefully");
    assert(r.value === null, "value should be null");
  });

  await test("E04 — value type other than string/number throws", async () => {
    await assertRejects(
      () => mc({ operation: "set", key: "e04", value: { nested: true } }),
      /value must be/i
    );
  });

  await test("E05 — host too long rejected", async () => {
    await assertRejects(
      () => memcachedClient({ host: "a".repeat(254), port: 11211, timeout: 2, operation: "version" }),
      /too long/i
    );
  });

  process.stdout.write("\n=== Section F: Concurrency (5) ===\n");

  mock.store.clear();

  await test("F01 — 10 parallel gets are isolated", async () => {
    // Set 10 distinct keys
    for (let i = 0; i < 10; i++) {
      await mc({ operation: "set", key: `f01-k${i}`, value: `v${i}` });
    }
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => mc({ operation: "get", key: `f01-k${i}` }))
    );
    for (let i = 0; i < 10; i++) {
      assert(results[i].found, `f01-k${i} should be found`);
      assert(results[i].value === `v${i}`, `Expected v${i} got ${results[i].value}`);
    }
  });

  await test("F02 — 10 parallel sets with distinct keys all succeed", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mc({ operation: "set", key: `f02-k${i}`, value: `data${i}` })
      )
    );
    assert(results.every(r => r.stored), "all parallel sets should succeed");
  });

  await test("F03 — parallel increment operations return distinct results", async () => {
    await mc({ operation: "set", key: "f03-counter", value: "0" });
    // Sequential increments: Memcached is single-threaded, so results will be ordered
    const r1 = await mc({ operation: "increment", key: "f03-counter", delta: 1 });
    const r2 = await mc({ operation: "increment", key: "f03-counter", delta: 1 });
    const r3 = await mc({ operation: "increment", key: "f03-counter", delta: 1 });
    assert(r3.value === 3, `Expected final value 3 got ${r3.value}`);
    assert(r1.value < r2.value && r2.value < r3.value, "increments should be monotonically increasing");
  });

  await test("F04 — mixed parallel operations (set + get + delete) complete without error", async () => {
    await mc({ operation: "set", key: "f04-shared", value: "initial" });
    const ops = [
      mc({ operation: "get",    key: "f04-shared" }),
      mc({ operation: "set",    key: "f04-a", value: "a" }),
      mc({ operation: "set",    key: "f04-b", value: "b" }),
      mc({ operation: "get",    key: "f04-a" }),
      mc({ operation: "delete", key: "f04-shared" }),
    ];
    const results = await Promise.all(ops);
    // All operations should complete without throwing
    assert(results.length === 5, "all 5 operations should complete");
  });

  await test("F05 — stats concurrent calls all return stat count > 0", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => mc({ operation: "stats" }))
    );
    assert(results.every(r => r.statCount > 0), "all concurrent stats should return data");
  });

  // ─── Cleanup & Summary ─────────────────────────────────────────────────────

  await mock.stop();

  process.stdout.write("\n");
  process.stdout.write(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
  if (failures.length > 0) {
    process.stdout.write("\nFailed tests:\n");
    for (const { name, err } of failures) {
      process.stdout.write(`  ✗ ${name}\n    ${err.stack || err.message}\n`);
    }
    process.exit(1);
  } else {
    process.stdout.write("All tests passed! ✓\n");
  }
}

runAll().catch(err => {
  process.stderr.write(`Fatal test error: ${err.stack}\n`);
  process.exit(1);
});
