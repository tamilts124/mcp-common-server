"use strict";
// ── FIND_PROMISE_ALL_WITHOUT_CATCH — unhandled-aggregate-rejection scan ────
// Scans JS/TS files for Promise.all([...])/Promise.allSettled([...]) calls
// with no .catch( chained directly onto the call and not textually inside a
// try { } block — one rejected member rejects the whole aggregate (for
// Promise.all; allSettled never rejects itself but is included since a
// caller commonly assumes the same handling shape as .all and copy-pastes
// between them) with no handling path in either case, which is exactly the
// unhandled-rejection crash shape on a process without a global handler.
//
// Pure text-scan (regex + paren/brace-depth extraction, same convention as
// find_unhandled_express_error_middleware's extractBody), not an AST/scope
// parser:
//   - "no data-flow tracking" caveat applies as elsewhere in this tool
//     family: a call outside any try, even if its result is later awaited
//     inside one, is still flagged. This matches the tool's stated scope
//     (the call site, not the eventual await site).
//   - .catch( is only recognized when chained *immediately* onto the call's
//     closing paren (whitespace/newlines allowed in between) — a .catch(
//     chained onto a different expression later in the file is not
//     mistaken for this call's handler.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const PROMISE_ALL_RE = /\bPromise\s*\.\s*(all|allSettled)\s*\(/g;
const TRY_OPEN_RE = /\btry\s*\{/g;
const CATCH_CHAIN_RE = /^\s*\.\s*catch\s*\(/;

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

function collectTryRanges(source) {
  const ranges = [];
  TRY_OPEN_RE.lastIndex = 0;
  let m;
  while ((m = TRY_OPEN_RE.exec(source)) !== null) {
    const openBraceIdx = m.index + m[0].length - 1;
    const { endIdx } = extractBody(source, openBraceIdx);
    ranges.push([openBraceIdx, endIdx]);
  }
  return ranges;
}

function isWithinAnyRange(idx, ranges) {
  for (const [start, end] of ranges) if (idx > start && idx < end) return true;
  return false;
}

function scanFile(relPath, source) {
  const findings = [];
  const tryRanges = collectTryRanges(source);

  PROMISE_ALL_RE.lastIndex = 0;
  let m;
  while ((m = PROMISE_ALL_RE.exec(source)) !== null) {
    const method = m[1];
    const openParenIdx = m.index + m[0].length - 1;
    const callEnd = findCallEnd(source, openParenIdx);
    if (callEnd === -1) continue;

    const after = source.slice(callEnd + 1, callEnd + 201);
    if (CATCH_CHAIN_RE.test(after)) continue;

    if (isWithinAnyRange(m.index, tryRanges)) continue;

    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      method: `Promise.${method}`,
      rule: "promise_all_without_catch",
      severity: "error",
      message: `Promise.${method}([...]) has no .catch( chained and the call is not inside a try block — a single rejected member rejects the whole aggregate with no handling path.`,
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
 * @returns {{path, filesScanned, findingsCount, errorCount, truncated, findings}}
 */
function findPromiseAllWithoutCatch(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_promise_all_without_catch: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_promise_all_without_catch: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_promise_all_without_catch: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");
    findings.push(...scanFile(rel, source));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    errorCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findPromiseAllWithoutCatch };
