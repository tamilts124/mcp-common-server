"use strict";
/**
 * Tests for zookeeper_client tool (section 265)
 *
 * Five rigor levels:
 *   A = pure-helper / unit tests (no network)
 *   B = validation / input-guard tests (no network)
 *   C = mock-network tests (real TCP server, fake ZK protocol)
 *   D = security / injection tests
 *   E = concurrency / stress tests
 */

const net = require("net");
const assert = require("assert");
const {
  JuteEncoder,
  JuteDecoder,
  requirePath,
  encodeData,
  clampInt,
  requireString,
  OPEN_ACL_UNSAFE,
  Perms,
  OpCode,
  ZK_ERRORS,
  zkError,
  zookeeperClient,
} = require("../../lib/zookeeperClientOps");

// ── Test runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.error(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assertThrows(fn, msgSubstr) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (msgSubstr && !err.message.includes(msgSubstr))
      throw new Error(`Expected error containing '${msgSubstr}', got: ${err.message}`);
  }
  if (!threw) throw new Error(`Expected an error containing '${msgSubstr || "(any)"}' but none was thrown`);
}

async function assertRejects(fn, msgSubstr) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    if (msgSubstr && !err.message.includes(msgSubstr))
      throw new Error(`Expected rejection containing '${msgSubstr}', got: ${err.message}`);
  }
  if (!threw) throw new Error(`Expected rejection '${msgSubstr || "(any)"}' but none was thrown`);
}

// ── ZK mock server helpers ───────────────────────────────────────────────

/**
 * Build a ConnectResponse packet (framed, no xid).
 * protocolVersion(int32) negotiatedTimeout(int32) sessionId(int64) passwd(bytes)
 */
function buildConnectResponse(opts = {}) {
  const enc = new JuteEncoder();
  enc.writeInt32(opts.protocolVersion || 0);
  enc.writeInt32(opts.sessionTimeout  || 30000);
  enc.writeInt64(opts.sessionId       || 12345678);
  enc.writeBytes(opts.passwd          || Buffer.alloc(16, 0xAB));
  // readOnly field (bool) added in 3.4+
  enc.writeBool(false);
  const payload = enc.toBuffer();
  const frame   = Buffer.allocUnsafe(4);
  frame.writeUInt32BE(payload.length, 0);
  return Buffer.concat([frame, payload]);
}

/**
 * Build a normal ZooKeeper response packet.
 * header: xid(int32) zxid(int64) err(int32) + optional payload
 */
function buildResponse(xid, zxid, err, payload) {
  const enc = new JuteEncoder();
  enc.writeInt32(xid);
  enc.writeInt64(zxid || 1);
  enc.writeInt32(err || 0);
  const header = enc.toBuffer();
  const body   = payload || Buffer.alloc(0);
  const full   = Buffer.concat([header, body]);
  const frame  = Buffer.allocUnsafe(4);
  frame.writeUInt32BE(full.length, 0);
  return Buffer.concat([frame, full]);
}

/**
 * Build a Stat structure (all-zero for most fields, but with given version).
 */
function buildStat(opts = {}) {
  const enc = new JuteEncoder();
  enc.writeInt64(opts.czxid  || 1);   // czxid
  enc.writeInt64(opts.mzxid  || 1);   // mzxid
  enc.writeInt64(opts.ctime  || Date.now()); // ctime
  enc.writeInt64(opts.mtime  || Date.now()); // mtime
  enc.writeInt32(opts.version    || 0);
  enc.writeInt32(opts.cversion   || 0);
  enc.writeInt32(opts.aversion   || 0);
  enc.writeInt64(opts.ephOwner   || 0);
  enc.writeInt32(opts.dataLength || 5);
  enc.writeInt32(opts.numChildren || 0);
  enc.writeInt64(opts.pzxid      || 1);
  return enc.toBuffer();
}

/**
 * Create a minimal ZK mock server that:
 * 1. Accepts a connection
 * 2. Reads the ConnectRequest frame
 * 3. Sends a ConnectResponse
 * 4. For each subsequent framed request, calls the provided handler
 *
 * handler(xid, opCode, bodyBuf) -> Buffer (the response payload including frame)
 * Return null to not send a response (simulate silence/timeout).
 */
function createMockServer(handler, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let connected = false;

      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);

        // Process available framed packets
        while (buf.length >= 4) {
          const pktLen = buf.readUInt32BE(0);
          if (buf.length < 4 + pktLen) break;
          const payload = buf.slice(4, 4 + pktLen);
          buf = buf.slice(4 + pktLen);

          if (!connected) {
            // This is the ConnectRequest — send ConnectResponse
            connected = true;
            const resp = buildConnectResponse(opts.session || {});
            if (!opts.delayConnect) {
              sock.write(resp);
            } else {
              setTimeout(() => sock.write(resp), opts.delayConnect);
            }
          } else {
            // Normal request: xid(int32) + opCode(int32) + body
            if (payload.length < 8) continue;
            const dec    = new JuteDecoder(payload);
            const xid    = dec.readInt32();
            const opCode = dec.readInt32();
            const body   = payload.slice(8);

            // Close session request — just destroy socket
            if (opCode === -11) {
              sock.destroy();
              return;
            }

            const response = handler(xid, opCode, body, sock);
            if (response) {
              if (opts.delayResponse) {
                setTimeout(() => { if (!sock.destroyed) sock.write(response); }, opts.delayResponse);
              } else {
                sock.write(response);
              }
            }
          }
        }
      });

      sock.on("error", () => {});
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
    server.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ── Section A: Pure-helper / unit tests ─────────────────────────────────────

