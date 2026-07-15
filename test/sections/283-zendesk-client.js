"use strict";
/**
 * Test suite: zendesk_client (section 283)
 * Five rigor levels: Normal, Medium, High, Critical, Extreme
 *
 * All tests run against the real zendeskClient() function logic directly.
 * Network calls are intercepted via monkey-patching https.request.
 */

const path = require("path");
const { zendeskClient } = require(path.join(__dirname, "../../lib/zendeskClientOps"));

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
    assert(ok, `${label} [got: ${e.message.slice(0, 120)}]`);
  }
}

// ─── Mock https ───────────────────────────────────────────────────────────────

const https = require("https");
const EventEmitter = require("events");

let mockResponseBody   = null;
let mockStatusCode     = 200;
let capturedRequest    = null;
let throwNetworkError  = false;

const originalRequest = https.request.bind(https);

function mockRequest(options, callback) {
  capturedRequest = { options, body: Buffer.alloc(0) };

  if (throwNetworkError) {
    const fakeReq = new EventEmitter();
    fakeReq.write   = (chunk) => {};
    fakeReq.end     = () => { process.nextTick(() => fakeReq.emit("error", new Error("ECONNREFUSED"))); };
    fakeReq.destroy = () => {};
    return fakeReq;
  }

  const fakeRes = new EventEmitter();
  fakeRes.statusCode = mockStatusCode;
  fakeRes.setEncoding = () => {};

  const fakeReq = new EventEmitter();
  fakeReq.write   = (chunk) => {
    if (chunk) capturedRequest.body = Buffer.concat([capturedRequest.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  };
  fakeReq.destroy = () => {};
  fakeReq.end     = () => {
    process.nextTick(() => {
      callback(fakeRes);
      process.nextTick(() => {
        const body = typeof mockResponseBody === "string" ? mockResponseBody : JSON.stringify(mockResponseBody);
        fakeRes.emit("data", Buffer.from(body));
        fakeRes.emit("end");
      });
    });
  };
  return fakeReq;
}

function setMock(body, status = 200) {
  mockResponseBody  = body;
  mockStatusCode    = status;
  throwNetworkError = false;
  capturedRequest   = null;
  https.request     = mockRequest;
}

function restoreHttps() {
  https.request     = originalRequest;
  throwNetworkError = false;
}

// Common auth
const AUTH = { subdomain: "myco", email: "agent@example.com", api_token: "tok123" };
const BEARER_AUTH = { subdomain: "myco", access_token: "bearer_xyz" };

// ─── LEVEL 1: Normal / Happy-path ────────────────────────────────────────────

async function testNormal() {
  process.stderr.write("\n[Level 1] Normal / Happy-path\n");

  // info
  setMock({ user: { id: 1, name: "Alice", email: "agent@example.com", role: "admin" } });
  const infoResult = await zendeskClient({ ...AUTH, operation: "info" });
  assert(infoResult.subdomain === "myco", "info: subdomain returned");
  assert(infoResult.authenticated_as.name === "Alice", "info: authenticated_as name");
  assert(infoResult.api_version === "v2", "info: api_version");

  // ticket_get
  setMock({ ticket: { id: 101, subject: "Login broken", status: "open", priority: "high" } });
  const tktGet = await zendeskClient({ ...AUTH, operation: "ticket_get", ticket_id: 101 });
  assert(tktGet.id === 101, "ticket_get: id correct");
  assert(tktGet.subject === "Login broken", "ticket_get: subject");

  // ticket_list
  setMock({ tickets: [{ id: 1, subject: "A" }, { id: 2, subject: "B" }], count: 2, next_page: null });
  const tktList = await zendeskClient({ ...AUTH, operation: "ticket_list", limit: 10 });
  assert(tktList.tickets.length === 2, "ticket_list: 2 tickets");
  assert(tktList.count === 2, "ticket_list: count");

  // ticket_create
  setMock({ ticket: { id: 200, subject: "New issue", status: "new", priority: "normal" } }, 201);
  const tktCreate = await zendeskClient({ ...AUTH, operation: "ticket_create", subject: "New issue", comment_body: "Something broke" });
  assert(tktCreate.id === 200, "ticket_create: id");
  assert(tktCreate.subject === "New issue", "ticket_create: subject");

  // ticket_update
  setMock({ ticket: { id: 101, subject: "Login broken", status: "pending", priority: "high" } });
  const tktUpdate = await zendeskClient({ ...AUTH, operation: "ticket_update", ticket_id: 101, status: "pending" });
  assert(tktUpdate.status === "pending", "ticket_update: status");

  // ticket_delete (204 success)
  setMock("", 204);
  const tktDel = await zendeskClient({ ...AUTH, operation: "ticket_delete", ticket_id: 101 });
  assert(tktDel.deleted === true, "ticket_delete: deleted flag");
  assert(tktDel.ticket_id === 101, "ticket_delete: ticket_id echoed");

  // ticket_search
  setMock({ results: [{ id: 1, subject: "Login" }], count: 1, next_page: null });
  const tktSearch = await zendeskClient({ ...AUTH, operation: "ticket_search", query: "subject:Login" });
  assert(tktSearch.results.length === 1, "ticket_search: 1 result");

  // ticket_assign
  setMock({ ticket: { id: 101, assignee_id: 42, subject: "Test" } });
  const tktAssign = await zendeskClient({ ...AUTH, operation: "ticket_assign", ticket_id: 101, assignee_id: 42 });
  assert(tktAssign.assignee_id === 42, "ticket_assign: assignee_id");

  // ticket_set_status
  setMock({ ticket: { id: 101, status: "solved", subject: "Test" } });
  const tktStatus = await zendeskClient({ ...AUTH, operation: "ticket_set_status", ticket_id: 101, status: "solved" });
  assert(tktStatus.status === "solved", "ticket_set_status: status");

  // ticket_bulk_update
  setMock({ job_status: { id: "j1", status: "queued", total: 3, progress: 0 } });
  const tktBulk = await zendeskClient({ ...AUTH, operation: "ticket_bulk_update", ticket_ids: [1, 2, 3], status: "solved" });
  assert(tktBulk.id === "j1", "ticket_bulk_update: job_status id");

  // comment_list
  setMock({ comments: [{ id: 1, body: "Hello" }, { id: 2, body: "World" }], count: 2 });
  const cmtList = await zendeskClient({ ...AUTH, operation: "comment_list", ticket_id: 101 });
  assert(cmtList.comments.length === 2, "comment_list: 2 comments");

  // comment_create
  setMock({ ticket: { id: 101, subject: "Test", status: "open", comment: { id: 55, body: "Hi there" } } });
  const cmtCreate = await zendeskClient({ ...AUTH, operation: "comment_create", ticket_id: 101, body: "Hi there" });
  assert(cmtCreate.id === 101, "comment_create: ticket id");

  // user_me
  setMock({ user: { id: 99, name: "Me", email: "me@example.com", role: "agent" } });
  const userMe = await zendeskClient({ ...AUTH, operation: "user_me" });
  assert(userMe.name === "Me", "user_me: name");

  // user_get
  setMock({ user: { id: 5, name: "Bob", email: "bob@example.com", role: "end-user" } });
  const userGet = await zendeskClient({ ...AUTH, operation: "user_get", user_id: 5 });
  assert(userGet.name === "Bob", "user_get: name");

  // user_get 404 -> exists:false
  setMock({ error: "RecordNotFound", description: "Not found" }, 404);
  const userNotFound = await zendeskClient({ ...AUTH, operation: "user_get", user_id: 99999 });
  assert(userNotFound.exists === false, "user_get 404: exists:false");
  assert(userNotFound.user_id === 99999, "user_get 404: user_id echoed");

  // user_list
  setMock({ users: [{ id: 1, name: "A" }], count: 1, next_page: null });
  const userList = await zendeskClient({ ...AUTH, operation: "user_list", limit: 5 });
  assert(userList.users.length === 1, "user_list: users");

  // user_search
  setMock({ users: [{ id: 3, name: "Carol" }], count: 1 });
  const userSearch = await zendeskClient({ ...AUTH, operation: "user_search", query: "carol" });
  assert(userSearch.users[0].name === "Carol", "user_search: found Carol");

  // user_create
  setMock({ user: { id: 10, name: "Dave", email: "dave@x.com", role: "end-user" } }, 201);
  const userCreate = await zendeskClient({ ...AUTH, operation: "user_create", name: "Dave", email_address: "dave@x.com" });
  assert(userCreate.id === 10, "user_create: id");

  // user_update
  setMock({ user: { id: 10, name: "David", email: "dave@x.com", role: "agent" } });
  const userUpdate = await zendeskClient({ ...AUTH, operation: "user_update", user_id: 10, name: "David" });
  assert(userUpdate.name === "David", "user_update: name");

  // user_delete
  setMock("", 204);
  const userDel = await zendeskClient({ ...AUTH, operation: "user_delete", user_id: 10 });
  assert(userDel.deleted === true, "user_delete: deleted");

  // org_get
  setMock({ organization: { id: 7, name: "Acme Corp", external_id: null } });
  const orgGet = await zendeskClient({ ...AUTH, operation: "org_get", organization_id: 7 });
  assert(orgGet.name === "Acme Corp", "org_get: name");

  // org_list
  setMock({ organizations: [{ id: 7, name: "Acme" }], count: 1, next_page: null });
  const orgList = await zendeskClient({ ...AUTH, operation: "org_list" });
  assert(orgList.organizations.length === 1, "org_list: orgs");

  // org_create
  setMock({ organization: { id: 20, name: "NewCo" } }, 201);
  const orgCreate = await zendeskClient({ ...AUTH, operation: "org_create", name: "NewCo" });
  assert(orgCreate.id === 20, "org_create: id");

  // group_get
  setMock({ group: { id: 3, name: "Support" } });
  const grpGet = await zendeskClient({ ...AUTH, operation: "group_get", group_id: 3 });
  assert(grpGet.name === "Support", "group_get: name");

  // group_list
  setMock({ groups: [{ id: 3, name: "Support" }], count: 1, next_page: null });
  const grpList = await zendeskClient({ ...AUTH, operation: "group_list" });
  assert(grpList.groups.length === 1, "group_list: groups");

  // group_members
  setMock({ group_memberships: [{ id: 1, user_id: 5, group_id: 3 }], count: 1 });
  const grpMembers = await zendeskClient({ ...AUTH, operation: "group_members", group_id: 3 });
  assert(grpMembers.memberships.length === 1, "group_members: memberships");

  // tag_list
  setMock({ tags: [{ name: "billing", count: 10 }], count: 1 });
  const tagList = await zendeskClient({ ...AUTH, operation: "tag_list" });
  assert(tagList.tags[0].name === "billing", "tag_list: tag name");

  // tag_add
  setMock({ tags: ["billing", "vip"] });
  const tagAdd = await zendeskClient({ ...AUTH, operation: "tag_add", ticket_id: 101, tags: ["billing", "vip"] });
  assert(Array.isArray(tagAdd.tags), "tag_add: tags array");

  // tag_remove
  setMock(null, 204);
  const tagRemove = await zendeskClient({ ...AUTH, operation: "tag_remove", ticket_id: 101, tags: ["billing"] });
  assert(tagRemove.removed === true, "tag_remove: removed flag");

  // view_list
  setMock({ views: [{ id: 10, title: "All open" }], count: 1 });
  const viewList = await zendeskClient({ ...AUTH, operation: "view_list" });
  assert(viewList.views[0].title === "All open", "view_list: title");

  // view_get
  setMock({ view: { id: 10, title: "All open" } });
  const viewGet = await zendeskClient({ ...AUTH, operation: "view_get", view_id: 10 });
  assert(viewGet.title === "All open", "view_get: title");

  // view_tickets
  setMock({ tickets: [{ id: 1, subject: "X" }], count: 1, next_page: null });
  const viewTkts = await zendeskClient({ ...AUTH, operation: "view_tickets", view_id: 10 });
  assert(viewTkts.tickets.length === 1, "view_tickets: tickets");

  // macro_list
  setMock({ macros: [{ id: 5, title: "Close ticket" }], count: 1 });
  const macroList = await zendeskClient({ ...AUTH, operation: "macro_list" });
  assert(macroList.macros[0].title === "Close ticket", "macro_list: title");

  // macro_apply
  setMock({ result: { ticket: { id: 101, status: "solved" }, actions: [{ field: "status", value: "solved" }] } });
  const macroApply = await zendeskClient({ ...AUTH, operation: "macro_apply", ticket_id: 101, macro_id: 5 });
  assert(macroApply.ticket.status === "solved", "macro_apply: applied status");

  // satisfaction_list
  setMock({ satisfaction_ratings: [{ id: 1, score: "good" }], count: 1 });
  const satList = await zendeskClient({ ...AUTH, operation: "satisfaction_list" });
  assert(satList.satisfaction_ratings[0].score === "good", "satisfaction_list: score");

  // satisfaction_get
  setMock({ satisfaction_rating: { id: 1, score: "good", comment: "Great!" } });
  const satGet = await zendeskClient({ ...AUTH, operation: "satisfaction_get", satisfaction_rating_id: 1 });
  assert(satGet.score === "good", "satisfaction_get: score");

  // generic request
  setMock({ ticket: { id: 1 } });
  const req = await zendeskClient({ ...AUTH, operation: "request", method: "GET", path: "/tickets/1.json" });
  assert(req.status === 200, "request: status 200");
  assert(req.body.ticket.id === 1, "request: body");

  // Bearer (access_token) auth path
  setMock({ user: { id: 1, name: "Bearer User", email: "b@x.com", role: "admin" } });
  const bearerResult = await zendeskClient({ ...BEARER_AUTH, operation: "user_me" });
  assert(capturedRequest.options.headers["Authorization"].startsWith("Bearer "), "Bearer auth: Authorization header");
  assert(bearerResult.name === "Bearer User", "Bearer auth: user name");

  restoreHttps();
}

// ─── LEVEL 2: Medium / Validation ────────────────────────────────────────────

async function testMedium() {
  process.stderr.write("\n[Level 2] Medium / Validation\n");

  // Missing operation
  await assertRejects(
    () => zendeskClient({ ...AUTH }),
    "operation is required",
    "missing operation throws"
  );

  // Unknown operation
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "fly_to_moon" }),
    "Unknown zendesk_client operation",
    "unknown operation throws"
  );

  // Missing subdomain
  await assertRejects(
    () => zendeskClient({ email: "a@x.com", api_token: "tok", operation: "user_me" }),
    "subdomain is required",
    "missing subdomain throws"
  );

  // Missing email when not using access_token
  await assertRejects(
    () => zendeskClient({ subdomain: "myco", api_token: "tok", operation: "user_me" }),
    "email is required",
    "missing email throws without access_token"
  );

  // Missing api_token when not using access_token
  await assertRejects(
    () => zendeskClient({ subdomain: "myco", email: "a@x.com", operation: "user_me" }),
    "api_token is required",
    "missing api_token throws without access_token"
  );

  // ticket_set_status with invalid status
  setMock({ ticket: {} });
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "ticket_set_status", ticket_id: 1, status: "flying" }),
    "status must be one of",
    "invalid ticket status throws"
  );

  // ticket_assign without assignee_id or group_id
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "ticket_assign", ticket_id: 1 }),
    "assignee_id or group_id required",
    "ticket_assign without assignee_id/group_id throws"
  );

  // ticket_bulk_update with empty ticket_ids
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "ticket_bulk_update", ticket_ids: [], status: "solved" }),
    "ticket_ids must be a non-empty array",
    "ticket_bulk_update empty ids throws"
  );

  // tag_add with empty tags
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "tag_add", ticket_id: 1, tags: [] }),
    "tags must be a non-empty array",
    "tag_add empty tags throws"
  );

  // ticket_create missing subject
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "ticket_create" }),
    "subject is required",
    "ticket_create without subject throws"
  );

  // user_create missing name
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "user_create", email_address: "x@x.com" }),
    "name is required",
    "user_create without name throws"
  );

  // user_create missing email (use BEARER_AUTH so email field is absent from args)
  await assertRejects(
    () => zendeskClient({ ...BEARER_AUTH, operation: "user_create", name: "X" }),
    "email/email_address is required",
    "user_create without email throws"
  );

  // ticket_search missing query
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "ticket_search" }),
    "query is required",
    "ticket_search without query throws"
  );

  // Zendesk API error surfaced
  setMock({ error: "RecordNotFound", description: "Not found" }, 404);
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "ticket_get", ticket_id: 9999 }),
    "Zendesk API error 404",
    "HTTP 404 on ticket_get throws"
  );

  restoreHttps();
}

