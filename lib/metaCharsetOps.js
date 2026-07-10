"use strict";
/**
 * find_missing_meta_charset
 *
 * Scans HTML/HTM files for the absence of a <meta charset="..."> declaration
 * (or the legacy <meta http-equiv="Content-Type" content="text/html; charset=...">).
 *
 * Without an explicit charset the browser sniffs the encoding, which can lead
 * to mojibake (garbled text), and historically to UTF-7 XSS attacks.
 *
 * Two rules:
 *   missing_meta_charset (error)  — no charset declaration found at all.
 *   charset_not_utf8    (warning) — charset declared but value is not UTF-8
 *     (nor the canonical alias utf8 without the hyphen).
 *
 * Best practice: <meta charset="UTF-8"> as the FIRST element inside <head>.
 * Only scans .html/.htm by default.
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".html", ".htm"];

// HTML5 short form: <meta charset="VALUE"> or <meta charset=VALUE>
// Only looks at charset= as a standalone attribute (not inside content="...").
// We collect all <meta ...> tags and check each one individually.
const META_TAG_RE = /<meta(\b[^>]*)>/gi;
const CHARSET_ATTR_RE = /\bcharset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]*))/i;
const HTTP_EQUIV_RE   = /\bhttp-equiv\s*=\s*(?:"content-type"|'content-type')/i;
const CONTENT_CS_RE   = /\bcontent\s*=\s*(?:"[^"]*charset\s*=\s*([^\s"';>]+)[^"]*"|'[^']*charset\s*=\s*([^\s"';>]+)[^']*')/i;

function extractCharset(src) {
  // Scan every <meta> tag in the file
  let m;
  META_TAG_RE.lastIndex = 0;
  while ((m = META_TAG_RE.exec(src)) !== null) {
    const attrs = m[1];
    const idx   = m.index;

    // HTML5: <meta charset="...">
    const cs = CHARSET_ATTR_RE.exec(attrs);
    if (cs) {
      const charset = (cs[1] ?? cs[2] ?? cs[3] ?? "").trim();
      return { charset, re: { index: idx } };
    }

    // Legacy: <meta http-equiv="Content-Type" content="...; charset=VALUE">
    if (HTTP_EQUIV_RE.test(attrs)) {
      const cont = CONTENT_CS_RE.exec(attrs);
      if (cont) {
        const charset = (cont[1] ?? cont[2] ?? "").trim();
        return { charset, re: { index: idx } };
      }
    }
  }
  return null;
}

function scanFile(filePath, origFile) {
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); }
  catch (_) { return []; }

  const findings = [];
  const result   = extractCharset(src);

  if (!result) {
    // Find a good hint line (first </head> or <body or <html)
    const lines   = src.split(/\n/);
    let hintLine = 1;
    for (let i = 0; i < lines.length; i++) {
      if (/<head|<html/i.test(lines[i])) { hintLine = i + 1; break; }
    }
    findings.push({
      file: origFile, line: hintLine,
      rule: "missing_meta_charset",
      severity: "error",
      message: `No <meta charset="..."> (or legacy http-equiv Content-Type charset) found. Without it the browser sniffs the encoding, risking mojibake and legacy XSS attacks. Add <meta charset="UTF-8"> as the first element inside <head>.`,
    });
    return findings;
  }

  // Charset declared — verify it is UTF-8 (or the alias utf8)
  const val = result.charset.toLowerCase().replace(/-/g, "");
  if (val !== "utf8") {
    const before = src.slice(0, result.re.index);
    const line   = before.split(/\n/).length; // re.index is always a number now
    findings.push({
      file: origFile, line,
      rule: "charset_not_utf8",
      severity: "warning",
      message: `Charset declared as "${result.charset}" instead of UTF-8. Modern HTML documents should use UTF-8 to ensure broadest compatibility and avoid encoding issues.`,
    });
  }

  return findings;
}

function collectFiles(dir, extensions, files = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return files; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      collectFiles(path.join(dir, e.name), extensions, files);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (extensions.includes(ext)) files.push(path.join(dir, e.name));
    }
  }
  return files;
}

function findMissingMetaCharset(resolvedPath, origPath, opts = {}) {
  const extensions = Array.isArray(opts.extensions)
    ? opts.extensions.map(e => e.toLowerCase())
    : DEFAULT_EXTENSIONS;
  const maxResults = typeof opts.maxResults === "number" ? opts.maxResults : 500;
  if (maxResults < 1 || maxResults > 5000) {
    const err = new Error("max_results must be between 1 and 5000");
    err.code = -32602; throw err;
  }

  let stat;
  try { stat = fs.statSync(resolvedPath); }
  catch (_) {
    const err = new Error(`Path not found or not accessible: ${origPath}`);
    err.code = -32602; throw err;
  }

  let filePaths;
  if (stat.isFile()) filePaths = [resolvedPath];
  else if (stat.isDirectory()) filePaths = collectFiles(resolvedPath, extensions);
  else {
    const err = new Error(`Path is neither a file nor a directory: ${origPath}`);
    err.code = -32602; throw err;
  }

  let allFindings = [];
  let filesScanned = 0;

  for (const fp of filePaths) {
    const displayFile = stat.isDirectory()
      ? origPath.replace(/[\\/]+$/, "") + "/" + path.relative(resolvedPath, fp).replace(/\\/g, "/")
      : origPath;
    allFindings = allFindings.concat(scanFile(fp, displayFile));
    filesScanned++;
  }

  allFindings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  let truncated = false;
  if (allFindings.length > maxResults) { allFindings = allFindings.slice(0, maxResults); truncated = true; }

  return {
    path: origPath,
    filesScanned,
    findingsCount: allFindings.length,
    errorCount:   allFindings.filter(f => f.severity === "error").length,
    warningCount: allFindings.filter(f => f.severity === "warning").length,
    truncated,
    findings: allFindings,
  };
}

module.exports = { findMissingMetaCharset };
