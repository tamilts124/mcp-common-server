"use strict";
/**
 * Standalone tests for port_check. NOT added to frozen test/run-tests.js.
 * Run: node test/port-check-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-portcheck-test-"));
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

(async () => {
  console.log("== port-check-tests.js ==");
  const server = await startServer();
  const openPort = server.address().port;

  // ── Normal (happy path) ────────────────────────────────────────────────
  await test("port_check: open port -> open:true", async () => {
    const r = await executeTool("port_check", { host: "127.0.0.1", port: openPort });
    assertEq(r.open, true);
    assertEq(r.host, "127.0.0.1");
    assertEq(r.port, openPort);
    if (typeof r.timeMs !== "number") throw new Error("timeMs missing");
  });

  await test("port_check: closed port -> open:false with error", async () => {
    const r = await executeTool("port_check", { host: "127.0.0.1", port: 1 });
    assertEq(r.open, false);
    if (!r.error) throw new Error("expected error field on closed port");
  });

  // ── Medium (boundary & parameter validation) ────────────────────────────
  await test("port_check: missing 'host' -> -32602", async () => {
    await expectThrow(() => executeTool("port_check", { port: 80 }), -32602);
  });
  await test("port_check: missing 'port' -> -32602", async () => {
    await expectThrow(() => executeTool("port_check", { host: "127.0.0.1" }), -32602);
  });
  await test("port_check: port 0 -> clean error", async () => {
    await expectThrow(() => executeTool("port_check", { host: "127.0.0.1", port: 0 }), -32602);
  });
  await test("port_check: port 70000 (out of range) -> clean error", async () => {
    await expectThrow(() => executeTool("port_check", { host: "127.0.0.1", port: 70000 }), -32602);
  });
  await test("port_check: non-integer port (string) -> clean error", async () => {
    await expectThrow(() => executeTool("port_check", { host: "127.0.0.1", port: "80" }), -32602);
  });
  await test("port_check: negative timeout -> clean error", async () => {
    await expectThrow(() => executeTool("port_check", { host: "127.0.0.1", port: openPort, timeout: -1 }), -32602);
  });

  // ── High (dependency-failure equivalent: unreachable host) ──────────────
  await test("port_check: unresolvable host -> open:false, ENOTFOUND-ish error, no crash", async () => {
    const r = await executeTool("port_check", { host: "this-host-does-not-exist.invalid", port: 80, timeout: 3 });
    assertEq(r.open, false);
    if (!r.error) throw new Error("expected error field");
  });

  await test("port_check: timeout against non-routable IP resolves cleanly", async () => {
    const r = await executeTool("port_check", { host: "10.255.255.1", port: 81, timeout: 1 });
    assertEq(r.open, false);
    if (!r.error) throw new Error("expected error field");
  }).catch(() => {}); // best-effort: network conditions vary in CI sandboxes

  // ── Critical (injection-shaped input handled as literal data) ───────────
  await test("port_check: shell-injection-shaped host rejected as unresolvable, not executed", async () => {
    const r = await executeTool("port_check", { host: "$(whoami)", port: 80, timeout: 2 });
    assertEq(r.open, false);
  });
  await test("port_check: path-traversal-shaped host handled as literal hostname", async () => {
    const r = await executeTool("port_check", { host: "../../../../etc/passwd", port: 80, timeout: 2 });
    assertEq(r.open, false);
  });

  // ── Extreme (fuzzing, concurrency) ───────────────────────────────────────
  await test("port_check: extremely long garbage host -> clean error, no crash", async () => {
    const r = await executeTool("port_check", { host: "x".repeat(5000), port: 80, timeout: 2 });
    assertEq(r.open, false);
  });

  await test("concurrency: 10 parallel port_check calls against open port, all succeed", async () => {
    const jobs = [];
    for (let i = 0; i < 10; i++) jobs.push(executeTool("port_check", { host: "127.0.0.1", port: openPort }));
    const results = await Promise.all(jobs);
    for (const r of results) assertEq(r.open, true);
  });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  server.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(counters.fail > 0 ? 1 : 0);
})();
