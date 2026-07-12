"use strict";
/**
 * Section 197 — ldap_client tests
 * 70 tests across 6 subsections (A–F)
 *
 * A: Input validation (10)
 * B: BER codec unit tests (10)
 * C: Security guards (10)
 * D: Happy-path mock (30)
 * E: Error paths (5)
 * F: Concurrency (5)
 *
 * Mock server dynamically patches msgId in responses to match incoming
 * request msgIds — works correctly regardless of the module-level _msgId counter.
 */

const net  = require("net");
const path = require("path");

// ── Load module under test ────────────────────────────────────────────────────
const libPath = path.resolve(__dirname, "../../lib/ldapClientOps.js");
const {
  ldapClient,
  LdapParser,
  BerReader,
  buildBindRequest,
  buildSearchRequest,
  buildAddRequest,
  buildModifyRequest,
  buildDeleteRequest,
  buildCompareRequest,
  buildWhoamiRequest,
  encodeFilter,
  berOctetString,
  berInt,
  berEnum,
  berSequence,
  berTLV,
  TAG,
  RESULT_CODES,
} = require(libPath);

// ── Minimal test runner ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(".");
  } catch (e) {
    failed++;
    errors.push({ name, error: e.message });
    process.stdout.write("F");
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`);
}

function assertThrows(fn, pattern) {
  try { fn(); }
  catch (e) {
    if (pattern && !e.message.includes(pattern))
      throw new Error(`Expected error '${pattern}' but got '${e.message}'`);
    return;
  }
  throw new Error("Expected function to throw but it did not");
}

async function assertRejects(fn, pattern) {
  try { await fn(); }
  catch (e) {
    if (pattern && !e.message.includes(pattern))
      throw new Error(`Expected rejection '${pattern}' but got '${e.message}'`);
    return;
  }
  throw new Error("Expected promise to reject but it resolved");
}

// ── BER helpers ───────────────────────────────────────────────────────────────

// Build a valid LDAP BindResponse message (resultCode=0 = success)
function makeBindResponse(resultCode = 0) {
  const resultBuf = Buffer.concat([
    berEnum(resultCode),        // resultCode
    berOctetString(""),         // matchedDN
    berOctetString(""),         // diagnosticMessage
  ]);
  const protocolOp = berTLV(TAG.BIND_RESPONSE, resultBuf);
  // Use placeholder msgId=0; mock server will patch with actual request msgId
  return berSequence([berInt(0), protocolOp]);
}

function makeSearchResultEntry(dn, attrs) {
  const attrBufs = [];
  for (const [type, vals] of Object.entries(attrs)) {
    const valBufs = vals.map(v => berTLV(TAG.OCTET_STRING, Buffer.from(v, "utf8")));
    const valSet  = berTLV(TAG.SET, Buffer.concat(valBufs));
    const partial = berSequence([berOctetString(type), valSet]);
    attrBufs.push(partial);
  }
  const attrSeq  = berSequence(attrBufs);
  const body     = Buffer.concat([berOctetString(dn), attrSeq]);
  const protocolOp = berTLV(TAG.SEARCH_RESULT_ENTRY, body);
  return berSequence([berInt(0), protocolOp]);
}

function makeSearchResultDone(resultCode = 0) {
  const body = Buffer.concat([
    berEnum(resultCode),
    berOctetString(""),
    berOctetString(""),
  ]);
  return berSequence([berInt(0), berTLV(TAG.SEARCH_RESULT_DONE, body)]);
}

function makeModifyResponse(resultCode = 0) {
  const body = Buffer.concat([berEnum(resultCode), berOctetString(""), berOctetString("")]);
  return berSequence([berInt(0), berTLV(TAG.MODIFY_RESPONSE, body)]);
}

function makeAddResponse(resultCode = 0) {
  const body = Buffer.concat([berEnum(resultCode), berOctetString(""), berOctetString("")]);
  return berSequence([berInt(0), berTLV(TAG.ADD_RESPONSE, body)]);
}

function makeDeleteResponse(resultCode = 0) {
  const body = Buffer.concat([berEnum(resultCode), berOctetString(""), berOctetString("")]);
  return berSequence([berInt(0), berTLV(TAG.DELETE_RESPONSE, body)]);
}

function makeCompareResponse(resultCode = 6 /* compareTrue */) {
  const body = Buffer.concat([berEnum(resultCode), berOctetString(""), berOctetString("")]);
  return berSequence([berInt(0), berTLV(TAG.COMPARE_RESPONSE, body)]);
}

function makeExtendedResponse(resultCode = 0, responseValue = "") {
  let body = Buffer.concat([berEnum(resultCode), berOctetString(""), berOctetString("")]);
  if (responseValue) {
    body = Buffer.concat([body, berTLV(0x8B, Buffer.from(responseValue, "utf8"))]);
  }
  return berSequence([berInt(0), berTLV(TAG.EXTENDED_RESPONSE, body)]);
}

// ── Mock server: msgId-aware ──────────────────────────────────────────────────
//
// Creates a real net.Server on a random OS port. For each incoming LDAP
// request, the server:
//   1. Parses the actual msgId from the request
//   2. Takes the next response buffer from `responses[]`
//   3. Patches every LDAP message in that buffer to use the actual msgId
//   4. Sends the patched response back
//
// This way tests don't need to know the module-level _msgId counter value.

function berLengthBuf(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len <= 0xFF) return Buffer.from([0x81, len]);
  if (len <= 0xFFFF) return Buffer.from([0x82, (len >> 8) & 0xFF, len & 0xFF]);
  if (len <= 0xFFFFFF) return Buffer.from([0x83, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
  return Buffer.from([0x84, (len >>> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
}

function parseBerLen(buf, pos) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first < 0x80) return { hdrLen: 1, bodyLen: first };
  const numBytes = first & 0x7F;
  if (numBytes === 0 || numBytes > 4 || pos + 1 + numBytes > buf.length) return null;
  let bodyLen = 0;
  for (let i = 0; i < numBytes; i++) bodyLen = (bodyLen << 8) | buf[pos + 1 + i];
  return { hdrLen: 1 + numBytes, bodyLen: bodyLen >>> 0 };
}

function extractMsgId(buf) {
  if (buf.length < 4 || buf[0] !== 0x30) return null;
  const outer = parseBerLen(buf, 1);
  if (!outer) return null;
  const bodyStart = 1 + outer.hdrLen;
  if (bodyStart >= buf.length || buf[bodyStart] !== 0x02 /* INTEGER */) return null;
  const inner = parseBerLen(buf, bodyStart + 1);
  if (!inner) return null;
  const valStart = bodyStart + 1 + inner.hdrLen;
  if (valStart + inner.bodyLen > buf.length) return null;
  let msgId = 0;
  for (let i = 0; i < inner.bodyLen; i++) msgId = (msgId << 8) | buf[valStart + i];
  return msgId;
}

// Rewrite the msgId INTEGER in a single LDAP message buffer.
function patchMsgId(msgBuf, newId) {
  if (!msgBuf || msgBuf.length < 4 || msgBuf[0] !== 0x30) return msgBuf;
  const outer = parseBerLen(msgBuf, 1);
  if (!outer) return msgBuf;
  const bodyStart = 1 + outer.hdrLen;
  if (bodyStart >= msgBuf.length || msgBuf[bodyStart] !== 0x02) return msgBuf;
  const inner = parseBerLen(msgBuf, bodyStart + 1);
  if (!inner) return msgBuf;
  const oldIntTotalLen = 1 + inner.hdrLen + inner.bodyLen; // tag + lenHdr + val
  const newIntBuf = berInt(newId); // fresh BER INTEGER for newId
  const rest = msgBuf.slice(bodyStart + oldIntTotalLen);
  const newBody = Buffer.concat([newIntBuf, rest]);
  return Buffer.concat([Buffer.from([0x30]), berLengthBuf(newBody.length), newBody]);
}

// Split a buffer that may contain multiple concatenated LDAP SEQUENCE messages.
function splitLdapMessages(buf) {
  const msgs = [];
  let pos = 0;
  while (pos < buf.length) {
    if (buf[pos] !== 0x30) break;
    const lenInfo = parseBerLen(buf, pos + 1);
    if (!lenInfo) break;
    const msgLen = 1 + lenInfo.hdrLen + lenInfo.bodyLen;
    if (pos + msgLen > buf.length) break;
    msgs.push(buf.slice(pos, pos + msgLen));
    pos += msgLen;
  }
  return { msgs, remainder: buf.slice(pos) };
}

function startMockLdapServer(responses) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let responseIdx = 0;
      let recvBuf     = Buffer.alloc(0);

      sock.on("data", (chunk) => {
        recvBuf = Buffer.concat([recvBuf, chunk]);
        const { msgs, remainder } = splitLdapMessages(recvBuf);
        recvBuf = remainder;

        for (const reqMsg of msgs) {
          // Skip UnbindRequest (APPLICATION 2, primitive, tag=0x42) — no response needed
          // After outer SEQUENCE + len + INTEGER msgId, the next byte is the op tag
          // We can detect by looking for UNBIND_REQUEST tag in the request body
          const actualMsgId = extractMsgId(reqMsg);
          if (actualMsgId === null) continue;

          if (responseIdx >= responses.length) continue;
          const resp = responses[responseIdx++];

          // resp may contain one or multiple LDAP messages (e.g. Entry+Done)
          const { msgs: subMsgs } = splitLdapMessages(resp);
          let patched;
          if (subMsgs.length === 0) {
            patched = resp;
          } else {
            patched = Buffer.concat(subMsgs.map(m => patchMsgId(m, actualMsgId)));
          }
          const toSend = patched;
          setImmediate(() => { if (!sock.destroyed) sock.write(toSend); });
        }
      });

      sock.on("error", () => {});
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ── SECTION A: Input Validation ──────────────────────────────────────────────

async function runSectionA() {
  process.stderr.write("\n[A] Input validation\n");

  await test("A01 missing host rejects", async () => {
    await assertRejects(() => ldapClient({ operation: "bind" }), "'host' is required");
  });

  await test("A02 missing operation rejects", async () => {
    await assertRejects(() => ldapClient({ host: "localhost" }), "'operation' must be one of");
  });

  await test("A03 invalid operation rejects", async () => {
    await assertRejects(() => ldapClient({ host: "localhost", operation: "hack" }), "'operation' must be one of");
  });

  await test("A04 search: invalid scope rejects", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "search", scope: "bogus" }),
      "'scope' must be one of"
    );
  });

  await test("A05 search: negative size_limit rejects", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "search", size_limit: -1 }),
      "'size_limit' must be a non-negative number"
    );
  });

  await test("A06 add: missing dn rejects", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "add" }),
      "'dn' is required for 'add'"
    );
  });

  await test("A07 add: missing entry_attributes rejects", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "add", dn: "cn=test,dc=example,dc=com" }),
      "'entry_attributes' (object) is required"
    );
  });

  await test("A08 modify: empty modifications rejects", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "modify", dn: "cn=test,dc=example,dc=com", modifications: [] }),
      "'modifications' (array) is required"
    );
  });

  await test("A09 compare: missing attribute rejects", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "compare", dn: "cn=test,dc=example,dc=com" }),
      "'attribute' is required for 'compare'"
    );
  });

  await test("A10 compare: missing value rejects", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "compare", dn: "cn=test,dc=example,dc=com", attribute: "cn" }),
      "'value' is required for 'compare'"
    );
  });
}

// ── SECTION B: BER Codec Unit Tests ──────────────────────────────────────────

async function runSectionB() {
  process.stderr.write("\n[B] BER codec unit tests\n");

  await test("B01 berInt encodes zero", () => {
    const buf = berInt(0);
    assertEqual(buf[0], TAG.INTEGER);
    assertEqual(buf[1], 1); // length=1
    assertEqual(buf[2], 0); // value=0
  });

  await test("B02 berInt encodes positive multibyte", () => {
    const buf = berInt(256);
    assertEqual(buf[0], TAG.INTEGER);
    // 256 = 0x0100: needs 2 bytes, sign bit needs leading 0x00
    assert(buf.length > 3);
  });

  await test("B03 berOctetString encodes UTF-8", () => {
    const buf = berOctetString("hello");
    assertEqual(buf[0], TAG.OCTET_STRING);
    assertEqual(buf[1], 5);
    assertEqual(buf.slice(2).toString("utf8"), "hello");
  });

  await test("B04 berEnum encodes correctly", () => {
    const buf = berEnum(2);
    assertEqual(buf[0], TAG.ENUMERATED);
    assertEqual(buf[2], 2);
  });

  await test("B05 encodeFilter present", () => {
    const buf = encodeFilter("(objectClass=*)");
    // present filter = 0x87 + length + 'objectClass'
    assertEqual(buf[0], 0x87);
    assertEqual(buf.slice(2).toString("utf8"), "objectClass");
  });

  await test("B06 encodeFilter equality", () => {
    const buf = encodeFilter("(cn=alice)");
    // equality filter tag = 0xA3
    assertEqual(buf[0], 0xA3);
  });

  await test("B07 encodeFilter AND", () => {
    const buf = encodeFilter("(&(cn=alice)(sn=smith))");
    assertEqual(buf[0], 0xA0); // AND
  });

  await test("B08 encodeFilter OR", () => {
    const buf = encodeFilter("(|(cn=alice)(cn=bob))");
    assertEqual(buf[0], 0xA1); // OR
  });

  await test("B09 LdapParser parses BindResponse", () => {
    const parser = new LdapParser();
    const resp   = makeBindResponse(0);
    parser.feed(resp);
    const msg = parser.shift();
    assert(msg !== null, "expected message");
    assertEqual(msg.type, "BindResponse");
    assertEqual(msg.resultCode, 0);
  });

  await test("B10 LdapParser handles fragmented input", () => {
    const parser = new LdapParser();
    const resp   = makeBindResponse(0);
    // Feed byte-by-byte
    for (let i = 0; i < resp.length; i++) {
      parser.feed(resp.slice(i, i + 1));
    }
    const msg = parser.shift();
    assert(msg !== null, "expected message after fragmented feed");
    assertEqual(msg.type, "BindResponse");
  });
}

// ── SECTION C: Security Guards ────────────────────────────────────────────────

async function runSectionC() {
  process.stderr.write("\n[C] Security guards\n");

  await test("C01 NUL in bind_dn rejects", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "bind", bind_dn: "cn=test\x00evil" }),
      "NUL bytes"
    );
  });

  await test("C02 NUL in bind_password rejected", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "bind", bind_password: "pass\x00word" }),
      "NUL bytes"
    );
  });

  await test("C03 NUL in filter rejected", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "search", filter: "(cn=al\x00ice)" }),
      "NUL bytes"
    );
  });

  await test("C04 NUL in dn rejected", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "delete", dn: "cn=bad\x00,dc=evil" }),
      "NUL bytes"
    );
  });

  await test("C05 DN exceeding max length rejected", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "delete", dn: "cn=" + "a".repeat(1025) }),
      "exceeds"
    );
  });

  await test("C06 bind_dn exceeding max length rejected", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "bind", bind_dn: "cn=" + "a".repeat(1025) }),
      "exceeds"
    );
  });

  await test("C07 filter exceeding 4096 chars rejected", async () => {
    await assertRejects(
      () => ldapClient({ host: "localhost", operation: "search", filter: "(cn=" + "a".repeat(4100) + ")" }),
      "exceeds"
    );
  });

  await test("C08 modify: missing attribute in modification rejected", async () => {
    await assertRejects(
      () => ldapClient({ host: "127.0.0.1", operation: "modify", dn: "cn=x,dc=y",
        modifications: [{ operation: "replace" }] }),
      "each modification needs 'attribute'"
    );
  });

  await test("C09 encodeFilter substring guard (no injection)", () => {
    // Ensure a substring filter with * is encoded as SEQUENCE not as equality
    const buf = encodeFilter("(cn=al*)");
    assertEqual(buf[0], 0xA4); // substring filter
  });

  await test("C10 BerReader throws on truncated data", () => {
    const r = new BerReader(Buffer.from([TAG.SEQUENCE, 0x10, 0x01]));
    assertThrows(() => r.readTLV(), "truncated");
  });
}

// ── SECTION D: Happy-Path Mock (30 tests) ─────────────────────────────────────

async function runSectionD() {
  process.stderr.write("\n[D] Happy-path mock\n");

  // ── D01–D05: bind ───────────────────────────────────────────────────────────

  await test("D01 bind: anonymous bind succeeds", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "bind",
        timeout: 5,
      });
      assertEqual(result.operation, "bind");
      assertEqual(result.bound, true);
      assertEqual(result.resultCode, 0);
    } finally {
      server.close();
    }
  });

  await test("D02 bind: returns correct dn", async () => {
    const { server, port } = await startMockLdapServer([makeBindResponse(0)]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "bind",
        bind_dn: "cn=admin,dc=example,dc=com",
        bind_password: "secret",
        timeout: 5,
      });
      assertEqual(result.dn, "cn=admin,dc=example,dc=com");
    } finally {
      server.close();
    }
  });

  await test("D03 bind: returns elapsedMs", async () => {
    const { server, port } = await startMockLdapServer([makeBindResponse(0)]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "bind", timeout: 5,
      });
      assert(typeof result.elapsedMs === "number" && result.elapsedMs >= 0);
    } finally {
      server.close();
    }
  });

  await test("D04 bind: host and port echoed", async () => {
    const { server, port } = await startMockLdapServer([makeBindResponse(0)]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "bind", timeout: 5,
      });
      assertEqual(result.host, "127.0.0.1");
      assertEqual(result.port, port);
    } finally {
      server.close();
    }
  });

  await test("D05 bind: codeStr is 'success'", async () => {
    const { server, port } = await startMockLdapServer([makeBindResponse(0)]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "bind", timeout: 5,
      });
      assertEqual(result.codeStr, "success");
    } finally {
      server.close();
    }
  });

  // ── D06–D10: search ─────────────────────────────────────────────────────────
  // Search responses are two LDAP messages concatenated (Entry + Done).
  // The mock server receives ONE request (SearchRequest) and must send BOTH
  // Entry and Done back. But the mock currently only responds once per request.
  // For search, the mock needs to send Entry+Done for the single SearchRequest.
  // We pass the concatenated buffer as a single response item.

  await test("D06 search: returns entries", async () => {
    const searchResp = Buffer.concat([
      makeSearchResultEntry("cn=alice,dc=example,dc=com", { cn: ["alice"], mail: ["alice@example.com"] }),
      makeSearchResultDone(0),
    ]);
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      searchResp,
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "search",
        base_dn: "dc=example,dc=com",
        filter: "(cn=alice)",
        attributes: ["cn", "mail"],
        timeout: 5,
      });
      assertEqual(result.operation, "search");
      assertEqual(result.entryCount, 1);
      assertEqual(result.entries[0].dn, "cn=alice,dc=example,dc=com");
      assert(Array.isArray(result.entries[0].attributes.cn));
    } finally {
      server.close();
    }
  });

  await test("D07 search: multiple entries", async () => {
    const searchResp = Buffer.concat([
      makeSearchResultEntry("cn=alice,dc=example,dc=com", { cn: ["alice"] }),
      makeSearchResultEntry("cn=bob,dc=example,dc=com",   { cn: ["bob"] }),
      makeSearchResultDone(0),
    ]);
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      searchResp,
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "search",
        base_dn: "dc=example,dc=com", timeout: 5,
      });
      assertEqual(result.entryCount, 2);
    } finally {
      server.close();
    }
  });

  await test("D08 search: zero entries", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeSearchResultDone(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "search",
        base_dn: "dc=example,dc=com", timeout: 5,
      });
      assertEqual(result.entryCount, 0);
      assertEqual(result.sizeLimitExceeded, false);
    } finally {
      server.close();
    }
  });

  await test("D09 search: sizeLimitExceeded flagged", async () => {
    const searchResp = Buffer.concat([
      makeSearchResultEntry("cn=alice,dc=example,dc=com", { cn: ["alice"] }),
      makeSearchResultDone(4 /* sizeLimitExceeded */),
    ]);
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      searchResp,
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "search",
        base_dn: "dc=example,dc=com", timeout: 5,
      });
      assertEqual(result.sizeLimitExceeded, true);
      assertEqual(result.entryCount, 1);
    } finally {
      server.close();
    }
  });

  await test("D10 search: scope 'base' accepted", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeSearchResultDone(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "search",
        base_dn: "cn=alice,dc=example,dc=com",
        scope: "base", timeout: 5,
      });
      assertEqual(result.entryCount, 0);
    } finally {
      server.close();
    }
  });

  // ── D11–D15: add ────────────────────────────────────────────────────────────

  await test("D11 add: returns added:true", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeAddResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "add",
        dn: "cn=newuser,dc=example,dc=com",
        entry_attributes: { cn: "newuser", objectClass: ["inetOrgPerson", "top"] },
        timeout: 5,
      });
      assertEqual(result.added, true);
      assertEqual(result.dn, "cn=newuser,dc=example,dc=com");
    } finally {
      server.close();
    }
  });

  await test("D12 add: resultCode echoed", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeAddResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "add",
        dn: "cn=x,dc=example,dc=com",
        entry_attributes: { cn: "x" },
        timeout: 5,
      });
      assertEqual(result.resultCode, 0);
      assertEqual(result.codeStr, "success");
    } finally {
      server.close();
    }
  });

  await test("D13 add: array attribute values", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeAddResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "add",
        dn: "cn=x,dc=example,dc=com",
        entry_attributes: { objectClass: ["top", "person", "inetOrgPerson"], cn: "x" },
        timeout: 5,
      });
      assertEqual(result.added, true);
    } finally {
      server.close();
    }
  });

  await test("D14 add: uses bind_dn and bind_password", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeAddResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "add",
        bind_dn: "cn=admin,dc=example,dc=com",
        bind_password: "admin_pass",
        dn: "cn=x,dc=example,dc=com",
        entry_attributes: { cn: "x" },
        timeout: 5,
      });
      assertEqual(result.added, true);
    } finally {
      server.close();
    }
  });

  await test("D15 add: elapsedMs is a number", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeAddResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "add",
        dn: "cn=x,dc=example,dc=com",
        entry_attributes: { cn: "x" },
        timeout: 5,
      });
      assert(typeof result.elapsedMs === "number");
    } finally {
      server.close();
    }
  });

  // ── D16–D20: modify ─────────────────────────────────────────────────────────

  await test("D16 modify: returns modified:true", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeModifyResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "modify",
        dn: "cn=alice,dc=example,dc=com",
        modifications: [{ operation: "replace", attribute: "sn", values: ["Smith"] }],
        timeout: 5,
      });
      assertEqual(result.modified, true);
      assertEqual(result.dn, "cn=alice,dc=example,dc=com");
    } finally {
      server.close();
    }
  });

  await test("D17 modify: add operation", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeModifyResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "modify",
        dn: "cn=alice,dc=example,dc=com",
        modifications: [{ operation: "add", attribute: "mail", values: ["alice@example.com"] }],
        timeout: 5,
      });
      assertEqual(result.modified, true);
    } finally {
      server.close();
    }
  });

  await test("D18 modify: delete operation (no values)", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeModifyResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "modify",
        dn: "cn=alice,dc=example,dc=com",
        modifications: [{ operation: "delete", attribute: "description" }],
        timeout: 5,
      });
      assertEqual(result.modified, true);
    } finally {
      server.close();
    }
  });

  await test("D19 modify: multiple modifications", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeModifyResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "modify",
        dn: "cn=alice,dc=example,dc=com",
        modifications: [
          { operation: "replace", attribute: "sn", values: ["Doe"] },
          { operation: "add",     attribute: "mail", values: ["alice@example.com"] },
        ],
        timeout: 5,
      });
      assertEqual(result.modified, true);
    } finally {
      server.close();
    }
  });

  await test("D20 modify: string value (not array)", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeModifyResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "modify",
        dn: "cn=alice,dc=example,dc=com",
        modifications: [{ operation: "replace", attribute: "sn", values: "Smith" }],
        timeout: 5,
      });
      assertEqual(result.modified, true);
    } finally {
      server.close();
    }
  });

  // ── D21–D25: delete ─────────────────────────────────────────────────────────

  await test("D21 delete: returns deleted:true", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeDeleteResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "delete",
        dn: "cn=alice,dc=example,dc=com",
        timeout: 5,
      });
      assertEqual(result.deleted, true);
      assertEqual(result.dn, "cn=alice,dc=example,dc=com");
    } finally {
      server.close();
    }
  });

  await test("D22 delete: resultCode echoed", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeDeleteResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "delete",
        dn: "cn=x,dc=example,dc=com", timeout: 5,
      });
      assertEqual(result.resultCode, 0);
    } finally {
      server.close();
    }
  });

  await test("D23 delete: codeStr is 'success'", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeDeleteResponse(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "delete",
        dn: "cn=x,dc=example,dc=com", timeout: 5,
      });
      assertEqual(result.codeStr, "success");
    } finally {
      server.close();
    }
  });

  // ── D24–D25: compare ────────────────────────────────────────────────────────

  await test("D24 compare: compareTrue (resultCode=6) returns matched:true", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeCompareResponse(6 /* compareTrue */),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "compare",
        dn: "cn=alice,dc=example,dc=com",
        attribute: "cn", value: "alice",
        timeout: 5,
      });
      assertEqual(result.matched, true);
      assertEqual(result.resultCode, 6);
      assertEqual(result.attribute, "cn");
    } finally {
      server.close();
    }
  });

  await test("D25 compare: compareFalse (resultCode=5) returns matched:false", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeCompareResponse(5 /* compareFalse */),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "compare",
        dn: "cn=alice,dc=example,dc=com",
        attribute: "cn", value: "wrong",
        timeout: 5,
      });
      assertEqual(result.matched, false);
    } finally {
      server.close();
    }
  });

  // ── D26–D30: whoami + misc ───────────────────────────────────────────────────

  await test("D26 whoami: returns authzId", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeExtendedResponse(0, "dn:cn=admin,dc=example,dc=com"),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "whoami",
        bind_dn: "cn=admin,dc=example,dc=com",
        bind_password: "secret",
        timeout: 5,
      });
      assertEqual(result.operation, "whoami");
      assertEqual(result.authzId, "dn:cn=admin,dc=example,dc=com");
    } finally {
      server.close();
    }
  });

  await test("D27 whoami: empty authzId for anonymous", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeExtendedResponse(0, ""),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "whoami", timeout: 5,
      });
      assertEqual(result.authzId, "");
    } finally {
      server.close();
    }
  });

  await test("D28 search: numeric scope=1 accepted", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeSearchResultDone(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "search",
        base_dn: "dc=example,dc=com",
        scope: 1, // one-level
        timeout: 5,
      });
      assertEqual(result.entryCount, 0);
    } finally {
      server.close();
    }
  });

  await test("D29 search: 'one' scope accepted", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeSearchResultDone(0),
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "search",
        base_dn: "dc=example,dc=com",
        scope: "one",
        timeout: 5,
      });
      assertEqual(result.entryCount, 0);
    } finally {
      server.close();
    }
  });

  await test("D30 search: attributes list returned in entries", async () => {
    const searchResp = Buffer.concat([
      makeSearchResultEntry("cn=bob,dc=example,dc=com", {
        cn: ["bob"],
        mail: ["bob@example.com"],
        sn: ["Builder"],
      }),
      makeSearchResultDone(0),
    ]);
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      searchResp,
    ]);
    try {
      const result = await ldapClient({
        host: "127.0.0.1", port, operation: "search",
        base_dn: "dc=example,dc=com",
        attributes: ["cn", "mail"],
        timeout: 5,
      });
      assertEqual(result.entryCount, 1);
      const attrs = result.entries[0].attributes;
      assert(Array.isArray(attrs.cn));
      assert(Array.isArray(attrs.mail));
    } finally {
      server.close();
    }
  });
}

// ── SECTION E: Error Paths ────────────────────────────────────────────────────

async function runSectionE() {
  process.stderr.write("\n[E] Error paths\n");

  await test("E01 ECONNREFUSED on unused port", async () => {
    // Find a port that's definitely not listening, then close the server before connecting
    const portCheck = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });

    await assertRejects(
      () => ldapClient({
        host: "127.0.0.1", port: portCheck, operation: "bind",
        timeout: 3, connect_timeout: 2,
      }),
      "" // any error
    );
  });

  await test("E02 bind failure (invalidCredentials=49) throws", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(49 /* invalidCredentials */),
    ]);
    try {
      await assertRejects(
        () => ldapClient({
          host: "127.0.0.1", port, operation: "bind",
          bind_dn: "cn=admin,dc=example,dc=com",
          bind_password: "wrong",
          timeout: 5,
        }),
        "invalidCredentials"
      );
    } finally {
      server.close();
    }
  });

  await test("E03 search failure (noSuchObject=32) throws", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeSearchResultDone(32 /* noSuchObject */),
    ]);
    try {
      await assertRejects(
        () => ldapClient({
          host: "127.0.0.1", port, operation: "search",
          base_dn: "dc=nonexistent,dc=com",
          timeout: 5,
        }),
        "noSuchObject"
      );
    } finally {
      server.close();
    }
  });

  await test("E04 delete failure (noSuchObject=32) throws", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeDeleteResponse(32 /* noSuchObject */),
    ]);
    try {
      await assertRejects(
        () => ldapClient({
          host: "127.0.0.1", port, operation: "delete",
          dn: "cn=ghost,dc=example,dc=com",
          timeout: 5,
        }),
        "noSuchObject"
      );
    } finally {
      server.close();
    }
  });

  await test("E05 compare: non-compare result code throws", async () => {
    const { server, port } = await startMockLdapServer([
      makeBindResponse(0),
      makeCompareResponse(32 /* noSuchObject, invalid for compare */),
    ]);
    try {
      await assertRejects(
        () => ldapClient({
          host: "127.0.0.1", port, operation: "compare",
          dn: "cn=ghost,dc=example,dc=com",
          attribute: "cn", value: "ghost",
          timeout: 5,
        }),
        "compare failed"
      );
    } finally {
      server.close();
    }
  });
}

// ── SECTION F: Concurrency ────────────────────────────────────────────────────

async function runSectionF() {
  process.stderr.write("\n[F] Concurrency\n");

  async function runSingleBind() {
    const { server, port } = await startMockLdapServer([makeBindResponse(0)]);
    try {
      const result = await ldapClient({ host: "127.0.0.1", port, operation: "bind", timeout: 5 });
      return result.bound;
    } finally {
      server.close();
    }
  }

  await test("F01 5 concurrent bind operations", async () => {
    const results = await Promise.all([runSingleBind(), runSingleBind(), runSingleBind(), runSingleBind(), runSingleBind()]);
    assert(results.every(r => r === true), "All concurrent binds should succeed");
  });

  await test("F02 10 concurrent search operations", async () => {
    async function runSearch() {
      const searchResp = Buffer.concat([
        makeSearchResultEntry("cn=alice,dc=example,dc=com", { cn: ["alice"] }),
        makeSearchResultDone(0),
      ]);
      const { server, port } = await startMockLdapServer([
        makeBindResponse(0),
        searchResp,
      ]);
      try {
        const result = await ldapClient({
          host: "127.0.0.1", port, operation: "search",
          base_dn: "dc=example,dc=com", timeout: 5,
        });
        return result.entryCount;
      } finally {
        server.close();
      }
    }
    const results = await Promise.all(Array.from({ length: 10 }, runSearch));
    assert(results.every(r => r === 1));
  });

  await test("F03 concurrent add + search interleaved", async () => {
    async function doAdd() {
      const { server, port } = await startMockLdapServer([
        makeBindResponse(0), makeAddResponse(0),
      ]);
      try {
        const r = await ldapClient({
          host: "127.0.0.1", port, operation: "add",
          dn: "cn=x,dc=example,dc=com",
          entry_attributes: { cn: "x" }, timeout: 5,
        });
        return r.added;
      } finally { server.close(); }
    }
    async function doSearch() {
      const { server, port } = await startMockLdapServer([
        makeBindResponse(0), makeSearchResultDone(0),
      ]);
      try {
        const r = await ldapClient({
          host: "127.0.0.1", port, operation: "search",
          base_dn: "dc=example,dc=com", timeout: 5,
        });
        return r.entryCount;
      } finally { server.close(); }
    }
    const [added, count] = await Promise.all([doAdd(), doSearch()]);
    assertEqual(added, true);
    assertEqual(count, 0);
  });

  await test("F04 concurrent failures don't affect other operations", async () => {
    async function failingBind() {
      const { server, port } = await startMockLdapServer([makeBindResponse(49)]);
      try {
        await ldapClient({
          host: "127.0.0.1", port, operation: "bind",
          bind_password: "wrong", timeout: 5,
        });
        return false; // should not reach
      } catch (_) {
        return true; // expected
      } finally {
        server.close();
      }
    }
    const results = await Promise.all([failingBind(), failingBind(), runSingleBind(), runSingleBind()]);
    assert(results[0] === true, "first should fail");
    assert(results[1] === true, "second should fail");
    assert(results[2] === true, "third should succeed");
    assert(results[3] === true, "fourth should succeed");
  });

  await test("F05 20 concurrent binds (stress)", async () => {
    const N = 20;
    const all = await Promise.all(Array.from({ length: N }, runSingleBind));
    assert(all.every(b => b === true), "All stress binds should succeed");
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  process.stderr.write("\n=== Section 197: ldap_client ===\n");

  await runSectionA();
  await runSectionB();
  await runSectionC();
  await runSectionD();
  await runSectionE();
  await runSectionF();

  const total = passed + failed;
  process.stderr.write(`\n\nResults: ${passed}/${total} passed`);
  if (failed > 0) {
    process.stderr.write(` (${failed} FAILED)\n`);
    for (const e of errors)
      process.stderr.write(`  FAIL: ${e.name}\n       ${e.error}\n`);
    process.exit(1);
  } else {
    process.stderr.write(" (all passed)\n");
  }
})();
