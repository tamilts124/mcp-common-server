"use strict";
// lib/schemas/utilSchemas53.js — JSON schema for protobuf_client tool

const UTIL_SCHEMAS_53 = [
  {
    name: "protobuf_client",
    description:
      "Zero-dependency Protocol Buffers (proto3) binary encoder/decoder (pure Node.js; no npm deps). " +
      "Implements the protobuf binary wire format: wire type 0 (varint), 1 (64-bit fixed), " +
      "2 (length-delimited), and 5 (32-bit fixed). " +
      "Supports all proto3 scalar types: int32, int64, uint32, uint64, sint32, sint64, bool, enum, " +
      "fixed32, sfixed32, float, fixed64, sfixed64, double, string, bytes, and nested messages. " +
      "BigInt values (int64/uint64/sfixed64/sint64) are returned as { __int64: \"string\" } for JSON safety. " +
      "A 'fields' descriptor ({ \"<fieldNumber>\": { name, type, fields? } }) enables human-readable " +
      "field names and correct scalar type interpretation during decode. Without a descriptor, " +
      "the decoder makes best-effort guesses (varints as signed int64, len-delim as string or bytes). " +
      "Operations: " +
      "encode (encode a JS object as protobuf bytes, with optional fields descriptor); " +
      "decode (decode protobuf bytes to a JS object, with optional fields descriptor); " +
      "encode_file (read a JSON file and write its protobuf encoding to an output file); " +
      "decode_file (read a protobuf file and return or write its decoded JSON); " +
      "inspect (show the wire-level field layout without full decoding, with sub-message heuristics). " +
      "Security: 50 MB file cap; 64-level nesting depth limit; 1,000,000 field limit; NUL-byte path guard. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
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
            "'encode': encode a JS object ('message' or 'json_file') to protobuf binary bytes. " +
            "'decode': decode protobuf bytes ('hex', 'base64', or 'input_file') to a JS object. " +
            "'encode_file': read a JSON file ('path') and write protobuf binary to 'output'. " +
            "'decode_file': read a protobuf file ('path') and return or write its decoded JSON ('output' optional). " +
            "'inspect': show the wire-level field layout of protobuf bytes without full decoding.",
        },

        // ---- encode ----
        message: {
          type: "object",
          description:
            "For 'encode': the protobuf message as a JS object where keys are field numbers (as strings or integers). " +
            "Values may be scalars, nested objects (message type), or arrays (repeated fields). " +
            "Example: { \"1\": 42, \"2\": \"hello\", \"3\": [1, 2, 3] }. " +
            "Required unless 'json_file' is provided.",
          additionalProperties: true,
        },
        json_file: {
          type: "string",
          description:
            "For 'encode': path to a JSON file whose content (a field-number-keyed object) will be encoded. " +
            "Alternative to 'message'.",
        },
        output_file: {
          type: "string",
          description:
            "For 'encode': path where the protobuf bytes will be written. " +
            "If omitted, the encoded bytes are returned inline as 'hex' and 'base64'.",
        },
        include_hex: {
          type: "boolean",
          description:
            "For 'encode' with output_file: also return a hex string of the encoded bytes in the response (default false).",
        },
        include_base64: {
          type: "boolean",
          description:
            "For 'encode' with output_file: also return a base64 string of the encoded bytes in the response (default false).",
        },

        // ---- decode / inspect ----
        hex: {
          type: "string",
          description:
            "For 'decode' and 'inspect': hex-encoded protobuf bytes (e.g. '0801120568656c6c6f'). Case-insensitive. Spaces are stripped.",
        },
        base64: {
          type: "string",
          description: "For 'decode' and 'inspect': base64-encoded protobuf bytes.",
        },
        input_file: {
          type: "string",
          description: "For 'decode' and 'inspect': path to the protobuf binary file to read.",
        },

        // ---- schema descriptor (encode + decode + encode_file + decode_file) ----
        fields: {
          type: "object",
          description:
            "Optional field descriptor for encode and decode operations. " +
            "An object mapping field numbers (as string keys) to { name, type, fields? }. " +
            "'name': human-readable field name used as the output key during decode. " +
            "'type': proto3 scalar type or 'message'. One of: " +
            "int32, int64, uint32, uint64, sint32, sint64, bool, enum, " +
            "fixed32, sfixed32, float, fixed64, sfixed64, double, string, bytes, message. " +
            "'fields': nested field descriptor for 'message' type fields. " +
            "Example: { \"1\": { \"name\": \"id\", \"type\": \"int32\" }, \"2\": { \"name\": \"label\", \"type\": \"string\" }, " +
            "\"3\": { \"name\": \"address\", \"type\": \"message\", \"fields\": { \"1\": { \"name\": \"street\", \"type\": \"string\" } } } }.",
          additionalProperties: true,
        },

        // ---- encode_file / decode_file ----
        path: {
          type: "string",
          description:
            "For 'encode_file': path to the input JSON file. " +
            "For 'decode_file': path to the input protobuf file.",
        },
        output: {
          type: "string",
          description:
            "For 'encode_file': path where the protobuf output is written (required). " +
            "For 'decode_file': optional path to write the decoded JSON; if omitted, value is returned inline.",
        },
        pretty: {
          type: "boolean",
          description:
            "For 'decode_file' with 'output': write pretty-printed JSON (2-space indent) instead of compact JSON (default false).",
        },

        // ---- inspect ----
        max_depth: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description:
            "For 'inspect': maximum nesting depth for sub-message heuristic analysis (1–10, default 3). " +
            "Length-delimited fields are probed as possible sub-messages up to this depth.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_53 };
