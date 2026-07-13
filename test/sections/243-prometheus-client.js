'use strict';
// Section 243 — prometheus_client tests
// 56 tests: A=validation x10, B=unit x20, C=happy-path x10, D=security x10, E=error-paths x6

const { prometheusClient } = require('../../lib/prometheusClientOps');

const path = require('path');
const os   = require('os');
const fs   = require('fs');

let passed = 0, failed = 0;
const TESTS = [];

function test(name, fn) {
  TESTS.push({ name, fn });
}

async function runAll() {
  for (const t of TESTS) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`Section 243 — prometheus_client`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  console.log('═'.repeat(40));
  if (failed > 0) process.exit(1);
}

// Fake resolveClientPath for testing
function fakeResolve(p) {
  if (typeof p === 'string' && p.includes('\x00'))
    throw Object.assign(new Error('prometheus_client: path must not contain NUL bytes.'), { code: 'ERR_INVALID_ARG_VALUE' });
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  return { resolved: abs };
}

// ── Sample Prometheus texts ──────────────────────────────────────────────────
const BASIC_PROM = [
  '# HELP http_requests_total The total number of HTTP requests.',
  '# TYPE http_requests_total counter',
  'http_requests_total{method="post",code="200"} 1027 1395066363000',
  'http_requests_total{method="post",code="400"}    3 1395066363000',
  'http_requests_total{method="get",code="200"}  1000',
  'http_requests_total{method="get",code="400"}    5',
  '',
  '# HELP process_resident_memory_bytes Resident memory size in bytes.',
  '# TYPE process_resident_memory_bytes gauge',
  'process_resident_memory_bytes 1.5e+08',
  '',
  '# HELP go_gc_duration_seconds A summary of the GC invocation durations.',
  '# TYPE go_gc_duration_seconds summary',
  'go_gc_duration_seconds{quantile="0"} 4.9351e-05',
  'go_gc_duration_seconds{quantile="0.25"} 7.424100000000001e-05',
  'go_gc_duration_seconds{quantile="0.5"} 8.3835e-05',
  'go_gc_duration_seconds_sum 0.004892952',
  'go_gc_duration_seconds_count 37',
].join('\n');

const HISTOGRAM_PROM = [
  '# HELP http_request_duration_seconds Histogram of HTTP request durations.',
  '# TYPE http_request_duration_seconds histogram',
  'http_request_duration_seconds_bucket{le="0.1"} 10',
  'http_request_duration_seconds_bucket{le="0.5"} 30',
  'http_request_duration_seconds_bucket{le="1"} 45',
  'http_request_duration_seconds_bucket{le="+Inf"} 50',
  'http_request_duration_seconds_sum 22.5',
  'http_request_duration_seconds_count 50',
].join('\n');

const OPENMETRICS_TEXT = [
  '# HELP up 1 if the target is reachable, or 0 if the scrape failed.',
  '# TYPE up gauge',
  'up{instance="localhost:9090"} 1',
  'up{instance="localhost:9091"} 0',
  '# EOF',
].join('\n');

const ESCAPED_LABELS_PROM = [
  '# TYPE weird_metric gauge',
  'weird_metric{label="value with \\"quotes\\"",path="/foo/bar"} 42',
].join('\n');

const INF_NAN_PROM = [
  '# TYPE inf_metric gauge',
  'inf_metric{t="pos"} +Inf',
  'inf_metric{t="neg"} -Inf',
  'inf_metric{t="nan"} NaN',
].join('\n');

const MALFORMED_PROM = [
  '# TYPE broken_metric gauge',
  'broken_metric{unclosed="val" 99',
  'broken_metric2 missing_value',
].join('\n');

// ── A: Validation (10 tests) ──────────────────────────────────────────────────
console.log('\nA: Validation');

test('A01 unknown operation', async () => {
  try { await prometheusClient({ operation: 'bogus', text: '' }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes('unknown operation')) throw new Error(`A01: unexpected: ${e.message}`);
  }
});

