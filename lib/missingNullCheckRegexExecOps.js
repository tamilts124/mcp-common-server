"use strict";
// ── FIND_MISSING_NULL_CHECKS_AFTER_REGEX_EXEC — TypeError-on-no-match scan ─
// Scans JS/TS files for the classic "regex match can be null" footgun:
// `RegExp.exec(str)` and `str.match(re)` both return `null` when nothing
// matches, so indexing the result (`[0]`/`[1]`/`.groups`) or destructuring
// it with no guard throws `TypeError: Cannot read properties of null`
// whenever the input doesn't happen to match.
//
// Two independent detection shapes, pure text-scan (regex + small line
// lookahead), not an AST/scope parser:
//   1. Direct chain: `regex.exec(str)[0]` / `str.match(re).groups` — the
//      result is indexed directly on the call with no intermediate
//      variable, so there is no possible guard between the call and the
//      index — always flagged (rule `chained_index_no_guard`).
//   2. Assign-then-use: `const m = regex.exec(str);` followed within a
//      short lookahead window by `m[0]`/`m[1]`/`m.groups` or a destructure
//      (`const [, g] = m;` / `const { groups } = m;`) of that same
//      variable — flagged (rule `missing_null_check_after_regex_exec`)
//      UNLESS a guard (`if (m)`/`if (!m)`/`m?.`/`m &&`/`m === null`/
//      `m !== null`) appears anywhere between the assignment and the use.
// One finding per assigned variable (first unguarded use only), to avoid
// duplicate spam when the same match variable is indexed multiple times in
// a row (e.g. `m[1]`, `m[2]`, `m[3]` back to back).
//
// Caveats shared with the rest of this heuristic tool family: no data-flow
// tracking across function boundaries, no understanding of a guard defined
// in a different (e.g. wrapping) function, and a fixed lookahead window
// (default 6 lines) rather than true statement-boundary awareness.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const LOOKAHEAD_LINES = 6;

const ASSIGN_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w.$]+\s*\.\s*(?:exec|match)\s*\(/;
const DIRECT_CHAIN_RE = /\.\s*(?:exec|match)\s*\([^()]*\)\s*(?:\[\s*\d+\s*\]|\.\s*groups\b)/;

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
        rule: "chained_index_no_guard",
        severity: "error",
        message: "exec()/match() result indexed directly on the call with no intermediate variable — no guard is possible here, so a non-match throws a TypeError.",
      });
    }
  }

  // 2. Assign-then-use.
  for (let i = 0; i < lines.length; i++) {
    const m = ASSIGN_RE.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    const nameRe = escapeRegExp(name);
    const usageRe = new RegExp(`\\b${nameRe}\\s*(?:\\[\\s*\\d+\\s*\\]|\\.\\s*groups\\b)`);
    const destructureRe = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s*[\\[{][^=]*=\\s*${nameRe}\\s*[;\\n]`);
    const guardRe = new RegExp(`\\bif\\s*\\(\\s*!?\\s*${nameRe}\\b|${nameRe}\\s*\\?\\.|${nameRe}\\s*&&|${nameRe}\\s*===?\\s*null|${nameRe}\\s*!==?\\s*null`);

    const end = Math.min(lines.length, i + 1 + LOOKAHEAD_LINES);
    let guarded = false;
    let flaggedLine = null;
    for (let j = i; j < end; j++) {
      if (guardRe.test(lines[j])) { guarded = true; break; }
      if (j > i && (usageRe.test(lines[j]) || destructureRe.test(lines[j]))) { flaggedLine = j + 1; break; }
    }

    if (flaggedLine !== null && !guarded) {
      findings.push({
        file: relPath,
        line: flaggedLine,
        name,
        rule: "missing_null_check_after_regex_exec",
        severity: "error",
        message: `'${name}' holds an exec()/match() result (which is null on no match) and is indexed/destructured within ${LOOKAHEAD_LINES} lines with no visible if(${name})/?./&&/=== null guard in between.`,
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
function findMissingNullChecksAfterRegexExec(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_null_checks_after_regex_exec: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_null_checks_after_regex_exec: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_null_checks_after_regex_exec: extensions must be an array of strings.", -32602);

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

module.exports = { findMissingNullChecksAfterRegexExec };
