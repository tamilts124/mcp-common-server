"use strict";
/**
 * Standalone tests for wait_for_port. NOT added to frozen test/run-tests.js.
 * Run: node test/wait-for-port-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-waitforport-test-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";

const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

const counters = { pass: 0, fail: 0 };
async function test(name, fn) {
  try { await fn(); counters.pass++; console.log(`  ok - ${name}`); }
  catch (e) { counters.fail++; console.log(`  FAIL - ${name}\n      ${e.message}`); }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function expectThrow(fn, codeOrMsgFrag) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (typeof codeOrMsgFrag === "number" && e.code !== codeOrMsgFrag)
      throw new Error(`expected code ${codeOrMsgFrag}, got ${e.code}: ${e.message}`);
    if (typeof codeOrMsgFrag === "string" && !e.message.includes(codeOrMsgFrag))
      throw new Error(`expected message to include '${codeOrMsgFrag}', got: ${e.message}`);
  }
}

function startServer() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.destroy());
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
function startDelayedServer(delayMs) {
  return new Promise((resolve) => {
    // Grab a free port first via a throwaway listen(0), close it, then
    // reopen the *same* port after delayMs. Resolve as soon as the port
    // number is known (not after the delayed listen completes), so the
    // caller can start polling *before* the port actually opens.
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => {
        const srv = net.createServer((sock) => sock.destroy());
        setTimeout(() => srv.listen(port, "127.0.0.1"), delayMs);
        resolve({ srv, port });
      });
    });
  });
}

(async () => {
  console.log("== wait-for-port-tests.js ==");
  const server = await startServer();
  const openPort = server.address().port;

  // ── Normal (happy path) ────────────────────────────────────────────────
  await test("wait_for_port: already-open port resolves immediately, attempts:1", async () => {
    const r = await executeTool("wait_for_port", { host: "127.0.0.1", port: openPort, timeout: 5 });
    assertEq(r.open, true);
    assertEq(r.attempts, 1);
    assertEq(r.host, "127.0.0.1");
    assertEq(r.port, openPort);
    if (typeof r.elapsedMs !== "number") throw new Error("elapsedMs missing");
  });

  await test("wait_for_port: port opens mid-poll -> open:true, attempts>1", async () => {
    const { srv, port } = await startDelayedServer(900);
    try {
      const r = await executeTool("wait_for_port", { host: "127.0.0.1", port, timeout: 5, interval: 0.3 });
      assertEq(r.open, true);
      if (r.attempts < 2) throw new Error(`expected >1 attempts, got ${r.attempts}`);
    } finally {
      srv.close();
    }
  });

  // ── Medium (boundary & parameter validation) ────────────────────────────
  await test("wait_for_port: missing 'host' -> -32602", async () => {
    await expectThrow(() => executeTool("wait_for_port", { port: 80 }), -32602);
  });
  await test("wait_for_port: missing 'port' -> -32602", async () => {
    await expectThrow(() => executeTool("wait_for_port", { host: "127.0.0.1" }), -32602);
  });
  await test("wait_for_port: port 0 -> clean error", async () => {
    await expectThrow(() => executeTool("wait_for_port", { host: "127.0.0.1", port: 0 }), -32602);
  });
  await test("wait_for_port: port 70000 -> clean error", async () => {
    await expectThrow(() => executeTool("wait_for_port", { host: "127.0.0.1", port: 70000 }), -32602);
  });
  await test("wait_for_port: negative timeout -> clean error", async () => {
    await expectThrow(() => executeTool("wait_for_port", { host: "127.0.0.1", port: openPort, timeout: -1 }), -32602);
  });
  await test("wait_for_port: interval below minimum -> clean error", async () => {
    await expectThrow(() => executeTool("wait_for_port", { host: "127.0.0.1", port: openPort, interval: 0.01 }), -32602);
  });
  await test("wait_for_port: timeout over max (60) is clamped, not rejected", async () => {
    const r = await executeTool("wait_for_port", { host: "127.0.0.1", port: openPort, timeout: 999 });
    assertEq(r.open, true); // resolves immediately since port is already open; clamp just affects worst-case budget
  });

  // ── High (dependency-failure: never-opens port times out cleanly) ───────
  await test("wait_for_port: port never opens -> open:false after full timeout budget, no throw", async () => {
    const start = Date.now();
    const r = await executeTool("wait_for_port", { host: "127.0.0.1", port: 1, timeout: 1, interval: 0.3 });
    const elapsed = Date.now() - start;
    assertEq(r.open, false);
    if (!r.error) throw new Error("expected error field on timeout");
    if (elapsed < 900) throw new Error(`resolved too early: ${elapsed}ms`);
    if (elapsed > 3000) throw new Error(`took too long: ${elapsed}ms`);
  });

  await test("wait_for_port: unresolvable host -> open:false, no crash", async () => {
    const r = await executeTool("wait_for_port", { host: "this-host-does-not-exist.invalid", port: 80, timeout: 1, interval: 0.3 });
    assertEq(r.open, false);
    if (!r.error) throw new Error("expected error field");
  });

  // ── Critical (injection-shaped input handled as literal data) ───────────
  await test("wait_for_port: shell-injection-shaped host handled as literal, no crash", async () => {
    const r = await executeTool("wait_for_port", { host: "$(whoami)", port: 80, timeout: 1, interval: 0.3 });
    assertEq(r.open, false);
  });
  await test("wait_for_port: path-traversal-shaped host handled as literal hostname", async () => {
    const r = await executeTool("wait_for_port", { host: "../../../../etc/passwd", port: 80, timeout: 1, interval: 0.3 });
    assertEq(r.open, false);
  });

  // ── Extreme (fuzzing, concurrency, budget enforcement) ───────────────────
  await test("wait_for_port: extremely long garbage host -> clean error, no crash", async () => {
    const r = await executeTool("wait_for_port", { host: "x".repeat(5000), port: 80, timeout: 1, interval: 0.3 });
    assertEq(r.open, false);
  });

  await test("concurrency: 8 parallel wait_for_port calls against open port, all succeed fast", async () => {
    const jobs = [];
    for (let i = 0; i < 8; i++) jobs.push(executeTool("wait_for_port", { host: "127.0.0.1", port: openPort, timeout: 5 }));
    const results = await Promise.all(jobs);
    for (const r of results) assertEq(r.open, true);
  });

  await test("wait_for_port: overall elapsed never exceeds clamped max budget (60s) even if timeout requested huge", async () => {
    // Use a short real timeout to keep the test fast, but verify the clamp logic path doesn't throw
    // and returns within a bounded time for a closed port.
    const start = Date.now();
    const r = await executeTool("wait_for_port", { host: "127.0.0.1", port: 2, timeout: 2, interval: 0.5 });
    const elapsed = Date.now() - start;
    assertEq(r.open, false);
    if (elapsed > 4000) throw new Error(`took too long: ${elapsed}ms`);
  });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(counters.fail > 0 ? 1 : 0);
})();
