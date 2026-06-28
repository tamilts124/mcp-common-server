"use strict";
// ── TOOL JSON-SCHEMA DEFINITIONS ───────────────────────────────────────────────
const { CMD_TIMEOUT } = require("./config");

const TOOLS_ALL = [

  // ════════════════════════════════════════════════════════════════════════════
  //  READ TOOLS — always available
  // ════════════════════════════════════════════════════════════════════════════

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

  {
    name: "file_checksum",
    description: "Compute a cryptographic digest (MD5, SHA-1, SHA-256, or SHA-512) of a file. Useful for verifying file integrity, detecting duplicates, and change detection.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:      { type: "string", description: "Path to the file to hash." },
      algorithm: { type: "string", description: "Hash algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'." },
    }},
  },
  {
    name: "zip_directory",
    description: "Archive a directory (and all its contents) into a ZIP file. Uses DEFLATE compression. The output .zip is written inside the jailed file system. Zero npm dependencies — pure Node.js built-ins.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source directory to archive." },
      destination: { type: "string", description: "Path for the output .zip file (e.g. 'backups/project.zip'). Parent directories are created automatically." },
    }},
  },
  {
    name: "query_json",
    description: "Parse a JSON file and extract a value by dot-notation path (e.g. 'dependencies.lodash', 'users.0.name'). Returns the value, its type, and the resolved path. Use an empty query to return the entire document.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:  { type: "string", description: "Path to the JSON file to parse." },
      query: { type: "string", description: "Dot-notation path into the parsed object (e.g. 'a.b.c' or 'items.0.name'). Empty or omitted = return root document." },
    }},
  },

  // ════════════════════════════════════════════════════════════════════════════
  //  WRITE TOOLS — hidden when MCP_READ_ONLY=true
  // ════════════════════════════════════════════════════════════════════════════

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
    description: "Move or rename a file. Works across directories within the same root.",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string", description: "Current path of the file." },
      destination: { type: "string", description: "New path of the file." },
    }},
  },
  {
    name: "copy_file",
    description: "Copy a file to a new location. Creates destination directories if needed.",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string" },
      destination: { type: "string" },
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

  // ════════════════════════════════════════════════════════════════════════════
  //  EXEC TOOLS — only present when MCP_ALLOW_EXEC=true and MCP_READ_ONLY=false
  // ════════════════════════════════════════════════════════════════════════════

  {
    name: "run_command",
    description: "Execute a shell command inside a root directory and return stdout, stderr, and exit code. Requires MCP_ALLOW_EXEC=true on the server.",
    inputSchema: { type: "object", required: ["command"], properties: {
      command: { type: "string",  description: "Shell command to run, e.g. 'python main.py' or 'npm test'." },
      cwd:     { type: "string",  description: "Working directory — root alias or path inside a root (default: first root)." },
      timeout: { type: "number",  description: `Seconds before the command is killed (default: ${CMD_TIMEOUT}, max: ${CMD_TIMEOUT}).` },
      env:     { type: "object",  description: "Extra environment variables to merge in, e.g. {\"DEBUG\": \"1\"}.",
        additionalProperties: { type: "string" },
      },
    }},
  },
  {
    name: "start_process",
    description: "Start a long-running background process (e.g. 'npm run dev', 'python server.py'). Returns a process id. Use get_process_output to read its stdout/stderr and kill_process to stop it. Requires MCP_ALLOW_EXEC=true.",
    inputSchema: { type: "object", required: ["command"], properties: {
      command: { type: "string",  description: "Shell command to run in the background." },
      cwd:     { type: "string",  description: "Working directory — root alias or path inside a root (default: first root)." },
      env:     { type: "object",  description: "Extra environment variables to merge in.",
        additionalProperties: { type: "string" },
      },
    }},
  },
  {
    name: "get_process_output",
    description: "Read buffered stdout and stderr from a background process started with start_process. Optionally clear the buffer after reading (for polling patterns).",
    inputSchema: { type: "object", required: ["id"], properties: {
      id:         { type: "string",  description: "Process id returned by start_process." },
      tail_bytes: { type: "number",  description: "Return only the last N bytes of each stream (0 = all, default: 0)." },
      clear:      { type: "boolean", description: "Clear the buffer after reading so next call only shows new output (default: false)." },
    }},
  },
  {
    name: "kill_process",
    description: "Stop a background process started with start_process.",
    inputSchema: { type: "object", required: ["id"], properties: {
      id:     { type: "string",  description: "Process id returned by start_process." },
      signal: { type: "string",  description: "Signal to send (default: 'SIGTERM'). Use 'SIGKILL' to force-kill." },
      remove: { type: "boolean", description: "Remove the process entry after killing (default: true)." },
    }},
  },
  {
    name: "list_processes",
    description: "List all background processes started with start_process, their status, and buffered output sizes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "execute_pipeline",
    description: `Run an ordered sequence of operations (any tool) in a single call.
Each step is an object with an 'op' field (tool name) plus the same arguments that tool takes directly.
Steps run in order. If a step fails and on_error is 'stop' (default), remaining steps are skipped.
Set on_error: 'continue' on a step to keep going even if it fails.
Returns a summary with per-step status, result, and error details.
Use this to chain dependent operations: rename then test, write then run, delete old then create new, etc.`,
    inputSchema: { type: "object", required: ["steps"], properties: {
      steps: {
        type: "array",
        description: "Ordered list of operations to run.",
        items: {
          type: "object",
          required: ["op"],
          properties: {
            op: {
              type: "string",
              description: "Tool name to run for this step. Any tool available on this server is valid.",
              enum: [
                "read_directory", "read_file", "read_files", "read_allfiles",
                "file_info", "search_files", "find_files",
                "file_checksum", "zip_directory", "query_json",
                "write_file", "write_files", "create_file", "create_files",
                "delete_file", "delete_files", "move_file", "copy_file",
                "create_directory", "delete_directory", "replace_in_file",
                "run_command", "start_process", "get_process_output",
                "kill_process", "list_processes",
              ],
            },
            on_error: {
              type: "string",
              enum: ["stop", "continue"],
              description: "What to do if this step fails. 'stop' (default) skips remaining steps. 'continue' keeps going.",
            },
          },
          additionalProperties: true,
        },
      },
    }},
  },
];

// Tool category sets
const WRITE_TOOLS = new Set([
  "write_file", "write_files", "create_file", "create_files",
  "delete_file", "delete_files", "move_file", "copy_file",
  "create_directory", "delete_directory", "replace_in_file",
]);
const EXEC_TOOLS = new Set([
  "run_command", "execute_pipeline",
  "start_process", "get_process_output", "kill_process", "list_processes",
]);

module.exports = { TOOLS_ALL, WRITE_TOOLS, EXEC_TOOLS };
