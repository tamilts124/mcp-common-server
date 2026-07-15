"use strict";
/**
 * test/sections/284-pagerduty-client.js
 * Isolated tests for pagerdutyClientOps.js
 * Five rigor levels: A=happy-path, B=validation, C=mock-network, D=security, E=concurrency
 */

const assert = require("assert");
const https  = require("https");
const { EventEmitter } = require("events");

// ── Load module under test ───────────────────────────────────────────────────
const { pagerdutyClient } = require("../../lib/pagerdutyClientOps");

let passed = 0;
let failed = 0;
const results = [];

async function test(label, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    results.push(`  ✗ ${label}: ${err.message}`);
  }
}

// ── Mock HTTPS helper ────────────────────────────────────────────────────────
function mockHttps(responses) {
  const original = https.request;
  let callIdx = 0;
  https.request = (options, callback) => {
    const resp = Array.isArray(responses) ? responses[callIdx++ % responses.length] : responses;
    const resEmitter = new EventEmitter();
    resEmitter.statusCode = resp.status;
    resEmitter.headers    = { "content-type": "application/json" };
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end   = () => {
      process.nextTick(() => {
        callback(resEmitter);
        process.nextTick(() => {
          if (resp.body !== undefined)
            resEmitter.emit("data", Buffer.from(JSON.stringify(resp.body)));
          resEmitter.emit("end");
        });
      });
    };
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  return () => { https.request = original; };
}

(async () => {

// ════════════════════════════════════════════════════════════════════════════
// A. HAPPY-PATH TESTS (normal operation with mocked HTTP)
// ════════════════════════════════════════════════════════════════════════════
console.log("\nA. Happy-path tests");

await test("A01: incident_get returns incident object", async () => {
  const restore = mockHttps({ status: 200, body: { incident: { id: "P12345", title: "Disk full" } } });
  try {
    const r = await pagerdutyClient({ operation: "incident_get", api_key: "testkey", incident_id: "P12345" });
    assert.strictEqual(r.id, "P12345");
    assert.strictEqual(r.title, "Disk full");
  } finally { restore(); }
});

await test("A02: incident_list returns paginated incidents", async () => {
  const restore = mockHttps({ status: 200, body: { incidents: [{id: "P1"}, {id: "P2"}], total: 2, limit: 25, offset: 0, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "incident_list", api_key: "testkey", limit: 25 });
    assert.strictEqual(r.incidents.length, 2);
    assert.strictEqual(r.total, 2);
  } finally { restore(); }
});

await test("A03: incident_create returns new incident", async () => {
  const restore = mockHttps({ status: 201, body: { incident: { id: "PNEW", title: "Server down", status: "triggered" } } });
  try {
    const r = await pagerdutyClient({
      operation: "incident_create", api_key: "testkey",
      title: "Server down", service_id: "SVC1",
      from_email: "ops@example.com",
    });
    assert.strictEqual(r.id, "PNEW");
    assert.strictEqual(r.status, "triggered");
  } finally { restore(); }
});

await test("A04: incident_acknowledge returns acknowledged incident", async () => {
  const restore = mockHttps({ status: 200, body: { incident: { id: "P1", status: "acknowledged" } } });
  try {
    const r = await pagerdutyClient({ operation: "incident_acknowledge", api_key: "key", incident_id: "P1", from_email: "a@b.com" });
    assert.strictEqual(r.status, "acknowledged");
  } finally { restore(); }
});

await test("A05: incident_resolve returns resolved incident", async () => {
  const restore = mockHttps({ status: 200, body: { incident: { id: "P1", status: "resolved" } } });
  try {
    const r = await pagerdutyClient({ operation: "incident_resolve", api_key: "key", incident_id: "P1", from_email: "a@b.com" });
    assert.strictEqual(r.status, "resolved");
  } finally { restore(); }
});

await test("A06: note_list returns notes", async () => {
  const restore = mockHttps({ status: 200, body: { notes: [{ id: "N1", content: "Investigating" }] } });
  try {
    const r = await pagerdutyClient({ operation: "note_list", api_key: "key", incident_id: "P1" });
    assert.strictEqual(r.notes.length, 1);
    assert.strictEqual(r.notes[0].content, "Investigating");
  } finally { restore(); }
});

await test("A07: note_create returns created note", async () => {
  const restore = mockHttps({ status: 201, body: { note: { id: "N2", content: "Escalated" } } });
  try {
    const r = await pagerdutyClient({ operation: "note_create", api_key: "key", incident_id: "P1", content: "Escalated", from_email: "a@b.com" });
    assert.strictEqual(r.id, "N2");
  } finally { restore(); }
});

await test("A08: service_get returns service", async () => {
  const restore = mockHttps({ status: 200, body: { service: { id: "SVC1", name: "Web API" } } });
  try {
    const r = await pagerdutyClient({ operation: "service_get", api_key: "key", service_id: "SVC1" });
    assert.strictEqual(r.name, "Web API");
  } finally { restore(); }
});

await test("A09: service_list returns services", async () => {
  const restore = mockHttps({ status: 200, body: { services: [{ id: "SVC1" }], total: 1, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "service_list", api_key: "key" });
    assert.strictEqual(r.services.length, 1);
  } finally { restore(); }
});

await test("A10: service_create returns new service", async () => {
  const restore = mockHttps({ status: 201, body: { service: { id: "SVC2", name: "Auth" } } });
  try {
    const r = await pagerdutyClient({ operation: "service_create", api_key: "key", name: "Auth", escalation_policy_id: "EP1" });
    assert.strictEqual(r.id, "SVC2");
  } finally { restore(); }
});

await test("A11: service_delete returns deleted=true", async () => {
  const restore = mockHttps({ status: 204, body: null });
  try {
    const r = await pagerdutyClient({ operation: "service_delete", api_key: "key", service_id: "SVC1" });
    assert.strictEqual(r.deleted, true);
  } finally { restore(); }
});

await test("A12: service_delete on 404 returns deleted=false", async () => {
  const restore = mockHttps({ status: 404, body: { error: { message: "Not Found" } } });
  try {
    const r = await pagerdutyClient({ operation: "service_delete", api_key: "key", service_id: "GONE" });
    assert.strictEqual(r.deleted, false);
  } finally { restore(); }
});

await test("A13: service_get 404 returns exists=false", async () => {
  const restore = mockHttps({ status: 404, body: { error: {} } });
  try {
    const r = await pagerdutyClient({ operation: "service_get", api_key: "key", service_id: "GONE" });
    assert.strictEqual(r.exists, false);
  } finally { restore(); }
});

await test("A14: escalation_policy_list returns policies", async () => {
  const restore = mockHttps({ status: 200, body: { escalation_policies: [{ id: "EP1" }], total: 1, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "escalation_policy_list", api_key: "key" });
    assert.strictEqual(r.escalation_policies.length, 1);
  } finally { restore(); }
});

await test("A15: user_get returns user", async () => {
  const restore = mockHttps({ status: 200, body: { user: { id: "U1", name: "Alice" } } });
  try {
    const r = await pagerdutyClient({ operation: "user_get", api_key: "key", user_id: "U1" });
    assert.strictEqual(r.name, "Alice");
  } finally { restore(); }
});

await test("A16: user_list returns users", async () => {
  const restore = mockHttps({ status: 200, body: { users: [{ id: "U1" }, { id: "U2" }], total: 2, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "user_list", api_key: "key" });
    assert.strictEqual(r.users.length, 2);
  } finally { restore(); }
});

await test("A17: user_create returns new user", async () => {
  const restore = mockHttps({ status: 201, body: { user: { id: "U3", name: "Bob", email: "bob@x.com" } } });
  try {
    const r = await pagerdutyClient({ operation: "user_create", api_key: "key", name: "Bob", email: "bob@x.com", from_email: "admin@x.com" });
    assert.strictEqual(r.email, "bob@x.com");
  } finally { restore(); }
});

await test("A18: user_delete returns deleted=true on 204", async () => {
  const restore = mockHttps({ status: 204, body: null });
  try {
    const r = await pagerdutyClient({ operation: "user_delete", api_key: "key", user_id: "U1" });
    assert.strictEqual(r.deleted, true);
  } finally { restore(); }
});

await test("A19: team_list returns teams", async () => {
  const restore = mockHttps({ status: 200, body: { teams: [{ id: "T1", name: "Ops" }], total: 1, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "team_list", api_key: "key" });
    assert.strictEqual(r.teams[0].name, "Ops");
  } finally { restore(); }
});

await test("A20: team_members returns members", async () => {
  const restore = mockHttps({ status: 200, body: { members: [{ user: { id: "U1" }, role: "manager" }], total: 1, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "team_members", api_key: "key", team_id: "T1" });
    assert.strictEqual(r.members.length, 1);
  } finally { restore(); }
});

await test("A21: schedule_list returns schedules", async () => {
  const restore = mockHttps({ status: 200, body: { schedules: [{ id: "SCH1" }], total: 1, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "schedule_list", api_key: "key" });
    assert.strictEqual(r.schedules.length, 1);
  } finally { restore(); }
});

await test("A22: oncall_list returns on-calls", async () => {
  const restore = mockHttps({ status: 200, body: { oncalls: [{ user: { id: "U1" } }], total: 1, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "oncall_list", api_key: "key" });
    assert.strictEqual(r.oncalls.length, 1);
  } finally { restore(); }
});

await test("A23: alert_list returns alerts", async () => {
  const restore = mockHttps({ status: 200, body: { alerts: [{ id: "A1", alert_key: "ak1" }], total: 1, more: false } });
  try {
    const r = await pagerdutyClient({ operation: "alert_list", api_key: "key", incident_id: "P1" });
    assert.strictEqual(r.alerts[0].alert_key, "ak1");
  } finally { restore(); }
});

await test("A24: log_entry_get returns log entry", async () => {
  const restore = mockHttps({ status: 200, body: { log_entry: { id: "LE1", type: "notify_log_entry" } } });
  try {
    const r = await pagerdutyClient({ operation: "log_entry_get", api_key: "key", log_entry_id: "LE1" });
    assert.strictEqual(r.type, "notify_log_entry");
  } finally { restore(); }
});

await test("A25: abilities_list returns abilities", async () => {
  const restore = mockHttps({ status: 200, body: { abilities: ["teams", "sso"] } });
  try {
    const r = await pagerdutyClient({ operation: "abilities_list", api_key: "key" });
    assert.ok(Array.isArray(r.abilities));
    assert.ok(r.abilities.includes("teams"));
  } finally { restore(); }
});

await test("A26: OAuth Bearer auth header used when access_token provided", async () => {
  let capturedAuth;
  const original = https.request;
  https.request = (options, callback) => {
    capturedAuth = options.headers["Authorization"];
    const resEmitter = new EventEmitter();
    resEmitter.statusCode = 200;
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => {
      process.nextTick(() => {
        callback(resEmitter);
        process.nextTick(() => {
          resEmitter.emit("data", Buffer.from(JSON.stringify({ abilities: [] })));
          resEmitter.emit("end");
        });
      });
    };
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    await pagerdutyClient({ operation: "abilities_list", access_token: "oauth_token_abc" });
    assert.ok(capturedAuth.startsWith("Bearer "), `Expected Bearer auth, got: ${capturedAuth}`);
    assert.ok(capturedAuth.includes("oauth_token_abc"));
  } finally { https.request = original; }
});

await test("A27: Token auth header used when api_key provided", async () => {
  let capturedAuth;
  const original = https.request;
  https.request = (options, callback) => {
    capturedAuth = options.headers["Authorization"];
    const resEmitter = new EventEmitter();
    resEmitter.statusCode = 200;
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => {
      process.nextTick(() => {
        callback(resEmitter);
        process.nextTick(() => {
          resEmitter.emit("data", Buffer.from(JSON.stringify({ abilities: [] })));
          resEmitter.emit("end");
        });
      });
    };
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    await pagerdutyClient({ operation: "abilities_list", api_key: "myapikey" });
    assert.ok(capturedAuth.startsWith("Token token="), `Expected Token auth, got: ${capturedAuth}`);
    assert.ok(capturedAuth.includes("myapikey"));
  } finally { https.request = original; }
});

await test("A28: incident_merge merges source incidents", async () => {
  const restore = mockHttps({ status: 200, body: { incident: { id: "P1", merged_from: ["P2", "P3"] } } });
  try {
    const r = await pagerdutyClient({ operation: "incident_merge", api_key: "key", incident_id: "P1", source_ids: ["P2", "P3"] });
    assert.strictEqual(r.id, "P1");
  } finally { restore(); }
});

await test("A29: generic request passthrough works", async () => {
  const restore = mockHttps({ status: 200, body: { custom: true } });
  try {
    const r = await pagerdutyClient({ operation: "request", api_key: "key", method: "GET", path: "/custom/endpoint" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.custom, true);
  } finally { restore(); }
});

await test("A30: incident_list passes statuses as query params", async () => {
  let capturedPath;
  const original = https.request;
  https.request = (options, callback) => {
    capturedPath = options.path;
    const resEmitter = new EventEmitter();
    resEmitter.statusCode = 200;
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => {
      process.nextTick(() => {
        callback(resEmitter);
        process.nextTick(() => {
          resEmitter.emit("data", Buffer.from(JSON.stringify({ incidents: [], total: 0, more: false })));
          resEmitter.emit("end");
        });
      });
    };
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    await pagerdutyClient({ operation: "incident_list", api_key: "key", statuses: ["triggered", "acknowledged"] });
    assert.ok(capturedPath.includes("statuses"), `Expected statuses in path, got: ${capturedPath}`);
  } finally { https.request = original; }
});

// ════════════════════════════════════════════════════════════════════════════
// B. VALIDATION TESTS
// ════════════════════════════════════════════════════════════════════════════
console.log("\nB. Validation tests");

await test("B01: missing operation throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ api_key: "key" }),
    /operation is required/
  );
});

await test("B02: missing api_key and access_token throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_list" }),
    /api_key or access_token is required/
  );
});

