'use strict';
// Section 244 — elasticsearch_client tests
// 56 tests: A=validation x10, B=unit x20, C=mock-network x10, D=security x10, E=error-paths x6
// All tests are offline (no live Elasticsearch required).
// Network operations are monkey-patched at the https/http module level.

const assert = require('assert');
const http   = require('http');
const https  = require('https');
const { elasticsearchClient } = require('../../lib/elasticsearchClientOps');

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
  console.log('Section 244 \u2014 elasticsearch_client');
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  console.log('\u2550'.repeat(46));
  if (failed > 0) process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Network mock infrastructure ───────────────────────────────────────────────

const originalHttpRequest  = http.request.bind(http);
const originalHttpsRequest = https.request.bind(https);

function installMock(statusCode, body) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const fakeFn = (_opts, cb) => {
    const resObj = {
      statusCode,
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data') setImmediate(() => handler(Buffer.from(bodyStr, 'utf8')));
        if (event === 'end')  setImmediate(() => handler());
        // ignore 'error'
        return this;
      },
    };
    if (cb) cb(resObj);
    return {
      setTimeout: function() { return this; },
      on: function() { return this; },
      write: () => {},
      end:   () => {},
      destroy: () => {},
    };
  };
  http.request  = fakeFn;
  https.request = fakeFn;
}

function removeMock() {
  http.request  = originalHttpRequest;
  https.request = originalHttpsRequest;
}

// ── A: Validation tests (x10) ─────────────────────────────────────────────────
console.log('\nA: Validation');

test('A01 missing operation throws', async () => {
  await rejects(() => elasticsearchClient({ url: 'http://localhost:9200' }), 'operation');
});

test('A02 unknown operation throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'foobar', url: 'http://localhost:9200' }), 'unknown operation');
});

test('A03 missing url throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'info' }), 'url');
});

test('A04 invalid url protocol throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'info', url: 'ftp://localhost' }), 'http or https');
});

test('A05 get without index throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'get', url: 'http://localhost:9200', id: '1' }), 'index');
});

test('A06 get without id throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'get', url: 'http://localhost:9200', index: 'myidx' }), 'id');
});

test('A07 index without index name throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'index', url: 'http://localhost:9200', document: { x: 1 } }), 'index');
});

test('A08 index without document throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'index', url: 'http://localhost:9200', index: 'myidx' }), 'document');
});

test('A09 delete without index throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'delete', url: 'http://localhost:9200', id: '1' }), 'index');
});

test('A10 delete without id throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'delete', url: 'http://localhost:9200', index: 'myidx' }), 'id');
});

// ── B: Unit tests (x20) ───────────────────────────────────────────────────────
console.log('\nB: Unit / Logic');

test('B01 info response parsed correctly', async () => {
  installMock(200, {
    name: 'node-1', cluster_name: 'my-cluster', cluster_uuid: 'abc123',
    version: { number: '8.10.0', lucene_version: '9.7.0' },
    tagline: 'You Know, for Search',
  });
  try {
    const r = await elasticsearchClient({ operation: 'info', url: 'http://localhost:9200' });
    assert.strictEqual(r.operation, 'info');
    assert.strictEqual(r.clusterName, 'my-cluster');
    assert.strictEqual(r.name, 'node-1');
    assert.strictEqual(r.tagline, 'You Know, for Search');
    assert.ok(r.version);
  } finally { removeMock(); }
});

test('B02 search response parsed correctly', async () => {
  installMock(200, {
    took: 5, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 },
    hits: {
      total: { value: 2, relation: 'eq' }, max_score: 1.5,
      hits: [
        { _index: 'myidx', _id: '1', _score: 1.5, _source: { title: 'Hello' } },
        { _index: 'myidx', _id: '2', _score: 1.0, _source: { title: 'World' } },
      ],
    },
  });
  try {
    const r = await elasticsearchClient({ operation: 'search', url: 'http://localhost:9200', index: 'myidx', query: { match_all: {} }, size: 10 });
    assert.strictEqual(r.operation, 'search');
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.took, 5);
    assert.strictEqual(r.hits.length, 2);
    assert.strictEqual(r.hits[0].id, '1');
    assert.strictEqual(r.hits[0].source.title, 'Hello');
  } finally { removeMock(); }
});

