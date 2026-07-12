"use strict";
// lib/schemas/utilSchemas55.js — JSON schema for avro_client tool

const UTIL_SCHEMAS_55 = [
  {
    name: "avro_client",
    description:
      "Zero-dependency Apache Avro binary encoder/decoder (pure Node.js; no npm deps). " +
      "Implements the full Avro binary encoding specification including all primitive and complex types. " +
      "Reads and writes Avro Object Container Files (OCF) with magic header 'Obj\\x01', " +
      "metadata map, 16-byte sync markers, and data blocks. " +
      "Used widely in data pipelines (especially Kafka + Avro), schema evolution workflows, " +
      "and interop with languages like Java, Python, and Go. " +
      "Supported Avro types: null, boolean, int, long, float, double, bytes, string (primitives); " +
      "record, enum, array, map, union, fixed (complex). " +
      "Encoding: null=0 bytes; boolean=1 byte; int/long=zigzag VarInt; " +
      "float=4-byte LE IEEE 754; double=8-byte LE IEEE 754; " +
      "bytes/string=long length prefix + raw bytes; " +
      "record=fields in declaration order; enum=int index; " +
      "array/map=length-prefixed blocks ending with 0; " +
      "union=long branch index + branch value; fixed=exactly N bytes. " +
      "Operations: " +
      "encode (single value + schema -> binary hex+base64 or file); " +
      "decode (binary hex/base64/file + schema -> JSON value); " +
      "encode_file (JSON file + schema -> binary or OCF file); " +
      "decode_file (binary/OCF file [+ schema for raw] -> JSON value or file); " +
      "inspect (show binary layout or OCF metadata+sample); " +
      "schema_fingerprint (compute Rabin-64 fingerprint for schema evolution). " +
      "Security: 50 MB file cap; 64-level nesting depth limit; 1,000,000 element limit; " +
      "NUL-byte path guard; directory path rejected.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["encode", "decode", "encode_file", "decode_file", "inspect", "schema_fingerprint"],
          description:
            "Operation to perform. " +
            "'encode': encode a single JSON value to Avro binary (hex+base64). Requires 'schema' and ('value' or 'json_file'). " +
            "'decode': decode Avro binary to JSON value. Requires 'schema' and ('hex', 'base64', or 'input_file'). " +
            "'encode_file': encode a JSON file to Avro binary or OCF (if schema is record and value is array). " +
            "  Requires 'schema', 'path' (JSON input), 'output' (binary output). " +
            "'decode_file': decode an Avro binary or OCF file to JSON. " +
            "  Requires 'path'. For OCF files, schema is extracted automatically; for raw binary, 'schema' is required. " +
            "  Optional: 'output' (write JSON to file), 'pretty' (pretty-print). " +
            "'inspect': show OCF metadata + sample record (for OCF), or structured decode (if 'schema' provided), " +
            "  or raw zigzag varint layout (if no schema). Requires ('hex', 'base64', or 'input_file'). " +
            "'schema_fingerprint': compute Rabin-64 fingerprint of a schema in canonical form. Requires 'schema'.",
        },

        // ---- Schema ----
        schema: {
          description:
            "Avro schema as a JSON object, array (for union), or primitive type name string. " +
            "Primitive names: 'null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string'. " +
            "Record schema: { \"type\": \"record\", \"name\": \"MyRecord\", \"fields\": [ { \"name\": \"id\", \"type\": \"long\" }, ... ] }. " +
            "Enum schema: { \"type\": \"enum\", \"name\": \"Color\", \"symbols\": [\"RED\", \"GREEN\", \"BLUE\"] }. " +
            "Array schema: { \"type\": \"array\", \"items\": \"string\" }. " +
            "Map schema: { \"type\": \"map\", \"values\": \"int\" }. " +
            "Union schema (array): [\"null\", \"string\"] (nullable string). " +
            "Fixed schema: { \"type\": \"fixed\", \"name\": \"MD5\", \"size\": 16 }. " +
            "Can also be a JSON string representation of any of the above (will be parsed). " +
            "Required for: encode, decode, encode_file, schema_fingerprint, inspect (without OCF). " +
            "Optional for decode_file and inspect when the file is an OCF (schema is embedded).",
        },

        // ---- Encode / decode inline ----
        value: {
          description:
            "For 'encode': the JSON value to encode. Must match the schema type. " +
            "Record: plain object with field names as keys (e.g. { \"id\": 1, \"name\": \"Alice\" }). " +
            "Enum: string symbol name (e.g. \"RED\") or integer index. " +
            "Array: JS array (e.g. [1, 2, 3]). " +
            "Map: plain object (e.g. { \"a\": 1, \"b\": 2 }). " +
            "Union: use { \"__avro_union\": { \"index\": N, \"value\": V } } to specify branch explicitly, " +
            "  or rely on automatic type inference (null->null branch, string->string branch, etc.). " +
            "Bytes/fixed: base64-encoded string. " +
            "Long values outside Number.MAX_SAFE_INTEGER: use a string (will be parsed as BigInt).",
        },
        json_file: {
          type: "string",
          description:
            "For 'encode': path to a JSON file containing the value to encode. " +
            "Alternative to 'value'. The file is parsed as JSON before encoding.",
        },

        // ---- Binary input ----
        hex: {
          type: "string",
          description:
            "For 'decode', 'inspect': the Avro binary data as a hexadecimal string (e.g. '020648656c6c6f'). " +
            "Must be an even-length hex string. Whitespace is ignored.",
        },
        base64: {
          type: "string",
          description:
            "For 'decode', 'inspect': the Avro binary data as a base64-encoded string.",
        },
        input_file: {
          type: "string",
          description:
            "For 'decode', 'inspect': path to a file containing Avro binary data or an OCF file.",
        },

        // ---- File paths ----
        path: {
          type: "string",
          description:
            "For 'encode_file': path to the JSON input file. " +
            "For 'decode_file': path to the Avro binary or OCF input file.",
        },
        output: {
          type: "string",
          description:
            "For 'encode_file': path to write the Avro binary or OCF output. " +
            "For 'decode_file': optional path to write the decoded JSON output (if omitted, returns inline).",
        },
        output_file: {
          type: "string",
          description:
            "For 'encode': optional path to write the binary output to a file " +
            "(instead of returning hex+base64 inline).",
        },

        // ---- Output format flags ----
        include_hex: {
          type: "boolean",
          description:
            "For 'encode' with 'output_file': also include the hex string in the result. Default: false.",
        },
        include_base64: {
          type: "boolean",
          description:
            "For 'encode' with 'output_file': also include the base64 string in the result. Default: false.",
        },
        pretty: {
          type: "boolean",
          description:
            "For 'decode_file' with 'output': pretty-print the JSON output (2-space indent). Default: false.",
        },

        // ---- Inspect options ----
        max_depth: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description:
            "For 'inspect': maximum depth for raw varint layout inspection. Default: 3.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_55 };
