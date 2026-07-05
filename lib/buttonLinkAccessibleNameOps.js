"use strict";
// ── FIND_MISSING_BUTTON_ACCESSIBLE_NAME — <button>/<a> accessible-name scan ─
// A <button> or <a> with no visible text and no aria-label is announced by
// screen readers as just "button" / "link" with zero indication of what it
// does — one of the most common front-end accessibility bugs (icon-only
// buttons, icon-only links). Third sibling in this server's front-end
// accessibility family, after find_missing_img_alt_text and
// find_missing_form_label.
//
// An accessible name is considered present if ANY of:
//   1. Non-empty text content directly between the opening and closing tag,
//      after stripping nested tags (e.g. <button><span class="icon"/>Save</button>
//      counts "Save" as the name; pure whitespace/nested-tags-only does not).
//   2. `aria-label="..."` (or JSX `aria-label={...}`) with non-empty content.
//   3. `aria-labelledby="..."` present at all (referenced id's existence is
//      not verified — trusted at face value, same convention as
//      find_missing_form_label).
//   4. `title="..."` with non-empty content (a weaker but real accessible-name
//      source per the HTML accessible-name algorithm — flagged as a separate,
//      lower-severity finding since title-only names are commonly considered
//      a code-smell despite technically working).
//
// A <button>/<a> containing an <img>/<svg> child with its own accessible
// name (alt text / aria-label on the child) is also considered named — the
// icon itself carries the label.
//
// Deliberately NOT flagged / documented caveats (same "skip, don't guess"
// convention as the rest of this tool family):
//   - Self-closing/void `<a />` (no closing tag reachable) is skipped — real
//     anchors always need a closing tag with content, so this shape is rare
//     and usually a custom/JSX component, not a real link.
//   - Pure text-scan (non-greedy regex tag-content match), not an HTML/JSX
//     parser — deeply nested same-name tags or a stray '>' inside a JSX
//     expression attribute can misplace a tag boundary (same limitation as
//     the other tools in this family).
//   - Custom component wrappers (e.g. <Button icon="..." />) that render a
//     real <button>/<a> under the hood are invisible to this scan.
//   - `disabled` buttons are still checked — a disabled control can become
//     enabled later and screen readers still announce disabled elements.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// Non-greedy match of a <button ...>...</button> or <a ...>...</a> element,
// including its inner content, so nested markup can be inspected.
const ELEMENT_RE = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const ARIA_LABEL_RE = /\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\}|\{[^}]*\})/i;
const ARIA_LABELLEDBY_RE = /\baria-labelledby\s*=/i;
const TITLE_RE = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\})/i;
const CHILD_ALT_RE = /<(?:img|svg)\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const CHILD_ARIA_LABEL_RE = /<(?:img|svg)\b[^>]*\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const STRIP_TAGS_RE = /<[^>]*>/g;
const JSX_EXPR_ONLY_RE = /^\{[^{}]*\}$/; // e.g. {label} — dynamic, can't statically evaluate, assumed fine

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

function hasTextContent(inner) {
  const text = inner.replace(STRIP_TAGS_RE, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (JSX_EXPR_ONLY_RE.test(trimmed)) return true; // dynamic expression — assumed fine, can't statically evaluate
  return trimmed.length > 0;
}

function childCarriesName(inner) {
  const altMatch = CHILD_ALT_RE.exec(inner);
  if (altMatch) {
    const alt = altMatch[1] ?? altMatch[2];
    if (alt && alt.trim() !== "") return true;
  }
  const ariaMatch = CHILD_ARIA_LABEL_RE.exec(inner);
  if (ariaMatch) {
    const label = ariaMatch[1] ?? ariaMatch[2];
    if (label && label.trim() !== "") return true;
  }
  return false;
}

function scanFile(relPath, source) {
  const findings = [];
  ELEMENT_RE.lastIndex = 0;
  let m;
  while ((m = ELEMENT_RE.exec(source)) !== null) {
    const tagName = m[1].toLowerCase();
    const attrs = m[2];
    const inner = m[3];
    const line = lineOf(source, m.index);

    if (hasTextContent(inner)) continue;

    const ariaLabelMatch = ARIA_LABEL_RE.exec(attrs);
    if (ariaLabelMatch) {
      const literal = ariaLabelMatch[1] ?? ariaLabelMatch[2] ?? ariaLabelMatch[3] ?? ariaLabelMatch[4];
      if (literal === undefined || literal.trim() !== "") continue; // non-empty literal or dynamic expr — assumed fine
    }

    if (ARIA_LABELLEDBY_RE.test(attrs)) continue;

    if (childCarriesName(inner)) continue;

    const titleMatch = TITLE_RE.exec(attrs);
    const title = titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? titleMatch[4] ?? titleMatch[5]) : null;
    if (title && title.trim() !== "") {
      findings.push({
        file: relPath, line, tag: tagName,
        rule: "title_only_accessible_name",
        severity: "warning",
        message: `<${tagName}> has no visible text or aria-label — only a title="${title}" attribute, which technically provides an accessible name but is not exposed as a tooltip on all devices/inputs and is broadly considered a weak substitute. Prefer aria-label or visible text.`,
      });
      continue;
    }

    findings.push({
      file: relPath, line, tag: tagName,
      rule: "missing_accessible_name",
      severity: "error",
      message: `<${tagName}> has no accessible name — no visible text content, aria-label, aria-labelledby, or labeled icon child found. Screen readers announce it as just "${tagName === "a" ? "link" : "button"}" with no indication of purpose.`,
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
function findMissingButtonAccessibleName(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_button_accessible_name: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_button_accessible_name: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_button_accessible_name: extensions must be an array of strings.", -32602);

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

module.exports = { findMissingButtonAccessibleName };
