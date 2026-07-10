"use strict";
/**
 * find_promise_race_without_timeout
 *
 * Scans JS/TS/JSX/TSX/.mjs/.cjs files for Promise.race([...]) calls that
 * don't include a timeout competitor promise.
 *
 * A common safe pattern for HTTP requests, DB queries, or any async operation
 * is:
 *   Promise.race([
 *     actualOperation(),
 *     new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
 *   ])
 *
 * Without a timeout, Promise.race() only helps choose the FASTEST of
 * concurrent promises — it provides no protection against ALL of them
 * hanging indefinitely.
 *
 * Two rules:
 *   promise_race_no_timeout (error) — `Promise.race([...])` where the
 *     array argument (within the same expression, across up to 10 lines)
 *     contains no visible setTimeout, new Promise with setTimeout, AbortSignal,
 *     or a reference to a well-known timeout helper (common naming: timeout,
 *     withTimeout, raceWithTimeout, deadline).
 *
 *   promise_race_single_item (warning) — `Promise.race([singleItem])` with
 *     only one element visible: a race against a single promise is a no-op
 *     and suggests a misunderstanding of the API.
 *
 * Siblings: find_promise_all_without_catch, find_dangling_promises,
 *   find_missing_stream_error_handler
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

// Detects Promise.race( on a line
const PROMISE_RACE_RE = /\bPromise\.race\s*\(/g;

// Detects timeout-related patterns in a block of text
const TIMEOUT_HINT_RE =
  /\bsetTimeout\b|AbortSignal\s*\.\s*timeout|AbortController|\bwithTimeout\b|\btimeoutPromise\b|\bdeadline\b|\braceTimeout\b|\btimeout\b/i;

// Detects a single-item array  [ ... ] with no inner comma at brace depth 0
function looksLikeSingleItem(chunk) {
  // Strip nested brackets/parens to find top-level commas
  let depth = 0;
  for (const ch of chunk) {
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") {
      if (depth === 0) return false; // malformed, bail
      depth--;
    } else if (ch === "," && depth === 0) {
      return false; // found a top-level comma → multiple items
    }
  }
  return true;
}

/**
 * Scan a single file for Promise.race without timeout.
 * @returns {Array<{file,line,rule,severity,text,message}>}
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
    PROMISE_RACE_RE.lastIndex = 0;
    let m;
    while ((m = PROMISE_RACE_RE.exec(line)) !== null) {
      // Collect a window of up to 15 lines to inspect the array argument
      const window = lines.slice(i, Math.min(i + 15, lines.length)).join(" ");

      // Extract what's inside the outer parens of Promise.race(...)
      // Look for the opening [ after Promise.race(
      const raceIdx = window.indexOf("Promise.race(");
      let arrayChunk = "";
      if (raceIdx !== -1) {
        // Find the '[' after Promise.race(
        const bracketStart = window.indexOf("[", raceIdx + 13);
        if (bracketStart !== -1) {
          // Find matching ']'
          let depth = 0;
          let bracketEnd = -1;
          for (let k = bracketStart; k < window.length; k++) {
            if (window[k] === "[") depth++;
            else if (window[k] === "]") {
              depth--;
              if (depth === 0) { bracketEnd = k; break; }
            }
          }
          if (bracketEnd !== -1) {
            // +1/-1 to strip the outer [ ]
            arrayChunk = window.slice(bracketStart + 1, bracketEnd);
          }
        }
      }

      const text = line.trim().slice(0, 120);

      if (arrayChunk) {
        // Check for timeout patterns
        if (!TIMEOUT_HINT_RE.test(arrayChunk)) {
          findings.push({
            file: origFile,
            line: i + 1,
            rule: "promise_race_no_timeout",
            severity: "error",
            text,
            message:
              "Promise.race() has no visible timeout competitor — if all contestants hang, " +
              "this waits forever. Add a timeout: " +
              "`Promise.race([op(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), MS))])`.",
          });
        }
        // Check for single-item race
        if (looksLikeSingleItem(arrayChunk.trim())) {
          findings.push({
            file: origFile,
            line: i + 1,
            rule: "promise_race_single_item",
            severity: "warning",
            text,
            message:
              "Promise.race() with a single item is a no-op — it resolves/rejects with " +
              "the same value as its only contestant without any racing benefit.",
          });
        }
      } else {
        // Could not extract array — still flag if no timeout in window
        if (!TIMEOUT_HINT_RE.test(window)) {
          findings.push({
            file: origFile,
            line: i + 1,
            rule: "promise_race_no_timeout",
            severity: "error",
            text,
            message:
              "Promise.race() has no visible timeout competitor — if all contestants hang, " +
              "this waits forever. Add a timeout: " +
              "`Promise.race([op(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), MS))])`.",
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
 * @param {string[]} [opts.extensions] - File extensions to scan
 * @param {number}  [opts.maxResults]  - Cap on findings array length
 */
function findPromiseRaceWithoutTimeout(resolvedPath, origPath, opts = {}) {
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

module.exports = { findPromiseRaceWithoutTimeout };
