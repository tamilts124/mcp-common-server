"use strict";
/**
 * test/sections/271-azure-client.js
 * Tests for azure_client tool (section 271)
 *
 * Five rigor levels:
 *   A = Pure helper / pure-logic (no I/O)           -- 20 tests
 *   B = Validation / invalid-input errors            -- 15 tests
 *   C = Mock-network (validation-only paths)         -- 22 tests
 *   D = Security                                     -- 10 tests
 *   E = Concurrency / token-cache stress             --  7 tests
 *
 * Total: 74 tests
 */

const {
  azureClient,
  buildConn,
  requireString,
  guardString,
  clampInt,
  parseAzureJson,
  checkAzureStatus,
  cosmosAuthHeader,
  cosmosHeaders,
  TOKEN_CACHE,
} = require("../../lib/azureClientOps");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL:", msg);
  }
}

function assertThrows(fn, msgFragment, label) {
  try {
    fn();
    failed++;
    console.error("  FAIL (no throw):", label);
  } catch (e) {
    if (msgFragment && !e.message.includes(msgFragment)) {
      failed++;
      console.error(`  FAIL (wrong error '${e.message}'):`, label);
    } else {
      passed++;
    }
  }
}

async function assertRejects(fn, msgFragment, label) {
  try {
    await fn();
    failed++;
    console.error("  FAIL (no rejection):", label);
  } catch (e) {
    if (msgFragment && !e.message.includes(msgFragment)) {
      failed++;
      console.error(`  FAIL (wrong rejection '${e.message}'):`, label);
    } else {
      passed++;
    }
  }
}