test('A02 no operation', async () => {
  try { await prometheusClient({}, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    // accepted: 'unknown operation' or any other meaningful message
  }
});

test('A03 parse requires text or path', async () => {
  try { await prometheusClient({ operation: 'parse' }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes("'text'") && !e.message.includes("'path'") && !e.message.includes('provide'))
      throw new Error(`A03: unexpected: ${e.message}`);
  }
});

test('A04 parse text and path both rejects', async () => {
  const tmpFile = path.join(os.tmpdir(), 'prom_test_a04.prom');
  fs.writeFileSync(tmpFile, BASIC_PROM);
  try {
    try { await prometheusClient({ operation: 'parse', text: BASIC_PROM, path: tmpFile }, fakeResolve); throw new Error('should throw'); }
    catch (e) {
      if (e.message === 'should throw') throw e;
      if (!e.message.includes('not both')) throw new Error(`A04: unexpected: ${e.message}`);
    }
  } finally { fs.unlinkSync(tmpFile); }
});

test('A05 query requires metric name', async () => {
  try { await prometheusClient({ operation: 'query', text: BASIC_PROM }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes("'metric'")) throw new Error(`A05: unexpected: ${e.message}`);
  }
});

test('A06 labels requires metric name', async () => {
  try { await prometheusClient({ operation: 'labels', text: BASIC_PROM }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes("'metric'")) throw new Error(`A06: unexpected: ${e.message}`);
  }
});

test('A07 fetch requires url', async () => {
  try { await prometheusClient({ operation: 'fetch' }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes("'url'")) throw new Error(`A07: unexpected: ${e.message}`);
  }
});

test('A08 fetch url must be http/https', async () => {
  try { await prometheusClient({ operation: 'fetch', url: 'ftp://example.com/metrics' }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes('http')) throw new Error(`A08: unexpected: ${e.message}`);
  }
});

test('A09 MAX_TEXT_SIZE constant exists', async () => {
  const src = fs.readFileSync(require.resolve('../../lib/prometheusClientOps'), 'utf8');
  if (!src.includes('MAX_TEXT_SIZE')) throw new Error('A09: MAX_TEXT_SIZE constant missing');
});

test('A10 validate op with no text returns error', async () => {
  const result = await prometheusClient({ operation: 'validate' }, fakeResolve);
  if (result.valid !== false) throw new Error(`A10: expected valid=false, got ${result.valid}`);
  if (!Array.isArray(result.errors) || result.errors.length === 0) throw new Error('A10: expected errors');
});

// ── B: Unit / Logic (20 tests) ───────────────────────────────────────────────
console.log('\nB: Unit / Logic');

test('B01 parse basic counter', async () => {
  const r = await prometheusClient({ operation: 'parse', text: BASIC_PROM }, fakeResolve);
  if (r.format !== 'prometheus') throw new Error(`B01: format=${r.format}`);
  if (r.metricCount < 3) throw new Error(`B01: metricCount=${r.metricCount}`);
  if (r.sampleCount <= 0) throw new Error(`B01: sampleCount=${r.sampleCount}`);
  if (!Array.isArray(r.metrics)) throw new Error('B01: metrics not array');
});

test('B02 query counter by name', async () => {
  const r = await prometheusClient({ operation: 'query', text: BASIC_PROM, metric: 'http_requests_total' }, fakeResolve);
  if (r.found !== true) throw new Error(`B02: found=${r.found}`);
  if (r.type !== 'counter') throw new Error(`B02: type=${r.type}`);
  if (r.sampleCount !== 4) throw new Error(`B02: sampleCount=${r.sampleCount}`);
});

test('B03 query with label filter', async () => {
  const r = await prometheusClient({ operation: 'query', text: BASIC_PROM, metric: 'http_requests_total', labels: { method: 'post' } }, fakeResolve);
  if (r.found !== true) throw new Error('B03: not found');
  if (r.sampleCount !== 2) throw new Error(`B03: expected 2 post samples, got ${r.sampleCount}`);
});

test('B04 query missing metric returns found=false', async () => {
  const r = await prometheusClient({ operation: 'query', text: BASIC_PROM, metric: 'nonexistent_metric' }, fakeResolve);
  if (r.found !== false) throw new Error(`B04: found=${r.found}`);
  if (r.samples.length !== 0) throw new Error('B04: samples not empty');
});

test('B05 labels operation', async () => {
  const r = await prometheusClient({ operation: 'labels', text: BASIC_PROM, metric: 'http_requests_total' }, fakeResolve);
  if (r.found !== true) throw new Error('B05: not found');
  if (!r.labelNames.includes('method')) throw new Error(`B05: missing 'method' in ${r.labelNames}`);
  if (!r.labelNames.includes('code')) throw new Error(`B05: missing 'code' in ${r.labelNames}`);
  if (!Array.isArray(r.labelValues.method)) throw new Error('B05: method not array');
  if (!r.labelValues.method.includes('get')) throw new Error('B05: missing get');
  if (!r.labelValues.method.includes('post')) throw new Error('B05: missing post');
});

test('B06 stats operation', async () => {
  const r = await prometheusClient({ operation: 'stats', text: BASIC_PROM }, fakeResolve);
  if (r.metricCount < 3) throw new Error(`B06: metricCount=${r.metricCount}`);
  if (typeof r.typeBreakdown !== 'object') throw new Error('B06: typeBreakdown missing');
  if (!r.typeBreakdown.counter || r.typeBreakdown.counter < 1) throw new Error('B06: no counters in breakdown');
  if (!r.typeBreakdown.gauge || r.typeBreakdown.gauge < 1) throw new Error('B06: no gauges in breakdown');
  if (!Array.isArray(r.topMetrics)) throw new Error('B06: topMetrics not array');
});

test('B07 filter by type gauge', async () => {
  const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM, type: 'gauge' }, fakeResolve);
  if (r.matchedCount < 1) throw new Error(`B07: matchedCount=${r.matchedCount}`);
  for (const m of r.metrics) if (m.type !== 'gauge') throw new Error(`B07: non-gauge in filter: ${m.type}`);
});

