"use strict";
// lib/schemas/utilSchemas37.js — JSON schema for toml_client tool

const UTIL_SCHEMAS_37 = [
  {
    name: "toml_client",
    description: "Zero-dependency TOML v1.0 parser and writer (pure Node.js fs; no npm deps). Read, query, modify, and create TOML configuration files such as Cargo.toml, pyproject.toml, config.toml. Supports the full TOML v1.0 spec: basic/literal/multiline strings, integers (decimal/hex/octal/binary), floats (inf/nan), booleans, offset date-times, local dates/times, arrays, inline tables, standard tables ([section]), and array of tables ([[section]]). Operations: read (parse file to JS object), get (get value at dotted key path), set (set/update value at dotted key path), delete (remove key at dotted key path), list_keys (list keys in root or a section), list_sections (list all table/array-of-tables headers), merge (overlay source TOML over base file), stringify (convert JS object to TOML string). Security: path NUL guard; 4 MB file cap; key nesting depth limit (max 20); 50,000 key limit. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["read", "get", "set", "delete", "list_keys", "list_sections", "merge", "stringify"],
          description: "Operation: read=parse TOML file to object, get=get value at key path, set=set value at key path and rewrite, delete=remove key and rewrite, list_keys=list top-level or section keys, list_sections=list all table headers, merge=overlay source TOML over base, stringify=convert JS object to TOML.",
        },
        path: {
          type: "string",
          description: "Path to the TOML file. Required for all operations except stringify (when no output_path). For merge, this is the base file.",
        },
        key_path: {
          type: "string",
          description: "Dotted key path (e.g. 'package.version', 'dependencies.serde'). Required for get, set, delete.",
        },
        value: {
          description: "Value to set. Can be a string, number, boolean, array, or object. Required for set.",
        },
        section: {
          type: "string",
          description: "For list_keys: dotted path to a sub-table to list keys of (e.g. 'dependencies'). Optional; if omitted, lists root keys.",
        },
        source_path: {
          type: "string",
          description: "Path to the source TOML file to merge (overlay) onto the base file at 'path'. Required for merge.",
        },
        output_path: {
          type: "string",
          description: "For merge: output path to write merged result (defaults to 'path'). For stringify: path to write the TOML output file.",
        },
        data: {
          type: "object",
          description: "Plain JS object to convert to TOML string. Required for stringify.",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_37 };
