"use strict";
/**
 * tls_client — Zero-dependency live TLS/SSL inspector.
 * Pure Node.js (tls built-in; no npm deps).
 *
 * Connects to a server over TLS and returns:
 *   inspect  — Full cert chain, negotiated protocol/cipher, ALPN, SANs,
 *              validity, fingerprints, key usage, issuer/subject details
 *   chain    — Full DER/PEM certificate chain with parsed fields per cert
 *   ciphers  — Enumerate supported ciphers by probing (subset of TLS1.2+)
 *   verify   — Verify cert chain validity against system roots or custom CA
 *   scan     — Multi-port TLS scan (443, 8443, 465, 993, etc.)
 *   info     — Return tool config and supported options (no I/O)
 *
 * Security:
 *   - NUL-byte guards on all user-supplied strings
 *   - Timeout clamped 1 s – 30 s (default 10 s)
 *   - Port must be 1–65535
 *   - SNI is sent automatically (can be overridden or disabled)
 *   - Never logs credentials or private-key material
 */

const tls    = require("tls");
const net    = require("net");
const crypto = require("crypto");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS     = 1_000;
const MAX_TIMEOUT_MS     = 30_000;
const DEFAULT_PORT       = 443;

// Well-known ports where TLS is expected
const WELL_KNOWN_TLS_PORTS = [
  { port: 443,   service: "HTTPS"   },
  { port: 8443,  service: "HTTPS-alt" },
  { port: 465,   service: "SMTPS"   },
  { port: 587,   service: "SMTP+STARTTLS" },
  { port: 636,   service: "LDAPS"   },
  { port: 993,   service: "IMAPS"   },
  { port: 995,   service: "POP3S"   },
  { port: 3389,  service: "RDP"     },
  { port: 5671,  service: "AMQPS"   },
  { port: 5986,  service: "WinRM"   },
  { port: 8883,  service: "MQTTS"   },
  { port: 9093,  service: "Kafka-TLS" },
];

// TLS protocol versions
const TLS_VERSIONS = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];

// Cipher suites to probe when operation=ciphers
// A representative subset of TLS 1.2 cipher suites
const PROBE_CIPHERS_TLS12 = [
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES256-SHA384",
  "ECDHE-RSA-AES128-SHA256",
  "ECDHE-RSA-AES256-SHA",
  "ECDHE-RSA-AES128-SHA",
  "DHE-RSA-AES256-GCM-SHA384",
  "DHE-RSA-AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-GCM-SHA256",
  "AES256-SHA256",
  "AES128-SHA256",
  "AES256-SHA",
  "AES128-SHA",
  "DES-CBC3-SHA",
  "RC4-SHA",
  "RC4-MD5",
  "NULL-MD5",
  "NULL-SHA",
];

// TLS 1.3 cipher suites (these are always negotiated by suite internally)
const TLS13_CIPHERS = [
  "TLS_AES_256_GCM_SHA384",
  "TLS_AES_128_GCM_SHA256",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_CCM_SHA256",
  "TLS_AES_128_CCM_8_SHA256",
];

// ── Guards ────────────────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`tls_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

function validatePort(port) {
  const p = port ?? DEFAULT_PORT;
  if (!Number.isInteger(p) || p < 1 || p > 65535)
    throw new Error(`tls_client: 'port' must be an integer 1–65535 (got ${p}).`);
  return p;
}

// ── Certificate helpers ───────────────────────────────────────────────────────

/**
 * Compute SHA-1 and SHA-256 fingerprints from a DER-encoded certificate.
 */
function computeFingerprints(derBuffer) {
  const sha1   = crypto.createHash("sha1").update(derBuffer).digest("hex")
    .match(/.{2}/g).join(":").toUpperCase();
  const sha256 = crypto.createHash("sha256").update(derBuffer).digest("hex")
    .match(/.{2}/g).join(":").toUpperCase();
  return { sha1, sha256 };
}

/**
 * Parse the Node.js tls.TLSSocket getPeerCertificate() object into a
 * clean, structured certificate record.
 */
