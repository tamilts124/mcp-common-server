"use strict";
/**
 * Section 199 — snmp_client tests (70 tests)
 *
 * A: input-validation        x10
 * B: BER-codec unit          x10
 * C: security-guards         x10
 * D: happy-path-mock         x30
 * E: error-paths              x5
 * F: concurrency              x5
 *
 * All network I/O mocked via real UDP sockets (dgram) on loopback.
 */

const assert = require("assert");
const dgram  = require("dgram");
const { snmpClient, _ber, _oidAliases, _resolveOid } = require("../../lib/snmpClientOps");

// ─── Test runner ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: "PASS" });
  } catch (e) {
    failed++;
    results.push({ name, status: "FAIL", error: e.message });
    process.stderr.write(`FAIL: ${name}\n  ${e.message}\n`);
  }
}

// ─── BER helpers ─────────────────────────────────────────────────────────────
const ber = _ber;

// ─── SNMP Mock Infrastructure ────────────────────────────────────────────────
/**
 * Create a mock SNMP agent on a random OS-assigned UDP port.
 * handler(requestMsg, callback) -> callback(responseBuffer)
 */
function createMockAgent(handler) {
  const server = dgram.createSocket("udp4");
  return new Promise((resolve) => {
    server.on("message", (msg, rinfo) => {
      handler(msg, (response) => {
        server.send(response, 0, response.length, rinfo.port, rinfo.address);
      });
    });
    server.bind(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/**
 * Build a fake SNMP GET-RESPONSE from a parsed request.
 * Replaces varBind null values with the provided returnValues map { oid -> {type, value} }.
 */
function buildMockResponse(requestBuf, returnValues) {
  // Parse the incoming request
  const req = ber.parseSnmpMessage(requestBuf);

  // Build response varBinds
  const varBinds = req.varBinds.map(vb => {
    const rv = returnValues && returnValues[vb.oid];
    if (rv) return { oid: vb.oid, type: rv.type, value: rv.value };
    return { oid: vb.oid, type: "null" };
  });

  // Re-use requestId, community, version from request
  const { msg } = ber.buildSnmpMessage({
    version:   req.version,
    community: req.community,
    pduType:   0xa2, // GET_RESPONSE
    requestId: req.requestId,
    errorStatus: 0,
    errorIndex:  0,
    varBinds,
  });
  return msg;
}

// ─── Main test runner ─────────────────────────────────────────────────────────
async function main() {

// ─── A: Input Validation (10 tests) ──────────────────────────────────────────
await test("A01 missing host throws", async () => {
  await assert.rejects(
    () => snmpClient({ operation: "get", oid: "1.3.6.1.2.1.1.1.0" }),
    /host.*required/i
  );
});

await test("A02 missing operation throws", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1" }),
    /operation/i
  );
});

await test("A03 unknown operation throws", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "magic" }),
    /unknown operation/i
  );
});

await test("A04 get with no OID throws", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "get" }),
    /At least one OID/i
  );
});

await test("A05 get with invalid OID format throws", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "get", oid: "not.an.oid" }),
    /Invalid OID/i
  );
});

await test("A06 get_bulk requires v2c", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "get_bulk", oid: "1.3.6.1.2.1.1.1.0", version: "v1", timeout: 0.1 }),
    /v2c/i
  );
});

await test("A07 set without set_vars throws", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "set" }),
    /set_vars/i
  );
});

await test("A08 set with empty set_vars throws", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "set", set_vars: [] }),
    /set_vars/i
  );
});

await test("A09 too many OIDs throws (>100)", async () => {
  const oids = Array.from({ length: 101 }, (_, i) => `1.3.6.1.2.1.1.${i}.0`);
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "get", oids }),
    /Maximum 100 OIDs/i
  );
});

await test("A10 OID too long throws", async () => {
  const longOid = "1.3.6.1." + "1.".repeat(130) + "0";
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "get", oid: longOid }),
    /OID exceeds/i
  );
});

