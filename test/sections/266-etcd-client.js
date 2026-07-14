"use strict";
/**
 * Tests for etcd_client tool (section 266)
 *
 * Five rigor levels:
 *   A = pure-helper / unit tests  (no network)
 *   B = validation / input-guard  (no network)
 *   C = mock-network tests        (real HTTP server, fake etcd API)
 *   D = security / injection tests
 *   E = concurrency / stress tests
 *
 * etcd uses its gRPC-gateway HTTP/1.1+JSON REST API on port 2379.
 * All keys/values are base64-encoded in the wire protocol.
 */

const http   = require("http");
const assert = require("assert");
const {
  etcdClient,
  toB64,
  fromB64,
  prefixRangeEnd,
  decodeKv,
  requireString,
  guardString,
  clampInt,
} = require("../../lib/etcdClientOps");

// ── Test runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.error(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assertThrows(fn, msgSubstr) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (msgSubstr && !err.message.includes(msgSubstr))
      throw new Error(`Expected error containing '${msgSubstr}', got: ${err.message}`);
  }
  if (!threw) throw new Error(`Expected an error containing '${msgSubstr || "(any)"}' but none was thrown`);
}

async function assertRejects(fn, msgSubstr) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    if (msgSubstr && !err.message.includes(msgSubstr))
      throw new Error(`Expected rejection containing '${msgSubstr}', got: ${err.message}`);
  }
  if (!threw) throw new Error(`Expected rejection '${msgSubstr || "(any)"}' but none was thrown`);
}

// ── Mock etcd HTTP server helper ──────────────────────────────────────────

/**
 * Creates a minimal HTTP/1.1 mock server that simulates etcd's gRPC-gateway API.
 * @param {Object} routes - Map of path → handler(reqBody) → responseObj
 * @returns {{ server, port }}
 */
function createMockEtcd(routes) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body || "{}"); } catch (_) {}

        const handler = routes[req.url];
        let response;
        if (typeof handler === "function") {
          try {
            response = handler(parsed, req);
          } catch (e) {
            response = { error: e.message, code: 500 };
          }
        } else {
          response = { error: "unknown route: " + req.url, code: 404 };
        }

        const responseJson = JSON.stringify(response);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(responseJson),
        });
        res.end(responseJson);
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
    server.on("error", reject);
  });
}

function closeMockEtcd(server) {
  return new Promise(resolve => server.close(resolve));
}

/** Build a fake etcd KV pair */
function fakeKv(key, value, version = "1") {
  return {
    key:             toB64(key),
    value:           toB64(value),
    version,
    create_revision: "1",
    mod_revision:    "2",
    lease:           "0",
  };
}

/** Build a fake etcd response header */
function fakeHeader(revision = "5") {
  return { cluster_id: "1234", member_id: "5678", revision, raft_term: "2" };
}

// ── Section A: Pure-helper / unit tests ─────────────────────────────────────

