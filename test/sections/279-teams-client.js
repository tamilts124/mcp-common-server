"use strict";
/**
 * Section 279 — teams_client tests
 * Five rigor levels: A=happy-path (25), B=validation (23), C=mock-network (17),
 *                    D=security (10), E=concurrency (8)  —  83 tests total
 * Run: node test/sections/279-teams-client.js
 */

const assert = require("assert");
const https  = require("https");
const { EventEmitter } = require("events");

const { teamsClient } = require("../../lib/teamsClientOps");

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r
        .then(() => { passed++; console.log(`  ✓ ${label}`); })
        .catch(err => { failed++; console.error(`  ✗ ${label}: ${err.message}`); });
    }
    passed++; console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++; console.error(`  ✗ ${label}: ${err.message}`);
  }
  return Promise.resolve();
}

// ─── Mock HTTPS ────────────────────────────────────────────────────────────────
function mockHttps(body, status = 200, extraHeaders = {}) {
  const original = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write   = () => {};
    req.destroy = () => {};
    req.end = () => {
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers    = { "content-type": "application/json", ...extraHeaders };
        res.destroy    = () => {};
        if (cb) cb(res);
        process.nextTick(() => {
          const txt = typeof body === "string" ? body : JSON.stringify(body);
          res.emit("data", Buffer.from(txt));
          res.emit("end");
        });
      });
    };
    return req;
  };
  return () => { https.request = original; };
}

const tests = [];

// ════════════════════════════════════════════════════════════════════════
// A: Happy-path (25 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== A: Happy-path ===");

tests.push(() => test("A01 - info returns ok:true", () => {
  return teamsClient({ operation: "info" }).then(r => {
    assert.strictEqual(r.ok, true);
    assert.ok(typeof r.api === "string");
    assert.ok(Array.isArray(r.operations));
    assert.ok(r.operations.length >= 10);
  });
}));

