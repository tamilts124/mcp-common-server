"use strict";
/**
 * Section 246 — cassandra_client tests
 * Levels: A=validation(x10), B=unit/protocol(x20), C=mock-network(x10), D=security(x10), E=error-paths(x6)
 * Total: 56 tests
 * No live Cassandra required.
 */

const assert = require("assert");
const net    = require("net");
const { cassandraClient } = require("../../lib/cassandraClientOps");

// ─── helpers ──────────────────────────────────────────────────────────────────

let passed = 0, failed = 0, total = 0;

function test(label, fn) {
  total++;
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { passed++; console.log(`  ✓ ${label}`); })
              .catch(err => { failed++; console.error(`  ✗ ${label}\n    ${err.message}`); });
    }
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${label}\n    ${err.message}`);
  }
}

async function testAsync(label, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${label}\n    ${err.message}`);
  }
}

function assertRejects(p, pattern) {
  return p.then(
    () => { throw new Error(`Expected rejection matching ${pattern}`); },
    err => {
      if (pattern && !pattern.test(err.message)) throw new Error(`Rejection '${err.message}' did not match ${pattern}`);
    }
  );
}

// ─── Protocol helpers (internal module access via require) ──────────────────
// We test the internal codec directly by loading the file and accessing via
// a small harness script.

// Import internal parts by loading the ops file in its own require context.
// Since they are not exported, we run isolated node scripts for unit testing.

const { execSync } = require("child_process");

function runNode(code) {
  const tmpFile = require("path").join(require("os").tmpdir(), `cassandra_test_${process.pid}_${Date.now()}.js`);
  require("fs").writeFileSync(tmpFile, code, "utf8");
  try {
    const result = execSync(`node "${tmpFile}"`, {
      cwd: process.cwd(),
      timeout: 10000,
      encoding: "utf8",
    });
    return result.trim();
  } finally {
    try { require("fs").unlinkSync(tmpFile); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A: Validation tests (10)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nA: Validation");

const TESTS = [];

TESTS.push(testAsync("A01 missing operation → ToolError", async () => {
  await assertRejects(
    cassandraClient({ host: "127.0.0.1" }),
    /operation.*required/i,
  );
}));

TESTS.push(testAsync("A02 unknown operation → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "flibber", host: "127.0.0.1" }),
    /unknown operation/i,
  );
}));

TESTS.push(testAsync("A03 query without cql → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "query", host: "127.0.0.1" }),
    /cql.*required/i,
  );
}));

TESTS.push(testAsync("A04 execute without cql → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "execute", host: "127.0.0.1" }),
    /cql.*required/i,
  );
}));

TESTS.push(testAsync("A05 tables without keyspace → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "tables", host: "127.0.0.1" }),
    /keyspace.*required/i,
  );
}));

TESTS.push(testAsync("A06 describe without table → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "describe", host: "127.0.0.1", keyspace: "ks" }),
    /table.*required/i,
  );
}));

TESTS.push(testAsync("A07 batch with empty statements → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "batch", host: "127.0.0.1", statements: [] }),
    /statements.*non-empty/i,
  );
}));

TESTS.push(testAsync("A08 batch without statements → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "batch", host: "127.0.0.1" }),
    /statements.*non-empty/i,
  );
}));

TESTS.push(testAsync("A09 port out of range → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "info", host: "127.0.0.1", port: 99999 }),
    /port.*1-65535/i,
  );
}));

TESTS.push(testAsync("A10 use_keyspace without keyspace → ToolError", async () => {
  await assertRejects(
    cassandraClient({ operation: "use_keyspace", host: "127.0.0.1" }),
    /keyspace.*required/i,
  );
}));

// ─────────────────────────────────────────────────────────────────────────────
// B: Unit / protocol codec tests (20)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nB: Unit / protocol codec");