async function runA() {
  console.error("\nA — Pure-helper / unit tests");

  // A1 — toB64: basic string
  await test("A1: toB64 encodes 'hello' correctly", () => {
    assert.strictEqual(toB64("hello"), Buffer.from("hello", "utf8").toString("base64"));
  });

  // A2 — toB64: empty string
  await test("A2: toB64 encodes empty string", () => {
    assert.strictEqual(toB64(""), "");
  });

  // A3 — toB64: null/undefined
  await test("A3: toB64 returns '' for null and undefined", () => {
    assert.strictEqual(toB64(null), "");
    assert.strictEqual(toB64(undefined), "");
  });

  // A4 — toB64: unicode
  await test("A4: toB64 encodes Unicode strings correctly", () => {
    const s = "こんにちは";
    const encoded = toB64(s);
    assert.strictEqual(Buffer.from(encoded, "base64").toString("utf8"), s);
  });

  // A5 — fromB64: basic
  await test("A5: fromB64 decodes base64 correctly", () => {
    const b64 = Buffer.from("world", "utf8").toString("base64");
    assert.strictEqual(fromB64(b64), "world");
  });

  // A6 — fromB64: empty / falsy
  await test("A6: fromB64 returns '' for falsy input", () => {
    assert.strictEqual(fromB64(""),        "");
    assert.strictEqual(fromB64(null),      "");
    assert.strictEqual(fromB64(undefined), "");
  });

  // A7 — toB64/fromB64 round-trip
  await test("A7: toB64 → fromB64 round-trip", () => {
    const original = "/foo/bar/baz";
    assert.strictEqual(fromB64(toB64(original)), original);
  });

  // A8 — prefixRangeEnd: basic prefix
  await test("A8: prefixRangeEnd increments last byte of prefix", () => {
    // 'foo' = [0x66, 0x6f, 0x6f]
    // range_end base64 of 'fop' = [0x66, 0x6f, 0x70]
    const rangeEnd = prefixRangeEnd("foo");
    const decoded  = Buffer.from(rangeEnd, "base64").toString("utf8");
    assert.strictEqual(decoded, "fop");
  });

  // A9 — prefixRangeEnd: slash prefix
  await test("A9: prefixRangeEnd works for '/config/' prefix", () => {
    const rangeEnd = prefixRangeEnd("/config/");
    const decoded  = Buffer.from(rangeEnd, "base64");
    // last byte should be '/' (0x2F) + 1 = '0' (0x30)
    const orig = Buffer.from("/config/", "utf8");
    assert.strictEqual(decoded[decoded.length - 1], orig[orig.length - 1] + 1);
  });

  // A10 — prefixRangeEnd: empty prefix → sentinel
  await test("A10: prefixRangeEnd('') returns \\x00 sentinel for all-keys scan", () => {
    const rangeEnd = prefixRangeEnd("");
    const decoded  = Buffer.from(rangeEnd, "base64");
    assert.strictEqual(decoded[0], 0x00);
  });

  // A11 — prefixRangeEnd: result is always a decodable base64 string
  await test("A11: prefixRangeEnd always returns a non-empty base64 string", () => {
    const prefixes = ["a", "/", "foo/bar/", "/config/", "z"];
    for (const prefix of prefixes) {
      const rangeEnd = prefixRangeEnd(prefix);
      assert.ok(typeof rangeEnd === "string" && rangeEnd.length > 0, "expected non-empty base64 for: " + prefix);
      const decoded = Buffer.from(rangeEnd, "base64");
      assert.ok(decoded.length > 0, "expected non-zero decoded bytes for: " + prefix);
    }
  });

  // A12 — decodeKv: normal kv pair
  await test("A12: decodeKv decodes base64 key/value to strings", () => {
    const raw = fakeKv("/mykey", "myvalue", "3");
    const kv  = decodeKv(raw);
    assert.strictEqual(kv.key,   "/mykey");
    assert.strictEqual(kv.value, "myvalue");
    assert.strictEqual(kv.version, "3");
    assert.ok("create_revision" in kv);
    assert.ok("mod_revision"    in kv);
    assert.ok("lease"           in kv);
  });

  // A13 — decodeKv: missing fields default to "0"
  await test("A13: decodeKv fills missing fields with '0'", () => {
    const kv = decodeKv({ key: toB64("k"), value: toB64("v") });
    assert.strictEqual(kv.version,         "0");
    assert.strictEqual(kv.create_revision, "0");
    assert.strictEqual(kv.mod_revision,    "0");
    assert.strictEqual(kv.lease,           "0");
  });

  // A14 — decodeKv: binary-safe key/value
  await test("A14: decodeKv handles binary-safe base64 with special chars", () => {
    const key = "/path/with spaces/and/ünïcödé";
    const val = "value\nwith\nnewlines";
    const kv  = decodeKv(fakeKv(key, val));
    assert.strictEqual(kv.key,   key);
    assert.strictEqual(kv.value, val);
  });

  // A15 — requireString: valid
  await test("A15: requireString accepts non-empty strings", () => {
    requireString("hello", "host"); // should not throw
  });

  // A16 — requireString: empty throws
  await test("A16: requireString throws for empty string", () => {
    assertThrows(() => requireString("", "host"), "non-empty string");
  });

  // A17 — requireString: non-string throws
  await test("A17: requireString throws for non-string input", () => {
    assertThrows(() => requireString(42, "host"), "non-empty string");
  });

  // A18 — requireString: NUL byte throws
  await test("A18: requireString throws for string with NUL byte", () => {
    assertThrows(() => requireString("ho\x00st", "host"), "NUL");
  });

  // A19 — guardString: undefined passes
  await test("A19: guardString allows undefined/null (optional field)", () => {
    guardString(undefined, "key"); // should not throw
    guardString(null, "key");      // should not throw
  });

  // A20 — guardString: non-string throws
  await test("A20: guardString throws for non-string value (not null/undefined)", () => {
    assertThrows(() => guardString(42, "key"), "string");
  });

  // A21 — guardString: NUL byte throws
  await test("A21: guardString throws for string with NUL byte", () => {
    assertThrows(() => guardString("foo\x00bar", "key"), "NUL");
  });

  // A22 — clampInt: default value when undefined
  await test("A22: clampInt returns default for undefined", () => {
    assert.strictEqual(clampInt(undefined, 10000, 1000, 120000, "timeout"), 10000);
  });

  // A23 — clampInt: within range
  await test("A23: clampInt returns value within range", () => {
    assert.strictEqual(clampInt(5000, 10000, 1000, 120000, "timeout"), 5000);
  });

  // A24 — clampInt: too small throws
  await test("A24: clampInt throws for value below minimum", () => {
    assertThrows(() => clampInt(500, 10000, 1000, 120000, "timeout"), "between 1000 and 120000");
  });

  // A25 — clampInt: too large throws
  await test("A25: clampInt throws for value above maximum", () => {
    assertThrows(() => clampInt(999999, 10000, 1000, 120000, "timeout"), "between 1000 and 120000");
  });

  // A26 — clampInt: rounds float
  await test("A26: clampInt rounds float to nearest integer", () => {
    assert.strictEqual(clampInt(2999.7, 10000, 1000, 120000, "timeout"), 3000);
  });

  // A27 — clampInt: non-finite throws
  await test("A27: clampInt throws for Infinity", () => {
    assertThrows(() => clampInt(Infinity, 10000, 1000, 120000, "timeout"), "number");
  });

  // A28 — toB64 round-trip: slash path
  await test("A28: toB64/fromB64 round-trip for etcd key path", () => {
    const key = "/services/web/instance-1";
    assert.strictEqual(fromB64(toB64(key)), key);
  });

  // A29 — toB64 round-trip: numeric string
  await test("A29: toB64/fromB64 round-trip for numeric string", () => {
    assert.strictEqual(fromB64(toB64("12345")), "12345");
  });

  // A30 — toB64 round-trip: JSON value
  await test("A30: toB64/fromB64 round-trip for JSON string value", () => {
    const val = JSON.stringify({ port: 8080, healthy: true });
    assert.strictEqual(fromB64(toB64(val)), val);
  });

  // A31 — prefixRangeEnd: single-char prefix
  await test("A31: prefixRangeEnd single-char 'a' → 'b'", () => {
    const rangeEnd = prefixRangeEnd("a");
    const decoded  = Buffer.from(rangeEnd, "base64").toString("utf8");
    assert.strictEqual(decoded, "b");
  });

  // A32 — decodeKv preserves all revision fields as strings
  await test("A32: decodeKv preserves numeric revision strings as-is", () => {
    const raw = {
      key:             toB64("/k"),
      value:           toB64("v"),
      version:         "99",
      create_revision: "100",
      mod_revision:    "101",
      lease:           "222",
    };
    const kv = decodeKv(raw);
    assert.strictEqual(kv.version,         "99");
    assert.strictEqual(kv.create_revision, "100");
    assert.strictEqual(kv.mod_revision,    "101");
    assert.strictEqual(kv.lease,           "222");
  });

  // A33 — toB64 coerces non-string to string
  await test("A33: toB64 coerces number to string before encoding", () => {
    const result = toB64(42);
    assert.strictEqual(fromB64(result), "42");
  });

  // A34 — prefixRangeEnd: multi-byte UTF-8 prefix
  await test("A34: prefixRangeEnd handles multi-byte UTF-8 prefix", () => {
    const prefix  = "/α"; // α = 0xCE 0xB1
    const rangeEnd = prefixRangeEnd(prefix);
    const decoded  = Buffer.from(rangeEnd, "base64");
    // Should be a valid buffer of the same or shorter length
    assert.ok(decoded.length > 0);
  });

  // A35 — info operation returns no-network result
  await test("A35: info() returns protocol reference synchronously (no I/O)", async () => {
    const result = await etcdClient({ operation: "info", host: "localhost" });
    assert.ok(result.protocol.includes("etcd"));
    assert.ok(Array.isArray(result.operations));
    assert.strictEqual(result.defaultPort, 2379);
  });

  // A36 — info lists all 17 operations
  await test("A36: info lists all 17 operations", async () => {
    const result = await etcdClient({ operation: "info", host: "localhost" });
    const opNames = result.operations.map(o => o.op);
    const expected = [
      "get", "put", "delete", "list", "watch",
      "grant_lease", "revoke_lease", "keepalive",
      "lock", "unlock",
      "status", "members", "compact", "txn",
      "auth_enable", "auth_disable", "info",
    ];
    for (const op of expected) {
      assert.ok(opNames.includes(op), `info missing op: ${op}`);
    }
  });

  // A37 — info has kvEncoding section
  await test("A37: info has kvEncoding and auth sections", async () => {
    const result = await etcdClient({ operation: "info", host: "localhost" });
    assert.ok(typeof result.kvEncoding  === "object");
    assert.ok(typeof result.auth        === "object");
    assert.ok(typeof result.leases      === "object");
    assert.ok(typeof result.locks       === "object");
    assert.ok(typeof result.transactions === "object");
    assert.ok(Array.isArray(result.useCases));
  });

  // A38 — info has apiBase
  await test("A38: info reports correct API base", async () => {
    const result = await etcdClient({ operation: "info", host: "localhost" });
    assert.ok(result.apiBase.includes("/v3/"));
  });

  // A39 — fromB64: all whitespace is treated as an empty-ish b64
  await test("A39: toB64('') returns empty base64 (no padding needed)", () => {
    // '' → base64 → ''
    assert.strictEqual(toB64(""), "");
  });

  // A40 — prefixRangeEnd: trailing space in prefix
  await test("A40: prefixRangeEnd handles trailing space correctly", () => {
    // ' ' = 0x20, so ' '+1 = '!'
    const rangeEnd = prefixRangeEnd("key ");
    const decoded  = Buffer.from(rangeEnd, "base64").toString("utf8");
    assert.ok(decoded.startsWith("key"));
  });

  // A41 — clampInt: null treated as default
  await test("A41: clampInt returns default for null", () => {
    assert.strictEqual(clampInt(null, 2379, 1, 65535, "port"), 2379);
  });

  // A42 — decodeKv: empty value becomes empty string
  await test("A42: decodeKv handles empty value (missing from wire)", () => {
    const kv = decodeKv({ key: toB64("/k"), value: undefined });
    assert.strictEqual(kv.value, "");
  });

  // A43 — toB64 coerces undefined → ''
  await test("A43: toB64(undefined) returns empty string", () => {
    assert.strictEqual(toB64(undefined), "");
  });

  // A44 — prefixRangeEnd: 'z' → '{'
  await test("A44: prefixRangeEnd increments 'z' to '{'", () => {
    const rangeEnd = prefixRangeEnd("z");
    const decoded  = Buffer.from(rangeEnd, "base64").toString("utf8");
    assert.strictEqual(decoded, "{");
  });

  // A45 — info version includes '3.3+'
  await test("A45: info version string mentions etcd 3.3+", async () => {
    const result = await etcdClient({ operation: "info", host: "localhost" });
    assert.ok(result.version.includes("3.3"));
  });

  // A46 — requireString: whitespace-only string is valid (non-empty)
  await test("A46: requireString accepts whitespace-only strings", () => {
    requireString("   ", "host"); // not empty
  });

  // A47 — decodeKv: very long key/value
  await test("A47: decodeKv handles long key/value strings", () => {
    const longKey = "/" + "a".repeat(500);
    const longVal = "x".repeat(1000);
    const kv = decodeKv(fakeKv(longKey, longVal));
    assert.strictEqual(kv.key,   longKey);
    assert.strictEqual(kv.value, longVal);
  });
}

