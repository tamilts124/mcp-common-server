"use strict";
/**
 * Section 259 — sip_client tests
 *
 * Five rigor levels:
 *   A  Pure-helper / unit functions          (x40)
 *   B  Input validation                      (x15)
 *   C  Mock-network (loopback UDP/dgram)     (x13)
 *   D  Security / injection guards           (x10)
 *   E  Concurrency / stress                  (x8)
 *
 * Total: 86 tests
 */

const assert = require("assert");
const dgram  = require("dgram");

const {
  sipClient,
  parseSipUri,
  formatSipUri,
  buildRequest,
  parseResponse,
  parseWwwAuthenticate,
  buildDigestAuth,
  expandCompactHeader,
  isCompleteResponse,
  randomBranch,
  randomCallId,
  randomTag,
  clampTimeout,
  guardNul,
  describeStatus,
  SIP_DEFAULT_PORT,
  SIPS_DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  MAGIC_COOKIE,
} = require("../../lib/sipClientOps");

let passed = 0;
let failed = 0;
const errors = [];

function ok(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    errors.push(label);
    process.stderr.write(`  FAIL: ${label}\n`);
  }
}

async function rejects(fn, pattern, label) {
  try {
    await fn();
    failed++;
    errors.push(`${label} (expected rejection, got none)`);
    process.stderr.write(`  FAIL: ${label} (expected rejection, got none)\n`);
  } catch (e) {
    const m = typeof pattern === "string" ? e.message.toLowerCase().includes(pattern.toLowerCase()) : pattern.test(e.message);
    if (m) {
      passed++;
    } else {
      failed++;
      errors.push(`${label} (msg: ${e.message})`);
      process.stderr.write(`  FAIL: ${label} \u2014 got: ${e.message}\n`);
    }
  }
}

