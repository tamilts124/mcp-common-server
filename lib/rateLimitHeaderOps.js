"use strict";
// ── CHECK_MISSING_RATE_LIMIT_HEADERS — rate-limit response-header shape scan ──
// Sibling of check_missing_rate_limit: that tool flags the *absence* of any
// rate-limiting middleware at all. This tool assumes limiting is already
// present (a rate-limit hint was found) and instead checks the *shape* of
// what it emits:
//
// Two independent checks:
//   1. Project-level: if any file registers Express routes AND a rate-limit
//      hint exists somewhere in the scan (express-rate-limit / rateLimit(
//      / a literal X-RateLimit-* or RateLimit-* header) but no file sets a
//      `Retry-After` header anywhere — a single project-level finding,
//      `missing_retry_after_header` — 429 responses should tell clients how
//      long to wait, easy to omit when hand-rolling limiter middleware.
//   2. Per-call-site: `rateLimit({ ... })` (express-rate-limit) with
//      `standardHeaders: false` (legacy/no RateLimit-* headers emitted) or
//      `legacyHeaders: false` — each flagged individually, informational,
//      since disabling either is a deliberate and common choice but worth
//      surfacing during a security/observability review.
//
// Pure text-scan (regex + looksBinary skip), not an AST/app-instance-aware
// parser — same documented heuristic gaps as check_missing_csp_header /
// check_missing_helmet_security_headers (project-wide hint, literal
// header-name/option matching only).
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ROUTE_REGISTRATION_RE = /\b(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|all)\s*\(/;
const RATE_LIMIT_HINT_RE = /\brateLimit\s*\(|x-ratelimit-|(?<![a-z-])ratelimit-(?:limit|remaining|reset)\b/i;
const RETRY_AFTER_RE = /retry-after/i;

const DISABLED_HEADER_RES = [
  { re: /\bstandardHeaders\s*:\s*false\b/g, option: "standardHeaders", header: "RateLimit-*" },
  { re: /\blegacyHeaders\s*:\s*false\b/g, option: "legacyHeaders", header: "X-RateLimit-*" },
];

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

function scanFileForDisabledHeaders(relPath, source) {
  const findings = [];
  for (const { re, option, header } of DISABLED_HEADER_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      findings.push({
        file: relPath,
        line: lineOf(source, m.index),
        rule: "rate_limit_header_explicitly_disabled",
        severity: "info",
        message: `rateLimit's '${option}' is explicitly disabled (${option}: false) — the ${header} response headers will not be set. Confirm this is intentional.`,
      });
    }
  }
  return findings;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, hasRouteRegistrations, hasRateLimitHint, hasRetryAfterHint, findingsCount, errorCount, warningCount, infoCount, truncated, findings}}
 */
function checkMissingRateLimitHeaders(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`check_missing_rate_limit_headers: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_missing_rate_limit_headers: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("check_missing_rate_limit_headers: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let hasRouteRegistrations = false;
  let hasRateLimitHint = false;
  let hasRetryAfterHint = false;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    if (ROUTE_REGISTRATION_RE.test(source)) hasRouteRegistrations = true;
    if (RATE_LIMIT_HINT_RE.test(source)) hasRateLimitHint = true;
    if (RETRY_AFTER_RE.test(source)) hasRetryAfterHint = true;

    findings.push(...scanFileForDisabledHeaders(rel, source));
  }

  if (hasRouteRegistrations && hasRateLimitHint && !hasRetryAfterHint) {
    findings.push({
      file: null,
      line: null,
      rule: "missing_retry_after_header",
      severity: "warning",
      message: "A rate-limit hint was found (rateLimit()/X-RateLimit-*/RateLimit-* header) but no 'Retry-After' header exists anywhere in the scanned files — 429 responses should tell clients how long to wait before retrying.",
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
  const infoCount = findings.filter(f => f.severity === "info").length;

  return {
    path: origPath,
    filesScanned: files.length,
    hasRouteRegistrations,
    hasRateLimitHint,
    hasRetryAfterHint,
    findingsCount: findings.length,
    errorCount, warningCount, infoCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { checkMissingRateLimitHeaders };
