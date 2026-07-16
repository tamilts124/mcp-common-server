"use strict";
/**
 * test/sections/288-hubspot-client.js
 * Isolated tests for hubspotClientOps.js
 * 5 rigor levels: A=normal, B=validation, C=mock-network, D=security, E=concurrency
 */
const https = require("https");
const { EventEmitter } = require("events");
const { hubspotClient } = require("../../lib/hubspotClientOps");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.error(`  \u2717 FAIL: ${msg}`);
    failed++;
  }
}

async function assertRejects(fn, pattern, msg) {
  try {
    await fn();
    console.error(`  \u2717 FAIL (no throw): ${msg}`);
    failed++;
  } catch (e) {
    const ok = pattern ? (e.message || "").match(pattern) : true;
    if (ok) {
      console.log(`  \u2713 ${msg}`);
      passed++;
    } else {
      console.error(`  \u2717 FAIL (wrong error: ${e.message}): ${msg}`);
      failed++;
    }
  }
}

// ── Mock HTTPS helpers ────────────────────────────────────────────────────────
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
    req.write   = () => {};
    req.end     = () => {};
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
    req.write   = () => {};
    req.end     = () => {};
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

function mockHttpsError(errMsg) {
  const original = https.request;
  https.request = (_opts, _cb) => {
    const req = new EventEmitter();
    req.write   = () => {};
    req.end     = () => { process.nextTick(() => req.emit("error", new Error(errMsg))); };
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

const FAKE_TOKEN = "pat-na1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

// ════════════════════════════════════════════════════════════════════════════
// A — Normal / happy-path assertions
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[A] Normal / happy-path tests");

async function testA() {
  // A1: crm_create returns 201 body
  {
    const restore = mockHttps(201, { id: "1001", properties: { email: "a@b.com" } });
    const r = await hubspotClient({
      operation: "crm_create",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      properties: { email: "a@b.com" },
    });
    assert(r.id === "1001", "A1: crm_create returns 201 body with id");
    restore();
  }

  // A2: crm_get returns 200 body
  {
    const restore = mockHttps(200, { id: "1001", properties: { firstname: "Alice" } });
    const r = await hubspotClient({
      operation: "crm_get",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      object_id: "1001",
    });
    assert(r.id === "1001" && r.properties.firstname === "Alice", "A2: crm_get returns object");
    restore();
  }

  // A3: crm_get 404 returns {exists: false}
  {
    const restore = mockHttps(404, { status: "error", message: "not found" });
    const r = await hubspotClient({
      operation: "crm_get",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      object_id: "missing",
    });
    assert(r.exists === false && r.object_id === "missing", "A3: crm_get 404 returns {exists:false}");
    restore();
  }

  // A4: crm_list returns results array
  {
    const restore = mockHttps(200, { results: [{ id: "1" }, { id: "2" }], paging: {} });
    const r = await hubspotClient({
      operation: "crm_list",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
    });
    assert(Array.isArray(r.results) && r.results.length === 2, "A4: crm_list returns results array");
    restore();
  }

  // A5: crm_update returns 200 body
  {
    const restore = mockHttps(200, { id: "1001", properties: { firstname: "Bob" } });
    const r = await hubspotClient({
      operation: "crm_update",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      object_id: "1001",
      properties: { firstname: "Bob" },
    });
    assert(r.id === "1001", "A5: crm_update returns updated object");
    restore();
  }

  // A6: crm_delete 204 returns {deleted:true}
  {
    const restore = mockHttpsEmpty(204);
    const r = await hubspotClient({
      operation: "crm_delete",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      object_id: "1001",
    });
    assert(r.deleted === true && r.object_id === "1001", "A6: crm_delete returns {deleted:true}");
    restore();
  }

  // A7: crm_delete 404 returns {deleted:false}
  {
    const restore = mockHttps(404, { status: "error" });
    const r = await hubspotClient({
      operation: "crm_delete",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      object_id: "missing",
    });
    assert(r.deleted === false, "A7: crm_delete 404 returns {deleted:false}");
    restore();
  }

  // A8: crm_search returns results
  {
    const restore = mockHttps(200, { results: [{ id: "2001" }], total: 1 });
    const r = await hubspotClient({
      operation: "crm_search",
      access_token: FAKE_TOKEN,
      object_type: "deals",
      query: "big deal",
    });
    assert(r.total === 1 && r.results[0].id === "2001", "A8: crm_search returns results");
    restore();
  }

  // A9: crm_batch_create returns batch results
  {
    const restore = mockHttps(201, { status: "COMPLETE", results: [{ id: "3001" }, { id: "3002" }] });
    const r = await hubspotClient({
      operation: "crm_batch_create",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      inputs: [{ properties: { email: "a@x.com" } }, { properties: { email: "b@x.com" } }],
    });
    assert(r.results.length === 2, "A9: crm_batch_create returns batch results");
    restore();
  }

  // A10: association_create returns {associated:true} when body is null
  {
    const restore = mockHttpsEmpty(200);
    const r = await hubspotClient({
      operation: "association_create",
      access_token: FAKE_TOKEN,
      from_object_type: "contacts",
      from_object_id: "1001",
      to_object_type: "companies",
      to_object_id: "2001",
      association_type: "1",
    });
    assert(r.associated === true, "A10: association_create empty 200 returns {associated:true}");
    restore();
  }

  // A11: association_list returns body
  {
    const restore = mockHttps(200, { results: [{ toObjectId: "2001" }], paging: {} });
    const r = await hubspotClient({
      operation: "association_list",
      access_token: FAKE_TOKEN,
      from_object_type: "contacts",
      from_object_id: "1001",
      to_object_type: "companies",
    });
    assert(r.results[0].toObjectId === "2001", "A11: association_list returns results");
    restore();
  }

  // A12: property_list returns results
  {
    const restore = mockHttps(200, { results: [{ name: "email" }] });
    const r = await hubspotClient({
      operation: "property_list",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
    });
    assert(r.results[0].name === "email", "A12: property_list returns property array");
    restore();
  }

  // A13: property_get 404 returns {exists:false}
  {
    const restore = mockHttps(404, { status: "error" });
    const r = await hubspotClient({
      operation: "property_get",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      property_name: "no_such_prop",
    });
    assert(r.exists === false && r.property_name === "no_such_prop", "A13: property_get 404 returns {exists:false}");
    restore();
  }

  // A14: pipeline_list returns results
  {
    const restore = mockHttps(200, { results: [{ id: "default", label: "Default" }] });
    const r = await hubspotClient({
      operation: "pipeline_list",
      access_token: FAKE_TOKEN,
      object_type: "deals",
    });
    assert(r.results[0].id === "default", "A14: pipeline_list returns pipelines");
    restore();
  }

  // A15: owner_list returns results
  {
    const restore = mockHttps(200, { results: [{ id: 101, email: "owner@co.com" }] });
    const r = await hubspotClient({
      operation: "owner_list",
      access_token: FAKE_TOKEN,
    });
    assert(r.results[0].id === 101, "A15: owner_list returns owners");
    restore();
  }

  // A16: owner_get 404 returns {exists:false}
  {
    const restore = mockHttps(404, { status: "error" });
    const r = await hubspotClient({
      operation: "owner_get",
      access_token: FAKE_TOKEN,
      owner_id: "99999",
    });
    assert(r.exists === false && r.owner_id === "99999", "A16: owner_get 404 returns {exists:false}");
    restore();
  }

  // A17: contact_create returns 201 body
  {
    const restore = mockHttps(201, { id: "5001", properties: { email: "jane@x.com" } });
    const r = await hubspotClient({
      operation: "contact_create",
      access_token: FAKE_TOKEN,
      email: "jane@x.com",
      firstname: "Jane",
    });
    assert(r.id === "5001", "A17: contact_create returns created contact");
    restore();
  }

  // A18: contact_get_by_email found returns first result
  {
    const restore = mockHttps(200, { results: [{ id: "5001", properties: { email: "jane@x.com" } }] });
    const r = await hubspotClient({
      operation: "contact_get_by_email",
      access_token: FAKE_TOKEN,
      email: "jane@x.com",
    });
    assert(r.id === "5001", "A18: contact_get_by_email returns match");
    restore();
  }

  // A19: contact_get_by_email not found returns {exists:false}
  {
    const restore = mockHttps(200, { results: [] });
    const r = await hubspotClient({
      operation: "contact_get_by_email",
      access_token: FAKE_TOKEN,
      email: "nobody@x.com",
    });
    assert(r.exists === false && r.email === "nobody@x.com", "A19: contact_get_by_email not found returns {exists:false}");
    restore();
  }

  // A20: deal_create returns 201 body
  {
    const restore = mockHttps(201, { id: "6001", properties: { dealname: "Mega Deal" } });
    const r = await hubspotClient({
      operation: "deal_create",
      access_token: FAKE_TOKEN,
      dealname: "Mega Deal",
      amount: 50000,
    });
    assert(r.id === "6001", "A20: deal_create returns created deal");
    restore();
  }

  // A21: company_create returns 201 body
  {
    const restore = mockHttps(201, { id: "7001", properties: { name: "Acme Corp" } });
    const r = await hubspotClient({
      operation: "company_create",
      access_token: FAKE_TOKEN,
      name: "Acme Corp",
      domain: "acme.com",
    });
    assert(r.id === "7001", "A21: company_create returns created company");
    restore();
  }

  // A22: generic request returns body
  {
    const restore = mockHttps(200, { total: 99, results: [] });
    const r = await hubspotClient({
      operation: "request",
      access_token: FAKE_TOKEN,
      method: "GET",
      path: "/crm/v3/objects/contacts",
    });
    assert(r.total === 99, "A22: generic GET request returns body");
    restore();
  }

  // A23: timeline_event_create 201 returns body
  {
    const restore = mockHttps(201, { id: "evt_001", objectId: "1001" });
    const r = await hubspotClient({
      operation: "timeline_event_create",
      access_token: FAKE_TOKEN,
      event_template_id: "tmpl_001",
      object_id: "1001",
      app_id: "app_001",
    });
    assert(r.id === "evt_001", "A23: timeline_event_create returns event body");
    restore();
  }

  // A24: crm_batch_read returns results
  {
    const restore = mockHttps(200, { results: [{ id: "1001" }, { id: "1002" }] });
    const r = await hubspotClient({
      operation: "crm_batch_read",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      inputs: [{ id: "1001" }, { id: "1002" }],
    });
    assert(r.results.length === 2, "A24: crm_batch_read returns results");
    restore();
  }

  // A25: pipeline_stage_list returns results
  {
    const restore = mockHttps(200, { results: [{ id: "stage1", label: "Qualified" }] });
    const r = await hubspotClient({
      operation: "pipeline_stage_list",
      access_token: FAKE_TOKEN,
      object_type: "deals",
      pipeline_id: "default",
    });
    assert(r.results[0].id === "stage1", "A25: pipeline_stage_list returns stages");
    restore();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// B — Validation (empty/invalid inputs)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[B] Validation tests");

async function testB() {
  // B1: missing operation throws
  await assertRejects(
    () => hubspotClient({ access_token: FAKE_TOKEN }),
    /operation.*required|non-empty/i, "B1: missing operation throws"
  );

  // B2: missing access_token throws
  await assertRejects(
    () => hubspotClient({ operation: "owner_list" }),
    /access_token.*required|non-empty/i, "B2: missing access_token throws"
  );

  // B3: unknown operation throws descriptive error
  await assertRejects(
    () => hubspotClient({ operation: "banana", access_token: FAKE_TOKEN }),
    /Unknown operation.*banana/i, "B3: unknown operation throws descriptive error"
  );

  // B4: crm_create missing object_type throws
  await assertRejects(
    () => hubspotClient({ operation: "crm_create", access_token: FAKE_TOKEN, properties: { email: "a@b.com" } }),
    /object_type.*one of|required/i, "B4: crm_create missing object_type throws"
  );

  // B5: crm_create invalid object_type throws
  await assertRejects(
    () => hubspotClient({ operation: "crm_create", access_token: FAKE_TOKEN, object_type: "unicorns", properties: {} }),
    /object_type must be one of/i, "B5: crm_create invalid object_type throws"
  );

  // B6: crm_create missing properties throws
  await assertRejects(
    () => hubspotClient({ operation: "crm_create", access_token: FAKE_TOKEN, object_type: "contacts" }),
    /properties.*required/i, "B6: crm_create missing properties throws"
  );

  // B7: crm_batch_create with empty inputs throws
  await assertRejects(
    () => hubspotClient({ operation: "crm_batch_create", access_token: FAKE_TOKEN, object_type: "contacts", inputs: [] }),
    /inputs.*required/i, "B7: crm_batch_create with empty inputs throws"
  );

  // B8: crm_batch_read with non-array inputs throws
  await assertRejects(
    () => hubspotClient({ operation: "crm_batch_read", access_token: FAKE_TOKEN, object_type: "contacts", inputs: "bad" }),
    /inputs.*required/i, "B8: crm_batch_read with non-array inputs throws"
  );

  // B9: crm_get missing object_id throws
  await assertRejects(
    () => hubspotClient({ operation: "crm_get", access_token: FAKE_TOKEN, object_type: "contacts" }),
    /object_id.*required|non-empty/i, "B9: crm_get missing object_id throws"
  );

  // B10: association_create missing from_object_type throws
  await assertRejects(
    () => hubspotClient({
      operation: "association_create",
      access_token: FAKE_TOKEN,
      from_object_id: "1",
      to_object_type: "companies",
      to_object_id: "2",
      association_type: "1",
    }),
    /from_object_type.*required|non-empty/i, "B10: association_create missing from_object_type throws"
  );

  // B11: property_create missing required fields throws
  await assertRejects(
    () => hubspotClient({
      operation: "property_create",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      // missing name, label, type, field_type, group_name
    }),
    /name.*required|non-empty/i, "B11: property_create missing name throws"
  );

  // B12: contact_create with no properties at all throws
  await assertRejects(
    () => hubspotClient({ operation: "contact_create", access_token: FAKE_TOKEN }),
    /At least one contact property/i, "B12: contact_create with no properties throws"
  );

  // B13: deal_create missing dealname throws
  await assertRejects(
    () => hubspotClient({ operation: "deal_create", access_token: FAKE_TOKEN }),
    /dealname.*required|non-empty/i, "B13: deal_create missing dealname throws"
  );

  // B14: company_create missing name throws
  await assertRejects(
    () => hubspotClient({ operation: "company_create", access_token: FAKE_TOKEN }),
    /name.*required|non-empty/i, "B14: company_create missing name throws"
  );

  // B15: generic request with unsupported method throws
  await assertRejects(
    () => hubspotClient({ operation: "request", access_token: FAKE_TOKEN, method: "HEAD", path: "/crm/v3/objects/contacts" }),
    /Unsupported method|HEAD/i, "B15: generic request with HEAD method throws"
  );
}

// ════════════════════════════════════════════════════════════════════════════
// C — Mock network failures
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[C] Mock-network tests");

async function testC() {
  // C1: network error propagates
  {
    const restore = mockHttpsError("ECONNREFUSED");
    await assertRejects(
      () => hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN }),
      /ECONNREFUSED/i, "C1: network error propagates"
    );
    restore();
  }

  // C2: HubSpot 4xx throws with status
  {
    const restore = mockHttps(400, { status: "error", message: "Bad request" });
    await assertRejects(
      () => hubspotClient({ operation: "crm_list", access_token: FAKE_TOKEN, object_type: "contacts" }),
      /HubSpot API error 400/i, "C2: HubSpot 400 error is thrown"
    );
    restore();
  }

  // C3: HubSpot 5xx throws with status
  {
    const restore = mockHttps(503, { status: "error", message: "Service unavailable" });
    await assertRejects(
      () => hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN }),
      /HubSpot API error 503/i, "C3: HubSpot 503 error is thrown"
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
      () => hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN, timeout: 50 }),
      /timed out|hang up/i, "C4: request times out"
    );
    https.request = original;
  }

  // C5: Bearer Authorization header is sent correctly
  {
    let capturedAuth = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedAuth = opts.headers["Authorization"];
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ results: [] }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    await hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN });
    assert(capturedAuth === `Bearer ${FAKE_TOKEN}`, "C5: Bearer auth header sent correctly");
    https.request = original;
  }

  // C6: POST body is JSON for crm_create
  {
    let capturedBody = null;
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 201;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ id: "1" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = (b) => { capturedBody = b; };
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    await hubspotClient({
      operation: "crm_create",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      properties: { email: "x@y.com" },
    });
    let parsed;
    try { parsed = JSON.parse(capturedBody); } catch (_) {}
    assert(parsed && parsed.properties && parsed.properties.email === "x@y.com", "C6: crm_create POST body is JSON with properties");
    https.request = original;
  }

  // C7: non-JSON response returns {_raw}
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from("<html>error</html>")); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    const r = await hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN });
    assert(r && r._raw, "C7: non-JSON response body returned as {_raw}");
    https.request = original;
  }

  // C8: response body exceeds 16 MB cap
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
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    await assertRejects(
      () => hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN }),
      /16 MB|exceeds/i, "C8: 17 MB response exceeds 16 MB cap"
    );
    https.request = original;
  }

  // C9: GET params sent as query string (crm_list with limit)
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ results: [] }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    await hubspotClient({
      operation: "crm_list",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      limit: 25,
    });
    assert(capturedPath && capturedPath.includes("limit=25"), "C9: crm_list sends limit as query string");
    https.request = original;
  }

  // C10: crm_delete 204 empty response returns {deleted:true}
  {
    const restore = mockHttpsEmpty(204);
    const r = await hubspotClient({
      operation: "crm_delete",
      access_token: FAKE_TOKEN,
      object_type: "deals",
      object_id: "6001",
    });
    assert(r.deleted === true, "C10: crm_delete 204 empty response returns {deleted:true}");
    restore();
  }

  // C11: timeline_event_create 200 also returns body
  {
    const restore = mockHttps(200, { id: "evt_002", objectId: "1002" });
    const r = await hubspotClient({
      operation: "timeline_event_create",
      access_token: FAKE_TOKEN,
      event_template_id: "tmpl_001",
      object_id: "1002",
      app_id: "app_001",
    });
    assert(r.id === "evt_002", "C11: timeline_event_create 200 returns body");
    restore();
  }

  // C12: crm_search sends filter as POST body
  {
    let capturedBody = null;
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ results: [], total: 0 }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = (b) => { capturedBody = b; };
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    await hubspotClient({
      operation: "crm_search",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      filters: [{ propertyName: "email", operator: "EQ", value: "a@b.com" }],
    });
    let parsed;
    try { parsed = JSON.parse(capturedBody); } catch (_) {}
    assert(parsed && parsed.filterGroups && parsed.filterGroups[0].filters[0].propertyName === "email",
      "C12: crm_search sends filters in POST body");
    https.request = original;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// D — Security (sanitization, injection, credential scrubbing)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[D] Security tests");

