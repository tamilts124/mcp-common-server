"use strict";
/**
 * utilSchemas80.js — JSON Schema for influxdb_client tool.
 */

const influxdbClientSchema = {
  name: "influxdb_client",
  description:
    "Zero-dependency InfluxDB v1/v2/v3 HTTP API client (pure Node.js; no npm deps). " +
    "Operations: ping (connectivity check), health (server health), " +
    "write (write line-protocol points), query_flux (Flux query → CSV rows), " +
    "query_influxql (InfluxQL query → rows), buckets (list v2 buckets), " +
    "orgs (list v2 organisations), measurements (SHOW MEASUREMENTS), " +
    "delete (predicate-based delete on v2). " +
    "Auth: token (Bearer, for v2/v3) or username/password (v1 / v2 compat). " +
    "Supports HTTP and HTTPS with configurable TLS verification.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: ["ping", "health", "write", "query_flux", "query_influxql", "buckets", "orgs", "measurements", "delete"],
        description: "Operation to perform.",
      },
      host: {
        type: "string",
        description: "InfluxDB hostname or IP (default: 'localhost').",
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        description: "InfluxDB port (default: 8086).",
      },
      ssl: {
        type: "boolean",
        description: "Use HTTPS (default: true). Set false for plain HTTP.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject self-signed TLS certificates (default: true).",
      },
      // Auth v2 / v3
      token: {
        type: "string",
        description: "InfluxDB v2/v3 API token (Bearer auth).",
      },
      // Auth v1 / v2 compat
      username: {
        type: "string",
        description: "Username for InfluxDB v1 or v2 compatibility endpoint.",
      },
      password: {
        type: "string",
        description: "Password for InfluxDB v1 or v2 compatibility endpoint.",
      },
      // Targeting
      org: {
        type: "string",
        description: "InfluxDB v2 organisation name or ID.",
      },
      bucket: {
        type: "string",
        description: "Bucket name (v2) or database name (v1, alias for 'db').",
      },
      db: {
        type: "string",
        description: "InfluxDB v1 database name (alias for 'bucket').",
      },
      api_version: {
        type: "string",
        enum: ["v1", "v2"],
        description: "API version to target (default: 'v2'). Use 'v1' for InfluxDB 1.x or v1-compat endpoints.",
      },
      // write
      lines: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "Line-protocol data: a single string (multiple lines OK) or an array of line-protocol strings. Required for 'write'.",
      },
      precision: {
        type: "string",
        enum: ["ns", "us", "ms", "s"],
        description: "Timestamp precision for 'write' (default: 'ns').",
      },
      // query_flux
      query: {
        type: "string",
        description: "Flux or InfluxQL query string. Required for 'query_flux' and 'query_influxql'.",
      },
      header: {
        type: "boolean",
        description: "Include header row in Flux CSV result (default: true).",
      },
      annotations: {
        type: "array",
        items: { type: "string" },
        description: "Flux CSV dialect annotations (default: ['datatype','group','default']).",
      },
      raw: {
        type: "boolean",
        description: "Include raw CSV body (truncated at 64 KB) in query_flux response (default: false).",
      },
      // query_influxql
      epoch: {
        type: "string",
        enum: ["h", "m", "s", "ms", "u", "ns"],
        description: "Timestamp format for InfluxQL query results (default: 'ns').",
      },
      // max rows
      max_rows: {
        type: "integer",
        minimum: 1,
        maximum: 50000,
        description: "Maximum result rows to return (default: 10000, max: 50000).",
      },
      // buckets / orgs pagination
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Maximum items to return for 'buckets' or 'orgs' (default: 100).",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Pagination offset for 'buckets' or 'orgs' (default: 0).",
      },
      // delete
      start: {
        type: "string",
        description: "RFC3339 start timestamp for 'delete' (e.g. '2024-01-01T00:00:00Z').",
      },
      stop: {
        type: "string",
        description: "RFC3339 stop timestamp for 'delete' (exclusive, e.g. '2024-01-02T00:00:00Z').",
      },
      predicate: {
        type: "string",
        description: "Tag predicate for 'delete' (e.g. '_measurement=\"cpu\" AND host=\"server01\"').",
      },
      // timeout
      timeout: {
        type: "integer",
        minimum: 1000,
        maximum: 300000,
        description: "Request timeout in milliseconds (default: 30000, max: 300000).",
      },
    },
  },
};

module.exports = { influxdbClientSchema };
