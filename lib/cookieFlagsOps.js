"use strict";
// ── CHECK_INSECURE_COOKIE_FLAGS — missing httpOnly/secure/sameSite hygiene ──
// Scans JS/TS for two cookie-configuration shapes missing the standard
// browser-cookie hardening flags:
//   (1) `res.cookie(name, value[, options])` (Express) — checks the 3rd
//       positional options-object argument.
//   (2) `cookie: { ... }` sub-object (express-session / cookie-session
//       config, e.g. `session({ cookie: { ... } })`) — checks the object
//       body directly.
// For each, three independent checks:
//   - httpOnly missing            -> missing_http_only (warning)
//   - httpOnly explicitly false   -> http_only_disabled (error)
//   - secure missing              -> missing_secure (warning)
//   - secure explicitly false     -> secure_disabled (warning — legitimate
//                                    for local HTTP dev, still worth flagging)
//   - sameSite missing            -> missing_same_site (info)
// A bare `res.cookie(name, value)` call with no options object at all is
// reported once as `cookie_no_options` (warning) rather than three
// separate missing-flag findings for the same call.
//
// Pure text-scan (regex + balanced-paren/brace extraction), not an AST
// parser:
//   CAVEATS:
//     - only the literal `res.cookie(` call shape and a literal `cookie:`
//       object key are recognized — an options object built via an
//       intermediate variable (`const opts = {...}; res.cookie(n, v, opts)`)
//       is invisible to this scan, same tradeoff as scan_cors_misconfig.
//     - `secure: process.env.NODE_ENV === 'production'`-style conditional
//       expressions are treated as "secure present" (not flagged) — the
//       scan only distinguishes "key present" vs "key absent" vs "key
//       explicitly literal false", it doesn't evaluate the expression.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const RES_COOKIE_RE = /\bres\.cookie\s*\(/g;
const COOKIE_KEY_RE = /\bcookie\s*:\s*\{/g;

const HTTP_ONLY_FALSE_RE = /\bhttpOnly\s*:\s*false\b/;
const HTTP_ONLY_KEY_RE = /\bhttpOnly\s*:/;
const SECURE_FALSE_RE = /\bsecure\s*:\s*false\b/;
const SECURE_KEY_RE = /\bsecure\s*:/;
const SAME_SITE_KEY_RE = /\bsameSite\s*:/;

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

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

// Balanced-paren extraction starting just after an opening '('.
function extractParen(source, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) break; }
  }
  return { text: source.slice(openIdx + 1, i), endIdx: i };
}

// Balanced-brace extraction starting just after an opening '{'.
function extractBrace(source, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  return { text: source.slice(openIdx + 1, i), endIdx: i };
}

// Split top-level comma-separated call arguments (paren/brace/bracket/string-aware).
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let start = 0;
  let inString = null;
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { inString = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(argsText.slice(start, i));
      start = i + 1;
    }
  }
  args.push(argsText.slice(start));
  return args;
}

function checkFlagBody(bodyText, rulePrefix, findings, relPath, line) {
  if (HTTP_ONLY_FALSE_RE.test(bodyText)) {
    findings.push({ file: relPath, line, rule: `${rulePrefix}http_only_disabled`, severity: "error",
      message: "httpOnly explicitly set to false — cookie is readable via client-side JavaScript (XSS exposure)." });
  } else if (!HTTP_ONLY_KEY_RE.test(bodyText)) {
    findings.push({ file: relPath, line, rule: `${rulePrefix}missing_http_only`, severity: "warning",
      message: "httpOnly not set — defaults to false in most cookie APIs, exposing the cookie to client-side JavaScript." });
  }

  if (SECURE_FALSE_RE.test(bodyText)) {
    findings.push({ file: relPath, line, rule: `${rulePrefix}secure_disabled`, severity: "warning",
      message: "secure explicitly set to false — cookie will be sent over plain HTTP." });
  } else if (!SECURE_KEY_RE.test(bodyText)) {
    findings.push({ file: relPath, line, rule: `${rulePrefix}missing_secure`, severity: "warning",
      message: "secure not set — cookie may be sent over unencrypted HTTP connections." });
  }

  if (!SAME_SITE_KEY_RE.test(bodyText)) {
    findings.push({ file: relPath, line, rule: `${rulePrefix}missing_same_site`, severity: "info",
      message: "sameSite not set — defaults vary by browser/library; explicit 'strict'/'lax' reduces CSRF exposure." });
  }
}

function scanFileForInsecureCookieFlags(relPath, source) {
  const findings = [];

  RES_COOKIE_RE.lastIndex = 0;
  let m;
  while ((m = RES_COOKIE_RE.exec(source)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const { text: argsText, endIdx } = extractParen(source, openIdx);
    const args = splitTopLevelArgs(argsText);
    const line = lineOf(source, m.index);

    if (args.length < 3 || !args[2] || !args[2].trim()) {
      findings.push({ file: relPath, line, rule: "cookie_no_options", severity: "warning",
        message: "res.cookie() called with no options object — httpOnly/secure/sameSite all default to insecure/unset." });
    } else {
      checkFlagBody(args[2], "res_cookie_", findings, relPath, line);
    }
    RES_COOKIE_RE.lastIndex = endIdx;
  }

  COOKIE_KEY_RE.lastIndex = 0;
  while ((m = COOKIE_KEY_RE.exec(source)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const { text: bodyText } = extractBrace(source, openIdx);
    const line = lineOf(source, m.index);
    checkFlagBody(bodyText, "session_cookie_", findings, relPath, line);
  }

  return findings;
}

/**
 * @param {string} absTarget  Absolute, jail-validated file or directory.
 * @param {string} origPath   Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults] Cap on findings[] length (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, infoCount, truncated, findings: Array}}
 */
function checkInsecureCookieFlags(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_insecure_cookie_flags: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("check_insecure_cookie_flags: extensions must be an array of strings.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;

  let stat;
  try { stat = fs.statSync(absTarget); }
  catch (e) { throw new ToolError(`check_insecure_cookie_flags: cannot access '${origPath}': ${e.message}`, -32602); }
  const isDirectory = stat.isDirectory();

  let files;
  if (isDirectory) {
    files = collectFiles(absTarget, extensions);
  } else {
    if (!extensions.some(e => absTarget.endsWith(e)))
      throw new ToolError(`check_insecure_cookie_flags: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let buf;
    try { buf = fs.readFileSync(abs); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    findings.push(...scanFileForInsecureCookieFlags(rel, buf.toString("utf8")));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;
  const infoCount = findings.filter(f => f.severity === "info").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    errorCount, warningCount, infoCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { checkInsecureCookieFlags };
