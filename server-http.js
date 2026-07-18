#!/usr/bin/env node

/**
 * MCP File Server — HTTP + SSE Transport  v3.1.0
 * For Claude Web (claude.ai) via ngrok or any public HTTPS URL
 * Zero npm dependencies — pure Node.js built-ins only
 *
 * ── Quick start ───────────────────────────────────────────────────────────────
 *
 *   # All tools (default — no --tools flag)
 *   node server-http.js
 *
 *   # Single root, no auth, no exec
 *   MCP_ROOT_DIR=D:/myproject node server-http.js
 *
 *   # Multiple roots
 *   MCP_ROOTS=D:/proj1,D:/proj2 node server-http.js
 *
 *   # With auth token
 *   MCP_AUTH_TOKEN=mysecret MCP_ROOTS=D:/proj1,D:/proj2 node server-http.js
 *
 *   # With shell command execution enabled
 *   MCP_ALLOW_EXEC=true MCP_ROOT_DIR=D:/myproject node server-http.js
 *
 *   # Load only specific categories (by category name)
 *   node server-http.js --category=read_file_system,git,code_analysis_audit
 *
 *   # Load specific individual tools (by tool name)
 *   node server-http.js --tools=read_file,write_file,git_log,git_status
 *
 *   # Combine both: categories + extra individual tools
 *   node server-http.js --category=git --tools=read_file,write_file
 *
 *   # Show help and all available categories/tools
 *   node server-http.js --help
 *
 *   # Or just put everything in a .env file next to this script and run:
 *   node server-http.js
 *
 * ── All environment variables ─────────────────────────────────────────────────
 *
 *   PORT              HTTP port (default: 3000)
 *   MCP_ROOT_DIR      Single root directory (backwards compat)
 *   MCP_ROOTS         Comma-separated list of root directories
 *   MCP_AUTH_TOKEN    Bearer token for auth. Omit = open access (default)
 *   MCP_READ_ONLY     true = disable all write/delete/exec tools (default: false)
 *   MCP_ALLOW_EXEC    true = enable run_command, execute_pipeline, start_process,
 *                     get_process_output, kill_process exec steps
 *                     (default: false — exec tools hidden from tools/list)
 *   MCP_CMD_TIMEOUT   Max seconds a run_command may run (default: 60)
 *   MCP_IGNORE        Comma-separated dir/file names to skip in listings
 *                     (default: node_modules,.git,__pycache__,.nyc_output,dist,build)
 *
 * Implementation is split across lib/:\n *   lib/config.js       — .env loading + env var config
 *   lib/roots.js         — multi-root setup, path jailing, ignore patterns
 *   lib/fileOps.js       — file/dir read/write/search/find/replace helpers
 *   lib/processOps.js    — run_command / background process management
 *   lib/toolsSchema.js   — JSON-RPC tool schema declarations
 *   lib/executeTool.js   — tool dispatch + execute_pipeline
 */

const http   = require("http");
const crypto = require("crypto");

// ── TOOL CATEGORY MAP ─────────────────────────────────────────────────────────
// Maps CLI flag names → canonical category keys → tool name sets
// Derived directly from README.md categories (484 tools across 10 categories)

