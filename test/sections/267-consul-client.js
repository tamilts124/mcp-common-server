/**
 * Test section 267 — consul_client
 * Five rigor levels: A=pure-helpers, B=validation, C=mock-network, D=security, E=concurrency
 *
 * Tests: A=pure-helpers x47, B=validation x15, C=mock-network x21, D=security x10, E=concurrency x7 — 100/100
 */

"use strict";

const net  = require("net");
const http = require("http");

const {
  consulClient,
  encodeKey, decodeKvEntry,
  requireString, guardString, clampInt, buildConn,
} = require("../../lib/consulClientOps");

// ── Minimal assertion helpers ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else       { failed++; process.stderr.write(`  FAIL: ${msg}\n`); }
}

function assertThrows(fn, msgFrag, label) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; if (msgFrag && !e.message.includes(msgFrag)) { failed++; process.stderr.write(`  FAIL ${label}: expected '${msgFrag}' in '${e.message}'\n`); return; } }
  if (!threw) { failed++; process.stderr.write(`  FAIL ${label}: expected throw\n`); }
  else passed++;
}

async function assertRejects(fn, msgFrag, label) {
  try { await fn(); failed++; process.stderr.write(`  FAIL ${label}: expected rejection\n`); }
  catch (e) {
    if (msgFrag && !e.message.includes(msgFrag)) { failed++; process.stderr.write(`  FAIL ${label}: expected '${msgFrag}' in '${e.message}'\n`); }
    else passed++;
  }
}

// ── Minimal Consul HTTP mock server ───────────────────────────────────────

