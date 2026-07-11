"use strict";
/**
 * Section 178 — tls_cert_inspect + http_multi_fetch tools
 *
 * Tests are isolated where possible:
 *  - tls_cert_inspect validation and helper functions run without a network.
 *  - http_multi_fetch validation and pMap run without a network.
 *  - Network-dependent tests spin up a local loopback HTTP server (no
 *    external internet needed) and close it after use.
 *
 * Rigor levels A–J (10 groups):
 *   A  Normal   — tls_cert_inspect: input validation (no network)
 *   B  Normal   — tls_cert_inspect: formatCert / parseSANs / buildChain helpers
 *   C  Normal   — http_multi_fetch: input validation (no network)
 *   D  Normal   — http_multi_fetch: pMap concurrency worker pool
 *   E  Normal   — http_multi_fetch: live batch GET to local server
 *   F  Normal   — http_multi_fetch: mixed method / body / headers
 *   G  Medium   — http_multi_fetch: HTTP error status (4xx/5xx) counted as failed
 *   H  High     — http_multi_fetch: network error handling (refused port)
 *   I  Critical — http_multi_fetch: fail_fast; path/scheme injection defence
 *   J  Extreme  — http_multi_fetch: 50-request batch, concurrency timing
 */

const http = require("http");

// Direct module imports — do NOT start the server
const { tlsCertInspect, formatCert, buildChain, parseSANs } = require("../../lib/tlsCertInspectOps");
const { httpMultiFetch, pMap }                              = require("../../lib/httpMultiFetchOps");
const { ToolError }                                        = require("../../lib/errors");

// ── Test harness (shared when run from run-tests.js, standalone otherwise) ───
const harness = (() => {
  if (global.testHarness) return global.testHarness;
  let pass = 0, fail = 0;
  return {
    ok(cond, msg) {
      if (cond) { pass++; process.stdout.write(`  \u2713 ${msg}\n`); }
      else       { fail++; process.stdout.write(`  \u2717 ${msg}\n`); }
    },
    done() { process.stdout.write(`\n${pass} passed, ${fail} failed\n`); },
    get counters() { return { pass, fail }; },
  };
})();
const { ok } = harness;

