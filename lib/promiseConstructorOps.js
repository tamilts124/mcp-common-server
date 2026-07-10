"use strict";
/**
 * find_promise_constructor_antipattern
 *
 * Scans JS/TS files for two common Promise-constructor misuses that silently
 * swallow errors or add unnecessary complexity:
 *
 *   1. async_executor_in_promise_constructor (error)
 *      `new Promise(async (resolve, reject) => { ... })` — an async executor.
 *      If the async executor throws synchronously before the first `await`,
 *      or if a promise rejection occurs after `await` without a try/catch,
 *      the error is silently lost (the Promise constructor only wraps the
 *      SYNC throw from the executor, not async ones). Node.js itself warns
 *      about this pattern. Fix: remove the Promise wrapper entirely and
 *      use an async function returning the awaited value.
 *
 *   2. explicit_promise_wrap (warning)
 *      `new Promise((resolve, reject) => somePromise.then(resolve).catch(reject))`
 *      or `new Promise((resolve, reject) => somePromise.then(resolve, reject))`
 *      — explicit wrapping of an already-thenable value. The inner `.then`/
 *      `.catch` chain properly forwards resolution and rejection, but the whole
 *      construction is just `return somePromise` in disguise. Fix: return the
 *      inner promise directly, or use `Promise.resolve(somePromise)`.
 *
 * Siblings: find_dangling_promises, find_missing_try_catch_in_async,
 *   find_unhandled_rejection_patterns, find_promise_all_without_catch
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS    = 5000;

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
 * Extract the balanced parentheses block starting at `startIdx` in `src`.
 * Returns the substring between the outer parens (exclusive), or null if
 * the opening paren is not at startIdx after whitespace.
 */
function extractParenBlock(src, startIdx) {
  let i = startIdx;
  // Skip whitespace
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== "(") return null;
  let depth = 0;
  const start = i;
  while (i < src.length) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return src.slice(start + 1, i); }
    i++;
  }
  return null;
}

// Matches `new Promise(` — the executor arguments start immediately after
const NEW_PROMISE_RE = /\bnew\s+Promise\s*\(/g;

function scanFile(relPath, src) {
  const findings = [];

  NEW_PROMISE_RE.lastIndex = 0;
  let m;
  while ((m = NEW_PROMISE_RE.exec(src)) !== null) {
    // Extract the executor argument block
    const executorStr = extractParenBlock(src, m.index + m[0].length - 1);
    if (!executorStr) continue;

    const lineNo = lineOf(src, m.index);

    // ── Rule 1: async executor ───────────────────────────────────────────────
    // Matches: async (resolve, ...) => { or async function(resolve, ...) {
    const hasAsyncExecutor = /^\s*async\s*(\w|\(|function)/.test(executorStr);
    if (hasAsyncExecutor) {
      findings.push({
        file:     relPath,
        line:     lineNo,
        rule:     "async_executor_in_promise_constructor",
        severity: "error",
        message:
          `new Promise(async ...) — async executor detected. If the executor ` +
          `throws after an 'await', the error escapes the Promise constructor ` +
          `and becomes an unhandled rejection (Node.js ignores async throws ` +
          `from the executor). Remove the Promise wrapper entirely: make the ` +
          `enclosing function async and return the awaited value directly.`,
      });
      continue; // don't also flag Rule 2 for the same call
    }

    // ── Rule 2: explicit re-wrap of an already-thenable ─────────────────────
    // Patterns:
    //   (resolve, reject) => someExpr.then(resolve).catch(reject)
    //   (resolve, reject) => someExpr.then(resolve, reject)
    //   (resolve, reject) => { someExpr.then(resolve).catch(reject); }
    //   (resolve, reject) => { return someExpr.then(resolve).catch(reject); }
    const isExplicitWrap =
      /\.then\s*\(\s*resolve\s*,\s*reject\s*\)/.test(executorStr) ||
      /\.then\s*\(\s*resolve\s*\)\s*\.\s*catch\s*\(\s*reject\s*\)/.test(executorStr) ||
      /\.then\s*\(\s*resolve\s*\)\s*\.\s*catch\s*\(\s*err\s*=>\s*reject/.test(executorStr);
    if (isExplicitWrap) {
      findings.push({
        file:     relPath,
        line:     lineNo,
        rule:     "explicit_promise_wrap",
        severity: "warning",
        message:
          `new Promise((resolve, reject) => somePromise.then(resolve, reject)) ` +
          `wraps an already-thenable value unnecessarily. Return the inner ` +
          `promise directly, or use Promise.resolve(somePromise) if you need ` +
          `a guaranteed-native Promise. The explicit wrap adds no value and ` +
          `loses the inner promise's stack context in some engines.`,
      });
    }
  }

  return findings;
}

function findPromiseConstructorAntipattern(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_promise_constructor_antipattern: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_promise_constructor_antipattern: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_promise_constructor_antipattern: extensions must be an array.", -32602);

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

module.exports = { findPromiseConstructorAntipattern };