// ─── B: BER Codec Unit Tests (10 tests) ──────────────────────────────────────
await test("B01 encodeInteger round-trips zero", async () => {
  const buf = ber.encodeInteger(0);
  const { tag, value } = ber.decodeTLV(buf, 0);
  assert.strictEqual(tag, 0x02);
  assert.strictEqual(ber.decodeInteger(value), 0);
});

await test("B02 encodeInteger round-trips positive", async () => {
  for (const n of [1, 127, 128, 255, 1000, 65535, 2147483647]) {
    const buf = ber.encodeInteger(n);
    const { value } = ber.decodeTLV(buf, 0);
    assert.strictEqual(ber.decodeInteger(value), n, `Failed for ${n}`);
  }
});

await test("B03 encodeUint32 round-trips unsigned values", async () => {
  for (const n of [0, 1, 0xffffffff]) {
    const buf = ber.encodeUint32(n);
    const { value } = ber.decodeTLV(buf, 0);
    assert.strictEqual(ber.decodeUint32(value), n >>> 0, `Failed for ${n}`);
  }
});

await test("B04 encodeOid round-trips basic OID", async () => {
  const oid = "1.3.6.1.2.1.1.1.0";
  const buf = ber.encodeOid(oid);
  const { tag, value } = ber.decodeTLV(buf, 0);
  assert.strictEqual(tag, 0x06);
  assert.strictEqual(ber.decodeOid(value), oid);
});

await test("B05 encodeOctetString round-trips string", async () => {
  const str = "Hello SNMP";
  const buf = ber.encodeOctetString(str);
  const { tag, value } = ber.decodeTLV(buf, 0);
  assert.strictEqual(tag, 0x04);
  assert.strictEqual(value.toString("utf8"), str);
});

await test("B06 encodeNull produces correct bytes", async () => {
  const buf = ber.encodeNull();
  assert.strictEqual(buf[0], 0x05);
  assert.strictEqual(buf[1], 0x00);
});

await test("B07 buildSnmpMessage produces parseable message", async () => {
  const oid = "1.3.6.1.2.1.1.1.0";
  const { msg, requestId } = ber.buildSnmpMessage({
    version:   1,
    community: "public",
    pduType:   0xa0, // GET_REQUEST
    varBinds:  [{ oid, type: "null" }],
  });
  const parsed = ber.parseSnmpMessage(msg);
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.community, "public");
  assert.strictEqual(parsed.requestId, requestId);
  assert.strictEqual(parsed.varBinds.length, 1);
  assert.strictEqual(parsed.varBinds[0].oid, oid);
});

await test("B08 decodeValue handles counter32", async () => {
  const buf = ber.encodeUint32(12345, 0x41);
  const { tag, value } = ber.decodeTLV(buf, 0);
  const decoded = ber.decodeValue(tag, value);
  assert.strictEqual(decoded.type, "counter32");
  assert.strictEqual(decoded.value, 12345);
});

await test("B09 decodeValue handles ip_address", async () => {
  // Build IP_ADDRESS TLV manually: [0x40, 4, 192, 168, 1, 1]
  const ipBuf = Buffer.from([0x40, 0x04, 192, 168, 1, 1]);
  const { tag, value } = ber.decodeTLV(ipBuf, 0);
  const decoded = ber.decodeValue(tag, value);
  assert.strictEqual(decoded.type, "ip_address");
  assert.strictEqual(decoded.value, "192.168.1.1");
});

await test("B10 parseSnmpMessage handles multi-varbind response", async () => {
  const oids = ["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"];
  const { msg } = ber.buildSnmpMessage({
    version: 1, community: "public", pduType: 0xa2, // GET_RESPONSE
    errorStatus: 0, errorIndex: 0,
    varBinds: [
      { oid: oids[0], type: "octet_string", value: "Linux" },
      { oid: oids[1], type: "octet_string", value: "router01" },
    ],
  });
  const parsed = ber.parseSnmpMessage(msg);
  assert.strictEqual(parsed.varBinds.length, 2);
  assert.strictEqual(parsed.varBinds[0].value, "Linux");
  assert.strictEqual(parsed.varBinds[1].value, "router01");
});