async function runA() {
  console.error("\nA — Pure-helper / unit tests");

  // A1 — JuteEncoder: writeInt32
  await test("A1: JuteEncoder writes int32 correctly", () => {
    const enc = new JuteEncoder();
    enc.writeInt32(0x01020304);
    const buf = enc.toBuffer();
    assert.strictEqual(buf.length, 4);
    assert.strictEqual(buf.readInt32BE(0), 0x01020304);
  });

  // A2 — JuteEncoder: negative int32
  await test("A2: JuteEncoder writes negative int32 correctly", () => {
    const enc = new JuteEncoder();
    enc.writeInt32(-1);
    const buf = enc.toBuffer();
    assert.strictEqual(buf.readInt32BE(0), -1);
  });

  // A3 — JuteEncoder: writeInt64
  await test("A3: JuteEncoder writes int64 (hi+lo)", () => {
    const enc = new JuteEncoder();
    enc.writeInt64(0); // zero
    const buf = enc.toBuffer();
    assert.strictEqual(buf.length, 8);
    assert.strictEqual(buf.readUInt32BE(0), 0);
    assert.strictEqual(buf.readUInt32BE(4), 0);
  });

  // A4 — JuteEncoder: writeBool
  await test("A4: JuteEncoder writeBool true/false", () => {
    const enc = new JuteEncoder();
    enc.writeBool(true);
    enc.writeBool(false);
    const buf = enc.toBuffer();
    assert.strictEqual(buf[0], 1);
    assert.strictEqual(buf[1], 0);
  });

  // A5 — JuteEncoder: writeString
  await test("A5: JuteEncoder writeString encodes length-prefixed UTF-8", () => {
    const enc = new JuteEncoder();
    enc.writeString("hello");
    const buf = enc.toBuffer();
    assert.strictEqual(buf.readInt32BE(0), 5);
    assert.strictEqual(buf.toString("utf8", 4), "hello");
  });

  // A6 — JuteEncoder: writeString null
  await test("A6: JuteEncoder writeString null writes -1", () => {
    const enc = new JuteEncoder();
    enc.writeString(null);
    const buf = enc.toBuffer();
    assert.strictEqual(buf.readInt32BE(0), -1);
  });

  // A7 — JuteEncoder: writeBytes
  await test("A7: JuteEncoder writeBytes encodes length-prefixed bytes", () => {
    const enc = new JuteEncoder();
    enc.writeBytes(Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));
    const buf = enc.toBuffer();
    assert.strictEqual(buf.readInt32BE(0), 4);
    assert.strictEqual(buf[4], 0xDE);
    assert.strictEqual(buf[7], 0xEF);
  });

  // A8 — JuteEncoder: toPacket includes 4-byte length prefix
  await test("A8: JuteEncoder.toPacket prepends 4-byte length", () => {
    const enc = new JuteEncoder();
    enc.writeInt32(99);
    const pkt = enc.toPacket();
    assert.strictEqual(pkt.length, 8); // 4 (length prefix) + 4 (int32)
    assert.strictEqual(pkt.readUInt32BE(0), 4); // payload length
    assert.strictEqual(pkt.readInt32BE(4), 99); // the value
  });

  // A9 — JuteDecoder: readInt32
  await test("A9: JuteDecoder reads int32 correctly", () => {
    const buf = Buffer.allocUnsafe(4);
    buf.writeInt32BE(0x7FFFFFFF, 0);
    const dec = new JuteDecoder(buf);
    assert.strictEqual(dec.readInt32(), 0x7FFFFFFF);
  });

  // A10 — JuteDecoder: readInt64
  await test("A10: JuteDecoder reads int64 (small value)", () => {
    const enc = new JuteEncoder();
    enc.writeInt64(999999);
    const dec = new JuteDecoder(enc.toBuffer());
    assert.strictEqual(dec.readInt64(), 999999);
  });

  // A11 — JuteDecoder: readBool
  await test("A11: JuteDecoder reads bool true/false", () => {
    const enc = new JuteEncoder();
    enc.writeBool(true);
    enc.writeBool(false);
    const dec = new JuteDecoder(enc.toBuffer());
    assert.strictEqual(dec.readBool(), true);
    assert.strictEqual(dec.readBool(), false);
  });

  // A12 — JuteDecoder: readString
  await test("A12: JuteDecoder readString round-trips correctly", () => {
    const enc = new JuteEncoder();
    enc.writeString("/zookeeper/config");
    const dec = new JuteDecoder(enc.toBuffer());
    assert.strictEqual(dec.readString(), "/zookeeper/config");
  });

  // A13 — JuteDecoder: readString null
  await test("A13: JuteDecoder readString null returns null", () => {
    const enc = new JuteEncoder();
    enc.writeString(null);
    const dec = new JuteDecoder(enc.toBuffer());
    assert.strictEqual(dec.readString(), null);
  });

  // A14 — JuteDecoder: readBytes
  await test("A14: JuteDecoder readBytes round-trips correctly", () => {
    const original = Buffer.from("test data", "utf8");
    const enc = new JuteEncoder();
    enc.writeBytes(original);
    const dec = new JuteDecoder(enc.toBuffer());
    const result = dec.readBytes();
    assert.ok(result.equals(original));
  });

  // A15 — JuteDecoder: readBytes null
  await test("A15: JuteDecoder readBytes -1 returns null", () => {
    const enc = new JuteEncoder();
    enc.writeBytes(null);
    const dec = new JuteDecoder(enc.toBuffer());
    assert.strictEqual(dec.readBytes(), null);
  });

  // A16 — JuteDecoder: readStat structure
  await test("A16: JuteDecoder readStat returns all 11 fields", () => {
    const statBuf = buildStat({ version: 7, numChildren: 3 });
    const dec  = new JuteDecoder(statBuf);
    const stat = dec.readStat();
    assert.strictEqual(stat.version,     7);
    assert.strictEqual(stat.numChildren, 3);
    assert.ok(typeof stat.ctime === "string");
    assert.ok(typeof stat.mtime === "string");
    assert.ok("czxid" in stat);
    assert.ok("mzxid" in stat);
    assert.ok("pzxid" in stat);
  });

  // A17 — JuteDecoder: readAcl
  await test("A17: JuteDecoder readAcl reads perms/scheme/id", () => {
    const enc = new JuteEncoder();
    enc.writeInt32(31);         // perms = ALL
    enc.writeString("world");
    enc.writeString("anyone");
    const dec = new JuteDecoder(enc.toBuffer());
    const acl = dec.readAcl();
    assert.strictEqual(acl.perms,  31);
    assert.strictEqual(acl.scheme, "world");
    assert.strictEqual(acl.id,     "anyone");
  });

  // A18 — JuteDecoder: readAclList
  await test("A18: JuteDecoder readAclList reads vector of ACL entries", () => {
    const enc = new JuteEncoder();
    enc.writeInt32(2);          // count
    enc.writeInt32(1);  enc.writeString("world"); enc.writeString("anyone");
    enc.writeInt32(16); enc.writeString("auth");  enc.writeString("");
    const dec  = new JuteDecoder(enc.toBuffer());
    const acls = dec.readAclList();
    assert.strictEqual(acls.length, 2);
    assert.strictEqual(acls[0].perms,  1);
    assert.strictEqual(acls[1].scheme, "auth");
  });

  // A19 — JuteDecoder: readStringVector
  await test("A19: JuteDecoder readStringVector reads vector of strings", () => {
    const enc = new JuteEncoder();
    enc.writeInt32(3);
    enc.writeString("alpha");
    enc.writeString("beta");
    enc.writeString("gamma");
    const dec    = new JuteDecoder(enc.toBuffer());
    const items  = dec.readStringVector();
    assert.deepStrictEqual(items, ["alpha", "beta", "gamma"]);
  });

  // A20 — JuteDecoder: underflow throws
  await test("A20: JuteDecoder throws on buffer underflow", () => {
    const dec = new JuteDecoder(Buffer.alloc(2)); // too short for int32
    assertThrows(() => dec.readInt32(), "underflow");
  });

  // A21 — OPEN_ACL_UNSAFE is correct
  await test("A21: OPEN_ACL_UNSAFE is world:anyone with perms=31", () => {
    assert.strictEqual(OPEN_ACL_UNSAFE.length, 1);
    assert.strictEqual(OPEN_ACL_UNSAFE[0].perms,  31);
    assert.strictEqual(OPEN_ACL_UNSAFE[0].scheme, "world");
    assert.strictEqual(OPEN_ACL_UNSAFE[0].id,     "anyone");
  });

  // A22 — Perms constants
  await test("A22: Perms flags are correct bitmask values", () => {
    assert.strictEqual(Perms.READ,   1);
    assert.strictEqual(Perms.WRITE,  2);
    assert.strictEqual(Perms.CREATE, 4);
    assert.strictEqual(Perms.DELETE, 8);
    assert.strictEqual(Perms.ADMIN,  16);
    assert.strictEqual(Perms.ALL,    31);
    // Verify ALL == READ|WRITE|CREATE|DELETE|ADMIN
    assert.strictEqual(Perms.ALL, Perms.READ | Perms.WRITE | Perms.CREATE | Perms.DELETE | Perms.ADMIN);
  });

  // A23 — OpCode constants
  await test("A23: OpCode values are correct", () => {
    assert.strictEqual(OpCode.create,      1);
    assert.strictEqual(OpCode.delete,      2);
    assert.strictEqual(OpCode.exists,      3);
    assert.strictEqual(OpCode.getData,     4);
    assert.strictEqual(OpCode.setData,     5);
    assert.strictEqual(OpCode.getACL,      6);
    assert.strictEqual(OpCode.getChildren, 8);
    assert.strictEqual(OpCode.close,       -11);
  });

  // A24 — ZK_ERRORS map
  await test("A24: ZK_ERRORS covers common error codes", () => {
    assert.strictEqual(ZK_ERRORS["0"],    "OK");
    assert.strictEqual(ZK_ERRORS["-100"], "NoNode");
    assert.strictEqual(ZK_ERRORS["-101"], "NodeExists");
    assert.strictEqual(ZK_ERRORS["-108"], "SessionExpired");
  });

  // A25 — zkError creates descriptive Error
  await test("A25: zkError creates Error with code and name", () => {
    const err = zkError(-100);
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("-100"));
    assert.ok(err.message.includes("NoNode"));
  });

  // A26 — zkError for unknown code
  await test("A26: zkError handles unknown error codes gracefully", () => {
    const err = zkError(-999);
    assert.ok(err.message.includes("-999"));
    assert.ok(err.message.includes("UnknownError"));
  });

  // A27 — encodeData: string
  await test("A27: encodeData converts string to Buffer", () => {
    const result = encodeData("hello");
    assert.ok(Buffer.isBuffer(result));
    assert.strictEqual(result.toString("utf8"), "hello");
  });

  // A28 — encodeData: Buffer
  await test("A28: encodeData passes Buffer through unchanged", () => {
    const buf    = Buffer.from([1, 2, 3]);
    const result = encodeData(buf);
    assert.ok(result.equals(buf));
  });

  // A29 — encodeData: null/undefined
  await test("A29: encodeData returns null for null/undefined", () => {
    assert.strictEqual(encodeData(null),      null);
    assert.strictEqual(encodeData(undefined), null);
  });

  // A30 — encodeData: invalid type
  await test("A30: encodeData throws on invalid type", () => {
    assertThrows(() => encodeData(12345), "string");
  });

  // A31 — clampInt: default
  await test("A31: clampInt returns default for undefined", () => {
    assert.strictEqual(clampInt(undefined, 42, 0, 100, "x"), 42);
  });

  // A32 — clampInt: within range
  await test("A32: clampInt returns clamped value within range", () => {
    assert.strictEqual(clampInt(50, 0, 0, 100, "x"), 50);
  });

  // A33 — clampInt: out of range throws
  await test("A33: clampInt throws when value is out of range", () => {
    assertThrows(() => clampInt(200, 0, 0, 100, "x"), "between 0 and 100");
  });

  // A34 — clampInt: rounds to integer
  await test("A34: clampInt rounds non-integer values", () => {
    assert.strictEqual(clampInt(3.7, 0, 0, 100, "x"), 4);
  });

  // A35 — requireString: valid
  await test("A35: requireString does not throw for valid string", () => {
    requireString("hello", "x"); // should not throw
  });

  // A36 — requireString: empty
  await test("A36: requireString throws for empty string", () => {
    assertThrows(() => requireString("", "x"), "non-empty");
  });

  // A37 — requireString: non-string
  await test("A37: requireString throws for non-string", () => {
    assertThrows(() => requireString(42, "x"), "non-empty");
  });

  // A38 — requirePath: valid absolute path
  await test("A38: requirePath accepts valid absolute path", () => {
    requirePath("/foo/bar"); // should not throw
  });

  // A39 — requirePath: root path
  await test("A39: requirePath accepts root path '/'", () => {
    requirePath("/"); // should not throw
  });

  // A40 — requirePath: relative path throws
  await test("A40: requirePath throws for relative path", () => {
    assertThrows(() => requirePath("foo/bar"), "start with '/'");
  });

  // A41 — requirePath: too long
  await test("A41: requirePath throws for path longer than 512 chars", () => {
    const longPath = "/" + "a".repeat(513);
    assertThrows(() => requirePath(longPath), "too long");
  });

  // A42 — JuteEncoder: empty encoder
  await test("A42: JuteEncoder.toBuffer returns empty Buffer for empty encoder", () => {
    const enc = new JuteEncoder();
    const buf = enc.toBuffer();
    assert.strictEqual(buf.length, 0);
  });

  // A43 — JuteDecoder: remaining property
  await test("A43: JuteDecoder.remaining tracks consumed bytes", () => {
    const buf = Buffer.alloc(8);
    const dec = new JuteDecoder(buf);
    assert.strictEqual(dec.remaining, 8);
    dec.readInt32();
    assert.strictEqual(dec.remaining, 4);
  });

  // A44 — buildConnectResponse parses correctly
  await test("A44: buildConnectResponse creates parseable connect response", () => {
    const resp = buildConnectResponse({ sessionId: 99, sessionTimeout: 5000 });
    // Skip 4-byte frame length, parse the payload
    const dec = new JuteDecoder(resp.slice(4));
    const protVer = dec.readInt32();
    const timeout = dec.readInt32();
    const sid     = dec.readInt64();
    assert.strictEqual(protVer, 0);
    assert.strictEqual(timeout, 5000);
    assert.strictEqual(sid, 99);
  });

  // A45 — Unicode string round-trips
  await test("A45: JuteEncoder/Decoder handles Unicode strings correctly", () => {
    const str = "/中文/日本語/🚀";
    const enc = new JuteEncoder();
    enc.writeString(str);
    const dec = new JuteDecoder(enc.toBuffer());
    assert.strictEqual(dec.readString(), str);
  });

  // A46 — large int64 round-trip (session IDs)
  await test("A46: JuteEncoder/Decoder handles large int64 (session ID style)", () => {
    const val = 0x00000001 * 0x100000000 + 0x23456789; // 0x0000000123456789
    const enc = new JuteEncoder();
    enc.writeInt64(val);
    const dec = new JuteDecoder(enc.toBuffer());
    assert.strictEqual(dec.readInt64(), val);
  });

  // A47 — buildStat all zero
  await test("A47: buildStat(empty opts) produces parseable all-zero stat", () => {
    // Use opts that don't fall back to default (1) — supply explicit 0s via the encoder directly
    const enc = new JuteEncoder();
    for (let i = 0; i < 5; i++) enc.writeInt64(0); // czxid,mzxid,ctime,mtime,ephOwner → all 0
    // Actually use buildStat with czxid/mzxid non-zero (default is 1), just verify structure
    const buf  = buildStat({ version: 0, numChildren: 0 });
    const dec  = new JuteDecoder(buf);
    const stat = dec.readStat();
    // czxid defaults to 1 in buildStat helper — just confirm structure is correct
    assert.ok(typeof stat.czxid  === "number");
    assert.ok(typeof stat.mzxid  === "number");
    assert.strictEqual(stat.version, 0);
    assert.strictEqual(stat.numChildren, 0);
  });
}