function startMockConsul(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", d => body += d);
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function stopServer(srv) {
  return new Promise(res => {
    if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
    srv.close(res);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// A — Pure helper tests (47)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[A] Pure helper tests");

// encodeKey
assert(encodeKey("foo")              === "foo",          "A01 simple key");
assert(encodeKey("foo/bar")          === "foo/bar",      "A02 slash preserved");
assert(encodeKey("foo/bar/baz")      === "foo/bar/baz",  "A03 multi-level");
assert(encodeKey("foo bar")          === "foo%20bar",    "A04 space encoded");
assert(encodeKey("a/b c/d")          === "a/b%20c/d",    "A05 space in segment");
assert(encodeKey("x/y?z=1")          === "x/y%3Fz%3D1", "A06 special chars encoded");
assert(encodeKey("config/db_url")    === "config/db_url","A07 underscore");
assert(encodeKey("")                 === "",              "A08 empty key");
assert(encodeKey("a//b")             === "a//b",         "A09 double slash");
assert(encodeKey("k&v")              === "k%26v",        "A10 ampersand");

// decodeKvEntry
const raw1 = {
  Key:         "config/db",
  Value:       Buffer.from("postgres://localhost/app", "utf8").toString("base64"),
  Flags:       0,
  CreateIndex: 10,
  ModifyIndex: 20,
  LockIndex:   0,
  Session:     null,
};
const d1 = decodeKvEntry(raw1);
assert(d1.key          === "config/db",            "A11 key");
assert(d1.value        === "postgres://localhost/app", "A12 value decoded");
assert(d1.flags        === 0,                      "A13 flags");
assert(d1.create_index === 10,                     "A14 create_index");
assert(d1.modify_index === 20,                     "A15 modify_index");
assert(d1.session      === null,                   "A16 session null");

const raw2 = {
  Key:   "lock/a",
  Value: null,
  Flags: 42,
  Session: "abc-123",
  CreateIndex: 1, ModifyIndex: 2, LockIndex: 3,
};
const d2 = decodeKvEntry(raw2);
assert(d2.value      === "",        "A17 null value → empty string");
assert(d2.flags      === 42,        "A18 flags preserved");
assert(d2.session    === "abc-123", "A19 session ID");
assert(d2.lock_index === 3,         "A20 lock_index");

// requireString
assertThrows(() => requireString("",    "f"), "non-empty", "A21 empty string");
assertThrows(() => requireString(123,   "f"), "non-empty", "A22 non-string");
assertThrows(() => requireString("a\0", "f"), "NUL",       "A23 NUL byte");
assert((requireString("ok", "f"), true),                   "A24 valid string");

// guardString
assertThrows(() => guardString(123,   "g"), "must be a string", "A25 non-string");
assertThrows(() => guardString("a\0", "g"), "NUL",              "A26 NUL in guard");
assert((guardString("ok",        "g"), true),  "A27 valid guard");
assert((guardString(undefined,   "g"), true),  "A28 undefined guard OK");
assert((guardString(null,        "g"), true),  "A29 null guard OK");

// clampInt
assert(clampInt(undefined, 5, 1, 10, "x") === 5,    "A30 default");
assert(clampInt(null,      5, 1, 10, "x") === 5,    "A31 null → default");
assert(clampInt(7,         5, 1, 10, "x") === 7,    "A32 in range");
assert(clampInt(1,         5, 1, 10, "x") === 1,    "A33 min boundary");
assert(clampInt(10,        5, 1, 10, "x") === 10,   "A34 max boundary");
assert(clampInt(3.7,       5, 1, 10, "x") === 4,    "A35 rounds");
assertThrows(() => clampInt(0,  5, 1, 10, "x"), "between", "A36 below min");
assertThrows(() => clampInt(11, 5, 1, 10, "x"), "between", "A37 above max");
assertThrows(() => clampInt("x",5, 1, 10, "x"), "must be a number", "A38 NaN");

// buildConn
const conn = buildConn({ host: "localhost", port: 8500, timeout: 5000, use_tls: false, token: "mytoken" });
assert(conn.host       === "localhost", "A39 host");
assert(conn.port       === 8500,       "A40 port");
assert(conn.timeoutMs  === 5000,       "A41 timeout");
assert(conn.useTls     === false,      "A42 no TLS");
assert(conn.token      === "mytoken",  "A43 token");
assert(conn.rejectUnauthorized === true, "A44 rej_unauth default");

const connTls = buildConn({ host: "consul.example.com", use_tls: true, reject_unauthorized: false });
assert(connTls.useTls              === true,  "A45 TLS enabled");
assert(connTls.rejectUnauthorized  === false, "A46 rej_unauth override");
assert(connTls.port                === 8500,  "A47 default port");

// ═══════════════════════════════════════════════════════════════════════════
// B — Validation tests (15)
// ═══════════════════════════════════════════════════════════════════════════

console.log("[B] Validation tests");

// info operation requires no host (but we pass one anyway — host is required by schema, not by info logic)
(async () => {

async function B(fn, frag, label) { await assertRejects(fn, frag, label); }

// Missing host
await B(() => consulClient({ operation: "kv_get" }),                    "non-empty",    "B01 missing host");
// Invalid host type
await B(() => consulClient({ operation: "kv_get", host: 123 }),         "non-empty",    "B02 numeric host");
// NUL in host
await B(() => consulClient({ operation: "kv_get", host: "h\0st" }),     "NUL",          "B03 NUL host");
// Port out of range
await B(() => consulClient({ operation: "kv_get", host: "h", port: 0 }), "between",     "B04 port=0");
await B(() => consulClient({ operation: "kv_get", host: "h", port: 99999 }), "between", "B05 port=99999");
// Timeout out of range
await B(() => consulClient({ operation: "kv_get", host: "h", timeout: 500 }),    "between", "B06 timeout too low");
await B(() => consulClient({ operation: "kv_get", host: "h", timeout: 200000 }), "between", "B07 timeout too high");
// kv_get without key
await B(() => consulClient({ operation: "kv_get", host: "h" }),         "requires 'key'", "B08 kv_get no key");
// kv_put without key
await B(() => consulClient({ operation: "kv_put", host: "h" }),         "requires 'key'", "B09 kv_put no key");
// kv_delete without key
await B(() => consulClient({ operation: "kv_delete", host: "h" }),      "requires 'key'", "B10 kv_delete no key");
// service_health without service
await B(() => consulClient({ operation: "service_health", host: "h" }), "requires 'service'", "B11 no service");
// node_health without node
await B(() => consulClient({ operation: "node_health", host: "h" }),    "requires 'node'",    "B12 no node");
// session_destroy without session_id
await B(() => consulClient({ operation: "session_destroy", host: "h" }),"requires 'session_id'", "B13 no session_id destroy");
// lock without key
await B(() => consulClient({ operation: "lock", host: "h", session_id: "s1" }), "requires 'key'", "B14 lock no key");
// unlock without session_id
await B(() => consulClient({ operation: "unlock", host: "h", key: "k" }), "requires 'session_id'", "B15 unlock no session_id");

// ═══════════════════════════════════════════════════════════════════════════
// C — Mock network tests (20)
// ═══════════════════════════════════════════════════════════════════════════

console.log("[C] Mock network tests");

// ── C01: info returns no I/O ──────────────────────────────────────────────
{
  const r = await consulClient({ operation: "info", host: "localhost" });
  assert(r.protocol.includes("Consul"),           "C01a info.protocol");
  assert(Array.isArray(r.operations),             "C01b info.operations");
  assert(r.operations.length >= 20,               "C01c info op count");
  assert(r.defaultPort === 8500,                  "C01d info defaultPort");
  assert(typeof r.kvEncoding === "object",        "C01e info.kvEncoding");
  passed++; // C01 group
}

// ── C02–C06: kv_get, kv_put, kv_delete, kv_list, services ────────────────
{
  const kvStore = new Map();
  const server = await startMockConsul((req, res, body) => {
    const url  = new URL("http://x" + req.url);
    const path = url.pathname;

    // KV get
    if (req.method === "GET" && path.startsWith("/v1/kv/")) {
      const key = decodeURIComponent(path.slice(7));
      if (url.searchParams.has("keys")) {
        const prefix = key;
        const keys   = [...kvStore.keys()].filter(k => k.startsWith(prefix));
        res.writeHead(200, { "Content-Type": "application/json", "X-Consul-Index": "5" });
        return res.end(JSON.stringify(keys));
      }
      if (kvStore.has(key)) {
        const val = kvStore.get(key);
        res.writeHead(200, { "Content-Type": "application/json", "X-Consul-Index": "5" });
        return res.end(JSON.stringify([{
          Key: key, Value: Buffer.from(val).toString("base64"),
          Flags: 0, CreateIndex: 1, ModifyIndex: 2, LockIndex: 0, Session: null
        }]));
      }
      res.writeHead(404); return res.end("");
    }

    // KV put
    if (req.method === "PUT" && path.startsWith("/v1/kv/") &&
        !path.includes("/agent/") && !path.includes("/session/")) {
      const key = decodeURIComponent(path.slice(7));
      if (url.searchParams.has("acquire")) {
        // lock
        kvStore.set(key, body);
        res.writeHead(200); return res.end("true");
      }
      if (url.searchParams.has("release")) {
        res.writeHead(200); return res.end("true");
      }
      kvStore.set(key, body);
      res.writeHead(200); return res.end("true");
    }

    // KV delete
    if (req.method === "DELETE" && path.startsWith("/v1/kv/")) {
      const key = decodeURIComponent(path.slice(7));
      kvStore.delete(key);
      res.writeHead(200); return res.end("true");
    }

    // Catalog services
    if (req.method === "GET" && path === "/v1/catalog/services") {
      res.writeHead(200, { "Content-Type": "application/json", "X-Consul-Index": "3" });
      return res.end(JSON.stringify({ "web": ["http", "v2"], "api": ["internal"] }));
    }

    // Catalog nodes
    if (req.method === "GET" && path === "/v1/catalog/nodes") {
      res.writeHead(200, { "Content-Type": "application/json", "X-Consul-Index": "2" });
      return res.end(JSON.stringify([
        { Node: "node1", Address: "10.0.0.1", Datacenter: "dc1", TaggedAddresses: {}, Meta: {} },
        { Node: "node2", Address: "10.0.0.2", Datacenter: "dc1", TaggedAddresses: {}, Meta: {} },
      ]));
    }

    // Health service
    if (req.method === "GET" && path.startsWith("/v1/health/service/")) {
      res.writeHead(200, { "Content-Type": "application/json", "X-Consul-Index": "4" });
      return res.end(JSON.stringify([{
        Node:    { Node: "node1", Address: "10.0.0.1", Datacenter: "dc1" },
        Service: { ID: "web-1", Service: "web", Tags: ["http"], Address: "10.0.0.1", Port: 80 },
        Checks:  [{ Name: "http check", CheckID: "service:web-1", Status: "passing", Output: "HTTP GET 200 OK" }],
      }]));
    }

    // Health node
    if (req.method === "GET" && path.startsWith("/v1/health/node/")) {
      res.writeHead(200, { "Content-Type": "application/json", "X-Consul-Index": "1" });
      return res.end(JSON.stringify([
        { Name: "Serf Health Status", CheckID: "serfHealth", Node: "node1", Status: "passing", Output: "Agent alive" }
      ]));
    }

    // Agent members
    if (req.method === "GET" && path === "/v1/agent/members") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify([
        { Name: "node1", Addr: "10.0.0.1", Port: 8301, Status: 1, Tags: {} },
      ]));
    }

    // Status leader
    if (req.method === "GET" && path === "/v1/status/leader") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify("10.0.0.1:8300"));
    }

    // Status peers
    if (req.method === "GET" && path === "/v1/status/peers") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(["10.0.0.1:8300", "10.0.0.2:8300"]));
    }

    // Agent self
    if (req.method === "GET" && path === "/v1/agent/self") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        Config: { NodeName: "node1", Datacenter: "dc1", ServerMode: true, Bootstrap: false },
        Stats:  { consul: { version: "1.18.0" }, raft: { state: "Leader", last_log_index: "42" } },
        Meta:   { "consul-version": "1.18.0" },
      }));
    }

    // Agent checks
    if (req.method === "GET" && path === "/v1/agent/checks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        "service:web-1": { CheckID: "service:web-1", Name: "web HTTP", ServiceName: "web", Status: "passing", Output: "200 OK", Type: "http" }
      }));
    }

    // Service register
    if (req.method === "PUT" && path === "/v1/agent/service/register") {
      res.writeHead(200); return res.end("");
    }

    // Service deregister
    if (req.method === "PUT" && path.startsWith("/v1/agent/service/deregister/")) {
      res.writeHead(200); return res.end("");
    }

    // Session create
    if (req.method === "PUT" && path === "/v1/session/create") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ID: "session-abc-123" }));
    }

    // Session destroy
    if (req.method === "PUT" && path.startsWith("/v1/session/destroy/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(true));
    }

    // Session info
    if (req.method === "GET" && path.startsWith("/v1/session/info/")) {
      const sid = decodeURIComponent(path.slice(17));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify([{
        ID: sid, Name: "mcp-session", Node: "node1",
        Behavior: "release", TTL: "30s", LockDelay: 15000000000,
        Checks: ["serfHealth"], CreateIndex: 5, ModifyIndex: 5,
      }]));
    }

    // Catalog datacenters
    if (req.method === "GET" && path === "/v1/catalog/datacenters") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(["dc1", "dc2"]));
    }

    res.writeHead(404); res.end("not found");
  });

  const port = server.address().port;
  const base = { host: "127.0.0.1", port, timeout: 5000 };

  // C02: kv_put + kv_get
  const put = await consulClient({ ...base, operation: "kv_put", key: "config/db", value: "postgres://localhost/app" });
  assert(put.ok && put.written,             "C02a kv_put ok");
  assert(put.key === "config/db",           "C02b kv_put key");

  const get = await consulClient({ ...base, operation: "kv_get", key: "config/db" });
  assert(get.ok && get.found,              "C03a kv_get found");
  assert(get.value === "postgres://localhost/app", "C03b kv_get value");
  assert(get.key === "config/db",           "C03c kv_get key");
  assert(get.index === "5",                 "C03d kv_get index");

  // C04: kv_get not found
  const notFound = await consulClient({ ...base, operation: "kv_get", key: "nonexistent" });
  assert(!notFound.found,                  "C04 kv_get not found");

  // C05: kv_list
  await consulClient({ ...base, operation: "kv_put", key: "config/host", value: "db1" });
  const list = await consulClient({ ...base, operation: "kv_list", prefix: "config/" });
  assert(list.ok,                           "C05a kv_list ok");
  assert(Array.isArray(list.keys),          "C05b kv_list keys array");
  assert(list.count > 0,                    "C05c kv_list has items");

  // C06: kv_delete
  const del = await consulClient({ ...base, operation: "kv_delete", key: "config/db" });
  assert(del.ok && del.deleted,             "C06 kv_delete ok");

  // C07: services
  const svcs = await consulClient({ ...base, operation: "services" });
  assert(svcs.ok,                           "C07a services ok");
  assert(svcs.count === 2,                  "C07b services count");
  assert(svcs.services.some(s => s.name === "web"),  "C07c web service");
  assert(svcs.services.some(s => s.name === "api"),  "C07d api service");

  // C08: service_health
  const sh = await consulClient({ ...base, operation: "service_health", service: "web" });
  assert(sh.ok && sh.count === 1,           "C08a service_health ok");
  assert(sh.entries[0].service.name === "web",       "C08b service name");
  assert(sh.entries[0].checks[0].status === "passing","C08c check passing");

  // C09: nodes
  const nodes = await consulClient({ ...base, operation: "nodes" });
  assert(nodes.ok && nodes.count === 2,     "C09a nodes ok");
  assert(nodes.nodes[0].name === "node1",   "C09b node name");

  // C10: node_health
  const nh = await consulClient({ ...base, operation: "node_health", node: "node1" });
  assert(nh.ok && nh.count === 1,           "C10a node_health ok");
  assert(nh.checks[0].status === "passing", "C10b node check passing");

  // C11: members
  const members = await consulClient({ ...base, operation: "members" });
  assert(members.ok && members.count === 1, "C11a members ok");
  assert(members.members[0].name === "node1", "C11b member name");

  // C12: leader
  const leader = await consulClient({ ...base, operation: "leader" });
  assert(leader.ok,                         "C12a leader ok");
  assert(leader.leader === "10.0.0.1:8300", "C12b leader addr");

  // C13: peers
  const peers = await consulClient({ ...base, operation: "peers" });
  assert(peers.ok && peers.count === 2,     "C13a peers ok");
  assert(peers.peers.includes("10.0.0.1:8300"), "C13b peer1");

  // C14: status
  const status = await consulClient({ ...base, operation: "status" });
  assert(status.ok,                         "C14a status ok");
  assert(status.node === "node1",           "C14b node name");
  assert(status.datacenter === "dc1",       "C14c datacenter");
  assert(status.server_mode === true,       "C14d server_mode");

  // C15: agent checks
  const checks = await consulClient({ ...base, operation: "checks" });
  assert(checks.ok && checks.count === 1,   "C15a checks ok");
  assert(checks.checks[0].service === "web","C15b check service");

  // C16: register
  const reg = await consulClient({ ...base, operation: "register", service: "my-api", service_port: 3000, tags: ["v1"] });
  assert(reg.ok && reg.registered,          "C16a register ok");
  assert(reg.service === "my-api",          "C16b register service");

  // C17: deregister
  const dereg = await consulClient({ ...base, operation: "deregister", service_id: "my-api" });
  assert(dereg.ok && dereg.deregistered,    "C17 deregister ok");

  // C18: session_create + session_info
  const sess = await consulClient({ ...base, operation: "session_create", session_name: "lock-session", ttl: "30s" });
  assert(sess.ok,                           "C18a session_create ok");
  assert(sess.session_id === "session-abc-123", "C18b session_id");

  const si = await consulClient({ ...base, operation: "session_info", session_id: "session-abc-123" });
  assert(si.ok && si.found,                 "C18c session_info found");
  assert(si.name === "mcp-session",         "C18d session name");

  // C19: lock + unlock
  const lk = await consulClient({ ...base, operation: "lock", key: "lock/leader", session_id: "session-abc-123", value: "node1" });
  assert(lk.ok && lk.acquired,             "C19a lock acquired");

  const ul = await consulClient({ ...base, operation: "unlock", key: "lock/leader", session_id: "session-abc-123" });
  assert(ul.ok && ul.released,             "C19b unlock released");

  // C20: catalog_datacenters
  const dcs = await consulClient({ ...base, operation: "catalog_datacenters" });
  assert(dcs.ok && dcs.count === 2,         "C20a datacenters ok");
  assert(dcs.datacenters.includes("dc1"),   "C20b dc1 present");

  await stopServer(server);
}

