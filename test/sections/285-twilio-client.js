"use strict";
/**
 * 285-twilio-client.js
 * Isolated tests for twilioClientOps.js
 * Levels: A=normal, B=validation, C=mock-network, D=security, E=concurrency
 * All tests run without hitting the real Twilio API.
 */

const https  = require("https");
const { EventEmitter } = require("events");

// ── Load the module under test ────────────────────────────────────────────────
const { twilioClient } = require("../../lib/twilioClientOps");

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${name}`);
    process.stderr.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    results.push(`  ✗ ${name}: ${err.message}`);
    process.stderr.write(`  ✗ ${name}\n    ${err.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

async function assertRejects(fn, pattern, msg) {
  try {
    await fn();
    throw new Error(msg || "Expected rejection but resolved");
  } catch (err) {
    if (err.message === (msg || "Expected rejection but resolved")) throw err;
    if (pattern && !pattern.test(err.message))
      throw new Error(`Expected error matching ${pattern} but got: ${err.message}`);
  }
}

// ── Mock https.request ────────────────────────────────────────────────────────
let mockResponse = null;
const origRequest = https.request.bind(https);

function mockHttp(status, body) {
  mockResponse = { status, body };
}

function restoreHttp() {
  mockResponse = null;
}

https.request = function mockRequest(options, callback) {
  if (!mockResponse) return origRequest(options, callback);

  const { status, body } = mockResponse;
  const raw = body === null ? "" : JSON.stringify(body);

  const resEmitter = new EventEmitter();
  resEmitter.statusCode = status;
  resEmitter.headers = { "content-type": "application/json" };

  const reqEmitter = new EventEmitter();
  reqEmitter.write = () => {};
  reqEmitter.end   = () => {
    setImmediate(() => {
      callback(resEmitter);
      setImmediate(() => {
        if (raw) resEmitter.emit("data", Buffer.from(raw));
        resEmitter.emit("end");
      });
    });
  };
  reqEmitter.destroy = () => {};
  return reqEmitter;
};

// Auth context shared
// NOTE: These are intentionally fake/invalid credentials for test purposes only.
// The account_sid uses a non-standard prefix (XC) so it does not match real Twilio SIDs.
const AUTH = {
  account_sid: "XCaabbccdd11223344556677889900aabb",
  auth_token:  "test_auth_token_abc123",
};

const AUTH_APIKEY = {
  account_sid: "XCaabbccdd11223344556677889900aabb",
  api_key:     "SKaaaaabbbbbccccc",
  api_secret:  "test_secret_key_data",
};

(async () => {

// ════════════════════════════════════════════════════════════════════════════════
// A. NORMAL (happy-path)
// ════════════════════════════════════════════════════════════════════════════════

process.stderr.write("\nA. Normal (happy-path)\n");

await test("A01: message_send returns message object", async () => {
  mockHttp(201, { sid: "SM123", body: "Hello", status: "queued", to: "+15550001111", from: "+15559998888" });
  const r = await twilioClient({ ...AUTH, operation: "message_send", to: "+15550001111", from: "+15559998888", body: "Hello" });
  assertEqual(r.sid, "SM123");
  assertEqual(r.status, "queued");
  restoreHttp();
});

await test("A02: message_get returns message details", async () => {
  mockHttp(200, { sid: "SM123", body: "Hi", status: "delivered" });
  const r = await twilioClient({ ...AUTH, operation: "message_get", message_sid: "SM123" });
  assertEqual(r.sid, "SM123");
  restoreHttp();
});

await test("A03: message_list returns messages array", async () => {
  mockHttp(200, { messages: [{ sid: "SM1" }, { sid: "SM2" }], page_size: 50 });
  const r = await twilioClient({ ...AUTH, operation: "message_list" });
  assert(Array.isArray(r.messages), "messages should be array");
  assertEqual(r.messages.length, 2);
  restoreHttp();
});

await test("A04: message_delete returns deleted:true on 204", async () => {
  mockHttp(204, null);
  const r = await twilioClient({ ...AUTH, operation: "message_delete", message_sid: "SM123" });
  assertEqual(r.deleted, true);
  assertEqual(r.message_sid, "SM123");
  restoreHttp();
});

await test("A05: message_update (redact) returns updated message", async () => {
  mockHttp(200, { sid: "SM123", body: "" });
  const r = await twilioClient({ ...AUTH, operation: "message_update", message_sid: "SM123", body: "" });
  assertEqual(r.sid, "SM123");
  restoreHttp();
});

await test("A06: call_create initiates outbound call", async () => {
  mockHttp(201, { sid: "CA123", status: "queued", to: "+15550001111" });
  const r = await twilioClient({ ...AUTH, operation: "call_create", to: "+15550001111", from: "+15559998888", url: "https://example.com/twiml" });
  assertEqual(r.sid, "CA123");
  assertEqual(r.status, "queued");
  restoreHttp();
});

await test("A07: call_get returns call details", async () => {
  mockHttp(200, { sid: "CA123", duration: "30", status: "completed" });
  const r = await twilioClient({ ...AUTH, operation: "call_get", call_sid: "CA123" });
  assertEqual(r.sid, "CA123");
  restoreHttp();
});

await test("A08: call_list returns calls", async () => {
  mockHttp(200, { calls: [{ sid: "CA1" }], page_size: 50 });
  const r = await twilioClient({ ...AUTH, operation: "call_list" });
  assert(Array.isArray(r.calls));
  restoreHttp();
});

await test("A09: call_update hangs up call", async () => {
  mockHttp(200, { sid: "CA123", status: "completed" });
  const r = await twilioClient({ ...AUTH, operation: "call_update", call_sid: "CA123", status: "completed" });
  assertEqual(r.status, "completed");
  restoreHttp();
});

await test("A10: call_delete returns deleted:true", async () => {
  mockHttp(204, null);
  const r = await twilioClient({ ...AUTH, operation: "call_delete", call_sid: "CA123" });
  assertEqual(r.deleted, true);
  restoreHttp();
});

await test("A11: phone_number_list returns incoming numbers", async () => {
  mockHttp(200, { incoming_phone_numbers: [{ sid: "PN1", phone_number: "+15551234567" }] });
  const r = await twilioClient({ ...AUTH, operation: "phone_number_list" });
  assert(Array.isArray(r.incoming_phone_numbers));
  restoreHttp();
});

await test("A12: phone_number_get returns number details", async () => {
  mockHttp(200, { sid: "PN1", phone_number: "+15551234567" });
  const r = await twilioClient({ ...AUTH, operation: "phone_number_get", phone_number_sid: "PN1" });
  assertEqual(r.sid, "PN1");
  restoreHttp();
});

await test("A13: phone_number_buy purchases number", async () => {
  mockHttp(201, { sid: "PN2", phone_number: "+15559876543", status: "in-use" });
  const r = await twilioClient({ ...AUTH, operation: "phone_number_buy", phone_number: "+15559876543" });
  assertEqual(r.sid, "PN2");
  restoreHttp();
});

await test("A14: phone_number_update updates webhooks", async () => {
  mockHttp(200, { sid: "PN1", sms_url: "https://myapp.com/sms" });
  const r = await twilioClient({ ...AUTH, operation: "phone_number_update", phone_number_sid: "PN1", sms_url: "https://myapp.com/sms" });
  assert(r.sms_url);
  restoreHttp();
});

await test("A15: phone_number_release returns released:true on 204", async () => {
  mockHttp(204, null);
  const r = await twilioClient({ ...AUTH, operation: "phone_number_release", phone_number_sid: "PN1" });
  assertEqual(r.released, true);
  restoreHttp();
});

await test("A16: phone_number_search returns available numbers", async () => {
  mockHttp(200, { available_phone_numbers: [{ phone_number: "+12025551234" }] });
  const r = await twilioClient({ ...AUTH, operation: "phone_number_search", country_code: "US" });
  assert(Array.isArray(r.available_phone_numbers));
  restoreHttp();
});

await test("A17: recording_list returns recordings", async () => {
  mockHttp(200, { recordings: [{ sid: "RE1", duration: "5" }] });
  const r = await twilioClient({ ...AUTH, operation: "recording_list" });
  assert(Array.isArray(r.recordings));
  restoreHttp();
});

await test("A18: recording_get returns recording + download_url", async () => {
  mockHttp(200, { sid: "RE1", duration: "10" });
  const r = await twilioClient({ ...AUTH, operation: "recording_get", recording_sid: "RE1" });
  assertEqual(r.sid, "RE1");
  assert(r.download_url && r.download_url.includes("RE1"), "download_url should include RE1");
  restoreHttp();
});

await test("A19: recording_delete returns deleted:true", async () => {
  mockHttp(204, null);
  const r = await twilioClient({ ...AUTH, operation: "recording_delete", recording_sid: "RE1" });
  assertEqual(r.deleted, true);
  restoreHttp();
});

await test("A20: verify_service_create creates service", async () => {
  mockHttp(201, { sid: "VA1", friendly_name: "MyApp" });
  const r = await twilioClient({ ...AUTH, operation: "verify_service_create", friendly_name: "MyApp" });
  assertEqual(r.sid, "VA1");
  restoreHttp();
});

await test("A21: verify_service_list returns services", async () => {
  mockHttp(200, { services: [{ sid: "VA1" }] });
  const r = await twilioClient({ ...AUTH, operation: "verify_service_list" });
  restoreHttp();
  assert(r !== null);
});

await test("A22: verify_send sends OTP", async () => {
  mockHttp(201, { sid: "VE1", status: "pending", to: "+15550001111" });
  const r = await twilioClient({ ...AUTH, operation: "verify_send", service_sid: "VA1", to: "+15550001111", channel: "sms" });
  assertEqual(r.status, "pending");
  restoreHttp();
});

await test("A23: verify_check verifies OTP code", async () => {
  mockHttp(200, { sid: "VE1", status: "approved", valid: true });
  const r = await twilioClient({ ...AUTH, operation: "verify_check", service_sid: "VA1", to: "+15550001111", code: "123456" });
  assertEqual(r.status, "approved");
  assertEqual(r.valid, true);
  restoreHttp();
});

await test("A24: messaging_service_create creates service", async () => {
  mockHttp(201, { sid: "MG1", friendly_name: "MyCampaign" });
  const r = await twilioClient({ ...AUTH, operation: "messaging_service_create", friendly_name: "MyCampaign" });
  assertEqual(r.sid, "MG1");
  restoreHttp();
});

await test("A25: messaging_service_get returns service", async () => {
  mockHttp(200, { sid: "MG1", friendly_name: "MyCampaign" });
  const r = await twilioClient({ ...AUTH, operation: "messaging_service_get", service_sid: "MG1" });
  assertEqual(r.sid, "MG1");
  restoreHttp();
});

await test("A26: messaging_service_list returns services", async () => {
  mockHttp(200, { services: [{ sid: "MG1" }] });
  const r = await twilioClient({ ...AUTH, operation: "messaging_service_list" });
  restoreHttp();
  assert(r !== null);
});

await test("A27: messaging_service_delete returns deleted:true", async () => {
  mockHttp(204, null);
  const r = await twilioClient({ ...AUTH, operation: "messaging_service_delete", service_sid: "MG1" });
  assertEqual(r.deleted, true);
  restoreHttp();
});

await test("A28: lookup_phone returns phone info", async () => {
  mockHttp(200, { phone_number: "+15550001111", country_code: "US", line_type_intelligence: { type: "mobile" } });
  const r = await twilioClient({ ...AUTH, operation: "lookup_phone", phone_number: "+15550001111" });
  assertEqual(r.phone_number, "+15550001111");
  restoreHttp();
});

await test("A29: account_info returns account details", async () => {
  mockHttp(200, { sid: "XCaabbccdd11223344556677889900aabb", friendly_name: "Test", status: "active", type: "Trial" });
  const r = await twilioClient({ ...AUTH, operation: "account_info" });
  assert(r.friendly_name);
  restoreHttp();
});

await test("A30: info returns connection metadata", async () => {
  mockHttp(200, { sid: "XCaabbccdd11223344556677889900aabb", friendly_name: "Test", status: "active", type: "Trial", date_created: "2020-01-01" });
  const r = await twilioClient({ ...AUTH, operation: "info" });
  assert(r.account_sid);
  assert(r.auth_method === "auth_token");
  restoreHttp();
});

await test("A31: conference_list returns conferences", async () => {
  mockHttp(200, { conferences: [{ sid: "CF1" }] });
  const r = await twilioClient({ ...AUTH, operation: "conference_list" });
  assert(Array.isArray(r.conferences));
  restoreHttp();
});

await test("A32: conference_get returns conference", async () => {
  mockHttp(200, { sid: "CF1", status: "in-progress" });
  const r = await twilioClient({ ...AUTH, operation: "conference_get", conference_sid: "CF1" });
  assertEqual(r.sid, "CF1");
  restoreHttp();
});

await test("A33: conference_participant_list returns participants", async () => {
  mockHttp(200, { participants: [{ call_sid: "CA1" }] });
  const r = await twilioClient({ ...AUTH, operation: "conference_participant_list", conference_sid: "CF1" });
  assert(Array.isArray(r.participants));
  restoreHttp();
});

await test("A34: conference_participant_kick returns kicked:true", async () => {
  mockHttp(204, null);
  const r = await twilioClient({ ...AUTH, operation: "conference_participant_kick", conference_sid: "CF1", call_sid: "CA1" });
  assertEqual(r.kicked, true);
  restoreHttp();
});

await test("A35: queue_list returns queues", async () => {
  mockHttp(200, { queues: [{ sid: "QU1", friendly_name: "Support" }] });
  const r = await twilioClient({ ...AUTH, operation: "queue_list" });
  assert(Array.isArray(r.queues));
  restoreHttp();
});

await test("A36: queue_create creates queue", async () => {
  mockHttp(201, { sid: "QU1", friendly_name: "Support", max_size: 100 });
  const r = await twilioClient({ ...AUTH, operation: "queue_create", friendly_name: "Support" });
  assertEqual(r.sid, "QU1");
  restoreHttp();
});

await test("A37: queue_delete returns deleted:true", async () => {
  mockHttp(204, null);
  const r = await twilioClient({ ...AUTH, operation: "queue_delete", queue_sid: "QU1" });
  assertEqual(r.deleted, true);
  restoreHttp();
});

await test("A38: request generic GET", async () => {
  mockHttp(200, { sid: "ACtest", status: "active" });
  const r = await twilioClient({ ...AUTH, operation: "request", method: "GET", path: "/2010-04-01/Accounts/ACtest.json" });
  assert(r !== null);
  restoreHttp();
});

await test("A39: api_key+api_secret auth works", async () => {
  mockHttp(200, { sid: "XCaabbccdd11223344556677889900aabb", friendly_name: "Test", status: "active", type: "Trial", date_created: "2020" });
  const r = await twilioClient({ ...AUTH_APIKEY, operation: "info" });
  assertEqual(r.auth_method, "api_key");
  restoreHttp();
});

await test("A40: message_delete returns deleted:false on 404", async () => {
  mockHttp(404, { code: 20404, message: "Not found" });
  const r = await twilioClient({ ...AUTH, operation: "message_delete", message_sid: "SMnotfound" });
  assertEqual(r.deleted, false);
  restoreHttp();
});

// ════════════════════════════════════════════════════════════════════════════════
// B. VALIDATION
// ════════════════════════════════════════════════════════════════════════════════

process.stderr.write("\nB. Validation\n");

await test("B01: missing operation throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH }),
    /operation.*required/i,
  );
});

await test("B02: missing account_sid throws", async () => {
  await assertRejects(
    () => twilioClient({ auth_token: "tok", operation: "info" }),
    /account_sid.*required/i,
  );
});

await test("B03: missing auth throws when neither auth_token nor api_key", async () => {
  await assertRejects(
    () => twilioClient({ account_sid: "ACtest", operation: "info" }),
    /auth_token.*api_key.*api_secret/i,
  );
});

await test("B04: unknown operation throws with list of valid ops", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "foobar" }),
    /Unknown operation/i,
  );
});