// ── Section B: Validation tests ─────────────────────────────────────────────

async function runB() {
  console.error("\nB — Validation / input-guard tests");

  // B1 — unknown operation rejects
  await test("B1: unknown operation rejects with descriptive error", async () => {
    await assertRejects(
      () => etcdClient({ operation: "bogus", host: "localhost" }),
      "bogus"
    );
  });

  // B2 — missing host rejects
  await test("B2: empty host rejects with descriptive error", async () => {
    await assertRejects(
      () => etcdClient({ operation: "get", host: "", key: "/foo" }),
      "non-empty"
    );
  });

  // B3 — info doesn't need network
  await test("B3: info operation works without network", async () => {
    const result = await etcdClient({ operation: "info", host: "localhost" });
    assert.ok(result.protocol);
    assert.strictEqual(result.defaultPort, 2379);
  });

  // B4 — timeout too small rejects
  await test("B4: timeout < 1000 rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "info", host: "localhost", timeout: 500 }),
      "between 1000 and 120000"
    );
  });

  // B5 — timeout too large rejects
  await test("B5: timeout > 120000 rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "info", host: "localhost", timeout: 200000 }),
      "between 1000 and 120000"
    );
  });

  // B6 — port too small rejects
  await test("B6: port 0 rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "info", host: "localhost", port: 0 }),
      "between 1 and 65535"
    );
  });

  // B7 — port too large rejects
  await test("B7: port 99999 rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "info", host: "localhost", port: 99999 }),
      "between 1 and 65535"
    );
  });

  // B8 — get without key or prefix rejects
  await test("B8: get without key or prefix rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "get", host: "127.0.0.1", port: 1 }),
      "key"
    );
  });

  // B9 — put without key rejects
  await test("B9: put without key rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "put", host: "127.0.0.1", port: 1 }),
      "key"
    );
  });

  // B10 — delete without key or prefix rejects
  await test("B10: delete without key or prefix rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "delete", host: "127.0.0.1", port: 1 }),
      "key"
    );
  });

  // B11 — revoke_lease without lease_id rejects
  await test("B11: revoke_lease without lease_id rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "revoke_lease", host: "127.0.0.1", port: 1 }),
      "lease_id"
    );
  });

  // B12 — keepalive without lease_id rejects
  await test("B12: keepalive without lease_id rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "keepalive", host: "127.0.0.1", port: 1 }),
      "lease_id"
    );
  });

  // B13 — lock without name rejects
  await test("B13: lock without name rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "lock", host: "127.0.0.1", port: 1 }),
      "name"
    );
  });

  // B14 — unlock without key rejects
  await test("B14: unlock without key rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "unlock", host: "127.0.0.1", port: 1 }),
      "key"
    );
  });

  // B15 — compact without revision rejects
  await test("B15: compact without revision rejects", async () => {
    await assertRejects(
      () => etcdClient({ operation: "compact", host: "127.0.0.1", port: 1 }),
      "revision"
    );
  });
}

