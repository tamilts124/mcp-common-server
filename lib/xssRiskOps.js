"use strict";
/**
 * find_xss_risk
 *
 * Scans JS/TS files for Cross-Site Scripting (XSS) sinks where user-controlled
 * values are assigned directly without sanitization.
 *
 * Three rules:
 *
 *   1. inner_html_assignment (error)
 *      `.innerHTML = ` or `.outerHTML = ` where the right-hand side contains
 *      user-tainted input (req.*, event.target.value, location.*, URLSearchParams,
 *      document.cookie, or sensitive-name identifiers: input/param/value/data/
 *      query/search/user/content/html/markup/text).
 *
 *   2. document_write_with_input (error)
 *      `document.write(` or `document.writeln(` with a template-literal or
 *      concatenated argument containing user-tainted values.
 *
 *   3. insert_adjacent_html_with_input (error)
 *      `insertAdjacentHTML(` where the second argument (position is first)
 *      contains user-tainted values.
 *
 * Suppressions: same-line `// safe`, `// xss-safe`, `// sanitized`, or a
 * sanitization hint (DOMPurify.sanitize, escapeHtml, he.escape, htmlspecialchars,
 * sanitize, encode) suppresses the finding.
 *
 * Pure text-scan (regex), not an AST/data-flow parser.
 * Returns { path, filesScanned, findingsCount, errorCount, warningCount,
 *           truncated, findings: [{file,line,rule,severity,message}] }.
 * Always available — does not require MCP_ALLOW_EXEC.
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS    = 5000;

// User taint sources
const REQ_TAINT_RE    = /\breq\s*\.\s*(?:body|query|params|headers)\b/;
const DOM_TAINT_RE    = /\b(?:location\.(?:href|search|hash|pathname)|URLSearchParams|event\.target\.value|document\.cookie)\b/;
const SENSITIVE_ID_RE = /\b(?:input|param(?:eter)?|value|data|query|search|user(?:input)?|content|html|markup|text|message|body)\b/i;

// Sanitization hints suppress findings
const SANITIZE_HINT_RE = /DOMPurify\.sanitize|escapeHtml|he\.escape|htmlspecialchars|sanitize\s*\(|encode\s*\(/i;

// Safe annotation suppression
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|xss-safe|sanitized)/i;

function isTainted(str) {
  return REQ_TAINT_RE.test(str) || DOM_TAINT_RE.test(str) || SENSITIVE_ID_RE.test(str);
}

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

function collectFiles(absDir, extensions, relBase) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(abs, extensions, rel));
    else if (ent.isFile() && extensions.some(e => ent.name.endsWith(e))) out.push(rel);
  }
  return out;
}

/**
 * Extract the right-hand side of an assignment starting after `=` (up to ~300 chars).
 */
function extractRhs(src, eqIdx) {
  let i = eqIdx + 1;
  const end = Math.min(src.length, eqIdx + 300);
  // Skip whitespace
  while (i < end && (src[i] === " " || src[i] === "\t")) i++;
  let depth = 0;
  let inStr = null;
  const buf = [];
  while (i < end) {
    const c = src[i];
    if (inStr) {
      buf.push(c);
      if (c === "\\" && i + 1 < end) { buf.push(src[++i]); }
      else if (c === inStr) inStr = null;
    } else if (c === "'" || c === '"' || c === "`") {
      inStr = c; buf.push(c);
    } else if (c === "(" || c === "[" || c === "{") {
      depth++; buf.push(c);
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--; buf.push(c);
    } else if ((c === ";" || c === "\n") && depth === 0) {
      break;
    } else {
      buf.push(c);
    }
    i++;
  }
  return buf.join("");
}

/**
 * Extract argument list (up to ~300 chars) from an open paren.
 */
function extractArgs(src, openParenIdx) {
  let i = openParenIdx + 1;
  const end = Math.min(src.length, openParenIdx + 300);
  let depth = 0;
  let inStr = null;
  const buf = [];
  while (i < end) {
    const c = src[i];
    if (inStr) {
      buf.push(c);
      if (c === "\\" && i + 1 < end) { buf.push(src[++i]); }
      else if (c === inStr) inStr = null;
    } else if (c === "'" || c === '"' || c === "`") {
      inStr = c; buf.push(c);
    } else if (c === "(" || c === "[" || c === "{") {
      depth++; buf.push(c);
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--; buf.push(c);
    } else {
      buf.push(c);
    }
    i++;
  }
  return buf.join("");
}

