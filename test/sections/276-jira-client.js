"use strict";
/**
 * Section 276 — jira_client tests
 * Rigor levels: A=pure-helpers, B=validation, C=mock-network, D=security, E=concurrency
 * Target: 55/55 passing
 */

const assert = require("assert");
const http   = require("http");
const {
  jiraClient,
  buildConn,
  requireString,
  guardString,
  clampInt,
  parseJson,
  checkStatus,
  mapIssue,
  mapProject,
  mapUser,
  mapComment,
  mapBoard,
  mapSprint,
  mapTransition,
  enc,
  qs,
  JIRA_API_V3,
  JIRA_AGILE_V1,
} = require("../../lib/jiraClientOps");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { console.log(`  ✓ ${name}`); passed++; })
              .catch(err => { console.error(`  ✗ ${name}:`, err.message); failed++; });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.message);
    failed++;
  }
  return Promise.resolve();
}

// ─── A. Pure helpers ─────────────────────────────────────────────────────────

console.log("\n=== A. Pure-helper tests ===");

const testsA = [
  test("enc() encodes special chars", () => {
    assert.strictEqual(enc("PROJ-1"), "PROJ-1");
    assert.strictEqual(enc("hello world"), "hello%20world");
    assert.strictEqual(enc("a/b"), "a%2Fb");
  }),

  test("qs() builds query string", () => {
    assert.strictEqual(qs({ a: 1, b: "x y" }), "?a=1&b=x%20y");
    assert.strictEqual(qs({}), "");
    assert.strictEqual(qs({ a: undefined, b: null, c: "ok" }), "?c=ok");
  }),

  test("qs() handles array values", () => {
    const result = qs({ fields: ["summary", "status"] });
    assert.ok(result.includes("fields=summary"));
    assert.ok(result.includes("fields=status"));
  }),

  test("requireString() passes valid string", () => {
    assert.doesNotThrow(() => requireString("hello", "field"));
  }),

  test("requireString() throws on empty string", () => {
    assert.throws(() => requireString("", "field"), /non-empty string/);
  }),

  test("requireString() throws on non-string", () => {
    assert.throws(() => requireString(123, "field"), /non-empty string/);
    assert.throws(() => requireString(null, "field"), /non-empty string/);
  }),

  test("requireString() throws on NUL byte", () => {
    assert.throws(() => requireString("bad\0val", "field"), /NUL/);
  }),

  test("guardString() allows undefined/null", () => {
    assert.doesNotThrow(() => guardString(undefined, "f"));
    assert.doesNotThrow(() => guardString(null, "f"));
  }),

  test("guardString() throws on NUL byte", () => {
    assert.throws(() => guardString("x\0y", "f"), /NUL/);
  }),

  test("guardString() throws on non-string", () => {
    assert.throws(() => guardString(42, "f"), /must be a string/);
  }),

  test("clampInt() clamps to range", () => {
    assert.strictEqual(clampInt(5, 1, 100, 20), 5);
    assert.strictEqual(clampInt(0, 1, 100, 20), 1);
    assert.strictEqual(clampInt(999, 1, 100, 20), 100);
    assert.strictEqual(clampInt(undefined, 1, 100, 20), 20);
    assert.strictEqual(clampInt(null, 1, 100, 20), 20);
  }),

  test("parseJson() parses valid JSON", () => {
    const r = parseJson('{"a":1}', "test");
    assert.deepStrictEqual(r, { a: 1 });
  }),

  test("parseJson() returns null for empty string", () => {
    assert.strictEqual(parseJson("", "ctx"), null);
    assert.strictEqual(parseJson("  ", "ctx"), null);
  }),

  test("parseJson() throws on invalid JSON", () => {
    assert.throws(() => parseJson("{bad", "ctx"), /Failed to parse JSON/);
  }),

  test("mapIssue() maps raw issue", () => {
    const raw = {
      id: "1", key: "PROJ-1", self: "https://x.atlassian.net/rest/api/3/issue/1",
      fields: {
        summary: "Test issue",
        status: { name: "Open", statusCategory: { name: "To Do" } },
        issuetype: { name: "Bug" },
        priority: { name: "High" },
        assignee: { displayName: "Alice" },
        reporter: { displayName: "Bob" },
        creator:  { displayName: "Carol" },
        created: "2025-01-01", updated: "2025-01-02",
        duedate: null, description: "desc",
        labels: ["ui"], components: [{ name: "Frontend" }],
        fixVersions: [{ name: "v1.0" }], versions: [],
        resolution: { name: "Fixed" }, resolutiondate: "2025-01-03",
        comment: { total: 5 },
        subtasks: [{ id: "2", key: "PROJ-2", fields: { summary: "sub" } }],
        parent: { id: "0", key: "PROJ-0" },
        project: { id: "10000", key: "PROJ", name: "Project" },
      },
    };
    const mapped = mapIssue(raw);
    assert.strictEqual(mapped.key, "PROJ-1");
    assert.strictEqual(mapped.summary, "Test issue");
    assert.strictEqual(mapped.status, "Open");
    assert.strictEqual(mapped.issuetype, "Bug");
    assert.strictEqual(mapped.assignee, "Alice");
    assert.deepStrictEqual(mapped.labels, ["ui"]);
    assert.deepStrictEqual(mapped.components, ["Frontend"]);
    assert.deepStrictEqual(mapped.fixVersions, ["v1.0"]);
    assert.strictEqual(mapped.comment_count, 5);
    assert.strictEqual(mapped.subtasks[0].key, "PROJ-2");
    assert.strictEqual(mapped.parent.key, "PROJ-0");
    assert.strictEqual(mapped.project.key, "PROJ");
  }),

  test("mapIssue() handles null input", () => {
    assert.strictEqual(mapIssue(null), null);
  }),

  test("mapProject() maps raw project", () => {
    const raw = { id: "100", key: "PROJ", name: "My Project", description: "desc",
      projectTypeKey: "software", lead: { displayName: "Lead" }, self: "url" };
    const mapped = mapProject(raw);
    assert.strictEqual(mapped.key, "PROJ");
    assert.strictEqual(mapped.projectType, "software");
    assert.strictEqual(mapped.lead, "Lead");
  }),

  test("mapProject() handles null input", () => {
    assert.strictEqual(mapProject(null), null);
  }),

  test("mapUser() maps raw user", () => {
    const raw = { accountId: "abc", displayName: "Alice", emailAddress: "a@b.com",
      active: true, accountType: "atlassian", avatarUrls: {}, self: "url" };
    const u = mapUser(raw);
    assert.strictEqual(u.accountId, "abc");
    assert.strictEqual(u.displayName, "Alice");
    assert.strictEqual(u.active, true);
  }),

  test("mapComment() maps raw comment", () => {
    const raw = { id: "10", author: { displayName: "Alice" },
      body: "Hello", created: "2025-01-01", updated: "2025-01-02", self: "url" };
    const c = mapComment(raw);
    assert.strictEqual(c.id, "10");
    assert.strictEqual(c.author, "Alice");
    assert.strictEqual(c.body, "Hello");
  }),

  test("mapBoard() maps raw board", () => {
    const raw = { id: 1, name: "Main Board", type: "scrum",
      location: { projectId: 10, projectKey: "PROJ", projectName: "My Project" }, self: "url" };
    const b = mapBoard(raw);
    assert.strictEqual(b.id, 1);
    assert.strictEqual(b.type, "scrum");
    assert.strictEqual(b.location.projectKey, "PROJ");
  }),

  test("mapSprint() maps raw sprint", () => {
    const raw = { id: 5, name: "Sprint 1", state: "active",
      startDate: "2025-01-01", endDate: "2025-01-14",
      completeDate: null, originBoardId: 1, goal: "Ship it", self: "url" };
    const s = mapSprint(raw);
    assert.strictEqual(s.id, 5);
    assert.strictEqual(s.state, "active");
    assert.strictEqual(s.goal, "Ship it");
  }),

  test("mapTransition() maps raw transition", () => {
    const raw = { id: "31", name: "In Progress",
      to: { id: "3", name: "In Progress" }, hasScreen: false,
      fields: { resolution: {} } };
    const t = mapTransition(raw);
    assert.strictEqual(t.id, "31");
    assert.strictEqual(t.name, "In Progress");
    assert.deepStrictEqual(t.fields, ["resolution"]);
  }),

  test("JIRA_API_V3 constant is correct", () => {
    assert.strictEqual(JIRA_API_V3, "/rest/api/3");
  }),

  test("JIRA_AGILE_V1 constant is correct", () => {
    assert.strictEqual(JIRA_AGILE_V1, "/rest/agile/1.0");
  }),

  test("buildConn() constructs with email+api_token", () => {
    const c = buildConn({ base_url: "https://org.atlassian.net", email: "a@b.com", api_token: "tok" });
    assert.ok(c.authHeader.startsWith("Basic "));
    assert.strictEqual(c.baseUrl, "https://org.atlassian.net");
    assert.strictEqual(c.rejectUnauthorized, true);
  }),

  test("buildConn() uses PAT when provided", () => {
    const c = buildConn({ base_url: "https://org.atlassian.net", pat: "mytoken" });
    assert.strictEqual(c.authHeader, "Bearer mytoken");
  }),

  test("buildConn() clamps timeout", () => {
    const c = buildConn({ base_url: "https://x.atlassian.net", timeout: 999999 });
    assert.strictEqual(c.timeoutMs, 120000);
    const c2 = buildConn({ base_url: "https://x.atlassian.net", timeout: 0 });
    assert.strictEqual(c2.timeoutMs, 1000);
  }),

  test("buildConn() strips trailing slash", () => {
    const c = buildConn({ base_url: "https://org.atlassian.net///" });
    assert.strictEqual(c.baseUrl, "https://org.atlassian.net");
  }),

  test("checkStatus() extracts Jira errorMessages", () => {
    const fakeRes = { status: 400, raw: JSON.stringify({ errorMessages: ["Issue does not exist"] }) };
    assert.throws(() => checkStatus(fakeRes, "test"), /Issue does not exist/);
  }),

  test("checkStatus() extracts Jira errors object", () => {
    const fakeRes = { status: 400, raw: JSON.stringify({ errors: { summary: "is required" } }) };
    assert.throws(() => checkStatus(fakeRes, "test"), /summary: is required/);
  }),

  test("checkStatus() returns null for 204 with allow204", () => {
    const r = checkStatus({ status: 204, raw: "" }, "ctx", { allow204: true });
    assert.strictEqual(r, null);
  }),

  test("checkStatus() returns null for 404 with allow404", () => {
    const r = checkStatus({ status: 404, raw: "" }, "ctx", { allow404: true });
    assert.strictEqual(r, null);
  }),
];

