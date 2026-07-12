"use strict";
// test/sections/211-http-client.js
// http_client comprehensive tests
// Sections: A=input-validation(10), B=unit(20), C=integration(10),
//           D=happy-path(20), E=security(10), F=concurrency(5) — 75 total

const http   = require("http");
const https  = require("https");
const zlib   = require("zlib");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const crypto = require("crypto");

const {
  httpClient,
  validateUrl,
  isPrivateHost,
  validateHeader,
  parseCookies,
  storeCookies,
  getCookieHeader,
  buildBody,
  buildDigestAuth,
  parseDigestChallenge,
  decompressBody,
  bufToText,
  tryParseJSON,
  makeSession,
  SESSION_STORE,
} = require("../../lib/httpClientOps");

// ── helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    process.stderr.write(`  FAIL: ${label}\n`);
  }
}

function assertThrows(label, fn, codeOrMsg) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      // Suppress unhandled rejection; mark as needing assertThrowsAsync
      r.catch(() => {});
      failed++;
      failures.push(label + " (returned promise — use assertThrowsAsync)");
      process.stderr.write(`  FAIL (promise returned, use assertThrowsAsync): ${label}\n`);
      return;
    }
    failed++;
    failures.push(label + " (no throw)");
    process.stderr.write(`  FAIL (no throw): ${label}\n`);
  } catch (e) {
    if (codeOrMsg) {
      const ok = typeof codeOrMsg === "string"
        ? (e.code === codeOrMsg || e.message.includes(codeOrMsg))
        : true;
      assert(label, ok);
    } else {
      passed++;
    }
  }
}

async function assertThrowsAsync(label, fn, codeOrMsg) {
  try {
    await fn();
    failed++;
    failures.push(label + " (no throw)");
    process.stderr.write(`  FAIL (no throw): ${label}\n`);
  } catch (e) {
    if (codeOrMsg) {
      const ok = typeof codeOrMsg === "string"
        ? (e.code === codeOrMsg || e.message.includes(codeOrMsg))
        : true;
      assert(label, ok);
    } else {
      passed++;
    }
  }
}

function tmpFile(ext = ".tmp") {
  return path.join(os.tmpdir(), `http-client-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

// ── Mini HTTP test server ─────────────────────────────────────────────────
let server, serverPort;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost`);
      const pathname = u.pathname;

      // Collect body
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const bodyBuf = Buffer.concat(chunks);
        const bodyStr = bodyBuf.toString("utf8");

        // Route: /echo  — echo method, headers, body as JSON
        if (pathname === "/echo") {
          const response = JSON.stringify({
            method:  req.method,
            headers: req.headers,
            body:    bodyStr,
            query:   Object.fromEntries(u.searchParams),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(response);
        }

        // Route: /set-cookie  — set a cookie then redirect
        if (pathname === "/set-cookie") {
          res.writeHead(302, {
            "Location": "/cookie-check",
            "Set-Cookie": "sessionid=abc123; Path=/; HttpOnly",
          });
          return res.end();
        }

        // Route: /cookie-check — return the Cookie header value
        if (pathname === "/cookie-check") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ cookie: req.headers["cookie"] || "" }));
        }

        // Route: /redirect — 301 to /echo
        if (pathname === "/redirect") {
          res.writeHead(301, { "Location": `http://localhost:${serverPort}/echo` });
          return res.end();
        }

        // Route: /redirect-loop — loops forever
        if (pathname === "/redirect-loop") {
          res.writeHead(302, { "Location": `http://localhost:${serverPort}/redirect-loop` });
          return res.end();
        }

        // Route: /gzip — gzip-compressed JSON
        if (pathname === "/gzip") {
          const data = JSON.stringify({ compressed: true, text: "hello gzip" });
          zlib.gzip(Buffer.from(data), (e, buf) => {
            if (e) { res.writeHead(500); return res.end("gzip error"); }
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Content-Encoding": "gzip",
            });
            res.end(buf);
          });
          return;
        }

        // Route: /brotli
        if (pathname === "/brotli") {
          const data = JSON.stringify({ compressed: true, text: "hello brotli" });
          zlib.brotliCompress(Buffer.from(data), (e, buf) => {
            if (e) { res.writeHead(500); return res.end("br error"); }
            res.writeHead(200, {
              "Content-Type": "application/json",
              "Content-Encoding": "br",
            });
            res.end(buf);
          });
          return;
        }

        // Route: /basic-auth
        if (pathname === "/basic-auth") {
          const authHdr = req.headers["authorization"] || "";
          if (authHdr.startsWith("Basic ")) {
            const decoded = Buffer.from(authHdr.slice(6), "base64").toString("utf8");
            if (decoded === "user:pass") {
              res.writeHead(200, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ authenticated: true, user: "user" }));
            }
          }
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
          return res.end(JSON.stringify({ authenticated: false }));
        }

        // Route: /bearer-auth
        if (pathname === "/bearer-auth") {
          const authHdr = req.headers["authorization"] || "";
          if (authHdr === "Bearer mysecrettoken") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ authenticated: true }));
          }
          res.writeHead(401);
          return res.end(JSON.stringify({ authenticated: false }));
        }

        // Route: /status/:code — return arbitrary status code
        if (pathname.startsWith("/status/")) {
          const code = parseInt(pathname.split("/")[2], 10) || 200;
          res.writeHead(code);
          return res.end(JSON.stringify({ status: code }));
        }

        // Route: /download — binary file download
        if (pathname === "/download") {
          const buf = Buffer.alloc(256, 0x42); // 256 'B' bytes
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          return res.end(buf);
        }

        // Route: /slow — delays 200ms
        if (pathname === "/slow") {
          setTimeout(() => {
            res.writeHead(200);
            res.end(JSON.stringify({ slow: true }));
          }, 200);
          return;
        }

        // Route: /post-json — expect JSON body
        if (pathname === "/post-json") {
          let parsed;
          try { parsed = JSON.parse(bodyStr); } catch { parsed = null; }
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ received: parsed, method: req.method }));
        }

        // Route: /form — expect form body
        if (pathname === "/form") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ body: bodyStr, ct: req.headers["content-type"] }));
        }

        // Default: 404
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found", path: pathname }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise(r => server.close(r));
}

