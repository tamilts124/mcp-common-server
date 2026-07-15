"use strict";
/**
 * Test suite: linear_client (section 282)
 * Five rigor levels: Normal, Medium, High, Critical, Extreme
 *
 * All tests run against the real linearClient() function logic directly.
 * Network calls are intercepted via monkey-patching https.request.
 */

const path = require("path");
const { linearClient } = require(path.join(__dirname, "../../lib/linearClientOps"));

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label) {
  if (condition) {
    process.stderr.write(`  \u2713 ${label}\n`);
    passed++;
  } else {
    process.stderr.write(`  \u2717 FAIL: ${label}\n`);
    failed++;
    errors.push(label);
  }
}

async function assertRejects(fn, msgPart, label) {
  try {
    await fn();
    process.stderr.write(`  \u2717 FAIL (no throw): ${label}\n`);
    failed++;
    errors.push(label);
  } catch (e) {
    const ok = !msgPart || e.message.includes(msgPart);
    assert(ok, `${label} [got: ${e.message.slice(0, 100)}]`);
  }
}

// ─── Mock https ───────────────────────────────────────────────────────────────

const https = require("https");
const EventEmitter = require("events");

let mockResponseBody = null;
let mockStatusCode   = 200;
let capturedRequest  = null;
let throwNetworkError = false;

const originalRequest = https.request.bind(https);

function mockRequest(options, callback) {
  capturedRequest = { options, body: "" };

  if (throwNetworkError) {
    const fakeReq = new EventEmitter();
    fakeReq.write  = (chunk) => { capturedRequest.body += chunk; };
    fakeReq.end    = () => { process.nextTick(() => fakeReq.emit("error", new Error("ECONNREFUSED"))); };
    fakeReq.destroy = () => {};
    return fakeReq;
  }

  const fakeRes = new EventEmitter();
  fakeRes.statusCode = mockStatusCode;
  fakeRes.setEncoding = () => {};

  const fakeReq = new EventEmitter();
  fakeReq.write  = (chunk) => { capturedRequest.body += chunk; };
  fakeReq.destroy = () => {};
  fakeReq.end    = () => {
    process.nextTick(() => {
      callback(fakeRes);
      process.nextTick(() => {
        fakeRes.emit("data", mockResponseBody);
        fakeRes.emit("end");
      });
    });
  };
  return fakeReq;
}

function setMock(body, status = 200) {
  mockResponseBody  = typeof body === "string" ? body : JSON.stringify(body);
  mockStatusCode    = status;
  throwNetworkError = false;
  capturedRequest   = null;
  https.request     = mockRequest;
}

function restoreHttps() {
  https.request = originalRequest;
  throwNetworkError = false;
}

// ─── LEVEL 1: Normal ───────────────────────────────────────────────────────────

