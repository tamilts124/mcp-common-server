"use strict";
/**
 * test/sections/289-salesforce-client.js
 * Isolated tests for salesforceClientOps.js
 * 5 rigor levels: A=normal, B=validation, C=mock-network, D=security, E=concurrency
 *
 * Mocking strategy:
 *   - salesforceClient() with access_token + instance_url: bypasses login, single HTTPS target
 *   - salesforceClient() without token: triggers loginWithPassword() which POSTs to login.salesforce.com,
 *     then uses instance_url from response for subsequent calls. We mock https.request to handle both.
 */
const https = require("https");
const { EventEmitter } = require("events");
const { salesforceClient, loginWithPassword } = require("../../lib/salesforceClientOps");

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
      console.error(`  \u2717 FAIL (wrong error "${e.message}"): ${msg}`);
      failed++;
    }
  }
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Mock https.request: returns statusCode + body JSON for ALL requests.
 * Use for bearer-token mode (no login needed) — one call per operation.
 */
function mockHttps(statusCode, body) {
  const original = https.request;
  https.request = (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    const payload = body !== null && body !== undefined
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;
    process.nextTick(() => {
      cb(res);
      if (payload) res.emit("data", Buffer.from(payload));
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

/**
 * Mock for password-flow: first call (login) returns 200 with token+instance_url,
 * subsequent calls return the given statusCode+body.
 */
function mockHttpsWithLogin(apiStatusCode, apiBody) {
  const original = https.request;
  let callIndex = 0;
  const LOGIN_RESPONSE = {
    access_token: "SF_MOCK_TOKEN_12345",
    instance_url: "https://myorg.my.salesforce.com",
    token_type:   "Bearer",
  };
  https.request = (_opts, cb) => {
    const isLogin = callIndex === 0;
    callIndex++;
    const statusCode = isLogin ? 200 : apiStatusCode;
    const body = isLogin ? JSON.stringify(LOGIN_RESPONSE)
      : (apiBody !== null && apiBody !== undefined
        ? (typeof apiBody === "string" ? apiBody : JSON.stringify(apiBody))
        : null);

    const res = new EventEmitter();
    res.statusCode = statusCode;
    process.nextTick(() => {
      cb(res);
      if (body) res.emit("data", Buffer.from(body));
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

// ── Test credentials ──────────────────────────────────────────────────────────
const FAKE_TOKEN    = "00Dxx0000001gERAAY!ARgAQK3pFm5Kq7bHXstest";
const INSTANCE_URL  = "https://myorg.my.salesforce.com";
const BASE_ARGS     = { access_token: FAKE_TOKEN, instance_url: INSTANCE_URL };

// Shorthand: bearer-token call
function sfCall(extra) {
  return salesforceClient({ ...BASE_ARGS, ...extra });
}

// ════════════════════════════════════════════════════════════════════════════
// A — Normal / happy-path tests
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[A] Normal / happy-path tests");

async function testA() {
  // A1: sobject_create returns 201 body
  {
    const restore = mockHttps(201, { id: "0013000000ABC123", success: true, errors: [] });
    const r = await sfCall({ operation: "sobject_create", sobject: "Contact",
      fields: { LastName: "Smith", Email: "smith@test.com" } });
    assert(r.id === "0013000000ABC123" && r.success === true, "A1: sobject_create returns 201 body");
    restore();
  }

  // A2: sobject_get returns 200 body
  {
    const restore = mockHttps(200, { Id: "003xx000004TmiQAAS", Name: "Alice Smith", Email: "alice@test.com" });
    const r = await sfCall({ operation: "sobject_get", sobject: "Contact", id: "003xx000004TmiQAAS" });
    assert(r.Id === "003xx000004TmiQAAS" && r.Name === "Alice Smith", "A2: sobject_get returns contact");
    restore();
  }

  // A3: sobject_get 404 returns {exists:false}
  {
    const restore = mockHttps(404, [{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }]);
    const r = await sfCall({ operation: "sobject_get", sobject: "Contact", id: "missing123" });
    assert(r.exists === false && r.id === "missing123", "A3: sobject_get 404 returns {exists:false}");
    restore();
  }

  // A4: sobject_update returns {updated:true}
  {
    const restore = mockHttpsEmpty(204);
    const r = await sfCall({ operation: "sobject_update", sobject: "Contact",
      id: "003xx000004TmiQAAS", fields: { Email: "new@test.com" } });
    assert(r.updated === true && r.id === "003xx000004TmiQAAS", "A4: sobject_update returns {updated:true}");
    restore();
  }

  // A5: sobject_delete 204 returns {deleted:true}
  {
    const restore = mockHttpsEmpty(204);
    const r = await sfCall({ operation: "sobject_delete", sobject: "Contact", id: "003xx000004TmiQAAS" });
    assert(r.deleted === true && r.id === "003xx000004TmiQAAS", "A5: sobject_delete 204 returns {deleted:true}");
    restore();
  }

  // A6: sobject_delete 404 returns {deleted:false}
  {
    const restore = mockHttps(404, [{ errorCode: "NOT_FOUND", message: "Entity not found" }]);
    const r = await sfCall({ operation: "sobject_delete", sobject: "Contact", id: "missing456" });
    assert(r.deleted === false && r.id === "missing456", "A6: sobject_delete 404 returns {deleted:false}");
    restore();
  }

  // A7: sobject_describe returns metadata
  {
    const restore = mockHttps(200, { name: "Contact", fields: [{ name: "Id" }, { name: "Email" }] });
    const r = await sfCall({ operation: "sobject_describe", sobject: "Contact" });
    assert(r.name === "Contact" && Array.isArray(r.fields), "A7: sobject_describe returns metadata");
    restore();
  }

  // A8: sobject_list returns sobjects array
  {
    const restore = mockHttps(200, { sobjects: [{ name: "Account" }, { name: "Contact" }], encoding: "UTF-8" });
    const r = await sfCall({ operation: "sobject_list" });
    assert(Array.isArray(r.sobjects) && r.sobjects.length === 2, "A8: sobject_list returns sobjects");
    restore();
  }

  // A9: query returns records
  {
    const restore = mockHttps(200, {
      totalSize: 2, done: true,
      records: [{ Id: "001A", Name: "Acme" }, { Id: "002B", Name: "Initech" }]
    });
    const r = await sfCall({ operation: "query", query: "SELECT Id, Name FROM Account LIMIT 2" });
    assert(r.totalSize === 2 && r.records.length === 2, "A9: query returns SOQL records");
    restore();
  }

  // A10: query_more returns next page
  {
    const restore = mockHttps(200, {
      totalSize: 5, done: true,
      records: [{ Id: "003C" }, { Id: "004D" }, { Id: "005E" }]
    });
    const r = await sfCall({ operation: "query_more",
      next_records_url: "/services/data/v59.0/query/01gXXXXXXXXX-500" });
    assert(r.records.length === 3 && r.done === true, "A10: query_more returns next page");
    restore();
  }

  // A11: search returns search results
  {
    const restore = mockHttps(200, {
      searchRecords: [{ Id: "003xx", Name: "Alice", attributes: { type: "Contact" } }]
    });
    const r = await sfCall({ operation: "search", query: "FIND {Alice} IN ALL FIELDS RETURNING Contact(Id, Name)" });
    assert(r.searchRecords.length === 1 && r.searchRecords[0].Name === "Alice", "A11: search returns SOSL results");
    restore();
  }

  // A12: get_limits returns limits object
  {
    const restore = mockHttps(200, { DailyApiRequests: { Max: 15000, Remaining: 14999 } });
    const r = await sfCall({ operation: "get_limits" });
    assert(r.DailyApiRequests && r.DailyApiRequests.Max === 15000, "A12: get_limits returns org limits");
    restore();
  }

  // A13: get_api_versions returns versions array
  {
    const restore = mockHttps(200, [{ label: "Spring '23", url: "/services/data/v57.0", version: "57.0" }]);
    const r = await sfCall({ operation: "get_api_versions" });
    assert(Array.isArray(r) && r[0].version === "57.0", "A13: get_api_versions returns versions");
    restore();
  }

  // A14: composite returns compositeResponse
  {
    const restore = mockHttps(200, {
      compositeResponse: [
        { body: { id: "0013000000ABC" }, httpStatusCode: 201, referenceId: "newContact" }
      ]
    });
    const r = await sfCall({
      operation: "composite",
      composite_request: [{
        method: "POST", url: "/services/data/v59.0/sobjects/Contact",
        referenceId: "newContact", body: { LastName: "Jones" }
      }]
    });
    assert(r.compositeResponse[0].httpStatusCode === 201, "A14: composite returns compositeResponse");
    restore();
  }

  // A15: composite_batch returns results
  {
    const restore = mockHttps(200, {
      hasErrors: false,
      results: [{ statusCode: 200, result: { Id: "003xx" } }]
    });
    const r = await sfCall({
      operation: "composite_batch",
      batch_requests: [{ method: "GET", url: "/services/data/v59.0/sobjects/Contact/003xx" }]
    });
    assert(r.hasErrors === false && r.results.length === 1, "A15: composite_batch returns batch results");
    restore();
  }

  // A16: generic GET request returns body
  {
    const restore = mockHttps(200, { totalSize: 0, records: [] });
    const r = await sfCall({
      operation: "request", method: "GET",
      path: "/services/data/v59.0/query", params: { q: "SELECT Id FROM Contact LIMIT 0" }
    });
    assert(r.totalSize === 0, "A16: generic GET request returns body");
    restore();
  }

  // A17: generic POST request returns body
  {
    const restore = mockHttps(201, { id: "005xx", success: true, errors: [] });
    const r = await sfCall({
      operation: "request", method: "POST",
      path: "/services/data/v59.0/sobjects/Lead",
      body: { LastName: "Doe", Company: "Test Inc" }
    });
    assert(r.id === "005xx" && r.success === true, "A17: generic POST request returns body");
    restore();
  }

  // A18: sobject_get with fields array sends correct query param
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ Id: "003xx", Email: "a@b.com" })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "sobject_get", sobject: "Contact", id: "003xx",
      fields: ["Id", "Email"] });
    assert(capturedPath && capturedPath.includes("fields=Id%2CEmail"), "A18: sobject_get sends fields as query param");
    https.request = original;
  }

  // A19: query with all_rows uses queryAll endpoint
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ totalSize: 1, done: true, records: [{ Id: "del01" }] })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "query", query: "SELECT Id FROM Account WHERE IsDeleted = true", all_rows: true });
    assert(capturedPath && capturedPath.includes("/queryAll"), "A19: all_rows=true uses queryAll endpoint");
    https.request = original;
  }

  // A20: password-flow login + sobject_create (two-call mock)
  {
    const restore = mockHttpsWithLogin(201, { id: "0013000000PWDTEST", success: true, errors: [] });
    const r = await salesforceClient({
      operation: "sobject_create",
      username: "user@example.com", password: "Password1",
      client_id: "clientKey", client_secret: "clientSecret",
      sobject: "Account", fields: { Name: "Test Corp" }
    });
    assert(r.id === "0013000000PWDTEST" && r.success === true,
      "A20: password-flow login + sobject_create succeed");
    restore();
  }

  // A21: non-JSON response body returned as {_raw}
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from("<html>Session expired</html>"));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const r = await sfCall({ operation: "get_limits" });
    assert(r && r._raw && r._raw.includes("<html>"), "A21: non-JSON response returned as {_raw}");
    https.request = original;
  }

  // A22: composite allOrNone defaults to true
  {
    let capturedBody = null;
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ compositeResponse: [] })));
        res.emit("end");
      });
      const req = new EventEmitter();
      req.write = (b) => { capturedBody = b; }; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({
      operation: "composite",
      composite_request: [{ method: "GET", url: "/services/data/v59.0/limits", referenceId: "limits" }]
    });
    const parsed = JSON.parse(capturedBody);
    assert(parsed.allOrNone === true, "A22: composite allOrNone defaults to true");
    https.request = original;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// B — Validation (empty/invalid inputs)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[B] Validation tests");

