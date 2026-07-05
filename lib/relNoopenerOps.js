"use strict";
// ── FIND_MISSING_REL_NOOPENER — target="_blank" reverse-tabnabbing scan ────
// An <a target="_blank"> link (HTML or JSX) without rel="noopener" (or
// rel="noreferrer", which implies noopener behavior too) leaves the new tab
// with a `window.opener` handle back to the originating page. A malicious
// destination can then run `window.opener.location = 'https://evil...'` and
// silently repoint the ORIGINAL tab to a phishing page while the user is
// looking at the new one — the "reverse tabnabbing" attack. Modern Chromium/
// Firefox auto-imply noopener for target="_blank" navigations in many cases,
// but this is engine-version-dependent behavior, not a markup guarantee —
// explicit rel="noopener" is still the correct, portable fix and the
// standard lint rule (react/jsx-no-target-blank, eslint-plugin-react) that
// this tool mirrors as a static, dependency-free scan. Sibling to
// find_open_redirect_risks/scan_cors_misconfig in this server's security-scan
// family (not the front-end-accessibility family — this is a security
// concern, not a screen-reader concern).
//
// Detection: any <a ...> tag with a literal target="_blank"/target='_blank'
// (or JSX target={"_blank"}/target={'_blank'}) whose full tag text has no
// rel= attribute containing "noopener" or "noreferrer" -> `missing_rel_noopener`
// (error).
//
// Deliberately NOT flagged / documented caveats (same "skip, don't guess"
// convention as the rest of this tool family):
//   - A JSX dynamic target (`target={someVar}`) is skipped entirely — can't
//     statically determine whether the runtime value is ever "_blank".
//   - A JSX dynamic/spread rel (`rel={someVar}`, `{...props}`) is treated as
//     "might already be safe" and NOT flagged — can't statically prove the
//     spread doesn't already carry noopener, and a false positive here is
//     worse than a false negative for a scan that's meant to be a review aid.
//   - Pure text-scan (non-greedy regex over `<a\b[^>]*>` tag bodies), not an
//     HTML/JSX parser: a stray '>' inside a JSX expression attribute value
//     can misplace a tag boundary, same documented caveat as this server's
//     other markup-scanning tools (find_missing_img_alt_text, etc.).
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// Non-greedy <a ...> tag match (same convention as buttonLinkAccessibleNameOps).
const A_TAG_RE = /<a\b[^>]*>/gi;
const TARGET_BLANK_RE = /\btarget\s*=\s*(?:"_blank"|'_blank'|\{"_blank"\}|\{'_blank'\})/i;
const TARGET_DYNAMIC_RE = /\btarget\s*=\s*\{[^}]*\}/i;
const REL_ATTR_RE = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|\{"([^"]*)"\}|\{'([^']*)'\})/i;
const REL_DYNAMIC_RE = /\brel\s*=\s*\{[^}]*\}/i;
const SPREAD_PROPS_RE = /\{\s*\.\.\./;

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
  A_TAG_RE.lastIndex = 0;
  let m;
  while ((m = A_TAG_RE.exec(source)) !== null) {
    const tag = m[0];

    // Only tags with a literal target="_blank" are in scope. A dynamic
    // target={var} can't be statically resolved -> skip entirely.
    if (!TARGET_BLANK_RE.test(tag)) {
      if (TARGET_DYNAMIC_RE.test(tag)) continue; // dynamic, can't evaluate
      continue; // no target="_blank" at all, not in scope
    }

    // Spread props might already carry a safe rel -> don't guess, skip.
    if (SPREAD_PROPS_RE.test(tag)) continue;

    const relMatch = REL_ATTR_RE.exec(tag);
    if (relMatch) {
      const relValue = (relMatch[1] ?? relMatch[2] ?? relMatch[3] ?? relMatch[4] ?? "").toLowerCase();
      if (relValue.includes("noopener") || relValue.includes("noreferrer")) continue; // safe
    } else if (REL_DYNAMIC_RE.test(tag)) {
      continue; // dynamic rel={var}, can't evaluate — don't guess
    }

    const line = lineOf(source, m.index);
    findings.push({
      file: relPath,
      line,
      rule: "missing_rel_noopener",
      severity: "error",
      message: `<a target="_blank"> with no rel="noopener"/"noreferrer" leaves window.opener accessible to the destination page — a reverse-tabnabbing risk (the new page can silently repoint this tab to a phishing URL). Add rel="noopener noreferrer".`,
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
function findMissingRelNoopener(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_rel_noopener: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_rel_noopener: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_rel_noopener: extensions must be an array of strings.", -32602);

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

module.exports = { findMissingRelNoopener };
