"use strict";
/**
 * test/sections/287-sendgrid-client.js
 * Isolated tests for sendgridClientOps.js
 * 5 rigor levels: A=normal, B=validation, C=mock-network, D=security, E=concurrency
 */
const https = require("https");
const { EventEmitter } = require("events");
const { sendgridClient } = require("../../lib/sendgridClientOps");

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

// ── Mock HTTPS helper ─────────────────────────────────────────────────────────
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

const FAKE_KEY = "SG.testkey_aaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// ══════════════════════════════════════════════════════════════════════════════
// A — Normal (happy-path assertions)
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[A] Normal / happy-path tests");

async function testA() {
  // A1: mail_send returns sent:true with 202 status
  {
    const restore = mockHttpsEmpty(202);
    const r = await sendgridClient({
      operation: "mail_send",
      api_key: FAKE_KEY,
      to: "alice@example.com",
      from: "sender@example.com",
      subject: "Hello",
      text: "World",
    });
    assert(r.sent === true && r.status === 202, "A1: mail_send returns {sent:true, status:202}");
    restore();
  }

  // A2: mail_send with 200 status also returns sent:true
  {
    const restore = mockHttps(200, { message_id: "msg_123" });
    const r = await sendgridClient({
      operation: "mail_send",
      api_key: FAKE_KEY,
      to: "alice@example.com",
      from: "sender@example.com",
      subject: "Hi",
      text: "Body",
    });
    assert(r.sent === true && r.status === 200, "A2: mail_send with 200 returns {sent:true}");
    restore();
  }

  // A3: mail_send with template_id (no subject required)
  {
    const restore = mockHttpsEmpty(202);
    const r = await sendgridClient({
      operation: "mail_send",
      api_key: FAKE_KEY,
      to: "alice@example.com",
      from: "sender@example.com",
      template_id: "d-abc123",
      dynamic_template_data: { name: "Alice" },
    });
    assert(r.sent === true, "A3: mail_send with template_id succeeds without subject");
    restore();
  }

  // A4: contact_upsert returns job body
  {
    const restore = mockHttps(202, { job_id: "job_abc", queued_at: 1234567890 });
    const r = await sendgridClient({
      operation: "contact_upsert",
      api_key: FAKE_KEY,
      contacts: [{ email: "alice@example.com", first_name: "Alice" }],
    });
    assert(r.job_id === "job_abc", "A4: contact_upsert returns job_id");
    restore();
  }

  // A5: contact_get returns contact body
  {
    const restore = mockHttps(200, { id: "contact_001", email: "alice@example.com" });
    const r = await sendgridClient({
      operation: "contact_get",
      api_key: FAKE_KEY,
      contact_id: "contact_001",
    });
    assert(r.id === "contact_001", "A5: contact_get returns contact object");
    restore();
  }

  // A6: contact_get 404 returns exists:false
  {
    const restore = mockHttps(404, { errors: [{ message: "not found" }] });
    const r = await sendgridClient({
      operation: "contact_get",
      api_key: FAKE_KEY,
      contact_id: "missing_id",
    });
    assert(r.exists === false && r.contact_id === "missing_id", "A6: contact_get 404 returns {exists:false}");
    restore();
  }

  // A7: contact_count returns count body
  {
    const restore = mockHttps(200, { contact_count: 42 });
    const r = await sendgridClient({ operation: "contact_count", api_key: FAKE_KEY });
    assert(r.contact_count === 42, "A7: contact_count returns {contact_count}");
    restore();
  }

  // A8: list_create returns new list
  {
    const restore = mockHttps(200, { id: "list_001", name: "My List" });
    const r = await sendgridClient({ operation: "list_create", api_key: FAKE_KEY, name: "My List" });
    assert(r.id === "list_001", "A8: list_create returns new list with id");
    restore();
  }

  // A9: list_get 404 returns exists:false
  {
    const restore = mockHttps(404, { errors: [] });
    const r = await sendgridClient({ operation: "list_get", api_key: FAKE_KEY, list_id: "bad_list" });
    assert(r.exists === false, "A9: list_get 404 returns {exists:false}");
    restore();
  }

  // A10: template_create returns new template
  {
    const restore = mockHttps(200, { id: "d-tmpl_001", name: "My Template" });
    const r = await sendgridClient({ operation: "template_create", api_key: FAKE_KEY, name: "My Template" });
    assert(r.id === "d-tmpl_001", "A10: template_create returns template id");
    restore();
  }

  // A11: template_delete 204 returns {deleted:true}
  {
    const restore = mockHttpsEmpty(204);
    const r = await sendgridClient({ operation: "template_delete", api_key: FAKE_KEY, template_id: "d-abc" });
    assert(r.deleted === true, "A11: template_delete 204 returns {deleted:true}");
    restore();
  }

  // A12: template_delete 404 returns {deleted:false}
  {
    const restore = mockHttps(404, { errors: [] });
    const r = await sendgridClient({ operation: "template_delete", api_key: FAKE_KEY, template_id: "d-bad" });
    assert(r.deleted === false, "A12: template_delete 404 returns {deleted:false}");
    restore();
  }

  // A13: suppression_get returns suppression array
  {
    const restore = mockHttps(200, [{ email: "spam@example.com", created: 1 }]);
    const r = await sendgridClient({
      operation: "suppression_get",
      api_key: FAKE_KEY,
      suppression_type: "bounces",
    });
    assert(Array.isArray(r) && r[0].email === "spam@example.com", "A13: suppression_get returns array");
    restore();
  }

  // A14: suppression_delete 204 returns {deleted:true}
  {
    const restore = mockHttpsEmpty(204);
    const r = await sendgridClient({
      operation: "suppression_delete",
      api_key: FAKE_KEY,
      suppression_type: "bounces",
      email: "spam@example.com",
    });
    assert(r.deleted === true, "A14: suppression_delete 204 returns {deleted:true}");
    restore();
  }

  // A15: sender_list returns array
  {
    const restore = mockHttps(200, [{ id: 1, from: { email: "s@e.com" } }]);
    const r = await sendgridClient({ operation: "sender_list", api_key: FAKE_KEY });
    assert(Array.isArray(r) && r[0].id === 1, "A15: sender_list returns array of senders");
    restore();
  }

  // A16: stats_global returns stats array
  {
    const restore = mockHttps(200, [{ date: "2024-01-01", stats: [] }]);
    const r = await sendgridClient({
      operation: "stats_global",
      api_key: FAKE_KEY,
      start_date: "2024-01-01",
    });
    assert(Array.isArray(r) && r[0].date === "2024-01-01", "A16: stats_global returns stats array");
    restore();
  }

  // A17: api_key_create returns new key
  {
    const restore = mockHttps(201, { api_key_id: "key_001", name: "My Key" });
    const r = await sendgridClient({ operation: "api_key_create", api_key: FAKE_KEY, name: "My Key" });
    assert(r.api_key_id === "key_001", "A17: api_key_create returns new key object");
    restore();
  }

  // A18: batch_id_generate returns batch_id
  {
    const restore = mockHttps(201, { batch_id: "HkJ22lkH" });
    const r = await sendgridClient({ operation: "batch_id_generate", api_key: FAKE_KEY });
    assert(r.batch_id === "HkJ22lkH", "A18: batch_id_generate returns {batch_id}");
    restore();
  }

  // A19: user_get returns profile
  {
    const restore = mockHttps(200, { username: "testuser", email: "owner@example.com" });
    const r = await sendgridClient({ operation: "user_get", api_key: FAKE_KEY });
    assert(r.username === "testuser", "A19: user_get returns user profile");
    restore();
  }

  // A20: account_get returns account
  {
    const restore = mockHttps(200, { type: "free", reputation: 95 });
    const r = await sendgridClient({ operation: "account_get", api_key: FAKE_KEY });
    assert(r.type === "free", "A20: account_get returns account details");
    restore();
  }

  // A21: generic request GET returns body
  {
    const restore = mockHttps(200, { items: [] });
    const r = await sendgridClient({
      operation: "request",
      api_key: FAKE_KEY,
      method: "GET",
      path: "/stats",
    });
    assert(r && "items" in r, "A21: generic request GET returns body");
    restore();
  }

  // A22: unsubscribe_group_list returns array
  {
    const restore = mockHttps(200, [{ id: 1, name: "Weekly Digest" }]);
    const r = await sendgridClient({ operation: "unsubscribe_group_list", api_key: FAKE_KEY });
    assert(Array.isArray(r) && r[0].id === 1, "A22: unsubscribe_group_list returns array");
    restore();
  }

  // A23: mail_send with array `to` includes all addresses in result
  {
    const restore = mockHttpsEmpty(202);
    const r = await sendgridClient({
      operation: "mail_send",
      api_key: FAKE_KEY,
      to: ["alice@example.com", "bob@example.com"],
      from: "sender@example.com",
      subject: "Bulk",
      text: "Hi both",
    });
    assert(
      r.to.includes("alice@example.com") && r.to.includes("bob@example.com"),
      "A23: mail_send with array to includes all addresses"
    );
    restore();
  }

  // A24: list_delete 202 returns queued:true
  {
    const restore = mockHttps(202, "");
    const r = await sendgridClient({ operation: "list_delete", api_key: FAKE_KEY, list_id: "list_abc" });
    assert(r.queued === true, "A24: list_delete 202 returns {queued:true}");
    restore();
  }

  // A25: scheduled_send_delete 204 returns {deleted:true}
  {
    const restore = mockHttpsEmpty(204);
    const r = await sendgridClient({
      operation: "scheduled_send_delete",
      api_key: FAKE_KEY,
      batch_id: "HkJ22lkH",
    });
    assert(r.deleted === true, "A25: scheduled_send_delete 204 returns {deleted:true}");
    restore();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// B — Validation (empty/invalid inputs)
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[B] Validation tests");

async function testB() {
  // B1: missing operation throws
  await assertRejects(
    () => sendgridClient({ api_key: FAKE_KEY }),
    /operation.*required|non-empty/i, "B1: missing operation throws"
  );

  // B2: missing api_key throws
  await assertRejects(
    () => sendgridClient({ operation: "info" }),
    /api_key.*required|non-empty/i, "B2: missing api_key throws"
  );

  // B3: invalid api_key prefix throws
  await assertRejects(
    () => sendgridClient({ operation: "user_get", api_key: "NOTANSGKEY" }),
    /api_key.*must start.*SG\./i, "B3: invalid api_key prefix throws"
  );

  // B4: unknown operation throws descriptive error
  await assertRejects(
    () => sendgridClient({ operation: "banana", api_key: FAKE_KEY }),
    /Unknown operation.*banana/i, "B4: unknown operation throws descriptive error"
  );

  // B5: mail_send missing `to` throws
  await assertRejects(
    () => sendgridClient({ operation: "mail_send", api_key: FAKE_KEY, from: "s@e.com", subject: "Hi", text: "Hi" }),
    /to.*required/i, "B5: mail_send missing to throws"
  );

  // B6: mail_send missing `from` throws
  await assertRejects(
    () => sendgridClient({ operation: "mail_send", api_key: FAKE_KEY, to: "r@e.com", subject: "Hi", text: "Hi" }),
    /from.*required/i, "B6: mail_send missing from throws"
  );

  // B7: mail_send missing subject AND template_id throws
  await assertRejects(
    () => sendgridClient({ operation: "mail_send", api_key: FAKE_KEY, to: "r@e.com", from: "s@e.com", text: "Hi" }),
    /subject or template_id.*required/i, "B7: mail_send missing subject+template_id throws"
  );

  // B8: mail_send missing content AND template_id throws
  await assertRejects(
    () => sendgridClient({ operation: "mail_send", api_key: FAKE_KEY, to: "r@e.com", from: "s@e.com", subject: "Hi" }),
    /text.*html.*content.*template_id.*required/i,
    "B8: mail_send missing content+template_id throws"
  );

  // B9: contact_upsert missing contacts throws
  await assertRejects(
    () => sendgridClient({ operation: "contact_upsert", api_key: FAKE_KEY }),
    /contacts.*array.*required/i, "B9: contact_upsert missing contacts throws"
  );

  // B10: contact_upsert with empty array throws
  await assertRejects(
    () => sendgridClient({ operation: "contact_upsert", api_key: FAKE_KEY, contacts: [] }),
    /contacts.*array.*required/i, "B10: contact_upsert with empty contacts[] throws"
  );

  // B11: suppression_get invalid suppression_type throws
  await assertRejects(
    () => sendgridClient({ operation: "suppression_get", api_key: FAKE_KEY, suppression_type: "unknown" }),
    /suppression_type.*must be one of/i, "B11: suppression_get invalid type throws"
  );

  // B12: list_add_contacts missing contact_ids throws
  await assertRejects(
    () => sendgridClient({ operation: "list_add_contacts", api_key: FAKE_KEY, list_id: "list_1" }),
    /contact_ids.*array.*required/i, "B12: list_add_contacts missing contact_ids throws"
  );

  // B13: scheduled_send_create invalid status throws
  await assertRejects(
    () => sendgridClient({ operation: "scheduled_send_create", api_key: FAKE_KEY, batch_id: "HkJ", status: "stop" }),
    /status.*cancel.*pause/i, "B13: scheduled_send_create invalid status throws"
  );

  // B14: generic request with unsupported method throws
  await assertRejects(
    () => sendgridClient({ operation: "request", api_key: FAKE_KEY, method: "HEAD", path: "/stats" }),
    /Unsupported method|HEAD/i, "B14: generic request with HEAD method throws"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// C — Mock network failures
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[C] Mock-network tests");

async function testC() {
  // C1: network error propagates
  {
    const restore = mockHttpsError("ECONNREFUSED");
    await assertRejects(
      () => sendgridClient({ operation: "user_get", api_key: FAKE_KEY }),
      /ECONNREFUSED/i, "C1: network error propagates"
    );
    restore();
  }

  // C2: SendGrid 4xx throws with status
  {
    const restore = mockHttps(400, { errors: [{ message: "Bad request" }] });
    await assertRejects(
      () => sendgridClient({ operation: "mail_send", api_key: FAKE_KEY, to: "a@b.com", from: "s@e.com", subject: "x", text: "y" }),
      /SendGrid API error 400/i, "C2: SendGrid 400 error is thrown"
    );
    restore();
  }

  // C3: SendGrid 5xx throws with status
  {
    const restore = mockHttps(503, { errors: [{ message: "Service unavailable" }] });
    await assertRejects(
      () => sendgridClient({ operation: "user_get", api_key: FAKE_KEY }),
      /SendGrid API error 503/i, "C3: SendGrid 503 error is thrown"
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
      () => sendgridClient({ operation: "user_get", api_key: FAKE_KEY, timeout: 50 }),
      /timed out|hang up/i, "C4: request times out"
    );
    https.request = original;
  }

  // C5: empty 202 response for mail_send returns {sent:true}
  {
    const restore = mockHttpsEmpty(202);
    const r = await sendgridClient({
      operation: "mail_send",
      api_key: FAKE_KEY,
      to: "a@b.com",
      from: "s@e.com",
      subject: "x",
      text: "y",
    });
    assert(r.sent === true, "C5: empty 202 mail_send returns {sent:true}");
    restore();
  }

  // C6: non-JSON response returns {_raw}
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
    const r = await sendgridClient({ operation: "user_get", api_key: FAKE_KEY });
    assert(r && r._raw, "C6: non-JSON response body returned as {_raw}");
    https.request = original;
  }

  // C7: response body exceeds 16 MB cap
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
      () => sendgridClient({ operation: "user_get", api_key: FAKE_KEY }),
      /16 MB|exceeds/i, "C7: 17 MB response exceeds 16 MB cap"
    );
    https.request = original;
  }

  // C8: Bearer Authorization header is sent correctly
  {
    let capturedAuth = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedAuth = opts.headers.Authorization;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ username: "u" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await sendgridClient({ operation: "user_get", api_key: FAKE_KEY });
    assert(capturedAuth === `Bearer ${FAKE_KEY}`, "C8: Bearer auth header sent correctly");
    https.request = original;
  }

  // C9: mail_send POST body is JSON with personalizations+from
  {
    let capturedBody = null;
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 202;
      process.nextTick(() => { cb(res); res.emit("end"); });
      const req = new EventEmitter();
      req.write = (b) => { capturedBody = b; };
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await sendgridClient({
      operation: "mail_send",
      api_key: FAKE_KEY,
      to: "alice@example.com",
      from: "sender@example.com",
      subject: "Test",
      text: "Body",
    });
    let parsed;
    try { parsed = JSON.parse(capturedBody); } catch (_) {}
    assert(parsed && parsed.personalizations && parsed.from, "C9: mail_send sends JSON body with personalizations+from");
    https.request = original;
  }

  // C10: GET requests send params as query string
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify([]))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await sendgridClient({
      operation: "stats_global",
      api_key: FAKE_KEY,
      start_date: "2024-01-01",
      end_date: "2024-01-31",
    });
    assert(capturedPath && capturedPath.includes("start_date=2024-01-01"), "C10: GET stats sends query string params");
    https.request = original;
  }

  // C11: suppression_delete 404 returns {deleted:false}
  {
    const restore = mockHttps(404, { errors: [] });
    const r = await sendgridClient({
      operation: "suppression_delete",
      api_key: FAKE_KEY,
      suppression_type: "bounces",
      email: "gone@example.com",
    });
    assert(r.deleted === false && r.email === "gone@example.com", "C11: suppression_delete 404 returns {deleted:false}");
    restore();
  }

  // C12: contact_delete 202 returns queued:true
  {
    const restore = mockHttps(202, "");
    const r = await sendgridClient({
      operation: "contact_delete",
      api_key: FAKE_KEY,
      ids: ["id_001", "id_002"],
    });
    assert(r.queued === true, "C12: contact_delete 202 returns {queued:true}");
    restore();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// D — Security (sanitization, injection, credentials scrubbing)
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[D] Security tests");

async function testD() {
  // D1: NUL byte in api_key throws
  await assertRejects(
    () => sendgridClient({ operation: "user_get", api_key: "SG.\x00evil" }),
    /NUL|api_key/i, "D1: NUL byte in api_key is rejected"
  );

  // D2: NUL byte in contact_id throws
  await assertRejects(
    () => sendgridClient({ operation: "contact_get", api_key: FAKE_KEY, contact_id: "id\x00evil" }),
    /NUL|contact_id/i, "D2: NUL byte in contact_id is rejected"
  );

  // D3: api_key scrubbed from network error messages
  {
    const canaryKey = "SG.canary_secret.aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const restore = mockHttpsError(`Connection refused key=${canaryKey}`);
    try {
      await sendgridClient({ operation: "user_get", api_key: canaryKey });
      assert(false, "D3: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryKey), "D3: api_key scrubbed from error message");
    }
    restore();
  }

  // D4: api_key scrubbed from API error body
  {
    const canaryKey = "SG.canary_body.bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const restore = mockHttps(401, { errors: [{ message: `Invalid key ${canaryKey}` }] });
    try {
      await sendgridClient({ operation: "user_get", api_key: canaryKey });
      assert(false, "D4: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryKey), "D4: api_key scrubbed from API error body");
    }
    restore();
  }

  // D5: reject_unauthorized defaults to true
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ username: "u" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await sendgridClient({ operation: "user_get", api_key: FAKE_KEY });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === true, "D5: reject_unauthorized defaults to true");
    https.request = original;
  }

  // D6: reject_unauthorized=false is forwarded
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ username: "u" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await sendgridClient({ operation: "user_get", api_key: FAKE_KEY, reject_unauthorized: false });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === false, "D6: reject_unauthorized:false forwarded");
    https.request = original;
  }

  // D7: huge timeout clamped, request still works
  {
    const restore = mockHttps(200, { username: "u" });
    const r = await sendgridClient({ operation: "user_get", api_key: FAKE_KEY, timeout: 999999 });
    assert(r && r.username === "u", "D7: huge timeout clamped, request still works");
    restore();
  }

  // D8: tiny timeout clamped to min, request still works
  {
    const restore = mockHttps(200, { username: "u" });
    const r = await sendgridClient({ operation: "user_get", api_key: FAKE_KEY, timeout: 1 });
    assert(r && r.username === "u", "D8: tiny timeout clamped to 1000ms, request still works");
    restore();
  }

  // D9: NUL byte in list_id is rejected
  await assertRejects(
    () => sendgridClient({ operation: "list_get", api_key: FAKE_KEY, list_id: "list\x00hack" }),
    /NUL|list_id/i, "D9: NUL byte in list_id is rejected"
  );

  // D10: NUL byte in template_id is rejected
  await assertRejects(
    () => sendgridClient({ operation: "template_get", api_key: FAKE_KEY, template_id: "d-\x00hack" }),
    /NUL|template_id/i, "D10: NUL byte in template_id is rejected"
  );

  // D11: NUL byte in email is rejected
  await assertRejects(
    () => sendgridClient({
      operation: "suppression_delete",
      api_key: FAKE_KEY,
      suppression_type: "bounces",
      email: "evil\x00@example.com",
    }),
    /NUL|email/i, "D11: NUL byte in email is rejected"
  );

  // D12: api_key not leaked in returned body
  {
    const restore = mockHttps(200, { username: "owner", email: "o@e.com" });
    const profile = await sendgridClient({ operation: "user_get", api_key: FAKE_KEY });
    assert(!JSON.stringify(profile).includes(FAKE_KEY), "D12: api_key not leaked in returned body");
    restore();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// E — Concurrency / stress
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[E] Concurrency tests");

async function testE() {
  // E1: 20 concurrent user_get calls all succeed
  {
    const restore = mockHttps(200, { username: "u", email: "u@x.com" });
    const tasks = Array.from({ length: 20 }, () =>
      sendgridClient({ operation: "user_get", api_key: FAKE_KEY })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 20 && results.every(r => r.username === "u"),
      "E1: 20 concurrent user_get calls all succeed");
    restore();
  }

  // E2: 10 concurrent mail_send calls all succeed
  {
    const restore = mockHttpsEmpty(202);
    const tasks = Array.from({ length: 10 }, () =>
      sendgridClient({
        operation: "mail_send",
        api_key: FAKE_KEY,
        to: "a@b.com",
        from: "s@e.com",
        subject: "Hi",
        text: "Body",
      })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 10 && results.every(r => r.sent === true),
      "E2: 10 concurrent mail_send calls all succeed");
    restore();
  }

  // E3: mix of success and validation errors in parallel
  {
    const restore = mockHttps(200, { username: "u" });
    const tasks = [
      sendgridClient({ operation: "user_get", api_key: FAKE_KEY }),
      sendgridClient({ operation: "user_get" }).catch(e => e),  // missing api_key
      sendgridClient({ operation: "user_get", api_key: FAKE_KEY }),
    ];
    const [r1, r2, r3] = await Promise.all(tasks);
    assert(r1.username === "u" && r2 instanceof Error && r3.username === "u",
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
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ username: "u" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 15 }, () =>
      sendgridClient({ operation: "user_get", api_key: FAKE_KEY })
    );
    const results = await Promise.all(tasks);
    assert(callCount === 15 && results.length === 15, "E4: 15 rapid calls, no state leakage");
    https.request = original;
  }

  // E5: concurrent network errors propagate independently
  {
    const restore = mockHttpsError("ECONNRESET");
    const tasks = Array.from({ length: 8 }, () =>
      sendgridClient({ operation: "user_get", api_key: FAKE_KEY }).catch(e => e)
    );
    const results = await Promise.all(tasks);
    assert(results.length === 8 && results.every(e => e instanceof Error && /ECONNRESET/i.test(e.message)),
      "E5: 8 concurrent network errors all propagate independently");
    restore();
  }

  // E6: 5 concurrent different operations don't interfere
  {
    const restore = mockHttps(200, { result: "ok" });
    const tasks = [
      sendgridClient({ operation: "user_get", api_key: FAKE_KEY }),
      sendgridClient({ operation: "account_get", api_key: FAKE_KEY }),
      sendgridClient({ operation: "api_key_list", api_key: FAKE_KEY }),
      sendgridClient({ operation: "sender_list", api_key: FAKE_KEY }),
      sendgridClient({ operation: "unsubscribe_group_list", api_key: FAKE_KEY }),
    ];
    const results = await Promise.all(tasks);
    assert(results.length === 5 && results.every(r => r.result === "ok"),
      "E6: 5 concurrent different operations succeed without interference");
    restore();
  }

  // E7: 50 sequential validation rejections don't accumulate
  {
    let errCount = 0;
    for (let i = 0; i < 50; i++) {
      await sendgridClient({ operation: "contact_upsert", api_key: FAKE_KEY }).catch(() => errCount++);
    }
    assert(errCount === 50, "E7: 50 sequential validation errors all caught cleanly");
  }

  // E8: 10 concurrent calls: 5 succeed + 5 fail (toggled)
  {
    let toggle = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      const mine = toggle++;
      const statusCode = mine % 2 === 0 ? 200 : 401;
      const body = mine % 2 === 0
        ? { username: "u" }
        : { errors: [{ message: "Unauthorized" }] };
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
      sendgridClient({ operation: "user_get", api_key: FAKE_KEY }).catch(e => ({ error: e.message }))
    );
    const results = await Promise.all(tasks);
    const successes = results.filter(r => r.username === "u").length;
    const failures  = results.filter(r => r.error).length;
    assert(successes === 5 && failures === 5, "E8: 10 concurrent: 5 succeed + 5 fail correctly");
    https.request = original;
  }

  // E9: concurrent calls with different api_keys don't cross-contaminate
  {
    const key1 = "SG.key1_aaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const key2 = "SG.key2_bbbb.bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const auths = [];
    const original = https.request;
    https.request = (opts, cb) => {
      auths.push(opts.headers.Authorization);
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ username: "u" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end   = () => {};
      req.destroy = () => {};
      return req;
    };
    await Promise.all([
      sendgridClient({ operation: "user_get", api_key: key1 }),
      sendgridClient({ operation: "user_get", api_key: key2 }),
    ]);
    assert(
      auths.some(a => a === `Bearer ${key1}`) && auths.some(a => a === `Bearer ${key2}`),
      "E9: concurrent calls with different api_keys send correct individual auth headers"
    );
    https.request = original;
  }

  // E10: 30 concurrent contact_count calls all succeed
  {
    const restore = mockHttps(200, { contact_count: 100 });
    const tasks = Array.from({ length: 30 }, () =>
      sendgridClient({ operation: "contact_count", api_key: FAKE_KEY })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 30 && results.every(r => r.contact_count === 100),
      "E10: 30 concurrent contact_count calls all succeed");
    restore();
  }
}

// ── Run all ──────────────────────────────────────────────────────────────────
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