test('B03 search handles numeric total (ES7)', async () => {
  installMock(200, { took: 3, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: 5, max_score: 2.0, hits: [] } });
  try {
    const r = await elasticsearchClient({ operation: 'search', url: 'http://localhost:9200', query: { match_all: {} } });
    assert.strictEqual(r.total, 5);
    assert.strictEqual(r.hits.length, 0);
  } finally { removeMock(); }
});

test('B04 get found document', async () => {
  installMock(200, { _index: 'myidx', _id: '42', _version: 3, _seq_no: 5, found: true, _source: { name: 'Alice', age: 30 } });
  try {
    const r = await elasticsearchClient({ operation: 'get', url: 'http://localhost:9200', index: 'myidx', id: '42' });
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.id, '42');
    assert.strictEqual(r.source.name, 'Alice');
    assert.strictEqual(r.version, 3);
  } finally { removeMock(); }
});

test('B05 get not-found returns found:false', async () => {
  installMock(404, { _index: 'myidx', _id: '99', found: false });
  try {
    const r = await elasticsearchClient({ operation: 'get', url: 'http://localhost:9200', index: 'myidx', id: '99' });
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.source, null);
  } finally { removeMock(); }
});

test('B06 index document returns result', async () => {
  installMock(201, { _index: 'myidx', _id: 'abc', _version: 1, result: 'created', _shards: { total: 2, successful: 1, failed: 0 }, _seq_no: 0 });
  try {
    const r = await elasticsearchClient({ operation: 'index', url: 'http://localhost:9200', index: 'myidx', document: { title: 'Test' } });
    assert.strictEqual(r.result, 'created');
    assert.strictEqual(r.index, 'myidx');
  } finally { removeMock(); }
});

test('B07 delete existing document', async () => {
  installMock(200, { _index: 'myidx', _id: '1', _version: 2, result: 'deleted' });
  try {
    const r = await elasticsearchClient({ operation: 'delete', url: 'http://localhost:9200', index: 'myidx', id: '1' });
    assert.strictEqual(r.result, 'deleted');
    assert.strictEqual(r.found, true);
  } finally { removeMock(); }
});

test('B08 delete not-found returns not_found', async () => {
  installMock(404, { _index: 'myidx', _id: '99', result: 'not_found' });
  try {
    const r = await elasticsearchClient({ operation: 'delete', url: 'http://localhost:9200', index: 'myidx', id: '99' });
    assert.strictEqual(r.result, 'not_found');
    assert.strictEqual(r.found, false);
  } finally { removeMock(); }
});

test('B09 create_index success', async () => {
  installMock(200, { acknowledged: true, shards_acknowledged: true, index: 'new-idx' });
  try {
    const r = await elasticsearchClient({
      operation: 'create_index', url: 'http://localhost:9200', index: 'new-idx',
      settings: { number_of_shards: 1 },
      mappings: { properties: { title: { type: 'text' } } },
    });
    assert.strictEqual(r.acknowledged, true);
    assert.strictEqual(r.indexName, 'new-idx');
  } finally { removeMock(); }
});

test('B10 delete_index success', async () => {
  installMock(200, { acknowledged: true });
  try {
    const r = await elasticsearchClient({ operation: 'delete_index', url: 'http://localhost:9200', index: 'old-idx' });
    assert.strictEqual(r.acknowledged, true);
    assert.strictEqual(r.found, true);
  } finally { removeMock(); }
});

test('B11 delete_index not found returns found:false', async () => {
  installMock(404, { error: { type: 'index_not_found_exception' } });
  try {
    const r = await elasticsearchClient({ operation: 'delete_index', url: 'http://localhost:9200', index: 'ghost' });
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.acknowledged, false);
  } finally { removeMock(); }
});

test('B12 indices returns structured list', async () => {
  installMock(200, [
    { index: 'idx-a', health: 'green', status: 'open', pri: '1', rep: '0', 'docs.count': '100', 'docs.deleted': '5', 'store.size': '10mb', 'creation.date.string': '2024-01-01' },
    { index: 'idx-b', health: 'yellow', status: 'open', pri: '2', rep: '1', 'docs.count': '50', 'docs.deleted': '0', 'store.size': '5mb', 'creation.date.string': '2024-06-01' },
  ]);
  try {
    const r = await elasticsearchClient({ operation: 'indices', url: 'http://localhost:9200' });
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.indices[0].index, 'idx-a');
    assert.strictEqual(r.indices[0].health, 'green');
    assert.strictEqual(r.indices[0].docsCount, 100);
    assert.strictEqual(r.indices[1].replicaShards, 1);
  } finally { removeMock(); }
});

