"use strict";
/**
 * find_long_functions
 *
 * Scans JS/TS files for function declarations, arrow functions, and method
 * definitions whose body exceeds a configurable line threshold.
 *
 * Long functions are harder to understand, test, and refactor. A function
 * over ~50 lines often has too many responsibilities (Single Responsibility
 * Principle violation) and should be broken into smaller units.
 *
 * Detection strategy:
 *   1. Find lines that start a function body (function declaration, arrow
 *      function with `{`, method shorthand, class method).
 *   2. Track brace depth from that opening `{` to find the matching `}`.
 *   3. Report if (closing_line - opening_line) > threshold.
 *
 * Function name extraction (best-effort, regex, not AST):
 *   - `function NAME(` — named function declaration
 *   - `const/let/var NAME = ... => {` — arrow function assigned to var
 *   - `const/let/var NAME = function(` — function expression
 *   - `NAME(` at start of an object/class method body opening
 *   - Anonymous: `(args) => {` or `function(` — reported as "<anonymous>"
 *
 * Rule: `long_function` (warning).
 *
 * Default extensions: .js, .jsx, .ts, .tsx, .mjs, .cjs
 * Default threshold: 50 lines
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_THRESHOLD  = 50;

// Patterns to detect function-opening lines
// Group 1: function name (if identifiable)
const FUNC_DECL_RE   = /\bfunction\s+(\w+)\s*\(/;          // function NAME(
const FUNC_ANON_RE   = /\bfunction\s*\(/;                   // anonymous function(
const ARROW_ASSIGN_RE = /(?:const|let|var)\s+(\w+)\s*=.*=>\s*\{/; // const X = ... => {
const FUNC_ASSIGN_RE  = /(?:const|let|var)\s+(\w+)\s*=\s*function/; // const X = function
const METHOD_RE       = /^\s*(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/; // method(args) { or method(args): ReturnType {

function extractFunctionName(line) {
  let m;
  if ((m = FUNC_DECL_RE.exec(line)))   return m[1];
  if ((m = ARROW_ASSIGN_RE.exec(line))) return m[1];
  if ((m = FUNC_ASSIGN_RE.exec(line)))  return m[1];
  if ((m = METHOD_RE.exec(line)))       return m[1];
  if (FUNC_ANON_RE.test(line))         return "<anonymous>";
  return null;
}

function looksLikeFunctionOpener(line) {
  // Must contain a `{` AND have some function-like indicator
  if (!line.includes("{")) return false;
  return (
    FUNC_DECL_RE.test(line) ||
    FUNC_ANON_RE.test(line) ||
    ARROW_ASSIGN_RE.test(line) ||
    FUNC_ASSIGN_RE.test(line) ||
    (METHOD_RE.test(line) && !line.trim().startsWith("//"))
  );
}

function scanFile(filePath, displayFile, threshold) {
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); } catch (_) { return []; }

  const lines    = src.split("\n");
  const findings = [];
  // Stack of pending function bodies: { startLine, name, depth }
  const stack    = [];
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip string literals crudely to avoid counting braces inside strings
    // (We do a simple pass: remove single/double/template strings)
    let stripped = line
      .replace(/`[^`]*`/g, "``")
      .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
      .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");
    // Strip inline comments
    stripped = stripped.replace(/\/\/.*$/, "");

    const opens  = (stripped.match(/\{/g) || []).length;
    const closes = (stripped.match(/\}/g) || []).length;

    // Check if this line opens a new function BEFORE updating depth
    if (opens > closes && looksLikeFunctionOpener(line)) {
      const name = extractFunctionName(line) || "<anonymous>";
      stack.push({ startLine: i + 1, name, depth: braceDepth + 1 });
    }

    braceDepth += opens - closes;

    // Pop completed functions
    for (let j = stack.length - 1; j >= 0; j--) {
      if (braceDepth < stack[j].depth) {
        const fn = stack.splice(j, 1)[0];
        const length = i + 1 - fn.startLine + 1; // inclusive
        if (length > threshold) {
          findings.push({
            file:      displayFile,
            line:      fn.startLine,
            name:      fn.name,
            lineCount: length,
            rule:      "long_function",
            severity:  "warning",
            message:   `Function '${fn.name}' is ${length} lines long (threshold: ${threshold}). Consider splitting it into smaller, focused functions.`,
          });
        }
      }
    }
  }

  return findings;
}

function collectFiles(dir, extensions, files = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return files; }
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

function findLongFunctions(resolvedPath, origPath, opts = {}) {
  const extensions = Array.isArray(opts.extensions)
    ? opts.extensions.map(e => e.toLowerCase())
    : DEFAULT_EXTENSIONS;
  const maxResults = typeof opts.maxResults === "number" ? opts.maxResults : 500;
  if (maxResults < 1 || maxResults > 5000) {
    const err = new Error("max_results must be between 1 and 5000");
    err.code = -32602; throw err;
  }
  const threshold = typeof opts.threshold === "number" ? opts.threshold : DEFAULT_THRESHOLD;
  if (threshold < 5 || threshold > 10000) {
    const err = new Error("threshold must be between 5 and 10000");
    err.code = -32602; throw err;
  }

  let stat;
  try { stat = fs.statSync(resolvedPath); } catch (_) {
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
    allFindings = allFindings.concat(scanFile(fp, displayFile, threshold));
    filesScanned++;
  }

  // Sort by line count descending (worst offenders first)
  allFindings.sort((a, b) => b.lineCount - a.lineCount);
  let truncated = false;
  if (allFindings.length > maxResults) { allFindings = allFindings.slice(0, maxResults); truncated = true; }

  return {
    path: origPath,
    filesScanned,
    threshold,
    findingsCount: allFindings.length,
    warningCount:  allFindings.length,
    truncated,
    findings: allFindings,
  };
}

module.exports = { findLongFunctions };