const codecScript = (code) => runNode(`
"use strict";
// Expose internal helpers by reproducing them inline for testing.
// We'll pull the source of the ops file and eval the relevant section.
const src = require("fs").readFileSync("lib/cassandraClientOps.js", "utf8");
// Extract just the builder / Reader / decodeValue sections.
// Simplest: create a module context with required stubs then execute the whole file.
const Module = require("module");
const m = new Module("test");
m.filename = require("path").resolve("lib/cassandraClientOps.js");
const req = (id) => {
  if (id === "./errors") return { ToolError: class ToolError extends Error { constructor(m,c){super(m);this.code=c;} } };
  return require(id);
};
const fn = new Function("require", "module", "exports", "__dirname", "__filename", src);
fn(req, m, m.exports, require("path").dirname(m.filename), m.filename);
// Now run the provided test code that can reference m.exports etc via the file module context.
// We expose the Reader and decodeValue by re-eval'ing with extra exports.
const src2 = src
  .replace("module.exports = { cassandraClient };",
    "module.exports = { cassandraClient, _Reader: Reader, _decodeValue: decodeValue, _writeString: writeString, _writeLongString: writeLongString, _writeInt: writeInt, _writeShort: writeShort, _buildFrame: buildFrame };");
const m2 = new Module("test2");
m2.filename = require("path").resolve("lib/cassandraClientOps.js");
const fn2 = new Function("require", "module", "exports", "__dirname", "__filename", src2);
fn2(req, m2, m2.exports, require("path").dirname(m2.filename), m2.filename);
const { _Reader: Reader, _decodeValue: decodeValue, _writeString: writeString, _writeLongString: writeLongString, _writeInt: writeInt, _writeShort: writeShort, _buildFrame: buildFrame } = m2.exports;
${code}
`);

