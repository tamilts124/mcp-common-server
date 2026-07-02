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
    description: "Read a file's content. Use from_line/to_line to limit to a line range (both 0 = entire file). When a range is requested, the result includes structured fromLine/toLine/returnedLines/totalLines fields alongside content, so large files can be paged through a chunk at a time without reading the whole thing.",
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
    name: "search_lines",
    description: "Grep-like line-level search: for each matching line in a file (or recursively across a directory), returns the 1-based line number, the matching line text, and optional surrounding context lines. Complements search_files (which returns matching file names) by pinpointing exact lines — useful for inspecting logs, locating function definitions, or finding where a string appears in large files without reading the whole file. Supports literal substring or regex matching, case-insensitive mode, extension filtering (directory mode), and a result cap. MCP_IGNORE'd directories are skipped automatically.",
    inputSchema: { type: "object", required: ["path", "pattern"], properties: {
      path:        { type: "string",  description: "File or directory to search. If a directory, searches recursively." },
      pattern:     { type: "string",  description: "Text string (literal, escaped automatically) or regex pattern to search for." },
      is_regex:    { type: "boolean", description: "Treat pattern as a regular expression (default: false)." },
      ignore_case: { type: "boolean", description: "Case-insensitive matching (default: false)." },
      context:     { type: "number",  description: "Number of surrounding context lines before/after each match (0-10, default: 0)." },
      max_matches: { type: "number",  description: "Maximum total matches to return (1-2000, default: 200)." },
      extensions:  { type: "array",   items: { type: "string" }, description: "Directory mode only: restrict to files with these extensions, e.g. ['.js', '.ts']." },
    }},
  },
  {
    name: "search_in_document",
    description: "Grep-like text search inside a .docx or .pdf file's extracted plain text, without writing a converted markdown file to disk first (unlike docx_to_md/pdf_to_md, this is read-only and does not require MCP_ALLOW_EXEC). For .docx, each paragraph/heading/bullet is treated as one searchable line (images skipped); for .pdf, text is extracted per the same stream-decoding logic as pdf_to_md. Matching semantics mirror search_lines: literal substring (auto-escaped) or regex, optional case-insensitive mode, optional surrounding context lines, and a result cap. Returns { path, format, pattern, isRegex, ignoreCase, totalLines, totalMatches, truncated, matches: [{ line, content, context: {before, after} }] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path", "pattern"], properties: {
      path:        { type: "string",  description: "Path to a .docx or .pdf file." },
      pattern:     { type: "string",  description: "Text string (literal, escaped automatically) or regex pattern to search for." },
      is_regex:    { type: "boolean", description: "Treat pattern as a regular expression (default: false)." },
      ignore_case: { type: "boolean", description: "Case-insensitive matching (default: false)." },
      context:     { type: "number",  description: "Number of surrounding context lines/paragraphs before/after each match (0-10, default: 0)." },
      max_matches: { type: "number",  description: "Maximum total matches to return (1-2000, default: 200)." },
    }},
  },
  {
    name: "env_diff",
    description: "Compare two .env-style files (e.g. .env vs .env.example) to catch environment-config drift. Parses KEY=VALUE lines (skips comments/blank lines, strips optional surrounding quotes, supports 'export KEY='; duplicate keys keep last occurrence like real dotenv loaders). Reports keys only in path, keys only in compare_path, and keys in path with an empty value. Read-only — does not require MCP_ALLOW_EXEC. Returns { path, comparePath, onlyInPath, onlyInComparePath, emptyInPath, commonKeyCount, totalPathKeys, totalCompareKeys }.",
    inputSchema: { type: "object", required: ["path", "compare_path"], properties: {
      path:         { type: "string", description: "Primary/live .env-style file." },
      compare_path: { type: "string", description: "Reference .env-style file to compare against (e.g. .env.example)." },
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
