"use strict";
/**
 * find_missing_aria_role
 *
 * Scans HTML/HTM/JSX/TSX files for interactive custom elements — specifically
 * <div> or <span> (and their JSX equivalents) that have a mouse/keyboard event
 * handler attached — but carry no `role=` attribute.
 *
 * Without a role, screen readers announce these elements as generic text
 * containers and keyboard users cannot discover or activate them.
 *
 * Two rules:
 *   missing_aria_role     (error)   — interactive div/span with click/keydown/
 *                                     keypress handler but no role attribute.
 *   role_without_tabindex (warning) — a role IS present but there's no
 *                                     tabIndex/tabindex, making the element
 *                                     unreachable via keyboard Tab navigation.
 *
 * Default extensions: .html, .htm, .jsx, .tsx
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".html", ".htm", ".jsx", ".tsx"];

// Tags we care about
const INTERACTIVE_TAG_RE = /<(div|span)\b([^>]*?)>/gi;

// Event handler attributes (HTML and JSX forms)
const CLICK_HANDLER_RE  = /\bon(?:click|Click)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/i;
const KEY_HANDLER_RE    = /\bon(?:keydown|keypress|keyup|KeyDown|KeyPress|KeyUp)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/i;
const ROLE_RE           = /\brole\s*=\s*(?:"[a-zA-Z-]+"|'[a-zA-Z-]+'|\{[^}]*\})/i;
const TABINDEX_RE       = /\btab(?:index|Index)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|-?\d+)/i;

function getLineNumber(src, index) {
  return src.slice(0, index).split("\n").length;
}

function scanFile(filePath, displayFile) {
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); }
  catch (_) { return []; }

  const findings = [];
  INTERACTIVE_TAG_RE.lastIndex = 0;
  let m;

  while ((m = INTERACTIVE_TAG_RE.exec(src)) !== null) {
    const attrs = m[2];
    const hasClick = CLICK_HANDLER_RE.test(attrs);
    const hasKey   = KEY_HANDLER_RE.test(attrs);
    if (!hasClick && !hasKey) continue;

    const hasRole     = ROLE_RE.test(attrs);
    const hasTabindex = TABINDEX_RE.test(attrs);
    const line        = getLineNumber(src, m.index);
    const tag         = m[1];

    if (!hasRole) {
      const handlerType = hasClick ? "onclick/onClick" : "onkeydown/onKeyDown";
      findings.push({
        file: displayFile,
        line,
        tag,
        rule: "missing_aria_role",
        severity: "error",
        message: `<${tag}> has an interactive handler (${handlerType}) but no role= attribute. Screen readers announce it as a generic container — add role="button" (or another appropriate ARIA role) and tabIndex="0" to make it keyboard-accessible.`,
      });
    } else if (!hasTabindex) {
      findings.push({
        file: displayFile,
        line,
        tag,
        rule: "role_without_tabindex",
        severity: "warning",
        message: `<${tag}> has role= but no tabIndex/tabindex attribute. Without tabIndex="0", keyboard users cannot Tab to this element even though it has an interactive handler.`,
      });
    }

    // Reset sub-regexes after test()
    CLICK_HANDLER_RE.lastIndex = 0;
    KEY_HANDLER_RE.lastIndex   = 0;
    ROLE_RE.lastIndex          = 0;
    TABINDEX_RE.lastIndex      = 0;
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

function findMissingAriaRole(resolvedPath, origPath, opts = {}) {
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
      ? origPath.replace(/[/\\]+$/, "") + "/" + path.relative(resolvedPath, fp).replace(/\\/g, "/")
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

module.exports = { findMissingAriaRole };