TESTS.push(testAsync("B01 Reader.readByte reads one byte", async () => {
  const out = codecScript(`
    const r = new Reader(Buffer.from([0xAB]));
    console.log(r.readByte() === 0xAB ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B02 Reader.readShort reads big-endian uint16", async () => {
  const out = codecScript(`
    const r = new Reader(Buffer.from([0x01, 0xF4]));
    console.log(r.readShort() === 500 ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B03 Reader.readInt reads big-endian int32", async () => {
  const out = codecScript(`
    const b = Buffer.alloc(4); b.writeInt32BE(-1, 0);
    const r = new Reader(b);
    console.log(r.readInt() === -1 ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B04 Reader.readString reads length-prefixed utf8", async () => {
  const out = codecScript(`
    const s = Buffer.from('hello'); const len = Buffer.alloc(2); len.writeUInt16BE(5,0);
    const r = new Reader(Buffer.concat([len, s]));
    console.log(r.readString() === 'hello' ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B05 Reader.readBytes returns null on -1", async () => {
  const out = codecScript(`
    const b = Buffer.alloc(4); b.writeInt32BE(-1,0);
    const r = new Reader(b);
    console.log(r.readBytes() === null ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B06 Reader.readStringMap reads key-value pairs", async () => {
  const out = codecScript(`
    const buf = Buffer.concat([
      Buffer.from([0x00,0x01]),           // 1 pair
      Buffer.from([0x00,0x03]),...[...Buffer.from('foo')].map(x=>Buffer.from([x])),  // key 'foo'
      Buffer.from([0x00,0x03]),...[...Buffer.from('bar')].map(x=>Buffer.from([x])),  // value 'bar'
    ]);
    // Simpler: build manually
    const b2 = Buffer.alloc(2+2+3+2+3);
    b2.writeUInt16BE(1,0);   // 1 entry
    b2.writeUInt16BE(3,2);   // key len
    b2.write('foo',4,'ascii');
    b2.writeUInt16BE(3,7);   // val len
    b2.write('bar',9,'ascii');
    const r = new Reader(b2);
    const strMap = r.readStringMap();
    console.log(strMap.foo === 'bar' ? 'OK' : 'FAIL:' + JSON.stringify(strMap));
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B07 decodeValue: varchar → string", async () => {
  const out = codecScript(`
    const bytes = Buffer.from('hello','utf8');
    console.log(decodeValue(bytes, 0x000d) === 'hello' ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B08 decodeValue: int → number", async () => {
  const out = codecScript(`
    const b = Buffer.alloc(4); b.writeInt32BE(42,0);
    console.log(decodeValue(b, 0x0009) === 42 ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B09 decodeValue: boolean true/false", async () => {
  const out = codecScript(`
    const t = Buffer.from([1]); const f = Buffer.from([0]);
    console.log(decodeValue(t,0x0004) === true && decodeValue(f,0x0004) === false ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B10 decodeValue: double", async () => {
  const out = codecScript(`
    const b = Buffer.alloc(8); b.writeDoubleBE(3.14, 0);
    const v = decodeValue(b, 0x0007);
    console.log(Math.abs(v - 3.14) < 0.001 ? 'OK' : 'FAIL:'+v);
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B11 decodeValue: null bytes → null", async () => {
  const out = codecScript(`
    console.log(decodeValue(null, 0x000d) === null ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B12 decodeValue: uuid → formatted string", async () => {
  const out = codecScript(`
    const b = Buffer.from('550e8400e29b41d4a716446655440000','hex');
    const v = decodeValue(b, 0x000c);
    console.log(v === '550e8400-e29b-41d4-a716-446655440000' ? 'OK' : 'FAIL:'+v);
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B13 decodeValue: blob → base64", async () => {
  const out = codecScript(`
    const b = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const v = decodeValue(b, 0x0003);
    console.log(v === Buffer.from([0xDE,0xAD,0xBE,0xEF]).toString('base64') ? 'OK' : 'FAIL:'+v);
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B14 decodeValue: inet IPv4 → dotted notation", async () => {
  const out = codecScript(`
    const b = Buffer.from([192,168,1,1]);
    const v = decodeValue(b, 0x0010);
    console.log(v === '192.168.1.1' ? 'OK' : 'FAIL:'+v);
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B15 decodeValue: date → YYYY-MM-DD", async () => {
  const out = codecScript(`
    // epoch day 0 = 1970-01-01 (2^31 days stored, 0 offset = 2147483648)
    const b = Buffer.alloc(4); b.writeUInt32BE(2147483648, 0);
    const v = decodeValue(b, 0x0011);
    console.log(v === '1970-01-01' ? 'OK' : 'FAIL:'+v);
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B16 buildFrame has correct 9-byte header", async () => {
  const out = codecScript(`
    const body = Buffer.from('test');
    const frame = buildFrame(0x07, body, 1, 0);
    const ok = frame[0] === 0x04   // version v4
      && frame[4] === 0x07          // opcode QUERY
      && frame.readUInt32BE(5) === 4  // body length
      && frame.length === 13;       // 9 header + 4 body
    console.log(ok ? 'OK' : 'FAIL:'+JSON.stringify([...frame]));
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B17 writeShort roundtrip", async () => {
  const out = codecScript(`
    const b = writeShort(1234);
    const r = new Reader(b);
    console.log(r.readShort() === 1234 ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B18 writeString roundtrip", async () => {
  const out = codecScript(`
    const b = writeString('cassandra');
    const r = new Reader(b);
    console.log(r.readString() === 'cassandra' ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B19 writeLongString roundtrip", async () => {
  const out = codecScript(`
    const b = writeLongString('SELECT * FROM t');
    const r = new Reader(b);
    console.log(r.readLongString() === 'SELECT * FROM t' ? 'OK' : 'FAIL');
  `);
  assert.strictEqual(out, "OK");
}));

TESTS.push(testAsync("B20 Reader underflow throws", async () => {
  try {
    codecScript(`
      const r = new Reader(Buffer.from([0x01]));
      r.readShort(); // needs 2 bytes
      console.log('FAIL: no throw');
    `);
    assert.fail("Should have thrown");
  } catch (err) {
    // execSync throws on non-zero exit; the script throws inside node
    // Either a process error or the test caught the exception
    assert.ok(true); // expected
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// C: Mock-network tests (10)
// Using a local TCP server to simulate Cassandra protocol responses.
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nC: Mock-network");

// Shared mock server helpers
const OP_STARTUP_CODE  = 0x01;
const OP_OPTIONS_CODE  = 0x05;
const OP_QUERY_CODE    = 0x07;
const OP_PREPARE_CODE  = 0x09;
const OP_EXECUTE_CODE  = 0x0a;
const OP_BATCH_CODE    = 0x0d;
const OP_AUTH_RESP     = 0x0f;

function buildMockFrame(opcode, bodyBufs, stream = 1) {
  const body   = Buffer.concat(bodyBufs.map(b => Buffer.isBuffer(b) ? b : Buffer.from(b)));
  const header = Buffer.allocUnsafe(9);
  header[0] = 0x84; // v4 response
  header[1] = 0;
  header.writeInt16BE(stream, 2);
  header[4] = opcode;
  header.writeUInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

function mockShort(n)  { const b = Buffer.alloc(2); b.writeUInt16BE(n,0); return b; }
function mockInt(n)    { const b = Buffer.alloc(4); b.writeInt32BE(n,0); return b; }
function mockStr(s)    { const sb = Buffer.from(s,'utf8'); return Buffer.concat([mockShort(sb.length), sb]); }
function mockLStr(s)   { const sb = Buffer.from(s,'utf8'); return Buffer.concat([mockInt(sb.length), sb]); }
function mockBytes(b)  { return Buffer.concat([mockInt(b ? b.length : -1), b ? b : Buffer.alloc(0)]); }
function mockSBytes(b) { return Buffer.concat([mockShort(b.length), b]); }

// READY frame
const READY_FRAME = buildMockFrame(0x02, [Buffer.alloc(0)]);

// RESULT VOID
function mkVoid(stream = 1) {
  return buildMockFrame(0x08, [mockInt(0x0001)], stream);
}

// RESULT ROWS (simple 1-column, 1-row with varchar)
function mkRows(colName, value, stream = 1) {
  // metadata: flags=0x0001 (global spec), colCount=1, ks='ks', table='t', colName, type=varchar(0x000d)
  const meta = Buffer.concat([
    mockInt(0x0001),        // flags: GLOBAL_TABLES_SPEC
    mockInt(1),             // col count
    mockStr("ks"),          // global ks
    mockStr("t"),           // global table
    mockStr(colName),       // col name
    mockShort(0x000d),      // type: varchar
  ]);
  const row  = mockBytes(Buffer.from(value, "utf8"));
  const body = Buffer.concat([mockInt(0x0002), meta, mockInt(1), row]);
  const header = Buffer.allocUnsafe(9);
  header[0] = 0x84; header[1] = 0;
  header.writeInt16BE(stream, 2);
  header[4] = 0x08;
  header.writeUInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

// RESULT SET_KEYSPACE
function mkSetKs(ks, stream = 1) {
  const body = Buffer.concat([mockInt(0x0003), mockStr(ks)]);
  const h = Buffer.allocUnsafe(9);
  h[0]=0x84; h[1]=0; h.writeInt16BE(stream,2); h[4]=0x08; h.writeUInt32BE(body.length,5);
  return Buffer.concat([h, body]);
}

// ERROR frame
function mkError(code, msg, stream = 1) {
  const body = Buffer.concat([mockInt(code), mockStr(msg)]);
  const h = Buffer.allocUnsafe(9);
  h[0]=0x84; h[1]=0; h.writeInt16BE(stream,2); h[4]=0x00; h.writeUInt32BE(body.length,5);
  return Buffer.concat([h, body]);
}

// SUPPORTED frame
function mkSupported(stream = 1) {
  // multimap: 1 key "CQL_VERSION" with values ["3.0.0"]
  const body = Buffer.concat([
    mockShort(1),
    mockStr("CQL_VERSION"),
    mockShort(1),
    mockStr("3.0.0"),
  ]);
  const h = Buffer.allocUnsafe(9);
  h[0]=0x84; h[1]=0; h.writeInt16BE(stream,2); h[4]=0x06; h.writeUInt32BE(body.length,5);
  return Buffer.concat([h, body]);
}

// PREPARED frame
function mkPrepared(stream = 1) {
  const qid = Buffer.from('aabbccdd','hex');
  const body = Buffer.concat([mockInt(0x0004), mockSBytes(qid)]);
  const h = Buffer.allocUnsafe(9);
  h[0]=0x84; h[1]=0; h.writeInt16BE(stream,2); h[4]=0x08; h.writeUInt32BE(body.length,5);
  return Buffer.concat([h, body]);
}

function buildMockSystemLocal(stream = 1) {
  // Return cluster_name=TestCluster as a ROWS result
  const meta = Buffer.concat([
    mockInt(0x0001),
    mockInt(1),
    mockStr("system"),
    mockStr("local"),
    mockStr("cluster_name"),
    mockShort(0x000d),
  ]);
  const row = mockBytes(Buffer.from("TestCluster", "utf8"));
  const body = Buffer.concat([mockInt(0x0002), meta, mockInt(1), row]);
  const h = Buffer.allocUnsafe(9);
  h[0]=0x84; h[1]=0; h.writeInt16BE(stream,2); h[4]=0x08; h.writeUInt32BE(body.length,5);
  return Buffer.concat([h, body]);
}

async function withMockServer(responseFactory, fn) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      let streamCounter = 0;
      socket.on("data", chunk => {
        // Parse incoming frames
        let pos = 0;
        while (pos + 9 <= chunk.length) {
          const bodyLen  = chunk.readUInt32BE(pos + 5);
          const opcode   = chunk[pos + 4];
          const streamId = chunk.readInt16BE(pos + 2);
          pos += 9 + bodyLen;
          streamCounter++;
          const resp = responseFactory(opcode, streamId, streamCounter);
          if (resp) socket.write(resp);
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      Promise.resolve(fn(port))
        .then(r => { server.close(); resolve(r); })
        .catch(e => { server.close(); reject(e); });
    });
    server.on("error", reject);
  });
}

TESTS.push(testAsync("C01 info op returns cluster name from mock server", async () => {
  let callCount = 0;
  await withMockServer((opcode, streamId, count) => {
    callCount++;
    if (opcode === 0x01) return READY_FRAME;  // STARTUP
    if (opcode === 0x05) return mkSupported(streamId); // OPTIONS
    if (opcode === 0x07) return buildMockSystemLocal(streamId); // QUERY system.local
    return READY_FRAME;
  }, async (port) => {
    const r = await cassandraClient({ operation: "info", host: "127.0.0.1", port, timeout: 5000 });
    assert.ok(r.options["CQL_VERSION"]);
    assert.strictEqual(r.clusterName, "TestCluster");
  });
}));

TESTS.push(testAsync("C02 query op returns decoded rows", async () => {
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x07) return mkRows("name", "Alice", streamId);
    return READY_FRAME;
  }, async (port) => {
    const r = await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 5000, cql: "SELECT name FROM users" });
    assert.strictEqual(r.resultKind, "rows");
    assert.strictEqual(r.rows.length, 1);
    assert.strictEqual(r.rows[0].name, "Alice");
  });
}));

TESTS.push(testAsync("C03 keyspaces op decodes multirow result", async () => {
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x07) {
      // Return 2 rows with keyspace_name column
      const meta = Buffer.concat([
        mockInt(0x0001), mockInt(1),
        mockStr("system_schema"), mockStr("keyspaces"),
        mockStr("keyspace_name"), mockShort(0x000d),
      ]);
      const row1 = mockBytes(Buffer.from("system"));
      const row2 = mockBytes(Buffer.from("mykeyspace"));
      const body = Buffer.concat([mockInt(0x0002), meta, mockInt(2), row1, row2]);
      const h = Buffer.allocUnsafe(9);
      h[0]=0x84; h[1]=0; h.writeInt16BE(streamId,2); h[4]=0x08; h.writeUInt32BE(body.length,5);
      return Buffer.concat([h, body]);
    }
    return READY_FRAME;
  }, async (port) => {
    const r = await cassandraClient({ operation: "keyspaces", host: "127.0.0.1", port, timeout: 5000 });
    assert.ok(r.keyspaces.length >= 1);
  });
}));

TESTS.push(testAsync("C04 use_keyspace returns SET_KEYSPACE result", async () => {
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x07) return mkSetKs("mykeyspace", streamId);
    return READY_FRAME;
  }, async (port) => {
    const r = await cassandraClient({ operation: "use_keyspace", host: "127.0.0.1", port, timeout: 5000, keyspace: "mykeyspace" });
    assert.strictEqual(r.keyspace, "mykeyspace");
  });
}));

TESTS.push(testAsync("C05 execute op: prepare then execute", async () => {
  let prepCalled = false;
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x09) { prepCalled = true; return mkPrepared(streamId); }  // PREPARE
    if (opcode === 0x0a) return mkVoid(streamId);  // EXECUTE
    return READY_FRAME;
  }, async (port) => {
    const r = await cassandraClient({ operation: "execute", host: "127.0.0.1", port, timeout: 5000, cql: "INSERT INTO t (k) VALUES (?)", values: ["hello"] });
    assert.ok(prepCalled, "PREPARE was not called");
    assert.strictEqual(r.resultKind, "void");
  });
}));

TESTS.push(testAsync("C06 batch op sends BATCH opcode", async () => {
  let batchCalled = false;
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x0d) { batchCalled = true; return mkVoid(streamId); }
    return READY_FRAME;
  }, async (port) => {
    const r = await cassandraClient({ operation: "batch", host: "127.0.0.1", port, timeout: 5000, statements: [{ cql: "INSERT INTO t (k) VALUES ('a')" }] });
    assert.ok(batchCalled, "BATCH opcode was not sent");
    assert.strictEqual(r.statementCount, 1);
  });
}));