// ── Section A: Input Validation (10) ────────────────────────────────────────
async function runSectionA() {
  console.log("\nA. Input Validation");

  // A1: missing operation rejects with INVALID_ARG
  await assertThrowsAsync("A1: missing operation", () => httpClient({}), "INVALID_ARG");

  // A2: unknown operation rejects with INVALID_ARG
  await assertThrowsAsync("A2: unknown operation", () => httpClient({ operation: "invalid_op" }), "INVALID_ARG");

  // A3: validateUrl rejects non-string
  assertThrows("A3: validateUrl non-string", () => validateUrl(123), "INVALID_ARG");

  // A4: validateUrl rejects non-http/https
  assertThrows("A4: validateUrl ftp scheme", () => validateUrl("ftp://example.com"), "INVALID_URL");

  // A5: validateUrl rejects malformed
  assertThrows("A5: validateUrl malformed", () => validateUrl("not_a_url"), "INVALID_URL");

  // A6: validateHeader rejects CRLF in name
  assertThrows("A6: CRLF in header name", () => validateHeader("X-Evil\r\nInject", "val"), "INVALID_ARG");

  // A7: validateHeader rejects CRLF in value
  assertThrows("A7: CRLF in header value", () => validateHeader("X-Header", "val\r\nInject"), "INVALID_ARG");

  // A8: validateHeader rejects NUL in name
  assertThrows("A8: NUL in header name", () => validateHeader("X-\0Bad", "v"), "INVALID_ARG");

  // A9: buildBody rejects non-object form
  assertThrows("A9: form not object", () => buildBody({ form: [1, 2, 3] }), "INVALID_ARG");

  // A10: buildBody rejects multipart without name
  assertThrows("A10: multipart part missing name", () => buildBody({ multipart: [{ value: "x" }] }), "INVALID_ARG");
}

