"use strict";
// ── FIND_MISSING_FORM_LABEL — <input>/<textarea>/<select> accessible-name scan ─
// A form control with no accessible name is announced by screen readers as
// just its element type ("edit text", "combo box") with no indication of
// what it's for — a common, easy-to-miss accessibility bug. Sibling to
// find_missing_img_alt_text, opening up front-end-markup accessibility
// coverage further (no existing tool inspected form controls before this).
//
// An accessible name is considered present if ANY of the following hold for
// a given `<input>`/`<textarea>`/`<select>` opening tag:
//   1. `aria-label="..."` (or JSX `aria-label={...}`) with non-empty content.
//   2. `aria-labelledby="..."` present at all (can't statically verify the
//      referenced id actually resolves to visible text — treated as present
//      on the assumption the reference is intentional).
//   3. The tag has `id="X"` and a `<label ... for="X">` (or JSX `htmlFor="X"`)
//      is found anywhere else in the file.
//   4. The tag's start position falls textually inside a `<label>...</label>`
//      span found anywhere in the file (implicit wrapping — `<label>Name:
//      <input .../></label>`).
//
// Elements deliberately skipped (not flagged even with no name found):
//   - `type="hidden"` — never rendered, no accessible-name requirement.
//   - `type="submit"` / `type="button"` / `type="reset"` — use their own
//     `value`/button text as the accessible name, a different (unchecked)
//     shape than the label-association rules above.
//
// Deliberately NOT flagged / documented caveats (same "skip, don't guess"
// convention as the rest of this tool family):
//   - `<label>...</label>` span-matching is a simple non-greedy regex, not a
//     real parser — nested/overlapping <label> tags can misassociate a
//     control with the wrong (or a non-enclosing) label text.
//   - `aria-labelledby` is trusted at face value — the referenced id's
//     element existing/having text is never verified.
//   - Custom component wrappers (e.g. `<TextField ... />`) that render a
//     real `<input>` under the hood are invisible to this scan — only the
//     literal HTML tag names are matched.
//   - A stray `>` inside a JSX expression attribute value can misplace a tag
//     boundary (same limitation as find_missing_img_alt_text).
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const CONTROL_TAG_RE = /<(input|textarea|select)\b[^>]*>/gi;
const LABEL_SPAN_RE = /<label\b[^>]*>[\s\S]*?<\/label>/gi;
const ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\})/i;
const ARIA_LABEL_RE = /\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\}|\{[^}]*\})/i;
const ARIA_LABELLEDBY_RE = /\baria-labelledby\s*=/i;
const TYPE_ATTR_RE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset"]);

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

function collectLabelForIds(source) {
  const ids = new Set();
  const forRe = /<label\b[^>]*\b(?:for|htmlFor)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\})/gi;
  let m;
  while ((m = forRe.exec(source)) !== null) {
    const id = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (id) ids.add(id);
  }
  return ids;
}

function collectLabelSpans(source) {
  const spans = [];
  LABEL_SPAN_RE.lastIndex = 0;
  let m;
  while ((m = LABEL_SPAN_RE.exec(source)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function isInsideAnySpan(idx, spans) {
  return spans.some(([start, end]) => idx >= start && idx < end);
}

function scanFile(relPath, source) {
  const findings = [];
  const labelForIds = collectLabelForIds(source);
  const labelSpans = collectLabelSpans(source);

  CONTROL_TAG_RE.lastIndex = 0;
  let m;
  while ((m = CONTROL_TAG_RE.exec(source)) !== null) {
    const tag = m[0];
    const tagName = m[1].toLowerCase();
    const line = lineOf(source, m.index);

    const typeMatch = TYPE_ATTR_RE.exec(tag);
    const type = typeMatch ? (typeMatch[1] ?? typeMatch[2] ?? "").toLowerCase() : null;
    if (type && SKIP_TYPES.has(type)) continue;

    const ariaLabelMatch = ARIA_LABEL_RE.exec(tag);
    if (ariaLabelMatch) {
      const literal = ariaLabelMatch[1] ?? ariaLabelMatch[2] ?? ariaLabelMatch[3] ?? ariaLabelMatch[4];
      if (literal === undefined || literal.trim() !== "") continue; // non-empty literal or dynamic expr — assumed fine
    }

    if (ARIA_LABELLEDBY_RE.test(tag)) continue;

    const idMatch = ID_ATTR_RE.exec(tag);
    const id = idMatch ? (idMatch[1] ?? idMatch[2] ?? idMatch[3] ?? idMatch[4] ?? idMatch[5]) : null;
    if (id && labelForIds.has(id)) continue;

    if (isInsideAnySpan(m.index, labelSpans)) continue;

    findings.push({
      file: relPath, line, tag: tagName,
      rule: "missing_form_label",
      severity: "error",
      message: `<${tagName}> has no accessible name — no aria-label, aria-labelledby, associated <label for="...">, or enclosing <label> found. Screen readers announce it as just its element type with no indication of purpose.`,
    });
  }
  return findings;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default .html/.htm/.jsx/.tsx).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, truncated, findings}}
 */
function findMissingFormLabel(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_form_label: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_form_label: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_form_label: extensions must be an array of strings.", -32602);

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

module.exports = { findMissingFormLabel };