await test("B03: incident_get missing incident_id throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_get", api_key: "key" }),
    /incident_id is required/
  );
});

await test("B04: incident_create missing title throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_create", api_key: "key", service_id: "SVC1" }),
    /title is required/
  );
});

await test("B05: incident_create missing service_id throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_create", api_key: "key", title: "Down" }),
    /service_id is required/
  );
});

await test("B06: note_create missing content throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "note_create", api_key: "key", incident_id: "P1" }),
    /content is required/
  );
});

await test("B07: incident_merge missing source_ids throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_merge", api_key: "key", incident_id: "P1" }),
    /source_ids must be a non-empty array/
  );
});

await test("B08: incident_merge empty source_ids throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_merge", api_key: "key", incident_id: "P1", source_ids: [] }),
    /source_ids must be a non-empty array/
  );
});

await test("B09: service_create missing escalation_policy_id throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "service_create", api_key: "key", name: "Svc" }),
    /escalation_policy_id is required/
  );
});

await test("B10: escalation_policy_create missing escalation_rules throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "escalation_policy_create", api_key: "key", name: "EP" }),
    /escalation_rules must be a non-empty array/
  );
});

await test("B11: user_create missing name throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "user_create", api_key: "key", email: "x@y.com" }),
    /name is required/
  );
});

