"use strict";
// ── FIND_DUPLICATE_HTML_ID — duplicate `id="..."` attribute scan ───────────
// HTML requires every `id` on a page to be unique: `document.getElementById`
// returns only the first match, CSS `#id` selectors only ever style the
// first element, and (directly relevant to this server's own
// find_missing_form_label tool) a `<label for="x">` associates with
// whichever `id="x"` happens to come first — silently orphaning every
// later duplicate. A duplicate id is a real, easy-to-miss correctness bug,
// not just a style nit. No existing tool in this server checks for it
// (find_duplicate_json_keys/find_duplicate_yaml_keys cover data-file key
// duplication, not markup attribute duplication — a different file format
// and a different kind of "duplicate").
//
// Detection: collect every literal `id="value"`/`id='value'` (and JSX
// `id={`value`}`/`id={"value"}`/`id={'value'}` literal-template forms) found
// in a file, grouped by value; any value appearing 2+ times ->
// `duplicate_id` (error) listing every line it appears on.
//
// Deliberately NOT flagged / documented caveats (same "skip, don't guess"
// convention as the rest of this tool family):
//   - A JSX dynamic expression id (`id={someVar}`, `id={`item-${i}`}`) is
//     skipped entirely — can't statically determine whether two dynamic
//     ids ever collide at runtime (e.g. list items keyed by index are
//     usually fine; a hardcoded fallback might not be).
//   - Duplication is checked per-file only, not across a whole app/bundle —
//     two different files each defining `id="wrapper"` is extremely common
//     (e.g. server-rendered partials) and not itself a bug until they're
//     both mounted on the same page, which this static scan cannot know.
//   - Pure text-scan (regex over generic ` id=` attributes across the whole
//     file, not scoped to any particular tag name), not an HTML/JSX parser —
//     an `id=` appearing inside a comment or a string literal unrelated to
//     markup (e.g. a JS object key rendered as text) can produce a false
//     positive; a stray quote character inside surrounding text is the only
//     other realistic misdetection source.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// Literal id="..." / id='...' / JSX id={`...`}/id={"..."}/id={'...'}.
// A bare {expr} (no capture group matches) is dynamic and skipped.
const ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\}|\{'([^']*)'\}|\{[^}]*\})/gi;

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
  const seen = new Map(); // id value -> [line, line, ...]
  ID_ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ID_ATTR_RE.exec(source)) !== null) {
    const value = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (value === undefined) continue; // dynamic expression, can't statically dedupe
    if (value.trim() === "") continue;  // empty id — not a meaningful reference target
    const line = lineOf(source, m.index);
    if (!seen.has(value)) seen.set(value, []);
    seen.get(value).push(line);
  }
  for (const [value, lines] of seen) {
    if (lines.length < 2) continue;
    findings.push({
      file: relPath,
      line: lines[0],
      id: value,
      occurrences: lines.length,
      lines,
      rule: "duplicate_id",
      severity: "error",
      message: `id="${value}" appears ${lines.length} times in this file (lines ${lines.join(", ")}) — getElementById/CSS #selectors/label-for association only ever resolve to the first match, silently orphaning the rest.`,
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
function findDuplicateHtmlId(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_duplicate_html_id: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_duplicate_html_id: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_duplicate_html_id: extensions must be an array of strings.", -32602);

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

module.exports = { findDuplicateHtmlId };
