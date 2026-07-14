"use strict";
/**
 * Section 273 — github_client tests
 * Five rigor levels:
 *  A  Pure helper / pure-logic tests (no network)
 *  B  Validation / error-path tests
 *  C  Mock-network tests (intercept https via monkey-patching)
 *  D  Security / injection tests
 *  E  Concurrency / race-condition tests
 */

const assert = require("assert");
const https  = require("https");
const { EventEmitter } = require("events");

const {
  githubClient,
  buildConn,
  requireString,
  guardString,
  clampInt,
  parseGhJson,
  checkGhStatus,
  ghRequest,
  ghApiRequest,
  mapRepo,
  mapIssue,
  mapPr,
  mapCommit,
  mapRelease,
  mapWorkflowRun,
  mapUser,
  enc,
  encPath,
} = require("../../lib/githubClientOps");

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

// ─────────────────────────────────────────────────────────────────────────────
// A — Pure helper / logic tests
// ─────────────────────────────────────────────────────────────────────────────

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

test("A04 requireString throws on non-string", () => {
  assert.throws(() => requireString(123, "owner"), /must be a non-empty string/);
});

test("A05 guardString passes undefined", () => {
  assert.doesNotThrow(() => guardString(undefined, "token"));
});

test("A06 guardString passes null", () => {
  assert.doesNotThrow(() => guardString(null, "token"));
});

test("A07 guardString passes valid string", () => {
  assert.doesNotThrow(() => guardString("ghp_abc123", "token"));
});

test("A08 guardString throws on NUL byte", () => {
  assert.throws(() => guardString("tok\0en", "token"), /NUL/);
});

test("A09 guardString throws on non-string type", () => {
  assert.throws(() => guardString(42, "token"), /must be a string/);
});

test("A10 clampInt returns default when undefined", () => {
  assert.strictEqual(clampInt(undefined, 20000, 1000, 120000), 20000);
});

test("A11 clampInt clamps to min", () => {
  assert.strictEqual(clampInt(0, 20000, 1000, 120000), 1000);
});

test("A12 clampInt clamps to max", () => {
  assert.strictEqual(clampInt(999999, 20000, 1000, 120000), 120000);
});

test("A13 clampInt rounds correctly", () => {
  assert.strictEqual(clampInt(5000.7, 20000, 1000, 120000), 5001);
});

test("A14 clampInt throws on NaN", () => {
  assert.throws(() => clampInt("notanumber", 20000, 1000, 120000), /finite/);
});

test("A15 buildConn defaults timeout to 20000", () => {
  const conn = buildConn({});
  assert.strictEqual(conn.timeoutMs, 20000);
});

test("A16 buildConn sets base URL to api.github.com", () => {
  const conn = buildConn({});
  assert.strictEqual(conn.baseUrl, "https://api.github.com");
});

test("A17 buildConn strips trailing slash from base_url", () => {
  const conn = buildConn({ base_url: "https://github.example.com/api/v3/" });
  assert.strictEqual(conn.baseUrl, "https://github.example.com/api/v3");
});

test("A18 buildConn stores token", () => {
  const conn = buildConn({ token: "ghp_testtoken" });
  assert.strictEqual(conn.token, "ghp_testtoken");
});

test("A19 buildConn allows no token (unauthenticated)", () => {
  const conn = buildConn({});
  assert.strictEqual(conn.token, null);
});

test("A20 buildConn throws if token has NUL", () => {
  assert.throws(() => buildConn({ token: "ghp_\0bad" }), /NUL/);
});

test("A21 parseGhJson returns null for empty string", () => {
  assert.strictEqual(parseGhJson("", "ctx"), null);
});

test("A22 parseGhJson returns null for whitespace", () => {
  assert.strictEqual(parseGhJson("   ", "ctx"), null);
});

test("A23 parseGhJson parses valid JSON", () => {
  const result = parseGhJson('{"id":1,"name":"test"}', "ctx");
  assert.deepStrictEqual(result, { id: 1, name: "test" });
});