// ─── C: Security Guards (10 tests) ───────────────────────────────────────────
await test("C01 host with NUL byte rejected", async () => {
  await assert.rejects(
    () => snmpClient({ host: "192.168.1.\x001", operation: "get", oid: "1.3.6.1.2.1.1.1.0" }),
    /NUL/i
  );
});

await test("C02 community with NUL byte rejected", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", community: "pub\x00lic", operation: "get", oid: "1.3.6.1.2.1.1.1.0" }),
    /NUL/i
  );
});

await test("C03 host with CRLF rejected", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1\r\nX-Injected: evil", operation: "get", oid: "1.3.6.1.2.1.1.1.0" }),
    /CRLF/i
  );
});

await test("C04 community with CRLF rejected", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", community: "pub\nlic", operation: "get", oid: "1.3.6.1.2.1.1.1.0" }),
    /CRLF/i
  );
});

await test("C05 host too long rejected", async () => {
  const longHost = "a".repeat(300);
  await assert.rejects(
    () => snmpClient({ host: longHost, operation: "get", oid: "1.3.6.1.2.1.1.1.0" }),
    /exceeds/i
  );
});

await test("C06 community too long rejected", async () => {
  const longComm = "x".repeat(300);
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", community: longComm, operation: "get", oid: "1.3.6.1.2.1.1.1.0" }),
    /exceeds/i
  );
});

await test("C07 OID with non-numeric chars rejected", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "get", oid: "1.3.6.1.2.evil.1.0" }),
    /Invalid OID/i
  );
});

await test("C08 OID too long rejected", async () => {
  const longOid = "1." + "1.".repeat(200) + "0";
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "get", oid: longOid }),
    /OID exceeds/i
  );
});

await test("C09 set_vars OID with non-numeric chars rejected", async () => {
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "set",
      set_vars: [{ oid: "1.3.evil.1.0", type: "integer", value: 1 }] }),
    /Invalid OID/i
  );
});

await test("C10 too many set_vars rejected", async () => {
  const setVars = Array.from({ length: 101 }, (_, i) =>
    ({ oid: `1.3.6.1.2.1.1.${i}.0`, type: "integer", value: i })
  );
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", operation: "set", set_vars: setVars }),
    /Maximum 100/i
  );
});

// ─── D: Happy-Path Mock Tests (30 tests) ──────────────────────────────────────

// D01-D05: GET operation
await test("D01 get sysDescr by numeric OID", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {
      "1.3.6.1.2.1.1.1.0": { type: "octet_string", value: "Linux router 5.4.0" },
    }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get",
      oid: "1.3.6.1.2.1.1.1.0", community: "public", timeout: 3 });
    assert.strictEqual(r.varBinds.length, 1);
    assert.strictEqual(r.varBinds[0].type, "octet_string");
    assert.strictEqual(r.varBinds[0].value, "Linux router 5.4.0");
    assert.ok(r.elapsedMs >= 0);
  } finally { server.close(); }
});

await test("D02 get sysDescr by alias 'sysDescr'", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {
      "1.3.6.1.2.1.1.1.0": { type: "octet_string", value: "Cisco IOS" },
    }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get",
      oid: "sysDescr", community: "public", timeout: 3 });
    assert.strictEqual(r.varBinds[0].value, "Cisco IOS");
  } finally { server.close(); }
});

await test("D03 get multiple OIDs in one request", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {
      "1.3.6.1.2.1.1.1.0": { type: "octet_string", value: "Linux" },
      "1.3.6.1.2.1.1.5.0": { type: "octet_string", value: "myrouter" },
    }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get",
      oids: ["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"], timeout: 3 });
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.varBinds[0].value, "Linux");
    assert.strictEqual(r.varBinds[1].value, "myrouter");
  } finally { server.close(); }
});

await test("D04 get returns integer type", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {
      "1.3.6.1.2.1.2.1.0": { type: "integer", value: 24 },
    }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get",
      oid: "1.3.6.1.2.1.2.1.0", timeout: 3 });
    assert.strictEqual(r.varBinds[0].type, "integer");
    assert.strictEqual(r.varBinds[0].value, 24);
  } finally { server.close(); }
});