test('B08 filter by name exact', async () => {
  const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM, name: 'process_resident_memory_bytes' }, fakeResolve);
  if (r.matchedCount !== 1) throw new Error(`B08: matchedCount=${r.matchedCount}`);
  if (r.metrics[0].name !== 'process_resident_memory_bytes') throw new Error('B08: wrong metric name');
});

test('B09 filter by name regex', async () => {
  const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM, name_regex: '^go_' }, fakeResolve);
  if (r.matchedCount < 1) throw new Error(`B09: matchedCount=${r.matchedCount}`);
  for (const m of r.metrics) if (!m.name.startsWith('go_')) throw new Error(`B09: non-go metric: ${m.name}`);
});

test('B10 filter by label name', async () => {
  const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM, label: 'quantile' }, fakeResolve);
  if (r.matchedCount < 1) throw new Error(`B10: matchedCount=${r.matchedCount}`);
});

test('B11 filter by label name and value', async () => {
  const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM, label: 'method', value: 'get' }, fakeResolve);
  if (r.matchedCount < 1) throw new Error('B11: no match');
  for (const m of r.metrics)
    for (const s of m.samples)
      if (s.labels.method !== 'get') throw new Error(`B11: unexpected method=${s.labels.method}`);
});

test('B12 histogram parsing', async () => {
  const r = await prometheusClient({ operation: 'parse', text: HISTOGRAM_PROM }, fakeResolve);
  const hist = r.metrics.find(m => m.name === 'http_request_duration_seconds');
  if (!hist) throw new Error('B12: histogram metric missing');
  if (hist.type !== 'histogram') throw new Error(`B12: type=${hist.type}`);
  if (hist.sampleCount <= 0) throw new Error('B12: no samples');
});

test('B13 OpenMetrics format detected', async () => {
  const r = await prometheusClient({ operation: 'parse', text: OPENMETRICS_TEXT }, fakeResolve);
  if (r.format !== 'openmetrics') throw new Error(`B13: format=${r.format}`);
  if (r.metricCount < 1) throw new Error(`B13: metricCount=${r.metricCount}`);
});

test('B14 Inf and NaN values', async () => {
  const r = await prometheusClient({ operation: 'query', text: INF_NAN_PROM, metric: 'inf_metric' }, fakeResolve);
  if (r.found !== true) throw new Error('B14: not found');
  const values = r.samples.map(s => s.value);
  if (!values.some(v => v === Infinity)) throw new Error(`B14: +Inf missing in ${values}`);
  if (!values.some(v => v === -Infinity)) throw new Error('B14: -Inf missing');
  if (!values.some(v => isNaN(v))) throw new Error('B14: NaN missing');
});

