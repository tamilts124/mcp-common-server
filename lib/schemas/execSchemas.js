"use strict";
// ── EXEC TOOL SCHEMAS — only present when MCP_ALLOW_EXEC=true and MCP_READ_ONLY=false ──

const { CMD_TIMEOUT } = require("../config");

const EXEC_SCHEMAS = [
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
                "file_info", "search_files", "find_files", "search_lines",
                "git_status", "git_log", "git_blame", "git_diff", "git_stash_list",
                "file_checksum", "zip_directory", "read_archive", "query_json", "query_data", "diff_files", "env_info", "find_duplicates", "compare_directories",
                "count_lines", "file_tree", "hash_directory",
                "base64_encode",
                "file_stats", "csv_query",
                "write_file", "write_files", "create_file", "create_files",
                "delete_file", "delete_files", "move_file", "copy_file",
                "create_directory", "delete_directory", "replace_in_file",
                "truncate_file", "append_file",
                "base64_decode", "json_format", "text_transform",
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

module.exports = { EXEC_SCHEMAS };