async function testB() {
  // B1: missing operation throws
  await assertRejects(
    () => salesforceClient({ access_token: FAKE_TOKEN, instance_url: INSTANCE_URL }),
    /operation.*required|non-empty/i, "B1: missing operation throws"
  );

  // B2: unknown operation throws
  await assertRejects(
    () => sfCall({ operation: "banana" }),
    /Unknown operation.*banana/i, "B2: unknown operation throws"
  );

  // B3: sobject_create missing sobject throws
  await assertRejects(
    () => sfCall({ operation: "sobject_create", fields: { LastName: "X" } }),
    /sobject.*required|non-empty/i, "B3: sobject_create missing sobject throws"
  );

  // B4: sobject_create missing fields throws
  await assertRejects(
    () => sfCall({ operation: "sobject_create", sobject: "Contact" }),
    /fields.*required/i, "B4: sobject_create missing fields throws"
  );

  // B5: sobject_create fields as array throws
  await assertRejects(
    () => sfCall({ operation: "sobject_create", sobject: "Contact", fields: ["bad"] }),
    /fields.*required/i, "B5: sobject_create fields array throws"
  );

  // B6: sobject_get missing id throws
  await assertRejects(
    () => sfCall({ operation: "sobject_get", sobject: "Contact" }),
    /id.*required|non-empty/i, "B6: sobject_get missing id throws"
  );

  // B7: sobject_update missing fields throws
  await assertRejects(
    () => sfCall({ operation: "sobject_update", sobject: "Contact", id: "003xx" }),
    /fields.*required/i, "B7: sobject_update missing fields throws"
  );

  // B8: sobject_delete missing id throws
  await assertRejects(
    () => sfCall({ operation: "sobject_delete", sobject: "Contact" }),
    /id.*required|non-empty/i, "B8: sobject_delete missing id throws"
  );

  // B9: sobject_describe missing sobject throws
  await assertRejects(
    () => sfCall({ operation: "sobject_describe" }),
    /sobject.*required|non-empty/i, "B9: sobject_describe missing sobject throws"
  );

  // B10: query missing query string throws
  await assertRejects(
    () => sfCall({ operation: "query" }),
    /query.*required|non-empty/i, "B10: query missing query string throws"
  );

  // B11: query_more missing next_records_url throws
  await assertRejects(
    () => sfCall({ operation: "query_more" }),
    /next_records_url.*required|non-empty/i, "B11: query_more missing next_records_url throws"
  );

  // B12: search missing query throws
  await assertRejects(
    () => sfCall({ operation: "search" }),
    /query.*required|non-empty/i, "B12: search missing query throws"
  );

  // B13: composite missing composite_request throws
  await assertRejects(
    () => sfCall({ operation: "composite" }),
    /composite_request.*required/i, "B13: composite missing composite_request throws"
  );

  // B14: composite_batch missing batch_requests throws
  await assertRejects(
    () => sfCall({ operation: "composite_batch" }),
    /batch_requests.*required/i, "B14: composite_batch missing batch_requests throws"
  );

  // B15: generic request unsupported method throws
  await assertRejects(
    () => sfCall({ operation: "request", method: "CONNECT", path: "/services/data/v59.0/limits" }),
    /Unsupported method|CONNECT/i, "B15: generic request CONNECT method throws"
  );

  // B16: composite with empty array throws
  await assertRejects(
    () => sfCall({ operation: "composite", composite_request: [] }),
    /composite_request.*required/i, "B16: composite empty array throws"
  );

  // B17: password-flow missing client_id throws
  await assertRejects(
    () => salesforceClient({
      operation: "sobject_list",
      username: "u@test.com", password: "pass", client_secret: "sec"
    }),
    /client_id.*required|non-empty/i, "B17: password-flow missing client_id throws"
  );

  // B18: password-flow missing username throws
  await assertRejects(
    () => salesforceClient({
      operation: "sobject_list",
      password: "pass", client_id: "cid", client_secret: "sec"
    }),
    /username.*required|non-empty/i, "B18: password-flow missing username throws"
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
      () => sfCall({ operation: "get_limits" }),
      /ECONNREFUSED/i, "C1: network error propagates"
    );
    restore();
  }

  // C2: 4xx response throws with status
  {
    const restore = mockHttps(400, [{ errorCode: "INVALID_QUERY_FILTER_OPERATOR", message: "Bad SOQL" }]);
    await assertRejects(
      () => sfCall({ operation: "query", query: "SELECT Id FROM" }),
      /Salesforce API error 400/i, "C2: 400 response throws with status"
    );
    restore();
  }

  // C3: 401 Unauthorized throws
  {
    const restore = mockHttps(401, [{ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid" }]);
    await assertRejects(
      () => sfCall({ operation: "get_limits" }),
      /Salesforce API error 401/i, "C3: 401 Unauthorized throws"
    );
    restore();
  }

  // C4: 503 Service Unavailable throws
  {
    const restore = mockHttps(503, { error: "service_unavailable" });
    await assertRejects(
      () => sfCall({ operation: "sobject_list" }),
      /Salesforce API error 503/i, "C4: 503 Service Unavailable throws"
    );
    restore();
  }

  // C5: request times out
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
      () => sfCall({ operation: "get_limits", timeout: 50 }),
      /timed out|hang up/i, "C5: request times out"
    );
    https.request = original;
  }

  // C6: Bearer Authorization header is correct
  {
    let capturedAuth = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedAuth = opts.headers["Authorization"];
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ DailyApiRequests: { Max: 15000, Remaining: 14999 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "get_limits" });
    assert(capturedAuth === `Bearer ${FAKE_TOKEN}`, "C6: Bearer auth header sent correctly");
    https.request = original;
  }

  // C7: sobject_create sends JSON body
  {
    let capturedBody = null;
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 201;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ id: "001xx", success: true, errors: [] })));
        res.emit("end");
      });
      const req = new EventEmitter();
      req.write = (b) => { capturedBody = b; };
      req.end   = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "sobject_create", sobject: "Account",
      fields: { Name: "TestCorp", Industry: "Technology" } });
    const parsed = JSON.parse(capturedBody);
    assert(parsed.Name === "TestCorp" && parsed.Industry === "Technology",
      "C7: sobject_create sends fields as JSON body");
    https.request = original;
  }

  // C8: query sends q as query string
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ totalSize: 0, done: true, records: [] })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "query", query: "SELECT Id FROM Account LIMIT 1" });
    assert(capturedPath && capturedPath.includes("q=SELECT"), "C8: SOQL query sent as q= param");
    https.request = original;
  }

  // C9: response body exceeds 16 MB cap
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
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await assertRejects(
      () => sfCall({ operation: "get_limits" }),
      /16 MB|exceeds/i, "C9: 17 MB response exceeds 16 MB cap"
    );
    https.request = original;
  }

  // C10: sobject_update sends PATCH with JSON body
  {
    let capturedMethod = null;
    let capturedBody   = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedMethod = opts.method;
      const res = new EventEmitter();
      res.statusCode = 204;
      process.nextTick(() => { cb(res); res.emit("end"); });
      const req = new EventEmitter();
      req.write = (b) => { capturedBody = b; }; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "sobject_update", sobject: "Contact",
      id: "003xx", fields: { Email: "patched@test.com" } });
    const parsed = JSON.parse(capturedBody);
    assert(capturedMethod === "PATCH" && parsed.Email === "patched@test.com",
      "C10: sobject_update sends PATCH with JSON body");
    https.request = original;
  }

  // C11: login failure throws descriptive error
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 400;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ error: "invalid_client", error_description: "client identifier invalid" })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await assertRejects(
      () => salesforceClient({
        operation: "sobject_list",
        username: "u@test.com", password: "wrongpw",
        client_id: "badId", client_secret: "badSec"
      }),
      /login failed.*400|400.*login failed/i, "C11: login 400 throws descriptive error"
    );
    https.request = original;
  }

  // C12: sobject_delete sends DELETE method
  {
    let capturedMethod = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedMethod = opts.method;
      const res = new EventEmitter();
      res.statusCode = 204;
      process.nextTick(() => { cb(res); res.emit("end"); });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "sobject_delete", sobject: "Lead", id: "00Qxx000001" });
    assert(capturedMethod === "DELETE", "C12: sobject_delete sends DELETE method");
    https.request = original;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// D — Security (NUL bytes, credential scrubbing, TLS)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[D] Security tests");

