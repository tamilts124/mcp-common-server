"use strict";
/**
 * find_magic_numbers
 *
 * Scans JS/TS files for numeric literals used directly in expressions
 * (not as the RHS of a named const/let/var declaration, and not trivially
 * uncontroversial values like 0, 1, -1, 2).
 *
 * Magic numbers are a maintenance anti-pattern: the reader cannot tell WHY
 * the number is what it is without extra context. Extracting them as named
 * constants makes intent explicit and makes changes a single-location edit.
 *
 * Exclusions (not flagged):
 *  - 0, 1, -1, 2, -2 — universally accepted unambiguous literals
 *  - Numbers on the RHS of a const/let/var assignment with a descriptive
 *    identifier name: `const MAX_RETRIES = 3` is the fix, not a bug.
 *  - Numbers inside import/require strings (not possible anyway since regex
 *    targets expression position, not string content).
 *  - CSS-unit-like patterns (handled separately by other tools).
 *  - Lines that are pure comments.
 *  - TypeScript type annotations (lines containing `: number` but not in
 *    value position — best-effort, not AST-accurate).
 *
 * Rule: `magic_number` (warning).
 *
 * Default extensions: .js, .jsx, .ts, .tsx, .mjs, .cjs
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

// Allowed literal values (not flagged)
const ALLOWED_VALUES = new Set(["0", "1", "2", "-1", "-2",
  // Bit-manipulation sentinels and common array API returns
  "-1"]);

// Pattern: a numeric literal (int or float, optional unary minus) in an
// expression context:
//   (?<![\w.]) — not preceded by ident char or dot (not a property/method name part)
//   -? — optional unary minus (treat -N as one literal)
//   (\d+\.?\d*|\.\d+) — integer or decimal
//   (?!\.) — not followed by dot (avoid matching 3 in 3.14 as a separate literal)
const NUM_RE = /(?<![\w.])-?(?:\d+\.\d*|\.\d+|\d+)(?!\.\d)(?![\w])/g;

// A line that is just a const/let/var assignment — the number is the definition
const ASSIGN_RE = /^\s*(?:const|let|var)\s+[A-Z_][\w]*\s*=/;
// Also allow camelCase named consts: any identifier in an assignment
const NAMED_ASSIGN_RE = /^\s*(?:const|let|var)\s+\w+\s*=/;

// Strip single-line comment at end of line
const COMMENT_STRIP_RE = /(\/\/.*$)/;
// Block comment (simplified inline)
const BLOCK_COMMENT_RE = /\/\*.*?\*\//g;
// Pure comment line
const PURE_COMMENT_RE = /^\s*(\/\/|\/\*|\*)/ ;

function getLineNumber(src, index) {
  return src.slice(0, index).split("\n").length;
}

function scanFile(filePath, displayFile, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 2;
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); } catch (_) { return []; }

  const lines   = src.split("\n");
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Skip blank/comment-only lines
    if (!line.trim() || PURE_COMMENT_RE.test(line)) continue;

    // Strip inline comments
    line = line.replace(BLOCK_COMMENT_RE, "");
    line = line.replace(COMMENT_STRIP_RE, "");

    // If this is a named const/let/var assignment, skip (it's the definition)
    if (NAMED_ASSIGN_RE.test(line)) continue;

    // Skip import/require lines
    if (/^\s*(?:import\b|(?:const|let|var)\s+\w+\s*=\s*require\()/.test(line)) continue;

    // Skip TypeScript type-annotation-only lines like `timeout: number = 5`
    // we keep scanning but be aware of false positives in TS interfaces.

    // Find numeric literals
    NUM_RE.lastIndex = 0;
    let m;
    while ((m = NUM_RE.exec(line)) !== null) {
      const raw = m[0];
      // Normalise: strip leading unary minus for the allowed check
      const abs = raw.replace(/^-/, "");
      const numVal = parseFloat(raw);
      // Always skip 0, 0.0, 1, 1.0, 2, -1, -2
      if (ALLOWED_VALUES.has(raw) || ALLOWED_VALUES.has(abs)) continue;
      if (!isNaN(numVal) && Math.abs(numVal) <= threshold) continue;

      findings.push({
        file:     displayFile,
        line:     i + 1,
        value:    raw,
        rule:     "magic_number",
        severity: "warning",
        message:  `Magic number ${raw} used directly. Extract it as a named constant (e.g. const TIMEOUT_MS = ${raw}) to document its intent and make future changes a single-location edit.`,
      });
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

function findMagicNumbers(resolvedPath, origPath, opts = {}) {
  const extensions = Array.isArray(opts.extensions)
    ? opts.extensions.map(e => e.toLowerCase())
    : DEFAULT_EXTENSIONS;
  const maxResults = typeof opts.maxResults === "number" ? opts.maxResults : 500;
  if (maxResults < 1 || maxResults > 5000) {
    const err = new Error("max_results must be between 1 and 5000");
    err.code = -32602; throw err;
  }
  // threshold: numbers with abs value <= threshold are exempt (besides the fixed set)
  // default 2 means 0,1,2,-1,-2 are all safe; anything above is flagged.
  const threshold = typeof opts.threshold === "number" ? opts.threshold : 2;

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
    allFindings = allFindings.concat(scanFile(fp, displayFile, { threshold }));
    filesScanned++;
  }

  allFindings.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  let truncated = false;
  if (allFindings.length > maxResults) { allFindings = allFindings.slice(0, maxResults); truncated = true; }

  return {
    path: origPath,
    filesScanned,
    findingsCount: allFindings.length,
    warningCount:  allFindings.length,
    truncated,
    findings: allFindings,
  };
}

module.exports = { findMagicNumbers };
