"use strict";
/**
 * Section 274 — gitlab_client tests
 * Five rigor levels:
 *  A  Pure helper / logic tests (no network)
 *  B  Validation / error-path tests
 *  C  Mock-network tests (intercept https)
 *  D  Security / injection tests
 *  E  Concurrency / race-condition tests
 */

const assert = require("assert");
const https  = require("https");
const { EventEmitter } = require("events");

const {
  gitlabClient,
  buildConn,
  requireString,
  guardString,
  clampInt,
  parseGlJson,
  checkGlStatus,
  glRequest,
  mapProject,
  mapIssue,
  mapMr,
  mapCommit,
  mapPipeline,
  mapJob,
  mapUser,
  mapGroup,
  enc,
  encPath,
  projId,
} = require("../../lib/gitlabClientOps");

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { passed++; process.stderr.write(`  \u2713 ${name}\n`); })
              .catch(err => { failed++; errors.push({ name, err }); process.stderr.write(`  \u2717 ${name}: ${err.message}\n`); });
    }
    passed++;
    process.stderr.write(`  \u2713 ${name}\n`);
  } catch (err) {
    failed++;
    errors.push({ name, err });
    process.stderr.write(`  \u2717 ${name}: ${err.message}\n`);
  }
}

// ── Mock helpers ─────────────────────────────────────────────────────────────

const ORIG_HTTPS_REQUEST = https.request;

function mockRequest(statusCode, body, { textPlain = false } = {}) {
  https.request = (_opts, cb) => {
    const contentType = textPlain ? "text/plain" : "application/json";
    const res = Object.assign(new EventEmitter(), {
      statusCode,
      headers: { "content-type": contentType },
    });
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: () => {
        setImmediate(() => {
          cb(res);
          setImmediate(() => {
            res.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
            res.emit("end");
          });
        });
      },
      destroy: () => {},
    });
    return req;
  };
}

function restoreRequest() {
  https.request = ORIG_HTTPS_REQUEST;
}

// ═══════════════════════════════════════════════════════════════════════════
process.stderr.write("\nA — Pure helper / logic tests\n");