function parseCertObject(cert, isLeaf) {
  if (!cert || !cert.subject) return null;

  // Extract Subject Alternative Names
  const sans = [];
  if (cert.subjectaltname) {
    for (const part of cert.subjectaltname.split(",")) {
      const trimmed = part.trim();
      const idx = trimmed.indexOf(":");
      if (idx !== -1) {
        sans.push({ type: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() });
      }
    }
  }

  // Extract key usage
  const keyUsage = cert.ext_key_usage ? cert.ext_key_usage : [];

  // Parse validity dates
  const notBefore = cert.valid_from ? new Date(cert.valid_from) : null;
  const notAfter  = cert.valid_to   ? new Date(cert.valid_to)   : null;
  const now       = new Date();
  const isExpired    = notAfter  ? now > notAfter  : false;
  const isNotYetValid = notBefore ? now < notBefore : false;
  const daysRemaining = notAfter
    ? Math.floor((notAfter - now) / (1000 * 60 * 60 * 24))
    : null;

  // Compute fingerprints from raw DER
  let fingerprints = null;
  if (cert.raw) {
    try {
      fingerprints = computeFingerprints(cert.raw);
    } catch (_) { /* ignore */ }
  }

  // Public key info
  const pubKey = cert.pubkey
    ? {
        bits:      cert.bits ?? null,
        algorithm: cert.asn1Curve ?? cert.nid ?? null,
      }
    : null;

  return {
    subject: cert.subject   || {},
    issuer:  cert.issuer    || {},
    serialNumber: cert.serialNumber || null,
    version:      cert.v3ext ? 3 : (cert.version ?? null),
    signatureAlgorithm: cert.sigalg || null,
    validity: {
      notBefore:    notBefore ? notBefore.toISOString() : null,
      notAfter:     notAfter  ? notAfter.toISOString()  : null,
      isExpired,
      isNotYetValid,
      daysRemaining,
    },
    subjectAltNames: sans,
    keyUsage,
    publicKey:    pubKey,
    fingerprints,
    isCA:    cert.isCA     ?? null,
    isSelfSigned: cert.subject && cert.issuer
      ? JSON.stringify(cert.subject) === JSON.stringify(cert.issuer)
      : null,
    isLeaf: isLeaf === true,
    pem: cert.raw
      ? `-----BEGIN CERTIFICATE-----\n${cert.raw.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----`
      : null,
  };
}

/**
 * Walk the certificate chain (getPeerCertificate(true) returns a linked list
 * via the issuerCertificate field). Stops at self-signed or when we loop.
 */
function extractChain(leafCert) {
  const chain = [];
  const seen  = new Set();
  let   current = leafCert;
  let   isLeaf  = true;

  while (current) {
    const fp = current.fingerprint256 || current.fingerprint || JSON.stringify(current.subject);
    if (seen.has(fp)) break;   // loop detection
    seen.add(fp);

    const parsed = parseCertObject(current, isLeaf);
    if (parsed) chain.push(parsed);
    isLeaf = false;

    // Check if issuer === subject (self-signed root)
    if (current.issuerCertificate === current) break;
    current = current.issuerCertificate || null;
  }

  return chain;
}

/**
 * Compute a human-readable assessment of the TLS configuration security.
 */
