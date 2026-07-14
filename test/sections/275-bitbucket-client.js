"use strict";

/**
 * Test suite for bitbucket_client (section 275)
 * Tests the core logic via direct function calls — no live MCP server needed.
 *
 * Rigor levels covered:
 *   1. Normal    — happy-path info and connection building
 *   2. Medium    — validation for empty / invalid inputs
 *   3. High      — mocked HTTP responses (success + error paths)
 *   4. Critical  — NUL-byte injection, credential redaction in errors
 *   5. Extreme   — concurrency (parallel requests), large-payload cap
 */

const assert = require("assert");
const https   = require("https");
const { EventEmitter } = require("events");

const {
  bitbucketClient,
  buildConn,
  requireString,
  guardString,
  clampInt,
  parseBbJson,
  checkBbStatus,
  mapRepo,
  mapIssue,
  mapPr,
  mapCommit,
  mapUser,
  mapWorkspace,
  enc,
  repoPath,
} = require("../../lib/bitbucketClientOps");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result
        .then(() => { console.log(`  ✓ ${name}`); passed++; })
        .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; });
    }
    console.log(`  ✓ ${name}`);
    passed++;
    return Promise.resolve();
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
    return Promise.resolve();
  }
}

// ── Mock HTTP helper ──────────────────────────────────────────────────────────
// Temporarily replaces https.request with a fake that returns a preset response.
function withMockHttps(statusCode, body, fn) {
  const original = https.request;
  https.request = function(_opts, callback) {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = { "content-type": "application/json" };
    const req = new EventEmitter();
    req.write = () => {};
    req.end   = () => {
      if (callback) callback(res);
      setTimeout(() => {
        res.emit("data", Buffer.from(body));
        res.emit("end");
      }, 0);
    };
    req.destroy = () => {};
    return req;
  };
  const result = fn();
  return Promise.resolve(result)
    .then((v)  => { https.request = original; return v; })
    .catch((e) => { https.request = original; throw e; });
}

// ── Section 1 — Normal ────────────────────────────────────────────────────────

console.log("\n[1/5] Normal — happy-path tests");

