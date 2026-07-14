/**
 * Test section 268 — vault_client
 * Five rigor levels: A=pure-helpers, B=validation, C=mock-network, D=security, E=concurrency
 *
 * Tests: A=pure-helpers x47, B=validation x15, C=mock-network x21, D=security x10, E=concurrency x7 — 100 asserts (153 total with sub-assertions)
 */

"use strict";

const http  = require("http");
const net   = require("net");
const { vaultClient, kvPath, buildConn, requireString, guardString, clampInt } =
  require("../../lib/vaultClientOps");

// ── Minimal assertion helpers ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else       { failed++; process.stderr.write(`  FAIL: ${msg}\n`); }
}

function assertThrows(fn, msgFrag, label) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgFrag && !e.message.includes(msgFrag)) {
      failed++; process.stderr.write(`  FAIL ${label}: expected '${msgFrag}' in '${e.message}'\n`);
      return;
    }
  }
  if (!threw) { failed++; process.stderr.write(`  FAIL ${label}: expected throw\n`); }
  else passed++;
}

async function assertRejects(fn, msgFrag, label) {
  try {
    await fn();
    failed++; process.stderr.write(`  FAIL ${label}: expected rejection\n`);
  } catch (e) {
    if (msgFrag && !e.message.includes(msgFrag)) {
      failed++; process.stderr.write(`  FAIL ${label}: expected '${msgFrag}' in '${e.message}'\n`);
    } else { passed++; }
  }
}

// ── Mock server helpers ────────────────────────────────────────────────────

