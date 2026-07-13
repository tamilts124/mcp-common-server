'use strict';
// ── Schema: prometheus_client ────────────────────────────────────────────────────

const PROMETHEUS_CLIENT_SCHEMA = {
  name: 'prometheus_client',
  description:
    "Zero-dep Prometheus/OpenMetrics text format parser (pure Node.js; no npm deps). " +
    "Parse .prom files or inline metric text, query individual metrics by name, " +
    "inspect label sets, compute aggregate statistics, filter by type/name/label, " +
    "and fetch+parse live /metrics HTTP endpoints. " +
    "Supports Prometheus text exposition format 0.0.4 and OpenMetrics text 1.0. " +
    "Operations: " +
    "parse=read file or text and return all metrics with their samples; " +
    "query=return all samples for a specific metric name with optional label filter; " +
    "labels=list all label names and their distinct values for a metric; " +
    "stats=aggregate statistics (metric count, sample count, type breakdown, top metrics by sample count); " +
    "filter=return metrics matching type/name/label criteria; " +
    "fetch=HTTP GET a /metrics URL and parse the response; " +
    "validate=check format correctness and report errors/warnings.",
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['parse', 'query', 'labels', 'stats', 'filter', 'fetch', 'validate'],
        description:
          'Operation to perform. ' +
          'parse=parse file/text and return all metrics; ' +
          'query=return samples for a specific metric name; ' +
          'labels=list label names and distinct values for a metric; ' +
          'stats=aggregate statistics (metric/sample counts, type breakdown); ' +
          'filter=return metrics matching type/name/label criteria; ' +
          'fetch=HTTP GET a /metrics URL and parse; ' +
          'validate=report format errors and warnings.',
      },
      path: {
        type: 'string',
        description: 'Path to a Prometheus text file (.prom, .txt, or any text file in exposition format). '
          + 'Required for parse/query/labels/stats/filter/validate unless \'text\' is provided.',
      },
      text: {
        type: 'string',
        description: 'Inline Prometheus text exposition content (alternative to \'path\'). '
          + 'Max 32 MB. Required for parse/query/labels/stats/filter/validate unless \'path\' is provided.',
      },
      url: {
        type: 'string',
        description: 'HTTP(S) URL of a /metrics endpoint (required for fetch operation). Example: http://localhost:9090/metrics',
      },
      metric: {
        type: 'string',
        description: 'Metric name to query or inspect (required for query and labels operations). '
          + 'May include type suffixes like _total; the base name is resolved automatically.',
      },
      labels: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Label filter for query operation: object mapping label names to exact values. '
          + 'Only samples whose labels match ALL of these key-value pairs are returned.',
      },
      type: {
        type: 'string',
        enum: ['counter', 'gauge', 'histogram', 'summary', 'untyped', 'gaugehistogram', 'stateset', 'info', 'unknown'],
        description: 'Metric type filter for the filter operation. Returns only metrics with this type.',
      },
      name: {
        type: 'string',
        description: 'Exact metric name filter for the filter operation.',
      },
      name_regex: {
        type: 'string',
        description: 'ECMAScript regular expression to match metric names in the filter operation. '
          + 'Example: "^go_" to find all Go runtime metrics.',
      },
      label: {
        type: 'string',
        description: 'Label name filter for the filter operation. Only metrics that have at least one sample '
          + 'with this label are returned.',
      },
      value: {
        type: 'string',
        description: 'Label value filter for the filter operation (used together with \'label\'). '
          + 'Only samples whose label has this exact value are included.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of metrics to return in parse/filter/fetch results (default: all).',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Number of metrics to skip before returning results in parse/filter/fetch (default: 0).',
      },
      max_samples: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of samples to return per metric in parse/query/filter/fetch (default: 100 for parse/filter/fetch, 1000 for query).',
      },
      top_n: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Number of top metrics (by sample count) to include in stats output (default: 20).',
      },
      timeout: {
        type: 'integer',
        minimum: 1000,
        maximum: 120000,
        description: 'HTTP fetch timeout in milliseconds (default: 15000).',
      },
    },
    required: ['operation'],
  },
};

module.exports = { PROMETHEUS_CLIENT_SCHEMA };