function assessSecurity(protocol, cipher, chain) {
  const issues = [];
  const warnings = [];

  // Protocol checks
  if (protocol === "TLSv1" || protocol === "SSLv3" || protocol === "SSLv2") {
    issues.push(`Deprecated protocol: ${protocol} — vulnerable to POODLE/BEAST`);
  } else if (protocol === "TLSv1.1") {
    warnings.push("TLS 1.1 is deprecated (RFC 8996); upgrade to TLS 1.2 or 1.3");
  }

  // Cipher checks
  if (cipher) {
    const name = cipher.name || "";
    if (name.includes("RC4"))   issues.push("RC4 cipher is broken (RFC 7465)");
    if (name.includes("DES") && !name.includes("3DES")) issues.push("DES cipher is broken");
    if (name.includes("3DES") || name.includes("CBC3")) warnings.push("3DES (SWEET32 attack risk)");
    if (name.includes("NULL") || name.includes("EXPORT")) issues.push("NULL/EXPORT cipher — no encryption");
    if (name.includes("anon") || name.includes("ADH") || name.includes("AECDH")) {
      issues.push("Anonymous cipher — no server authentication");
    }
    if (name.includes("MD5")) warnings.push("MD5 in cipher (deprecated)");
    if (!name.includes("ECDHE") && !name.includes("DHE") && protocol !== "TLSv1.3") {
      warnings.push("No forward secrecy (missing ECDHE/DHE key exchange)");
    }
  }

  // Certificate checks
  if (chain && chain.length > 0) {
    const leaf = chain[0];
    if (leaf.validity.isExpired) {
      issues.push("Certificate is expired");
    } else if (leaf.validity.daysRemaining !== null && leaf.validity.daysRemaining < 30) {
      warnings.push(`Certificate expires in ${leaf.validity.daysRemaining} days`);
    }
    if (leaf.isSelfSigned) {
      warnings.push("Self-signed certificate (not trusted by browsers)");
    }
    if (leaf.publicKey && leaf.publicKey.bits && leaf.publicKey.bits < 2048) {
      issues.push(`Weak key: ${leaf.publicKey.bits} bits (minimum 2048 recommended)`);
    }
    if (leaf.signatureAlgorithm && /md5|sha1/i.test(leaf.signatureAlgorithm)) {
      issues.push(`Weak signature algorithm: ${leaf.signatureAlgorithm}`);
    }
  }

  let grade;
  if (issues.length === 0 && warnings.length === 0) grade = "A";
  else if (issues.length === 0) grade = "B";
  else if (issues.length <= 1) grade = "C";
  else grade = "F";

  return { grade, issues, warnings };
}

// ── Core TLS connection ───────────────────────────────────────────────────────
/**
 * Establish a TLS connection to host:port, return socket info and peer cert.
 * options: { servername, minVersion, maxVersion, ciphers, rejectUnauthorized, ca }
 */
