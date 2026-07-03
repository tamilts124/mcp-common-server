"use strict";
// ── DNS_LOOKUP — hostname/IP resolution via Node's dns module ───────────────
// Resolves a hostname to its records (A/AAAA/CNAME/MX/TXT/NS/SRV) or, when
// given an IP, performs a reverse lookup (PTR). Pure Node dns module, no
// exec, no external deps. Always available.

const dns = require("dns").promises;
const net = require("net");
const { ToolError } = require("./errors");

const VALID_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "PTR"];
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_S = 30;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolve a hostname's DNS records, or reverse-resolve an IP to hostname(s).
 * @param {object} opts
 * @param {string} opts.host hostname or IP address
 * @param {string} [opts.type] record type (default: auto — PTR for IPs, A for hostnames)
 * @param {number} [opts.timeout] seconds (default 5, max 30)
 * @returns {Promise<object>}
 */
async function dnsLookup(opts = {}) {
  const host = opts.host;
  if (!host || typeof host !== "string" || host.trim() === "") {
    throw new ToolError("dns_lookup: 'host' is required and must be a non-empty string.", -32602);
  }
  const trimmedHost = host.trim();

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (opts.timeout !== undefined) {
    if (typeof opts.timeout !== "number" || !Number.isFinite(opts.timeout) || opts.timeout <= 0) {
      throw new ToolError("dns_lookup: 'timeout' must be a positive number of seconds.", -32602);
    }
    timeoutMs = Math.min(opts.timeout, MAX_TIMEOUT_S) * 1000;
  }

  const isIp = net.isIP(trimmedHost) !== 0;
  let type = opts.type;
  if (type !== undefined) {
    if (typeof type !== "string" || !VALID_TYPES.includes(type.toUpperCase())) {
      throw new ToolError(`dns_lookup: 'type' must be one of ${VALID_TYPES.join(", ")}.`, -32602);
    }
    type = type.toUpperCase();
  } else {
    type = isIp ? "PTR" : "A";
  }

  if (type === "PTR" && !isIp) {
    throw new ToolError("dns_lookup: type 'PTR' (reverse lookup) requires 'host' to be an IP address.", -32602);
  }
  if (type !== "PTR" && isIp) {
    throw new ToolError(`dns_lookup: 'host' is an IP address; use type 'PTR' for reverse lookup (or omit 'type').`, -32602);
  }

  const start = Date.now();
  try {
    let records;
    if (type === "PTR") {
      records = await withTimeout(dns.reverse(trimmedHost), timeoutMs, "dns_lookup");
    } else if (type === "MX") {
      records = await withTimeout(dns.resolveMx(trimmedHost), timeoutMs, "dns_lookup");
    } else if (type === "TXT") {
      records = await withTimeout(dns.resolveTxt(trimmedHost), timeoutMs, "dns_lookup");
    } else if (type === "NS") {
      records = await withTimeout(dns.resolveNs(trimmedHost), timeoutMs, "dns_lookup");
    } else if (type === "SRV") {
      records = await withTimeout(dns.resolveSrv(trimmedHost), timeoutMs, "dns_lookup");
    } else if (type === "CNAME") {
      records = await withTimeout(dns.resolveCname(trimmedHost), timeoutMs, "dns_lookup");
    } else if (type === "AAAA") {
      records = await withTimeout(dns.resolve6(trimmedHost), timeoutMs, "dns_lookup");
    } else {
      records = await withTimeout(dns.resolve4(trimmedHost), timeoutMs, "dns_lookup");
    }
    return { host: trimmedHost, type, records, elapsedMs: Date.now() - start };
  } catch (e) {
    if (e.message && e.message.endsWith("timed out")) {
      return { host: trimmedHost, type, records: [], elapsedMs: Date.now() - start, error: "timeout" };
    }
    const code = e.code || e.message || "ENOTFOUND";
    return { host: trimmedHost, type, records: [], elapsedMs: Date.now() - start, error: code };
  }
}

module.exports = { dnsLookup };