// ── Section C: Mock-network tests ──────────────────────────────────────────

async function runC() {
  console.error("\nC — Mock-network tests");

  // C1 — get single key
  await test("C1: get operation reads a key and returns decoded kv", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/range": (body) => ({
        header: fakeHeader("5"),
        count:  "1",
        kvs:    [fakeKv("/foo", "bar")],
      }),
    });
    try {
      const result = await etcdClient({ operation: "get", host: "127.0.0.1", port, key: "/foo" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "get");
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.kvs[0].key,   "/foo");
      assert.strictEqual(result.kvs[0].value, "bar");
      assert.strictEqual(result.revision, "5");
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C2 — put a key
  await test("C2: put operation writes a key and returns revision", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/put": (body) => ({
        header: fakeHeader("6"),
      }),
    });
    try {
      const result = await etcdClient({ operation: "put", host: "127.0.0.1", port, key: "/bar", value: "baz" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "put");
      assert.strictEqual(result.key, "/bar");
      assert.strictEqual(result.value, "baz");
      assert.strictEqual(result.revision, "6");
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C3 — delete a key
  await test("C3: delete operation returns deleted count", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/deleterange": (body) => ({
        header:  fakeHeader("7"),
        deleted: "1",
      }),
    });
    try {
      const result = await etcdClient({ operation: "delete", host: "127.0.0.1", port, key: "/baz" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "delete");
      assert.strictEqual(result.deleted, 1);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C4 — list keys
  await test("C4: list operation returns key names under prefix", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/range": (body) => ({
        header: fakeHeader("8"),
        count:  "3",
        kvs: [
          fakeKv("/app/a", ""),
          fakeKv("/app/b", ""),
          fakeKv("/app/c", ""),
        ],
      }),
    });
    try {
      const result = await etcdClient({ operation: "list", host: "127.0.0.1", port, prefix: "/app/" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "list");
      assert.ok(Array.isArray(result.keys));
      assert.strictEqual(result.keys.length, 3);
      assert.ok(result.keys.includes("/app/a"));
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C5 — grant_lease
  await test("C5: grant_lease returns lease_id and ttl", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/lease/grant": (body) => ({ header: fakeHeader(), ID: "123456", TTL: "30" }),
    });
    try {
      const result = await etcdClient({ operation: "grant_lease", host: "127.0.0.1", port, ttl: 30 });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "grant_lease");
      assert.strictEqual(result.lease_id, "123456");
      assert.strictEqual(result.ttl, 30);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C6 — revoke_lease
  await test("C6: revoke_lease returns revoked:true", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/lease/revoke": () => ({ header: fakeHeader() }),
    });
    try {
      const result = await etcdClient({ operation: "revoke_lease", host: "127.0.0.1", port, lease_id: "123" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.revoked, true);
      assert.strictEqual(result.lease_id, "123");
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C7 — keepalive
  await test("C7: keepalive returns refreshed lease TTL", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/lease/keepalive": () => ({ result: { ID: "789", TTL: "28" } }),
    });
    try {
      const result = await etcdClient({ operation: "keepalive", host: "127.0.0.1", port, lease_id: "789" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "keepalive");
      assert.strictEqual(result.ttl, 28);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C8 — status
  await test("C8: status operation returns cluster member info", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/maintenance/status": () => ({
        version:    "3.5.0",
        dbSize:     "1048576",
        dbSizeInUse: "524288",
        leader:     "1234",
        raftIndex:  "100",
        raftTerm:   "2",
        raftAppliedIndex: "99",
        isLearner:  false,
      }),
    });
    try {
      const result = await etcdClient({ operation: "status", host: "127.0.0.1", port });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "status");
      assert.strictEqual(result.version, "3.5.0");
      assert.strictEqual(result.db_size, 1048576);
      assert.strictEqual(result.leader,  "1234");
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C9 — members
  await test("C9: members operation returns cluster member list", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/cluster/member/list": () => ({
        header:  fakeHeader(),
        members: [
          {
            ID:         "aaa",
            name:       "node1",
            peerURLs:   ["http://node1:2380"],
            clientURLs: ["http://node1:2379"],
            isLearner:  false,
          },
          {
            ID:         "bbb",
            name:       "node2",
            peerURLs:   ["http://node2:2380"],
            clientURLs: ["http://node2:2379"],
            isLearner:  false,
          },
        ],
      }),
    });
    try {
      const result = await etcdClient({ operation: "members", host: "127.0.0.1", port });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "members");
      assert.strictEqual(result.count, 2);
      assert.strictEqual(result.members[0].name, "node1");
      assert.ok(Array.isArray(result.members[0].peer_urls));
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C10 — txn
  await test("C10: txn returns succeeded and responses", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/txn": () => ({
        header:    fakeHeader("10"),
        succeeded: true,
        responses: [],
      }),
    });
    try {
      const result = await etcdClient({
        operation: "txn",
        host:      "127.0.0.1",
        port,
        compare:   [{ key: "/lock", target: "VERSION", result: "EQUAL", version: 0 }],
        success:   [{ request_put: { key: "/lock", value: "owner" } }],
        failure:   [],
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "txn");
      assert.strictEqual(result.succeeded, true);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C11 — etcd error propagates
  await test("C11: etcd error in response body propagates as Error", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/range": () => ({ error: "rpc error: code = NotFound", code: 5 }),
    });
    try {
      await assertRejects(
        () => etcdClient({ operation: "get", host: "127.0.0.1", port, key: "/missing" }),
        "rpc error"
      );
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C12 — connection refused rejects cleanly
  await test("C12: connection refused rejects with descriptive error", async () => {
    await assertRejects(
      () => etcdClient({ operation: "get", host: "127.0.0.1", port: 1, key: "/foo", timeout: 2000 }),
      "Cannot connect"
    );
  });

  // C13 — put with prev_kv returns previous kv
  await test("C13: put with prev_kv:true returns the previous kv", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/put": () => ({
        header:  fakeHeader("9"),
        prev_kv: fakeKv("/key", "old-value", "1"),
      }),
    });
    try {
      const result = await etcdClient({
        operation: "put", host: "127.0.0.1", port, key: "/key", value: "new-value", prev_kv: true,
      });
      assert.strictEqual(result.prev_kv.key,   "/key");
      assert.strictEqual(result.prev_kv.value, "old-value");
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C14 — delete with prefix sends correct range_end
  await test("C14: delete with prefix sends correct range_end to etcd", async () => {
    let receivedBody = null;
    const { server, port } = await createMockEtcd({
      "/v3/kv/deleterange": (body) => { receivedBody = body; return { header: fakeHeader(), deleted: "3" }; },
    });
    try {
      await etcdClient({ operation: "delete", host: "127.0.0.1", port, prefix: "/app/" });
      assert.ok(receivedBody.key,       "key should be set");
      assert.ok(receivedBody.range_end, "range_end should be set for prefix delete");
      // Verify the key encodes '/app/'
      assert.strictEqual(fromB64(receivedBody.key), "/app/");
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C15 — auth_enable
  await test("C15: auth_enable returns enabled:true", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/auth/enable": () => ({ header: fakeHeader() }),
    });
    try {
      const result = await etcdClient({ operation: "auth_enable", host: "127.0.0.1", port });
      assert.strictEqual(result.ok,      true);
      assert.strictEqual(result.enabled, true);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C16 — auth_disable
  await test("C16: auth_disable returns disabled:true", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/auth/disable": () => ({ header: fakeHeader() }),
    });
    try {
      const result = await etcdClient({ operation: "auth_disable", host: "127.0.0.1", port });
      assert.strictEqual(result.ok,       true);
      assert.strictEqual(result.disabled, true);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C17 — compact
  await test("C17: compact operation returns revision and physical flag", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/compaction": () => ({ header: fakeHeader() }),
    });
    try {
      const result = await etcdClient({ operation: "compact", host: "127.0.0.1", port, revision: 10, physical: true });
      assert.strictEqual(result.ok,       true);
      assert.strictEqual(result.revision, "10");
      assert.strictEqual(result.physical, true);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C18 — lock
  await test("C18: lock operation returns lock key", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/lock/lock": () => ({
        header: fakeHeader(),
        key: toB64("my-mutex/abc123"),
      }),
    });
    try {
      const result = await etcdClient({ operation: "lock", host: "127.0.0.1", port, name: "my-mutex" });
      assert.strictEqual(result.ok,        true);
      assert.strictEqual(result.operation, "lock");
      assert.strictEqual(result.name,      "my-mutex");
      assert.ok(result.key.startsWith("my-mutex"));
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C19 — unlock
  await test("C19: unlock operation returns released:true", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/lock/unlock": () => ({ header: fakeHeader() }),
    });
    try {
      const result = await etcdClient({ operation: "unlock", host: "127.0.0.1", port, key: "my-mutex/abc123" });
      assert.strictEqual(result.ok,       true);
      assert.strictEqual(result.released, true);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // C20 — server address in result
  await test("C20: result.server contains host:port", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/range": () => ({ header: fakeHeader(), kvs: [fakeKv("/k", "v")] }),
    });
    try {
      const result = await etcdClient({ operation: "get", host: "127.0.0.1", port, key: "/k" });
      assert.ok(result.server.includes("127.0.0.1"));
      assert.ok(result.server.includes(String(port)));
    } finally {
      await closeMockEtcd(server);
    }
  });
}