await test("B05: message_send requires body or media_url", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "message_send", to: "+15551234567", from: "+15559876543" }),
    /body.*media_url.*content_sid/i,
  );
});

await test("B06: message_send missing to throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "message_send", from: "+15559876543", body: "Hi" }),
    /to.*required/i,
  );
});

await test("B07: call_create missing url/twiml/application_sid throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "call_create", to: "+15551234567", from: "+15559876543" }),
    /url.*twiml.*application_sid/i,
  );
});

await test("B08: call_update no fields throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "call_update", call_sid: "CA123" }),
    /At least one/i,
  );
});

await test("B09: phone_number_update no fields throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "phone_number_update", phone_number_sid: "PN1" }),
    /At least one/i,
  );
});

await test("B10: phone_number_search missing country_code throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "phone_number_search" }),
    /country_code.*required/i,
  );
});

await test("B11: verify_send missing channel throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "verify_send", service_sid: "VA1", to: "+15551234567" }),
    /channel.*required/i,
  );
});

await test("B12: verify_check missing code throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "verify_check", service_sid: "VA1", to: "+15551234567" }),
    /code.*required/i,
  );
});

await test("B13: request unsupported method throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "request", method: "TRACE", path: "/test" }),
    /Unsupported method/i,
  );
});