// ─── LEVEL 3: High / Network failures ────────────────────────────────────────

async function testHigh() {
  process.stderr.write("\n[Level 3] High / Network failures\n");

  // ECONNREFUSED
  throwNetworkError = true;
  https.request = mockRequest;
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "user_me" }),
    "ECONNREFUSED",
    "network error propagated"
  );
  restoreHttps();

  // HTTP 500
  setMock({ error: "InternalError" }, 500);
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "user_me" }),
    "Zendesk API error 500",
    "HTTP 500 surfaced"
  );

  // HTTP 403
  setMock({ error: "Forbidden" }, 403);
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "ticket_list" }),
    "Zendesk API error 403",
    "HTTP 403 surfaced"
  );

  // HTTP 429 rate limit
  setMock({ error: "TooManyRequests" }, 429);
  await assertRejects(
    () => zendeskClient({ ...AUTH, operation: "ticket_list" }),
    "Zendesk API error 429",
    "HTTP 429 surfaced"
  );

  // 204 No Content handled correctly (delete)
  setMock("", 204);
  const del = await zendeskClient({ ...AUTH, operation: "ticket_delete", ticket_id: 1 });
  assert(del.deleted === true, "204 No Content: deleted=true");

  // Non-JSON response handled (wraps in _raw)
  setMock("Plain text response", 200);
  const infoRes = await zendeskClient({ ...AUTH, operation: "user_me" });
  // user_me returns res.body.user — body has _raw when non-JSON
  // This means body.user is undefined but no throw
  assert(infoRes === undefined || typeof infoRes === "object", "non-JSON body handled gracefully");

  // org_get 404 -> exists:false
  setMock({ error: "NotFound" }, 404);
  const orgNF = await zendeskClient({ ...AUTH, operation: "org_get", organization_id: 9999 });
  assert(orgNF.exists === false, "org_get 404: exists:false");

  // group_get 404 -> exists:false
  setMock({ error: "NotFound" }, 404);
  const grpNF = await zendeskClient({ ...AUTH, operation: "group_get", group_id: 9999 });
  assert(grpNF.exists === false, "group_get 404: exists:false");

  // view_get 404 -> exists:false
  setMock({ error: "NotFound" }, 404);
  const viewNF = await zendeskClient({ ...AUTH, operation: "view_get", view_id: 9999 });
  assert(viewNF.exists === false, "view_get 404: exists:false");

  // satisfaction_get 404 -> exists:false
  setMock({ error: "NotFound" }, 404);
  const satNF = await zendeskClient({ ...AUTH, operation: "satisfaction_get", satisfaction_rating_id: 9999 });
  assert(satNF.exists === false, "satisfaction_get 404: exists:false");

  // ticket_delete 404 -> deleted:false
  setMock({ error: "NotFound" }, 404);
  const tktNF = await zendeskClient({ ...AUTH, operation: "ticket_delete", ticket_id: 9999 });
  assert(tktNF.deleted === false, "ticket_delete 404: deleted:false");

  // user_delete 404 -> deleted:false
  setMock({ error: "NotFound" }, 404);
  const userNF = await zendeskClient({ ...AUTH, operation: "user_delete", user_id: 9999 });
  assert(userNF.deleted === false, "user_delete 404: deleted:false");

  restoreHttps();
}

