"use strict";
/**
 * find_missing_error_context
 *
 * Scans JS/TS/JSX/TSX/.mjs/.cjs files for catch blocks that re-throw an
 * error without wrapping it to preserve the original cause.
 *
 * Node.js 16+ and modern browsers support the `cause` option in the Error
 * constructor: `throw new Error('message', { cause: err })`. Without it,
 * the original stack trace and error type are lost, making debugging
 * significantly harder.
 *
 * Two rules:
 *   bare_rethrow (warning) — `throw err` / `throw error` / `throw e` (the
 *     caught variable) inside a catch block with no wrapping. The original
 *     error information IS preserved (it's the same object), but adding
 *     context at each level helps debugging layered systems.
 *
 *   rethrow_without_cause (error) — `throw new Error('...')` (or
 *     `throw new SomeError('...')`) inside a catch block WITHOUT a
 *     `{ cause: ... }` options object. This is the most harmful pattern:
 *     the original error is completely discarded.
 *
 * Siblings: find_empty_catch_blocks, find_inconsistent_error_response_shape
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

// Match `catch (e)` / `catch (err)` / `catch (error)` / `catch (ex)` / `catch (_)` etc.
// Captures the variable name (group 1)
const CATCH_RE = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;

// Match `throw new SomeError(...)` — captures constructor name (group 1)
const THROW_NEW_RE = /\bthrow\s+new\s+([A-Za-z_$][\w$]*)\s*\(/g;

// Check if a throw-new line contains { cause: (possibly followed by text)
const HAS_CAUSE_RE = /\{\s*cause\s*:/;

/**
 * Extract the body of a catch block.
 * @param {string[]} lines - All source lines
 * @param {number} catchLineIdx - Line index of the catch keyword
 * @param {number} catchEndCol  - Column right after the catch(...) closing paren
 */
function extractCatchBody(lines, catchLineIdx, catchEndCol) {
  let depth = 0;
  let bodyStart = -1;
  const bodyLines = [];

  for (let i = catchLineIdx; i < lines.length; i++) {
    const line = lines[i];
    // On the catch line itself, only start scanning from after the catch(...) paren
    const startCol = (i === catchLineIdx) ? (catchEndCol || 0) : 0;
    for (let k = startCol; k < line.length; k++) {
      const ch = line[k];
      if (ch === "{") {
        depth++;
        if (depth === 1) bodyStart = i;
      } else if (ch === "}" && depth > 0) {
        depth--;
        if (depth === 0) {
          // Include the closing line if we started (handles single-line catch bodies)
          if (bodyStart >= 0) bodyLines.push({ lineNo: i + 1, text: line });
          return bodyLines;
        }
      }
    }
    if (bodyStart >= 0 && bodyLines.length === 0 || (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].lineNo !== i + 1)) {
      if (bodyStart >= 0) bodyLines.push({ lineNo: i + 1, text: line });
    }
  }
  return bodyLines;
}

/**
 * Scan a single file for missing-error-context patterns.
 * @returns {Array<{file,line,catchVar,rule,severity,text,message}>}
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

    // Look for catch blocks
    CATCH_RE.lastIndex = 0;
    let m;
    while ((m = CATCH_RE.exec(line)) !== null) {
      const catchVar = m[1];
      const catchEndCol = m.index + m[0].length;
      // Skip ignored patterns: `_`, `_err` etc.? No — even `_e` deserves a check.
      const bodyLines = extractCatchBody(lines, i, catchEndCol);
      if (bodyLines.length === 0) continue;

      for (const bl of bodyLines) {
        const trimmed = bl.text.trim();

        // Rule 1: rethrow_without_cause — throw new Error(...) without { cause: }
        THROW_NEW_RE.lastIndex = 0;
        let tm;
        while ((tm = THROW_NEW_RE.exec(trimmed)) !== null) {
          // Only flag if no { cause: } on same line
          if (!HAS_CAUSE_RE.test(trimmed)) {
            findings.push({
              file: origFile,
              line: bl.lineNo,
              catchVar,
              constructorName: tm[1],
              rule: "rethrow_without_cause",
              severity: "error",
              text: trimmed.slice(0, 120),
              message:
                `\`throw new ${tm[1]}(...)\` inside a catch block discards the original error — ` +
                `add \`{ cause: ${catchVar} }\` as the second argument to preserve the error chain: ` +
                `\`throw new ${tm[1]}('...', { cause: ${catchVar} })\`.`,
            });
          }
        }

        // Rule 2: bare_rethrow — `throw catchVar;` (re-throws the same object)
        // This is less harmful but worth noting as an improvement opportunity.
        // Pattern: `throw VAR;` where VAR === catchVar
        const bareRethrowRE = new RegExp(
          `^\\bthrow\\s+${catchVar}\\s*;?\\s*$`
        );
        if (bareRethrowRE.test(trimmed)) {
          // Only flag if they're not wrapping it (which is fine)
          findings.push({
            file: origFile,
            line: bl.lineNo,
            catchVar,
            rule: "bare_rethrow",
            severity: "warning",
            text: trimmed.slice(0, 120),
            message:
              `Bare \`throw ${catchVar}\` re-throws the original error unchanged — consider ` +
              `wrapping with context: \`throw new Error('context message', { cause: ${catchVar} })\` ` +
              `to make debugging layered systems easier.`,
          });
        }
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
 * @param {string[]} [opts.extensions]   - File extensions to scan
 * @param {number}  [opts.maxResults]    - Cap on findings array length
 * @param {boolean} [opts.bareRethrowOnly] - Only report bare_rethrow (skip rethrow_without_cause)
 */
function findMissingErrorContext(resolvedPath, origPath, opts = {}) {
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

module.exports = { findMissingErrorContext };