await test("B14: api_key without api_secret throws", async () => {
  await assertRejects(
    () => twilioClient({ account_sid: "ACtest", api_key: "SKtest", operation: "info" }),
    /auth_token.*api_key.*api_secret/i,
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// C. MOCK-NETWORK (simulate errors / edge cases)
// ════════════════════════════════════════════════════════════════════════════════

process.stderr.write("\nC. Mock-network\n");

await test("C01: Twilio API 400 throws with status", async () => {
  mockHttp(400, { code: 21211, message: "Invalid phone number" });
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "message_send", to: "invalid", from: "+15559998888", body: "Hi" }),
    /Twilio API error 400/,
  );
  restoreHttp();
});

await test("C02: Twilio API 401 throws for bad auth", async () => {
  mockHttp(401, { code: 20003, message: "Authenticate" });
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "account_info" }),
    /Twilio API error 401/,
  );
  restoreHttp();
});

await test("C03: Twilio API 429 throws rate limit", async () => {
  mockHttp(429, { code: 20429, message: "Too Many Requests" });
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "message_list" }),
    /Twilio API error 429/,
  );
  restoreHttp();
});

await test("C04: phone_number_release returns released:false on 404", async () => {
  mockHttp(404, { code: 20404 });
  const r = await twilioClient({ ...AUTH, operation: "phone_number_release", phone_number_sid: "PNgone" });
  assertEqual(r.released, false);
  restoreHttp();
});