test("A24 parseGhJson throws on invalid JSON", () => {
  assert.throws(() => parseGhJson("not-json", "ctx"), /invalid JSON/);
});

test("A25 checkGhStatus throws on 4xx", () => {
  assert.throws(
    () => checkGhStatus({ statusCode: 404, raw: '{"message":"Not Found"}' }, "repo_get"),
    /HTTP 404/,
  );
});

test("A26 checkGhStatus throws on 5xx", () => {
  assert.throws(
    () => checkGhStatus({ statusCode: 500, raw: "Internal Server Error" }, "repo_get"),
    /HTTP 500/,
  );
});

test("A27 checkGhStatus does not throw on 200", () => {
  assert.doesNotThrow(() => checkGhStatus({ statusCode: 200, raw: "" }, "repo_get"));
});

test("A28 checkGhStatus does not throw on 201", () => {
  assert.doesNotThrow(() => checkGhStatus({ statusCode: 201, raw: "" }, "repo_get"));
});

test("A29 checkGhStatus does not throw on 204", () => {
  assert.doesNotThrow(() => checkGhStatus({ statusCode: 204, raw: "" }, "repo_get"));
});

test("A30 checkGhStatus extracts message from JSON body", () => {
  let msg = "";
  try {
    checkGhStatus({ statusCode: 422, raw: '{"message":"Validation Failed"}' }, "issue_create");
  } catch (e) { msg = e.message; }
  assert.ok(msg.includes("Validation Failed"), `Expected 'Validation Failed' in: ${msg}`);
});

test("A31 mapRepo maps all expected fields", () => {
  const raw = {
    id: 1, name: "repo", full_name: "user/repo", owner: { login: "user" },
    private: false, description: "desc", fork: false, html_url: "https://g/r",
    clone_url: "https://g/r.git", ssh_url: "git@g:r.git", default_branch: "main",
    stargazers_count: 5, forks_count: 2, open_issues_count: 1, language: "JavaScript",
    topics: ["node"], archived: false, disabled: false, visibility: "public",
    created_at: "2024-01-01", updated_at: "2024-06-01", pushed_at: "2024-06-01", size: 100,
  };
  const m = mapRepo(raw);
  assert.strictEqual(m.id, 1);
  assert.strictEqual(m.full_name, "user/repo");
  assert.strictEqual(m.owner, "user");
  assert.strictEqual(m.stars, 5);
  assert.strictEqual(m.language, "JavaScript");
  assert.deepStrictEqual(m.topics, ["node"]);
});

test("A32 mapRepo handles null input", () => {
  const m = mapRepo(null);
  assert.deepStrictEqual(m, {});
});

test("A33 mapRepo handles missing optional fields", () => {
  const m = mapRepo({ id: 2, name: "x" });
  assert.strictEqual(m.id, 2);
  assert.strictEqual(m.description, null);
  assert.strictEqual(m.stars, 0);
  assert.deepStrictEqual(m.topics, []);
});

test("A34 mapIssue maps all expected fields", () => {
  const raw = {
    id: 10, number: 42, title: "Bug", body: "desc", state: "open",
    user: { login: "alice" }, labels: [{ name: "bug" }],
    assignees: [{ login: "bob" }], comments: 3,
    pull_request: undefined, milestone: { title: "v1" },
    html_url: "https://g/r/issues/42",
    created_at: "2024-01-01", updated_at: "2024-01-02", closed_at: null,
  };
  const m = mapIssue(raw);
  assert.strictEqual(m.number, 42);
  assert.strictEqual(m.title, "Bug");
  assert.deepStrictEqual(m.labels, ["bug"]);
  assert.deepStrictEqual(m.assignees, ["bob"]);
  assert.strictEqual(m.milestone, "v1");
  assert.strictEqual(m.is_pr, false);
});

test("A35 mapIssue detects pull_request flag", () => {
  const m = mapIssue({ pull_request: { url: "..." }, number: 1 });
  assert.strictEqual(m.is_pr, true);
});