async function testD() {
  // D1: NUL byte in access_token throws
  await assertRejects(
    () => salesforceClient({ operation: "get_limits", access_token: "tok\x00en", instance_url: INSTANCE_URL }),
    /NUL|access_token/i, "D1: NUL byte in access_token is rejected"
  );

  // D2: NUL byte in instance_url throws
  await assertRejects(
    () => salesforceClient({ operation: "get_limits", access_token: FAKE_TOKEN, instance_url: "https://org\x00.salesforce.com" }),
    /NUL|instance_url/i, "D2: NUL byte in instance_url is rejected"
  );

  // D3: NUL byte in sobject throws
  await assertRejects(
    () => sfCall({ operation: "sobject_create", sobject: "Con\x00tact", fields: { LastName: "X" } }),
    /NUL|sobject/i, "D3: NUL byte in sobject is rejected"
  );

  // D4: NUL byte in record id throws
  await assertRejects(
    () => sfCall({ operation: "sobject_get", sobject: "Contact", id: "id\x00hack" }),
    /NUL|id/i, "D4: NUL byte in record id is rejected"
  );

  // D5: NUL byte in operation throws
  await assertRejects(
    () => sfCall({ operation: "query\x00inject" }),
    /NUL|operation/i, "D5: NUL byte in operation is rejected"
  );

  // D6: access_token scrubbed from API error messages
  {
    const canaryToken = "00Dxx-CANARY-SECRET-xxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const restore = mockHttps(401, [{ errorCode: "INVALID_SESSION_ID", message: `Bad token: ${canaryToken}` }]);
    try {
      await salesforceClient({ operation: "get_limits", access_token: canaryToken, instance_url: INSTANCE_URL });
      assert(false, "D6: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryToken), "D6: access_token scrubbed from API error body");
    }
    restore();
  }

  // D7: client_secret scrubbed from login error messages
  {
    const canarySecret = "SUPER_SECRET_CLIENT_SECRET_DO_NOT_LEAK_12345";
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 400;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ error: "invalid_client", error_description: `Secret ${canarySecret} is wrong` })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    try {
      await salesforceClient({ operation: "sobject_list", username: "u@t.com", password: "pw",
        client_id: "cid", client_secret: canarySecret });
      assert(false, "D7: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canarySecret), "D7: client_secret scrubbed from login error");
    }
    https.request = original;
  }

  // D8: password scrubbed from login error messages
  {
    const canaryPwd = "CANARY_PASSWORD_12345_DO_NOT_LEAK";
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 400;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ error: "invalid_grant", error_description: `authentication failure: ${canaryPwd}` })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    try {
      await salesforceClient({ operation: "sobject_list", username: "u@t.com", password: canaryPwd,
        client_id: "cid", client_secret: "sec" });
      assert(false, "D8: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryPwd), "D8: password scrubbed from login error");
    }
    https.request = original;
  }

  // D9: reject_unauthorized defaults to true
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ DailyApiRequests: { Max: 15000, Remaining: 14999 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "get_limits" });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === true, "D9: rejectUnauthorized defaults to true");
    https.request = original;
  }

  // D10: reject_unauthorized=false is forwarded
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ DailyApiRequests: { Max: 1000, Remaining: 999 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await sfCall({ operation: "get_limits", reject_unauthorized: false });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === false, "D10: rejectUnauthorized:false forwarded");
    https.request = original;
  }

  // D11: huge timeout clamped, request still works
  {
    const restore = mockHttps(200, { DailyApiRequests: { Max: 15000, Remaining: 14999 } });
    const r = await sfCall({ operation: "get_limits", timeout: 9999999 });
    assert(r && r.DailyApiRequests, "D11: huge timeout clamped, request still works");
    restore();
  }

  // D12: NUL byte in query string throws
  await assertRejects(
    () => sfCall({ operation: "query", query: "SELECT Id FROM Account\x00 LIMIT 1" }),
    /NUL|query/i, "D12: NUL byte in SOQL query is rejected"
  );

  // D13: access_token not leaked in returned body
  {
    const restore = mockHttps(200, { DailyApiRequests: { Max: 15000, Remaining: 14990 } });
    const r = await sfCall({ operation: "get_limits" });
    assert(!JSON.stringify(r).includes(FAKE_TOKEN), "D13: access_token not leaked in returned body");
    restore();
  }

  // D14: NUL byte in next_records_url throws
  await assertRejects(
    () => sfCall({ operation: "query_more", next_records_url: "/services/data/v59.0/query/01g\x00XX" }),
    /NUL|next_records_url/i, "D14: NUL byte in next_records_url is rejected"
  );
}