await test("B12: user_create missing email throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "user_create", api_key: "key", name: "Alice" }),
    /email is required/
  );
});

await test("B13: unknown operation throws descriptive error", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "bogus_op", api_key: "key" }),
    /Unknown pagerduty_client operation: bogus_op/
  );
});

await test("B14: generic request missing path throws", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "request", api_key: "key" }),
    /path is required/
  );
});

// ════════════════════════════════════════════════════════════════════════════
// C. MOCK-NETWORK FAILURE TESTS
// ════════════════════════════════════════════════════════════════════════════
console.log("\nC. Mock-network failure tests");

await test("C01: 401 Unauthorized throws PagerDuty API error", async () => {
  const restore = mockHttps({ status: 401, body: { error: { code: 2006, message: "Invalid API Token" } } });
  try {
    await assert.rejects(
      () => pagerdutyClient({ operation: "incident_list", api_key: "badkey" }),
      /PagerDuty API error 401/
    );
  } finally { restore(); }
});

await test("C02: 403 Forbidden throws PagerDuty API error", async () => {
  const restore = mockHttps({ status: 403, body: { error: { message: "Insufficient permissions" } } });
  try {
    await assert.rejects(
      () => pagerdutyClient({ operation: "user_delete", api_key: "key", user_id: "U1" }),
      /PagerDuty API error 403/
    );
  } finally { restore(); }
});

