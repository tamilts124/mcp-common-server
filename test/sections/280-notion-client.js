"use strict";
/**
 * Section 280 — notion_client tests
 * A: happy-path helpers (25)
 * B: input validation (23)
 * C: mock-network (17)
 * D: security (10)
 * E: concurrency (8)
 * Total: 83
 */

const assert = require("assert");
const https  = require("https");
const { notionClient } = require("../../lib/notionClientOps");

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0;
function test(name, fn) {
  total++;
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      r.then(() => { passed++; process.stderr.write(`  ✓ ${name}\n`); })
       .catch(err => { failed++; process.stderr.write(`  ✗ ${name}: ${err.message}\n`); });
    } else {
      passed++;
      process.stderr.write(`  ✓ ${name}\n`);
    }
  } catch (err) {
    failed++;
    process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
  }
}

// ── Mock helper ───────────────────────────────────────────────────────────────
function mockHttps(statusCode, body) {
  const orig = https.request;
  https.request = (opts, cb) => {
    const EventEmitter = require("events").EventEmitter;
    const res = Object.assign(Object.create(EventEmitter.prototype), {
      statusCode, headers: { "content-type": "application/json" },
    });
    const req = Object.assign(Object.create(EventEmitter.prototype), {
      write: () => {}, destroy: () => {},
      end: () => {
        cb(res);
        setTimeout(() => {
          res.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
          res.emit("end");
        }, 0);
      },
    });
    return req;
  };
  return () => { https.request = orig; };
}

// ── Section A: happy-path helpers (no network) ───────────────────────────────
process.stderr.write("\nA: happy-path helpers\n");

test("A01 info returns ok=true", async () => {
  const r = await notionClient({ operation: "info" });
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.operations));
});

test("A02 info includes base_url with notion.com", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.base_url.includes("notion.com"));
});

test("A03 info includes notion api version in YYYY-MM-DD format", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.version));
});

test("A04 version returns notionVersion", async () => {
  const r = await notionClient({ operation: "version" });
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.notionVersion));
});

test("A05 version.apiBaseUrl contains notion.com", async () => {
  const r = await notionClient({ operation: "version" });
  assert.ok(r.apiBaseUrl.includes("notion.com"));
});

test("A06 version.sdkVersion is null", async () => {
  const r = await notionClient({ operation: "version" });
  assert.strictEqual(r.sdkVersion, null);
});

test("A07 info auth field mentions Bearer", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(JSON.stringify(r.auth).toLowerCase().includes("bearer"));
});

test("A08 info operations mentions page_get", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("page_get"));
});

test("A09 info operations mentions database_query", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("database_query"));
});

test("A10 info operations mentions block_get", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("block_get"));
});

test("A11 info operations mentions comment_create", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("comment_create"));
});

test("A12 info operations mentions user_list", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("user_list"));
});

test("A13 info operations mentions search", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("search"));
});

test("A14 info operations mentions workspace_info", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("workspace_info"));
});

test("A15 info operations mentions page_content_get", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("page_content_get"));
});

test("A16 info operations mentions page_title_set", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("page_title_set"));
});

test("A17 info operations mentions property_get", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("property_get"));
});

test("A18 info operations mentions request", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("request"));
});

test("A19 info and version both work without token", async () => {
  const a = await notionClient({ operation: "info" });
  const b = await notionClient({ operation: "version" });
  assert.ok(a.ok && b.notionVersion);
});

test("A20 info operations count >= 10", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.length >= 10);
});

test("A21 info operations are all strings", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.every(o => typeof o === "string"));
});

test("A22 info operations mention database_create", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("database_create"));
});

test("A23 info operations mention block_children_append", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("block_children_append"));
});

test("A24 info operations mention page_icon_set", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("page_icon_set"));
});

test("A25 info operations mention page_cover_set", async () => {
  const r = await notionClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("page_cover_set"));
});

// ── Section B: input validation ───────────────────────────────────────────────
process.stderr.write("\nB: input validation\n");