const CATEGORY_TOOLS = {
  read_file_system: new Set([
    "read_directory","read_file","read_files","read_allfiles","file_info",
    "search_files","search_lines","search_in_document","file_checksum",
    "checksum_verify","hash_string","regex_test","env_info","system_resources",
    "which_command","compare_directories","file_diff_dir","count_lines",
    "file_tree","hash_directory","base64_encode","text_transform","file_stats",
    "dir_size_stats","disk_usage_summary","dir_diff_summary","image_ops",
    "pdf_rich_extract","pdf_to_md","docx_to_md","docx_to_pdf","dotenv_client",
    "toml_client","yaml_client","ini_client","xml_client","markdown_client",
    "csv_client","jsonl_client","zip_client","tar_client","json_client",
    "excel_client","pdf_client","msgpack_client","cbor_client","protobuf_client",
    "jsonrpc_client","avro_client","thrift_client","parquet_client","orc_client",
    "arrow_client","hdf5_client","pcap_client","ical_client","sqlite_client",
    "log_client","geo_client","font_client","epub_client","audio_client",
    "video_client","image_client","3d_client","wasm_client","ssh_keygen",
    "registry_client","k8s_client","prometheus_client","elasticsearch_client",
    "mongodb_client","cassandra_client","influxdb_client","ntp_client",
    "syslog_client","clickhouse_client","semver_compare","url_parse",
    "json_flatten","uuid_generate","diff_strings","base62_encode","base62_decode",
    "markdown_to_html","xml_parse","string_transform","ip_cidr","color_convert",
    "number_format","date_calc","text_extract","str_similarity","cron_next",
  ]),

  write_edit: new Set([
    "write_file","write_files","create_file","create_files","replace_in_file",
    "truncate_file","append_file","base64_decode","delete_file","delete_files",
    "move_file","copy_file","move_directory","copy_directory","create_directory",
    "delete_directory","gzip_compress","brotli_compress","md_to_docx","md_to_pdf",
    "pdf_to_docx","json_path_set",
  ]),

  git: new Set([
    "git_write_ops","find_stale_branches","check_branch_protection_hints",
    "git_hooks_audit","git_status","git_log","git_blame","git_diff",
    "git_stash_list","git_branch_list","git_worktree_list",
    "git_worktree_prune_candidates","git_commit_message_lint",
    "check_gitignore_coverage","git_diff_summary","git_show","git_tag_list",
    "git_reflog","git_dangling_commits","git_object_count","git_untracked_size",
    "git_cherry","git_contributors_summary","find_recent_force_pushes",
    "check_stash_apply_risk","git_blame_ownership_diff","git_tag_annotate_audit",
    "suggest_next_version","check_commit_signatures","git_commit_frequency",
    "git_orphaned_branches","git_submodule_status","git_ownership",
    "git_blame_hotspots","git_file_age","find_todo_owners","find_stale_todos",
    "generate_pr_description","find_large_git_objects",
    "check_dotenv_files_not_gitignored","check_lfs_coverage","merge_conflict_risk",
  ]),

  code_analysis_audit: new Set([
    "find_files","check_binary_file","find_duplicates","scan_todos",
    "scan_conflict_markers","find_binary_diffs","find_circular_deps",
    "find_dead_exports","find_unused_dependencies","find_console_logs",
    "find_duplicate_dependencies","readme_link_check","find_env_var_usage",
    "check_npm_audit_cache","find_unreachable_modules","find_orphaned_test_files",
    "check_test_coverage_gaps","check_line_endings","find_large_files",
    "find_empty_dirs","package_json_audit","check_package_lock_sync",
    "scan_dockerfile_issues","scan_dependency_licenses",
    "find_case_sensitive_import_mismatches","find_duplicate_yaml_keys",
    "find_unsafe_regex","scan_npm_lifecycle_scripts",
    "check_semver_range_strictness","find_empty_catch_blocks",
    "find_sync_fs_in_async_context","find_dangling_promises",
    "find_unbounded_recursion","find_unbounded_object_growth",
    "find_regex_denial_of_service_in_route_params","check_test_flakiness_risk",
    "find_unbounded_array_push_in_loop",
    "find_env_var_default_fallback_masking_errors",
    "find_promise_all_without_catch","find_blocking_child_process_calls",
    "find_unhandled_express_error_middleware","check_dockerignore_coverage",
    "find_json_parse_without_try_catch","find_inconsistent_error_response_shape",
    "summarize_package_scripts","check_docker_compose_issues",
    "find_setinterval_without_clear","find_async_callback_in_foreach",
    "find_duplicate_html_id","find_positive_tabindex","find_duplicate_json_keys",
    "find_inline_event_handlers","find_missing_viewport_meta",
    "find_missing_lang_attribute","find_missing_meta_charset",
    "find_missing_aria_role","find_hardcoded_color_literals","find_missing_doctype",
    "find_unused_css_variables","find_magic_numbers","find_long_functions",
    "find_deprecated_html_elements","find_eval_usage","find_missing_error_context",
    "find_promise_race_without_timeout","find_missing_try_catch_in_async",
    "find_unhandled_rejection_patterns","find_memory_leak_patterns",
    "find_circular_reference_risks","find_promise_constructor_antipattern",
    "find_event_emitter_leak","find_sql_injection_risk",
    "find_command_injection_risk","find_xss_risk","find_path_traversal_risk",
    "find_insecure_deserialization","find_prototype_pollution_via_merge",
    "find_timing_attack_risk","find_missing_input_validation",
  ]),

  security_scanning: new Set([
    "scan_secrets","find_hardcoded_ips","find_missing_await","scan_cors_misconfig",
    "scan_dangerous_code_patterns","find_unpinned_github_actions",
    "find_hardcoded_credentials_in_config","find_hardcoded_ports",
    "find_insecure_random_usage","find_missing_null_checks_after_regex_exec",
    "check_missing_csp_header","find_missing_sort_comparator",
    "find_req_body_mass_assignment","find_prototype_pollution_risk",
    "check_missing_rate_limit","check_dependency_confusion_risk",
    "find_error_message_leaking_internals","find_disabled_tls_verification",
    "find_unpinned_docker_base_image","check_missing_helmet_security_headers",
    "check_missing_rate_limit_headers","find_duplicate_route_registrations",
    "find_missing_pagination_limit","find_missing_error_boundary_in_async_route",
    "find_missing_websocket_error_handler","find_hardcoded_localhost_urls",
    "find_open_redirect_risks","find_unvalidated_redirect","find_race_condition_risk",
    "find_missing_json_response_content_type","find_missing_findindex_check",
    "find_missing_null_check_on_optional_chaining_default",
    "find_missing_cleanup_on_early_return","find_hardcoded_jwt_secret",
    "check_insecure_cookie_flags","check_missing_engines_field",
    "find_missing_shebang_in_bin_scripts","find_missing_return_after_res_send",
    "find_missing_stream_error_handler","find_missing_img_alt_text",
    "find_missing_form_label","find_missing_button_accessible_name",
    "find_missing_rel_noopener","find_missing_remove_event_listener",
    "jwt_decode","jwt_sign","jwt_verify","crypto_encrypt","crypto_decrypt",
    "hmac_sign","hmac_verify","totp_generate","totp_verify","password_generate",
    "key_generate","oauth2_token","tls_cert_inspect",
  ]),

  browser_automation: new Set([
    "browser_launch","browser_navigate","browser_get_content","browser_get_title",
    "browser_evaluate","browser_click","browser_type","browser_screenshot",
    "browser_get_console_logs","browser_list_sessions","browser_close",
    "browser_wait_for_navigation","browser_hover","browser_upload_file",
    "browser_drag_and_drop","browser_download","browser_get_attribute",
    "browser_is_checked","browser_uncheck","browser_get_element_info",
    "browser_close_page","browser_emulate","browser_set_viewport",
    "browser_set_extra_headers","browser_set_local_storage",
    "browser_add_init_script","browser_get_page_metrics",
    "browser_get_exposed_calls","browser_wait_for_response",
    "browser_get_storage_state","browser_storage_state_save",
    "browser_accessibility_snapshot","browser_find_by_role",
    "browser_wait_for_dialog","browser_frame_evaluate","browser_replay_actions",
    "browser_new_page","browser_switch_page","browser_list_pages",
    "browser_start_recording","browser_stop_recording","browser_get_recording",
    "browser_clear_recording","browser_select_option","browser_press_key",
    "browser_scroll","browser_double_click","browser_right_click","browser_check",
    "browser_wait_for_selector","browser_get_current_url","browser_go_back",
    "browser_go_forward","browser_reload","browser_pdf","browser_is_visible",
    "browser_expose_function","browser_get_cookies","browser_set_cookies",
    "browser_network_start","browser_network_stop","browser_get_network_requests",
    "browser_route","browser_unroute","browser_get_local_storage",
    "browser_handle_next_dialog","browser_get_dialog_log","browser_list_frames",
    "browser_frame_click","browser_frame_type","browser_frame_get_content",
  ]),

  network_messaging: new Set([
    "http_fetch","http_download","port_check","wait_for_port","port_scan_range",
    "dns_lookup","websocket_client","sse_client","smtp_client","redis_client",
    "mqtt_client","imap_client","snmp_client","ftp_client","kafka_client",
    "amqp_client","stomp_client","ldap_client","nats_client","memcached_client",
    "grpc_client","http_client","graphql_client","tcp_client","udp_client",
    "ssh_exec","http_multi_fetch","multipart_upload","http_serve","modbus_client",
    "coap_client","whois_client","tls_client","dns_client","irc_client",
    "tftp_client","rtsp_client","sip_client","xmpp_client","radius_client",
    "diameter_client","pop3_client","nntp_client","zookeeper_client","etcd_client",
    "consul_client","vault_client","aws_client","gcp_client","azure_client",
    "terraform_client","github_client","gitlab_client","bitbucket_client",
    "jira_client","confluence_client","slack_client","teams_client","notion_client",
    "discord_client","linear_client","zendesk_client","pagerduty_client",
    "twilio_client","stripe_client","sendgrid_client","mailchimp_client",
    "hubspot_client","salesforce_client","shopify_client","woocommerce_client",
    "airtable_client",
  ]),

  data_format_utilities: new Set([
    "json_schema_validate","env_diff","zip_directory","create_tar","read_archive",
    "query_json","query_data","diff_files","query_path","json_patch_generate",
    "json_diff","json_format","json_patch","apply_patch","unzip_archive",
    "extract_tar","yaml_patch","yaml_merge","json_merge","convert_data",
    "csv_convert","gzip_decompress","brotli_decompress","csv_diff",
    "json_schema_generate","csv_query","json_unflatten","template_render",
    "table_ops","graphql_query","jsonl_ops",
  ]),

  execution_process: new Set([
    "run_command","start_process","get_process_output","kill_process",
    "list_processes","run_npm_script","execute_pipeline","send_process_input",
  ]),

  email_database: new Set([
    "email_list_mailboxes","email_send","email_search","sqlite_create",
    "sqlite_connect","sqlite_execute","sqlite_disconnect","sqlite_connections",
    "sqlite_tables",
  ]),
};