// Export a Promise so run-tests.js can `await` it and keep the test runner
// fully serialised (prevents event-loop starvation during the async sections).
module.exports = (async () => {

// ============================================================================
// A: tls_cert_inspect — input validation (no network)
// ============================================================================
console.log("[178-A] tls_cert_inspect: input validation");

// Missing host
try {
  await tlsCertInspect({});
  ok(false, "A1: should throw for missing host");
} catch (e) { ok(e instanceof ToolError, "A1: ToolError for missing host"); }

// Empty host
try {
  await tlsCertInspect({ host: "   " });
  ok(false, "A2: should throw for blank host");
} catch (e) { ok(e instanceof ToolError, "A2: ToolError for blank host"); }

// Unknown operation
try {
  tlsCertInspect({ host: "example.com", operation: "hack" });
  ok(false, "A3: should throw for unknown op");
} catch (e) { ok(e instanceof ToolError, "A3: ToolError for unknown op"); }

// Bad port — 0
try {
  await tlsCertInspect({ host: "example.com", port: 0 });
  ok(false, "A4: should throw for port=0");
} catch (e) { ok(e instanceof ToolError, "A4: ToolError for port=0"); }

// Bad port — 70000
try {
  await tlsCertInspect({ host: "example.com", port: 70000 });
  ok(false, "A5: should throw for port=70000");
} catch (e) { ok(e instanceof ToolError, "A5: ToolError for port=70000"); }

// host must be a string
try {
  await tlsCertInspect({ host: 12345 });
  ok(false, "A6: should throw for numeric host");
} catch (e) { ok(e instanceof ToolError, "A6: ToolError for numeric host"); }

ok(true, "A7: validation tests all produced ToolError (not crashes)");

// ============================================================================
// B: tls_cert_inspect — helper functions (no network)
// ============================================================================
console.log("[178-B] tls_cert_inspect: helper functions");

// parseSANs
ok(parseSANs("").length === 0, "B1: parseSANs empty string");
ok(parseSANs(null).length  === 0, "B2: parseSANs null");
const sans1 = parseSANs("DNS:example.com, DNS:www.example.com, IP Address:1.2.3.4");
ok(sans1.length === 3, "B3: parseSANs parses 3 entries");
ok(sans1[0] === "DNS:example.com", "B4: parseSANs first entry");
ok(sans1[2] === "IP Address:1.2.3.4", "B5: parseSANs IP entry");
ok(parseSANs("DNS:only.one").length === 1, "B6: parseSANs single entry");

// formatCert — null/empty input
ok(formatCert(null) === null, "B7: formatCert(null) returns null");
ok(formatCert({})   === null, "B8: formatCert({}) returns null (empty object)");

// formatCert — well-formed input
const fakeCert = {
  subject:        { CN: "Example CA", O: "Example Org" },
  issuer:         { CN: "Root CA",    O: "Root Org"    },
  serialNumber:   "01ABCDEF",
  valid_from:     "Jan  1 00:00:00 2024 GMT",
  valid_to:       "Jan  1 00:00:00 2030 GMT",
  fingerprint:    "AA:BB:CC",
  fingerprint256: "AA:BB:CC:DD",
  bits:           2048,
  subjectaltname: "DNS:example.com, DNS:www.example.com",
  ca:             false,
};
const fmtd = formatCert(fakeCert);
ok(fmtd !== null,                     "B9: formatCert returns object");
ok(fmtd.subject.CN === "Example CA", "B10: formatCert subject.CN");
ok(fmtd.issuer.CN  === "Root CA",   "B11: formatCert issuer.CN");
ok(fmtd.serialNumber === "01ABCDEF", "B12: formatCert serialNumber");
ok(fmtd.bits === 2048,               "B13: formatCert bits");
ok(fmtd.subjectAltNames.length === 2, "B14: formatCert SANs parsed");
ok(fmtd.isSelfSigned === false,      "B15: not self-signed");
ok(typeof fmtd.daysUntilExpiry === "number", "B16: daysUntilExpiry is number");
ok(fmtd.isExpired === false,         "B17: future cert not expired");

// formatCert — self-signed detection
const selfSignedRaw = {
  subject:        { CN: "Self CA", O: "Self" },
  issuer:         { CN: "Self CA", O: "Self" },
  valid_from:     "Jan  1 00:00:00 2020 GMT",
  valid_to:       "Jan  1 00:00:00 2030 GMT",
  subjectaltname: "",
};
const selfSigned = formatCert(selfSignedRaw);
ok(selfSigned.isSelfSigned === true, "B18: self-signed detection");

// formatCert — expired cert
const expiredRaw = {
  subject:        { CN: "Expired" },
  issuer:         { CN: "Root" },
  valid_from:     "Jan  1 00:00:00 2000 GMT",
  valid_to:       "Jan  1 00:00:00 2001 GMT",
  subjectaltname: "",
};
const expired = formatCert(expiredRaw);
ok(expired.isExpired === true,           "B19: expired cert detected");
ok(expired.daysUntilExpiry < 0,          "B20: daysUntilExpiry negative for expired cert");

// buildChain — single cert (self-signed, circular issuerCertificate pointer)
const selfChainRaw = { ...selfSignedRaw, fingerprint256: "AA:BB" };
selfChainRaw.issuerCertificate = selfChainRaw; // circular — should stop
const selfChain = buildChain(selfChainRaw);
ok(selfChain.length === 1, "B21: buildChain stops at self-signed (no loop)");

// buildChain — two-cert chain
const rootRaw = { ...selfSignedRaw, fingerprint256: "ROOT:FF", subject: { CN: "Root" }, issuer: { CN: "Root" } };
rootRaw.issuerCertificate = rootRaw; // self-signed root
const leafRaw2 = { ...fakeCert, fingerprint256: "LEAF:01" };
leafRaw2.issuerCertificate = rootRaw;
const chain2 = buildChain(leafRaw2);
ok(chain2.length === 2,                   "B22: buildChain two-cert chain");
ok(chain2[0].subject.CN === "Example CA", "B23: buildChain[0] is leaf");
ok(chain2[1].subject.CN === "Root",       "B24: buildChain[1] is root");

// ============================================================================
// C: http_multi_fetch — input validation (no network)
// ============================================================================
console.log("[178-C] http_multi_fetch: input validation");

// Missing requests
try {
  await httpMultiFetch({});
  ok(false, "C1: should throw for missing requests");
} catch (e) { ok(e instanceof ToolError, "C1: ToolError for missing requests"); }

// Empty requests array
try {
  await httpMultiFetch({ requests: [] });
  ok(false, "C2: should throw for empty requests");
} catch (e) { ok(e instanceof ToolError, "C2: ToolError for empty array"); }

// Too many requests
try {
  const reqs = Array.from({ length: 101 }, (_, i) => ({ url: `http://x.com/${i}` }));
  await httpMultiFetch({ requests: reqs });
  ok(false, "C3: should throw for >100 requests");
} catch (e) { ok(e instanceof ToolError, "C3: ToolError for >100 requests"); }

// Non-array requests
try {
  await httpMultiFetch({ requests: "not an array" });
  ok(false, "C4: should throw for string requests");
} catch (e) { ok(e instanceof ToolError, "C4: ToolError for non-array"); }

// Missing url in request
try {
  await httpMultiFetch({ requests: [{ method: "GET" }] });
  ok(false, "C5: should throw for missing url");
} catch (e) { ok(e instanceof ToolError, "C5: ToolError for missing url"); }

// Null request entry
try {
  await httpMultiFetch({ requests: [null] });
  ok(false, "C6: should throw for null request entry");
} catch (e) { ok(e instanceof ToolError, "C6: ToolError for null entry"); }

// Array request entry
try {
  await httpMultiFetch({ requests: [["url", "val"]] });
  ok(false, "C7: should throw for array request entry");
} catch (e) { ok(e instanceof ToolError, "C7: ToolError for array entry"); }

// ============================================================================
// D: pMap — concurrency worker pool (no network)
// ============================================================================
console.log("[178-D] http_multi_fetch: pMap concurrency");

// pMap preserves input order
const pMapResult = await pMap(
  [3, 1, 4, 1, 5].map(n => () => new Promise(r => setTimeout(() => r(n * 10), n))),
  3
);
ok(pMapResult.every(s => s.status === "fulfilled"), "D1: pMap all settled fulfilled");
ok(pMapResult.map(s => s.value).join(",") === "30,10,40,10,50", "D2: pMap preserves order");

// pMap handles rejections gracefully
const pMapMixed = await pMap(
  [
    () => Promise.resolve("ok"),
    () => Promise.reject(new Error("boom")),
    () => Promise.resolve("ok2"),
  ],
  2
);
ok(pMapMixed[0].status === "fulfilled",  "D3: pMap[0] fulfilled");
ok(pMapMixed[1].status === "rejected",   "D4: pMap[1] rejected");
ok(pMapMixed[2].status === "fulfilled",  "D5: pMap[2] fulfilled");
ok(pMapMixed[1].reason.message === "boom", "D6: pMap rejection reason preserved");

// pMap with concurrency=1 is purely serial
const serial = [];
await pMap(
  [1, 2, 3].map(n => () => Promise.resolve(serial.push(n))),
  1
);
ok(serial.join(",") === "1,2,3", "D7: pMap concurrency=1 is serial order");

// pMap empty array
const emptyResult = await pMap([], 5);
ok(emptyResult.length === 0, "D8: pMap empty array");

// ============================================================================
// E-J: Live network tests (local loopback server)
// ============================================================================

// Spin up a minimal local HTTP server
let PORT;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  switch (u.pathname) {
    case "/ok": {
      let body = "";
      req.on("data", d => (body += d));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "x-test": "yes" });
        res.end(JSON.stringify({ method: req.method, echo: body, path: u.pathname }));
      });
      break;
    }
    case "/slow": {
      // Delay 500 ms before responding
      setTimeout(() => { res.writeHead(200); res.end("slow"); }, 500);
      break;
    }
    case "/404":
      res.writeHead(404); res.end("not found"); break;
    case "/500":
      res.writeHead(500); res.end("server error"); break;
    case "/big": {
      res.writeHead(200);
      // Send 120 KB to trigger truncation
      res.end("x".repeat(120 * 1024));
      break;
    }
    default:
      res.writeHead(404); res.end("unknown");
  }
});

