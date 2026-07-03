"use strict";
/**
 * [79] DNS_LOOKUP — hostname/IP resolution via Node's dns module
 *
 * Rigor levels:
 *   Normal:   A-record lookup on a real domain returns IPv4 addresses;
 *             PTR reverse lookup on a real IP returns hostname(s).
 *   Medium:   missing host throws -32602; invalid type throws -32602;
 *             PTR on a non-IP host throws -32602; A on an IP host throws
 *             -32602 (must use PTR/omit type for IPs).
 *   High:     non-existent domain resolves cleanly to { records: [],
 *             error: 'ENOTFOUND' } rather than throwing; very short timeout
 *             on a real lookup either succeeds fast or reports error:'timeout'
 *             without throwing.
 *   Critical: shell/path-injection-shaped host string treated as an inert
 *             literal hostname (fails lookup, never executed); result is
 *             JSON-serialisable.
 *   Extreme:  5 concurrent lookups of different types don't interfere with
 *             each other's results.
 *
 * Requires real network/DNS access (matches the project's existing
 * pattern of exercising real git/filesystem state rather than mocking).
 * IIFE assigned to module.exports (async test bodies) — run-tests.js must
 * `await require(...)` this file, matching sections 55/58/63/64/76/78.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[79] DNS_LOOKUP — hostname/IP resolution`);

module.exports = (async () => {
  await test("normal: A-record lookup on a real domain returns addresses", async () => {
    const r = await executeTool("dns_lookup", { host: "example.com", type: "A" });
    assert.strictEqual(r.host, "example.com");
    assert.strictEqual(r.type, "A");
    assert.ok(Array.isArray(r.records));
    assert.ok(r.records.length > 0);
    assert.ok(!r.error);
  });

  await test("normal: PTR reverse lookup on a real IP returns hostname(s)", async () => {
    const r = await executeTool("dns_lookup", { host: "8.8.8.8" });
    assert.strictEqual(r.type, "PTR");
    assert.ok(Array.isArray(r.records));
    assert.ok(r.records.length > 0);
  });

  await test("medium: missing host throws -32602", async () => {
    let threw = null;
    try { await executeTool("dns_lookup", {}); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("medium: invalid type throws -32602", async () => {
    let threw = null;
    try { await executeTool("dns_lookup", { host: "example.com", type: "BOGUS" }); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("medium: PTR on non-IP host throws -32602", async () => {
    let threw = null;
    try { await executeTool("dns_lookup", { host: "example.com", type: "PTR" }); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("medium: A type on IP host throws -32602", async () => {
    let threw = null;
    try { await executeTool("dns_lookup", { host: "8.8.8.8", type: "A" }); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.strictEqual(threw.code, -32602);
  });

  await test("high: non-existent domain resolves cleanly with error field, no throw", async () => {
    const r = await executeTool("dns_lookup", { host: "thisdomaindoesnotexist12345.invalid", type: "A" });
    assert.deepStrictEqual(r.records, []);
    assert.ok(r.error);
  });

  await test("high: 1ms timeout on a real lookup never throws (fast success or timeout error)", async () => {
    const r = await executeTool("dns_lookup", { host: "example.com", type: "A", timeout: 0.001 });
    assert.ok(Array.isArray(r.records));
    if (r.records.length === 0) assert.ok(r.error);
  });

  await test("critical: shell-injection-shaped host is an inert literal, no throw beyond validation", async () => {
    const r = await executeTool("dns_lookup", { host: "example.com; rm -rf /", type: "A" });
    assert.deepStrictEqual(r.records, []);
    assert.ok(r.error);
  });

  await test("critical: result is JSON-serialisable", async () => {
    const r = await executeTool("dns_lookup", { host: "example.com", type: "A" });
    assert.doesNotThrow(() => JSON.stringify(r));
  });

  await test("extreme: 5 concurrent lookups of different types don't interfere", async () => {
    const [a, aaaa, mx, ns, ptr] = await Promise.all([
      executeTool("dns_lookup", { host: "example.com", type: "A" }),
      executeTool("dns_lookup", { host: "example.com", type: "AAAA" }),
      executeTool("dns_lookup", { host: "example.com", type: "MX" }),
      executeTool("dns_lookup", { host: "example.com", type: "NS" }),
      executeTool("dns_lookup", { host: "1.1.1.1", type: "PTR" }),
    ]);
    assert.strictEqual(a.type, "A");
    assert.strictEqual(aaaa.type, "AAAA");
    assert.strictEqual(mx.type, "MX");
    assert.strictEqual(ns.type, "NS");
    assert.strictEqual(ptr.type, "PTR");
    assert.ok(ns.records.length > 0);
  });
})();
