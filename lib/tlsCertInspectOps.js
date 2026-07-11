"use strict";
// ── tls_cert_inspect: inspect TLS/SSL certificates for a host ───────────────────
// Uses Node's built-in tls module — zero npm dependencies.
// Operations:
//   inspect — connect and return the server's leaf certificate + TLS details
//   chain   — return the full peer certificate chain (leaf → intermediates → root)

const tls  = require("tls");
const { ToolError } = require("./errors");

const DEFAULT_PORT     = 443;
const DEFAULT_TIMEOUT  = 10_000;  // 10 s
const DEFAULT_WARN_DAYS = 30;

/**
 * Parse Subject Alternative Names from the raw subjectaltname string.
 * Format: "DNS:example.com, DNS:www.example.com, IP Address:1.2.3.4"
 */
function parseSANs(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Format a certificate peer object from tls.getPeerCertificate() into a
 * clean, serialisable structure.
 *
 * @param {object} raw  — raw peer cert object from Node tls
 * @returns {object|null}
 */
function formatCert(raw) {
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return null;

  const subject = raw.subject || {};
  const issuer  = raw.issuer  || {};

  const validFrom = raw.valid_from ? new Date(raw.valid_from) : null;
  const validTo   = raw.valid_to   ? new Date(raw.valid_to)   : null;
  const now       = new Date();

  const isExpired        = validTo ? validTo < now : null;
  const daysUntilExpiry  = validTo
    ? Math.floor((validTo - now) / (1000 * 60 * 60 * 24))
    : null;

  // Self-signed: subject and issuer identical
  const isSelfSigned =
    !!subject.CN && !!issuer.CN &&
    JSON.stringify(subject) === JSON.stringify(issuer);

  // CA flag from the basic constraints extension (bit 5 of key usage)
  const isCA = raw.ca === true;

  return {
    subject,
    issuer,
    serialNumber:   raw.serialNumber   || null,
    valid_from:     raw.valid_from     || null,
    valid_to:       raw.valid_to       || null,
    isExpired,
    daysUntilExpiry,
    subjectAltNames: parseSANs(raw.subjectaltname),
    fingerprint:    raw.fingerprint    || null,
    fingerprint256: raw.fingerprint256 || null,
    bits:           raw.bits           || null,
    isSelfSigned,
    isCA,
  };
}

/**
 * Walk the getPeerCertificate(true) linked list and return an array of
 * formatted cert objects from leaf → root.
 *
 * Node's getPeerCertificate(true) returns the leaf cert with an
 * .issuerCertificate pointer. Self-signed certs point to themselves.
 *
 * @param {object} leafRaw
 * @returns {object[]}
 */
function buildChain(leafRaw) {
  const chain   = [];
  const visited = new Set();
  let current   = leafRaw;

  while (current && typeof current === "object") {
    // Use fingerprint256 (most unique) as visited key
    const fp = current.fingerprint256 || current.fingerprint || JSON.stringify(current.subject);
    if (!fp || visited.has(fp)) break;
    visited.add(fp);
    const formatted = formatCert(current);
    if (formatted) chain.push(formatted);
    // Stop at self-signed or when issuerCertificate is the same node
    if (!current.issuerCertificate || current.issuerCertificate === current) break;
    current = current.issuerCertificate;
  }

  return chain;
}

/**
 * Connect to host:port via TLS and resolve certificate details.
 *
 * @param {object} opts
 * @param {"inspect"|"chain"} opts.operation
 * @param {string}  opts.host
 * @param {number}  [opts.port]        default 443
 * @param {number}  [opts.timeout]     ms, default 10 000
 * @param {string}  [opts.servername]  SNI override (defaults to host)
 * @param {number}  [opts.warn_days]   warn if expires within N days, default 30
 * @returns {Promise<object>}
 */
function tlsCertInspect(opts = {}) {
  const { operation = "inspect" } = opts;

  if (operation !== "inspect" && operation !== "chain") {
    throw new ToolError(
      `tls_cert_inspect: unknown operation '${operation}'. Valid: inspect, chain.`,
      -32602
    );
  }

  const host = opts.host;
  if (!host || typeof host !== "string" || !host.trim()) {
    throw new ToolError("tls_cert_inspect: 'host' is required (non-empty string).", -32602);
  }

  const port = (typeof opts.port === "number" && opts.port > 0 && opts.port <= 65535)
    ? Math.floor(opts.port)
    : DEFAULT_PORT;

  if (opts.port !== undefined && (typeof opts.port !== "number" || opts.port <= 0 || opts.port > 65535)) {
    throw new ToolError("tls_cert_inspect: 'port' must be a number between 1 and 65535.", -32602);
  }

  const timeout = (typeof opts.timeout === "number" && opts.timeout > 0)
    ? opts.timeout
    : DEFAULT_TIMEOUT;

  const warnDays = (typeof opts.warn_days === "number" && opts.warn_days >= 0)
    ? Math.floor(opts.warn_days)
    : DEFAULT_WARN_DAYS;

  const servername = (typeof opts.servername === "string" && opts.servername.trim())
    ? opts.servername.trim()
    : host.trim();

  const hostTrimmed = host.trim();

  return new Promise((resolve, reject) => {
    let settled = false;

    const done = (val)  => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };
    const fail = (err)  => { if (!settled) { settled = true; clearTimeout(timer); reject(err);  } };

    const socket = tls.connect(
      {
        host:               hostTrimmed,
        port,
        servername,
        rejectUnauthorized: false,       // inspect mode — we don't enforce trust
        checkServerIdentity: () => undefined, // suppress hostname mismatch
      },
      () => {
        // 'secureConnect' callback fires after TLS handshake
        const authorized = socket.authorized;
        const authError  = authorized ? null : (socket.authorizationError || "unknown");
        const protocol   = socket.getProtocol ? socket.getProtocol() : null;
        const cipherInfo = socket.getCipher ? socket.getCipher() : null;

        // fullChain=true to walk the certificate chain
        const leafRaw = socket.getPeerCertificate(true);
        socket.end();

        const chain = buildChain(leafRaw);
        const leaf  = chain[0] || null;

        const common = {
          host:               hostTrimmed,
          port,
          servername,
          connected:          true,
          authorized,
          authorizationError: authError,
          protocol,
          cipher: cipherInfo
            ? { name: cipherInfo.name, version: cipherInfo.version }
            : null,
        };

        if (operation === "chain") {
          done({ ...common, chainLength: chain.length, chain });
        } else {
          // inspect: leaf cert + expiry warning
          let expiryWarning = null;
          if (leaf && typeof leaf.daysUntilExpiry === "number") {
            if (leaf.isExpired) {
              expiryWarning = "EXPIRED";
            } else if (leaf.daysUntilExpiry <= warnDays) {
              expiryWarning = `EXPIRES_IN_${leaf.daysUntilExpiry}_DAYS`;
            }
          }

          done({
            ...common,
            warnDays,
            expiryWarning,
            cert: leaf,
          });
        }
      }
    );

    const timer = setTimeout(() => {
      if (settled) return;
      socket.destroy();
      fail(new ToolError(
        `tls_cert_inspect: connection to ${hostTrimmed}:${port} timed out after ${timeout}ms.`,
        -32603
      ));
    }, timeout);

    socket.on("error", (err) => {
      // Common: ECONNREFUSED, ENOTFOUND, ECONNRESET
      fail(new ToolError(
        `tls_cert_inspect: connection error for ${hostTrimmed}:${port} — ${err.message}`,
        -32603
      ));
    });
  });
}

module.exports = { tlsCertInspect, formatCert, buildChain, parseSANs };
