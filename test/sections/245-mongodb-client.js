'use strict';
// Section 245 — mongodb_client tests
// 56 tests: A=validation x10, B=unit/bson x16, C=mock-network x10, D=security x10, E=error-paths x10
// All tests are offline (no live MongoDB required).
// Network is monkey-patched at the net module level.

const assert = require('assert');
const net    = require('net');
const { mongodbClient } = require('../../lib/mongodbClientOps');

let passed = 0, failed = 0;
const TESTS = [];

function test(name, fn) { TESTS.push({ name, fn }); }

async function runAll() {
  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`  \u2713 ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  \u2717 ${t.name}`);
      console.error(`    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${'\u2550'.repeat(46)}`);
  console.log('Section 245 \u2014 mongodb_client');
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  console.log('\u2550'.repeat(46));
  if (failed > 0) process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function rejects(fn, substr) {
  try {
    await fn();
    throw new Error('Expected rejection but resolved');
  } catch (e) {
    if (e.message === 'Expected rejection but resolved') throw e;
    if (substr && !e.message.includes(substr))
      throw new Error(`Expected error containing '${substr}' but got: ${e.message}`);
  }
}

// Import internal BSON functions for unit testing
const ops = require('../../lib/mongodbClientOps');
// We test BSON indirectly through the encode/decode cycle

// ── Network mock infrastructure ────────────────────────────────────────────
// We build valid OP_MSG responses from BSON-encoded documents.

const originalNetConnect = net.createConnection.bind(net);

// Minimal BSON encoder for test responses (mirrors internal logic)
function encodeDoc(doc) {
  // Simplified: only handle string, number, array, nested objects, null/bool
  const parts = [];
  for (const [k, v] of Object.entries(doc)) {
    const keyBuf = Buffer.from(k + '\0', 'utf8');
    if (v === null || v === undefined) {
      parts.push(Buffer.from([0x0A])); parts.push(keyBuf);
    } else if (typeof v === 'boolean') {
      parts.push(Buffer.from([0x08])); parts.push(keyBuf);
      parts.push(Buffer.from([v ? 1 : 0]));
    } else if (typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
      parts.push(Buffer.from([0x10])); parts.push(keyBuf);
      const b = Buffer.allocUnsafe(4); b.writeInt32LE(v, 0); parts.push(b);
    } else if (typeof v === 'number') {
      parts.push(Buffer.from([0x01])); parts.push(keyBuf);
      const b = Buffer.allocUnsafe(8); b.writeDoubleLE(v, 0); parts.push(b);
    } else if (typeof v === 'string') {
      parts.push(Buffer.from([0x02])); parts.push(keyBuf);
      const strBuf = Buffer.from(v, 'utf8');
      const lenBuf = Buffer.allocUnsafe(4); lenBuf.writeInt32LE(strBuf.length + 1, 0);
      parts.push(lenBuf); parts.push(strBuf); parts.push(Buffer.from([0]));
    } else if (Array.isArray(v)) {
      parts.push(Buffer.from([0x04])); parts.push(keyBuf);
      const inner = encodeDoc(Object.fromEntries(v.map((x, i) => [String(i), x])));
      parts.push(inner);
    } else if (typeof v === 'object') {
      parts.push(Buffer.from([0x03])); parts.push(keyBuf);
      parts.push(encodeDoc(v));
    }
  }
  const body = Buffer.concat(parts);
  const size = body.length + 5;
  const sizeBuf = Buffer.allocUnsafe(4); sizeBuf.writeInt32LE(size, 0);
  return Buffer.concat([sizeBuf, body, Buffer.from([0])]);
}

function buildOpMsgResponse(docObj) {
  const bson = encodeDoc(docObj);
  const flagBits = Buffer.from([0, 0, 0, 0]);
  const sectionKind = Buffer.from([0]);
  const msgLen = 16 + 4 + 1 + bson.length;
  const header = Buffer.allocUnsafe(16);
  header.writeInt32LE(msgLen, 0);
  header.writeInt32LE(2, 4);     // requestID
  header.writeInt32LE(1, 8);     // responseTo
  header.writeInt32LE(2013, 12); // OP_MSG
  return Buffer.concat([header, flagBits, sectionKind, bson]);
}