test("A01 requireString passes valid string", () => {
  assert.doesNotThrow(() => requireString("octocat", "owner"));
});
test("A02 requireString throws on empty string", () => {
  assert.throws(() => requireString("", "owner"), /must be a non-empty string/);
});
test("A03 requireString throws on NUL byte", () => {
  assert.throws(() => requireString("abc\0def", "owner"), /NUL/);
});
test("A04 guardString passes undefined/null", () => {
  assert.doesNotThrow(() => guardString(undefined, "x"));
  assert.doesNotThrow(() => guardString(null, "x"));
});
test("A05 guardString throws on NUL byte", () => {
  assert.throws(() => guardString("tok\0en", "token"), /NUL/);
});
test("A06 clampInt returns default when undefined", () => {
  assert.strictEqual(clampInt(undefined, 20000, 1000, 120000), 20000);
});
test("A07 clampInt clamps to min", () => {
  assert.strictEqual(clampInt(0, 20000, 1000, 120000), 1000);
});
test("A08 clampInt clamps to max", () => {
  assert.strictEqual(clampInt(999999, 20000, 1000, 120000), 120000);
});
test("A09 buildConn defaults", () => {
  const conn = buildConn({});
  assert.strictEqual(conn.timeoutMs, 20000);
  assert.strictEqual(conn.baseUrl, "https://gitlab.com/api/v4");
  assert.strictEqual(conn.token, null);
  assert.strictEqual(conn.rejectUnauthorized, true);
});
test("A10 buildConn strips trailing slash", () => {
  const conn = buildConn({ base_url: "https://gitlab.example.com/api/v4/" });
  assert.strictEqual(conn.baseUrl, "https://gitlab.example.com/api/v4");
});
test("A11 buildConn stores token", () => {
  const conn = buildConn({ token: "glpat-xxx" });
  assert.strictEqual(conn.token, "glpat-xxx");
});
test("A12 buildConn throws if token has NUL", () => {
  assert.throws(() => buildConn({ token: "glpat-\0bad" }), /NUL/);
});
test("A13 parseGlJson null for empty", () => {
  assert.strictEqual(parseGlJson("", "ctx"), null);
  assert.strictEqual(parseGlJson("  ", "ctx"), null);
});
test("A14 parseGlJson parses valid JSON", () => {
  assert.deepStrictEqual(parseGlJson('{"id":1}', "ctx"), { id: 1 });
});
test("A15 parseGlJson throws on invalid JSON", () => {
  assert.throws(() => parseGlJson("not-json", "ctx"), /invalid JSON/);
});
test("A16 checkGlStatus throws on 4xx", () => {
  assert.throws(
    () => checkGlStatus({ statusCode: 404, raw: '{"message":"Not Found"}' }, "project_get"),
    /HTTP 404/,
  );
});
test("A17 checkGlStatus throws on 5xx", () => {
  assert.throws(
    () => checkGlStatus({ statusCode: 500, raw: "error" }, "project_get"),
    /HTTP 500/,
  );
});
test("A18 checkGlStatus does not throw on 200/201/204", () => {
  [200, 201, 204].forEach(s =>
    assert.doesNotThrow(() => checkGlStatus({ statusCode: s, raw: "" }, "op"))
  );
});
test("A19 mapProject handles minimal input", () => {
  const r = mapProject({ id: 1, name: "p" });
  assert.strictEqual(r.id, 1);
  assert.strictEqual(r.name, "p");
  assert.deepStrictEqual(r.topics, []);
  assert.strictEqual(r.description, null);
});
test("A20 mapProject full", () => {
  const r = mapProject({
    id: 5, name: "proj", name_with_namespace: "ns/proj",
    path: "proj", path_with_namespace: "ns/proj",
    description: "desc", visibility: "private",
    namespace: { full_path: "ns" }, default_branch: "main",
    ssh_url_to_repo: "git@gl:ns/proj.git",
    http_url_to_repo: "https://gl/ns/proj.git",
    web_url: "https://gl/ns/proj",
    forks_count: 2, star_count: 10, open_issues_count: 5,
    archived: false, topics: ["node"],
    created_at: "2024-01-01", last_activity_at: "2024-06-01",
  });
  assert.strictEqual(r.namespace, "ns");
  assert.strictEqual(r.star_count, 10);
  assert.deepStrictEqual(r.topics, ["node"]);
});
test("A21 mapIssue", () => {
  const r = mapIssue({
    id: 1, iid: 1, title: "Bug", state: "opened",
    author: { username: "alice" }, assignees: [{ username: "bob" }],
    labels: ["bug"], created_at: "2024-01-01", updated_at: "2024-01-02",
  });
  assert.strictEqual(r.author, "alice");
  assert.deepStrictEqual(r.assignees, ["bob"]);
  assert.deepStrictEqual(r.labels, ["bug"]);
});
test("A22 mapMr", () => {
  const r = mapMr({
    id: 1, iid: 1, title: "MR", state: "opened",
    author: { username: "dev" }, assignees: [], reviewers: [], labels: [],
    source_branch: "feat", target_branch: "main",
    created_at: "2024-01-01", updated_at: "2024-01-01",
  });
  assert.strictEqual(r.source_branch, "feat");
  assert.strictEqual(r.draft, false);
});
test("A23 mapCommit", () => {
  const r = mapCommit({
    id: "abc", short_id: "abc123", title: "init",
    message: "initial commit", author_name: "Alice",
    author_email: "a@example.com", authored_date: "2024-01-01",
    parent_ids: ["def"],
  });
  assert.strictEqual(r.author_name, "Alice");
  assert.deepStrictEqual(r.parent_ids, ["def"]);
});
test("A24 mapPipeline", () => {
  const r = mapPipeline({ id: 5, status: "success", ref: "main" });
  assert.strictEqual(r.id, 5);
  assert.strictEqual(r.status, "success");
  assert.strictEqual(r.ref, "main");
});
test("A25 mapJob", () => {
  const r = mapJob({ id: 9, name: "test", status: "success", stage: "test",
    ref: "main", tag: false, allow_failure: false });
  assert.strictEqual(r.status, "success");
  assert.strictEqual(r.allow_failure, false);
});
test("A26 mapUser", () => {
  const r = mapUser({ id: 42, username: "alice", name: "Alice", state: "active" });
  assert.strictEqual(r.username, "alice");
  assert.strictEqual(r.email, null);
});
test("A27 mapGroup", () => {
  const r = mapGroup({ id: 7, name: "grp", path: "grp" });
  assert.strictEqual(r.id, 7);
  assert.strictEqual(r.description, null);
});
test("A28 enc encodes special chars", () => {
  assert.strictEqual(enc("hello world"), "hello%20world");
  assert.strictEqual(enc("a/b"), "a%2Fb");
});
test("A29 encPath preserves slashes, encodes segments", () => {
  assert.strictEqual(encPath("folder/sub folder/f.js"), "folder/sub%20folder/f.js");
});
test("A30 projId uses project_id", () => {
  const pid = projId({ project_id: 123 });
  assert.strictEqual(pid, "123");
});
test("A31 projId uses project namespace/name", () => {
  const pid = projId({ project: "mygroup/myrepo" });
  assert.strictEqual(pid, encodeURIComponent("mygroup/myrepo"));
});
test("A32 projId throws when both missing", () => {
  assert.throws(() => projId({}), /project_id.*or.*project/);
});

