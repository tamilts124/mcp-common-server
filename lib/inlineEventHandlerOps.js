"use strict";
/**
 * find_inline_event_handlers
 *
 * Scans HTML/JSX/HTML-in-JS for inline event handler attributes like
 * onclick="...", onload="...", onerror="...", href="javascript:...", etc.
 *
 * Two rules:
 *   inline_event_handler (error) — a literal `on<event>="<JS>"` or
 *     `on<event>='<JS>'` attribute with a non-empty JS expression value.
 *     Also catches JSX `on<Event>={...}` only when value is a literal string
 *     (not a JSX expression, which is the correct JSX pattern).
 *   javascript_href (error) — `href="javascript:..."` / `href='javascript:...'`
 *     which is also CSP-violating and semantically problematic.
 *
 * Suppresses:
 *   - `on<event>=""` / `on<event>=''` (empty handlers)
 *   - JSX `on<Event>={expr}` form (curly-brace expression — correct pattern)
 *
 * Security sibling of: check_missing_csp_header, find_missing_rel_noopener
 */
const fs = require("fs");
const path = require("path");

// All standard HTML event attribute names (case-insensitive prefix match)
// We use a regex that matches on<word> attribute names.
const INLINE_EVENT_RE = /\bon([a-z]{2,20})\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
// javascript: href
const JS_HREF_RE = /\bhref\s*=\s*(?:"(javascript:[^"]+)"|'(javascript:[^']+)')/gi;

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx", ".js", ".ts"];

/**
 * Scan a single file for inline event handlers.
 * @returns {Array<{file,line,attr,value,rule,severity,message}>}
 */
function scanFile(filePath, origFile) {
  let src;
  try {
    src = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return [];
  }
  const lines = src.split(/\n/);
  const findings = [];

  // Walk line-by-line for accurate line numbers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Reset regex lastIndex before each line
    INLINE_EVENT_RE.lastIndex = 0;
    JS_HREF_RE.lastIndex = 0;

    let m;
    // Check inline event handlers
    while ((m = INLINE_EVENT_RE.exec(line)) !== null) {
      const attr = "on" + m[1].toLowerCase();
      const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : "");
      // Skip empty handlers
      if (!value.trim()) continue;
      findings.push({
        file: origFile,
        line: lineNo,
        attr,
        value: value.length > 80 ? value.slice(0, 77) + "..." : value,
        rule: "inline_event_handler",
        severity: "error",
        message: `Inline event handler '${attr}' violates Content-Security-Policy — move handler to external JS file.`,
      });
    }

    // Check javascript: href
    while ((m = JS_HREF_RE.exec(line)) !== null) {
      const value = m[1] || m[2];
      findings.push({
        file: origFile,
        line: lineNo,
        attr: "href",
        value: value.length > 80 ? value.slice(0, 77) + "..." : value,
        rule: "javascript_href",
        severity: "error",
        message: `'href="javascript:..."' violates CSP and is a security/usability anti-pattern — use a proper <button> with an event listener instead.`,
      });
    }
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
function findInlineEventHandlers(resolvedPath, origPath, opts = {}) {
  const extensions = Array.isArray(opts.extensions)
    ? opts.extensions.map(e => e.toLowerCase())
    : DEFAULT_EXTENSIONS;
  const maxResults = typeof opts.maxResults === "number" ? opts.maxResults : 500;

  // Validate
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
    // Compute display path relative to resolvedPath (directory mode) or just origPath (file mode)
    const displayFile = stat.isDirectory()
      ? origPath.replace(/[\\/]+$/, "") + "/" + path.relative(resolvedPath, fp).replace(/\\/g, "/")
      : origPath;
    const found = scanFile(fp, displayFile);
    allFindings = allFindings.concat(found);
    filesScanned++;
  }

  // Sort by file then line
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

module.exports = { findInlineEventHandlers };