function startMockUdpServer(responseText) {
  return new Promise((resolve, reject) => {
    const server = dgram.createSocket("udp4");
    server.on("error", reject);
    server.on("message", (_msg, rinfo) => {
      const buf = Buffer.from(responseText, "utf8");
      server.send(buf, 0, buf.length, rinfo.port, rinfo.address);
    });
    server.bind(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise(r => server.close(r));
}

async function runAll() {

  // =========================================================================
  // A — Pure helpers / unit (40 tests)
  // =========================================================================

  // parseSipUri
  {
    const r = parseSipUri("pbx.example.com");
    ok(r.scheme === "sip",           "A01: bare host defaults to sip scheme");
    ok(r.host   === "pbx.example.com","A02: host parsed");
    ok(r.port   === SIP_DEFAULT_PORT, "A03: default port 5060");
    ok(r.user   === null,             "A04: no user");
  }

  {
    const r = parseSipUri("sip:alice@example.com");
    ok(r.scheme === "sip",   "A05: sip scheme");
    ok(r.user   === "alice", "A06: user parsed");
    ok(r.host   === "example.com", "A07: host parsed");
  }

  {
    const r = parseSipUri("sips:bob@secure.example.com:5061");
    ok(r.scheme === "sips",              "A08: sips scheme");
    ok(r.user   === "bob",               "A09: sips user");
    ok(r.port   === 5061,                "A10: sips port");
    ok(r.port   === SIPS_DEFAULT_PORT,   "A11: sips default port constant");
  }

  {
    const r = parseSipUri("sip:user@host:12345");
    ok(r.port === 12345, "A12: custom port");
  }

  {
    const r = parseSipUri("sip:alice@example.com;transport=tcp");
    ok(r.host === "example.com", "A13: strips semicolon params");
  }

  {
    const r = parseSipUri("sip:alice@[::1]:5060");
    ok(r.host === "::1",  "A14: IPv6 host");
    ok(r.port === 5060,   "A15: IPv6 port");
  }

  {
    const r = parseSipUri("sip:alice%40test@example.com");
    ok(r.user === "alice@test", "A16: URL-decoded user");
  }

  {
    const r = parseSipUri("sip:10.0.0.1:5060");
    ok(r.host === "10.0.0.1", "A17: host-only no user");
    ok(r.user === null,        "A18: user null");
  }

  {
    let threw = false;
    try { parseSipUri(""); } catch (e) { threw = /non-empty/i.test(e.message); }
    ok(threw, "A19: empty string throws");
  }

  {
    let threw = false;
    try { parseSipUri("sip:user@[::1"); } catch (e) { threw = /ipv6/i.test(e.message); }
    ok(threw, "A20: malformed IPv6 throws");
  }

  // formatSipUri
  {
    const p = { scheme: "sip", user: "alice", host: "example.com", port: 5060 };
    ok(formatSipUri(p) === "sip:alice@example.com", "A21: formatSipUri basic");
  }

  {
    const p = { scheme: "sip", user: "alice", host: "example.com", port: 12345 };
    ok(formatSipUri(p).includes(":12345"), "A22: non-default port included");
  }

  {
    const p = { scheme: "sip", user: "alice", host: "example.com", port: 5060 };
    ok(!formatSipUri(p, false).includes("alice"), "A23: includeUser=false omits user");
  }

  {
    const p = { scheme: "sips", user: "bob", host: "secure.example.com", port: 5061 };
    ok(formatSipUri(p).startsWith("sips:bob@"), "A24: sips scheme");
  }

  // buildRequest
  {
    const msg = buildRequest({ method: "OPTIONS", requestUri: "sip:example.com", headers: { Via: "v" } });
    ok(msg.startsWith("OPTIONS sip:example.com SIP/2.0\r\n"), "A25: start line");
    ok(msg.includes("Content-Length: 0"), "A26: no body → CL 0");
  }

  {
    const body = "hello world";
    const msg = buildRequest({ method: "MESSAGE", requestUri: "sip:x", headers: {}, body });
    const cl = parseInt(msg.match(/Content-Length:\s*(\d+)/i)[1], 10);
    ok(cl === Buffer.byteLength(body, "utf8"), "A27: body sets Content-Length");
  }

  {
    const msg = buildRequest({ method: "OPTIONS", requestUri: "sip:x", headers: { Via: ["v1", "v2"] } });
    ok(msg.includes("Via: v1\r\n") && msg.includes("Via: v2\r\n"), "A28: array header emits multiple lines");
  }

  {
    const msg = buildRequest({ method: "OPTIONS", requestUri: "sip:x", headers: { "X-Null": null } });
    ok(!msg.includes("X-Null"), "A29: null header value skipped");
  }

  // parseResponse
  {
    const r = parseResponse("SIP/2.0 200 OK\r\nVia: SIP/2.0/UDP host\r\n\r\n");
    ok(r.statusCode === 200,                  "A30: 200 statusCode");
    ok(r.statusText === "OK",                 "A31: statusText");
    ok(r.headers["via"] === "SIP/2.0/UDP host", "A32: Via header lowercase");
    ok(r.body === "",                         "A33: empty body");
  }

  {
    const r = parseResponse("SIP/2.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"x\"\r\n\r\n");
    ok(r.statusCode === 401, "A34: 401 statusCode");
    ok(!!r.headers["www-authenticate"], "A35: WWW-Authenticate present");
  }

  {
    const r = parseResponse("SIP/2.0 200 OK\r\nv: SIP/2.0/UDP host\r\n\r\n");
    ok("via" in r.headers, "A36: compact header 'v' expands to Via");
  }

  {
    const body = "v=0\r\n";
    const raw  = `SIP/2.0 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    ok(parseResponse(raw).body === body, "A37: body captured");
  }

  {
    const r = parseResponse("SIP/2.0 200 OK\r\nVia: v1\r\nVia: v2\r\n\r\n");
    ok(Array.isArray(r.headers["via"]) && r.headers["via"].length === 2, "A38: duplicate headers as array");
  }

  {
    let threw = false;
    try { parseResponse("GARBAGE\r\n\r\n"); } catch (e) { threw = /status line/i.test(e.message); }
    ok(threw, "A39: invalid status line throws");
  }

  // misc helpers
  ok(expandCompactHeader("v") === "Via",      "A40a: v → Via");
  ok(expandCompactHeader("t") === "To",       "A40b: t → To");
  ok(expandCompactHeader("f") === "From",     "A40c: f → From");
  ok(expandCompactHeader("X-C") === "X-C",   "A40d: unknown passthrough");

  {
    const ch = parseWwwAuthenticate("Digest realm=\"sip.test.com\", nonce=\"xyz789\", algorithm=MD5");
    ok(ch.scheme === "digest",       "A40e: digest scheme");
    ok(ch.realm  === "sip.test.com", "A40f: realm");
    ok(ch.nonce  === "xyz789",       "A40g: nonce");
  }

  ok(parseWwwAuthenticate("Basic realm=x") === null, "A40h: Basic → null");
  ok(parseWwwAuthenticate(["Digest realm=\"r1\", nonce=\"n1\""]).realm === "r1", "A40i: array input");

  {
    const ch   = { scheme: "digest", realm: "sip.test.com", nonce: "abc", opaque: "", qop: "", algorithm: "MD5" };
    const auth = buildDigestAuth("OPTIONS", "sip:example.com", "alice", "secret", ch);
    ok(auth.startsWith("Digest "),            "A40j: Digest prefix");
    ok(auth.includes('username="alice"'),     "A40k: username in auth");
    ok(auth.includes("response="),            "A40l: response in auth");
    ok(!auth.includes("secret"),              "A40m: plaintext password absent");
  }

  {
    const ch   = { scheme: "digest", realm: "r", nonce: "n", opaque: "", qop: "auth", algorithm: "MD5" };
    const auth = buildDigestAuth("REGISTER", "sip:r", "u", "p", ch);
    ok(auth.includes("qop=auth"),         "A40n: qop=auth");
    ok(auth.includes("nc=00000001"),      "A40o: nc");
    ok(auth.includes("cnonce="),          "A40p: cnonce");
  }

  ok(buildDigestAuth("OPTIONS", "sip:x", "u", "p", null) === null, "A40q: null challenge → null");

  ok(!isCompleteResponse("SIP/2.0 200 OK\r\n"),                            "A40r: incomplete (no sep)");
  ok(isCompleteResponse("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"),    "A40s: CL=0 complete");
  ok(isCompleteResponse(`SIP/2.0 200 OK\r\nContent-Length: 5\r\n\r\nhello`), "A40t: body complete");

  {
    const b = randomBranch();
    ok(b.startsWith(MAGIC_COOKIE) && b.length > MAGIC_COOKIE.length, "A40u: randomBranch magic cookie");
  }

  ok(clampTimeout(0)      === 1000,            "A40v: clamp below min");
  ok(clampTimeout(999999) === 60000,           "A40w: clamp above max");
  ok(clampTimeout(5000)   === 5000,            "A40x: within range unchanged");
  ok(clampTimeout(undefined) === DEFAULT_TIMEOUT_MS, "A40y: undefined → default");

  ok(describeStatus(200) === "Success",       "A40z: 200 Success");
  ok(describeStatus(100) === "Provisional",   "A40aa: 1xx Provisional");
  ok(describeStatus(404) === "Client Error",  "A40bb: 404 Client Error");
  ok(describeStatus(500) === "Server Error",  "A40cc: 500 Server Error");
  ok(describeStatus(302) === "Redirection",   "A40dd: 302 Redirection");

  // =========================================================================
  // B — Input validation (15 tests)
  // =========================================================================

  await rejects(() => sipClient({}),                            "operation",      "B01: missing operation");
  await rejects(() => sipClient({ operation: "dance" }),        "unknown operation", "B02: unknown operation");
  await rejects(() => sipClient({ operation: "options" }),      "server",         "B03: options missing server");
  await rejects(() => sipClient({ operation: "register", server: "sip:pbx.example.com" }), "from", "B04: register missing from");
  await rejects(() => sipClient({ operation: "invite", server: "sip:pbx.example.com" }), "from", "B05: invite missing from");
  await rejects(() => sipClient({ operation: "invite", server: "sip:pbx.example.com", from: "sip:a@x" }), "to", "B06: invite missing to");
  await rejects(() => sipClient({ operation: "message", server: "sip:pbx.example.com", from: "sip:a@x" }), "to", "B07: message missing to");
  await rejects(() => sipClient({ operation: "message", server: "sip:pbx.example.com", from: "sip:a@x", to: "sip:b@x" }), "body", "B08: message missing body");
  await rejects(() => sipClient({ operation: "subscribe", server: "sip:pbx.example.com", from: "sip:a@x", to: "sip:b@x" }), "event", "B09: subscribe missing event");
  await rejects(() => sipClient({ operation: "options", server: "sip:pbx.example.com", transport: "ftp" }), "transport", "B10: invalid transport");

  {
    let threw = false;
    try { parseSipUri(""); } catch (e) { threw = true; }
    ok(threw, "B11: empty URI throws");
  }

  {
    let threw = false;
    try { parseSipUri("sip:user@[::1"); } catch (e) { threw = true; }
    ok(threw, "B12: malformed IPv6 throws");
  }

  {
    let threw = false;
    try { parseSipUri("sip:"); } catch (e) { threw = /missing host/i.test(e.message); }
    ok(threw, "B13: missing host throws");
  }

  ok(clampTimeout("banana") === DEFAULT_TIMEOUT_MS, "B14: non-number → default");

  {
    let t1 = false, t2 = false;
    try { guardNul("abc\0def", "f"); } catch (e) { t1 = /NUL/i.test(e.message); }
    try { guardNul("clean", "f"); t2 = true; } catch (_) {}
    ok(t1 && t2, "B15: guardNul throws on NUL, passes on clean");
  }

  // =========================================================================
  // C — Mock network (13 tests)
  // =========================================================================

  // C01 — info operation (no I/O)
  {
    const r = await sipClient({ operation: "info" });
    ok(r.ok === true,                          "C01: info ok");
    ok(r.operation === "info",                 "C02: info operation field");
    ok(r.protocol.rfcs.some(s => s.includes("3261")), "C03: RFC 3261 listed");
    ok(Array.isArray(r.operations),            "C04: operations array");
  }

  // C05 — OPTIONS 200 OK
  {
    const resp200 = [
      "SIP/2.0 200 OK",
      "Via: SIP/2.0/UDP 127.0.0.1;branch=z9hG4bKtest",
      "Allow: INVITE, ACK, BYE, OPTIONS",
      "Content-Length: 0",
      "", "",
    ].join("\r\n");
    const { server, port } = await startMockUdpServer(resp200);
    try {
      const r = await sipClient({ operation: "options", server: `sip:127.0.0.1:${port}`, timeout: 3000 });
      ok(r.ok === true,                         "C05: options ok");
      ok(r.statusCode === 200,                  "C06: 200 status");
      ok(r.allow.includes("INVITE"),            "C07: allow parsed");
    } finally { await closeServer(server); }
  }

  // C08 — OPTIONS 403
  {
    const { server, port } = await startMockUdpServer("SIP/2.0 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    try {
      const r = await sipClient({ operation: "options", server: `sip:127.0.0.1:${port}`, timeout: 3000 });
      ok(r.ok === false,        "C08: 403 → ok=false");
      ok(r.statusCode === 403,  "C09: 403 statusCode");
    } finally { await closeServer(server); }
  }

  // C10 — REGISTER 200 OK + contact parsing
  {
    const regResp = "SIP/2.0 200 OK\r\nContact: <sip:alice@127.0.0.1>;expires=3600\r\nContent-Length: 0\r\n\r\n";
    const { server, port } = await startMockUdpServer(regResp);
    try {
      const r = await sipClient({ operation: "register", server: `sip:127.0.0.1:${port}`, from: "sip:alice@127.0.0.1", timeout: 3000 });
      ok(r.ok === true,                       "C10: register ok");
      ok(r.operation === "register",          "C10b: register operation");
      ok(Array.isArray(r.contacts),           "C10c: contacts array");
    } finally { await closeServer(server); }
  }

  // C11 — MESSAGE 200 OK
  {
    const { server, port } = await startMockUdpServer("SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n");
    try {
      const r = await sipClient({
        operation: "message", server: `sip:127.0.0.1:${port}`,
        from: "sip:alice@127.0.0.1", to: "sip:bob@127.0.0.1",
        body: "Hello Bob!", timeout: 3000,
      });
      ok(r.ok === true,          "C11: message ok");
      ok(r.bodyLength > 0,       "C11b: bodyLength > 0");
    } finally { await closeServer(server); }
  }

  // C12 — Digest auto-retry on 401
  {
    let requestCount = 0;
    const server = dgram.createSocket("udp4");
    await new Promise(r => server.bind(0, "127.0.0.1", r));
    const port = server.address().port;
    server.on("message", (_msg, rinfo) => {
      requestCount++;
      const resp = requestCount === 1
        ? "SIP/2.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"test.com\", nonce=\"abc123\", algorithm=MD5\r\nContent-Length: 0\r\n\r\n"
        : "SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n";
      const buf = Buffer.from(resp);
      server.send(buf, 0, buf.length, rinfo.port, rinfo.address);
    });
    try {
      const r = await sipClient({
        operation: "options", server: `sip:127.0.0.1:${port}`,
        username: "alice", password: "secret", timeout: 5000,
      });
      ok(r.statusCode === 200,     "C12: digest retry succeeds");
      ok(r.requestsSent === 2,     "C12b: 2 requests sent");
    } finally { await closeServer(server); }
  }

  // C13 — UDP timeout
  {
    const server = dgram.createSocket("udp4");
    await new Promise(r => server.bind(0, "127.0.0.1", r));
    const port = server.address().port;
    let timedOut = false;
    try {
      await sipClient({ operation: "options", server: `sip:127.0.0.1:${port}`, timeout: 1000 });
    } catch (e) {
      timedOut = /timed out/i.test(e.message);
    } finally {
      await closeServer(server);
    }
    ok(timedOut, "C13: UDP timeout error");
  }

  // =========================================================================
  // D — Security / injection guards (10 tests)
  // =========================================================================

  await rejects(() => sipClient({ operation: "options", server: "sip:host\0bad:5060" }),                             "NUL", "D01: NUL in server");
  await rejects(() => sipClient({ operation: "options", server: "sip:host:5060", username: "alice\0evil" }),          "NUL", "D02: NUL in username");
  await rejects(() => sipClient({ operation: "options", server: "sip:host:5060", password: "pass\0word" }),           "NUL", "D03: NUL in password");
  await rejects(() => sipClient({ operation: "register", server: "sip:host:5060", from: "sip:alice\0@host" }),        "NUL", "D04: NUL in from");
  await rejects(() => sipClient({ operation: "invite", server: "sip:host:5060", from: "sip:a@h", to: "sip:b\0@h" }), "NUL", "D05: NUL in to");
  await rejects(() => sipClient({ operation: "subscribe", server: "sip:h:5060", from: "sip:a@h", to: "sip:b@h", event: "pres\0ence" }), "NUL", "D06: NUL in event");

  {
    let t = false;
    try { guardNul("abc\0xyz", "f"); } catch (e) { t = /NUL/i.test(e.message); }
    ok(t, "D07: NUL mid-string");
  }

  {
    let t = false;
    try { guardNul("\0start", "f"); } catch (e) { t = true; }
    ok(t, "D08: NUL at start");
  }

  ok(clampTimeout(-9999) === 1000,  "D09: negative timeout clamped to min");
  ok(clampTimeout(999999) === 60000, "D10: huge timeout clamped to max");

  // =========================================================================
  // E — Concurrency / stress (8 tests)
  // =========================================================================

  // E01 — parallel info x20
  {
    const results = await Promise.all(Array.from({ length: 20 }, () => sipClient({ operation: "info" })));
    ok(results.length === 20 && results.every(r => r.ok), "E01: 20 parallel info calls");
  }

  // E02 — randomBranch uniqueness
  {
    const branches = new Set(Array.from({ length: 100 }, randomBranch));
    ok(branches.size === 100, "E02: 100 unique branches");
  }

  // E03 — randomCallId uniqueness
  {
    const ids = new Set(Array.from({ length: 100 }, () => randomCallId("test.com")));
    ok(ids.size === 100, "E03: 100 unique call-IDs");
  }

  // E04 — randomTag uniqueness
  {
    const tags = new Set(Array.from({ length: 100 }, randomTag));
    ok(tags.size === 100, "E04: 100 unique tags");
  }

  // E05 — 5 parallel OPTIONS to separate servers
  {
    const resp = "SIP/2.0 200 OK\r\nAllow: INVITE, OPTIONS\r\nContent-Length: 0\r\n\r\n";
    const servers = await Promise.all(Array.from({ length: 5 }, () => startMockUdpServer(resp)));
    try {
      const results = await Promise.all(servers.map(({ port }) =>
        sipClient({ operation: "options", server: `sip:127.0.0.1:${port}`, timeout: 5000 })
      ));
      ok(results.every(r => r.ok) && results.every(r => r.allow.includes("INVITE")),
         "E05: 5 parallel OPTIONS succeed");
    } finally {
      await Promise.all(servers.map(s => closeServer(s.server)));
    }
  }

  // E06 — parallel info x50
  {
    const results = await Promise.all(Array.from({ length: 50 }, () => sipClient({ operation: "info" })));
    ok(results.every(r => r.ok), "E06: 50 parallel info calls");
  }

  // E07 — parseSipUri under load
  {
    let allOk = true;
    for (let i = 0; i < 500; i++) {
      const r = parseSipUri(`sip:user${i}@host${i}.example.com:${5060 + (i % 100)}`);
      if (r.user !== `user${i}` || r.host !== `host${i}.example.com`) { allOk = false; break; }
    }
    ok(allOk, "E07: parseSipUri x500 load test");
  }

  // E08 — buildRequest under load
  {
    let allOk = true;
    for (let i = 0; i < 500; i++) {
      const msg = buildRequest({ method: "OPTIONS", requestUri: `sip:host${i}.example.com`, headers: { "CSeq": `${i} OPTIONS` } });
      if (!msg.includes(`${i} OPTIONS`)) { allOk = false; break; }
    }
    ok(allOk, "E08: buildRequest x500 load test");
  }

  // =========================================================================
  // Summary
  // =========================================================================
  process.stderr.write(`\n259-sip-client: ${passed}/${passed + failed} tests passed\n`);
  if (errors.length) {
    process.stderr.write("FAILURES:\n");
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
}

runAll().catch(err => {
  process.stderr.write(`Unexpected error: ${err.stack || err}\n`);
  process.exit(1);
});