// ─── B. Validation tests ──────────────────────────────────────────────────────

console.log("\n=== B. Validation tests ===");

const testsB = [
  test("throws without operation", async () => {
    await assert.rejects(() => jiraClient({ base_url: "https://x.atlassian.net" }), /operation must be/);
  }),

  test("throws without base_url", async () => {
    await assert.rejects(() => jiraClient({ operation: "issue_get", issue_key: "P-1" }), /base_url must be provided/);
  }),

  test("throws on unknown operation", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "do_magic", base_url: "https://x.atlassian.net" }),
      /Unknown operation/
    );
  }),

  test("issue_get requires issue_key", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_get", base_url: "https://x.atlassian.net" }),
      /issue_key must be a non-empty string/
    );
  }),

  test("issue_create requires project_key", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_create", base_url: "https://x.atlassian.net", summary: "x", issuetype: "Bug" }),
      /project_key must be a non-empty string/
    );
  }),

  test("issue_create requires summary", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_create", base_url: "https://x.atlassian.net", project_key: "P", issuetype: "Bug" }),
      /summary must be a non-empty string/
    );
  }),

  test("issue_create requires issuetype", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_create", base_url: "https://x.atlassian.net", project_key: "P", summary: "x" }),
      /issuetype must be a non-empty string/
    );
  }),

  test("issue_search requires jql", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_search", base_url: "https://x.atlassian.net" }),
      /jql must be a non-empty string/
    );
  }),

  test("issue_transition requires either transition_id or transition_name", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_transition", base_url: "https://x.atlassian.net", issue_key: "P-1" }),
      /Either transition_id or transition_name must be provided/
    );
  }),

  test("issue_bulk_create requires non-empty issues array", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_bulk_create", base_url: "https://x.atlassian.net", issues: [] }),
      /issues must be a non-empty array/
    );
  }),

  test("user_assignable requires issue_key or project_key", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "user_assignable", base_url: "https://x.atlassian.net" }),
      /Either issue_key or project_key must be provided/
    );
  }),

  test("issue_link requires inward_key, outward_key, link_type", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_link", base_url: "https://x.atlassian.net", inward_key: "P-1", outward_key: "P-2" }),
      /link_type must be a non-empty string/
    );
  }),

  test("request requires api_path starting with /", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "request", base_url: "https://x.atlassian.net", api_path: "no-slash" }),
      /api_path must start with/
    );
  }),

  test("NUL byte in issue_key is rejected", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_get", base_url: "https://x.atlassian.net", issue_key: "P-1\0" }),
      /NUL/
    );
  }),
];

