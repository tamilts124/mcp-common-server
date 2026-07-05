"use strict";
// ── FIND_MISSING_SORT_COMPARATOR — bare .sort() on numeric data ────────────
// Array.prototype.sort() with no comparator sorts elements as strings by
// default ([1, 2, 10].sort() === [1, 10, 2]) — a classic silent-bug source
// when the array actually holds numbers. This scan tracks, per file, two
// textual sources of "known numeric" arrays and flags any later bare
// `NAME.sort()` call on one of them, plus any fully-inline numeric-literal
// array chained directly into `.sort()`:
//   (1) `const/let/var NAME = [n1, n2, ...]` where every element is a bare
//       numeric literal (int or float, optional leading '-').
//   (2) `const/let/var NAME = ....map(Number)` / `....map(parseInt)` — a
//       common numeric-coercion idiom.
//   (3) `[n1, n2, ...].sort()` — the array literal chained straight into
//       `.sort()` with no intermediate variable at all.
//
// Pure text-scan (regex, no data-flow/type analysis):
//   CAVEATS:
//     - only declarations of the exact shapes above mark a variable as
//       numeric; a numeric array built any other way (e.g. returned from a
//       function, pushed to incrementally, destructured) is not tracked.
//     - a variable reassigned later to a non-numeric array after the
//       tracked declaration is still treated as numeric — no reassignment
//       tracking, a documented heuristic tradeoff shared with this tool
//       family's other declaration-based checks (e.g.
//       find_unbounded_object_growth's cache tracking).
//     - `.sort(undefined)` / `.sort(null)` are NOT treated as equivalent to
//       a bare call — only a literal empty-parens `.sort()` is flagged.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const NUMERIC_ELEMENT_RE = /^-?\d+(?:\.\d+)?$/;
const NUMERIC_ARRAY_DECL_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*\[([^\[\]]*)\]/g;
const NUMERIC_MAP_DECL_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*[\w.]+(?:\([^)]*\))?\s*\.map\s*\(\s*(?:Number|parseInt)\b/g;
const BARE_SORT_RE = /\b(\w+)\.sort\s*\(\s*\)/g;
const INLINE_NUMERIC_SORT_RE = /\[\s*(-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)*)\s*\]\s*\.sort\s*\(\s*\)/g;

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

function isAllNumericElements(contents) {
  const trimmed = contents.trim();
  if (!trimmed) return false;
  const parts = trimmed.split(",").map(s => s.trim());
  return parts.every(p => NUMERIC_ELEMENT_RE.test(p));
}

function scanFileForMissingSortComparator(relPath, source) {
  const findings = [];
  const numericVars = new Map(); // name -> declaration line

  NUMERIC_ARRAY_DECL_RE.lastIndex = 0;
  let m;
  while ((m = NUMERIC_ARRAY_DECL_RE.exec(source)) !== null) {
    if (isAllNumericElements(m[2])) numericVars.set(m[1], lineOf(source, m.index));
  }

  NUMERIC_MAP_DECL_RE.lastIndex = 0;
  while ((m = NUMERIC_MAP_DECL_RE.exec(source)) !== null) {
    numericVars.set(m[1], lineOf(source, m.index));
  }

  BARE_SORT_RE.lastIndex = 0;
  while ((m = BARE_SORT_RE.exec(source)) !== null) {
    const name = m[1];
    if (!numericVars.has(name)) continue;
    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      rule: "bare_sort_on_numeric_array",
      severity: "warning",
      variable: name,
      declaredAtLine: numericVars.get(name),
      message: `'${name}' is built from numeric values but '.sort()' is called with no comparator — default sort is lexicographic (string) order, which silently mis-orders numbers (e.g. 10 sorts before 2).`,
    });
  }

  INLINE_NUMERIC_SORT_RE.lastIndex = 0;
  while ((m = INLINE_NUMERIC_SORT_RE.exec(source)) !== null) {
    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      rule: "bare_sort_on_inline_numeric_array",
      severity: "warning",
      message: "An inline numeric-literal array is sorted with no comparator — default sort is lexicographic (string) order, which silently mis-orders numbers (e.g. 10 sorts before 2).",
    });
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
function findMissingSortComparator(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_sort_comparator: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_sort_comparator: extensions must be an array of strings.", -32602);

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
      throw new ToolError(`find_missing_sort_comparator: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }
  const baseDir = isDirectory ? absTarget : path.dirname(absTarget);

  const findings = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    findings.push(...scanFileForMissingSortComparator(rel, buf.toString("utf8")));
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

module.exports = { findMissingSortComparator };
