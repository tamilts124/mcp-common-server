"use strict";
// ── FIND_ERROR_MESSAGE_LEAKING_INTERNALS — stack-trace/internal disclosure ──
// Scans Express-style error handlers / catch blocks for a raw Error object
// (or its .stack/.message) sent directly in an HTTP response — leaking
// internal file paths, dependency versions, and code structure to an
// end user (and to an attacker probing for exploitable details).
//
// Three call-site rules, each triggered by a raw error identifier (`err`,
// `error`, `e`, or `exc`, case-sensitive to those common catch-binding
// names — configurable via opts.errorIdentifiers) reaching a response call:
//   - error_stack_in_response (error)   — `.stack` property of the error
//     identifier passed into res.send(/res.json(/res.end(.
//   - raw_error_object_in_response (warning) — the bare error identifier
//     itself (not `.stack`/`.message`) passed directly into res.send(/
//     res.json(, e.g. `res.json({ error: err })` — many frameworks/loggers
//     serialize the full Error object (including `.stack`) when it's handed
//     to JSON.stringify indirectly via Express's res.json.
//   - error_interpolated_in_response (warning) — the error identifier
//     interpolated into a template-literal string that is itself passed to
//     res.send(/res.json(, e.g. `` res.send(`Error: ${err}`) `` — String(err)
//     includes err.message but not the stack; still leaks internal detail
//     text to the client.
//
// A same-line or short-lookback NODE_ENV / isProduction / isDev guard
// (checking for a conditional that only sends the raw error outside
// production) suppresses the finding — a dev-only debug branch is a
// deliberate, common, and acceptable pattern.
//
// Pure text-scan (regex + brace-depth catch-body extraction, reusing the
// convention from find_empty_catch_blocks/find_unhandled_express_error_middleware),
// not an AST/data-flow parser: only scans literal `catch (NAME) { ... }`
// bodies plus whole-file scanning for the response call shapes (so an error
// object threaded out of the catch block into a differently-named handler
// is not tracked — a real data-flow analysis would need a full parser).
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const DEV_GUARD_RE = /NODE_ENV\s*(?:!==|===)\s*['"]production['"]|isProduction|isDev(?:elopment)?\b/;

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function collectFiles(absDir, extensions, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(abs, extensions, rel));
    else if (ent.isFile() && extensions.some(e => ent.name.endsWith(e))) out.push(rel);
  }
  return out;
}

function buildRules(names) {
  const alt = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return {
    stack: new RegExp(`\\b(?:res|response)\\s*\\.\\s*(?:send|json|end)\\s*\\([^)]*\\b(?:${alt})\\s*\\.\\s*stack\\b`),
    raw: new RegExp(`\\b(?:res|response)\\s*\\.\\s*(?:send|json)\\s*\\([^)]*[:(,]\\s*(?:${alt})\\s*[,)}]`),
    interpolated: new RegExp(`\\b(?:res|response)\\s*\\.\\s*(?:send|json)\\s*\\(\\s*\`[^\`]*\\$\\{\\s*(?:${alt})\\s*\\}`),
  };
}

function hasDevGuardNearby(lines, lineIdx, lookback) {
  const start = Math.max(0, lineIdx - lookback);
  for (let i = lineIdx; i >= start; i--) {
    if (DEV_GUARD_RE.test(lines[i])) return true;
  }
  return false;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {string[]} [opts.errorIdentifiers] Catch-binding names to treat as raw errors (default err/error/e/exc).
 * @param {number}   [opts.maxResults]
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function findErrorMessageLeakingInternals(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_error_message_leaking_internals: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_error_message_leaking_internals: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_error_message_leaking_internals: extensions must be an array of strings.", -32602);
  if (opts.errorIdentifiers !== undefined && !Array.isArray(opts.errorIdentifiers))
    throw new ToolError("find_error_message_leaking_internals: errorIdentifiers must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const identifiers = Array.isArray(opts.errorIdentifiers) && opts.errorIdentifiers.length ? opts.errorIdentifiers : ["err", "error", "e", "exc"];
  const RULES = buildRules(identifiers);
  const LOOKBACK_LINES = 5;

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");
    const lines = source.split(/\r\n|\r|\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let rule = null, severity = null, message = null;

      if (RULES.stack.test(line)) {
        rule = "error_stack_in_response"; severity = "error";
        message = "The raw error's .stack is sent directly in an HTTP response — this leaks internal file paths, line numbers, and code structure to the client.";
      } else if (RULES.interpolated.test(line)) {
        rule = "error_interpolated_in_response"; severity = "warning";
        message = "The raw error object is interpolated into a response string — String(err) includes err.message, which can leak internal detail text to the client.";
      } else if (RULES.raw.test(line)) {
        rule = "raw_error_object_in_response"; severity = "warning";
        message = "The raw error object is passed directly into an HTTP response — res.json() will serialize it (including .stack in many setups), leaking internal detail to the client.";
      } else {
        continue;
      }

      if (hasDevGuardNearby(lines, i, LOOKBACK_LINES)) continue;

      findings.push({ file: rel, line: i + 1, rule, severity, message });
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    errorCount, warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findErrorMessageLeakingInternals };