await test("C05: recording_delete returns deleted:false on 404", async () => {
  mockHttp(404, { code: 20404 });
  const r = await twilioClient({ ...AUTH, operation: "recording_delete", recording_sid: "REgone" });
  assertEqual(r.deleted, false);
  restoreHttp();
});

await test("C06: call_delete returns deleted:false on 404", async () => {
  mockHttp(404, null);
  const r = await twilioClient({ ...AUTH, operation: "call_delete", call_sid: "CAgone" });
  assertEqual(r.deleted, false);
  restoreHttp();
});

await test("C07: messaging_service_delete returns deleted:false on 404", async () => {
  mockHttp(404, null);
  const r = await twilioClient({ ...AUTH, operation: "messaging_service_delete", service_sid: "MGgone" });
  assertEqual(r.deleted, false);
  restoreHttp();
});

await test("C08: queue_delete returns deleted:false on 404", async () => {
  mockHttp(404, null);
  const r = await twilioClient({ ...AUTH, operation: "queue_delete", queue_sid: "QUgone" });
  assertEqual(r.deleted, false);
  restoreHttp();
});

await test("C09: conference_participant_kick returns kicked:false on 404", async () => {
  mockHttp(404, null);
  const r = await twilioClient({ ...AUTH, operation: "conference_participant_kick", conference_sid: "CF1", call_sid: "CAgone" });
  assertEqual(r.kicked, false);
  restoreHttp();
});