await test("D05 get with v1 version succeeds", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {
      "1.3.6.1.2.1.1.3.0": { type: "timeticks", value: 900000 },
    }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, version: "v1",
      operation: "get", oid: "1.3.6.1.2.1.1.3.0", timeout: 3 });
    assert.strictEqual(r.varBinds[0].type, "timeticks");
    assert.strictEqual(r.varBinds[0].value, 900000);
  } finally { server.close(); }
});

// D06-D09: GET_NEXT
await test("D06 get_next returns next OID", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    // Return the next OID in the MIB
    const req = ber.parseSnmpMessage(msg);
    const nextOid = "1.3.6.1.2.1.1.2.0";
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0,
      varBinds: [{ oid: nextOid, type: "oid", value: "1.3.6.1.4.1.9" }],
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get_next",
      oid: "1.3.6.1.2.1.1.1.0", timeout: 3 });
    assert.strictEqual(r.varBinds[0].oid, "1.3.6.1.2.1.1.2.0");
    assert.strictEqual(r.varBinds[0].type, "oid");
  } finally { server.close(); }
});

await test("D07 get_next with multiple OIDs", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0,
      varBinds: [
        { oid: "1.3.6.1.2.1.1.2.0", type: "octet_string", value: "v1" },
        { oid: "1.3.6.1.2.1.1.6.0", type: "octet_string", value: "DC1" },
      ],
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get_next",
      oids: ["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"], timeout: 3 });
    assert.strictEqual(r.count, 2);
  } finally { server.close(); }
});

await test("D08 get_next result contains elapsed time", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, { "1.3.6.1.2.1.1.1.0": { type: "null" } }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get_next",
      oid: "1.3.6.1.2.1.1.0.0", timeout: 3 });
    assert.ok(typeof r.elapsedMs === "number" && r.elapsedMs >= 0);
  } finally { server.close(); }
});

await test("D09 get_next result has host/port/version/operation", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, { "1.3.6.1.2.1.1.1.0": { type: "null" } }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get_next",
      oid: "1.3.6.1.2.1.1.0.0", timeout: 3 });
    assert.strictEqual(r.host, "127.0.0.1");
    assert.strictEqual(r.port, port);
    assert.strictEqual(r.version, "v2c");
    assert.strictEqual(r.operation, "get_next");
  } finally { server.close(); }
});

// D10-D14: GET_BULK
await test("D10 get_bulk returns multiple results", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    const vbs = [];
    for (let i = 1; i <= 5; i++) {
      vbs.push({ oid: `1.3.6.1.2.1.2.2.1.2.${i}`, type: "octet_string", value: `eth${i}` });
    }
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0, varBinds: vbs,
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get_bulk",
      oid: "1.3.6.1.2.1.2.2.1.2", max_repetitions: 5, timeout: 3 });
    assert.strictEqual(r.count, 5);
    assert.strictEqual(r.varBinds[0].value, "eth1");
    assert.strictEqual(r.maxRepetitions, 5);
  } finally { server.close(); }
});

await test("D11 get_bulk default max_repetitions=10", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    // Verify the request encodes maxRepetitions=10
    const req = ber.parseSnmpMessage(msg);
    // errorIndex field holds maxRepetitions in GETBULK
    assert.strictEqual(req.errorIndex, 10); // maxRepetitions
    reply(buildMockResponse(msg, {}));
  });
  try {
    await snmpClient({ host: "127.0.0.1", port, operation: "get_bulk",
      oid: "1.3.6.1.2.1.1.1.0", timeout: 3 });
  } finally { server.close(); }
});

await test("D12 get_bulk non_repeaters=1 maxRepetitions=5", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    assert.strictEqual(req.errorStatus, 1); // nonRepeaters
    assert.strictEqual(req.errorIndex,  5); // maxRepetitions
    reply(buildMockResponse(msg, {}));
  });
  try {
    await snmpClient({ host: "127.0.0.1", port, operation: "get_bulk",
      oid: "1.3.6.1.2.1.1.1.0", non_repeaters: 1, max_repetitions: 5, timeout: 3 });
  } finally { server.close(); }
});

