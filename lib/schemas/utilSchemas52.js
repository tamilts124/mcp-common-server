"use strict";
// lib/schemas/utilSchemas52.js — JSON schema for cbor_client tool

const UTIL_SCHEMAS_52 = [
  {
    name: "cbor_client",
    description:
      "Zero-dependency CBOR (RFC 8949) encoder/decoder (pure Node.js; no npm deps). " +
      "CBOR (Concise Binary Object Representation) is a compact binary format used in IoT (CoAP), " +
      "WebAuthn/FIDO2, COSE (signing/encryption), hardware security keys, and embedded systems. " +
      "Supports all CBOR major types: unsigned int (MT0), negative int (MT1), byte strings (MT2), " +
      "text strings (MT3), arrays (MT4), maps (MT5), tags (MT6 — including bignum tags 2/3), " +
      "and floats/simples (MT7 — float16/32/64, true, false, null, undefined). " +
      "Indefinite-length encoding is fully supported for bytes, text, arrays, and maps. " +
      "Operations: " +
      "encode (encode an inline JSON value or json_file to CBOR bytes; returns hex + base64, or writes to output_file); " +
      "decode (decode CBOR from hex string, base64 string, or input_file; returns JSON-safe value); " +
      "encode_file (read a JSON file and write its CBOR encoding to an output file); " +
      "decode_file (read a CBOR file and return or write its decoded JSON value); " +
      "inspect (analyse the type structure / byte layout of a CBOR buffer without fully decoding it). " +
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
            "'encode': encode a JSON value (inline 'value' or 'json_file') to CBOR bytes. " +
            "'decode': decode CBOR bytes ('hex', 'base64', or 'input_file') to a JSON-safe value. " +
            "'encode_file': read a JSON file ('path') and write CBOR to 'output'. " +
            "'decode_file': read a CBOR file ('path') and return or write its decoded JSON ('output' optional). " +
            "'inspect': show the type tree / byte layout of a CBOR buffer without full decoding.",
        },

        // ---- encode ----
        value: {
          description:
            "For 'encode': the JSON-compatible value to encode (null, bool, number, string, array, object). " +
            "Required if 'json_file' is not provided.",
        },
        json_file: {
          type: "string",
          description: "For 'encode': path to a JSON file whose content will be encoded. Alternative to 'value'.",
        },
        output_file: {
          type: "string",
          description:
            "For 'encode': path where the CBOR bytes will be written. " +
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
            "For 'decode' and 'inspect': hex-encoded CBOR bytes (e.g. 'a201626869'). Case-insensitive. Spaces are stripped.",
        },
        base64: {
          type: "string",
          description: "For 'decode' and 'inspect': base64-encoded CBOR bytes.",
        },
        input_file: {
          type: "string",
          description: "For 'decode' and 'inspect': path to the CBOR binary file to read.",
        },
        allow_multiple: {
          type: "boolean",
          description:
            "For 'decode' and 'decode_file': if true, decode a stream of concatenated CBOR values " +
            "and return an array of all values (default false).",
        },

        // ---- encode_file / decode_file ----
        path: {
          type: "string",
          description:
            "For 'encode_file': path to the input JSON file. " +
            "For 'decode_file': path to the input CBOR file.",
        },
        output: {
          type: "string",
          description:
            "For 'encode_file': path where the CBOR output is written (required). " +
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
            "For 'inspect': maximum nesting depth to expand in the type tree (1–10, default 3). " +
            "Deeper nodes are counted but not expanded (truncated: true).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_52 };