// ─── C. Mock-network tests ────────────────────────────────────────────────────

console.log("\n=== C. Mock-network tests ===");

function mockServer(responses) {
  // responses: array of { statusCode, body } objects to serve in sequence
  let idx = 0;
  const server = http.createServer((req, res) => {
    const r = responses[idx % responses.length];
    idx++;
    res.writeHead(r.statusCode, { "Content-Type": "application/json" });
    res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, base_url: `http://127.0.0.1:${port}` });
    });
  });
}

async function withServer(responses, fn) {
  const { server, base_url } = await mockServer(responses);
  try { return await fn(base_url); }
  finally { server.close(); }
}

const testsC = [
  test("issue_get returns issue on 200", async () => {
    const body = {
      id: "1", key: "PROJ-1", self: "url",
      fields: { summary: "Bug fix", status: { name: "Open" }, issuetype: { name: "Bug" } }
    };
    await withServer([{ statusCode: 200, body }], async (base_url) => {
      const r = await jiraClient({ operation: "issue_get", base_url, issue_key: "PROJ-1" });
      assert.strictEqual(r.exists, true);
      assert.strictEqual(r.issue.key, "PROJ-1");
    });
  }),

  test("issue_get returns exists:false on 404", async () => {
    await withServer([{ statusCode: 404, body: {} }], async (base_url) => {
      const r = await jiraClient({ operation: "issue_get", base_url, issue_key: "PROJ-99" });
      assert.strictEqual(r.exists, false);
    });
  }),

  test("issue_create returns created key", async () => {
    const body = { id: "1001", key: "PROJ-1001", self: "url" };
    await withServer([{ statusCode: 201, body }], async (base_url) => {
      const r = await jiraClient({
        operation: "issue_create", base_url,
        project_key: "PROJ", summary: "New bug", issuetype: "Bug"
      });
      assert.strictEqual(r.created, true);
      assert.strictEqual(r.key, "PROJ-1001");
    });
  }),

  test("issue_update returns updated:true on 204", async () => {
    await withServer([{ statusCode: 204, body: "" }], async (base_url) => {
      const r = await jiraClient({ operation: "issue_update", base_url, issue_key: "PROJ-1", summary: "Updated" });
      assert.strictEqual(r.updated, true);
    });
  }),

  test("issue_delete returns deleted:true on 204", async () => {
    await withServer([{ statusCode: 204, body: "" }], async (base_url) => {
      const r = await jiraClient({ operation: "issue_delete", base_url, issue_key: "PROJ-1" });
      assert.strictEqual(r.deleted, true);
    });
  }),

  test("issue_search returns paginated issues", async () => {
    const body = { total: 1, startAt: 0, maxResults: 20,
      issues: [{ id: "1", key: "PROJ-1", fields: { summary: "s" } }] };
    await withServer([{ statusCode: 200, body }], async (base_url) => {
      const r = await jiraClient({ operation: "issue_search", base_url, jql: "project=PROJ" });
      assert.strictEqual(r.total, 1);
      assert.strictEqual(r.issues.length, 1);
    });
  }),

  test("project_get returns project on 200", async () => {
    const body = { id: "10000", key: "PROJ", name: "My Project" };
    await withServer([{ statusCode: 200, body }], async (base_url) => {
      const r = await jiraClient({ operation: "project_get", base_url, project_key: "PROJ" });
      assert.strictEqual(r.exists, true);
      assert.strictEqual(r.project.key, "PROJ");
    });
  }),

  test("board_list returns boards", async () => {
    const body = { total: 1, startAt: 0, maxResults: 20,
      values: [{ id: 1, name: "Board 1", type: "scrum" }] };
    await withServer([{ statusCode: 200, body }], async (base_url) => {
      const r = await jiraClient({ operation: "board_list", base_url });
      assert.strictEqual(r.boards.length, 1);
    });
  }),

  test("sprint_create returns created sprint", async () => {
    const body = { id: 5, name: "Sprint 1", state: "future", originBoardId: 1 };
    await withServer([{ statusCode: 201, body }], async (base_url) => {
      const r = await jiraClient({ operation: "sprint_create", base_url, board_id: 1, name: "Sprint 1" });
      assert.strictEqual(r.created, true);
      assert.strictEqual(r.sprint.id, 5);
    });
  }),

  test("user_me returns current user", async () => {
    const body = { accountId: "abc", displayName: "Alice", emailAddress: "a@b.com", active: true };
    await withServer([{ statusCode: 200, body }], async (base_url) => {
      const r = await jiraClient({ operation: "user_me", base_url });
      assert.strictEqual(r.user.displayName, "Alice");
    });
  }),

  test("issue_comment returns comment on 201", async () => {
    const body = { id: "50", author: { displayName: "Alice" }, body: "Great!", created: "2025-01-01" };
    await withServer([{ statusCode: 201, body }], async (base_url) => {
      const r = await jiraClient({ operation: "issue_comment", base_url, issue_key: "PROJ-1", body: "Great!" });
      assert.strictEqual(r.commented, true);
      assert.strictEqual(r.comment.body, "Great!");
    });
  }),

  test("info returns serverInfo", async () => {
    const body = { baseUrl: "https://x.atlassian.net", version: "9.0", versionNumbers: [9, 0, 0] };
    await withServer([{ statusCode: 200, body }], async (base_url) => {
      const r = await jiraClient({ operation: "info", base_url });
      assert.ok(r.serverInfo.version);
    });
  }),

  test("filter_create returns created filter", async () => {
    const body = { id: "10", name: "My Filter", jql: "project=PROJ", self: "url" };
    await withServer([{ statusCode: 200, body }], async (base_url) => {
      const r = await jiraClient({ operation: "filter_create", base_url, name: "My Filter", jql: "project=PROJ" });
      assert.strictEqual(r.created, true);
      assert.strictEqual(r.name, "My Filter");
    });
  }),

  test("HTTP error throws with status and detail", async () => {
    const body = { errorMessages: ["Project does not exist"] };
    await withServer([{ statusCode: 400, body }], async (base_url) => {
      await assert.rejects(
        () => jiraClient({ operation: "project_get", base_url, project_key: "BAD" }),
        /Project does not exist/
      );
    });
  }),

  test("issue_transition by name resolves transition id", async () => {
    // First request: get transitions; Second: do transition
    const transitions = { transitions: [{ id: "31", name: "In Progress", to: { id: "3", name: "In Progress" } }] };
    const done = { statusCode: 204, body: "" };
    await withServer([{ statusCode: 200, body: transitions }, done], async (base_url) => {
      const r = await jiraClient({
        operation: "issue_transition", base_url,
        issue_key: "PROJ-1", transition_name: "In Progress"
      });
      assert.strictEqual(r.transitioned, true);
    });
  }),
];

