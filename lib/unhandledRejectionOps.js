"use strict";
/**
 * find_unhandled_rejection_patterns
 *
 * Scans JS/TS entry-point files and project-wide for common patterns that
 * indicate unhandled promise rejections could crash the server:
 *
 * Two rules:
 *   missing_global_rejection_handler (warning) — entry-point-like files
 *     (server.js, app.js, index.js, main.js) have no
 *     `process.on('unhandledRejection', ...)` call. Without this, Node.js
 *     15+ crashes on any unhandled rejection.
 *
 *   noop_rejection_handler (error) — `process.on('unhandledRejection', () => {})`
 *     or `process.on('unhandledRejection', err => { })` — a handler with an
 *     empty body that explicitly swallows errors silently is worse than none (it hides
 *     real bugs).
 *
 * Siblings: find_missing_try_catch_in_async, find_dangling_promises,
 *   find_empty_catch_blocks
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

// Entry-point filename patterns
const ENTRY_POINT_RE = /^(server|app|index|main|start|bootstrap|entry)(\.\w+)?$/i;

// Matches process.on('unhandledRejection', ...) or process.on("unhandledRejection", ...)
const HANDLER_RE = /process\.on\s*\(\s*['"`]unhandledRejection['"`]\s*,/g;

// Matches a no-op handler pattern: `() => {}` or `(_) => {}` or `err => {}` with only whitespace/comments in body
const NOOP_ARROW_RE = /process\.on\s*\(\s*['"`]unhandledRejection['"`]\s*,\s*(?:[A-Za-z_$][\w$]*|\([^)]*\))\s*=>\s*\{\s*(?:\/\*[^*]*\*\/|\s)*\}/g;

// Also match: process.on('unhandledRejection', function() {})
const NOOP_FUNC_RE = /process\.on\s*\(\s*['"`]unhandledRejection['"`]\s*,\s*function\s*[^)]*\)\s*\{\s*(?:\/\*[^*]*\*\/|\s)*\}/g;

/**
 * Scan a single file.
 * @returns {Array<{file,line,rule,severity,message}>}
 */
function scanFile(filePath, origFile, isEntryPoint) {
  let src;
  try {
    src = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return [];
  }

  const lines = src.split(/\n/);
  const findings = [];

  // Check for noop handler (error) — project-wide, not just entry points
  NOOP_ARROW_RE.lastIndex = 0;
  NOOP_FUNC_RE.lastIndex  = 0;

  let m;
  while ((m = NOOP_ARROW_RE.exec(src)) !== null) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    findings.push({
      file: origFile,
      line: lineNo,
      rule: "noop_rejection_handler",
      severity: "error",
      message:
        "`process.on('unhandledRejection', ...)` is registered with an empty/no-op handler. " +
        "This silently swallows all unhandled rejections, hiding real bugs. " +
        "Log the error and optionally exit: `(reason, promise) => { console.error(reason); process.exit(1); }`.",
    });
  }

  while ((m = NOOP_FUNC_RE.exec(src)) !== null) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    // Don't double-report if already caught by arrow RE
    if (!findings.some(f => f.line === lineNo && f.rule === "noop_rejection_handler")) {
      findings.push({
        file: origFile,
        line: lineNo,
        rule: "noop_rejection_handler",
        severity: "error",
        message:
          "`process.on('unhandledRejection', function() {...})` is registered with an empty/no-op handler. " +
          "This silently swallows all unhandled rejections, hiding real bugs. " +
          "Log the error and optionally exit: `(reason) => { console.error(reason); process.exit(1); }`.",
      });
    }
  }

  // Check entry points for missing handler
  if (isEntryPoint) {
    HANDLER_RE.lastIndex = 0;
    const hasHandler = HANDLER_RE.test(src);
    if (!hasHandler) {
      findings.push({
        file: origFile,
        line: 1,
        rule: "missing_global_rejection_handler",
        severity: "warning",
        message:
          `Entry-point file \`${path.basename(origFile)}\` has no ` +
          "`process.on('unhandledRejection', ...)` handler. " +
          "In Node.js 15+ unhandled promise rejections crash the process. " +
          "Add: `process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled rejection:', reason); process.exit(1); });`",
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
function findUnhandledRejectionPatterns(resolvedPath, origPath, opts = {}) {
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
    // Determine if this is an entry-point file
    const baseName = path.basename(fp, path.extname(fp));
    const isEntry  = ENTRY_POINT_RE.test(baseName);
    const found = scanFile(fp, displayFile, isEntry);
    allFindings = allFindings.concat(found);
    filesScanned++;
  }

  allFindings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

  let truncated = false;
  if (allFindings.length > maxResults) {
    allFindings = allFindings.slice(0, maxResults);
    truncated = true;
  }

  const errorCount   = allFindings.filter(f => f.severity === "error").length;
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

module.exports = { findUnhandledRejectionPatterns };
