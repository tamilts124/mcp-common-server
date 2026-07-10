"use strict";
/**
 * find_hardcoded_color_literals
 *
 * Scans CSS/SCSS/LESS files for hardcoded color literals (hex, rgb(), rgba(),
 * hsl(), hsla()) used directly in property values outside of :root{} / :host{}
 * blocks that define custom properties (--var: value).
 *
 * The design-token pattern encourages defining all colors as CSS variables in
 * a :root{} block and then referencing them via var(--color-name), which makes
 * theming and design-system updates a single-location change. A literal color
 * directly in a rule (e.g. `color: #333`) duplicates the value and bypasses
 * the token system.
 *
 * One rule:
 *   hardcoded_color_literal (warning) — a color literal is used directly in a
 *     CSS property value rather than via var(--token).
 *
 * Exclusions (not flagged):
 *   - Lines inside a :root{} or :host{} block (those are token declarations).
 *   - Lines where the color is the value of a --custom-property (e.g.
 *     `--brand: #333;` — that's the intended token definition).
 *   - CSS comments.
 *   - Lines containing var() referencing the color (already tokenised).
 *   - "transparent", "inherit", "currentColor", "none" — not real literals.
 *
 * Default extensions: .css, .scss, .less
 */
const fs   = require("fs");
const path = require("path");

const DEFAULT_EXTENSIONS = [".css", ".scss", ".less"];

// Matches hex colors: #rgb, #rrggbb, #rgba, #rrggbbaa
const HEX_RE   = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6,8})\b/;
// Matches rgb()/rgba()/hsl()/hsla() functions
const FUNC_RE  = /\b(rgba?|hsla?)\s*\(/i;
// A line declaring a CSS custom property (skip these)
const CUSTOM_PROP_RE = /^\s*--[\w-]+\s*:/;
// A line already using var() — already tokenised
const VAR_USE_RE = /\bvar\s*\(/;
// CSS comment — strip before checking
const COMMENT_RE = /\/\*.*?\*\//g;

// Inside :root or :host block we skip (token definition zone)
// We track brace depth to detect when we exit.

function scanFile(filePath, displayFile) {
  let src;
  try { src = fs.readFileSync(filePath, "utf8"); }
  catch (_) { return []; }

  const findings = [];
  const lines = src.split("\n");
  let braceDepth = 0;
  let inRootBlock = false;
  let rootBlockDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Strip inline comments
    line = line.replace(COMMENT_RE, "");

    // Track brace depth for :root / :host detection
    const openBraces  = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Check if this line opens a :root / :host block
    if (/:\s*root\b|:\s*host\b/.test(line) && line.includes("{")) {
      inRootBlock = true;
      rootBlockDepth = braceDepth + openBraces - closeBraces;
    }

    braceDepth += openBraces - closeBraces;

    // If we've exited the root block, clear the flag
    if (inRootBlock && braceDepth < rootBlockDepth) {
      inRootBlock = false;
    }

    // Skip :root / :host zone
    if (inRootBlock) continue;
    // Skip custom property declarations (--var: value)
    if (CUSTOM_PROP_RE.test(line)) continue;
    // Skip lines already using var()
    if (VAR_USE_RE.test(line)) continue;

    // Check for color literals
    const hasHex  = HEX_RE.test(line);
    const hasFunc = FUNC_RE.test(line);

    if (hasHex || hasFunc) {
      // Extract the color value for the message
      const colorMatch = hasHex
        ? line.match(HEX_RE)
        : line.match(/\b(?:rgba?|hsla?)\s*\([^)]+\)/i);
      const colorPreview = colorMatch ? colorMatch[0].trim() : "(color)";

      findings.push({
        file: displayFile,
        line: i + 1,
        color: colorPreview,
        rule: "hardcoded_color_literal",
        severity: "warning",
        message: `Hardcoded color literal "${colorPreview}" found directly in CSS rule. Consider extracting it as a CSS custom property (e.g. --color-name: ${colorPreview}) in :root{} and referencing it via var(--color-name) for theming and design-token consistency.`,
      });
    }
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

function findHardcodedColorLiterals(resolvedPath, origPath, opts = {}) {
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
    warningCount:  allFindings.length,
    truncated,
    findings: allFindings,
  };
}

module.exports = { findHardcodedColorLiterals };
