'use strict';
// ── prometheus_client — Zero-dep Prometheus/OpenMetrics text format parser ─────
// Pure Node.js; no npm dependencies.
// Supports: Prometheus text exposition format 0.0.4, OpenMetrics text 1.0
//
// Operations:
//   parse    – Parse a .prom / .txt file or inline text; return all metrics.
//   query    – Return all samples for a specific metric name.
//   labels   – Return label names/values for a metric.
//   stats    – Aggregate stats: metric count, sample count, type breakdown.
//   filter   – Return metrics matching type/label/name/value filters.
//   fetch    – HTTP GET a /metrics endpoint and parse the result.
//   validate – Report format errors and warnings.

const fs   = require('fs');
const http  = require('http');
const https = require('https');
const path  = require('path');

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE  = 64 * 1024 * 1024; // 64 MB
const MAX_TEXT_SIZE  = 32 * 1024 * 1024; // 32 MB inline
const MAX_SAMPLES    = 500_000;
const DEFAULT_TIMEOUT = 15_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse Prometheus label set string: {k="v", k2="v2"}
 * Returns an object.
 */
function parseLabels(labelStr) {
  const labels = {};
  if (!labelStr || !labelStr.trim()) return labels;
  // Walk char-by-char to handle escaped quotes in values
  let i = 0;
  const s = labelStr.trim();
  while (i < s.length) {
    // skip whitespace and commas
    while (i < s.length && (s[i] === ',' || s[i] === ' ')) i++;
    if (i >= s.length) break;
    // read key
    const keyStart = i;
    while (i < s.length && s[i] !== '=') i++;
    const key = s.slice(keyStart, i).trim();
    if (!key) { i++; continue; }
    i++; // skip '='
    // skip optional whitespace
    while (i < s.length && s[i] === ' ') i++;
    // expect opening quote
    if (i >= s.length || s[i] !== '"') { i++; continue; }
    i++; // skip opening quote
    let value = '';
    while (i < s.length) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const next = s[i + 1];
        if (next === '"')  { value += '"'; i += 2; }
        else if (next === 'n')  { value += '\n'; i += 2; }
        else if (next === '\\') { value += '\\'; i += 2; }
        else { value += s[i]; i++; }
      } else if (s[i] === '"') {
        i++; break; // closing quote
      } else {
        value += s[i++];
      }
    }
    labels[key] = value;
  }
  return labels;
}

/**
 * Parse a sample value: NaN, +Inf, -Inf, or a float.
 */
function parseValue(str) {
  const t = str.trim();
  if (t === 'NaN')  return NaN;
  if (t === '+Inf') return Infinity;
  if (t === '-Inf') return -Infinity;
  return parseFloat(t);
}

/**
 * Main parser: returns { metrics, format, errors, warnings, sampleCount }
 * metrics: Map<name, { type, help, unit, samples: [{labels, value, timestamp}] }>
 */
