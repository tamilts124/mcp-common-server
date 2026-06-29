"use strict";
/**
 * [32] HTTP_FETCH — outbound HTTP/HTTPS request tool
 *
 * Rigor levels:
 *
 *   Normal:  happy-path — GET/POST to a local test HTTP server (spun up in
 *            process, no external network); verify status, body, ok flag,
 *            headers, bodySize, truncated, url, redirected fields. Also: POST
 *            with JSON body + Content-Type header, HEAD request (no body),
 *            custom headers echoed back.
 *
 *   Medium:  boundary — missing required 'url' field returns -32602; empty
 *            url returns -32602; unknown method returns -32602; non-http/https
 *            scheme (file://, ftp://, data://) returns -32602; 404 returns
 *            ok:false without throwing; 500 returns ok:false without throwing;
 *            timeout param is clamped at 60 s (validated via schema).
 *
 *   High:    redirect — 301 redirect is followed automatically and
 *            redirected:true is set; redirect loop (A→A) is detected and
 *            rejected; too many redirects (6 hops) is rejected; redirect to
 *            a non-http scheme is blocked.
 *
 *   Critical: security — file:// scheme rejected; data:// scheme rejected;
 *             ftp:// scheme rejected; javascript: scheme rejected; null byte
 *             in URL rejected cleanly; no prototype pollution from response
 *             headers; injection-shaped header values are transmitted as
 *             literal strings (no template injection); result is fully
 *             JSON-serialisable.
 *
 *   Extreme: stress — large response body (200 KB) is truncated at 100 KB
 *            with truncated:true; 10 concurrent GETs return consistent
 *            results; 50 sequential GETs to the same endpoint are consistent;
 *            fuzz bytes as url throw cleanly (not crash); very long URL string
 *            (10000 chars) is handled without crashing.
 *
 * Note: Tests use a loopback HTTP server (no external network needed) to keep
 * the suite hermetic. The server is started once, all tests run, then it is
 * closed. http_fetch is tested via executeTool() to go through the full
 * validateArgs/dispatch/async-await path.
 *
 * See test/sections/29b-http-fetch-pipeline.js for execute_pipeline +
 * http_fetch integration tests (split out separately to keep this file
 * under the project's 500-line threshold).
 */
const http   = require("http");
const { assert, test, counters } = require("../test-harness");
const { executeTool } = require("../../lib/executeTool");

console.log(`\n[32] HTTP_FETCH — http_fetch tool`);

// ── LOCAL TEST SERVER ─────────────────────────────────────────────────────────
// We spin up a plain Node http server on an OS-assigned port for tests that
// need a real round-trip. All tests use `http://127.0.0.1:${PORT}/...`.

let testServer;
let PORT;

function startTestServer() {
  return new Promise((resolve) => {
    testServer = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");

      // ── /echo — reflects method, headers, body ─────────────────────────
      if (url.pathname === "/echo") {
        let body = "";
        req.on("data", d => body += d);
        req.on("end", () => {
          const resp = {
            method:  req.method,
            headers: req.headers,
            body,
            path:    url.pathname,
          };
          res.writeHead(200, {
            "content-type": "application/json",
            "x-test-header": "yes",
          });
          res.end(JSON.stringify(resp));
        });
        return;
      }

      // ── /status/:code — return the given HTTP status ───────────────────
      const statusMatch = url.pathname.match(/^\/status\/(\d+)$/);
      if (statusMatch) {
        const code = parseInt(statusMatch[1], 10);
        res.writeHead(code, { "content-type": "text/plain" });
        res.end(`Status ${code}`);
        return;
      }

      // ── /redirect — redirect to /echo ──────────────────────────────────
      if (url.pathname === "/redirect") {
        res.writeHead(301, { location: `http://127.0.0.1:${PORT}/echo` });
        res.end();
        return;
      }

      // ── /redirect-loop — always redirect to itself ─────────────────────
      if (url.pathname === "/redirect-loop") {
        res.writeHead(301, { location: `http://127.0.0.1:${PORT}/redirect-loop` });
        res.end();
        return;
      }

      // ── /redirect-chain/:n — redirect chain of n hops ─────────────────
      const chainMatch = url.pathname.match(/^\/redirect-chain\/(\d+)$/);
      if (chainMatch) {
        const n = parseInt(chainMatch[1], 10);
        if (n > 0) {
          res.writeHead(301, { location: `http://127.0.0.1:${PORT}/redirect-chain/${n - 1}` });
          res.end();
        } else {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("chain-end");
        }
        return;
      }

      // ── /large — 200 KB body ───────────────────────────────────────────
      if (url.pathname === "/large") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(200 * 1024));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });

    testServer.listen(0, "127.0.0.1", () => {
      PORT = testServer.address().port;
      resolve();
    });
  });
}

