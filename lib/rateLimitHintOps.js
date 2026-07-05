"use strict";
// ── CHECK_MISSING_RATE_LIMIT — auth/token routes with no rate-limit hint ────
// Project-level check (same convention as check_missing_csp_header /
// find_unhandled_express_error_middleware): if any file registers an
// Express route whose path looks like an authentication, credential-reset,
// or token-issuing endpoint (login/signin/register/signup/reset-password/
// forgot-password/token/otp/verify — path-name heuristics) but NO file in
// the same scan shows a rate-limiting hint anywhere (`express-rate-limit`
// import, `rateLimit(`/`slowDown(` call, or `RateLimiterMemory`/
// `RateLimiterRedis`/`RateLimiterCluster` from rate-limiter-flexible), a
// single project-level finding is reported, listing every matched
// auth-route registration site for context — brute-force / credential-
// stuffing exposure with no throttling anywhere in scope.
//
// Pure text-scan (regex), not an AST/app-instance-aware parser:
//   - the rate-limit hint is project-wide, not per-route/per-app-instance —
//     ANY rate-limiter usage anywhere in the scanned tree counts as
//     "present" for the whole scan (matches the CSP-header tool's
//     documented tradeoff: a global app.use(rateLimit()) elsewhere in the
//     app is exactly the common case this is meant to detect as present).
//   - route detection is path-string-literal keyword matching; a route
//     registered via a dynamically-built path/route table, or with a path
//     that doesn't contain one of the recognized keywords, is not detected.
//   - a rate limiter imported/configured but never actually wired to
//     app.use()/router.use() still counts as "present" — textual presence,
//     not proof of middleware wiring.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ROUTE_CALL_RE = /\b(?:app|router)\s*\.\s*(?:get|post|put|patch|all)\s*\(\s*['"]([^'"]+)['"]/g;
const AUTH_PATH_RE = /login|signin|sign-in|register|signup|sign-up|reset-password|password-reset|forgot-password|\/token\b|\/otp\b|\/verify\b/i;
const RATE_LIMIT_HINT_RE = /express-rate-limit|rate-limiter-flexible|\brateLimit\s*\(|\bslowDown\s*\(|RateLimiterMemory|RateLimiterRedis|RateLimiterCluster/i;

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

function scanFileForAuthRoutes(relPath, source) {
  const routes = [];
  ROUTE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_CALL_RE.exec(source)) !== null) {
    if (AUTH_PATH_RE.test(m[1])) {
      routes.push({ file: relPath, line: lineOf(source, m.index), routePath: m[1] });
    }
  }
  return routes;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, hasAuthRoutes, hasRateLimitHint, findingsCount, warningCount, truncated, findings}}
 */
function checkMissingRateLimit(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`check_missing_rate_limit: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_missing_rate_limit: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("check_missing_rate_limit: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  let hasRateLimitHint = false;
  const authRoutes = [];

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    if (RATE_LIMIT_HINT_RE.test(source)) hasRateLimitHint = true;
    authRoutes.push(...scanFileForAuthRoutes(rel, source));
  }

  authRoutes.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const hasAuthRoutes = authRoutes.length > 0;

  const findings = [];
  if (hasAuthRoutes && !hasRateLimitHint) {
    findings.push({
      file: null,
      line: null,
      rule: "missing_rate_limit_on_auth_routes",
      severity: "warning",
      authRoutes,
      message: "Authentication/credential-reset/token-issuing route(s) were found but no rate-limiting hint (express-rate-limit, rateLimit()/slowDown(), or rate-limiter-flexible's RateLimiterMemory/RateLimiterRedis/RateLimiterCluster) exists anywhere in the scanned files — these endpoints are exposed to brute-force/credential-stuffing with no throttling.",
    });
  }

  const truncated = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    hasAuthRoutes,
    hasRateLimitHint,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { checkMissingRateLimit };