function parsePrometheusText(text) {
  const lines   = text.split(/\r?\n/);
  const metrics  = new Map(); // name -> { type, help, unit, samples }
  const errors   = [];
  const warnings = [];
  let format     = 'prometheus'; // or 'openmetrics'
  let sampleCount = 0;
  let lineNo      = 0;

  // Detect OpenMetrics by # EOF marker or content-type hint
  // (we detect by checking if last non-empty line is '# EOF')
  const lastNonEmpty = [...lines].reverse().find(l => l.trim().length > 0);
  if (lastNonEmpty === '# EOF') format = 'openmetrics';

  for (const rawLine of lines) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;
    if (line === '# EOF') continue; // OpenMetrics terminator

    if (line.startsWith('#')) {
      // Metadata line: # HELP <name> <text> / # TYPE <name> <type> / # UNIT <name> <unit>
      const parts = line.slice(1).trim().split(/\s+/, 3);
      const keyword = parts[0];
      if (!['HELP', 'TYPE', 'UNIT'].includes(keyword)) continue;

      const metricName = parts[1];
      if (!metricName) {
        warnings.push({ line: lineNo, message: `${keyword} without metric name` });
        continue;
      }

      // Store metadata under the base name so TYPE/HELP declared for
      // 'http_requests_total' is visible when querying base 'http_requests'.
      const metaKey = deriveBaseName(metricName);
      if (!metrics.has(metaKey)) {
        metrics.set(metaKey, { type: 'untyped', help: '', unit: '', samples: [] });
      }
      const m = metrics.get(metaKey);

      if (keyword === 'TYPE') {
        const typeVal = parts[2] || 'untyped';
        const validTypes = ['counter', 'gauge', 'histogram', 'summary', 'untyped', 'gaugehistogram', 'stateset', 'info', 'unknown'];
        if (!validTypes.includes(typeVal)) {
          warnings.push({ line: lineNo, message: `Unknown metric type '${typeVal}' for '${metricName}'` });
        }
        m.type = typeVal;
      } else if (keyword === 'HELP') {
        // Everything after the name
        const helpMatch = line.match(/^#\s+HELP\s+\S+\s*(.*?)\s*$/);
        m.help = helpMatch ? helpMatch[1] : '';
      } else if (keyword === 'UNIT') {
        m.unit = parts[2] || '';
      }
      continue;
    }

    // Sample line: <metric_name>[{labels}] <value> [timestamp]
    if (sampleCount >= MAX_SAMPLES) {
      warnings.push({ line: lineNo, message: `Sample cap (${MAX_SAMPLES}) reached; remaining lines skipped` });
      break;
    }

    // Find label block
    const braceOpen = line.indexOf('{');
    let metricName, labelStr, rest;

    if (braceOpen !== -1) {
      metricName = line.slice(0, braceOpen).trim();
      const braceClose = line.lastIndexOf('}');
      if (braceClose === -1) {
        errors.push({ line: lineNo, message: `Unclosed label brace in: ${line.slice(0, 60)}` });
        continue;
      }
      labelStr = line.slice(braceOpen + 1, braceClose);
      rest     = line.slice(braceClose + 1).trim();
    } else {
      // No labels; split on first whitespace
      const spaceIdx = line.search(/\s/);
      if (spaceIdx === -1) {
        errors.push({ line: lineNo, message: `Cannot parse sample line: ${line.slice(0, 60)}` });
        continue;
      }
      metricName = line.slice(0, spaceIdx);
      labelStr   = '';
      rest       = line.slice(spaceIdx).trim();
    }

    if (!metricName) {
      errors.push({ line: lineNo, message: `Empty metric name on line ${lineNo}` });
      continue;
    }

    // Parse value and optional timestamp from rest
    const restParts = rest.split(/\s+/);
    if (restParts.length < 1 || restParts[0] === '') {
      errors.push({ line: lineNo, message: `Missing value for '${metricName}'` });
      continue;
    }
    const value     = parseValue(restParts[0]);
    const timestamp = restParts[1] !== undefined ? parseFloat(restParts[1]) : undefined;

    // Derive base metric name (strip _total, _created, _sum, _count, _bucket suffixes for grouping)
    const baseName = deriveBaseName(metricName);
    const entryKey = baseName;

    if (!metrics.has(entryKey)) {
      metrics.set(entryKey, { type: 'untyped', help: '', unit: '', samples: [] });
    }
    // Also ensure original name is registered if different
    if (entryKey !== metricName && !metrics.has(metricName)) {
      // don't create a separate entry for suffixed variants; they attach to base
    }

    const labels = parseLabels(labelStr);
    const sample = { metricName, labels, value };
    if (timestamp !== undefined && !isNaN(timestamp)) sample.timestamp = timestamp;

    metrics.get(entryKey).samples.push(sample);
    sampleCount++;
  }

  return { metrics, format, errors, warnings, sampleCount, lineCount: lineNo };
}

/**
 * Derive the canonical base metric name by stripping known suffixes.
 * e.g. http_requests_total -> http_requests
 *      http_request_duration_seconds_bucket -> http_request_duration_seconds
 */
function deriveBaseName(name) {
  // Order matters: check longer suffixes first
  const suffixes = ['_total', '_created', '_sum', '_count', '_bucket', '_gcount', '_gsum', '_info'];
  for (const s of suffixes) {
    if (name.endsWith(s)) return name.slice(0, -s.length);
  }
  return name;
}

/**
 * Serialise a metrics Map into a JSON-friendly array.
 */
function metricsToArray(metricsMap, opts = {}) {
  const { limit = 0, offset = 0 } = opts;
  let entries = [...metricsMap.entries()].map(([name, m]) => ({
    name,
    type:   m.type,
    help:   m.help || undefined,
    unit:   m.unit || undefined,
    sampleCount: m.samples.length,
    samples: m.samples,
  }));
  if (offset > 0) entries = entries.slice(offset);
  if (limit  > 0) entries = entries.slice(0, limit);
  return entries;
}

/**
 * Serialise samples with optional truncation.
 */
function truncateSamples(samples, maxSamples) {
  if (!maxSamples || samples.length <= maxSamples) return { samples, truncated: false };
  return { samples: samples.slice(0, maxSamples), truncated: true };
}

// ── HTTP fetch helper ──────────────────────────────────────────────────────────

