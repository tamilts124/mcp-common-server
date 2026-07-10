"use strict";
/**
 * find_missing_viewport_meta
 *
 * Scans HTML/HTM files for the absence of a <meta name="viewport"> tag.
 * Without it, mobile browsers use a desktop layout, making text unreadable
 * and touch targets too small.
 *
 * Two rules:
 *   missing_viewport_meta (error) — no <meta ... name="viewport" found.
 *   viewport_missing_width_device_width (warning) — viewport meta present but
 *     content attribute lacks width=device-width.
 *
 * Only scans .html/.htm by default (viewport belongs in base HTML templates).
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".html", ".htm"];

// Matches any <meta ... > tag (may be multiline-ish but we check per-file)
// We do a case-insensitive file-level check rather than per-line since the
// viewport meta might span a line.
const VIEWPORT_META_RE = /<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i;
const VIEWPORT_META_RE2 = /<meta[^>]+content\s*=\s*["'][^"']*["'][^>]+name\s*=\s*["']viewport["'][^>]*>/i;
const WIDTH_DEVICE_WIDTH_RE = /width\s*=\s*device-width/i;

/**
 * Scan a single HTML file for viewport meta issues.
 * Returns array of findings.
 */
function scanFile(filePath, origFile) {
  let src;
  try {
    src = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return [];
  }

  const findings = [];

  // Find <meta name="viewport"> — may be in either attribute order
  const hasViewport = VIEWPORT_META_RE.test(src) || VIEWPORT_META_RE2.test(src);

  if (!hasViewport) {
    // Find line number of </head> or <body> as a hint — default to line 1
    const lines = src.split(/\n/);
    let hintLine = 1;
    for (let i = 0; i < lines.length; i++) {
      if (/<\/head>|<body/i.test(lines[i])) {
        hintLine = i + 1;
        break;
      }
    }
    findings.push({
      file: origFile,
      line: hintLine,
      rule: "missing_viewport_meta",
      severity: "error",
      message: "No <meta name=\"viewport\"> found — mobile browsers will render a desktop layout, making text tiny and touch targets too small. Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> inside <head>.",
    });
    return findings;
  }

  // Viewport meta present — check for width=device-width in content
  // Extract all <meta ...> tags and check the viewport one
  const metaTagRe = /<meta[^>]+>/gi;
  let m;
  let foundWidthDeviceWidth = false;
  while ((m = metaTagRe.exec(src)) !== null) {
    const tag = m[0];
    if (/name\s*=\s*["']viewport["']/i.test(tag)) {
      if (WIDTH_DEVICE_WIDTH_RE.test(tag)) {
        foundWidthDeviceWidth = true;
      }
      break;
    }
  }

  if (!foundWidthDeviceWidth) {
    // Find line number of the viewport meta tag
    const lines = src.split(/\n/);
    let viewportLine = 1;
    for (let i = 0; i < lines.length; i++) {
      if (/name\s*=\s*["']viewport["']/i.test(lines[i])) {
        viewportLine = i + 1;
        break;
      }
    }
    findings.push({
      file: origFile,
      line: viewportLine,
      rule: "viewport_missing_width_device_width",
      severity: "warning",
      message: "<meta name=\"viewport\"> found but content is missing width=device-width — add this value to enable correct mobile scaling (e.g. content=\"width=device-width, initial-scale=1\").",
    });
  }

  return findings;
}

/**
 * Recursively collect files matching extensions from a directory.
 */
function collectFiles(dir, extensions, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return files;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      collectFiles(path.join(dir, e.name), extensions, files);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (extensions.includes(ext)) {
        files.push(path.join(dir, e.name));
      }
    }
  }
  return files;
}

/**
 * Main exported function.
 *
 * @param {string} resolvedPath  - Absolute path (file or directory)
 * @param {string} origPath      - Original client path (for display)
 * @param {object} opts
 * @param {string[]} [opts.extensions] - File extensions to scan
 * @param {number}  [opts.maxResults]  - Cap on findings array length
 */
function findMissingViewportMeta(resolvedPath, origPath, opts = {}) {
  const extensions = Array.isArray(opts.extensions)
    ? opts.extensions.map(e => e.toLowerCase())
    : DEFAULT_EXTENSIONS;
  const maxResults = typeof opts.maxResults === "number" ? opts.maxResults : 500;

  if (maxResults < 1 || maxResults > 5000) {
    const err = new Error("max_results must be between 1 and 5000");
    err.code = -32602;
    throw err;
  }

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (e) {
    const err = new Error(`Path not found or not accessible: ${origPath}`);
    err.code = -32602;
    throw err;
  }

  let filePaths;
  if (stat.isFile()) {
    filePaths = [resolvedPath];
  } else if (stat.isDirectory()) {
    filePaths = collectFiles(resolvedPath, extensions);
  } else {
    const err = new Error(`Path is neither a file nor a directory: ${origPath}`);
    err.code = -32602;
    throw err;
  }

  let allFindings = [];
  let filesScanned = 0;

  for (const fp of filePaths) {
    const displayFile = stat.isDirectory()
      ? origPath.replace(/[\\/]+$/, "") + "/" + path.relative(resolvedPath, fp).replace(/\\/g, "/")
      : origPath;
    const found = scanFile(fp, displayFile);
    allFindings = allFindings.concat(found);
    filesScanned++;
  }

  allFindings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

  let truncated = false;
  if (allFindings.length > maxResults) {
    allFindings = allFindings.slice(0, maxResults);
    truncated = true;
  }

  const errorCount = allFindings.filter(f => f.severity === "error").length;
  const warningCount = allFindings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned,
    findingsCount: allFindings.length,
    errorCount,
    warningCount,
    truncated,
    findings: allFindings,
  };
}

module.exports = { findMissingViewportMeta };