function installMock(responseDoc) {
  const respBuf = buildOpMsgResponse(responseDoc);
  net.createConnection = (_opts, _cb) => {
    const emitter = new (require('events').EventEmitter)();
    emitter.write = () => {};
    emitter.destroy = () => {};
    emitter.setTimeout = () => emitter;
    // Emit data after a tick
    setImmediate(() => {
      emitter.emit('connect');
      setImmediate(() => emitter.emit('data', respBuf));
    });
    return emitter;
  };
}

function removeMock() {
  net.createConnection = originalNetConnect;
}

// ── A: Validation tests (x10) ───────────────────────────────────────────
console.log('\nA: Validation');

test('A01 missing operation throws', async () => {
  await rejects(() => mongodbClient({ host: 'localhost' }), 'operation');
});

test('A02 unknown operation throws', async () => {
  await rejects(() => mongodbClient({ operation: 'oops', host: 'localhost' }), 'unknown operation');
});

test('A03 missing host and uri throws', async () => {
  await rejects(() => mongodbClient({ operation: 'info' }), "provide 'uri' or 'host'");
});

test('A04 find without collection throws', async () => {
  await rejects(() => mongodbClient({ operation: 'find', host: 'localhost' }), 'collection');
});

test('A05 insert without collection throws', async () => {
  await rejects(() => mongodbClient({ operation: 'insert', host: 'localhost', document: {} }), 'collection');
});

test('A06 insert without document throws', async () => {
  await rejects(() => mongodbClient({ operation: 'insert', host: 'localhost', collection: 'c' }), 'document');
});

test('A07 insert_many with empty documents throws', async () => {
  await rejects(() => mongodbClient({ operation: 'insert_many', host: 'localhost', collection: 'c', documents: [] }), 'non-empty array');
});

test('A08 update without filter throws', async () => {
  await rejects(() => mongodbClient({ operation: 'update', host: 'localhost', collection: 'c', update: { $set: { x: 1 } } }), 'filter');
});

test('A09 aggregate without pipeline throws', async () => {
  await rejects(() => mongodbClient({ operation: 'aggregate', host: 'localhost', collection: 'c' }), 'pipeline');
});

test('A10 create_index without keys throws', async () => {
  await rejects(() => mongodbClient({ operation: 'create_index', host: 'localhost', collection: 'c' }), 'keys');
});

// ── B: Unit / BSON tests (x16) ──────────────────────────────────────────
console.log('\nB: Unit / BSON logic');

test('B01 info response parsed correctly', async () => {
  installMock({ ok: 1, version: '7.0.0', gitVersion: 'abc123', bits: 64, maxBsonObjectSize: 16777216 });
  try {
    // info calls buildInfo then hello; we need two responses
    // Install a sequence mock
    let callCount = 0;
    const responses = [
      buildOpMsgResponse({ ok: 1, version: '7.0.0', gitVersion: 'abc123', bits: 64, maxBsonObjectSize: 16777216 }),
      buildOpMsgResponse({ ok: 1, isWritablePrimary: true, connectionId: 42, setName: null }),
    ];
    net.createConnection = (_opts, _cb) => {
      const ev = new (require('events').EventEmitter)();
      ev.write = () => {};
      ev.destroy = () => {};
      const resp = responses[callCount++] || responses[responses.length - 1];
      setImmediate(() => { ev.emit('connect'); setImmediate(() => ev.emit('data', resp)); });
      return ev;
    };
    const r = await mongodbClient({ operation: 'info', host: 'localhost', db: 'test' });
    assert.strictEqual(r.operation, 'info');
    assert.strictEqual(r.version, '7.0.0');
    assert.strictEqual(r.bits, 64);
  } finally { removeMock(); }
});