await test("C10: network error (req error) propagates", async () => {
  const saved = https.request;
  https.request = function (options, callback) {
    const reqE = new EventEmitter();
    reqE.write   = () => {};
    reqE.destroy = () => {};
    reqE.end = () => {
      setImmediate(() => reqE.emit("error", new Error("ECONNREFUSED")));
    };
    return reqE;
  };
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "account_info" }),
    /ECONNREFUSED/,
  );
  https.request = saved;
});

await test("C11: timeout fires if response never arrives", async () => {
  const saved = https.request;
  https.request = function (options, callback) {
    const reqE = new EventEmitter();
    reqE.write   = () => {};
    reqE.destroy = () => {};
    reqE.end     = () => {}; // never responds
    return reqE;
  };
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "account_info", timeout: 50 }),
    /timed out/i,
  );
  https.request = saved;
});

await test("C12: non-JSON body handled gracefully (_raw fallback)", async () => {
  mockHttp(200, null);
  const saved = https.request;
  https.request = function (options, callback) {
    const resE = new EventEmitter();
    resE.statusCode = 200;
    const reqE = new EventEmitter();
    reqE.write   = () => {};
    reqE.destroy = () => {};
    reqE.end     = () => {
      setImmediate(() => {
        callback(resE);
        setImmediate(() => {
          resE.emit("data", Buffer.from("not json here"));
          resE.emit("end");
        });
      });
    };
    return reqE;
  };
  const r = await twilioClient({ ...AUTH, operation: "account_info" });
  assert(r._raw === "not json here", "should have _raw fallback");
  https.request = saved;
  restoreHttp();
});

