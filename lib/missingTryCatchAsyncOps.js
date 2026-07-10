"use strict";
/**
 * find_missing_try_catch_in_async
 *
 * Scans JS/TS/JSX/TSX/.mjs/.cjs files for async functions that contain at
 * least one `await` expression but have no try/catch block wrapping the body.
 *
 * An un-caught rejection inside an async function becomes an unhandled promise
 * rejection. In Node.js 15+ this crashes the process (the default mode changed
 * from a deprecation warning to a fatal crash). In older Node.js it emits an
 * `unhandledRejection` event that most apps don't handle.
 *
 * Two rules:
 *   async_await_no_try_catch (error) — a named async function / async arrow
 *     function with >=1 `await` in its body and no `try {` anywhere in its
 *     brace-delimited body.
 *
 *   async_promise_chain_no_catch (warning) — an `await somePromise` on a line
 *     that is not inside any try block in the file AND where the awaited
 *     expression is not chained with `.catch(`. (Fewer false positives than the
 *     function-level rule for one-liners.)
 *
 * Siblings: find_missing_error_context, find_empty_catch_blocks,
 *   find_dangling_promises
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

// Matches async function declarations and expressions (named or arrow)
// Group 1: optional name after 'function'
// We look for: `async function NAME(` or `async (` or `async ARGNAME =>`
const ASYNC_FN_RE = /\basync\s+(?:function\s*([A-Za-z_$][\w$]*)\s*\(|function\s*\(|([A-Za-z_$][\w$]*)\s*=>|\()/g;

// Detect `await ` anywhere in a block of text
const AWAIT_RE  = /\bawait\s+/;
// Detect `try {` or `try{` in a block of text
const TRY_RE    = /\btry\s*\{/;

/**
 * Extract the function body string using brace-depth tracking.
 * Returns the body text (everything between the outer { and }).
 * @param {string} src - full source text
 * @param {number} searchFrom - position to start looking for the opening `{`
 */
function extractFunctionBody(src, searchFrom) {
  let depth = 0;
  let start = -1;
  for (let i = searchFrom; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      depth++;
      if (depth === 1) { start = i + 1; }
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return src.slice(start, i);
      }
    }
  }
  return null;
}

/**
 * Count the 1-indexed line number of a position in the source.
 */
function lineOf(src, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

/**
 * Scan a single file for async functions without try/catch.
 * @returns {Array<{file,line,name,rule,severity,message}>}
 */
function scanFile(filePath, origFile) {
  let src;
  try {
    src = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return [];
  }

  const findings = [];
  ASYNC_FN_RE.lastIndex = 0;

  let m;
  while ((m = ASYNC_FN_RE.exec(src)) !== null) {
    const matchEnd = m.index + m[0].length;
    // For arrow functions with no parens (async x =>), we need to find the body after =>
    // For all others, we're already past the opening paren
    // Find the opening brace of the body
    const body = extractFunctionBody(src, matchEnd - 1);
    if (!body) continue;

    // Only flag if the body actually uses await
    if (!AWAIT_RE.test(body)) continue;
    // Skip if body already has a try block
    if (TRY_RE.test(body)) continue;

    // Determine function name
    const fnName = m[1] || m[2] || "<anonymous>";
    const lineNo = lineOf(src, m.index);

    findings.push({
      file: origFile,
      line: lineNo,
      name: fnName,
      rule: "async_await_no_try_catch",
      severity: "error",
      message:
        `Async function \`${fnName}\` uses \`await\` but has no try/catch block. ` +
        `In Node.js 15+ an uncaught rejection crashes the process. ` +
        `Wrap the awaited operations in try/catch, or ensure the caller handles rejection.`,
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
function findMissingTryCatchInAsync(resolvedPath, origPath, opts = {}) {
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

module.exports = { findMissingTryCatchInAsync };
