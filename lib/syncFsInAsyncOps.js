"use strict";
// ── FIND_SYNC_FS_IN_ASYNC_CONTEXT — blocking calls inside async functions ──
// Flags `fs.*Sync`/`execSync`/`execFileSync`/`spawnSync` calls made inside
// the body of an `async function` (declaration, arrow, function expression,
// or object/class method shorthand). Using a blocking syscall inside async
// code defeats the entire purpose of making the function async — it still
// blocks the event loop for its full duration, delaying every other
// in-flight async operation on the process, not just the caller.
//
// Pure text-scan (brace-depth walk from each detected `async ... {` span),
// not a real parser:
//   CAVEATS:
//     - a sync call inside a *nested non-async* function defined within an
//       async function's body is still flagged (the textual span still
//       counts as "inside the async function" even though that particular
//       call only blocks whenever the nested function itself is invoked,
//       not necessarily during every await of the outer async function) —
//       documented as an accepted heuristic tradeoff, same category as
//       find_missing_await's "not is this call itself in an async context"
//       caveat.
//     - single-expression arrow functions with no braces (`async x => f()`)
//       are out of scope — only brace-bodied async functions are scanned,
//       since a bodyless arrow can't itself contain a separate statement.
//     - matches are deduplicated by absolute source position so a call
//       inside nested/overlapping async spans is reported once.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// Each captures an optional name in group 1 and ends at the body's opening '{'.
const ASYNC_SPAN_PATTERNS = [
  /async\s+function\s*\*?\s*(\w+)?\s*\([^)]*\)\s*\{/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*async\s*\([^)]*\)\s*=>\s*\{/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*async\s+function\s*\*?\s*\([^)]*\)\s*\{/g,
  /(\w+)\s*:\s*async\s*\([^)]*\)\s*=>\s*\{/g,
  /(\w+)\s*:\s*async\s+function\s*\*?\s*\([^)]*\)\s*\{/g,
  /^\s*async\s+(\w+)\s*\([^)]*\)\s*\{/gm,
  /\(\s*async\s*\([^)]*\)\s*=>\s*\{/g,
];

const SYNC_CALL_RE = /\b(fs\.\w*Sync|execSync|execFileSync|spawnSync)\s*\(/g;

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

function findAsyncSpans(source) {
  const spans = [];
  for (const re of ASYNC_SPAN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const openBraceIdx = m.index + m[0].length - 1;
      const { body, endIdx } = extractBody(source, openBraceIdx);
      spans.push({ name: m[1] || "(anonymous)", bodyStart: openBraceIdx + 1, bodyEnd: endIdx, body });
    }
  }
  return spans;
}

function scanFileForSyncInAsync(relPath, source) {
  const spans = findAsyncSpans(source);
  if (spans.length === 0) return [];

  const findings = [];
  const seenIdx = new Set();

  for (const span of spans) {
    SYNC_CALL_RE.lastIndex = 0;
    let m;
    while ((m = SYNC_CALL_RE.exec(span.body)) !== null) {
      const absIdx = span.bodyStart + m.index;
      if (seenIdx.has(absIdx)) continue;
      seenIdx.add(absIdx);
      const lineStart = source.lastIndexOf("\n", absIdx) + 1;
      const lineEnd = source.indexOf("\n", absIdx);
      const lineText = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
      findings.push({
        file: relPath,
        line: lineOf(source, absIdx),
        asyncFunctionName: span.name,
        call: m[1],
        text: lineText,
      });
    }
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
function findSyncFsInAsyncContext(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_sync_fs_in_async_context: max_results must be a number.", -32602);
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
      throw new ToolError(`find_sync_fs_in_async_context: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForSyncInAsync(rel, source));
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

module.exports = { findSyncFsInAsyncContext };
