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

module.exports = { portCheck };