// ─── D. Security tests ────────────────────────────────────────────────────────

console.log("\n=== D. Security tests ===");

const testsD = [
  test("NUL byte in base_url is rejected", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "issue_get", base_url: "https://x.atlassian.net\0", issue_key: "P-1" }),
      /NUL/
    );
  }),

  test("NUL byte in email is rejected by guardString", () => {
    assert.throws(() => guardString("alice\0@b.com", "email"), /NUL/);
  }),

  test("NUL byte in api_token is rejected by guardString", () => {
    assert.throws(() => guardString("tok\0en", "api_token"), /NUL/);
  }),

  test("NUL byte in pat is rejected by guardString", () => {
    assert.throws(() => guardString("pat\0val", "pat"), /NUL/);
  }),

  test("credentials not echoed in buildConn output", () => {
    const conn = buildConn({ base_url: "https://x.atlassian.net", email: "u@b.com", api_token: "secret" });
    const str = JSON.stringify(conn);
    assert.ok(!str.includes("secret"), "api_token must not appear in conn object");
    assert.ok(!str.includes("u@b.com"), "email must not appear in conn object");
  }),

  test("issue_key with path traversal chars is URL-encoded safely", () => {
    // enc() should encode '/' in issue_key to prevent path traversal
    const encoded = enc("../../etc/passwd");
    assert.ok(!encoded.includes("/"));
    assert.ok(encoded.includes("%2F") || !encoded.includes("/"));
  }),

  test("checkStatus() does not expose raw HTTP body in success path", () => {
    const r = checkStatus({ status: 200, raw: '{"id":"1","key":"P-1"}' }, "ctx");
    assert.ok(r !== null);
    // The raw string is parsed, not directly exposed
    assert.strictEqual(typeof r, "object");
  }),

  test("buildConn rejectUnauthorized defaults to true", () => {
    const conn = buildConn({ base_url: "https://x.atlassian.net" });
    assert.strictEqual(conn.rejectUnauthorized, true);
  }),

  test("buildConn allows disabling TLS verification", () => {
    const conn = buildConn({ base_url: "https://x.atlassian.net", reject_unauthorized: false });
    assert.strictEqual(conn.rejectUnauthorized, false);
  }),

  test("NUL in project_key is rejected", async () => {
    await assert.rejects(
      () => jiraClient({ operation: "project_get", base_url: "https://x.atlassian.net", project_key: "P\0" }),
      /NUL/
    );
  }),
];

