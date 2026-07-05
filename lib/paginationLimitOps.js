"use strict";
// ── FIND_MISSING_PAGINATION_LIMIT — unbounded list-endpoint scan ─────────
// Scans JS/TS files for Express GET route handlers that look like they
// return a full collection/query result (`res.json(`/`res.send(` somewhere
// in the handler, plus a DB/collection list call — `.find(`/`.findAll(`/
// `.findMany(`/`.query(` — also in the handler) with no visible pagination
// hint anywhere in the same handler (`limit`/`take`/`skip`/`offset`/`page`/
// `pageSize` as a bare word, or a `.slice(` call). An endpoint that returns
// an entire table/collection with no bound grows unboundedly with the data
// and is a common scaling/DoS-shaped bug, especially once traffic or data
// volume increases past what was true during development.
//
// Scope is the GET route-registration call itself, delimited by paren-depth
// matching from the opening `(` of `app.get(`/`router.get(` to its matching
// close (same convention as find_promise_all_without_catch's findCallEnd) —
// this naturally covers the handler callback's body without needing a
// separate brace-depth body extraction, since the callback is just another
// argument inside that same outer call.
//
// Restricted to `get` registrations only (list/read endpoints) — POST/PUT/
// PATCH/DELETE handlers aren't "list" endpoints in the shape this tool
// targets, and including them would mostly produce noise. Pure text-scan
// (regex + paren-depth extraction), not an AST/data-flow parser: does not
// verify the `.find(`-returned value is actually the thing passed to
// `res.json(`/`res.send(` (both hints firing anywhere in the handler is
// treated as "this handler looks like a list endpoint"), and a pagination
// hint present anywhere in the handler (even unrelated, e.g. a `page` var
// used only for logging) suppresses the finding.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const GET_ROUTE_RE = /\b(?:app|router)\s*\.\s*get\s*\(/g;
const DB_LIST_HINT_RE = /\.\s*(?:find|findAll|findMany|query)\s*\(/i;
const RESPONSE_ARRAY_HINT_RE = /\bres\s*\.\s*(?:json|send)\s*\(/i;
const PAGINATION_HINT_RE = /\b(?:limit|take|skip|offset|page|pageSize)\b|\.\s*slice\s*\(/i;

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
  GET_ROUTE_RE.lastIndex = 0;
  let m;
  while ((m = GET_ROUTE_RE.exec(source)) !== null) {
    const openParenIdx = m.index + m[0].length - 1;
    const endIdx = findCallEnd(source, openParenIdx);
    if (endIdx === -1) continue; // unterminated call, skip rather than guess
    const handlerText = source.slice(openParenIdx, endIdx + 1);

    if (DB_LIST_HINT_RE.test(handlerText) && RESPONSE_ARRAY_HINT_RE.test(handlerText) && !PAGINATION_HINT_RE.test(handlerText)) {
      findings.push({
        file: relPath,
        line: lineOf(source, m.index),
        rule: "missing_pagination_limit",
        severity: "warning",
        message: "GET route returns a DB/collection list result (find()/findAll()/findMany()/query()) via res.json()/res.send() with no visible pagination (limit/take/skip/offset/page/pageSize or .slice()) anywhere in the handler — this endpoint's response size grows unboundedly with the data.",
      });
    }
    GET_ROUTE_RE.lastIndex = endIdx + 1; // resume scanning after this call, avoid re-entering nested app.get( inside the handler text
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, getRoutesSeen, findingsCount, warningCount, truncated, findings}}
 */
function findMissingPaginationLimit(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_pagination_limit: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_pagination_limit: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_pagination_limit: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let getRoutesSeen = 0;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    const matches = source.match(GET_ROUTE_RE);
    getRoutesSeen += matches ? matches.length : 0;

    scanFile(rel, source, findings);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    getRoutesSeen,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findMissingPaginationLimit };
