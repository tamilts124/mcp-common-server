"use strict";
// lib/schemas/utilSchemas64.js -- JSON schema for log_client tool

const UTIL_SCHEMAS_64 = [
  {
    name: "log_client",
    description:
      "Zero-dependency structured log file reader and analyzer (pure Node.js; no npm deps). " +
      "Auto-detects and parses log formats: JSON-lines (NDJSON), Apache/Nginx CLF+Combined, " +
      "Syslog RFC3164/RFC5424, W3C Extended (IIS), ISO-timestamp prefix, Unix-timestamp prefix, " +
      "and plain text with inline level keywords. " +
      "Operations: " +
      "info (file metadata, auto-detected format, sample level counts, first/last timestamps); " +
      "read (parse and return log entries with optional filters; paginated with offset+limit); " +
      "search (filter entries by pattern/level/time range/field — at least one filter required); " +
      "stats (aggregate statistics: level counts, per-hour time series, top field values); " +
      "tail (return the last N lines, parsed and filtered); " +
      "export (dump parsed/filtered entries to JSON, JSONL, CSV, or TSV; optionally write to file). " +
      "Filters: level (exact match, array), min_level (severity threshold), from/to (ISO time range), " +
      "pattern (regex against raw line + message), ignore_case, field+field_value (exact field match). " +
      "Security: 500 MB file cap; 5,000,000 line limit; NUL-byte guard; directory guard.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "read", "search", "stats", "tail", "export"],
          description:
            "Operation to perform. " +
            "'info': return file metadata, auto-detected format, sample level counts, first/last timestamps. " +
            "'read': parse and return log entries, optionally filtered (offset+limit for pagination). " +
            "'search': filter entries — requires at least one of: pattern, level, min_level, from, to, or field. " +
            "'stats': aggregate statistics including level counts, per-hour time-series, and optional top field values. " +
            "'tail': return the last N parsed log entries (optionally filtered). " +
            "'export': dump parsed entries to JSON/JSONL/CSV/TSV, optionally writing to an output file.",
        },

        path: {
          type: "string",
          description:
            "Path to the log file to read. Supported formats are auto-detected: " +
            "JSON-lines (.jsonl/.ndjson/.log), Apache/Nginx access logs, Syslog (RFC3164/5424), " +
            "W3C Extended IIS logs, ISO/Unix timestamp prefixed logs, and plain text.",
        },

        format: {
          type: "string",
          enum: ["jsonl", "apache_combined", "apache_clf", "syslog5424", "syslog3164",
                 "w3c", "iso_timestamp", "unix_ts", "plain"],
          description:
            "Override auto-detected format. Omit to auto-detect from file content. " +
            "'jsonl': newline-delimited JSON objects; " +
            "'apache_combined'/'apache_clf': Apache/Nginx access log formats; " +
            "'syslog5424'/'syslog3164': RFC 5424/3164 syslog; " +
            "'w3c': W3C Extended / IIS log format (requires #Fields: header); " +
            "'iso_timestamp': ISO-8601 timestamp prefix; " +
            "'unix_ts': Unix epoch timestamp prefix; " +
            "'plain': plain text with optional level keywords.",
        },

        // ── Pagination (read) ──────────────────────────────────────────────
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "For 'read': number of (post-filter) entries to skip before returning results (default: 0).",
        },

        limit: {
          type: "integer",
          minimum: 1,
          description:
            "For 'read': maximum entries to return (default: 1000; hard cap: 100,000). " +
            "For 'tail': maximum lines from the end of the file to read (default: 100; hard cap: 10,000).",
        },

        lines: {
          type: "integer",
          minimum: 1,
          description:
            "For 'tail': number of lines to read from the end of the file (default: 100; hard cap: 10,000). " +
            "Alias for 'limit' in tail context.",
        },

        // ── Filters (read / search / tail / export) ───────────────────────
        min_level: {
          type: "string",
          description:
            "Minimum log level (severity threshold). Entries with severity below this are excluded. " +
            "Recognised levels (ascending severity): trace/verbose, debug, info/notice, warn/warning, " +
            "error/err, critical/crit, alert, fatal, emerg/panic. " +
            "Example: 'warn' includes warn, error, critical, fatal, etc.",
        },

        level: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Exact log level(s) to include. String or array of strings. " +
            "Example: 'error' or ['warn', 'error']. Case-insensitive.",
        },

        from: {
          type: "string",
          description:
            "ISO 8601 start timestamp (inclusive). Entries with timestamps before this value are excluded. " +
            "Example: '2024-01-01T00:00:00Z'. Only applied to entries that have a parsed timestamp.",
        },

        to: {
          type: "string",
          description:
            "ISO 8601 end timestamp (inclusive). Entries with timestamps after this value are excluded. " +
            "Example: '2024-01-01T23:59:59Z'. Only applied to entries that have a parsed timestamp.",
        },

        pattern: {
          type: "string",
          description:
            "Regular expression pattern to filter entries. Matched against the raw log line and " +
            "(if available) the parsed message field. Use 'ignore_case: true' for case-insensitive matching.",
        },

        ignore_case: {
          type: "boolean",
          description:
            "Apply 'pattern' filter case-insensitively (default: false).",
        },

        field: {
          type: "string",
          description:
            "Field name to filter on (exact match with 'field_value'). " +
            "For JSON-lines entries, any top-level key is valid. " +
            "For Apache/Syslog entries, valid fields include: client_ip, status, method, url, " +
            "hostname, app_name, proc_id, facility, etc.",
        },

        field_value: {
          description:
            "Value to match for 'field' filter (exact string comparison after converting to string). " +
            "Example: field='status', field_value=404.",
        },

        // ── Stats-specific ────────────────────────────────────────────────
        top_fields: {
          type: "array",
          items: { type: "string" },
          description:
            "For 'stats': list of field names to compute top-value frequency tables for. " +
            "Returns the top 20 values per field. " +
            "Example: ['status', 'client_ip'] for Apache access logs.",
        },

        // ── Export-specific ───────────────────────────────────────────────
        format_in: {
          type: "string",
          enum: ["jsonl", "apache_combined", "apache_clf", "syslog5424", "syslog3164",
                 "w3c", "iso_timestamp", "unix_ts", "plain"],
          description:
            "For 'export': override the input log format (same values as 'format'). " +
            "Alias for 'format' in export context.",
        },

        format_out: {
          type: "string",
          enum: ["jsonl", "json", "csv", "tsv"],
          description:
            "For 'export': output format (default: 'jsonl'). " +
            "'jsonl': one JSON object per line; " +
            "'json': JSON array (pretty-printed by default); " +
            "'csv': timestamp, level, severity, message, raw (with header row); " +
            "'tsv': tab-separated equivalent of csv.",
        },

        pretty: {
          type: "boolean",
          description:
            "For 'export' with format_out='json': pretty-print the JSON array with 2-space indentation " +
            "(default: true). Set to false for compact/minified output.",
        },

        output_file: {
          type: "string",
          description:
            "For 'export': write the exported data to this file path instead of returning inline. " +
            "Parent directories are created automatically. " +
            "Returns operation metadata without the inline data field.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_64 };
