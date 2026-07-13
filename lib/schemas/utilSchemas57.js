"use strict";
// lib/schemas/utilSchemas57.js — JSON schema for parquet_client tool

const UTIL_SCHEMAS_57 = [
  {
    name: "parquet_client",
    description:
      "Zero-dependency Apache Parquet file reader (pure Node.js; no npm deps). " +
      "Reads .parquet files produced by Spark, Hadoop, DuckDB, Pandas, Arrow, BigQuery, and all other Parquet-compatible tools. " +
      "Supports all standard Parquet physical types (BOOLEAN, INT32, INT64, INT96, FLOAT, DOUBLE, BYTE_ARRAY, FIXED_LEN_BYTE_ARRAY), " +
      "logical/converted types (STRING, DATE, TIMESTAMP, DECIMAL, UUID, ENUM, JSON), " +
      "encodings (PLAIN, RLE, BIT_PACKED, DELTA_BINARY_PACKED, PLAIN_DICTIONARY, RLE_DICTIONARY), " +
      "and compression codecs (UNCOMPRESSED, SNAPPY, GZIP). " +
      "Operations: " +
      "info (file metadata: row groups, columns, compression, schema tree); " +
      "schema (full column schema with physical/logical/converted types and repetition); " +
      "row_group (read one row group by index with column filtering and row offset/limit); " +
      "read (read rows across all row groups with optional column filter, offset, limit); " +
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
          enum: ["info", "schema", "row_group", "read", "to_json", "to_csv"],
          description:
            "Operation to perform. " +
            "'info': return file-level metadata (row count, row groups, column count, schema tree, key-value metadata, compression). " +
            "'schema': return the full column schema (physical types, logical types, converted types, repetition levels). " +
            "'row_group': read rows from a specific row group (use 'row_group_index'). " +
            "'read': read rows across all row groups (supports 'columns', 'offset', 'limit'). " +
            "'to_json': read rows and return as a JSON string (or write to 'output_file'). " +
            "'to_csv': read rows and return as a CSV string (or write to 'output_file').",
        },

        path: {
          type: "string",
          description: "Path to the .parquet file to read.",
        },

        columns: {
          type: "array",
          items: { type: "string" },
          description:
            "For 'read', 'row_group', 'to_json', 'to_csv': optional list of column paths to include (e.g. ['id', 'name', 'address.city']). " +
            "If omitted, all columns are returned.",
        },

        row_group_index: {
          type: "integer",
          minimum: 0,
          description: "For 'row_group': zero-based index of the row group to read. Default: 0.",
        },

        offset: {
          type: "integer",
          minimum: 0,
          description: "For 'read', 'row_group', 'to_json', 'to_csv': skip this many rows from the start. Default: 0.",
        },

        limit: {
          type: "integer",
          minimum: 1,
          description:
            "For 'read', 'row_group', 'to_json', 'to_csv': maximum number of rows to return. " +
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

module.exports = { UTIL_SCHEMAS_57 };