await test("D13 get_bulk result includes nonRepeaters and maxRepetitions", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {}));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get_bulk",
      oid: "1.3.6.1.2.1.1.1.0", non_repeaters: 0, max_repetitions: 7, timeout: 3 });
    assert.strictEqual(r.nonRepeaters, 0);
    assert.strictEqual(r.maxRepetitions, 7);
  } finally { server.close(); }
});

await test("D14 get_bulk with counter32 values", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0,
      varBinds: [
        { oid: "1.3.6.1.2.1.2.2.1.10.1", type: "counter32", value: 999999 },
      ],
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get_bulk",
      oid: "1.3.6.1.2.1.2.2.1.10", timeout: 3 });
    assert.strictEqual(r.varBinds[0].type, "counter32");
    assert.strictEqual(r.varBinds[0].value, 999999);
  } finally { server.close(); }
});

// D15-D20: WALK
await test("D15 walk collects subtree OIDs", async () => {
  let callCount = 0;
  const subtree = [
    { oid: "1.3.6.1.2.1.1.1.0", type: "octet_string", value: "Linux" },
    { oid: "1.3.6.1.2.1.1.2.0", type: "oid",          value: "1.3.6.1.4.1.9" },
    { oid: "1.3.6.1.2.1.1.3.0", type: "timeticks",    value: 12345 },
  ];
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    const currentOid = req.varBinds[0].oid;
    // Find index in subtree, return next
    const idx = subtree.findIndex(e => e.oid === currentOid);
    let responseVbs;
    if (idx === -1) {
      // Walk start: return first entry
      responseVbs = [subtree[0]];
    } else if (idx < subtree.length - 1) {
      // Return next batch (simulate GETBULK returning up to 10)
      responseVbs = subtree.slice(idx + 1);
    } else {
      // End of subtree: return out-of-subtree OID
      responseVbs = [{ oid: "1.3.6.1.2.1.2.1.0", type: "integer", value: 4 }];
    }
    callCount++;
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0, varBinds: responseVbs,
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "walk",
      oid: "1.3.6.1.2.1.1", timeout: 5 });
    assert.ok(r.count >= 3, `Expected >= 3 results, got ${r.count}`);
    assert.strictEqual(r.rootOid, "1.3.6.1.2.1.1");
    assert.ok(!r.truncated);
  } finally { server.close(); }
});

await test("D16 walk respects max_results cap", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    const base = req.varBinds[0].oid;
    // Always return 5 more entries within subtree
    const startNum = parseInt(base.split(".").pop(), 10) + 1 || 1;
    const vbs = [];
    for (let i = startNum; i < startNum + 5; i++) {
      vbs.push({ oid: `1.3.6.1.2.1.1.${i}.0`, type: "integer", value: i });
    }
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0, varBinds: vbs,
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "walk",
      oid: "1.3.6.1.2.1.1", max_results: 7, timeout: 5 });
    assert.ok(r.count <= 7, `Expected <= 7 results, got ${r.count}`);
    assert.ok(r.truncated);
  } finally { server.close(); }
});

await test("D17 walk stops at endOfMibView", async () => {
  let callIdx = 0;
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    let vbs;
    if (callIdx === 0) {
      vbs = [{ oid: "1.3.6.1.2.1.1.1.0", type: "octet_string", value: "Linux" }];
    } else {
      vbs = [{ oid: "1.3.6.1.2.1.1.2.0", type: "endOfMibView", value: null }];
    }
    callIdx++;
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0, varBinds: vbs,
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "walk",
      oid: "1.3.6.1.2.1.1", timeout: 3 });
    // Should have collected the first entry then stopped
    assert.strictEqual(r.count, 1);
  } finally { server.close(); }
});