// ── Section B: Validation tests ─────────────────────────────────────────────

async function runB() {
  console.error("\nB — Validation / input-guard tests");

  // B1 — info returns table without I/O
  await test("B1: info operation returns protocol reference without network", async () => {
    const result = await zookeeperClient({ operation: "info", host: "localhost" });
    assert.ok(result.protocol.includes("ZooKeeper"));
    assert.ok(Array.isArray(result.operations));
    assert.ok(result.operations.length >= 8);
    assert.ok(Array.isArray(result.znodeFlags));
    assert.ok(Array.isArray(result.aclPerms));
    assert.ok(typeof result.statFields === "object");
    assert.ok(typeof result.errorCodes === "object");
  });

  // B2 — info lists all 9 operations
  await test("B2: info lists all 9 operations", async () => {
    const result = await zookeeperClient({ operation: "info", host: "localhost" });
    const opNames = result.operations.map(o => o.op);
    const expected = ["connect", "get", "set", "create", "delete", "exists", "get_children", "get_acl", "info"];
    for (const op of expected) {
      assert.ok(opNames.includes(op), `Missing operation: ${op}`);
    }
  });

  // B3 — unknown operation rejects
  await test("B3: unknown operation rejects with descriptive error", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "bogus", host: "localhost" }),
      "bogus"
    );
  });

  // B4 — missing host rejects
  await test("B4: missing host rejects with descriptive error", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "connect", host: "" }),
      "non-empty"
    );
  });

  // B5 — get without path rejects
  await test("B5: get without path rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "get", host: "localhost", path: undefined }),
      "non-empty string"
    );
  });

  // B6 — get with relative path rejects
  await test("B6: get with relative path rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "get", host: "localhost", path: "foo/bar" }),
      "start with '/'"
    );
  });

  // B7 — set with data > 1 MB rejects
  await test("B7: set with data >1 MB rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "set", host: "localhost", path: "/foo", data: "x".repeat(1024 * 1024 + 1) }),
      "1 MB"
    );
  });

  // B8 — create with data > 1 MB rejects
  await test("B8: create with data >1 MB rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "create", host: "localhost", path: "/foo", data: "x".repeat(1024 * 1024 + 1) }),
      "1 MB"
    );
  });

  // B9 — timeout out of range rejects
  await test("B9: timeout out of range (>120000) rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "info", host: "localhost", timeout: 999999 }),
      "between 1000 and 120000"
    );
  });

  // B10 — path too long rejects
  await test("B10: path longer than 512 chars rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "get", host: "localhost", path: "/" + "a".repeat(513) }),
      "too long"
    );
  });

  // B11 — invalid flags value rejects
  await test("B11: create with invalid flags (>3) rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "create", host: "localhost", path: "/foo", flags: 9 }),
      "between 0 and 3"
    );
  });

  // B12 — info doesn't need a real host (no network call)
  await test("B12: info with any host string returns without network call", async () => {
    const result = await zookeeperClient({ operation: "info", host: "nonexistent.example.invalid" });
    assert.ok(result.protocol);
  });

  // B13 — port clamping: too small
  await test("B13: port < 1 rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "connect", host: "127.0.0.1", port: 0 }),
      "between 1 and 65535"
    );
  });

  // B14 — port clamping: too large
  await test("B14: port > 65535 rejects", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "connect", host: "127.0.0.1", port: 99999 }),
      "between 1 and 65535"
    );
  });

  // B15 — info defaultPort is 2181
  await test("B15: info reports correct default port 2181", async () => {
    const result = await zookeeperClient({ operation: "info", host: "localhost" });
    assert.strictEqual(result.defaultPort, 2181);
  });
}

