"use strict";
// ── FIND_MISSING_FINDINDEX_CHECK — -1-index-on-no-match footgun scan ──────
// `Array.prototype.findIndex()` returns -1 when nothing matches. Using that
// result directly as a subscript (`arr[idx]`) with no guard either reads
// the WRONG element (arr[-1] is undefined in a plain array, but is a real
// property lookup that can silently return something on array-likes /
// objects-with-negative-keys) or throws when the result is then property-
// accessed (`arr[idx].foo` -> TypeError: Cannot read properties of
// undefined). Same shape as the existing find_missing_null_checks_after_
// regex_exec footgun (assign a "might be a miss" result, then use it
// unguarded), different API surface (-1 sentinel vs null).
//
// Two independent detection shapes, pure text-scan (regex + small line
// lookahead), not an AST/scope parser:
//   1. Direct chain: `arr[arr.findIndex(...)]` — the index expression is
//      the findIndex call itself, inline inside the subscript — no
//      intermediate variable, so no guard is structurally possible between
//      the call and the use — always flagged (rule
//      `chained_findindex_no_guard`).
//   2. Assign-then-use: `const idx = arr.findIndex(...);` followed within a
//      short lookahead window by `arr[idx]` (any array subscripted with
//      that variable name) — flagged (rule `missing_findindex_guard`)
//      UNLESS a guard (`if (idx...)`, `idx !== -1`, `idx === -1`,
//      `idx >= 0`, `idx < 0`, `idx > -1`, or a ternary `idx ? `) appears
//      anywhere between the assignment and the use.
// One finding per assigned variable (first unguarded use only).
//
// Caveats shared with the rest of this heuristic tool family: no data-flow
// tracking across function boundaries, no understanding of a guard defined
// in a wrapping function/earlier assertion, and a fixed lookahead window
// (default 6 lines) rather than true statement-boundary awareness. A
// variable named `idx`/`i` reused for an unrelated purpose after the
// findIndex assignment can produce a false positive/negative.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const LOOKAHEAD_LINES = 6;

const ASSIGN_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w.$]+\s*\.\s*findIndex\s*\(/;
const DIRECT_CHAIN_RE = /\[\s*[\w.$]+\s*\.\s*findIndex\s*\([^()]*\)\s*\]/;

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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanFile(relPath, source) {
  const findings = [];
  const lines = source.split(/\r\n|\r|\n/);

  // 1. Direct chain — no variable, no possible guard, always flagged.
  for (let i = 0; i < lines.length; i++) {
    if (DIRECT_CHAIN_RE.test(lines[i])) {
      findings.push({
        file: relPath,
        line: i + 1,
        rule: "chained_findindex_no_guard",
        severity: "error",
        message: "findIndex() result used directly as a subscript with no intermediate variable — no guard is possible here, so a no-match (-1) reads the wrong element or throws on further property access.",
      });
    }
  }

  // 2. Assign-then-use.
  for (let i = 0; i < lines.length; i++) {
    const m = ASSIGN_RE.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    const nameRe = escapeRegExp(name);
    const usageRe = new RegExp(`\\[\\s*${nameRe}\\s*\\]`);
    const guardRe = new RegExp(`\\bif\\s*\\(\\s*!?\\s*${nameRe}\\b|${nameRe}\\s*(?:===?|!==?|<=?|>=?)\\s*-?\\d+|${nameRe}\\s*\\?[^:]`);

    const end = Math.min(lines.length, i + 1 + LOOKAHEAD_LINES);
    let guarded = false;
    let flaggedLine = null;
    for (let j = i; j < end; j++) {
      if (guardRe.test(lines[j])) { guarded = true; break; }
      if (j > i && usageRe.test(lines[j])) { flaggedLine = j + 1; break; }
    }

    if (flaggedLine !== null && !guarded) {
      findings.push({
        file: relPath,
        line: flaggedLine,
        name,
        rule: "missing_findindex_guard",
        severity: "error",
        message: `'${name}' holds a findIndex() result (which is -1 on no match) and is used as a subscript within ${LOOKAHEAD_LINES} lines with no visible if(${name})/!==-1/===-1/>=0/<0 guard in between.`,
      });
    }
  }

  return findings;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, truncated, findings}}
 */
function findMissingFindIndexCheck(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_findindex_check: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_findindex_check: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_findindex_check: extensions must be an array of strings.", -32602);

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

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findMissingFindIndexCheck };