test('B15 timestamp parsing', async () => {
  const r = await prometheusClient({ operation: 'query', text: BASIC_PROM, metric: 'http_requests_total', labels: { method: 'post', code: '200' } }, fakeResolve);
  const s = r.samples[0];
  if (s.timestamp === undefined) throw new Error('B15: no timestamp');
  if (s.timestamp !== 1395066363000) throw new Error(`B15: timestamp=${s.timestamp}`);
});

test('B16 escaped quotes in label values', async () => {
  const r = await prometheusClient({ operation: 'query', text: ESCAPED_LABELS_PROM, metric: 'weird_metric' }, fakeResolve);
  if (r.found !== true) throw new Error('B16: not found');
  const s = r.samples[0];
  if (!s.labels.label) throw new Error('B16: label key missing');
  if (!s.labels.label.includes('"')) throw new Error(`B16: escaped quote not parsed, got: ${s.labels.label}`);
});

test('B17 validate clean text', async () => {
  const r = await prometheusClient({ operation: 'validate', text: BASIC_PROM }, fakeResolve);
  if (r.valid !== true) throw new Error(`B17: valid=${r.valid}, errors=${JSON.stringify(r.errors)}`);
  if (r.errors.length !== 0) throw new Error(`B17: errors=${JSON.stringify(r.errors)}`);
});

test('B18 validate malformed text', async () => {
  const r = await prometheusClient({ operation: 'validate', text: MALFORMED_PROM }, fakeResolve);
  if (r.valid !== false) throw new Error('B18: expected valid=false');
  if (r.errors.length === 0) throw new Error('B18: no errors reported');
});

test('B19 max_samples cap', async () => {
  const r = await prometheusClient({ operation: 'query', text: BASIC_PROM, metric: 'http_requests_total', max_samples: 2 }, fakeResolve);
  if (r.samples.length > 2) throw new Error(`B19: samples.length=${r.samples.length}`);
  if (r.truncated !== true) throw new Error('B19: expected truncated=true');
});

test('B20 parse empty text', async () => {
  const r = await prometheusClient({ operation: 'parse', text: '' }, fakeResolve);
  if (r.metricCount !== 0) throw new Error(`B20: metricCount=${r.metricCount}`);
  if (r.sampleCount !== 0) throw new Error(`B20: sampleCount=${r.sampleCount}`);
  if (r.errors.length !== 0) throw new Error(`B20: errors=${JSON.stringify(r.errors)}`);
});

// ── C: Happy-path (10 tests) ─────────────────────────────────────────────────
console.log('\nC: Happy-path');

test('C01 parse from file', async () => {
  const tmpFile = path.join(os.tmpdir(), 'prom_test_c01.prom');
  fs.writeFileSync(tmpFile, BASIC_PROM);
  try {
    const r = await prometheusClient({ operation: 'parse', path: tmpFile }, fakeResolve);
    if (r.metricCount < 3) throw new Error(`C01: metricCount=${r.metricCount}`);
    if (r.source !== tmpFile) throw new Error(`C01: source=${r.source}`);
  } finally { try { fs.unlinkSync(tmpFile); } catch {} }
});

test('C02 validate from file', async () => {
  const tmpFile = path.join(os.tmpdir(), 'prom_test_c02.prom');
  fs.writeFileSync(tmpFile, BASIC_PROM);
  try {
    const r = await prometheusClient({ operation: 'validate', path: tmpFile }, fakeResolve);
    if (r.valid !== true) throw new Error(`C02: valid=${r.valid}`);
    if (r.source !== tmpFile) throw new Error('C02: source mismatch');
  } finally { try { fs.unlinkSync(tmpFile); } catch {} }
});

test('C03 stats from complex text', async () => {
  const combined = BASIC_PROM + '\n' + HISTOGRAM_PROM;
  const r = await prometheusClient({ operation: 'stats', text: combined }, fakeResolve);
  if (r.metricCount < 4) throw new Error(`C03: metricCount=${r.metricCount}`);
  if (!r.typeBreakdown.histogram || r.typeBreakdown.histogram < 1) throw new Error('C03: no histogram');
  if (r.topMetrics.length === 0) throw new Error('C03: no topMetrics');
});

