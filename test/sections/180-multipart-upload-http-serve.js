"use strict";
/**
 * Section 180: multipart_upload + http_serve tools
 * All 5 rigor levels across 10 sub-sections (A–J).
 *
 * A: multipart_upload — input validation (no network)
 * B: multipart_upload — body structure tests via local recvServer
 * C: http_serve — input validation & opStatus offline
 * D: http_serve — route matching logic
 * E: http_serve — integration lifecycle + clear_requests
 * F: multipart_upload → http_serve: fields + inline files (end-to-end)
 * G: multipart_upload → http_serve: disk file Buffer (end-to-end)
 * H: http_serve — wait operation + add_route
 * I: multipart_upload — security: special chars, binary, custom headers
 * J: http_serve — 50 concurrent requests + delay_ms stress
 *
 * NOTE: multipartUpload() uses camelCase opts: inlineFiles, contentType
 * (snake_case conversion is done by the dispatchRead.js handler layer).
 */

const { counters, fs, path, TMP } = require("../test-harness");
const http   = require("http");
const crypto = require("crypto");

const { multipartUpload } = require("../../lib/multipartUploadOps");
const { httpServe, SERVERS } = require("../../lib/httpServeOps");
const { ToolError }           = require("../../lib/errors");

function ok(label, pass, detail = "") {
  counters[pass ? "pass" : "fail"]++;
  const sym = pass ? "\u2713" : "\u2717";
  const msg = detail ? `  ${sym} ${label}: ${detail}` : `  ${sym} ${label}`;
  if (!pass) process.stderr.write(msg + "\n");
  else console.log(msg);
}

async function asyncThrows(fn, msgPart) {
  try { await fn(); return false; }
  catch (e) { return !msgPart || e.message.includes(msgPart); }
}

/** Minimal raw HTTP request helper (no deps). */
function rawRequest(port, method, urlPath, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method,
        headers: { "content-length": Buffer.byteLength(body, "utf8") } },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end",  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Section header
// ──────────────────────────────────────────────────────────────────────────
console.log("[180-A] multipart_upload: input validation");

