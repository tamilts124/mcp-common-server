"use strict";
// lib/schemas/utilSchemas36.js — JSON schema for dotenv_client tool

const UTIL_SCHEMAS_36 = [
  {
    name: "dotenv_client",
    description: "Zero-dependency .env file parser and writer (pure Node.js fs; no npm deps). Parse, query, write, delete, merge, validate, and export environment-variable files. Parser handles quoted values (single/double/backtick), escape sequences (\\n \\r \\t \\\\ in double-quoted strings), inline comments on unquoted values, blank lines, # comment lines, and the `export KEY=val` prefix. Writer preserves existing structure (comments, blank lines, ordering) and only rewrites changed lines. Security: key name validation ([A-Za-z_][A-Za-z0-9_]*); NUL/CRLF/space/equals guards on keys; NUL guard on values; 4 MB file cap; 1 MB per-value cap; 5000-key limit. Operations: read (parse file into key-value map), list (return key names only), write (add/update keys), delete (remove keys by name), merge (overlay a second .env over a base), validate (check required keys are present and non-empty), to_shell (emit `export KEY=value` lines for shell sourcing). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["read", "list", "write", "delete", "merge", "validate", "to_shell"],
          description: "Operation to perform. read=parse file to key-value map, list=return key names, write=add/update keys, delete=remove keys, merge=overlay source .env over base, validate=check required keys present, to_shell=emit export statements.",
        },
        path: {
          type: "string",
          description: "Path to the .env file. Required for all operations. For merge, this is the base file.",
        },

        // ── write ─────────────────────────────────────────────────────────
        vars: {
          type: "object",
          description: "Object mapping key names to string values. Required for 'write'. Keys must match [A-Za-z_][A-Za-z0-9_]*. Values are auto-quoted if they contain special characters.",
          additionalProperties: { type: "string" },
        },

        // ── delete ────────────────────────────────────────────────────────
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Array of key names to delete. Required for 'delete'. Keys not found in the file are reported in notFound but do not cause an error.",
        },

        // ── merge ─────────────────────────────────────────────────────────
        source: {
          type: "string",
          description: "Path to the source (override) .env file for 'merge'. Keys in this file override keys in the base file at 'path'. New keys from source are appended.",
        },
        output: {
          type: "string",
          description: "Output path for 'merge'. If omitted, the base file at 'path' is overwritten with the merged result.",
        },

        // ── validate ──────────────────────────────────────────────────────
        required: {
          type: "array",
          items: { type: "string" },
          description: "Array of key names that must be present and non-empty. Required for 'validate'. Returns valid=true/false plus lists of present and missing keys.",
        },

        // ── to_shell ──────────────────────────────────────────────────────
        prefix: {
          type: "string",
          description: "Prefix for each output line in 'to_shell' (default: 'export '). Pass '' for bare KEY=value lines.",
        },
        // keys is reused from delete schema (optional filter for to_shell too)
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_36 };
