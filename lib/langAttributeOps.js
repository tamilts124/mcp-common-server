"use strict";
/**
 * find_missing_lang_attribute
 *
 * Scans HTML/HTM files for <html> tags missing a lang= attribute.
 * WCAG 2.0 Success Criterion 3.1.1 (Level A): the page language must be
 * identified so screen readers can apply the correct pronunciation rules.
 *
 * Two rules:
 *   missing_lang_attribute (error)  — no lang= on the <html> tag.
 *   empty_lang_attribute   (error)  — lang="" / lang='' (blank is invalid).
 *   numeric_lang_attribute (warning)— lang is present but its value doesn't
 *     look like a valid BCP 47 tag (e.g. lang="123").
 *
 * Only scans .html/.htm by default.
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".html", ".htm"];

// Regex that captures the full opening <html ...> tag (handles multiline via \r\n etc)
const HTML_TAG_RE = /<html(\b[^>]*)>/i;
// BCP 47: starts with 2-3 alpha, optional subtags
const BCP47_RE    = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/;

function scanFile(filePath, origFile) {
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); }
  catch (_) { return []; }

  const findings = [];
  const m = HTML_TAG_RE.exec(src);
  if (!m) return findings; // no <html> tag at all — not an issue for this tool

  // Find line number of the <html> tag
  const before = src.slice(0, m.index);
  const line   = before.split(/\n/).length;

  const attrs  = m[1];
  const langM  = /\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(attrs);

  if (!langM) {
    findings.push({
      file: origFile, line,
      rule: "missing_lang_attribute",
      severity: "error",
      message: `<html> tag has no lang= attribute — screen readers won't know the page language (WCAG 3.1.1). Add e.g. lang="en".`,
    });
    return findings;
  }

  const langVal = (langM[1] ?? langM[2] ?? langM[3] ?? "").trim();

  if (langVal === "") {
    findings.push({
      file: origFile, line,
      rule: "empty_lang_attribute",
      severity: "error",
      message: `<html lang=""> is an empty string — an empty lang value is invalid. Provide a valid BCP 47 language code (e.g. lang="en" or lang="en-US").`,
    });
    return findings;
  }

  if (!BCP47_RE.test(langVal)) {
    findings.push({
      file: origFile, line,
      rule: "invalid_lang_value",
      severity: "warning",
      message: `<html lang="${langVal}"> doesn't look like a valid BCP 47 language tag. Expected a 2-3 letter language code, optionally followed by subtags (e.g. "en", "en-US", "zh-Hant").`,
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

function findMissingLangAttribute(resolvedPath, origPath, opts = {}) {
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

module.exports = { findMissingLangAttribute };