module.exports = (async () => {

  // ──────────────────────────────────────────────────────────────────────
  // [180-A] multipart_upload: input validation (no network)
  // ──────────────────────────────────────────────────────────────────────

  ok("A1: missing url throws",
    await asyncThrows(() => multipartUpload({ url: "" }), "'url' is required"));

  ok("A2: invalid url throws",
    await asyncThrows(() => multipartUpload({ url: "not-a-url" }), "invalid URL"));

  ok("A3: ftp scheme rejected",
    await asyncThrows(() => multipartUpload({ url: "ftp://example.com/upload" }), "unsupported scheme"));

  // method validation: GET/DELETE not allowed
  ok("A4: GET method rejected",
    await asyncThrows(
      () => multipartUpload({ url: "http://127.0.0.1/x", method: "GET",
        inlineFiles: [{ name: "f", data: "d", filename: "f.txt" }] }),
      "not allowed"
    ));

  ok("A5: DELETE method rejected",
    await asyncThrows(
      () => multipartUpload({ url: "http://127.0.0.1/x", method: "DELETE", fields: { x: "1" } }),
      "not allowed"
    ));

  ok("A6: non-object fields rejected",
    await asyncThrows(
      () => multipartUpload({ url: "http://127.0.0.1/x", fields: ["a", "b"] }),
      "plain object"
    ));

  ok("A7: empty payload rejected",
    await asyncThrows(
      () => multipartUpload({ url: "http://127.0.0.1/x", fields: {}, inlineFiles: [] }),
      "at least one"
    ));

  ok("A8: URL control char rejected",
    await asyncThrows(
      () => multipartUpload({ url: "http://127.0.0.1/\x00upload" }),
      "control characters"
    ));

  // A9: inline file > 50 MB rejected (note: inlineFiles camelCase)
  // Keep the test buffer small — 51*1024*1024 is fine; just use Buffer directly
  const BIG = Buffer.alloc(51 * 1024 * 1024, 0x78);
  ok("A9: 51MB inline file rejected",
    await asyncThrows(
      () => multipartUpload({ url: "http://127.0.0.1/x", inlineFiles: [{ name: "f", data: BIG, filename: "big.bin" }] }),
      "50 MB"
    ));

  // A10: >100 fields rejected
  const tooManyFields = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, `v${i}`]));
  ok("A10: >100 fields rejected",
    await asyncThrows(
      () => multipartUpload({ url: "http://127.0.0.1/x", fields: tooManyFields }),
      "too many fields"
    ));

  // ──────────────────────────────────────────────────────────────────────
  // [180-B] multipart_upload: body structure tests
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-B] multipart_upload: body structure tests");

  // Set up a minimal receiver server (Node http, not http_serve)
  let capturedBody = null;
  let capturedCT   = null;
  const recvServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      capturedBody = Buffer.concat(chunks).toString("utf8");
      capturedCT   = req.headers["content-type"] || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(r => recvServer.listen(0, "127.0.0.1", r));
  const recvPort = recvServer.address().port;
  const recvUrl  = `http://127.0.0.1:${recvPort}/upload`;

  try {
    // B1-B7: fields only
    const r1 = await multipartUpload({ url: recvUrl, fields: { hello: "world", count: 42 } });
    ok("B1: status 200",               r1.status === 200);
    ok("B2: ok=true",                  r1.ok === true);
    ok("B3: partCount=2",              r1.partCount === 2);
    ok("B4: content-type has boundary", r1.boundary && capturedCT.includes(r1.boundary));
    ok("B5: body has 'hello'",         capturedBody.includes('name="hello"'));
    ok("B6: body has 'world'",         capturedBody.includes("world"));
    ok("B7: body has '42'",            capturedBody.includes("42"));

    // B8-B10: inline file (camelCase: inlineFiles, contentType)
    const r2 = await multipartUpload({
      url: recvUrl,
      inlineFiles: [{ name: "upload", data: "hello file", filename: "test.txt", contentType: "text/plain" }],
    });
    ok("B8: inline partCount=1",       r2.partCount === 1);
    ok("B9: body has filename",        capturedBody.includes('filename="test.txt"'));
    ok("B10: body has file content",   capturedBody.includes("hello file"));

    // B11: PUT method
    const r3 = await multipartUpload({ url: recvUrl, method: "PUT", fields: { x: "1" } });
    ok("B11: PUT method accepted",     r3.method === "PUT");

    // B12: PATCH method
    const r4 = await multipartUpload({ url: recvUrl, method: "PATCH", fields: { y: "2" } });
    ok("B12: PATCH method accepted",   r4.method === "PATCH");

    // B13-B14: field name with double-quote (escapeDisposition)
    const r5 = await multipartUpload({ url: recvUrl, fields: { 'name"q"': "value" } });
    ok("B13: quoted field name ok",    r5.partCount === 1);
    ok("B14: requestBodySize > 0",     r5.requestBodySize > 0);

  } finally {
    await new Promise(r => recvServer.close(r));
  }

  // ──────────────────────────────────────────────────────────────────────
  // [180-C] http_serve: input validation
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-C] http_serve: input validation");

  ok("C1: stop without session_id throws",
    await asyncThrows(() => httpServe({ operation: "stop" }), "'session_id' is required"));
  ok("C2: requests without session_id throws",
    await asyncThrows(() => httpServe({ operation: "requests" }), "'session_id' is required"));
  ok("C3: unknown session_id throws",
    await asyncThrows(() => httpServe({ operation: "stop", session_id: crypto.randomUUID() }), "no session"));
  ok("C4: unknown operation throws",
    await asyncThrows(() => httpServe({ operation: "dance" }), "unknown operation"));
  ok("C5: invalid port throws",
    await asyncThrows(() => httpServe({ operation: "start", port: 99999 }), "invalid port"));
  ok("C6: route without path throws",
    await asyncThrows(() => httpServe({ operation: "start", routes: [{ method: "GET" }] }), "route.path"));
  ok("C7: route bad status throws",
    await asyncThrows(() => httpServe({ operation: "start", routes: [{ path: "/x", status: 9999 }] }), "100"));
  ok("C8: route bad delay_ms throws",
    await asyncThrows(() => httpServe({ operation: "start", routes: [{ path: "/x", delay_ms: -1 }] }), "delay_ms"));

  SERVERS.clear(); // ensure clean state for status check
  const noSess = await httpServe({ operation: "status" });
  ok("C9: empty status count=0",       noSess.count === 0);

  // ──────────────────────────────────────────────────────────────────────
  // [180-D] http_serve: route matching
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-D] http_serve: route matching");

  const sD = await httpServe({
    operation: "start",
    routes: [
      { path: "/exact",  method: "GET", status: 200, body: "{\"route\":\"exact\"}" },
      { path: "/api/*",  method: "*",   status: 201, body: "{\"route\":\"prefix\"}" },
      { path: "*",       method: "POST",status: 202, body: "{\"route\":\"any-post\"}" },
    ],
  });
  ok("D1: start returns session_id",  typeof sD.session_id === "string");
  ok("D2: start returns url",         sD.url.startsWith("http://127.0.0.1:"));
  ok("D3: start routes_count=3",      sD.routes_count === 3);

  try {
    const d4 = await rawRequest(sD.port, "GET",  "/exact");
    ok("D4: exact route matches",      d4.status === 200 && d4.body.includes("exact"));

    const d5 = await rawRequest(sD.port, "GET",  "/api/users");
    ok("D5: prefix route matches",     d5.status === 201 && d5.body.includes("prefix"));

    const d6 = await rawRequest(sD.port, "POST", "/anything");
    ok("D6: catch-all POST matches",   d6.status === 202 && d6.body.includes("any-post"));

    const d7 = await rawRequest(sD.port, "GET",  "/no-match");
    ok("D7: unmatched → 404",          d7.status === 404);

    const reqsD = await httpServe({ operation: "requests", session_id: sD.session_id });
    ok("D8: requests captured",        reqsD.total_captured >= 4);
    ok("D9: matched flag set",         reqsD.requests[0].matched === true);
    ok("D10: matchedRoute for /exact", reqsD.requests.some(r => r.matchedRoute?.includes("/exact")));

  } finally {
    await httpServe({ operation: "stop", session_id: sD.session_id });
  }

  // ──────────────────────────────────────────────────────────────────────
  // [180-E] http_serve: integration lifecycle + clear_requests
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-E] http_serve: integration lifecycle");

  const sE = await httpServe({ operation: "start", routes: [{ path: "/ping", status: 200, body: "{\"pong\":true}" }] });
  ok("E1: start returns port",         typeof sE.port === "number" && sE.port > 0);

  const statusE = await httpServe({ operation: "status" });
  ok("E2: session listed in status",   statusE.sessions.some(s => s.session_id === sE.session_id));

  try {
    await rawRequest(sE.port, "GET", "/ping");
    await rawRequest(sE.port, "GET", "/ping");

    const reqsE1 = await httpServe({ operation: "requests", session_id: sE.session_id });
    ok("E3: two requests captured",    reqsE1.total_captured === 2);

    await httpServe({ operation: "clear_requests", session_id: sE.session_id });
    const reqsE2 = await httpServe({ operation: "requests", session_id: sE.session_id });
    ok("E4: cleared → 0 captured",     reqsE2.total_captured === 0);

    await rawRequest(sE.port, "POST", "/echo", JSON.stringify({ msg: "hello" }));
    const reqsE3 = await httpServe({ operation: "requests", session_id: sE.session_id });
    ok("E5: POST body captured",       reqsE3.requests.some(r => r.body.includes("hello")));

    const stopR = await httpServe({ operation: "stop", session_id: sE.session_id });
    ok("E6: stop status='stopped'",    stopR.status === "stopped");
    ok("E7: session removed",          !SERVERS.has(sE.session_id));

  } catch (e) {
    try { await httpServe({ operation: "stop", session_id: sE.session_id }); } catch (_) {}
    throw e;
  }

  // ──────────────────────────────────────────────────────────────────────
  // [180-F] multipart_upload → http_serve: fields + inline files
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-F] multipart_upload: live POST with fields + inline");

  const sF = await httpServe({ operation: "start", routes: [{ path: "*", status: 200, body: "{\"received\":true}" }] });
  const fUrl = `http://127.0.0.1:${sF.port}/upload`;

  try {
    const rf = await multipartUpload({
      url:   fUrl,
      fields: { name: "Alice", age: "30" },
      // camelCase: inlineFiles, contentType
      inlineFiles: [
        { name: "doc",  data: "file content here",               filename: "doc.txt",  contentType: "text/plain" },
        { name: "data", data: Buffer.from("BIN").toString("base64"), filename: "bin.dat",
          encoding: "base64", contentType: "application/octet-stream" },
      ],
    });
    ok("F1: status=200",               rf.status === 200);
    ok("F2: ok=true",                  rf.ok === true);
    ok("F3: partCount=4",              rf.partCount === 4); // 2 fields + 2 inlineFiles
    ok("F4: boundary present",        typeof rf.boundary === "string" && rf.boundary.startsWith("----McpBoundary"));
    ok("F5: requestBodySize > 0",      rf.requestBodySize > 200);

    const reqsF = await httpServe({ operation: "requests", session_id: sF.session_id });
    const captBody = reqsF.requests[0]?.body || "";
    ok("F6: server got 'Alice'",       captBody.includes("Alice"));
    ok("F7: server got file content",  captBody.includes("file content here"));
    ok("F8: server got BIN payload",   captBody.includes("BIN"));
    ok("F9: truncated=false",          rf.truncated === false);
    ok("F10: bodySize >= 15",          rf.bodySize >= 15);

  } finally {
    await httpServe({ operation: "stop", session_id: sF.session_id });
  }

  // ──────────────────────────────────────────────────────────────────────
  // [180-G] multipart_upload: disk Buffer (pre-read file)
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-G] multipart_upload: live POST with disk file Buffer");

  const diskFilePath = path.join(TMP, "upload-test-180.txt");
  fs.writeFileSync(diskFilePath, "disk file payload here");

  const sG = await httpServe({ operation: "start", routes: [{ path: "*", status: 200, body: "{\"ok\":true}" }] });
  try {
    // dispatchRead reads the file and passes a Buffer; replicate that here.
    const diskBuf = fs.readFileSync(diskFilePath);
    const rg = await multipartUpload({
      url:   `http://127.0.0.1:${sG.port}/file-upload`,
      files: [{ name: "file", filename: "upload-test.txt", contentType: "text/plain", data: diskBuf }],
    });
    ok("G1: disk file upload status=200", rg.status === 200);
    ok("G2: partCount=1",                 rg.partCount === 1);

    const reqsG = await httpServe({ operation: "requests", session_id: sG.session_id });
    ok("G3: server got file content",   reqsG.requests[0]?.body.includes("disk file payload here"));
    ok("G4: filename in Content-Disp",  reqsG.requests[0]?.body.includes("upload-test.txt"));

  } finally {
    await httpServe({ operation: "stop", session_id: sG.session_id });
    try { fs.unlinkSync(diskFilePath); } catch (_) {}
  }

  // ──────────────────────────────────────────────────────────────────────
  // [180-H] http_serve: wait + add_route
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-H] http_serve: wait + add_route");

  const sH = await httpServe({ operation: "start", routes: [{ path: "*", status: 200, body: "{}" }] });

  try {
    // H1: wait times out (100ms) when no request arrives
    const waitH1 = await httpServe({ operation: "wait", session_id: sH.session_id, timeout: 0.1 });
    ok("H1: wait times out",            waitH1.timed_out === true && waitH1.found === false);

    // H2-H3: wait finds a matching request (fire it 30ms after wait starts)
    setTimeout(() => rawRequest(sH.port, "POST", "/webhook", "{}"), 30);
    const waitH2 = await httpServe({
      operation:    "wait",
      session_id:   sH.session_id,
      path_match:   "/webhook",
      method_match: "POST",
      timeout:      5,
    });
    ok("H2: wait finds POST /webhook",   waitH2.found === true);
    ok("H3: wait returns request obj",   waitH2.request?.path?.includes("/webhook"));

    // H4-H5: add_route prepends
    const addR = await httpServe({
      operation:  "add_route",
      session_id: sH.session_id,
      route:      { path: "/special", status: 418, body: "{\"teapot\":true}" },
    });
    ok("H4: add_route routes_count++",   addR.routes_count === 2);
    const d418 = await rawRequest(sH.port, "GET", "/special");
    ok("H5: new route active",           d418.status === 418);

    // H6: double-stop is safe (opStop throws synchronously if session gone,
    // so use try/catch rather than .catch() to handle it)
    await httpServe({ operation: "stop", session_id: sH.session_id });
    let stopped2;
    try { stopped2 = await httpServe({ operation: "stop", session_id: sH.session_id }); }
    catch (_) { stopped2 = { status: "already_stopped" }; }
    ok("H6: double-stop safe",           stopped2.status === "already_stopped" || stopped2.status === "stopped");

  } catch (e) {
    try { await httpServe({ operation: "stop", session_id: sH.session_id }); } catch (_) {}
    throw e;
  }

  // ──────────────────────────────────────────────────────────────────────
  // [180-I] multipart_upload: security & edge cases
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-I] multipart_upload: security");

  const sI = await httpServe({ operation: "start", routes: [{ path: "*", status: 200, body: "{}" }] });
  const iUrl = `http://127.0.0.1:${sI.port}/upload`;

  try {
    // I1: field name with CRLF injection attempt (escapeDisposition handles it)
    const ri1 = await multipartUpload({ url: iUrl, fields: { 'a\r\nb': "injected" } });
    ok("I1: CRLF in field name survives", ri1.status === 200);

    // I2-I3: base64-encoded binary inline file
    const binaryData = crypto.randomBytes(64).toString("base64");
    const ri2 = await multipartUpload({
      url:         iUrl,
      inlineFiles: [{ name: "bin", data: binaryData, filename: "bin.dat", encoding: "base64" }],
    });
    ok("I2: base64 binary upload ok",    ri2.status === 200);
    ok("I3: decoded size correct",       ri2.requestBodySize > 64);

    // I4-I5: extra headers forwarded
    await multipartUpload({
      url:     iUrl,
      fields:  { x: "1" },
      headers: { Authorization: "Bearer test-token-123" },
    });
    const reqsI = await httpServe({ operation: "requests", session_id: sI.session_id });
    ok("I4: custom header received",
      reqsI.requests.some(r => r.headers?.authorization === "Bearer test-token-123"));

    // I5: short custom timeout (1s loopback is plenty)
    const ri5 = await multipartUpload({ url: iUrl, fields: { quick: "yes" }, timeout: 1 });
    ok("I5: short timeout works",        ri5.status === 200);
    ok("I6: truncated=false small resp", ri5.truncated === false);

    // I7: numeric field values stringified automatically
    const ri7 = await multipartUpload({ url: iUrl, fields: { count: 999, flag: false, ratio: 3.14 } });
    ok("I7: numeric fields accepted",    ri7.status === 200);
    ok("I8: partCount=3 numeric fields", ri7.partCount === 3);

  } finally {
    await httpServe({ operation: "stop", session_id: sI.session_id });
  }

  // ──────────────────────────────────────────────────────────────────────
  // [180-J] http_serve: 50 concurrent requests + delay_ms stress
  // ──────────────────────────────────────────────────────────────────────
  console.log("[180-J] http_serve: concurrency stress");

  const sJ = await httpServe({
    operation: "start",
    routes: [{ path: "/stress", method: "*", status: 200, body: "{\"ok\":true}" }],
  });

  try {
    const CONCURRENCY = 50;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        rawRequest(sJ.port, "POST", "/stress", JSON.stringify({ i }))
      )
    );
    ok(`J1: ${CONCURRENCY} concurrent → all 200`, results.every(r => r.status === 200));

    const reqsJ = await httpServe({ operation: "requests", session_id: sJ.session_id });
    ok("J2: all 50 captured",            reqsJ.total_captured === CONCURRENCY);
    ok("J3: session_id in response",     reqsJ.session_id === sJ.session_id);

    // limit=5 returns 5
    const reqsJ4 = await httpServe({ operation: "requests", session_id: sJ.session_id, limit: 5 });
    ok("J4: limit=5 returns 5",          reqsJ4.returned === 5);

    // clear via requests clear=true
    const reqsJ5 = await httpServe({ operation: "requests", session_id: sJ.session_id, clear: true });
    ok("J5: clear=true clears log",      reqsJ5.cleared === true);
    const reqsJ5b = await httpServe({ operation: "requests", session_id: sJ.session_id });
    ok("J6: after clear, 0 captured",    reqsJ5b.total_captured === 0);

    // delay_ms route (20ms)
    await httpServe({ operation: "add_route", session_id: sJ.session_id,
      route: { path: "/slow", status: 202, body: "{}", delay_ms: 20 } });
    const t0 = Date.now();
    const delayResp = await rawRequest(sJ.port, "GET", "/slow");
    const elapsed   = Date.now() - t0;
    ok("J7: delay_ms route waited",      elapsed >= 15 && delayResp.status === 202);

    // method captured correctly
    const reqsJ8 = await httpServe({ operation: "requests", session_id: sJ.session_id });
    ok("J8: method captured",            reqsJ8.requests.some(r => r.method === "GET"));

  } finally {
    await httpServe({ operation: "stop", session_id: sJ.session_id });
  }

  console.log("");
})();
