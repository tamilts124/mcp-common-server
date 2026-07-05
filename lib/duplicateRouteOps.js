"use strict";
// ── FIND_DUPLICATE_ROUTE_REGISTRATIONS — dead-handler detection ───────────
// Express resolves routes in registration order: if the same HTTP method +
// literal path string is registered more than once (on `app` or `router`,
// mixed or not), only the *first* matching handler ever runs — every later
// registration for that same (method, path) pair is silently dead code.
// Common copy-paste bug, not covered by find_dead_exports/find_unreachable_modules
// (those catch different dead-code shapes: unused module exports / unrequired
// files, not intra-file/-project route shadowing).
//
// Only literal quoted path strings are matched (single/double/backtick with
// no `${...}` interpolation) — a templated or variable path can't be
// compared textually and is intentionally skipped rather than guessed at.
// Aggregation is project-wide across all scanned files (a router mounted
// into the same app can shadow just as easily across file boundaries as
// within one file) — one finding per (method, path) pair with >1
// registration, listing every occurrence.
//
// Pure text-scan (regex), not an AST/route-table simulator: doesn't account
// for path-parameter equivalence (`/users/:id` vs `/users/:userId` are
// textually different so NOT flagged, even though Express would treat the
// route pattern shape similarly), mount-prefix concatenation (router base
// path from `app.use('/api', router)` is not resolved into the compared
// key), or regex-path routes.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// Captures: [1]=method [2]=quote char [3]=literal path body (no interpolation-bearing backtick)
const ROUTE_RE = /\b(?:app|router)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\\n])*?)\2\s*[,)]/g;

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

function scanFile(relPath, source, registry) {
  ROUTE_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_RE.exec(source)) !== null) {
    const [, methodRaw, quote, rawPath] = m;
    if (quote === "`" && rawPath.includes("${")) continue; // dynamic template, skip
    const method = methodRaw.toLowerCase();
    const routePath = rawPath;
    const key = method + " " + routePath;
    if (!registry.has(key)) registry.set(key, []);
    registry.get(key).push({ file: relPath, line: lineOf(source, m.index), method, path: routePath });
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, routeRegistrationsSeen, duplicateGroupsCount, findingsCount, warningCount, truncated, findings}}
 */
function findDuplicateRouteRegistrations(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_duplicate_route_registrations: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_duplicate_route_registrations: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_duplicate_route_registrations: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const registry = new Map(); // "method path" -> [{file,line,method,path}]
  let routeRegistrationsSeen = 0;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");
    scanFile(rel, source, registry);
  }
  for (const arr of registry.values()) routeRegistrationsSeen += arr.length;

  const findings = [];
  let duplicateGroupsCount = 0;
  for (const [key, occurrences] of registry) {
    if (occurrences.length < 2) continue;
    duplicateGroupsCount++;
    const [first, ...rest] = occurrences;
    for (const dupe of rest) {
      findings.push({
        file: dupe.file,
        line: dupe.line,
        rule: "duplicate_route_registration",
        severity: "warning",
        message: `Duplicate route registration for ${dupe.method.toUpperCase()} '${dupe.path}' — shadowed by the earlier registration at ${first.file}:${first.line}; this handler will never run.`,
      });
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    routeRegistrationsSeen,
    duplicateGroupsCount,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findDuplicateRouteRegistrations };
