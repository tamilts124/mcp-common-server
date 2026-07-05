"use strict";
// ── FIND_BLOCKING_CHILD_PROCESS_CALLS — flag execSync/spawnSync/execFileSync ─
// Distinct from find_sync_fs_in_async_context (which only flags sync calls
// found textually inside an `async function` span). A blocking child_process
// call freezes the entire single-threaded event loop for its full duration
// regardless of whether its containing function happens to be declared
// `async` — a plain synchronous Express route handler that shells out with
// execSync() blocks every other in-flight request just as badly. This tool
// scans for execSync/spawnSync/execFileSync calls anywhere in the file (not
// gated on an async span) and additionally flags — at higher severity — any
// call whose nearest preceding handler-signature hint (`(req, res` or an
// `app.get/post/put/delete/patch/all(`/`router.<verb>(` route registration)
// appears within a lookback window, since that's the case most likely to
// stall live request traffic rather than a one-off CLI/build script.
//
// Pure text-scan (regex + fixed line lookback), not an AST/scope parser:
//   - the handler-signature lookback is a fixed line window, not a real
//     brace-scoped enclosing-function search, so a call just past the end
//     of an unrelated earlier handler can be misclassified as "in a
//     handler" — documented as an accepted heuristic tradeoff, same
//     category as find_sync_fs_in_async_context's span caveats.
//   - `child_process.execSync(...)` (fully-qualified, no destructured
//     import) is also matched.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const LOOKBACK_LINES = 40;

const SYNC_CALL_RE = /\b(?:child_process\s*\.\s*)?(execSync|execFileSync|spawnSync)\s*\(/;
const HANDLER_HINT_RE = /\(\s*req\s*,\s*res\b|\b(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|all|use)\s*\(/;

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

function nearHandlerSignature(lines, lineIdx) {
  const start = Math.max(0, lineIdx - LOOKBACK_LINES);
  for (let i = lineIdx; i >= start; i--) {
    if (HANDLER_HINT_RE.test(lines[i])) return true;
  }
  return false;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function findBlockingChildProcessCalls(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_blocking_child_process_calls: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_blocking_child_process_calls: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_blocking_child_process_calls: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

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
      const m = SYNC_CALL_RE.exec(lines[i]);
      if (!m) continue;
      const inHandler = nearHandlerSignature(lines, i);
      findings.push({
        file: rel,
        line: i + 1,
        call: m[1],
        severity: inHandler ? "error" : "warning",
        rule: inHandler ? "blocking_call_in_request_handler" : "blocking_child_process_call",
        message: inHandler
          ? `${m[1]}() called near a request-handler signature — blocks the event loop for every in-flight request, not just this one.`
          : `${m[1]}() blocks the event loop for its full duration; prefer the async child_process API (exec/execFile/spawn) unless this is a one-off startup/CLI script.`,
      });
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

module.exports = { findBlockingChildProcessCalls };