async function testD() {
  // D1: NUL byte in access_token throws
  await assertRejects(
    () => hubspotClient({ operation: "owner_list", access_token: "tok\x00en" }),
    /NUL|access_token/i, "D1: NUL byte in access_token is rejected"
  );

  // D2: NUL byte in object_id throws
  await assertRejects(
    () => hubspotClient({
      operation: "crm_get",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      object_id: "id\x00hack",
    }),
    /NUL|object_id/i, "D2: NUL byte in object_id is rejected"
  );

  // D3: access_token scrubbed from network error messages
  {
    const canaryToken = "pat-na1-canary-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const restore = mockHttpsError(`Connection refused token=${canaryToken}`);
    try {
      await hubspotClient({ operation: "owner_list", access_token: canaryToken });
      assert(false, "D3: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryToken), "D3: access_token scrubbed from error message");
    }
    restore();
  }

  // D4: access_token scrubbed from API error body
  {
    const canaryToken = "pat-na1-canary-body-yyyyyyyyyyyyyyyyyyyyyyyyyyyy";
    const restore = mockHttps(401, { message: `Invalid token ${canaryToken}` });
    try {
      await hubspotClient({ operation: "owner_list", access_token: canaryToken });
      assert(false, "D4: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryToken), "D4: access_token scrubbed from API error body");
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
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ results: [] }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    await hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN });
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
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ results: [] }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    await hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN, reject_unauthorized: false });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === false, "D6: reject_unauthorized:false is forwarded");
    https.request = original;
  }

  // D7: huge timeout clamped, request still works
  {
    const restore = mockHttps(200, { results: [] });
    const r = await hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN, timeout: 999999 });
    assert(r && Array.isArray(r.results), "D7: huge timeout clamped, request still works");
    restore();
  }

  // D8: tiny timeout clamped to min, request still works
  {
    const restore = mockHttps(200, { results: [] });
    const r = await hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN, timeout: 1 });
    assert(r && Array.isArray(r.results), "D8: tiny timeout clamped to 1000ms, request still works");
    restore();
  }

  // D9: NUL byte in property_name throws
  await assertRejects(
    () => hubspotClient({
      operation: "property_get",
      access_token: FAKE_TOKEN,
      object_type: "contacts",
      property_name: "prop\x00hack",
    }),
    /NUL|property_name/i, "D9: NUL byte in property_name is rejected"
  );

  // D10: NUL byte in operation throws
  await assertRejects(
    () => hubspotClient({ operation: "crm_\x00get", access_token: FAKE_TOKEN }),
    /NUL|operation/i, "D10: NUL byte in operation is rejected"
  );

  // D11: access_token not leaked in returned body
  {
    const restore = mockHttps(200, { results: [{ id: "1", properties: {} }] });
    const list = await hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN });
    assert(!JSON.stringify(list).includes(FAKE_TOKEN), "D11: access_token not leaked in returned body");
    restore();
  }

  // D12: NUL in from_object_id throws
  await assertRejects(
    () => hubspotClient({
      operation: "association_list",
      access_token: FAKE_TOKEN,
      from_object_type: "contacts",
      from_object_id: "id\x00inject",
      to_object_type: "companies",
    }),
    /NUL|from_object_id/i, "D12: NUL byte in from_object_id is rejected"
  );
}