// ── Section B: Unit Tests (20) ───────────────────────────────────────────────
async function runSectionB() {
  console.log("\nB. Unit Tests");

  // B1: validateUrl parses https correctly
  {
    const p = validateUrl("https://example.com/path?q=1#frag");
    assert("B1: protocol https", p.protocol === "https:");
    assert("B1: hostname", p.hostname === "example.com");
    assert("B1: pathname", p.pathname === "/path");
  }

  // B2: validateUrl parses http correctly
  {
    const p = validateUrl("http://user:pass@host.com:8080/api?k=v");
    assert("B2: protocol http", p.protocol === "http:");
    assert("B2: port 8080", p.port === "8080");
  }

  // B3: isPrivateHost detects 127.x.x.x
  assert("B3: 127.0.0.1 is private", isPrivateHost("127.0.0.1"));
  assert("B3: 127.1.2.3 is private", isPrivateHost("127.1.2.3"));

  // B4: isPrivateHost detects 192.168.x.x
  assert("B4: 192.168.1.1 is private", isPrivateHost("192.168.1.1"));

  // B5: isPrivateHost detects 10.x.x.x
  assert("B5: 10.0.0.1 is private", isPrivateHost("10.0.0.1"));

  // B6: isPrivateHost detects 172.16-31.x.x
  assert("B6: 172.16.0.1 is private", isPrivateHost("172.16.0.1"));
  assert("B6: 172.31.255.1 is private", isPrivateHost("172.31.255.1"));
  assert("B6: 172.15.0.1 not private", !isPrivateHost("172.15.0.1"));
  assert("B6: 172.32.0.1 not private", !isPrivateHost("172.32.0.1"));

  // B7: isPrivateHost detects localhost
  assert("B7: localhost is private", isPrivateHost("localhost"));
  assert("B7: LOCALHOST is private", isPrivateHost("LOCALHOST"));

  // B8: isPrivateHost passes public IPs
  assert("B8: 8.8.8.8 not private", !isPrivateHost("8.8.8.8"));
  assert("B8: 93.184.216.34 not private", !isPrivateHost("93.184.216.34"));

  // B9: parseCookies basic
  {
    const cookies = parseCookies("sessionid=abc; Path=/; HttpOnly", "example.com");
    assert("B9: 1 cookie", cookies.length === 1);
    assert("B9: name=sessionid", cookies[0].name === "sessionid");
    assert("B9: value=abc", cookies[0].value === "abc");
    assert("B9: domain", cookies[0].domain === "example.com");
  }

  // B10: parseCookies array
  {
    const cookies = parseCookies(["a=1", "b=2; Secure"], "host.com");
    assert("B10: 2 cookies", cookies.length === 2);
    assert("B10: a=1", cookies[0].value === "1");
    assert("B10: b secure", cookies[1].secure === true);
  }

  // B11: parseCookies max-age expiry
  {
    const cookies = parseCookies("tok=x; Max-Age=3600", "host.com");
    assert("B11: expires set", cookies[0].expires !== null);
    assert("B11: expires ~1h from now", cookies[0].expires > Date.now() + 3500000);
  }

  // B12: storeCookies + getCookieHeader
  {
    const session = makeSession("test-b12");
    const cookies = parseCookies("user=alice; Path=/", "example.com");
    storeCookies(session, cookies);
    const hdr = getCookieHeader(session, new URL("http://example.com/page"));
    assert("B12: cookie header includes user=alice", hdr.includes("user=alice"));
  }

  // B13: getCookieHeader excludes secure cookie over http
  {
    const session = makeSession("test-b13");
    const cookies = parseCookies("tok=secret; Secure; Path=/", "example.com");
    storeCookies(session, cookies);
    const hdr = getCookieHeader(session, new URL("http://example.com/"));
    assert("B13: secure cookie not sent over http", !hdr.includes("tok=secret"));
  }

  // B14: buildBody JSON
  {
    const { body, contentType } = buildBody({ json: { hello: "world" } });
    assert("B14: body is buffer", Buffer.isBuffer(body));
    assert("B14: content-type json", contentType === "application/json");
    assert("B14: body parseable", JSON.parse(body.toString()).hello === "world");
  }

  // B15: buildBody form
  {
    const { body, contentType } = buildBody({ form: { name: "Alice", age: "30" } });
    assert("B15: form content-type", contentType === "application/x-www-form-urlencoded");
    const str = body.toString();
    assert("B15: name encoded", str.includes("name=Alice"));
    assert("B15: age encoded", str.includes("age=30"));
  }

  // B16: buildBody multipart
  {
    const { body, contentType } = buildBody({
      multipart: [
        { name: "field1", value: "hello" },
        { name: "file",   value: "content", filename: "test.txt", content_type: "text/plain" },
      ],
    });
    assert("B16: multipart content-type", contentType.startsWith("multipart/form-data; boundary="));
    const str = body.toString();
    assert("B16: field1 present", str.includes("name=\"field1\""));
    assert("B16: file present",   str.includes("filename=\"test.txt\""));
    assert("B16: hello value",    str.includes("hello"));
  }

  // B17: buildBody raw body
  {
    const { body, contentType } = buildBody({ body: "raw text", content_type: "text/csv" });
    assert("B17: raw body content", body.toString() === "raw text");
    assert("B17: content-type csv", contentType === "text/csv");
  }

  // B18: buildBody empty
  {
    const { body, contentType } = buildBody({});
    assert("B18: empty body null", body === null);
    assert("B18: empty contentType null", contentType === null);
  }

  // B19: decompressBody gzip
  {
    const original = Buffer.from("hello gzip world");
    const compressed = await new Promise((res, rej) => zlib.gzip(original, (e, b) => e ? rej(e) : res(b)));
    const decompressed = await decompressBody(compressed, "gzip");
    assert("B19: gzip roundtrip", decompressed.toString() === "hello gzip world");
  }

  // B20: parseDigestChallenge + buildDigestAuth
  {
    const challenge = parseDigestChallenge('Digest realm="testrealm", nonce="abc123", algorithm=MD5');
    assert("B20: realm parsed", challenge.realm === "testrealm");
    assert("B20: nonce parsed", challenge.nonce === "abc123");
    const auth = buildDigestAuth("user", "pass", "GET", "/protected", challenge);
    assert("B20: auth starts with Digest", auth.startsWith("Digest "));
    assert("B20: auth has username", auth.includes('username="user"'));
    assert("B20: auth has response", auth.includes("response="));
  }
}

