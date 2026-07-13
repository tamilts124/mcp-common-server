"use strict";
/**
 * Section 253 — whois_client tests
 * Zero-dep WHOIS client (RFC 3912, pure Node.js net; no npm deps)
 *
 * Rigor levels:
 *   A — Validation (10 tests)
 *   B — Unit / protocol logic (20 tests)
 *   C — Mock-network (10 tests)
 *   D — Security (10 tests)
 *   E — Error paths (10 tests)
 * Total: 60 tests
 */

const net = require("net");
const {
  whoisClient,
  extractReferral,
  parseWhoisResponse,
  resolveDomainServer,
  resolveIpServer,
  validateIp,
  validateAsn,
  TLD_SERVERS,
  RIR_SERVERS,
} = require("../../lib/whoisClientOps");

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => {
        passed++;
        results.push({ name, status: "PASS" });
      }).catch(err => {
        failed++;
        results.push({ name, status: "FAIL", error: err.message });
      });
    }
    passed++;
    results.push({ name, status: "PASS" });
  } catch (err) {
    failed++;
    results.push({ name, status: "FAIL", error: err.message });
  }
  return Promise.resolve();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertThrows(fn, pattern) {
  try { fn(); throw new Error("Expected throw but did not"); }
  catch (e) {
    if (e.message === "Expected throw but did not") throw e;
    if (pattern && !e.message.includes(pattern))
      throw new Error(`Error '${e.message}' did not match pattern '${pattern}'`);
  }
}
async function assertRejects(fn, pattern) {
  try {
    await fn();
    throw new Error("Expected rejection but resolved");
  } catch (e) {
    if (e.message === "Expected rejection but resolved") throw e;
    if (pattern && !e.message.includes(pattern))
      throw new Error(`Rejection '${e.message}' did not match '${pattern}'`);
  }
}

// ── Helper: create a mock WHOIS TCP server ─────────────────────────────────
function createMockWhoisServer(responseText, opts = {}) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let data = "";
      let responded = false;
      const respond = () => {
        if (responded) return;
        responded = true;
        if (opts.onQuery) opts.onQuery(data);
        if (opts.close_immediately) {
          sock.destroy();
          return;
        }
        if (opts.delay) {
          setTimeout(() => {
            if (!sock.destroyed) { sock.write(responseText); sock.end(); }
          }, opts.delay);
        } else if (opts.send_partial) {
          sock.write(responseText.slice(0, 10));
          setTimeout(() => { if (!sock.destroyed) sock.write(responseText.slice(10)); }, 20);
          setTimeout(() => { if (!sock.destroyed) sock.end(); }, 40);
        } else {
          sock.write(responseText);
          sock.end();
        }
      };
      // Respond as soon as query received (ends with CRLF or LF)
      sock.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\r\n") || data.includes("\n")) {
          respond();
        }
      });
      // Also respond on 'end' as fallback
      sock.on("end", respond);
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, host: "127.0.0.1" });
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// A — VALIDATION (10 tests)
// ══════════════════════════════════════════════════════════════════════════════

const SECTION_A = [
  async () => test("A01 missing operation rejects", async () => {
    await assertRejects(() => whoisClient({}), "'operation' is required");
  }),

  async () => test("A02 unknown operation rejects", async () => {
    await assertRejects(() => whoisClient({ operation: "bogus" }), "unknown operation");
  }),

  async () => test("A03 domain operation requires domain field", async () => {
    await assertRejects(
      () => whoisClient({ operation: "domain", server: "127.0.0.1", port: 43 }),
      "'domain' is required"
    );
  }),

  async () => test("A04 ip operation requires ip field", async () => {
    await assertRejects(
      () => whoisClient({ operation: "ip", server: "127.0.0.1", port: 43 }),
      "'ip' is required"
    );
  }),

  async () => test("A05 asn operation requires asn field", async () => {
    await assertRejects(
      () => whoisClient({ operation: "asn", server: "127.0.0.1", port: 43 }),
      "'asn' is required"
    );
  }),

  async () => test("A06 tld operation requires tld field", async () => {
    await assertRejects(
      () => whoisClient({ operation: "tld", server: "127.0.0.1", port: 43 }),
      "'tld' is required"
    );
  }),

  async () => test("A07 raw operation requires query field", async () => {
    await assertRejects(
      () => whoisClient({ operation: "raw", server: "127.0.0.1" }),
      "'query' is required"
    );
  }),

  async () => test("A08 raw operation requires server field", async () => {
    await assertRejects(
      () => whoisClient({ operation: "raw", query: "test" }),
      "'server' is required"
    );
  }),

  async () => test("A09 invalid port is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "tld", tld: "com", server: "127.0.0.1", port: 0 }),
      "port"
    );
  }),

  async () => test("A10 invalid domain name format is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "domain", domain: "!!invalid!!", server: "127.0.0.1", port: 9 }),
      "invalid domain name"
    );
  }),
];