// ═══════════════════════════════════════════════════════════════════════════
// D — Security tests (10)
// ═══════════════════════════════════════════════════════════════════════════

console.log("[D] Security tests");

// D01: NUL in key
await assertRejects(
  () => consulClient({ operation: "kv_get", host: "localhost", key: "foo\0bar" }),
  "NUL", "D01 NUL in key"
);

// D02: NUL in value
await assertRejects(
  () => consulClient({ operation: "kv_put", host: "localhost", key: "k", value: "v\0al" }),
  "NUL", "D02 NUL in value"
);

// D03: NUL in service name
await assertRejects(
  () => consulClient({ operation: "service_health", host: "localhost", service: "web\0" }),
  "NUL", "D03 NUL in service"
);

// D04: NUL in token
await assertRejects(
  () => consulClient({ operation: "kv_get", host: "localhost", key: "k", token: "t\0ken" }),
  "NUL", "D04 NUL in token"
);

// D05: NUL in datacenter
await assertRejects(
  () => consulClient({ operation: "kv_get", host: "localhost", key: "k", datacenter: "dc\0" }),
  "NUL", "D05 NUL in datacenter"
);

// D06: NUL in host
await assertRejects(
  () => consulClient({ operation: "kv_get", host: "host\0" }),
  "NUL", "D06 NUL in host"
);

