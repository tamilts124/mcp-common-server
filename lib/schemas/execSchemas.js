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
    description: `Run an ordered sequence of operations (any tool) in a single call.\nEach step is an object with an 'op' field (tool name) plus the same arguments that tool takes directly.\nSteps run in order. If a step fails and on_error is 'stop' (default), remaining steps are skipped.\nSet on_error: 'continue' on a step to keep going even if it fails.\nReturns a summary with per-step status, result, and error details.\nUse this to chain dependent operations: rename then test, write then run, delete old then create new, etc.`,
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
                "file_info", "search_files", "find_files", "search_lines", "search_in_document",
                "git_status", "git_log", "git_blame", "git_diff", "git_stash_list", "git_branch_list", "git_worktree_list", "git_show", "git_tag_list", "git_ownership", "git_reflog", "git_cherry", "git_untracked_size", "find_stale_branches", "git_commit_message_lint", "check_gitignore_coverage", "git_diff_summary", "git_blame_hotspots", "git_file_age",
                "file_checksum", "checksum_verify", "hash_string", "zip_directory", "create_tar", "read_archive", "query_json", "query_data", "query_path", "diff_files", "env_info", "env_diff", "system_resources", "which_command", "find_duplicates", "compare_directories", "file_diff_dir", "json_diff", "json_schema_validate", "json_flatten", "json_unflatten", "find_circular_deps", "find_dead_exports", "find_unused_dependencies", "find_console_logs",
                "count_lines", "file_tree", "hash_directory",
                "base64_encode",
                "file_stats", "scan_todos", "scan_conflict_markers", "scan_secrets", "check_line_endings", "find_large_files", "find_empty_dirs", "package_json_audit", "readme_link_check", "dir_size_stats", "disk_usage_summary", "csv_query", "http_fetch", "port_check", "wait_for_port", "port_scan_range", "dns_lookup",
                "write_file", "write_files", "create_file", "create_files",
                "delete_file", "delete_files", "move_file", "copy_file", "move_directory", "copy_directory",
                "create_directory", "delete_directory", "replace_in_file",
                "truncate_file", "append_file",

                "base64_decode", "json_format", "text_transform",
                "json_patch", "apply_patch", "unzip_archive", "extract_tar", "yaml_patch", "yaml_merge", "convert_data", "csv_convert",
                "gzip_compress", "gzip_decompress", "brotli_compress", "brotli_decompress",
                "md_to_docx", "docx_to_md", "md_to_pdf", "pdf_to_md", "docx_to_pdf", "pdf_to_docx",
                "run_command", "start_process", "get_process_output",
                "kill_process", "list_processes",
                "browser_launch", "browser_navigate", "browser_get_content", "browser_evaluate",
                "browser_click", "browser_type", "browser_screenshot", "browser_get_console_logs",
                "browser_list_sessions", "browser_close", "browser_wait_for_selector", "browser_get_current_url", "browser_get_title",
                "browser_go_back", "browser_go_forward", "browser_reload",
                "browser_get_cookies", "browser_set_cookies", "browser_pdf",
                "browser_select_option", "browser_press_key", "browser_wait_for_navigation",
                "browser_hover", "browser_upload_file", "browser_scroll",
                "browser_double_click", "browser_right_click", "browser_drag_and_drop",
                "browser_download", "browser_get_attribute", "browser_is_visible",
                "browser_is_checked", "browser_check", "browser_uncheck",
                "browser_get_element_info", "browser_new_page", "browser_switch_page",
                "browser_list_pages", "browser_close_page", "browser_network_start",
                "browser_network_stop", "browser_get_network_requests", "browser_route",
                "browser_unroute", "browser_emulate", "browser_set_extra_headers",
                "browser_get_local_storage", "browser_set_local_storage", "browser_add_init_script", "browser_set_viewport",
                "browser_get_page_metrics", "browser_expose_function", "browser_get_exposed_calls",
                "browser_wait_for_response", "browser_get_storage_state", "browser_accessibility_snapshot",
                "browser_find_by_role", "browser_handle_next_dialog", "browser_wait_for_dialog",
                "browser_get_dialog_log", "browser_list_frames", "browser_frame_click",
                "browser_frame_type", "browser_frame_get_content", "browser_frame_evaluate",
                "browser_start_recording", "browser_stop_recording", "browser_get_recording", "browser_clear_recording", "browser_replay_actions",
                "email_list_mailboxes", "email_search", "email_send",
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