const normalTests = [
  test("info operation returns protocol metadata", async () => {
    const result = await bitbucketClient({ operation: "info" });
    assert.ok(result.ok, "ok should be true");
    assert.strictEqual(typeof result.protocol, "string");
    assert.ok(result.operations.length > 50, "should list 56 operations");
    assert.ok(result.operations.some(o => o.op === "repo_get"));
    assert.ok(result.operations.some(o => o.op === "bitbucket_client" || o.op === "info"));
  }),

  test("buildConn defaults are correct", () => {
    const conn = buildConn({ username: "user", app_password: "pass" });
    assert.strictEqual(conn.username, "user");
    assert.strictEqual(conn.appPassword, "pass");
    assert.strictEqual(conn.accessToken, null);
    assert.strictEqual(conn.timeoutMs, 20000);
    assert.strictEqual(conn.rejectUnauthorized, true);
    assert.ok(conn.baseUrl.includes("bitbucket.org"));
  }),

  test("buildConn with access_token sets accessToken", () => {
    const conn = buildConn({ access_token: "mytoken" });
    assert.strictEqual(conn.accessToken, "mytoken");
    assert.strictEqual(conn.username, null);
    assert.strictEqual(conn.appPassword, null);
  }),

  test("buildConn custom base_url strips trailing slash", () => {
    const conn = buildConn({ base_url: "https://custom.example.com/2.0/" });
    assert.strictEqual(conn.baseUrl, "https://custom.example.com/2.0");
  }),

  test("clampInt clamps correctly", () => {
    assert.strictEqual(clampInt(5, 10, 1, 100), 5);
    assert.strictEqual(clampInt(0, 10, 1, 100), 1);
    assert.strictEqual(clampInt(200, 10, 1, 100), 100);
    assert.strictEqual(clampInt(undefined, 42, 1, 100), 42);
  }),

  test("parseBbJson parses valid JSON", () => {
    const result = parseBbJson('{"foo":"bar"}', "test");
    assert.deepStrictEqual(result, { foo: "bar" });
  }),

  test("parseBbJson returns null for empty string", () => {
    const result = parseBbJson("", "test");
    assert.strictEqual(result, null);
  }),

  test("enc URL-encodes special characters", () => {
    assert.strictEqual(enc("my repo"), "my%20repo");
    assert.strictEqual(enc("foo/bar"), "foo%2Fbar");
  }),

  test("repoPath builds correct path", () => {
    const path = repoPath({ workspace: "myws", repo_slug: "myrepo" });
    assert.strictEqual(path, "/repositories/myws/myrepo");
  }),

  test("mapRepo extracts key fields", () => {
    const raw = {
      name: "test-repo", full_name: "ws/test-repo", is_private: true,
      language: "JavaScript", size: 1024, has_issues: true,
      mainbranch: { name: "main" }, owner: { nickname: "alice" },
      workspace: { slug: "ws" },
      links: { html: { href: "https://bb.example.com" }, clone: [{ name: "https", href: "https://clone.url" }] },
    };
    const m = mapRepo(raw);
    assert.strictEqual(m.name, "test-repo");
    assert.strictEqual(m.is_private, true);
    assert.strictEqual(m.mainbranch, "main");
    assert.strictEqual(m.owner, "alice");
    assert.strictEqual(m.workspace, "ws");
    assert.strictEqual(m.links.clone[0].name, "https");
  }),

  test("mapIssue extracts key fields", () => {
    const raw = {
      id: 42, title: "Bug", state: "open", kind: "bug", priority: "major",
      reporter: { nickname: "bob" }, content: { raw: "description" },
      links: { html: { href: "https://issues.url" } },
    };
    const m = mapIssue(raw);
    assert.strictEqual(m.id, 42);
    assert.strictEqual(m.kind, "bug");
    assert.strictEqual(m.reporter, "bob");
    assert.strictEqual(m.content, "description");
  }),

  test("mapPr extracts key fields", () => {
    const raw = {
      id: 7, title: "My PR", state: "OPEN",
      source:      { branch: { name: "feature" }, commit: { hash: "abc123" }, repository: { full_name: "ws/repo" } },
      destination: { branch: { name: "main" },    commit: { hash: "def456" } },
      author: { nickname: "carol" },
      reviewers: [{ nickname: "dave" }],
      participants: [{ user: { nickname: "eve" }, role: "REVIEWER", approved: true }],
      links: { html: { href: "https://pr.url" } },
    };
    const m = mapPr(raw);
    assert.strictEqual(m.id, 7);
    assert.strictEqual(m.source.branch, "feature");
    assert.strictEqual(m.destination.branch, "main");
    assert.strictEqual(m.reviewers[0], "dave");
    assert.strictEqual(m.participants[0].approved, true);
  }),

  test("mapUser extracts key fields", () => {
    const raw = { account_id: "acc1", uuid: "{uuid}", nickname: "frank", display_name: "Frank F" };
    const m = mapUser(raw);
    assert.strictEqual(m.nickname, "frank");
    assert.strictEqual(m.account_id, "acc1");
  }),

  test("mapWorkspace extracts key fields", () => {
    const raw = { uuid: "{ws-uuid}", slug: "myws", name: "My Workspace", is_private: false };
    const m = mapWorkspace(raw);
    assert.strictEqual(m.slug, "myws");
    assert.strictEqual(m.is_private, false);
  }),
];

// ── Section 2 — Medium ────────────────────────────────────────────────────────

console.log("\n[2/5] Medium — validation for empty / invalid inputs");