function startMockVault(handler) {
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

function jsonResp(res, statusCode, body) {
  const s = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

// ═══════════════════════════════════════════════════════════════════════════
// A — Pure helper tests (47)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[A] Pure helper tests");

// -- kvPath --
assert(kvPath("secret", "mykey", 1, "data") === "/v1/secret/mykey",                 "A01 kvPath v1 basic");
assert(kvPath("secret", "mykey", 2, "data") === "/v1/secret/data/mykey",             "A02 kvPath v2 data mode");
assert(kvPath("secret", "mykey", 2, "metadata") === "/v1/secret/metadata/mykey",     "A03 kvPath v2 metadata mode");
assert(kvPath("secret", "mykey", 2, "delete") === "/v1/secret/delete/mykey",         "A04 kvPath v2 delete mode");
assert(kvPath("secret", "mykey", 2, "destroy") === "/v1/secret/destroy/mykey",       "A05 kvPath v2 destroy mode");
assert(kvPath("secret/", "mykey", 1, "data") === "/v1/secret/mykey",                 "A06 kvPath trims trailing slash from mount");
assert(kvPath("secret", "/mykey", 1, "data") === "/v1/secret/mykey",                 "A07 kvPath trims leading slash from path");
assert(kvPath(undefined, "mykey", 1, "data") === "/v1/secret/mykey",                 "A08 kvPath defaults mount to secret");
assert(kvPath("kv", "app/db/password", 2, "data") === "/v1/kv/data/app/db/password", "A09 kvPath nested path v2");
assert(kvPath("kv", "app/db/password", 1, "data") === "/v1/kv/app/db/password",      "A10 kvPath nested path v1");
assert(kvPath("secret", "key", 2, undefined) === "/v1/secret/data/key",              "A11 kvPath unknown mode defaults to data in v2");
assert(kvPath("secret", "", 2, "metadata") === "/v1/secret/metadata/",               "A12 kvPath v2 empty path");

// -- requireString --
assertThrows(() => requireString("", "field"),         "non-empty",  "A13 requireString empty string");
assertThrows(() => requireString(42, "field"),         "non-empty",  "A14 requireString non-string");
assertThrows(() => requireString("abc\0def", "field"), "NUL",        "A15 requireString NUL byte");
assertThrows(() => requireString(undefined, "field"),  "non-empty",  "A16 requireString undefined");
assertThrows(() => requireString(null, "field"),       "non-empty",  "A17 requireString null");
assert((requireString("hello", "field"), true),                       "A18 requireString valid");

// -- guardString --
assertThrows(() => guardString(42, "field"),           "must be a string", "A19 guardString non-string");
assertThrows(() => guardString("hello\0", "field"),    "NUL",              "A20 guardString NUL byte");
assert((guardString("hello", "field"), true),                           "A21 guardString valid string");
assert((guardString(undefined, "field"), true),                         "A22 guardString undefined OK");
assert((guardString(null, "field"), true),                              "A23 guardString null OK");

// -- clampInt --
assert(clampInt(undefined, 10000, 1000, 120000, "timeout") === 10000, "A24 clampInt returns default for undefined");
assert(clampInt(null,      5000,  1000, 120000, "timeout") === 5000,  "A25 clampInt returns default for null");
assert(clampInt(3.7,       0,     1,    10,     "n")       === 4,     "A26 clampInt rounds float to int");
assert(clampInt(1000,      5000,  1000, 120000, "timeout") === 1000,  "A27 clampInt accepts boundary min");
assert(clampInt(120000,    5000,  1000, 120000, "timeout") === 120000,"A28 clampInt accepts boundary max");
assertThrows(() => clampInt(0,      1000, 1000, 120000, "timeout"), "between",          "A29 clampInt below min");
assertThrows(() => clampInt(200000, 1000, 1000, 120000, "timeout"), "between",          "A30 clampInt above max");
assertThrows(() => clampInt(NaN,    1000, 1000, 120000, "timeout"), "must be a number", "A31 clampInt NaN");

// -- buildConn --
const conn = buildConn({ host: "localhost" });
assert(conn.host             === "localhost", "A32 buildConn default host");
assert(conn.port             === 8200,        "A33 buildConn default port");
assert(conn.timeoutMs        === 10000,       "A34 buildConn default timeout");
assert(conn.useTls           === false,       "A35 buildConn default no TLS");
assert(conn.rejectUnauthorized === true,      "A36 buildConn default rejectUnauthorized");
assert(conn.token            === null,        "A37 buildConn default token null");
assert(conn.namespace        === null,        "A38 buildConn default namespace null");

const conn2 = buildConn({ host: "vault.local", port: 8201, use_tls: true, reject_unauthorized: false,
  token: "hvs.abc", namespace: "admin", timeout: 30000 });
assert(conn2.port             === 8201,       "A39 buildConn custom port");
assert(conn2.useTls           === true,       "A40 buildConn TLS enabled");
assert(conn2.rejectUnauthorized === false,    "A41 buildConn reject_unauthorized false");
assert(conn2.token            === "hvs.abc",  "A42 buildConn stores token");
assert(conn2.namespace        === "admin",    "A43 buildConn stores namespace");
assert(conn2.timeoutMs        === 30000,      "A44 buildConn custom timeout");

const connTrimmed = buildConn({ host: "  vault.local  " });
assert(connTrimmed.host === "vault.local",    "A45 buildConn trims host whitespace");

assertThrows(() => buildConn({ port: 8200 }),                             "non-empty",  "A46 buildConn throws for missing host");
assertThrows(() => buildConn({ host: "vault\0.local" }),                  "NUL",        "A47 buildConn throws for NUL host");

// ═══════════════════════════════════════════════════════════════════════════
// B + C + D + E — async tests
// ═══════════════════════════════════════════════════════════════════════════

(async () => {

// ── B — Validation tests (15) ─────────────────────────────────────────────
console.log("[B] Validation tests");

// info works with host=localhost (pure, no I/O)
{
  const r = await vaultClient({ operation: "info", host: "localhost" });
  assert(r.ok === true,                          "B00a info ok");
  assert(Array.isArray(r.operations),            "B00b info operations array");
  assert(r.operations.length >= 25,              "B00c info ops count");
  assert(r.defaultPort === 8200,                 "B00d info defaultPort");
  assert(typeof r.auth === "object",             "B00e info auth object");
  assert(typeof r.kvVersions === "object",       "B00f info kvVersions");
}

await assertRejects(() => vaultClient({ operation: "kv_get", host: "localhost", token: "t" }),
  "path", "B01 kv_get requires path");
await assertRejects(() => vaultClient({ operation: "kv_put", host: "localhost", token: "t", path: "p", data: "string" }),
  "data", "B02 kv_put data must be object");
await assertRejects(() => vaultClient({ operation: "kv_put", host: "localhost", token: "t", path: "p" }),
  "data", "B03 kv_put requires data");
await assertRejects(() => vaultClient({ operation: "kv_delete", host: "localhost", token: "t" }),
  "path", "B04 kv_delete requires path");
await assertRejects(() => vaultClient({ operation: "kv_destroy", host: "localhost", token: "t", versions: [1] }),
  "path", "B05 kv_destroy requires path");
await assertRejects(() => vaultClient({ operation: "kv_destroy", host: "localhost", token: "t", path: "p" }),
  "versions", "B06 kv_destroy requires versions");
await assertRejects(() => vaultClient({ operation: "kv_destroy", host: "localhost", token: "t", path: "p", versions: [] }),
  "versions", "B07 kv_destroy requires non-empty versions");
await assertRejects(() => vaultClient({ operation: "pki_issue", host: "localhost", token: "t", common_name: "x.com" }),
  "role", "B08 pki_issue requires role");
await assertRejects(() => vaultClient({ operation: "pki_issue", host: "localhost", token: "t", role: "myrole" }),
  "common_name", "B09 pki_issue requires common_name");
await assertRejects(() => vaultClient({ operation: "pki_sign", host: "localhost", token: "t", role: "myrole" }),
  "csr", "B10 pki_sign requires csr");
await assertRejects(() => vaultClient({ operation: "transit_encrypt", host: "localhost", token: "t", plaintext: "hi" }),
  "key", "B11 transit_encrypt requires key");
await assertRejects(() => vaultClient({ operation: "transit_decrypt", host: "localhost", token: "t", key: "mykey" }),
  "ciphertext", "B12 transit_decrypt requires ciphertext");
await assertRejects(() => vaultClient({ operation: "transit_sign", host: "localhost", token: "t", key: "mykey" }),
  "input", "B13 transit_sign requires input");
await assertRejects(() => vaultClient({ operation: "transit_verify", host: "localhost", token: "t", key: "mykey", input: "d" }),
  "signature", "B14 transit_verify requires signature");
await assertRejects(() => vaultClient({ operation: "sys_capabilities", host: "localhost", token: "t" }),
  "paths", "B15 sys_capabilities requires paths");

// ── C — Mock network tests (21) ───────────────────────────────────────────
console.log("[C] Mock network tests");

// C01: kv_get v1 returns secret
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: { username: "admin", password: "s3cr3t" }, lease_id: "", renewable: false, lease_duration: 0 });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_get", host: "127.0.0.1", port, token: "t", path: "myapp/db", kv_version: 1 });
  assert(r.ok === true,                    "C01a kv_get v1 ok");
  assert(r.found === true,                 "C01b kv_get v1 found");
  assert(r.kv_version === 1,               "C01c kv_get v1 version");
  assert(r.data.username === "admin",      "C01d kv_get v1 data");
  await stopServer(server);
}

// C02: kv_get v2 returns versioned secret
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: {
      data: { apikey: "abc123" },
      metadata: { version: 3, created_time: "2024-01-01T00:00:00Z", deletion_time: "", destroyed: false }
    }});
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_get", host: "127.0.0.1", port, token: "t", path: "myapp/api", kv_version: 2 });
  assert(r.ok === true,                    "C02a kv_get v2 ok");
  assert(r.found === true,                 "C02b kv_get v2 found");
  assert(r.kv_version === 2,               "C02c kv_get v2 version");
  assert(r.data.apikey === "abc123",       "C02d kv_get v2 data");
  assert(r.version === 3,                  "C02e kv_get v2 meta version");
  await stopServer(server);
}

