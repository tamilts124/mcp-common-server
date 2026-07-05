"use strict";
// ── FIND_MISSING_RETURN_AFTER_RES_SEND — double-response / dead-code-after-send scan ─
// Express (and raw http) response objects are one-shot: once res.send/json/
// end/redirect has flushed a response, calling any of them again on the same
// request throws "Cannot set headers after they are sent to the client" and
// crashes the request (or, without a crash handler, the process). The classic
// cause is a handler that sends a response inside a conditional but forgets
// to `return` immediately after, so execution falls through to more code —
// most dangerously a second response-sending call later in the same block.
//
// Pure text-scan + brace-depth block extraction (same technique as
// find_missing_cleanup_on_early_return's findEnclosingBlockEnd), not an
// AST/CFG analyzer. Two rules:
//   `double_response_send` (error) — a second res.send/json/end/redirect
//   call is textually visible later in the same enclosing block after a
//   first one that wasn't itself `return`ed — near-certain double-send bug.
//   `missing_return_after_res_send` (warning) — the first call isn't
//   `return`ed and *some* other non-trivial statement follows it in the same
//   block (not just closing braces/comments/a bare `return;`) — code runs
//   after the response is already committed, which may or may not matter
//   depending on what that code does, hence warning not error.
//
// Caveats (consistent with the rest of this heuristic tool family):
//   - Brace/paren counting ignores string/template-literal/regex contents,
//     so a stray `{`/`}`/`(`/`)` inside a string can misplace boundaries.
//   - Only literal `res`/`response` receiver names are matched, with an
//     optional `.status(...)` chain immediately before the send-like call
//     (e.g. `res.status(404).json(...)`) — other chained calls, destructured
//     response objects, or renamed parameters are not tracked.
//   - An arrow function whose entire body is the call (`() => res.json(x)`,
//     no braces) is an implicit return and is never flagged.
//   - A trailing bare `return;` immediately after the call is treated as the
//     idiomatic "stop here" guard and does not itself trigger the warning.
//   - Both checks are scoped to the *innermost* enclosing `{...}` block, not
//     the whole enclosing function: a second send-like call sitting in a
//     sibling block one level up (e.g. inside an `if`, with the follow-up
//     call after the `if` closes) is NOT cross-block-detected. This trades
//     recall for a much lower false-positive rate — walking up to the
//     enclosing function without real scope/CFG tracking would flag many
//     harmless guard-clause patterns (`if (x) { res.send(y); return; }`
//     followed by unrelated code) as false positives.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// [1] = send-like method name. Optional `.status(...)` chain before it.
const SEND_CALL_RE = /\b(?:res|response)\s*(?:\.\s*status\s*\([^)]*\)\s*)?\.\s*(send|json|end|redirect)\s*\(/g;

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

// Naive matching-paren finder starting just after an opening '(' at openIdx-1.
// Ignores string/template contents (documented caveat). Returns index of the
// matching ')' or -1 if unterminated.
function findMatchingParen(source, openIdx) {
  let depth = 1;
  for (let i = openIdx + 1; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Same technique as cleanupEarlyReturnOps.findEnclosingBlockEnd.
function findEnclosingBlockEnd(source, pos) {
  const stack = [];
  for (let i = 0; i < pos; i++) {
    if (source[i] === "{") stack.push(i);
    else if (source[i] === "}") stack.pop();
  }
  if (stack.length === 0) return -1;
  let depth = 1;
  for (let i = pos; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return i; }
  }
  return source.length - 1;
}

function isReturnedOrImplicit(source, matchIndex) {
  const lineStart = source.lastIndexOf("\n", matchIndex - 1) + 1;
  const prefix = source.slice(lineStart, matchIndex).trim();
  if (/(?:^|[\s;{])return\s*$/.test(prefix)) return true; // `return res.send(...)`
  if (/=>\s*$/.test(prefix)) return true; // arrow implicit-return body
  return false;
}

function scanFile(relPath, source) {
  const findings = [];
  SEND_CALL_RE.lastIndex = 0;
  let m;
  while ((m = SEND_CALL_RE.exec(source)) !== null) {
    if (isReturnedOrImplicit(source, m.index)) continue;

    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParen(source, openParenIdx);
    if (closeParenIdx === -1) continue; // unterminated call, skip
    let afterCall = closeParenIdx + 1;
    if (source[afterCall] === ";") afterCall++;

    const blockEnd = findEnclosingBlockEnd(source, afterCall);
    const scopeEnd = blockEnd === -1 ? source.length : blockEnd;
    const scope = source.slice(afterCall, scopeEnd);

    const line = lineOf(source, m.index);
    const method = m[1];

    const mainLastIndex = SEND_CALL_RE.lastIndex; // resume point in `source` for the outer loop
    SEND_CALL_RE.lastIndex = 0;
    const hasAnotherSend = SEND_CALL_RE.test(scope);
    SEND_CALL_RE.lastIndex = mainLastIndex; // restore — do not let the scope-check disturb the outer scan

    if (hasAnotherSend) {
      findings.push({
        file: relPath, line, method,
        rule: "double_response_send",
        severity: "error",
        message: `res.${method}(...) is not returned, and another response-sending call appears later in the same block — this will throw 'Cannot set headers after they are sent' if this path is reached.`,
      });
      continue;
    }

    const stripped = scope
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/}/g, "")
      .replace(/\breturn\s*;/g, "")
      .trim();

    if (stripped.length > 0) {
      findings.push({
        file: relPath, line, method,
        rule: "missing_return_after_res_send",
        severity: "warning",
        message: `res.${method}(...) is not returned, and more code runs afterward in the same block — add 'return' before the call (or a bare 'return;' after it) to stop execution once the response is sent.`,
      });
    }
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
function findMissingReturnAfterResSend(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_return_after_res_send: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_return_after_res_send: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_return_after_res_send: extensions must be an array of strings.", -32602);

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

module.exports = { findMissingReturnAfterResSend };