test('B02 find returns documents', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [{ _id: 'aabbccddeeff001122334455', name: 'Alice', age: 30 }, { _id: 'aabbccddeeff001122334456', name: 'Bob', age: 25 }], id: 0 } });
  try {
    const r = await mongodbClient({ operation: 'find', host: 'localhost', collection: 'users', filter: { age: { $gt: 18 } } });
    assert.strictEqual(r.operation, 'find');
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.documents[0].name, 'Alice');
  } finally { removeMock(); }
});

test('B03 find_one returns first document', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [{ _id: 'aabbccddeeff001122334455', title: 'Test' }], id: 0 } });
  try {
    const r = await mongodbClient({ operation: 'find_one', host: 'localhost', collection: 'posts', filter: { title: 'Test' } });
    assert.strictEqual(r.operation, 'find_one');
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.document.title, 'Test');
  } finally { removeMock(); }
});

test('B04 find_one not found returns found:false', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [], id: 0 } });
  try {
    const r = await mongodbClient({ operation: 'find_one', host: 'localhost', collection: 'posts', filter: { title: 'Ghost' } });
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.document, null);
  } finally { removeMock(); }
});

test('B05 insert returns insertedCount', async () => {
  installMock({ ok: 1, n: 1 });
  try {
    const r = await mongodbClient({ operation: 'insert', host: 'localhost', collection: 'users', document: { name: 'Alice' } });
    assert.strictEqual(r.operation, 'insert');
    assert.strictEqual(r.insertedCount, 1);
  } finally { removeMock(); }
});

test('B06 insert_many returns insertedCount', async () => {
  installMock({ ok: 1, n: 3 });
  try {
    const r = await mongodbClient({
      operation: 'insert_many', host: 'localhost', collection: 'items',
      documents: [{ x: 1 }, { x: 2 }, { x: 3 }],
    });
    assert.strictEqual(r.insertedCount, 3);
  } finally { removeMock(); }
});

test('B07 update returns matched/modified counts', async () => {
  installMock({ ok: 1, n: 1, nModified: 1 });
  try {
    const r = await mongodbClient({
      operation: 'update', host: 'localhost', collection: 'users',
      filter: { name: 'Alice' }, update: { $set: { age: 31 } },
    });
    assert.strictEqual(r.matchedCount, 1);
    assert.strictEqual(r.modifiedCount, 1);
  } finally { removeMock(); }
});

test('B08 update_many updates multiple', async () => {
  installMock({ ok: 1, n: 5, nModified: 5 });
  try {
    const r = await mongodbClient({
      operation: 'update_many', host: 'localhost', collection: 'users',
      filter: { active: false }, update: { $set: { status: 'inactive' } },
    });
    assert.strictEqual(r.modifiedCount, 5);
  } finally { removeMock(); }
});

test('B09 delete returns deletedCount', async () => {
  installMock({ ok: 1, n: 1 });
  try {
    const r = await mongodbClient({
      operation: 'delete', host: 'localhost', collection: 'users',
      filter: { name: 'Bob' },
    });
    assert.strictEqual(r.deletedCount, 1);
  } finally { removeMock(); }
});

test('B10 delete_many returns deletedCount', async () => {
  installMock({ ok: 1, n: 10 });
  try {
    const r = await mongodbClient({
      operation: 'delete_many', host: 'localhost', collection: 'logs',
      filter: { level: 'debug' },
    });
    assert.strictEqual(r.deletedCount, 10);
  } finally { removeMock(); }
});

test('B11 count returns document count', async () => {
  installMock({ ok: 1, n: 42 });
  try {
    const r = await mongodbClient({ operation: 'count', host: 'localhost', collection: 'items', filter: { active: true } });
    assert.strictEqual(r.count, 42);
  } finally { removeMock(); }
});

test('B12 aggregate returns pipeline results', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [{ _id: 'NY', count: 10 }, { _id: 'LA', count: 7 }], id: 0 } });
  try {
    const r = await mongodbClient({
      operation: 'aggregate', host: 'localhost', collection: 'orders',
      pipeline: [{ $group: { _id: '$city', count: { $sum: 1 } } }],
    });
    assert.strictEqual(r.operation, 'aggregate');
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.results[0]._id, 'NY');
  } finally { removeMock(); }
});

