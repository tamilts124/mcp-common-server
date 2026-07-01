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

const TOOLS_ALL = [
  ...CORE_READ_SCHEMAS,
  ...GIT_SCHEMAS,
  ...UTIL_SCHEMAS,
  ...WRITE_SCHEMAS,
  ...EXEC_SCHEMAS,
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
]);
const EXEC_TOOLS = new Set([
  "run_command", "execute_pipeline",
  "start_process", "get_process_output", "kill_process", "list_processes",
]);

module.exports = { TOOLS_ALL, WRITE_TOOLS, EXEC_TOOLS };
