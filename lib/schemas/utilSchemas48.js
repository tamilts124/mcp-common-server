"use strict";
// lib/schemas/utilSchemas48.js — JSON schema for json_client tool

const UTIL_SCHEMAS_48 = [
  {
    name: "json_client",
    description:
      "Fine-grained JSON file editor (pure Node.js; zero npm deps). " +
      "Provides 8 operations for reading, navigating, and mutating .json files at the individual-key level — " +
      "far more ergonomic than query_json (read-only) or json_patch (no path navigation). " +
      "Completes the file-format client family: dotenv/toml/yaml/ini/xml/markdown/csv/jsonl/zip/tar → json_client. " +
      "Operations: " +
      "read (parse and return the full JSON document); " +
      "get (retrieve a value at a dot-notation key_path like 'a.b.0.name'; optional default for missing paths); " +
      "set (set or overwrite a value at a key_path; creates file if create:true); " +
      "delete (remove a key or array index at a key_path; ignore_missing option); " +
      "keys (list object keys or array length at a given path); " +
      "merge (deep-merge one or more JSON source files and/or an inline 'data' object into the file; " +
        "objects are recursively merged, arrays and scalars: source wins; creates file if create:true); " +
      "patch (apply a JSON Patch RFC 6902 array of operations — add, remove, replace, move, copy, test — " +
        "atomically to the file; rolled back on any error); " +
      "stringify (return the document as a formatted or minified JSON string; optionally write back with write_back). " +
      "Security: 10 MB file cap; max nesting depth 100; 200,000-key limit; NUL-byte path guard. " +
      "All write operations (set/delete/merge/patch) re-serialise with 2-space indent by default (configurable). " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      additionalProperties: false,
      properties: {
        // ── Core ─────────────────────────────────────────────────────────────
        operation: {
          type: "string",
          enum: ["read", "get", "set", "delete", "keys", "merge", "patch", "stringify"],
          description:
            "Operation to perform. " +
            "'read': return the full parsed document. " +
            "'get': retrieve a value at key_path. " +
            "'set': set a value at key_path (writes file). " +
            "'delete': remove key/index at key_path (writes file). " +
            "'keys': list keys (object) or indices (array) at key_path. " +
            "'merge': deep-merge sources/data into the file (writes file). " +
            "'patch': apply RFC 6902 JSON Patch operations array (writes file). " +
            "'stringify': format the document as a JSON string.",
        },

        // ── File path (all operations) ─────────────────────────────────────────
        path: {
          type: "string",
          description:
            "Path to the JSON file to operate on. Required for all operations.",
        },

        // ── Key path (get/set/delete/keys) ──────────────────────────────────────
        key_path: {
          type: "string",
          description:
            "Dot-notation path to a value within the document. " +
            "Examples: 'name', 'dependencies.lodash', 'users.0.email', 'items.2'. " +
            "Escape literal dots in key names with a backslash: 'a.b\\.c.d'. " +
            "For 'get': required. For 'set': use '' (empty string) to replace the root document. " +
            "For 'delete': required. For 'keys': optional — omit to list top-level keys/indices. " +
            "For 'merge': unused.",
        },

        // ── get-specific ─────────────────────────────────────────────────────────────
        default: {
          description:
            "For 'get': value to return when key_path is not found (instead of throwing an error). " +
            "May be any JSON-serialisable value. When provided, the response 'found' field is false " +
            "and 'value' is this default.",
        },
        default_value_set: {
          type: "boolean",
          description:
            "For 'get': internal flag — set to true when 'default' is explicitly provided " +
            "(allows null as a valid default). Callers should use 'default' directly; " +
            "the schema resolver sets this flag automatically if 'default' is present.",
        },

        // ── set-specific ─────────────────────────────────────────────────────────────
        value: {
          description:
            "For 'set': the JSON value to write at key_path. May be any JSON-serialisable value: " +
            "string, number, boolean, null, object, or array.",
        },
        create: {
          type: "boolean",
          description:
            "For 'set' and 'merge': if true, create the JSON file with an empty object {} as root " +
            "when it does not exist (default: false — missing file is an error).",
        },

        // ── delete-specific ───────────────────────────────────────────────────────────
        ignore_missing: {
          type: "boolean",
          description:
            "For 'delete': if true, silently succeed when key_path does not exist " +
            "instead of throwing an error (default: false).",
        },

        // ── merge-specific ───────────────────────────────────────────────────────────
        sources: {
          type: "array",
          items: { type: "string" },
          description:
            "For 'merge': list of paths to JSON files to deep-merge into the target file, in order. " +
            "Later sources override earlier ones where keys conflict. " +
            "Provide 'sources' and/or 'data' (at least one is required for merge).",
        },
        data: {
          description:
            "For 'merge': inline JSON value (object/array/scalar) to merge as the final layer " +
            "after any 'sources' files. Objects are deeply merged; arrays/scalars replace the target value.",
        },

        // ── patch-specific ───────────────────────────────────────────────────────────
        operations: {
          type: "array",
          description:
            "For 'patch': RFC 6902 JSON Patch operations array. Each operation is an object with: " +
            "{ op: 'add'|'remove'|'replace'|'move'|'copy'|'test', path: '/json/pointer', value?, from? }. " +
            "'path' and 'from' use JSON Pointer notation (RFC 6901): '/' prefix, '~1' for '/', '~0' for '~'. " +
            "Operations are applied atomically — rolled back on any error. " +
            "Example: [{ op: 'replace', path: '/version', value: '2.0.0' }, { op: 'remove', path: '/deprecated' }]",
          items: {
            type: "object",
            properties: {
              op:    { type: "string", enum: ["add", "remove", "replace", "move", "copy", "test"] },
              path:  { type: "string" },
              from:  { type: "string" },
              value: {},
            },
            required: ["op", "path"],
            additionalProperties: false,
          },
        },

        // ── stringify-specific ────────────────────────────────────────────────────────
        write_back: {
          type: "boolean",
          description:
            "For 'stringify': if true, write the formatted string back to the file (default: false — " +
            "only return the string). Useful for normalising/reformatting a JSON file in-place.",
        },

        // ── Shared write options ──────────────────────────────────────────────────────
        indent: {
          type: "number",
          description:
            "Number of spaces per indent level when writing the file (default: 2, range 0–8). " +
            "Set to 0 to minify (no whitespace). Applies to: set, delete, merge, patch, stringify.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_48 };