await test("C03: 429 Rate limited throws PagerDuty API error", async () => {
  const restore = mockHttps({ status: 429, body: { error: { message: "Rate Limit Exceeded" } } });
  try {
    await assert.rejects(
      () => pagerdutyClient({ operation: "incident_list", api_key: "key" }),
      /PagerDuty API error 429/
    );
  } finally { restore(); }
});

await test("C04: network error (socket error) is caught and throws", async () => {
  const original = https.request;
  https.request = (options, callback) => {
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => {
      process.nextTick(() => reqEmitter.emit("error", new Error("ECONNREFUSED")));
    };
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    await assert.rejects(
      () => pagerdutyClient({ operation: "incident_list", api_key: "key" }),
      /ECONNREFUSED/
    );
  } finally { https.request = original; }
});

await test("C05: timeout clamps min to 1000ms", async () => {
  let capturedOptions;
  const original = https.request;
  https.request = (options, callback) => {
    capturedOptions = options;
    const resEmitter = new EventEmitter();
    resEmitter.statusCode = 200;
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => {
      process.nextTick(() => {
        callback(resEmitter);
        process.nextTick(() => {
          resEmitter.emit("data", Buffer.from(JSON.stringify({ abilities: [] })));
          resEmitter.emit("end");
        });
      });
    };
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    await pagerdutyClient({ operation: "abilities_list", api_key: "key", timeout: 0 });
    assert.ok(capturedOptions !== undefined);
  } finally { https.request = original; }
});