function tlsConnect(host, port, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    const connectOpts = {
      host,
      port,
      servername:          options.servername !== undefined ? options.servername : host,
      rejectUnauthorized:  options.rejectUnauthorized !== false,   // default: verify
      checkServerIdentity: options.rejectUnauthorized === false    // skip if not verifying
        ? () => undefined
        : undefined,
    };

    if (options.minVersion) connectOpts.minVersion = options.minVersion;
    if (options.maxVersion) connectOpts.maxVersion = options.maxVersion;
    if (options.ciphers)    connectOpts.ciphers    = options.ciphers;
    if (options.ca)         connectOpts.ca         = options.ca;

    // For rejectUnauthorized=false we still want the cert
    if (options.rejectUnauthorized === false) {
      connectOpts.checkServerIdentity = () => undefined;
    }

    const timer = setTimeout(() => {
      sock.destroy();
      finish(new Error(`tls_client: connection to ${host}:${port} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    const sock = tls.connect(connectOpts, () => {
      try {
        const peerCert      = sock.getPeerCertificate(true);
        const cipher        = sock.getCipher();
        const protocol      = sock.getProtocol();
        const alpnProtocol  = sock.alpnProtocol || null;
        const authorized    = sock.authorized;
        const authError     = sock.authorizationError || null;
        const sessionReused = sock.isSessionReused ? sock.isSessionReused() : null;

        finish(null, {
          peerCert,
          cipher,
          protocol,
          alpnProtocol,
          authorized,
          authError,
          sessionReused,
          localAddress:  sock.localAddress,
          localPort:     sock.localPort,
          remoteAddress: sock.remoteAddress,
          remoteFamily:  sock.remoteFamily,
        });
      } catch (e) {
        finish(new Error(`tls_client: failed to read TLS session info: ${e.message}`));
      } finally {
        sock.destroy();
      }
    });

    sock.on("error", (err) => {
      if (err.code === "ENOTFOUND")
        finish(new Error(`tls_client: host not found: '${host}'.`));
      else if (err.code === "ECONNREFUSED")
        finish(new Error(`tls_client: connection refused by ${host}:${port}.`));
      else if (err.code === "CERT_HAS_EXPIRED")
        finish(new Error(`tls_client: certificate expired on ${host}. Use verify_certificate:false to inspect anyway.`));
      else if (err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
               err.code === "SELF_SIGNED_CERT_IN_CHAIN" ||
               err.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
               err.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
               err.code === "CERT_UNTRUSTED")
        finish(new Error(`tls_client: certificate verification failed (${err.code}). Use verify_certificate:false to inspect untrusted certificates.`));
      else if (err.code === "ERR_SSL_WRONG_VERSION_NUMBER" ||
               err.code === "ERR_SSL_NO_PROTOCOLS_AVAILABLE")
        finish(new Error(`tls_client: TLS handshake failed — server may not support TLS or cipher mismatch: ${err.message}`));
      else
        finish(new Error(`tls_client: TLS error connecting to ${host}:${port}: ${err.message}`));
    });
  });
}

// ── Operations ───────────────────────────────���────────────────────────────────

/** inspect — Full TLS inspection: cert chain, cipher, protocol, ALPN, security grade */
async function opInspect(args) {
  const host      = (args.host || "").trim();
  if (!host) throw new Error("tls_client: 'host' is required for operation 'inspect'.");
  guardNul(host, "host");

  const port       = validatePort(args.port);
  const timeoutMs  = clampTimeout(args.timeout);
  const servername = args.servername !== undefined ? args.servername : host;
  const rejectUnauthorized = args.verify_certificate !== false;  // default: true

  if (args.servername !== undefined) guardNul(args.servername, "servername");

  const t0 = Date.now();
  let info;
  try {
    info = await tlsConnect(host, port, timeoutMs, { servername, rejectUnauthorized });
  } catch (e) {
    // If verification failed with rejectUnauthorized=true, try without to get cert info
    if (rejectUnauthorized &&
        (e.message.includes("certificate verification failed") ||
         e.message.includes("certificate expired"))) {
      // Re-throw with helpful message
      throw e;
    }
    throw e;
  }
  const elapsed = Date.now() - t0;

  const chain    = extractChain(info.peerCert);
  const security = assessSecurity(info.protocol, info.cipher, chain);

  return {
    ok:           true,
    operation:    "inspect",
    host,
    port,
    servername,
    elapsedMs:    elapsed,
    protocol:     info.protocol,
    cipher:       info.cipher,
    alpnProtocol: info.alpnProtocol,
    authorized:   info.authorized,
    authorizationError: info.authError,
    sessionReused:      info.sessionReused,
    remoteAddress:      info.remoteAddress,
    certificateChain:   chain,
    chainLength:        chain.length,
    leafCertificate:    chain[0] || null,
    security,
  };
}

/** chain — Return the full certificate chain in PEM + parsed form */
async function opChain(args) {
  const host      = (args.host || "").trim();
  if (!host) throw new Error("tls_client: 'host' is required for operation 'chain'.");
  guardNul(host, "host");

  const port       = validatePort(args.port);
  const timeoutMs  = clampTimeout(args.timeout);
  const servername = args.servername !== undefined ? args.servername : host;
  const rejectUnauthorized = args.verify_certificate !== false;

  const t0   = Date.now();
  const info = await tlsConnect(host, port, timeoutMs, { servername, rejectUnauthorized });
  const elapsed = Date.now() - t0;

  const chain = extractChain(info.peerCert);

  return {
    ok:        true,
    operation: "chain",
    host,
    port,
    servername,
    elapsedMs: elapsed,
    protocol:  info.protocol,
    chain,
    chainLength: chain.length,
    pems: chain.map(c => c.pem).filter(Boolean),
  };
}

/** verify — Verify cert chain validity; optionally against a custom CA bundle */
async function opVerify(args) {
  const host      = (args.host || "").trim();
  if (!host) throw new Error("tls_client: 'host' is required for operation 'verify'.");
  guardNul(host, "host");

  const port       = validatePort(args.port);
  const timeoutMs  = clampTimeout(args.timeout);
  const servername = args.servername !== undefined ? args.servername : host;
  const customCa   = args.ca_pem || null;

  if (customCa) guardNul(customCa, "ca_pem");

  const connectOpts = {
    servername,
    rejectUnauthorized: true,
  };
  if (customCa) connectOpts.ca = customCa;

  let authorized = false;
  let authError  = null;
  let chain      = [];
  let protocol   = null;
  let cipher     = null;
  const t0       = Date.now();

  try {
    const info = await tlsConnect(host, port, timeoutMs, connectOpts);
    authorized = info.authorized;
    authError  = info.authError;
    chain      = extractChain(info.peerCert);
    protocol   = info.protocol;
    cipher     = info.cipher;
  } catch (e) {
    // Even on failure, try to get cert info without verification
    authError = e.message;
    try {
      const info2 = await tlsConnect(host, port, timeoutMs, {
        servername,
        rejectUnauthorized: false,
      });
      chain    = extractChain(info2.peerCert);
      protocol = info2.protocol;
      cipher   = info2.cipher;
    } catch (_) { /* best effort */ }
  }
  const elapsed = Date.now() - t0;

  // Hostname verification check
  let hostnameValid = null;
  if (chain.length > 0) {
    const leaf = chain[0];
    const sans = leaf.subjectAltNames || [];
    const cnMatch = leaf.subject && leaf.subject.CN
      ? matchHostname(servername, leaf.subject.CN)
      : false;
    const sanDnsMatch = sans.some(s => s.type === "DNS" && matchHostname(servername, s.value));
    const sanIpMatch  = sans.some(s => s.type === "IP Address" && s.value === servername);
    hostnameValid = cnMatch || sanDnsMatch || sanIpMatch;
  }

  const leaf = chain[0] || null;

  return {
    ok:            true,
    operation:     "verify",
    host,
    port,
    servername,
    elapsedMs:     elapsed,
    protocol,
    cipher,
    authorized,
    authorizationError: authError,
    hostnameValid,
    certificateValid:   authorized && hostnameValid,
    leafCertificate:    leaf,
    chain,
    chainLength:        chain.length,
    customCaUsed:       !!customCa,
    summary: authorized
      ? `Certificate chain is valid and trusted${customCa ? " (custom CA)" : ""}."`
      : `Certificate chain verification FAILED: ${authError}`,
  };
}

/** matchHostname — RFC 2818 wildcard matching */
function matchHostname(name, pattern) {
  if (!name || !pattern) return false;
  const n = name.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === n) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    const parts  = n.split(".");
    if (parts.length >= 2) {
      return parts.slice(1).join(".") === suffix;
    }
  }
  return false;
}

/** ciphers — Probe which cipher suites the server accepts */
async function opCiphers(args) {
  const host     = (args.host || "").trim();
  if (!host) throw new Error("tls_client: 'host' is required for operation 'ciphers'.");
  guardNul(host, "host");

  const port       = validatePort(args.port);
  const timeoutMs  = clampTimeout(args.timeout);
  const servername = args.servername !== undefined ? args.servername : host;

  // Single connection to get supported ciphers via Node's built-in list + negotiation
  const t0 = Date.now();

  // Get server-negotiated cipher (TLS 1.3 default)
  let negotiated = null;
  let protocol   = null;
  let tlsVersion = null;
  try {
    const info = await tlsConnect(host, port, timeoutMs, {
      servername,
      rejectUnauthorized: false,
    });
    negotiated = info.cipher;
    protocol   = info.protocol;
    tlsVersion = info.protocol;
  } catch (e) {
    throw new Error(`tls_client: initial connection failed: ${e.message}`);
  }

  // Probe individual TLS 1.2 ciphers in parallel (with concurrency cap)
  const CONCURRENCY = 5;
  const probeResults = [];
  const individualTimeout = Math.min(5000, timeoutMs);

  for (let i = 0; i < PROBE_CIPHERS_TLS12.length; i += CONCURRENCY) {
    const batch = PROBE_CIPHERS_TLS12.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (cipher) => {
      try {
        const info = await tlsConnect(host, port, individualTimeout, {
          servername,
          rejectUnauthorized: false,
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
          ciphers: cipher,
        });
        return { cipher, supported: true, protocol: info.protocol, negotiated: info.cipher };
      } catch (e) {
        // Connection failure = cipher not supported (or blocked)
        return { cipher, supported: false };
      }
    }));
    probeResults.push(...batchResults);
  }

  const elapsed = Date.now() - t0;
  const supported = probeResults.filter(r => r.supported).map(r => ({
    name:      r.cipher,
    protocol:  r.protocol,
    negotiated: r.negotiated ? r.negotiated.name : r.cipher,
    security:  classifyCipherSecurity(r.cipher),
  }));
  const rejected = probeResults.filter(r => !r.supported).map(r => r.cipher);

  // TLS 1.3 ciphers are always available when TLS 1.3 is supported
  const tls13Supported = protocol === "TLSv1.3" || (negotiated && negotiated.version === "TLSv1.3");
  const tls13Ciphers = tls13Supported
    ? TLS13_CIPHERS.map(c => ({ name: c, protocol: "TLSv1.3", security: "strong" }))
    : [];

  return {
    ok:           true,
    operation:    "ciphers",
    host,
    port,
    servername,
    elapsedMs:    elapsed,
    negotiatedProtocol:   protocol,
    negotiatedCipher:     negotiated,
    tls13Supported,
    tls13Ciphers,
    supportedTls12Ciphers: supported,
    rejectedCiphers:       rejected,
    supportedCount:        supported.length + tls13Ciphers.length,
    weakCiphers: supported.filter(c => c.security === "weak" || c.security === "broken"),
    note: "Cipher enumeration probes TLS 1.2 ciphers individually; TLS 1.3 suites are server-decided.",
  };
}