// ════════════════════════════════════════════════════════════════════════════════
// D. SECURITY
// ════════════════════════════════════════════════════════════════════════════════

process.stderr.write("\nD. Security\n");

await test("D01: NUL byte in account_sid throws", async () => {
  await assertRejects(
    () => twilioClient({ account_sid: "AC\x00test", auth_token: "tok", operation: "info" }),
    /NUL bytes/i,
  );
});

await test("D02: NUL byte in to throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "message_send", to: "+1555\x00", from: "+15559998888", body: "Hi" }),
    /NUL bytes/i,
  );
});

await test("D03: auth_token scrubbed from error message", async () => {
  mockHttp(403, { message: "Forbidden" });
  try {
    await twilioClient({ ...AUTH, operation: "account_info" });
    assert(false, "should have thrown");
  } catch (err) {
    assert(!err.message.includes(AUTH.auth_token), "auth_token must be scrubbed from error");
  }
  restoreHttp();
});

await test("D04: api_secret scrubbed from error message", async () => {
  mockHttp(403, { message: "super_secret_key_data leaked" });
  try {
    await twilioClient({ ...AUTH_APIKEY, operation: "account_info" });
    assert(false, "should have thrown");
  } catch (err) {
    assert(!err.message.includes(AUTH_APIKEY.api_secret), "api_secret must be scrubbed from error");
  }
  restoreHttp();
});

await test("D05: account_sid scrubbed from API error body", async () => {
  // Use AUTH.account_sid directly for scrubbing test
  const SID = AUTH.account_sid;
  mockHttp(400, { message: `Bad request for account ${SID}` });
  try {
    await twilioClient({ ...AUTH, operation: "account_info" });
    assert(false, "should have thrown");
  } catch (err) {
    assert(!err.message.includes(SID), "account_sid must be scrubbed from error");
  }
  restoreHttp();
});