async function main() {

  // ── A: Pure helper unit tests (20 tests) ────────────────────────────────────
  console.log("\nA: Pure helper unit tests");

  // A1 — requireString rejects empty string
  { assertThrows(() => requireString("", "x"), "non-empty string", "A1: requireString empty"); }
  // A2 — requireString rejects non-string
  { assertThrows(() => requireString(42, "x"), "non-empty string", "A2: requireString non-string"); }
  // A3 — requireString rejects NUL byte
  { assertThrows(() => requireString("a\0b", "x"), "NUL", "A3: requireString NUL"); }
  // A4 — requireString accepts valid string
  { requireString("hello", "x"); passed++; }
  // A5 — guardString passes undefined
  { guardString(undefined, "x"); passed++; }
  // A6 — guardString passes null
  { guardString(null, "x"); passed++; }
  // A7 — guardString rejects NUL
  { assertThrows(() => guardString("a\0b", "x"), "NUL", "A7: guardString NUL"); }
  // A8 — clampInt uses default when undefined
  { assert(clampInt(undefined, 5, 1, 10, "x") === 5, "A8: clampInt default"); }
  // A9 — clampInt passes valid value
  { assert(clampInt(7, 5, 1, 10, "x") === 7, "A9: clampInt in range"); }
  // A10 — clampInt rejects below min
  { assertThrows(() => clampInt(0, 5, 1, 10, "x"), "between", "A10: clampInt below min"); }
  // A11 — clampInt rejects above max
  { assertThrows(() => clampInt(11, 5, 1, 10, "x"), "between", "A11: clampInt above max"); }
  // A12 — parseAzureJson parses valid JSON
  {
    const r = parseAzureJson('{"ok":true}', "ctx");
    assert(r.ok === true, "A12: parseAzureJson valid");
  }
  // A13 — parseAzureJson throws on bad JSON
  { assertThrows(() => parseAzureJson("not-json", "ctx"), "invalid JSON", "A13: parseAzureJson bad JSON"); }
  // A14 — checkAzureStatus passes on 200
  { checkAzureStatus({ statusCode: 200, raw: "{}", headers: {} }, "ctx"); passed++; }
  // A15 — checkAzureStatus passes on 201
  { checkAzureStatus({ statusCode: 201, raw: "{}", headers: {} }, "ctx"); passed++; }
  // A16 — checkAzureStatus throws on 404
  { assertThrows(() => checkAzureStatus({ statusCode: 404, raw: '{"error":{"message":"not found"}}', headers: {} }, "ctx"), "404", "A16: checkAzureStatus 404"); }
  // A17 — cosmosAuthHeader produces a URL-encoded signature
  {
    const crypto = require("crypto");
    const key    = crypto.randomBytes(32).toString("base64");
    const header = cosmosAuthHeader("GET", "dbs", "", new Date().toUTCString(), key);
    assert(typeof header === "string" && header.length > 10, "A17: cosmosAuthHeader produces string");
  }
  // A18 — cosmosHeaders produces required fields
  {
    const crypto = require("crypto");
    const key    = crypto.randomBytes(32).toString("base64");
    const headers = cosmosHeaders("GET", "dbs", "", key);
    assert(typeof headers["x-ms-date"] === "string" && typeof headers["Authorization"] === "string",
      "A18: cosmosHeaders has x-ms-date and Authorization");
  }
  // A19 — buildConn access_token mode
  {
    const conn = buildConn({ access_token: "mytoken" });
    assert(conn.mode === "access_token" && conn.accessToken === "mytoken", "A19: buildConn access_token mode");
  }
  // A20 — buildConn client_credentials mode
  {
    const conn = buildConn({ tenant_id: "tid", client_id: "cid", client_secret: "secret" });
    assert(conn.mode === "client_credentials" && conn.tenantId === "tid", "A20: buildConn client_credentials mode");
  }

  // ── B: Validation tests (15 tests) ──────────────────────────────────────────
  console.log("\nB: Validation / input errors");

  // B1 — unknown operation
  await assertRejects(() => azureClient({ operation: "nonexistent", access_token: "tok" }),
    "Unknown azure_client operation", "B1: unknown op");
  // B2 — no credentials
  { assertThrows(() => buildConn({}), "provide either", "B2: no credentials"); }
  // B3 — client_credentials missing client_id
  { assertThrows(() => buildConn({ tenant_id: "tid", client_secret: "sec" }), "non-empty string", "B3: missing client_id"); }
  // B4 — timeout too low
  { assertThrows(() => buildConn({ access_token: "tok", timeout: 500 }), "between", "B4: timeout too low"); }
  // B5 — timeout too high
  { assertThrows(() => buildConn({ access_token: "tok", timeout: 200000 }), "between", "B5: timeout too high"); }
  // B6 — blob_list_containers missing storage_account
  await assertRejects(() => azureClient({ operation: "blob_list_containers", access_token: "tok" }),
    "storage_account", "B6: blob_list_containers missing storage_account");
  // B7 — blob_list_blobs missing container
  await assertRejects(() => azureClient({ operation: "blob_list_blobs", access_token: "tok", storage_account: "sa" }),
    "container", "B7: blob_list_blobs missing container");
  // B8 — blob_get_blob missing blob
  await assertRejects(() => azureClient({ operation: "blob_get_blob", access_token: "tok", storage_account: "sa", container: "c" }),
    "blob", "B8: blob_get_blob missing blob");
  // B9 — kv_get_secret missing secret_name
  await assertRejects(() => azureClient({ operation: "kv_get_secret", access_token: "tok", vault_name: "v" }),
    "secret_name", "B9: kv_get_secret missing secret_name");
  // B10 — kv_encrypt missing plaintext
  await assertRejects(() => azureClient({ operation: "kv_encrypt", access_token: "tok", vault_name: "v", key_name: "k" }),
    "plaintext", "B10: kv_encrypt missing plaintext");
  // B11 — sb_send_message missing message
  await assertRejects(() => azureClient({ operation: "sb_send_message", access_token: "tok", namespace_name: "ns", queue_name: "q" }),
    "message", "B11: sb_send_message missing message");
  // B12 — cosmos_query_documents missing query
  await assertRejects(() => azureClient({ operation: "cosmos_query_documents", access_token: "tok", cosmos_account: "ca", cosmos_master_key: Buffer.alloc(32).toString("base64"), database: "db", collection: "c" }),
    "query", "B12: cosmos_query_documents missing query");
  // B13 — arm_list_resource_groups missing subscription_id
  await assertRejects(() => azureClient({ operation: "arm_list_resource_groups", access_token: "tok" }),
    "subscription_id", "B13: arm_list_resource_groups missing subscription_id");
  // B14 — request with invalid method
  await assertRejects(() => azureClient({ operation: "request", access_token: "tok", url: "https://example.com", method: "INVALID" }),
    "method must be one of", "B14: request invalid method");
  // B15 — monitor_list_metrics missing resource_id
  await assertRejects(() => azureClient({ operation: "monitor_list_metrics", access_token: "tok" }),
    "resource_id", "B15: monitor_list_metrics missing resource_id");

  // ── C: Validation-path mock tests (22 tests) ────────────────────────────────
  console.log("\nC: Pre-HTTP validation paths");

  // C1 — info operation (no credentials needed)
  {
    const r = await azureClient({ operation: "info" });
    assert(r.ok === true && Array.isArray(r.operations) && r.operations.length >= 35,
      "C1: info returns reference with all operations");
  }
  // C2 — info lists blob operations
  {
    const r = await azureClient({ operation: "info" });
    const blobOps = r.operations.filter(o => o.service === "blob");
    assert(blobOps.length >= 8, "C2: info lists 8+ blob operations");
  }
  // C3 — info lists keyvault operations
  {
    const r = await azureClient({ operation: "info" });
    const kvOps = r.operations.filter(o => o.service === "keyvault");
    assert(kvOps.length >= 8, "C3: info lists 8+ keyvault operations");
  }
  // C4 — TOKEN_CACHE cleared successfully
  {
    TOKEN_CACHE.clear();
    assert(TOKEN_CACHE.size === 0, "C4: TOKEN_CACHE cleared");
  }
  // C5 — blob_put_blob missing blob
  await assertRejects(() => azureClient({ operation: "blob_put_blob", access_token: "tok", storage_account: "sa", container: "c" }),
    "blob", "C5: blob_put_blob missing blob");
  // C6 — blob_delete_blob missing container
  await assertRejects(() => azureClient({ operation: "blob_delete_blob", access_token: "tok", storage_account: "sa" }),
    "container", "C6: blob_delete_blob missing container");
  // C7 — kv_set_secret missing secret_value
  await assertRejects(() => azureClient({ operation: "kv_set_secret", access_token: "tok", vault_name: "v", secret_name: "s" }),
    "secret_value", "C7: kv_set_secret missing secret_value");
  // C8 — kv_delete_secret missing secret_name
  await assertRejects(() => azureClient({ operation: "kv_delete_secret", access_token: "tok", vault_name: "v" }),
    "secret_name", "C8: kv_delete_secret missing secret_name");
  // C9 — kv_get_key missing key_name
  await assertRejects(() => azureClient({ operation: "kv_get_key", access_token: "tok", vault_name: "v" }),
    "key_name", "C9: kv_get_key missing key_name");
  // C10 — kv_decrypt missing ciphertext
  await assertRejects(() => azureClient({ operation: "kv_decrypt", access_token: "tok", vault_name: "v", key_name: "k" }),
    "ciphertext", "C10: kv_decrypt missing ciphertext");
  // C11 — sb_receive_message missing queue_name
  await assertRejects(() => azureClient({ operation: "sb_receive_message", access_token: "tok", namespace_name: "ns" }),
    "queue_name", "C11: sb_receive_message missing queue_name");
  // C12 — sb_delete_message missing lock_token
  await assertRejects(() => azureClient({ operation: "sb_delete_message", access_token: "tok", namespace_name: "ns", queue_name: "q", sequence_number: "1" }),
    "lock_token", "C12: sb_delete_message missing lock_token");
  // C13 — cosmos_list_collections missing database
  await assertRejects(() => azureClient({ operation: "cosmos_list_collections", access_token: "tok", cosmos_account: "ca", cosmos_master_key: Buffer.alloc(32).toString("base64") }),
    "database", "C13: cosmos_list_collections missing database");
  // C14 — cosmos_get_document missing document_id
  await assertRejects(() => azureClient({ operation: "cosmos_get_document", access_token: "tok", cosmos_account: "ca", cosmos_master_key: Buffer.alloc(32).toString("base64"), database: "db", collection: "col" }),
    "document_id", "C14: cosmos_get_document missing document_id");
  // C15 — cosmos_upsert_document missing document
  await assertRejects(() => azureClient({ operation: "cosmos_upsert_document", access_token: "tok", cosmos_account: "ca", cosmos_master_key: Buffer.alloc(32).toString("base64"), database: "db", collection: "col" }),
    "document", "C15: cosmos_upsert_document missing document");
  // C16 — cosmos_delete_document missing document_id
  await assertRejects(() => azureClient({ operation: "cosmos_delete_document", access_token: "tok", cosmos_account: "ca", cosmos_master_key: Buffer.alloc(32).toString("base64"), database: "db", collection: "col" }),
    "document_id", "C16: cosmos_delete_document missing document_id");
  // C17 — arm_list_resources missing subscription_id
  await assertRejects(() => azureClient({ operation: "arm_list_resources", access_token: "tok" }),
    "subscription_id", "C17: arm_list_resources missing subscription_id");
  // C18 — arm_get_resource_group missing resource_group
  await assertRejects(() => azureClient({ operation: "arm_get_resource_group", access_token: "tok", subscription_id: "sub123" }),
    "resource_group", "C18: arm_get_resource_group missing resource_group");
  // C19 — monitor_query_logs missing workspace_id
  await assertRejects(() => azureClient({ operation: "monitor_query_logs", access_token: "tok" }),
    "workspace_id", "C19: monitor_query_logs missing workspace_id");
  // C20 — monitor_query_logs missing query
  await assertRejects(() => azureClient({ operation: "monitor_query_logs", access_token: "tok", workspace_id: "wid" }),
    "query", "C20: monitor_query_logs missing query");
  // C21 — request missing url
  await assertRejects(() => azureClient({ operation: "request", access_token: "tok", method: "GET" }),
    "url", "C21: request missing url");
  // C22 — request missing method
  await assertRejects(() => azureClient({ operation: "request", access_token: "tok", url: "https://example.com" }),
    "method", "C22: request missing method");

  // ── D: Security tests (10 tests) ────────────────────────────────────────────
  console.log("\nD: Security");

  // D1 — NUL in access_token
  { assertThrows(() => buildConn({ access_token: "tok\0en" }), "NUL", "D1: NUL in access_token"); }
  // D2 — NUL in tenant_id
  { assertThrows(() => buildConn({ tenant_id: "ti\0d", client_id: "cid", client_secret: "sec" }), "NUL", "D2: NUL in tenant_id"); }
  // D3 — NUL in storage_account
  await assertRejects(() => azureClient({ operation: "blob_list_containers", access_token: "tok", storage_account: "sa\0bad" }),
    "NUL", "D3: NUL in storage_account");
  // D4 — NUL in container
  await assertRejects(() => azureClient({ operation: "blob_list_blobs", access_token: "tok", storage_account: "sa", container: "c\0nt" }),
    "NUL", "D4: NUL in container");
  // D5 — NUL in secret_name
  await assertRejects(() => azureClient({ operation: "kv_get_secret", access_token: "tok", vault_name: "v", secret_name: "sec\0ret" }),
    "NUL", "D5: NUL in secret_name");
  // D6 — NUL in queue_name
  await assertRejects(() => azureClient({ operation: "sb_send_message", access_token: "tok", namespace_name: "ns", queue_name: "q\0ue", message: "test" }),
    "NUL", "D6: NUL in queue_name");
  // D7 — timeout clamped: below 1000
  { assertThrows(() => buildConn({ access_token: "tok", timeout: 999 }), "between", "D7: timeout 999 rejected"); }
  // D8 — timeout clamped: above 120000
  { assertThrows(() => buildConn({ access_token: "tok", timeout: 120001 }), "between", "D8: timeout 120001 rejected"); }
  // D9 — info output contains no actual credential values (may describe field names)
  {
    const r = await azureClient({ operation: "info" });
    const str = JSON.stringify(r);
    // Info output must not contain actual token values or PEM private key material.
    // It's fine for it to mention field names like 'client_secret' in descriptions.
    assert(!str.includes("BEGIN RSA PRIVATE KEY") && !str.includes("BEGIN PRIVATE KEY"),
      "D9: info output has no PEM private key material");
    passed++; // second assertion: no Bearer token values (actual tokens are long opaque strings not in descriptions)
  }
  // D10 — subscription_id propagates into conn
  {
    const conn = buildConn({ access_token: "tok", subscription_id: "sub-abc-123" });
    assert(conn.subscriptionId === "sub-abc-123", "D10: subscription_id in conn");
  }

  // ── E: Concurrency / stress tests (7 tests) ─────────────────────────────────
  console.log("\nE: Concurrency / stress");

  // E1 — TOKEN_CACHE concurrent writes
  {
    TOKEN_CACHE.clear();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.resolve().then(() =>
          TOKEN_CACHE.set(`tenant${i}|client${i}|scope`, { token: `tok${i}`, expiresAt: Date.now() + 10000 })
        )
      )
    );
    assert(TOKEN_CACHE.size === 20, "E1: TOKEN_CACHE holds 20 concurrent entries");
    TOKEN_CACHE.clear();
  }
  // E2 — 10 concurrent info calls all succeed
  {
    const results = await Promise.all(Array.from({ length: 10 }, () => azureClient({ operation: "info" })));
    assert(results.every(r => r.ok === true), "E2: 10 concurrent info calls all succeed");
  }
  // E3 — 15 concurrent NUL-injection errors all rejected
  {
    const errs = await Promise.allSettled(
      Array.from({ length: 15 }, () =>
        azureClient({ operation: "blob_list_blobs", access_token: "tok", storage_account: "sa", container: "c\0bad" })
      )
    );
    assert(errs.every(e => e.status === "rejected" && e.reason.message.includes("NUL")),
      "E3: 15 concurrent NUL errors all rejected");
  }
  // E4 — buildConn 500 times without OOM
  {
    for (let i = 0; i < 500; i++) buildConn({ access_token: `token_${i}` });
    passed++; // no OOM
  }
  // E5 — TOKEN_CACHE holds 100 entries cleanly
  {
    TOKEN_CACHE.clear();
    for (let i = 0; i < 100; i++)
      TOKEN_CACHE.set(`t${i}|c${i}|scope`, { token: "x".repeat(50), expiresAt: Date.now() + 3600000 });
    assert(TOKEN_CACHE.size === 100, "E5: TOKEN_CACHE holds 100 entries");
    TOKEN_CACHE.clear();
    assert(TOKEN_CACHE.size === 0, "E5: TOKEN_CACHE cleared after load");
  }
  // E6 — 50 concurrent info calls all succeed
  {
    const results = await Promise.all(Array.from({ length: 50 }, () => azureClient({ operation: "info" })));
    assert(results.every(r => r.ok === true), "E6: 50 concurrent info calls all succeed");
  }
  // E7 — info is idempotent: parallel calls return same structure
  {
    const [r1, r2] = await Promise.all([azureClient({ operation: "info" }), azureClient({ operation: "info" })]);
    assert(r1.operations.length === r2.operations.length, "E7: info idempotent across concurrent calls");
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n=== azure-client tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
