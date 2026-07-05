"use strict";
// ── FIND_MISSING_CLEANUP_ON_EARLY_RETURN — resource-leak-on-early-exit scan ─
// A function acquires a resource (a file descriptor, a timer, a lock) and
// releases it later in the same block — but an early `return`/`throw`
// between acquisition and release skips the release entirely unless it's
// guaranteed by a `finally`. Four resource kinds recognised by a fixed
// acquire/release pair, pure text-scan + brace-depth block extraction (not
// an AST parser):
//   fd       fs.openSync(...)              fs.closeSync(VAR)
//   interval setInterval(...)              clearInterval(VAR)
//   timeout  setTimeout(...)               clearTimeout(VAR)
//   lock     <expr>.lock(...)              VAR.unlock(...)
//
// Two rules:
//   `missing_cleanup_on_early_return` (error) — a release call for VAR
//   exists somewhere in the enclosing block, but a `return`/`throw` line
//   sits between the acquisition and that release with no `finally` keyword
//   anywhere in between (the cheap proxy for "cleanup is actually
//   guaranteed").
//   `resource_never_released` (warning) — no release call for VAR appears
//   anywhere in the enclosing block at all.
//
// Caveats shared with the rest of this heuristic tool family: brace
// counting does not understand strings/comments/regex literals, so a stray
// `{`/`}` inside a string can misplace the enclosing-block boundary; no
// cross-function tracking (a resource handed to a helper for cleanup reads
// as "never released" here); a `finally` anywhere between acquire and
// release is treated as sufficient regardless of what it actually cleans up.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ACQUIRES = [
  { kind: "fd",       re: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*fs\s*\.\s*openSync\s*\(/g,
    release: name => new RegExp(`\\bfs\\s*\\.\\s*closeSync\\s*\\(\\s*${name}\\b`) },
  { kind: "interval", re: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*setInterval\s*\(/g,
    release: name => new RegExp(`\\bclearInterval\\s*\\(\\s*${name}\\b`) },
  { kind: "timeout",  re: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*setTimeout\s*\(/g,
    release: name => new RegExp(`\\bclearTimeout\\s*\\(\\s*${name}\\b`) },
  { kind: "lock",     re: /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w.$]+\s*\.\s*lock\s*\(/g,
    release: name => new RegExp(`\\b${name}\\s*\\.\\s*unlock\\s*\\(`) },
];

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

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

// Returns the index (in `source`) of the closing brace of the innermost
// {...} block that encloses position `pos`, or -1 if none (top-level).
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

function lineOf(source, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function scanFile(relPath, source) {
  const findings = [];

  for (const acquire of ACQUIRES) {
    acquire.re.lastIndex = 0;
    let m;
    while ((m = acquire.re.exec(source)) !== null) {
      const varName = m[1];
      const acquireEnd = m.index + m[0].length;
      const blockEnd = findEnclosingBlockEnd(source, acquireEnd);
      const searchEnd = blockEnd === -1 ? source.length : blockEnd;
      const scope = source.slice(acquireEnd, searchEnd);

      const releaseRe = acquire.release(escapeRegExp(varName));
      const releaseMatch = releaseRe.exec(scope);

      if (!releaseMatch) {
        findings.push({
          file: relPath,
          line: lineOf(source, m.index),
          name: varName,
          kind: acquire.kind,
          rule: "resource_never_released",
          severity: "warning",
          message: `'${varName}' (${acquire.kind}) is acquired but no matching release call is visible anywhere in its enclosing block.`,
        });
        continue;
      }

      const between = scope.slice(0, releaseMatch.index);
      const hasFinally = /\bfinally\b/.test(between);
      const earlyExit = /\breturn\b|\bthrow\b/.test(between);

      if (earlyExit && !hasFinally) {
        findings.push({
          file: relPath,
          line: lineOf(source, m.index),
          name: varName,
          kind: acquire.kind,
          rule: "missing_cleanup_on_early_return",
          severity: "error",
          message: `'${varName}' (${acquire.kind}) is released later in the block, but an early return/throw between acquisition and release (with no 'finally') skips the release on that path.`,
        });
      }
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
function findMissingCleanupOnEarlyReturn(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_missing_cleanup_on_early_return: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_cleanup_on_early_return: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_cleanup_on_early_return: extensions must be an array of strings.", -32602);

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

module.exports = { findMissingCleanupOnEarlyReturn };