const mediumTests = [
  test("requireString throws for empty string", () => {
    assert.throws(() => requireString("", "field"), /non-empty string/);
  }),

  test("requireString throws for non-string", () => {
    assert.throws(() => requireString(123, "field"), /non-empty string/);
  }),

  test("guardString throws for non-string value", () => {
    assert.throws(() => guardString(123, "field"), /must be a string/);
  }),

  test("guardString allows null and undefined", () => {
    assert.doesNotThrow(() => guardString(null, "field"));
    assert.doesNotThrow(() => guardString(undefined, "field"));
  }),

  test("repoPath throws when workspace missing", () => {
    assert.throws(() => repoPath({ repo_slug: "r" }), /workspace and repo_slug/);
  }),

  test("repoPath throws when repo_slug missing", () => {
    assert.throws(() => repoPath({ workspace: "ws" }), /workspace and repo_slug/);
  }),

  test("parseBbJson throws for invalid JSON", () => {
    assert.throws(() => parseBbJson("not-json", "ctx"), /invalid JSON/);
  }),

  test("checkBbStatus throws for 4xx", () => {
    assert.throws(
      () => checkBbStatus({ statusCode: 403, raw: JSON.stringify({ error: { message: "Forbidden" } }) }, "op"),
      /HTTP 403.*Forbidden/
    );
  }),

  test("checkBbStatus throws for 5xx", () => {
    assert.throws(
      () => checkBbStatus({ statusCode: 500, raw: "" }, "op"),
      /HTTP 500/
    );
  }),

  test("checkBbStatus does not throw for 2xx", () => {
    assert.doesNotThrow(() => checkBbStatus({ statusCode: 200, raw: "" }, "op"));
    assert.doesNotThrow(() => checkBbStatus({ statusCode: 201, raw: "" }, "op"));
    assert.doesNotThrow(() => checkBbStatus({ statusCode: 204, raw: "" }, "op"));
  }),

  test("unknown operation throws with hint", async () => {
    try {
      await bitbucketClient({ operation: "does_not_exist" });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("does_not_exist"));
      assert.ok(err.message.includes("info"));
    }
  }),

  test("clampInt throws for non-finite value", () => {
    assert.throws(() => clampInt(NaN, 5, 1, 10), /finite/);
    assert.throws(() => clampInt(Infinity, 5, 1, 10), /finite/);
  }),

  test("buildConn respects reject_unauthorized=false", () => {
    const conn = buildConn({ reject_unauthorized: false });
    assert.strictEqual(conn.rejectUnauthorized, false);
  }),

  test("buildConn clamps timeout", () => {
    const connLow  = buildConn({ timeout: 0 });
    const connHigh = buildConn({ timeout: 999999 });
    assert.strictEqual(connLow.timeoutMs, 1000);
    assert.strictEqual(connHigh.timeoutMs, 120000);
  }),
];

// ── Section 3 — High: mocked HTTP ────────────────────────────────────────────

console.log("\n[3/5] High — mocked HTTP responses");