function httpGet(url, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https://') ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_FILE_SIZE) {
          res.destroy();
          reject(new Error(`Response too large (> ${MAX_FILE_SIZE} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`HTTP fetch timed out after ${timeout}ms`)); });
    req.on('error', reject);
  });
}

// ── Input resolution ──────────────────────────────────────────────────────────

function resolveText(args, resolveClientPath) {
  if (args.text != null && args.path != null)
    throw new Error("prometheus_client: provide 'text' or 'path', not both.");
  if (args.text != null) {
    if (typeof args.text !== 'string')
      throw new Error("prometheus_client: 'text' must be a string.");
    if (args.text.length > MAX_TEXT_SIZE)
      throw new Error(`prometheus_client: 'text' too large (max ${MAX_TEXT_SIZE} bytes).`);
    return { text: args.text, source: '<inline>' };
  }
  if (args.path != null) {
    const { resolved } = resolveClientPath(args.path);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory())
      throw new Error(`prometheus_client: '${args.path}' is a directory, not a file.`);
    if (stat.size > MAX_FILE_SIZE)
      throw new Error(`prometheus_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`);
    // NUL guard
    if (args.path.includes('\x00'))
      throw new Error('prometheus_client: path must not contain NUL bytes.');
    return { text: fs.readFileSync(resolved, 'utf8'), source: args.path };
  }
  throw new Error("prometheus_client: provide 'text' (inline string) or 'path' (file) or use op=fetch with 'url'.");
}

// ── Sample matching helpers ───────────────────────────────────────────────────

function labelsMatch(sampleLabels, filterLabels) {
  if (!filterLabels) return true;
  for (const [k, v] of Object.entries(filterLabels)) {
    if (sampleLabels[k] !== v) return false;
  }
  return true;
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

async function prometheusClient(args, resolveClientPath) {
  const op = args.operation;

  // ── fetch ────────────────────────────────────────────────────────────────
  if (op === 'fetch') {
    if (!args.url || typeof args.url !== 'string')
      throw new Error("prometheus_client fetch: 'url' is required.");
    if (!/^https?:\/\//i.test(args.url))
      throw new Error("prometheus_client fetch: 'url' must start with http:// or https://.");
    if (args.url.includes('\x00'))
      throw new Error('prometheus_client fetch: url must not contain NUL bytes.');
    const timeout = Math.min(Math.max(1000, args.timeout ?? DEFAULT_TIMEOUT), 120_000);
    const text    = await httpGet(args.url, { timeout });
    const parsed  = parsePrometheusText(text);
    const metrics = metricsToArray(parsed.metrics, {
      limit:  args.limit  ?? 0,
      offset: args.offset ?? 0,
    });
    // optionally strip samples for brevity
    const maxSamples = args.max_samples ?? 100;
    const out = metrics.map(m => {
      const { samples, truncated } = truncateSamples(m.samples, maxSamples);
      return { ...m, samples, samplesTruncated: truncated };
    });
    return {
      url: args.url,
      format:      parsed.format,
      metricCount: parsed.metrics.size,
      sampleCount: parsed.sampleCount,
      lineCount:   parsed.lineCount,
      errors:      parsed.errors,
      warnings:    parsed.warnings,
      metrics:     out,
    };
  }

  // ── validate (does not require text/path to be valid; it reports errors) ──
  if (op === 'validate') {
    let text, source;
    try {
      ({ text, source } = resolveText(args, resolveClientPath));
    } catch (e) {
      return { valid: false, errors: [{ line: 0, message: e.message }], warnings: [] };
    }
    const parsed = parsePrometheusText(text);
    return {
      source,
      format:      parsed.format,
      valid:       parsed.errors.length === 0,
      metricCount: parsed.metrics.size,
      sampleCount: parsed.sampleCount,
      lineCount:   parsed.lineCount,
      errors:      parsed.errors,
      warnings:    parsed.warnings,
    };
  }

  // All remaining ops need text input
  const { text, source } = resolveText(args, resolveClientPath);
  const parsed = parsePrometheusText(text);

  // ── parse ─────────────────────────────────────────────────────────────────
  if (op === 'parse') {
    const maxSamples = args.max_samples ?? 100;
    const metrics    = metricsToArray(parsed.metrics, {
      limit:  args.limit  ?? 0,
      offset: args.offset ?? 0,
    });
    const out = metrics.map(m => {
      const { samples, truncated } = truncateSamples(m.samples, maxSamples);
      return { ...m, samples, samplesTruncated: truncated };
    });
    return {
      source,
      format:      parsed.format,
      metricCount: parsed.metrics.size,
      sampleCount: parsed.sampleCount,
      lineCount:   parsed.lineCount,
      errors:      parsed.errors,
      warnings:    parsed.warnings,
      metrics:     out,
    };
  }

  // ── query ─────────────────────────────────────────────────────────────────
  if (op === 'query') {
    if (!args.metric || typeof args.metric !== 'string')
      throw new Error("prometheus_client query: 'metric' (metric name) is required.");
    const baseName = deriveBaseName(args.metric);
    const entry    = parsed.metrics.get(baseName) || parsed.metrics.get(args.metric);
    if (!entry) {
      return { source, metric: args.metric, found: false, samples: [] };
    }
    // Optional label filter
    let samples = entry.samples;
    if (args.labels && typeof args.labels === 'object') {
      samples = samples.filter(s => labelsMatch(s.labels, args.labels));
    }
    // Filter by exact metricName (e.g. _total vs _sum)
    if (args.suffix && typeof args.suffix === 'string') {
      samples = samples.filter(s => s.metricName === args.metric || s.metricName.endsWith('_' + args.suffix));
    }
    const maxSamples = args.max_samples ?? 1000;
    const { samples: out, truncated } = truncateSamples(samples, maxSamples);
    return {
      source,
      metric:      baseName,
      type:        entry.type,
      help:        entry.help || undefined,
      unit:        entry.unit || undefined,
      found:       true,
      sampleCount: samples.length,
      truncated,
      samples:     out,
    };
  }

  // ── labels ────────────────────────────────────────────────────────────────
  if (op === 'labels') {
    if (!args.metric || typeof args.metric !== 'string')
      throw new Error("prometheus_client labels: 'metric' is required.");
    const baseName = deriveBaseName(args.metric);
    const entry    = parsed.metrics.get(baseName) || parsed.metrics.get(args.metric);
    if (!entry) {
      return { source, metric: args.metric, found: false, labelNames: [], labelValues: {} };
    }
    // Collect all label names and their distinct values
    const labelNames  = new Set();
    const labelValues = {}; // name -> Set of values
    for (const sample of entry.samples) {
      for (const [k, v] of Object.entries(sample.labels)) {
        labelNames.add(k);
        if (!labelValues[k]) labelValues[k] = new Set();
        labelValues[k].add(v);
      }
    }
    const out = {};
    for (const k of labelNames) {
      out[k] = [...labelValues[k]].sort();
    }
    return {
      source,
      metric:      baseName,
      type:        entry.type,
      help:        entry.help || undefined,
      found:       true,
      sampleCount: entry.samples.length,
      labelNames:  [...labelNames].sort(),
      labelValues: out,
    };
  }

  // ── stats ─────────────────────────────────────────────────────────────────
  if (op === 'stats') {
    const typeCounts = {};
    const topMetrics = [];
    let totalSamples = 0;
    for (const [name, m] of parsed.metrics) {
      typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
      totalSamples += m.samples.length;
      topMetrics.push({ name, type: m.type, sampleCount: m.samples.length });
    }
    topMetrics.sort((a, b) => b.sampleCount - a.sampleCount);
    const topN = Math.min(args.top_n ?? 20, 200);
    return {
      source,
      format:      parsed.format,
      metricCount: parsed.metrics.size,
      sampleCount: totalSamples,
      lineCount:   parsed.lineCount,
      errorCount:   parsed.errors.length,
      warningCount: parsed.warnings.length,
      typeBreakdown: typeCounts,
      topMetrics:   topMetrics.slice(0, topN),
      errors:       parsed.errors,
      warnings:     parsed.warnings,
    };
  }

  // ── filter ────────────────────────────────────────────────────────────────
  if (op === 'filter') {
    const filterType   = args.type   ?? null;
    const filterName   = args.name   ?? null; // regex or exact
    const filterLabel  = args.label  ?? null; // label name
    const filterValue  = args.value  ?? null; // label value (exact)
    const filterNameRx = args.name_regex ? new RegExp(args.name_regex) : null;
    const maxSamples   = args.max_samples ?? 50;

    const results = [];
    for (const [name, m] of parsed.metrics) {
      // Type filter
      if (filterType && m.type !== filterType) continue;
      // Name exact filter
      if (filterName && name !== filterName) continue;
      // Name regex filter
      if (filterNameRx && !filterNameRx.test(name)) continue;
      // Label filter: at least one sample must have this label
      let samples = m.samples;
      if (filterLabel) {
        samples = samples.filter(s => {
          const hasLabel = s.labels[filterLabel] !== undefined;
          if (!hasLabel) return false;
          if (filterValue !== null) return s.labels[filterLabel] === filterValue;
          return true;
        });
        if (samples.length === 0) continue;
      }
      const { samples: out, truncated } = truncateSamples(samples, maxSamples);
      results.push({
        name,
        type:        m.type,
        help:        m.help || undefined,
        unit:        m.unit || undefined,
        sampleCount: samples.length,
        samplesTruncated: truncated,
        samples:     out,
      });
    }
    return {
      source,
      format:       parsed.format,
      matchedCount: results.length,
      errors:       parsed.errors,
      warnings:     parsed.warnings,
      metrics:      results,
    };
  }

  throw new Error(`prometheus_client: unknown operation '${op}'. Valid: parse, query, labels, stats, filter, fetch, validate.`);
}

module.exports = { prometheusClient };
