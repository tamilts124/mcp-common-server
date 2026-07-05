"use strict";
// ── FIND_SETINTERVAL_WITHOUT_CLEAR — leaked/zombie interval-timer scan ──────
// `setInterval(fn, ms)` returns a handle that keeps firing (and keeps the
// event loop alive, unless `.unref()`'d) for the life of the process unless
// something calls `clearInterval(handle)`. A long-running server that starts
// intervals per-request/per-connection/per-job without ever clearing them
// accumulates zombie timers — a classic Node memory/CPU leak that's invisible
// in short-lived scripts and only shows up under sustained load.
//
// Detection:
//   1. `const/let/var NAME = setInterval(...)` — the *whole file* (not just
//      the enclosing block, since clearInterval is commonly called from a
//      separate shutdown/cleanup function) is searched for a literal
//      `clearInterval(NAME` reference. Found -> not flagged.
//   2. An inline chained `.unref()` immediately after the call (either
//      assigned or not) is treated as an intentional "let this die with the
//      process" idiom and is not flagged — `.unref()` timers don't keep the
//      process alive, so the leak concern (a process that never exits) does
//      not apply, even though the callback itself would still fire.
//   3. No variable AND no inline `.unref()` -> `unassigned_interval_handle`
//      (error) — the handle isn't stored anywhere, so `clearInterval` could
//      never be called on it even if someone wanted to; this is worse than
//      case where a variable exists but isn't cleared (rule 4).
//   4. Variable exists but no `clearInterval(NAME` anywhere in the file and
//      no inline `.unref()` -> `interval_never_cleared` (warning).
//
// Deliberately NOT flagged / documented caveats (same "skip, don't guess"
// convention as the rest of this tool family):
//   - `obj.prop = setInterval(...)` (member-expression assignment, not a
//     bare `const/let/var` declaration) has no extractable variable name and
//     is treated as case 3 (unassigned) even though `clearInterval(obj.prop)`
//     elsewhere would be valid — property-access assignment targets aren't
//     tracked.
//   - `clearInterval(NAME` is a whole-file textual search, not scope/CFG
//     aware: a `clearInterval` call in a completely unrelated function that
//     happens to reuse the same variable name in a different scope will
//     suppress a genuine finding (false negative, chosen over the
//     false-positive-heavy alternative of also tracking scope boundaries).
//   - Brace/paren counting ignores string/template/regex contents.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// [1] = optional assignment keyword (anchor only), [2] = variable name.
const CREATE_RE = /(?:(const|let|var)\s+(\w+)\s*=\s*)?\bsetInterval\s*\(/g;

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
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function findMatchingParen(source, openIdx) {
  let depth = 1;
  for (let i = openIdx + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function scanFile(relPath, source) {
  const findings = [];
  CREATE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_RE.exec(source)) !== null) {
    const varName = m[2];
    const line = lineOf(source, m.index);

    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParen(source, openParenIdx);
    if (closeParenIdx === -1) continue; // unterminated call, skip

    const afterCall = closeParenIdx + 1;
    const chainWindow = source.slice(afterCall, afterCall + 40);
    const hasInlineUnref = /^\s*\.\s*unref\s*\(\s*\)/.test(chainWindow);
    if (hasInlineUnref) continue; // intentional daemon-timer idiom

    if (!varName) {
      findings.push({
        file: relPath, line,
        rule: "unassigned_interval_handle",
        severity: "error",
        message: "setInterval(...) result is not assigned to a variable — clearInterval() can never be called on it, and (without .unref()) it will keep the process alive and firing forever.",
      });
      continue;
    }

    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const clearRe = new RegExp(`\\bclearInterval\\s*\\(\\s*${escaped}\\b`);
    if (clearRe.test(source)) continue;

    findings.push({
      file: relPath, line, variable: varName,
      rule: "interval_never_cleared",
      severity: "warning",
      message: `setInterval(...) assigned to '${varName}' has no matching 'clearInterval(${varName})' anywhere in this file — the timer will keep firing for the life of the process unless cleared elsewhere.`,
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
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function findSetIntervalWithoutClear(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_setinterval_without_clear: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_setinterval_without_clear: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_setinterval_without_clear: extensions must be an array of strings.", -32602);

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
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    errorCount, warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findSetIntervalWithoutClear };