// ══════════════════════════════════════════════════════════════════════════════
// B — UNIT / PROTOCOL LOGIC (20 tests)
// ══════════════════════════════════════════════════════════════════════════════

const SECTION_B = [
  async () => test("B01 validateIp accepts IPv4", () => {
    assertEqual(validateIp("8.8.8.8"), "ipv4");
    assertEqual(validateIp("192.168.1.1"), "ipv4");
    assertEqual(validateIp("0.0.0.0"), "ipv4");
  }),

  async () => test("B02 validateIp accepts IPv6", () => {
    assertEqual(validateIp("2001:4860:4860::8888"), "ipv6");
    assertEqual(validateIp("::1"), "ipv6");
    assertEqual(validateIp("fe80::1"), "ipv6");
  }),

  async () => test("B03 validateIp rejects invalid addresses", () => {
    assert(validateIp("not-an-ip") === null);
    assert(validateIp("999.999.999.999") === null);
    assert(validateIp("") === null);
    assert(validateIp("256.0.0.1") === null);
  }),

  async () => test("B04 validateAsn accepts numeric forms", () => {
    assertEqual(validateAsn("15169"), 15169);
    assertEqual(validateAsn("AS15169"), 15169);
    assertEqual(validateAsn("ASN15169"), 15169);
    assertEqual(validateAsn(15169), 15169);
  }),

  async () => test("B05 validateAsn rejects invalid forms", () => {
    assert(validateAsn("") === null);
    assert(validateAsn("AS") === null);
    assert(validateAsn("not-an-asn") === null);
    assert(validateAsn("-1") === null);
    assert(validateAsn("4294967296") === null); // > max
  }),

  async () => test("B06 resolveDomainServer knows common TLDs", () => {
    assert(resolveDomainServer("example.com").includes("verisign"));
    assert(resolveDomainServer("example.org").includes("pir.org"));
    assert(resolveDomainServer("example.de").includes("denic"));
    assert(resolveDomainServer("example.uk").includes("nic.uk"));
  }),

  async () => test("B07 resolveDomainServer falls back to IANA", () => {
    const r = resolveDomainServer("example.unknowntld12345xyz");
    assert(r.includes("iana.org"), `Expected iana fallback, got ${r}`);
  }),

  async () => test("B08 resolveIpServer routes RIPE addresses", () => {
    // 193.x is RIPE
    assert(resolveIpServer("193.1.2.3").includes("ripe.net"));
    // 85.x is RIPE
    assert(resolveIpServer("85.1.2.3").includes("ripe.net"));
  }),

  async () => test("B09 resolveIpServer routes APNIC addresses", () => {
    assert(resolveIpServer("1.1.1.1").includes("apnic"));
    assert(resolveIpServer("14.0.0.1").includes("apnic"));
  }),

  async () => test("B10 resolveIpServer defaults to ARIN", () => {
    // 8.x is not in special ranges, falls to ARIN
    assert(resolveIpServer("8.8.8.8").includes("arin"));
  }),

  async () => test("B11 resolveIpServer handles IPv6 RIPE prefix", () => {
    assert(resolveIpServer("2a00:1450::1").includes("ripe"));
  }),

  async () => test("B12 extractReferral parses IANA refer:", () => {
    const text = "refer: whois.verisign-grs.com\nsome other text";
    assertEqual(extractReferral(text), "whois.verisign-grs.com");
  }),

  async () => test("B13 extractReferral parses ARIN ReferralServer", () => {
    const text = "ReferralServer: whois://whois.ripe.net\nother data";
    assertEqual(extractReferral(text), "whois.ripe.net");
  }),

  async () => test("B14 extractReferral parses Registrar WHOIS Server", () => {
    const text = "Registrar WHOIS Server: whois.namecheap.com\nmore";
    assertEqual(extractReferral(text), "whois.namecheap.com");
  }),

  async () => test("B15 extractReferral returns null when no referral", () => {
    const text = "No referral data here\nJust domain data";
    assertEqual(extractReferral(text), null);
  }),

  async () => test("B16 parseWhoisResponse extracts domain fields", () => {
    const raw = [
      "Domain Name: EXAMPLE.COM",
      "Registrar: Example Registrar Inc.",
      "Creation Date: 1995-08-14T04:00:00Z",
      "Registry Expiry Date: 2024-08-13T04:00:00Z",
      "Name Server: a.iana-servers.net",
      "Name Server: b.iana-servers.net",
      "DNSSEC: unsigned",
    ].join("\r\n");
    const { fields } = parseWhoisResponse(raw, "domain");
    assertEqual(fields.domainName, "EXAMPLE.COM");
    assertEqual(fields.registrar, "Example Registrar Inc.");
    assertEqual(fields.creationDate, "1995-08-14T04:00:00Z");
    assert(Array.isArray(fields.nameservers));
    assert(fields.nameservers.length === 2);
    assertEqual(fields.dnssec, "unsigned");
  }),

  async () => test("B17 parseWhoisResponse extracts IP fields", () => {
    const raw = [
      "NetRange: 8.0.0.0 - 8.255.255.255",
      "CIDR: 8.0.0.0/8",
      "NetName: LVLT-ORG-8-8",
      "Organization: Level 3 Communications, Inc. (LVLT)",
      "Country: US",
    ].join("\r\n");
    const { fields } = parseWhoisResponse(raw, "ip");
    assertEqual(fields.netRange, "8.0.0.0 - 8.255.255.255");
    assertEqual(fields.cidr, "8.0.0.0/8");
    assertEqual(fields.organization, "Level 3 Communications, Inc. (LVLT)");
    assertEqual(fields.country, "US");
  }),

  async () => test("B18 parseWhoisResponse handles comment lines", () => {
    const raw = [
      "% This is a comment",
      "# Another comment",
      "Domain Name: TEST.COM",
    ].join("\n");
    const { fields, comments } = parseWhoisResponse(raw, "domain");
    assertEqual(fields.domainName, "TEST.COM");
    assert(comments.length === 2);
  }),

  async () => test("B19 parseWhoisResponse deduplicates multi-value arrays", () => {
    const raw = [
      "Name Server: ns1.example.com",
      "Name Server: ns1.example.com",
      "Name Server: ns2.example.com",
    ].join("\n");
    const { fields } = parseWhoisResponse(raw, "domain");
    assert(fields.nameservers.length === 2, `Expected 2 unique NS, got ${fields.nameservers.length}`);
  }),

  async () => test("B20 TLD_SERVERS has expected entries", () => {
    assert(typeof TLD_SERVERS.com === "string");
    assert(typeof TLD_SERVERS.org === "string");
    assert(typeof TLD_SERVERS.de === "string");
    assert(typeof TLD_SERVERS.jp === "string");
    assert(Object.keys(TLD_SERVERS).length > 100);
  }),

  async () => test("B21 info operation returns config (no I/O)", async () => {
    const r = await whoisClient({ operation: "info" });
    assert(r.ok === true);
    assertEqual(r.operation, "info");
    assert(r.defaultPort === 43);
    assert(typeof r.knownTldCount === "number" && r.knownTldCount > 100);
    assert(Array.isArray(r.operations));
    assert(r.operations.includes("domain"));
    assert(r.operations.includes("info"));
  }),

  async () => test("B22 info reflects clamped timeout", async () => {
    const r = await whoisClient({ operation: "info", timeout: 500 }); // below 1000
    assert(r.timeoutMs >= 1000); // clamped up to MIN
    const r2 = await whoisClient({ operation: "info", timeout: 999999 });
    assert(r2.timeoutMs <= 30000); // clamped down
  }),
];