test("A36 mapPr maps all expected fields", () => {
  const raw = {
    id: 99, number: 5, title: "Add feature", body: "body", state: "open",
    draft: false, merged: false, mergeable: true,
    user: { login: "dev" },
    head: { label: "dev:feature", sha: "abc123" },
    base: { label: "main:main" },
    labels: [{ name: "enhancement" }],
    assignees: [], requested_reviewers: [{ login: "reviewer" }],
    commits: 2, additions: 10, deletions: 3, changed_files: 2,
    html_url: "https://g/r/pull/5",
    created_at: "2024-01-01", updated_at: "2024-01-02",
    merged_at: null, closed_at: null, merge_commit_sha: null,
  };
  const m = mapPr(raw);
  assert.strictEqual(m.number, 5);
  assert.strictEqual(m.head, "dev:feature");
  assert.strictEqual(m.head_sha, "abc123");
  assert.deepStrictEqual(m.reviewers, ["reviewer"]);
  assert.strictEqual(m.commits, 2);
});

test("A37 mapCommit maps all expected fields", () => {
  const raw = {
    sha: "abc123",
    commit: { message: "init", author: { name: "Alice", date: "2024-01-01" }, committer: { name: "Alice", date: "2024-01-01" } },
    author: { login: "alice" },
    html_url: "https://g/r/commit/abc",
    parents: [{ sha: "parent1" }],
  };
  const m = mapCommit(raw);
  assert.strictEqual(m.sha, "abc123");
  assert.strictEqual(m.message, "init");
  assert.strictEqual(m.author, "Alice");
  assert.deepStrictEqual(m.parents, ["parent1"]);
});

test("A38 mapRelease maps all expected fields", () => {
  const raw = {
    id: 1, tag_name: "v1.0.0", name: "Release 1.0", body: "Changelog",
    draft: false, prerelease: false, author: { login: "maintainer" },
    html_url: "https://g/r/releases/tag/v1",
    tarball_url: "https://g/r/tar", zipball_url: "https://g/r/zip",
    assets: [{ id: 1, name: "bin.tar.gz", size: 1024, browser_download_url: "https://dl" }],
    created_at: "2024-01-01", published_at: "2024-01-02",
    target_commitish: "main",
  };
  const m = mapRelease(raw);
  assert.strictEqual(m.tag_name, "v1.0.0");
  assert.strictEqual(m.author, "maintainer");
  assert.strictEqual(m.assets.length, 1);
  assert.strictEqual(m.assets[0].name, "bin.tar.gz");
});

test("A39 mapWorkflowRun maps all expected fields", () => {
  const raw = {
    id: 9, name: "CI", workflow_id: 1, head_branch: "main", head_sha: "abc",
    status: "completed", conclusion: "success", event: "push",
    run_number: 7, run_attempt: 1, actor: { login: "alice" },
    html_url: "https://g/r/actions/runs/9",
    created_at: "2024-01-01", updated_at: "2024-01-02",
  };
  const m = mapWorkflowRun(raw);
  assert.strictEqual(m.id, 9);
  assert.strictEqual(m.conclusion, "success");
  assert.strictEqual(m.actor, "alice");
});

test("A40 mapUser maps all expected fields", () => {
  const raw = {
    id: 1, login: "octocat", name: "The Octocat", email: "octo@example.com",
    bio: "Dev", company: "GitHub", location: "SF", blog: "https://blog",
    twitter_username: "octo", type: "User",
    public_repos: 5, followers: 100, following: 10,
    html_url: "https://github.com/octocat", avatar_url: "https://avatar",
    created_at: "2020-01-01", updated_at: "2024-01-01",
  };
  const m = mapUser(raw);
  assert.strictEqual(m.login, "octocat");
  assert.strictEqual(m.name, "The Octocat");
  assert.strictEqual(m.twitter, "octo");
  assert.strictEqual(m.followers, 100);
});