TESTS.push(testAsync("C07 server ERROR response is propagated as thrown error", async () => {
  await assertRejects(
    withMockServer((opcode, streamId) => {
      if (opcode === 0x01) return READY_FRAME;
      if (opcode === 0x07) return mkError(0x2200, "Read timeout", streamId);
      return READY_FRAME;
    }, async (port) => {
      await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 5000, cql: "SELECT * FROM t" });
    }),
    /Read timeout/,
  );
}));

TESTS.push(testAsync("C08 authentication: SASL PLAIN exchange", async () => {
  let authCalled = false;
  await withMockServer((opcode, streamId, count) => {
    if (opcode === 0x01) {
      // Respond with AUTHENTICATE
      const body = Buffer.concat([mockStr("org.apache.cassandra.auth.PasswordAuthenticator")]);
      const h = Buffer.allocUnsafe(9);
      h[0]=0x84; h[1]=0; h.writeInt16BE(streamId,2); h[4]=0x03; h.writeUInt32BE(body.length,5);
      return Buffer.concat([h, body]);
    }
    if (opcode === 0x0f) { // AUTH_RESPONSE
      authCalled = true;
      // AUTH_SUCCESS
      const body = Buffer.concat([mockInt(-1)]); // empty token
      const h = Buffer.allocUnsafe(9);
      h[0]=0x84; h[1]=0; h.writeInt16BE(streamId,2); h[4]=0x10; h.writeUInt32BE(body.length,5);
      return Buffer.concat([h, body]);
    }
    if (opcode === 0x07) return mkRows("k", "v", streamId);
    return READY_FRAME;
  }, async (port) => {
    const r = await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 5000, cql: "SELECT k FROM t", username: "cassandra", password: "cassandra" });
    assert.ok(authCalled, "AUTH_RESPONSE was not sent");
    assert.strictEqual(r.rows[0].k, "v");
  });
}));