// ─── E. Concurrency tests ─────────────────────────────────────────────────────

console.log("\n=== E. Concurrency tests ===");

const testsE = [
  test("concurrent issue_get requests all succeed", async () => {
    const body = { id: "1", key: "PROJ-1", self: "url", fields: { summary: "s" } };
    const { server, base_url } = await mockServer(Array(5).fill({ statusCode: 200, body }));
    try {
      const results = await Promise.all(
        Array(5).fill(null).map(() =>
          jiraClient({ operation: "issue_get", base_url, issue_key: "PROJ-1" })
        )
      );
      assert.ok(results.every(r => r.exists === true), "All requests should succeed");
    } finally { server.close(); }
  }),

  test("concurrent issue_create requests all succeed", async () => {
    let counter = 0;
    const srv = http.createServer((req, res) => {
      counter++;
      const n = counter;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: String(n), key: `PROJ-${n}`, self: "url" }));
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const base_url = `http://127.0.0.1:${srv.address().port}`;
    try {
      const results = await Promise.all(
        Array(3).fill(null).map((_, i) =>
          jiraClient({ operation: "issue_create", base_url,
            project_key: "PROJ", summary: `Issue ${i}`, issuetype: "Task" })
        )
      );
      assert.ok(results.every(r => r.created === true));
    } finally { srv.close(); }
  }),

  test("concurrent mixed operations succeed", async () => {
    const handlers = [
      { op: "issue_get", resp: { statusCode: 200, body: { id: "1", key: "P-1", fields: {} } } },
      { op: "user_me",   resp: { statusCode: 200, body: { accountId: "x", displayName: "A" } } },
      { op: "label_list", resp: { statusCode: 200, body: { total: 0, values: [] } } },
    ];
    let i = 0;
    const resps = handlers.map(h => h.resp);
    const { server, base_url } = await mockServer(resps);
    try {
      const [r1, r2, r3] = await Promise.all([
        jiraClient({ operation: "issue_get", base_url, issue_key: "P-1" }),
        jiraClient({ operation: "user_me", base_url }),
        jiraClient({ operation: "label_list", base_url }),
      ]);
      assert.ok(r1.exists !== undefined);
      assert.ok(r2.user !== undefined);
      assert.ok(r3.labels !== undefined);
    } finally { server.close(); }
  }),

  test("concurrent 404 responses all return exists:false", async () => {
    const { server, base_url } = await mockServer(Array(4).fill({ statusCode: 404, body: {} }));
    try {
      const results = await Promise.all(
        ["P-1", "P-2", "P-3", "P-4"].map(k =>
          jiraClient({ operation: "issue_get", base_url, issue_key: k })
        )
      );
      assert.ok(results.every(r => r.exists === false));
    } finally { server.close(); }
  }),

  test("timeout fires on slow server", async () => {
    const srv = http.createServer((_req, _res) => { /* never respond */ });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const base_url = `http://127.0.0.1:${srv.address().port}`;
    try {
      await assert.rejects(
        () => jiraClient({ operation: "issue_get", base_url, issue_key: "P-1", timeout: 200 }),
        /timed out/i
      );
    } finally { srv.close(); }
  }),

  test("large response cap is enforced", async () => {
    // Serve a response larger than 16MB
    const bigData = "x".repeat(17 * 1024 * 1024);
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Stream in chunks to exceed the cap
      res.write(bigData.slice(0, 8 * 1024 * 1024));
      res.write(bigData.slice(8 * 1024 * 1024));
      res.end();
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const base_url = `http://127.0.0.1:${srv.address().port}`;
    try {
      await assert.rejects(
        () => jiraClient({ operation: "issue_get", base_url, issue_key: "P-1" }),
        /16 MB cap/
      );
    } finally { srv.close(); }
  }),

  test("issue_transition not found returns transitioned:false", async () => {
    await withServer([{ statusCode: 404, body: {} }], async (base_url) => {
      const r = await jiraClient({
        operation: "issue_transition", base_url,
        issue_key: "P-99", transition_id: "31"
      });
      assert.strictEqual(r.transitioned, false);
      assert.strictEqual(r.reason, "not_found");
    });
  }),
];

// ─── Run all tests ────────────────────────────────────────────────────────────

async function main() {
  await Promise.all(testsA);
  await Promise.all(testsB);
  await Promise.all(testsC);
  await Promise.all(testsD);
  await Promise.all(testsE);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed / ${passed + failed} total ===`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