await test("C06: escalation_policy_create success", async () => {
  const restore = mockHttps({ status: 201, body: { escalation_policy: { id: "EP2", name: "Critical" } } });
  try {
    const r = await pagerdutyClient({
      operation: "escalation_policy_create", api_key: "key",
      name: "Critical",
      escalation_rules: [{ escalation_delay_in_minutes: 30, targets: [{ id: "U1", type: "user_reference" }] }],
    });
    assert.strictEqual(r.id, "EP2");
  } finally { restore(); }
});

await test("C07: escalation_policy_delete returns deleted=true on 204", async () => {
  const restore = mockHttps({ status: 204, body: null });
  try {
    const r = await pagerdutyClient({ operation: "escalation_policy_delete", api_key: "key", escalation_policy_id: "EP1" });
    assert.strictEqual(r.deleted, true);
  } finally { restore(); }
});

await test("C08: schedule_get 404 returns exists=false", async () => {
  const restore = mockHttps({ status: 404, body: { error: {} } });
  try {
    const r = await pagerdutyClient({ operation: "schedule_get", api_key: "key", schedule_id: "GONE" });
    assert.strictEqual(r.exists, false);
  } finally { restore(); }
});

await test("C09: log_entry_get 404 returns exists=false", async () => {
  const restore = mockHttps({ status: 404, body: { error: {} } });
  try {
    const r = await pagerdutyClient({ operation: "log_entry_get", api_key: "key", log_entry_id: "GONE" });
    assert.strictEqual(r.exists, false);
  } finally { restore(); }
});

await test("C10: user_get 404 returns exists=false", async () => {
  const restore = mockHttps({ status: 404, body: { error: {} } });
  try {
    const r = await pagerdutyClient({ operation: "user_get", api_key: "key", user_id: "GONE" });
    assert.strictEqual(r.exists, false);
  } finally { restore(); }
});

await test("C11: team_get 404 returns exists=false", async () => {
  const restore = mockHttps({ status: 404, body: { error: {} } });
  try {
    const r = await pagerdutyClient({ operation: "team_get", api_key: "key", team_id: "GONE" });
    assert.strictEqual(r.exists, false);
  } finally { restore(); }
});

await test("C12: escalation_policy_get 404 returns exists=false", async () => {
  const restore = mockHttps({ status: 404, body: { error: {} } });
  try {
    const r = await pagerdutyClient({ operation: "escalation_policy_get", api_key: "key", escalation_policy_id: "GONE" });
    assert.strictEqual(r.exists, false);
  } finally { restore(); }
});

// ════════════════════════════════════════════════════════════════════════════
// D. SECURITY TESTS
// ════════════════════════════════════════════════════════════════════════════
console.log("\nD. Security tests");

