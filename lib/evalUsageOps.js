"use strict";
/**
 * find_eval_usage
 *
 * Scans JS/TS/JSX/TSX/.mjs/.cjs files for dangerous dynamic code execution
 * patterns that violate Content Security Policy and create XSS/RCE vectors:
 *
 *   direct_eval (error) — a bare `eval(...)` call (excludes `eval.apply`,
 *     `someObj.eval`, etc. which are out-of-scope). Passing user-controlled
 *     content to eval() is a classic RCE/XSS vulnerability and violates
 *     CSP's `unsafe-eval` restriction.
 *
 *   new_function_constructor (error) — `new Function(...)` call, which
 *     dynamically compiles JS from a string at runtime. Semantically
 *     equivalent to eval() and blocked by the same CSP directives.
 *
 *   settimeout_string_arg (warning) — `setTimeout("...", ...)` or
 *     `setInterval("...", ...)` calls where the first argument is a string
 *     literal (not a function reference). Browsers evaluate the string as
 *     code, another implicit eval() path (also blocked by CSP unsafe-eval).
 *
 * Siblings: check_missing_csp_header, find_inline_event_handlers,
 *   find_insecure_random_usage
 */
const fs = require("fs");
const path = require("path");

// Matches a bare eval( call — NOT preceded by a dot (method call like foo.eval)
// or an identifier char (to avoid matching 'someeval(' by accident)
const EVAL_RE = /(?<![\w.])\beval\s*\(/g;

// Matches `new Function(` — with optional whitespace between new and Function
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/g;

// Matches setTimeout/setInterval where the first arg is a string literal:
//   setTimeout("...", or setTimeout('...', or setTimeout(`...`,
// We look for the call then peek at the opening character of the first arg.
const TIMER_STRING_RE = /\b(setTimeout|setInterval)\s*\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)/g;

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

/**
 * Scan a single file for eval usage patterns.
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
    const lineNo = i + 1;

    EVAL_RE.lastIndex = 0;
    NEW_FUNCTION_RE.lastIndex = 0;
    TIMER_STRING_RE.lastIndex = 0;

    let m;

    // direct eval()
    while ((m = EVAL_RE.exec(line)) !== null) {
      findings.push({
        file: origFile,
        line: lineNo,
        rule: "direct_eval",
        severity: "error",
        text: line.trim().slice(0, 100),
        message: "eval() executes arbitrary code from a string — a critical XSS/RCE vector that violates CSP unsafe-eval. Replace with a safe alternative.",
      });
    }

    // new Function()
    while ((m = NEW_FUNCTION_RE.exec(line)) !== null) {
      findings.push({
        file: origFile,
        line: lineNo,
        rule: "new_function_constructor",
        severity: "error",
        text: line.trim().slice(0, 100),
        message: "new Function(...) compiles a string as code at runtime — equivalent to eval(), blocked by CSP unsafe-eval. Use a statically-defined function instead.",
      });
    }

    // setTimeout/setInterval with string literal first arg
    while ((m = TIMER_STRING_RE.exec(line)) !== null) {
      const timerName = m[1];
      findings.push({
        file: origFile,
        line: lineNo,
        rule: "settimeout_string_arg",
        severity: "warning",
        text: line.trim().slice(0, 100),
        message: `${timerName}(string, ...) evaluates the string as code at runtime — an implicit eval() path blocked by CSP. Pass a function reference instead: ${timerName}(() => { ... }, delay).`,
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
function findEvalUsage(resolvedPath, origPath, opts = {}) {
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

module.exports = { findEvalUsage };
