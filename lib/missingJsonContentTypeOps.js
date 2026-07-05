"use strict";
// ── FIND_MISSING_JSON_RESPONSE_CONTENT_TYPE — send(JSON.stringify) footgun ──
// Express's res.send(obj) auto-sets Content-Type: application/json only when
// given an object/array directly. Pre-stringifying it yourself — res.send(
// JSON.stringify(obj)) or the raw-http res.end(JSON.stringify(obj)) — hands
// send()/end() a plain string, which falls back to Content-Type: text/html
// (send) or no header at all (end/http.ServerResponse), even though the body
// is JSON. Clients that trust the header (strict JSON parsers, some HTTP
// libraries, browser fetch()'s res.json() convenience) then mis-handle a
// perfectly valid JSON body. This scans for that call shape and flags it
// unless an explicit Content-Type: application/json hint (res.type('json'),
// res.set/header('Content-Type', 'application/json')) appears in a lookback
// window on the same file, in which case it's already been fixed manually
// and — at most — should just switch to res.json() for brevity.
//
// Pure text-scan (regex + fixed line lookback), not an AST/scope parser:
//   - the lookback is a fixed line window, not a real brace-scoped
//     enclosing-function search, same accepted tradeoff as
//     find_blocking_child_process_calls's handler-signature lookback.
//   - only the exact `JSON.stringify(` shape is matched; a body built from
//     a variable that happens to already be a JSON string
//     (`const body = JSON.stringify(x); res.send(body)`) is not tracked
//     across statements — out of scope, documented limitation.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const LOOKBACK_LINES = 15;

const SEND_JSON_STRINGIFY_RE = /\b(?:res|response)\s*\.\s*(send|end)\s*\(\s*JSON\s*\.\s*stringify\s*\(/;
const CONTENT_TYPE_HINT_RE = /\b(?:res|response)\s*\.\s*type\s*\(\s*['"]json['"]\s*\)|\b(?:res|response)\s*\.\s*(?:set|header)\s*\(\s*['"]Content-Type['"]\s*,\s*['"]application\/json/i;

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

function hasContentTypeHintNearby(lines, lineIdx) {
  const start = Math.max(0, lineIdx - LOOKBACK_LINES);
  for (let i = lineIdx; i >= start; i--) {
    if (CONTENT_TYPE_HINT_RE.test(lines[i])) return true;
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
function findMissingJsonResponseContentType(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_json_response_content_type: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_json_response_content_type: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_json_response_content_type: extensions must be an array of strings.", -32602);

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
      const m = SEND_JSON_STRINGIFY_RE.exec(lines[i]);
      if (!m) continue;
      const method = m[1];
      const hinted = hasContentTypeHintNearby(lines, i);
      if (hinted) continue; // already explicitly set — not a footgun
      findings.push({
        file: rel,
        line: i + 1,
        method,
        rule: method === "end" ? "missing_content_type_res_end" : "missing_content_type_res_send",
        severity: method === "end" ? "error" : "warning",
        message: method === "end"
          ? "res.end(JSON.stringify(...)) sends no Content-Type header at all — clients can't reliably tell the body is JSON. Use res.json(...) or set Content-Type: application/json first."
          : "res.send(JSON.stringify(...)) defaults to Content-Type: text/html (a string body, not an object) even though the payload is JSON. Use res.json(...) instead, or set Content-Type explicitly.",
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

module.exports = { findMissingJsonResponseContentType };
