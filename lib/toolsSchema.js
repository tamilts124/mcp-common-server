"use strict";
// ── TOOL JSON-SCHEMA DEFINITIONS — thin aggregator ─────────────────────────────
// Individual schema groups live under lib/schemas/ to keep every file under
// the project's 500-line threshold. This file just concatenates them in the
// same order they used to appear in the monolithic version of this file.

const { CORE_READ_SCHEMAS } = require("./schemas/coreSchemas");
const { GIT_SCHEMAS }       = require("./schemas/gitSchemas");
const { UTIL_SCHEMAS }      = require("./schemas/utilSchemas");
const { WRITE_SCHEMAS }     = require("./schemas/writeSchemas");
const { EXEC_SCHEMAS }      = require("./schemas/execSchemas");
const { BROWSER_SCHEMAS }   = require("./schemas/browserSchemas");

const TOOLS_ALL = [
  ...CORE_READ_SCHEMAS,
  ...GIT_SCHEMAS,
  ...UTIL_SCHEMAS,
  ...WRITE_SCHEMAS,
  ...EXEC_SCHEMAS,
  ...BROWSER_SCHEMAS,
];

// Tool category sets
const WRITE_TOOLS = new Set([
  "write_file", "write_files", "create_file", "create_files",
  "delete_file", "delete_files", "move_file", "copy_file",
  "move_directory", "copy_directory",
  "create_directory", "delete_directory", "replace_in_file",
  "truncate_file", "append_file",
  "base64_decode", "json_format", "text_transform",
  "json_patch", "apply_patch", "unzip_archive", "yaml_patch", "yaml_merge", "convert_data", "csv_convert",
  // zip_directory's schema lives in UTIL_SCHEMAS and its handler in
  // dispatchRead.js (grouped with the other utility tools), but it writes a
  // real .zip file to disk (mkdirSync + fs.writeFileSync in zipDirectory()),
  // so it must still be gated here -- dispatch file/schema-group location is
  // unrelated to write-gating, only membership in this Set is.
  "zip_directory",
]);

const EXEC_TOOLS = new Set([
  "run_command", "execute_pipeline",
  "start_process", "get_process_output", "kill_process", "list_processes",
  // Browser tools spawn a real Chromium process, same trust tier as exec.
  "browser_launch", "browser_navigate", "browser_get_content", "browser_evaluate",
  "browser_click", "browser_type", "browser_screenshot", "browser_get_console_logs",
  "browser_list_sessions", "browser_close",
  "browser_wait_for_selector", "browser_go_back", "browser_go_forward", "browser_reload",
  "browser_get_cookies", "browser_set_cookies", "browser_pdf", "browser_select_option", "browser_press_key",
  "browser_wait_for_navigation", "browser_hover", "browser_upload_file",
  "browser_scroll", "browser_double_click", "browser_right_click", "browser_drag_and_drop", "browser_download",
  "browser_get_attribute", "browser_is_visible", "browser_is_checked", "browser_check", "browser_uncheck",
  "browser_get_element_info",
  "browser_new_page", "browser_switch_page", "browser_list_pages", "browser_close_page",
  "browser_network_start", "browser_network_stop", "browser_get_network_requests",
  "browser_route", "browser_unroute",
  "browser_emulate",
  "browser_set_extra_headers", "browser_get_local_storage", "browser_set_local_storage",
]);

module.exports = { TOOLS_ALL, WRITE_TOOLS, EXEC_TOOLS };