await test("D01: api_key scrubbed from error message", async () => {
  const original = https.request;
  const SECRET_KEY = "super-secret-api-key-12345";
  https.request = (options, callback) => {
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => process.nextTick(() => reqEmitter.emit("error", new Error(`Connection failed with token=${SECRET_KEY}`)));
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    let errMsg = "";
    try {
      await pagerdutyClient({ operation: "incident_list", api_key: SECRET_KEY });
    } catch (e) { errMsg = e.message; }
    assert.ok(!errMsg.includes(SECRET_KEY), `api_key leaked in error: ${errMsg}`);
    assert.ok(errMsg.includes("[api_key]"), `Expected [api_key] placeholder, got: ${errMsg}`);
  } finally { https.request = original; }
});

await test("D02: access_token scrubbed from error message", async () => {
  const original = https.request;
  const SECRET = "Bearer super-secret-oauth-token";
  https.request = (options, callback) => {
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => process.nextTick(() => reqEmitter.emit("error", new Error(`Auth failed: token=${SECRET}`)));
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    let errMsg = "";
    try {
      await pagerdutyClient({ operation: "incident_list", access_token: SECRET });
    } catch (e) { errMsg = e.message; }
    assert.ok(!errMsg.includes(SECRET), `access_token leaked in error: ${errMsg}`);
    assert.ok(errMsg.includes("[access_token]"), `Expected [access_token] placeholder, got: ${errMsg}`);
  } finally { https.request = original; }
});

await test("D03: NUL byte in api_key is rejected", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_list", api_key: "key\x00injected" }),
    /NUL bytes/
  );
});

await test("D04: NUL byte in incident_id is rejected", async () => {
  const restore = mockHttps({ status: 200, body: { incident: {} } });
  try {
    await assert.rejects(
      () => pagerdutyClient({ operation: "incident_get", api_key: "key", incident_id: "P1\x00evil" }),
      /NUL bytes/
    );
  } finally { restore(); }
});

await test("D05: api_key not echoed in response body", async () => {
  const SECRET = "my-very-secret-api-key";
  const restore = mockHttps({ status: 200, body: { abilities: ["teams"] } });
  try {
    const r = await pagerdutyClient({ operation: "abilities_list", api_key: SECRET });
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(SECRET), `api_key leaked in response: ${serialized}`);
  } finally { restore(); }
});

await test("D06: api_key scrubbed from 4xx error response body", async () => {
  const SECRET = "secret-pd-key";
  const restore = mockHttps({
    status: 401,
    body: { error: { message: `Unauthorized: token=${SECRET}` } },
  });
  try {
    let errMsg = "";
    try {
      await pagerdutyClient({ operation: "incident_list", api_key: SECRET });
    } catch (e) { errMsg = e.message; }
    assert.ok(!errMsg.includes(SECRET), `api_key leaked in 401 error: ${errMsg}`);
  } finally { restore(); }
});

await test("D07: NUL byte in from_email is rejected", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_create", api_key: "key", title: "Test", service_id: "S1", from_email: "a@b.com\x00evil" }),
    /NUL bytes/
  );
});

await test("D08: NUL byte in access_token is rejected", async () => {
  await assert.rejects(
    () => pagerdutyClient({ operation: "incident_list", access_token: "token\x00injected" }),
    /NUL bytes/
  );
});

await test("D09: Content-Type application/json always set", async () => {
  let capturedHeaders;
  const original = https.request;
  https.request = (options, callback) => {
    capturedHeaders = options.headers;
    const resEmitter = new EventEmitter();
    resEmitter.statusCode = 200;
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => {
      process.nextTick(() => {
        callback(resEmitter);
        process.nextTick(() => {
          resEmitter.emit("data", Buffer.from(JSON.stringify({ abilities: [] })));
          resEmitter.emit("end");
        });
      });
    };
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    await pagerdutyClient({ operation: "abilities_list", api_key: "key" });
    assert.strictEqual(capturedHeaders["Content-Type"], "application/json");
    assert.ok(capturedHeaders["Accept"].includes("pagerduty"), `Expected PagerDuty accept header, got: ${capturedHeaders["Accept"]}`);
  } finally { https.request = original; }
});