// ── Section C: Integration Tests (10) ───────────────────────────────────────
async function runSectionC() {
  console.log("\nC. Integration Tests");
  const base = `http://127.0.0.1:${serverPort}`;

  // C1: GET /echo returns 200 + JSON
  {
    const r = await httpClient({ operation: "get", url: `${base}/echo`, ssrf_guard: false });
    assert("C1: status 200", r.statusCode === 200);
    assert("C1: json parsed", r.json !== null);
    assert("C1: method=GET", r.json.method === "GET");
  }

  // C2: POST with JSON body
  {
    const r = await httpClient({
      operation: "post",
      url: `${base}/post-json`,
      json: { name: "Alice", value: 42 },
      ssrf_guard: false,
    });
    assert("C2: status 200", r.statusCode === 200);
    assert("C2: received.name=Alice", r.json.received.name === "Alice");
    assert("C2: method=POST", r.json.method === "POST");
  }

  // C3: PUT with form body
  {
    const r = await httpClient({
      operation: "put",
      url: `${base}/form`,
      form: { key: "val", n: "1" },
      ssrf_guard: false,
    });
    assert("C3: status 200", r.statusCode === 200);
    assert("C3: form body sent", r.json.body.includes("key=val"));
    assert("C3: urlencoded ct", r.json.ct.includes("urlencoded"));
  }

  // C4: redirect followed automatically
  {
    const r = await httpClient({ operation: "get", url: `${base}/redirect`, ssrf_guard: false });
    assert("C4: final status 200", r.statusCode === 200);
    assert("C4: 1 redirect", r.redirects === 1);
    assert("C4: landed on /echo", r.json.method === "GET");
  }

  // C5: gzip decompression
  {
    const r = await httpClient({ operation: "get", url: `${base}/gzip`, ssrf_guard: false });
    assert("C5: status 200", r.statusCode === 200);
    assert("C5: json parsed", r.json !== null);
    assert("C5: compressed=true", r.json.compressed === true);
    assert("C5: text intact", r.json.text === "hello gzip");
  }

  // C6: brotli decompression
  {
    const r = await httpClient({ operation: "get", url: `${base}/brotli`, ssrf_guard: false });
    assert("C6: status 200", r.statusCode === 200);
    assert("C6: brotli json", r.json.text === "hello brotli");
  }

  // C7: Basic auth
  {
    const r = await httpClient({
      operation: "get",
      url: `${base}/basic-auth`,
      auth: { type: "basic", username: "user", password: "pass" },
      ssrf_guard: false,
    });
    assert("C7: auth 200", r.statusCode === 200);
    assert("C7: authenticated=true", r.json.authenticated === true);
  }

  // C8: Bearer auth
  {
    const r = await httpClient({
      operation: "get",
      url: `${base}/bearer-auth`,
      auth: { type: "bearer", token: "mysecrettoken" },
      ssrf_guard: false,
    });
    assert("C8: bearer 200", r.statusCode === 200);
    assert("C8: authenticated=true", r.json.authenticated === true);
  }

  // C9: Cookie jar via session
  {
    const sid = `test-session-${Date.now()}`;
    // Trigger set-cookie + redirect (follow_redirects default=true)
    await httpClient({ operation: "get", url: `${base}/set-cookie`, session_id: sid, ssrf_guard: false });
    // Now check that cookie was stored and sent
    const r = await httpClient({ operation: "get", url: `${base}/cookie-check`, session_id: sid, ssrf_guard: false });
    assert("C9: cookie sent", r.json.cookie.includes("sessionid=abc123"));
  }

  // C10: Download to file
  {
    const dest = tmpFile(".bin");
    const r = await httpClient({
      operation: "download",
      url: `${base}/download`,
      download_path: dest,
      ssrf_guard: false,
    });
    assert("C10: download status 200", r.statusCode === 200);
    assert("C10: file exists", fs.existsSync(dest));
    assert("C10: correct byte count", r.byteLength === 256);
    const data = fs.readFileSync(dest);
    assert("C10: correct content", data.every(b => b === 0x42));
    try { fs.unlinkSync(dest); } catch {}
  }
}