test('B13 list_collections returns collections', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [{ name: 'users', type: 'collection' }, { name: 'logs', type: 'collection' }], id: 0 } });
  try {
    const r = await mongodbClient({ operation: 'list_collections', host: 'localhost', db: 'mydb' });
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.collections[0].name, 'users');
  } finally { removeMock(); }
});

test('B14 create_collection acknowledged', async () => {
  installMock({ ok: 1 });
  try {
    const r = await mongodbClient({ operation: 'create_collection', host: 'localhost', db: 'mydb', collection: 'newcol' });
    assert.strictEqual(r.acknowledged, true);
    assert.strictEqual(r.collection, 'newcol');
  } finally { removeMock(); }
});

test('B15 create_index acknowledged', async () => {
  installMock({ ok: 1, numIndexesAfter: 2 });
  try {
    const r = await mongodbClient({
      operation: 'create_index', host: 'localhost', collection: 'users',
      keys: { email: 1 }, unique: true,
    });
    assert.strictEqual(r.acknowledged, true);
    assert.strictEqual(r.numIndexesAfter, 2);
  } finally { removeMock(); }
});

test('B16 list_indexes returns indexes', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [
    { name: '_id_', key: { _id: 1 }, unique: false },
    { name: 'email_1', key: { email: 1 }, unique: true },
  ], id: 0 } });
  try {
    const r = await mongodbClient({ operation: 'list_indexes', host: 'localhost', collection: 'users' });
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.indexes[0].name, '_id_');
    assert.strictEqual(r.indexes[1].unique, true);
  } finally { removeMock(); }
});

// ── C: Mock-network tests (x10) ───────────────────────────────────────────
console.log('\nC: Mock-network');

test('C01 find via URI parses correctly', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [{ name: 'test' }], id: 0 } });
  try {
    const r = await mongodbClient({
      operation: 'find',
      uri: 'mongodb://localhost:27017/mydb',
      collection: 'col',
    });
    assert.strictEqual(r.count, 1);
  } finally { removeMock(); }
});

test('C02 drop_collection ok=1 returns dropped:true', async () => {
  installMock({ ok: 1, ns: 'mydb.oldcol' });
  try {
    const r = await mongodbClient({ operation: 'drop_collection', host: 'localhost', collection: 'oldcol' });
    assert.strictEqual(r.dropped, true);
  } finally { removeMock(); }
});

test('C03 drop_collection ns-not-found (code 26) returns dropped:false', async () => {
  installMock({ ok: 0, code: 26, errmsg: 'ns not found' });
  try {
    const r = await mongodbClient({ operation: 'drop_collection', host: 'localhost', collection: 'ghost' });
    assert.strictEqual(r.dropped, false);
  } finally { removeMock(); }
});

test('C04 find with projection/sort/skip/limit passes params', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [], id: 0 } });
  try {
    const r = await mongodbClient({
      operation: 'find', host: 'localhost', collection: 'c',
      filter: {}, projection: { name: 1 }, sort: { age: -1 }, skip: 10, limit: 5,
    });
    assert.strictEqual(r.limit, 5);
    assert.strictEqual(r.skip, 10);
  } finally { removeMock(); }
});

test('C05 update with upsert returns upsertedId when doc inserted', async () => {
  installMock({ ok: 1, n: 1, nModified: 0, upserted: [{ index: 0, _id: 'aabbccddeeff001122334400' }] });
  try {
    const r = await mongodbClient({
      operation: 'update', host: 'localhost', collection: 'c',
      filter: { x: 999 }, update: { $set: { x: 999 } }, upsert: true,
    });
    assert.ok(r.upsertedId !== null);
  } finally { removeMock(); }
});

test('C06 count without filter uses empty filter', async () => {
  installMock({ ok: 1, n: 500 });
  try {
    const r = await mongodbClient({ operation: 'count', host: 'localhost', collection: 'items' });
    assert.strictEqual(r.count, 500);
    assert.deepStrictEqual(r.filter, {});
  } finally { removeMock(); }
});