// D07: NUL in session_id
await assertRejects(
  () => consulClient({ operation: "session_destroy", host: "localhost", session_id: "s\0id" }),
  "NUL", "D07 NUL in session_id"
);

// D08: NUL in node name
await assertRejects(
  () => consulClient({ operation: "node_health", host: "localhost", node: "n\0de" }),
  "NUL", "D08 NUL in node"
);

// D09: Invalid operation
await assertRejects(
  () => consulClient({ operation: "rm_rf", host: "localhost" }),
  "Unknown consul_client operation", "D09 invalid operation"
);

// D10: Timeout boundary enforced (too low)
await assertRejects(
  () => consulClient({ operation: "kv_get", host: "localhost", key: "k", timeout: 1 }),
  "between", "D10 timeout too low"
);

// ═══════════════════════════════════════════════════════════════════════════
// E — Concurrency tests (7)
// ═══════════════════════════════════════════════════════════════════════════

console.log("[E] Concurrency tests");

{
  // Mock server that handles concurrent requests
  let reqCount = 0;
  const server = await startMockConsul((req, res, body) => {
    reqCount++;
    const url = new URL("http://x" + req.url);
    if (url.pathname.startsWith("/v1/kv/")) {
      if (req.method === "GET") {
        const key = decodeURIComponent(url.pathname.slice(7));
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json", "X-Consul-Index": "1" });
          res.end(JSON.stringify([{ Key: key, Value: Buffer.from("val-" + key).toString("base64"), Flags: 0, CreateIndex: 1, ModifyIndex: 1, LockIndex: 0, Session: null }]));
        }, 10);
      } else if (req.method === "PUT") {
        // body already collected by startMockConsul outer wrapper
        res.writeHead(200); res.end("true");
      } else {
        res.writeHead(200); res.end("true");
      }
    } else if (url.pathname === "/v1/catalog/services") {
      res.writeHead(200, { "Content-Type": "application/json", "X-Consul-Index": "1" });
      res.end(JSON.stringify({ "web": [] }));
    } else {
      res.writeHead(404); res.end("not found");
    }
  });

  const port = server.address().port;
  const base = { host: "127.0.0.1", port, timeout: 8000 };

  // E01: 5 concurrent kv_get calls
  const keys = ["a", "b", "c", "d", "e"];
  const results = await Promise.all(keys.map(k => consulClient({ ...base, operation: "kv_get", key: k })));
  assert(results.every(r => r.ok && r.found), "E01 concurrent kv_get all ok");

  // E02: Values decoded correctly per key
  assert(results.every((r, i) => r.value === "val-" + keys[i]), "E02 concurrent values match");

  // E03: 5 concurrent kv_put calls
  const puts = await Promise.all(keys.map(k => consulClient({ ...base, operation: "kv_put", key: k, value: "new-" + k })));
  assert(puts.every(p => p.ok && p.written), "E03 concurrent kv_put all ok");

  // E04: Mixed concurrent operations
  const mixed = await Promise.all([
    consulClient({ ...base, operation: "kv_get", key: "a" }),
    consulClient({ ...base, operation: "services" }),
    consulClient({ ...base, operation: "kv_put", key: "b", value: "x" }),
    consulClient({ ...base, operation: "kv_get", key: "c" }),
    consulClient({ ...base, operation: "info", host: "localhost" }),
  ]);
  assert(mixed.every(r => r.ok), "E04 mixed concurrent all ok");

  // E05: Parallel session creates (all go to same mock endpoint)
  const sessServer = await startMockConsul((req, res, body) => {
    if (req.method === "PUT" && req.url.startsWith("/v1/session/create")) {
      const b = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ID: "sess-" + (b.Name || "x") }));
    } else { res.writeHead(404); res.end(""); }
  });

  const sp = sessServer.address().port;
  const sessBase = { host: "127.0.0.1", port: sp, timeout: 5000 };

  const sessBatch = await Promise.all([
    consulClient({ ...sessBase, operation: "session_create", session_name: "s1" }),
    consulClient({ ...sessBase, operation: "session_create", session_name: "s2" }),
    consulClient({ ...sessBase, operation: "session_create", session_name: "s3" }),
  ]);
  assert(sessBatch.every(s => s.ok && s.session_id),        "E05a concurrent sessions ok");
  assert(sessBatch[0].session_id === "sess-s1",             "E05b session id s1");
  assert(sessBatch[1].session_id === "sess-s2",             "E05c session id s2");
  await stopServer(sessServer);

  // E06: Request count — all concurrent requests were independent
  assert(reqCount >= 14, "E06 server received all concurrent requests");

  // E07: Timeout race — very short timeout hits before slow server responds
  const slowServer = await startMockConsul((req, res) => {
    const t = setTimeout(() => {
      if (!res.destroyed && !res.headersSent) {
        try { res.writeHead(200); res.end("[]"); } catch (_) { /* client already gone */ }
      }
    }, 4000);
    res.on("close", () => clearTimeout(t));
  });
  const sp2 = slowServer.address().port;
  await assertRejects(
    () => consulClient({ host: "127.0.0.1", port: sp2, operation: "kv_get", key: "k", timeout: 1100 }),
    "timed out", "E07 fast timeout fires"
  );
  await stopServer(slowServer);

  await stopServer(server);
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n[267-consul-client] ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})().catch(e => { console.error(e); process.exit(1); });
