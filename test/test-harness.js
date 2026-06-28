"use strict";
/**
 * Shared test harness for the isolated functional test suite.
 *
 * Sets up an isolated MCP_ROOTS temp directory, loads lib/ modules against
 * it, and exposes a minimal test()/counter API shared across all
 * test/sections/*.js files so the aggregate pass/fail count and exit code
 * stay correct no matter how the suite is split across files.
 *
 * Does NOT start the HTTP server or any MCP client — imports logic directly.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
process.env.MCP_CMD_TIMEOUT = "5";

const { buildRoots, resolveClientPath, ROOTS } = require("../lib/roots");
buildRoots();
const { executeTool, ToolError, validateArgs, getErrorCode } = require("../lib/executeTool");

const counters = { pass: 0, fail: 0 };

function test(name, fn) {
  try {
    fn();
    counters.pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    counters.fail++;
    console.log(`  FAIL - ${name}\n      ${e.message}`);
  }
}

/** Best-effort recursive delete with retries (Windows can transiently lock
 *  files right after a child process closes). */
function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (_) { try { require("child_process").execSync("ping -n 1 127.0.0.1 >NUL 2>&1"); } catch (__) {} }
  }
}

module.exports = {
  fs, os, path, assert,
  TMP, counters, test, cleanupDir,
  buildRoots, resolveClientPath, ROOTS,
  executeTool, ToolError, validateArgs, getErrorCode,
};
