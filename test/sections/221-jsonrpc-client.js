"use strict";
/**
 * test/sections/221-jsonrpc-client.js
 * Comprehensive tests for jsonrpc_client tool (section 221)
 * Rigor levels:
 *   A = validation (10 tests)
 *   B = unit / builder functions (20 tests)
 *   C = happy-path HTTP (20 tests)
 *   D = security / edge cases (10 tests)
 *   E = error paths (10 tests)
 *   F = concurrency (6 tests)
 * Total: 76 tests
 */

const http = require("http");
const net  = require("net");

const {
  jsonrpcClient,
  buildRequest,
  buildNotification,
  parseJsonRpcResponse,
} = require("../../lib/jsonrpcClientOps");

// ── Test harness ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error((msg || "assertEqual") + ": expected " + JSON.stringify(b) + ", got " + JSON.stringify(a));
}

function assertMatch(str, re, msg) {
  if (!re.test(str)) throw new Error((msg || "assertMatch") + ": " + JSON.stringify(str) + " did not match " + re);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stderr.write("  ✓ " + name + "\n");
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    process.stderr.write("  ✗ " + name + " — " + e.message + "\n");
  }
}

// ── Mock HTTP JSON-RPC server helpers ─────────────────────────────────────────

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", d => (body += d));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          handler(parsed, res);
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
    srv.on("error", reject);
  });
}

function stopServer(srv) {
  return new Promise(resolve => srv.close(resolve));
}

function serverUrl(srv) {
  return "http://127.0.0.1:" + srv.address().port;
}

// Echo handler: returns { result: { echoed: method, params } }
function echoHandler(req, res) {
  if (Array.isArray(req)) {
    const responses = req
      .filter(r => r.id != null)
      .map(r => ({ jsonrpc: "2.0", result: { echoed: r.method, params: r.params }, id: r.id }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responses));
  } else {
    if (req.id == null) {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", result: { echoed: req.method, params: req.params }, id: req.id }));
    }
  }
}

function errorHandler(code, message) {
  return (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: req.id != null ? req.id : null }));
  };
}

// ── Mock TCP JSON-RPC server helper ───────────────────────────────────────────

function startTcpServer(handler) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(sock => {
      let buf = "";
      sock.on("data", d => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          try {
            const req = JSON.parse(line);
            handler(req, sock);
          } catch (e) {
            sock.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }) + "\n");
            sock.end();
          }
        }
      });
      sock.on("error", () => {});
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
    srv.on("error", reject);
  });
}

// ── Main test runner ────────────────────────────────────────────────────────

