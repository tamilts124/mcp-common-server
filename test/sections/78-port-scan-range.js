"use strict";
/**
 * [78] PORT_SCAN_RANGE — concurrent TCP port range scanner
 *
 * Rigor levels:
 *   Normal:   a range containing one listening port correctly reports it
 *             open, others closed.
 *   Medium:   end_port < start_port throws -32602; non-integer/out-of-range
 *             ports throw -32602; missing host throws -32602.
 *   High:     unreachable/closed-port range (all closed, no throw); custom
 *             concurrency param respected (result shape unaffected).
 *   Critical: range exceeding MAX_RANGE_PORTS (1000) throws a descriptive
 *             -32602 rather than silently scanning; result is JSON-
 *             serialisable.
 *   Extreme:  50-port range scanned concurrently completes well under a
 *             naive-sequential time budget; concurrent calls to the tool
 *             itself don't interfere with each other's results.
 *
 * IIFE assigned to module.exports (async test bodies), matches sections
 * 55/58/62/63/64 — run-tests.js must `await require(...)` this file.
 */
const net = require("net");
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[78] PORT_SCAN_RANGE — concurrent port range scanner`);

function listenOnFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

module.exports = (async () => {
  let server;
  let listeningPort;

  await test("setup: start a listening server on a free port", async () => {
    server = await listenOnFreePort();
    listeningPort = server.address().port;
    assert.ok(listeningPort > 0);
  });

  await test("normal: range containing the listening port reports it open", async () => {
    const r = await executeTool("port_scan_range", {
      host: "127.0.0.1",
      start_port: listeningPort,
      end_port: listeningPort + 4,
      timeout: 1,
    });
    assert.strictEqual(r.host, "127.0.0.1");
    assert.strictEqual(r.totalPorts, 5);
    assert.ok(r.openPorts.includes(listeningPort));
    assert.strictEqual(r.closedCount, r.totalPorts - r.openPorts.length);
  });

  await test("medium: end_port < start_port throws -32602", async () => {
    let threw = null;
    try {
      await executeTool("port_scan_range", { host: "127.0.0.1", start_port: 100, end_port: 50 });
    } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("medium: out-of-range port number throws -32602", async () => {
    let threw = null;
    try {
      await executeTool("port_scan_range", { host: "127.0.0.1", start_port: 1, end_port: 70000 });
    } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("medium: missing host throws -32602", async () => {
    let threw = null;
    try {
      await executeTool("port_scan_range", { start_port: 1, end_port: 5 });
    } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("high: closed-port range returns all-closed, no throw", async () => {
    const r = await executeTool("port_scan_range", {
      host: "127.0.0.1",
      start_port: 59990,
      end_port: 59994,
      timeout: 0.5,
    });
    assert.strictEqual(r.openPorts.length, 0);
    assert.strictEqual(r.closedCount, 5);
  });

  await test("high: custom concurrency param respected, shape unaffected", async () => {
    const r = await executeTool("port_scan_range", {
      host: "127.0.0.1",
      start_port: listeningPort,
      end_port: listeningPort + 9,
      timeout: 1,
      concurrency: 3,
    });
    assert.strictEqual(r.totalPorts, 10);
    assert.ok(r.openPorts.includes(listeningPort));
  });

  await test("critical: range exceeding 1000 ports throws descriptive -32602", async () => {
    let threw = null;
    try {
      await executeTool("port_scan_range", { host: "127.0.0.1", start_port: 1, end_port: 2000 });
    } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
    assert.ok(/max/i.test(threw.message));
  });

  await test("critical: result is JSON-serialisable", async () => {
    const r = await executeTool("port_scan_range", {
      host: "127.0.0.1",
      start_port: listeningPort,
      end_port: listeningPort + 1,
      timeout: 1,
    });
    assert.doesNotThrow(() => JSON.stringify(r));
  });

  await test("extreme: 50-port concurrent scan completes reasonably fast", async () => {
    const t0 = Date.now();
    const r = await executeTool("port_scan_range", {
      host: "127.0.0.1",
      start_port: 59900,
      end_port: 59949,
      timeout: 1,
      concurrency: 50,
    });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.totalPorts, 50);
    // 50 ports sequentially at 1s timeout each would take ~50s; concurrent
    // scan with 50 workers should finish well under that.
    assert.ok(elapsed < 8000, `expected concurrent scan under 8s, took ${elapsed}ms`);
  });

  await test("extreme: concurrent tool calls don't interfere with each other", async () => {
    const [r1, r2] = await Promise.all([
      executeTool("port_scan_range", { host: "127.0.0.1", start_port: listeningPort, end_port: listeningPort, timeout: 1 }),
      executeTool("port_scan_range", { host: "127.0.0.1", start_port: 59991, end_port: 59991, timeout: 0.5 }),
    ]);
    assert.deepStrictEqual(r1.openPorts, [listeningPort]);
    assert.deepStrictEqual(r2.openPorts, []);
  });

  await test("cleanup: close listening server", async () => {
    await new Promise((resolve) => server.close(resolve));
    assert.ok(true);
  });
})();
