"use strict";
/**
 * Concurrency/stress tests for write_file races + browser session table.
 * NOT part of test/run-tests.js or test/browser-tests.js — standalone.
 * Run: node test/stress-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stress-test-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
process.env.MCP_MAX_BROWSER_SESSIONS = "3";

const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

const counters = { pass: 0, fail: 0 };
async function test(name, fn) {
  try {
    await fn();
    counters.pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    counters.fail++;
    console.log(`  FAIL - ${name}\n      ${e.message}`);
  }
}
function assertOk(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

(async () => {
  console.log("== stress-tests.js ==");

  // ── write_file races: N parallel full-file writes to the same path ──
  await test("parallel write_file: file ends in one clean valid state, no interleave/corruption", async () => {
    const target = "race.txt";
    const writers = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve(executeTool("write_file", { path: target, content: `writer-${i}`.repeat(50) })));
    await Promise.all(writers);
    const content = fs.readFileSync(path.join(TMP, target), "utf8");
    const match = /^(writer-\d+)\1*$/.exec(content);
    assertOk(match, `corrupted/interleaved content: ${content.slice(0, 60)}...`);
  });

  await test("parallel write_files: distinct files, all land intact", async () => {
    const files = Array.from({ length: 15 }, (_, i) => ({ path: `multi-${i}.txt`, content: `payload-${i}` }));
    await Promise.resolve(executeTool("write_files", { files }));
    for (let i = 0; i < 15; i++) {
      const c = fs.readFileSync(path.join(TMP, `multi-${i}.txt`), "utf8");
      assertOk(c === `payload-${i}`, `file ${i} corrupted: ${c}`);
    }
  });

  // ── browser session table under load ─────────────────────────────────
  await test("session cap: MAX_SESSIONS enforced under concurrent launches", async () => {
    const launches = Array.from({ length: 6 }, () => executeTool("browser_launch", { headless: true }));
    const results = await Promise.allSettled(launches);
    const ok = results.filter(r => r.status === "fulfilled");
    const failed = results.filter(r => r.status === "rejected");
    assertOk(ok.length === 3, `expected 3 successful launches (cap=3), got ${ok.length}`);
    assertOk(failed.every(r => r.reason.code === -32603), "cap rejection should be -32603");

    const ids = ok.map(r => r.value.session_id);
    await Promise.all(ids.map(id => executeTool("browser_close", { session_id: id })));
    const listed = executeTool("browser_list_sessions", {});
    assertOk(listed.count === 0, `session table not clean after close: ${listed.count} remain`);
  });

  await test("session table: rapid launch+close cycles leave no leaks", async () => {
    for (let i = 0; i < 4; i++) {
      const { session_id } = await executeTool("browser_launch", { headless: true });
      await executeTool("browser_navigate", { session_id, url: "data:text/html,<h1>x</h1>" });
      await executeTool("browser_close", { session_id });
    }
    const listed = executeTool("browser_list_sessions", {});
    assertOk(listed.count === 0, `leaked sessions: ${listed.count}`);
  });

  await test("repeated screenshots: memory/file stability over N captures, no leak/crash", async () => {
    const { session_id } = await executeTool("browser_launch", { headless: true });
    await executeTool("browser_navigate", { session_id, url: "data:text/html,<h1>shot</h1>" });
    const before = process.memoryUsage().rss;
    for (let i = 0; i < 10; i++) {
      await executeTool("browser_screenshot", { session_id, path: `shot-${i}.png` });
    }
    const after = process.memoryUsage().rss;
    const growthMB = (after - before) / 1024 / 1024;
    assertOk(growthMB < 200, `excessive RSS growth over 10 screenshots: ${growthMB.toFixed(1)}MB`);
    for (let i = 0; i < 10; i++) {
      assertOk(fs.existsSync(path.join(TMP, `shot-${i}.png`)), `missing shot-${i}.png`);
    }
    await executeTool("browser_close", { session_id });
  });

  await test("concurrency: mixed browser_launch racing against session cap doesn't corrupt table", async () => {
    const batch1 = [executeTool("browser_launch", {}), executeTool("browser_launch", {}), executeTool("browser_launch", {})];
    const settled = await Promise.allSettled(batch1);
    const live = settled.filter(r => r.status === "fulfilled").map(r => r.value.session_id);
    assertOk(live.length <= 3, "cap violated under race");
    await Promise.all(live.map(id => executeTool("browser_close", { session_id: id }).catch(() => {})));
    const listed = executeTool("browser_list_sessions", {});
    assertOk(listed.count === 0, "table not clean after mixed race");
  });

  await test("concurrency: parallel evaluate() calls on same session don't corrupt/crash", async () => {
    const { session_id } = await executeTool("browser_launch", { headless: true });
    await executeTool("browser_navigate", { session_id, url: "data:text/html,<h1>x</h1>" });
    const calls = Array.from({ length: 10 }, (_, i) =>
      executeTool("browser_evaluate", { session_id, script: `${i} * 2` }));
    const results = await Promise.all(calls);
    results.forEach((r, i) => assertOk(r.result === i * 2, `evaluate ${i} returned ${r.result}`));
    await executeTool("browser_close", { session_id });
  });

  await test("concurrency: rapid route/unroute churn on same session, no crash/leak", async () => {
    const { session_id } = await executeTool("browser_launch", { headless: true });
    for (let i = 0; i < 8; i++) {
      await executeTool("browser_route", { session_id, url_pattern: `**/churn-${i}`, action: "abort" });
    }
    const unrouted = await executeTool("browser_unroute", { session_id });
    assertOk(unrouted.status === "unrouted_all" && unrouted.count === 8, `expected 8 routes cleared, got ${unrouted.count}`);
    await executeTool("browser_navigate", { session_id, url: "data:text/html,<h1>after-churn</h1>" });
    await executeTool("browser_close", { session_id });
  });

  // ── fuzz: extreme-length write content doesn't crash the process ────
  await test("fuzz: very large write_file payload handled without crash", async () => {
    const big = "x".repeat(5_000_000); // 5MB
    const r = executeTool("write_file", { path: "big.txt", content: big });
    assertOk(r.written === "entire file");
    assertOk(fs.statSync(path.join(TMP, "big.txt")).size === 5_000_000);
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  process.exit(counters.fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