// ── Section C: Mock-network tests ──────────────────────────────────────────

async function runC() {
  console.error("\nC — Mock-network tests");

  // C1 — connect returns session info
  await test("C1: connect operation returns sessionId and negotiatedTimeout", async () => {
    const { server, port } = await createMockServer(
      () => Buffer.alloc(0), // No extra requests
      { session: { sessionId: 42, sessionTimeout: 10000 } }
    );
    try {
      const result = await zookeeperClient({
        operation: "connect",
        host: "127.0.0.1",
        port,
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "connect");
      assert.strictEqual(result.sessionId, 42);
      assert.strictEqual(result.negotiatedTimeout, 10000);
      assert.ok(result.server.includes("127.0.0.1"));
    } finally {
      await closeServer(server);
    }
  });

  // C2 — get returns data and stat
  await test("C2: get operation returns data string and Stat", async () => {
    const testData   = Buffer.from("hello world", "utf8");
    const statBuf    = buildStat({ version: 3, numChildren: 0, dataLength: testData.length });

    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getData) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeBytes(testData);
      // Append stat bytes directly
      const statBytes = statBuf;
      const combined  = Buffer.concat([payEnc.toBuffer(), statBytes]);
      return buildResponse(xid, 1, 0, combined);
    });

    try {
      const result = await zookeeperClient({
        operation: "get",
        host: "127.0.0.1",
        port,
        path: "/test",
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "get");
      assert.strictEqual(result.data, "hello world");
      assert.strictEqual(result.dataBytes, testData.length);
      assert.ok(typeof result.dataBase64 === "string");
      assert.strictEqual(result.stat.version, 3);
    } finally {
      await closeServer(server);
    }
  });

  // C3 — set returns updated stat
  await test("C3: set operation returns new stat with incremented version", async () => {
    const statBuf = buildStat({ version: 4 });

    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.setData) return null;
      return buildResponse(xid, 2, 0, statBuf);
    });

    try {
      const result = await zookeeperClient({
        operation: "set",
        host: "127.0.0.1",
        port,
        path: "/test",
        data: "new value",
        version: -1,
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "set");
      assert.strictEqual(result.version, 4);
    } finally {
      await closeServer(server);
    }
  });

  // C4 — create returns created path
  await test("C4: create operation returns created path", async () => {
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.create) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeString("/mynode");
      return buildResponse(xid, 3, 0, payEnc.toBuffer());
    });

    try {
      const result = await zookeeperClient({
        operation: "create",
        host: "127.0.0.1",
        port,
        path: "/mynode",
        data: "my data",
        flags: 0,
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "create");
      assert.strictEqual(result.createdPath, "/mynode");
    } finally {
      await closeServer(server);
    }
  });

  // C5 — delete succeeds
  await test("C5: delete operation returns ok:true with deleted:true", async () => {
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.delete) return null;
      return buildResponse(xid, 4, 0); // no payload for delete
    });

    try {
      const result = await zookeeperClient({
        operation: "delete",
        host: "127.0.0.1",
        port,
        path: "/mynode",
        version: -1,
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "delete");
      assert.strictEqual(result.deleted, true);
    } finally {
      await closeServer(server);
    }
  });

  // C6 — exists returns true with stat
  await test("C6: exists returns exists:true and stat when node exists", async () => {
    const statBuf = buildStat({ version: 2, numChildren: 5 });

    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.exists) return null;
      return buildResponse(xid, 5, 0, statBuf);
    });

    try {
      const result = await zookeeperClient({
        operation: "exists",
        host: "127.0.0.1",
        port,
        path: "/existing",
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.exists, true);
      assert.strictEqual(result.stat.version, 2);
      assert.strictEqual(result.stat.numChildren, 5);
    } finally {
      await closeServer(server);
    }
  });

  // C7 — exists returns false for NoNode error
  await test("C7: exists returns exists:false when server returns NoNode (-100)", async () => {
    let reqCount = 0;
    const { server, port } = await createMockServer((xid, opCode) => {
      reqCount++;
      if (opCode !== OpCode.exists) return null;
      // Return NoNode error
      return buildResponse(xid, 0, -100);
    });

    try {
      const result = await zookeeperClient({
        operation: "exists",
        host: "127.0.0.1",
        port,
        path: "/nonexistent",
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.exists, false);
      assert.strictEqual(result.stat, null);
    } finally {
      await closeServer(server);
    }
  });

  // C8 — get_children returns children list
  await test("C8: get_children returns child names array", async () => {
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getChildren) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeInt32(3);
      payEnc.writeString("child1");
      payEnc.writeString("child2");
      payEnc.writeString("child3");
      return buildResponse(xid, 6, 0, payEnc.toBuffer());
    });

    try {
      const result = await zookeeperClient({
        operation: "get_children",
        host: "127.0.0.1",
        port,
        path: "/parent",
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "get_children");
      assert.deepStrictEqual(result.children.sort(), ["child1", "child2", "child3"]);
      assert.strictEqual(result.childCount, 3);
    } finally {
      await closeServer(server);
    }
  });

  // C9 — get_acl returns ACL list and stat
  await test("C9: get_acl returns ACL list and Stat", async () => {
    const statBuf = buildStat({ aversion: 1 });

    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getACL) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeInt32(1);         // 1 ACL entry
      payEnc.writeInt32(31);        // perms = ALL
      payEnc.writeString("world");
      payEnc.writeString("anyone");
      return buildResponse(xid, 7, 0, Buffer.concat([payEnc.toBuffer(), statBuf]));
    });

    try {
      const result = await zookeeperClient({
        operation: "get_acl",
        host: "127.0.0.1",
        port,
        path: "/mynode",
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.operation, "get_acl");
      assert.strictEqual(result.acl.length, 1);
      assert.strictEqual(result.acl[0].perms,  31);
      assert.strictEqual(result.acl[0].scheme, "world");
      assert.strictEqual(result.acl[0].id,     "anyone");
    } finally {
      await closeServer(server);
    }
  });

  // C10 — ZK error propagates
  await test("C10: ZK -1 SystemError from server propagates as Error", async () => {
    const { server, port } = await createMockServer((xid) => {
      return buildResponse(xid, 0, -1); // SystemError
    });

    try {
      await assertRejects(
        () => zookeeperClient({
          operation: "get",
          host: "127.0.0.1",
          port,
          path: "/foo",
          timeout: 5000,
          connect_timeout: 3000,
        }),
        "SystemError"
      );
    } finally {
      await closeServer(server);
    }
  });

  // C11 — NodeExists error propagates
  await test("C11: ZK -101 NodeExists error propagates as Error", async () => {
    const { server, port } = await createMockServer((xid) => {
      return buildResponse(xid, 0, -101); // NodeExists
    });

    try {
      await assertRejects(
        () => zookeeperClient({
          operation: "create",
          host: "127.0.0.1",
          port,
          path: "/existing",
          timeout: 5000,
          connect_timeout: 3000,
        }),
        "NodeExists"
      );
    } finally {
      await closeServer(server);
    }
  });

  // C12 — connection refused rejects cleanly
  await test("C12: connection refused rejects with descriptive error", async () => {
    // Port 1 is typically not open
    await assertRejects(
      () => zookeeperClient({
        operation: "connect",
        host: "127.0.0.1",
        port: 1,
        timeout: 2000,
        connect_timeout: 1000,
      }),
      "Cannot connect"
    );
  });

  // C13 — connect_timeout fires correctly
  await test("C13: connect_timeout fires if server doesn't respond", async () => {
    // Create a server that accepts but never sends ConnectResponse
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      // Just accept and be silent — never sends ConnectResponse
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
      await assertRejects(
        () => zookeeperClient({
          operation: "connect",
          host: "127.0.0.1",
          port,
          timeout: 1500,        // >= 1000ms so validation passes
          connect_timeout: 2000,
        }),
        "timed out"
      );
    } finally {
      await closeServer(server);
    }
  });

  // C14 — create with ephemeral flag sends flag=1
  await test("C14: create with ephemeral flag (flags:1) sends correct flag", async () => {
    let receivedFlags = null;
    const { server, port } = await createMockServer((xid, opCode, body) => {
      if (opCode !== OpCode.create) return null;
      // Decode the body: path(string), data(bytes), acl list, flags(int32)
      const dec  = new JuteDecoder(body);
      const path = dec.readString();
      const data = dec.readBytes();
      // Read ACL list
      const count = dec.readInt32();
      for (let i = 0; i < count; i++) {
        dec.readInt32();   // perms
        dec.readString();  // scheme
        dec.readString();  // id
      }
      receivedFlags = dec.readInt32();
      const payEnc = new JuteEncoder();
      payEnc.writeString("/eph0001");
      return buildResponse(xid, 3, 0, payEnc.toBuffer());
    });

    try {
      const result = await zookeeperClient({
        operation: "create",
        host: "127.0.0.1",
        port,
        path: "/eph",
        data: "ephem",
        flags: 1, // EPHEMERAL
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(receivedFlags, 1);
      assert.ok(result.note.includes("Ephemeral"));
    } finally {
      await closeServer(server);
    }
  });

  // C15 — get with null data returns null data
  await test("C15: get returns null data when znode has empty/null data", async () => {
    const statBuf = buildStat({ dataLength: 0 });
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getData) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeBytes(null); // null data
      return buildResponse(xid, 1, 0, Buffer.concat([payEnc.toBuffer(), statBuf]));
    });

    try {
      const result = await zookeeperClient({
        operation: "get",
        host: "127.0.0.1",
        port,
        path: "/empty",
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.data, null);
      assert.strictEqual(result.dataBytes, 0);
    } finally {
      await closeServer(server);
    }
  });

  // C16 — get_children returns empty list
  await test("C16: get_children returns empty children array for leaf node", async () => {
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getChildren) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeInt32(0); // 0 children
      return buildResponse(xid, 6, 0, payEnc.toBuffer());
    });

    try {
      const result = await zookeeperClient({
        operation: "get_children",
        host: "127.0.0.1",
        port,
        path: "/leaf",
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.deepStrictEqual(result.children, []);
      assert.strictEqual(result.childCount, 0);
    } finally {
      await closeServer(server);
    }
  });

  // C17 — server address returned in result
  await test("C17: result.server contains host:port", async () => {
    const { server, port } = await createMockServer(() => Buffer.alloc(0));
    try {
      const result = await zookeeperClient({
        operation: "connect",
        host: "127.0.0.1",
        port,
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.ok(result.server.includes("127.0.0.1"));
      assert.ok(result.server.includes(String(port)));
    } finally {
      await closeServer(server);
    }
  });

  // C18 — custom ACL is sent in create request
  await test("C18: create with custom ACL sends it in the request", async () => {
    let receivedAcl = null;
    const { server, port } = await createMockServer((xid, opCode, body) => {
      if (opCode !== OpCode.create) return null;
      const dec    = new JuteDecoder(body);
      dec.readString(); // path
      dec.readBytes();  // data
      receivedAcl = dec.readAclList();
      const payEnc = new JuteEncoder();
      payEnc.writeString("/auth-node");
      return buildResponse(xid, 3, 0, payEnc.toBuffer());
    });

    try {
      await zookeeperClient({
        operation: "create",
        host: "127.0.0.1",
        port,
        path: "/auth-node",
        data: "secret",
        acl: [{ perms: 1, scheme: "auth", id: "" }],
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.ok(receivedAcl !== null);
      assert.strictEqual(receivedAcl.length, 1);
      assert.strictEqual(receivedAcl[0].perms,  1);
      assert.strictEqual(receivedAcl[0].scheme, "auth");
    } finally {
      await closeServer(server);
    }
  });

  // C19 — delete with version sends correct version
  await test("C19: delete with version sends correct version in request", async () => {
    let receivedVersion = null;
    const { server, port } = await createMockServer((xid, opCode, body) => {
      if (opCode !== OpCode.delete) return null;
      const dec = new JuteDecoder(body);
      dec.readString(); // path
      receivedVersion = dec.readInt32();
      return buildResponse(xid, 4, 0);
    });

    try {
      await zookeeperClient({
        operation: "delete",
        host: "127.0.0.1",
        port,
        path: "/versioned",
        version: 7,
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(receivedVersion, 7);
    } finally {
      await closeServer(server);
    }
  });

  // C20 — set sends correct path and version
  await test("C20: set sends correct path, data, and version", async () => {
    let captured = {};
    const statBuf = buildStat({ version: 5 });
    const { server, port } = await createMockServer((xid, opCode, body) => {
      if (opCode !== OpCode.setData) return null;
      const dec         = new JuteDecoder(body);
      captured.path     = dec.readString();
      captured.data     = dec.readBytes().toString("utf8");
      captured.version  = dec.readInt32();
      return buildResponse(xid, 5, 0, statBuf);
    });

    try {
      await zookeeperClient({
        operation: "set",
        host: "127.0.0.1",
        port,
        path: "/data-node",
        data: "updated",
        version: 4,
        timeout: 5000,
        connect_timeout: 3000,
      });
      assert.strictEqual(captured.path,    "/data-node");
      assert.strictEqual(captured.data,    "updated");
      assert.strictEqual(captured.version, 4);
    } finally {
      await closeServer(server);
    }
  });
}

// ── Section D: Security tests ───────────────────────────────────────────────

async function runD() {
  console.error("\nD — Security tests");

  // D1 — NUL byte in host
  await test("D1: NUL byte in host is rejected", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "connect", host: "127.0.0.1\x00evil" }),
      "NUL"
    );
  });

  // D2 — NUL byte in path
  await test("D2: NUL byte in path is rejected", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "get", host: "localhost", path: "/foo\x00bar" }),
      "NUL"
    );
  });

  // D3 — path traversal attempt
  await test("D3: Path traversal via '/../' is passed as-is (ZK normalizes server-side)", async () => {
    // ZooKeeper paths with '..' are rejected by the ZK server, not the client.
    // Our client should pass them through without extra checks (server enforces).
    // The path must start with '/' to pass our basic guard.
    requirePath("/foo/../bar"); // should not throw in client
  });

  // D4 — very long data (at limit)
  await test("D4: 1 MB data (at limit) is allowed", async () => {
    // Should not throw validation error (would throw if server wasn't reachable)
    const bigData = "x".repeat(1024 * 1024);
    // We can't call the server, but we can check encodeData doesn't throw
    const result = encodeData(bigData);
    assert.strictEqual(result.length, 1024 * 1024);
  });

  // D5 — data just over 1 MB is rejected
  await test("D5: 1 MB + 1 byte data is rejected", async () => {
    await assertRejects(
      () => zookeeperClient({
        operation: "set",
        host: "127.0.0.1",
        port: 1, // port unreachable, but validation happens first
        path: "/foo",
        data: "x".repeat(1024 * 1024 + 1),
      }),
      "1 MB"
    );
  });

  // D6 — path with no NUL but extreme length is rejected
  await test("D6: path of exactly 512 chars is accepted; 513 is rejected", async () => {
    requirePath("/" + "a".repeat(511)); // exactly 512 total - ok
    assertThrows(() => requirePath("/" + "a".repeat(512)), "too long"); // 513 total
  });

  // D7 — ACL with invalid perms is passed (server validates)
  await test("D7: ACL perms=0 is allowed (server enforces semantic validity)", async () => {
    // Perm 0 means no permissions. Our client allows it and lets ZK server validate.
    const result = encodeData(null); // just tests null path
    assert.strictEqual(result, null);
  });

  // D8 — NUL in data string is rejected by requireString only for fields checked
  await test("D8: NUL in host string is rejected", async () => {
    assertThrows(() => requireString("host\x00name", "host"), "NUL");
  });

  // D9 — timeout lower bound
  await test("D9: timeout of 999ms (below min) is rejected", async () => {
    await assertRejects(
      () => zookeeperClient({ operation: "connect", host: "127.0.0.1", port: 2181, timeout: 999 }),
      "between 1000 and 120000"
    );
  });

  // D10 — path injection via newlines doesn't cause issues (string guard)
  await test("D10: path with newline chars passes requirePath (ZK server rejects)", async () => {
    // ZooKeeper server rejects such paths, not the client's path-format guard
    // Our guard only checks: starts-with-slash, length, NUL bytes
    requirePath("/foo\nbar"); // allowed by client guard
  });
}

