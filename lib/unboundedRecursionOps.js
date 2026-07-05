"use strict";
// ── FIND_UNBOUNDED_RECURSION — self-recursive functions with no visible guard ─
// Flags a named function (declaration, arrow, function-expression, or
// object/class method shorthand) whose body calls itself (self-recursion)
// with no apparent base-case guard — `if(`, `?` (ternary), `&&`, `||`,
// `switch(`, or `return` — appearing *before* the first recursive call in
// the body. Recursion with no textual guard ahead of the recursive call is
// a strong stack-overflow-risk signal (either truly unconditional, or the
// guard is expressed in a way this heuristic can't see, e.g. a thrown
// exception or a guard clause defined in a different function).
//
// Pure text-scan (brace-body extraction + regex), not a real parser/CFG:
//   CAVEATS:
//     - a guard *token* appearing before the call is treated as sufficient
//       (e.g. `if (unrelatedCondition) doOtherThing();` earlier in the body
//       still counts as "guarded") — no control-flow-graph reachability
//       analysis is attempted, matching the scope-limiting tradeoff used by
//       find_missing_await and friends.
//     - only brace-bodied named functions are scanned; anonymous/bodyless
//       arrows are out of scope.
//     - mutual recursion (A calls B calls A) is not detected — only direct
//       self-calls by the function's own name.
//     - `?` inside optional chaining (`?.`) or nullish coalescing (`??`) is
//       still counted as a ternary-shaped guard token — a documented
//       heuristic over-count, same spirit as find_dangling_promises'
//       single-line-only tradeoff.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const GUARD_RE = /\bif\s*\(|\?|&&|\|\||\bswitch\s*\(|\breturn\b/;

// Each captures the function/method name in group 1 and ends at the body's opening '{'.
const FUNC_SPAN_PATTERNS = [
  /(?:async\s+)?function\s*\*?\s*(\w+)\s*\([^)]*\)\s*\{/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{/g,
  /(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
  /(\w+)\s*:\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{/g,
  /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm,
];

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

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

function findNamedFuncSpans(source) {
  const spans = [];
  for (const re of FUNC_SPAN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      if (!name) continue;
      const openBraceIdx = m.index + m[0].length - 1;
      const { body, endIdx } = extractBody(source, openBraceIdx);
      spans.push({ name, bodyStart: openBraceIdx + 1, bodyEnd: endIdx, body });
    }
  }
  return spans;
}

function scanFileForUnboundedRecursion(relPath, source) {
  const findings = [];
  const seenLines = new Set();

  for (const span of findNamedFuncSpans(source)) {
    const callRe = new RegExp("\\b" + escapeRegExp(span.name) + "\\s*\\(", "g");
    callRe.lastIndex = 0;
    const callMatch = callRe.exec(span.body);
    if (!callMatch) continue; // not self-recursive

    const guardMatch = GUARD_RE.exec(span.body.slice(0, callMatch.index));
    if (guardMatch) continue; // guard token found before the first recursive call

    const absIdx = span.bodyStart + callMatch.index;
    const line = lineOf(source, absIdx);
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    const lineStart = source.lastIndexOf("\n", absIdx) + 1;
    const lineEnd = source.indexOf("\n", absIdx);
    const text = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
    findings.push({ file: relPath, line, functionName: span.name, text });
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
function findUnboundedRecursion(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unbounded_recursion: max_results must be a number.", -32602);
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
      throw new ToolError(`find_unbounded_recursion: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForUnboundedRecursion(rel, source));
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

module.exports = { findUnboundedRecursion };