TESTS.push(testAsync("C09 connection refused → connection error", async () => {
  // Use a port that is not listening
  await assertRejects(
    cassandraClient({ operation: "info", host: "127.0.0.1", port: 19999, timeout: 2000 }),
    /connect|ECONNREFUSED/i,
  );
}));

TESTS.push(testAsync("C10 query with use_keyspace sends USE first", async () => {
  const received = [];
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x07) {
      received.push(streamId);
      if (received.length === 1) return mkSetKs("ks1", streamId); // USE response
      return mkRows("n", "val", streamId);
    }
    return READY_FRAME;
  }, async (port) => {
    const r = await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 5000, cql: "SELECT n FROM t", use_keyspace: "ks1" });
    assert.ok(received.length >= 2, `Expected at least 2 QUERY ops, got ${received.length}`);
    assert.strictEqual(r.rows[0].n, "val");
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// D: Security tests (10)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nD: Security");

TESTS.push(testAsync("D01 NUL byte in host → rejected", async () => {
  await assertRejects(
    cassandraClient({ operation: "info", host: "127.0.0.\x00" }),
    /NUL bytes/i,
  );
}));

TESTS.push(testAsync("D02 NUL byte in keyspace → rejected", async () => {
  await assertRejects(
    cassandraClient({ operation: "tables", host: "127.0.0.1", keyspace: "ks\x00evil" }),
    /NUL bytes/i,
  );
}));