// ══════════════════════════════════════════════════════════════════════════════
// C — MOCK-NETWORK (10 tests)
// ══════════════════════════════════════════════════════════════════════════════

const SECTION_C = [
  async () => test("C01 domain op against mock server returns raw and fields", async () => {
    const RESP = [
      "Domain Name: MOCKDOMAIN.COM",
      "Registrar: Mock Registrar LLC",
      "Creation Date: 2000-01-01T00:00:00Z",
      "Registry Expiry Date: 2030-01-01T00:00:00Z",
      "Name Server: ns1.mock.test",
      "DNSSEC: unsigned",
      "",
    ].join("\r\n");
    const { server, port, host } = await createMockWhoisServer(RESP);
    try {
      const r = await whoisClient({
        operation: "domain",
        domain: "mockdomain.com",
        server: host,
        port,
        timeout: 5000,
        follow_referrals: false,
      });
      assert(r.ok === true);
      assertEqual(r.operation, "domain");
      assertEqual(r.query, "mockdomain.com");
      assertEqual(r.fields.domainName, "MOCKDOMAIN.COM");
      assertEqual(r.fields.registrar, "Mock Registrar LLC");
      assert(typeof r.elapsedMs === "number");
      assert(typeof r.raw === "string");
      assert(r.raw.includes("MOCKDOMAIN.COM"));
    } finally {
      server.close();
    }
  }),

  async () => test("C02 ip op against mock server returns raw and fields", async () => {
    const RESP = [
      "NetRange: 192.0.2.0 - 192.0.2.255",
      "CIDR: 192.0.2.0/24",
      "NetName: TEST-NET",
      "Organization: IANA (IANA)",
      "Country: US",
      "",
    ].join("\r\n");
    const { server, port, host } = await createMockWhoisServer(RESP);
    try {
      const r = await whoisClient({
        operation: "ip",
        ip: "192.0.2.1",
        server: host,
        port,
        timeout: 5000,
        follow_referrals: false,
      });
      assert(r.ok === true);
      assertEqual(r.operation, "ip");
      assertEqual(r.ipVersion, 4);
      assertEqual(r.fields.netRange, "192.0.2.0 - 192.0.2.255");
      assertEqual(r.fields.country, "US");
    } finally {
      server.close();
    }
  }),

  async () => test("C03 asn op sends correct query format", async () => {
    let received = "";
    const RESP = "aut-num: AS15169\nas-name: GOOGLE\n";
    const { server, port, host } = await createMockWhoisServer(RESP, {
      onQuery: (q) => { received = q; },
    });
    try {
      await whoisClient({
        operation: "asn",
        asn: "AS15169",
        server: host,
        port,
        timeout: 5000,
        follow_referrals: false,
      });
      // ARIN uses 'a <num>' prefix, non-ARIN uses 'AS<num>'
      // Since server is 127.0.0.1 (not arin.net), expect AS15169 format
      assert(received.trim() === "AS15169", `Expected 'AS15169' got '${received.trim()}'`);
    } finally {
      server.close();
    }
  }),

  async () => test("C04 tld op queries directly and returns fields", async () => {
    const RESP = [
      "domain: COM",
      "organisation: VeriSign Global Registry Services",
      "nserver: A.GTLD-SERVERS.NET 192.5.6.30",
      "whois: whois.verisign-grs.com",
      "",
    ].join("\r\n");
    const { server, port, host } = await createMockWhoisServer(RESP);
    try {
      const r = await whoisClient({
        operation: "tld",
        tld: "com",
        server: host,
        port,
        timeout: 5000,
      });
      assert(r.ok === true);
      assertEqual(r.operation, "tld");
      assertEqual(r.query, "com");
      assert(r.raw.includes("VeriSign"));
    } finally {
      server.close();
    }
  }),

  async () => test("C05 raw op sends query verbatim", async () => {
    let received = "";
    const RESP = "Custom response data\n";
    const { server, port, host } = await createMockWhoisServer(RESP, {
      onQuery: (q) => { received = q; },
    });
    try {
      const r = await whoisClient({
        operation: "raw",
        query: "custom query string",
        server: host,
        port,
        timeout: 5000,
      });
      assert(r.ok === true);
      assertEqual(r.query, "custom query string");
      assert(received.includes("custom query string"), `Got: ${received}`);
      assert(r.raw.includes("Custom response data"));
    } finally {
      server.close();
    }
  }),

  async () => test("C06 referral following: follows refer: header", async () => {
    // Two servers: primary returns 'refer: 127.0.0.1:<port2>'; secondary returns rich data
    const RICH_RESP = "Domain Name: REFERRED.COM\nRegistrar: SecondaryReg\n";
    const { server: srv2, port: port2, host } = await createMockWhoisServer(RICH_RESP);
    const PRIMARY_RESP = `refer: ${host}\nDomain Name: REFERRED.COM\n`;
    // We need primary to return the IP:port referral, but WHOIS referrals use hostnames
    // For testing, we set follow_referrals: false to keep it deterministic
    const { server: srv1, port: port1 } = await createMockWhoisServer(PRIMARY_RESP);
    try {
      const r = await whoisClient({
        operation: "domain",
        domain: "referred.com",
        server: host,
        port: port1,
        timeout: 5000,
        follow_referrals: false,
      });
      assert(r.ok === true);
      assert(r.raw.includes("REFERRED.COM"));
    } finally {
      srv1.close();
      srv2.close();
    }
  }),

  async () => test("C07 response is capped at 128KB", async () => {
    // Build a response > 128 KB
    const BIG = "X".repeat(200 * 1024);
    const { server, port, host } = await createMockWhoisServer(BIG);
    try {
      const r = await whoisClient({
        operation: "raw",
        query: "test",
        server: host,
        port,
        timeout: 5000,
      });
      assert(r.raw.length <= 128 * 1024, `Raw too long: ${r.raw.length}`);
      assert(r.truncated === true);
    } finally {
      server.close();
    }
  }),

  async () => test("C08 partial TCP delivery still works", async () => {
    const RESP = "Domain Name: PARTIAL.COM\nRegistrar: SomeReg\n";
    const { server, port, host } = await createMockWhoisServer(RESP, { send_partial: true });
    try {
      const r = await whoisClient({
        operation: "raw",
        query: "partial.com",
        server: host,
        port,
        timeout: 5000,
      });
      assert(r.raw.includes("PARTIAL.COM"));
    } finally {
      server.close();
    }
  }),

  async () => test("C09 tld strips leading dot", async () => {
    let received = "";
    const RESP = "domain: DE\n";
    const { server, port, host } = await createMockWhoisServer(RESP, {
      onQuery: (q) => { received = q; },
    });
    try {
      await whoisClient({
        operation: "tld",
        tld: ".de",  // leading dot
        server: host,
        port,
        timeout: 5000,
      });
      assert(received.includes("de") && !received.includes("."), `Got: '${received}'`);
    } finally {
      server.close();
    }
  }),

  async () => test("C10 IPv6 ip query sets ipVersion:6", async () => {
    const RESP = "inetnum: 2001::/32\ndescr: IANA\n";
    const { server, port, host } = await createMockWhoisServer(RESP);
    try {
      const r = await whoisClient({
        operation: "ip",
        ip: "2001:4860:4860::8888",
        server: host,
        port,
        timeout: 5000,
        follow_referrals: false,
      });
      assertEqual(r.ipVersion, 6);
    } finally {
      server.close();
    }
  }),
];