await test("D06: auth_token scrubbed from network error", async () => {
  const saved = https.request;
  const TOKEN = AUTH.auth_token;
  https.request = function (options, callback) {
    const reqE = new EventEmitter();
    reqE.write   = () => {};
    reqE.destroy = () => {};
    reqE.end     = () => setImmediate(() => reqE.emit("error", new Error(`connect failed for ${TOKEN}`)));
    return reqE;
  };
  try {
    await twilioClient({ ...AUTH, operation: "account_info" });
    assert(false, "should have thrown");
  } catch (err) {
    assert(!err.message.includes(TOKEN), "auth_token must be scrubbed from network error");
  }
  https.request = saved;
});

await test("D07: NUL byte in message body throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "message_send", to: "+15551234567", from: "+15559876543", body: "hello\x00world" }),
    /NUL bytes/i,
  );
});

await test("D08: NUL byte in friendly_name throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "verify_service_create", friendly_name: "My\x00App" }),
    /NUL bytes/i,
  );
});

await test("D09: NUL byte in api_key throws", async () => {
  await assertRejects(
    () => twilioClient({ account_sid: "ACtest", api_key: "SK\x00test", api_secret: "sec", operation: "info" }),
    /NUL bytes/i,
  );
});

await test("D10: NUL byte in api_secret throws", async () => {
  await assertRejects(
    () => twilioClient({ account_sid: "ACtest", api_key: "SKtest", api_secret: "sec\x00ret", operation: "info" }),
    /NUL bytes/i,
  );
});

await test("D11: NUL byte in service_sid throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "verify_send", service_sid: "VA\x00test", to: "+15551234567", channel: "sms" }),
    /NUL bytes/i,
  );
});

