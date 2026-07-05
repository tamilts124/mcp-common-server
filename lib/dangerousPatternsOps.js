"use strict";
// ── SCAN_DANGEROUS_CODE_PATTERNS — dynamic-code / injection footguns ───────
// Recursively walks a file or directory (same MCP_IGNORE-aware walk pattern
// as scan_secrets/scan_cors_misconfig) looking for common dangerous dynamic-
// code patterns in JS/TS:
//   - eval(...)                         — arbitrary code execution
//   - new Function(...)                 — same class of risk as eval
//   - exec()/execSync() built from a template literal with ${..} or string
//     concatenation (not a plain string literal) — command injection risk;
//     execFile/spawn with an argv array are NOT flagged (already safer)
//   - setTimeout/setInterval with a string literal as the first arg —
//     implicit eval, legacy footgun
//   - .innerHTML = <non-literal> or dangerouslySetInnerHTML — XSS risk if
//     the value isn't a hardcoded string
//   - Math.random() used to build something named token/secret/password/
//     apiKey/sessionId — cryptographically weak, should use crypto.random*
// Pure line-oriented text-scan (regex), not an AST parser — no data-flow
// tracking (a variable built from a literal several lines earlier is not
// distinguished from one built from user input). Read-only, zero-dependency.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const EVAL_RE           = /(?<!\.)\beval\s*\(/;
const NEW_FUNCTION_RE   = /\bnew\s+Function\s*\(/;
const EXEC_CALL_RE      = /\b(?:child_process\s*\.\s*)?exec(?:Sync)?\s*\(/;
const EXEC_DYNAMIC_ARG_RE = /`[^`]*\$\{|['"`]\s*\+\s*\w|\w\s*\+\s*['"`]/;
const TIMER_STRING_RE   = /\bset(?:Timeout|Interval)\s*\(\s*['"`]/;
const INNER_HTML_ASSIGN_RE = /\.innerHTML\s*=(?!\s*(?:'[^']*'|"[^"]*"|`(?:(?!\$\{)[^`])*`)\s*[;,)])/;
const DANGEROUS_SET_HTML_RE = /dangerouslySetInnerHTML/;
const WEAK_RANDOM_TOKEN_RE = /(?:token|secret|password|passwd|api[_-]?key|session[_-]?id)\s*[:=][^;\n]*Math\.random\s*\(\s*\)/i;

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function collectFiles(absDir, extensions, relBase = "") {
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
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported issues (1-5000, default 500).
 * @returns {{path, filesScanned, issueCount, errorCount, warningCount, truncated, issues}}
 */
function scanDangerousPatterns(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`scan_dangerous_code_patterns: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("scan_dangerous_code_patterns: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("scan_dangerous_code_patterns: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const issues = [];

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");
    const lines = source.split(/\r\n|\r|\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      if (EVAL_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "eval_usage", severity: "error",
          message: "eval() executes arbitrary code — high injection risk if any part of the input is not fully trusted." });
      }

      if (NEW_FUNCTION_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "new_function", severity: "error",
          message: "new Function(...) compiles a string into executable code — same risk class as eval()." });
      }

      if (EXEC_CALL_RE.test(line) && EXEC_DYNAMIC_ARG_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "exec_dynamic_command", severity: "error",
          message: "exec()/execSync() built from a template literal or string concatenation — command injection risk. Prefer execFile/spawn with an argv array." });
      }

      if (TIMER_STRING_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "timer_string_eval", severity: "warning",
          message: "setTimeout/setInterval called with a string as the first argument — implicitly eval'd. Pass a function instead." });
      }

      if (DANGEROUS_SET_HTML_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "dangerously_set_inner_html", severity: "warning",
          message: "dangerouslySetInnerHTML renders raw HTML — XSS risk unless the content is sanitized." });
      } else if (INNER_HTML_ASSIGN_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "unsafe_inner_html", severity: "warning",
          message: ".innerHTML assigned from a non-literal value — XSS risk unless the content is sanitized/escaped." });
      }

      if (WEAK_RANDOM_TOKEN_RE.test(line)) {
        issues.push({ file: rel, line: lineNo, rule: "weak_random_token", severity: "warning",
          message: "Math.random() is not cryptographically secure — use crypto.randomBytes/randomUUID for tokens, secrets, or session IDs." });
      }
    }
  }

  issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = issues.length > maxResults;
  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    issueCount: issues.length,
    errorCount, warningCount,
    truncated,
    issues: issues.slice(0, maxResults),
  };
}

module.exports = { scanDangerousPatterns };