// ── Section D: Security tests ───────────────────────────────────────────────

async function runD() {
  console.error("\nD — Security / injection tests");

  // D1 — NUL byte in host
  await test("D1: NUL byte in host is rejected", async () => {
    await assertRejects(
      () => etcdClient({ operation: "get", host: "127.0.0.1\x00evil", key: "/foo" }),
      "NUL"
    );
  });

  // D2 — NUL byte in key
  await test("D2: NUL byte in key is rejected", async () => {
    await assertRejects(
      () => etcdClient({ operation: "get", host: "localhost", key: "/foo\x00bar" }),
      "NUL"
    );
  });

  // D3 — NUL byte in value
  await test("D3: NUL byte in value is rejected", async () => {
    await assertRejects(
      () => etcdClient({ operation: "put", host: "localhost", key: "/k", value: "v\x00alue" }),
      "NUL"
    );
  });

  // D4 — NUL byte in prefix
  await test("D4: NUL byte in prefix is rejected", async () => {
    await assertRejects(
      () => etcdClient({ operation: "get", host: "localhost", prefix: "/app\x00hack" }),
      "NUL"
    );
  });

  // D5 — NUL byte in username
  await test("D5: NUL byte in username is rejected", async () => {
    await assertRejects(
      () => etcdClient({ operation: "status", host: "127.0.0.1", port: 1, username: "adm\x00in" }),
      "NUL"
    );
  });

  // D6 — NUL byte in password
  await test("D6: NUL byte in password is rejected", async () => {
    await assertRejects(
      () => etcdClient({ operation: "status", host: "127.0.0.1", port: 1, password: "pass\x00word" }),
      "NUL"
    );
  });

  // D7 — NUL byte in lock name
  await test("D7: NUL byte in lock name is rejected", async () => {
    await assertRejects(
      () => etcdClient({ operation: "lock", host: "127.0.0.1", port: 1, name: "mu\x00tex" }),
      "NUL"
    );
  });

  // D8 — NUL byte in unlock key
  await test("D8: NUL byte in unlock key is rejected", async () => {
    await assertRejects(
      () => etcdClient({ operation: "unlock", host: "127.0.0.1", port: 1, key: "k\x00ey" }),
      "NUL"
    );
  });

  // D9 — password not returned in output
  await test("D9: password field is not echoed back in etcd error output", async () => {
    // When auth fails, the password must not appear in the thrown error message
    // Use port 1 to get a connection error (no real server), check password not in error
    try {
      await etcdClient({
        operation: "status",
        host: "127.0.0.1",
        port: 1,
        username: "admin",
        password: "super-secret-password-xyz",
        timeout: 1500,
      });
    } catch (err) {
      assert.ok(!err.message.includes("super-secret-password-xyz"),
        "password leaked in error message: " + err.message);
    }
  });

  // D10 — JSON injection in key: special chars treated as literal
  await test("D10: special JSON chars in key/value are base64-encoded safely", () => {
    const maliciousKey = '/"{}';
    const encoded = toB64(maliciousKey);
    // base64 never contains <, >, or " in a way that could break JSON
    const decoded = fromB64(encoded);
    assert.strictEqual(decoded, maliciousKey);
  });
}