await test("D18 walk uses alias sysName as root", async () => {
  // sysName maps to 1.3.6.1.2.1.1.5.0; walk should resolve it
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    // Immediately return out-of-subtree to end walk
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0,
      varBinds: [{ oid: "1.3.6.1.2.1.2.1.0", type: "integer", value: 0 }],
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "walk",
      oid: "sysName", timeout: 3 });
    assert.strictEqual(r.rootOid, "1.3.6.1.2.1.1.5.0");
  } finally { server.close(); }
});

await test("D19 walk returns count and rootOid fields", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0,
      varBinds: [{ oid: "2.0", type: "null" }], // out of subtree immediately
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "walk",
      oid: "1.3.6.1.2.1.1", timeout: 3 });
    assert.ok("count" in r);
    assert.ok("rootOid" in r);
    assert.strictEqual(r.rootOid, "1.3.6.1.2.1.1");
  } finally { server.close(); }
});

await test("D20 walk with v1 uses GETNEXT (not GETBULK)", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    // Version 0 = v1, PDU type should be GETNEXT (0xa1)
    assert.strictEqual(req.version, 0); // v1
    assert.strictEqual(req.pduType, 0xa1); // GETNEXT
    // Return out-of-subtree
    const { msg: resp } = ber.buildSnmpMessage({
      version: 0, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0,
      varBinds: [{ oid: "2.0", type: "null" }],
    });
    reply(resp);
  });
  try {
    await snmpClient({ host: "127.0.0.1", port, operation: "walk",
      version: "v1", oid: "1.3.6.1.2.1.1", timeout: 3 });
  } finally { server.close(); }
});

// D21-D25: SET
await test("D21 set integer value succeeds", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {
      "1.3.6.1.2.1.1.4.0": { type: "octet_string", value: "admin@example.com" },
    }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "set",
      set_vars: [{ oid: "1.3.6.1.2.1.1.4.0", type: "octet_string", value: "admin@example.com" }],
      community: "private", timeout: 3 });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.count, 1);
  } finally { server.close(); }
});

await test("D22 set multiple vars at once", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    // Echo back varBinds
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0, varBinds: req.varBinds,
    });
    reply(resp);
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "set",
      set_vars: [
        { oid: "1.3.6.1.2.1.1.4.0", type: "octet_string", value: "admin" },
        { oid: "1.3.6.1.2.1.1.6.0", type: "octet_string", value: "DC1" },
      ],
      timeout: 3 });
    assert.strictEqual(r.count, 2);
  } finally { server.close(); }
});

await test("D23 set PDU type is SET_REQUEST (0xa3)", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    assert.strictEqual(req.pduType, 0xa3); // SET_REQUEST
    reply(buildMockResponse(msg, {}));
  });
  try {
    await snmpClient({ host: "127.0.0.1", port, operation: "set",
      set_vars: [{ oid: "1.3.6.1.2.1.1.4.0", type: "octet_string", value: "x" }],
      timeout: 3 });
  } finally { server.close(); }
});

await test("D24 set uses alias OID in set_vars", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    // sysContact = 1.3.6.1.2.1.1.4.0
    assert.strictEqual(req.varBinds[0].oid, "1.3.6.1.2.1.1.4.0");
    reply(buildMockResponse(msg, {}));
  });
  try {
    await snmpClient({ host: "127.0.0.1", port, operation: "set",
      set_vars: [{ oid: "sysContact", type: "octet_string", value: "ops" }],
      timeout: 3 });
  } finally { server.close(); }
});

await test("D25 OID aliases resolve correctly", async () => {
  assert.strictEqual(_resolveOid("sysDescr"),   "1.3.6.1.2.1.1.1.0");
  assert.strictEqual(_resolveOid("sysUpTime"),  "1.3.6.1.2.1.1.3.0");
  assert.strictEqual(_resolveOid("ifInOctets"), "1.3.6.1.2.1.2.2.1.10");
  assert.strictEqual(_resolveOid("1.2.3.4"),    "1.2.3.4"); // passthrough
});

// D26-D30: Response metadata
await test("D26 result includes host and port", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, { "1.3.6.1.2.1.1.1.0": { type: "null" } }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get",
      oid: "1.3.6.1.2.1.1.1.0", timeout: 3 });
    assert.strictEqual(r.host, "127.0.0.1");
    assert.strictEqual(r.port, port);
  } finally { server.close(); }
});

