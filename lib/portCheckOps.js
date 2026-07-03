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

const MAX_RANGE_PORTS = 1000;
const DEFAULT_SCAN_TIMEOUT_S = 1;
const MAX_SCAN_TIMEOUT_S = 10;
const DEFAULT_CONCURRENCY = 50;
const MAX_CONCURRENCY = 200;

function validatePortArg(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PORT) {
    throw new ToolError(`port_scan_range: '${name}' must be an integer between 1 and ${MAX_PORT}.`, -32602);
  }
}

/**
 * Scan a range of TCP ports on a host concurrently.
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.start_port
 * @param {number} opts.end_port
 * @param {number} [opts.timeout] per-port connect timeout, seconds (default 1, max 10)
 * @param {number} [opts.concurrency] max in-flight probes (default 50, max 200)
 * @returns {Promise<{host:string, startPort:number, endPort:number, totalPorts:number, openPorts:number[], closedCount:number, elapsedMs:number}>}
 */
async function portScanRange(opts = {}) {
  const host = opts.host;
  if (!host || typeof host !== "string" || host.trim() === "") {
    throw new ToolError("port_scan_range: 'host' is required and must be a non-empty string.", -32602);
  }
  validatePortArg("start_port", opts.start_port);
  validatePortArg("end_port", opts.end_port);
  const startPort = opts.start_port;
  const endPort = opts.end_port;
  if (endPort < startPort) {
    throw new ToolError("port_scan_range: 'end_port' must be >= 'start_port'.", -32602);
  }
  const totalPorts = endPort - startPort + 1;
  if (totalPorts > MAX_RANGE_PORTS) {
    throw new ToolError(`port_scan_range: range spans ${totalPorts} ports, exceeding the max of ${MAX_RANGE_PORTS}. Narrow start_port/end_port.`, -32602);
  }

  let timeoutS = DEFAULT_SCAN_TIMEOUT_S;
  if (opts.timeout !== undefined) {
    if (typeof opts.timeout !== "number" || !Number.isFinite(opts.timeout) || opts.timeout <= 0) {
      throw new ToolError("port_scan_range: 'timeout' must be a positive number of seconds.", -32602);
    }
    timeoutS = Math.min(opts.timeout, MAX_SCAN_TIMEOUT_S);
  }

  let concurrency = DEFAULT_CONCURRENCY;
  if (opts.concurrency !== undefined) {
    if (typeof opts.concurrency !== "number" || !Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new ToolError("port_scan_range: 'concurrency' must be a positive integer.", -32602);
    }
    concurrency = Math.min(opts.concurrency, MAX_CONCURRENCY);
  }

  const start = Date.now();
  const ports = [];
  for (let p = startPort; p <= endPort; p++) ports.push(p);

  const openPorts = [];
  let idx = 0;
  async function worker() {
    while (idx < ports.length) {
      const myIdx = idx++;
      const port = ports[myIdx];
      const result = await portCheck({ host, port, timeout: timeoutS });
      if (result.open) openPorts.push(port);
    }
  }
  const workers = [];
  const workerCount = Math.min(concurrency, ports.length);
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);

  openPorts.sort((a, b) => a - b);
  return {
    host,
    startPort,
    endPort,
    totalPorts,
    openPorts,
    closedCount: totalPorts - openPorts.length,
    elapsedMs: Date.now() - start,
  };
}

module.exports = { portCheck, waitForPort, portScanRange };
