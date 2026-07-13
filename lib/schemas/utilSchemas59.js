"use strict";
// lib/schemas/utilSchemas59.js — JSON schema for arrow_client tool

const UTIL_SCHEMAS_59 = [
  {
    name: "arrow_client",
    description:
      "Zero-dependency Apache Arrow IPC file/stream reader (pure Node.js; no npm deps). " +
      "Reads .arrow and .arrows files produced by PyArrow, Apache Spark, DuckDB, Polars, " +
      "and all Arrow-compatible tools. Supports both Arrow IPC File format (with magic header/footer) " +
      "and Arrow IPC Stream format. " +
      "Column types: NULL, Bool, Int (8/16/32/64 signed/unsigned), FloatingPoint (half/single/double), " +
      "Binary, LargeBinary, Utf8, LargeUtf8, Date (day/ms), Time (32/64), Timestamp, Duration, " +
      "Interval, Decimal (128/256), FixedSizeBinary, List, LargeList, FixedSizeList, Struct, Map, " +
      "and dictionary-encoded variants of any type. " +
      "Operations: " +
      "info (file metadata: format, row count, batch count, column count, schema, endianness); " +
      "schema (full column schema with types and nullability); " +
      "read (decode rows across all record batches with optional column filter, offset, limit); " +
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
          enum: ["info", "schema", "read", "to_json", "to_csv"],
          description:
            "Operation to perform. " +
            "'info': return file-level metadata (format, row count, batch count, column count, schema). " +
            "'schema': return the full column schema (types, nullability, children). " +
            "'read': decode rows across all record batches (supports 'columns', 'offset', 'limit'). " +
            "'to_json': decode rows and return as a JSON string (or write to 'output_file'). " +
            "'to_csv': decode rows and return as a CSV string (or write to 'output_file').",
        },

        path: {
          type: "string",
          description: "Path to the Arrow IPC file (.arrow or .arrows) or stream file to read.",
        },

        columns: {
          type: "array",
          items: { type: "string" },
          description:
            "For 'read', 'to_json', 'to_csv': optional list of top-level column names to include. " +
            "If omitted, all columns are returned.",
        },

        offset: {
          type: "integer",
          minimum: 0,
          description: "For 'read', 'to_json', 'to_csv': skip this many rows from the start. Default: 0.",
        },

        limit: {
          type: "integer",
          minimum: 1,
          description:
            "For 'read', 'to_json', 'to_csv': maximum number of rows to return. " +
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

module.exports = { UTIL_SCHEMAS_59 };