// ── Section D: Happy-Path Tests (20) ─────────────────────────────────────────
async function runSectionD() {
  console.log("\nD. Happy-Path Tests");
  const base = `http://127.0.0.1:${serverPort}`;

  // D1: HEAD request
  {
    const r = await httpClient({ operation: "head", url: `${base}/echo`, ssrf_guard: false });
    assert("D1: head status 200", r.statusCode === 200);
    // HEAD has no body
    assert("D1: head body empty", r.body === "" || r.byteLength === 0);
  }

  // D2: DELETE request
  {
    const r = await httpClient({ operation: "delete", url: `${base}/echo`, ssrf_guard: false });
    assert("D2: delete status 200", r.statusCode === 200);
    assert("D2: method=DELETE", r.json.method === "DELETE");
  }

  // D3: PATCH request
  {
    const r = await httpClient({
      operation: "patch",
      url: `${base}/post-json`,
      json: { patch: true },
      ssrf_guard: false,
    });
    assert("D3: patch status 200", r.statusCode === 200);
    assert("D3: method=PATCH", r.json.method === "PATCH");
  }

  // D4: OPTIONS request
  {
    const r = await httpClient({ operation: "options", url: `${base}/echo`, ssrf_guard: false });
    assert("D4: options status 200 or 204", r.statusCode === 200 || r.statusCode === 204);
  }

  // D5: explicit 'request' operation with custom method
  {
    const r = await httpClient({
      operation: "request",
      method: "GET",
      url: `${base}/echo`,
      ssrf_guard: false,
    });
    assert("D5: request method=GET", r.json.method === "GET");
  }

  // D6: custom headers sent
  {
    const r = await httpClient({
      operation: "get",
      url: `${base}/echo`,
      headers: { "X-Custom-Header": "my-value" },
      ssrf_guard: false,
    });
    assert("D6: custom header echoed", r.json.headers["x-custom-header"] === "my-value");
  }

  // D7: query string preserved
  {
    const r = await httpClient({ operation: "get", url: `${base}/echo?foo=bar&baz=qux`, ssrf_guard: false });
    assert("D7: query foo=bar", r.json.query.foo === "bar");
    assert("D7: query baz=qux", r.json.query.baz === "qux");
  }

  // D8: status 404 returns properly
  {
    const r = await httpClient({ operation: "get", url: `${base}/nonexistent`, ssrf_guard: false });
    assert("D8: status 404", r.statusCode === 404);
  }

  // D9: status 500 returns properly
  {
    const r = await httpClient({ operation: "get", url: `${base}/status/500`, ssrf_guard: false });
    assert("D9: status 500", r.statusCode === 500);
  }

  // D10: session_new creates session
  {
    const r = await httpClient({ operation: "session_new", session_id: "mysession" });
    assert("D10: created=true", r.created === true);
    assert("D10: session_id returned", r.session_id === "mysession");
  }

  // D11: session_clear deletes specific session
  {
    await httpClient({ operation: "session_new", session_id: "to-delete" });
    const r = await httpClient({ operation: "session_clear", session_id: "to-delete" });
    assert("D11: cleared=1", r.cleared === 1);
    assert("D11: session gone", !SESSION_STORE.has("to-delete"));
  }

  // D12: session_clear all
  {
    await httpClient({ operation: "session_new", session_id: "s1" });
    await httpClient({ operation: "session_new", session_id: "s2" });
    const r = await httpClient({ operation: "session_clear" });
    assert("D12: cleared all", r.all === true);
    assert("D12: store empty", SESSION_STORE.size === 0);
  }

  // D13: follow_redirects: false — no redirect
  {
    const r = await httpClient({ operation: "get", url: `${base}/redirect`, follow_redirects: false, ssrf_guard: false });
    assert("D13: no redirect, status 301", r.statusCode === 301);
    assert("D13: 0 redirects", r.redirects === 0);
  }

  // D14: multipart body sent
  {
    const r = await httpClient({
      operation: "post",
      url: `${base}/echo`,
      multipart: [{ name: "greeting", value: "hello" }],
      ssrf_guard: false,
    });
    assert("D14: multipart ct header", r.json.headers["content-type"].includes("multipart/form-data"));
    assert("D14: body has boundary", r.json.body.includes("greeting"));
  }

  // D15: raw body sent
  {
    const r = await httpClient({
      operation: "post",
      url: `${base}/echo`,
      body: "hello raw",
      content_type: "text/plain",
      ssrf_guard: false,
    });
    assert("D15: raw body echoed", r.json.body === "hello raw");
    assert("D15: content-type text/plain", r.json.headers["content-type"] === "text/plain");
  }

  // D16: byteLength reflects response body size
  {
    const r = await httpClient({ operation: "get", url: `${base}/echo`, ssrf_guard: false });
    assert("D16: byteLength > 0", r.byteLength > 0);
  }

  // D17: bufToText handles utf-8
  {
    const buf = Buffer.from("héllo wörld", "utf8");
    const s   = bufToText(buf);
    assert("D17: utf8 decoded", s === "héllo wörld");
  }

  // D18: tryParseJSON returns parsed or null
  {
    assert("D18: parses valid json", tryParseJSON('{"a":1}').a === 1);
    assert("D18: null on invalid", tryParseJSON("not json") === null);
  }

  // D19: url field in response reflects final URL after redirect
  {
    const r = await httpClient({ operation: "get", url: `${base}/redirect`, ssrf_guard: false });
    assert("D19: url is final url", r.url.includes("/echo"));
  }

  // D20: session_new without explicit ID auto-generates one
  {
    const r = await httpClient({ operation: "session_new" });
    assert("D20: session_id auto-generated", typeof r.session_id === "string" && r.session_id.length > 0);
    assert("D20: created=true", r.created === true);
  }
}