test("B01 missing operation throws", async () => {
  try { await notionClient({}); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("operation")); }
});

test("B02 null args throws", async () => {
  try { await notionClient(null); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message); }
});

test("B03 unknown operation throws with op name in message", async () => {
  try { await notionClient({ operation: "zap_blorp", token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("zap_blorp")); }
});

test("B04 page_get missing page_id throws", async () => {
  try { await notionClient({ operation: "page_get", token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("page_id")); }
});

test("B05 page_get missing token throws", async () => {
  try { await notionClient({ operation: "page_get", page_id: "abc" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("token")); }
});

test("B06 database_get missing database_id throws", async () => {
  try { await notionClient({ operation: "database_get", token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("database_id")); }
});

test("B07 block_get missing block_id throws", async () => {
  try { await notionClient({ operation: "block_get", token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("block_id")); }
});

test("B08 user_get missing user_id throws", async () => {
  try { await notionClient({ operation: "user_get", token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("user_id")); }
});

test("B09 page_create missing parent throws", async () => {
  try { await notionClient({ operation: "page_create", token: "tok", properties: {} }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("parent")); }
});

test("B10 page_create missing properties throws", async () => {
  try { await notionClient({ operation: "page_create", token: "tok", parent: { type: "page_id", page_id: "abc" } }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("properties")); }
});

test("B11 comment_create missing rich_text throws", async () => {
  try { await notionClient({ operation: "comment_create", token: "tok", parent: { page_id: "x" } }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("rich_text")); }
});

test("B12 comment_create empty rich_text throws", async () => {
  try { await notionClient({ operation: "comment_create", token: "tok", parent: { page_id: "x" }, rich_text: [] }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("rich_text")); }
});

test("B13 comment_create missing parent and discussion_id throws", async () => {
  try { await notionClient({ operation: "comment_create", token: "tok", rich_text: [{ type: "text", text: { content: "Hi" } }] }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message); }
});

test("B14 page_title_set missing title throws", async () => {
  try { await notionClient({ operation: "page_title_set", token: "tok", page_id: "abc" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("title")); }
});

test("B15 page_icon_set missing icon_type throws", async () => {
  try { await notionClient({ operation: "page_icon_set", token: "tok", page_id: "abc", icon_value: "emoji" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("icon_type")); }
});

test("B16 page_icon_set invalid icon_type throws", async () => {
  try { await notionClient({ operation: "page_icon_set", token: "tok", page_id: "abc", icon_type: "svg", icon_value: "x" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("icon_type")); }
});

test("B17 page_cover_set missing cover_url throws", async () => {
  try { await notionClient({ operation: "page_cover_set", token: "tok", page_id: "abc" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("cover_url")); }
});

test("B18 block_update missing content and archived throws", async () => {
  try { await notionClient({ operation: "block_update", token: "tok", block_id: "abc" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message); }
});

test("B19 page_content_append missing children throws", async () => {
  try { await notionClient({ operation: "page_content_append", token: "tok", page_id: "abc" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("children")); }
});

test("B20 page_content_append empty children throws", async () => {
  try { await notionClient({ operation: "page_content_append", token: "tok", page_id: "abc", children: [] }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("children")); }
});

test("B21 comment_list missing block_id throws", async () => {
  try { await notionClient({ operation: "comment_list", token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("block_id")); }
});

test("B22 search_filter missing object_type throws", async () => {
  try { await notionClient({ operation: "search_filter", token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("object_type")); }
});

test("B23 search_filter invalid object_type throws", async () => {
  try { await notionClient({ operation: "search_filter", token: "tok", object_type: "block" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("object_type")); }
});

// ── Section C: mock-network ───────────────────────────────────────────────────
process.stderr.write("\nC: mock-network\n");

const PAGE_FIXTURE = { id: "page-abc", object: "page", url: "https://notion.so/page-abc",
  created_time: "2024-01-01T00:00:00.000Z", last_edited_time: "2024-01-02T00:00:00.000Z",
  archived: false, in_trash: false, parent: { type: "workspace", workspace: true },
  icon: null, cover: null, properties: {}, public_url: null };

test("C01 page_get returns mapped page", async () => {
  const restore = mockHttps(200, PAGE_FIXTURE);
  try {
    const r = await notionClient({ operation: "page_get", token: "secret_test", page_id: "page-abc" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.page.id, "page-abc");
    assert.strictEqual(r.page.url, "https://notion.so/page-abc");
  } finally { restore(); }
});

test("C02 page_get 404 returns exists:false", async () => {
  const restore = mockHttps(404, { object: "error", status: 404, code: "object_not_found", message: "Not found" });
  try {
    const r = await notionClient({ operation: "page_get", token: "secret_test", page_id: "nonexistent" });
    assert.strictEqual(r.exists, false);
    assert.strictEqual(r.page, null);
  } finally { restore(); }
});

test("C03 database_get returns mapped database", async () => {
  const restore = mockHttps(200, { id: "db-1", object: "database", url: "https://notion.so/db-1",
    title: [], description: [], created_time: "2024-01-01T00:00:00.000Z",
    last_edited_time: "2024-01-01T00:00:00.000Z", archived: false, in_trash: false,
    parent: {}, icon: null, cover: null, properties: {}, public_url: null, is_inline: false });
  try {
    const r = await notionClient({ operation: "database_get", token: "secret_test", database_id: "db-1" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.database.id, "db-1");
  } finally { restore(); }
});

test("C04 user_list returns mapped users array", async () => {
  const restore = mockHttps(200, { results: [
    { id: "u1", object: "user", type: "person", name: "Alice", avatar_url: null },
  ], has_more: false, next_cursor: null });
  try {
    const r = await notionClient({ operation: "user_list", token: "secret_test" });
    assert.ok(Array.isArray(r.users));
    assert.strictEqual(r.users[0].name, "Alice");
    assert.strictEqual(r.hasMore, false);
  } finally { restore(); }
});

test("C05 search returns results with count", async () => {
  const restore = mockHttps(200, { results: [{ id: "p1", object: "page" }], has_more: false, next_cursor: null });
  try {
    const r = await notionClient({ operation: "search", token: "secret_test", query: "test" });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.hasMore, false);
  } finally { restore(); }
});

test("C06 database_query returns mapped pages", async () => {
  const restore = mockHttps(200, { results: [PAGE_FIXTURE], has_more: false, next_cursor: null });
  try {
    const r = await notionClient({ operation: "database_query", token: "secret_test", database_id: "db-1" });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.results[0].id, "page-abc");
  } finally { restore(); }
});

test("C07 block_get returns mapped block with content", async () => {
  const restore = mockHttps(200, { id: "b1", object: "block", type: "paragraph",
    created_time: "2024-01-01T00:00:00.000Z", last_edited_time: "2024-01-01T00:00:00.000Z",
    archived: false, in_trash: false, has_children: false, parent: {},
    paragraph: { rich_text: [{ plain_text: "Hello" }], color: "default" } });
  try {
    const r = await notionClient({ operation: "block_get", token: "secret_test", block_id: "b1" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.block.type, "paragraph");
    assert.ok(r.block.content);
  } finally { restore(); }
});

test("C08 block_delete 404 returns deleted:false", async () => {
  const restore = mockHttps(404, { object: "error", status: 404, message: "Not found" });
  try {
    const r = await notionClient({ operation: "block_delete", token: "secret_test", block_id: "gone" });
    assert.strictEqual(r.deleted, false);
  } finally { restore(); }
});

test("C09 page_create returns created:true with mapped page", async () => {
  const restore = mockHttps(200, { ...PAGE_FIXTURE, id: "new-page" });
  try {
    const r = await notionClient({
      operation: "page_create", token: "secret_test",
      parent: { type: "database_id", database_id: "db-1" },
      properties: { Name: { title: [{ text: { content: "Test" } }] } },
    });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.page.id, "new-page");
  } finally { restore(); }
});

test("C10 generic request returns status and data", async () => {
  const restore = mockHttps(200, { object: "user", id: "me" });
  try {
    const r = await notionClient({ operation: "request", token: "secret_test", path: "/users/me" });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data);
  } finally { restore(); }
});

test("C11 API 401 error propagates message", async () => {
  const restore = mockHttps(401, { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." });
  try {
    await notionClient({ operation: "user_me", token: "bad_token" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e.message.includes("401") || e.message.includes("invalid"));
  } finally { restore(); }
});

test("C12 workspace_info returns bot/user info", async () => {
  const restore = mockHttps(200, { id: "bot-1", object: "user", type: "bot", name: "Bot",
    avatar_url: null, bot: { owner: {}, workspace_name: "Acme" } });
  try {
    const r = await notionClient({ operation: "workspace_info", token: "secret_test" });
    assert.ok(r.user);
  } finally { restore(); }
});

test("C13 block_children_list returns blocks array", async () => {
  const restore = mockHttps(200, { results: [
    { id: "c1", object: "block", type: "heading_1", created_time: "2024-01-01T00:00:00.000Z",
      last_edited_time: "2024-01-01T00:00:00.000Z", archived: false, in_trash: false,
      has_children: false, parent: {}, heading_1: { rich_text: [] } },
  ], has_more: false, next_cursor: null });
  try {
    const r = await notionClient({ operation: "block_children_list", token: "secret_test", block_id: "p1" });
    assert.ok(Array.isArray(r.blocks));
    assert.strictEqual(r.blocks[0].type, "heading_1");
  } finally { restore(); }
});

test("C14 comment_list returns comments", async () => {
  const restore = mockHttps(200, { results: [
    { id: "cmt1", object: "comment", parent: { page_id: "p1" }, discussion_id: "disc1",
      created_time: "2024-01-01T00:00:00.000Z", last_edited_time: "2024-01-01T00:00:00.000Z",
      created_by: { id: "u1" }, rich_text: [{ plain_text: "Hello" }] },
  ], has_more: false, next_cursor: null });
  try {
    const r = await notionClient({ operation: "comment_list", token: "secret_test", block_id: "p1" });
    assert.ok(Array.isArray(r.comments));
    assert.strictEqual(r.comments[0].id, "cmt1");
  } finally { restore(); }
});

test("C15 database_list returns databases (via search endpoint)", async () => {
  const restore = mockHttps(200, { results: [
    { id: "db-2", object: "database", url: "", title: [], description: [],
      created_time: "2024-01-01T00:00:00.000Z", last_edited_time: "2024-01-01T00:00:00.000Z",
      archived: false, in_trash: false, parent: {}, icon: null, cover: null, properties: {}, is_inline: false },
  ], has_more: false, next_cursor: null });
  try {
    const r = await notionClient({ operation: "database_list", token: "secret_test" });
    assert.ok(Array.isArray(r.databases));
    assert.strictEqual(r.databases[0].id, "db-2");
  } finally { restore(); }
});

test("C16 property_list returns properties object", async () => {
  const restore = mockHttps(200, { id: "db-1", object: "database", properties: {
    Name: { id: "title", type: "title", title: {} },
  } });
  try {
    const r = await notionClient({ operation: "property_list", token: "secret_test", database_id: "db-1" });
    assert.ok(r.properties);
    assert.strictEqual(r.databaseId, "db-1");
  } finally { restore(); }
});

test("C17 database_filter alias works same as database_query", async () => {
  const restore = mockHttps(200, { results: [], has_more: false, next_cursor: null });
  try {
    const r = await notionClient({ operation: "database_filter", token: "secret_test", database_id: "db-1" });
    assert.ok(Array.isArray(r.results));
    assert.strictEqual(r.hasMore, false);
  } finally { restore(); }
});

// ── Section D: security ───────────────────────────────────────────────────────
process.stderr.write("\nD: security\n");

test("D01 NUL byte in token throws", async () => {
  try { await notionClient({ operation: "page_get", token: "tok\x00bad", page_id: "abc" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D02 NUL byte in page_id throws", async () => {
  try { await notionClient({ operation: "page_get", token: "tok", page_id: "abc\x00bad" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D03 NUL byte in database_id throws", async () => {
  try { await notionClient({ operation: "database_get", token: "tok", database_id: "db\x00" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D04 NUL byte in block_id throws", async () => {
  try { await notionClient({ operation: "block_get", token: "tok", block_id: "b\x00" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D05 NUL byte in user_id throws", async () => {
  try { await notionClient({ operation: "user_get", token: "tok", user_id: "u\x00" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D06 empty string token throws", async () => {
  try { await notionClient({ operation: "page_get", token: "", page_id: "abc" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("token")); }
});

test("D07 empty string page_id throws", async () => {
  try { await notionClient({ operation: "page_get", token: "tok", page_id: "" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("page_id")); }
});

test("D08 timeout < 1000 is clamped (no crash)", async () => {
  const restore = mockHttps(200, { ...PAGE_FIXTURE });
  try {
    await notionClient({ operation: "page_get", token: "tok", page_id: "page-abc", timeout: 1 });
  } catch (e) {
    // only timeout error is acceptable
    assert.ok(e.message.includes("ms") || e.message.includes("timed"));
  } finally { restore(); }
});

test("D09 token not echoed in API error message", async () => {
  const restore = mockHttps(403, { object: "error", status: 403, code: "restricted_resource", message: "Access denied" });
  try {
    await notionClient({ operation: "user_me", token: "super_secret_tok_xyz" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!e.message.includes("super_secret_tok_xyz"), "token must not leak into error");
  } finally { restore(); }
});

test("D10 reject_unauthorized defaults true (captured in request options)", async () => {
  const EventEmitter = require("events").EventEmitter;
  let capturedOpts;
  const orig = https.request;
  https.request = (opts, cb) => {
    capturedOpts = opts;
    const res = Object.assign(Object.create(EventEmitter.prototype), { statusCode: 200, headers: {} });
    const req = Object.assign(Object.create(EventEmitter.prototype), {
      write: () => {}, destroy: () => {},
      end: () => {
        cb(res);
        setTimeout(() => {
          res.emit("data", Buffer.from(JSON.stringify(
            { id: "u1", object: "user", type: "bot", name: "Bot", avatar_url: null, bot: null }
          )));
          res.emit("end");
        }, 0);
      },
    });
    return req;
  };
  try {
    await notionClient({ operation: "user_me", token: "tok" });
    assert.strictEqual(capturedOpts.rejectUnauthorized, true);
  } finally { https.request = orig; }
});

// ── Section E: concurrency ────────────────────────────────────────────────────
process.stderr.write("\nE: concurrency\n");

test("E01 8 concurrent info calls all succeed", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => notionClient({ operation: "info" })));
  assert.ok(results.every(r => r.ok === true));
});

test("E02 5 concurrent version calls return same version", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => notionClient({ operation: "version" })));
  const v0 = results[0].notionVersion;
  assert.ok(results.every(r => r.notionVersion === v0));
});

test("E03 5 concurrent mock page_get calls succeed independently", async () => {
  const EventEmitter = require("events").EventEmitter;
  const orig = https.request;
  https.request = (opts, cb) => {
    const id = opts.path.split("/").pop().split("?")[0];
    const res = Object.assign(Object.create(EventEmitter.prototype), { statusCode: 200, headers: {} });
    const req = Object.assign(Object.create(EventEmitter.prototype), {
      write: () => {}, destroy: () => {},
      end: () => {
        cb(res);
        setTimeout(() => {
          res.emit("data", Buffer.from(JSON.stringify(
            { id, object: "page", url: `https://notion.so/${id}`,
              created_time: "2024-01-01T00:00:00.000Z", last_edited_time: "2024-01-01T00:00:00.000Z",
              archived: false, in_trash: false, parent: {}, icon: null, cover: null, properties: {} }
          )));
          res.emit("end");
        }, 5);
      },
    });
    return req;
  };
  try {
    const ids = ["pa", "pb", "pc", "pd", "pe"];
    const results = await Promise.all(ids.map(id => notionClient({ operation: "page_get", token: "tok", page_id: id })));
    assert.ok(results.every(r => r.exists === true));
    assert.ok(results.every((r, i) => r.page.id === ids[i]));
  } finally { https.request = orig; }
});

test("E04 mixed concurrent ops: info+version+validation work correctly", async () => {
  const results = await Promise.all([
    notionClient({ operation: "info" }),
    notionClient({ operation: "version" }),
    notionClient({}).catch(e => ({ error: e.message })),
    notionClient({ operation: "info" }),
    notionClient({ operation: "version" }),
  ]);
  assert.strictEqual(results[0].ok, true);
  assert.ok(results[1].notionVersion);
  assert.ok(results[2].error.includes("operation"));
  assert.strictEqual(results[3].ok, true);
  assert.ok(results[4].notionVersion);
});

test("E05 concurrent validation errors throw with correct field names", async () => {
  const msgs = await Promise.all([
    notionClient({ operation: "page_get", token: "tok" }).catch(e => e.message),
    notionClient({ operation: "database_get", token: "tok" }).catch(e => e.message),
    notionClient({ operation: "block_get", token: "tok" }).catch(e => e.message),
    notionClient({ operation: "user_get", token: "tok" }).catch(e => e.message),
  ]);
  assert.ok(msgs[0].includes("page_id"));
  assert.ok(msgs[1].includes("database_id"));
  assert.ok(msgs[2].includes("block_id"));
  assert.ok(msgs[3].includes("user_id"));
});

test("E06 10 concurrent info calls return consistent operations", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => notionClient({ operation: "info" })));
  const first = JSON.stringify(results[0].operations);
  assert.ok(results.every(r => JSON.stringify(r.operations) === first));
});

test("E07 5 concurrent mock user_list calls return independent data", async () => {
  const EventEmitter = require("events").EventEmitter;
  const orig = https.request;
  let n = 0;
  https.request = (opts, cb) => {
    const idx = ++n;
    const res = Object.assign(Object.create(EventEmitter.prototype), { statusCode: 200, headers: {} });
    const req = Object.assign(Object.create(EventEmitter.prototype), {
      write: () => {}, destroy: () => {},
      end: () => {
        cb(res);
        setTimeout(() => {
          res.emit("data", Buffer.from(JSON.stringify(
            { results: [{ id: `u${idx}`, object: "user", type: "person", name: `User${idx}`, avatar_url: null }],
              has_more: false, next_cursor: null }
          )));
          res.emit("end");
        }, 5);
      },
    });
    return req;
  };
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      notionClient({ operation: "user_list", token: "tok" })));
    assert.ok(results.every(r => Array.isArray(r.users) && r.users.length === 1));
    // Each call got a unique user id
    const ids = results.map(r => r.users[0].id);
    assert.strictEqual(new Set(ids).size, 5);
  } finally { https.request = orig; }
});

test("E08 info is idempotent across many calls", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => notionClient({ operation: "info" })));
  assert.ok(results.every(r => r.ok === true && typeof r.api === "string"));
});

// ── Final report ──────────────────────────────────────────────────────────────
setTimeout(() => {
  process.stderr.write(`\n280-notion-client: ${passed}/${total} passed`);
  if (failed > 0) {
    process.stderr.write(`, ${failed} failed`);
    process.stderr.write("\n");
    process.exit(1);
  }
  process.stderr.write("\n");
  process.exit(0);
}, 500);