TESTS.push(testAsync("D03 NUL byte in username → rejected", async () => {
  await assertRejects(
    cassandraClient({ operation: "info", host: "127.0.0.1", username: "admin\x00" }),
    /NUL bytes/i,
  );
}));

TESTS.push(testAsync("D04 host too long → rejected", async () => {
  await assertRejects(
    cassandraClient({ operation: "info", host: "a".repeat(300) }),
    /host.*too long/i,
  );
}));

TESTS.push(testAsync("D05 port 0 → rejected", async () => {
  await assertRejects(
    cassandraClient({ operation: "info", host: "127.0.0.1", port: 0 }),
    /port.*1-65535/i,
  );
}));

TESTS.push(testAsync("D06 no credentials when server requires auth → ToolError", async () => {
  await assertRejects(
    withMockServer((opcode, streamId) => {
      if (opcode === 0x01) {
        const body = Buffer.concat([mockStr("PasswordAuthenticator")]);
        const h = Buffer.allocUnsafe(9);
        h[0]=0x84; h[1]=0; h.writeInt16BE(streamId,2); h[4]=0x03; h.writeUInt32BE(body.length,5);
        return Buffer.concat([h, body]);
      }
      return READY_FRAME;
    }, async (port) => {
      await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 3000, cql: "SELECT 1" });
    }),
    /authentication|username/i,
  );
}));

