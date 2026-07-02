"use strict";
/**
 * [63] RUN_COMMAND (async spawn rewrite) — lib/processOps.js runCommand
 *
 * Context: runCommand previously used child_process.execSync, which blocks
 * the entire Node event loop for the command's whole duration. On the
 * HTTP/SSE transport this starves concurrent request handling (e.g. SSE
 * keepalive) for that span, which manifested as a client-side transport
 * failure for run_command calls lasting more than a few seconds — even
 * though the command itself would have succeeded within its timeout.
 * Rewritten to use spawn + Promise (non-blocking); same return shape.
 *
 * Async section (run_command now returns a Promise). Wrapped in an async
 * IIFE assigned to module.exports, same pattern as sections 55/58.
 *
 * Rigor levels:
 *   Normal:   happy-path command returns exitCode 0 + correct stdout.
 *   Medium:   missing 'command' throws -32602; nonzero exit captured cleanly.
 *   High:     event loop is NOT blocked during a long-running command.
 *   Critical: shell-metacharacter command (&&) executes safely, no crash.
 *   Extreme:  command exceeding its timeout is killed (exitCode 124) even
 *             on Windows, where shell:true spawns cmd.exe as an intermediary
 *             and a plain SIGTERM to that PID does not reach its own child
 *             process — fixed via taskkill /T /F tree-kill on win32.
 *             Also: 5 concurrent commands resolve independently.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[63] RUN_COMMAND (async spawn) — lib/processOps.js runCommand`);

module.exports = (async () => {

  await test("run_command: happy path returns exitCode 0 + stdout", async () => {
    const r = await executeTool("run_command", { command: "node -e \"console.log('hi')\"" });
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.stdout, "hi");
    assert.strictEqual(typeof r.duration_ms, "number");
  });

  await test("run_command: missing command throws -32602", () => {
    assert.throws(() => executeTool("run_command", {}), /command/);
  });

  await test("run_command: nonzero exit captured without throwing", async () => {
    const r = await executeTool("run_command", { command: "node -e \"process.exit(3)\"" });
    assert.strictEqual(r.exitCode, 3);
  });

  await test("run_command: event loop stays live during a long command", async () => {
    let ticks = 0;
    const iv = setInterval(() => ticks++, 50);
    await executeTool("run_command", { command: "node -e \"setTimeout(()=>{},1200)\"", timeout: 10 });
    clearInterval(iv);
    assert.ok(ticks >= 8, `expected >=8 event-loop ticks during long command, got ${ticks}`);
  });

  await test("run_command: shell metacharacter (&&) command runs safely", async () => {
    const r = await executeTool("run_command", { command: "node -e \"console.log(1)\" && echo done" });
    assert.strictEqual(typeof r.exitCode, "number");
    assert.ok(r.stdout.includes("done"));
  });

  await test("run_command: command exceeding timeout is killed, exitCode 124", async () => {
    const r = await executeTool("run_command", { command: "node -e \"setTimeout(()=>{},5000)\"", timeout: 1 });
    assert.strictEqual(r.exitCode, 124);
    assert.ok(r.duration_ms < 3000, `expected fast kill, took ${r.duration_ms}ms`);
  });

  await test("run_command: 5 concurrent commands resolve independently", async () => {
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map(i => executeTool("run_command", { command: `node -e "console.log(${i})"` }))
    );
    results.forEach((r, i) => assert.strictEqual(r.stdout, String(i)));
  });

})();