// ── Section E: Concurrency / stress tests ────────────────────────────────────

async function runE() {
  console.error("\nE — Concurrency / stress tests");

  // E1 — multiple concurrent get requests
  await test("E1: 8 concurrent get requests all succeed", async () => {
    let reqCount = 0;
    const { server, port } = await createMockEtcd({
      "/v3/kv/range": (body) => {
        reqCount++;
        const key = fromB64(body.key || "");
        return { header: fakeHeader(), count: "1", kvs: [fakeKv(key, "val")] };
      },
    });
    try {
      const keys    = ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"];
      const results = await Promise.all(
        keys.map(key => etcdClient({ operation: "get", host: "127.0.0.1", port, key }))
      );
      assert.strictEqual(results.length, 8);
      for (const r of results) assert.strictEqual(r.ok, true);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // E2 — concurrent mixed operations
  await test("E2: concurrent get+put+delete all succeed", async () => {
    const { server, port } = await createMockEtcd({
      "/v3/kv/range":       () => ({ header: fakeHeader(), count: "1", kvs: [fakeKv("/k", "v")] }),
      "/v3/kv/put":         () => ({ header: fakeHeader() }),
      "/v3/kv/deleterange": () => ({ header: fakeHeader(), deleted: "1" }),
    });
    try {
      const [getR, putR, delR] = await Promise.all([
        etcdClient({ operation: "get",    host: "127.0.0.1", port, key: "/k" }),
        etcdClient({ operation: "put",    host: "127.0.0.1", port, key: "/k", value: "v2" }),
        etcdClient({ operation: "delete", host: "127.0.0.1", port, key: "/old" }),
      ]);
      assert.strictEqual(getR.ok, true);
      assert.strictEqual(putR.ok, true);
      assert.strictEqual(delR.ok, true);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // E3 — toB64/fromB64 round-trip stress test
  await test("E3: toB64/fromB64 stress test with 500 varied keys", () => {
    for (let i = 0; i < 500; i++) {
      const key = `/namespace/service-${i}/instance/item-${i * 3}`;
      assert.strictEqual(fromB64(toB64(key)), key);
    }
  });

  // E4 — prefixRangeEnd stress test
  await test("E4: prefixRangeEnd on 200 different prefixes produces consistent results", () => {
    for (let i = 0; i < 200; i++) {
      const prefix  = `/range-test-${i}/`;
      const rangeEnd = prefixRangeEnd(prefix);
      // Must be a non-empty base64 string
      assert.ok(typeof rangeEnd === "string" && rangeEnd.length > 0);
      // Must be decodeable
      const decoded = Buffer.from(rangeEnd, "base64");
      assert.ok(decoded.length > 0);
    }
  });

  // E5 — large list response
  await test("E5: list handles 500 keys in response", async () => {
    const manyKvs = Array.from({ length: 500 }, (_, i) => fakeKv(`/key-${i}`, `val-${i}`));
    const { server, port } = await createMockEtcd({
      "/v3/kv/range": () => ({ header: fakeHeader(), count: "500", kvs: manyKvs }),
    });
    try {
      const result = await etcdClient({ operation: "list", host: "127.0.0.1", port, prefix: "/key-" });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.keys.length, 500);
      assert.strictEqual(result.count, 500);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // E6 — sequential put+get cycle
  await test("E6: 10 sequential put→get cycles succeed", async () => {
    let putCount = 0;
    let getCount = 0;
    const store  = {};
    const { server, port } = await createMockEtcd({
      "/v3/kv/put":   (body) => { putCount++; const k = fromB64(body.key); store[k] = fromB64(body.value); return { header: fakeHeader() }; },
      "/v3/kv/range": (body) => { getCount++; const k = fromB64(body.key); const v = store[k] || ""; return { header: fakeHeader(), count: "1", kvs: [fakeKv(k, v)] }; },
    });
    try {
      for (let i = 0; i < 10; i++) {
        const key = `/cycle-${i}`;
        await etcdClient({ operation: "put",  host: "127.0.0.1", port, key, value: `value-${i}` });
        const r = await etcdClient({ operation: "get", host: "127.0.0.1", port, key });
        assert.strictEqual(r.kvs[0].value, `value-${i}`);
      }
      assert.strictEqual(putCount, 10);
      assert.strictEqual(getCount, 10);
    } finally {
      await closeMockEtcd(server);
    }
  });

  // E7 — info operation 100× concurrently (pure, no I/O)
  await test("E7: 100 concurrent info calls all return immediately", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => etcdClient({ operation: "info", host: "localhost" }))
    );
    assert.strictEqual(results.length, 100);
    for (const r of results) {
      assert.ok(r.protocol.includes("etcd"));
    }
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.error("\n=== etcd_client tests (section 266) ===");
  await runA();
  await runB();
  await runC();
  await runD();
  await runE();

  const total = passed + failed;
  console.error(`\n═══ Results: ${passed}/${total} passed ═══`);

  if (failed > 0) {
    process.exit(1);
  }
})();