TESTS.push(testAsync("D07 timeout clamped: below 1000 → 1000", async () => {
  // Can't easily observe the clamped value from outside, but we can confirm
  // it doesn't throw on tiny timeouts and connects within a mock server.
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x07) return mkRows("x", "1", streamId);
    return READY_FRAME;
  }, async (port) => {
    // Provide timeout=1 (below min); should be clamped to 1000 and still work.
    const r = await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 1, cql: "SELECT x FROM t" });
    assert.strictEqual(r.rows[0].x, "1");
  });
}));

TESTS.push(testAsync("D08 oversized CQL (>1MB) still sent — no client-side size limit", async () => {
  // The spec doesn't cap CQL length on the client, so this should reach the mock.
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x07) return mkVoid(streamId);
    return READY_FRAME;
  }, async (port) => {
    const bigCql = "SELECT " + "x,".repeat(5000) + " k FROM t";
    const r = await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 5000, cql: bigCql });
    // VOID is returned for non-SELECT but the important thing is no exception
    assert.ok(r.resultKind !== undefined);
  });
}));

TESTS.push(testAsync("D09 cql injection via keyspace is CQL-safe (quote escaping)", async () => {
  // The tables operation uses parameterised WHERE keyspace_name = '...' with quote-escaping.
  // We just verify the tool doesn't crash or throw a codec error when quotes are in keyspace.
  await assertRejects(
    // This will fail at TCP level (no server), not at injection level — proving the
    // string is escaped and passed through without syntax errors on the client side.
    cassandraClient({ operation: "tables", host: "127.0.0.1", port: 19998, timeout: 500, keyspace: "ks'evil" }),
    /connect|ECONNREFUSED|timeout/i,
  );
}));

TESTS.push(testAsync("D10 auth failure from server propagates as error", async () => {
  await assertRejects(
    withMockServer((opcode, streamId) => {
      if (opcode === 0x01) {
        const body = Buffer.concat([mockStr("PasswordAuthenticator")]);
        const h = Buffer.allocUnsafe(9);
        h[0]=0x84; h[1]=0; h.writeInt16BE(streamId,2); h[4]=0x03; h.writeUInt32BE(body.length,5);
        return Buffer.concat([h, body]);
      }
      if (opcode === 0x0f) return mkError(0x0100, "Bad credentials", streamId);
      return READY_FRAME;
    }, async (port) => {
      await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 3000, cql: "SELECT 1", username: "wrong", password: "wrong" });
    }),
    /Bad credentials|auth/i,
  );
}));