// ═══════════════════════════════════════════════════════════════════════════
process.stderr.write("\nB — Validation / error-path tests\n");

test("B01 unknown operation throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "nonexistent_op" }),
    /Unknown gitlab_client operation/,
  );
});
test("B02 project_get: missing project throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "project_get" }),
    /project_id.*or.*project/,
  );
});
test("B03 issue_create: missing title throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "issue_create", project_id: 1 }),
    /title must be a non-empty string/,
  );
});
test("B04 issue_get: missing issue_iid throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "issue_get", project_id: 1 }),
    /issue_iid/,
  );
});
test("B05 mr_create: missing source_branch throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "mr_create", project_id: 1, target_branch: "main", title: "T" }),
    /source_branch must be a non-empty string/,
  );
});
test("B06 mr_create: missing target_branch throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "mr_create", project_id: 1, source_branch: "feat", title: "T" }),
    /target_branch must be a non-empty string/,
  );
});
test("B07 mr_merge: missing mr_iid throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "mr_merge", project_id: 1 }),
    /mr_iid/,
  );
});
test("B08 file_get: missing file_path throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "file_get", project_id: 1 }),
    /file_path must be a non-empty string/,
  );
});
test("B09 file_create: missing branch throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "file_create", project_id: 1, file_path: "a.js", content: "x", commit_message: "m" }),
    /branch must be a non-empty string/,
  );
});
test("B10 branch_create: missing ref throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "branch_create", project_id: 1, branch: "new" }),
    /ref must be a non-empty string/,
  );
});
test("B11 commit_get: missing sha throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "commit_get", project_id: 1 }),
    /sha must be a non-empty string/,
  );
});
test("B12 tag_create: missing ref throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "tag_create", project_id: 1, tag_name: "v1" }),
    /ref must be a non-empty string/,
  );
});
test("B13 pipeline_get: missing pipeline_id throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "pipeline_get", project_id: 1 }),
    /pipeline_id/,
  );
});
test("B14 job_get: missing job_id throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "job_get", project_id: 1 }),
    /job_id/,
  );
});
test("B15 user_get: missing user_id and username throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "user_get" }),
    /user_id or username/,
  );
});
test("B16 group_get: missing group_id and group_path throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "group_get" }),
    /group_id or group_path/,
  );
});
test("B17 label_create: missing name throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "label_create", project_id: 1, color: "#f00" }),
    /name must be a non-empty string/,
  );
});
test("B18 label_create: missing color throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "label_create", project_id: 1, name: "bug" }),
    /color must be a non-empty string/,
  );
});
test("B19 snippet_get: missing snippet_id throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "snippet_get" }),
    /snippet_id/,
  );
});
test("B20 request op: missing path throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "request", method: "GET" }),
    /path must be a non-empty string/,
  );
});
test("B21 request op: invalid method throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "request", path: "/projects", method: "TRACE" }),
    /method must be one of/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
process.stderr.write("\nC — Mock-network tests\n");

test("C01 info returns ok:true with all major ops", async () => {
  const r = await gitlabClient({ operation: "info" });
  assert.strictEqual(r.ok, true);
  assert.ok(r.protocol.includes("GitLab REST API v4"));
  const ops = r.operations.map(o => o.op);
  for (const op of ["project_get", "issue_list", "mr_create", "pipeline_list", "job_log", "user_me", "group_list", "snippet_create", "request", "info"]) {
    assert.ok(ops.includes(op), `Missing op: ${op}`);
  }
});

test("C02 project_get 200 -> mapped project", async () => {
  mockRequest(200, {
    id: 123, name: "proj", path: "proj",
    namespace: { full_path: "ns" }, description: "desc",
    visibility: "private", default_branch: "main",
    forks_count: 2, star_count: 5, open_issues_count: 1,
    archived: false, topics: ["node"],
    created_at: "2024-01-01T00:00:00Z", last_activity_at: "2024-06-01T00:00:00Z",
  });
  try {
    const r = await gitlabClient({ operation: "project_get", project_id: 123 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.id, 123);
    assert.strictEqual(r.namespace, "ns");
    assert.deepStrictEqual(r.topics, ["node"]);
  } finally { restoreRequest(); }
});

test("C03 project_get 404 -> exists:false", async () => {
  mockRequest(404, { message: "404 Project Not Found" });
  try {
    const r = await gitlabClient({ operation: "project_get", project_id: 9999 });
    assert.strictEqual(r.exists, false);
  } finally { restoreRequest(); }
});

test("C04 project_list returns array", async () => {
  mockRequest(200, [
    { id: 1, name: "p1", namespace: { full_path: "ns" } },
    { id: 2, name: "p2", namespace: { full_path: "ns" } },
  ]);
  try {
    const r = await gitlabClient({ operation: "project_list" });
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.projects[0].id, 1);
  } finally { restoreRequest(); }
});

test("C05 issue_list returns mapped issues", async () => {
  mockRequest(200, [
    { id: 10, iid: 1, title: "Bug", state: "opened",
      author: { username: "alice" }, assignees: [], labels: [],
      created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
  ]);
  try {
    const r = await gitlabClient({ operation: "issue_list", project_id: 1 });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.issues[0].title, "Bug");
    assert.strictEqual(r.issues[0].author, "alice");
  } finally { restoreRequest(); }
});

test("C06 mr_list returns mapped MRs", async () => {
  mockRequest(200, [
    { id: 100, iid: 5, title: "Feature", state: "opened",
      author: { username: "bob" }, assignees: [], reviewers: [], labels: [],
      source_branch: "feat", target_branch: "main",
      created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
  ]);
  try {
    const r = await gitlabClient({ operation: "mr_list", project_id: 1 });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.merge_requests[0].iid, 5);
  } finally { restoreRequest(); }
});

test("C07 mr_merge 405 -> not_mergeable", async () => {
  mockRequest(405, { message: "Not Allowed" });
  try {
    const r = await gitlabClient({ operation: "mr_merge", project_id: 1, mr_iid: 5 });
    assert.strictEqual(r.merged, false);
    assert.strictEqual(r.reason, "not_mergeable");
  } finally { restoreRequest(); }
});

test("C08 mr_merge 406 -> already_merged_or_closed", async () => {
  mockRequest(406, { message: "Already merged" });
  try {
    const r = await gitlabClient({ operation: "mr_merge", project_id: 1, mr_iid: 5 });
    assert.strictEqual(r.merged, false);
    assert.strictEqual(r.reason, "already_merged_or_closed");
  } finally { restoreRequest(); }
});

test("C09 branch_protect 409 -> already_protected", async () => {
  mockRequest(409, { message: "Protected branch already exists" });
  try {
    const r = await gitlabClient({ operation: "branch_protect", project_id: 1, branch: "main" });
    assert.strictEqual(r.protected, false);
    assert.strictEqual(r.reason, "already_protected");
  } finally { restoreRequest(); }
});

test("C10 pipeline_list returns mapped pipelines", async () => {
  mockRequest(200, [
    { id: 200, iid: 1, status: "success", ref: "main",
      created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z" },
  ]);
  try {
    const r = await gitlabClient({ operation: "pipeline_list", project_id: 1 });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.pipelines[0].status, "success");
  } finally { restoreRequest(); }
});

test("C11 pipeline_cancel 403 -> cancelled:false", async () => {
  mockRequest(403, { message: "403 Forbidden" });
  try {
    const r = await gitlabClient({ operation: "pipeline_cancel", project_id: 1, pipeline_id: 200 });
    assert.strictEqual(r.cancelled, false);
    assert.strictEqual(r.reason, "forbidden");
  } finally { restoreRequest(); }
});

test("C12 user_me returns mapped user", async () => {
  mockRequest(200, { id: 42, username: "alice", name: "Alice", state: "active",
    email: "a@example.com", web_url: "https://gitlab.com/alice",
    created_at: "2020-01-01T00:00:00Z" });
  try {
    const r = await gitlabClient({ operation: "user_me", token: "secret" });
    assert.strictEqual(r.id, 42);
    assert.strictEqual(r.username, "alice");
  } finally { restoreRequest(); }
});

test("C13 job_log: truncates at 100 KB", async () => {
  const bigLog = "x".repeat(150000);
  mockRequest(200, bigLog, { textPlain: true });
  try {
    const r = await gitlabClient({ operation: "job_log", project_id: 1, job_id: 1 });
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.log.length, 100000);
    assert.strictEqual(r.size, 150000);
  } finally { restoreRequest(); }
});