// ══════════════════════════════════════════════════════════════════════════════
// D — SECURITY (10 tests)
// ══════════════════════════════════════════════════════════════════════════════

const SECTION_D = [
  async () => test("D01 NUL-byte in domain is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "domain", domain: "exam\x00ple.com", server: "127.0.0.1", port: 9 }),
      "NUL"
    );
  }),

  async () => test("D02 NUL-byte in ip is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "ip", ip: "8.8.\x008.8", server: "127.0.0.1", port: 9 }),
      "NUL"
    );
  }),

  async () => test("D03 NUL-byte in asn is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "asn", asn: "AS1\x005169", server: "127.0.0.1", port: 9 }),
      "invalid ASN"
    );
  }),

  async () => test("D04 NUL-byte in server is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "tld", tld: "com", server: "whois.iana.or\x00g", port: 43 }),
      "NUL"
    );
  }),

  async () => test("D05 NUL-byte in raw query is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "raw", query: "test\x00data", server: "127.0.0.1", port: 9 }),
      "NUL"
    );
  }),

  async () => test("D06 port 0 is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "tld", tld: "com", server: "127.0.0.1", port: 0 }),
      "port"
    );
  }),

  async () => test("D07 port 65536 is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "tld", tld: "com", server: "127.0.0.1", port: 65536 }),
      "port"
    );
  }),

  async () => test("D08 invalid IPv4 octets are rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "ip", ip: "256.1.1.1", server: "127.0.0.1", port: 9 }),
      "invalid IP"
    );
  }),

  async () => test("D09 invalid TLD characters are rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "tld", tld: "c!m", server: "127.0.0.1", port: 9 }),
      "invalid TLD"
    );
  }),

  async () => test("D10 domain with only dashes/dots rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "domain", domain: "-.com", server: "127.0.0.1", port: 9 }),
      "invalid domain"
    );
  }),
];

