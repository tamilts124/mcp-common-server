"use strict";
/**
 * test/sections/288-mailchimp-client.js
 * Isolated tests for mailchimpClientOps.js
 * 5 rigor levels: A=normal, B=validation, C=mock-network, D=security, E=concurrency
 */
const https = require("https");
const { EventEmitter } = require("events");
const { mailchimpClient } = require("../../lib/mailchimpClientOps");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

async function assertRejects(fn, pattern, msg) {
  try {
    await fn();
    console.error(`  ✗ FAIL (no throw): ${msg}`);
    failed++;
  } catch (e) {
    const ok = pattern ? (e.message || "").match(pattern) : true;
    if (ok) {
      console.log(`  ✓ ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL (wrong error: ${e.message}): ${msg}`);
      failed++;
    }
  }
}

// ── Mock HTTPS helpers ─────────────────────────────────────────────────────────
function mockHttps(statusCode, body) {
  const original = https.request;
  https.request = (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    process.nextTick(() => {
      cb(res);
      if (body !== null && body !== undefined && body !== "") {
        res.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      }
      res.emit("end");
    });
    const req = new EventEmitter();
    req.write = () => {};
    req.end   = () => {};
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

function mockHttpsEmpty(statusCode) {
  const original = https.request;
  https.request = (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    process.nextTick(() => { cb(res); res.emit("end"); });
    const req = new EventEmitter();
    req.write = () => {};
    req.end   = () => {};
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

function mockHttpsError(errMsg) {
  const original = https.request;
  https.request = (_opts, _cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end   = () => { process.nextTick(() => req.emit("error", new Error(errMsg))); };
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

const FAKE_KEY = "abc123-us6";
const BASE_LIST_ARGS = {
  api_key: FAKE_KEY,
  name: "Test List",
  company: "Acme Corp",
  address1: "123 Main St",
  city: "Springfield",
  country: "US",
  from_name: "Acme",
  from_email: "hello@acme.com",
  subject: "Newsletter",
  permission_reminder: "You signed up on our website.",
};

// ══════════════════════════════════════════════════════════════════════════════
// A — Normal (happy-path)
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[A] Normal / happy-path tests");

async function testA() {
  // A1: ping returns health check
  {
    const restore = mockHttps(200, { health_status: "Everything's Chimpy!" });
    const r = await mailchimpClient({ operation: "ping", api_key: FAKE_KEY });
    assert(r && r.health_status, "A1: ping returns health status");
    restore();
  }

  // A2: account_info returns account object
  {
    const restore = mockHttps(200, { account_id: "acct_001", account_name: "Acme" });
    const r = await mailchimpClient({ operation: "account_info", api_key: FAKE_KEY });
    assert(r.account_id === "acct_001", "A2: account_info returns account object");
    restore();
  }

  // A3: list_create returns new list
  {
    const restore = mockHttps(200, { id: "list_001", name: "Test List" });
    const r = await mailchimpClient({ operation: "list_create", ...BASE_LIST_ARGS });
    assert(r.id === "list_001", "A3: list_create returns new list");
    restore();
  }

  // A4: list_get returns list
  {
    const restore = mockHttps(200, { id: "list_001", stats: { member_count: 100 } });
    const r = await mailchimpClient({ operation: "list_get", api_key: FAKE_KEY, list_id: "list_001" });
    assert(r.id === "list_001", "A4: list_get returns list object");
    restore();
  }

  // A5: list_get 404 returns exists:false
  {
    const restore = mockHttps(404, { title: "Resource Not Found" });
    const r = await mailchimpClient({ operation: "list_get", api_key: FAKE_KEY, list_id: "bad_list" });
    assert(r.exists === false && r.list_id === "bad_list", "A5: list_get 404 returns {exists:false}");
    restore();
  }

  // A6: list_delete 204 returns deleted:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({ operation: "list_delete", api_key: FAKE_KEY, list_id: "list_001" });
    assert(r.deleted === true, "A6: list_delete 204 returns {deleted:true}");
    restore();
  }

  // A7: member_add returns new member
  {
    const restore = mockHttps(200, { id: "abc123", email_address: "alice@example.com", status: "subscribed" });
    const r = await mailchimpClient({
      operation: "member_add",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "alice@example.com",
      status: "subscribed",
    });
    assert(r.email_address === "alice@example.com", "A7: member_add returns new member");
    restore();
  }

  // A8: member_get returns member
  {
    const restore = mockHttps(200, { email_address: "alice@example.com", status: "subscribed" });
    const r = await mailchimpClient({
      operation: "member_get",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "alice@example.com",
    });
    assert(r.status === "subscribed", "A8: member_get returns member object");
    restore();
  }

  // A9: member_get 404 returns exists:false
  {
    const restore = mockHttps(404, { title: "Resource Not Found" });
    const r = await mailchimpClient({
      operation: "member_get",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "nobody@example.com",
    });
    assert(r.exists === false, "A9: member_get 404 returns {exists:false}");
    restore();
  }

  // A10: member_delete 204 returns deleted:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({
      operation: "member_delete",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "alice@example.com",
    });
    assert(r.deleted === true, "A10: member_delete 204 returns {deleted:true}");
    restore();
  }

  // A11: member_tags_update 204 returns tags_updated:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({
      operation: "member_tags_update",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "alice@example.com",
      tags: [{ name: "VIP", status: "active" }],
    });
    assert(r.tags_updated === true, "A11: member_tags_update 204 returns {tags_updated:true}");
    restore();
  }

  // A12: segment_create returns new segment
  {
    const restore = mockHttps(200, { id: 101, name: "VIP Segment", type: "static" });
    const r = await mailchimpClient({
      operation: "segment_create",
      api_key: FAKE_KEY,
      list_id: "list_001",
      name: "VIP Segment",
    });
    assert(r.id === 101, "A12: segment_create returns segment with id");
    restore();
  }

  // A13: segment_get 404 returns exists:false
  {
    const restore = mockHttps(404, { title: "Resource Not Found" });
    const r = await mailchimpClient({
      operation: "segment_get",
      api_key: FAKE_KEY,
      list_id: "list_001",
      segment_id: 9999,
    });
    assert(r.exists === false, "A13: segment_get 404 returns {exists:false}");
    restore();
  }

  // A14: campaign_create returns new campaign
  {
    const restore = mockHttps(200, { id: "camp_001", type: "regular", status: "save" });
    const r = await mailchimpClient({
      operation: "campaign_create",
      api_key: FAKE_KEY,
      type: "regular",
      recipients: { list_id: "list_001" },
      settings: { subject_line: "Hello", from_name: "Acme", reply_to: "hello@acme.com" },
    });
    assert(r.id === "camp_001", "A14: campaign_create returns new campaign");
    restore();
  }

  // A15: campaign_send 204 returns sent:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({
      operation: "campaign_send",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
    });
    assert(r.sent === true, "A15: campaign_send 204 returns {sent:true}");
    restore();
  }

  // A16: campaign_schedule 204 returns scheduled:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({
      operation: "campaign_schedule",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
      schedule_time: "2025-01-01T10:00:00Z",
    });
    assert(r.scheduled === true && r.campaign_id === "camp_001", "A16: campaign_schedule returns {scheduled:true}");
    restore();
  }

  // A17: campaign_delete 204 returns deleted:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({
      operation: "campaign_delete",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
    });
    assert(r.deleted === true, "A17: campaign_delete 204 returns {deleted:true}");
    restore();
  }

  // A18: campaign_content_set returns updated content
  {
    const restore = mockHttps(200, { plain_text: "Hello world", html: "<p>Hello</p>" });
    const r = await mailchimpClient({
      operation: "campaign_content_set",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
      plain_text: "Hello world",
      html: "<p>Hello</p>",
    });
    assert(r.plain_text === "Hello world", "A18: campaign_content_set returns updated content");
    restore();
  }

  // A19: template_create returns new template
  {
    const restore = mockHttps(200, { id: 101, name: "My Template" });
    const r = await mailchimpClient({
      operation: "template_create",
      api_key: FAKE_KEY,
      name: "My Template",
      html: "<html><body>Hello</body></html>",
    });
    assert(r.id === 101, "A19: template_create returns new template");
    restore();
  }

  // A20: template_delete 204 returns deleted:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({
      operation: "template_delete",
      api_key: FAKE_KEY,
      template_id: 101,
    });
    assert(r.deleted === true, "A20: template_delete 204 returns {deleted:true}");
    restore();
  }

  // A21: report_get returns campaign report
  {
    const restore = mockHttps(200, { id: "camp_001", emails_sent: 100, opens: { unique_opens: 42 } });
    const r = await mailchimpClient({
      operation: "report_get",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
    });
    assert(r.emails_sent === 100, "A21: report_get returns campaign report");
    restore();
  }

  // A22: automation_list returns automations
  {
    const restore = mockHttps(200, { automations: [{ id: "wf_001" }], total_items: 1 });
    const r = await mailchimpClient({ operation: "automation_list", api_key: FAKE_KEY });
    assert(r.total_items === 1, "A22: automation_list returns automations");
    restore();
  }

  // A23: automation_start 204 returns started:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({
      operation: "automation_start",
      api_key: FAKE_KEY,
      workflow_id: "wf_001",
    });
    assert(r.started === true, "A23: automation_start 204 returns {started:true}");
    restore();
  }

  // A24: member_upsert returns member
  {
    const restore = mockHttps(200, { email_address: "bob@example.com", status: "subscribed" });
    const r = await mailchimpClient({
      operation: "member_upsert",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "bob@example.com",
      status_if_new: "subscribed",
      merge_fields: { FNAME: "Bob" },
    });
    assert(r.email_address === "bob@example.com", "A24: member_upsert returns member object");
    restore();
  }

  // A25: campaign_send_test 204 returns test_sent:true
  {
    const restore = mockHttpsEmpty(204);
    const r = await mailchimpClient({
      operation: "campaign_send_test",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
      test_emails: ["qa@example.com"],
    });
    assert(r.test_sent === true, "A25: campaign_send_test 204 returns {test_sent:true}");
    restore();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// B — Validation
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[B] Validation tests");

async function testB() {
  // B1: missing operation throws
  await assertRejects(
    () => mailchimpClient({ api_key: FAKE_KEY }),
    /operation.*required|non-empty/i, "B1: missing operation throws"
  );

  // B2: missing api_key and oauth_token throws
  await assertRejects(
    () => mailchimpClient({ operation: "ping" }),
    /api_key or oauth_token.*required/i, "B2: missing api_key and oauth_token throws"
  );

  // B3: api_key without dc suffix throws
  await assertRejects(
    () => mailchimpClient({ operation: "ping", api_key: "nodcsuffix" }),
    /datacenter suffix/i, "B3: api_key without -usXX suffix throws"
  );

  // B4: oauth_token without server_prefix throws
  await assertRejects(
    () => mailchimpClient({ operation: "ping", oauth_token: "tok_abc" }),
    /server_prefix.*required/i, "B4: oauth_token without server_prefix throws"
  );

  // B5: unknown operation throws descriptive error
  await assertRejects(
    () => mailchimpClient({ operation: "banana", api_key: FAKE_KEY }),
    /Unknown operation.*banana/i, "B5: unknown operation throws descriptive error"
  );

  // B6: list_create missing required fields throws
  await assertRejects(
    () => mailchimpClient({ operation: "list_create", api_key: FAKE_KEY }),
    /name.*required|non-empty/i, "B6: list_create missing name throws"
  );

  // B7: member_add invalid status throws
  await assertRejects(
    () => mailchimpClient({
      operation: "member_add",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "x@y.com",
      status: "invalid_status",
    }),
    /status must be one of/i, "B7: member_add invalid status throws"
  );

  // B8: campaign_create invalid type throws
  await assertRejects(
    () => mailchimpClient({
      operation: "campaign_create",
      api_key: FAKE_KEY,
      type: "newsletter",
    }),
    /campaign type must be one of/i, "B8: campaign_create invalid type throws"
  );

  // B9: campaign_send_test missing test_emails throws
  await assertRejects(
    () => mailchimpClient({
      operation: "campaign_send_test",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
    }),
    /test_emails.*array.*required/i, "B9: campaign_send_test missing test_emails throws"
  );

  // B10: member_tags_update missing tags throws
  await assertRejects(
    () => mailchimpClient({
      operation: "member_tags_update",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "alice@example.com",
    }),
    /tags.*array.*required/i, "B10: member_tags_update missing tags throws"
  );

  // B11: campaign_content_set with no content throws
  await assertRejects(
    () => mailchimpClient({
      operation: "campaign_content_set",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
    }),
    /plain_text|html|url|template|sections.*required/i,
    "B11: campaign_content_set with no content fields throws"
  );

  // B12: template_create missing html throws
  await assertRejects(
    () => mailchimpClient({
      operation: "template_create",
      api_key: FAKE_KEY,
      name: "My Template",
    }),
    /html.*required|non-empty/i, "B12: template_create missing html throws"
  );

  // B13: generic request with unsupported method throws
  await assertRejects(
    () => mailchimpClient({
      operation: "request",
      api_key: FAKE_KEY,
      method: "HEAD",
      path: "/ping",
    }),
    /Unsupported method|HEAD/i, "B13: generic request with HEAD throws"
  );

  // B14: campaign_schedule missing schedule_time throws
  await assertRejects(
    () => mailchimpClient({
      operation: "campaign_schedule",
      api_key: FAKE_KEY,
      campaign_id: "camp_001",
    }),
    /schedule_time.*required|non-empty/i, "B14: campaign_schedule missing schedule_time throws"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// C — Mock-network
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[C] Mock-network tests");

async function testC() {
  // C1: network error propagates
  {
    const restore = mockHttpsError("ECONNREFUSED");
    await assertRejects(
      () => mailchimpClient({ operation: "ping", api_key: FAKE_KEY }),
      /ECONNREFUSED/i, "C1: network error propagates"
    );
    restore();
  }

  // C2: Mailchimp 400 error thrown
  {
    const restore = mockHttps(400, { title: "Invalid Resource", detail: "Bad request" });
    await assertRejects(
      () => mailchimpClient({ operation: "ping", api_key: FAKE_KEY }),
      /Mailchimp API error 400/i, "C2: Mailchimp 400 throws error"
    );
    restore();
  }

  // C3: Mailchimp 401 unauthorized
  {
    const restore = mockHttps(401, { title: "API Key Invalid" });
    await assertRejects(
      () => mailchimpClient({ operation: "account_info", api_key: FAKE_KEY }),
      /Mailchimp API error 401/i, "C3: Mailchimp 401 throws error"
    );
    restore();
  }

  // C4: request times out
  {
    const original = https.request;
    https.request = (_opts, _cb) => {
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => req.emit("error", new Error("socket hang up"));
      return req;
    };
    await assertRejects(
      () => mailchimpClient({ operation: "ping", api_key: FAKE_KEY, timeout: 50 }),
      /timed out|hang up/i, "C4: request times out"
    );
    https.request = original;
  }

  // C5: Basic auth header set correctly from api_key
  {
    let capturedAuth = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedAuth = opts.headers["Authorization"];
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ health_status: "ok" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await mailchimpClient({ operation: "ping", api_key: FAKE_KEY });
    const expected = `Basic ${Buffer.from(`mcp:${FAKE_KEY}`).toString("base64")}`;
    assert(capturedAuth === expected, "C5: Basic auth header set correctly from api_key");
    https.request = original;
  }

  // C6: Bearer auth header set when using oauth_token
  {
    let capturedAuth = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedAuth = opts.headers["Authorization"];
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ health_status: "ok" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await mailchimpClient({ operation: "ping", oauth_token: "mytoken", server_prefix: "us6" });
    assert(capturedAuth === "Bearer mytoken", "C6: Bearer auth header set from oauth_token");
    https.request = original;
  }

  // C7: datacenter extracted from api_key sets correct hostname
  {
    let capturedHostname = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHostname = opts.hostname;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({}))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await mailchimpClient({ operation: "ping", api_key: "key123-us14" });
    assert(capturedHostname === "us14.api.mailchimp.com", "C7: datacenter us14 extracted, correct hostname set");
    https.request = original;
  }

  // C8: server_prefix overrides datacenter
  {
    let capturedHostname = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHostname = opts.hostname;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({}))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await mailchimpClient({ operation: "ping", api_key: FAKE_KEY, server_prefix: "us9" });
    assert(capturedHostname === "us9.api.mailchimp.com", "C8: server_prefix overrides datacenter");
    https.request = original;
  }

  // C9: GET requests send params as query string
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ lists: [], total_items: 0 }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await mailchimpClient({ operation: "list_get_all", api_key: FAKE_KEY, count: 50 });
    assert(capturedPath && capturedPath.includes("count=50"), "C9: GET list_get_all sends query string params");
    https.request = original;
  }

  // C10: non-JSON response returns {_raw}
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from("<html>error</html>")); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    const r = await mailchimpClient({ operation: "ping", api_key: FAKE_KEY });
    assert(r && r._raw, "C10: non-JSON response body returned as {_raw}");
    https.request = original;
  }

  // C11: 16 MB cap enforced
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x41));
        res.emit("end");
      });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await assertRejects(
      () => mailchimpClient({ operation: "ping", api_key: FAKE_KEY }),
      /16 MB|exceeds/i, "C11: 17 MB response exceeds 16 MB cap"
    );
    https.request = original;
  }

  // C12: member_delete 404 returns deleted:false
  {
    const restore = mockHttps(404, { title: "Resource Not Found" });
    const r = await mailchimpClient({
      operation: "member_delete",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "gone@example.com",
    });
    assert(r.deleted === false && r.email_address === "gone@example.com", "C12: member_delete 404 returns {deleted:false}");
    restore();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// D — Security
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[D] Security tests");

async function testD() {
  // D1: NUL byte in api_key throws
  await assertRejects(
    () => mailchimpClient({ operation: "ping", api_key: "abc\x00-us6" }),
    /NUL|api_key/i, "D1: NUL byte in api_key is rejected"
  );

  // D2: NUL byte in list_id throws
  await assertRejects(
    () => mailchimpClient({ operation: "list_get", api_key: FAKE_KEY, list_id: "list\x00hack" }),
    /NUL|list_id/i, "D2: NUL byte in list_id is rejected"
  );

  // D3: api_key scrubbed from network error
  {
    const canaryKey = "canary_secret-us6";
    const restore = mockHttpsError(`Connection refused key=${canaryKey}`);
    try {
      await mailchimpClient({ operation: "ping", api_key: canaryKey });
      assert(false, "D3: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryKey), "D3: api_key scrubbed from network error message");
    }
    restore();
  }

  // D4: api_key scrubbed from API error body
  {
    const canaryKey = "canary_body_key-us6";
    const restore = mockHttps(401, { detail: `Invalid key ${canaryKey}` });
    try {
      await mailchimpClient({ operation: "ping", api_key: canaryKey });
      assert(false, "D4: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryKey), "D4: api_key scrubbed from API error body");
    }
    restore();
  }

  // D5: oauth_token scrubbed from API error
  {
    const canaryToken = "oauth_secret_token_123456789";
    const restore = mockHttps(401, { detail: `Token ${canaryToken} invalid` });
    try {
      await mailchimpClient({ operation: "ping", oauth_token: canaryToken, server_prefix: "us6" });
      assert(false, "D5: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryToken), "D5: oauth_token scrubbed from API error body");
    }
    restore();
  }

  // D6: rejectUnauthorized defaults to true
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({}))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await mailchimpClient({ operation: "ping", api_key: FAKE_KEY });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === true, "D6: rejectUnauthorized defaults to true");
    https.request = original;
  }

  // D7: reject_unauthorized:false forwarded
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({}))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await mailchimpClient({ operation: "ping", api_key: FAKE_KEY, reject_unauthorized: false });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === false, "D7: reject_unauthorized:false forwarded");
    https.request = original;
  }

  // D8: NUL byte in email_address throws
  await assertRejects(
    () => mailchimpClient({
      operation: "member_get",
      api_key: FAKE_KEY,
      list_id: "list_001",
      email_address: "evil\x00@example.com",
    }),
    /NUL|email_address/i, "D8: NUL byte in email_address is rejected"
  );

  // D9: NUL byte in campaign_id throws
  await assertRejects(
    () => mailchimpClient({
      operation: "campaign_get",
      api_key: FAKE_KEY,
      campaign_id: "camp\x00hack",
    }),
    /NUL|campaign_id/i, "D9: NUL byte in campaign_id is rejected"
  );

  // D10: huge timeout clamped
  {
    const restore = mockHttps(200, { health_status: "ok" });
    const r = await mailchimpClient({ operation: "ping", api_key: FAKE_KEY, timeout: 999999 });
    assert(r && r.health_status === "ok", "D10: huge timeout clamped, request still works");
    restore();
  }

  // D11: NUL byte in server_prefix throws
  await assertRejects(
    () => mailchimpClient({ operation: "ping", api_key: FAKE_KEY, server_prefix: "us\x006" }),
    /NUL|server_prefix/i, "D11: NUL byte in server_prefix is rejected"
  );

  // D12: api_key not leaked in returned body
  {
    const restore = mockHttps(200, { account_id: "acc_001" });
    const r = await mailchimpClient({ operation: "account_info", api_key: FAKE_KEY });
    assert(!JSON.stringify(r).includes(FAKE_KEY), "D12: api_key not leaked in returned body");
    restore();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// E — Concurrency / stress
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[E] Concurrency tests");

async function testE() {
  // E1: 20 concurrent ping calls succeed
  {
    const restore = mockHttps(200, { health_status: "ok" });
    const tasks = Array.from({ length: 20 }, () =>
      mailchimpClient({ operation: "ping", api_key: FAKE_KEY })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 20 && results.every(r => r.health_status === "ok"),
      "E1: 20 concurrent ping calls all succeed");
    restore();
  }

  // E2: 10 concurrent list_get_all calls
  {
    const restore = mockHttps(200, { lists: [], total_items: 0 });
    const tasks = Array.from({ length: 10 }, () =>
      mailchimpClient({ operation: "list_get_all", api_key: FAKE_KEY })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 10 && results.every(r => r.total_items === 0),
      "E2: 10 concurrent list_get_all calls all succeed");
    restore();
  }

  // E3: mix of success and validation errors
  {
    const restore = mockHttps(200, { health_status: "ok" });
    const tasks = [
      mailchimpClient({ operation: "ping", api_key: FAKE_KEY }),
      mailchimpClient({ operation: "ping" }).catch(e => e),
      mailchimpClient({ operation: "ping", api_key: FAKE_KEY }),
    ];
    const [r1, r2, r3] = await Promise.all(tasks);
    assert(r1.health_status === "ok" && r2 instanceof Error && r3.health_status === "ok",
      "E3: mix of success + validation errors handled correctly");
    restore();
  }

  // E4: 15 rapid calls don't leak state
  {
    let callCount = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      callCount++;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ health_status: "ok" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 15 }, () =>
      mailchimpClient({ operation: "ping", api_key: FAKE_KEY })
    );
    const results = await Promise.all(tasks);
    assert(callCount === 15 && results.length === 15, "E4: 15 rapid calls, no state leakage");
    https.request = original;
  }

  // E5: 8 concurrent network errors propagate independently
  {
    const restore = mockHttpsError("ECONNRESET");
    const tasks = Array.from({ length: 8 }, () =>
      mailchimpClient({ operation: "ping", api_key: FAKE_KEY }).catch(e => e)
    );
    const results = await Promise.all(tasks);
    assert(results.length === 8 && results.every(e => e instanceof Error && /ECONNRESET/i.test(e.message)),
      "E5: 8 concurrent network errors all propagate independently");
    restore();
  }

  // E6: 5 different operations concurrently
  {
    const restore = mockHttps(200, { result: "ok" });
    const tasks = [
      mailchimpClient({ operation: "ping", api_key: FAKE_KEY }),
      mailchimpClient({ operation: "account_info", api_key: FAKE_KEY }),
      mailchimpClient({ operation: "list_get_all", api_key: FAKE_KEY }),
      mailchimpClient({ operation: "campaign_list", api_key: FAKE_KEY }),
      mailchimpClient({ operation: "template_list", api_key: FAKE_KEY }),
    ];
    const results = await Promise.all(tasks);
    assert(results.length === 5 && results.every(r => r.result === "ok"),
      "E6: 5 concurrent different operations succeed");
    restore();
  }

  // E7: 50 sequential validation rejections
  {
    let errCount = 0;
    for (let i = 0; i < 50; i++) {
      await mailchimpClient({ operation: "member_tags_update", api_key: FAKE_KEY, list_id: "l", email_address: "x@y.com" })
        .catch(() => errCount++);
    }
    assert(errCount === 50, "E7: 50 sequential validation errors all caught cleanly");
  }

  // E8: concurrent calls with different api_keys use correct hostnames
  {
    const key1 = "key1-us3";
    const key2 = "key2-us10";
    const hostnames = [];
    const original = https.request;
    https.request = (opts, cb) => {
      hostnames.push(opts.hostname);
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({}))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await Promise.all([
      mailchimpClient({ operation: "ping", api_key: key1 }),
      mailchimpClient({ operation: "ping", api_key: key2 }),
    ]);
    assert(
      hostnames.some(h => h === "us3.api.mailchimp.com") && hostnames.some(h => h === "us10.api.mailchimp.com"),
      "E8: concurrent calls with different api_keys use correct distinct hostnames"
    );
    https.request = original;
  }

  // E9: 10 concurrent: 5 succeed + 5 fail
  {
    let toggle = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      const mine = toggle++;
      const statusCode = mine % 2 === 0 ? 200 : 400;
      const body = mine % 2 === 0 ? { health_status: "ok" } : { title: "Error" };
      const res = new EventEmitter();
      res.statusCode = statusCode;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify(body))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 10 }, () =>
      mailchimpClient({ operation: "ping", api_key: FAKE_KEY }).catch(e => ({ error: e.message }))
    );
    const results = await Promise.all(tasks);
    const successes = results.filter(r => r.health_status === "ok").length;
    const failures  = results.filter(r => r.error).length;
    assert(successes === 5 && failures === 5, "E9: 10 concurrent: 5 succeed + 5 fail correctly");
    https.request = original;
  }

  // E10: 30 concurrent member_get calls
  {
    const restore = mockHttps(200, { email_address: "u@x.com", status: "subscribed" });
    const tasks = Array.from({ length: 30 }, () =>
      mailchimpClient({
        operation: "member_get",
        api_key: FAKE_KEY,
        list_id: "list_001",
        email_address: "u@x.com",
      })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 30 && results.every(r => r.status === "subscribed"),
      "E10: 30 concurrent member_get calls all succeed");
    restore();
  }
}

// ── Run all ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await testA();
    await testB();
    await testC();
    await testD();
    await testE();
  } catch (err) {
    console.error("UNEXPECTED:", err);
    failed++;
  }
  console.log(`\n────────────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