// C03: kv_get 404 returns found:false
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 404, { errors: [] });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_get", host: "127.0.0.1", port, token: "t", path: "missing" });
  assert(r.ok === true,                    "C03a 404 ok");
  assert(r.found === false,                "C03b 404 not found");
  await stopServer(server);
}

// C04: kv_put v1
{
  let method, pathname;
  const server = await startMockVault((req, res, body) => {
    method = req.method; pathname = req.url;
    jsonResp(res, 204, {});
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_put", host: "127.0.0.1", port, token: "t",
    path: "myapp/db", data: { password: "new" }, kv_version: 1 });
  assert(r.ok === true,                    "C04a kv_put v1 ok");
  assert(method === "POST",                "C04b kv_put v1 method");
  assert(pathname === "/v1/secret/myapp/db", "C04c kv_put v1 path");
  await stopServer(server);
}

// C05: kv_put v2 uses /data/ path
{
  let pathname;
  const server = await startMockVault((req, res) => {
    pathname = req.url;
    jsonResp(res, 200, { data: { version: 4, created_time: "2024-01-01T00:00:00Z" } });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_put", host: "127.0.0.1", port, token: "t",
    path: "myapp/db", data: { password: "new" }, kv_version: 2 });
  assert(r.ok === true,                    "C05a kv_put v2 ok");
  assert(r.version === 4,                  "C05b kv_put v2 version");
  assert(pathname.includes("/data/"),      "C05c kv_put v2 /data/ path");
  await stopServer(server);
}