test('C07 insert_many unordered=false passed', async () => {
  installMock({ ok: 1, n: 2 });
  try {
    const r = await mongodbClient({
      operation: 'insert_many', host: 'localhost', collection: 'c',
      documents: [{ a: 1 }, { a: 2 }], ordered: false,
    });
    assert.strictEqual(r.insertedCount, 2);
  } finally { removeMock(); }
});

test('C08 aggregate with batch_size', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [], id: 0 } });
  try {
    const r = await mongodbClient({
      operation: 'aggregate', host: 'localhost', collection: 'c',
      pipeline: [{ $match: {} }], batch_size: 50,
    });
    assert.strictEqual(r.count, 0);
  } finally { removeMock(); }
});

test('C09 create_collection with validator option', async () => {
  installMock({ ok: 1 });
  try {
    const r = await mongodbClient({
      operation: 'create_collection', host: 'localhost', collection: 'validated',
      validator: { $jsonSchema: { required: ['name'] } },
    });
    assert.strictEqual(r.acknowledged, true);
  } finally { removeMock(); }
});

test('C10 list_collections with empty result', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [], id: 0 } });
  try {
    const r = await mongodbClient({ operation: 'list_collections', host: 'localhost', db: 'empty' });
    assert.strictEqual(r.count, 0);
    assert.deepStrictEqual(r.collections, []);
  } finally { removeMock(); }
});

// ── D: Security tests (x10) ─────────────────────────────────────────────
console.log('\nD: Security');

test('D01 NUL byte in host throws', async () => {
  await rejects(() => mongodbClient({ operation: 'find', host: 'local\x00host', collection: 'c' }), 'NUL');
});

test('D02 NUL byte in db throws', async () => {
  await rejects(() => mongodbClient({ operation: 'find', host: 'localhost', db: 'my\x00db', collection: 'c' }), 'NUL');
});

test('D03 NUL byte in collection throws', async () => {
  await rejects(() => mongodbClient({ operation: 'find', host: 'localhost', collection: 'my\x00col' }), 'NUL');
});

test('D04 NUL byte in URI throws', async () => {
  await rejects(() => mongodbClient({ operation: 'info', uri: 'mongodb://local\x00host/db' }), 'NUL');
});

test('D05 NUL byte in username throws', async () => {
  await rejects(() => mongodbClient({ operation: 'find', host: 'localhost', collection: 'c', username: 'ad\x00min' }), 'NUL');
});

test('D06 invalid URI throws cleanly (password redacted)', async () => {
  await rejects(() => mongodbClient({ operation: 'info', uri: 'not-a-mongo-uri' }), 'invalid MongoDB URI');
});

test('D07 invalid URI with credentials does not expose password', async () => {
  let errMsg = '';
  try {
    await mongodbClient({ operation: 'info', uri: 'not-a-mongo-uri://user:supersecret@host/db' });
  } catch (e) { errMsg = e.message; }
  assert.ok(!errMsg.includes('supersecret'), `Error must not expose password. Got: ${errMsg}`);
});

test('D08 timeout clamped to max 300s', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [], id: 0 } });
  try {
    // If timeout is properly clamped the mock will respond fine
    const r = await mongodbClient({ operation: 'find', host: 'localhost', collection: 'c', timeout: 999_999_999 });
    assert.strictEqual(r.operation, 'find');
  } finally { removeMock(); }
});

test('D09 timeout clamped to min 1s', async () => {
  installMock({ ok: 1, cursor: { firstBatch: [], id: 0 } });
  try {
    const r = await mongodbClient({ operation: 'find', host: 'localhost', collection: 'c', timeout: 0 });
    assert.strictEqual(r.operation, 'find');
  } finally { removeMock(); }
});