// Human-readable labels for --help output
const CATEGORY_LABELS = {
  read_file_system:     "Read & File System    (94 tools)",
  write_edit:           "Write & Edit          (22 tools)",
  git:                  "Git                   (42 tools)",
  code_analysis_audit:  "Code Analysis & Audit (79 tools)",
  security_scanning:    "Security Scanning     (57 tools)",
  browser_automation:   "Browser Automation    (71 tools)",
  network_messaging:    "Network & Messaging   (71 tools)",
  data_format_utilities:"Data & Format Utilities (31 tools)",
  execution_process:    "Execution & Process    (8 tools)",
  email_database:       "Email & Database       (9 tools)",
};

// ── --help ─────────────────────���──────────────────────────────────────────────
function printHelp() {
  console.log(`
MCP Common Server v3.1.0 — HTTP + SSE Transport
Zero-dependency Node.js MCP server with 484 tools across 10 categories.

USAGE:
  node server-http.js [--tools=<categories>] [--help]

OPTIONS:
  --tools=<cat1,cat2,...>   Load only the specified tool categories (comma-separated).
                            Default: all categories are loaded.
  --help                    Show this help message and exit.

ENVIRONMENT VARIABLES:
  PORT              HTTP port (default: 3000)
  MCP_ROOT_DIR      Single root directory
  MCP_ROOTS         Comma-separated list of root directories
  MCP_AUTH_TOKEN    Bearer token for auth (default: open access)
  MCP_READ_ONLY     true = disable all write/delete/exec tools (default: false)
  MCP_ALLOW_EXEC    true = enable shell execution tools (default: false)
  MCP_CMD_TIMEOUT   Max seconds for run_command (default: 60)
  MCP_IGNORE        Comma-separated names to skip in directory listings

AVAILABLE CATEGORIES:
  (use the key name with --category=)

  Key                     Description
  ─────────────────────── ────────────────────────────────────────────
  read_file_system        ${CATEGORY_LABELS.read_file_system}
  write_edit              ${CATEGORY_LABELS.write_edit}
  git                     ${CATEGORY_LABELS.git}
  code_analysis_audit     ${CATEGORY_LABELS.code_analysis_audit}
  security_scanning       ${CATEGORY_LABELS.security_scanning}
  browser_automation      ${CATEGORY_LABELS.browser_automation}
  network_messaging       ${CATEGORY_LABELS.network_messaging}
  data_format_utilities   ${CATEGORY_LABELS.data_format_utilities}
  execution_process       ${CATEGORY_LABELS.execution_process}
  email_database          ${CATEGORY_LABELS.email_database}

EXAMPLES:
  # Start with all 484 tools (default)
  node server-http.js

  # Load categories by name
  node server-http.js --category=read_file_system,git

  # Load specific individual tools by name
  node server-http.js --tools=read_file,write_file,git_log,git_status,git_diff

  # Mix: a whole category + a few extra individual tools
  node server-http.js --category=git --tools=read_file,write_file

  # Full suite with auth + exec enabled
  MCP_AUTH_TOKEN=secret MCP_ALLOW_EXEC=true node server-http.js --category=read_file_system,write_edit,git,code_analysis_audit,security_scanning,browser_automation,network_messaging,data_format_utilities,execution_process,email_database

TOOL LISTING PER CATEGORY:
`);

  for (const [key, tools] of Object.entries(CATEGORY_TOOLS)) {
    const names = [...tools].join(", ");
    console.log(`  ▸ ${key} (${tools.size})`);
    // Print tools wrapped at ~100 chars
    let line = "    ";
    for (const t of tools) {
      if (line.length + t.length + 2 > 100) { console.log(line); line = "    "; }
      line += t + ", ";
    }
    if (line.trim().length > 0) console.log(line.replace(/,\s*$/, ""));
    console.log();
  }

  process.exit(0);
}