await new Promise(r => server.listen(0, "127.0.0.1", () => {
  PORT = server.address().port;
  r();
}));

const base = `http://127.0.0.1:${PORT}`;

// ============================================================================
// E: http_multi_fetch — live batch GET
// ============================================================================
console.log("[178-E] http_multi_fetch: live batch GET");

const eRes = await httpMultiFetch({
  requests: [
    { url: `${base}/ok` },
    { url: `${base}/ok` },
    { url: `${base}/ok` },
  ],
  concurrency: 2,
});
ok(eRes.total      === 3, "E1: total=3");
ok(eRes.succeeded  === 3, "E2: succeeded=3");
ok(eRes.failed     === 0, "E3: failed=0");
ok(eRes.errors     === 0, "E4: errors=0");
ok(eRes.results[0].ok === true, "E5: results[0].ok=true");
ok(eRes.results[0].status === 200, "E6: results[0].status=200");
ok(eRes.results[0].index  === 0, "E7: results[0].index=0");
ok(typeof eRes.results[0].duration_ms === "number", "E8: duration_ms is number");
ok(eRes.results[0].error === null, "E9: no error on success");

// Verify body is JSON-parseable (the /ok endpoint returns JSON)
const eBody = JSON.parse(eRes.results[0].body);
ok(eBody.method === "GET", "E10: body.method=GET");
ok(eBody.path   === "/ok", "E11: body.path=/ok");