test('C04 filter returns all metrics when no filter', async () => {
  const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM }, fakeResolve);
  if (r.matchedCount < 3) throw new Error(`C04: matchedCount=${r.matchedCount}`);
});

test('C05 filter with no label match returns empty', async () => {
  const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM, label: 'nosuchlabel' }, fakeResolve);
  if (r.matchedCount !== 0) throw new Error(`C05: matchedCount=${r.matchedCount}`);
});

test('C06 labels for missing metric', async () => {
  const r = await prometheusClient({ operation: 'labels', text: BASIC_PROM, metric: 'no_such_metric' }, fakeResolve);
  if (r.found !== false) throw new Error(`C06: found=${r.found}`);
  if (r.labelNames.length !== 0) throw new Error('C06: labelNames not empty');
});

test('C07 parse openmetrics with EOF', async () => {
  const r = await prometheusClient({ operation: 'parse', text: OPENMETRICS_TEXT }, fakeResolve);
  if (r.format !== 'openmetrics') throw new Error(`C07: format=${r.format}`);
  const up = r.metrics.find(m => m.name === 'up');
  if (!up) throw new Error('C07: up metric missing');
  if (up.sampleCount !== 2) throw new Error(`C07: sampleCount=${up.sampleCount}`);
});

test('C08 comment-only text is valid', async () => {
  const commentOnly = '# Just a comment line\n# Another comment';
  const r = await prometheusClient({ operation: 'validate', text: commentOnly }, fakeResolve);
  if (r.valid !== true) throw new Error(`C08: valid=${r.valid}`);
});

test('C09 filter by type counter only', async () => {
  const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM, type: 'counter' }, fakeResolve);
  if (r.matchedCount < 1) throw new Error(`C09: matchedCount=${r.matchedCount}`);
  for (const m of r.metrics) if (m.type !== 'counter') throw new Error(`C09: non-counter: ${m.type}`);
});

test('C10 stats top_n capped', async () => {
  const r = await prometheusClient({ operation: 'stats', text: BASIC_PROM, top_n: 1 }, fakeResolve);
  if (r.topMetrics.length > 1) throw new Error(`C10: topMetrics.length=${r.topMetrics.length}`);
});

// ── D: Security (10 tests) ────────────────────────────────────────────────────
console.log('\nD: Security');

test('D01 NUL byte in path rejected', async () => {
  try { await prometheusClient({ operation: 'parse', path: '/tmp/test\x00.prom' }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes('NUL') && !e.message.includes('\\x00') && !e.message.includes('null'))
      throw new Error(`D01: unexpected: ${e.message}`);
  }
});

test('D02 directory path rejected', async () => {
  try { await prometheusClient({ operation: 'parse', path: os.tmpdir() }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes('directory') && !e.message.includes('dir') && !e.message.includes('EISDIR'))
      throw new Error(`D02: unexpected: ${e.message}`);
  }
});

test('D03 NUL byte in url rejected', async () => {
  try { await prometheusClient({ operation: 'fetch', url: 'http://localhost/met\x00rics' }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes('NUL') && !e.message.includes('null'))
      throw new Error(`D03: unexpected: ${e.message}`);
  }
});

test('D04 non-http url rejected', async () => {
  try { await prometheusClient({ operation: 'fetch', url: 'file:///etc/passwd' }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes('http') && !e.message.includes('https'))
      throw new Error(`D04: unexpected: ${e.message}`);
  }
});

test('D05 text exceeds size cap guard exists in source', async () => {
  const src = fs.readFileSync(require.resolve('../../lib/prometheusClientOps'), 'utf8');
  if (!src.includes('MAX_TEXT_SIZE')) throw new Error('D05: no size cap in source');
  if (!src.includes('too large')) throw new Error('D05: no too large error in source');
});

test('D06 unclosed brace produces parse error', async () => {
  const text = 'metric{key="val" 42';
  const r = await prometheusClient({ operation: 'validate', text }, fakeResolve);
  if (r.valid !== false) throw new Error(`D06: expected invalid, got valid=${r.valid}`);
  if (r.errors.length === 0) throw new Error('D06: expected errors, got none');
});