function classifyCipherSecurity(name) {
  if (!name) return "unknown";
  // Broken: null encryption, export-grade, anonymous (ADH/AECDH/anon), RC4, RC2, bare DES
  if (name.includes("NULL") || name.includes("EXPORT")) return "broken";
  if (name.includes("anon") || name.includes("ADH") || name.includes("AECDH")) return "broken";
  if (name.includes("RC4") || name.includes("RC2")) return "broken";
  // Bare DES (but NOT 3DES)
  if (name.includes("DES") && !name.includes("3DES") && !name.includes("CBC3")) return "broken";
  // Weak: 3DES, MD5 in cipher name
  if (name.includes("3DES") || name.includes("CBC3") || name.includes("MD5")) return "weak";
  if (name.includes("AES128-SHA") && !name.includes("256")) return "moderate";
  if (name.includes("GCM") || name.includes("CHACHA20") || name.includes("ECDHE")) return "strong";
  return "moderate";
}

/** scan — Probe multiple ports on a host for TLS availability */
async function opScan(args) {
  const host = (args.host || "").trim();
  if (!host) throw new Error("tls_client: 'host' is required for operation 'scan'.");
  guardNul(host, "host");

  const timeoutMs  = clampTimeout(args.timeout);
  const portsArg   = args.ports;
  let   portsToScan;

  if (Array.isArray(portsArg) && portsArg.length > 0) {
    portsToScan = portsArg.map(p => {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        throw new Error(`tls_client: invalid port in 'ports' array: ${p}`);
      return { port: n, service: "custom" };
    });
  } else {
    portsToScan = WELL_KNOWN_TLS_PORTS;
  }

  if (portsToScan.length > 50)
    throw new Error("tls_client: scan 'ports' array must not exceed 50 ports.");

  const CONCURRENCY  = 5;
  const portTimeout  = Math.min(5000, timeoutMs);
  const results      = [];
  const t0           = Date.now();

  for (let i = 0; i < portsToScan.length; i += CONCURRENCY) {
    const batch = portsToScan.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async ({ port, service }) => {
      try {
        const info = await tlsConnect(host, port, portTimeout, {
          servername: host,
          rejectUnauthorized: false,
        });
        const chain = extractChain(info.peerCert);
        const leaf  = chain[0] || null;
        return {
          port,
          service,
          tlsFound:    true,
          protocol:    info.protocol,
          cipher:      info.cipher ? info.cipher.name : null,
          authorized:  info.authorized,
          subject:     leaf ? (leaf.subject.CN || null) : null,
          notAfter:    leaf ? leaf.validity.notAfter : null,
          isExpired:   leaf ? leaf.validity.isExpired : null,
          daysRemaining: leaf ? leaf.validity.daysRemaining : null,
        };
      } catch (e) {
        // Distinguish "no TLS" from "port closed"
        const isTlsError = e.message.includes("TLS") || e.message.includes("tls") ||
                           e.message.includes("certificate") || e.message.includes("SSL");
        return {
          port,
          service,
          tlsFound: false,
          error: e.message.includes("ECONNREFUSED") ? "port closed"
               : e.message.includes("timed out")   ? "timeout"
               : isTlsError ? "TLS error"
               : e.message.slice(0, 120),
        };
      }
    }));
    results.push(...batchResults);
  }
  const elapsed = Date.now() - t0;

  const tlsPorts = results.filter(r => r.tlsFound);

  return {
    ok:          true,
    operation:   "scan",
    host,
    elapsedMs:   elapsed,
    portsScanned: portsToScan.length,
    tlsPortsFound: tlsPorts.length,
    results,
    openTlsPorts: tlsPorts.map(r => r.port),
  };
}

