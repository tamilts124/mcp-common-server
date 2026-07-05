"use strict";
// ── FIND_MISSING_IMG_ALT_TEXT — HTML/JSX <img> accessibility scan ──────────
// Every <img> element needs an `alt` attribute: screen readers announce the
// alt text (or skip the image entirely for `alt=""`, the correct marker for
// purely decorative images); with no `alt` attribute at all, screen readers
// fall back to announcing the raw file path, which is meaningless to a
// visually-impaired user. This is the first tool in this server's coverage
// to look at front-end markup accessibility rather than backend/security/git
// concerns — no existing tool inspects HTML/JSX <img> tags at all.
//
// Detection, per `<img ...>` (or JSX `<img ... />`) tag found via a
// balanced-attribute regex (`<img\b[^>]*>`, case-insensitive tag name):
//   1. No `alt=` attribute anywhere in the tag at all ->
//      `missing_alt_attribute` (error) — worst case: raw filename/URL is
//      announced to screen readers.
//   2. `alt=""` (or `alt={''}`/`alt={""}` JSX-empty-string form) -> NOT
//      flagged. Empty alt is the correct, intentional way to mark a purely
//      decorative image (screen readers skip it silently) — this is a
//      correct pattern, not a bug.
//   3. `alt="..."` present with non-empty text that looks like a bare
//      filename (ends in a common image extension, optionally with a path)
//      -> `non_descriptive_alt_text` (warning) — a common anti-pattern where
//      alt text is auto-filled/copy-pasted from the filename instead of
//      describing the image's content, providing screen-reader users no
//      more information than the missing-alt case.
//   4. A JSX expression alt value (`alt={someVar}`) is treated as present
//      and assumed descriptive (can't statically evaluate the expression) —
//      not flagged, avoiding false positives on legitimately dynamic alt
//      text.
//
// Deliberately NOT flagged (documented caveats, same "skip, don't guess"
// convention as the rest of this tool family):
//   - `<Image .../>` (Next.js/custom component wrappers) — only the literal
//     `<img` HTML tag name is matched, not arbitrary component names that
//     may render an <img> under the hood.
//   - Attribute order/spacing variations are all handled (regex over the
//     whole tag body), but a stray `>` inside a JSX expression attribute
//     value (e.g. `alt={x > 0 ? 'a' : 'b'}`) can misplace the tag boundary —
//     a documented heuristic limitation of the "first `>` ends the tag"
//     approach used here (no real JSX/HTML parser).
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const IMG_TAG_RE = /<img\b[^>]*>/gi;
// alt="..." | alt='...' | alt={`...`} | alt={"..."} | alt={'...'} | alt={expr}
const ALT_ATTR_RE = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\}|\{[^}]*\})/i;
const IMAGE_FILENAME_RE = /^[\w\-./\\]+\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;

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

function scanFile(relPath, source) {
  const findings = [];
  IMG_TAG_RE.lastIndex = 0;
  let m;
  while ((m = IMG_TAG_RE.exec(source)) !== null) {
    const tag = m[0];
    const line = lineOf(source, m.index);
    const altMatch = ALT_ATTR_RE.exec(tag);

    if (!altMatch) {
      findings.push({
        file: relPath, line,
        rule: "missing_alt_attribute",
        severity: "error",
        message: "<img> tag has no 'alt' attribute — screen readers fall back to announcing the raw file path/URL. Add alt=\"<description>\" (or alt=\"\" if the image is purely decorative).",
      });
      continue;
    }

    // Literal string forms captured in groups 1-4; group 5 (bare {expr}) has
    // no capture at all -> treat as dynamic/present, don't inspect further.
    const literalValue = altMatch[1] ?? altMatch[2] ?? altMatch[3] ?? altMatch[4];
    if (literalValue === undefined) continue; // dynamic expression, assumed fine

    if (literalValue.trim() === "") continue; // alt="" — correct decorative-image marker

    if (IMAGE_FILENAME_RE.test(literalValue.trim())) {
      findings.push({
        file: relPath, line,
        altText: literalValue,
        rule: "non_descriptive_alt_text",
        severity: "warning",
        message: `<img> alt text "${literalValue}" looks like a bare filename rather than a description of the image's content — provides screen-reader users no more information than a missing alt attribute.`,
      });
    }
  }
  return findings;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default .html/.htm/.jsx/.tsx).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function findMissingImgAltText(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_img_alt_text: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_img_alt_text: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_img_alt_text: extensions must be an array of strings.", -32602);

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

module.exports = { findMissingImgAltText };