test('B13 mapping returns properties', async () => {
  installMock(200, { myidx: { mappings: { dynamic: 'strict', properties: { title: { type: 'text' }, created: { type: 'date' } } } } });
  try {
    const r = await elasticsearchClient({ operation: 'mapping', url: 'http://localhost:9200', index: 'myidx' });
    assert.strictEqual(r.dynamic, 'strict');
    assert.ok(r.properties.title);
    assert.strictEqual(r.properties.title.type, 'text');
  } finally { removeMock(); }
});

test('B14 count returns count', async () => {
  installMock(200, { count: 42, _shards: { total: 1, successful: 1, failed: 0 } });
  try {
    const r = await elasticsearchClient({ operation: 'count', url: 'http://localhost:9200', index: 'myidx', query: { match_all: {} } });
    assert.strictEqual(r.count, 42);
    assert.strictEqual(r.index, 'myidx');
  } finally { removeMock(); }
});

test('B15 cluster_health returns status', async () => {
  installMock(200, { cluster_name: 'my-cluster', status: 'green', timed_out: false, number_of_nodes: 3, number_of_data_nodes: 3, active_primary_shards: 10, active_shards: 20 });
  try {
    const r = await elasticsearchClient({ operation: 'cluster_health', url: 'http://localhost:9200' });
    assert.strictEqual(r.status, 'green');
    assert.strictEqual(r.cluster_name, 'my-cluster');
    assert.strictEqual(r.number_of_nodes, 3);
  } finally { removeMock(); }
});

test('B16 bulk returns summary', async () => {
  installMock(200, {
    took: 10, errors: false,
    items: [
      { index: { _index: 'myidx', _id: '1', result: 'created', status: 201 } },
      { index: { _index: 'myidx', _id: '2', result: 'created', status: 201 } },
    ],
  });
  try {
    const r = await elasticsearchClient({
      operation: 'bulk', url: 'http://localhost:9200', index: 'myidx',
      operations: [
        { action: 'index', id: '1', document: { title: 'Doc 1' } },
        { action: 'index', id: '2', document: { title: 'Doc 2' } },
      ],
    });
    assert.strictEqual(r.errors, false);
    assert.strictEqual(r.total, 2);
    assert.strictEqual(r.errorCount, 0);
  } finally { removeMock(); }
});

test('B17 bulk with errors surfaces errorItems', async () => {
  installMock(200, {
    took: 5, errors: true,
    items: [
      { create: { _index: 'myidx', _id: '1', status: 409, error: { type: 'version_conflict_engine_exception', reason: 'already exists' } } },
      { index:  { _index: 'myidx', _id: '2', result: 'created', status: 201 } },
    ],
  });
  try {
    const r = await elasticsearchClient({
      operation: 'bulk', url: 'http://localhost:9200', index: 'myidx',
      operations: [
        { action: 'create', id: '1', document: { title: 'Dup' } },
        { action: 'index',  id: '2', document: { title: 'OK' } },
      ],
    });
    assert.strictEqual(r.errors, true);
    assert.strictEqual(r.errorCount, 1);
    assert.strictEqual(r.errorItems[0].action, 'create');
  } finally { removeMock(); }
});

test('B18 search with aggregations returned', async () => {
  installMock(200, {
    took: 2, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 },
    hits: { total: { value: 0, relation: 'eq' }, max_score: null, hits: [] },
    aggregations: { by_status: { buckets: [{ key: 'open', doc_count: 10 }] } },
  });
  try {
    const r = await elasticsearchClient({
      operation: 'search', url: 'http://localhost:9200',
      query: { match_all: {} }, size: 0,
      aggs: { by_status: { terms: { field: 'status' } } },
    });
    assert.ok(r.aggregations);
    assert.ok(r.aggregations.by_status.buckets);
  } finally { removeMock(); }
});

test('B19 index without id uses POST (auto-id)', async () => {
  installMock(201, { _index: 'myidx', _id: 'auto-abc', _version: 1, result: 'created', _shards: { total: 1, successful: 1, failed: 0 } });
  try {
    const r = await elasticsearchClient({ operation: 'index', url: 'http://localhost:9200', index: 'myidx', document: { val: 42 } });
    assert.strictEqual(r.result, 'created');
    assert.strictEqual(r.id, 'auto-abc');
  } finally { removeMock(); }
});