test("A41 enc encodes special characters", () => {
  assert.strictEqual(enc("hello world"), "hello%20world");
});

test("A42 enc encodes slash", () => {
  assert.strictEqual(enc("a/b"), "a%2Fb");
});

test("A43 encPath preserves slashes in paths", () => {
  assert.strictEqual(encPath("src/index.js"), "src/index.js");
});

test("A44 encPath encodes spaces within segments", () => {
  assert.strictEqual(encPath("my folder/my file.js"), "my%20folder/my%20file.js");
});

test("A45 opInfo returns ok:true with all operations listed", async () => {
  const result = await githubClient({ operation: "info" });
  assert.strictEqual(result.ok, true);
  assert.ok(Array.isArray(result.operations));
  assert.ok(result.operations.length >= 50);
  const ops = result.operations.map(o => o.op);
  assert.ok(ops.includes("repo_get"));
  assert.ok(ops.includes("issue_create"));
  assert.ok(ops.includes("pr_merge"));
  assert.ok(ops.includes("workflow_dispatch"));
  assert.ok(ops.includes("search_repos"));
  assert.ok(ops.includes("gist_create"));
  assert.ok(ops.includes("request"));
});

test("A46 opInfo contains api_version field", async () => {
  const result = await githubClient({ operation: "info" });
  assert.ok(result.api_version);
  assert.ok(result.default_base_url.includes("github.com"));
});

test("A47 mapPr handles null input", () => {
  const m = mapPr(null);
  assert.deepStrictEqual(m, {});
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Validation / error-path tests
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nB — Validation / error-path tests\n");

test("B01 unknown operation throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "nonexistent_op" }),
    /Unknown github_client operation/,
  );
});

test("B02 repo_get without owner throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "repo_get", repo: "hello" }),
    /owner.*must be a non-empty string/,
  );
});

test("B03 repo_get without repo throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "repo_get", owner: "user" }),
    /repo.*must be a non-empty string/,
  );
});

test("B04 issue_create without title throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "issue_create", owner: "u", repo: "r" }),
    /title.*must be a non-empty string/,
  );
});

test("B05 issue_get without issue_number throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "issue_get", owner: "u", repo: "r" }),
    /issue_number/,
  );
});

test("B06 pr_create without head throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "pr_create", owner: "u", repo: "r", title: "t", base: "main" }),
    /head.*must be a non-empty string/,
  );
});

test("B07 pr_merge without pull_number throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "pr_merge", owner: "u", repo: "r" }),
    /pull_number/,
  );
});

test("B08 pr_review without event throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "pr_review", owner: "u", repo: "r", pull_number: 1 }),
    /event.*must be a non-empty string/,
  );
});

test("B09 file_get without path throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "file_get", owner: "u", repo: "r" }),
    /path.*must be a non-empty string/,
  );
});

test("B10 file_create without content throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "file_create", owner: "u", repo: "r", path: "f.js", message: "m" }),
    /content.*must be a non-empty string/,
  );
});

test("B11 file_delete without sha throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "file_delete", owner: "u", repo: "r", path: "f.js", message: "m" }),
    /sha.*must be a non-empty string/,
  );
});

test("B12 branch_create without sha throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "branch_create", owner: "u", repo: "r", branch: "new" }),
    /sha.*must be a non-empty string/,
  );
});

test("B13 commit_get without sha throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "commit_get", owner: "u", repo: "r" }),
    /sha.*must be a non-empty string/,
  );
});

test("B14 release_create without tag_name throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "release_create", owner: "u", repo: "r" }),
    /tag_name.*must be a non-empty string/,
  );
});

