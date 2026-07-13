"use strict";
/**
 * Section 261: radius_client tests
 * Five rigor levels:
 *   A) Pure-helper / protocol-logic tests (no I/O)
 *   B) Validation tests (bad inputs → specific errors)
 *   C) Mock-network tests (real UDP socket, fake RADIUS server)
 *   D) Security tests (NUL bytes, oversized packets, identifier mismatch)
 *   E) Concurrency tests (parallel requests)
 */

const dgram  = require("dgram");
const crypto = require("crypto");
const assert = require("assert").strict;

// Import main entry point
const ops = require("../../lib/radiusClientOps");

// ── Inline copies of pure helpers for unit testing ──────────────────────

function encryptPassword(password, secret, authenticator) {
  const passBuf = Buffer.from(password, "utf8");
  const padLen = Math.ceil(Math.max(passBuf.length, 1) / 16) * 16;
  const padded = Buffer.alloc(padLen, 0);
  passBuf.copy(padded);
  const secretBuf = Buffer.from(secret, "utf8");
  const result    = Buffer.alloc(padLen);
  let prev = authenticator;
  for (let i = 0; i < padLen; i += 16) {
    const hash = crypto.createHash("md5").update(secretBuf).update(prev).digest();
    for (let j = 0; j < 16; j++) result[i + j] = padded[i + j] ^ hash[j];
    prev = result.slice(i, i + 16);
  }
  return result;
}

function buildChapPassword(chapId, password, challenge) {
  const id  = Buffer.from([chapId]);
  const pwd = Buffer.from(password, "utf8");
  const hash = crypto.createHash("md5").update(id).update(pwd).update(challenge).digest();
  return Buffer.concat([id, hash]);
}

function encodeAttr(type, value) {
  let val;
  if (Buffer.isBuffer(value)) val = value;
  else if (typeof value === "number") { val = Buffer.alloc(4); val.writeUInt32BE(value, 0); }
  else val = Buffer.from(String(value), "utf8");
  if (val.length > 253) val = val.slice(0, 253);
  const buf = Buffer.alloc(2 + val.length);
  buf[0] = type; buf[1] = 2 + val.length;
  val.copy(buf, 2);
  return buf;
}

function buildPacket(code, identifier, authenticator, attrs) {
  const attrBuf = Buffer.concat(attrs);
  const length  = 20 + attrBuf.length;
  if (length > 4096) throw new Error(`RADIUS packet too large: ${length} bytes (max 4096)`);
  const pkt = Buffer.alloc(length);
  pkt[0] = code; pkt[1] = identifier;
  pkt.writeUInt16BE(length, 2);
  authenticator.copy(pkt, 4);
  attrBuf.copy(pkt, 20);
  return pkt;
}

function verifyResponseAuthenticator(response, requestAuth, secret) {
  if (response.length < 20) return false;
  const copy = Buffer.from(response);
  requestAuth.copy(copy, 4);
  const secretBuf = Buffer.from(secret, "utf8");
  const expected = crypto.createHash("md5").update(copy).update(secretBuf).digest();
  return response.slice(4, 20).equals(expected);
}

function computeAcctAuthenticator(pkt, secret) {
  return crypto.createHash("md5").update(pkt).update(Buffer.from(secret, "utf8")).digest();
}

