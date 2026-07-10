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
    name: "run_npm_script",
    description: `Execute a package.json script (e.g. 'test', 'build') via 'npm run <script>' and capture stdout, stderr, exit code, and timing. Actual-execution complement to the many static-scan tools in this server (find_*/check_*/scan_*) — for when the caller wants to know what actually happens when the tests/build run, not just what a static scan predicts. Validates the script exists in package.json's 'scripts' map before spawning anything (a typo'd name gets a clear -32602 error listing available scripts, instead of npm's own generic failure). Runs via spawn with an argv array — 'extra_args' are passed as literal arguments after '--', never concatenated into a shell string, so they can't be used for command injection. Async, non-blocking (does not freeze the server's event loop while the script runs). Returns { path, script, command, exitCode, signal, success, timedOut, durationMs, stdout, stderr, stdoutTruncated, stderrTruncated, error }. Requires MCP_ALLOW_EXEC=true.`,
    inputSchema: { type: "object", required: ["script"], properties: {
      path:       { type: "string", description: "Project directory containing package.json (default: first root)." },
      script:     { type: "string", description: "npm script name to run, e.g. 'test', 'build', 'lint'. Must exist in package.json's scripts." },
      extra_args: { type: "array", items: { type: "string" }, description: "Extra arguments appended after '--', e.g. ['--watch=false']." },
      timeout:    { type: "number", description: `Seconds before the script is killed (default/max: ${CMD_TIMEOUT}).` },
      env:        { type: "object", description: "Extra environment variables to merge in.",
        additionalProperties: { type: "string" },
      },
    }},
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
                "git_status", "git_log", "git_blame", "git_diff", "git_stash_list", "git_branch_list", "git_worktree_list", "git_worktree_prune_candidates", "git_show", "git_tag_list", "git_ownership", "git_reflog", "git_dangling_commits", "git_object_count", "git_cherry", "git_untracked_size", "find_stale_branches", "git_commit_message_lint", "check_gitignore_coverage", "check_dotenv_files_not_gitignored", "git_diff_summary", "git_blame_hotspots", "git_file_age", "find_todo_owners", "find_stale_todos", "generate_pr_description", "find_large_git_objects", "check_lfs_coverage", "merge_conflict_risk", "git_contributors_summary", "find_recent_force_pushes", "check_stash_apply_risk", "git_blame_ownership_diff", "git_tag_annotate_audit", "check_commit_signatures", "git_commit_frequency", "git_orphaned_branches", "git_submodule_status", "suggest_next_version",

                "file_checksum", "checksum_verify", "hash_string", "regex_test", "jwt_decode", "url_parse", "semver_compare", "zip_directory", "create_tar", "read_archive", "query_json", "query_data", "query_path", "diff_files", "env_info", "env_diff", "system_resources", "which_command", "find_duplicates", "compare_directories", "file_diff_dir", "dir_diff_summary", "find_binary_diffs", "json_diff", "json_patch_generate", "json_schema_validate", "json_schema_generate", "json_flatten", "json_unflatten", "find_circular_deps", "find_dead_exports", "find_unused_dependencies", "find_console_logs", "find_duplicate_dependencies",
                "count_lines", "file_tree", "hash_directory",
                "base64_encode", "check_binary_file",
                "file_stats", "scan_todos", "scan_conflict_markers", "scan_secrets", "check_line_endings", "find_large_files", "find_empty_dirs", "package_json_audit", "readme_link_check", "check_package_lock_sync", "scan_dockerfile_issues", "scan_dependency_licenses", "find_case_sensitive_import_mismatches", "scan_cors_misconfig", "scan_dangerous_code_patterns", "check_branch_protection_hints", "find_hardcoded_ips", "find_env_var_usage", "git_hooks_audit", "check_npm_audit_cache", "find_unreachable_modules", "find_orphaned_test_files", "find_missing_await", "check_test_coverage_gaps", "find_duplicate_json_keys", "find_duplicate_yaml_keys", "find_unsafe_regex", "find_unpinned_github_actions", "scan_npm_lifecycle_scripts", "check_semver_range_strictness", "find_empty_catch_blocks", "find_sync_fs_in_async_context", "find_hardcoded_credentials_in_config", "find_hardcoded_ports", "find_dangling_promises", "find_insecure_random_usage", "find_unbounded_recursion", "find_open_redirect_risks", "find_blocking_child_process_calls", "find_missing_json_response_content_type", "find_unhandled_express_error_middleware", "find_promise_all_without_catch", "find_unbounded_object_growth", "find_missing_null_checks_after_regex_exec", "find_regex_denial_of_service_in_route_params", "check_dockerignore_coverage", "check_test_flakiness_risk", "check_missing_csp_header", "find_missing_sort_comparator", "find_req_body_mass_assignment", "find_prototype_pollution_risk", "check_missing_rate_limit", "check_dependency_confusion_risk", "find_error_message_leaking_internals", "find_disabled_tls_verification", "find_unpinned_docker_base_image", "check_missing_helmet_security_headers", "check_missing_rate_limit_headers", "find_duplicate_route_registrations", "find_missing_pagination_limit", "find_missing_error_boundary_in_async_route", "find_missing_websocket_error_handler", "find_unbounded_array_push_in_loop", "find_env_var_default_fallback_masking_errors", "find_hardcoded_localhost_urls", "find_json_parse_without_try_catch", "find_missing_findindex_check", "find_missing_null_check_on_optional_chaining_default", "find_missing_cleanup_on_early_return", "find_inconsistent_error_response_shape", "find_hardcoded_jwt_secret", "check_insecure_cookie_flags", "summarize_package_scripts", "check_missing_engines_field", "find_missing_shebang_in_bin_scripts", "find_missing_return_after_res_send", "check_docker_compose_issues", "find_missing_stream_error_handler", "find_setinterval_without_clear", "find_async_callback_in_foreach", "find_missing_img_alt_text", "find_missing_form_label", "find_missing_button_accessible_name", "find_duplicate_html_id", "find_positive_tabindex", "find_missing_rel_noopener", "find_missing_remove_event_listener", "find_inline_event_handlers", "dir_size_stats", "disk_usage_summary", "csv_query", "csv_diff", "http_fetch", "port_check", "wait_for_port", "port_scan_range", "dns_lookup",
                "write_file", "write_files", "create_file", "create_files",
                "delete_file", "delete_files", "move_file", "copy_file", "move_directory", "copy_directory",
                "create_directory", "delete_directory", "replace_in_file",
                "truncate_file", "append_file",

                "base64_decode", "json_format", "text_transform",
                "json_patch", "apply_patch", "unzip_archive", "extract_tar", "yaml_patch", "yaml_merge", "json_merge", "convert_data", "csv_convert", "http_download", "json_path_set",
                "gzip_compress", "gzip_decompress", "brotli_compress", "brotli_decompress",
                "md_to_docx", "docx_to_md", "md_to_pdf", "pdf_to_md", "docx_to_pdf", "pdf_to_docx",
                "run_command", "start_process", "get_process_output",
                "kill_process", "list_processes", "run_npm_script",
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
                "sqlite_create", "sqlite_connect", "sqlite_execute", "sqlite_disconnect", "sqlite_connections", "sqlite_tables",
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
