"use strict";
// ── FIND_UNHANDLED_EXPRESS_ERROR_MIDDLEWARE — silent-failure hygiene scan ──
// Two independent checks over a scanned file/directory:
//
//   1. Project-level: if any file registers Express routes (app.get/post/
//      put/delete/patch/all(...) or router.<verb>(...)) but NO file in the
//      same scan defines Express's 4-argument error-handling middleware
//      signature — (err, req, res, next) passed to app.use(...) — a single
//      finding is reported: routes exist with no error-handling middleware
//      mounted anywhere, meaning thrown/forwarded errors in sync handlers
//      crash the process (sync) or hang the request forever (async, since
//      Express only auto-forwards synchronous throws to the built-in
//      handler; a rejected promise in an async route handler is NOT
//      forwarded unless the app itself calls next(err)).
//
//   2. Per-catch-block: every `catch (e) { ... }` block in the scanned
//      files that neither calls `next(` nor touches `res.` anywhere in its
//      body is flagged as silently swallowing the error — the request
//      never gets a response and never reaches error-handling middleware,
//      so the client just hangs until it times out.
//
// Pure text-scan (regex + brace-depth body extraction, same convention as
// find_sync_fs_in_async_context's extractBody), not an AST/scope parser:
//   - route/middleware detection is signature-shaped, not app-instance-
//     aware — an app.use((err,req,res,next)=>{}) in a different unrelated
//     file within the same scanned tree still counts as "present" (project-
//     wide check by design, not per-file).
//   - a catch block that re-throws (`throw e`) is NOT flagged even without
//     next()/res. — re-throwing hands the error to the *caller's* handling,
//     which is a legitimate pattern, not a silent swallow.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ROUTE_REGISTRATION_RE = /\b(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|all)\s*\(/;
const ERROR_MIDDLEWARE_RE = /\.\s*use\s*\(\s*(?:function\s*)?\(?\s*err\s*,\s*req\s*,\s*res\s*,\s*next\s*\)?/;
const CATCH_OPEN_RE = /catch\s*\(\s*\w*\s*\)\s*\{/g;
const NEXT_CALL_RE = /\bnext\s*\(/;
const RES_USE_RE = /\bres\s*\./;
const RETHROW_RE = /\bthrow\s+\w+\s*;/;

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

function extractBody(source, openBraceIdx) {
  let depth = 1;
  let i = openBraceIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  return { body: source.slice(openBraceIdx + 1, i), endIdx: i };
}

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function scanFileForSilentCatches(relPath, source) {
  const findings = [];
  CATCH_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = CATCH_OPEN_RE.exec(source)) !== null) {
    const openBraceIdx = m.index + m[0].length - 1;
    const { body } = extractBody(source, openBraceIdx);
    if (NEXT_CALL_RE.test(body) || RES_USE_RE.test(body) || RETHROW_RE.test(body)) continue;
    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      rule: "silent_catch_swallows_error",
      severity: "error",
      message: "catch block neither forwards the error via next(err) nor sends a response via res.* — the request will hang until the client times out.",
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
 * @returns {{path, filesScanned, hasRouteRegistrations, hasErrorMiddleware, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function findUnhandledExpressErrorMiddleware(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_unhandled_express_error_middleware: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unhandled_express_error_middleware: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_unhandled_express_error_middleware: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let hasRouteRegistrations = false;
  let hasErrorMiddleware = false;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    if (ROUTE_REGISTRATION_RE.test(source)) hasRouteRegistrations = true;
    if (ERROR_MIDDLEWARE_RE.test(source)) hasErrorMiddleware = true;

    findings.push(...scanFileForSilentCatches(rel, source));
  }

  if (hasRouteRegistrations && !hasErrorMiddleware) {
    findings.push({
      file: null,
      line: null,
      rule: "no_error_handling_middleware",
      severity: "warning",
      message: "Route registrations were found (app./router.get|post|put|delete|patch|all) but no 4-argument error-handling middleware ((err, req, res, next) passed to .use()) exists anywhere in the scanned files — thrown/forwarded errors have nowhere centralized to go.",
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
    hasErrorMiddleware,
    findingsCount: findings.length,
    errorCount, warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findUnhandledExpressErrorMiddleware };