// ════════════════════════════════════════════════════════════════════════════
// E — Concurrency / stress
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[E] Concurrency tests");

async function testE() {
  // E1: 20 concurrent owner_list calls all succeed
  {
    const restore = mockHttps(200, { results: [{ id: 1, email: "o@co.com" }] });
    const tasks = Array.from({ length: 20 }, () =>
      hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 20 && results.every(r => r.results[0].id === 1),
      "E1: 20 concurrent owner_list calls all succeed");
    restore();
  }

  // E2: 10 concurrent crm_list calls all succeed
  {
    const restore = mockHttps(200, { results: [], paging: {} });
    const tasks = Array.from({ length: 10 }, () =>
      hubspotClient({ operation: "crm_list", access_token: FAKE_TOKEN, object_type: "contacts" })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 10 && results.every(r => Array.isArray(r.results)),
      "E2: 10 concurrent crm_list calls all succeed");
    restore();
  }

  // E3: mix of success and validation errors in parallel
  {
    const restore = mockHttps(200, { results: [] });
    const tasks = [
      hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN }),
      hubspotClient({ operation: "owner_list" }).catch(e => e),  // missing access_token
      hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN }),
    ];
    const [r1, r2, r3] = await Promise.all(tasks);
    assert(Array.isArray(r1.results) && r2 instanceof Error && Array.isArray(r3.results),
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
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ results: [] }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 15 }, () =>
      hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN })
    );
    const results = await Promise.all(tasks);
    assert(callCount === 15 && results.length === 15, "E4: 15 rapid calls, no state leakage");
    https.request = original;
  }

  // E5: concurrent network errors propagate independently
  {
    const restore = mockHttpsError("ECONNRESET");
    const tasks = Array.from({ length: 8 }, () =>
      hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN }).catch(e => e)
    );
    const results = await Promise.all(tasks);
    assert(results.length === 8 && results.every(e => e instanceof Error && /ECONNRESET/i.test(e.message)),
      "E5: 8 concurrent network errors all propagate independently");
    restore();
  }

  // E6: 5 concurrent different operations don't interfere
  {
    const restore = mockHttps(200, { results: [] });
    const tasks = [
      hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN }),
      hubspotClient({ operation: "crm_list", access_token: FAKE_TOKEN, object_type: "contacts" }),
      hubspotClient({ operation: "property_list", access_token: FAKE_TOKEN, object_type: "companies" }),
      hubspotClient({ operation: "pipeline_list", access_token: FAKE_TOKEN, object_type: "deals" }),
      hubspotClient({ operation: "crm_list", access_token: FAKE_TOKEN, object_type: "deals" }),
    ];
    const results = await Promise.all(tasks);
    assert(results.length === 5 && results.every(r => Array.isArray(r.results)),
      "E6: 5 concurrent different operations succeed without interference");
    restore();
  }

  // E7: 50 sequential validation rejections don't accumulate
  {
    let errCount = 0;
    for (let i = 0; i < 50; i++) {
      await hubspotClient({ operation: "crm_create", access_token: FAKE_TOKEN, object_type: "contacts" })
        .catch(() => errCount++);
    }
    assert(errCount === 50, "E7: 50 sequential validation errors all caught cleanly");
  }

  // E8: 10 concurrent calls: 5 succeed + 5 fail (toggled status)
  {
    let toggle = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      const mine = toggle++;
      const statusCode = mine % 2 === 0 ? 200 : 401;
      const body = mine % 2 === 0
        ? { results: [] }
        : { message: "Unauthorized" };
      const res = new EventEmitter();
      res.statusCode = statusCode;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify(body))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 10 }, () =>
      hubspotClient({ operation: "owner_list", access_token: FAKE_TOKEN }).catch(e => ({ error: e.message }))
    );
    const results = await Promise.all(tasks);
    const successes = results.filter(r => r.results).length;
    const failures  = results.filter(r => r.error).length;
    assert(successes === 5 && failures === 5, "E8: 10 concurrent: 5 succeed + 5 fail correctly");
    https.request = original;
  }

  // E9: concurrent calls with different tokens don't cross-contaminate auth headers
  {
    const token1 = "pat-na1-token1-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
    const token2 = "pat-na1-token2-yyyy-yyyy-yyyy-yyyyyyyyyyyy";
    const auths = [];
    const original = https.request;
    https.request = (opts, cb) => {
      auths.push(opts.headers["Authorization"]);
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ results: [] }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => {};
      return req;
    };
    await Promise.all([
      hubspotClient({ operation: "owner_list", access_token: token1 }),
      hubspotClient({ operation: "owner_list", access_token: token2 }),
    ]);
    assert(
      auths.some(a => a === `Bearer ${token1}`) && auths.some(a => a === `Bearer ${token2}`),
      "E9: concurrent calls with different tokens send correct individual auth headers"
    );
    https.request = original;
  }

  // E10: 30 concurrent crm_search calls all succeed
  {
    const restore = mockHttps(200, { results: [], total: 0 });
    const tasks = Array.from({ length: 30 }, () =>
      hubspotClient({
        operation: "crm_search",
        access_token: FAKE_TOKEN,
        object_type: "contacts",
        query: "test",
      })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 30 && results.every(r => r.total === 0),
      "E10: 30 concurrent crm_search calls all succeed");
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
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
