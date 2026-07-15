"use strict";
/**
 * Section 281 — discord_client tests
 * A: happy-path helpers (25)
 * B: input validation (23)
 * C: mock-network (17)
 * D: security (10)
 * E: concurrency (8)
 * Total: 83
 */

const assert = require("assert");
const https  = require("https");
const { discordClient } = require("../../lib/discordClientOps");

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
function mockHttps(statusCode, body, extraHeaders) {
  const orig = https.request;
  https.request = (opts, cb) => {
    const EventEmitter = require("events").EventEmitter;
    const res = Object.assign(Object.create(EventEmitter.prototype), {
      statusCode,
      headers: Object.assign({ "content-type": "application/json" }, extraHeaders || {}),
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
  const r = await discordClient({ operation: "info" });
  assert.strictEqual(r.ok, true);
});

test("A02 info includes base_url with discord.com", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.base_url.includes("discord.com"));
});

test("A03 info includes api version v10", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.api.includes("v10"));
});

test("A04 info auth array is present", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(Array.isArray(r.auth));
  assert.ok(r.auth.length >= 2);
});

test("A05 info auth mentions Bot token", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(JSON.stringify(r.auth).includes("Bot"));
});

test("A06 info auth mentions Bearer", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(JSON.stringify(r.auth).toLowerCase().includes("bearer"));
});

test("A07 info operations is array", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(Array.isArray(r.operations));
});

test("A08 info operations mentions guild_get", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("guild_get"));
});

test("A09 info operations mentions message_send", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("message_send"));
});

test("A10 info operations mentions webhook_execute", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("webhook_execute"));
});

test("A11 info operations mentions member_ban", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("member_ban"));
});

test("A12 info operations mentions role_create", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("role_create"));
});

test("A13 info operations mentions reaction_add", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("reaction_add"));
});

test("A14 info operations mentions voice_regions", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("voice_regions"));
});

test("A15 info operations mentions interaction_respond", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("interaction_respond"));
});

test("A16 info operations mentions channel_typing", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("channel_typing"));
});

test("A17 info operations mentions user_me", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("user_me"));
});

test("A18 info operations mentions guild_bans", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("guild_bans"));
});

test("A19 info operations count >= 10", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.length >= 10);
});

test("A20 info operations are all strings", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.every(o => typeof o === "string"));
});

test("A21 info operations mentions message_bulk_delete", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("message_bulk_delete"));
});

test("A22 info operations mentions channel_create_dm", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("channel_create_dm"));
});

test("A23 info operations mentions role_assign", async () => {
  const r = await discordClient({ operation: "info" });
  assert.ok(r.operations.join(" ").includes("role_assign"));
});

test("A24 info works without token", async () => {
  const r = await discordClient({ operation: "info" });
  assert.strictEqual(r.ok, true);
});

test("A25 two sequential info calls return identical ok", async () => {
  const a = await discordClient({ operation: "info" });
  const b = await discordClient({ operation: "info" });
  assert.strictEqual(a.ok, b.ok);
  assert.strictEqual(a.api, b.api);
});

// ── Section B: input validation ───────────────────────────────────────────────
process.stderr.write("\nB: input validation\n");

test("B01 missing operation throws", async () => {
  try { await discordClient({}); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("operation")); }
});

test("B02 null args throws", async () => {
  try { await discordClient(null); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message); }
});