test("C14 HTTP 500 throws with status code", async () => {
  mockRequest(500, { message: "Internal Server Error" });
  try {
    await assert.rejects(
      () => gitlabClient({ operation: "project_list" }),
      /HTTP 500/,
    );
  } finally { restoreRequest(); }
});

test("C15 invalid JSON response throws descriptive error", async () => {
  mockRequest(200, "<html>not json</html>");
  try {
    await assert.rejects(
      () => gitlabClient({ operation: "project_list" }),
      /invalid JSON response/,
    );
  } finally { restoreRequest(); }
});

test("C16 request op passes through status and body", async () => {
  mockRequest(200, { id: 1, name: "hook" });
  try {
    const r = await gitlabClient({ operation: "request", path: "/projects/1/hooks", method: "GET" });
    assert.strictEqual(r.status_code, 200);
    assert.strictEqual(r.body.id, 1);
  } finally { restoreRequest(); }
});

test("C17 group_list returns mapped groups", async () => {
  mockRequest(200, [
    { id: 1, name: "grp", path: "grp", full_path: "grp" },
  ]);
  try {
    const r = await gitlabClient({ operation: "group_list" });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.groups[0].id, 1);
  } finally { restoreRequest(); }
});

test("C18 tag_list returns mapped tags", async () => {
  mockRequest(200, [
    { name: "v1.0.0", message: "First release",
      commit: { id: "abc", title: "Release v1" }, protected: false },
  ]);
  try {
    const r = await gitlabClient({ operation: "tag_list", project_id: 1 });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.tags[0].name, "v1.0.0");
  } finally { restoreRequest(); }
});

