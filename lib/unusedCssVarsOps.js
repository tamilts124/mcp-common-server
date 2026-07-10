"use strict";
/**
 * find_unused_css_variables
 *
 * Scans a CSS/SCSS/LESS/HTML/JSX/TSX/JS/TS project for CSS custom property
 * (a.k.a. CSS variable) declarations that are never used anywhere via var().
 *
 * Two phases:
 *   1. DECLARATION SCAN: collect every `--var-name:` declaration from CSS,
 *      SCSS, LESS files (also recognises declarations in <style> blocks in HTML).
 *   2. USAGE SCAN: collect every `var(--var-name)` reference from CSS, SCSS,
 *      LESS, HTML, JSX, TSX, JS, TS files.
 *   3. CROSS-REFERENCE: report any declared variable with zero usages.
 *
 * One rule:
 *   unused_css_variable (warning) — a --var-name is declared but never
 *     referenced with var(--var-name) anywhere in the scanned tree.
 *
 * Limitations (documented so callers aren't surprised):
 *   - Variables consumed only at runtime (e.g. via element.style.getProperty-
 *     Value / setAttribute in JS) are invisible to this static scan.
 *   - Variables used ONLY in inline style attributes of HTML/JSX are tracked
 *     via the usage scan (the string `var(--name)` is recognised in any file).
 *   - Declarations inside `node_modules` and `.git` are skipped.
 *   - A variable declared in one file and used in a sibling file IS caught
 *     (cross-file analysis across the scanned directory tree).
 */
const fs   = require("fs");
const path = require("path");

const DECL_EXTENSIONS  = [".css", ".scss", ".less", ".html", ".htm"];
const USAGE_EXTENSIONS = [".css", ".scss", ".less", ".html", ".htm", ".jsx", ".tsx", ".js", ".ts", ".mjs", ".cjs"];

// Matches a CSS custom property declaration: --var-name:
// (allow leading whitespace, optional colon-with-value on same line)
const DECL_RE = /(?:^|[;{\n])\s*(--[\w-]+)\s*:/gm;
// Matches var(--var-name) usage — allows whitespace between var( and --
const USAGE_RE = /var\(\s*(--[\w-]+)/g;

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

function readSafe(fp) {
  try { return fs.readFileSync(fp, "utf8"); }
  catch (_) { return ""; }
}

/**
 * Main exported function.
 *
 * @param {string} resolvedPath  - Absolute path (file or directory)
 * @param {string} origPath      - Original client path (for display)
 * @param {object} opts
 * @param {string[]} [opts.declExtensions]  - Override file extensions for declaration scan
 * @param {string[]} [opts.usageExtensions] - Override file extensions for usage scan
 * @param {number}  [opts.maxResults]
 */
function findUnusedCssVariables(resolvedPath, origPath, opts = {}) {
  const declExts  = Array.isArray(opts.declExtensions)
    ? opts.declExtensions.map(e => e.toLowerCase())
    : DECL_EXTENSIONS;
  const usageExts = Array.isArray(opts.usageExtensions)
    ? opts.usageExtensions.map(e => e.toLowerCase())
    : USAGE_EXTENSIONS;
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

  // For a single file, we scan that file for both declarations and usages
  const isDir = stat.isDirectory();
  if (!isDir && !stat.isFile()) {
    const err = new Error(`Path is neither a file nor a directory: ${origPath}`);
    err.code = -32602; throw err;
  }

  let declFiles, usageFiles;
  if (isDir) {
    declFiles  = collectFiles(resolvedPath, declExts);
    usageFiles = collectFiles(resolvedPath, usageExts);
  } else {
    declFiles  = [resolvedPath];
    usageFiles = [resolvedPath];
  }

  // Phase 1: collect declarations { varName -> [{file, line}] }
  const declarations = new Map(); // varName -> [{file, line}]
  for (const fp of declFiles) {
    const src   = readSafe(fp);
    const displayFile = isDir
      ? origPath.replace(/[\\/]+$/, "") + "/" + path.relative(resolvedPath, fp).replace(/\\/g, "/")
      : origPath;
    const lines = src.split(/\n/);
    // Build per-line lookup from character offset
    const lineOffsets = [];
    let off = 0;
    for (const ln of lines) { lineOffsets.push(off); off += ln.length + 1; }

    DECL_RE.lastIndex = 0;
    let m;
    while ((m = DECL_RE.exec(src)) !== null) {
      const varName = m[1];
      // Find line number from match offset
      let lineNum = 1;
      const matchOff = m.index + m[0].indexOf(varName);
      for (let i = 0; i < lineOffsets.length; i++) {
        if (lineOffsets[i] <= matchOff) lineNum = i + 1;
        else break;
      }
      if (!declarations.has(varName)) declarations.set(varName, []);
      declarations.get(varName).push({ file: displayFile, line: lineNum });
    }
  }

  // Phase 2: collect usages (Set of variable names)
  const usedVars = new Set();
  for (const fp of usageFiles) {
    const src = readSafe(fp);
    USAGE_RE.lastIndex = 0;
    let m;
    while ((m = USAGE_RE.exec(src)) !== null) {
      usedVars.add(m[1]);
    }
  }

  // Phase 3: cross-reference — report declared but never used
  let findings = [];
  for (const [varName, locs] of declarations.entries()) {
    if (usedVars.has(varName)) continue;
    // Report the first declaration site
    const { file, line } = locs[0];
    const declCount = locs.length;
    findings.push({
      file, line,
      variable: varName,
      declarationCount: declCount,
      rule: "unused_css_variable",
      severity: "warning",
      message: `CSS variable "${varName}" is declared ${declCount > 1 ? `${declCount} times` : ""} but never referenced with var(${varName}) in the scanned project. If intentional (e.g. a theme token only consumed via JS), suppress by including a var(${varName}) reference comment.`,
    });
  }

  findings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

  const totalDeclarations = declarations.size;
  const unusedCount      = findings.length;

  let truncated = false;
  if (findings.length > maxResults) { findings = findings.slice(0, maxResults); truncated = true; }

  return {
    path: origPath,
    filesScanned: new Set([...declFiles, ...usageFiles]).size,
    totalDeclaredVariables: totalDeclarations,
    unusedCount,
    findingsCount: findings.length,
    warningCount: findings.length,
    truncated,
    findings,
  };
}

module.exports = { findUnusedCssVariables };