test("B15 workflow_dispatch without ref throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "workflow_dispatch", owner: "u", repo: "r", workflow_id: "ci.yml" }),
    /ref.*must be a non-empty string/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Mock-network tests (monkey-patch https.request)
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nC — Mock-network tests\n");

const ORIG_HTTPS_REQUEST = https.request;

function mockRequest(statusCode, body) {
  https.request = (_opts, cb) => {
    const res = Object.assign(new EventEmitter(), {
      statusCode,
      headers: { "content-type": "application/json" },
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

test("C01 repo_get returns exists:true on 200", async () => {
  mockRequest(200, {
    id: 1, name: "hello-world", full_name: "octocat/hello-world",
    owner: { login: "octocat" }, private: false, stargazers_count: 1,
    forks_count: 0, open_issues_count: 0, topics: [], archived: false,
    disabled: false, default_branch: "main",
  });
  try {
    const r = await githubClient({ operation: "repo_get", owner: "octocat", repo: "hello-world" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.full_name, "octocat/hello-world");
  } finally { restoreRequest(); }
});

test("C02 repo_get returns exists:false on 404", async () => {
  mockRequest(404, { message: "Not Found" });
  try {
    const r = await githubClient({ operation: "repo_get", owner: "ghost", repo: "nope" });
    assert.strictEqual(r.exists, false);
  } finally { restoreRequest(); }
});

test("C03 issue_list returns issues array", async () => {
  mockRequest(200, [
    { id: 1, number: 1, title: "Bug", state: "open", user: { login: "alice" }, labels: [], assignees: [], comments: 0 },
    { id: 2, number: 2, title: "Feature", state: "open", user: { login: "bob" }, labels: [], assignees: [], comments: 0 },
  ]);
  try {
    const r = await githubClient({ operation: "issue_list", owner: "u", repo: "r" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.issues[0].title, "Bug");
  } finally { restoreRequest(); }
});

test("C04 issue_create returns created:true", async () => {
  mockRequest(201, { id: 99, number: 10, title: "New issue", state: "open", user: { login: "me" }, labels: [], assignees: [] });
  try {
    const r = await githubClient({ operation: "issue_create", owner: "u", repo: "r", title: "New issue" });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.number, 10);
  } finally { restoreRequest(); }
});

test("C05 pr_list returns pull_requests array", async () => {
  mockRequest(200, [
    { id: 1, number: 1, title: "PR1", state: "open", draft: false, merged: false, user: { login: "dev" },
      head: { label: "dev:feat", sha: "abc" }, base: { label: "main:main" },
      labels: [], assignees: [], requested_reviewers: [], commits: 1, additions: 5, deletions: 2, changed_files: 1 },
  ]);
  try {
    const r = await githubClient({ operation: "pr_list", owner: "u", repo: "r" });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.pull_requests[0].title, "PR1");
  } finally { restoreRequest(); }
});

test("C06 file_get decodes base64 content", async () => {
  const content = "console.log('hello')";
  const encoded = Buffer.from(content).toString("base64");
  mockRequest(200, { name: "index.js", path: "src/index.js", sha: "abc", size: 21, content: encoded, encoding: "base64" });
  try {
    const r = await githubClient({ operation: "file_get", owner: "u", repo: "r", path: "src/index.js" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.content, content);
  } finally { restoreRequest(); }
});

test("C07 file_get returns exists:false on 404", async () => {
  mockRequest(404, { message: "Not Found" });
  try {
    const r = await githubClient({ operation: "file_get", owner: "u", repo: "r", path: "missing.js" });
    assert.strictEqual(r.exists, false);
    assert.strictEqual(r.path, "missing.js");
  } finally { restoreRequest(); }
});

test("C08 branch_list returns branches", async () => {
  mockRequest(200, [
    { name: "main", commit: { sha: "abc" }, protected: true },
    { name: "dev", commit: { sha: "def" }, protected: false },
  ]);
  try {
    const r = await githubClient({ operation: "branch_list", owner: "u", repo: "r" });
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.branches[0].name, "main");
    assert.strictEqual(r.branches[0].protected, true);
  } finally { restoreRequest(); }
});

test("C09 release_latest returns latest release", async () => {
  mockRequest(200, {
    id: 5, tag_name: "v2.0.0", name: "v2", draft: false, prerelease: false,
    author: { login: "me" }, assets: [], created_at: "2024-01-01", published_at: "2024-01-02",
  });
  try {
    const r = await githubClient({ operation: "release_latest", owner: "u", repo: "r" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.tag_name, "v2.0.0");
  } finally { restoreRequest(); }
});

test("C10 user_get returns user profile", async () => {
  mockRequest(200, {
    id: 1, login: "octocat", name: "Octocat", type: "User",
    public_repos: 10, followers: 100, following: 5, html_url: "https://github.com/octocat",
  });
  try {
    const r = await githubClient({ operation: "user_get", username: "octocat" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.login, "octocat");
  } finally { restoreRequest(); }
});

test("C11 search_repos returns items array", async () => {
  mockRequest(200, {
    total_count: 1000,
    incomplete_results: false,
    items: [{ id: 1, name: "repo", full_name: "u/repo", owner: { login: "u" }, private: false, stargazers_count: 50, topics: [] }],
  });
  try {
    const r = await githubClient({ operation: "search_repos", query: "node", per_page: 1 });
    assert.strictEqual(r.total_count, 1000);
    assert.strictEqual(r.items.length, 1);
  } finally { restoreRequest(); }
});

test("C12 gist_create returns created:true", async () => {
  mockRequest(201, { id: "gist123", html_url: "https://gist.github.com/gist123", description: "Test", public: false });
  try {
    const r = await githubClient({
      operation: "gist_create",
      description: "Test",
      files: { "test.js": "console.log(1)" },
    });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.id, "gist123");
  } finally { restoreRequest(); }
});

test("C13 pr_merge returns merged:true on success", async () => {
  mockRequest(200, { merged: true, sha: "mergesha", message: "Pull Request successfully merged" });
  try {
    const r = await githubClient({ operation: "pr_merge", owner: "u", repo: "r", pull_number: 5 });
    assert.strictEqual(r.merged, true);
    assert.strictEqual(r.sha, "mergesha");
  } finally { restoreRequest(); }
});

test("C14 pr_merge returns merged:false on 405 not_mergeable", async () => {
  mockRequest(405, { message: "Pull Request is not mergeable" });
  try {
    const r = await githubClient({ operation: "pr_merge", owner: "u", repo: "r", pull_number: 5 });
    assert.strictEqual(r.merged, false);
    assert.strictEqual(r.reason, "not_mergeable");
  } finally { restoreRequest(); }
});

test("C15 commit_list returns commits array", async () => {
  mockRequest(200, [
    { sha: "abc", commit: { message: "init", author: { name: "Alice", date: "2024-01-01" }, committer: { name: "Alice", date: "2024-01-01" } }, parents: [] },
  ]);
  try {
    const r = await githubClient({ operation: "commit_list", owner: "u", repo: "r" });
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.commits[0].sha, "abc");
    assert.strictEqual(r.commits[0].message, "init");
  } finally { restoreRequest(); }
});

test("C16 workflow_dispatch returns dispatched:true", async () => {
  mockRequest(204, "");
  try {
    const r = await githubClient({ operation: "workflow_dispatch", owner: "u", repo: "r", workflow_id: "ci.yml", ref: "main" });
    assert.strictEqual(r.dispatched, true);
  } finally { restoreRequest(); }
});

test("C17 repo_delete returns deleted:true on success", async () => {
  mockRequest(204, "");
  try {
    const r = await githubClient({ operation: "repo_delete", owner: "u", repo: "r" });
    assert.strictEqual(r.deleted, true);
  } finally { restoreRequest(); }
});

test("C18 repo_delete returns deleted:false on 404", async () => {
  mockRequest(404, { message: "Not Found" });
  try {
    const r = await githubClient({ operation: "repo_delete", owner: "u", repo: "nope" });
    assert.strictEqual(r.deleted, false);
    assert.strictEqual(r.reason, "not_found");
  } finally { restoreRequest(); }
});

test("C19 dir_list returns entries on success", async () => {
  mockRequest(200, [
    { name: "README.md", path: "README.md", type: "file", size: 100, sha: "s1", html_url: "https://g" },
    { name: "src", path: "src", type: "dir", size: 0, sha: "s2", html_url: "https://g/src" },
  ]);
  try {
    const r = await githubClient({ operation: "dir_list", owner: "u", repo: "r" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.entries[1].type, "dir");
  } finally { restoreRequest(); }
});

test("C20 request operation passes through status and body", async () => {
  mockRequest(200, { login: "octocat" });
  try {
    const r = await githubClient({ operation: "request", path: "/user", method: "GET" });
    assert.strictEqual(r.status_code, 200);
    assert.strictEqual(r.body.login, "octocat");
  } finally { restoreRequest(); }
});

test("C21 request operation throws on invalid method", async () => {
  await assert.rejects(
    () => githubClient({ operation: "request", path: "/user", method: "TRACE" }),
    /must be one of/,
  );
});

test("C22 org_get returns org details", async () => {
  mockRequest(200, {
    id: 1, login: "myorg", name: "My Org", description: "desc",
    public_repos: 10, html_url: "https://github.com/myorg",
    created_at: "2020-01-01",
  });
  try {
    const r = await githubClient({ operation: "org_get", org: "myorg" });
    assert.strictEqual(r.login, "myorg");
    assert.strictEqual(r.public_repos, 10);
  } finally { restoreRequest(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// D — Security / injection tests
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nD — Security / injection tests\n");

test("D01 NUL byte in owner is rejected", async () => {
  await assert.rejects(
    () => githubClient({ operation: "repo_get", owner: "bad\0guy", repo: "r" }),
    /NUL/,
  );
});

test("D02 NUL byte in repo is rejected", async () => {
  await assert.rejects(
    () => githubClient({ operation: "repo_get", owner: "u", repo: "r\0bad" }),
    /NUL/,
  );
});

test("D03 NUL byte in token is rejected", async () => {
  await assert.rejects(
    () => githubClient({ operation: "repo_get", owner: "u", repo: "r", token: "ghp_bad\0token" }),
    /NUL/,
  );
});

test("D04 NUL byte in branch name is rejected", async () => {
  await assert.rejects(
    () => githubClient({ operation: "branch_get", owner: "u", repo: "r", branch: "main\0injection" }),
    /NUL/,
  );
});

test("D05 NUL byte in username is rejected", async () => {
  await assert.rejects(
    () => githubClient({ operation: "user_get", username: "alice\0evil" }),
    /NUL/,
  );
});

test("D06 NUL byte in search query is rejected", async () => {
  await assert.rejects(
    () => githubClient({ operation: "search_repos", query: "node\0injection" }),
    /NUL/,
  );
});

test("D07 token is not returned in HTTP 401 error message", async () => {
  mockRequest(401, { message: "Bad credentials" });
  const secretToken = "ghp_SUPERSECRETTOKEN";
  try {
    await githubClient({ operation: "repo_get", owner: "u", repo: "r", token: secretToken });
    assert.fail("Should have thrown");
  } catch (err) {
    assert.ok(!err.message.includes(secretToken), `Token leaked in error: ${err.message}`);
  } finally { restoreRequest(); }
});

test("D08 gist_create with empty files object throws", async () => {
  await assert.rejects(
    () => githubClient({ operation: "gist_create", description: "test", files: {} }),
    /files must be a non-empty object/,
  );
});

test("D09 path traversal chars in repo path are URL-encoded (special chars)", () => {
  // encPath encodes special chars within segments (spaces, %, etc.)
  // ../ traversal is rejected by the GitHub API server, not by encPath
  const encoded = encPath("path with spaces/file%name.js");
  assert.ok(encoded.includes("%20"), `Spaces should be encoded: ${encoded}`);
  assert.ok(encoded.includes("%25"), `Percent should be encoded: ${encoded}`);
});

test("D10 NUL byte in gist_id is rejected", async () => {
  await assert.rejects(
    () => githubClient({ operation: "gist_get", gist_id: "abc\0def" }),
    /NUL/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// E — Concurrency / race-condition tests
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nE — Concurrency / race-condition tests\n");

test("E01 multiple concurrent info calls all return ok", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    githubClient({ operation: "info" })
  ));
  for (const r of results) {
    assert.strictEqual(r.ok, true);
  }
});

test("E02 concurrent repo_get calls succeed independently", async () => {
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
            res.emit("data", Buffer.from(JSON.stringify({
              id: idx, name: `repo${idx}`, full_name: `u/repo${idx}`,
              owner: { login: "u" }, private: false, topics: [], stargazers_count: idx,
            })));
            res.emit("end");
          }, Math.random() * 10);
        }, Math.random() * 10);
      },
      destroy: () => {},
    });
    return req;
  };

  try {
    const repos = ["r1", "r2", "r3", "r4", "r5"];
    const results = await Promise.all(repos.map(repo =>
      githubClient({ operation: "repo_get", owner: "u", repo })
    ));
    assert.strictEqual(results.length, 5);
    for (const r of results) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.exists, true);
    }
  } finally { restoreRequest(); }
});

