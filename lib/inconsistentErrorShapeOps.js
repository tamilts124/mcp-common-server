"use strict";
// ── FIND_INCONSISTENT_ERROR_RESPONSE_SHAPE ────────────────────────────────
// Express route handlers that send an error response via
// `res.status(4xx/5xx).json({ KEY: ... })` should use the same top-level
// JSON key for every error in a file/router (e.g. always `error`, or always
// `message`) — client code that parses `err.error` breaks silently the
// moment a sibling handler in the same router sends `{ message: ... }`
// instead. Pure text-scan (regex over each file's full text, not an AST
// parser): every `res.status(<4xx|5xx>).json({ KEY: ... })` call site is
// extracted with its top-level object key; the first key seen in a file
// establishes that file's baseline shape, and every later call site in the
// same file using a *different* key is flagged.
//
// Caveats shared with the rest of this heuristic tool family: only the
// `res.status(N).json({...})` call shape is recognised (a bare `res.json()`
// with no explicit status, or a shape built via an intermediate variable
// like `const body = {...}; res.status(500).json(body);`, is invisible to
// this scan); only the object literal's *first* key is read, so
// `{ message: x, code: y }` is classified by `message` only; baseline is
// per-file, not per-router-mount, so two files that both define parts of
// the same logical router are checked independently.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ERROR_RESPONSE_RE = /res\s*\.\s*status\s*\(\s*([45]\d\d)\s*\)\s*\.\s*json\s*\(\s*\{\s*([A-Za-z_$][\w$]*)\s*:/g;

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

function scanFile(relPath, source) {
  const findings = [];
  const calls = [];
  ERROR_RESPONSE_RE.lastIndex = 0;
  let m;
  while ((m = ERROR_RESPONSE_RE.exec(source)) !== null) {
    calls.push({ status: m[1], key: m[2], line: lineOf(source, m.index) });
  }
  if (calls.length < 2) return findings;

  const baseline = calls[0];
  for (let i = 1; i < calls.length; i++) {
    if (calls[i].key !== baseline.key) {
      findings.push({
        file: relPath,
        line: calls[i].line,
        key: calls[i].key,
        rule: "inconsistent_error_response_shape",
        severity: "warning",
        message: `Error response uses key '${calls[i].key}', but this file's first error response (line ${baseline.line}) used '${baseline.key}' — inconsistent client-facing error contract within the same file.`,
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
 * @returns {{path, filesScanned, findingsCount, truncated, findings}}
 */
function findInconsistentErrorResponseShape(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_inconsistent_error_response_shape: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_inconsistent_error_response_shape: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_inconsistent_error_response_shape: extensions must be an array of strings.", -32602);

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

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findInconsistentErrorResponseShape };
