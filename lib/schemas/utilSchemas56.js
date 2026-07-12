"use strict";
// lib/schemas/utilSchemas56.js — JSON schema for thrift_client tool

const UTIL_SCHEMAS_56 = [
  {
    name: "thrift_client",
    description:
      "Zero-dependency Apache Thrift binary & compact protocol encoder/decoder (pure Node.js; no npm deps). " +
      "Implements both Thrift Binary Protocol (default) and Thrift Compact Protocol. " +
      "Supports the full Thrift type system: BOOL, BYTE/I8, I16, I32, I64, DOUBLE, STRING/BINARY, " +
      "STRUCT (with field IDs), LIST, SET, MAP, and UUID (compact only). " +
      "The Binary Protocol uses fixed-width integers (I16/I32/I64/DOUBLE all big-endian). " +
      "The Compact Protocol uses zigzag-encoded variable-length integers, delta field IDs, " +
      "and little-endian DOUBLE. " +
      "Useful for interoperating with Apache Thrift services (Facebook, HBase, Cassandra Thrift API, etc.), " +
      "reverse-engineering Thrift binary frames, and testing Thrift RPC encoding. " +
      "Operations: " +
      "encode (JS value + schema -> Thrift binary hex+base64 or file); " +
      "decode (Thrift binary hex/base64/file + schema -> JS value); " +
      "encode_file (JSON file + schema -> Thrift binary file); " +
      "decode_file (Thrift binary file + schema -> JSON value or file); " +
      "inspect (schema-less wire-level field layout). " +
      "Security: 50 MB file cap; 64-level nesting depth limit; 1,000,000 element limit; " +
      "NUL-byte path guard; directory path rejected.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["encode", "decode", "encode_file", "decode_file", "inspect"],
          description:
            "Operation to perform. " +
            "'encode': encode a JS value to Thrift binary (requires 'schema' and 'value' or 'json_file'). " +
            "'decode': decode Thrift binary to JS value (requires 'schema' and 'hex', 'base64', or 'input_file'). " +
            "'encode_file': encode a JSON file to a Thrift binary file (requires 'schema', 'path', 'output'). " +
            "'decode_file': decode a Thrift binary file to JSON (requires 'schema', 'path'; optional 'output', 'pretty'). " +
            "'inspect': schema-less wire-level decode (requires 'hex', 'base64', or 'input_file'; optional 'schema', 'max_depth').",
        },

        protocol: {
          type: "string",
          enum: ["binary", "compact"],
          description:
            "Thrift protocol to use. " +
            "'binary' (default): fixed-width integers, big-endian DOUBLE. " +
            "'compact': zigzag VarInt, delta field IDs, little-endian DOUBLE. " +
            "Must match the server/peer being communicated with.",
        },

        schema: {
          description:
            "Thrift schema describing the top-level type to encode/decode. " +
            "Primitive string shorthand: 'bool', 'byte'/'i8', 'i16', 'i32', 'i64', 'double', 'string'/'binary', 'uuid'. " +
            "Struct: { \"type\": \"struct\", \"fields\": [ { \"id\": 1, \"name\": \"userId\", \"type\": \"i64\", \"required\": true }, ... ] }. " +
            "List/Set: { \"type\": \"list\", \"valueType\": \"string\" }. " +
            "Map: { \"type\": \"map\", \"keyType\": \"string\", \"valueType\": \"i32\" }. " +
            "Can be a JSON string (will be parsed). " +
            "Required for: encode, decode, encode_file, decode_file. " +
            "Optional for 'inspect' (schema-guided decode if provided, otherwise raw wire layout).",
        },

        value: {
          description:
            "For 'encode': the JS value to encode. Must match the schema type. " +
            "Struct: plain object with field names as keys. " +
            "List/Set: array. Map: plain object. " +
            "I64: number, BigInt, or decimal string. " +
            "String/Binary: UTF-8 string or { \"__binary\": \"<base64>\" } for raw binary. " +
            "UUID: 8-4-4-4-12 hex string. Bool: true/false, 1/0, or 'true'/'false'.",
        },
        json_file: {
          type: "string",
          description: "For 'encode': path to a JSON file containing the value to encode. Alternative to 'value'.",
        },

        hex: {
          type: "string",
          description:
            "For 'decode', 'inspect': Thrift binary data as a hex string. Must be even-length. Whitespace is ignored.",
        },
        base64: {
          type: "string",
          description: "For 'decode', 'inspect': Thrift binary data as a base64-encoded string.",
        },
        input_file: {
          type: "string",
          description: "For 'decode', 'inspect': path to a file containing Thrift binary data.",
        },

        path: {
          type: "string",
          description:
            "For 'encode_file': path to the JSON input file. " +
            "For 'decode_file': path to the Thrift binary input file.",
        },
        output: {
          type: "string",
          description:
            "For 'encode_file': path to write the Thrift binary output. " +
            "For 'decode_file': optional path to write decoded JSON output.",
        },
        output_file: {
          type: "string",
          description: "For 'encode': optional path to write binary output to a file instead of returning hex+base64 inline.",
        },

        include_hex: {
          type: "boolean",
          description: "For 'encode' with 'output_file': also include the hex string in the result. Default: false.",
        },
        include_base64: {
          type: "boolean",
          description: "For 'encode' with 'output_file': also include the base64 string in the result. Default: false.",
        },
        pretty: {
          type: "boolean",
          description: "For 'decode_file' with 'output': pretty-print the JSON output. Default: false.",
        },

        max_depth: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "For 'inspect': maximum depth for raw wire-level layout. Default: 3.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_56 };