// ── PARSE CLI ARGS ────────────────────────────────────────────────────────────
// --category=cat1,cat2   → load all tools from those categories
// --tools=tool1,tool2    → load specific individual tools by name
// Both can be combined; the union is used.
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
  }

  // ── --category= ──────────────────────────────────────────────────────────
  const categoryArg = args.find(a => a.startsWith("--category="));
  let selectedCategories = null;
  if (categoryArg) {
    const raw = categoryArg.slice("--category=".length).trim();
    if (!raw) {
      console.error("Error: --category= requires a value. Use --help to see categories.");
      process.exit(1);
    }
    selectedCategories = raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const unknown = selectedCategories.filter(k => !CATEGORY_TOOLS[k]);
    if (unknown.length > 0) {
      console.error(`Error: Unknown categor${unknown.length > 1 ? "ies" : "y"}: ${unknown.join(", ")}`);
      console.error(`Run 'node server-http.js --help' to see valid category names.`);
      process.exit(1);
    }
  }

  // ── --tools= ──────────────────────────────────────────────────────────────
  const toolsArg = args.find(a => a.startsWith("--tools="));
  let selectedTools = null;
  if (toolsArg) {
    const raw = toolsArg.slice("--tools=".length).trim();
    if (!raw) {
      console.error("Error: --tools= requires a value. Use --help to see tool names.");
      process.exit(1);
    }
    selectedTools = raw.split(",").map(s => s.trim()).filter(Boolean);
    // Validate against the full known tool set
    const allKnownTools = new Set(Object.values(CATEGORY_TOOLS).flatMap(s => [...s]));
    const unknown = selectedTools.filter(t => !allKnownTools.has(t));
    if (unknown.length > 0) {
      console.error(`Error: Unknown tool${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
      console.error(`Run 'node server-http.js --help' to see all tool names.`);
      process.exit(1);
    }
  }

  return { selectedCategories, selectedTools };
}

// ── RESOLVE ACTIVE TOOL SET ───────────────────────────────────────────────────
// --category expands to all tools in those categories.
// --tools adds specific tool names.
// Union of both; if neither → null (all tools).
function resolveAllowedTools(selectedCategories, selectedTools) {
  if (!selectedCategories && !selectedTools) return null; // all tools
  const allowed = new Set();
  if (selectedCategories) {
    for (const cat of selectedCategories)
      for (const name of CATEGORY_TOOLS[cat]) allowed.add(name);
  }
  if (selectedTools) {
    for (const name of selectedTools) allowed.add(name);
  }
  return allowed;
}

const { selectedCategories, selectedTools } = parseArgs();
const ALLOWED_TOOLS = resolveAllowedTools(selectedCategories, selectedTools);

// ── LOAD CORE MODULES ─────────────────────────────────────────────────────────
const { PORT, AUTH_TOKEN, READ_ONLY, ALLOW_EXEC, CMD_TIMEOUT, IGNORE_PATTERNS } = require("./lib/config");
const { ROOTS, buildRoots } = require("./lib/roots");
const { TOOLS: ALL_TOOLS, executeTool, getErrorCode } = require("./lib/executeTool");
const { installCrashGuard } = require("./lib/crashGuard");
const { serializeResult, formatError } = require("./lib/safeSerialize");

installCrashGuard();
buildRoots();

// Apply category filter on top of the existing exec/read-only filter from executeTool.js
const TOOLS = ALLOWED_TOOLS
  ? ALL_TOOLS.filter(t => ALLOWED_TOOLS.has(t.name))
  : ALL_TOOLS;

// ── STARTUP BANNER ─────────────────────────────────────────────────────────────
console.log(`MCP Common Server (HTTP+SSE) v3.1.0`);
console.log(`Roots:`);
for (const [alias, abs] of ROOTS) console.log(`  [${alias}] ${abs}`);
console.log(`Auth      : ${AUTH_TOKEN ? "enabled (token set)" : "disabled (open)"}`);
console.log(`ReadOnly  : ${READ_ONLY}`);
console.log(`Exec      : ${ALLOW_EXEC ? `enabled (timeout: ${CMD_TIMEOUT}s)` : "disabled"}`);
console.log(`Ignore    : ${IGNORE_PATTERNS.join(", ")}`);
console.log(`Port      : ${PORT}`);
if (selectedCategories) console.log(`Category  : ${selectedCategories.join(", ")}`);
else if (!selectedTools)  console.log(`Category  : all (${Object.keys(CATEGORY_TOOLS).length})`);
if (selectedTools)        console.log(`Tools +   : ${selectedTools.join(", ")}`);
console.log(`Tools     : ${TOOLS.length} active`);
console.log("---");

// ── AUTH ──────────────────────────────────────────────────────────────────────
function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers["authorization"] || "";
  return header === `Bearer ${AUTH_TOKEN}`;
}

// ── SSE SESSION STORE ─────────────────────────────────────────────────────────
const sessions = new Map(); // sessionId → { res, lastSeen }

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      console.log(`[SSE] Pruning stale session: ${id}`);
      sessions.delete(id);
    }
  }
}, 60_000);

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (!checkAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized — invalid or missing Bearer token" }));
    return;
  }

  // ── GET /sse ───────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/sse") {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
    sessions.set(sessionId, { res, lastSeen: Date.now() });
    console.log(`[SSE] Client connected: ${sessionId}`);

    const keepalive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); }
    }, 20_000);

    req.on("close", () => {
      clearInterval(keepalive);
      sessions.delete(sessionId);
      console.log(`[SSE] Client disconnected: ${sessionId}`);
    });
    return;
  }

  // ── POST /message ──────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/message") {
    const sessionId = url.searchParams.get("sessionId");
    const session   = sessions.get(sessionId);
    if (session) session.lastSeen = Date.now();

    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400); res.end("Bad JSON"); return;
      }

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      const respond = (payload) => {
        if (!session) return;
        session.res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const { id, method, params } = msg;

      if (method === "initialize") {
        return respond({ jsonrpc: "2.0", id, result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-common-server", version: "3.1.0" },
        }});
      }
      if (method === "notifications/initialized") return;
      if (method === "ping") return respond({ jsonrpc: "2.0", id, result: {} });

      if (method === "tools/list")
        return respond({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

      if (method === "tools/call") {
        const { name, arguments: args } = params;
        Promise.resolve()
          .then(() => executeTool(name, args || {}))
          .then((result) => {
            const label = args?.path || args?.command || args?.id ||
              (args?.files?.length ? `(${args.files.length} files)` : "") ||
              (args?.steps?.length ? `(${args.steps.length} steps)` : "") || "";
            const { text, truncated, originalBytes } = serializeResult(result);
            if (truncated) {
              console.error(`[TOOL] ${name} ${label} — response truncated (${originalBytes} bytes > 3.5 MB limit)`);
            } else {
              console.log(`[TOOL] ${name}`, label);
            }
            respond({ jsonrpc: "2.0", id, result: {
              content: [{ type: "text", text }],
            }});
          })
          .catch((e) => {
            const code = getErrorCode(e);
            const detail = formatError(e, name);
            console.error(`[TOOL ERROR] ${detail}`);
            respond({ jsonrpc: "2.0", id,
              error: { code, message: e.message, data: { tool: name, stack: e.stack || null } },
              result: {
                content: [{ type: "text", text: detail }],
                isError: true,
              },
            });
          });
        return;
      }

      if (id !== undefined)
        respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    });
    return;
  }

  // ── GET / — Health check ───────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:      "ok",
      server:      "mcp-common-server",
      version:     "3.1.0",
      readOnly:    READ_ONLY,
      auth:        !!AUTH_TOKEN,
      execEnabled: ALLOW_EXEC,
      roots:       Object.fromEntries(ROOTS),
      categories:  selectedCategories || Object.keys(CATEGORY_TOOLS),
      extraTools:  selectedTools || [],
      tools:       TOOLS.map(t => t.name),
      toolCount:   TOOLS.length,
    }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`   SSE endpoint : http://localhost:${PORT}/sse`);
  console.log(`   Health check : http://localhost:${PORT}/`);
  console.log(`\nNow run: ngrok http ${PORT}`);
  console.log(`Then add https://xxxx.ngrok-free.app/sse to Claude Web integrations\n`);
});