// C06: kv_delete v1 uses DELETE
{
  let method;
  const server = await startMockVault((req, res) => {
    method = req.method; res.writeHead(204); res.end();
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_delete", host: "127.0.0.1", port, token: "t",
    path: "myapp/db", kv_version: 1 });
  assert(r.ok === true,                    "C06a kv_delete v1 ok");
  assert(r.deleted === true,               "C06b kv_delete deleted");
  assert(method === "DELETE",              "C06c kv_delete method");
  await stopServer(server);
}

// C07: kv_list returns keys
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: { keys: ["foo", "bar/", "baz"] } });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_list", host: "127.0.0.1", port, token: "t", path: "", kv_version: 2 });
  assert(r.ok === true,                    "C07a kv_list ok");
  assert(r.count === 3,                    "C07b kv_list count");
  assert(r.keys.includes("foo"),           "C07c kv_list keys");
  await stopServer(server);
}

// C08: kv_metadata returns version info
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: {
      current_version: 3, max_versions: 10, oldest_version: 1,
      created_time: "2024-01-01T00:00:00Z", updated_time: "2024-06-01T00:00:00Z",
      cas_required: false, delete_version_after: "0s", custom_metadata: {}, versions: {}
    }});
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_metadata", host: "127.0.0.1", port, token: "t", path: "myapp/db" });
  assert(r.ok === true,                    "C08a kv_metadata ok");
  assert(r.found === true,                 "C08b kv_metadata found");
  assert(r.current_version === 3,          "C08c kv_metadata version");
  await stopServer(server);
}

// C09: sys_health without auth
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { initialized: true, sealed: false, standby: false, version: "1.15.0", cluster_name: "vault-cluster" });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "sys_health", host: "127.0.0.1", port });
  assert(r.ok === true,                    "C09a sys_health ok");
  assert(r.initialized === true,           "C09b sys_health initialized");
  assert(r.sealed === false,               "C09c sys_health not sealed");
  assert(r.version === "1.15.0",           "C09d sys_health version");
  await stopServer(server);
}

