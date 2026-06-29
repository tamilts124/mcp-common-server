"use strict";
/**
 * [32b] EXECUTE_PIPELINE + HTTP_FETCH — async-tool pipeline integration
 *
 * Regression suite for the bug this session's async-pipeline rewrite fixes:
 * executePipeline() used to call executeTool() synchronously and push
 * whatever it returned straight into the results array. For an async tool
 * like http_fetch, that "result" was a dangling Promise object, not the
 * actual response — it would JSON.stringify to "{}" and any subsequent
 * pipeline step depending on it would see garbage. executePipeline() is now
 * `async` and every step does `await Promise.resolve(executeTool(...))`, so
 * async tool results are fully resolved before being recorded.
 *
 * Rigor levels:
 *   Normal:   pipeline with a single http_fetch step resolves the real
 *             response object (not a Promise/empty object); pipeline mixing
 *             a sync tool (create_file) followed by an http_fetch step
 *             completes both correctly in order.
 *   Medium:   pipeline with an http_fetch step that has a missing required
 *             field records a structured per-step error (not a thrown
 *             exception that kills the whole pipeline) when on_error is
 *             absent (default "stop") vs "continue".
 *   High:     pipeline with multiple sequential http_fetch steps to
 *             different paths all resolve independently and correctly
 *             (no result cross-contamination between steps).
 *   Critical: a failing http_fetch step (bad scheme) with on_error:"continue"
 *             does not abort later steps, and the per-step error message is
 *             a plain string (JSON-serialisable, no leaked Promise/Error
 *             object).
 *   Extreme:  10 pipelines run concurrently (each with 2 http_fetch steps)
 *             all resolve with correct, non-cross-contaminated results;
 *             a pipeline with 5 http_fetch steps all targeting the same
 *             endpoint resolves every step's `result` as a fully-formed,
 *             JSON-serialisable object (not "[object Promise]" anywhere).
 */
const http = require("http");
const { assert, test, counters } = require("../test-harness");
const { executeTool } = require("../../lib/executeTool");

console.log(`\n[32b] EXECUTE_PIPELINE + HTTP_FETCH — async pipeline integration`);

let testServer;
let PORT;

function startTestServer() {
  return new Promise((resolve) => {
    testServer = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: url.pathname, ts: Date.now() }));
        return;
      }
      if (url.pathname === "/a" || url.pathname === "/b" || url.pathname === "/c") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`marker-${url.pathname.slice(1)}`);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    testServer.listen(0, "127.0.0.1", () => {
      PORT = testServer.address().port;
      resolve();
    });
  });
}

function stopTestServer() {
  return new Promise((resolve) => {
    if (!testServer) { resolve(); return; }
    testServer.close(() => resolve());
  });
}

// execute_pipeline is itself async (executeTool returns a Promise for it).
async function pipeline(steps) {
  return Promise.resolve(executeTool("execute_pipeline", { steps }));
}

