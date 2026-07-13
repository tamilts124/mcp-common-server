"use strict";
// lib/schemas/utilSchemas58.js — JSON schema for orc_client tool

const UTIL_SCHEMAS_58 = [
  {
    name: "orc_client",
    description:
      "Zero-dependency Apache ORC file reader (pure Node.js; no npm deps). " +
      "Reads .orc files produced by Hive, Spark, Presto/Trino, and all ORC-compatible tools. " +
      "Supports all ORC column types: BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, STRING, " +
      "BINARY, TIMESTAMP, DATE, DECIMAL, VARCHAR, CHAR, LIST, MAP, STRUCT, UNION, TIMESTAMP_INSTANT. " +
      "Column encodings: DIRECT, DIRECT_V2, DICTIONARY, DICTIONARY_V2 (RLE v1 and v2). " +
      "Compression codecs: NONE, ZLIB, SNAPPY, LZ4. " +
      "Operations: " +
      "info (file metadata: row count, stripes, column count, schema tree, compression, ORC version); " +
      "schema (full column schema with types, precision, scale, max length); " +
      "stripe (read rows from a specific stripe by index with column filtering and row offset/limit); " +
      "read (read rows across all stripes with optional column filter, offset, limit); " +
      "to_json (convert to JSON string or file); " +
      "to_csv (convert to CSV string or file). " +
      "Security: 200 MB file cap; 10,000,000 row limit; NUL-byte path guard; directory path rejected.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "schema", "stripe", "read", "to_json", "to_csv"],
          description:
            "Operation to perform. " +
            "'info': return file-level metadata (row count, stripe count, column count, schema tree, compression, ORC version). " +
            "'schema': return the full column schema (types, precision, scale, max length). " +
            "'stripe': read rows from a specific stripe (use 'stripe_index'). " +
            "'read': read rows across all stripes (supports 'columns', 'offset', 'limit'). " +
            "'to_json': read rows and return as a JSON string (or write to 'output_file'). " +
            "'to_csv': read rows and return as a CSV string (or write to 'output_file').",
        },

        path: {
          type: "string",
          description: "Path to the .orc file to read.",
        },

        columns: {
          type: "array",
          items: { type: "string" },
          description:
            "For 'read', 'stripe', 'to_json', 'to_csv': optional list of top-level column names to include. " +
            "If omitted, all columns are returned.",
        },

        stripe_index: {
          type: "integer",
          minimum: 0,
          description: "For 'stripe': zero-based index of the stripe to read. Default: 0.",
        },

        offset: {
          type: "integer",
          minimum: 0,
          description: "For 'read', 'stripe', 'to_json', 'to_csv': skip this many rows from the start. Default: 0.",
        },

        limit: {
          type: "integer",
          minimum: 1,
          description:
            "For 'read', 'stripe', 'to_json', 'to_csv': maximum number of rows to return. " +
            "Default: all rows (up to 10,000,000 hard cap).",
        },

        output_file: {
          type: "string",
          description:
            "For 'to_json', 'to_csv': path to write the output file. " +
            "If omitted, the result is returned inline in the response.",
        },

        pretty: {
          type: "boolean",
          description: "For 'to_json': pretty-print the JSON output. Default: false.",
        },

        separator: {
          type: "string",
          description: "For 'to_csv': field separator character. Default: ','.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_58 };
