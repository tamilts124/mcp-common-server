"use strict";
// ── FIND_MISSING_ERROR_BOUNDARY_IN_ASYNC_ROUTE — unguarded async handler scan ──
// Scans JS/TS for Express route registrations (any of get/post/put/delete/
// patch/all, on `app` or `router`) whose handler is declared `async` but
// whose call has no `try`/`catch` anywhere in it and isn't wrapped by a
// known async-handler helper (`asyncHandler(`/`wrapAsync(`/`catchAsync(`).
// A rejected promise inside such a handler with no catch and no Express
// error middleware invocation crashes the process (older Node) or leaves
// the request hanging forever (newer Node/Express 5's built-in forwarding
// still needs a `next(err)`-reaching error middleware to actually respond).
//
// Distinct from find_promise_all_without_catch (targets Promise.all( call
// sites specifically, not handler-level coverage) and
// find_unhandled_express_error_middleware (checks whether a 4-arg error
// middleware exists anywhere in the project at all, not per-handler
// try/catch coverage).
//
// Scope is the route-registration call itself, delimited by paren-depth
// matching from the opening `(` to its matching close (same convention as
// find_missing_pagination_limit / find_promise_all_without_catch's
// findCallEnd) — naturally covers the handler callback's body since the
// callback is just another argument inside that same outer call.
//
// Pure text-scan (regex + paren-depth extraction), not an AST/control-flow
// parser: `async` detection is a bare-word heuristic scoped to the route
// call text (matches the intended handler in the overwhelming majority of
// real-world registrations, but a stray `async` inside an unrelated nested
// callback or string/comment could theoretically suppress or trigger a
// finding); a wrapper call anywhere in the registration (even one that
// doesn't actually wrap the async handler) suppresses the finding, same
// documented-limitation style as sibling tools.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ROUTE_RE = /\b(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|all)\s*\(/g;
const ASYNC_HANDLER_RE = /\basync\b/;
const TRY_RE = /\btry\b/;
const WRAPPER_RE = /\b(?:asyncHandler|wrapAsync|catchAsync)\s*\(/;

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

function findCallEnd(source, openParenIdx) {
  let depth = 1;
  let i = openParenIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function scanFile(relPath, source, findings) {
  ROUTE_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_RE.exec(source)) !== null) {
    const openParenIdx = m.index + m[0].length - 1;
    const endIdx = findCallEnd(source, openParenIdx);
    if (endIdx === -1) continue; // unterminated call, skip rather than guess
    const handlerText = source.slice(openParenIdx, endIdx + 1);

    if (ASYNC_HANDLER_RE.test(handlerText) && !TRY_RE.test(handlerText) && !WRAPPER_RE.test(handlerText)) {
      findings.push({
        file: relPath,
        line: lineOf(source, m.index),
        rule: "missing_error_boundary_in_async_route",
        severity: "warning",
        message: "Route handler is declared async with no try/catch and no asyncHandler()/wrapAsync()/catchAsync() wrapper anywhere in the registration — an unhandled rejection here crashes the process or hangs the request instead of reaching Express error handling.",
      });
    }
    ROUTE_RE.lastIndex = endIdx + 1; // resume scanning after this call, avoid re-entering nested app.get( inside the handler text
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, routesSeen, findingsCount, warningCount, truncated, findings}}
 */
function findMissingErrorBoundaryInAsyncRoute(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_error_boundary_in_async_route: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_error_boundary_in_async_route: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_error_boundary_in_async_route: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let routesSeen = 0;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    const matches = source.match(ROUTE_RE);
    routesSeen += matches ? matches.length : 0;

    scanFile(rel, source, findings);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    routesSeen,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findMissingErrorBoundaryInAsyncRoute };
