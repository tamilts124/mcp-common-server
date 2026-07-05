"use strict";
// ── FIND_MISSING_STREAM_ERROR_HANDLER — unguarded stream/request 'error' scan ─
// Node's fs.createReadStream/createWriteStream results (Readable/Writable) and
// http(s).request/get results (ClientRequest, plus the response stream) are
// EventEmitters: an 'error' event emitted with zero listeners throws and, with
// no process-level uncaughtException handler, crashes the whole process — a
// single bad file path, disk-full write, or network reset can take the server
// down even though only one operation failed. This scans for creation calls
// that never get a sibling `.on('error', ...)` attached.
//
// Detection, in order of preference:
//   1. `const/let/var NAME = fs.createReadStream(...)` (or createWriteStream /
//      http(s).request / http(s).get) — then the enclosing `{...}` block
//      (same brace-depth technique as cleanupEarlyReturnOps.findEnclosingBlockEnd)
//      is searched for a literal `NAME.on('error'` or `NAME.once('error'`.
//   2. No assignment, but `.on('error', ...)` is chained directly onto the
//      call before the next statement boundary (`fs.createReadStream(x).on('error', ...)`)
//      — counted as handled without needing a variable.
//
// Deliberately NOT flagged (documented caveats, same "skip, don't guess"
// convention as the rest of this tool family):
//   - Calls textually inside a `pipeline(` / `promisify(pipeline)(` wrapper —
//     Node's stream.pipeline() forwards every stream's errors to its own
//     callback/rejection automatically, so no per-stream `.on('error')` is
//     needed. Detected by a simple textual `pipeline(` lookback on the same
//     statement, not real call-target resolution.
//   - Calls whose variable name can't be extracted AND aren't chained with an
//     inline `.on('error'` — skipped rather than guessed at.
//   - Only literal `fs.`/`http.`/`https.` receivers are matched; re-exported
//     or destructured (`const { createReadStream } = require('fs')`) call
//     styles are not recognized.
//   - Brace/paren counting ignores string/template/regex contents, so a stray
//     bracket inside a string can misplace boundaries.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// [1] = optional assignment keyword (unused, just anchors), [2] = variable name.
// [3] = which stream-producing call was used.
const CREATE_RE = /(?:(const|let|var)\s+(\w+)\s*=\s*)?\b(fs\.createReadStream|fs\.createWriteStream|https?\.request|https?\.get)\s*\(/g;

const TYPE_LABEL = {
  "fs.createReadStream": "readStream",
  "fs.createWriteStream": "writeStream",
  "http.request": "httpRequest",
  "https.request": "httpRequest",
  "http.get": "httpRequest",
  "https.get": "httpRequest",
};

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

// Same technique as missingReturnAfterResSendOps.findEnclosingBlockEnd.
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

function scanFile(relPath, source) {
  const findings = [];
  CREATE_RE.lastIndex = 0;
  let m;
  while ((m = CREATE_RE.exec(source)) !== null) {
    const varName = m[2];
    const callName = m[3];
    const line = lineOf(source, m.index);
    const type = TYPE_LABEL[callName] || "stream";

    // Skip calls wrapped in stream.pipeline(...) — errors auto-forwarded.
    const lineStart = source.lastIndexOf("\n", m.index - 1) + 1;
    const stmtPrefix = source.slice(lineStart, m.index);
    if (/\bpipeline\s*\(\s*$/.test(stmtPrefix) || /\bpipeline\s*\(\s*[\s\S]{0,80}$/.test(stmtPrefix)) continue;

    const openParenIdx = m.index + m[0].length - 1;
    const closeParenIdx = findMatchingParen(source, openParenIdx);
    if (closeParenIdx === -1) continue; // unterminated call, skip

    let afterCall = closeParenIdx + 1;

    if (!varName) {
      // Check for an inline chained `.on('error', ...)` immediately after the call.
      const chainWindow = source.slice(afterCall, afterCall + 400);
      const chainMatch = /^\s*(?:\.\s*on\s*\(\s*['"`]error['"`]|\.\s*pipe\s*\([^)]*\)\s*\.\s*on\s*\(\s*['"`]error['"`])/.exec(chainWindow);
      if (chainMatch) continue; // handled inline
      // Also allow a directly chained `.on('error', ...)` anywhere before the
      // statement's terminating semicolon (covers `.on('data',...).on('error',...)`).
      const semiIdx = source.indexOf(";", afterCall);
      const stmtEnd = semiIdx === -1 ? Math.min(source.length, afterCall + 400) : semiIdx;
      const stmtChain = source.slice(afterCall, stmtEnd);
      if (/\.\s*on\s*\(\s*['"`]error['"`]/.test(stmtChain)) continue;
      continue; // no variable and no inline handler visible — skip (can't guess)
    }

    const blockEnd = findEnclosingBlockEnd(source, afterCall);
    const scopeEnd = blockEnd === -1 ? source.length : blockEnd;
    const scope = source.slice(afterCall, scopeEnd);

    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const handlerRe = new RegExp(`\\b${escaped}\\s*\\.\\s*(?:on|once)\\s*\\(\\s*['"\`]error['"\`]`);
    if (handlerRe.test(scope)) continue;

    findings.push({
      file: relPath, line, variable: varName, type,
      rule: "missing_stream_error_handler",
      severity: "warning",
      message: `${callName}(...) assigned to '${varName}' has no sibling '${varName}.on(\"error\", ...)' listener in the enclosing block — an emitted 'error' event will throw uncaught and can crash the process.`,
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
 * @returns {{path, filesScanned, findingsCount, warningCount, truncated, findings}}
 */
function findMissingStreamErrorHandler(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_stream_error_handler: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_stream_error_handler: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_stream_error_handler: extensions must be an array of strings.", -32602);

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
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findMissingStreamErrorHandler };
