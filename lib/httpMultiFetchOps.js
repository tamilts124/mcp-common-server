"use strict";
// ── http_multi_fetch: send multiple HTTP requests in parallel ────────────────
// Zero additional npm dependencies — reuses httpFetch from httpFetchOps.js.
// Configurable concurrency (default 5, max 20) via a simple worker-pool.
// Each request may override url, method, headers, body, timeout.
// Always collects all results (even errors) unless fail_fast: true.

const { httpFetch } = require("./httpFetchOps");
const { ToolError } = require("./errors");

const MAX_REQUESTS    = 100;
const MAX_CONCURRENCY = 20;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_S   = 15;  // seconds (passed to httpFetch)

/**
 * Concurrency-limited map: run `tasks` (array of () => Promise) with at most
 * `concurrency` running simultaneously. Returns results in input order.
 * Never rejects — each task's outcome is captured as { status, value, reason }.
 *
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} concurrency
 * @returns {Promise<Array<{status: "fulfilled"|"rejected", value?, reason?}>>}
 */
async function pMap(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const i = nextIdx++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  }

  // Spawn exactly min(concurrency, tasks.length) workers
  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Send multiple HTTP requests in parallel.
 *
 * @param {object}  opts
 * @param {Array}   opts.requests            — Array of request configs
 * @param {number}  [opts.concurrency]       — Max parallel requests (1-20, default 5)
 * @param {number}  [opts.timeout]           — Default timeout per request in seconds (default 15)
 * @param {boolean} [opts.fail_fast]         — If true, reject on first connection error
 * @returns {Promise<object>}
 */
async function httpMultiFetch(opts = {}) {
  const { requests, fail_fast = false } = opts;

  // ── Validation ───────────────────────────────────────────────────────────────
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new ToolError("http_multi_fetch: 'requests' must be a non-empty array.", -32602);
  }
  if (requests.length > MAX_REQUESTS) {
    throw new ToolError(
      `http_multi_fetch: 'requests' length (${requests.length}) exceeds ${MAX_REQUESTS} request limit.`,
      -32602
    );
  }

  const concurrency = (typeof opts.concurrency === "number" && opts.concurrency > 0)
    ? Math.min(Math.floor(opts.concurrency), MAX_CONCURRENCY)
    : DEFAULT_CONCURRENCY;

  const defaultTimeoutS = (typeof opts.timeout === "number" && opts.timeout > 0)
    ? opts.timeout
    : DEFAULT_TIMEOUT_S;

  // Validate each request object up-front before firing anything
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      throw new ToolError(`http_multi_fetch: requests[${i}] must be a plain object.`, -32602);
    }
    if (!req.url || typeof req.url !== "string" || !req.url.trim()) {
      throw new ToolError(`http_multi_fetch: requests[${i}].url is required (non-empty string).`, -32602);
    }
  }

  const startAll = Date.now();

  // ── Build task array ─────────────────────────────────────────────────────────
  const tasks = requests.map((req, i) => async () => {
    const t0 = Date.now();
    const timeout = (typeof req.timeout === "number" && req.timeout > 0)
      ? req.timeout
      : defaultTimeoutS;
    try {
      const result = await httpFetch({
        url:     req.url,
        method:  req.method,
        headers: req.headers,
        body:    req.body,
        timeout,
      });
      return {
        index:       i,
        url:         result.url,         // final URL after redirects
        status:      result.status,
        statusText:  result.statusText,
        ok:          result.ok,
        redirected:  result.redirected,
        headers:     result.headers,
        body:        result.body,
        bodySize:    result.bodySize,
        truncated:   result.truncated,
        duration_ms: Date.now() - t0,
        error:       null,
      };
    } catch (e) {
      return {
        index:       i,
        url:         req.url,
        status:      null,
        statusText:  null,
        ok:          false,
        redirected:  false,
        headers:     null,
        body:        null,
        bodySize:    null,
        truncated:   false,
        duration_ms: Date.now() - t0,
        error:       e.message || String(e),
      };
    }
  });

  // ── Execute ───────────────────────────────────────────────────────────────────
  const settlements = await pMap(tasks, concurrency);

  // pMap never rejects (errors caught per-task), but in fail_fast mode we
  // surface the first network-level exception (error !== null) by rethrowing.
  const results = settlements.map(s =>
    s.status === "fulfilled" ? s.value : { error: String(s.reason) }
  );

  if (fail_fast) {
    const firstError = results.find(r => r.error !== null);
    if (firstError) {
      throw new ToolError(
        `http_multi_fetch (fail_fast): request[${firstError.index}] to ${firstError.url} failed — ${firstError.error}`,
        -32603
      );
    }
  }

  // ── Aggregate stats ───────────────────────────────────────────────────────────
  const succeeded  = results.filter(r => r.ok).length;
  const errors     = results.filter(r => r.error !== null).length;
  const httpFails  = results.filter(r => !r.ok && r.error === null).length;

  return {
    total:       results.length,
    succeeded,
    failed:      httpFails,
    errors,
    duration_ms: Date.now() - startAll,
    concurrency,
    results,
  };
}

module.exports = { httpMultiFetch, pMap };