test('B20 bulk without operations throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'bulk', url: 'http://localhost:9200', index: 'myidx', operations: [] }), 'non-empty array');
});

// ── C: Mock-network tests (x10) ───────────────────────────────────────────────
console.log('\nC: Mock-network');

test('C01 HTTP 4xx on search throws with status code', async () => {
  installMock(400, { error: { type: 'parsing_exception', reason: 'bad query' } });
  try {
    await rejects(() => elasticsearchClient({ operation: 'search', url: 'http://localhost:9200', query: { bad: true } }), 'HTTP 400');
  } finally { removeMock(); }
});

test('C02 HTTP 5xx on info throws', async () => {
  installMock(503, { error: { reason: 'service unavailable' } });
  try {
    await rejects(() => elasticsearchClient({ operation: 'info', url: 'http://localhost:9200' }), 'HTTP 503');
  } finally { removeMock(); }
});

test('C03 mapping throws without index', async () => {
  await rejects(() => elasticsearchClient({ operation: 'mapping', url: 'http://localhost:9200' }), 'index');
});

test('C04 create_index throws without index name', async () => {
  await rejects(() => elasticsearchClient({ operation: 'create_index', url: 'http://localhost:9200' }), 'index');
});

test('C05 delete_index throws without index name', async () => {
  await rejects(() => elasticsearchClient({ operation: 'delete_index', url: 'http://localhost:9200' }), 'index');
});

test('C06 indices with pattern', async () => {
  installMock(200, [
    { index: 'app-2024-01', health: 'green', status: 'open', pri: '1', rep: '0', 'docs.count': '1000', 'docs.deleted': '0', 'store.size': '100mb', 'creation.date.string': '2024-01-01' },
  ]);
  try {
    const r = await elasticsearchClient({ operation: 'indices', url: 'http://localhost:9200', pattern: 'app-*' });
    assert.strictEqual(r.pattern, 'app-*');
    assert.strictEqual(r.count, 1);
  } finally { removeMock(); }
});

test('C07 cluster_health with level=indices', async () => {
  installMock(200, { cluster_name: 'prod', status: 'yellow', timed_out: false, number_of_nodes: 2, indices: { 'my-index': { status: 'green' } } });
  try {
    const r = await elasticsearchClient({ operation: 'cluster_health', url: 'http://localhost:9200', level: 'indices' });
    assert.strictEqual(r.status, 'yellow');
    assert.ok(r.indices);
  } finally { removeMock(); }
});

test('C08 search with HTTPS url', async () => {
  installMock(200, { took: 1, timed_out: false, _shards: { total: 1, successful: 1, failed: 0 }, hits: { total: { value: 0, relation: 'eq' }, max_score: null, hits: [] } });
  try {
    const r = await elasticsearchClient({ operation: 'search', url: 'https://myserver:9243', index: 'myidx', query: { match_all: {} }, reject_unauthorized: false });
    assert.strictEqual(r.total, 0);
  } finally { removeMock(); }
});

test('C09 count without query uses match_all semantics', async () => {
  installMock(200, { count: 999, _shards: { total: 5, successful: 5, failed: 0 } });
  try {
    const r = await elasticsearchClient({ operation: 'count', url: 'http://localhost:9200' });
    assert.strictEqual(r.count, 999);
    assert.strictEqual(r.index, '_all');
  } finally { removeMock(); }
});

test('C10 bulk with update action', async () => {
  installMock(200, { took: 3, errors: false, items: [{ update: { _index: 'myidx', _id: '1', result: 'updated', status: 200 } }] });
  try {
    const r = await elasticsearchClient({
      operation: 'bulk', url: 'http://localhost:9200', index: 'myidx',
      operations: [{ action: 'update', id: '1', doc: { title: 'Updated' }, doc_as_upsert: true }],
    });
    assert.strictEqual(r.errors, false);
    assert.strictEqual(r.items[0].result, 'updated');
  } finally { removeMock(); }
});

// ── D: Security tests (x10) ───────────────────────────────────────────────────
console.log('\nD: Security');

test('D01 NUL byte in url throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'info', url: 'http://local\x00host:9200' }), 'NUL');
});

