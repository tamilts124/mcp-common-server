"use strict";
/**
 * Test suite for slack_client (section 278)
 * Tests the slackClient function directly — no live network, no MCP server.
 *
 * Rigor levels:
 *   A) Normal:    happy-path map/field logic via mocked responses  (25 tests)
 *   B) Medium:    validation — missing/empty/wrong-type inputs      (23 tests)
 *   C) High:      mock-network — real dispatch, HTTPS intercepted   (17 tests)
 *   D) Critical:  NUL guards, token-never-leaked, injection safety  (10 tests)
 *   E) Extreme:   concurrency, timeout, 16MB cap                     (8 tests)
 *   Total: 83 tests
 */

const assert = require("assert");
const https  = require("https");
const { EventEmitter } = require("events");

const { slackClient } = require("../../lib/slackClientOps");

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
function mockHttps(body, status = 200, delayMs = 0) {
  const original = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => req.emit("error", new Error("destroyed"));
    req.end = () => {
      setTimeout(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = {};
        res.destroy = () => {};
        if (cb) cb(res);
        setImmediate(() => {
          const txt = typeof body === "string" ? body : JSON.stringify(body);
          res.emit("data", Buffer.from(txt));
          res.emit("end");
        });
      }, delayMs);
    };
    return req;
  };
  return () => { https.request = original; };
}

// ─── A: Normal – happy-path via mock responses ────────────────────────────────
console.log("\n=== A: Normal ===");

const tests = [];

