"use strict";
// ── FIND_CASE_SENSITIVE_IMPORT_MISMATCHES ── cross-platform casing audit ────
// Scans JS/TS files for relative import/require specifiers and flags any
// that resolve to a real on-disk file/directory ONLY when compared
// case-insensitively. These work fine during local development on macOS or
// Windows (case-insensitive/preserving filesystems) but fail hard on Linux
// CI/production (case-sensitive) with a "module not found" error — one of
// the most common "works on my machine" bug classes. Same collectFiles/
// isIgnored/specifier-extraction conventions as find_unreachable_modules/
// find_circular_deps (regex-based, not a real module resolver — no path
// aliases, no dynamically-constructed specifiers). Also separately reports
// on-disk case COLLISIONS (two real entries whose paths differ only in
// case — a landmine on its own, independent of any import statement).

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const RESOLVE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const IMPORT_FROM_RE    = /(?:import|export)\s+[^;'"`]*?from\s*["'`]([^"'`]+)["'`]/g;
const BARE_IMPORT_RE    = /import\s*["'`]([^"'`]+)["'`]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const REQUIRE_RE        = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

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

// Line number (1-based) of a character offset within source text.
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function extractSpecifiers(source) {
  const specs = [];
  for (const re of [IMPORT_FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) specs.push({ spec: m[1], index: m.index });
  }
  return specs;
}

/**
 * @param {string} absDir   Absolute, jail-validated directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported issues (1-5000, default 500).
 * @returns {{path, filesScanned, specifiersChecked, mismatchCount, truncated, mismatches, collisionCount, collisions}}
 */
function findCaseSensitiveImportMismatches(absDir, origPath, opts = {}) {
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new ToolError(`find_case_sensitive_import_mismatches: '${origPath}' is not a directory.`, -32602);

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_case_sensitive_import_mismatches: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_case_sensitive_import_mismatches: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = collectFiles(absDir, extensions);
  const fileSet = new Set(files);
  // lowercase rel path -> array of actual-case rel paths sharing that lowercase form
  const lowerMap = new Map();
  for (const f of files) {
    const key = f.toLowerCase();
    if (!lowerMap.has(key)) lowerMap.set(key, []);
    lowerMap.get(key).push(f);
  }

  const collisions = [];
  for (const [key, paths] of lowerMap) {
    if (paths.length > 1) collisions.push({ lower: key, paths: paths.sort() });
  }
  collisions.sort((a, b) => a.lower.localeCompare(b.lower));

  const mismatches = [];
  let specifiersChecked = 0;

  for (const rel of files) {
    let source;
    try { source = fs.readFileSync(path.join(absDir, rel), "utf8"); }
    catch (_) { continue; }
    const fromDir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);

    for (const { spec, index } of extractSpecifiers(source)) {
      if (!(spec.startsWith(".") || spec.startsWith("/"))) continue; // bare specifier: external package, out of scope
      specifiersChecked++;
      const rawJoined = path.posix.normalize(spec.startsWith("/") ? spec.slice(1) : path.posix.join(fromDir, spec));
      const candidates = [rawJoined];
      for (const ext of RESOLVE_EXTENSIONS) candidates.push(rawJoined + ext);
      for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.posix.join(rawJoined, "index" + ext));

      let exactHit = false;
      let caseInsensitiveHit = null;
      for (const c of candidates) {
        if (fileSet.has(c)) { exactHit = true; break; }
      }
      if (!exactHit) {
        for (const c of candidates) {
          const arr = lowerMap.get(c.toLowerCase());
          if (arr && arr.length) { caseInsensitiveHit = arr[0]; break; }
        }
      }
      if (!exactHit && caseInsensitiveHit) {
        mismatches.push({
          file: rel,
          line: lineAt(source, index),
          specifier: spec,
          actualPath: caseInsensitiveHit,
        });
      }
      // else: genuinely unresolved (missing/bare/aliased) — out of scope for this tool.
    }
  }

  mismatches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = mismatches.length > maxResults;

  return {
    path: origPath,
    filesScanned: files.length,
    specifiersChecked,
    mismatchCount: mismatches.length,
    truncated,
    mismatches: mismatches.slice(0, maxResults),
    collisionCount: collisions.length,
    collisions,
  };
}

module.exports = { findCaseSensitiveImportMismatches };
