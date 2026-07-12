"use strict";
// lib/schemas/utilSchemas47.js — JSON schema for tar_client tool

const UTIL_SCHEMAS_47 = [
  {
    name: "tar_client",
    description:
      "Fine-grained TAR archive manipulation tool (pure Node.js; zero npm deps). " +
      "Provides 7 operations for working with TAR archives at the individual-entry level — " +
      "far more granular than create_tar (whole-dir tar) or extract_tar (full extract). " +
      "Supports plain .tar and gzip-compressed .tar.gz/.tgz formats (auto-detected). " +
      "Operations: " +
      "list (enumerate all entries with name, size, modified time, mode, uid/gid; optional glob filter); " +
      "read (read a single entry's content as UTF-8 text or base64 without extracting the whole archive); " +
      "extract (selectively extract specific entries by name, or all, to a destination directory — Tar Slip protected); " +
      "add (add or replace individual files in an existing TAR, or create a new TAR if the path does not exist); " +
      "delete (remove specific entries from a TAR by name); " +
      "create (create a new TAR from an explicit list of files and/or directories with optional custom entry names; " +
        "auto-compresses to .tar.gz/.tgz based on destination extension, or when gzip:true is passed); " +
      "info (summary statistics: total entries, file/dir count, total size, compression format and ratio). " +
      "Security: 500 MB TAR read cap (uncompressed); 10 MB per-entry read cap; Tar Slip prevention; " +
      "NUL/traversal guards on all paths; absolute path and '..' guards on entry names; " +
      "symlink/hardlink/device/fifo entries rejected on extract. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        // ── Core ───────────────────────────────────────────────────────────────────
        operation: {
          type: "string",
          enum: ["list", "read", "extract", "add", "delete", "create", "info"],
          description:
            "Operation to perform. " +
            "'list': enumerate entries with full metadata (name, size, mtime, mode, uid/gid). " +
            "'read': read a single entry's content as text or base64. " +
            "'extract': extract entries to a destination directory. " +
            "'add': add/replace files in an existing TAR (creates TAR if missing). " +
            "'delete': remove entries from a TAR. " +
            "'create': create a new TAR from explicit file/directory sources; " +
              "compresses as .tar.gz/.tgz if destination ends in .tar.gz or .tgz, or when gzip:true. " +
            "'info': summary statistics for the TAR.",
        },

        // ── Path (used by list/read/extract/add/delete/info) ───────────────────────
        path: {
          type: "string",
          description:
            "Path to the TAR file to operate on. " +
            "Required for: list, read, extract, add, delete, info. " +
            "For 'add': the file is created if it does not exist.",
        },

        // ── list-specific ─────────────────────────────────────────────────────────
        filter: {
          type: "string",
          description:
            "For 'list': optional glob-style filter (supports * as wildcard) to restrict which entries " +
            "are returned. Case-insensitive. Example: '*.js' lists only JavaScript files.",
        },

        // ── read-specific ─────────────────────────────────────────────────────────
        entry: {
          type: "string",
          description:
            "For 'read': exact entry name inside the TAR (as returned by 'list'). " +
            "Example: 'src/index.js', 'README.md'.",
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

        // ── extract-specific ─────────────────────────────────────────────────────
        destination: {
          type: "string",
          description:
            "For 'extract': path to the directory where entries will be extracted (created if missing). " +
            "For 'create': path for the new TAR file to write (parent directories created automatically); " +
            "use a .tar.gz or .tgz extension to auto-compress with gzip.",
        },
        entries: {
          type: "array",
          items: { type: "string" },
          description:
            "For 'extract': list of specific entry names to extract. If omitted, all entries are extracted. " +
            "For 'delete': list of entry names to remove from the TAR. Required for 'delete'.",
        },
        overwrite: {
          type: "boolean",
          description:
            "For 'extract': allow extraction into an existing destination directory (default: false). " +
            "Existing files at the same path are overwritten.",
        },

        // ── add-specific ─────────────────────────────────────────────────────────
        files: {
          type: "array",
          description:
            "For 'add': array of {entry, source_path} objects — each specifying an existing host file " +
            "to add/replace in the TAR under the given entry name. " +
            "For 'create': array of {source_path, entry?} objects — each can be a file or directory. " +
            "Directories are archived recursively; 'entry' sets the base prefix inside the TAR " +
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
                  "For 'add': entry name inside the TAR (e.g. 'config/app.json'). Required. " +
                  "For 'create': optional base name/prefix inside the TAR. Defaults to basename of source_path.",
              },
            },
            additionalProperties: false,
          },
        },

        // ── delete-specific ─────────────────────────────────────────────────────
        ignore_missing: {
          type: "boolean",
          description:
            "For 'delete': if true, silently skip entries not found in the TAR instead of throwing an error " +
            "(default: false — missing entries are an error).",
        },

        // ── create-specific ─────────────────────────────────────────────────────
        gzip: {
          type: "boolean",
          description:
            "For 'create': if true, gzip-compress the resulting TAR (equivalent to .tar.gz). " +
            "Default: auto-detect from destination extension (.tar.gz/.tgz → true, .tar → false).",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_47 };