await test("D10: TLS enabled by default (rejectUnauthorized=true)", async () => {
  let capturedOptions;
  const original = https.request;
  https.request = (options, callback) => {
    capturedOptions = options;
    const resEmitter = new EventEmitter();
    resEmitter.statusCode = 200;
    const reqEmitter = new EventEmitter();
    reqEmitter.write = () => {};
    reqEmitter.end = () => {
      process.nextTick(() => {
        callback(resEmitter);
        process.nextTick(() => {
          resEmitter.emit("data", Buffer.from(JSON.stringify({ abilities: [] })));
          resEmitter.emit("end");
        });
      });
    };
    reqEmitter.destroy = () => {};
    return reqEmitter;
  };
  try {
    await pagerdutyClient({ operation: "abilities_list", api_key: "key" });
    assert.strictEqual(capturedOptions.rejectUnauthorized, true);
  } finally { https.request = original; }
});

await test("D11: api_key scrubbed from 500 error response", async () => {
  const SECRET = "sec-api-500";
  const restore = mockHttps({
    status: 500,
    body: { error: { message: `Internal error ref=${SECRET}` } },
  });
  try {
    let errMsg = "";
    try {
      await pagerdutyClient({ operation: "service_list", api_key: SECRET });
    } catch (e) { errMsg = e.message; }
    assert.ok(!errMsg.includes(SECRET), `api_key leaked in 500 error: ${errMsg}`);
  } finally { restore(); }
});

await test("D12: access_token scrubbed from 401 response", async () => {
  const SECRET = "sec-oauth-401";
  const restore = mockHttps({
    status: 401,
    body: { error: { message: `Invalid token=${SECRET}` } },
  });
  try {
    let errMsg = "";
    try {
      await pagerdutyClient({ operation: "incident_list", access_token: SECRET });
    } catch (e) { errMsg = e.message; }
    assert.ok(!errMsg.includes(SECRET), `access_token leaked in 401 error: ${errMsg}`);
  } finally { restore(); }
});

// ════════════════════════════════════════════════════════════════════════════
// E. CONCURRENCY / STRESS TESTS
// ════════════════════════════════════════════════════════════════════════════
console.log("\nE. Concurrency tests");

await test("E01: 10 concurrent incident_list calls all succeed", async () => {
  const restore = mockHttps({ status: 200, body: { incidents: [], total: 0, more: false } });
  try {
    const promises = Array.from({ length: 10 }, () =>
      pagerdutyClient({ operation: "incident_list", api_key: "key" })
    );
    const results2 = await Promise.all(promises);
    assert.strictEqual(results2.length, 10);
    results2.forEach(r => assert.ok(Array.isArray(r.incidents)));
  } finally { restore(); }
});

await test("E02: concurrent mixed operations do not interfere", async () => {
  const restore = mockHttps([
    { status: 200, body: { incidents: [{id:"P1"}], total: 1, more: false } },
    { status: 200, body: { services: [{id:"SVC1"}], total: 1, more: false } },
    { status: 200, body: { users: [{id:"U1"}], total: 1, more: false } },
  ]);
  try {
    const [incidents, services, users] = await Promise.all([
      pagerdutyClient({ operation: "incident_list", api_key: "key" }),
      pagerdutyClient({ operation: "service_list", api_key: "key" }),
      pagerdutyClient({ operation: "user_list", api_key: "key" }),
    ]);
    assert.ok(Array.isArray(incidents.incidents));
    assert.ok(Array.isArray(services.services));
    assert.ok(Array.isArray(users.users));
  } finally { restore(); }
});

await test("E03: concurrent validation failures do not affect successful calls", async () => {
  const restore = mockHttps({ status: 200, body: { abilities: ["teams"] } });
  try {
    const results2 = await Promise.allSettled([
      pagerdutyClient({ operation: "incident_get", api_key: "key" }),
      pagerdutyClient({ operation: "abilities_list", api_key: "key" }),
      pagerdutyClient({ operation: "note_create", api_key: "key", incident_id: "P1" }),
    ]);
    assert.strictEqual(results2[0].status, "rejected");
    assert.strictEqual(results2[1].status, "fulfilled");
    assert.strictEqual(results2[2].status, "rejected");
  } finally { restore(); }
});

