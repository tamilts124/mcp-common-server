"use strict";
/**
 * Section 258 — rtsp_client tests
 *
 * Rigor levels:
 *   A — Pure helpers / unit tests (no I/O):   40 tests
 *   B — Schema / validation tests:            15 tests
 *   C — Mock-network tests (TCP loopback):    13 tests
 *   D — Security / sanitisation tests:        10 tests
 *   E — Concurrency tests:                     8 tests
 * Total: 86 tests
 */

const assert = require("assert").strict;
const net    = require("net");

const {
  parseRtspUrl,
  buildRequest,
  parseResponse,
  parseSdp,
  parseWwwAuthenticate,
  buildAuthHeader,
  clampTimeout,
  guardNul,
  rtspClient,
  RTSP_DEFAULT_PORT,
  RTSPS_DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  RTSP_VERSION,
} = require("../../lib/rtspClientOps");

const { rtspClientSchema } = require("../../lib/schemas/utilSchemas91");

let passed = 0;
let failed = 0;
const errors = [];

function ok(cond, label) {
  if (cond) {
    passed++;
    process.stderr.write(`  \u2713 ${label}\n`);
  } else {
    failed++;
    errors.push(label);
    process.stderr.write(`  \u2717 FAIL: ${label}\n`);
  }
}

async function rejects(fn, substr, label) {
  try {
    await fn();
    failed++;
    errors.push(`${label} (expected rejection, got none)`);
    process.stderr.write(`  \u2717 FAIL: ${label} (expected rejection)\n`);
  } catch (e) {
    const match = !substr || e.message.includes(substr);
    if (match) {
      passed++;
      process.stderr.write(`  \u2713 ${label}\n`);
    } else {
      failed++;
      errors.push(`${label} (msg: ${e.message})`);
      process.stderr.write(`  \u2717 FAIL: ${label} — got: ${e.message}\n`);
    }
  }
}

function sec(name) {
  process.stderr.write(`\n[${name}]\n`);
}