test("E03 timeout is respected (short timeout triggers error)", async () => {
  https.request = (_opts, cb) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: () => { /* Never responds */ },
      destroy: function() { this.emit("error", new Error("socket hang up")); },
    });
    return req;
  };
  try {
    await assert.rejects(
      () => githubClient({ operation: "repo_get", owner: "u", repo: "r", timeout: 50 }),
      /timed out/i,
    );
  } finally { restoreRequest(); }
});

test("E04 response size cap triggers error", async () => {
  https.request = (_opts, cb) => {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
    const req = Object.assign(new EventEmitter(), {
      write: () => {},
      end: () => {
        cb(res);
        // Emit 17 MB of data (exceeds 16 MB cap)
        const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1 MB chunks
        setImmediate(() => { for (let i = 0; i < 17; i++) res.emit("data", chunk); });
      },
      destroy: () => {},
    });
    return req;
  };
  try {
    await assert.rejects(
      () => githubClient({ operation: "user_me" }),
      /16 MB cap/,
    );
  } finally { restoreRequest(); }
});

test("E05 network error triggers connect error message", async () => {
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
      () => githubClient({ operation: "user_me" }),
      /Cannot connect to api.github.com/,
    );
  } finally { restoreRequest(); }
});

test("E06 concurrent validation errors are all caught cleanly", async () => {
  const promises = [
    githubClient({ operation: "repo_get" }).catch(e => e.message),
    githubClient({ operation: "issue_create", owner: "u", repo: "r" }).catch(e => e.message),
    githubClient({ operation: "pr_create", owner: "u", repo: "r", title: "t", base: "main" }).catch(e => e.message),
    githubClient({ operation: "file_create", owner: "u", repo: "r", path: "f", message: "m" }).catch(e => e.message),
    githubClient({ operation: "branch_create", owner: "u", repo: "r", branch: "b" }).catch(e => e.message),
  ];
  const results = await Promise.all(promises);
  for (const r of results) {
    assert.ok(typeof r === "string" && r.length > 0, `Expected error message, got: ${r}`);
  }
});

test("E07 response stream error is propagated cleanly", async () => {
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
      () => githubClient({ operation: "user_me" }),
      /stream error/,
    );
  } finally { restoreRequest(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

const allPromises = [];
// Collect all async test promises

setTimeout(async () => {
  if (failed > 0) {
    process.stderr.write(`\n✗ ${failed} test(s) FAILED:\n`);
    for (const { name, err } of errors) {
      process.stderr.write(`  - ${name}: ${err.message}\n`);
    }
  }
  process.stderr.write(`\n✓ ${passed} passed, ✗ ${failed} failed out of ${passed + failed} tests\n\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 3000);