test('D02 NUL byte in index throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'get', url: 'http://localhost:9200', index: 'my\x00idx', id: '1' }), 'NUL');
});

test('D03 NUL byte in id throws', async () => {
  await rejects(() => elasticsearchClient({ operation: 'get', url: 'http://localhost:9200', index: 'myidx', id: 'abc\x00def' }), 'NUL');
});

test('D04 invalid url throws cleanly', async () => {
  await rejects(() => elasticsearchClient({ operation: 'info', url: 'not-a-url' }), 'invalid');
});

test('D05 ftp url rejected', async () => {
  await rejects(() => elasticsearchClient({ operation: 'info', url: 'ftp://localhost:9200' }), 'http or https');
});

test('D06 bulk with unknown action throws', async () => {
  await rejects(
    () => elasticsearchClient({ operation: 'bulk', url: 'http://localhost:9200', operations: [{ action: 'evil', id: '1', document: { x: 1 } }] }),
    'unknown action'
  );
});

test('D07 bulk index operation without document throws', async () => {
  await rejects(
    () => elasticsearchClient({ operation: 'bulk', url: 'http://localhost:9200', operations: [{ action: 'index', id: '1' }] }),
    'document'
  );
});

test('D08 bulk create operation without document throws', async () => {
  await rejects(
    () => elasticsearchClient({ operation: 'bulk', url: 'http://localhost:9200', operations: [{ action: 'create', id: '1' }] }),
    'document'
  );
});

test('D09 error message does not expose password', async () => {
  installMock(401, { error: { reason: 'Unauthorized' } });
  try {
    let errMsg = '';
    try {
      await elasticsearchClient({ operation: 'info', url: 'http://localhost:9200', auth: { type: 'basic', username: 'admin', password: 'secret123' } });
    } catch (e) { errMsg = e.message; }
    assert.ok(!errMsg.includes('secret123'), `Error message must not contain password. Got: ${errMsg}`);
  } finally { removeMock(); }
});

test('D10 timeout clamped to max 300s', async () => {
  installMock(200, { name: 'n', cluster_name: 'c', cluster_uuid: 'u', version: {}, tagline: 't' });
  try {
    const r = await elasticsearchClient({ operation: 'info', url: 'http://localhost:9200', timeout: 9_999_999 });
    assert.strictEqual(r.clusterName, 'c');
  } finally { removeMock(); }
});

// ── E: Error-paths tests (x6) ─────────────────────────────────────────────────
console.log('\nE: Error Paths');

test('E01 search 4xx includes status code in error', async () => {
  installMock(400, { error: { root_cause: [{ type: 'parsing_exception' }] } });
  try {
    await rejects(() => elasticsearchClient({ operation: 'search', url: 'http://localhost:9200', query: { bad: null } }), '400');
  } finally { removeMock(); }
});

test('E02 mapping 4xx throws with status', async () => {
  installMock(404, { error: { type: 'index_not_found_exception', reason: 'no such index' } });
  try {
    await rejects(() => elasticsearchClient({ operation: 'mapping', url: 'http://localhost:9200', index: 'ghost' }), '404');
  } finally { removeMock(); }
});

test('E03 count 5xx throws with status', async () => {
  installMock(500, { error: { reason: 'internal server error' } });
  try {
    await rejects(() => elasticsearchClient({ operation: 'count', url: 'http://localhost:9200' }), '500');
  } finally { removeMock(); }
});

test('E04 create_index 4xx already exists throws', async () => {
  installMock(400, { error: { type: 'resource_already_exists_exception', reason: 'already exists' } });
  try {
    await rejects(() => elasticsearchClient({ operation: 'create_index', url: 'http://localhost:9200', index: 'exists' }), '400');
  } finally { removeMock(); }
});

test('E05 cluster_health 5xx throws', async () => {
  installMock(503, { error: { reason: 'master not discovered' } });
  try {
    await rejects(() => elasticsearchClient({ operation: 'cluster_health', url: 'http://localhost:9200' }), '503');
  } finally { removeMock(); }
});

test('E06 indices 5xx throws', async () => {
  installMock(500, { error: { reason: 'red cluster' } });
  try {
    await rejects(() => elasticsearchClient({ operation: 'indices', url: 'http://localhost:9200' }), '500');
  } finally { removeMock(); }
});

// ── Run ───────────────────────────────────────────────────────────────────────
runAll().catch(e => { console.error(e); process.exit(1); });