// ═══════════════════════════════════════════════════════════════════════════
process.stderr.write("\nD — Security / injection tests\n");

test("D01 NUL byte in token throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "project_get", project_id: 1, token: "abc\0xyz" }),
    /NUL/,
  );
});
test("D02 NUL byte in base_url throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "project_get", project_id: 1, base_url: "https://gl.com\0hack" }),
    /NUL/,
  );
});
test("D03 NUL byte in issue title throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "issue_create", project_id: 1, title: "good\0bad" }),
    /NUL/,
  );
});
test("D04 NUL byte in branch name throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "branch_get", project_id: 1, branch: "main\0evil" }),
    /NUL/,
  );
});
test("D05 NUL byte in username throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "user_get", username: "alice\0evil" }),
    /NUL/,
  );
});
test("D06 NUL byte in mr comment body throws", async () => {
  await assert.rejects(
    () => gitlabClient({ operation: "mr_add_note", project_id: 1, mr_iid: 1, body: "ok\0bad" }),
    /NUL/,
  );
});
test("D07 token not leaked in HTTP 401 error", async () => {
  const secretToken = "glpat-AnotherSecretToken";
  mockRequest(401, { message: "401 Unauthorized" });
  try {
    let msg = "";
    try {
      await gitlabClient({ operation: "project_get", project_id: 1, token: secretToken });
    } catch (err) { msg = err.message; }
    assert.ok(!msg.includes(secretToken), `Token leaked: ${msg}`);
  } finally { restoreRequest(); }
});
test("D08 token not leaked in network error", async () => {
  const secretToken = "glpat-SuperSecretToken12345";
  https.request = (_opts, _cb) => {
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: function() {
        setImmediate(() => this.emit("error", new Error("ECONNREFUSED")));
      },
      destroy: () => {},
    });
    return req;
  };
  try {
    let msg = "";
    try {
      await gitlabClient({ operation: "project_get", project_id: 1, token: secretToken });
    } catch (err) { msg = err.message; }
    assert.ok(!msg.includes(secretToken), `Token leaked in network error: ${msg}`);
  } finally { restoreRequest(); }
});
test("D09 response size cap triggers error (17 MB)", async () => {
  https.request = (_opts, cb) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: () => {
        cb(res);
        const chunk = Buffer.alloc(1024 * 1024, 0x41);
        setImmediate(() => { for (let i = 0; i < 17; i++) res.emit("data", chunk); });
      },
      destroy: () => {},
    });
    return req;
  };
  try {
    await assert.rejects(
      () => gitlabClient({ operation: "project_list" }),
      /16 MB cap/,
    );
  } finally { restoreRequest(); }
});
test("D10 response stream error is propagated", async () => {
  https.request = (_opts, cb) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: () => {
        cb(res);
        setImmediate(() => res.emit("error", new Error("stream broke")));
      },
      destroy: () => {},
    });
    return req;
  };
  try {
    await assert.rejects(
      () => gitlabClient({ operation: "project_list" }),
      /stream error/,
    );
  } finally { restoreRequest(); }
});