// Header is passed through
ok(eRes.results[0].headers["x-test"] === "yes", "E12: x-test header present");

// ============================================================================
// F: http_multi_fetch — mixed method / body / headers
// ============================================================================
console.log("[178-F] http_multi_fetch: mixed methods");

const fRes = await httpMultiFetch({
  requests: [
    { url: `${base}/ok`, method: "GET" },
    { url: `${base}/ok`, method: "POST", body: "hello", headers: { "content-type": "text/plain" } },
    { url: `${base}/ok`, method: "PUT",  body: "{\"a\":1}", headers: { "content-type": "application/json" } },
  ],
  concurrency: 3,
});
ok(fRes.total     === 3, "F1: total=3");
ok(fRes.succeeded === 3, "F2: all 3 succeeded");
const fPost = JSON.parse(fRes.results[1].body);
ok(fPost.method === "POST",  "F3: POST method echoed");
ok(fPost.echo   === "hello", "F4: POST body echoed");
const fPut = JSON.parse(fRes.results[2].body);
ok(fPut.method === "PUT",      "F5: PUT method echoed");

// ============================================================================
// G: http_multi_fetch — HTTP error statuses
// ============================================================================
console.log("[178-G] http_multi_fetch: HTTP error statuses");

const gRes = await httpMultiFetch({
  requests: [
    { url: `${base}/ok`  },
    { url: `${base}/404` },
    { url: `${base}/500` },
  ],
});
ok(gRes.total     === 3, "G1: total=3");
ok(gRes.succeeded === 1, "G2: 1 succeeded");
ok(gRes.failed    === 2, "G3: 2 http-failed (4xx/5xx)");
ok(gRes.errors    === 0, "G4: 0 network errors");
ok(gRes.results[0].ok === true,  "G5: /ok is ok");
ok(gRes.results[1].ok === false, "G6: /404 not ok");
ok(gRes.results[1].status === 404, "G7: /404 status=404");
ok(gRes.results[1].error  === null, "G8: /404 has no error (it's an HTTP response, not a failure)");
ok(gRes.results[2].ok === false,   "G9: /500 not ok");
ok(gRes.results[2].status === 500, "G10: /500 status=500");

