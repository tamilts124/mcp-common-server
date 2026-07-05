"use strict";
// ── FIND_EMPTY_CATCH_BLOCKS — silently-swallowed errors ──────────────────
// Scans JS/TS source for `catch` blocks (both `catch (e) { ... }` and
// bare `catch { ... }`) whose body has no meaningful content: no statements
// other than comments/whitespace. A truly empty or comment-only catch block
// silently swallows an error with zero trace, which is almost always a bug
// masked as error handling.
//
// Pure text-scan (brace-depth walk from the `catch` keyword), not a real
// parser:
//   CAVEATS:
//     - a catch block containing ONLY a comment (no rethrow/log/return) is
//       still flagged — a comment explaining "why" doesn't change the fact
//       that the error itself vanishes silently at runtime.
//     - does not evaluate whether logging/rethrow logic is *correct*, only
//       whether the block is non-empty — `catch (e) { console.log("x") }`
//       is not flagged even though `e` itself is never referenced.
//     - nested catch blocks are each scanned independently.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const CATCH_RE = /\bcatch\s*(\([^)]*\))?\s*\{/g;

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

// Strips // line comments and /* */ block comments from a snippet (naive —
// does not understand strings/regex/template literals containing comment-
// like sequences, an accepted heuristic tradeoff shared by scan_todos etc).
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Given source and the index right after the `catch (...) {` block's
// opening brace, finds the matching closing brace via depth counting and
// returns the body substring (exclusive of the braces) plus its end index.
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

function scanFileForEmptyCatch(relPath, source) {
  const findings = [];
  CATCH_RE.lastIndex = 0;
  let m;
  while ((m = CATCH_RE.exec(source)) !== null) {
    const openBraceIdx = m.index + m[0].length - 1;
    const { body, endIdx } = extractBody(source, openBraceIdx);
    const cleaned = stripComments(body).trim();
    if (cleaned.length === 0) {
      findings.push({
        file: relPath,
        line: lineOf(source, m.index),
        hasCommentOnly: body.trim().length > 0,
        snippet: source.slice(m.index, Math.min(endIdx + 1, m.index + 120)).replace(/\s+/g, " ").trim(),
      });
    }
    CATCH_RE.lastIndex = endIdx;
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
function findEmptyCatchBlocks(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_empty_catch_blocks: max_results must be a number.", -32602);
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
      throw new ToolError(`find_empty_catch_blocks: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForEmptyCatch(rel, source));
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

module.exports = { findEmptyCatchBlocks };