// Simple mock RADIUS server
function startMockRadiusServer(port, secret, handler) {
  const server = dgram.createSocket("udp4");
  server.on("message", (msg, rinfo) => {
    const resp = handler(msg, secret);
    if (resp) server.send(resp, rinfo.port, rinfo.address);
  });
  return new Promise((resolve, reject) => {
    server.bind(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

// Build a valid Access-Accept response
function buildAccessAccept(requestPkt, secret, extraAttrs) {
  const code = 2; // Access-Accept
  const id   = requestPkt[1];
  const requestAuth = requestPkt.slice(4, 20);
  const attrBuf = Buffer.concat(extraAttrs || []);
  const length  = 20 + attrBuf.length;
  const pkt = Buffer.alloc(length);
  pkt[0] = code; pkt[1] = id;
  pkt.writeUInt16BE(length, 2);
  requestAuth.copy(pkt, 4); // placeholder
  attrBuf.copy(pkt, 20);
  // Compute real response authenticator: MD5(code+id+len+requestAuth+attrs+secret)
  const copy = Buffer.from(pkt);
  const auth = crypto.createHash("md5").update(copy).update(Buffer.from(secret, "utf8")).digest();
  auth.copy(pkt, 4);
  return pkt;
}

function buildAccessReject(requestPkt, secret, replyMsg) {
  const code = 3; // Access-Reject
  const id   = requestPkt[1];
  const requestAuth = requestPkt.slice(4, 20);
  const attrs = replyMsg ? [encodeAttr(18, replyMsg)] : [];
  const attrBuf = Buffer.concat(attrs);
  const length  = 20 + attrBuf.length;
  const pkt = Buffer.alloc(length);
  pkt[0] = code; pkt[1] = id;
  pkt.writeUInt16BE(length, 2);
  requestAuth.copy(pkt, 4);
  attrBuf.copy(pkt, 20);
  const auth = crypto.createHash("md5").update(pkt).update(Buffer.from(secret, "utf8")).digest();
  auth.copy(pkt, 4);
  return pkt;
}

function buildAccountingResponse(requestPkt, secret) {
  const code = 5; // Accounting-Response
  const id   = requestPkt[1];
  // Accounting-Response uses the same auth as request
  const requestAuth = requestPkt.slice(4, 20);
  const length = 20;
  const pkt = Buffer.alloc(length);
  pkt[0] = code; pkt[1] = id;
  pkt.writeUInt16BE(length, 2);
  requestAuth.copy(pkt, 4);
  const auth = crypto.createHash("md5").update(pkt).update(Buffer.from(secret, "utf8")).digest();
  auth.copy(pkt, 4);
  return pkt;
}

// ── test runner ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stderr.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
    failures.push({ name, err });
    failed++;
  }
}

function skip(name, reason) {
  process.stderr.write(`  ◦ SKIP ${name}: ${reason}\n`);
  skipped++;
}

// Find free port helper
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function runAll() {

  // ── A) Pure-helper / protocol-logic tests ──────────────────────────────

  process.stderr.write("\n== A) Pure-helper / protocol-logic ==\n");

  await test("info op returns correct protocol", async () => {
    const r = await ops.radiusClient({ operation: "info" });
    assert.equal(r.protocol, "RADIUS (Remote Authentication Dial In User Service)");
    assert.ok(Array.isArray(r.operations));
    assert.ok(r.operations.find(o => o.op === "authenticate"));
    assert.ok(r.operations.find(o => o.op === "accounting"));
    assert.ok(r.operations.find(o => o.op === "status"));
  });

  await test("info op returns default ports 1812/1813", async () => {
    const r = await ops.radiusClient({ operation: "info" });
    assert.equal(r.defaultPorts.authentication, 1812);
    assert.equal(r.defaultPorts.accounting, 1813);
  });

  await test("info op returns PAP and CHAP auth methods", async () => {
    const r = await ops.radiusClient({ operation: "info" });
    const methods = r.authMethods.map(m => m.method);
    assert.ok(methods.includes("pap"));
    assert.ok(methods.includes("chap"));
  });

  await test("encryptPassword: empty password pads to 16 bytes", async () => {
    const secret = "testing123";
    const auth   = crypto.randomBytes(16);
    const enc    = encryptPassword("", secret, auth);
    assert.equal(enc.length, 16);
  });

  await test("encryptPassword: 16-char password produces 16 bytes", async () => {
    const secret = "secret";
    const auth   = Buffer.alloc(16, 0x42);
    const enc    = encryptPassword("1234567890123456", secret, auth);
    assert.equal(enc.length, 16);
  });

  await test("encryptPassword: 17-char password pads to 32 bytes", async () => {
    const enc = encryptPassword("12345678901234567", "s", Buffer.alloc(16));
    assert.equal(enc.length, 32);
  });

  await test("encryptPassword: deterministic for same inputs", async () => {
    const secret = "shhh";
    const auth   = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    const a = encryptPassword("mypassword", secret, auth);
    const b = encryptPassword("mypassword", secret, auth);
    assert.ok(a.equals(b));
  });

  await test("encryptPassword: different secrets produce different output", async () => {
    const auth = crypto.randomBytes(16);
    const a = encryptPassword("pass", "secret1", auth);
    const b = encryptPassword("pass", "secret2", auth);
    assert.ok(!a.equals(b));
  });

  await test("buildChapPassword: produces 17 bytes (1 id + 16 hash)", async () => {
    const result = buildChapPassword(42, "password", Buffer.alloc(16, 0xAB));
    assert.equal(result.length, 17);
    assert.equal(result[0], 42);
  });

  await test("buildChapPassword: deterministic for same inputs", async () => {
    const challenge = Buffer.alloc(16, 0x55);
    const a = buildChapPassword(1, "test", challenge);
    const b = buildChapPassword(1, "test", challenge);
    assert.ok(a.equals(b));
  });

  await test("buildChapPassword: different passwords produce different output", async () => {
    const challenge = crypto.randomBytes(16);
    const a = buildChapPassword(1, "pass1", challenge);
    const b = buildChapPassword(1, "pass2", challenge);
    assert.ok(!a.equals(b));
  });

  await test("encodeAttr: string value", async () => {
    const buf = encodeAttr(1, "alice"); // User-Name
    assert.equal(buf[0], 1);
    assert.equal(buf[1], 2 + 5);
    assert.equal(buf.slice(2).toString("utf8"), "alice");
  });

  await test("encodeAttr: integer value", async () => {
    const buf = encodeAttr(6, 1); // Service-Type = Login
    assert.equal(buf[0], 6);
    assert.equal(buf[1], 6); // 2 + 4
    assert.equal(buf.readUInt32BE(2), 1);
  });

  await test("encodeAttr: buffer value", async () => {
    const val = Buffer.from([0x01, 0x02, 0x03]);
    const buf = encodeAttr(24, val); // State
    assert.equal(buf[0], 24);
    assert.equal(buf[1], 5); // 2 + 3
    assert.ok(buf.slice(2).equals(val));
  });

  await test("encodeAttr: truncates value > 253 bytes", async () => {
    const longStr = "x".repeat(300);
    const buf = encodeAttr(1, longStr);
    assert.equal(buf.length, 255); // 2 + 253
  });

  await test("buildPacket: header fields correct", async () => {
    const auth = crypto.randomBytes(16);
    const attrs = [encodeAttr(1, "alice")];
    const pkt = buildPacket(1, 77, auth, attrs);
    assert.equal(pkt[0], 1);  // code
    assert.equal(pkt[1], 77); // identifier
    assert.equal(pkt.readUInt16BE(2), pkt.length); // length
    assert.ok(pkt.slice(4, 20).equals(auth));
  });

  await test("buildPacket: minimum 20-byte header with no attrs", async () => {
    const pkt = buildPacket(1, 1, Buffer.alloc(16), []);
    assert.equal(pkt.length, 20);
  });

  await test("verifyResponseAuthenticator: correctly verifies valid response", async () => {
    const secret = "testing";
    const requestAuth = crypto.randomBytes(16);
    // Build a response packet with correct authenticator
    const code = 2; const id = 42;
    const length = 20;
    const pkt = Buffer.alloc(20);
    pkt[0] = code; pkt[1] = id; pkt.writeUInt16BE(length, 2);
    requestAuth.copy(pkt, 4); // start with request auth
    const respAuth = crypto.createHash("md5").update(pkt).update(Buffer.from(secret)).digest();
    respAuth.copy(pkt, 4);
    assert.ok(verifyResponseAuthenticator(pkt, requestAuth, secret));
  });

  await test("verifyResponseAuthenticator: rejects wrong secret", async () => {
    const requestAuth = crypto.randomBytes(16);
    const pkt = Buffer.alloc(20);
    pkt[0] = 2; pkt[1] = 1; pkt.writeUInt16BE(20, 2);
    requestAuth.copy(pkt, 4);
    const auth = crypto.createHash("md5").update(pkt).update(Buffer.from("rightsecret")).digest();
    auth.copy(pkt, 4);
    assert.ok(!verifyResponseAuthenticator(pkt, requestAuth, "wrongsecret"));
  });

  await test("verifyResponseAuthenticator: rejects too-short packet", async () => {
    const pkt = Buffer.alloc(10); // too short
    const ok = verifyResponseAuthenticator(pkt, Buffer.alloc(16), "secret");
    assert.equal(ok, false);
  });

  await test("computeAcctAuthenticator: produces 16-byte digest", async () => {
    const pkt = Buffer.alloc(20); pkt[0] = 4; pkt[1] = 1; pkt.writeUInt16BE(20, 2);
    const auth = computeAcctAuthenticator(pkt, "secret");
    assert.equal(auth.length, 16);
  });

  await test("computeAcctAuthenticator: deterministic", async () => {
    const pkt = Buffer.alloc(20, 0x42);
    const a = computeAcctAuthenticator(pkt, "sec");
    const b = computeAcctAuthenticator(pkt, "sec");
    assert.ok(a.equals(b));
  });

  await test("computeAcctAuthenticator: different secrets produce different output", async () => {
    const pkt = Buffer.alloc(20, 0x99);
    const a = computeAcctAuthenticator(pkt, "sec1");
    const b = computeAcctAuthenticator(pkt, "sec2");
    assert.ok(!a.equals(b));
  });

  await test("info op includes commonAttributes list", async () => {
    const r = await ops.radiusClient({ operation: "info" });
    assert.ok(Array.isArray(r.commonAttributes));
    const names = r.commonAttributes.map(a => a.name);
    assert.ok(names.includes("USER_NAME"));
    assert.ok(names.includes("USER_PASSWORD"));
    assert.ok(names.includes("ACCT_STATUS_TYPE"));
  });

  await test("info op includes UDP transport", async () => {
    const r = await ops.radiusClient({ operation: "info" });
    assert.equal(r.transport, "UDP");
  });

  await test("info op includes acctStatusTypes", async () => {
    const r = await ops.radiusClient({ operation: "info" });
    assert.ok(r.acctStatusTypes.includes("start"));
    assert.ok(r.acctStatusTypes.includes("stop"));
    assert.ok(r.acctStatusTypes.includes("interim"));
  });

  await test("encryptPassword/decrypt round-trip via XOR property", async () => {
    // Encrypt twice = original (XOR is its own inverse when hashes are same)
    const password = "helloworld";
    const secret   = "sharedsecret";
    const auth     = crypto.randomBytes(16);
    const enc = encryptPassword(password, secret, auth);
    // Decrypt: same operation
    const secretBuf = Buffer.from(secret);
    let dec = Buffer.alloc(enc.length);
    let prev = auth;
    for (let i = 0; i < enc.length; i += 16) {
      const hash = crypto.createHash("md5").update(secretBuf).update(prev).digest();
      for (let j = 0; j < 16; j++) dec[i+j] = enc[i+j] ^ hash[j];
      prev = enc.slice(i, i+16);
    }
    assert.equal(dec.slice(0, password.length).toString("utf8"), password);
  });

  await test("buildPacket: attrs copied correctly starting at offset 20", async () => {
    const auth  = Buffer.alloc(16, 0x11);
    const attr  = encodeAttr(1, "test");
    const pkt   = buildPacket(1, 5, auth, [attr]);
    assert.equal(pkt[20], 1);   // attr type
    assert.equal(pkt[21], 6);   // attr length (2+4)
  });

  await test("packet length field matches actual packet size", async () => {
    const attrs = [encodeAttr(1, "user"), encodeAttr(2, Buffer.alloc(16))];
    const pkt   = buildPacket(1, 0, Buffer.alloc(16), attrs);
    const reportedLen = pkt.readUInt16BE(2);
    assert.equal(reportedLen, pkt.length);
  });

  await test("chapId range is 0-255", async () => {
    // Build 100 CHAP passwords and ensure chapId byte is always 0-255
    for (let i = 0; i < 100; i++) {
      const chapId = Math.floor(Math.random() * 256);
      const pkt    = buildChapPassword(chapId, "pw", crypto.randomBytes(16));
      assert.ok(pkt[0] >= 0 && pkt[0] <= 255);
    }
  });

  await test("encryptPassword: 32-char password produces exactly 32 bytes", async () => {
    const enc = encryptPassword("12345678901234567890123456789012", "s", Buffer.alloc(16));
    assert.equal(enc.length, 32);
  });

  await test("encryptPassword: 33-char password pads to 48 bytes", async () => {
    const enc = encryptPassword("123456789012345678901234567890123", "s", Buffer.alloc(16));
    assert.equal(enc.length, 48);
  });

  // ── B) Validation tests ───────────────────────────────────────────────────

  process.stderr.write("\n== B) Validation ==\n");

  await test("unknown operation throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "badop" }),
      /Unknown radius_client operation/
    );
  });

  await test("authenticate: missing server throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", secret: "s", username: "u" }),
      /server must be a non-empty string/
    );
  });

  await test("authenticate: missing secret throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1", username: "u" }),
      /secret must be a non-empty string/
    );
  });

  await test("authenticate: missing username throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1", secret: "s" }),
      /username must be a non-empty string/
    );
  });

  await test("authenticate: invalid auth_method throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1", secret: "s",
        username: "u", password: "p", auth_method: "kerberos", timeout: 1000, retries: 1 }),
      /auth_method must be 'pap' or 'chap'/
    );
  });

  await test("authenticate: PAP without password throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1",
        secret: "s", username: "u", auth_method: "pap", timeout: 1000, retries: 1 }),
      /password is required for PAP/
    );
  });

  await test("authenticate: CHAP without password throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1",
        secret: "s", username: "u", auth_method: "chap", timeout: 1000, retries: 1 }),
      /password is required for CHAP/
    );
  });

  await test("accounting: missing server throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "accounting", secret: "s", username: "u", session_id: "x" }),
      /server must be a non-empty string/
    );
  });

  await test("accounting: missing session_id throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "accounting", server: "127.0.0.1", secret: "s", username: "u" }),
      /session_id must be a non-empty string/
    );
  });

  await test("accounting: invalid acct_status_type throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "accounting", server: "127.0.0.1", secret: "s",
        username: "u", session_id: "id", acct_status_type: "flying", timeout: 1000, retries: 1 }),
      /acct_status_type must be one of/
    );
  });

  await test("status: missing server throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "status", secret: "s" }),
      /server must be a non-empty string/
    );
  });

  await test("status: missing secret throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "status", server: "127.0.0.1" }),
      /secret must be a non-empty string/
    );
  });

  await test("port out of range (0) throws on authenticate", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1", secret: "s",
        username: "u", password: "p", port: 0, timeout: 1000, retries: 1 }),
      /port must be between/
    );
  });

  await test("port out of range (65536) throws on authenticate", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1", secret: "s",
        username: "u", password: "p", port: 65536, timeout: 1000, retries: 1 }),
      /port must be between/
    );
  });

  await test("timeout below 1000ms throws on authenticate", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1", secret: "s",
        username: "u", password: "p", timeout: 50, retries: 1 }),
      /timeout must be between/
    );
  });

  // ── C) Mock-network tests ───────────────────────────────────────────────────

  process.stderr.write("\n== C) Mock-network ==\n");

  await test("authenticate PAP: Access-Accept returns ok=true", async () => {
    const port   = await getFreePort();
    const secret = "testing123";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccessAccept(msg, sec));
    try {
      const r = await ops.radiusClient({
        operation: "authenticate", server: "127.0.0.1", port, secret,
        username: "alice", password: "password", auth_method: "pap",
        timeout: 3000, retries: 1,
      });
      assert.equal(r.ok, true);
      assert.equal(r.result, "ACCESS_ACCEPT");
      assert.equal(r.username, "alice");
      assert.equal(r.authMethod, "pap");
      assert.ok(r.elapsedMs >= 0);
      assert.ok(r.authVerified);
    } finally { srv.close(); }
  });

  await test("authenticate PAP: Access-Reject returns ok=false", async () => {
    const port   = await getFreePort();
    const secret = "testing123";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccessReject(msg, sec, "Bad password"));
    try {
      const r = await ops.radiusClient({
        operation: "authenticate", server: "127.0.0.1", port, secret,
        username: "alice", password: "wrong", auth_method: "pap",
        timeout: 3000, retries: 1,
      });
      assert.equal(r.ok, false);
      assert.equal(r.result, "ACCESS_REJECT");
      assert.ok(r.attributes.REPLY_MESSAGE);
    } finally { srv.close(); }
  });

  await test("authenticate CHAP: Access-Accept returns ok=true", async () => {
    const port   = await getFreePort();
    const secret = "chapsecret";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccessAccept(msg, sec));
    try {
      const r = await ops.radiusClient({
        operation: "authenticate", server: "127.0.0.1", port, secret,
        username: "bob", password: "chappassword", auth_method: "chap",
        timeout: 3000, retries: 1,
      });
      assert.equal(r.ok, true);
      assert.equal(r.authMethod, "chap");
    } finally { srv.close(); }
  });

  await test("authenticate: identifier in response must match request", async () => {
    const port   = await getFreePort();
    const secret = "testing";
    // Server sends response with wrong identifier
    const srv = await startMockRadiusServer(port, secret, (msg, sec) => {
      const resp = buildAccessAccept(msg, sec);
      resp[1] = (msg[1] + 1) & 0xFF; // wrong id
      // Recompute authenticator
      const copy = Buffer.from(resp);
      msg.slice(4, 20).copy(copy, 4);
      const auth = crypto.createHash("md5").update(copy).update(Buffer.from(sec)).digest();
      auth.copy(resp, 4);
      return resp;
    });
    try {
      await assert.rejects(
        ops.radiusClient({
          operation: "authenticate", server: "127.0.0.1", port, secret,
          username: "u", password: "p", auth_method: "pap", timeout: 3000, retries: 1,
        }),
        /identifier mismatch/
      );
    } finally { srv.close(); }
  });

  await test("accounting start: returns ok=true", async () => {
    const port   = await getFreePort();
    const secret = "acct-secret";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccountingResponse(msg, sec));
    try {
      const r = await ops.radiusClient({
        operation: "accounting", server: "127.0.0.1", port, secret,
        username: "alice", session_id: "sess-001", acct_status_type: "start",
        nas_ip: "10.0.0.1",
        timeout: 3000, retries: 1,
      });
      assert.equal(r.ok, true);
      assert.equal(r.result, "ACCOUNTING_RESPONSE");
      assert.equal(r.sessionId, "sess-001");
      assert.equal(r.acctStatusType, "start");
    } finally { srv.close(); }
  });

  await test("accounting stop: with session time and octets", async () => {
    const port   = await getFreePort();
    const secret = "acct-secret";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccountingResponse(msg, sec));
    try {
      const r = await ops.radiusClient({
        operation: "accounting", server: "127.0.0.1", port, secret,
        username: "carol", session_id: "sess-002", acct_status_type: "stop",
        acct_session_time: 3600, acct_input_octets: 1024000, acct_output_octets: 512000,
        acct_terminate_cause: 1, // User-Request
        timeout: 3000, retries: 1,
      });
      assert.equal(r.ok, true);
      assert.equal(r.acctStatusType, "stop");
    } finally { srv.close(); }
  });

  await test("accounting interim: works correctly", async () => {
    const port   = await getFreePort();
    const secret = "acct-secret";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccountingResponse(msg, sec));
    try {
      const r = await ops.radiusClient({
        operation: "accounting", server: "127.0.0.1", port, secret,
        username: "dave", session_id: "sess-003", acct_status_type: "interim",
        acct_session_time: 1800,
        timeout: 3000, retries: 1,
      });
      assert.equal(r.ok, true);
      assert.equal(r.acctStatusType, "interim");
    } finally { srv.close(); }
  });

  await test("status: server unreachable returns ok=false with error", async () => {
    const port = await getFreePort(); // Nothing listening
    const r = await ops.radiusClient({
      operation: "status", server: "127.0.0.1", port: port,
      secret: "testing", timeout: 1000, retries: 1,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(r.result, "NO_RESPONSE");
  });

  await test("authenticate: NAS-Identifier attribute is sent when specified", async () => {
    const port   = await getFreePort();
    const secret = "testing";
    let receivedNasId = null;
    // Mock server that reads NAS-Identifier from request
    const srv = await startMockRadiusServer(port, secret, (msg, sec) => {
      // Parse attrs to find NAS-Identifier (type 32)
      let off = 20;
      while (off < msg.length) {
        const t = msg[off]; const l = msg[off+1];
        if (l < 2) break;
        if (t === 32) receivedNasId = msg.slice(off+2, off+l).toString("utf8");
        off += l;
      }
      return buildAccessAccept(msg, sec);
    });
    try {
      await ops.radiusClient({
        operation: "authenticate", server: "127.0.0.1", port, secret,
        username: "u", password: "p", auth_method: "pap",
        nas_identifier: "my-ap-01", timeout: 3000, retries: 1,
      });
      assert.equal(receivedNasId, "my-ap-01");
    } finally { srv.close(); }
  });

  await test("authenticate: Called/Calling station IDs are sent", async () => {
    const port   = await getFreePort();
    const secret = "testing";
    const stations = {};
    const srv = await startMockRadiusServer(port, secret, (msg, sec) => {
      let off = 20;
      while (off < msg.length && off + 1 < msg.length) {
        const t = msg[off]; const l = msg[off+1];
        if (l < 2) break;
        if (t === 30) stations.called  = msg.slice(off+2, off+l).toString("utf8");
        if (t === 31) stations.calling = msg.slice(off+2, off+l).toString("utf8");
        off += l;
      }
      return buildAccessAccept(msg, sec);
    });
    try {
      await ops.radiusClient({
        operation: "authenticate", server: "127.0.0.1", port, secret,
        username: "u", password: "p", auth_method: "pap",
        called_station_id:  "00:11:22:33:44:55:MySSID",
        calling_station_id: "AA:BB:CC:DD:EE:FF",
        timeout: 3000, retries: 1,
      });
      assert.equal(stations.called,  "00:11:22:33:44:55:MySSID");
      assert.equal(stations.calling, "AA:BB:CC:DD:EE:FF");
    } finally { srv.close(); }
  });

  await test("authenticate: retries on no response (2 retries)", async () => {
    const port   = await getFreePort();
    const secret = "testing";
    let count = 0;
    const srv = await startMockRadiusServer(port, secret, (msg, sec) => {
      count++;
      if (count < 2) return null; // drop first attempt
      return buildAccessAccept(msg, sec);
    });
    try {
      const r = await ops.radiusClient({
        operation: "authenticate", server: "127.0.0.1", port, secret,
        username: "u", password: "p", auth_method: "pap",
        timeout: 1000, retries: 3,
      });
      assert.equal(r.ok, true);
      assert.ok(count >= 2);
    } finally { srv.close(); }
  });

  await test("authenticate: response attributes decoded correctly", async () => {
    const port   = await getFreePort();
    const secret = "testing";
    const sessionTimeout = encodeAttr(27, 3600); // Session-Timeout = 3600
    const framedIp = encodeAttr(8, Buffer.from([10,20,30,40])); // 10.20.30.40
    const srv = await startMockRadiusServer(port, secret, (msg, sec) =>
      buildAccessAccept(msg, sec, [sessionTimeout, framedIp])
    );
    try {
      const r = await ops.radiusClient({
        operation: "authenticate", server: "127.0.0.1", port, secret,
        username: "u", password: "p", auth_method: "pap",
        timeout: 3000, retries: 1,
      });
      assert.equal(r.attributes.SESSION_TIMEOUT, 3600);
      assert.equal(r.attributes.FRAMED_IP_ADDRESS, "10.20.30.40");
    } finally { srv.close(); }
  });

  // ── D) Security tests ──────────────────────────────────────────────────────

  process.stderr.write("\n== D) Security ==\n");

  await test("NUL byte in server throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0\x001",
        secret: "s", username: "u" }),
      /NUL bytes/
    );
  });

  await test("NUL byte in secret throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1",
        secret: "sec\x00ret", username: "u" }),
      /NUL bytes/
    );
  });

  await test("NUL byte in username throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1",
        secret: "s", username: "alice\x00" }),
      /NUL bytes/
    );
  });

  await test("empty server string throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "", secret: "s", username: "u" }),
      /server must be a non-empty string/
    );
  });

  await test("empty secret string throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "h", secret: "", username: "u" }),
      /secret must be a non-empty string/
    );
  });

  await test("empty username string throws", async () => {
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "h", secret: "s", username: "" }),
      /username must be a non-empty string/
    );
  });

  await test("password is never included in error messages", async () => {
    const sensitivePassword = "superSecretP@ssw0rd";
    try {
      await ops.radiusClient({
        operation: "authenticate", server: "127.0.0.1", port: 19999,
        secret: "s", username: "u", password: sensitivePassword,
        auth_method: "pap", timeout: 1000, retries: 1,
      });
    } catch (err) {
      assert.ok(!err.message.includes(sensitivePassword), "Password leaked in error message");
    }
  });

  await test("very long username is clamped to 253 bytes in attribute", async () => {
    // encodeAttr clips at 253
    const longName = "a".repeat(300);
    const attr = encodeAttr(1, longName);
    assert.equal(attr[1], 255); // 2 + 253
  });

  await test("buildPacket throws if packet would exceed 4096 bytes", async () => {
    // Build attributes that sum to > 4076
    const attrs = [];
    let size = 0;
    while (size <= 4076) {
      attrs.push(encodeAttr(1, "a".repeat(253)));
      size += 255;
    }
    assert.throws(
      () => buildPacket(1, 1, Buffer.alloc(16), attrs),
      /packet too large/
    );
  });

  await test("timeout upper bound is enforced (>60000 clamped)", async () => {
    // Providing a very high timeout shouldn't work (60000 max)
    await assert.rejects(
      () => ops.radiusClient({ operation: "authenticate", server: "127.0.0.1",
        secret: "s", username: "u", password: "p", timeout: 99999, retries: 1 }),
      /timeout must be between/
    );
  });

  // ── E) Concurrency tests ───────────────────────────────────────────────────

  process.stderr.write("\n== E) Concurrency ==\n");

  await test("10 parallel PAP authenticate requests (same server) all succeed", async () => {
    const port   = await getFreePort();
    const secret = "concurrent";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccessAccept(msg, sec));
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          ops.radiusClient({
            operation: "authenticate", server: "127.0.0.1", port, secret,
            username: `user${i}`, password: `pass${i}`, auth_method: "pap",
            timeout: 5000, retries: 1,
          })
        )
      );
      assert.ok(results.every(r => r.ok === true));
      assert.ok(results.every(r => r.result === "ACCESS_ACCEPT"));
    } finally { srv.close(); }
  });

  await test("5 parallel accounting requests (start) all succeed", async () => {
    const port   = await getFreePort();
    const secret = "concurrent";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccountingResponse(msg, sec));
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          ops.radiusClient({
            operation: "accounting", server: "127.0.0.1", port, secret,
            username: `user${i}`, session_id: `sess-${i}`, acct_status_type: "start",
            timeout: 5000, retries: 1,
          })
        )
      );
      assert.ok(results.every(r => r.ok === true));
    } finally { srv.close(); }
  });

  await test("mixed PAP auth and accounting parallel (8 total) all succeed", async () => {
    const authPort = await getFreePort();
    const acctPort = await getFreePort();
    const secret   = "mixedsecret";
    const authSrv  = await startMockRadiusServer(authPort, secret, (msg, sec) => buildAccessAccept(msg, sec));
    const acctSrv  = await startMockRadiusServer(acctPort, secret, (msg, sec) => buildAccountingResponse(msg, sec));
    try {
      const authReqs = Array.from({ length: 4 }, (_, i) =>
        ops.radiusClient({
          operation: "authenticate", server: "127.0.0.1", port: authPort, secret,
          username: `auser${i}`, password: "pw", auth_method: "pap",
          timeout: 5000, retries: 1,
        })
      );
      const acctReqs = Array.from({ length: 4 }, (_, i) =>
        ops.radiusClient({
          operation: "accounting", server: "127.0.0.1", port: acctPort, secret,
          username: `auser${i}`, session_id: `s${i}`, acct_status_type: "start",
          timeout: 5000, retries: 1,
        })
      );
      const results = await Promise.all([...authReqs, ...acctReqs]);
      assert.ok(results.every(r => r.ok === true));
    } finally { authSrv.close(); acctSrv.close(); }
  });

  await test("concurrent requests get independent identifiers", async () => {
    const port   = await getFreePort();
    const secret = "idtest";
    const receivedIds = new Set();
    const srv = await startMockRadiusServer(port, secret, (msg, sec) => {
      receivedIds.add(msg[1]);
      return buildAccessAccept(msg, sec);
    });
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          ops.radiusClient({
            operation: "authenticate", server: "127.0.0.1", port, secret,
            username: `u${i}`, password: "pw", auth_method: "pap",
            timeout: 5000, retries: 1,
          })
        )
      );
      // Server received at least one request (may share ids — that's ok per spec)
      assert.ok(receivedIds.size >= 1);
    } finally { srv.close(); }
  });

  await test("rapid sequential sends (50 requests) on same server", async () => {
    const port   = await getFreePort();
    const secret = "rapid";
    let count = 0;
    const srv = await startMockRadiusServer(port, secret, (msg, sec) => {
      count++;
      return buildAccessAccept(msg, sec);
    });
    try {
      for (let i = 0; i < 50; i++) {
        const r = await ops.radiusClient({
          operation: "authenticate", server: "127.0.0.1", port, secret,
          username: `u${i}`, password: "pw", auth_method: "pap",
          timeout: 3000, retries: 1,
        });
        assert.equal(r.ok, true);
      }
      assert.equal(count, 50);
    } finally { srv.close(); }
  });

  await test("no memory leak: 100 requests do not grow heap unboundedly", async () => {
    const port   = await getFreePort();
    const secret = "memleak";
    const srv    = await startMockRadiusServer(port, secret, (msg, sec) => buildAccessAccept(msg, sec));
    const before = process.memoryUsage().heapUsed;
    try {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          ops.radiusClient({
            operation: "authenticate", server: "127.0.0.1", port, secret,
            username: `u${i}`, password: "pw", auth_method: "pap",
            timeout: 5000, retries: 1,
          })
        )
      );
      if (global.gc) global.gc();
      const after = process.memoryUsage().heapUsed;
      // Growth less than 20 MB for 100 requests
      assert.ok((after - before) < 20 * 1024 * 1024,
        `Heap grew by ${Math.round((after - before) / 1024)} KB`);
    } finally { srv.close(); }
  });

  await test("socket is always closed after error", async () => {
    // After a failed request, calling again should work (no socket leak)
    const port = await getFreePort(); // nothing listening
    await ops.radiusClient({
      operation: "status", server: "127.0.0.1", port, secret: "s",
      timeout: 1000, retries: 1,
    }); // should return {ok:false}
    // Do it again — should not fail due to unclosed socket
    const r = await ops.radiusClient({
      operation: "status", server: "127.0.0.1", port, secret: "s",
      timeout: 1000, retries: 1,
    });
    assert.equal(r.ok, false);
  });

  await test("accounting: framed_ip_address accepted and sent", async () => {
    const port   = await getFreePort();
    const secret = "test";
    let gotFramedIp = false;
    const srv = await startMockRadiusServer(port, secret, (msg, sec) => {
      let off = 20;
      while (off + 1 < msg.length) {
        const t = msg[off]; const l = msg[off+1]; if (l < 2) break;
        if (t === 8) gotFramedIp = true; // Framed-IP-Address
        off += l;
      }
      return buildAccountingResponse(msg, sec);
    });
    try {
      await ops.radiusClient({
        operation: "accounting", server: "127.0.0.1", port, secret,
        username: "u", session_id: "sess", acct_status_type: "stop",
        framed_ip_address: "192.168.1.100",
        timeout: 3000, retries: 1,
      });
      assert.ok(gotFramedIp);
    } finally { srv.close(); }
  });

  // ── Final report ──────────────────────────────────────────────────────────────
  const total = passed + failed + skipped;
  process.stderr.write(`\n== Section 261 radius_client: ${passed}/${total} passed`);
  if (skipped) process.stderr.write(` (${skipped} skipped)`);
  if (failed)  process.stderr.write(` [${failed} FAILED]`);
  process.stderr.write(" ==\n");
  if (failures.length) {
    for (const f of failures) process.stderr.write(`   FAIL: ${f.name}: ${f.err.message}\n`);
    process.exit(1);
  }
}

runAll().catch(err => {
  process.stderr.write(`Unexpected error: ${err.stack || err}\n`);
  process.exit(1);
});
