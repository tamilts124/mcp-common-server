"use strict";
// ── FIND_OPEN_REDIRECT_RISKS — flag unvalidated redirect targets ───────────
// Recursively walks a file or directory (same MCP_IGNORE-aware walk pattern
// as scan_secrets/scan_cors_misconfig) looking for common open-redirect
// footguns in JS/TS server and client code:
//   - res.redirect(...) / response.redirect(...) called with a value built
//     directly from req.query/req.body/req.params/req.headers, with no
//     allow-list/host check on the same line
//   - res.writeHead(30x, { Location: ... }) where the Location header is
//     built from the same request-input sources (multi-line window scan,
//     same convention as scan_cors_misconfig's cors() options window)
//   - window.location / location.href assigned directly from
//     req.query/req.body/req.params (SSR templates echoing a "next"/
//     "returnUrl" param straight into a client-side redirect)
// Pure text-scan (regex), not an AST parser — no data-flow tracking, so a
// variable sanitized/allow-listed several lines earlier reads the same as
// one used raw. A same-line allow-list hint (`startsWith(`, `includes(`,
// `ALLOWED`, `whitelist`, case-insensitive) suppresses the finding for that
// line to cut obvious false positives. Read-only, zero-dependency, no
// network calls.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const REQUEST_INPUT_RE = /req\.(?:query|body|params|headers)\b/i;
const REDIRECT_CALL_RE = /\b(?:res|response)\s*\.\s*redirect\s*\(/i;
const WRITEHEAD_OPEN_RE = /\b(?:res|response)\s*\.\s*writeHead\s*\(\s*30[1237893]\b/i;
const LOCATION_HEADER_RE = /['"]?Location['"]?\s*:/i;
const CLIENT_LOCATION_ASSIGN_RE = /\b(?:window\.location(?:\.href)?|location\.href)\s*=(?!=)/i;
const ALLOWLIST_HINT_RE = /startsWith\s*\(|includes\s*\(|allowlist|allow_list|whitelist|ALLOWED/i;

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

// Joins the matched line plus a few lines of lookahead, stopping early at a
// closing `})`/`;` — same shape as scan_cors_misconfig's windowFrom, used
// here to catch multi-line res.writeHead(30x, {\n  Location: ...\n}) calls.
function windowFrom(lines, lineIdx, windowSize = 6) {
  const end = Math.min(lines.length, lineIdx + windowSize);
  const collected = [];
  for (let i = lineIdx; i < end; i++) {
    collected.push(lines[i]);
    if (i > lineIdx && /\}\s*\)/.test(lines[i])) break;
  }
  return collected.join("\n");
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported issues (1-5000, default 500).
 * @returns {{path, filesScanned, issueCount, errorCount, warningCount, truncated, issues}}
 */
function findOpenRedirectRisks(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_open_redirect_risks: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_open_redirect_risks: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_open_redirect_risks: extensions must be an array of strings.", -32602);

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

      if (REDIRECT_CALL_RE.test(line) && REQUEST_INPUT_RE.test(line) && !ALLOWLIST_HINT_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "redirect_from_request_input", severity: "error",
          message: "res.redirect() target built directly from request input with no visible allow-list/host check — classic open-redirect (phishing pivot)." });
        continue; // don't double-report the same line under the writeHead rule
      }

      if (WRITEHEAD_OPEN_RE.test(line)) {
        const window = windowFrom(lines, i);
        if (LOCATION_HEADER_RE.test(window) && REQUEST_INPUT_RE.test(window) && !ALLOWLIST_HINT_RE.test(window)) {
          issues.push({ file: rel, line: lineNo, rule: "redirect_header_from_request_input", severity: "error",
            message: "writeHead() 30x response sets a Location header built from request input with no visible allow-list/host check — open-redirect risk." });
        }
      }

      if (CLIENT_LOCATION_ASSIGN_RE.test(line) && REQUEST_INPUT_RE.test(line) && !ALLOWLIST_HINT_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "location_assignment_from_request_input", severity: "warning",
          message: "window.location/location.href assigned directly from request input with no visible allow-list check — client-side open-redirect risk." });
      }
    }
  }

  issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = issues.length > maxResults;
  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    issueCount: issues.length,
    errorCount, warningCount,
    truncated,
    issues: issues.slice(0, maxResults),
  };
}

module.exports = { findOpenRedirectRisks };