async function testNormal() {
  process.stderr.write("\n[Level 1] Normal / Happy-path\n");

  // info
  setMock({ data: {
    viewer:       { id: "u1", name: "Alice", email: "a@example.com", displayName: "Alice" },
    organization: { id: "o1", name: "Acme Corp", urlKey: "acme" },
  }});
  const infoResult = await linearClient({ operation: "info", api_key: "lin_api_abc" });
  assert(infoResult.operation === "info", "info: operation field returned");
  assert(infoResult.result.viewer.name === "Alice", "info: viewer name correct");
  assert(infoResult.result.organization.name === "Acme Corp", "info: org name correct");

  // user_me
  setMock({ data: { viewer: { id: "u1", name: "Bob", email: "b@example.com", displayName: "Bob", active: true, admin: false, guest: false, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z" } } });
  const meResult = await linearClient({ operation: "user_me", api_key: "lin_api_abc" });
  assert(meResult.operation === "user_me", "user_me: operation field");
  assert(meResult.result.name === "Bob", "user_me: name correct");

  // issue_list
  setMock({ data: { issues: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [{ id: "i1", identifier: "ENG-1", title: "Fix bug", priority: 2 }],
  }}});
  const listResult = await linearClient({ operation: "issue_list", api_key: "lin_api_abc", team_id: "t1", limit: 10 });
  assert(listResult.result.nodes.length === 1, "issue_list: returns nodes");
  assert(listResult.result.nodes[0].identifier === "ENG-1", "issue_list: node identifier");

  // issue_get
  setMock({ data: { issue: { id: "i1", identifier: "ENG-1", title: "Fix login bug", priority: 1 } } });
  const getResult = await linearClient({ operation: "issue_get", api_key: "lin_api_abc", issue_id: "i1" });
  assert(getResult.result.identifier === "ENG-1", "issue_get: identifier");

  // issue_create
  setMock({ data: { issueCreate: { success: true, issue: { id: "i2", identifier: "ENG-2", title: "New issue" } } } });
  const createResult = await linearClient({ operation: "issue_create", api_key: "lin_api_abc", team_id: "t1", title: "New issue" });
  assert(createResult.result.success === true, "issue_create: success flag");
  assert(createResult.result.issue.identifier === "ENG-2", "issue_create: new issue identifier");

  // issue_update
  setMock({ data: { issueUpdate: { success: true, issue: { id: "i1", identifier: "ENG-1", title: "Fixed bug" } } } });
  const updateResult = await linearClient({ operation: "issue_update", api_key: "lin_api_abc", issue_id: "i1", title: "Fixed bug" });
  assert(updateResult.result.success === true, "issue_update: success");

  // issue_delete
  setMock({ data: { issueDelete: { success: true } } });
  const delResult = await linearClient({ operation: "issue_delete", api_key: "lin_api_abc", issue_id: "i1" });
  assert(delResult.result.success === true, "issue_delete: success");

  // issue_search
  setMock({ data: { issueSearch: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "i1", identifier: "ENG-1", title: "Login bug" }] } } });
  const searchResult = await linearClient({ operation: "issue_search", api_key: "lin_api_abc", query: "login bug" });
  assert(searchResult.result.nodes.length === 1, "issue_search: returns match");

  // issue_archive
  setMock({ data: { issueArchive: { success: true } } });
  const archResult = await linearClient({ operation: "issue_archive", api_key: "lin_api_abc", issue_id: "i1" });
  assert(archResult.result.success === true, "issue_archive: success");

  // issue_assign
  setMock({ data: { issueUpdate: { success: true, issue: { id: "i1", identifier: "ENG-1", title: "Fix bug", assignee: { id: "u2", name: "Carol", email: "c@x.com" } } } } });
  const assignResult = await linearClient({ operation: "issue_assign", api_key: "lin_api_abc", issue_id: "i1", user_id: "u2" });
  assert(assignResult.result.issue.assignee.name === "Carol", "issue_assign: assignee set");

  // issue_set_priority
  setMock({ data: { issueUpdate: { success: true, issue: { id: "i1", identifier: "ENG-1", title: "Fix bug", priority: 1, priorityLabel: "Urgent" } } } });
  const prioResult = await linearClient({ operation: "issue_set_priority", api_key: "lin_api_abc", issue_id: "i1", priority: 1 });
  assert(prioResult.result.issue.priorityLabel === "Urgent", "issue_set_priority: label");

  // team_list
  setMock({ data: { teams: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "t1", name: "Engineering", key: "ENG" }] } } });
  const teamListResult = await linearClient({ operation: "team_list", api_key: "lin_api_abc" });
  assert(teamListResult.result.nodes[0].key === "ENG", "team_list: team key");

  // project_list
  setMock({ data: { projects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "p1", name: "Alpha", status: "inProgress" }] } } });
  const projResult = await linearClient({ operation: "project_list", api_key: "lin_api_abc" });
  assert(projResult.result.nodes[0].name === "Alpha", "project_list: name");

  // comment_create
  setMock({ data: { commentCreate: { success: true, comment: { id: "c1", body: "Looks good!", createdAt: "2024-01-01T00:00:00Z" } } } });
  const commentResult = await linearClient({ operation: "comment_create", api_key: "lin_api_abc", issue_id: "i1", body: "Looks good!" });
  assert(commentResult.result.success === true, "comment_create: success");
  assert(commentResult.result.comment.body === "Looks good!", "comment_create: body");

  // org_info
  setMock({ data: { organization: { id: "o1", name: "Acme", urlKey: "acme", subscription: { type: "pro", seats: 50 } } } });
  const orgResult = await linearClient({ operation: "org_info", api_key: "lin_api_abc" });
  assert(orgResult.result.name === "Acme", "org_info: name");

  // Bearer token auth (access_token path)
  setMock({ data: { viewer: { id: "u3", name: "Dave", email: "d@x.com", displayName: "Dave", active: true, admin: false, guest: false, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z" } } });
  const bearerResult = await linearClient({ operation: "user_me", access_token: "tok_xyz" });
  assert(capturedRequest.options.headers["Authorization"] === "Bearer tok_xyz", "access_token: Authorization header");
  assert(bearerResult.result.name === "Dave", "access_token: user retrieved");

  restoreHttps();
}

// ─── LEVEL 2: Medium ─────────────────────────────────────────────────────────

async function testMedium() {
  process.stderr.write("\n[Level 2] Medium / Validation\n");

  // missing operation
  await assertRejects(
    () => linearClient({ api_key: "lin_api_abc" }),
    "'operation' is required",
    "missing operation throws"
  );

  // unknown operation
  setMock({ data: {} });
  await assertRejects(
    () => linearClient({ operation: "fly_to_moon", api_key: "lin_api_abc" }),
    "Unknown operation",
    "unknown operation throws"
  );

  // missing auth
  setMock({ data: {} });
  await assertRejects(
    () => linearClient({ operation: "user_me" }),
    "Either 'api_key' or 'access_token' is required",
    "missing auth throws"
  );

  // issue_create requires team_id
  setMock({ data: {} });
  await assertRejects(
    () => linearClient({ operation: "issue_create", api_key: "key", title: "T" }),
    "'team_id' is required",
    "issue_create without team_id throws"
  );

  // issue_set_priority with invalid value
  setMock({ data: {} });
  await assertRejects(
    () => linearClient({ operation: "issue_set_priority", api_key: "key", issue_id: "i1", priority: 99 }),
    "priority must be",
    "invalid priority value throws"
  );

  // limit clamped to 250
  setMock({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
  await linearClient({ operation: "issue_list", api_key: "key", limit: 99999 });
  const body = JSON.parse(capturedRequest.body);
  assert(body.variables.first === 250, "limit clamped to 250");

  // HTTP 401 error surfaced correctly
  setMock(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), 200);
  await assertRejects(
    () => linearClient({ operation: "user_me", api_key: "bad_key" }),
    "Linear GraphQL error",
    "GraphQL errors surfaced"
  );

  // HTTP 400 surfaced
  setMock(JSON.stringify({ error: "Bad request" }), 400);
  await assertRejects(
    () => linearClient({ operation: "user_me", api_key: "key" }),
    "Linear API error (HTTP 400)",
    "HTTP 400 surfaced as error"
  );

  restoreHttps();
}

// ─── LEVEL 3: High / Network failure mocking ─────────────────────────────────

async function testHigh() {
  process.stderr.write("\n[Level 3] High / Network failures\n");

  // ECONNREFUSED
  throwNetworkError = true;
  https.request = mockRequest;
  await assertRejects(
    () => linearClient({ operation: "user_me", api_key: "key" }),
    "ECONNREFUSED",
    "network error propagated"
  );
  restoreHttps();

  // Malformed JSON response
  setMock("not json at all", 200);
  await assertRejects(
    () => linearClient({ operation: "user_me", api_key: "key" }),
    "Failed to parse Linear response",
    "malformed JSON surfaced"
  );

  // HTTP 500 server error
  setMock(JSON.stringify({ error: "Internal Server Error" }), 500);
  await assertRejects(
    () => linearClient({ operation: "user_me", api_key: "key" }),
    "HTTP 500",
    "HTTP 500 surfaced"
  );

  // HTTP 403 forbidden
  setMock(JSON.stringify({ error: "Forbidden" }), 403);
  await assertRejects(
    () => linearClient({ operation: "user_me", api_key: "key" }),
    "HTTP 403",
    "HTTP 403 surfaced"
  );

  // Multiple GraphQL errors joined
  setMock(JSON.stringify({ errors: [{ message: "Error A" }, { message: "Error B" }] }));
  await assertRejects(
    () => linearClient({ operation: "user_me", api_key: "key" }),
    "Error A",
    "multiple GraphQL errors joined"
  );

  // graphql operation passes raw query
  setMock({ data: { teams: { nodes: [{ id: "t1", name: "Eng" }] } } });
  const rawResult = await linearClient({
    operation: "graphql",
    api_key: "key",
    query: "{ teams { nodes { id name } } }",
  });
  assert(rawResult.result.teams.nodes[0].name === "Eng", "graphql: raw query executed");

  // graphql without query throws
  setMock({ data: {} });
  await assertRejects(
    () => linearClient({ operation: "graphql", api_key: "key" }),
    "'query' (GraphQL query string) is required",
    "graphql without query throws"
  );

  restoreHttps();
}

// ─── LEVEL 4: Critical / Sanitization ──────────────────────────────────────────

async function testCritical() {
  process.stderr.write("\n[Level 4] Critical / Security\n");

  // NUL byte in api_key
  await assertRejects(
    () => linearClient({ operation: "user_me", api_key: "key\0evil" }),
    "NUL bytes",
    "NUL in api_key rejected"
  );

  // NUL byte in team_id
  setMock({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
  await assertRejects(
    () => linearClient({ operation: "issue_list", api_key: "key", team_id: "t1\0x" }),
    "NUL bytes",
    "NUL in team_id rejected"
  );

  // NUL byte in title
  await assertRejects(
    () => linearClient({ operation: "issue_create", api_key: "key", team_id: "t1", title: "bad\0title" }),
    "NUL bytes",
    "NUL in title rejected"
  );

  // NUL byte in query
  await assertRejects(
    () => linearClient({ operation: "issue_search", api_key: "key", query: "foo\0bar" }),
    "NUL bytes",
    "NUL in query rejected"
  );

  // Credential scrubbing: api_key must not appear in error messages
  setMock(JSON.stringify({ errors: [{ message: "The token lin_api_SECRET is invalid" }] }));
  try {
    await linearClient({ operation: "user_me", api_key: "lin_api_SECRET" });
    assert(false, "credential scrub: should have thrown");
  } catch (e) {
    assert(!e.message.includes("lin_api_SECRET"), "credential scrub: api_key not in error message");
  }

  // Credential scrubbing: access_token must not appear in error messages
  setMock(JSON.stringify({ errors: [{ message: "Bearer tok_MY_PRIVATE_TOKEN revoked" }] }));
  try {
    await linearClient({ operation: "user_me", access_token: "tok_MY_PRIVATE_TOKEN" });
    assert(false, "credential scrub: should have thrown");
  } catch (e) {
    assert(!e.message.includes("tok_MY_PRIVATE_TOKEN"), "credential scrub: access_token not in error message");
  }

  // No extra auth when neither key provided (catches early)
  await assertRejects(
    () => linearClient({ operation: "user_me" }),
    "Either 'api_key' or 'access_token' is required",
    "no credentials: specific error"
  );

  // Request body must be valid JSON (no injection)
  setMock({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
  await linearClient({ operation: "issue_list", api_key: "key", title: 'Test "quoted" title' });
  const parsed = JSON.parse(capturedRequest.body);
  assert(typeof parsed.query === "string", "request body is valid JSON");
  assert(parsed.variables !== undefined, "request body has variables");

  restoreHttps();
}

// ─── LEVEL 5: Extreme / Concurrency & stress ─────────────────────────────────

async function testExtreme() {
  process.stderr.write("\n[Level 5] Extreme / Concurrency & stress\n");

  // 50 concurrent user_me calls
  setMock({ data: { viewer: { id: "u1", name: "Alice", email: "a@x.com", displayName: "Alice", active: true, admin: false, guest: false, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" } } });
  const concurrentCalls = Array.from({ length: 50 }, () =>
    linearClient({ operation: "user_me", api_key: "key" })
  );
  const results = await Promise.all(concurrentCalls);
  assert(results.length === 50, "50 concurrent calls all resolved");
  assert(results.every(r => r.operation === "user_me"), "50 concurrent calls: all correct operation");
  assert(results.every(r => r.result.name === "Alice"), "50 concurrent calls: all correct result");

  // Large response (within 10 MB limit) — simulate 500 issues
  const largeIssues = Array.from({ length: 500 }, (_, i) => ({
    id: `i${i}`, identifier: `ENG-${i}`, title: `Issue ${i}`, priority: i % 5,
  }));
  setMock({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: largeIssues } } });
  const largeResult = await linearClient({ operation: "issue_list", api_key: "key", limit: 250 });
  assert(largeResult.result.nodes.length === 500, "large response: 500 issues returned");

  // Rapid sequential calls — 20 in sequence
  let seqCount = 0;
  for (let i = 0; i < 20; i++) {
    setMock({ data: { viewer: { id: `u${i}`, name: `User${i}`, email: `u${i}@x.com`, displayName: `User${i}`, active: true, admin: false, guest: false, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" } } });
    const r = await linearClient({ operation: "user_me", api_key: "key" });
    if (r.result.name === `User${i}`) seqCount++;
  }
  assert(seqCount === 20, "20 rapid sequential calls all succeed");

  // Mixed operation concurrency (4 different ops at once, 10x each)
  setMock({ data: {
    viewer: { id: "u1", name: "Alice", email: "a@x.com", displayName: "Alice", active: true, admin: false, guest: false, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
    teams:  { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    projects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    users:  { nodes: [] },
  }});
  // Each op needs its own mock since they send different queries
  const ops = ["user_me", "team_list", "project_list", "user_list"];
  const mixedResults = await Promise.allSettled(
    ops.flatMap(op =>
      Array.from({ length: 10 }, () => {
        setMock({ data: {
          viewer:   { id: "u1", name: "Alice", email: "a@x.com", displayName: "Alice", active: true, admin: false, guest: false, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" },
          teams:    { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          projects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          users:    { nodes: [] },
        }});
        return linearClient({ operation: op, api_key: "key" });
      })
    )
  );
  const mixedFulfilled = mixedResults.filter(r => r.status === "fulfilled").length;
  assert(mixedFulfilled === 40, `mixed concurrent ops: ${mixedFulfilled}/40 succeeded`);

  // Operations object is not mutated across calls
  setMock({ data: { viewer: { id: "u1", name: "Alice", email: "a@x.com", displayName: "Alice", active: true, admin: false, guest: false, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" } } });
  const r1 = await linearClient({ operation: "user_me", api_key: "key" });
  setMock({ data: { viewer: { id: "u2", name: "Bob", email: "b@x.com", displayName: "Bob", active: true, admin: false, guest: false, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" } } });
  const r2 = await linearClient({ operation: "user_me", api_key: "key" });
  assert(r1.result.name !== r2.result.name, "no state pollution between calls");

  restoreHttps();
}

// ─── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  process.stderr.write("=== linear_client tests (section 282) ===\n");
  try {
    await testNormal();
    await testMedium();
    await testHigh();
    await testCritical();
    await testExtreme();
  } finally {
    restoreHttps();
  }
  process.stderr.write(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (errors.length) {
    process.stderr.write(`Failed:\n${errors.map(e => `  - ${e}`).join("\n")}\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