/** info — Return configuration and capabilities (no I/O) */
function opInfo(args) {
  const timeoutMs = clampTimeout(args.timeout);
  return {
    ok:           true,
    operation:    "info",
    defaultPort:  DEFAULT_PORT,
    timeoutMs,
    supportedOperations: ["inspect", "chain", "ciphers", "verify", "scan", "info"],
    tlsVersions:         TLS_VERSIONS,
    wellKnownTlsPorts:   WELL_KNOWN_TLS_PORTS,
    tls13Ciphers:        TLS13_CIPHERS,
    probedTls12Ciphers:  PROBE_CIPHERS_TLS12,
    nodeTlsVersion:      tls.DEFAULT_MAX_VERSION || "TLSv1.3",
    notes: [
      "inspect: connects to server, returns full cert chain + negotiated cipher + security grade.",
      "chain:   returns DER/PEM chain only.",
      "ciphers: probes TLS 1.2 cipher suites individually; TLS 1.3 suites are server-negotiated.",
      "verify:  checks chain against system roots (or custom CA PEM); returns hostname validation.",
      "scan:    probes multiple ports concurrently for TLS presence.",
      "set verify_certificate:false to inspect self-signed or expired certificates.",
      "set servername to override SNI (useful for CDN/SNI routing).",
    ],
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function tlsClient(args) {
  const op = args.operation;
  if (!op) throw new Error("tls_client: 'operation' is required.");

  switch (op) {
    case "inspect":  return opInspect(args);
    case "chain":    return opChain(args);
    case "ciphers":  return opCiphers(args);
    case "verify":   return opVerify(args);
    case "scan":     return opScan(args);
    case "info":     return opInfo(args);
    default:
      throw new Error(
        `tls_client: unknown operation '${op}'. ` +
        `Valid: inspect, chain, ciphers, verify, scan, info.`
      );
  }
}

module.exports = {
  tlsClient,
  // Exported for testing
  parseCertObject,
  extractChain,
  assessSecurity,
  classifyCipherSecurity,
  matchHostname,
  computeFingerprints,
  WELL_KNOWN_TLS_PORTS,
  TLS_VERSIONS,
  PROBE_CIPHERS_TLS12,
  TLS13_CIPHERS,
};