const highTests = [
  test("repo_list returns mapped repos from mocked 200", async () => {
    const fakeBody = JSON.stringify({
      values: [
        { name: "repo1", full_name: "ws/repo1", is_private: false, scm: "git", links: { clone: [] } },
        { name: "repo2", full_name: "ws/repo2", is_private: true,  scm: "git", links: { clone: [] } },
      ],
      page: 1, size: 2,
    });
    return withMockHttps(200, fakeBody, async () => {
      const result = await bitbucketClient({
        operation:  "repo_list",
        workspace:  "myws",
        access_token: "tok",
      });
      assert.ok(result.ok);
      assert.strictEqual(result.count, 2);
      assert.strictEqual(result.repos[0].name, "repo1");
      assert.strictEqual(result.repos[1].is_private, true);
    });
  }),

  test("repo_get returns exists:false on 404", async () => {
    return withMockHttps(404, "", async () => {
      const result = await bitbucketClient({
        operation:   "repo_get",
        workspace:   "ws",
        repo_slug:   "nonexistent",
        access_token: "tok",
      });
      assert.ok(result.ok);
      assert.strictEqual(result.exists, false);
    });
  }),

  test("pr_list maps pull requests from mocked response", async () => {
    const fakeBody = JSON.stringify({
      values: [{
        id: 1, title: "Feature", state: "OPEN",
        author: { nickname: "alice" },
        source:      { branch: { name: "feat" }, commit: { hash: "aaa" } },
        destination: { branch: { name: "main" }, commit: { hash: "bbb" } },
        reviewers: [], participants: [],
        links: { html: { href: "https://bb.org/pr/1" } },
      }],
      page: 1, size: 1,
    });
    return withMockHttps(200, fakeBody, async () => {
      const result = await bitbucketClient({
        operation: "pr_list", workspace: "ws", repo_slug: "r", access_token: "tok",
      });
      assert.ok(result.ok);
      assert.strictEqual(result.count, 1);
      assert.strictEqual(result.pull_requests[0].title, "Feature");
      assert.strictEqual(result.pull_requests[0].source.branch, "feat");
    });
  }),

  test("issue_create sends correct payload and maps response", async () => {
    const fakeBody = JSON.stringify({
      id: 10, title: "New Bug", state: "new", kind: "bug",
      reporter: { nickname: "user1" }, content: { raw: "desc" },
      links: { html: { href: "https://issue.url" } },
    });
    return withMockHttps(201, fakeBody, async () => {
      const result = await bitbucketClient({
        operation: "issue_create", workspace: "ws", repo_slug: "r",
        title: "New Bug", kind: "bug", content: "desc",
        access_token: "tok",
      });
      assert.ok(result.ok);
      assert.ok(result.created);
      assert.strictEqual(result.id, 10);
      assert.strictEqual(result.kind, "bug");
    });
  }),

  test("repo_delete returns deleted:false on 404", async () => {
    return withMockHttps(404, "", async () => {
      const result = await bitbucketClient({
        operation: "repo_delete", workspace: "ws", repo_slug: "ghost", access_token: "tok",
      });
      assert.ok(result.ok);
      assert.strictEqual(result.deleted, false);
      assert.strictEqual(result.reason, "not_found");
    });
  }),

  test("HTTP error (403) propagates as Error with status code", async () => {
    const errBody = JSON.stringify({ error: { message: "Insufficient permissions" } });
    return withMockHttps(403, errBody, async () => {
      try {
        await bitbucketClient({
          operation: "repo_list", workspace: "ws", access_token: "tok",
        });
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(err.message.includes("403"));
        assert.ok(err.message.includes("Insufficient permissions"));
      }
    });
  }),

  test("pipeline_create throws without branch or commit", async () => {
    // Note: validation happens before network — no mock needed
    try {
      await bitbucketClient({
        operation: "pipeline_create", workspace: "ws", repo_slug: "r", access_token: "tok",
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("branch or commit"));
    }
  }),

  test("user_me returns mapped user from mocked response", async () => {
    const fakeBody = JSON.stringify({
      account_id: "123", uuid: "{uuid1}", nickname: "myuser",
      display_name: "My User", links: { html: { href: "https://bb.org/myuser" } },
    });
    return withMockHttps(200, fakeBody, async () => {
      const result = await bitbucketClient({ operation: "user_me", access_token: "tok" });
      assert.ok(result.ok);
      assert.strictEqual(result.nickname, "myuser");
      assert.strictEqual(result.account_id, "123");
    });
  }),

  test("webhook_create validates events array", async () => {
    try {
      await bitbucketClient({
        operation: "webhook_create", workspace: "ws", repo_slug: "r",
        url: "https://example.com/hook", events: [],
        access_token: "tok",
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("non-empty array"));
    }
  }),
];

// ── Section 4 — Critical: security / injection ────────────────────────────────

console.log("\n[4/5] Critical — NUL-byte injection and credential redaction");

const criticalTests = [
  test("requireString rejects NUL byte", () => {
    assert.throws(() => requireString("hello\0world", "field"), /NUL/);
  }),

  test("guardString rejects NUL byte", () => {
    assert.throws(() => guardString("abc\0", "field"), /NUL/);
  }),

  test("buildConn throws on NUL in username", () => {
    // buildConn uses guardString for username
    assert.throws(() => buildConn({ username: "us\0er", app_password: "p" }), /NUL/);
  }),

  test("buildConn throws on NUL in access_token", () => {
    assert.throws(() => buildConn({ access_token: "tok\0en" }), /NUL/);
  }),

  test("credentials do not appear in error messages", async () => {
    // On network failure, the app_password must not appear in the error
    // We trigger a real-ish error by using withMockHttps with a 401
    const fakeBody = JSON.stringify({ error: { message: "Unauthorized" } });
    return withMockHttps(401, fakeBody, async () => {
      try {
        await bitbucketClient({
          operation: "repo_list", workspace: "ws",
          username: "user", app_password: "supersecret",
        });
        assert.fail("Should have thrown");
      } catch (err) {
        assert.ok(!err.message.includes("supersecret"),
          "app_password must not appear in error: " + err.message);
      }
    });
  }),

  test("workspace/repo values are URL-encoded in path", () => {
    const path = repoPath({ workspace: "my workspace", repo_slug: "my repo/slug" });
    assert.ok(path.includes("my%20workspace"), "workspace should be URL-encoded");
    assert.ok(path.includes("my%20repo%2Fslug"), "repo_slug should be URL-encoded");
    assert.ok(!path.includes(" "), "no raw spaces");
  }),

  test("request operation rejects invalid HTTP methods", async () => {
    try {
      await bitbucketClient({
        operation: "request", api_path: "/some/path",
        method: "EVIL; rm -rf /", access_token: "tok",
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("method must be one of"));
    }
  }),

  test("checkBbStatus redacts nothing but includes raw in limited form", () => {
    // raw is truncated to 300 chars in error — the full secret body shouldn't overflow
    const longBody = "x".repeat(500);
    try {
      checkBbStatus({ statusCode: 400, raw: longBody }, "op");
      assert.fail("Should throw");
    } catch (err) {
      assert.ok(err.message.length < 400, "error message should not be arbitrarily long");
    }
  }),
];

// ── Section 5 — Extreme: concurrency and stress ───────────────────────────────

console.log("\n[5/5] Extreme — concurrency and large-payload cap");

const extremeTests = [
  test("concurrent info calls return consistent results", async () => {
    const calls = Array.from({ length: 20 }, () => bitbucketClient({ operation: "info" }));
    const results = await Promise.all(calls);
    for (const r of results) {
      assert.ok(r.ok);
      assert.ok(r.operations.length > 50);
    }
    // All results should be identical
    const first = JSON.stringify(results[0]);
    for (const r of results.slice(1)) {
      assert.strictEqual(JSON.stringify(r), first, "concurrent info should be identical");
    }
  }),

  test("parallel mocked repo_get calls all succeed", async () => {
    const fakeBody = JSON.stringify({
      name: "repo", full_name: "ws/repo", is_private: false, scm: "git",
      links: { clone: [] },
    });
    return withMockHttps(200, fakeBody, async () => {
      const calls = Array.from({ length: 10 }, (_, i) => bitbucketClient({
        operation: "repo_get", workspace: `ws${i}`, repo_slug: "repo", access_token: "tok",
      }));
      const results = await Promise.all(calls);
      for (const r of results) {
        assert.ok(r.ok);
        assert.ok(r.exists);
        assert.strictEqual(r.name, "repo");
      }
    });
  }),

  test("response cap: rejects body larger than 16 MB", async () => {
    // Build a mock that streams chunks totalling > 16 MB
    const original = https.request;
    const LIMIT = 16 * 1024 * 1024;
    https.request = function(_opts, callback) {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers    = {};
      const req = new EventEmitter();
      req.write   = () => {};
      req.destroy = () => {};
      req.end = () => {
        if (callback) callback(res);
        // Stream LIMIT+1 bytes in one chunk
        setTimeout(() => {
          res.emit("data", Buffer.alloc(LIMIT + 1, 0x61)); // 'a' * 16MB+1
          res.emit("end");
        }, 0);
      };
      return req;
    };
    try {
      await bitbucketClient({ operation: "repo_list", workspace: "ws", access_token: "tok" });
      https.request = original;
      assert.fail("Should have rejected with 16 MB cap error");
    } catch (err) {
      https.request = original;
      assert.ok(err.message.includes("16 MB"), `Expected 16 MB cap error, got: ${err.message}`);
    }
  }),

  test("mapRepo handles null/missing fields gracefully", () => {
    const m = mapRepo({});
    // Should not throw; all missing fields become null/false/0
    assert.strictEqual(m.is_private, false);
    assert.strictEqual(m.size, 0);
    assert.deepStrictEqual(m.links.clone, []);
    assert.strictEqual(m.mainbranch, null);
  }),

  test("mapPr handles empty participants and reviewers", () => {
    const m = mapPr({ id: 1, title: "T", state: "OPEN", reviewers: [], participants: [] });
    assert.deepStrictEqual(m.reviewers, []);
    assert.deepStrictEqual(m.participants, []);
  }),

  test("clampInt rounds fractional inputs", () => {
    assert.strictEqual(clampInt(3.9, 5, 1, 10), 4);
    assert.strictEqual(clampInt(3.1, 5, 1, 10), 3);
  }),
];

// ── Run all tests ─────────────────────────────────────────────────────────────

Promise.all([
  ...normalTests,
  ...mediumTests,
  ...highTests,
  ...criticalTests,
  ...extremeTests.filter(p => p && typeof p.then === "function"),
]).then(() => {
  // Section 5 has one callback-style test; allow event loop to flush
  return new Promise(res => setTimeout(res, 200));
}).then(() => {
  console.log(`\n${ passed + failed } tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
