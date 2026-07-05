"use strict";
// ── FIND_UNSAFE_REGEX — heuristic ReDoS pattern scanner ─────────────────────
// Scans JS/TS regex literals and new RegExp(...) string patterns for two
// classic catastrophic-backtracking shapes: nested quantifiers (e.g.
// (a+)+, (\d*)*) and quantified alternation with overlapping branches
// (e.g. (a|a)+, (foo|foobar)+). Pure text/regex heuristic, NOT a real regex
// engine or parser: no lookahead-based safety detection, no cross-branch
// analysis beyond simple prefix overlap, and regex-literal extraction can
// false-positive on division operators in rare cases. Zero-dependency,
// read-only.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

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

const REGEX_LITERAL_RE = /(?<![\w$\/])\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\n\\])+)\/([gimsuy]*)/g;
const NEW_REGEXP_RE = /new\s+RegExp\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function hasNestedQuantifier(pattern) {
  return /\([^()]*[+*]\)[+*]/.test(pattern);
}

function overlappingAlternationQuantified(pattern) {
  const re = /\(([^()|]*)\|([^()|]*)\)[+*]/g;
  let m;
  while ((m = re.exec(pattern))) {
    const a = m[1], b = m[2];
    if (!a && !b) continue;
    if (a === b) return true;
    if (a && b.startsWith(a)) return true;
    if (b && a.startsWith(b)) return true;
  }
  return false;
}

function classifyPattern(pattern) {
  const issues = [];
  if (hasNestedQuantifier(pattern)) {
    issues.push({ rule: "nested_quantifier", severity: "error", message: "Nested quantifier (e.g. (x+)+) can cause catastrophic backtracking (ReDoS)." });
  }
  if (overlappingAlternationQuantified(pattern)) {
    issues.push({ rule: "quantified_overlapping_alternation", severity: "warning", message: "Quantified alternation with overlapping branches (e.g. (a|a)+) can cause catastrophic backtracking (ReDoS)." });
  }
  return issues;
}

function scanLineForPatterns(line) {
  const found = [];
  let m;
  REGEX_LITERAL_RE.lastIndex = 0;
  while ((m = REGEX_LITERAL_RE.exec(line))) found.push(m[1]);
  NEW_REGEXP_RE.lastIndex = 0;
  while ((m = NEW_REGEXP_RE.exec(line))) found.push(m[2]);
  return found;
}

function scanFileForUnsafeRegex(absPath, relPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); }
  catch (e) { return { file: relPath, error: `cannot read: ${e.message}`, issues: [] }; }
  if (looksBinary(buf)) return { file: relPath, skipped: true, issues: [] };
  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const issues = [];
  try {
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const patterns = scanLineForPatterns(raw);
      for (const pattern of patterns) {
        for (const issue of classifyPattern(pattern)) {
          issues.push({ file: relPath, line: i + 1, pattern, ...issue });
        }
      }
    }
    return { file: relPath, error: null, issues };
  } catch (e) {
    return { file: relPath, error: e.message, issues: [] };
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults]
 * @returns {{path, filesScanned, filesWithErrors, issueCount, errorCount, warningCount, truncated, issues, errors}}
 */
function scanUnsafeRegex(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_unsafe_regex: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unsafe_regex: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_unsafe_regex: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const allIssues = [];
  const errors = [];
  let filesScanned = 0;

  for (const rel of files) {
    const abs = path.join(baseDir, rel);
    const result = scanFileForUnsafeRegex(abs, rel);
    if (result.skipped) continue;
    filesScanned++;
    if (result.error) { errors.push({ file: rel, error: result.error }); continue; }
    for (const issue of result.issues) allIssues.push(issue);
  }

  allIssues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = allIssues.length > maxResults;
  const finalIssues = allIssues.slice(0, maxResults);

  return {
    path: origPath,
    filesScanned,
    filesWithErrors: errors.length,
    issueCount: allIssues.length,
    errorCount: finalIssues.filter(i => i.severity === "error").length,
    warningCount: finalIssues.filter(i => i.severity === "warning").length,
    truncated,
    issues: finalIssues,
    errors,
  };
}

module.exports = { scanUnsafeRegex };
