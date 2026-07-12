"use strict";
// lib/schemas/utilSchemas46.js — JSON schema for zip_client tool

const UTIL_SCHEMAS_46 = [
  {
    name: "zip_client",
    description:
      "Fine-grained ZIP file manipulation tool (pure Node.js; zero npm deps). " +
      "Provides 7 operations for working with ZIP archives at the individual-entry level — " +
      "far more granular than zip_directory (whole-dir zip) or unzip_archive (full extract). " +
      "Operations: " +
      "list (enumerate all entries with name, size, compression ratio, CRC-32, and modified time); " +
      "read (read a single entry's content as UTF-8 text or base64 without extracting the whole archive); " +
      "extract (selectively extract specific entries by name, or all, to a destination directory — Zip Slip protected); " +
      "add (add or replace individual files in an existing ZIP, or create a new ZIP if the path does not exist); " +
      "delete (remove specific entries from a ZIP by name); " +
      "create (create a new ZIP from an explicit list of files and/or directories with optional custom entry names); " +
      "info (summary statistics: total entries, file/dir count, total/compressed sizes, overall compression ratio). " +
      "Security: 200 MB ZIP read cap; 10 MB per-entry read cap; Zip Slip prevention; NUL/traversal guards on all paths; " +
      "absolute path and '..' guards on entry names. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        // ── Core ─────────────────────────────────────────────────────────────
        operation: {
          type: "string",
          enum: ["list", "read", "extract", "add", "delete", "create", "info"],
          description:
            "Operation to perform. " +
            "'list': enumerate entries with full metadata. " +
            "'read': read a single entry as text or base64. " +
            "'extract': extract entries to a destination directory. " +
            "'add': add/replace files in an existing ZIP (creates ZIP if missing). " +
            "'delete': remove entries from a ZIP. " +
            "'create': create a new ZIP from explicit file/directory sources. " +
            "'info': summary statistics for the ZIP.",
        },

        // ── Path (used by list/read/extract/add/delete/info) ─────────────────
        path: {
          type: "string",
          description:
            "Path to the ZIP file to operate on. " +
            "Required for: list, read, extract, add, delete, info. " +
            "For 'add': the file is created if it does not exist.",
        },

        // ── list-specific ────────────────────────────────────────────────────
        filter: {
          type: "string",
          description:
            "For 'list': optional glob-style filter (supports * as wildcard) to restrict which entries are returned. " +
            "Case-insensitive. Example: '*.js' lists only JavaScript files.",
        },

        // ── read-specific ─────────────────────────────────────────────────────
        entry: {
          type: "string",
          description:
            "For 'read' and 'extract' (single entry shorthand): exact entry name inside the ZIP " +
            "(as returned by 'list'). Example: 'src/index.js', 'README.md'.",
        },
        encoding: {
          type: "string",
          enum: ["auto", "utf8", "base64"],
          description:
            "For 'read': how to return the entry's content. " +
            "'auto' (default): returns UTF-8 text for text files, base64 for binary. " +
            "'utf8': always return as UTF-8 string. " +
            "'base64': always return as base64 string.",
        },

        // ── extract-specific ─────────────────────────────────────────────────
        destination: {
          type: "string",
          description:
            "For 'extract' and 'create': " +
            "'extract' — path to the directory where entries will be extracted (created if missing). " +
            "'create' — path for the new ZIP file to write (parent directories created automatically).",
        },
        entries: {
          type: "array",
          items: { type: "string" },
          description:
            "For 'extract': list of specific entry names to extract. If omitted, all entries are extracted. " +
            "For 'delete': list of entry names to remove from the ZIP. Required for 'delete'.",
        },
        overwrite: {
          type: "boolean",
          description:
            "For 'extract': allow extraction into an existing destination directory (default: false). " +
            "Existing files at the same path are overwritten.",
        },

        // ── add-specific ─────────────────────────────────────────────────────
        files: {
          type: "array",
          description:
            "For 'add': array of {entry, source_path} objects — each specifying an existing host file " +
            "to add/replace in the ZIP under the given entry name. " +
            "For 'create': array of {source_path, entry?} objects — each can be a file or directory. " +
            "Directories are archived recursively; 'entry' sets the base prefix inside the ZIP " +
            "(defaults to the basename of source_path).",
          items: {
            type: "object",
            properties: {
              source_path: {
                type: "string",
                description: "Path to the source file or directory on disk.",
              },
              entry: {
                type: "string",
                description:
                  "For 'add': entry name inside the ZIP (e.g. 'config/app.json'). Required. " +
                  "For 'create': optional base name/prefix inside the ZIP. Defaults to basename of source_path.",
              },
            },
            additionalProperties: false,
          },
        },

        // ── delete-specific ──────────────────────────────────────────────────
        ignore_missing: {
          type: "boolean",
          description:
            "For 'delete': if true, silently skip entries not found in the ZIP instead of throwing an error " +
            "(default: false — missing entries are an error).",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_46 };
