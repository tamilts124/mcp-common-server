"use strict";
// ── CORE READ TOOL SCHEMAS — always available ──────────────────────────────────
// Generic filesystem read operations: directory listing, file reading
// (single/batch/bulk), metadata, text search, and glob-based file finding.

const CORE_READ_SCHEMAS = [
  {
    name: "read_directory",
    description: "List files and folders in a root or subdirectory. Omit path to list all roots.",
    inputSchema: { type: "object", properties: {
      path:    { type: "string",  description: "Root alias or subdirectory path. Omit to list all roots." },
      sub_dir: { type: "boolean", description: "Recurse into subdirectories (default: false)." },
    }},
  },
  {
    name: "read_file",
    description: "Read a file's content. Use from_line/to_line to limit to a line range (both 0 = entire file).",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:      { type: "string" },
      from_line: { type: "number", description: "First line to return (1-based). 0 = start." },
      to_line:   { type: "number", description: "Last line to return (inclusive). 0 = end." },
    }},
  },
  {
    name: "read_files",
    description: "Read multiple files in one call. Each item is a path string or {path, from_line?, to_line?}.",
    inputSchema: { type: "object", required: ["files"], properties: {
      files: { type: "array", description: "Array of path strings or {path, from_line?, to_line?} objects.",
        items: { oneOf: [
          { type: "string" },
          { type: "object", required: ["path"], properties: {
            path:      { type: "string" },
            from_line: { type: "number" },
            to_line:   { type: "number" },
          }},
        ]},
      },
    }},
  },
  {
    name: "read_allfiles",
    description: "Read every file in a directory at once. Filter by extensions if needed.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string",  description: "Directory to read (default: first root)." },
      sub_dir:    { type: "boolean", description: "Include subdirectories (default: true)." },
      extensions: { type: "array",   description: "Only include files with these extensions, e.g. [\".py\", \".js\"].",
        items: { type: "string" },
      },
    }},
  },
  {
    name: "file_info",
    description: "Get metadata for a file or directory: size, created, modified, permissions, line count.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string" },
    }},
  },
  {
    name: "search_files",
    description: "Search for a text string or regex pattern across files. Returns matching lines with line numbers.",
    inputSchema: { type: "object", required: ["pattern"], properties: {
      path:       { type: "string",  description: "Directory to search (default: first root)." },
      pattern:    { type: "string",  description: "Text string or regex pattern to search for." },
      is_regex:   { type: "boolean", description: "Treat pattern as a regular expression (default: false)." },
      sub_dir:    { type: "boolean", description: "Search recursively (default: true)." },
      extensions: { type: "array",   description: "Limit search to these file extensions.",
        items: { type: "string" },
      },
    }},
  },
  {
    name: "find_files",
    description: "Find files by name or path glob pattern (e.g. '*.test.js', '**/*.config.*', 'src/{a,b}.ts'). Searches filenames and relative paths. Supports *, **, ?, [abc], {a,b} glob syntax.",
    inputSchema: { type: "object", required: ["pattern"], properties: {
      pattern:  { type: "string",  description: "Glob pattern to match against filenames or relative paths. Examples: '*.py', '**/*.test.js', 'src/**/*.{ts,tsx}', 'config*.json'." },
      path:     { type: "string",  description: "Directory to search (default: first root)." },
      sub_dir:  { type: "boolean", description: "Search recursively (default: true)." },
    }},
  },
];

module.exports = { CORE_READ_SCHEMAS };