async function run() {
  process.stderr.write("\n=== Section 221: jsonrpc_client ===\n");

  // ── Section A: Validation (10) ───────────────────────────────────────
  process.stderr.write("\n-- A: Validation --\n");

  await test("A01 missing operation throws", async () => {
    let threw = false;
    try { await jsonrpcClient({}); } catch (e) { threw = true; assertMatch(e.message, /operation.*required/i); }
    assert(threw);
  });

  await test("A02 unknown operation throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "blast" }); } catch (e) { threw = true; assertMatch(e.message, /unknown operation/i); }
    assert(threw);
  });

  await test("A03 call missing url throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call", method: "foo" }); } catch (e) { threw = true; assertMatch(e.message, /url.*required/i); }
    assert(threw);
  });

  await test("A04 call missing method throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call", url: "http://localhost" }); } catch (e) { threw = true; assertMatch(e.message, /method.*required/i); }
    assert(threw);
  });

  await test("A05 notify missing url throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "notify", method: "m" }); } catch (e) { threw = true; assertMatch(e.message, /url.*required/i); }
    assert(threw);
  });

  await test("A06 batch missing url throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "batch", calls: [{ method: "m" }] }); } catch (e) { threw = true; assertMatch(e.message, /url.*required/i); }
    assert(threw);
  });

  await test("A07 batch empty calls throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "batch", url: "http://localhost", calls: [] }); } catch (e) { threw = true; assertMatch(e.message, /non-empty/i); }
    assert(threw);
  });

  await test("A08 call_tcp missing host throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call_tcp", port: 9, method: "x" }); } catch (e) { threw = true; assertMatch(e.message, /host.*required/i); }
    assert(threw);
  });

  await test("A09 call_unix missing socket_path throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call_unix", method: "x" }); } catch (e) { threw = true; assertMatch(e.message, /socket_path.*required/i); }
    assert(threw);
  });

  await test("A10 call_unix NUL byte in path throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call_unix", socket_path: "/tmp/ok\0bad", method: "x" }); }
    catch (e) { threw = true; assertMatch(e.message, /NUL byte/i); }
    assert(threw);
  });

  // ── Section B: Unit / Builder Functions (20) ────────────────────────────
  process.stderr.write("\n-- B: Unit / Builder Functions --\n");

  await test("B01 buildRequest includes jsonrpc 2.0", async () => {
    const r = buildRequest("add", [1, 2], 1);
    assertEqual(r.jsonrpc, "2.0");
    assertEqual(r.method, "add");
    assert(Array.isArray(r.params));
    assertEqual(r.id, 1);
  });

  await test("B02 buildRequest no params omits params key", async () => {
    const r = buildRequest("ping", undefined, 1);
    assert(!("params" in r));
  });

  await test("B03 buildNotification has no id", async () => {
    const n = buildNotification("event", { x: 1 });
    assertEqual(n.jsonrpc, "2.0");
    assert(!("id" in n));
  });

  await test("B04 buildNotification no params omits params", async () => {
    const n = buildNotification("ping");
    assert(!("params" in n));
  });

  await test("B05 buildRequest named params (object)", async () => {
    const r = buildRequest("getUser", { id: 42 }, 5);
    assertEqual(r.params.id, 42);
  });

  await test("B06 buildRequest string id", async () => {
    const r = buildRequest("m", [], "req-abc");
    assertEqual(r.id, "req-abc");
  });

  await test("B07 buildRequest null id", async () => {
    const r = buildRequest("m", [], null);
    assertEqual(r.id, null);
  });

  await test("B08 parseJsonRpcResponse valid JSON parses ok", async () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", result: 42, id: 1 });
    const parsed = parseJsonRpcResponse(raw, false);
    assertEqual(parsed.result, 42);
  });

  await test("B09 parseJsonRpcResponse empty string + isNotification returns notified", async () => {
    const parsed = parseJsonRpcResponse("", true);
    assertEqual(parsed.notified, true);
  });

  await test("B10 parseJsonRpcResponse invalid JSON throws", async () => {
    let threw = false;
    try { parseJsonRpcResponse("not json", false); }
    catch (e) { threw = true; assertMatch(e.message, /invalid JSON/i); }
    assert(threw);
  });

  await test("B11 parseJsonRpcResponse whitespace-only + notification returns notified", async () => {
    const parsed = parseJsonRpcResponse("   \t\n  ", true);
    assertEqual(parsed.notified, true);
  });

  await test("B12 buildRequest id=0 is preserved", async () => {
    const r = buildRequest("m", [], 0);
    assertEqual(r.id, 0);
  });

  await test("B13 buildRequest two different explicit ids are distinct", async () => {
    const r1 = buildRequest("m", undefined, 100);
    const r2 = buildRequest("m", undefined, 101);
    assert(r1.id !== r2.id);
  });

  await test("B14 buildRequest with array params", async () => {
    const r = buildRequest("sum", [1, 2, 3], 1);
    assertEqual(r.params.length, 3);
  });

  await test("B15 buildRequest method is preserved verbatim", async () => {
    const r = buildRequest("eth_getBalance", [], 1);
    assertEqual(r.method, "eth_getBalance");
  });

  await test("B16 buildNotification with array params", async () => {
    const n = buildNotification("heartbeat", [42]);
    assertEqual(n.params[0], 42);
  });

  await test("B17 parseJsonRpcResponse null body is valid JSON", async () => {
    const parsed = parseJsonRpcResponse("null", false);
    assertEqual(parsed, null);
  });

  await test("B18 buildRequest with nested object params", async () => {
    const params = { a: { b: [1, 2] } };
    const r = buildRequest("m", params, 1);
    assertEqual(r.params.a.b[0], 1);
  });

  await test("B19 parseJsonRpcResponse number body", async () => {
    const parsed = parseJsonRpcResponse("42", false);
    assertEqual(parsed, 42);
  });

  await test("B20 parseJsonRpcResponse batch array body", async () => {
    const batch = [{ jsonrpc: "2.0", result: 1, id: 1 }, { jsonrpc: "2.0", result: 2, id: 2 }];
    const parsed = parseJsonRpcResponse(JSON.stringify(batch), false);
    assert(Array.isArray(parsed));
    assertEqual(parsed.length, 2);
  });

  // ── Section C: Happy-Path HTTP (20) ─────────────────────────────────
  process.stderr.write("\n-- C: Happy-Path HTTP --\n");

  const echoSrv = await startMockServer(echoHandler);
  const echoUrl = serverUrl(echoSrv);

  await test("C01 call returns result", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "add", params: [1, 2] });
    assertEqual(r.operation, "call");
    assertEqual(r.result.echoed, "add");
  });

  await test("C02 call result has auto-assigned id", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "m" });
    assert(r.id != null);
  });

  await test("C03 call with explicit numeric id", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "m", id: 42 });
    assertEqual(r.id, 42);
  });

  await test("C04 call with string id", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "m", id: "myId" });
    assertEqual(r.id, "myId");
  });

  await test("C05 call with named params echoed back", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "greet", params: { name: "world" } });
    assertEqual(r.result.params.name, "world");
  });

  await test("C06 call with array params echoed back", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "sum", params: [1, 2, 3] });
    assertEqual(r.result.params[0], 1);
  });

  await test("C07 call statusCode is 200", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "m" });
    assertEqual(r.statusCode, 200);
  });

  await test("C08 call include_raw returns raw string", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "m", include_raw: true });
    assert(typeof r.raw === "string");
    assertMatch(r.raw, /jsonrpc/);
  });

  await test("C09 call without include_raw has undefined raw", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "m" });
    assertEqual(r.raw, undefined);
  });

  await test("C10 notify returns notified:true", async () => {
    const r = await jsonrpcClient({ operation: "notify", url: echoUrl, method: "update", params: { v: 1 } });
    assertEqual(r.operation, "notify");
    assertEqual(r.notified, true);
  });

  await test("C11 notify statusCode 2xx", async () => {
    const r = await jsonrpcClient({ operation: "notify", url: echoUrl, method: "ping" });
    assert(r.statusCode >= 200 && r.statusCode < 300);
  });

  await test("C12 notify has no result field", async () => {
    const r = await jsonrpcClient({ operation: "notify", url: echoUrl, method: "e" });
    assertEqual(r.result, undefined);
  });

  await test("C13 batch single call", async () => {
    const r = await jsonrpcClient({ operation: "batch", url: echoUrl, calls: [{ method: "add", params: [1, 2] }] });
    assertEqual(r.operation, "batch");
    assertEqual(r.callCount, 1);
    assert(Array.isArray(r.results));
  });

  await test("C14 batch multiple calls aligned by id", async () => {
    const r = await jsonrpcClient({ operation: "batch", url: echoUrl, calls: [
      { method: "a" }, { method: "b" }, { method: "c" },
    ]});
    assertEqual(r.results.length, 3);
    assertEqual(r.results[0].method, "a");
    assertEqual(r.results[1].method, "b");
    assertEqual(r.results[2].method, "c");
  });

  await test("C15 batch notification entry has notify:true", async () => {
    const r = await jsonrpcClient({ operation: "batch", url: echoUrl, calls: [
      { method: "event", notify: true },
      { method: "query" },
    ]});
    assertEqual(r.results[0].notify, true);
    assertEqual(r.results[0].notified, true);
    assert(!r.results[1].notify);
  });

  await test("C16 batch include_raw returns raw", async () => {
    const r = await jsonrpcClient({ operation: "batch", url: echoUrl, calls: [{ method: "m" }], include_raw: true });
    assert(typeof r.raw === "string");
  });

  await test("C17 call url is echoed in response", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "m" });
    assertEqual(r.url, echoUrl);
  });

  await test("C18 call with custom headers succeeds", async () => {
    const r = await jsonrpcClient({ operation: "call", url: echoUrl, method: "m", headers: { "X-Test": "1" } });
    assert(r.result !== undefined || r.result === null);
  });

  await test("C19 batch with explicit ids in calls", async () => {
    const r = await jsonrpcClient({ operation: "batch", url: echoUrl, calls: [
      { method: "x", id: 99 }, { method: "y", id: 100 },
    ]});
    assertEqual(r.results[0].id, 99);
    assertEqual(r.results[1].id, 100);
  });

  await test("C20 notify include_raw in result", async () => {
    const r = await jsonrpcClient({ operation: "notify", url: echoUrl, method: "evt", include_raw: true });
    assert("raw" in r);
  });

  await stopServer(echoSrv);

  // ── Section D: Security & Edge Cases (10) ──────────────────────────────
  process.stderr.write("\n-- D: Security & Edge Cases --\n");

  await test("D01 batch >100 calls throws before any HTTP", async () => {
    const calls = Array.from({ length: 101 }, (_, i) => ({ method: "m" + i }));
    let threw = false;
    try { await jsonrpcClient({ operation: "batch", url: "http://127.0.0.1:1", calls }); }
    catch (e) { threw = true; assertMatch(e.message, /exceeds limit/i); }
    assert(threw);
  });

  await test("D02 batch call missing method throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "batch", url: "http://127.0.0.1:1", calls: [{ params: [1] }] }); }
    catch (e) { threw = true; assertMatch(e.message, /method/i); }
    assert(threw);
  });

  await test("D03 RPC-level error surfaced as ToolError", async () => {
    const srv = await startMockServer(errorHandler(-32601, "Method not found"));
    const url = serverUrl(srv);
    let threw = false;
    try { await jsonrpcClient({ operation: "call", url, method: "unknown" }); }
    catch (e) { threw = true; assertMatch(e.message, /-32601|Method not found/); }
    assert(threw);
    await stopServer(srv);
  });

  await test("D04 server returns invalid JSON surfaced clearly", async () => {
    const srv = await startMockServer((req, res) => { res.writeHead(200); res.end("not json at all"); });
    const url = serverUrl(srv);
    let threw = false;
    try { await jsonrpcClient({ operation: "call", url, method: "m" }); }
    catch (e) { threw = true; assertMatch(e.message, /invalid JSON/i); }
    assert(threw);
    await stopServer(srv);
  });

  await test("D05 call to non-existent port errors with HTTP error", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call", url: "http://127.0.0.1:1", method: "m", timeout: 2000 }); }
    catch (e) { threw = true; assertMatch(e.message, /HTTP error/i); }
    assert(threw);
  });

  await test("D06 call_tcp to non-existent port errors with socket error", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call_tcp", host: "127.0.0.1", port: 1, method: "m", timeout: 2000 }); }
    catch (e) { threw = true; assertMatch(e.message, /socket error/i); }
    assert(threw);
  });

  await test("D07 batch server error object (non-array) surfaced", async () => {
    const srv = await startMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    });
    const url = serverUrl(srv);
    let threw = false;
    try { await jsonrpcClient({ operation: "batch", url, calls: [{ method: "m" }] }); }
    catch (e) { threw = true; assertMatch(e.message, /-32700|Parse error/); }
    assert(threw);
    await stopServer(srv);
  });

  await test("D08 response > 10 MB triggers size limit error", async () => {
    const bigPayload = "x".repeat(11 * 1024 * 1024);
    const srv = await startMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"jsonrpc":"2.0","result":"');
      res.write(bigPayload);
      res.end('","id":1}');
    });
    const url = serverUrl(srv);
    let threw = false;
    try { await jsonrpcClient({ operation: "call", url, method: "m", timeout: 15000 }); }
    catch (e) { threw = true; assertMatch(e.message, /too large/i); }
    assert(threw);
    await stopServer(srv);
  });

  await test("D09 call_unix NUL byte in socket path rejected early", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call_unix", socket_path: "/tmp/a\0b", method: "m" }); }
    catch (e) { threw = true; assertMatch(e.message, /NUL byte/i); }
    assert(threw);
  });

  await test("D10 timeout error message mentions timed out", async () => {
    const srv = await startMockServer(() => {}); // deliberately hangs
    const url = serverUrl(srv);
    let threw = false;
    try { await jsonrpcClient({ operation: "call", url, method: "m", timeout: 200 }); }
    catch (e) { threw = true; assertMatch(e.message, /timed out/i); }
    assert(threw);
    await stopServer(srv);
  });

  // ── Section E: Error Paths (10) ─────────────────────────────────────────
  process.stderr.write("\n-- E: Error Paths --\n");

  await test("E01 call operation field echoed in result", async () => {
    const srv = await startMockServer(echoHandler);
    const url = serverUrl(srv);
    const r = await jsonrpcClient({ operation: "call", url, method: "x" });
    assertEqual(r.operation, "call");
    await stopServer(srv);
  });

  await test("E02 notify operation field echoed in result", async () => {
    const srv = await startMockServer(echoHandler);
    const url = serverUrl(srv);
    const r = await jsonrpcClient({ operation: "notify", url, method: "x" });
    assertEqual(r.operation, "notify");
    await stopServer(srv);
  });

  await test("E03 batch with all notifications returns no missing-id errors", async () => {
    const srv = await startMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    });
    const url = serverUrl(srv);
    const r = await jsonrpcClient({ operation: "batch", url, calls: [
      { method: "evt1", notify: true },
      { method: "evt2", notify: true },
    ]});
    assert(r.results.every(x => x.notified === true));
    await stopServer(srv);
  });

  await test("E04 batch id mismatch returns error entry per result", async () => {
    const srv = await startMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ jsonrpc: "2.0", result: "ok", id: 9999 }]));
    });
    const url = serverUrl(srv);
    const r = await jsonrpcClient({ operation: "batch", url, calls: [{ method: "m" }] });
    assertEqual(typeof r.results[0].error, "string");
    await stopServer(srv);
  });

  await test("E05 call_tcp missing method throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call_tcp", host: "127.0.0.1", port: 1 }); }
    catch (e) { threw = true; assertMatch(e.message, /method.*required/i); }
    assert(threw);
  });

  await test("E06 call_unix missing method throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call_unix", socket_path: "/tmp/t.sock" }); }
    catch (e) { threw = true; assertMatch(e.message, /method.*required/i); }
    assert(threw);
  });

  await test("E07 call_tcp missing port throws", async () => {
    let threw = false;
    try { await jsonrpcClient({ operation: "call_tcp", host: "127.0.0.1", method: "m" }); }
    catch (e) { threw = true; assertMatch(e.message, /port.*required/i); }
    assert(threw);
  });

  await test("E08 batch invalid JSON from server throws", async () => {
    const srv = await startMockServer((req, res) => { res.writeHead(200); res.end("GARBAGE"); });
    const url = serverUrl(srv);
    let threw = false;
    try { await jsonrpcClient({ operation: "batch", url, calls: [{ method: "m" }] }); }
    catch (e) { threw = true; assertMatch(e.message, /invalid JSON/i); }
    assert(threw);
    await stopServer(srv);
  });

  await test("E09 RPC error code preserved in error message", async () => {
    const srv = await startMockServer(errorHandler(-32000, "Application error"));
    const url = serverUrl(srv);
    let threw = false;
    try { await jsonrpcClient({ operation: "call", url, method: "m" }); }
    catch (e) { threw = true; assertMatch(e.message, /-32000/); }
    assert(threw);
    await stopServer(srv);
  });

  await test("E10 call_tcp server returning malformed JSON errors", async () => {
    const tcpSrv = await startTcpServer((req, sock) => {
      sock.write("BADJSON\n");
      sock.end();
    });
    const port = tcpSrv.address().port;
    let threw = false;
    try {
      await jsonrpcClient({ operation: "call_tcp", host: "127.0.0.1", port, method: "m", timeout: 3000 });
    } catch (e) {
      threw = true;
      assertMatch(e.message, /invalid JSON/i);
    }
    assert(threw);
    await new Promise(r => tcpSrv.close(r));
  });

  // ── Section F: Concurrency (6) ──────────────────────────────────────────
  process.stderr.write("\n-- F: Concurrency --\n");

  await test("F01 10 concurrent calls to same server", async () => {
    const srv = await startMockServer(echoHandler);
    const url = serverUrl(srv);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => jsonrpcClient({ operation: "call", url, method: "m" + i }))
    );
    assertEqual(results.length, 10);
    results.forEach((r, i) => assertEqual(r.result.echoed, "m" + i));
    await stopServer(srv);
  });

  await test("F02 5 concurrent batch requests", async () => {
    const srv = await startMockServer(echoHandler);
    const url = serverUrl(srv);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        jsonrpcClient({ operation: "batch", url, calls: [{ method: "a" }, { method: "b" }] }))
    );
    results.forEach(r => assertEqual(r.callCount, 2));
    await stopServer(srv);
  });

  await test("F03 mixed concurrent call + notify", async () => {
    const srv = await startMockServer(echoHandler);
    const url = serverUrl(srv);
    const [callRes, notifyRes] = await Promise.all([
      jsonrpcClient({ operation: "call", url, method: "ping" }),
      jsonrpcClient({ operation: "notify", url, method: "heartbeat" }),
    ]);
    assertEqual(callRes.operation, "call");
    assertEqual(notifyRes.operation, "notify");
    await stopServer(srv);
  });

  await test("F04 auto-incrementing ids unique across 20 concurrent calls", async () => {
    const srv = await startMockServer(echoHandler);
    const url = serverUrl(srv);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => jsonrpcClient({ operation: "call", url, method: "m" }))
    );
    const ids = results.map(r => r.id);
    const unique = new Set(ids);
    assertEqual(unique.size, 20);
    await stopServer(srv);
  });

  await test("F05 50 concurrent calls complete without error", async () => {
    const srv = await startMockServer(echoHandler);
    const url = serverUrl(srv);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => jsonrpcClient({ operation: "call", url, method: "f" + i }))
    );
    assertEqual(results.length, 50);
    results.forEach(r => assertEqual(r.operation, "call"));
    await stopServer(srv);
  });

  await test("F06 TCP call concurrent with HTTP call", async () => {
    const httpSrv = await startMockServer(echoHandler);
    const tcpSrv  = await startTcpServer((req, sock) => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", result: "tcp-ok", id: req.id }) + "\n");
      sock.end();
    });
    const url = serverUrl(httpSrv);
    const port = tcpSrv.address().port;
    const [httpRes, tcpRes] = await Promise.all([
      jsonrpcClient({ operation: "call", url, method: "http-method" }),
      jsonrpcClient({ operation: "call_tcp", host: "127.0.0.1", port, method: "tcp-method", timeout: 5000 }),
    ]);
    assertEqual(httpRes.operation, "call");
    assertEqual(tcpRes.operation, "call_tcp");
    assertEqual(tcpRes.result, "tcp-ok");
    await stopServer(httpSrv);
    await new Promise(r => tcpSrv.close(r));
  });

  // ── Summary ──────────────────────────────────────────────────────────
  process.stderr.write("\n" + (failed === 0 ? "ALL PASSED" : failed + " FAILED") +
    " — " + passed + "/" + (passed + failed) + " tests\n");

  if (failed > 0) {
    for (const e of failures) process.stderr.write("  FAIL: " + e.name + " — " + e.error + "\n");
    process.exit(1);
  }
}

run().catch(e => { process.stderr.write("FATAL: " + e.message + "\n"); process.exit(1); });