// C10: sys_health sealed (503) handled gracefully
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 503, { initialized: true, sealed: true, standby: false });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "sys_health", host: "127.0.0.1", port });
  assert(r.ok === true,                    "C10a sys_health sealed ok");
  assert(r.http_status === 503,            "C10b sys_health 503 status");
  assert(r.sealed === true,                "C10c sys_health sealed true");
  await stopServer(server);
}

// C11: sys_seal_status
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { type: "shamir", initialized: true, sealed: false, t: 3, n: 5, progress: 0, version: "1.15.0" });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "sys_seal_status", host: "127.0.0.1", port, token: "t" });
  assert(r.ok === true,                    "C11a sys_seal_status ok");
  assert(r.type === "shamir",              "C11b type");
  assert(r.n === 5,                        "C11c n");
  await stopServer(server);
}

// C12: sys_mounts
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, {
      "secret/": { type: "kv", description: "KV", accessor: "abc", local: false, seal_wrap: false, options: {} },
      "transit/": { type: "transit", description: "", accessor: "def", local: false, seal_wrap: false, options: {} }
    });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "sys_mounts", host: "127.0.0.1", port, token: "t" });
  assert(r.ok === true,                           "C12a sys_mounts ok");
  assert(r.count >= 2,                            "C12b sys_mounts count");
  assert(r.mounts.some(m => m.type === "kv"),     "C12c has kv");
  assert(r.mounts.some(m => m.type === "transit"),"C12d has transit");
  await stopServer(server);
}

// C13: sys_policies
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: { keys: ["default", "root", "my-app"] } });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "sys_policies", host: "127.0.0.1", port, token: "t" });
  assert(r.ok === true,                    "C13a sys_policies ok");
  assert(r.count === 3,                    "C13b sys_policies count");
  assert(r.policies.includes("root"),      "C13c sys_policies root");
  await stopServer(server);
}

// C14: auth_userpass
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { auth: {
      client_token: "hvs.AAAA", accessor: "acc1", policies: ["default"],
      token_type: "service", lease_duration: 3600, renewable: true, entity_id: "eid1"
    }});
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "auth_userpass", host: "127.0.0.1", port,
    username: "alice", password: "secret" });
  assert(r.ok === true,                    "C14a auth_userpass ok");
  assert(r.authenticated === true,         "C14b authenticated");
  assert(r.client_token === "hvs.AAAA",    "C14c client_token");
  assert(r.policies.includes("default"),   "C14d policies");
  await stopServer(server);
}

// C15: auth_approle
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { auth: {
      client_token: "hvs.BBBB", policies: ["default", "myapp"],
      lease_duration: 1800, renewable: true, accessor: "acc2", entity_id: "eid2"
    }});
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "auth_approle", host: "127.0.0.1", port,
    role_id: "role-uuid", secret_id: "secret-uuid" });
  assert(r.ok === true,                    "C15a auth_approle ok");
  assert(r.client_token === "hvs.BBBB",    "C15b client_token");
  await stopServer(server);
}

// C16: token_lookup
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: {
      accessor: "acc1", display_name: "token", policies: ["default"], meta: {},
      ttl: 3600, explicit_max_ttl: 0, num_uses: 0, renewable: true, orphan: false, type: "service"
    }});
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "token_lookup", host: "127.0.0.1", port, token: "hvs.ABC" });
  assert(r.ok === true,                    "C16a token_lookup ok");
  assert(r.ttl === 3600,                   "C16b ttl");
  assert(r.renewable === true,             "C16c renewable");
  await stopServer(server);
}

// C17: transit_encrypt
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: { ciphertext: "vault:v1:abc123def", key_version: 1 } });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "transit_encrypt", host: "127.0.0.1", port,
    token: "t", key: "mykey", plaintext: "hello world" });
  assert(r.ok === true,                         "C17a transit_encrypt ok");
  assert(r.ciphertext === "vault:v1:abc123def",  "C17b ciphertext");
  assert(r.key === "mykey",                      "C17c key");
  await stopServer(server);
}