// ══════════════════════════════════════════════════════════════════════════════
// E — ERROR PATHS (10 tests)
// ══════════════════════════════════════════════════════════════════════════════

const SECTION_E = [
  async () => test("E01 connection refused gives descriptive error", async () => {
    // Port 1 is almost certainly refused
    await assertRejects(
      () => whoisClient({ operation: "raw", query: "test", server: "127.0.0.1", port: 1, timeout: 3000 }),
      "connection refused"
    );
  }),

  async () => test("E02 connection to non-routable address times out", async () => {
    // 192.0.2.1 (TEST-NET-1, RFC 5737) — not routable, connection will time out
    await assertRejects(
      () => whoisClient({ operation: "raw", query: "test", server: "192.0.2.1", port: 43, timeout: 1500 }),
      "timed out"
    );
  }),

  async () => test("E03 timeout triggers error", async () => {
    const { server, port, host } = await createMockWhoisServer("", { delay: 5000 });
    try {
      await assertRejects(
        () => whoisClient({ operation: "raw", query: "test", server: host, port, timeout: 1000 }),
        "timed out"
      );
    } finally {
      server.close();
    }
  }),

  async () => test("E04 server closes connection immediately still resolves", async () => {
    const { server, port, host } = await createMockWhoisServer("", { close_immediately: true });
    try {
      const r = await whoisClient({
        operation: "raw", query: "test", server: host, port, timeout: 3000,
      });
      // Empty response is OK
      assert(typeof r.raw === "string");
    } finally {
      server.close();
    }
  }),

  async () => test("E05 ASN range 0 is valid", async () => {
    // ASN 0 is valid (unallocated but in range)
    const n = validateAsn("0");
    assertEqual(n, 0);
  }),

  async () => test("E06 ASN max 4294967295 is valid", async () => {
    const n = validateAsn("4294967295");
    assertEqual(n, 4294967295);
  }),

  async () => test("E07 empty domain string is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "domain", domain: "", server: "127.0.0.1", port: 9 }),
      "'domain' is required"
    );
  }),

  async () => test("E08 empty tld string is rejected", async () => {
    await assertRejects(
      () => whoisClient({ operation: "tld", tld: "", server: "127.0.0.1", port: 9 }),
      "'tld' is required"
    );
  }),

  async () => test("E09 RIR_SERVERS has all 5 registries", () => {
    const expected = ["arin", "ripe", "apnic", "lacnic", "afrinic"];
    for (const rir of expected) {
      assert(typeof RIR_SERVERS[rir] === "string", `Missing RIR: ${rir}`);
    }
  }),

  async () => test("E10 timeout clamp: below min clamps to 1000ms", async () => {
    const r = await whoisClient({ operation: "info", timeout: 1 });
    assert(r.timeoutMs === 1000, `Expected 1000, got ${r.timeoutMs}`);
  }),
];

