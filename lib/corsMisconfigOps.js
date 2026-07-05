"use strict";
// ── SCAN_CORS_MISCONFIG — find likely CORS misconfigurations in source ─────
// Recursively walks a file or directory (same MCP_IGNORE-aware walk pattern
// as scan_secrets/scan_todos) looking for common CORS footguns in JS/TS:
//   - a hardcoded wildcard Access-Control-Allow-Origin header ('*')
//   - cors({ origin: '*' }) (express `cors` package, explicit wildcard)
//   - origin: '*' combined with credentials: true in the SAME options
//     object — invalid per the Fetch spec (browsers reject it), and when a
//     server-side proxy/framework doesn't itself enforce the spec this
//     combination is a common source of credentialed cross-origin leaks
//   - the origin header being reflected back unchecked
//     (Access-Control-Allow-Origin set directly from req.headers.origin /
//     req.header('origin') with no allow-list check) — a classic "allow any
//     origin that asks" bypass that looks safe at a glance
// Pure text-scan (regex), not an AST parser — no cross-file/variable-alias
// tracking (e.g. `const opts = {...}; cors(opts)` isn't followed). Read-only,
// zero-dependency, no network calls.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// Matched against each line independently (line-oriented, like scan_secrets).
const WILDCARD_HEADER_RE  = /(?:Access-Control-Allow-Origin|['"]access-control-allow-origin['"])\s*[,:]\s*['"]\*['"]/i;
const CORS_CALL_OPEN_RE   = /\bcors\s*\(/i;
const CORS_BARE_CALL_RE   = /\bcors\s*\(\s*\)/i;
const WINDOW_WILDCARD_ORIGIN_RE = /origin\s*:\s*['"]\*['"]/i;
const WINDOW_CREDENTIALS_TRUE_RE = /credentials\s*:\s*true/i;
const REFLECTED_ORIGIN_RE = /Access-Control-Allow-Origin['"]?\s*,\s*(?:req\.headers(?:\[['"]origin['"]\]|\.origin)|req\.header\s*\(\s*['"]origin['"]\s*\))/i;

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

// Joins the matched line plus a few lines of lookahead into one window, to
// catch the common multi-line `cors({\n  origin: '*',\n  credentials: true\n})`
// shape without a full parser. Stops early at a closing `})` so it doesn't
// bleed into an unrelated later call.
function windowFrom(lines, lineIdx, windowSize = 6) {
  const end = Math.min(lines.length, lineIdx + windowSize);
  const collected = [];
  for (let i = lineIdx; i < end; i++) {
    collected.push(lines[i]);
    if (i > lineIdx && /\}\s*\)/.test(lines[i])) break; // left the options object
  }
  return collected.join("\n");
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported issues (1-5000, default 500).
 * @returns {{path, filesScanned, issueCount, truncated, issues}}
 */
function scanCorsMisconfig(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`scan_cors_misconfig: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("scan_cors_misconfig: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("scan_cors_misconfig: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const issues = [];

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");
    const lines = source.split(/\r\n|\r|\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      if (REFLECTED_ORIGIN_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "reflected_origin", severity: "error",
          message: "Access-Control-Allow-Origin set directly from the request's Origin header with no allow-list check — reflects any origin that asks." });
        continue; // don't double-report the same line under the wildcard rule
      }

      if (WILDCARD_HEADER_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "wildcard_header", severity: "warning",
          message: "Access-Control-Allow-Origin hardcoded to '*' — allows any origin to read the response." });
      }

      if (CORS_CALL_OPEN_RE.test(line)) {
        if (CORS_BARE_CALL_RE.test(line)) {
          issues.push({ file: rel, line: lineNo, rule: "cors_default_wildcard", severity: "info",
            message: "cors() called with no options — defaults to reflecting/allowing all origins (Access-Control-Allow-Origin: *)." });
        } else {
          const window = windowFrom(lines, i);
          if (WINDOW_WILDCARD_ORIGIN_RE.test(window)) {
            if (WINDOW_CREDENTIALS_TRUE_RE.test(window)) {
              issues.push({ file: rel, line: lineNo, rule: "wildcard_with_credentials", severity: "error",
                message: "cors() configured with origin:'*' and credentials:true in the same options — invalid per spec and a common credentialed cross-origin leak." });
            } else {
              issues.push({ file: rel, line: lineNo, rule: "cors_wildcard_origin", severity: "warning",
                message: "cors() explicitly configured with origin:'*' — allows any origin." });
            }
          }
        }
      }
    }
  }

  issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = issues.length > maxResults;
  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;
  const infoCount = issues.filter(i => i.severity === "info").length;

  return {
    path: origPath,
    filesScanned: files.length,
    issueCount: issues.length,
    errorCount, warningCount, infoCount,
    truncated,
    issues: issues.slice(0, maxResults),
  };
}

module.exports = { scanCorsMisconfig };