// C18: transit_decrypt
{
  const b64 = Buffer.from("hello world", "utf8").toString("base64");
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: { plaintext: b64 } });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "transit_decrypt", host: "127.0.0.1", port,
    token: "t", key: "mykey", ciphertext: "vault:v1:abc123def" });
  assert(r.ok === true,                    "C18a transit_decrypt ok");
  assert(r.plaintext === "hello world",    "C18b plaintext decoded");
  await stopServer(server);
}

// C19: error response extracts Vault errors array
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 403, { errors: ["permission denied", "no token"] });
  });
  const port = server.address().port;
  await assertRejects(
    () => vaultClient({ operation: "kv_get", host: "127.0.0.1", port, token: "bad", path: "secret/foo" }),
    "permission denied", "C19 error extracts Vault errors"
  );
  await stopServer(server);
}

// C20: kv_destroy posts to /destroy/ path
{
  let pathname;
  const server = await startMockVault((req, res) => {
    pathname = req.url; res.writeHead(204); res.end();
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_destroy", host: "127.0.0.1", port,
    token: "t", path: "myapp/db", versions: [1, 2, 3] });
  assert(r.ok === true,                    "C20a kv_destroy ok");
  assert(r.destroyed === true,             "C20b destroyed");
  assert(pathname.includes("/destroy/"),   "C20c destroy path");
  await stopServer(server);
}

// C21: sys_capabilities returns capability map
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { "secret/myapp": ["read", "list"] });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "sys_capabilities", host: "127.0.0.1", port,
    token: "t", paths: ["secret/myapp"] });
  assert(r.ok === true,                                        "C21a sys_capabilities ok");
  assert(Array.isArray(r.capabilities["secret/myapp"]),       "C21b capabilities map");
  await stopServer(server);
}

// ── D — Security tests (10) ───────────────────────────────────────────────
console.log("[D] Security tests");

await assertRejects(() => vaultClient({ operation: "kv_get", host: "vault\0.local", token: "t", path: "x" }),
  "NUL", "D01 NUL byte in host");
await assertRejects(() => vaultClient({ operation: "kv_get", host: "localhost", token: "hvs\0.bad", path: "x" }),
  "NUL", "D02 NUL byte in token");
await assertRejects(() => vaultClient({ operation: "kv_get", host: "localhost", token: "t", path: "my\0key" }),
  "NUL", "D03 NUL byte in path");
await assertRejects(() => vaultClient({ operation: "kv_get", host: "localhost", token: "t",
  namespace: "admin\0", path: "x" }),
  "NUL", "D04 NUL byte in namespace");
await assertRejects(() => vaultClient({ operation: "auth_userpass", host: "localhost",
  username: "ali\0ce", password: "pass" }),
  "NUL", "D05 NUL in username");
await assertRejects(() => vaultClient({ operation: "auth_userpass", host: "localhost",
  username: "alice", password: "pa\0ss" }),
  "NUL", "D06 NUL in password");
await assertRejects(() => vaultClient({ operation: "kv_get", host: "localhost", port: 0, token: "t", path: "x" }),
  "between", "D07 port out of range");
await assertRejects(() => vaultClient({ operation: "kv_get", host: "localhost", timeout: 100, token: "t", path: "x" }),
  "between", "D08 timeout out of range");

// D09: token not echoed in output
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { data: { secret: "value" }, lease_id: "", renewable: false, lease_duration: 0 });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_get", host: "127.0.0.1", port,
    token: "hvs.MY_SECRET_TOKEN", path: "app/key", kv_version: 1 });
  const s = JSON.stringify(r);
  assert(!s.includes("MY_SECRET_TOKEN"), "D09 token not in output");
  await stopServer(server);
}

await assertRejects(() => vaultClient({ operation: "nonexistent_op", host: "localhost" }),
  "Unknown vault_client operation", "D10 unknown operation error");

// ── E — Concurrency / stress tests (7) ───────────────────────────────────
console.log("[E] Concurrency tests");