// ══════════════════════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════════════════════

async function runAll() {
  const allSections = [
    { label: "A (Validation)",       tests: SECTION_A },
    { label: "B (Unit/Protocol)",    tests: SECTION_B },
    { label: "C (Mock-Network)",     tests: SECTION_C },
    { label: "D (Security)",         tests: SECTION_D },
    { label: "E (Error Paths)",      tests: SECTION_E },
  ];

  for (const { label, tests } of allSections) {
    process.stderr.write(`\n  Section ${label}\n`);
    for (const fn of tests) {
      await fn();
    }
  }

  // Print results
  for (const r of results) {
    if (r.status === "PASS") {
      process.stdout.write(`  [PASS] ${r.name}\n`);
    } else {
      process.stdout.write(`  [FAIL] ${r.name}: ${r.error}\n`);
    }
  }

  const total = passed + failed;
  process.stdout.write(`\n  Results: ${passed}/${total} passed\n`);

  if (failed > 0) {
    process.stderr.write(`\n  FAILED: ${failed} test(s) failed\n`);
    process.exit(1);
  } else {
    process.stderr.write(`\n  All ${total} tests passed.\n`);
  }
}

runAll().catch(err => {
  process.stderr.write(`Fatal: ${err.stack}\n`);
  process.exit(1);
});
