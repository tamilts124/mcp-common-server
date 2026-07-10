"use strict";
/**
 * find_unvalidated_redirect
 *
 * Scans JS/TS files for redirect operations that use dynamic (non-literal)
 * values without an allowlist/origin check. Complements find_open_redirect_risks
 * (which only flags DIRECT req.* usage in the redirect call). This tool flags
 * ANY dynamic value — including variables that may have been tainted upstream
 * — unless an allowlist, origin-check, or path-startsWith guard is visible.
 *
 * Four rules:
 *
 *  1. redirect_dynamic_url (error)
 *     res.redirect(expr) / response.redirect(expr) where expr is:
 *     - a template literal (contains ${ })
 *     - a variable identifier (not a string/number literal)
 *     - a concatenation expression (+ or +=)
 *     ...and no allowlist/startsWith/origin/pathname hint is visible in a
 *     ±5-line window. Distinct from find_open_redirect_risks: fires even when
 *     expr is a local variable that *may* have been sanitized elsewhere, giving
 *     a broader signal to review redirect targets.
 *
 *  2. location_href_dynamic (error)
 *     window.location.href = expr / location.href = expr / window.location = expr
 *     where expr is dynamic (template, variable, concat), no validation guard
 *     visible in a ±5-line window.
 *
 *  3. location_header_dynamic (warning)
 *     res.setHeader('Location', expr) / res.writeHead(3xx, {'Location': expr})
 *     or response.headers['location'] = expr, where expr is dynamic.
 *
 *  4. next_with_dynamic_route (warning)
 *     next(dynamicVar) inside an Express middleware where the variable looks
 *     like it controls routing (named route/url/path/redirect/next/dest/
 *     destination). Passing a non-Error string to next() triggers route
 *     skipping but can be hijacked if the value is user-controlled.
 *
 * Suppressions:
 *   - same-line `// safe`, `// validated`, `// redirect-safe`, `// nosec`
 *   - presence of `startsWith`, `includes(`, `allowlist`, `allow_list`,
 *     `whitelist`, `ALLOWED`, `origin ===`, `origin !==`, `pathname ===`,
 *     `url.parse`, `new URL(` in a ±5-line window
 *
 * Returns { path, filesScanned, findingsCount, errorCount, warningCount,
 *           truncated, findings: [{file,line,rule,severity,message}] }
 * Always available — does not require MCP_ALLOW_EXEC.
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored }  = require("./roots");
const { ToolError }  = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX        = 500;
const HARD_MAX           = 5000;

// res.redirect(expr) patterns
const REDIRECT_CALL_RE = /\b(?:res|response)\s*\.\s*redirect\s*\(/i;
// location.href = / window.location.href = / window.location =
const LOCATION_ASSIGN_RE = /\b(?:window\.location(?:\.href)?|location\.href)\s*=(?!=)/;
// res.setHeader('Location', ...) or res.header('Location', ...) or res.set('Location', ...)
const SET_LOCATION_HEADER_RE = /\b(?:res|response)\s*\.\s*(?:setHeader|header|set)\s*\(\s*['"][Ll]ocation['"]\s*,/;
// writeHead with Location
const WRITEHEAD_RE = /\b(?:res|response)\s*\.\s*writeHead\s*\(\s*3\d\d/;
const LOCATION_IN_WINDOW_RE = /['"]?[Ll]ocation['"]?\s*:/;
// next(dynamicVar) with route-like name
const NEXT_ROUTE_RE = /\bnext\s*\(\s*(\w+)\s*\)/;
const ROUTE_VAR_NAME_RE = /route|url|redirect|redir|dest(?:ination)?|path|next(?:Url|Route|Path)?/i;

// Dynamic expression detector: template literal, variable identifier (not string/number), or concat
const TEMPLATE_LITERAL_RE = /\$\{/;
const STRING_LITERAL_RE   = /^\s*['"`].*['"`]\s*$|^\s*\d+\s*$/;
// Allowlist / guard hints
const ALLOWLIST_HINT_RE = /startsWith\s*\(|includes\s*\(|allowlist|allow_list|whitelist|ALLOWED|origin\s*[=!]==|pathname\s*===|url\.parse\b|new URL\s*\(/i;
// Safe annotations
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|validated|redirect-safe|nosec)/i;

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
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

function windowHasGuard(lines, i, radius) {
  const start = Math.max(0, i - radius);
  const end   = Math.min(lines.length, i + radius + 1);
  return lines.slice(start, end).some(l => ALLOWLIST_HINT_RE.test(l));
}

/**
 * Extract the first argument from a function call starting at parenPos.
 * Returns the text of the first argument, or '' if not extractable.
 */
function extractFirstArg(line, openParenIdx) {
  let depth = 0;
  let argStart = -1;
  for (let c = openParenIdx; c < line.length; c++) {
    const ch = line[c];
    if (ch === '(') {
      if (depth === 0) { argStart = c + 1; }
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && argStart >= 0) {
        return line.slice(argStart, c).trim();
      }
    }
  }
  return argStart >= 0 ? line.slice(argStart).trim() : '';
}

