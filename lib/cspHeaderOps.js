"use strict";
// ── CHECK_MISSING_CSP_HEADER — Content-Security-Policy hygiene scan ────────
// Two independent checks over a scanned file/directory:
//
//   1. Project-level: if any file registers Express routes (app.get/post/
//      put/delete/patch/all(...) or router.<verb>(...)) but NO file in the
//      same scan sets a Content-Security-Policy anywhere — via the
//      `helmet` middleware, a manual `res.set('Content-Security-Policy', ...)`
//      / `res.setHeader('Content-Security-Policy', ...)` call, or a raw
//      header-name string literal — a single project-level finding is
//      reported: routes exist with no CSP hint anywhere, leaving responses
//      without XSS/clickjacking-mitigating headers by default.
//
//   2. Per-call-site: `helmet({ contentSecurityPolicy: false })` (or the
//      equivalent single-quoted/spaced variant) explicitly disables the CSP
//      helmet would otherwise set — flagged individually since this is
//      easy to miss during a security review even when helmet itself is
//      present and looks like "the CSP is handled".
//
// Pure text-scan (regex + looksBinary skip, same convention as
// find_unhandled_express_error_middleware), not an AST/app-instance-aware
// parser:
//   - CSP-hint detection is project-wide, not per-app-instance — a CSP set
//     in one file of the scanned tree counts as "present" for the whole
//     scan, by design (matches the project-level convention already used
//     by find_unhandled_express_error_middleware).
//   - only the literal header name `Content-Security-Policy` (case-
//     insensitive) is recognized; a CSP set via an unrelated abstraction
//     (a custom wrapper function with no literal header name in the
//     scanned files) will not be detected — a documented heuristic gap
//     shared with every other hint-based project-level check in this tool
//     family.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ROUTE_REGISTRATION_RE = /\b(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|all)\s*\(/;
const CSP_HINT_RE = /\bhelmet\s*\(|content-security-policy/i;
const CSP_DISABLED_RE = /helmet\s*\(\s*\{[^}]*contentSecurityPolicy\s*:\s*false/gi;

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

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function scanFileForDisabledCsp(relPath, source) {
  const findings = [];
  CSP_DISABLED_RE.lastIndex = 0;
  let m;
  while ((m = CSP_DISABLED_RE.exec(source)) !== null) {
    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      rule: "csp_explicitly_disabled",
      severity: "warning",
      message: "helmet's Content-Security-Policy is explicitly disabled (contentSecurityPolicy: false) — confirm this is intentional and that CSP is enforced elsewhere.",
    });
  }
  return findings;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, hasRouteRegistrations, hasCspHint, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function checkMissingCspHeader(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`check_missing_csp_header: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_missing_csp_header: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("check_missing_csp_header: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let hasRouteRegistrations = false;
  let hasCspHint = false;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    if (ROUTE_REGISTRATION_RE.test(source)) hasRouteRegistrations = true;
    if (CSP_HINT_RE.test(source)) hasCspHint = true;

    findings.push(...scanFileForDisabledCsp(rel, source));
  }

  if (hasRouteRegistrations && !hasCspHint) {
    findings.push({
      file: null,
      line: null,
      rule: "missing_csp_header",
      severity: "warning",
      message: "Route registrations were found (app./router.get|post|put|delete|patch|all) but no Content-Security-Policy hint (helmet middleware or a literal 'Content-Security-Policy' header) exists anywhere in the scanned files — responses have no CSP protection against XSS/clickjacking by default.",
    });
  }

  findings.sort((a, b) => {
    if (a.file === null) return 1;
    if (b.file === null) return -1;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    hasRouteRegistrations,
    hasCspHint,
    findingsCount: findings.length,
    errorCount, warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { checkMissingCspHeader };