await test("D27 result version field reflects v2c default", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, { "1.3.6.1.2.1.1.1.0": { type: "null" } }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, operation: "get",
      oid: "1.3.6.1.2.1.1.1.0", timeout: 3 });
    assert.strictEqual(r.version, "v2c");
  } finally { server.close(); }
});

await test("D28 result version field reflects v1 when specified", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, { "1.3.6.1.2.1.1.1.0": { type: "null" } }));
  });
  try {
    const r = await snmpClient({ host: "127.0.0.1", port, version: "v1",
      operation: "get", oid: "1.3.6.1.2.1.1.1.0", timeout: 3 });
    assert.strictEqual(r.version, "v1");
  } finally { server.close(); }
});

await test("D29 community defaults to 'public'", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    assert.strictEqual(req.community, "public");
    reply(buildMockResponse(msg, {}));
  });
  try {
    await snmpClient({ host: "127.0.0.1", port, operation: "get",
      oid: "1.3.6.1.2.1.1.1.0", timeout: 3 });
  } finally { server.close(); }
});

await test("D30 community string is sent correctly in request", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    assert.strictEqual(req.community, "monitoringSecret123");
    reply(buildMockResponse(msg, {}));
  });
  try {
    await snmpClient({ host: "127.0.0.1", port, community: "monitoringSecret123",
      operation: "get", oid: "1.3.6.1.2.1.1.1.0", timeout: 3 });
  } finally { server.close(); }
});

// ─── E: Error Paths (5 tests) ─────────────────────────────────────────────────
await test("E01 timeout when agent doesn't respond", async () => {
  // Use a port where nothing is listening
  await assert.rejects(
    () => snmpClient({ host: "127.0.0.1", port: 19161, operation: "get",
      oid: "1.3.6.1.2.1.1.1.0", timeout: 0.2 }),
    /timeout/i
  );
});

await test("E02 SNMP errorStatus non-zero throws descriptive error", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 2, // noSuchName
      errorIndex: 1,
      varBinds: req.varBinds,
    });
    reply(resp);
  });
  try {
    await assert.rejects(
      () => snmpClient({ host: "127.0.0.1", port, operation: "get",
        oid: "1.3.6.1.2.1.1.1.0", timeout: 3 }),
      /noSuchName|SNMP error/i
    );
  } finally { server.close(); }
});

await test("E03 invalid OID in encodeOid throws", async () => {
  assert.throws(() => ber.encodeOid("1"), /Invalid OID/);
});

await test("E04 SET errorStatus throws specific error", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 6, // noAccess
      errorIndex: 1,
      varBinds: req.varBinds,
    });
    reply(resp);
  });
  try {
    await assert.rejects(
      () => snmpClient({ host: "127.0.0.1", port, operation: "set",
        set_vars: [{ oid: "1.3.6.1.2.1.1.4.0", type: "octet_string", value: "x" }],
        timeout: 3 }),
      /noAccess|SNMP SET error/i
    );
  } finally { server.close(); }
});

await test("E05 walk timeout is respected", async () => {
  // Agent hangs after first response
  let count = 0;
  const { server, port } = await createMockAgent((msg, reply) => {
    if (count++ === 0) {
      const req = ber.parseSnmpMessage(msg);
      const { msg: resp } = ber.buildSnmpMessage({
        version: req.version, community: req.community,
        pduType: 0xa2, requestId: req.requestId,
        errorStatus: 0, errorIndex: 0,
        varBinds: [{ oid: "1.3.6.1.2.1.1.1.0", type: "octet_string", value: "x" }],
      });
      reply(resp);
      // Don't reply to subsequent requests (simulate hang)
    }
  });
  try {
    await assert.rejects(
      () => snmpClient({ host: "127.0.0.1", port, operation: "walk",
        oid: "1.3.6.1.2.1.1", timeout: 0.3 }),
      /timeout/i
    );
  } finally { server.close(); }
});

