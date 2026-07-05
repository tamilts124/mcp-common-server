"use strict";
// ── FIND_MISSING_AWAIT — calls to known-async functions with no `await` ──
// Per-file heuristic: collects names declared async in the file (function
// declarations, async arrow/function expressions assigned to a variable,
// object/class method shorthand), then scans every other line for a call to
// one of those names that isn't preceded by `await` and isn't a `return
// name(...)` (returning a promise from an async function needs no await —
// it's automatically unwrapped for the caller, same reasoning as ESLint's
// no-return-await).
//
// Pure text-scan, not a real parser/type-checker:
//   CAVEATS:
//     - does not verify the call site is itself inside an async function
//       (await would be a syntax error otherwise) — a flagged call sitting
//       in non-async code is a false positive to be reviewed, not silently
//       droppable, since it usually means the surrounding function should
//       itself be made async.
//     - only same-file declarations are tracked (no cross-module import
//       resolution) — a call to an async function imported from elsewhere
//       is never flagged, by design (scope limited to "the same file/module").
//     - `.then(`-chained calls are still flagged today (chaining is itself
//       a valid alternative to await) — treat findings as a review starting
//       point, not an authoritative bug list.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const DECL_PATTERNS = [
  /async\s+function\s*\*?\s*(\w+)/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*async\s*\(/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*async\s+function/g,
  /(\w+)\s*:\s*async\s*\(/g,
  /^\s*async\s+(\w+)\s*\(/gm,
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

function isDeclarationLine(line) {
  for (const re of DECL_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(line)) return true;
  }
  return false;
}

function findAsyncNames(source) {
  const names = new Set();
  for (const re of DECL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  return names;
}

function scanFileForMissingAwait(relPath, source) {
  const names = findAsyncNames(source);
  if (names.size === 0) return [];

  const lines = source.split("\n");
  const findings = [];

  lines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (isDeclarationLine(rawLine)) return;

    for (const name of names) {
      const callRe = new RegExp("\\b" + escapeRegExp(name) + "\\s*\\(", "g");
      let m;
      callRe.lastIndex = 0;
      while ((m = callRe.exec(rawLine)) !== null) {
        const before = rawLine.slice(0, m.index);
        if (/\bawait\s*$/.test(before)) continue;      // already awaited
        if (/\breturn\s+$/.test(before)) continue;      // return foo() needs no await
        if (/\bfunction\s*\*?\s*$/.test(before)) continue; // this *is* `async function name(` etc, safety net
        findings.push({ file: relPath, line: idx + 1, functionName: name, text: trimmed });
      }
    }
  });

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
function findMissingAwait(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_await: max_results must be a number.", -32602);
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
      throw new ToolError(`find_missing_await: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForMissingAwait(rel, source));
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

module.exports = { findMissingAwait };