function isDynamic(expr) {
  if (!expr) return false;
  if (TEMPLATE_LITERAL_RE.test(expr)) return true;  // template literal with interpolation
  if (/[+]/.test(expr) && !/^["']/.test(expr)) return true;  // concatenation
  // String literal => not dynamic
  if (/^["'`][^`$]*["'`]$/.test(expr)) return false;
  // Number literal
  if (/^\d+$/.test(expr)) return false;
  // If it's a plain identifier or property access, consider it dynamic
  if (/^\w[\w.]*$/.test(expr)) return true;
  // Template literal without ${ } (just a plain string in backticks)
  if (/^`[^$]*`$/.test(expr)) return false;
  return true;
}

function windowFrom(lines, lineIdx, windowSize) {
  const end = Math.min(lines.length, lineIdx + windowSize);
  const collected = [];
  for (let i = lineIdx; i < end; i++) {
    collected.push(lines[i]);
    if (i > lineIdx && /\}\s*\)/.test(lines[i])) break;
  }
  return collected.join("\n");
}

function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line   = lines[i];
    const lineNo = i + 1;

    if (SAFE_ANNOT_RE.test(line)) continue;

    // Rule 1: res.redirect(dynamicExpr)
    if (REDIRECT_CALL_RE.test(line)) {
      const m = line.match(/(?:res|response)\s*\.\s*redirect\s*(\()/);
      if (m) {
        const parenIdx = line.indexOf('(', m.index + m[0].length - 1);
        const expr = extractFirstArg(line, parenIdx);
        if (isDynamic(expr) && !windowHasGuard(lines, i, 5)) {
          findings.push({
            file: relPath, line: lineNo,
            rule: "redirect_dynamic_url", severity: "error",
            message:
              `res.redirect() called with a dynamic expression (${expr.slice(0, 60)}) ` +
              `and no allowlist/startsWith/origin check visible in a \u00b15-line window. ` +
              `If this value can be influenced by user input (directly or via a tainted ` +
              `variable), attackers can redirect victims to phishing or malware sites. ` +
              `Fix: validate the redirect target against an explicit allowlist of paths ` +
              `or use a relative path guard (startsWith('/') && !startsWith('//')).`,
          });
        }
      }
    }

    // Rule 2: location.href = dynamic
    if (LOCATION_ASSIGN_RE.test(line)) {
      // Extract RHS after the assignment
      const eqIdx = line.search(/=(?!=)/);
      const rhs   = eqIdx >= 0 ? line.slice(eqIdx + 1).trim().replace(/;\s*$/, '') : '';
      if (isDynamic(rhs) && !windowHasGuard(lines, i, 5)) {
        findings.push({
          file: relPath, line: lineNo,
          rule: "location_href_dynamic", severity: "error",
          message:
            `window.location/location.href assigned a dynamic value (${rhs.slice(0, 60)}) ` +
            `with no allowlist/origin validation in a \u00b15-line window. ` +
            `Client-side open redirect: the browser navigates to an attacker-controlled ` +
            `URL if this value is user-tainted (query param, postMessage, etc.). ` +
            `Fix: parse with new URL(expr, location.origin) and verify .origin matches ` +
            `your expected domain, or validate against a known-good path prefix.`,
        });
      }
    }

    // Rule 3: res.setHeader('Location', dynamic)
    if (SET_LOCATION_HEADER_RE.test(line)) {
      const m = line.match(/[Ll]ocation['"]\s*,\s*(.+)$/);
      if (m) {
        const expr = m[1].trim().replace(/\)\s*;?\s*$/, '').trim();
        if (isDynamic(expr) && !windowHasGuard(lines, i, 5)) {
          findings.push({
            file: relPath, line: lineNo,
            rule: "location_header_dynamic", severity: "warning",
            message:
              `Location response header set to a dynamic value (${expr.slice(0, 60)}) ` +
              `without a visible allowlist/origin check. If the value originates from ` +
              `user input, this enables open redirect attacks. Validate the target URL ` +
              `against an allowlist of trusted paths or origins before setting it.`,
          });
        }
      }
    }

    // Rule 3b: writeHead 3xx with Location header in window
    if (WRITEHEAD_RE.test(line)) {
      const window = windowFrom(lines, i, 6);
      if (LOCATION_IN_WINDOW_RE.test(window)) {
        // Extract the Location value from the window
        const locM = window.match(/['"]?[Ll]ocation['"]?\s*:\s*(.+)/);
        const expr = locM ? locM[1].trim().replace(/[,})].*$/, '').trim() : '';
        if (isDynamic(expr) && !windowHasGuard(lines, i, 5)) {
          findings.push({
            file: relPath, line: lineNo,
            rule: "location_header_dynamic", severity: "warning",
            message:
              `writeHead() sets a dynamic Location header (${expr.slice(0, 60)}) ` +
              `without a visible allowlist/origin check. Validate the redirect target ` +
              `before using it in a 3xx Location header.`,
          });
        }
      }
    }

    // Rule 4: next(routeVar) inside middleware
    const nextM = line.match(NEXT_ROUTE_RE);
    if (nextM) {
      const varName = nextM[1];
      if (ROUTE_VAR_NAME_RE.test(varName) && !windowHasGuard(lines, i, 5) && !SAFE_ANNOT_RE.test(line)) {
        findings.push({
          file: relPath, line: lineNo,
          rule: "next_with_dynamic_route", severity: "warning",
          message:
            `next(${varName}) passes a route-like variable to Express next(). ` +
            `If '${varName}' can be influenced by user input, attackers may skip ` +
            `authentication or authorization middleware. Ensure '${varName}' is ` +
            `derived from a safe, validated source, not user-controlled data.`,
        });
      }
    }
  }

  return findings;
}

function findUnvalidatedRedirect(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_unvalidated_redirect: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_unvalidated_redirect: extensions must be an array.", -32602);
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unvalidated_redirect: max_results must be a number.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(
    Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX)),
    HARD_MAX
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
    errorCount: Math.min(errorCount, maxResults),
    warningCount: Math.min(warningCount, maxResults),
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findUnvalidatedRedirect };
