"use strict";
// ── FIND_MISSING_REMOVE_EVENT_LISTENER — leaked DOM event-listener scan ────
// Sibling to find_setinterval_without_clear (same "leaked handle" family),
// but for `target.addEventListener(type, handler, opts)` instead of
// `setInterval`. Unlike setInterval, addEventListener returns no handle at
// all — cleanup requires calling `target.removeEventListener(type, handler)`
// with the *same* target + type + function reference. That makes an inline
// anonymous handler (`function(){}` / `(...) => {}`) uncleanable by
// construction: a fresh function is created every call, so no later
// removeEventListener call could ever reference it.
//
// Detection, per `target.addEventListener("type", HANDLER, opts?)` call:
//   1. `opts` contains `once: true` -> the browser auto-removes the listener
//      after it fires once; not flagged (mirrors the .unref() idiom for
//      setInterval — an intentional "let this clean itself up" signal).
//   2. HANDLER is not a bare identifier (inline function/arrow, method call,
//      etc.) -> `inline_handler_uncleanable` (error) — removeEventListener
//      can never target this listener, worse than case 3 since there is no
//      way to fix it without refactoring to a named reference first.
//   3. HANDLER is a bare identifier -> whole-file search for
//      `target.removeEventListener(` with the same event-type string and the
//      same identifier. Not found -> `event_listener_never_removed`
//      (warning, same rationale/limits as setInterval's whole-file scan).
//
// Deliberately NOT flagged / documented caveats (same "skip, don't guess"
// convention as the rest of this tool family):
//   - Only a literal string event type (`"click"`, 'load', `` `resize` ``)
//     puts a call in scope; a dynamic event-type expression is skipped —
//     can't statically resolve it to match against a removeEventListener
//     call using the same dynamic expression.
//   - The `target` match is a literal textual prefix (e.g. `window`,
//     `this`, `el`) — `target.removeEventListener` is searched for verbatim,
//     so a removeEventListener called through a differently-named alias to
//     the same underlying object (false negative) or coincidentally reusing
//     the same target/type/name in an unrelated scope (false negative via
//     suppression) are both possible, same whole-file/non-scope-aware
//     tradeoff documented in setIntervalLeakOps.js.
//   - Brace/paren counting ignores string/template/regex contents.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// [1] = target expression, [2] = quote char, [3] = event type.
const CALL_RE = /([\w.$]+)\.addEventListener\s*\(\s*(['"`])([^'"`]+)\2\s*,/g;

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
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function findMatchingParen(source, openIdx) {
  let depth = 1;
  for (let i = openIdx + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Split the argument list starting right after "type," at startIdx, into
// top-level comma-separated args, respecting nested (), [], {} and strings.
function splitTopLevelArgs(source, startIdx, endIdx) {
  const args = [];
  let depth = 0, cur = "", inStr = null;
  for (let i = startIdx; i < endIdx; i++) {
    const c = source[i];
    if (inStr) {
      cur += c;
      if (c === inStr && source[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { inStr = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; cur += c; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; cur += c; continue; }
    if (c === "," && depth === 0) { args.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim().length) args.push(cur);
  return args.map(a => a.trim());
}

const IDENT_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

function scanFile(relPath, source) {
  const findings = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(source)) !== null) {
    const target = m[1];
    const eventType = m[3];
    const line = lineOf(source, m.index);

    const openParenIdx = source.indexOf("(", m.index + target.length);
    const closeParenIdx = findMatchingParen(source, openParenIdx);
    if (closeParenIdx === -1) continue; // unterminated call, skip

    const afterType = m.index + m[0].length;
    const args = splitTopLevelArgs(source, afterType, closeParenIdx);
    const handlerExpr = (args[0] || "").trim();
    const optsExpr = (args[1] || "").trim();

    if (/\bonce\s*:\s*true\b/.test(optsExpr)) continue; // self-cleaning idiom

    if (!IDENT_RE.test(handlerExpr)) {
      findings.push({
        file: relPath, line, target, eventType,
        rule: "inline_handler_uncleanable",
        severity: "error",
        message: `addEventListener("${eventType}", ...) on '${target}' was given an inline function/expression, not a named reference — removeEventListener() can never match it since a new function is created on every call.`,
      });
      continue;
    }

    const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedHandler = handlerExpr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedType = eventType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const removeRe = new RegExp(
      `\\b${escapedTarget}\\.removeEventListener\\s*\\(\\s*['"\`]${escapedType}['"\`]\\s*,\\s*${escapedHandler}\\b`
    );
    if (removeRe.test(source)) continue;

    findings.push({
      file: relPath, line, target, eventType, handler: handlerExpr,
      rule: "event_listener_never_removed",
      severity: "warning",
      message: `addEventListener("${eventType}", ${handlerExpr}) on '${target}' has no matching removeEventListener("${eventType}", ${handlerExpr}) anywhere in this file — the listener (and anything it closes over) will never be released.`,
    });
  }
  return findings;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function findMissingRemoveEventListener(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_remove_event_listener: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_remove_event_listener: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_remove_event_listener: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");
    findings.push(...scanFile(rel, source));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    errorCount, warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findMissingRemoveEventListener };