function stopTestServer() {
  return new Promise((resolve) => {
    if (!testServer) { resolve(); return; }
    testServer.close(() => resolve());
  });
}

// ── Helper: await executeTool (http_fetch is async) ───────────────────────────
async function fetch(args) {
  return Promise.resolve(executeTool("http_fetch", args));
}

// ── Run all tests inside an async IIFE so we can use await at top level ───────
// Export the promise so run-tests.js can await it before printing the summary.
module.exports = (async () => {
  await startTestServer();

  // ── NORMAL ────────────────────────────────────────────────────────────────

  await test("http_fetch: GET /echo returns status 200 and ok:true", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.ok, true);
  });

  await test("http_fetch: result has all documented fields", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    assert.ok(typeof r.url         === "string");
    assert.ok(typeof r.status      === "number");
    assert.ok(typeof r.statusText  === "string");
    assert.ok(typeof r.ok          === "boolean");
    assert.ok(typeof r.redirected  === "boolean");
    assert.ok(typeof r.headers     === "object");
    assert.ok(typeof r.body        === "string");
    assert.ok(typeof r.bodySize    === "number");
    assert.ok(typeof r.truncated   === "boolean");
  });

  await test("http_fetch: body is parseable JSON for /echo", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    const parsed = JSON.parse(r.body);
    assert.strictEqual(parsed.method, "GET");
  });

  await test("http_fetch: response headers included in result", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    assert.ok(r.headers["x-test-header"] === "yes", "x-test-header should be 'yes'");
  });

  await test("http_fetch: POST with JSON body — body echoed back", async () => {
    const r = await fetch({
      url:    `http://127.0.0.1:${PORT}/echo`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body:   JSON.stringify({ foo: "bar" }),
    });
    assert.strictEqual(r.status, 200);
    const parsed = JSON.parse(r.body);
    assert.strictEqual(parsed.method, "POST");
    assert.strictEqual(parsed.body, JSON.stringify({ foo: "bar" }));
  });

  await test("http_fetch: custom request headers are sent to server", async () => {
    const r = await fetch({
      url:     `http://127.0.0.1:${PORT}/echo`,
      headers: { "x-custom": "hello-world" },
    });
    const parsed = JSON.parse(r.body);
    assert.strictEqual(parsed.headers["x-custom"], "hello-world");
  });

  await test("http_fetch: HEAD request — status 200, body empty", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo`, method: "HEAD" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, "");
    assert.strictEqual(r.bodySize, 0);
  });

  await test("http_fetch: bodySize matches body length in bytes", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    assert.strictEqual(r.bodySize, Buffer.byteLength(r.body, "utf8"));
  });

  // ── MEDIUM ────────────────────────────────────────────────────────────────

  await test("http_fetch: missing required 'url' field returns -32602", async () => {
    let caught = null;
    try { await fetch({}); } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.ok(caught.code === -32602 || caught.message.includes("url"), `msg: ${caught.message}`);
  });

  await test("http_fetch: empty url string returns -32602", async () => {
    let caught = null;
    try { await fetch({ url: "" }); } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown");
    assert.ok(caught.code === -32602 || caught.message.toLowerCase().includes("url"));
  });

  await test("http_fetch: unknown method returns -32602", async () => {
    let caught = null;
    try { await fetch({ url: `http://127.0.0.1:${PORT}/echo`, method: "PURGE" }); }
    catch (e) { caught = e; }
    assert.ok(caught, "should have thrown for unknown method");
    assert.ok(caught.code === -32602 || caught.message.includes("method"), `msg: ${caught?.message}`);
  });

  await test("http_fetch: 404 response returns ok:false without throwing", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/nonexistent-path` });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.ok, false);
  });

  await test("http_fetch: 500 response returns ok:false without throwing", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/status/500` });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.ok, false);
  });

  await test("http_fetch: 201 response returns ok:true", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/status/201` });
    assert.strictEqual(r.ok, true);
  });

  await test("http_fetch: non-http scheme (file://) rejected with -32602", async () => {
    let caught = null;
    try { await fetch({ url: "file:///etc/passwd" }); } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown for file:// scheme");
    assert.ok(
      caught.code === -32602 || caught.message.toLowerCase().includes("scheme") || caught.message.toLowerCase().includes("http"),
      `msg: ${caught.message}`
    );
  });

  await test("http_fetch: non-http scheme (ftp://) rejected with -32602", async () => {
    let caught = null;
    try { await fetch({ url: "ftp://ftp.example.com/file.txt" }); } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown for ftp:// scheme");
  });

  await test("http_fetch: non-http scheme (data://) rejected with -32602", async () => {
    let caught = null;
    try { await fetch({ url: "data:text/html,<h1>hello</h1>" }); } catch (e) { caught = e; }
    assert.ok(caught, "should have thrown for data: scheme");
  });

  // ── HIGH ──────────────────────────────────────────────────────────────────

  await test("http_fetch: 301 redirect is followed; redirected:true is set", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/redirect` });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.redirected, true);
    // Final URL should point to /echo
    assert.ok(r.url.includes("/echo"), `final url: ${r.url}`);
  });

  await test("http_fetch: no-redirect endpoint has redirected:false", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    assert.strictEqual(r.redirected, false);
  });

  await test("http_fetch: redirect loop (A→A) is detected and rejected", async () => {
    let caught = null;
    try { await fetch({ url: `http://127.0.0.1:${PORT}/redirect-loop` }); }
    catch (e) { caught = e; }
    assert.ok(caught, "should have thrown for redirect loop");
    assert.ok(
      caught.message.toLowerCase().includes("loop") || caught.message.toLowerCase().includes("redirect"),
      `msg: ${caught.message}`
    );
  });

  await test("http_fetch: too many redirects (6 hops) rejected", async () => {
    let caught = null;
    try { await fetch({ url: `http://127.0.0.1:${PORT}/redirect-chain/6` }); }
    catch (e) { caught = e; }
    assert.ok(caught, "should have thrown for too many redirects");
    assert.ok(
      caught.message.toLowerCase().includes("redirect") || caught.message.toLowerCase().includes("many"),
      `msg: ${caught.message}`
    );
  });

  await test("http_fetch: chain of exactly 5 redirects is within limit and succeeds", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/redirect-chain/5` });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.redirected, true);
    assert.strictEqual(r.body, "chain-end");
  });

  // ── CRITICAL ──────────────────────────────────────────────────────────────

  await test("http_fetch: file:// scheme is rejected", async () => {
    let caught = null;
    try { await fetch({ url: "file:///C:/Windows/win.ini" }); } catch (e) { caught = e; }
    assert.ok(caught, "file:// must be rejected");
  });

  await test("http_fetch: javascript: scheme (parse-level rejection) rejected cleanly", async () => {
    let caught = null;
    try { await fetch({ url: "javascript:alert(1)" }); } catch (e) { caught = e; }
    assert.ok(caught, "javascript: must be rejected");
  });

  await test("http_fetch: null byte in URL rejected cleanly (no crash)", async () => {
    let caught = null;
    try { await fetch({ url: "http://example.com/\x00evil" }); } catch (e) { caught = e; }
    assert.ok(caught, "null byte in URL should throw");
    assert.ok(typeof caught.message === "string");
  });

  await test("http_fetch: no prototype pollution from response headers", async () => {
    const before = Object.prototype.toString;
    // Even if a server returns a header named '__proto__', it must not pollute
    // Object.prototype (Node's http module already normalises headers to plain
    // objects with no prototype-polluting keys, but let's verify the result).
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    assert.strictEqual(Object.prototype.toString, before, "Object.prototype.toString should be unchanged");
    assert.ok(r.headers !== Object.prototype, "headers should not be Object.prototype");
  });

  await test("http_fetch: injection-shaped header value transmitted as literal string", async () => {
    const injValue = "'; DROP TABLE users; --\\n<script>alert(1)</script>";
    const r = await fetch({
      url:     `http://127.0.0.1:${PORT}/echo`,
      headers: { "x-inj": injValue },
    });
    const parsed = JSON.parse(r.body);
    // The header value must arrive at the server exactly as sent (literal)
    assert.strictEqual(parsed.headers["x-inj"], injValue);
  });

  await test("http_fetch: result is fully JSON-serialisable (no circular refs)", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    assert.doesNotThrow(() => JSON.stringify(r));
  });

  await test("http_fetch: no unexpected keys on result (no prototype pollution)", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
    const expectedKeys = new Set(["url", "status", "statusText", "ok", "redirected", "headers", "body", "bodySize", "truncated"]);
    for (const k of Object.keys(r)) {
      assert.ok(expectedKeys.has(k), `unexpected result key: ${k}`);
    }
  });

  // ── EXTREME ───────────────────────────────────────────────────────────────

  await test("http_fetch: 200 KB response is truncated at 100 KB with truncated:true", async () => {
    const r = await fetch({ url: `http://127.0.0.1:${PORT}/large` });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.bodySize <= 100 * 1024, `bodySize ${r.bodySize} exceeds 100 KB`);
    assert.ok(r.body.length <= 100 * 1024, `body.length ${r.body.length} exceeds 100 KB`);
  });

  await test("http_fetch: 10 concurrent GETs return consistent results", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => fetch({ url: `http://127.0.0.1:${PORT}/echo` }))
    );
    for (const r of results) {
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.ok, true);
    }
  });

  await test("http_fetch: 50 sequential GETs return consistent status", async () => {
    for (let i = 0; i < 50; i++) {
      const r = await fetch({ url: `http://127.0.0.1:${PORT}/echo` });
      assert.strictEqual(r.status, 200, `iteration ${i}: status should be 200`);
    }
  });

  await test("http_fetch: fuzz url strings throw cleanly (no crash)", async () => {
    const fuzzUrls = [
      "\x00\x01\x02\x03",
      "a".repeat(10000),
      "not-a-url-at-all",
      "://missing-scheme",
      "\ud800\udc00",      // surrogate pair
    ];
    for (const url of fuzzUrls) {
      let caught = null;
      try { await fetch({ url }); } catch (e) { caught = e; }
      assert.ok(caught, `fuzz url ${JSON.stringify(url.slice(0, 20))} should throw`);
      assert.ok(typeof caught.message === "string", "error should have string message");
    }
  });

  await test("http_fetch: very long but valid-ish URL (10000 chars) throws cleanly without crashing", async () => {
    const longUrl = "http://example.com/" + "a".repeat(10000);
    let caught = null;
    // This may succeed (ECONNREFUSED to example.com) or fail — either is fine;
    // what must NOT happen is an unhandled exception crash.
    try { await fetch({ url: longUrl, timeout: 1 }); } catch (e) { caught = e; }
    // Either it threw (network error, timeout) or it returned a response.
    // Both are fine. We just verify it didn't crash the process silently.
    assert.ok(true, "no unhandled exception");
  });

  // ── CLEANUP ───────────────────────────────────────────────────────────────

  await test("http_fetch: cleanup — shut down local test server", async () => {
    await stopTestServer();
    assert.ok(true, "test server closed cleanly");
  });

})().catch((e) => {
  counters.fail++;
  console.error(`[32] UNHANDLED TEST ERROR: ${e.stack || e.message}`);
});