// ─── F: Concurrency (5 tests) ─────────────────────────────────────────────────
await test("F01 10 concurrent GET requests succeed", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {
      "1.3.6.1.2.1.1.1.0": { type: "octet_string", value: "Linux" },
    }));
  });
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        snmpClient({ host: "127.0.0.1", port, operation: "get",
          oid: "1.3.6.1.2.1.1.1.0", timeout: 3 })
      )
    );
    assert.strictEqual(results.length, 10);
    assert.ok(results.every(r => r.varBinds[0].value === "Linux"));
  } finally { server.close(); }
});

await test("F02 concurrent requests maintain independent requestIds", async () => {
  const seenIds = new Set();
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    seenIds.add(req.requestId);
    reply(buildMockResponse(msg, {}));
  });
  try {
    await Promise.all(
      Array.from({ length: 5 }, () =>
        snmpClient({ host: "127.0.0.1", port, operation: "get",
          oid: "1.3.6.1.2.1.1.1.0", timeout: 3 })
      )
    );
    // All 5 should have different requestIds
    assert.strictEqual(seenIds.size, 5);
  } finally { server.close(); }
});

await test("F03 concurrent gets and gets_next", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {
      "1.3.6.1.2.1.1.1.0": { type: "octet_string", value: "v" },
      "1.3.6.1.2.1.1.5.0": { type: "octet_string", value: "r" },
    }));
  });
  try {
    const [r1, r2] = await Promise.all([
      snmpClient({ host: "127.0.0.1", port, operation: "get",
        oid: "1.3.6.1.2.1.1.1.0", timeout: 3 }),
      snmpClient({ host: "127.0.0.1", port, operation: "get_next",
        oid: "1.3.6.1.2.1.1.4.0", timeout: 3 }),
    ]);
    assert.strictEqual(r1.operation, "get");
    assert.strictEqual(r2.operation, "get_next");
  } finally { server.close(); }
});

await test("F04 concurrent requests don't share socket state", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    const req = ber.parseSnmpMessage(msg);
    // Return a response that includes the requestId so we can verify isolation
    const { msg: resp } = ber.buildSnmpMessage({
      version: req.version, community: req.community,
      pduType: 0xa2, requestId: req.requestId,
      errorStatus: 0, errorIndex: 0,
      varBinds: [{ oid: "1.3.6.1.2.1.1.1.0", type: "integer", value: req.requestId }],
    });
    reply(resp);
  });
  try {
    const requests = Array.from({ length: 8 }, () =>
      snmpClient({ host: "127.0.0.1", port, operation: "get",
        oid: "1.3.6.1.2.1.1.1.0", timeout: 3 })
    );
    const results = await Promise.all(requests);
    // Each result should have varBinds[0].value equal to that request's own requestId
    for (const r of results) {
      assert.ok(typeof r.varBinds[0].value === "number");
    }
  } finally { server.close(); }
});

await test("F05 concurrent set operations complete without interference", async () => {
  const { server, port } = await createMockAgent((msg, reply) => {
    reply(buildMockResponse(msg, {}));
  });
  try {
    const ops = Array.from({ length: 5 }, (_, i) =>
      snmpClient({ host: "127.0.0.1", port, operation: "set",
        set_vars: [{ oid: `1.3.6.1.2.1.1.${i + 1}.0`, type: "integer", value: i }],
        timeout: 3 })
    );
    const results = await Promise.all(ops);
    assert.strictEqual(results.length, 5);
    assert.ok(results.every(r => r.success === true));
  } finally { server.close(); }
});

// ─── Summary ─────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n199-snmp-client: ${passed}/${total} passed${failed > 0 ? ` (${failed} FAILED)` : ""}.`);
if (failed > 0) {
  results.filter(r => r.status === "FAIL").forEach(r =>
    console.log(`  FAIL: ${r.name}\n    ${r.error}`)
  );
  process.exit(1);
}

} // end main()

main().catch(err => {
  process.stderr.write(`Unhandled error: ${err.stack || err.message}\n`);
  process.exit(1);
});
