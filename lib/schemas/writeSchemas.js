"use strict";
// ── WRITE TOOL SCHEMAS — hidden when MCP_READ_ONLY=true ───────────────────────

const WRITE_SCHEMAS = [
  {
    name: "write_file",
    description: "Write content to a file. from_line/to_line=0 replaces the whole file (creates a .bak backup first). Otherwise replaces only the specified line range.",
    inputSchema: { type: "object", required: ["path", "content"], properties: {
      path:      { type: "string" },
      content:   { type: "string", description: "New content to write." },
      from_line: { type: "number", description: "Start of line range to replace (1-based). 0 = whole file." },
      to_line:   { type: "number", description: "End of line range to replace (inclusive). 0 = whole file." },
    }},
  },
  {
    name: "write_files",
    description: "Write multiple files in one call. Each item: {path, content, from_line?, to_line?}. Line ranges work the same as write_file.",
    inputSchema: { type: "object", required: ["files"], properties: {
      files: { type: "array", items: { type: "object", required: ["path", "content"], properties: {
        path:      { type: "string" },
        content:   { type: "string" },
        from_line: { type: "number" },
        to_line:   { type: "number" },
      }}},
    }},
  },
  {
    name: "create_file",
    description: "Create a new file with optional content. Fails if the file already exists.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:    { type: "string" },
      content: { type: "string", description: "Initial file content (default: empty)." },
    }},
  },
  {
    name: "create_files",
    description: "Create multiple new files in one call. Each item: {path, content?}. Fails per-file if already exists.",
    inputSchema: { type: "object", required: ["files"], properties: {
      files: { type: "array", items: { type: "object", required: ["path"], properties: {
        path:    { type: "string" },
        content: { type: "string" },
      }}},
    }},
  },
  {
    name: "delete_file",
    description: "Permanently delete a file.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string" },
    }},
  },
  {
    name: "delete_files",
    description: "Permanently delete multiple files in one call.",
    inputSchema: { type: "object", required: ["paths"], properties: {
      paths: { type: "array", items: { type: "string" } },
    }},
  },
  {
    name: "move_file",
    description: "Move or rename a file. Works across directories and across roots (including across filesystems/drives, via an automatic copy+delete fallback when a direct rename is not possible). Rejects directory sources. Fails if the destination already exists unless overwrite: true is passed. Symlinks that would escape the source or destination root are blocked.",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string", description: "Current path of the file." },
      destination: { type: "string", description: "New path of the file." },
      overwrite:   { type: "boolean", description: "Allow overwriting an existing destination file (default: false — throws if destination exists)." },
    }},
  },
  {
    name: "copy_file",
    description: "Copy a file to a new location. Creates destination directories if needed. Rejects directory sources. Fails if the destination already exists unless overwrite: true is passed. Symlinks that would escape the source or destination root are blocked.",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string" },
      destination: { type: "string" },
      overwrite:   { type: "boolean", description: "Allow overwriting an existing destination file (default: false — throws if destination exists)." },
    }},
  },
  {
    name: "create_directory",
    description: "Create a directory, including all parent directories.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string" },
    }},
  },
  {
    name: "delete_directory",
    description: "Delete a directory. Set recursive: true to delete non-empty directories.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:      { type: "string" },
      recursive: { type: "boolean", description: "Delete contents recursively (default: false)." },
    }},
  },
  {
    name: "replace_in_file",
    description: "Find and replace text in one or more files. Supports plain string or regex substitution. Creates a .bak backup of each modified file. Use is_regex=true and flags='g' for global regex replace.",
    inputSchema: { type: "object", required: ["search", "replace"], properties: {
      search:   { type: "string",  description: "Text string or regex pattern to find." },
      replace:  { type: "string",  description: "Replacement text. For regex mode, can use $1, $2 etc. for capture groups." },
      path:     { type: "string",  description: "File path or directory to search. If a directory, operates on all matched files." },
      is_regex: { type: "boolean", description: "Treat search as a regular expression (default: false)." },
      flags:    { type: "string",  description: "Regex flags to use when is_regex=true (default: 'g'). E.g. 'gi' for case-insensitive global." },
      extensions: { type: "array", description: "When path is a directory, only process files with these extensions.",
        items: { type: "string" },
      },
    }},
  },
  {
    name: "truncate_file",
    description: "Shrink a file to its first N lines or first N bytes. Exactly one of 'lines' or 'bytes' must be supplied. If the file is already shorter than the limit, it is left unchanged. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:  { type: "string", description: "Path to the file to truncate." },
      lines: { type: "number", description: "Keep the first N lines (newline-delimited). Mutually exclusive with 'bytes'." },
      bytes: { type: "number", description: "Keep the first N bytes. Mutually exclusive with 'lines'." },
    }},
  },
  {
    name: "append_file",
    description: "Append text content to the end of a file. Creates the file (and any missing parent directories) if it does not already exist. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:    { type: "string", description: "Path to the file to append to." },
      content: { type: "string", description: "Text to append. May be empty string (no-op append)." },
    }},
  },
  {
    name: "json_patch",
    description: "Apply RFC 6902 JSON Patch operations (add, remove, replace, move, copy, test) to a JSON file. Path pointers use RFC 6901 JSON Pointer syntax (e.g. /dependencies/lodash, /scripts/build, /items/0). The file is read, all operations are applied atomically in memory, and the result is written back pretty-printed at the original indent level. Pass apply: false for a dry-run that returns the patched document without touching the file. A failed 'test' operation aborts the entire patch (no partial writes). Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "ops"], properties: {
      path: { type: "string", description: "Path to the JSON file to patch (e.g. 'package.json', 'config/settings.json')." },
      ops:  { type: "array",  description: "Array of RFC 6902 patch operations. Each operation is an object with 'op' (required), 'path' (required, RFC 6901 pointer), and optionally 'value' and 'from'.",
        items: { type: "object", required: ["op", "path"], properties: {
          op:    { type: "string", description: "Operation name: 'add', 'remove', 'replace', 'move', 'copy', or 'test'." },
          path:  { type: "string", description: "RFC 6901 JSON Pointer to the target location (e.g. '/scripts/build' or '/deps/0')." },
          value: { description: "Value to use for 'add', 'replace', and 'test' operations." },
          from:  { type: "string", description: "Source pointer for 'move' and 'copy' operations." },
        }},
      },
      apply: { type: "boolean", description: "If false, perform a dry-run: return the patched document without writing the file (default: true)." },
    }},
  },
  {
    name: "apply_patch",
    description: "Apply a unified diff (as produced by diff_files, git diff, or diff -u) to a file. Hunks are applied atomically — the whole modified content is assembled in memory and written to disk only if every hunk succeeds. Strict mode (default) verifies that context lines in the patch match the actual file, so a patch intended for a different version of the file is rejected safely. Fuzzy mode (strict: false) skips context verification and applies hunks by position only — useful for offset-only patches on slightly modified files. Use dry_run: true to preview the patched text without touching the file. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "patch"], properties: {
      path:     { type: "string",  description: "Path to the file to patch." },
      patch:    { type: "string",  description: "Unified diff text (--- / +++ / @@ hunk format)." },
      strict:   { type: "boolean", description: "Verify context lines match the file exactly (default: true). Set false to skip context verification." },
      dry_run:  { type: "boolean", description: "If true, return the patched file content without writing it (default: false)." },
    }},
  },
];

module.exports = { WRITE_SCHEMAS };