// ─── LEVEL 4: Critical / Security ────────────────────────────────────────────

async function testCritical() {
  process.stderr.write("\n[Level 4] Critical / Security\n");

  // NUL byte in api_token
  await assertRejects(
    () => zendeskClient({ subdomain: "myco", email: "a@x.com", api_token: "tok\0evil", operation: "user_me" }),
    "NUL bytes",
    "NUL in api_token rejected"
  );

  // NUL byte in subdomain
  await assertRejects(
    () => zendeskClient({ subdomain: "myco\0evil", email: "a@x.com", api_token: "tok", operation: "user_me" }),
    "NUL bytes",
    "NUL in subdomain rejected"
  );

  // NUL byte in email
  await assertRejects(
    () => zendeskClient({ subdomain: "myco", email: "a\0@x.com", api_token: "tok", operation: "user_me" }),
    "NUL bytes",
    "NUL in email rejected"
  );

  // NUL byte in access_token
  await assertRejects(
    () => zendeskClient({ subdomain: "myco", access_token: "bearer\0x", operation: "user_me" }),
    "NUL bytes",
    "NUL in access_token rejected"
  );

  // Credential scrubbing: api_token must not appear in error messages
  setMock({ error: "The token tok_SECRET_VAL is invalid" }, 401);
  try {
    await zendeskClient({ subdomain: "myco", email: "a@x.com", api_token: "tok_SECRET_VAL", operation: "user_me" });
    assert(false, "credential scrub: should have thrown");
  } catch (e) {
    assert(!e.message.includes("tok_SECRET_VAL"), "credential scrub: api_token not in error message");
  }

  // Credential scrubbing: email must not appear in error messages
  setMock({ error: "Email secret@internal.corp is banned" }, 403);
  try {
    await zendeskClient({ subdomain: "myco", email: "secret@internal.corp", api_token: "tok", operation: "user_me" });
    assert(false, "email credential scrub: should have thrown");
  } catch (e) {
    assert(!e.message.includes("secret@internal.corp"), "credential scrub: email not in error message");
  }

  // Credential scrubbing: access_token must not appear in error messages
  setMock({ error: "Token bearer_PRIVATE_TOKEN is revoked" }, 401);
  try {
    await zendeskClient({ subdomain: "myco", access_token: "bearer_PRIVATE_TOKEN", operation: "user_me" });
    assert(false, "access_token scrub: should have thrown");
  } catch (e) {
    assert(!e.message.includes("bearer_PRIVATE_TOKEN"), "credential scrub: access_token not in error message");
  }

  // Request body must be valid JSON
  setMock({ ticket: { id: 1, subject: 'He said "hi"', status: "open" } }, 201);
  await zendeskClient({ ...AUTH, operation: "ticket_create", subject: 'He said "hi"' });
  const bodyStr = capturedRequest.body.toString("utf8");
  const parsed = JSON.parse(bodyStr);
  assert(parsed.ticket.subject === 'He said "hi"', "request body: quoted subject is valid JSON");

  // Basic auth format: email/token:api_token
  setMock({ user: { id: 1, name: "A", email: "a@x.com", role: "agent" } });
  await zendeskClient({ subdomain: "myco", email: "agent@example.com", api_token: "tok123", operation: "user_me" });
  const authHeader = capturedRequest.options.headers["Authorization"];
  assert(authHeader.startsWith("Basic "), "Basic auth: Authorization header prefix");
  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  assert(decoded === "agent@example.com/token:tok123", "Basic auth: correct credential format");

  // Path injection prevention: only /api/v2 prefix allowed for generic request
  setMock({ result: {} });
  await zendeskClient({ ...AUTH, operation: "request", method: "GET", path: "/tickets/1.json" });
  assert(capturedRequest.options.path === "/api/v2/tickets/1.json", "generic request: /api/v2 prefix added");

  // Path without leading slash also gets correct prefix
  setMock({ result: {} });
  await zendeskClient({ ...AUTH, operation: "request", method: "GET", path: "tickets/1.json" });
  assert(capturedRequest.options.path === "/api/v2/tickets/1.json", "generic request: path without leading slash");

  restoreHttps();
}