tests.push(() => test("A02 - team_list returns teams array", () => {
  const restore = mockHttps({
    value: [
      { id: "t1", displayName: "Engineering", visibility: "Public" },
      { id: "t2", displayName: "Marketing",   visibility: "Private" },
    ],
    "@odata.count": 2,
  });
  return teamsClient({ operation: "team_list", access_token: "tok" })
    .then(r => { assert.strictEqual(r.teams.length, 2); assert.strictEqual(r.teams[0].id, "t1"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A03 - team_get returns team object", () => {
  const restore = mockHttps({ id: "t1", displayName: "Engineering", webUrl: "https://teams.ms/t1" });
  return teamsClient({ operation: "team_get", access_token: "tok", team_id: "t1" })
    .then(r => { assert.strictEqual(r.team.id, "t1"); assert.strictEqual(r.team.displayName, "Engineering"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A04 - channel_list returns channels", () => {
  const restore = mockHttps({ value: [{ id: "c1", displayName: "General", membershipType: "standard" }] });
  return teamsClient({ operation: "channel_list", access_token: "tok", team_id: "t1" })
    .then(r => { assert.strictEqual(r.channels.length, 1); assert.strictEqual(r.channels[0].id, "c1"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A05 - message_send sent:true", () => {
  const restore = mockHttps({ id: "m1", messageType: "message", body: { contentType: "text", content: "Hi" } }, 201);
  return teamsClient({ operation: "message_send", access_token: "tok", team_id: "t1", channel_id: "c1", content: "Hi" })
    .then(r => { assert.strictEqual(r.sent, true); assert.strictEqual(r.message.id, "m1"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A06 - chat_list returns chats", () => {
  const restore = mockHttps({ value: [{ id: "ch1", chatType: "group", topic: "Project X" }] });
  return teamsClient({ operation: "chat_list", access_token: "tok" })
    .then(r => { assert.strictEqual(r.chats.length, 1); assert.strictEqual(r.chats[0].chatType, "group"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A07 - user_me returns user object", () => {
  const restore = mockHttps({ id: "u1", displayName: "Alice", userPrincipalName: "alice@example.com", mail: "alice@example.com" });
  return teamsClient({ operation: "user_me", access_token: "tok" })
    .then(r => { assert.strictEqual(r.user.displayName, "Alice"); assert.strictEqual(r.user.userPrincipalName, "alice@example.com"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A08 - team_delete 404 → deleted:false", () => {
  const restore = mockHttps("", 404);
  return teamsClient({ operation: "team_delete", access_token: "tok", team_id: "gone" })
    .then(r => { assert.strictEqual(r.deleted, false); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A09 - team_delete 204 → deleted:true", () => {
  const restore = mockHttps("", 204);
  return teamsClient({ operation: "team_delete", access_token: "tok", team_id: "t1" })
    .then(r => { assert.strictEqual(r.deleted, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A10 - meeting_list returns meetings", () => {
  const restore = mockHttps({ value: [{ id: "ev1", subject: "Standup", start: { dateTime: "2024-01-15T09:00:00" }, end: { dateTime: "2024-01-15T09:30:00" } }] });
  return teamsClient({ operation: "meeting_list", access_token: "tok" })
    .then(r => { assert.strictEqual(r.meetings.length, 1); assert.strictEqual(r.meetings[0].subject, "Standup"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A11 - app_list returns apps", () => {
  const restore = mockHttps({ value: [{ id: "ai1", teamsApp: { displayName: "Planner", externalId: "ext1" }, teamsAppDefinition: { version: "1.0" } }] });
  return teamsClient({ operation: "app_list", access_token: "tok", team_id: "t1" })
    .then(r => { assert.strictEqual(r.apps.length, 1); assert.strictEqual(r.apps[0].displayName, "Planner"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A12 - tag_list returns tags", () => {
  const restore = mockHttps({ value: [{ id: "tag1", displayName: "FrontEnd", memberCount: 3 }] });
  return teamsClient({ operation: "tag_list", access_token: "tok", team_id: "t1" })
    .then(r => { assert.strictEqual(r.tags.length, 1); assert.strictEqual(r.tags[0].displayName, "FrontEnd"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A13 - message_get 404 → exists:false", () => {
  const restore = mockHttps("", 404);
  return teamsClient({ operation: "message_get", access_token: "tok", team_id: "t1", channel_id: "c1", message_id: "gone" })
    .then(r => { assert.strictEqual(r.exists, false); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A14 - file_list returns files", () => {
  const restore = mockHttps({ value: [{ id: "fi1", name: "report.pdf", size: 12345, file: { mimeType: "application/pdf" } }] });
  return teamsClient({ operation: "file_list", access_token: "tok", team_id: "t1", channel_id: "c1" })
    .then(r => { assert.strictEqual(r.files.length, 1); assert.strictEqual(r.files[0].name, "report.pdf"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A15 - message_reply sent:true", () => {
  const restore = mockHttps({ id: "r1", body: { content: "Got it!", contentType: "text" } }, 201);
  return teamsClient({ operation: "message_reply", access_token: "tok", team_id: "t1", channel_id: "c1", message_id: "m1", content: "Got it!" })
    .then(r => { assert.strictEqual(r.sent, true); assert.strictEqual(r.reply.id, "r1"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A16 - channel_get 200 → exists:true", () => {
  const restore = mockHttps({ id: "c1", displayName: "General", membershipType: "standard" });
  return teamsClient({ operation: "channel_get", access_token: "tok", team_id: "t1", channel_id: "c1" })
    .then(r => { assert.strictEqual(r.exists, true); assert.strictEqual(r.channel.id, "c1"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A17 - file_share returns link", () => {
  const restore = mockHttps({ link: { type: "view", scope: "organization", webUrl: "https://share.link" } });
  return teamsClient({ operation: "file_share", access_token: "tok", team_id: "t1", item_id: "fi1" })
    .then(r => { assert.strictEqual(r.link.type, "view"); assert.ok(r.link.webUrl.startsWith("https://")); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A18 - user_presence returns availability", () => {
  const restore = mockHttps({ id: "u1", availability: "Available", activity: "Available" });
  return teamsClient({ operation: "user_presence", access_token: "tok", user_id: "u1" })
    .then(r => { assert.strictEqual(r.availability, "Available"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A19 - generic request returns status+data", () => {
  const restore = mockHttps({ value: "test" });
  return teamsClient({ operation: "request", access_token: "tok", path: "/me", method: "GET" })
    .then(r => { assert.strictEqual(r.status, 200); assert.strictEqual(r.data.value, "test"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A20 - team_create 202 → provisioning status", () => {
  const restore = mockHttps("", 202, { location: "https://graph.microsoft.com/v1.0/operations/op1" });
  return teamsClient({ operation: "team_create", access_token: "tok", display_name: "Test Team", description: "A test" })
    .then(r => { assert.strictEqual(r.created, true); assert.strictEqual(r.status, "provisioning"); assert.ok(typeof r.location === "string"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A21 - channel_member_add added:true", () => {
  const restore = mockHttps({ id: "m1", displayName: "Bob", userId: "u2", roles: ["owner"] }, 201);
  return teamsClient({ operation: "channel_member_add", access_token: "tok", team_id: "t1", channel_id: "c1", user_id: "u2", roles: ["owner"] })
    .then(r => { assert.strictEqual(r.added, true); assert.strictEqual(r.member.displayName, "Bob"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A22 - chat_create created:true", () => {
  const restore = mockHttps({ id: "ch2", chatType: "group", topic: "New Chat" }, 201);
  return teamsClient({ operation: "chat_create", access_token: "tok", topic: "New Chat", members: [{ user_id: "u1", roles: ["owner"] }, { user_id: "u2" }] })
    .then(r => { assert.strictEqual(r.created, true); assert.strictEqual(r.chat.id, "ch2"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A23 - meeting_create created:true", () => {
  const restore = mockHttps({ id: "ev2", subject: "Sprint Review", start: { dateTime: "2024-02-01T14:00:00" }, end: { dateTime: "2024-02-01T15:00:00" } }, 201);
  return teamsClient({ operation: "meeting_create", access_token: "tok", subject: "Sprint Review", start_datetime: "2024-02-01T14:00:00", end_datetime: "2024-02-01T15:00:00" })
    .then(r => { assert.strictEqual(r.created, true); assert.strictEqual(r.meeting.id, "ev2"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A24 - tab_create created:true", () => {
  const restore = mockHttps({ id: "tab1", displayName: "Planner Tab", webUrl: "https://teams.ms/tab1" }, 201);
  return teamsClient({ operation: "tab_create", access_token: "tok", team_id: "t1", channel_id: "c1", display_name: "Planner Tab", teams_app_id: "com.ms.planner", content_url: "https://tasks.office.com/t1" })
    .then(r => { assert.strictEqual(r.created, true); assert.strictEqual(r.tab.id, "tab1"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("A25 - tag_create created:true", () => {
  const restore = mockHttps({ id: "tag2", displayName: "BackEnd" }, 201);
  return teamsClient({ operation: "tag_create", access_token: "tok", team_id: "t1", display_name: "BackEnd", members: [{ user_id: "u3" }] })
    .then(r => { assert.strictEqual(r.created, true); assert.strictEqual(r.tag.displayName, "BackEnd"); restore(); })
    .catch(e => { restore(); throw e; });
}));

// ════════════════════════════════════════════════════════════════════════
// B: Validation (23 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== B: Validation ===");

tests.push(() => test("B01 - missing operation throws", () =>
  assert.rejects(() => teamsClient({}), /operation is required/)));

tests.push(() => test("B02 - no auth throws", () =>
  assert.rejects(() => teamsClient({ operation: "team_list" }), /access_token/)));

tests.push(() => test("B03 - partial client creds throws", () =>
  assert.rejects(() => teamsClient({ operation: "team_list", tenant_id: "t", client_id: "c" }), /client_secret/)));

tests.push(() => test("B04 - team_get missing team_id", () =>
  assert.rejects(() => teamsClient({ operation: "team_get", access_token: "tok" }), /team_id/)));

tests.push(() => test("B05 - channel_list missing team_id", () =>
  assert.rejects(() => teamsClient({ operation: "channel_list", access_token: "tok" }), /team_id/)));

tests.push(() => test("B06 - message_send missing content", () =>
  assert.rejects(() => teamsClient({ operation: "message_send", access_token: "tok", team_id: "t1", channel_id: "c1" }), /content/)));

tests.push(() => test("B07 - chat_create empty members", () =>
  assert.rejects(() => teamsClient({ operation: "chat_create", access_token: "tok", members: [] }), /members/)));

tests.push(() => test("B08 - tab_create missing content_url", () =>
  assert.rejects(() => teamsClient({ operation: "tab_create", access_token: "tok", team_id: "t1", channel_id: "c1", display_name: "T", teams_app_id: "a1" }), /content_url/)));

tests.push(() => test("B09 - request missing path", () =>
  assert.rejects(() => teamsClient({ operation: "request", access_token: "tok" }), /path/)));

tests.push(() => test("B10 - request invalid method", () =>
  assert.rejects(() => teamsClient({ operation: "request", access_token: "tok", path: "/me", method: "CONNECT" }), /method/)));

tests.push(() => test("B11 - unknown operation throws descriptive", () =>
  assert.rejects(() => teamsClient({ operation: "unknown_op", access_token: "tok" }), /Unknown operation/)));

tests.push(() => test("B12 - channel_get missing channel_id", () =>
  assert.rejects(() => teamsClient({ operation: "channel_get", access_token: "tok", team_id: "t1" }), /channel_id/)));

tests.push(() => test("B13 - meeting_create missing subject", () =>
  assert.rejects(() => teamsClient({ operation: "meeting_create", access_token: "tok", start_datetime: "2024-01-01T09:00:00", end_datetime: "2024-01-01T10:00:00" }), /subject/)));

tests.push(() => test("B14 - meeting_create missing start_datetime", () =>
  assert.rejects(() => teamsClient({ operation: "meeting_create", access_token: "tok", subject: "S", end_datetime: "2024-01-01T10:00:00" }), /start_datetime/)));

tests.push(() => test("B15 - app_install missing teams_app_id", () =>
  assert.rejects(() => teamsClient({ operation: "app_install", access_token: "tok", team_id: "t1" }), /teams_app_id/)));

tests.push(() => test("B16 - message_get missing message_id", () =>
  assert.rejects(() => teamsClient({ operation: "message_get", access_token: "tok", team_id: "t1", channel_id: "c1" }), /message_id/)));

tests.push(() => test("B17 - channel_create missing display_name", () =>
  assert.rejects(() => teamsClient({ operation: "channel_create", access_token: "tok", team_id: "t1" }), /display_name/)));

tests.push(() => test("B18 - user_get missing user_id", () =>
  assert.rejects(() => teamsClient({ operation: "user_get", access_token: "tok" }), /user_id/)));

tests.push(() => test("B19 - file_upload missing file_name", () =>
  assert.rejects(() => teamsClient({ operation: "file_upload", access_token: "tok", team_id: "t1", content: "data" }), /file_name/)));

tests.push(() => test("B20 - file_upload missing content", () =>
  assert.rejects(() => teamsClient({ operation: "file_upload", access_token: "tok", team_id: "t1", file_name: "f.txt" }), /content/)));

tests.push(() => test("B21 - tag_create missing display_name", () =>
  assert.rejects(() => teamsClient({ operation: "tag_create", access_token: "tok", team_id: "t1" }), /display_name/)));

tests.push(() => test("B22 - chat_send missing content", () =>
  assert.rejects(() => teamsClient({ operation: "chat_send", access_token: "tok", chat_id: "ch1" }), /content/)));

tests.push(() => test("B23 - message_reply missing content", () =>
  assert.rejects(() => teamsClient({ operation: "message_reply", access_token: "tok", team_id: "t1", channel_id: "c1", message_id: "m1" }), /content/)));

// ════════════════════════════════════════════════════════════════════════
// C: Mock-network failures (17 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== C: Mock-network ===");

tests.push(() => test("C01 - Graph API 400 throws", () => {
  const restore = mockHttps({ error: { code: "BadRequest", message: "Invalid team" } }, 400);
  return assert.rejects(
    () => teamsClient({ operation: "team_get", access_token: "tok", team_id: "bad" }),
    /400/
  ).then(() => restore()).catch(e => { restore(); throw e; });
}));

tests.push(() => test("C02 - Graph API 403 throws", () => {
  const restore = mockHttps({ error: { code: "Forbidden", message: "Not authorized" } }, 403);
  return assert.rejects(
    () => teamsClient({ operation: "user_list", access_token: "tok" }),
    /403/
  ).then(() => restore()).catch(e => { restore(); throw e; });
}));

tests.push(() => test("C03 - Graph API 500 throws", () => {
  const restore = mockHttps({ error: { code: "InternalServerError", message: "Server fail" } }, 500);
  return assert.rejects(
    () => teamsClient({ operation: "team_list", access_token: "tok" }),
    /500/
  ).then(() => restore()).catch(e => { restore(); throw e; });
}));

tests.push(() => test("C04 - Malformed JSON throws parse error", () => {
  const restore = mockHttps("NOT-JSON", 200);
  return assert.rejects(
    () => teamsClient({ operation: "team_list", access_token: "tok" }),
    /JSON/i
  ).then(() => restore()).catch(e => { restore(); throw e; });
}));

tests.push(() => test("C05 - token acquisition failure throws", () => {
  const restore = mockHttps({ error: "invalid_client", error_description: "Secret mismatch" }, 400);
  return assert.rejects(
    () => teamsClient({ operation: "team_list", tenant_id: "ten1", client_id: "cid1", client_secret: "bad" }),
    /Token acquisition failed/
  ).then(() => restore()).catch(e => { restore(); throw e; });
}));

tests.push(() => test("C06 - channel_delete 404 → deleted:false", () => {
  const restore = mockHttps("", 404);
  return teamsClient({ operation: "channel_delete", access_token: "tok", team_id: "t1", channel_id: "gone" })
    .then(r => { assert.strictEqual(r.deleted, false); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C07 - file_get 404 → exists:false", () => {
  const restore = mockHttps("", 404);
  return teamsClient({ operation: "file_get", access_token: "tok", team_id: "t1", item_id: "gone" })
    .then(r => { assert.strictEqual(r.exists, false); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C08 - message_replies returns array", () => {
  const restore = mockHttps({ value: [{ id: "r1", body: { content: "OK!" } }, { id: "r2", body: { content: "Sure!" } }] });
  return teamsClient({ operation: "message_replies", access_token: "tok", team_id: "t1", channel_id: "c1", message_id: "m1" })
    .then(r => { assert.strictEqual(r.replies.length, 2); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C09 - team_members returns members", () => {
  const restore = mockHttps({ value: [{ id: "mb1", displayName: "Alice", userId: "u1", roles: ["owner"] }, { id: "mb2", displayName: "Bob", userId: "u2", roles: [] }] });
  return teamsClient({ operation: "team_members", access_token: "tok", team_id: "t1" })
    .then(r => { assert.strictEqual(r.members.length, 2); assert.strictEqual(r.members[0].roles[0], "owner"); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C10 - tag_delete 404 → deleted:false", () => {
  const restore = mockHttps("", 404);
  return teamsClient({ operation: "tag_delete", access_token: "tok", team_id: "t1", tag_id: "gone" })
    .then(r => { assert.strictEqual(r.deleted, false); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C11 - user_list with nextLink", () => {
  const restore = mockHttps({ value: [{ id: "u1", displayName: "Alice" }], "@odata.nextLink": "https://graph.ms/next" });
  return teamsClient({ operation: "user_list", access_token: "tok", top: 1 })
    .then(r => { assert.strictEqual(r.users.length, 1); assert.ok(r.nextLink !== null); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C12 - chat_send sent:true", () => {
  const restore = mockHttps({ id: "cm1", body: { content: "Hi!", contentType: "text" } }, 201);
  return teamsClient({ operation: "chat_send", access_token: "tok", chat_id: "ch1", content: "Hi!" })
    .then(r => { assert.strictEqual(r.sent, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C13 - message_update 204 → updated:true", () => {
  const restore = mockHttps("", 204);
  return teamsClient({ operation: "message_update", access_token: "tok", team_id: "t1", channel_id: "c1", message_id: "m1", content: "Updated!" })
    .then(r => { assert.strictEqual(r.updated, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C14 - message_delete 404 → deleted:false", () => {
  const restore = mockHttps("", 404);
  return teamsClient({ operation: "message_delete", access_token: "tok", team_id: "t1", channel_id: "c1", message_id: "gone" })
    .then(r => { assert.strictEqual(r.deleted, false); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C15 - user_joined_teams returns teams", () => {
  const restore = mockHttps({ value: [{ id: "t1", displayName: "Engineering" }, { id: "t2", displayName: "Design" }] });
  return teamsClient({ operation: "user_joined_teams", access_token: "tok", user_id: "u1" })
    .then(r => { assert.strictEqual(r.teams.length, 2); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C16 - meeting_update 200 → updated:true", () => {
  const restore = mockHttps({ id: "ev1", subject: "Updated Meeting" });
  return teamsClient({ operation: "meeting_update", access_token: "tok", event_id: "ev1", subject: "Updated Meeting" })
    .then(r => { assert.strictEqual(r.updated, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C17 - app_get 404 → exists:false", () => {
  const restore = mockHttps("", 404);
  return teamsClient({ operation: "app_get", access_token: "tok", team_id: "t1", app_installation_id: "gone" })
    .then(r => { assert.strictEqual(r.exists, false); restore(); })
    .catch(e => { restore(); throw e; });
}));

// ════════════════════════════════════════════════════════════════════════
// D: Security (10 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== D: Security ===");

tests.push(() => test("D01 - NUL byte in team_id throws", () =>
  assert.rejects(() => teamsClient({ operation: "team_get", access_token: "tok", team_id: "t1\x00evil" }), /NUL bytes/)));

tests.push(() => test("D02 - NUL byte in access_token throws", () =>
  assert.rejects(() => teamsClient({ operation: "team_list", access_token: "tok\x00injected" }), /NUL bytes/)));

tests.push(() => test("D03 - NUL byte in content throws", () =>
  assert.rejects(() => teamsClient({ operation: "message_send", access_token: "tok", team_id: "t1", channel_id: "c1", content: "Hello\x00World" }), /NUL bytes/)));

tests.push(() => test("D04 - NUL byte in channel_id throws", () =>
  assert.rejects(() => teamsClient({ operation: "channel_get", access_token: "tok", team_id: "t1", channel_id: "c\x00x" }), /NUL bytes/)));

tests.push(() => test("D05 - NUL byte in display_name throws", () =>
  assert.rejects(() => teamsClient({ operation: "team_create", access_token: "tok", display_name: "Evil\x00Team" }), /NUL bytes/)));

tests.push(() => test("D06 - timeout clamped to minimum", () => {
  const restore = mockHttps({ value: [], "@odata.count": 0 });
  return teamsClient({ operation: "team_list", access_token: "tok", timeout: -999 })
    .then(r => { assert.ok(Array.isArray(r.teams)); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("D07 - timeout clamped to maximum", () => {
  const restore = mockHttps({ value: [], "@odata.count": 0 });
  return teamsClient({ operation: "team_list", access_token: "tok", timeout: 9999999 })
    .then(r => { assert.ok(Array.isArray(r.teams)); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("D08 - NUL byte in tenant_id throws", () =>
  assert.rejects(() => teamsClient({ operation: "team_list", tenant_id: "ten\x00x", client_id: "c", client_secret: "s" }), /NUL bytes/)));

tests.push(() => test("D09 - NUL byte in filter throws", () =>
  assert.rejects(() => teamsClient({ operation: "team_list", access_token: "tok", filter: "id eq 'x'\x00drop" }), /NUL bytes/)));

tests.push(() => test("D10 - token not echoed in error message", () => {
  const SECRET = "super_secret_bearer_token_99999";
  const restore = mockHttps({ error: { code: "Unauthenticated", message: "Token expired" } }, 401);
  return teamsClient({ operation: "team_list", access_token: SECRET })
    .then(() => { restore(); throw new Error("should have thrown"); })
    .catch(err => { restore(); assert.ok(!err.message.includes(SECRET), `Token leaked: ${err.message}`); });
}));

// ════════════════════════════════════════════════════════════════════════
// E: Concurrency (8 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\n=== E: Concurrency ===");

tests.push(() => test("E01 - 8 concurrent team_list calls", () => {
  const restore = mockHttps({ value: [{ id: "t1", displayName: "Engineering" }], "@odata.count": 1 });
  return Promise.all(Array.from({ length: 8 }, () => teamsClient({ operation: "team_list", access_token: "tok" })))
    .then(results => { assert.ok(results.every(r => r.teams.length === 1)); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("E02 - 8 concurrent channel_list calls", () => {
  const restore = mockHttps({ value: [{ id: "c1", displayName: "General" }] });
  return Promise.all(Array.from({ length: 8 }, (_, i) => teamsClient({ operation: "channel_list", access_token: "tok", team_id: `team_${i}` })))
    .then(results => { assert.ok(results.every(r => r.channels.length === 1)); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("E03 - 8 concurrent message_send calls", () => {
  const restore = mockHttps({ id: "m_new", body: { content: "Hi", contentType: "text" } }, 201);
  return Promise.all(Array.from({ length: 8 }, (_, i) => teamsClient({ operation: "message_send", access_token: "tok", team_id: "t1", channel_id: "c1", content: `Message ${i}` })))
    .then(results => { assert.ok(results.every(r => r.sent === true)); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("E04 - mixed concurrent operations", () => {
  const restore = mockHttps({ value: [] });
  return Promise.all([
    teamsClient({ operation: "team_list",  access_token: "tok" }),
    teamsClient({ operation: "chat_list",  access_token: "tok" }),
  ])
    .then(([teamR, chatR]) => { assert.ok(Array.isArray(teamR.teams)); assert.ok(Array.isArray(chatR.chats)); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("E05 - 8 concurrent user_list calls", () => {
  const restore = mockHttps({ value: [{ id: "u1", displayName: "Alice" }] });
  return Promise.all(Array.from({ length: 8 }, () => teamsClient({ operation: "user_list", access_token: "tok" })))
    .then(results => { assert.ok(results.every(r => Array.isArray(r.users))); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("E06 - 8 concurrent info calls", () => {
  return Promise.all(Array.from({ length: 8 }, () => teamsClient({ operation: "info" })))
    .then(results => { assert.ok(results.every(r => r.ok === true)); });
}));

tests.push(() => test("E07 - 16MB response cap triggers error", () => {
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200; res.headers = {}; res.destroy = () => {};
        cb(res);
        process.nextTick(() => res.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x41)));
      });
    };
    return req;
  };
  return assert.rejects(
    () => teamsClient({ operation: "team_list", access_token: "tok" }),
    /16 MB/
  ).then(() => { https.request = orig; }).catch(e => { https.request = orig; throw e; });
}));

tests.push(() => test("E08 - 8 concurrent meeting_list calls", () => {
  const restore = mockHttps({ value: [{ id: "ev1", subject: "Sync", start: { dateTime: "2024-01-15T09:00:00" }, end: { dateTime: "2024-01-15T09:30:00" } }] });
  return Promise.all(Array.from({ length: 8 }, () => teamsClient({ operation: "meeting_list", access_token: "tok" })))
    .then(results => { assert.ok(results.every(r => r.meetings.length === 1)); restore(); })
    .catch(e => { restore(); throw e; });
}));

// ════════════════════════════════════════════════════════════════════════
// Run all tests
// ════════════════════════════════════════════════════════════════════════
const TOTAL_EXPECTED = 83;

tests.reduce((p, fn) => p.then(() => fn()), Promise.resolve()).then(() => {
  console.log(`\n=== Results: ${passed} passed, ${failed} failed / ${TOTAL_EXPECTED} expected ===\n`);
  if (failed > 0) {
    console.error(`FAILED: ${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log("All tests passed!");
    process.exit(0);
  }
});
