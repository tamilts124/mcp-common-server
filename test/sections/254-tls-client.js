"use strict";
/**
 * Section 254 — tls_client tests
 * Five rigor levels:
 *   A) Normal      — info op, happy-path parseCertObject / assessSecurity / matchHostname
 *   B) Medium      — validation: missing host, bad port, bad operation, empty strings
 *   C) High        — mock TLS network (mock tls.connect via monkey-patch)
 *   D) Critical    — NUL-byte injection, port boundary values, scan port limit
 *   E) Extreme     — concurrency (parallel opInfo calls), cipher classification coverage
 */

const assert = require("assert");
const {
  tlsClient,
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
} = require("../../lib/tlsClientOps");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.error(`  \u2717 ${name}: ${err.message}`);
    failed++;
  }
}

async function runAll() {
  // ── A: Normal / happy path ─────────────────────────────────────────────────
  console.log("\n[A] Normal — info op and pure helpers");

  await test("info op returns all required fields", async () => {
    const r = await tlsClient({ operation: "info" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.operation, "info");
    assert.ok(Array.isArray(r.supportedOperations));
    assert.ok(r.supportedOperations.includes("inspect"));
    assert.ok(r.supportedOperations.includes("chain"));
    assert.ok(r.supportedOperations.includes("ciphers"));
    assert.ok(r.supportedOperations.includes("verify"));
    assert.ok(r.supportedOperations.includes("scan"));
    assert.ok(r.supportedOperations.includes("info"));
    assert.ok(Array.isArray(r.tlsVersions));
    assert.ok(Array.isArray(r.wellKnownTlsPorts));
    assert.ok(Array.isArray(r.tls13Ciphers));
    assert.ok(Array.isArray(r.probedTls12Ciphers));
    assert.ok(typeof r.defaultPort === "number");
    assert.ok(typeof r.timeoutMs === "number");
  });

  await test("info op uses custom timeout (clamped to max)", async () => {
    const r = await tlsClient({ operation: "info", timeout: 999999 });
    assert.strictEqual(r.timeoutMs, 30000);
  });

  await test("info op clamps timeout to minimum", async () => {
    const r = await tlsClient({ operation: "info", timeout: 0 });
    assert.strictEqual(r.timeoutMs, 1000);
  });

  await test("parseCertObject returns null for falsy cert", () => {
    assert.strictEqual(parseCertObject(null, true), null);
    assert.strictEqual(parseCertObject(undefined, true), null);
    assert.strictEqual(parseCertObject({}, true), null);
  });

  await test("parseCertObject parses a minimal cert object", () => {
    const mockCert = {
      subject: { CN: "example.com", O: "Example Inc" },
      issuer:  { CN: "DigiCert CA", O: "DigiCert" },
      valid_from: "Jan 1 00:00:00 2024 GMT",
      valid_to:   "Jan 1 00:00:00 2030 GMT",
      serialNumber: "0ABCDEF",
      subjectaltname: "DNS:example.com, DNS:www.example.com, IP Address:93.184.216.34",
    };
    const parsed = parseCertObject(mockCert, true);
    assert.ok(parsed !== null);
    assert.deepStrictEqual(parsed.subject, { CN: "example.com", O: "Example Inc" });
    assert.deepStrictEqual(parsed.issuer,  { CN: "DigiCert CA",  O: "DigiCert"    });
    assert.strictEqual(parsed.isLeaf, true);
    assert.strictEqual(parsed.isSelfSigned, false);
    assert.ok(Array.isArray(parsed.subjectAltNames));
    assert.strictEqual(parsed.subjectAltNames.length, 3);
    assert.strictEqual(parsed.subjectAltNames[0].type, "DNS");
    assert.strictEqual(parsed.subjectAltNames[0].value, "example.com");
    assert.strictEqual(parsed.subjectAltNames[2].type, "IP Address");
    assert.strictEqual(parsed.subjectAltNames[2].value, "93.184.216.34");
    assert.strictEqual(parsed.serialNumber, "0ABCDEF");
    assert.ok(parsed.validity);
    assert.ok(typeof parsed.validity.isExpired === "boolean");
    assert.ok(typeof parsed.validity.daysRemaining === "number");
    assert.strictEqual(parsed.pem, null);
  });

  await test("parseCertObject detects self-signed cert", () => {
    const selfSigned = {
      subject: { CN: "localhost" },
      issuer:  { CN: "localhost" },
      valid_from: "Jan 1 00:00:00 2020 GMT",
      valid_to:   "Jan 1 00:00:00 2030 GMT",
    };
    const parsed = parseCertObject(selfSigned, true);
    assert.strictEqual(parsed.isSelfSigned, true);
  });

  await test("parseCertObject generates PEM from raw DER buffer", () => {
    const fakeDer = Buffer.alloc(64, 0x30);
    const mockCert = {
      subject: { CN: "test.local" },
      issuer:  { CN: "test-ca.local" },
      valid_from: "Jan 1 00:00:00 2024 GMT",
      valid_to:   "Jan 1 00:00:00 2026 GMT",
      raw: fakeDer,
    };
    const parsed = parseCertObject(mockCert, true);
    assert.ok(parsed.pem !== null);
    assert.ok(parsed.pem.startsWith("-----BEGIN CERTIFICATE-----"));
    assert.ok(parsed.pem.endsWith("-----END CERTIFICATE-----"));
    assert.ok(parsed.fingerprints !== null);
    assert.ok(parsed.fingerprints.sha1.includes(":"));
    assert.ok(parsed.fingerprints.sha256.includes(":"));
  });

  await test("computeFingerprints returns colon-delimited hex", () => {
    const buf = Buffer.from("Hello, World!");
    const fps = computeFingerprints(buf);
    assert.ok(/^[0-9A-F:]+$/.test(fps.sha1));
    assert.ok(/^[0-9A-F:]+$/.test(fps.sha256));
    assert.strictEqual(fps.sha1.split(":").length, 20);
    assert.strictEqual(fps.sha256.split(":").length, 32);
  });

  await test("assessSecurity grades A for clean TLS 1.3 + valid cert", () => {
    const chain = [{
      validity: { isExpired: false, daysRemaining: 365 },
      isSelfSigned: false,
      publicKey: { bits: 4096, algorithm: "RSA" },
      signatureAlgorithm: "sha256WithRSAEncryption",
    }];
    const r = assessSecurity("TLSv1.3", { name: "TLS_AES_256_GCM_SHA384" }, chain);
    assert.strictEqual(r.grade, "A");
    assert.strictEqual(r.issues.length, 0);
    assert.strictEqual(r.warnings.length, 0);
  });

  await test("assessSecurity flags deprecated TLS 1.0", () => {
    const r = assessSecurity("TLSv1", { name: "AES256-SHA" }, []);
    assert.ok(r.issues.some(i => i.includes("Deprecated")));
  });

  await test("assessSecurity flags TLS 1.1 as warning", () => {
    const r = assessSecurity("TLSv1.1", { name: "AES256-GCM-SHA384" }, []);
    assert.ok(r.warnings.some(w => w.includes("TLS 1.1")));
  });

  await test("assessSecurity flags RC4 cipher as issue", () => {
    const r = assessSecurity("TLSv1.2", { name: "RC4-SHA" }, []);
    assert.ok(r.issues.some(i => i.includes("RC4")));
  });

  await test("assessSecurity flags NULL cipher as issue", () => {
    const r = assessSecurity("TLSv1.2", { name: "NULL-SHA" }, []);
    assert.ok(r.issues.some(i => i.includes("NULL")));
  });

  await test("assessSecurity flags expired cert as issue", () => {
    const chain = [{
      validity: { isExpired: true, daysRemaining: -10 },
      isSelfSigned: false,
      publicKey: { bits: 2048 },
      signatureAlgorithm: "sha256WithRSAEncryption",
    }];
    const r = assessSecurity("TLSv1.2", { name: "ECDHE-RSA-AES256-GCM-SHA384" }, chain);
    assert.ok(r.issues.some(i => i.includes("expired")));
    assert.ok(r.grade === "C" || r.grade === "F");
  });

  await test("assessSecurity warns on cert expiring soon (< 30 days)", () => {
    const chain = [{
      validity: { isExpired: false, daysRemaining: 10 },
      isSelfSigned: false,
      publicKey: { bits: 2048 },
      signatureAlgorithm: "sha256WithRSAEncryption",
    }];
    const r = assessSecurity("TLSv1.3", { name: "TLS_AES_256_GCM_SHA384" }, chain);
    assert.ok(r.warnings.some(w => w.includes("expires in")));
  });

  await test("assessSecurity flags weak key (< 2048 bits)", () => {
    const chain = [{
      validity: { isExpired: false, daysRemaining: 365 },
      isSelfSigned: false,
      publicKey: { bits: 512 },
      signatureAlgorithm: "sha256WithRSAEncryption",
    }];
    const r = assessSecurity("TLSv1.3", { name: "TLS_AES_256_GCM_SHA384" }, chain);
    assert.ok(r.issues.some(i => i.includes("Weak key")));
  });

  await test("matchHostname exact match", () => {
    assert.strictEqual(matchHostname("example.com", "example.com"), true);
    assert.strictEqual(matchHostname("EXAMPLE.COM", "example.com"), true);
  });

  await test("matchHostname wildcard match", () => {
    assert.strictEqual(matchHostname("sub.example.com", "*.example.com"), true);
    assert.strictEqual(matchHostname("example.com", "*.example.com"), false);
    assert.strictEqual(matchHostname("deep.sub.example.com", "*.example.com"), false);
  });

  await test("matchHostname no match", () => {
    assert.strictEqual(matchHostname("other.com", "example.com"), false);
    assert.strictEqual(matchHostname("", "example.com"), false);
    assert.strictEqual(matchHostname("example.com", ""), false);
    assert.strictEqual(matchHostname("", ""), false);
  });

  await test("WELL_KNOWN_TLS_PORTS contains port 443", () => {
    assert.ok(WELL_KNOWN_TLS_PORTS.some(p => p.port === 443 && p.service === "HTTPS"));
  });

  await test("TLS_VERSIONS includes TLSv1.2 and TLSv1.3", () => {
    assert.ok(TLS_VERSIONS.includes("TLSv1.2"));
    assert.ok(TLS_VERSIONS.includes("TLSv1.3"));
  });

  await test("PROBE_CIPHERS_TLS12 is non-empty array of strings", () => {
    assert.ok(Array.isArray(PROBE_CIPHERS_TLS12));
    assert.ok(PROBE_CIPHERS_TLS12.length > 0);
    assert.ok(PROBE_CIPHERS_TLS12.every(c => typeof c === "string"));
  });

  await test("TLS13_CIPHERS includes AES-256-GCM suite", () => {
    assert.ok(TLS13_CIPHERS.includes("TLS_AES_256_GCM_SHA384"));
  });

  // ── B: Medium — input validation ───────────────────────────────────────────
  console.log("\n[B] Medium — input validation");

  await test("missing operation throws", async () => {
    await assert.rejects(() => tlsClient({}), /operation.*required/i);
  });

  await test("unknown operation throws", async () => {
    await assert.rejects(() => tlsClient({ operation: "hack" }), /unknown operation/i);
  });

  await test("inspect without host throws", async () => {
    await assert.rejects(() => tlsClient({ operation: "inspect" }), /host.*required/i);
  });

  await test("inspect with whitespace-only host throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "inspect", host: "   " }),
      /host.*required/i
    );
  });

  await test("chain without host throws", async () => {
    await assert.rejects(() => tlsClient({ operation: "chain" }), /host.*required/i);
  });

  await test("ciphers without host throws", async () => {
    await assert.rejects(() => tlsClient({ operation: "ciphers" }), /host.*required/i);
  });

  await test("verify without host throws", async () => {
    await assert.rejects(() => tlsClient({ operation: "verify" }), /host.*required/i);
  });

  await test("scan without host throws", async () => {
    await assert.rejects(() => tlsClient({ operation: "scan" }), /host.*required/i);
  });

  await test("invalid port (0) throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "inspect", host: "example.com", port: 0 }),
      /port.*1.*65535/i
    );
  });

  await test("invalid port (65536) throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "inspect", host: "example.com", port: 65536 }),
      /port.*1.*65535/i
    );
  });

  await test("invalid port (non-integer) throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "inspect", host: "example.com", port: 3.5 }),
      /port.*1.*65535/i
    );
  });

  await test("scan with > 50 ports throws", async () => {
    const ports = Array.from({ length: 51 }, (_, i) => i + 1);
    await assert.rejects(
      () => tlsClient({ operation: "scan", host: "example.com", ports }),
      /50 ports/i
    );
  });

  await test("scan with invalid port 0 in array throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "scan", host: "example.com", ports: [443, 0] }),
      /invalid port/i
    );
  });

  // ── C: High — mock TLS network ─────────────────────────────────────────────
  console.log("\n[C] High — mock TLS network via monkey-patching");

  const tls = require("tls");
  const EventEmitter = require("events");
  let originalConnect;

  function mockTlsConnect(behavior) {
    originalConnect = tls.connect;
    tls.connect = function(opts, cb) {
      const sock = new EventEmitter();
      sock.destroy = () => {};
      sock.localAddress  = "127.0.0.1";
      sock.localPort     = 54321;
      sock.remoteAddress = "93.184.216.34";
      sock.remoteFamily  = "IPv4";
      if (behavior === "success") {
        sock.getPeerCertificate = () => ({
          subject: { CN: "example.com", O: "Example" },
          issuer:  { CN: "DigiCert", O: "DigiCert Inc" },
          valid_from: "Jan 1 00:00:00 2024 GMT",
          valid_to:   "Jan 1 00:00:00 2030 GMT",
          subjectaltname: "DNS:example.com, DNS:www.example.com",
          fingerprint256: "AA:BB:CC",
        });
        sock.getCipher   = () => ({ name: "TLS_AES_256_GCM_SHA384", version: "TLSv1.3" });
        sock.getProtocol = () => "TLSv1.3";
        sock.alpnProtocol = "h2";
        sock.authorized  = true;
        sock.authorizationError = null;
        sock.isSessionReused = () => false;
        process.nextTick(() => cb && cb());
      } else {
        const codes = {
          enotfound:   { code: "ENOTFOUND",                   msg: "getaddrinfo ENOTFOUND" },
          econnrefused:{ code: "ECONNREFUSED",                 msg: "connect ECONNREFUSED" },
          cert_expired:{ code: "CERT_HAS_EXPIRED",             msg: "certificate has expired" },
          self_signed: { code: "DEPTH_ZERO_SELF_SIGNED_CERT",  msg: "self signed certificate" },
        };
        const info = codes[behavior] || { code: "UNKNOWN", msg: "unknown error" };
        process.nextTick(() => {
          const err = new Error(info.msg);
          err.code = info.code;
          sock.emit("error", err);
        });
      }
      return sock;
    };
  }

  function restoreTls() {
    if (originalConnect) { tls.connect = originalConnect; originalConnect = null; }
  }

  await test("inspect succeeds with mock success", async () => {
    mockTlsConnect("success");
    try {
      const r = await tlsClient({ operation: "inspect", host: "example.com", port: 443 });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "inspect");
      assert.strictEqual(r.host, "example.com");
      assert.strictEqual(r.port, 443);
      assert.strictEqual(r.protocol, "TLSv1.3");
      assert.ok(r.certificateChain.length > 0);
      assert.ok(r.leafCertificate !== null);
      assert.ok(r.security && typeof r.security.grade === "string");
      assert.ok(typeof r.elapsedMs === "number");
    } finally { restoreTls(); }
  });

  await test("chain op succeeds with mock", async () => {
    mockTlsConnect("success");
    try {
      const r = await tlsClient({ operation: "chain", host: "example.com", port: 443 });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "chain");
      assert.ok(Array.isArray(r.chain));
      assert.ok(Array.isArray(r.pems));
    } finally { restoreTls(); }
  });

  await test("ENOTFOUND gives human-readable error", async () => {
    mockTlsConnect("enotfound");
    try {
      await assert.rejects(
        () => tlsClient({ operation: "inspect", host: "fake.invalid" }),
        /host not found/i
      );
    } finally { restoreTls(); }
  });

  await test("ECONNREFUSED gives human-readable error", async () => {
    mockTlsConnect("econnrefused");
    try {
      await assert.rejects(
        () => tlsClient({ operation: "inspect", host: "localhost", port: 9999 }),
        /connection refused/i
      );
    } finally { restoreTls(); }
  });

  await test("expired cert error gives helpful message", async () => {
    mockTlsConnect("cert_expired");
    try {
      await assert.rejects(
        () => tlsClient({ operation: "inspect", host: "expired.example.com" }),
        /certificate expired|verify_certificate/i
      );
    } finally { restoreTls(); }
  });

  await test("self-signed cert error gives helpful message", async () => {
    mockTlsConnect("self_signed");
    try {
      await assert.rejects(
        () => tlsClient({ operation: "inspect", host: "self-signed.local" }),
        /certificate verification failed|verify_certificate/i
      );
    } finally { restoreTls(); }
  });

  await test("scan returns results for each well-known port", async () => {
    mockTlsConnect("econnrefused");
    try {
      const r = await tlsClient({ operation: "scan", host: "example.com" });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.portsScanned, WELL_KNOWN_TLS_PORTS.length);
      assert.strictEqual(r.results.length, WELL_KNOWN_TLS_PORTS.length);
      assert.ok(r.results.every(res => res.tlsFound === false));
    } finally { restoreTls(); }
  });

  await test("scan finds TLS ports with success mock", async () => {
    mockTlsConnect("success");
    try {
      const r = await tlsClient({ operation: "scan", host: "example.com", ports: [443, 8443] });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.portsScanned, 2);
      assert.strictEqual(r.tlsPortsFound, 2);
      assert.ok(r.openTlsPorts.includes(443));
      assert.ok(r.openTlsPorts.includes(8443));
    } finally { restoreTls(); }
  });

  await test("verify op with mock returns structured result", async () => {
    mockTlsConnect("success");
    try {
      const r = await tlsClient({ operation: "verify", host: "example.com" });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "verify");
      assert.ok(typeof r.authorized === "boolean");
      assert.ok(typeof r.hostnameValid === "boolean");
      assert.ok(typeof r.summary === "string");
    } finally { restoreTls(); }
  });

  await test("ciphers op with mock success returns cipher lists", async () => {
    mockTlsConnect("success");
    try {
      const r = await tlsClient({ operation: "ciphers", host: "example.com" });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "ciphers");
      assert.ok(typeof r.negotiatedProtocol === "string");
      assert.ok(Array.isArray(r.tls13Ciphers));
      assert.ok(Array.isArray(r.supportedTls12Ciphers));
      assert.ok(Array.isArray(r.rejectedCiphers));
      assert.ok(Array.isArray(r.weakCiphers));
    } finally { restoreTls(); }
  });

  // ── D: Critical — injection / boundaries ───────────────────────────────────
  console.log("\n[D] Critical — injection and boundary checks");

  await test("NUL-byte in host throws on inspect", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "inspect", host: "exam\0ple.com" }),
      /NUL/i
    );
  });

  await test("NUL-byte in servername throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "inspect", host: "example.com", servername: "bad\0sni" }),
      /NUL/i
    );
  });

  await test("NUL-byte in ca_pem throws on verify", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "verify", host: "example.com", ca_pem: "-----BEGIN\0CERT-----" }),
      /NUL/i
    );
  });

  await test("port 1 is valid — produces connection error not validation error", async () => {
    mockTlsConnect("econnrefused");
    try {
      await assert.rejects(
        () => tlsClient({ operation: "inspect", host: "example.com", port: 1 }),
        /connection refused/i
      );
    } finally { restoreTls(); }
  });

  await test("port 65535 is valid — produces connection error not validation error", async () => {
    mockTlsConnect("econnrefused");
    try {
      await assert.rejects(
        () => tlsClient({ operation: "inspect", host: "example.com", port: 65535 }),
        /connection refused/i
      );
    } finally { restoreTls(); }
  });

  await test("port -1 is invalid", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "inspect", host: "example.com", port: -1 }),
      /port.*1.*65535/i
    );
  });

  await test("NUL in host on scan throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "scan", host: "ex\0ample.com" }),
      /NUL/i
    );
  });

  await test("NUL in host on chain throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "chain", host: "ex\0ample.com" }),
      /NUL/i
    );
  });

  await test("NUL in host on ciphers throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "ciphers", host: "ex\0ample.com" }),
      /NUL/i
    );
  });

  await test("NUL in host on verify throws", async () => {
    await assert.rejects(
      () => tlsClient({ operation: "verify", host: "ex\0ample.com" }),
      /NUL/i
    );
  });

  // ── E: Extreme — concurrency + exhaustive cipher classification ────────────
  console.log("\n[E] Extreme — concurrency and cipher classification");

  await test("10 concurrent info ops all succeed", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => tlsClient({ operation: "info" }))
    );
    assert.strictEqual(results.length, 10);
    assert.ok(results.every(r => r.ok === true && r.operation === "info"));
  });

  await test("classifyCipherSecurity: broken", () => {
    assert.strictEqual(classifyCipherSecurity("NULL-SHA"),           "broken");
    assert.strictEqual(classifyCipherSecurity("EXPORT-RC4-MD5"),     "broken");
    assert.strictEqual(classifyCipherSecurity("RC4-SHA"),            "broken");
    assert.strictEqual(classifyCipherSecurity("ADH-AES256-GCM-SHA384"), "broken");
    assert.strictEqual(classifyCipherSecurity("DES-CBC-SHA"),        "broken");
  });

  await test("classifyCipherSecurity: weak", () => {
    assert.strictEqual(classifyCipherSecurity("DES-CBC3-SHA"),       "weak");
    assert.strictEqual(classifyCipherSecurity("AES256-MD5"),         "weak");
  });

  await test("classifyCipherSecurity: strong", () => {
    assert.strictEqual(classifyCipherSecurity("ECDHE-RSA-AES256-GCM-SHA384"), "strong");
    assert.strictEqual(classifyCipherSecurity("TLS_CHACHA20_POLY1305_SHA256"), "strong");
    assert.strictEqual(classifyCipherSecurity("AES256-GCM-SHA384"),  "strong");
  });

  await test("classifyCipherSecurity: handles null/undefined/empty", () => {
    assert.strictEqual(classifyCipherSecurity(null),      "unknown");
    assert.strictEqual(classifyCipherSecurity(""),        "unknown");
    assert.strictEqual(classifyCipherSecurity(undefined), "unknown");
  });

  await test("extractChain handles circular cert chain (loop detection)", () => {
    const selfRef = {
      subject: { CN: "self-signed.com" },
      issuer:  { CN: "self-signed.com" },
      valid_from: "Jan 1 00:00:00 2024 GMT",
      valid_to:   "Jan 1 00:00:00 2030 GMT",
      fingerprint256: "SELF:SIGNED:FP",
    };
    selfRef.issuerCertificate = selfRef;
    const chain = extractChain(selfRef);
    assert.strictEqual(chain.length, 1);
  });

  await test("assessSecurity returns grade, issues, warnings for null inputs", () => {
    const r = assessSecurity(null, null, []);
    assert.ok(typeof r.grade === "string");
    assert.ok(Array.isArray(r.issues));
    assert.ok(Array.isArray(r.warnings));
  });

  await test("all PROBE_CIPHERS_TLS12 have a known classifyCipherSecurity result", () => {
    const valid = ["strong", "moderate", "weak", "broken", "unknown"];
    for (const cipher of PROBE_CIPHERS_TLS12) {
      const result = classifyCipherSecurity(cipher);
      assert.ok(valid.includes(result), `Bad result for ${cipher}: ${result}`);
    }
  });

  await test("parseCertObject handles missing subjectaltname gracefully", () => {
    const cert = {
      subject: { CN: "no-san.example.com" },
      issuer:  { CN: "CA" },
      valid_from: "Jan 1 00:00:00 2024 GMT",
      valid_to:   "Jan 1 00:00:00 2030 GMT",
    };
    const parsed = parseCertObject(cert, false);
    assert.ok(parsed !== null);
    assert.deepStrictEqual(parsed.subjectAltNames, []);
    assert.strictEqual(parsed.isLeaf, false);
  });

  await test("20 concurrent mock inspects complete without error", async () => {
    mockTlsConnect("success");
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          tlsClient({ operation: "inspect", host: "example.com", port: 443 })
        )
      );
      assert.strictEqual(results.length, 20);
      assert.ok(results.every(r => r.ok === true));
    } finally { restoreTls(); }
  });

  await test("scan custom ports 1-50 all succeed structurally", async () => {
    mockTlsConnect("econnrefused");
    try {
      const ports = Array.from({ length: 50 }, (_, i) => i + 1);
      const r = await tlsClient({ operation: "scan", host: "example.com", ports });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.portsScanned, 50);
      assert.strictEqual(r.results.length, 50);
    } finally { restoreTls(); }
  });

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(42)}`);
  console.log(`Section 254 — tls_client`);
  console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED.`);
    process.exit(1);
  } else {
    console.log(`All ${passed} tests passed.`);
  }
}

runAll().catch(err => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