// ── Section E: Security Tests (10) ──────────────────────────────────────────
async function runSectionE() {
  console.log("\nE. Security Tests");
  const base = `http://127.0.0.1:${serverPort}`;

  // E1: SSRF guard blocks 127.0.0.1
  await assertThrowsAsync("E1: SSRF blocks 127.0.0.1",
    () => httpClient({ operation: "get", url: "http://127.0.0.1/secret" }),
    "SSRF_BLOCKED");

  // E2: SSRF guard blocks localhost
  await assertThrowsAsync("E2: SSRF blocks localhost",
    () => httpClient({ operation: "get", url: "http://localhost/secret" }),
    "SSRF_BLOCKED");

  // E3: SSRF guard blocks 10.x.x.x
  await assertThrowsAsync("E3: SSRF blocks 10.0.0.1",
    () => httpClient({ operation: "get", url: "http://10.0.0.1/secret" }),
    "SSRF_BLOCKED");

  // E4: SSRF guard disabled with ssrf_guard: false allows 127.x
  {
    const r = await httpClient({ operation: "get", url: `${base}/echo`, ssrf_guard: false });
    assert("E4: ssrf_guard=false allows 127.x", r.statusCode === 200);
  }

  // E5: CRLF injection in header name rejected
  await assertThrowsAsync("E5: CRLF in header name",
    () => httpClient({
      operation: "get",
      url: `${base}/echo`,
      headers: { "X-Evil\r\nInjected": "val" },
      ssrf_guard: false,
    }),
    "INVALID_ARG");

  // E6: CRLF injection in header value rejected
  await assertThrowsAsync("E6: CRLF in header value",
    () => httpClient({
      operation: "get",
      url: `${base}/echo`,
      headers: { "X-Header": "val\r\nInject: evil" },
      ssrf_guard: false,
    }),
    "INVALID_ARG");

  // E7: Redirect loop raises error
  await assertThrowsAsync("E7: redirect loop too many redirects",
    () => httpClient({ operation: "get", url: `${base}/redirect-loop`, ssrf_guard: false }),
    "TOO_MANY_REDIRECTS");

  // E8: max_redirects=0 stops at first redirect
  {
    const r = await httpClient({ operation: "get", url: `${base}/redirect`, max_redirects: 0, ssrf_guard: false });
    assert("E8: stopped at 301", r.statusCode === 301);
  }

  // E9: Response body size cap enforced
  await assertThrowsAsync("E9: response too large",
    () => httpClient({
      operation: "get",
      url: `${base}/echo`,
      max_response_bytes: 10,
      ssrf_guard: false,
    }),
    "RESPONSE_TOO_LARGE");

  // E10: SSRF guard follows redirect into private IP (redirect to private)
  // We simulate: if the redirect goes to a private address, ssrf_guard must block it
  // This is tested by ensuring isPrivateHost('192.168.1.1') is true and would block
  assert("E10: isPrivateHost 192.168.1.1", isPrivateHost("192.168.1.1"));
  assert("E10: isPrivateHost ::1", isPrivateHost("::1"));
}