// Rule 1: innerHTML/outerHTML assignment
const INNER_HTML_RE = /\b(innerHTML|outerHTML)\s*=/g;

// Rule 2: document.write / document.writeln
const DOC_WRITE_RE = /\bdocument\.write(?:ln)?\s*\(/g;

// Rule 3: insertAdjacentHTML
const INSERT_ADJ_RE = /\binsertAdjacentHTML\s*\(/g;

function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split("\n");

  // ── Rule 1: innerHTML / outerHTML ──────────────────────────────────────────
  INNER_HTML_RE.lastIndex = 0;
  let m;
  while ((m = INNER_HTML_RE.exec(src)) !== null) {
    const lineNo  = lineOf(src, m.index);
    const lineStr = lines[lineNo - 1] || "";
    if (SAFE_ANNOT_RE.test(lineStr) || SANITIZE_HINT_RE.test(lineStr)) continue;
    // eqIdx = position of '='
    const eqIdx = m.index + m[0].length - 1;
    const rhs   = extractRhs(src, eqIdx);
    // Also check 2 surrounding lines for taint
    const win = lines.slice(Math.max(0, lineNo - 2), lineNo + 2).join(" ");
    if (!isTainted(rhs) && !isTainted(win)) continue;
    if (SANITIZE_HINT_RE.test(rhs)) continue;
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "inner_html_assignment",
      severity: "error",
      message:
        `${m[1]} assigned a user-controlled value without sanitization. ` +
        `An attacker can inject arbitrary HTML/script tags via this sink, ` +
        `leading to XSS. Use DOMPurify.sanitize(value) before assignment, ` +
        `or use textContent/innerText for plain-text content.`,
    });
  }

  // ── Rule 2: document.write / document.writeln ──────────────────────────────
  DOC_WRITE_RE.lastIndex = 0;
  while ((m = DOC_WRITE_RE.exec(src)) !== null) {
    const lineNo  = lineOf(src, m.index);
    const lineStr = lines[lineNo - 1] || "";
    if (SAFE_ANNOT_RE.test(lineStr) || SANITIZE_HINT_RE.test(lineStr)) continue;
    const openParen = m.index + m[0].length - 1;
    const args      = extractArgs(src, openParen);
    const win       = lines.slice(Math.max(0, lineNo - 2), lineNo + 2).join(" ");
    if (!isTainted(args) && !isTainted(win)) continue;
    if (SANITIZE_HINT_RE.test(args)) continue;
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "document_write_with_input",
      severity: "error",
      message:
        `document.write() called with user-controlled input. ` +
        `document.write() is a classic XSS vector: any HTML tags in the value ` +
        `are interpreted by the browser. Avoid document.write() entirely; ` +
        `use DOM APIs (createElement, appendChild, textContent) instead.`,
    });
  }

  // ── Rule 3: insertAdjacentHTML ─────────────────────────────────────────────
  INSERT_ADJ_RE.lastIndex = 0;
  while ((m = INSERT_ADJ_RE.exec(src)) !== null) {
    const lineNo  = lineOf(src, m.index);
    const lineStr = lines[lineNo - 1] || "";
    if (SAFE_ANNOT_RE.test(lineStr) || SANITIZE_HINT_RE.test(lineStr)) continue;
    const openParen = m.index + m[0].length - 1;
    const args      = extractArgs(src, openParen);
    const win       = lines.slice(Math.max(0, lineNo - 2), lineNo + 2).join(" ");
    if (!isTainted(args) && !isTainted(win)) continue;
    if (SANITIZE_HINT_RE.test(args)) continue;
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "insert_adjacent_html_with_input",
      severity: "error",
      message:
        `insertAdjacentHTML() called with user-controlled input. ` +
        `The second argument is parsed as HTML by the browser, making this ` +
        `an XSS sink equivalent to innerHTML. Use DOMPurify.sanitize(value) ` +
        `on the second argument, or use insertAdjacentText() for plain text.`,
    });
  }

  return findings;
}

function findXssRisk(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_xss_risk: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_xss_risk: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_xss_risk: extensions must be an array.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(
    Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)),
    HARD_MAX_RESULTS
  );

  const files   = stat.isDirectory() ? collectFiles(absPath, extensions, "") : [path.basename(absPath)];
  const baseDir = stat.isDirectory() ? absPath : path.dirname(absPath);

  const findings = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    findings.push(...scanFile(rel, buf.toString("utf8")));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated    = findings.length > maxResults;
  const errorCount   = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: Math.min(findings.length, maxResults),
    errorCount,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findXssRisk };