test("B03 unknown operation throws with op name", async () => {
  try { await discordClient({ operation: "blorp_zap", token: "Bot fake" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("blorp_zap")); }
});

test("B04 guild_get missing token throws", async () => {
  try { await discordClient({ operation: "guild_get", guild_id: "123" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("token")); }
});

test("B05 guild_get missing guild_id throws", async () => {
  try { await discordClient({ operation: "guild_get", token: "Bot tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("guild_id")); }
});

test("B06 channel_get missing channel_id throws", async () => {
  try { await discordClient({ operation: "channel_get", token: "Bot tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("channel_id")); }
});

test("B07 message_send missing channel_id throws", async () => {
  try { await discordClient({ operation: "message_send", token: "Bot tok", content: "hi" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("channel_id")); }
});

test("B08 message_send with no content/embeds/components throws", async () => {
  try { await discordClient({ operation: "message_send", token: "Bot tok", channel_id: "123" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("content") || e.message.includes("embeds")); }
});

test("B09 message_get missing message_id throws", async () => {
  try { await discordClient({ operation: "message_get", token: "Bot tok", channel_id: "123" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("message_id")); }
});

test("B10 member_get missing user_id throws", async () => {
  try { await discordClient({ operation: "member_get", token: "Bot tok", guild_id: "123" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("user_id")); }
});

test("B11 role_create missing guild_id throws", async () => {
  try { await discordClient({ operation: "role_create", token: "Bot tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("guild_id")); }
});

test("B12 webhook_create missing name throws", async () => {
  try { await discordClient({ operation: "webhook_create", token: "Bot tok", channel_id: "123" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("name")); }
});

test("B13 webhook_execute missing webhook_token throws", async () => {
  try { await discordClient({ operation: "webhook_execute", token: "Bot tok", webhook_id: "123", content: "hi" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("webhook_token")); }
});

test("B14 webhook_execute no content/embeds throws", async () => {
  try { await discordClient({ operation: "webhook_execute", token: "Bot tok", webhook_id: "123", webhook_token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("content") || e.message.includes("embeds")); }
});

test("B15 message_bulk_delete fewer than 2 IDs throws", async () => {
  try { await discordClient({ operation: "message_bulk_delete", token: "Bot tok", channel_id: "123", message_ids: ["1"] }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("message_ids")); }
});

test("B16 message_bulk_delete more than 100 IDs throws", async () => {
  try {
    await discordClient({ operation: "message_bulk_delete", token: "Bot tok", channel_id: "123",
      message_ids: Array.from({length:101}, (_,i) => String(i)) });
    assert.fail("should throw");
  } catch (e) { assert.ok(e.message.includes("message_ids")); }
});

test("B17 reaction_add missing emoji throws", async () => {
  try { await discordClient({ operation: "reaction_add", token: "Bot tok", channel_id: "123", message_id: "456" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("emoji")); }
});

test("B18 interaction_respond missing type throws", async () => {
  try { await discordClient({ operation: "interaction_respond", token: "Bot tok", interaction_id: "123", interaction_token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("type")); }
});

test("B19 interaction_followup missing content/embeds throws", async () => {
  try { await discordClient({ operation: "interaction_followup", token: "Bot tok", application_id: "123", interaction_token: "tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("content") || e.message.includes("embeds")); }
});

test("B20 guild_create name too short throws", async () => {
  try { await discordClient({ operation: "guild_create", token: "Bot tok", name: "A" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("name")); }
});

test("B21 webhook_create name empty throws", async () => {
  try { await discordClient({ operation: "webhook_create", token: "Bot tok", channel_id: "123", name: "" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("name")); }
});

test("B22 role_assign missing role_id throws", async () => {
  try { await discordClient({ operation: "role_assign", token: "Bot tok", guild_id: "123", user_id: "456" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("role_id")); }
});

test("B23 channel_create_dm missing recipient_id throws", async () => {
  try { await discordClient({ operation: "channel_create_dm", token: "Bot tok" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("recipient_id")); }
});

// ── Section C: mock-network ───────────────────────────────────────────────────
process.stderr.write("\nC: mock-network\n");

const GUILD_FIXTURE = {
  id: "guild-1", name: "Test Server", icon: null, description: null,
  owner_id: "owner-1", afk_timeout: 300, verification_level: 0,
  member_count: 42, approximate_presence_count: 10, features: [],
  premium_tier: 0, system_channel_id: null, rules_channel_id: null,
};

const MSG_FIXTURE = {
  id: "msg-1", channel_id: "chan-1", guild_id: "guild-1",
  content: "Hello world", timestamp: "2024-01-01T00:00:00.000Z",
  edited_timestamp: null, tts: false, mention_everyone: false,
  pinned: false, type: 0,
  author: { id: "u1", username: "Alice", discriminator: "0001", global_name: "Alice", bot: false },
  attachments: [], embeds: [], reactions: [], components: [],
};

test("C01 guild_get returns mapped guild", async () => {
  const restore = mockHttps(200, GUILD_FIXTURE);
  try {
    const r = await discordClient({ operation: "guild_get", token: "Bot fake", guild_id: "guild-1" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.guild.id, "guild-1");
    assert.strictEqual(r.guild.name, "Test Server");
  } finally { restore(); }
});

test("C02 guild_get 404 returns exists:false", async () => {
  const restore = mockHttps(404, { message: "Unknown Guild", code: 10004 });
  try {
    const r = await discordClient({ operation: "guild_get", token: "Bot fake", guild_id: "nonexistent" });
    assert.strictEqual(r.exists, false);
    assert.strictEqual(r.guild, null);
  } finally { restore(); }
});

test("C03 channel_get returns mapped channel", async () => {
  const restore = mockHttps(200, { id: "c1", type: 0, guild_id: "g1", name: "general",
    topic: null, nsfw: false, position: 0, parent_id: null });
  try {
    const r = await discordClient({ operation: "channel_get", token: "Bot fake", channel_id: "c1" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.channel.name, "general");
  } finally { restore(); }
});

test("C04 message_send returns sent:true", async () => {
  const restore = mockHttps(200, MSG_FIXTURE);
  try {
    const r = await discordClient({ operation: "message_send", token: "Bot fake", channel_id: "chan-1", content: "Hello" });
    assert.strictEqual(r.sent, true);
    assert.strictEqual(r.message.id, "msg-1");
    assert.strictEqual(r.message.content, "Hello world");
  } finally { restore(); }
});

test("C05 message_get returns mapped message", async () => {
  const restore = mockHttps(200, MSG_FIXTURE);
  try {
    const r = await discordClient({ operation: "message_get", token: "Bot fake", channel_id: "chan-1", message_id: "msg-1" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.message.author.username, "Alice");
  } finally { restore(); }
});

test("C06 message_delete 404 returns deleted:false", async () => {
  const restore = mockHttps(404, { message: "Unknown Message", code: 10008 });
  try {
    const r = await discordClient({ operation: "message_delete", token: "Bot fake", channel_id: "c1", message_id: "gone" });
    assert.strictEqual(r.deleted, false);
  } finally { restore(); }
});

test("C07 guild_members returns members array", async () => {
  const restore = mockHttps(200, [{
    user: { id: "u1", username: "Alice", discriminator: "0", global_name: "Alice", bot: false, avatar: null },
    nick: null, avatar: null, roles: [], joined_at: "2024-01-01T00:00:00.000Z",
    premium_since: null, deaf: false, mute: false, pending: false, permissions: "0",
  }]);
  try {
    const r = await discordClient({ operation: "guild_members", token: "Bot fake", guild_id: "g1" });
    assert.ok(Array.isArray(r.members));
    assert.strictEqual(r.members[0].user.username, "Alice");
    assert.strictEqual(r.count, 1);
  } finally { restore(); }
});

test("C08 guild_roles returns roles array", async () => {
  const restore = mockHttps(200, [
    { id: "r1", name: "Admin", color: 0xFF0000, hoist: true, position: 1, permissions: "8", managed: false, mentionable: true },
  ]);
  try {
    const r = await discordClient({ operation: "guild_roles", token: "Bot fake", guild_id: "g1" });
    assert.ok(Array.isArray(r.roles));
    assert.strictEqual(r.roles[0].name, "Admin");
  } finally { restore(); }
});

test("C09 user_me returns mapped user", async () => {
  const restore = mockHttps(200, { id: "me-1", username: "MyBot", discriminator: "0", global_name: null,
    avatar: null, bot: true, system: false, mfa_enabled: false, verified: true, email: null, flags: 0, premium_type: 0 });
  try {
    const r = await discordClient({ operation: "user_me", token: "Bot fake" });
    assert.strictEqual(r.user.username, "MyBot");
    assert.strictEqual(r.user.bot, true);
  } finally { restore(); }
});

test("C10 role_create returns created:true", async () => {
  const restore = mockHttps(200, { id: "r2", name: "Mods", color: 0x00FF00, hoist: false,
    position: 2, permissions: "0", managed: false, mentionable: false });
  try {
    const r = await discordClient({ operation: "role_create", token: "Bot fake", guild_id: "g1", name: "Mods" });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.role.name, "Mods");
  } finally { restore(); }
});

test("C11 webhook_create returns created:true", async () => {
  const restore = mockHttps(200, { id: "wh1", type: 1, guild_id: "g1", channel_id: "c1",
    name: "MyHook", avatar: null, url: null, application_id: null });
  try {
    const r = await discordClient({ operation: "webhook_create", token: "Bot fake", channel_id: "c1", name: "MyHook" });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.webhook.name, "MyHook");
    // token not in webhook output
    assert.ok(!JSON.stringify(r).includes('"token"'));
  } finally { restore(); }
});

test("C12 API error 403 propagates message", async () => {
  const restore = mockHttps(403, { message: "Missing Permissions", code: 50013 });
  try {
    await discordClient({ operation: "guild_delete", token: "Bot fake", guild_id: "g1" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e.message.includes("403") || e.message.includes("Permission"));
  } finally { restore(); }
});

test("C13 rate limit 429 throws with retry_after info", async () => {
  const restore = mockHttps(429, { message: "You are being rate limited.", retry_after: 1.5, global: false });
  try {
    await discordClient({ operation: "user_me", token: "Bot fake" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e.message.includes("429") || e.message.includes("rate"));
  } finally { restore(); }
});

test("C14 guild_list returns guilds array", async () => {
  const restore = mockHttps(200, [{ id: "g1", name: "Server 1", icon: null }]);
  try {
    const r = await discordClient({ operation: "guild_list", token: "Bot fake" });
    assert.ok(Array.isArray(r.guilds));
    assert.strictEqual(r.count, 1);
  } finally { restore(); }
});

test("C15 channel_messages returns messages array", async () => {
  const restore = mockHttps(200, [MSG_FIXTURE]);
  try {
    const r = await discordClient({ operation: "channel_messages", token: "Bot fake", channel_id: "c1" });
    assert.ok(Array.isArray(r.messages));
    assert.strictEqual(r.messages[0].id, "msg-1");
    assert.strictEqual(r.count, 1);
  } finally { restore(); }
});

test("C16 reaction_add returns added:true", async () => {
  const restore = mockHttps(204, "");
  try {
    const r = await discordClient({ operation: "reaction_add", token: "Bot fake",
      channel_id: "c1", message_id: "m1", emoji: "\uD83D\uDC4D" });
    assert.strictEqual(r.added, true);
  } finally { restore(); }
});

test("C17 generic request returns status and data", async () => {
  const restore = mockHttps(200, { id: "g1", name: "Guild" });
  try {
    const r = await discordClient({ operation: "request", token: "Bot fake", path: "/guilds/g1" });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data);
  } finally { restore(); }
});

// ── Section D: security ───────────────────────────────────────────────────────
process.stderr.write("\nD: security\n");

test("D01 NUL byte in token throws", async () => {
  try { await discordClient({ operation: "guild_get", token: "Bot tok\x00bad", guild_id: "g1" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D02 NUL byte in guild_id throws", async () => {
  try { await discordClient({ operation: "guild_get", token: "Bot tok", guild_id: "g1\x00" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D03 NUL byte in channel_id throws", async () => {
  try { await discordClient({ operation: "channel_get", token: "Bot tok", channel_id: "c1\x00" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D04 NUL byte in bearer_token throws", async () => {
  try { await discordClient({ operation: "user_me", bearer_token: "tok\x00" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("NUL")); }
});

test("D05 empty token throws", async () => {
  try { await discordClient({ operation: "guild_get", token: "", guild_id: "g1" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("token")); }
});

test("D06 empty guild_id throws", async () => {
  try { await discordClient({ operation: "guild_get", token: "Bot tok", guild_id: "" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e.message.includes("guild_id")); }
});

test("D07 token not echoed in API error message", async () => {
  const restore = mockHttps(401, { message: "401: Unauthorized", code: 0 });
  try {
    await discordClient({ operation: "user_me", token: "super_secret_bot_token_xyz" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!e.message.includes("super_secret_bot_token_xyz"), "token must not leak into error");
  } finally { restore(); }
});

test("D08 webhook_token not echoed in webhook output", async () => {
  const restore = mockHttps(204, "");
  try {
    const r = await discordClient({
      operation: "webhook_execute", token: "Bot tok",
      webhook_id: "wh1", webhook_token: "very_secret_webhook_token",
      content: "hi",
    });
    assert.ok(!JSON.stringify(r).includes("very_secret_webhook_token"), "webhook_token must not appear in output");
  } finally { restore(); }
});

test("D09 reject_unauthorized defaults true (captured in request options)", async () => {
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
            { id: "me", username: "Bot", discriminator: "0", global_name: null,
              avatar: null, bot: true, system: false, mfa_enabled: false,
              verified: true, email: null, flags: 0, premium_type: 0 }
          )));
          res.emit("end");
        }, 0);
      },
    });
    return req;
  };
  try {
    await discordClient({ operation: "user_me", token: "Bot tok" });
    assert.strictEqual(capturedOpts.rejectUnauthorized, true);
  } finally { https.request = orig; }
});

test("D10 timeout < 1000 is clamped (no crash)", async () => {
  const restore = mockHttps(200, { id: "me", username: "Bot", discriminator: "0",
    global_name: null, avatar: null, bot: true, system: false, mfa_enabled: false,
    verified: true, email: null, flags: 0, premium_type: 0 });
  try {
    await discordClient({ operation: "user_me", token: "Bot tok", timeout: 1 });
    // Should not crash — clamped to 1000ms
  } catch (e) {
    assert.ok(e.message.includes("ms") || e.message.includes("timed"));
  } finally { restore(); }
});

// ── Section E: concurrency ────────────────────────────────────────────────────
process.stderr.write("\nE: concurrency\n");

test("E01 8 concurrent info calls all succeed", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => discordClient({ operation: "info" })));
  assert.ok(results.every(r => r.ok === true));
});

test("E02 10 concurrent info calls return consistent api field", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => discordClient({ operation: "info" })));
  const api0 = results[0].api;
  assert.ok(results.every(r => r.api === api0));
});

test("E03 5 concurrent mock guild_get calls succeed independently", async () => {
  const EventEmitter = require("events").EventEmitter;
  const orig = https.request;
  https.request = (opts, cb) => {
    const parts = opts.path.split("/");
    const id = parts[2] ? parts[2].replace("?", "").split("?")[0] : "gX";
    const res = Object.assign(Object.create(EventEmitter.prototype), { statusCode: 200, headers: {} });
    const req = Object.assign(Object.create(EventEmitter.prototype), {
      write: () => {}, destroy: () => {},
      end: () => {
        cb(res);
        setTimeout(() => {
          res.emit("data", Buffer.from(JSON.stringify(
            { id, name: `Guild-${id}`, icon: null, description: null, owner_id: "o1",
              afk_timeout: 300, verification_level: 0, member_count: 1,
              approximate_presence_count: 0, features: [], premium_tier: 0,
              system_channel_id: null, rules_channel_id: null }
          )));
          res.emit("end");
        }, 5);
      },
    });
    return req;
  };
  try {
    const ids = ["g1", "g2", "g3", "g4", "g5"];
    const results = await Promise.all(ids.map(id =>
      discordClient({ operation: "guild_get", token: "Bot tok", guild_id: id })));
    assert.ok(results.every(r => r.exists === true));
  } finally { https.request = orig; }
});

test("E04 mixed concurrent ops: info+validation work correctly", async () => {
  const results = await Promise.all([
    discordClient({ operation: "info" }),
    discordClient({}).catch(e => ({ error: e.message })),
    discordClient({ operation: "info" }),
    discordClient({ operation: "guild_get", token: "Bot tok" }).catch(e => ({ error: e.message })),
    discordClient({ operation: "info" }),
  ]);
  assert.strictEqual(results[0].ok, true);
  assert.ok(results[1].error.includes("operation"));
  assert.strictEqual(results[2].ok, true);
  assert.ok(results[3].error.includes("guild_id"));
  assert.strictEqual(results[4].ok, true);
});

test("E05 concurrent validation errors have correct field names", async () => {
  const msgs = await Promise.all([
    discordClient({ operation: "guild_get",   token: "Bot tok" }).catch(e => e.message),
    discordClient({ operation: "channel_get", token: "Bot tok" }).catch(e => e.message),
    discordClient({ operation: "message_get", token: "Bot tok", channel_id: "c1" }).catch(e => e.message),
    discordClient({ operation: "member_get",  token: "Bot tok", guild_id: "g1" }).catch(e => e.message),
  ]);
  assert.ok(msgs[0].includes("guild_id"));
  assert.ok(msgs[1].includes("channel_id"));
  assert.ok(msgs[2].includes("message_id"));
  assert.ok(msgs[3].includes("user_id"));
});

test("E06 5 concurrent mock message_send calls return independent messages", async () => {
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
          res.emit("data", Buffer.from(JSON.stringify({
            id: `msg-${idx}`, channel_id: "c1", guild_id: "g1",
            content: `msg${idx}`, timestamp: "2024-01-01T00:00:00.000Z",
            edited_timestamp: null, tts: false, mention_everyone: false,
            pinned: false, type: 0,
            author: { id: "bot", username: "Bot", discriminator: "0", global_name: null, bot: true },
            attachments: [], embeds: [], reactions: [], components: [],
          })));
          res.emit("end");
        }, 5);
      },
    });
    return req;
  };
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      discordClient({ operation: "message_send", token: "Bot tok", channel_id: "c1", content: "hi" })));
    assert.ok(results.every(r => r.sent === true));
    const ids = results.map(r => r.message.id);
    assert.strictEqual(new Set(ids).size, 5);
  } finally { https.request = orig; }
});

test("E07 20 concurrent info calls are all idempotent", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => discordClient({ operation: "info" })));
  assert.ok(results.every(r => r.ok === true && typeof r.api === "string"));
});

test("E08 concurrent NUL-byte errors all throw with NUL in message", async () => {
  const msgs = await Promise.all([
    discordClient({ operation: "guild_get", token: "tok\x00", guild_id: "g1" }).catch(e => e.message),
    discordClient({ operation: "channel_get", token: "Bot tok", channel_id: "c\x00" }).catch(e => e.message),
    discordClient({ operation: "user_get", token: "Bot tok", user_id: "u\x00" }).catch(e => e.message),
  ]);
  assert.ok(msgs.every(m => m.includes("NUL")));
});

// ── Final report ──────────────────────────────────────────────────────────────
setTimeout(() => {
  process.stderr.write(`\n281-discord-client: ${passed}/${total} passed`);
  if (failed > 0) {
    process.stderr.write(`, ${failed} failed`);
    process.stderr.write("\n");
    process.exit(1);
  }
  process.stderr.write("\n");
  process.exit(0);
}, 500);