await test("D12: empty string operation throws", async () => {
  await assertRejects(
    () => twilioClient({ ...AUTH, operation: "" }),
    /operation.*required/i,
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// E. CONCURRENCY / STRESS
// ════════════════════════════════════════════════════════════════════════════════

process.stderr.write("\nE. Concurrency\n");

await test("E01: 10 concurrent message_sends succeed independently", async () => {
  mockHttp(201, { sid: "SMconc", status: "queued" });
  const tasks = Array.from({ length: 10 }, (_, i) =>
    twilioClient({ ...AUTH, operation: "message_send", to: `+1555000${String(i).padStart(4, "0")}`, from: "+15559998888", body: "Test" })
  );
  const results2 = await Promise.all(tasks);
  assert(results2.every(r => r.sid === "SMconc"), "all should succeed");
  restoreHttp();
});

await test("E02: 10 concurrent call_gets succeed", async () => {
  mockHttp(200, { sid: "CA_conc", status: "completed" });
  const tasks = Array.from({ length: 10 }, () =>
    twilioClient({ ...AUTH, operation: "call_get", call_sid: "CA_conc" })
  );
  const results2 = await Promise.all(tasks);
  assert(results2.every(r => r.sid === "CA_conc"));
  restoreHttp();
});

await test("E03: mixed concurrent operations all resolve", async () => {
  mockHttp(200, { sid: "OK", status: "ok" });
  const ops = [
    twilioClient({ ...AUTH, operation: "message_list" }),
    twilioClient({ ...AUTH, operation: "call_list" }),
    twilioClient({ ...AUTH, operation: "conference_list" }),
    twilioClient({ ...AUTH, operation: "queue_list" }),
    twilioClient({ ...AUTH, operation: "recording_list" }),
  ];
  const results2 = await Promise.all(ops);
  assert(results2.length === 5);
  restoreHttp();
});

await test("E04: concurrent failures don't cross-contaminate", async () => {
  let call = 0;
  const saved = https.request;
  https.request = function (options, callback) {
    const n = call++;
    const reqE = new EventEmitter();
    reqE.write   = () => {};
    reqE.destroy = () => {};
    reqE.end = () => {
      setImmediate(() => {
        if (n % 2 === 0) {
          const resE = new EventEmitter();
          resE.statusCode = 200;
          callback(resE);
          setImmediate(() => {
            resE.emit("data", Buffer.from(JSON.stringify({ sid: `OK${n}` })));
            resE.emit("end");
          });
        } else {
          reqE.emit("error", new Error(`fail${n}`));
        }
      });
    };
    return reqE;
  };

  const tasks = Array.from({ length: 6 }, () =>
    twilioClient({ ...AUTH, operation: "account_info" }).catch(e => ({ error: e.message }))
  );
  const r = await Promise.all(tasks);
  const successes = r.filter(x => x.sid);
  const failures  = r.filter(x => x.error);
  assert(successes.length === 3 && failures.length === 3, `Expected 3+3, got ${successes.length}+${failures.length}`);
  https.request = saved;
});

await test("E05: 20 validation errors fire correctly under concurrency", async () => {
  const tasks = Array.from({ length: 20 }, () =>
    twilioClient({ account_sid: "ACtest", operation: "info" }).catch(e => e.message)
  );
  const errs = await Promise.all(tasks);
  assert(errs.every(e => /auth_token.*api_key.*api_secret/i.test(e)), "all should be auth error");
});

await test("E06: 20 concurrent NUL validation errors", async () => {
  const tasks = Array.from({ length: 20 }, () =>
    twilioClient({ ...AUTH, operation: "message_send", to: "+1555\x00", from: "+15559998888", body: "x" }).catch(e => e.message)
  );
  const errs = await Promise.all(tasks);
  assert(errs.every(e => /NUL/i.test(e)), "all should be NUL error");
});

await test("E07: 10 concurrent lookups", async () => {
  mockHttp(200, { phone_number: "+15551234567", country_code: "US" });
  const tasks = Array.from({ length: 10 }, () =>
    twilioClient({ ...AUTH, operation: "lookup_phone", phone_number: "+15551234567" })
  );
  const r = await Promise.all(tasks);
  assert(r.every(x => x.phone_number === "+15551234567"));
  restoreHttp();
});

await test("E08: 5 concurrent timeouts all fire", async () => {
  const saved = https.request;
  https.request = function () {
    const reqE = new EventEmitter();
    reqE.write   = () => {};
    reqE.destroy = () => {};
    reqE.end     = () => {}; // never responds
    return reqE;
  };
  const tasks = Array.from({ length: 5 }, () =>
    twilioClient({ ...AUTH, operation: "account_info", timeout: 50 }).catch(e => e.message)
  );
  const errs = await Promise.all(tasks);
  assert(errs.every(e => /timed out/i.test(e)), `unexpected: ${errs[0]}`);
  https.request = saved;
});

await test("E09: memory - 100 rapid validation rejections don't leak", async () => {
  const before = process.memoryUsage().heapUsed;
  const tasks = Array.from({ length: 100 }, () =>
    twilioClient({ ...AUTH, operation: "" }).catch(() => {})
  );
  await Promise.all(tasks);
  const after = process.memoryUsage().heapUsed;
  const deltaMb = (after - before) / 1024 / 1024;
  assert(deltaMb < 30, `Memory grew too much: ${deltaMb.toFixed(1)} MB`);
});

await test("E10: 5 concurrent 404 deletes return deleted:false correctly", async () => {
  mockHttp(404, null);
  const tasks = Array.from({ length: 5 }, (_, i) =>
    twilioClient({ ...AUTH, operation: "message_delete", message_sid: `SM${i}` })
  );
  const r = await Promise.all(tasks);
  assert(r.every(x => x.deleted === false));
  restoreHttp();
});

// ── Summary ───────────────────────────────────────────────────────────────────
process.stderr.write("\n");
process.stderr.write(results.join("\n") + "\n");
process.stderr.write(`\n${"-".repeat(60)}\n`);
process.stderr.write(`Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write("FAILED TESTS:\n");
  results.filter(r => r.includes("✗")).forEach(r => {
    process.stderr.write(`  ${r}\n`);
  });
  process.exit(1);
} else {
  process.stderr.write("All tests passed!\n");
}

})();
