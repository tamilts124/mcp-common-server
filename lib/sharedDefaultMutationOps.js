"use strict";
// ── FIND_MISSING_NULL_CHECK_ON_OPTIONAL_CHAINING_DEFAULT ──────────────────
// `obj?.prop ?? DEFAULT` / `obj?.prop || DEFAULT` is safe when DEFAULT is an
// inline literal (`?? []`, `?? {}`) — a fresh value every call. It becomes a
// shared-mutable-state bug when DEFAULT is a bare identifier that points at
// an array/object literal declared once at module (top) level: every call
// site where `obj.prop` is missing receives the *same* object instance, so
// mutating the result (`.push(`, property assignment, index assignment)
// corrupts state across unrelated calls/requests.
//
// Two shapes, pure text-scan (regex + line lookahead), not an AST/scope
// parser:
//   1. Direct chain: `(expr?.prop ?? DEFAULT).push(...)` — mutation happens
//      in the same expression, always flagged when DEFAULT resolves to a
//      top-level literal declaration (rule `chained_shared_default_mutation`).
//   2. Assign-then-use: `const x = expr?.prop ?? DEFAULT;` followed within a
//      lookahead window by a mutation of `x` (rule
//      `assigned_shared_default_mutation`).
//
// "Top-level literal declaration" is approximated as `const NAME = [`/`{`
// with zero leading indentation — a heuristic for module scope, not a real
// scope resolver. A same-named local shadowing a module-level literal, or a
// literal declared with leading whitespace inside an IIFE, can produce a
// false negative/positive. Documented limitation, same convention as the
// rest of this heuristic tool family (e.g. find_missing_findindex_check).

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const LOOKAHEAD_LINES = 6;

const MUTATORS = "push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin";
const TOPLEVEL_LITERAL_RE = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\[|\{)/;
const ASSIGN_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w.$]+\s*\?\.\s*[\w$]+\s*(?:\?\?|\|\|)\s*([A-Za-z_$][\w$]*)\s*;?\s*$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function findTopLevelLiterals(lines) {
  const set = new Set();
  for (const line of lines) {
    const m = TOPLEVEL_LITERAL_RE.exec(line);
    if (m) set.add(m[1]);
  }
  return set;
}

function scanFile(relPath, source) {
  const findings = [];
  const lines = source.split(/\r\n|\r|\n/);
  const topLevelLiterals = findTopLevelLiterals(lines);
  if (topLevelLiterals.size === 0) return findings;

  // 1. Direct chain — mutation happens inline, always flagged.
  const literalAlt = Array.from(topLevelLiterals).map(escapeRegExp).join("|");
  const directChainRe = new RegExp(
    `\\?\\.[\\w$]+\\s*(?:\\?\\?|\\|\\|)\\s*(${literalAlt})\\s*\\)\\s*\\.\\s*(?:${MUTATORS})\\s*\\(`
  );
  for (let i = 0; i < lines.length; i++) {
    const m = directChainRe.exec(lines[i]);
    if (m) {
      findings.push({
        file: relPath,
        line: i + 1,
        name: m[1],
        rule: "chained_shared_default_mutation",
        severity: "error",
        message: `'${m[1]}' is a module-level array/object literal used as an optional-chaining fallback and mutated in the same expression — every caller that hits this fallback shares and corrupts the same instance.`,
      });
    }
  }

  // 2. Assign-then-use.
  for (let i = 0; i < lines.length; i++) {
    const m = ASSIGN_RE.exec(lines[i]);
    if (!m) continue;
    const varName = m[1];
    const fallbackName = m[2];
    if (!topLevelLiterals.has(fallbackName)) continue;

    const nameRe = escapeRegExp(varName);
    const mutationRe = new RegExp(
      `\\b${nameRe}\\s*\\.\\s*(?:${MUTATORS})\\s*\\(|\\b${nameRe}\\s*\\[[^\\]]*\\]\\s*=(?!=)|\\b${nameRe}\\s*\\.\\s*[\\w$]+\\s*=(?!=)`
    );

    const end = Math.min(lines.length, i + 1 + LOOKAHEAD_LINES);
    for (let j = i + 1; j < end; j++) {
      const mm = mutationRe.exec(lines[j]);
      if (mm) {
        findings.push({
          file: relPath,
          line: j + 1,
          name: varName,
          rule: "assigned_shared_default_mutation",
          severity: "error",
          message: `'${varName}' can hold '${fallbackName}' (a module-level array/object literal used as an optional-chaining fallback) and is mutated here — every caller that hits the fallback shares and corrupts the same instance.`,
        });
        break;
      }
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
function findSharedDefaultMutation(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_null_check_on_optional_chaining_default: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_null_check_on_optional_chaining_default: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_null_check_on_optional_chaining_default: extensions must be an array of strings.", -32602);

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

module.exports = { findSharedDefaultMutation };