// ── Fake RTSP server helpers ──────────────────────────────────────────────────
function startFakeRtsp(responseText) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on("data", () => {
        sock.write(responseText);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

async function withFakeRtsp(responseText, fn) {
  const { port, close } = await startFakeRtsp(responseText);
  try { return await fn(port); }
  finally { close(); }
}

// ── Main test runner ──────────────────────────────────────────────────────────
async function runAll() {

  // =========================================================================
  // A — Pure helpers
  // =========================================================================
  sec("A — Pure helpers");

  // parseRtspUrl
  {
    const r = parseRtspUrl("rtsp://192.168.1.1:554/stream1");
    ok(r.scheme === "rtsp",          "A01: rtsp:// scheme");
    ok(r.host   === "192.168.1.1",   "A02: host");
    ok(r.port   === 554,             "A03: explicit port");
    ok(r.path   === "/stream1",      "A04: path");
    ok(r.username === null,          "A05: no credentials");
  }

  {
    const r = parseRtspUrl("rtsps://cam.local/live");
    ok(r.scheme === "rtsps",         "A06: rtsps:// scheme");
    ok(r.port === RTSPS_DEFAULT_PORT,"A07: default rtsps port");
  }

  {
    const r = parseRtspUrl("rtsp://host/stream");
    ok(r.port === RTSP_DEFAULT_PORT, "A08: default rtsp port");
  }

  {
    const r = parseRtspUrl("rtsp://admin:secret@192.168.1.1:554/live");
    ok(r.username === "admin",       "A09: username from URL");
    ok(r.password === "secret",      "A10: password from URL");
  }

  {
    const r = parseRtspUrl("rtsp://user%40name:p%40ss@host/stream");
    ok(r.username === "user@name",   "A11: URL-decoded username");
    ok(r.password === "p@ss",        "A12: URL-decoded password");
  }

  {
    const r = parseRtspUrl("rtsp://host");
    ok(r.path === "/",               "A13: no path defaults to /");
  }

  {
    const r = parseRtspUrl("rtsp://[::1]:8554/stream");
    ok(r.host === "::1",             "A14: IPv6 host");
    ok(r.port === 8554,              "A15: IPv6 explicit port");
  }

  {
    let threw = false;
    try { parseRtspUrl("http://host/stream"); } catch(e) { threw = e.message.includes("rtsp://"); }
    ok(threw, "A16: non-rtsp scheme rejected");
  }

  {
    let threw = false;
    try { parseRtspUrl(""); } catch(e) { threw = true; }
    ok(threw, "A17: empty string rejected");
  }

  {
    let threw = false;
    try { parseRtspUrl("rtsp://host:99999/s"); } catch(e) { threw = e.message.includes("port"); }
    ok(threw, "A18: invalid port rejected");
  }

  ok(parseRtspUrl("rtsp://host:1/s").port === 1,       "A19: port 1 valid");
  ok(parseRtspUrl("rtsp://host:65535/s").port === 65535, "A20: port 65535 valid");

  {
    const r = parseRtspUrl("rtsp://admin@host/stream");
    ok(r.username === "admin",        "A21: username-only userinfo");
    ok(r.password === "",             "A22: empty password when no colon");
  }

  // buildRequest
  {
    const req = buildRequest("OPTIONS", "rtsp://host/stream", 1, {}, null);
    ok(req.startsWith("OPTIONS rtsp://host/stream RTSP/1.0\r\n"),
       "A23: buildRequest start line");
    ok(req.includes("CSeq: 1\r\n"),    "A24: CSeq header");
    ok(req.endsWith("\r\n\r\n"),       "A25: ends with CRLF CRLF");
  }

  {
    const req = buildRequest("DESCRIBE", "rtsp://h/s", 2, { Accept: "application/sdp" });
    ok(req.includes("Accept: application/sdp\r\n"), "A26: extra header preserved");
  }

  {
    const req = buildRequest("ANNOUNCE", "rtsp://h/s", 3, {}, "body data");
    ok(req.includes("Content-Length: 9\r\n"), "A27: Content-Length set from body");
    ok(req.endsWith("body data"),              "A28: body appended");
  }

  // parseResponse
  {
    const raw = "RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS,DESCRIBE\r\n\r\n";
    const r = parseResponse(raw);
    ok(r.statusCode === 200,                          "A29: 200 status code");
    ok(r.statusText === "OK",                         "A30: status text");
    ok(r.headers["public"] === "OPTIONS,DESCRIBE",    "A31: Public header");
  }

  {
    const raw = "RTSP/1.0 401 Unauthorized\r\nWWW-Authenticate: Digest realm=\"test\"\r\n\r\n";
    ok(parseResponse(raw).statusCode === 401,         "A32: 401 status code");
  }

  {
    const raw = "RTSP/1.0 200 OK\r\nContent-Type: application/sdp\r\n\r\n";
    ok("content-type" in parseResponse(raw).headers,  "A33: headers lowercase");
  }

  {
    const body = "v=0\r\ns=Test\r\n";
    const raw  = `RTSP/1.0 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    ok(parseResponse(raw).body.includes("v=0"),        "A34: body captured");
  }

  {
    let threw = false;
    try { parseResponse("RTSP/1.0 200 OK\r\n"); } catch(e) { threw = e.message.includes("incomplete"); }
    ok(threw, "A35: throws on missing header terminator");
  }

  {
    let threw = false;
    try { parseResponse("HTTP/1.1 200 OK\r\n\r\n"); } catch(e) { threw = true; }
    ok(threw, "A36: throws on non-RTSP status line");
  }

  // parseSdp
  {
    const sdp = "v=0\r\no=- 12345 1 IN IP4 192.168.1.1\r\ns=Test Stream\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=1\r\n";
    const r = parseSdp(sdp);
    ok(r.version === 0,                           "A37: SDP version");
    ok(r.sessionName === "Test Stream",           "A38: SDP session name");
    ok(r.mediaDescriptions[0].type === "video",   "A39: SDP media type");
    ok(r.mediaDescriptions[0].controlUrl === "trackID=1", "A40: SDP controlUrl");
  }

  // =========================================================================
  // B — Validation / schema tests
  // =========================================================================
  sec("B — Validation / schema tests");

  ok(rtspClientSchema.name === "rtsp_client",                           "B01: schema name");
  ok(Array.isArray(rtspClientSchema.inputSchema.required),               "B02: required is array");
  ok(rtspClientSchema.inputSchema.required.includes("operation"),        "B03: operation is required");

  {
    const ops = rtspClientSchema.inputSchema.properties.operation.enum;
    const expected = ["options","describe","setup","play","pause","teardown","info"];
    ok(ops.length === 7, "B04: 7 operations in enum");
    ok(expected.every(o => ops.includes(o)), "B05: all operations present");
  }

  ok(!!rtspClientSchema.inputSchema.properties.url,                      "B06: url property");
  ok(!!rtspClientSchema.inputSchema.properties.timeout,                  "B07: timeout property");
  ok(!!rtspClientSchema.inputSchema.properties.reject_unauthorized,      "B08: reject_unauthorized property");
  ok(rtspClientSchema.inputSchema.properties.reject_unauthorized.type === "boolean", "B09: reject_unauthorized type boolean");
  ok(!!rtspClientSchema.inputSchema.properties.session_id,               "B10: session_id property");
  ok(!!rtspClientSchema.inputSchema.properties.control_url,              "B11: control_url property");
  ok(!!rtspClientSchema.inputSchema.properties.transport,                "B12: transport property");
  ok(!!rtspClientSchema.inputSchema.properties.range,                    "B13: range property");

  await rejects(() => rtspClient({}),                   "operation",         "B14: missing operation");
  await rejects(() => rtspClient({ operation: "xyz" }), "unknown operation", "B15: unknown operation");

  // =========================================================================
  // C — Mock-network tests
  // =========================================================================
  sec("C — Mock-network tests");

  // C01: options — 200 OK
  await withFakeRtsp(
    "RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS,DESCRIBE,SETUP,PLAY,PAUSE,TEARDOWN\r\n\r\n",
    async (port) => {
      const r = await rtspClient({ operation: "options", url: `rtsp://127.0.0.1:${port}/s`, timeout: 3000 });
      ok(r.ok,                             "C01: options ok");
      ok(r.operation === "options",        "C02: options operation field");
      ok(r.publicMethods.includes("OPTIONS"), "C03: publicMethods parsed");
    }
  );

  // C04: describe — returns SDP
  {
    const sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Test\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=control:trackID=0\r\n";
    await withFakeRtsp(
      `RTSP/1.0 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`,
      async (port) => {
        const r = await rtspClient({ operation: "describe", url: `rtsp://127.0.0.1:${port}/s`, timeout: 3000 });
        ok(r.ok,                                              "C04: describe ok");
        ok(r.sdp !== null,                                    "C05: SDP parsed");
        ok(r.sdp.mediaDescriptions[0].type === "video",      "C06: SDP video track");
      }
    );
  }

  // C07: setup — returns sessionId
  await withFakeRtsp(
    "RTSP/1.0 200 OK\r\nCSeq: 1\r\nSession: 12345678;timeout=60\r\nTransport: RTP/AVP;unicast;server_port=6000-6001\r\n\r\n",
    async (port) => {
      const r = await rtspClient({ operation: "setup", url: `rtsp://127.0.0.1:${port}/s`, timeout: 3000 });
      ok(r.sessionId === "12345678",     "C07: sessionId from setup");
      ok(r.serverTransport.includes("server_port"), "C08: serverTransport");
    }
  );

  // C09: play
  await withFakeRtsp(
    "RTSP/1.0 200 OK\r\nCSeq: 1\r\nSession: 12345678\r\nRTP-Info: url=rtsp://h/s;seq=1\r\n\r\n",
    async (port) => {
      const r = await rtspClient({ operation: "play", url: `rtsp://127.0.0.1:${port}/s`, session_id: "12345678", timeout: 3000 });
      ok(r.ok && r.operation === "play",   "C09: play ok");
      ok(r.rtpInfo.includes("seq=1"),      "C10: rtpInfo present");
    }
  );

  // C11: teardown
  await withFakeRtsp(
    "RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n",
    async (port) => {
      const r = await rtspClient({ operation: "teardown", url: `rtsp://127.0.0.1:${port}/s`, session_id: "sess", timeout: 3000 });
      ok(r.ok && r.operation === "teardown", "C11: teardown ok");
    }
  );

  // C12: 401 → ok:false
  await withFakeRtsp(
    'RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="cam", nonce="abc"\r\n\r\n',
    async (port) => {
      const r = await rtspClient({ operation: "options", url: `rtsp://127.0.0.1:${port}/s`, timeout: 3000 });
      ok(!r.ok && r.statusCode === 401, "C12: 401 → ok:false");
    }
  );

  // C13: Basic auth retry
  {
    let reqCount = 0;
    const server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        if (buf.includes("\r\n\r\n")) {
          reqCount++;
          if (reqCount === 1) {
            sock.write("RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm=\"cam\"\r\n\r\n");
          } else {
            sock.write("RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n");
          }
          buf = "";
        }
      });
    });
    await new Promise(res => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    try {
      const r = await rtspClient({ operation: "options", url: `rtsp://127.0.0.1:${port}/s`, username: "admin", password: "secret", timeout: 3000 });
      ok(r.ok,                "C13: Basic auth retry succeeds");
    } finally { server.close(); }
  }

  // C14-extra: connection refused gives clear error
  {
    let threw = false;
    try { await rtspClient({ operation: "options", url: "rtsp://127.0.0.1:1/s", timeout: 1000 }); }
    catch(e) { threw = true; }
    ok(threw, "C-extra: connection refused gives error");
  }

  // =========================================================================
  // D — Security tests
  // =========================================================================
  sec("D — Security tests");

  await rejects(() => rtspClient({ operation: "options", url: "rtsp://host\0evil/s" }),       "NUL", "D01: NUL in URL");
  await rejects(() => rtspClient({ operation: "options", url: "rtsp://host/s", username: "admin\0evil" }), "NUL", "D02: NUL in username");
  await rejects(() => rtspClient({ operation: "options", url: "rtsp://host/s", username: "a", password: "pass\0evil" }), "NUL", "D03: NUL in password");
  await rejects(() => rtspClient({ operation: "options", url: "ftp://host/s" }),              "rtsp://", "D04: non-rtsp scheme");
  await rejects(() => rtspClient({ operation: "options", url: "rtsp://host:0/s" }),           "port",    "D05: port=0");
  await rejects(() => rtspClient({ operation: "play",    url: "rtsp://host/s" }),             "session_id", "D06: play without session_id");
  await rejects(() => rtspClient({ operation: "pause",   url: "rtsp://host/s" }),             "session_id", "D07: pause without session_id");
  await rejects(() => rtspClient({ operation: "teardown",url: "rtsp://host/s" }),             "session_id", "D08: teardown without session_id");

  {
    const authHdr = buildAuthHeader("DESCRIBE", "rtsp://h/s", "admin", "mysecret",
      { scheme: "digest", realm: "cam", nonce: "n1", opaque: "", qop: "", algorithm: "MD5" });
    ok(!authHdr.includes("mysecret"), "D09: Digest auth does not contain plaintext password");
  }

  {
    const r = await rtspClient({ operation: "info", timeout: 9999999 });
    ok(r.ok, "D10: extreme timeout clamped silently");
  }

  // =========================================================================
  // E — Concurrency tests
  // =========================================================================
  sec("E — Concurrency tests");

  // E01: 5 parallel info calls
  {
    const results = await Promise.all(Array.from({ length: 5 }, () => rtspClient({ operation: "info" })));
    ok(results.every(r => r.ok), "E01: 5 parallel info calls all succeed");
  }

  // E02: 5 parallel options to same fake server
  await withFakeRtsp(
    "RTSP/1.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS\r\n\r\n",
    async (port) => {
      const url = `rtsp://127.0.0.1:${port}/s`;
      const results = await Promise.all(Array.from({ length: 5 }, () =>
        rtspClient({ operation: "options", url, timeout: 3000 })
      ));
      ok(results.every(r => r.ok), "E02: 5 parallel options all succeed");
    }
  );

  // E03: mix of info + network calls
  {
    const resp200 = "RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n";
    const sdp = "v=0\r\ns=T\r\nm=video 0 RTP/AVP 96\r\n";
    const respSdp = `RTSP/1.0 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`;
    const s1 = await startFakeRtsp(resp200);
    const s2 = await startFakeRtsp(respSdp);
    try {
      const [r1, r2, r3] = await Promise.all([
        rtspClient({ operation: "info" }),
        rtspClient({ operation: "options", url: `rtsp://127.0.0.1:${s1.port}/s`, timeout: 3000 }),
        rtspClient({ operation: "describe", url: `rtsp://127.0.0.1:${s2.port}/s`, timeout: 3000 }),
      ]);
      ok(r1.ok && r2.ok && r3.ok,     "E03: mixed parallel calls succeed");
      ok(r3.sdp.sessionName === "T",   "E04: correct SDP from parallel describe");
    } finally { s1.close(); s2.close(); }
  }

  // E05: 5 parallel URL parses
  {
    const urls = ["rtsp://h1/s","rtsp://h2:8554/s","rtsp://u:p@h3/s","rtsps://h4/s","rtsp://[::1]:554/s"];
    const results = await Promise.all(urls.map(u => Promise.resolve(parseRtspUrl(u))));
    ok(results[0].host === "h1",        "E05: parallel parse host1");
    ok(results[1].port === 8554,        "E06: parallel parse port");
    ok(results[2].username === "u",     "E07: parallel parse username");
  }

  // E08: 3 parallel describes to different servers
  {
    const makeResp = (name) => {
      const s = `v=0\r\ns=${name}\r\nm=video 0 RTP/AVP 96\r\n`;
      return `RTSP/1.0 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: ${s.length}\r\n\r\n${s}`;
    };
    const servers = await Promise.all(["Alpha","Beta","Gamma"].map(n => startFakeRtsp(makeResp(n))));
    try {
      const results = await Promise.all(servers.map(s =>
        rtspClient({ operation: "describe", url: `rtsp://127.0.0.1:${s.port}/s`, timeout: 3000 })
      ));
      ok(results.map(r => r.sdp.sessionName).sort().join(",") === "Alpha,Beta,Gamma",
         "E08: 3 parallel describes receive correct data");
    } finally { servers.forEach(s => s.close()); }
  }

  // =========================================================================
  // Summary
  // =========================================================================
  process.stderr.write(`\n${'='.repeat(60)}\n`);
  process.stderr.write(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
  if (errors.length) {
    process.stderr.write("Failed:\n");
    errors.forEach(e => process.stderr.write(`  - ${e}\n`));
  }
  process.stderr.write(`${'='.repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.stack || err}\n`);
  process.exit(1);
});