await test("E04: 20 concurrent team_list calls complete without memory blowup", async () => {
  const restore = mockHttps({ status: 200, body: { teams: Array.from({ length: 10 }, (_, i) => ({ id: `T${i}` })), total: 10, more: false } });
  try {
    const before = process.memoryUsage().heapUsed;
    await Promise.all(Array.from({ length: 20 }, () =>
      pagerdutyClient({ operation: "team_list", api_key: "key" })
    ));
    const after = process.memoryUsage().heapUsed;
    const growthMB = (after - before) / (1024 * 1024);
    assert.ok(growthMB < 50, `Memory grew too much: ${growthMB.toFixed(2)} MB`);
  } finally { restore(); }
});

await test("E05: concurrent schedule_list calls each return correct data", async () => {
  const restore = mockHttps({ status: 200, body: { schedules: [{ id: "SCH1" }], total: 1, more: false } });
  try {
    const res = await Promise.all([
      pagerdutyClient({ operation: "schedule_list", api_key: "key" }),
      pagerdutyClient({ operation: "schedule_list", api_key: "key" }),
      pagerdutyClient({ operation: "schedule_list", api_key: "key" }),
    ]);
    res.forEach(r => {
      assert.strictEqual(r.schedules.length, 1);
      assert.strictEqual(r.schedules[0].id, "SCH1");
    });
  } finally { restore(); }
});

await test("E06: concurrent NUL validation all reject correctly", async () => {
  const attacks = Array.from({ length: 5 }, () =>
    pagerdutyClient({ operation: "incident_list", api_key: "key\x00evil" })
  );
  const results2 = await Promise.allSettled(attacks);
  results2.forEach(r => {
    assert.strictEqual(r.status, "rejected");
    assert.ok(r.reason.message.includes("NUL"));
  });
});

await test("E07: high-concurrency (50) abilities_list calls", async () => {
  const restore = mockHttps({ status: 200, body: { abilities: ["teams", "sso"] } });
  try {
    const res = await Promise.all(
      Array.from({ length: 50 }, () =>
        pagerdutyClient({ operation: "abilities_list", api_key: "key" })
      )
    );
    assert.strictEqual(res.length, 50);
    res.forEach(r => assert.ok(Array.isArray(r.abilities)));
  } finally { restore(); }
});

await test("E08: sequential calls reuse independent request state", async () => {
  const restore = mockHttps([
    { status: 200, body: { incidents: [{ id: "P1" }], total: 1, more: false } },
    { status: 200, body: { incidents: [{ id: "P2" }], total: 1, more: false } },
    { status: 200, body: { incidents: [{ id: "P3" }], total: 1, more: false } },
  ]);
  try {
    const r1 = await pagerdutyClient({ operation: "incident_list", api_key: "key" });
    const r2 = await pagerdutyClient({ operation: "incident_list", api_key: "key" });
    const r3 = await pagerdutyClient({ operation: "incident_list", api_key: "key" });
    assert.strictEqual(r1.incidents[0].id, "P1");
    assert.strictEqual(r2.incidents[0].id, "P2");
    assert.strictEqual(r3.incidents[0].id, "P3");
  } finally { restore(); }
});

await test("E09: mixed success and failure concurrent calls", async () => {
  const restore = mockHttps({ status: 200, body: { incidents: [], total: 0, more: false } });
  try {
    const tasks = [
      pagerdutyClient({ operation: "incident_list", api_key: "key" }),
      pagerdutyClient({ operation: "incident_get" }),
      pagerdutyClient({ operation: "incident_list", api_key: "key" }),
    ];
    const res = await Promise.allSettled(tasks);
    assert.strictEqual(res[0].status, "fulfilled");
    assert.strictEqual(res[1].status, "rejected");
    assert.strictEqual(res[2].status, "fulfilled");
  } finally { restore(); }
});

await test("E10: escalation_policy_delete concurrent calls all return correct state", async () => {
  const restore = mockHttps({ status: 204, body: null });
  try {
    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pagerdutyClient({ operation: "escalation_policy_delete", api_key: "key", escalation_policy_id: `EP${i}` })
      )
    );
    res.forEach(r => assert.strictEqual(r.deleted, true));
  } finally { restore(); }
});

// ════════════════════════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════════════════════════

console.log("\n" + results.join("\n"));
console.log(`\n${"-".repeat(60)}`);
console.log(`pagerduty_client: ${passed} passed, ${failed} failed out of ${passed + failed} total`);

if (failed > 0) process.exit(1);

})();
