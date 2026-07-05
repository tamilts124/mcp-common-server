"use strict";
// ── FIND_JSON_PARSE_WITHOUT_TRY_CATCH — unguarded JSON.parse() calls ──────
// Flags `JSON.parse(` call sites that are not enclosed in a `try{}` block
// which itself has a matching `catch` clause immediately after its closing
// brace. Malformed/unexpected input (user uploads, API responses, config
// files, localStorage, query params, ...) throws a SyntaxError that, left
// unguarded, crashes the process (uncaught exception) or hangs a request.
// Distinct from find_missing_error_boundary_in_async_route (route-level,
// not call-site level; also fires only inside Express route handlers,
// whereas this fires anywhere including plain scripts/config loaders).
//
// Pure text-scan, not a real parser:
//   CAVEATS:
//     - a `try{}` with only `finally` (no `catch`) does NOT count as
//       guarded — the SyntaxError still propagates uncaught, same risk.
//     - guard detection is purely positional (call site's absolute index
//       falls within a qualifying try-body's [start,end) range) — it does
//       not trace cross-function guards (a JSON.parse inside a helper
//       function called from within a try block is NOT considered guarded
//       by that outer try, since that would need real call-graph analysis).
//     - only brace-bodied `try {` is recognized (always the case in valid
//       JS/TS).
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const TRY_RE = /\btry\s*\{/g;
const JSON_PARSE_RE = /JSON\.parse\s*\(/g;
const CATCH_FOLLOWS_RE = /^\s*catch\b/;

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
  return { bodyStart: openBraceIdx + 1, bodyEnd: i, endBraceIdx: i };
}

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

// Returns array of [bodyStart, bodyEnd) ranges for try-blocks that have a
// matching catch clause immediately after their closing brace.
function findGuardedTryRanges(source) {
  const ranges = [];
  TRY_RE.lastIndex = 0;
  let m;
  while ((m = TRY_RE.exec(source)) !== null) {
    const openBraceIdx = m.index + m[0].length - 1;
    const { bodyStart, bodyEnd, endBraceIdx } = extractBody(source, openBraceIdx);
    const after = source.slice(endBraceIdx + 1, endBraceIdx + 50);
    if (CATCH_FOLLOWS_RE.test(after)) ranges.push([bodyStart, bodyEnd]);
  }
  return ranges;
}

function isGuarded(idx, ranges) {
  return ranges.some(([s, e]) => idx >= s && idx < e);
}

function scanFileForUnguardedJsonParse(relPath, source) {
  const findings = [];
  const guardedRanges = findGuardedTryRanges(source);

  JSON_PARSE_RE.lastIndex = 0;
  let m;
  while ((m = JSON_PARSE_RE.exec(source)) !== null) {
    if (isGuarded(m.index, guardedRanges)) continue;
    const line = lineOf(source, m.index);
    const lineStart = source.lastIndexOf("\n", m.index) + 1;
    const lineEndIdx = source.indexOf("\n", m.index);
    const text = source.slice(lineStart, lineEndIdx === -1 ? source.length : lineEndIdx).trim();
    findings.push({ file: relPath, line, rule: "unguarded_json_parse", severity: "warning", text });
  }
  return findings;
}

/**
 * @param {string} absTarget  Absolute, jail-validated file or directory.
 * @param {string} origPath   Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults] Cap on findings[] length (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, truncated, findings: Array}}
 */
function findJsonParseWithoutTryCatch(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_json_parse_without_try_catch: max_results must be a number.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;

  const stat = fs.statSync(absTarget);
  const isDirectory = stat.isDirectory();

  let files;
  if (isDirectory) {
    files = collectFiles(absTarget, extensions);
  } else {
    if (!extensions.some(e => absTarget.endsWith(e)))
      throw new ToolError(`find_json_parse_without_try_catch: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForUnguardedJsonParse(rel, source));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findJsonParseWithoutTryCatch };