// E01: concurrent kv_get v1
{
  let reqCount = 0;
  const server = await startMockVault((req, res) => {
    reqCount++;
    jsonResp(res, 200, { data: { val: reqCount }, lease_id: "", renewable: false, lease_duration: 0 });
  });
  const port = server.address().port;
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      vaultClient({ operation: "kv_get", host: "127.0.0.1", port, token: "t", path: `key${i}`, kv_version: 1 })
    )
  );
  assert(results.length === 5,               "E01a concurrent kv_get length");
  assert(results.every(r => r.ok),           "E01b concurrent kv_get all ok");
  assert(reqCount === 5,                     "E01c concurrent reqCount");
  await stopServer(server);
}

// E02: concurrent sys_health
{
  const server = await startMockVault((req, res) => {
    jsonResp(res, 200, { initialized: true, sealed: false, version: "1.15.0" });
  });
  const port = server.address().port;
  const results = await Promise.all(
    Array.from({ length: 8 }, () => vaultClient({ operation: "sys_health", host: "127.0.0.1", port }))
  );
  assert(results.every(r => r.ok && !r.sealed), "E02 concurrent sys_health");
  await stopServer(server);
}

// E03: timeout fires on stalled server
{
  const server = await startMockVault((req, res) => { /* never respond */ });
  const port = server.address().port;
  const start = Date.now();
  await assertRejects(
    () => vaultClient({ operation: "kv_get", host: "127.0.0.1", port, token: "t", path: "x", timeout: 1000 }),
    "timed out", "E03 timeout fires"
  );
  const elapsed = Date.now() - start;
  assert(elapsed < 4000, `E03b timeout elapsed ${elapsed}ms < 4000ms`);
  await stopServer(server);
}

// E04: connection refused produces descriptive error
{
  const closedPort = await new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  await assertRejects(
    () => vaultClient({ operation: "kv_get", host: "127.0.0.1", port: closedPort, token: "t", path: "x" }),
    "Cannot connect", "E04 connection refused"
  );
}

// E05: multiple operations in parallel same host
{
  const server = await startMockVault((req, res) => {
    const url = req.url;
    if (url.includes("/sys/health")) {
      jsonResp(res, 200, { initialized: true, sealed: false });
    } else if (url.includes("/sys/seal-status")) {
      jsonResp(res, 200, { type: "shamir", initialized: true, sealed: false, t: 1, n: 1 });
    } else {
      jsonResp(res, 200, { data: { keys: [] } });
    }
  });
  const port = server.address().port;
  const [h, s, l] = await Promise.all([
    vaultClient({ operation: "sys_health", host: "127.0.0.1", port }),
    vaultClient({ operation: "sys_seal_status", host: "127.0.0.1", port, token: "t" }),
    vaultClient({ operation: "kv_list", host: "127.0.0.1", port, token: "t", path: "" }),
  ]);
  assert(h.ok && s.ok && l.ok, "E05 multiple ops parallel");
  await stopServer(server);
}

// E06: large response (100 keys)
{
  const server = await startMockVault((req, res) => {
    const keys = Array.from({ length: 100 }, (_, i) => `key-${i}`);
    jsonResp(res, 200, { data: { keys } });
  });
  const port = server.address().port;
  const r = await vaultClient({ operation: "kv_list", host: "127.0.0.1", port, token: "t", path: "" });
  assert(r.ok === true,         "E06a large response ok");
  assert(r.count === 100,       "E06b large response count");
  await stopServer(server);
}

// E07: 20 concurrent info ops (no network)
{
  const results = await Promise.all(
    Array.from({ length: 20 }, () => vaultClient({ operation: "info", host: "localhost" }))
  );
  assert(results.length === 20,           "E07a info concurrency length");
  assert(results.every(r => r.ok),        "E07b info concurrency all ok");
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n[268-vault-client] ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})().catch(e => { console.error(e); process.exit(1); });
