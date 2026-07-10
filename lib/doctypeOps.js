"use strict";
/**
 * find_missing_doctype
 *
 * Scans HTML/HTM files for a missing or non-standard DOCTYPE declaration.
 * Without <!DOCTYPE html>, browsers switch into "quirks mode" which changes
 * layout, box model, and CSS behaviour unpredictably across browsers.
 *
 * Two rules:
 *   missing_doctype     (error)   — no <!DOCTYPE ...> at all in the file.
 *   non_html5_doctype   (warning) — DOCTYPE present but not the simple
 *                                   HTML5 form `<!DOCTYPE html>` (case-insensitive).
 *
 * Only scans .html/.htm by default.
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".html", ".htm"];

// Any <!DOCTYPE ...> declaration
const DOCTYPE_RE      = /<!DOCTYPE\s+([^>]+)>/i;
// The canonical HTML5 doctype value: just the word "html"
const HTML5_VALUE_RE  = /^html\s*$/i;

function scanFile(filePath, origFile) {
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); }
  catch (_) { return []; }

  const findings = [];
  const m = DOCTYPE_RE.exec(src);

  if (!m) {
    // Find a reasonable hint line (first non-blank line)
    const lines = src.split(/\n/);
    let hintLine = 1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) { hintLine = i + 1; break; }
    }
    findings.push({
      file: origFile, line: hintLine,
      rule: "missing_doctype",
      severity: "error",
      message: `No <!DOCTYPE html> declaration found. Without it browsers enter quirks mode, changing layout, box model, and CSS behaviour unpredictably. Add <!DOCTYPE html> as the very first line.`,
    });
    return findings;
  }

  const before = src.slice(0, m.index);
  const line   = before.split(/\n/).length;
  const value  = m[1].trim();

  if (!HTML5_VALUE_RE.test(value)) {
    findings.push({
      file: origFile, line,
      rule: "non_html5_doctype",
      severity: "warning",
      message: `Non-standard DOCTYPE "<!DOCTYPE ${value}>". Modern HTML should use <!DOCTYPE html> (the simple HTML5 doctype). XHTML/HTML4 doctypes trigger limited-quirks mode in some browsers.`,
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

function findMissingDoctype(resolvedPath, origPath, opts = {}) {
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

module.exports = { findMissingDoctype };