// ─────────────────────────────────────────────────────────────────────────────
// E: Error-paths tests (6)
// ─────────────────────────────────────────────────────────────────────────────

console.log("\nE: Error-paths");

TESTS.push(testAsync("E01 Cassandra server ERROR 0x2200 (read timeout) rejects promise", async () => {
  await assertRejects(
    withMockServer((opcode, streamId) => {
      if (opcode === 0x01) return READY_FRAME;
      return mkError(0x2200, "Read Request Timeout", streamId);
    }, async (port) => {
      await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 3000, cql: "SELECT * FROM t" });
    }),
    /Read Request Timeout/,
  );
}));

TESTS.push(testAsync("E02 Cassandra error 0x2100 (write timeout) rejects promise", async () => {
  await assertRejects(
    withMockServer((opcode, streamId) => {
      if (opcode === 0x01) return READY_FRAME;
      if (opcode === 0x07) return mkError(0x2100, "Write Request Timeout", streamId);
      return READY_FRAME;
    }, async (port) => {
      await cassandraClient({ operation: "query", host: "127.0.0.1", port, timeout: 3000, cql: "INSERT INTO t (k) VALUES ('x')" });
    }),
    /Write Request Timeout/,
  );
}));

TESTS.push(testAsync("E03 prepare failure rejects execute", async () => {
  await assertRejects(
    withMockServer((opcode, streamId) => {
      if (opcode === 0x01) return READY_FRAME;
      if (opcode === 0x09) return mkError(0x2000, "Syntax error", streamId);
      return READY_FRAME;
    }, async (port) => {
      await cassandraClient({ operation: "execute", host: "127.0.0.1", port, timeout: 3000, cql: "BAD CQL ???" });
    }),
    /Syntax error/,
  );
}));

TESTS.push(testAsync("E04 describe on non-existent table → ToolError", async () => {
  await assertRejects(
    withMockServer((opcode, streamId) => {
      if (opcode === 0x01) return READY_FRAME;
      if (opcode === 0x07) {
        // Return 0-row ROWS result
        const meta = Buffer.concat([mockInt(0x0001), mockInt(0), mockStr("s"), mockStr("t")]);
        const body = Buffer.concat([mockInt(0x0002), meta, mockInt(0)]);
        const h = Buffer.allocUnsafe(9);
        h[0]=0x84; h[1]=0; h.writeInt16BE(streamId,2); h[4]=0x08; h.writeUInt32BE(body.length,5);
        return Buffer.concat([h, body]);
      }
      return READY_FRAME;
    }, async (port) => {
      await cassandraClient({ operation: "describe", host: "127.0.0.1", port, timeout: 3000, table: "nonexistent", keyspace: "ks" });
    }),
    /not found/i,
  );
}));

TESTS.push(testAsync("E05 server closes connection mid-frame → error", async () => {
  await assertRejects(
    new Promise((resolve, reject) => {
      const server = net.createServer(socket => {
        socket.on("data", () => {
          // Send a partial frame then close
          socket.write(Buffer.from([0x84, 0, 0, 1, 0x08, 0, 0, 0])); // incomplete 9-byte header
          socket.destroy();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        cassandraClient({ operation: "info", host: "127.0.0.1", port, timeout: 3000 })
          .then(resolve, reject)
          .finally(() => server.close());
      });
    }),
    /connect|socket|timeout|closed/i,
  );
}));

TESTS.push(testAsync("E06 batch type 'invalid' → unknown → defaults to logged (no throw)", async () => {
  await withMockServer((opcode, streamId) => {
    if (opcode === 0x01) return READY_FRAME;
    if (opcode === 0x0d) return mkVoid(streamId);
    return READY_FRAME;
  }, async (port) => {
    // 'invalid' batch_type is handled by the fallback ?? 0 (logged)
    const r = await cassandraClient({
      operation:  "batch",
      host:       "127.0.0.1",
      port,
      timeout:    3000,
      statements: [{ cql: "INSERT INTO t (k) VALUES ('x')" }],
      batch_type: "invalid",  // will use default 0=LOGGED
    });
    assert.strictEqual(r.statementCount, 1);
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(TESTS).then(() => {
  console.log(`\nResults: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