test('D07 massive label count in one sample (DoS guard)', async () => {
  const labels = Array.from({length: 50}, (_,i) => `label${i}="val${i}"`).join(',');
  const text = `# TYPE big_labels gauge\nbig_labels{${labels}} 1.0`;
  const r = await prometheusClient({ operation: 'parse', text }, fakeResolve);
  if (r.sampleCount !== 1) throw new Error(`D07: sampleCount=${r.sampleCount}`);
  const m = r.metrics[0];
  if (Object.keys(m.samples[0].labels).length !== 50)
    throw new Error(`D07: label count=${Object.keys(m.samples[0].labels).length}`);
});

test('D08 extremely long metric name safe', async () => {
  const longName = 'a'.repeat(4096);
  const text = `${longName} 42`;
  const r = await prometheusClient({ operation: 'validate', text }, fakeResolve);
  if (typeof r.valid !== 'boolean') throw new Error('D08: result.valid missing');
});

test('D09 fetch timeout clamp', async () => {
  const src = fs.readFileSync(require.resolve('../../lib/prometheusClientOps'), 'utf8');
  if (!src.includes('120_000') && !src.includes('120000')) throw new Error('D09: no max timeout clamp');
  if (!src.includes('1000')) throw new Error('D09: no min timeout clamp');
});

test('D10 name_regex injection safe (no catastrophic backtrack)', async () => {
  try {
    const r = await prometheusClient({ operation: 'filter', text: BASIC_PROM, name_regex: '(a+)+$' }, fakeResolve);
    if (typeof r.matchedCount !== 'number') throw new Error('D10: matchedCount missing');
  } catch (e) {
    // bad-regex error is also acceptable
    if (!e.message.toLowerCase().includes('regex') && !e.message.includes('RegExp') && !e.message.includes('Invalid'))
      throw new Error(`D10: unexpected error: ${e.message}`);
  }
});

// ── E: Error Paths (6 tests) ──────────────────────────────────────────────────
console.log('\nE: Error Paths');

test('E01 nonexistent file', async () => {
  try { await prometheusClient({ operation: 'parse', path: '/no/such/file.prom' }, fakeResolve); throw new Error('should throw'); }
  catch (e) {
    if (e.message === 'should throw') throw e;
    if (e.code !== 'ENOENT' && !e.message.includes('ENOENT') && !e.message.includes('no such'))
      throw new Error(`E01: unexpected: ${e.message}`);
  }
});

test('E02 fetch connection refused returns error', async () => {
  // Port 1 is almost certainly closed
  try {
    await prometheusClient({ operation: 'fetch', url: 'http://127.0.0.1:1/metrics', timeout: 2000 }, fakeResolve);
    throw new Error('should throw');
  } catch (e) {
    if (e.message === 'should throw') throw e;
    if (!e.message.includes('ECONNREFUSED') && !e.message.includes('connect') &&
        !e.message.includes('timeout') && !e.message.includes('ENOTFOUND'))
      throw new Error(`E02: unexpected: ${e.message}`);
  }
});

test('E03 text with only whitespace', async () => {
  const r = await prometheusClient({ operation: 'parse', text: '   \n   \t  ' }, fakeResolve);
  if (r.metricCount !== 0) throw new Error(`E03: metricCount=${r.metricCount}`);
});

test('E04 sample without value reports error', async () => {
  const text = '# TYPE m gauge\nm{a="b"}';
  const r = await prometheusClient({ operation: 'validate', text }, fakeResolve);
  if (r.valid !== false) throw new Error('E04: expected invalid');
  if (r.errors.length === 0) throw new Error('E04: no errors reported');
});

test('E05 filter with invalid regex throws', async () => {
  try {
    await prometheusClient({ operation: 'filter', text: BASIC_PROM, name_regex: '[invalid(' }, fakeResolve);
    throw new Error('should throw on bad regex');
  } catch (e) {
    if (e.message === 'should throw on bad regex') throw e;
    // any error about invalid regex/syntax is acceptable
  }
});

test('E06 validate HELP line without name warning', async () => {
  const text = '# HELP  \n# TYPE m gauge\nm 1';
  const r = await prometheusClient({ operation: 'validate', text }, fakeResolve);
  if (typeof r.warnings !== 'object') throw new Error('E06: warnings missing');
});

// ── Run all ───────────────────────────────────────────────────────────────────
runAll().catch(e => { console.error(e); process.exit(1); });