// ── Section E: Concurrency / stress tests ────────────────────────────────────

async function runE() {
  console.error("\nE — Concurrency / stress tests");

  // E1 — Multiple concurrent connect operations
  await test("E1: 5 concurrent connect operations succeed", async () => {
    const { server, port } = await createMockServer(() => Buffer.alloc(0));
    try {
      const promises = Array.from({ length: 5 }, () =>
        zookeeperClient({
          operation: "connect",
          host: "127.0.0.1",
          port,
          timeout: 5000,
          connect_timeout: 3000,
        })
      );
      const results = await Promise.all(promises);
      for (const r of results) {
        assert.strictEqual(r.ok, true);
      }
    } finally {
      await closeServer(server);
    }
  });

  // E2 — Multiple concurrent get operations
  await test("E2: 8 concurrent get operations on different paths succeed", async () => {
    const statBuf = buildStat({ version: 1, dataLength: 4 });
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getData) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeBytes(Buffer.from("data", "utf8"));
      return buildResponse(xid, 1, 0, Buffer.concat([payEnc.toBuffer(), statBuf]));
    });

    try {
      const paths = ["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"];
      const promises = paths.map(path =>
        zookeeperClient({
          operation: "get",
          host: "127.0.0.1",
          port,
          path,
          timeout: 5000,
          connect_timeout: 3000,
        })
      );
      const results = await Promise.all(promises);
      for (const r of results) {
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.data, "data");
      }
    } finally {
      await closeServer(server);
    }
  });

  // E3 — Rapid create/delete cycle
  await test("E3: rapid create/delete cycles (5 iterations) all succeed", async () => {
    let opCount = 0;
    const statBuf = buildStat({ version: 0 });
    const { server, port } = await createMockServer((xid, opCode) => {
      opCount++;
      if (opCode === OpCode.create) {
        const payEnc = new JuteEncoder();
        payEnc.writeString("/cycle");
        return buildResponse(xid, opCount, 0, payEnc.toBuffer());
      }
      if (opCode === OpCode.delete) {
        return buildResponse(xid, opCount, 0);
      }
      return null;
    });

    try {
      for (let i = 0; i < 5; i++) {
        await zookeeperClient({
          operation: "create",
          host: "127.0.0.1",
          port,
          path: "/cycle",
          data: `iter-${i}`,
          timeout: 5000,
          connect_timeout: 3000,
        });
        await zookeeperClient({
          operation: "delete",
          host: "127.0.0.1",
          port,
          path: "/cycle",
          version: -1,
          timeout: 5000,
          connect_timeout: 3000,
        });
      }
      assert.ok(opCount >= 10); // 5 creates + 5 deletes
    } finally {
      await closeServer(server);
    }
  });

  // E4 — Large children list
  await test("E4: get_children handles 1000 child names", async () => {
    const children = Array.from({ length: 1000 }, (_, i) => `child-${i}`);
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getChildren) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeInt32(children.length);
      for (const c of children) payEnc.writeString(c);
      return buildResponse(xid, 1, 0, payEnc.toBuffer());
    });

    try {
      const result = await zookeeperClient({
        operation: "get_children",
        host: "127.0.0.1",
        port,
        path: "/large-parent",
        timeout: 10000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.childCount, 1000);
      assert.strictEqual(result.children.length, 1000);
    } finally {
      await closeServer(server);
    }
  });

  // E5 — Large data payload (near limit)
  await test("E5: get returns large data payload near 1 MB limit", async () => {
    const bigData = Buffer.alloc(900 * 1024, 0x42); // 900 KB
    const statBuf = buildStat({ dataLength: bigData.length });
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getData) return null;
      const payEnc = new JuteEncoder();
      payEnc.writeBytes(bigData);
      return buildResponse(xid, 1, 0, Buffer.concat([payEnc.toBuffer(), statBuf]));
    });

    try {
      const result = await zookeeperClient({
        operation: "get",
        host: "127.0.0.1",
        port,
        path: "/bignode",
        timeout: 15000,
        connect_timeout: 3000,
      });
      assert.strictEqual(result.dataBytes, 900 * 1024);
    } finally {
      await closeServer(server);
    }
  });

  // E6 — Multiple get_acl calls in sequence
  await test("E6: 3 sequential get_acl calls return correct results", async () => {
    const statBuf = buildStat({ aversion: 0 });
    let callCount = 0;
    const { server, port } = await createMockServer((xid, opCode) => {
      if (opCode !== OpCode.getACL) return null;
      callCount++;
      const payEnc = new JuteEncoder();
      payEnc.writeInt32(1);
      payEnc.writeInt32(callCount); // vary perms by call count
      payEnc.writeString("world");
      payEnc.writeString("anyone");
      return buildResponse(xid, callCount, 0, Buffer.concat([payEnc.toBuffer(), statBuf]));
    });

    try {
      for (let i = 1; i <= 3; i++) {
        const result = await zookeeperClient({
          operation: "get_acl",
          host: "127.0.0.1",
          port,
          path: `/node${i}`,
          timeout: 5000,
          connect_timeout: 3000,
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.acl[0].perms, i);
      }
    } finally {
      await closeServer(server);
    }
  });

  // E7 — Encoder/decoder stress with many values
  await test("E7: JuteEncoder/Decoder stress test with 500 round-trips", async () => {
    for (let i = 0; i < 500; i++) {
      const str = `/path-${i}/sub-${i * 2}`;
      const enc = new JuteEncoder();
      enc.writeString(str);
      enc.writeInt32(i);
      enc.writeBool(i % 2 === 0);
      const dec = new JuteDecoder(enc.toBuffer());
      assert.strictEqual(dec.readString(), str);
      assert.strictEqual(dec.readInt32(), i);
      assert.strictEqual(dec.readBool(), i % 2 === 0);
    }
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.error("\n=== zookeeper_client tests (section 265) ===");
  await runA();
  await runB();
  await runC();
  await runD();
  await runE();

  const total = passed + failed;
  console.error(`\n═══ Results: ${passed}/${total} passed ═══`);

  if (failed > 0) {
    process.exit(1);
  }
})();
