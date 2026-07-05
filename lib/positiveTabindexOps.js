"use strict";
// ── FIND_POSITIVE_TABINDEX — tabindex > 0 anti-pattern scan ────────────────
// A positive tabindex (tabindex="1", tabIndex={2}, ...) pulls an element out
// of the natural DOM tab order and forces it to be visited before every
// tabindex="0"/unset element on the page, in ascending numeric order. WCAG
// 2.4.3 flags this as a well-known accessibility anti-pattern: it is almost
// always a copy-paste/"make it focusable" mistake, and once two components
// on the same page each use positive tabindex independently, their authors
// can't reason about the resulting order at all. Fourth sibling in this
// server's front-end-accessibility family (after find_missing_img_alt_text,
// find_missing_form_label, find_missing_button_accessible_name,
// find_duplicate_html_id).
//
// Detection: literal `tabindex="N"`/`tabindex='N'` (HTML) or JSX
// `tabIndex={N}`/`tabIndex="N"`/`tabIndex='N'` where N is an integer > 0.
// `tabindex="0"` (natural order, added focusability) and `tabindex="-1"`
// (programmatic-only focus) are the two well-established legitimate values
// and are never flagged. A JSX dynamic expression (`tabIndex={variable}`)
// is skipped entirely — can't statically know the runtime value.
//
// Deliberately NOT flagged / documented caveats (same "skip, don't guess"
// convention as the rest of this tool family):
//   - Non-integer / malformed values (`tabindex="abc"`) are skipped; that's
//     invalid markup, not a tab-order bug, and out of scope for this tool.
//   - Pure text-scan (regex over `tabindex=`/`tabIndex=` attributes across
//     the whole file, not scoped to any particular tag name), not an
//     HTML/JSX parser — a matching attribute name appearing inside a
//     comment or an unrelated string literal can produce a false positive.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// HTML tabindex="N"/'N' or JSX tabIndex={N}/"N"/'N'. Bare {expr} (no digits
// captured) is dynamic and skipped.
const TABINDEX_RE = /\b(?:tabindex|tabIndex)\s*=\s*(?:"(-?\d+)"|'(-?\d+)'|\{(-?\d+)\}|\{[^}]*\})/g;

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
  TABINDEX_RE.lastIndex = 0;
  let m;
  while ((m = TABINDEX_RE.exec(source)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw === undefined) continue; // dynamic expression, can't statically evaluate
    const value = parseInt(raw, 10);
    if (!Number.isInteger(value) || value <= 0) continue; // 0 and -1 are legitimate; skip
    const line = lineOf(source, m.index);
    findings.push({
      file: relPath,
      line,
      value,
      rule: "positive_tabindex",
      severity: "warning",
      message: `tabindex="${value}" pulls this element out of the natural DOM tab order and forces it before every tabindex="0"/unset element in ascending order — a well-known WCAG 2.4.3 anti-pattern. Use tabindex="0" (natural order) or reorder the markup instead.`,
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
function findPositiveTabindex(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_positive_tabindex: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_positive_tabindex: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_positive_tabindex: extensions must be an array of strings.", -32602);

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

module.exports = { findPositiveTabindex };