// ═══════════════════════════════════════════════════════════════════════════
process.stderr.write("\nE — Concurrency / race-condition tests\n");

test("E01 20 concurrent info() calls all succeed", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => gitlabClient({ operation: "info" }))
  );
  for (const r of results) {
    assert.strictEqual(r.ok, true);
  }
});

test("E02 concurrent project_get (mocked) all return exists:true", async () => {
  let callCount = 0;
  https.request = (_opts, cb) => {
    const idx = ++callCount;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { "content-type": "application/json" },
    });
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: () => {
        setTimeout(() => {
          cb(res);
          setTimeout(() => {
            res.emit("data", Buffer.from(JSON.stringify({ id: idx, name: `p${idx}`, namespace: { full_path: "ns" } })));
            res.emit("end");
          }, Math.random() * 10);
        }, Math.random() * 10);
      },
      destroy: () => {},
    });
    return req;
  };
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        gitlabClient({ operation: "project_get", project_id: i + 1 })
      )
    );
    for (const r of results) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.exists, true);
    }
  } finally { restoreRequest(); }
});

test("E03 timeout is respected", async () => {
  https.request = (_opts, _cb) => {
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: () => { /* never responds */ },
      destroy: function() { this.emit("error", new Error("socket hang up")); },
    });
    return req;
  };
  try {
    await assert.rejects(
      () => gitlabClient({ operation: "project_get", project_id: 1, timeout: 50 }),
      /timed out/i,
    );
  } finally { restoreRequest(); }
});

test("E04 concurrent validation errors handled independently", async () => {
  const results = await Promise.allSettled([
    gitlabClient({ operation: "issue_create", project_id: 1 }),  // missing title
    gitlabClient({ operation: "mr_merge", project_id: 1 }),       // missing mr_iid
    gitlabClient({ operation: "info" }),                           // ok
    gitlabClient({ operation: "unknown_op" }),                     // unknown
    gitlabClient({ operation: "info" }),                           // ok
  ]);
  assert.strictEqual(results[0].status, "rejected");
  assert.strictEqual(results[1].status, "rejected");
  assert.strictEqual(results[2].status, "fulfilled");
  assert.strictEqual(results[3].status, "rejected");
  assert.strictEqual(results[4].status, "fulfilled");
});

test("E05 network error triggers descriptive error", async () => {
  https.request = (_opts, _cb) => {
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: function() {
        setImmediate(() => this.emit("error", new Error("ECONNREFUSED")));
      },
      destroy: () => {},
    });
    return req;
  };
  try {
    await assert.rejects(
      () => gitlabClient({ operation: "project_list" }),
      /Cannot connect to GitLab API.*ECONNREFUSED/,
    );
  } finally { restoreRequest(); }
});

// ── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  if (failed > 0) {
    process.stderr.write(`\n\u2717 ${failed} test(s) FAILED:\n`);
    for (const { name, err } of errors) {
      process.stderr.write(`  - ${name}: ${err.message}\n`);
    }
  }
  process.stderr.write(`\n\u2713 ${passed} passed, \u2717 ${failed} failed out of ${passed + failed} tests\n\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 5000);
