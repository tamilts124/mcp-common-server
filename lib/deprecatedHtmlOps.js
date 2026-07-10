"use strict";
/**
 * find_deprecated_html_elements
 *
 * Scans HTML/HTM/JSX/TSX files for deprecated or discouraged HTML elements.
 *
 * Two rules:
 *   deprecated_html_element (error) — element was removed or deprecated in HTML5:
 *     <font>, <center>, <marquee>, <blink>, <frameset>, <frame>, <noframes>,
 *     <big>, <applet>, <basefont>, <dir>, <isindex>, <plaintext>, <xmp>,
 *     <listing>, <spacer>, <strike>, <tt>
 *   discouraged_html_element (warning) — element still technically valid but
 *     superseded by better semantic/CSS alternatives:
 *     <b> (use <strong>), <i> (use <em>), <s> (use <del>), <u> (use CSS text-decoration)
 *
 * Siblings: find_missing_doctype, find_missing_lang_attribute, find_missing_meta_charset
 */
const fs = require("fs");
const path = require("path");

// Elements removed/deprecated in HTML5 — opening tags (with optional attributes)
const DEPRECATED_TAGS = new Set([
  "font", "center", "marquee", "blink", "frameset", "frame", "noframes",
  "big", "applet", "basefont", "dir", "isindex", "plaintext", "xmp",
  "listing", "spacer", "strike", "tt",
]);

// Discouraged (still valid, but semantic/CSS alternatives preferred)
const DISCOURAGED_TAGS = {
  b: "use <strong> for semantic importance, or CSS font-weight for purely presentational bold",
  i: "use <em> for semantic emphasis, or CSS font-style for purely presentational italics",
  s: "use <del> for document-revision deletions, or CSS text-decoration:line-through for visual strikethrough",
  u: "use CSS text-decoration:underline instead; <u> is often confused with hyperlinks by users",
};

// Match opening tags: <tagname> or <tagname ... > (with optional attributes)
// We detect the tag name right after '<'
const OPEN_TAG_RE = /<([a-z][a-z0-9]*)(\s[^>]*)?\/?>|<\/([a-z][a-z0-9]*)>/gi;

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx"];

/**
 * Scan a single file for deprecated/discouraged HTML elements.
 * @returns {Array<{file,line,tag,rule,severity,alternative?,message}>}
 */
function scanFile(filePath, origFile) {
  let src;
  try {
    src = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return [];
  }
  const lines = src.split(/\n/);
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    OPEN_TAG_RE.lastIndex = 0;
    let m;
    while ((m = OPEN_TAG_RE.exec(line)) !== null) {
      // m[1] = opening tag name, m[3] = closing tag name
      const tagName = (m[1] || m[3] || "").toLowerCase();
      if (!tagName) continue;

      // Only flag opening tags (not closing) — one finding per element instance
      if (m[3]) continue; // closing tag, skip

      if (DEPRECATED_TAGS.has(tagName)) {
        findings.push({
          file: origFile,
          line: lineNo,
          tag: `<${tagName}>`,
          rule: "deprecated_html_element",
          severity: "error",
          message: `<${tagName}> is a deprecated HTML element removed in HTML5 — replace with a semantic equivalent or CSS.`,
        });
      } else if (DISCOURAGED_TAGS[tagName]) {
        findings.push({
          file: origFile,
          line: lineNo,
          tag: `<${tagName}>`,
          rule: "discouraged_html_element",
          severity: "warning",
          alternative: DISCOURAGED_TAGS[tagName],
          message: `<${tagName}> is discouraged — ${DISCOURAGED_TAGS[tagName]}.`,
        });
      }
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
function findDeprecatedHtmlElements(resolvedPath, origPath, opts = {}) {
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
  } catch (_) {
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

module.exports = { findDeprecatedHtmlElements };