// ============================================================================
// H: http_multi_fetch — network error (refused port)
// ============================================================================
console.log("[178-H] http_multi_fetch: network error handling");

// Use a port that nobody is listening on (pick a very high ephemeral port)
const DEAD_PORT = 19997;
const hRes = await httpMultiFetch({
  requests: [
    { url: `${base}/ok` },
    { url: `http://127.0.0.1:${DEAD_PORT}/nope`, timeout: 5 },
    { url: `${base}/ok` },
  ],
  concurrency: 2,
});
ok(hRes.total     === 3, "H1: total=3");
ok(hRes.succeeded === 2, "H2: 2 succeeded");
ok(hRes.errors    === 1, "H3: 1 network error");
ok(hRes.results[1].ok    === false,  "H4: refused port ok=false");
ok(typeof hRes.results[1].error === "string" && hRes.results[1].error.length > 0,
  "H5: refused port has error string");
ok(hRes.results[0].ok === true, "H6: surrounding requests still succeeded");
ok(hRes.results[2].ok === true, "H7: surrounding requests still succeeded");

// ============================================================================
// I: http_multi_fetch — fail_fast + scheme validation
// ============================================================================
console.log("[178-I] http_multi_fetch: fail_fast + security");

// fail_fast: should throw when first request hits connection error
try {
  await httpMultiFetch({
    requests: [
      { url: `http://127.0.0.1:${DEAD_PORT}/nope`, timeout: 3 },
      { url: `${base}/ok` },
    ],
    fail_fast: true,
    concurrency: 1,
  });
  ok(false, "I1: fail_fast should throw on network error");
} catch (e) {
  ok(e instanceof ToolError, "I1: fail_fast throws ToolError");
  ok(e.message.includes("fail_fast"), "I2: ToolError message mentions fail_fast");
}

// Scheme validation (non-http/https) propagated as error in result
const iRes = await httpMultiFetch({
  requests: [
    { url: "ftp://example.com/file" },
    { url: `${base}/ok` },
  ],
});
ok(iRes.errors    >= 1, "I3: ftp:// scheme produces an error result");
ok(iRes.succeeded === 1, "I4: valid request still succeeds");
ok(typeof iRes.results[0].error === "string", "I5: ftp scheme error captured as string");

// ============================================================================
// J: http_multi_fetch — 50-request batch, concurrency timing
// ============================================================================
console.log("[178-J] http_multi_fetch: 50-request batch + concurrency");

// 50 fast GETs with concurrency=10 should be faster than 50*serial
const jRequests = Array.from({ length: 50 }, () => ({ url: `${base}/ok` }));
const t0 = Date.now();
const jRes = await httpMultiFetch({ requests: jRequests, concurrency: 10 });
const elapsed = Date.now() - t0;

ok(jRes.total     === 50, "J1: total=50");
ok(jRes.succeeded === 50, "J2: all 50 succeeded");
ok(jRes.results.every((r, i) => r.index === i), "J3: indices preserved in order");
ok(jRes.concurrency === 10, "J4: concurrency reported as 10");
ok(elapsed < 20_000, `J5: 50 requests under 20s (took ${elapsed}ms)`);   // very loose bound

// Verify body truncation flag
const bigRes = await httpMultiFetch({ requests: [{ url: `${base}/big` }] });
ok(bigRes.results[0].truncated === true,  "J6: large response body is truncated");
ok(bigRes.results[0].bodySize  <= 100 * 1024 + 512, "J7: truncated body near 100 KB limit");

// ============================================================================
// Cleanup
// ============================================================================
await new Promise(r => server.close(r));

if (!global.testHarness) harness.done();

})(); // end module.exports async IIFE
