"use strict";
// ── SCAN_NPM_LIFECYCLE_SCRIPTS — supply-chain risk audit for package.json scripts ─
// Real npm supply-chain attacks (e.g. compromised eslint-scope, ua-parser-js,
// event-stream) abuse install-time lifecycle hooks (preinstall/install/
// postinstall/prepare/etc.) that run automatically on `npm install` with no
// user confirmation. This scans every entry in package.json's "scripts"
// field for: (1) curl/wget output piped straight into a shell — arbitrary
// remote code execution; (2) a lifecycle hook that fetches remote content
// at all (curl/wget/http(s):// present) — even without an obvious pipe,
// since the hook can write+execute a file in two steps; (3) eval(...) usage;
// (4) destructive `rm -rf /` or `rm -rf ~`. Pure text/regex heuristic, not a
// shell parser — no variable expansion, no multi-command AST. Zero-dependency,
// read-only.
const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const LIFECYCLE_HOOKS = new Set([
  "preinstall", "install", "postinstall",
  "preuninstall", "uninstall", "postuninstall",
  "preversion", "version", "postversion",
  "prepare", "prepublishOnly",
]);

const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const CURL_PIPE_SHELL_RE = /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|node)\b/;
const REMOTE_FETCH_RE = /\b(curl|wget)\b|https?:\/\//;
const EVAL_RE = /\beval\s*\(/;
const DESTRUCTIVE_RM_RE = /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/|~)(?:\s|$|["'])/;

function classifyScript(name, command) {
  const issues = [];
  const isHook = LIFECYCLE_HOOKS.has(name);
  if (CURL_PIPE_SHELL_RE.test(command)) {
    issues.push({ rule: "curl_pipe_shell", severity: "error", message: `Script '${name}' pipes curl/wget output directly into a shell — arbitrary remote code execution.` });
  } else if (isHook && REMOTE_FETCH_RE.test(command)) {
    issues.push({ rule: "remote_fetch_in_lifecycle_hook", severity: "error", message: `Lifecycle hook '${name}' fetches remote content — runs automatically on npm install with no confirmation, a classic supply-chain vector.` });
  }
  if (EVAL_RE.test(command)) {
    issues.push({ rule: "eval_usage", severity: "warning", message: `Script '${name}' uses eval(...).` });
  }
  if (DESTRUCTIVE_RM_RE.test(command)) {
    issues.push({ rule: "destructive_rm", severity: "error", message: `Script '${name}' runs a destructive 'rm -rf' against root/home.` });
  }
  return issues;
}

/**
 * @param {string} absPath  Absolute, jail-validated path to package.json.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {number} [opts.maxResults]
 * @returns {{path, scriptsScanned, hookScriptsScanned, issueCount, errorCount, warningCount, truncated, issues, errors}}
 */
function scanNpmLifecycleScripts(absPath, origPath, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new ToolError(`scan_npm_lifecycle_scripts: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("scan_npm_lifecycle_scripts: max_results must be a number.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new ToolError(`scan_npm_lifecycle_scripts: malformed JSON in '${origPath}': ${e.message}`, -32602); }

  const scripts = (pkg && typeof pkg.scripts === "object" && pkg.scripts) || {};
  const errors = [];
  const allIssues = [];
  let scriptsScanned = 0;
  let hookScriptsScanned = 0;

  for (const [name, command] of Object.entries(scripts)) {
    scriptsScanned++;
    if (LIFECYCLE_HOOKS.has(name)) hookScriptsScanned++;
    if (typeof command !== "string") { errors.push({ script: name, error: "non-string script value" }); continue; }
    for (const issue of classifyScript(name, command)) {
      allIssues.push({ script: name, command, ...issue });
    }
  }

  allIssues.sort((a, b) => a.script.localeCompare(b.script));
  const truncated = allIssues.length > maxResults;

  return {
    path: origPath,
    scriptsScanned,
    hookScriptsScanned,
    issueCount: allIssues.length,
    errorCount: allIssues.filter(i => i.severity === "error").length,
    warningCount: allIssues.filter(i => i.severity === "warning").length,
    truncated,
    issues: allIssues.slice(0, maxResults),
    errors,
  };
}

module.exports = { scanNpmLifecycleScripts };
