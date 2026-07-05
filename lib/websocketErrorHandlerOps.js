"use strict";
// ── FIND_MISSING_WEBSOCKET_ERROR_HANDLER — unguarded socket 'error' scan ──
// Scans JS/TS for `.on('connection', ...)` registrations (ws's WebSocketServer
// or socket.io's `io.on('connection', ...)`) whose callback accepts a socket
// parameter but never registers a sibling `<socket>.on('error', ...)` listener
// inside the handler body. Node's EventEmitter throws (and, with no other
// listener, crashes the process) when an 'error' event is emitted with no
// listener attached — a raw TCP reset, protocol violation, or backpressure
// issue on an individual socket can therefore take down the whole server
// even though only one client misbehaved.
//
// Scope is the `.on(` call itself, delimited by paren-depth matching from the
// opening `(` to its matching close (same convention as sibling scan tools'
// findCallEnd) — this naturally covers the connection callback's full body.
//
// The socket/connection parameter name is extracted from the callback's
// first parameter (`(socket) =>`, `function(ws)`, etc.) so the sibling
// `.on('error', ...)` check is scoped to *that* variable, not just any
// `.on('error'` anywhere in the file. If the parameter name can't be
// extracted (unusual destructuring, no parameter at all), the registration
// is skipped rather than guessed at — same "skip, don't guess" convention as
// find_missing_pagination_limit's unterminated-call handling.
//
// Pure text-scan (regex + paren-depth extraction), not an AST parser: does
// not resolve whether the error listener is attached via a helper function
// the socket is passed into, only literal `<var>.on('error', ...)` inside
// the same connection-handler text counts as a fix.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const CONNECTION_RE = /\.\s*on\s*\(\s*(['"`])connection\1\s*,/g;
const PARAM_RE = /connection['"`]\s*,\s*(?:async\s*)?(?:function\s*\*?\s*\w*\s*\(|\()\s*([a-zA-Z_$][\w$]*)/;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function findCallEnd(source, openParenIdx) {
  let depth = 1;
  let i = openParenIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function scanFile(relPath, source, findings) {
  CONNECTION_RE.lastIndex = 0;
  let m;
  while ((m = CONNECTION_RE.exec(source)) !== null) {
    const openParenIdx = m.index + m[0].indexOf("(");
    const endIdx = findCallEnd(source, openParenIdx);
    if (endIdx === -1) { CONNECTION_RE.lastIndex = m.index + m[0].length; continue; } // unterminated call, skip rather than guess
    const handlerText = source.slice(openParenIdx, endIdx + 1);

    const paramMatch = PARAM_RE.exec(handlerText);
    if (paramMatch) {
      const varName = paramMatch[1];
      const errorListenerRe = new RegExp(`\\b${escapeRegex(varName)}\\s*\\.\\s*on\\s*\\(\\s*['"\`]error['"\`]`);
      if (!errorListenerRe.test(handlerText)) {
        findings.push({
          file: relPath,
          line: lineOf(source, m.index),
          rule: "missing_websocket_error_handler",
          severity: "warning",
          message: `Connection handler receives '${varName}' but never registers ${varName}.on('error', ...) — an unhandled 'error' event on this socket throws and can crash the process.`,
        });
      }
    }
    // no parseable parameter name: skip rather than guess
    CONNECTION_RE.lastIndex = endIdx + 1; // resume scanning after this call
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, connectionHandlersSeen, findingsCount, warningCount, truncated, findings}}
 */
function findMissingWebsocketErrorHandler(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_websocket_error_handler: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_websocket_error_handler: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_websocket_error_handler: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let connectionHandlersSeen = 0;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    const matches = source.match(CONNECTION_RE);
    connectionHandlersSeen += matches ? matches.length : 0;

    scanFile(rel, source, findings);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    connectionHandlersSeen,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findMissingWebsocketErrorHandler };