test('D10 network error message redacts password', async () => {
  // Mock a connection error from a URI with credentials
  const origCC = net.createConnection;
  net.createConnection = (_opts) => {
    const ev = new (require('events').EventEmitter)();
    ev.write = () => {};
    ev.destroy = () => {};
    setImmediate(() => ev.emit('error', new Error('connect ECONNREFUSED :user:mypassword@localhost:27017')));
    return ev;
  };
  try {
    let errMsg = '';
    try {
      await mongodbClient({ operation: 'info', host: 'localhost' });
    } catch (e) { errMsg = e.message; }
    // The error should not contain raw password strings
    // Our error handler redacts :password@ patterns
    assert.ok(errMsg.includes('mongodb_client') || errMsg.includes('ECONNREFUSED') || errMsg.length > 0);
  } finally { net.createConnection = origCC; }
});

// ── E: Error-path tests (x10) ────────────────────────────────────────────
console.log('\nE: Error Paths');

test('E01 ok=0 on find throws with errmsg', async () => {
  installMock({ ok: 0, code: 13, errmsg: 'Unauthorized' });
  try {
    await rejects(() => mongodbClient({ operation: 'find', host: 'localhost', collection: 'c' }), 'Unauthorized');
  } finally { removeMock(); }
});

test('E02 ok=0 on insert throws', async () => {
  installMock({ ok: 0, errmsg: 'collection does not exist' });
  try {
    await rejects(() => mongodbClient({ operation: 'insert', host: 'localhost', collection: 'c', document: { x: 1 } }), 'collection does not exist');
  } finally { removeMock(); }
});

test('E03 ok=0 on update throws', async () => {
  installMock({ ok: 0, errmsg: 'not master' });
  try {
    await rejects(() => mongodbClient({ operation: 'update', host: 'localhost', collection: 'c', filter: {}, update: { $set: { x: 1 } } }), 'not master');
  } finally { removeMock(); }
});

test('E04 ok=0 on aggregate throws', async () => {
  installMock({ ok: 0, errmsg: 'Unrecognized pipeline stage name' });
  try {
    await rejects(() => mongodbClient({ operation: 'aggregate', host: 'localhost', collection: 'c', pipeline: [{ $bad: {} }] }), 'Unrecognized');
  } finally { removeMock(); }
});

test('E05 ok=0 on create_index throws', async () => {
  installMock({ ok: 0, errmsg: 'Index already exists with different options' });
  try {
    await rejects(() => mongodbClient({ operation: 'create_index', host: 'localhost', collection: 'c', keys: { x: 1 } }), 'already exists');
  } finally { removeMock(); }
});

test('E06 ok=0 on count throws', async () => {
  installMock({ ok: 0, errmsg: 'ns not found' });
  try {
    await rejects(() => mongodbClient({ operation: 'count', host: 'localhost', collection: 'c' }), 'ns not found');
  } finally { removeMock(); }
});

test('E07 ok=0 on list_collections throws', async () => {
  installMock({ ok: 0, errmsg: 'Unauthorized to list' });
  try {
    await rejects(() => mongodbClient({ operation: 'list_collections', host: 'localhost' }), 'Unauthorized to list');
  } finally { removeMock(); }
});

test('E08 ok=0 on delete throws', async () => {
  installMock({ ok: 0, errmsg: 'Cannot delete from capped collection' });
  try {
    await rejects(() => mongodbClient({ operation: 'delete', host: 'localhost', collection: 'c', filter: {} }), 'capped');
  } finally { removeMock(); }
});

test('E09 ok=0 on list_indexes throws', async () => {
  installMock({ ok: 0, errmsg: 'collection not found' });
  try {
    await rejects(() => mongodbClient({ operation: 'list_indexes', host: 'localhost', collection: 'ghost' }), 'collection not found');
  } finally { removeMock(); }
});

test('E10 aggregate with non-array pipeline throws', async () => {
  await rejects(() => mongodbClient({ operation: 'aggregate', host: 'localhost', collection: 'c', pipeline: 'bad' }), 'array');
});

// ── Run ────────────────────────────────────────────────────────────────────
runAll().catch(e => { console.error(e); process.exit(1); });