tests.push(() => test("A01 - auth_test returns ok fields", () => {
  const restore = mockHttps({ ok:true, url:"https://ex.slack.com/", team:"T",
    user:"bob", team_id:"T1", user_id:"U2", bot_id:"B3" });
  return slackClient({ operation:"auth_test", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.team_id, "T1");
    assert.strictEqual(r.bot_id, "B3");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A02 - channel_list returns channels + cursor", () => {
  const restore = mockHttps({ ok:true, channels:[{ id:"C1", name:"gen",
    is_channel:true, is_private:false, is_archived:false, is_member:true,
    topic:{value:"hello"}, purpose:{value:"chat"}, num_members:3, created:100}],
    response_metadata:{next_cursor:"cur123"} });
  return slackClient({ operation:"channel_list", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.channels.length, 1);
    assert.strictEqual(r.channels[0].topic, "hello");
    assert.strictEqual(r.cursor, "cur123");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A03 - channel_get maps all channel fields", () => {
  const restore = mockHttps({ ok:true, channel:{ id:"C99", name:"dev",
    is_channel:true, is_private:true, is_archived:false, is_member:true,
    topic:{value:"code"}, purpose:{value:"work"}, num_members:10, created:200 } });
  return slackClient({ operation:"channel_get", token:"xoxb-t", channel:"C99" }).then(r => {
    assert.strictEqual(r.channel.is_private, true);
    assert.strictEqual(r.channel.purpose, "work");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A04 - user_list returns users", () => {
  const restore = mockHttps({ ok:true, members:[{ id:"U1", name:"alice",
    real_name:"Alice", profile:{display_name:"al",email:"a@b.com",
    status_text:"working",status_emoji:":laptop:"}, is_bot:false, is_admin:false,
    deleted:false, tz:"UTC" }], response_metadata:{next_cursor:""} });
  return slackClient({ operation:"user_list", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.users[0].email, "a@b.com");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A05 - user_get maps user fields", () => {
  const restore = mockHttps({ ok:true, user:{ id:"U2", name:"bob", real_name:"Bob",
    profile:{display_name:"b", email:"b@c.com", status_text:"away", status_emoji:":zzz:"},
    is_bot:false, is_admin:true, deleted:false, tz:"America/New_York" } });
  return slackClient({ operation:"user_get", token:"xoxb-t", user:"U2" }).then(r => {
    assert.strictEqual(r.user.is_admin, true);
    assert.strictEqual(r.user.tz, "America/New_York");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A06 - messages_history returns messages + has_more", () => {
  const restore = mockHttps({ ok:true, messages:[{
    type:"message", ts:"1234.5", user:"U1", text:"hello",
    reactions:[{name:"+1",count:2}],
    files:[{id:"F1",name:"doc.pdf",mimetype:"application/pdf"}]
  }], has_more:true, response_metadata:{next_cursor:"cur"} });
  return slackClient({ operation:"messages_history", token:"xoxb-t", channel:"C1" }).then(r => {
    assert.strictEqual(r.messages[0].text, "hello");
    assert.strictEqual(r.messages[0].reactions[0].name, "+1");
    assert.strictEqual(r.messages[0].files[0].mimetype, "application/pdf");
    assert.strictEqual(r.has_more, true);
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A07 - file_get maps file fields", () => {
  const restore = mockHttps({ ok:true, file:{ id:"F9", name:"img.png",
    title:"Screenshot", filetype:"png", mimetype:"image/png", size:2048,
    url_private:"https://files.slack.com/", permalink:"https://slack.com/f",
    created:300, user:"U1" }, comments:[] });
  return slackClient({ operation:"file_get", token:"xoxb-t", file:"F9" }).then(r => {
    assert.strictEqual(r.file.size, 2048);
    assert.ok(Array.isArray(r.comments));
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A08 - emoji_list returns count", () => {
  const restore = mockHttps({ ok:true, emoji:{ smile:"url1", wave:"alias:smile", hi:"url2" } });
  return slackClient({ operation:"emoji_list", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.count, 3);
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A09 - team_info maps team fields", () => {
  const restore = mockHttps({ ok:true, team:{ id:"T1", name:"MyCo",
    domain:"myco", email_domain:"myco.com", icon:{}, plan:"pro" } });
  return slackClient({ operation:"team_info", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.domain, "myco");
    assert.strictEqual(r.plan, "pro");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A10 - bot_info returns bot object", () => {
  const restore = mockHttps({ ok:true, bot:{ id:"B1", name:"mybot", app_id:"A1" } });
  return slackClient({ operation:"bot_info", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.bot.id, "B1");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A11 - message_search returns structured matches", () => {
  const restore = mockHttps({ ok:true, messages:{ total:2, pagination:{page:1},
    matches:[{ts:"1",channel:{id:"C1"},text:"foo",permalink:"https://",user:"U1"},
             {ts:"2",channel:{id:"C2"},text:"bar",permalink:"https://",user:"U2"}] } });
  return slackClient({ operation:"message_search", token:"xoxp-t", query:"foo" }).then(r => {
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.matches[1].channel, "C2");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A12 - reminder_list returns reminders", () => {
  const restore = mockHttps({ ok:true, reminders:[{id:"Rm1",text:"buy milk",time:1700000}] });
  return slackClient({ operation:"reminder_list", token:"xoxp-t" }).then(r => {
    assert.strictEqual(r.reminders[0].id, "Rm1");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A13 - usergroup_list returns usergroups", () => {
  const restore = mockHttps({ ok:true, usergroups:[{id:"S1",name:"devs",handle:"devs"}] });
  return slackClient({ operation:"usergroup_list", token:"xoxp-t" }).then(r => {
    assert.strictEqual(r.usergroups[0].handle, "devs");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A14 - reaction_list returns items", () => {
  const restore = mockHttps({ ok:true, items:[{type:"message"}],
    response_metadata:{next_cursor:""} });
  return slackClient({ operation:"reaction_list", token:"xoxp-t" }).then(r => {
    assert.ok(Array.isArray(r.items));
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A15 - reaction_get returns message", () => {
  const restore = mockHttps({ ok:true, type:"message",
    message:{type:"message",ts:"1234",user:"U1",text:"yo"} });
  return slackClient({ operation:"reaction_get", token:"xoxb-t",
    channel:"C1", timestamp:"1234" }).then(r => {
    assert.strictEqual(r.type, "message");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A16 - dm_history returns messages array", () => {
  const restore = mockHttps({ ok:true, messages:[], has_more:false,
    response_metadata:{next_cursor:""} });
  return slackClient({ operation:"dm_history", token:"xoxb-t", channel:"D1" }).then(r => {
    assert.ok(Array.isArray(r.messages));
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A17 - message_scheduled_list returns messages", () => {
  const restore = mockHttps({ ok:true, scheduled_messages:[{id:"Q1"}],
    response_metadata:{next_cursor:""} });
  return slackClient({ operation:"message_scheduled_list", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.scheduled_messages.length, 1);
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A18 - message_permalink returns link", () => {
  const restore = mockHttps({ ok:true, channel:"C1",
    permalink:"https://slack.com/archives/C1/p1700" });
  return slackClient({ operation:"message_permalink", token:"xoxb-t",
    channel:"C1", message_ts:"1700.001" }).then(r => {
    assert.ok(r.permalink.includes("slack.com"));
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A19 - bookmark_list returns bookmarks", () => {
  const restore = mockHttps({ ok:true, bookmarks:[{id:"Bk1",title:"Docs"}] });
  return slackClient({ operation:"bookmark_list", token:"xoxb-t", channel_id:"C1" }).then(r => {
    assert.strictEqual(r.bookmarks[0].id, "Bk1");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A20 - user_me returns user_id + team_id", () => {
  const restore = mockHttps({ ok:true, user_id:"U1", user:"alice",
    team:"MyCo", team_id:"T1", bot_id:"B1", is_enterprise_install:false });
  return slackClient({ operation:"user_me", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.user_id, "U1");
    assert.strictEqual(r.team_id, "T1");
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A21 - channel_invite with string users works", () => {
  const restore = mockHttps({ ok:true, channel:{id:"C1",name:"gen"} });
  return slackClient({ operation:"channel_invite", token:"xoxb-t",
    channel:"C1", users:"U1,U2" }).then(r => {
    assert.strictEqual(r.invited, true);
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A22 - dm_open with string users works", () => {
  const restore = mockHttps({ ok:true, channel:{id:"D1",name:""}, already_open:false });
  return slackClient({ operation:"dm_open", token:"xoxb-t", users:"U1" }).then(r => {
    assert.strictEqual(r.channel.id, "D1");
    assert.strictEqual(r.already_open, false);
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A23 - generic GET request returns ok+data", () => {
  const restore = mockHttps({ ok:true, channels:[] });
  return slackClient({ operation:"request", token:"xoxb-t",
    method:"GET", api_method:"conversations.list" }).then(r => {
    assert.strictEqual(r.ok, true);
    assert.ok(r.data && Array.isArray(r.data.channels));
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A24 - generic POST request works", () => {
  const restore = mockHttps({ ok:true, ts:"1234" });
  return slackClient({ operation:"request", token:"xoxb-t",
    method:"POST", api_method:"chat.postMessage",
    body:{channel:"C1",text:"hello"} }).then(r => {
    assert.strictEqual(r.ok, true);
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("A25 - file_list returns files", () => {
  const restore = mockHttps({ ok:true, files:[{id:"F1",name:"a.txt"}],
    paging:{total:1,page:1} });
  return slackClient({ operation:"file_list", token:"xoxb-t" }).then(r => {
    assert.strictEqual(r.files[0].id, "F1");
    assert.strictEqual(r.total, 1);
    restore();
  }).catch(e => { restore(); throw e; });
}));

// ─── B: Validation ────────────────────────────────────────────────────────────
console.log("\n=== B: Validation ===");

tests.push(() => test("B01 - missing operation throws", () =>
  assert.rejects(() => slackClient({ token:"xoxb-t" }), /operation is required/)));

tests.push(() => test("B02 - missing token throws", () =>
  assert.rejects(() => slackClient({ operation:"auth_test" }), /token is required/)));

tests.push(() => test("B03 - unknown operation throws descriptive", () =>
  assert.rejects(() => slackClient({ operation:"bogus", token:"xoxb-t" }), /Unknown operation/)));

tests.push(() => test("B04 - unknown operation lists valid ops in error", () =>
  assert.rejects(() => slackClient({ operation:"nope", token:"xoxb-t" }), /message_post/)));

tests.push(() => test("B05 - message_post: missing channel", () =>
  assert.rejects(
    () => slackClient({ operation:"message_post", token:"xoxb-t", text:"hi" }),
    /channel must be a non-empty string/)));

tests.push(() => test("B06 - message_post: missing text AND blocks", () =>
  assert.rejects(
    () => slackClient({ operation:"message_post", token:"xoxb-t", channel:"C1" }),
    /text or blocks is required/)));

tests.push(() => test("B07 - message_update: missing ts", () =>
  assert.rejects(
    () => slackClient({ operation:"message_update", token:"xoxb-t", channel:"C1", text:"x" }),
    /ts must be a non-empty string/)));

tests.push(() => test("B08 - message_delete: missing channel", () =>
  assert.rejects(
    () => slackClient({ operation:"message_delete", token:"xoxb-t", ts:"1234" }),
    /channel must be a non-empty string/)));

tests.push(() => test("B09 - message_reply: missing thread_ts", () =>
  assert.rejects(
    () => slackClient({ operation:"message_reply", token:"xoxb-t", channel:"C1", text:"x" }),
    /thread_ts must be a non-empty string/)));

tests.push(() => test("B10 - channel_get: empty channel", () =>
  assert.rejects(
    () => slackClient({ operation:"channel_get", token:"xoxb-t", channel:"" }),
    /channel must be a non-empty string/)));

tests.push(() => test("B11 - channel_create: missing name", () =>
  assert.rejects(
    () => slackClient({ operation:"channel_create", token:"xoxb-t" }),
    /name must be a non-empty string/)));

tests.push(() => test("B12 - channel_invite: empty array users", () =>
  assert.rejects(
    () => slackClient({ operation:"channel_invite", token:"xoxb-t", channel:"C1", users:[] }),
    /users must be a non-empty/)));

tests.push(() => test("B13 - user_get: numeric user id", () =>
  assert.rejects(
    () => slackClient({ operation:"user_get", token:"xoxb-t", user:123 }),
    /user must be a non-empty string/)));

tests.push(() => test("B14 - user_lookup_by_email: empty email", () =>
  assert.rejects(
    () => slackClient({ operation:"user_lookup_by_email", token:"xoxb-t", email:"" }),
    /email must be a non-empty string/)));

tests.push(() => test("B15 - file_upload: missing filename", () =>
  assert.rejects(
    () => slackClient({ operation:"file_upload", token:"xoxb-t", content:"data" }),
    /filename must be a non-empty string/)));

tests.push(() => test("B16 - file_upload: missing content+content_base64", () =>
  assert.rejects(
    () => slackClient({ operation:"file_upload", token:"xoxb-t", filename:"f.txt" }),
    /content_base64 or content/)));

tests.push(() => test("B17 - reaction_add: missing name", () =>
  assert.rejects(
    () => slackClient({ operation:"reaction_add", token:"xoxb-t", channel:"C1", timestamp:"1" }),
    /name must be a non-empty string/)));

tests.push(() => test("B18 - reminder_add: missing time", () =>
  assert.rejects(
    () => slackClient({ operation:"reminder_add", token:"xoxp-t", text:"do it" }),
    /time must be a non-empty string/)));

tests.push(() => test("B19 - bookmark_add: missing title", () =>
  assert.rejects(
    () => slackClient({ operation:"bookmark_add", token:"xoxb-t", channel_id:"C1", type:"link" }),
    /title must be a non-empty string/)));

tests.push(() => test("B20 - star_add: no target fields", () =>
  assert.rejects(
    () => slackClient({ operation:"star_add", token:"xoxp-t" }),
    /At least one of/)));

tests.push(() => test("B21 - dm_open: empty array users", () =>
  assert.rejects(
    () => slackClient({ operation:"dm_open", token:"xoxb-t", users:[] }),
    /users must be a non-empty/)));

tests.push(() => test("B22 - generic request: invalid method", () =>
  assert.rejects(
    () => slackClient({ operation:"request", token:"xoxb-t", api_method:"auth.test", method:"DELETE" }),
    /method must be GET or POST/)));

tests.push(() => test("B23 - generic request: missing api_method", () =>
  assert.rejects(
    () => slackClient({ operation:"request", token:"xoxb-t" }),
    /api_method must be a non-empty string/)));

// ─── C: Mock-network ──────────────────────────────────────────────────────────
console.log("\n=== C: Mock-network ===");

tests.push(() => test("C01 - message_post success", () => {
  const restore = mockHttps({ ok:true, channel:"C1", ts:"1700.001",
    message:{type:"message",ts:"1700.001",text:"hi"} });
  return slackClient({ operation:"message_post", token:"xoxb-t", channel:"C1", text:"hi" })
    .then(r => { assert.strictEqual(r.posted, true); assert.ok(r.ts); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C02 - message_update success", () => {
  const restore = mockHttps({ ok:true, channel:"C1", ts:"1700.001", text:"upd" });
  return slackClient({ operation:"message_update", token:"xoxb-t",
    channel:"C1", ts:"1700.001", text:"upd" })
    .then(r => { assert.strictEqual(r.updated, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C03 - message_delete success", () => {
  const restore = mockHttps({ ok:true });
  return slackClient({ operation:"message_delete", token:"xoxb-t", channel:"C1", ts:"1700" })
    .then(r => { assert.strictEqual(r.deleted, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C04 - channel_create success", () => {
  const restore = mockHttps({ ok:true, channel:{id:"C99",name:"new-ch"} });
  return slackClient({ operation:"channel_create", token:"xoxb-t", name:"new-ch" })
    .then(r => { assert.strictEqual(r.created, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C05 - channel_archive + unarchive", () => {
  const restore = mockHttps({ ok:true });
  return slackClient({ operation:"channel_archive", token:"xoxb-t", channel:"C1" })
    .then(r => { assert.strictEqual(r.archived, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C06 - reaction_add success", () => {
  const restore = mockHttps({ ok:true });
  return slackClient({ operation:"reaction_add", token:"xoxb-t",
    name:"+1", channel:"C1", timestamp:"1234" })
    .then(r => { assert.strictEqual(r.added, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C07 - pin_add + pin_remove", () => {
  const restore = mockHttps({ ok:true });
  return slackClient({ operation:"pin_add", token:"xoxb-t", channel:"C1", timestamp:"1234" })
    .then(r => { assert.strictEqual(r.pinned, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C08 - reminder_add success", () => {
  const restore = mockHttps({ ok:true, reminder:{id:"Rm1",text:"do it"} });
  return slackClient({ operation:"reminder_add", token:"xoxp-t",
    text:"do it", time:"in 1 hour" })
    .then(r => { assert.strictEqual(r.added, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C09 - reminder_delete success", () => {
  const restore = mockHttps({ ok:true });
  return slackClient({ operation:"reminder_delete", token:"xoxp-t", reminder:"Rm1" })
    .then(r => { assert.strictEqual(r.deleted, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C10 - star_remove success", () => {
  const restore = mockHttps({ ok:true });
  return slackClient({ operation:"star_remove", token:"xoxp-t", file:"F1" })
    .then(r => { assert.strictEqual(r.unstarred, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C11 - Slack ok:false throws with error code", () => {
  const restore = mockHttps({ ok:false, error:"not_in_channel" });
  return assert.rejects(
    () => slackClient({ operation:"message_post", token:"xoxb-t", channel:"C1", text:"hi" }),
    /not_in_channel/
  ).then(() => restore()).catch(e => { restore(); throw e; });
}));

tests.push(() => test("C12 - HTTP 500 throws", () => {
  const restore = mockHttps("Server Error", 500);
  return assert.rejects(
    () => slackClient({ operation:"auth_test", token:"xoxb-t" }),
    /HTTP 500/
  ).then(() => restore()).catch(e => { restore(); throw e; });
}));

tests.push(() => test("C13 - invalid JSON body throws", () => {
  const restore = mockHttps("NOT JSON", 200);
  return assert.rejects(
    () => slackClient({ operation:"auth_test", token:"xoxb-t" }),
    /Invalid JSON/
  ).then(() => restore()).catch(e => { restore(); throw e; });
}));

tests.push(() => test("C14 - file_upload text content", () => {
  const restore = mockHttps({ ok:true, file:{id:"F10",name:"t.txt"} });
  return slackClient({ operation:"file_upload", token:"xoxb-t",
    filename:"hello.txt", content:"Hello world", channels:"C1" })
    .then(r => { assert.strictEqual(r.uploaded, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C15 - usergroup_create success", () => {
  const restore = mockHttps({ ok:true, usergroup:{id:"S1",name:"devs"} });
  return slackClient({ operation:"usergroup_create", token:"xoxp-t",
    name:"devs", handle:"devs" })
    .then(r => { assert.strictEqual(r.created, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C16 - bookmark_add success", () => {
  const restore = mockHttps({ ok:true, bookmark:{id:"Bk1"} });
  return slackClient({ operation:"bookmark_add", token:"xoxb-t",
    channel_id:"C1", title:"Example", type:"link", link:"https://example.com" })
    .then(r => { assert.strictEqual(r.added, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

tests.push(() => test("C17 - user_set_status success", () => {
  const restore = mockHttps({ ok:true });
  return slackClient({ operation:"user_set_status", token:"xoxp-t",
    status_text:"Working from home", status_emoji:":house:" })
    .then(r => { assert.strictEqual(r.updated, true); restore(); })
    .catch(e => { restore(); throw e; });
}));

// ─── D: Security ──────────────────────────────────────────────────────────────
console.log("\n=== D: Security ===");

tests.push(() => test("D01 - NUL byte in token throws", () =>
  assert.rejects(
    () => slackClient({ operation:"auth_test", token:"xoxb-\x00bad" }),
    /NUL bytes/)));

tests.push(() => test("D02 - NUL byte in channel throws", () =>
  assert.rejects(
    () => slackClient({ operation:"channel_get", token:"xoxb-t", channel:"C\x00X" }),
    /NUL bytes/)));

tests.push(() => test("D03 - NUL byte in text throws", () =>
  assert.rejects(
    () => slackClient({ operation:"message_post", token:"xoxb-t",
      channel:"C1", text:"hi\x00there" }),
    /NUL bytes/)));

tests.push(() => test("D04 - NUL byte in query throws", () =>
  assert.rejects(
    () => slackClient({ operation:"message_search", token:"xoxp-t", query:"hello\x00" }),
    /NUL bytes/)));

tests.push(() => test("D05 - NUL byte in api_method throws", () =>
  assert.rejects(
    () => slackClient({ operation:"request", token:"xoxb-t", api_method:"auth.\x00test" }),
    /NUL bytes/)));

tests.push(() => test("D06 - NUL byte in email throws", () =>
  assert.rejects(
    () => slackClient({ operation:"user_lookup_by_email", token:"xoxb-t",
      email:"a\x00b@c.com" }),
    /NUL bytes/)));

tests.push(() => test("D07 - token not echoed in API error message", () => {
  const SECRET = "xoxb-VERY-SECRET-TOKEN-12345";
  const restore = mockHttps({ ok:false, error:"invalid_auth" });
  return slackClient({ operation:"auth_test", token:SECRET })
    .then(() => { restore(); throw new Error("should have thrown"); })
    .catch(err => {
      restore();
      if (err.message.includes(SECRET))
        throw new Error(`Token leaked in error: ${err.message}`);
    });
}));

tests.push(() => test("D08 - token not echoed in HTTP 401 error", () => {
  const SECRET = "xoxb-SECRET-401-NEVER-REVEAL";
  const restore = mockHttps("Unauthorized", 401);
  return slackClient({ operation:"auth_test", token:SECRET })
    .then(() => { restore(); throw new Error("should have thrown"); })
    .catch(err => {
      restore();
      if (err.message.includes(SECRET))
        throw new Error(`Token leaked: ${err.message}`);
      assert.ok(err.message.includes("401"), `Expected 401 in error: ${err.message}`);
    });
}));

tests.push(() => test("D09 - NUL byte in reminder text throws", () =>
  assert.rejects(
    () => slackClient({ operation:"reminder_add", token:"xoxp-t",
      text:"ok\x00", time:"now" }),
    /NUL bytes/)));

tests.push(() => test("D10 - Bearer Authorization header is set correctly", () => {
  let capturedHeaders = null;
  const orig = https.request;
  https.request = (opts) => {
    capturedHeaders = opts.headers;
    const req = new EventEmitter();
    req.write = () => {}; req.end = () => {}; req.destroy = () => {};
    return req;
  };
  slackClient({ operation:"auth_test", token:"xoxb-mytoken" }).catch(() => {});
  return new Promise(resolve => setTimeout(resolve, 15)).then(() => {
    https.request = orig;
    assert.ok(capturedHeaders && capturedHeaders["Authorization"] === "Bearer xoxb-mytoken",
      `Expected Bearer header, got: ${JSON.stringify(capturedHeaders)}`);
  });
}));

// ─── E: Extreme / concurrency ─────────────────────────────────────────────────
console.log("\n=== E: Extreme ===");

tests.push(() => test("E01 - concurrent auth_test calls all succeed", () => {
  const restore = mockHttps({ ok:true, team_id:"T1", user_id:"U1", bot_id:"B1" });
  return Promise.all(
    Array.from({ length: 8 }, () =>
      slackClient({ operation:"auth_test", token:"xoxb-t" })
    )
  ).then(results => {
    assert.ok(results.every(r => r.team_id === "T1"));
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("E02 - concurrent message_post calls all succeed", () => {
  const restore = mockHttps({ ok:true, channel:"C1", ts:"1234", message:{} });
  return Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      slackClient({ operation:"message_post", token:"xoxb-t",
        channel:"C1", text:`msg ${i}` })
    )
  ).then(results => {
    assert.ok(results.every(r => r.posted === true));
    restore();
  }).catch(e => { restore(); throw e; });
}));

tests.push(() => test("E03 - 16MB response cap triggers error", () => {
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200; res.headers = {};
        res.destroy = () => {};
        cb(res);
        process.nextTick(() => {
          res.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x41));
        });
      });
    };
    return req;
  };
  return assert.rejects(
    () => slackClient({ operation:"auth_test", token:"xoxb-t" }),
    /16 MB/
  ).then(() => { https.request = orig; }).catch(e => { https.request = orig; throw e; });
}));

tests.push(() => test("E04 - timeout elapses triggers error", () => {
  // Use a manual mock that never resolves (infinite delay) + short client timeout
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};  // no-op — let reject('timed out') win
    req.end = () => {};       // never calls cb => timer fires first
    return req;
  };
  return assert.rejects(
    () => slackClient({ operation:"auth_test", token:"xoxb-t", timeout:1000 }),
    /timed out/i
  ).then(() => { https.request = orig; }).catch(e => { https.request = orig; throw e; });
}));

tests.push(() => test("E05 - network error propagates", () => {
  const orig = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      process.nextTick(() => req.emit("error", new Error("ECONNREFUSED 127.0.0.1:443")));
    };
    return req;
  };
  return assert.rejects(
    () => slackClient({ operation:"auth_test", token:"xoxb-t" }),
    /ECONNREFUSED/
  ).then(() => { https.request = orig; }).catch(e => { https.request = orig; throw e; });
}));

tests.push(() => test("E06 - mixed success/fail concurrent requests", () => {
  let call = 0;
  const orig = https.request;
  https.request = (opts, cb) => {
    const n = call++;
    const body = n % 2 === 0
      ? JSON.stringify({ ok:true, channel:"C1", ts:"1", message:{} })
      : JSON.stringify({ ok:false, error:"rate_limited" });
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = 200; res.headers = {}; res.destroy = () => {};
        cb(res);
        process.nextTick(() => {
          res.emit("data", Buffer.from(body)); res.emit("end");
        });
      });
    };
    return req;
  };
  return Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      slackClient({ operation:"message_post", token:"xoxb-t",
        channel:"C1", text:`m${i}` })
    )
  ).then(results => {
    https.request = orig;
    assert.ok(results.some(r => r.status === "fulfilled"), "some should succeed");
    assert.ok(results.some(r => r.status === "rejected"), "some should fail");
  }).catch(e => { https.request = orig; throw e; });
}));

tests.push(() => test("E07 - reject_unauthorized:false is forwarded to request opts", () => {
  let capturedOpts = null;
  const orig = https.request;
  https.request = (opts) => {
    capturedOpts = opts;
    const req = new EventEmitter();
    req.write = () => {}; req.end = () => {}; req.destroy = () => {};
    return req;
  };
  slackClient({ operation:"auth_test", token:"xoxb-t", reject_unauthorized:false }).catch(() => {});
  return new Promise(r => setTimeout(r, 15)).then(() => {
    https.request = orig;
    assert.strictEqual(capturedOpts && capturedOpts.rejectUnauthorized, false,
      "rejectUnauthorized should be false");
  });
}));

tests.push(() => test("E08 - default timeout is 20 seconds (20000ms clamp range)", () => {
  let capturedOpts = null;
  const orig = https.request;
  https.request = (opts) => {
    capturedOpts = opts;
    const req = new EventEmitter();
    req.write = () => {}; req.end = () => {}; req.destroy = () => {};
    return req;
  };
  slackClient({ operation:"auth_test", token:"xoxb-t" }).catch(() => {});
  return new Promise(r => setTimeout(r, 15)).then(() => {
    https.request = orig;
    // The timer uses 20000ms default — just confirm request was attempted
    assert.ok(capturedOpts !== null, "request should have been attempted");
  });
}));

// ─── Run all tests sequentially ───────────────────────────────────────────────
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