module.exports = (async () => {
  await startTestServer();

  // ── NORMAL ──────────────────────────────────────────────────────────────
  await test("pipeline: single http_fetch step resolves a real response object, not a dangling Promise", async () => {
    const r = await pipeline([
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
    ]);
    assert.strictEqual(r.completed, 1);
    assert.strictEqual(r.failed, 0);
    const stepResult = r.steps[0].result;
    assert.strictEqual(typeof stepResult, "object");
    assert.notStrictEqual(stepResult, null);
    assert.strictEqual(typeof stepResult.then, "undefined", "result must not be a dangling Promise");
    assert.strictEqual(stepResult.status, 200);
    assert.strictEqual(stepResult.ok, true);
  });

  await test("pipeline: sync tool then http_fetch step, both complete in order", async () => {
    const r = await pipeline([
      { op: "create_file", path: "pipeline-http-marker.txt", content: "before-fetch" },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/a` },
    ]);
    assert.strictEqual(r.completed, 2);
    assert.strictEqual(r.failed, 0);
    assert.strictEqual(r.steps[0].result.created, "pipeline-http-marker.txt");
    assert.strictEqual(r.steps[1].result.body, "marker-a");
  });

  // ── MEDIUM ──────────────────────────────────────────────────────────────
  await test("pipeline: http_fetch step missing required 'url' records a structured per-step error (default stop)", async () => {
    const r = await pipeline([
      { op: "http_fetch" },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
    ]);
    assert.strictEqual(r.steps[0].status, "error");
    assert.ok(typeof r.steps[0].error === "string");
    assert.strictEqual(r.stopped_at, 0);
    assert.strictEqual(r.steps[1].status, "skipped");
  });

  await test("pipeline: http_fetch step missing 'url' with on_error:'continue' lets later steps run", async () => {
    const r = await pipeline([
      { op: "http_fetch", on_error: "continue" },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
    ]);
    assert.strictEqual(r.steps[0].status, "error");
    assert.strictEqual(r.steps[1].status, "ok");
    assert.strictEqual(r.steps[1].result.status, 200);
  });

  // ── HIGH ────────────────────────────────────────────────────────────────
  await test("pipeline: multiple sequential http_fetch steps to different paths resolve independently, no cross-contamination", async () => {
    const r = await pipeline([
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/a` },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/b` },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/c` },
    ]);
    assert.strictEqual(r.completed, 3);
    assert.strictEqual(r.steps[0].result.body, "marker-a");
    assert.strictEqual(r.steps[1].result.body, "marker-b");
    assert.strictEqual(r.steps[2].result.body, "marker-c");
  });

  // ── CRITICAL ────────────────────────────────────────────────────────────
  await test("pipeline: failing http_fetch step (bad scheme) with on_error:'continue' doesn't abort later steps, error is a plain string", async () => {
    const r = await pipeline([
      { op: "http_fetch", url: "file:///etc/passwd", on_error: "continue" },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
    ]);
    assert.strictEqual(r.steps[0].status, "error");
    assert.strictEqual(typeof r.steps[0].error, "string");
    assert.doesNotThrow(() => JSON.stringify(r), "pipeline result must be fully JSON-serialisable");
    assert.strictEqual(r.steps[1].status, "ok");
    assert.strictEqual(r.steps[1].result.status, 200);
  });

  // ── EXTREME ─────────────────────────────────────────────────────────────
  await test("pipeline: 10 concurrent pipelines (2 http_fetch steps each) all resolve correctly, no cross-contamination", async () => {
    const runs = await Promise.all(
      Array.from({ length: 10 }, () => pipeline([
        { op: "http_fetch", url: `http://127.0.0.1:${PORT}/a` },
        { op: "http_fetch", url: `http://127.0.0.1:${PORT}/b` },
      ]))
    );
    for (const r of runs) {
      assert.strictEqual(r.completed, 2);
      assert.strictEqual(r.steps[0].result.body, "marker-a");
      assert.strictEqual(r.steps[1].result.body, "marker-b");
    }
  });

  await test("pipeline: 5 http_fetch steps targeting the same endpoint all resolve as fully-formed, JSON-serialisable objects", async () => {
    const r = await pipeline([
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
      { op: "http_fetch", url: `http://127.0.0.1:${PORT}/echo` },
    ]);
    assert.strictEqual(r.completed, 5);
    assert.strictEqual(r.failed, 0);
    const serialised = JSON.stringify(r);
    assert.ok(!serialised.includes("[object Promise]"), "no dangling Promise leaked into the pipeline result");
    for (const step of r.steps) {
      assert.strictEqual(step.status, "ok");
      assert.strictEqual(typeof step.result, "object");
      assert.strictEqual(step.result.status, 200);
    }
  });

  // ── CLEANUP ─────────────────────────────────────────────────────────────
  await test("cleanup: shut down local test server (29b)", async () => {
    await stopTestServer();
    assert.ok(true, "test server closed cleanly");
  });

})().catch((e) => {
  counters.fail++;
  console.error(`[32b] UNHANDLED TEST ERROR: ${e.stack || e.message}`);
});