// ════════════════════════════════════════════════════════════════════════════
// E — Concurrency / stress
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[E] Concurrency tests");

async function testE() {
  // E1: 20 concurrent get_limits calls all succeed
  {
    const restore = mockHttps(200, { DailyApiRequests: { Max: 15000, Remaining: 14999 } });
    const tasks = Array.from({ length: 20 }, () => sfCall({ operation: "get_limits" }));
    const results = await Promise.all(tasks);
    assert(results.length === 20 && results.every(r => r.DailyApiRequests.Max === 15000),
      "E1: 20 concurrent get_limits calls all succeed");
    restore();
  }

  // E2: 10 concurrent SOQL queries all succeed
  {
    const restore = mockHttps(200, { totalSize: 0, done: true, records: [] });
    const tasks = Array.from({ length: 10 }, (_, i) =>
      sfCall({ operation: "query", query: `SELECT Id FROM Account WHERE Id = 'x${i}' LIMIT 1` })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 10 && results.every(r => r.done === true),
      "E2: 10 concurrent SOQL queries all succeed");
    restore();
  }

  // E3: mix of success and validation errors in parallel
  {
    const restore = mockHttps(200, { DailyApiRequests: { Max: 15000, Remaining: 14999 } });
    const tasks = [
      sfCall({ operation: "get_limits" }),
      sfCall({ operation: "sobject_create", sobject: "Contact" }).catch(e => e),  // missing fields
      sfCall({ operation: "get_limits" }),
    ];
    const [r1, r2, r3] = await Promise.all(tasks);
    assert(r1.DailyApiRequests && r2 instanceof Error && r3.DailyApiRequests,
      "E3: mix of success + validation errors handled correctly");
    restore();
  }

  // E4: 15 rapid calls don't leak state between requests
  {
    let callCount = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      callCount++;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ DailyApiRequests: { Max: 15000, Remaining: 14999 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 15 }, () => sfCall({ operation: "get_limits" }));
    const results = await Promise.all(tasks);
    assert(callCount === 15 && results.length === 15, "E4: 15 rapid calls, no state leakage");
    https.request = original;
  }

  // E5: concurrent network errors all propagate independently
  {
    const restore = mockHttpsError("ECONNRESET");
    const tasks = Array.from({ length: 8 }, () =>
      sfCall({ operation: "get_limits" }).catch(e => e)
    );
    const results = await Promise.all(tasks);
    assert(results.length === 8 && results.every(e => e instanceof Error && /ECONNRESET/i.test(e.message)),
      "E5: 8 concurrent network errors all propagate independently");
    restore();
  }

  // E6: 5 concurrent different operations succeed
  {
    const restore = mockHttps(200, { totalSize: 0, done: true, records: [], sobjects: [], DailyApiRequests: { Max: 1, Remaining: 0 }, searchRecords: [] });
    const tasks = [
      sfCall({ operation: "get_limits" }),
      sfCall({ operation: "query", query: "SELECT Id FROM Account LIMIT 0" }),
      sfCall({ operation: "sobject_list" }),
      sfCall({ operation: "search", query: "FIND {test} IN ALL FIELDS RETURNING Account(Id)" }),
      sfCall({ operation: "get_api_versions" }),
    ];
    const results = await Promise.all(tasks);
    assert(results.length === 5 && results.every(r => r !== null), "E6: 5 concurrent different operations succeed");
    restore();
  }

  // E7: 50 sequential validation errors don't accumulate
  {
    let errCount = 0;
    for (let i = 0; i < 50; i++) {
      await sfCall({ operation: "sobject_create", sobject: "Contact" }).catch(() => errCount++);
    }
    assert(errCount === 50, "E7: 50 sequential validation errors all caught cleanly");
  }

  // E8: concurrent calls with different tokens get correct auth headers
  {
    const token1 = "00Dxx-TOKEN1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const token2 = "00Dxx-TOKEN2-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy";
    const auths = [];
    const original = https.request;
    https.request = (opts, cb) => {
      auths.push(opts.headers["Authorization"]);
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ DailyApiRequests: { Max: 15000, Remaining: 14999 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await Promise.all([
      salesforceClient({ operation: "get_limits", access_token: token1, instance_url: INSTANCE_URL }),
      salesforceClient({ operation: "get_limits", access_token: token2, instance_url: INSTANCE_URL }),
    ]);
    assert(
      auths.some(a => a === `Bearer ${token1}`) && auths.some(a => a === `Bearer ${token2}`),
      "E8: concurrent calls with different tokens send correct individual auth headers"
    );
    https.request = original;
  }

  // E9: 30 concurrent sobject_creates all succeed
  {
    const restore = mockHttps(201, { id: "001xx", success: true, errors: [] });
    const tasks = Array.from({ length: 30 }, (_, i) =>
      sfCall({ operation: "sobject_create", sobject: "Account", fields: { Name: `Corp${i}` } })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 30 && results.every(r => r.success === true),
      "E9: 30 concurrent sobject_creates all succeed");
    restore();
  }

  // E10: 10 concurrent: 5 success + 5 auth failures handled correctly
  {
    let toggle = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      const mine = toggle++;
      const statusCode = mine % 2 === 0 ? 200 : 401;
      const body = mine % 2 === 0
        ? { DailyApiRequests: { Max: 15000, Remaining: 14999 } }
        : [{ errorCode: "INVALID_SESSION_ID", message: "Session expired" }];
      const res = new EventEmitter();
      res.statusCode = statusCode;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 10 }, () =>
      sfCall({ operation: "get_limits" }).catch(e => ({ error: e.message }))
    );
    const results = await Promise.all(tasks);
    const successes = results.filter(r => r.DailyApiRequests).length;
    const failures  = results.filter(r => r.error).length;
    assert(successes === 5 && failures === 5, "E10: 10 concurrent: 5 succeed + 5 fail correctly");
    https.request = original;
  }
}

// ── Run all ───────────────────────────────────────────────────────────────────
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