// ─── LEVEL 5: Extreme / Concurrency & stress ─────────────────────────────────

async function testExtreme() {
  process.stderr.write("\n[Level 5] Extreme / Concurrency & stress\n");

  // 50 concurrent user_me calls
  setMock({ user: { id: 1, name: "Alice", email: "a@x.com", role: "agent" } });
  const concurrent = Array.from({ length: 50 }, () =>
    zendeskClient({ ...AUTH, operation: "user_me" })
  );
  const results = await Promise.all(concurrent);
  assert(results.length === 50, "50 concurrent user_me: all resolved");
  assert(results.every(r => r && r.name === "Alice"), "50 concurrent user_me: all correct name");

  // Large ticket list (500 items)
  const bigTickets = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, subject: `Ticket ${i}`, status: "open" }));
  setMock({ tickets: bigTickets, count: 500, next_page: null });
  const bigList = await zendeskClient({ ...AUTH, operation: "ticket_list", limit: 100 });
  assert(bigList.tickets.length === 500, "large response: 500 tickets");

  // 20 rapid sequential calls
  let seqOk = 0;
  for (let i = 0; i < 20; i++) {
    setMock({ user: { id: i, name: `User${i}`, email: `u${i}@x.com`, role: "agent" } });
    const r = await zendeskClient({ ...AUTH, operation: "user_me" });
    if (r && r.name === `User${i}`) seqOk++;
  }
  assert(seqOk === 20, "20 rapid sequential calls all succeed");

  // Mixed operation concurrency: 5 different ops x 8 parallel = 40
  const ops = [
    { operation: "ticket_list" },
    { operation: "user_list" },
    { operation: "org_list" },
    { operation: "group_list" },
    { operation: "tag_list" },
  ];
  const mockBodies = [
    { tickets: [], count: 0, next_page: null },
    { users: [], count: 0, next_page: null },
    { organizations: [], count: 0, next_page: null },
    { groups: [], count: 0, next_page: null },
    { tags: [], count: 0 },
  ];
  const mixedCalls = [];
  for (let i = 0; i < ops.length; i++) {
    for (let j = 0; j < 8; j++) {
      setMock(mockBodies[i]);
      mixedCalls.push(zendeskClient({ ...AUTH, ...ops[i] }));
    }
  }
  const mixedResults = await Promise.allSettled(mixedCalls);
  const fulfilled = mixedResults.filter(r => r.status === "fulfilled").length;
  assert(fulfilled === 40, `mixed concurrent ops: ${fulfilled}/40 succeeded`);

  // timeout option is clamped (1000-120000): very small value should be clamped up
  setMock({ user: { id: 1, name: "Alice", email: "a@x.com", role: "agent" } });
  const tResult = await zendeskClient({ ...AUTH, operation: "user_me", timeout: 0 });
  assert(tResult && tResult.name === "Alice", "timeout clamped: call still succeeds");

  // no state pollution between calls
  setMock({ user: { id: 1, name: "First", email: "f@x.com", role: "agent" } });
  const r1 = await zendeskClient({ ...AUTH, operation: "user_me" });
  setMock({ user: { id: 2, name: "Second", email: "s@x.com", role: "agent" } });
  const r2 = await zendeskClient({ ...AUTH, operation: "user_me" });
  assert(r1.name !== r2.name, "no state pollution between calls");
  assert(r1.name === "First" && r2.name === "Second", "each call gets its own response");

  // Bulk update with many ticket IDs
  const manyIds = Array.from({ length: 100 }, (_, i) => i + 1);
  setMock({ job_status: { id: "job_big", status: "queued", total: 100 } });
  const bigBulk = await zendeskClient({ ...AUTH, operation: "ticket_bulk_update", ticket_ids: manyIds, status: "solved" });
  assert(bigBulk.id === "job_big", "bulk update 100 ids: job_status returned");
  // Verify the query string contains the IDs
  const qs = capturedRequest.options.path;
  assert(qs.includes("ids="), "bulk update: ids in query string");

  restoreHttps();
}

// ─── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  process.stderr.write("=== zendesk_client tests (section 283) ===\n");
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
