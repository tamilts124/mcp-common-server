"use strict";
// lib/schemas/utilSchemas51.js — JSON schema for msgpack_client tool

const UTIL_SCHEMAS_51 = [
  {
    name: "msgpack_client",
    description:
      "Zero-dependency MessagePack encoder/decoder (pure Node.js; no npm deps). " +
      "MessagePack is a compact binary serialization format compatible with JSON data types. " +
      "Supports all MessagePack types: nil, bool, int (positive/negative fixint, int8/16/32/64, uint8/16/32/64), " +
      "float32/64, str (fixstr, str8/16/32), bin (bin8/16/32), array (fixarray, array16/32), " +
      "map (fixmap, map16/32), and ext types (returned as base64-encoded data). " +
      "Operations: " +
      "encode (encode an inline JSON value or json_file to MessagePack bytes; returns hex + base64, or writes to output_file); " +
      "decode (decode MessagePack from hex string, base64 string, or input_file; returns JSON-safe value); " +
      "encode_file (read a JSON file and write its MessagePack encoding to an output file); " +
      "decode_file (read a MessagePack file and return or write its decoded JSON value); " +
      "inspect (analyse the type structure / byte layout of a MessagePack buffer without fully decoding it). " +
      "Security: 50 MB file cap; 100-level nesting depth limit; 1,000,000 element limit; NUL-byte path guard. " +
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
            "'encode': encode a JSON value (inline 'value' or 'json_file') to MessagePack bytes. " +
            "'decode': decode MessagePack bytes ('hex', 'base64', or 'input_file') to a JSON-safe value. " +
            "'encode_file': read a JSON file ('path') and write MessagePack to 'output'. " +
            "'decode_file': read a MessagePack file ('path') and return or write its decoded JSON ('output' optional). " +
            "'inspect': show the type tree / byte layout of a MessagePack buffer without full decoding.",
        },

        // ---- encode ----
        value: {
          description:
            "For 'encode': the JSON-compatible value to encode (null, bool, number, string, array, object). " +
            "Required if 'json_file' is not provided.",
        },
        json_file: {
          type: "string",
          description:
            "For 'encode': path to a JSON file whose content will be encoded. Alternative to 'value'.",
        },
        output_file: {
          type: "string",
          description:
            "For 'encode': path where the MessagePack bytes will be written. " +
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
            "For 'decode' and 'inspect': hex-encoded MessagePack bytes (e.g. '92c3c2'). Case-insensitive. Spaces are stripped.",
        },
        base64: {
          type: "string",
          description:
            "For 'decode' and 'inspect': base64-encoded MessagePack bytes.",
        },
        input_file: {
          type: "string",
          description:
            "For 'decode' and 'inspect': path to the MessagePack binary file to read.",
        },
        allow_multiple: {
          type: "boolean",
          description:
            "For 'decode' and 'decode_file': if true, decode a stream of concatenated MessagePack values " +
            "and return an array of all values (default false).",
        },

        // ---- encode_file / decode_file ----
        path: {
          type: "string",
          description:
            "For 'encode_file': path to the input JSON file. " +
            "For 'decode_file': path to the input MessagePack file.",
        },
        output: {
          type: "string",
          description:
            "For 'encode_file': path where the MessagePack output is written (required). " +
            "For 'decode_file': optional path to write the decoded JSON; if omitted, value is returned inline.",
        },
        pretty: {
          type: "boolean",
          description:
            "For 'decode_file' with 'output': if true, write pretty-printed JSON (2-space indent) instead of compact JSON (default false).",
        },

        // ---- inspect ----
        max_depth: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description:
            "For 'inspect': maximum nesting depth to expand in the type tree (1–10, default 3). " +
            "Deeper nodes are counted but not expanded (truncated: true).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_51 };
