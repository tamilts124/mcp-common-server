"use strict";
// ── PORT_CHECK — TCP port open/closed probe ─────────────────────────────────
// Attempts a raw TCP connect to host:port and reports whether it opened,
// timed out, or errored. Always available — pure Node net module, no exec.

const net = require("net");
const { ToolError } = require("./errors");

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_S = 30;
const MAX_PORT = 65535;

/**
 * Probe a TCP port.
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {number} [opts.timeout] seconds (default 3, max 30)
 * @returns {Promise<{host:string, port:number, open:boolean, timeMs:number, error?:string}>}
 */
function portCheck(opts = {}) {
  const host = opts.host;
  if (!host || typeof host !== "string" || host.trim() === "") {
    throw new ToolError("port_check: 'host' is required and must be a non-empty string.", -32602);
  }
  const port = opts.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new ToolError(`port_check: 'port' must be an integer between 1 and ${MAX_PORT}.`, -32602);
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (opts.timeout !== undefined) {
    if (typeof opts.timeout !== "number" || !Number.isFinite(opts.timeout) || opts.timeout <= 0) {
      throw new ToolError("port_check: 'timeout' must be a positive number of seconds.", -32602);
    }
    timeoutMs = Math.min(opts.timeout, MAX_TIMEOUT_S) * 1000;
  }

  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(open, error) {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ host, port, open, timeMs: Date.now() - start, ...(error ? { error } : {}) });
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (e) => finish(false, e.code || e.message));

    try {
      socket.connect(port, host);
    } catch (e) {
      finish(false, e.message);
    }
  });
}

const MAX_WAIT_TIMEOUT_S = 60;
const DEFAULT_WAIT_TIMEOUT_S = 30;
const DEFAULT_INTERVAL_S = 1;
const MIN_INTERVAL_S = 0.1;

/**
 * Poll a TCP port repeatedly until it opens or the overall timeout elapses.
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {number} [opts.timeout] overall wait budget, seconds (default 30, max 60)
 * @param {number} [opts.interval] seconds between attempts (default 1, min 0.1)
 * @param {number} [opts.connect_timeout] per-attempt connect timeout, seconds (default 3, max 30)
 * @returns {Promise<{host:string, port:number, open:boolean, attempts:number, elapsedMs:number, error?:string}>}
 */
async function waitForPort(opts = {}) {
  const host = opts.host;
  if (!host || typeof host !== "string" || host.trim() === "") {
    throw new ToolError("wait_for_port: 'host' is required and must be a non-empty string.", -32602);
  }
  const port = opts.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new ToolError(`wait_for_port: 'port' must be an integer between 1 and ${MAX_PORT}.`, -32602);
  }
  let overallMs = DEFAULT_WAIT_TIMEOUT_S * 1000;
  if (opts.timeout !== undefined) {
    if (typeof opts.timeout !== "number" || !Number.isFinite(opts.timeout) || opts.timeout <= 0) {
      throw new ToolError("wait_for_port: 'timeout' must be a positive number of seconds.", -32602);
    }
    overallMs = Math.min(opts.timeout, MAX_WAIT_TIMEOUT_S) * 1000;
  }
  let intervalMs = DEFAULT_INTERVAL_S * 1000;
  if (opts.interval !== undefined) {
    if (typeof opts.interval !== "number" || !Number.isFinite(opts.interval) || opts.interval < MIN_INTERVAL_S) {
      throw new ToolError(`wait_for_port: 'interval' must be a number >= ${MIN_INTERVAL_S} seconds.`, -32602);
    }
    intervalMs = opts.interval * 1000;
  }
  let connectTimeout;
  if (opts.connect_timeout !== undefined) {
    if (typeof opts.connect_timeout !== "number" || !Number.isFinite(opts.connect_timeout) || opts.connect_timeout <= 0) {
      throw new ToolError("wait_for_port: 'connect_timeout' must be a positive number of seconds.", -32602);
    }
    connectTimeout = opts.connect_timeout;
  }

  const start = Date.now();
  let attempts = 0;
  let lastError;

  while (true) {
    attempts++;
    const remainingMs = overallMs - (Date.now() - start);
    const perAttemptTimeoutS = connectTimeout !== undefined
      ? connectTimeout
      : Math.max(0.1, Math.min(3, remainingMs / 1000));

    const result = await portCheck({ host, port, timeout: perAttemptTimeoutS });
    if (result.open) {
      return { host, port, open: true, attempts, elapsedMs: Date.now() - start };
    }
    lastError = result.error;

    const elapsed = Date.now() - start;
    if (elapsed >= overallMs) {
      return { host, port, open: false, attempts, elapsedMs: elapsed, error: lastError || "timeout" };
    }

    const sleepMs = Math.min(intervalMs, overallMs - elapsed);
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
}

module.exports = { portCheck, waitForPort };