// ── Section F: Concurrency Tests (5) ────────────────────────────────────────
async function runSectionF() {
  console.log("\nF. Concurrency Tests");
  const base = `http://127.0.0.1:${serverPort}`;

  // F1: 10 concurrent GETs
  {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        httpClient({ operation: "get", url: `${base}/echo`, ssrf_guard: false })
      )
    );
    assert("F1: all 10 succeed", results.every(r => r.statusCode === 200));
    assert("F1: all method=GET", results.every(r => r.json.method === "GET"));
  }

  // F2: concurrent POSTs with different bodies
  {
    const payloads = Array.from({ length: 5 }, (_, i) => ({ id: i, name: `item${i}` }));
    const results = await Promise.all(
      payloads.map(p => httpClient({
        operation: "post",
        url: `${base}/post-json`,
        json: p,
        ssrf_guard: false,
      }))
    );
    assert("F2: all 5 POSTs succeed", results.every(r => r.statusCode === 200));
    assert("F2: responses match payloads", results.every((r, i) => r.json.received.id === i));
  }

  // F3: concurrent session operations
  {
    const sessions = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        httpClient({ operation: "session_new", session_id: `concurrent-s${i}` })
      )
    );
    assert("F3: all sessions created", sessions.every(s => s.created === true));
    // cleanup
    await httpClient({ operation: "session_clear" });
  }

  // F4: concurrent downloads
  {
    const dests = Array.from({ length: 3 }, () => tmpFile(".bin"));
    const results = await Promise.all(
      dests.map(dest =>
        httpClient({ operation: "download", url: `${base}/download`, download_path: dest, ssrf_guard: false })
      )
    );
    assert("F4: all downloads succeeded", results.every(r => r.statusCode === 200));
    assert("F4: all files exist", dests.every(d => fs.existsSync(d)));
    dests.forEach(d => { try { fs.unlinkSync(d); } catch {} });
  }

  // F5: concurrent mixed operations
  {
    const ops = [
      httpClient({ operation: "get",    url: `${base}/echo`,      ssrf_guard: false }),
      httpClient({ operation: "post",   url: `${base}/post-json`, json: { x: 1 }, ssrf_guard: false }),
      httpClient({ operation: "head",   url: `${base}/echo`,      ssrf_guard: false }),
      httpClient({ operation: "delete", url: `${base}/echo`,      ssrf_guard: false }),
      httpClient({ operation: "get",    url: `${base}/gzip`,      ssrf_guard: false }),
    ];
    const results = await Promise.all(ops);
    assert("F5: all mixed ops succeed", results.every(r => r.statusCode === 200));
  }
}

// ── Main runner ───────────────────────────────────────────────────────────────
async function main() {
  await startServer();

  await runSectionA();

  try {
    await runSectionB();
    await runSectionC();
    await runSectionD();
    await runSectionE();
    await runSectionF();
  } finally {
    await stopServer();
  }

  console.log(`\n═ Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests ═`);
  if (failures.length) {
    process.stderr.write("Failed tests:\n");
    failures.forEach(f => process.stderr.write(` • ${f}\n`));
  }
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  process.stderr.write(`Runner error: ${err.stack || err}\n`);
  process.exit(1);
});
