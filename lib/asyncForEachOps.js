"use strict";
// ── FIND_ASYNC_CALLBACK_IN_FOREACH — async-callback-in-.forEach() footgun scan ─
// Array.prototype.forEach() ignores its callback's return value and never
// awaits it. Passing an `async` callback compiles fine and any `await` INSIDE
// that callback works locally, but forEach itself moves on to the next
// iteration (and returns) immediately — the enclosing function has no way to
// wait for all iterations to finish, and a rejection inside the callback
// becomes an unhandled promise rejection instead of a catchable error. This
// is distinct from find_missing_await (which only flags a call site missing
// a preceding `await` — an await *inside* the forEach callback body defeats
// that check) and find_dangling_promises (statement-position floating
// promise, not forEach-specific).
//
// Detection, in order of preference:
//   1. `<expr>.forEach(async (...) => ...)` / `<expr>.forEach(async function
//      (...) {...})` / `<expr>.forEach(async x => ...)` — the callback is
//      inline and textually `async`. Always flagged: `foreach_inline_async_callback`
//      (error).
//   2. `<expr>.forEach(NAME)` where NAME was declared as an async function
//      elsewhere in the same file (declaration, arrow/function expression
//      assigned to a variable, or object/class method shorthand — same
//      name-collection technique as find_missing_await). Flagged as
//      `foreach_named_async_callback` (warning, lower confidence since the
//      identifier's async-ness is resolved by name only, not by scope).
//
// Deliberately NOT flagged (documented caveats, same "skip, don't guess"
// convention as the rest of this tool family):
//   - `.map(async ...)`, `.filter(async ...)`, etc. — only `.forEach(` is in
//     scope; other array methods have a different (often still buggy, but
//     distinct) return-value-discarding shape not covered by this tool.
//   - `for...of` / `for` loops with an async body — not a forEach call at
//     all.
//   - A `.forEach(name)` where `name` is not found among this file's
//     collected async declarations — skipped rather than guessed at (could
//     be async in another file, imported, or simply not async).
//   - Brace/paren counting ignores string/template/regex contents, so a
//     stray bracket inside a string can misplace boundaries.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

// Inline async callback passed directly to .forEach(
const INLINE_RE = /\.forEach\s*\(\s*async\b/g;

// Bare identifier passed to .forEach( — captures the identifier name.
const NAMED_CALLBACK_RE = /\.forEach\s*\(\s*(\w+)\s*\)/g;

// Same three async-declaration shapes used by find_missing_await:
//   async function NAME(...)
//   const/let/var NAME = async (...) => ...   |   = async function(...) {...}
//   NAME(...) { ... }  preceded by `async` (object/class method shorthand)
const ASYNC_FUNC_DECL_RE = /\basync\s+function\s+(\w+)\s*\(/g;
const ASYNC_VAR_ASSIGN_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*async\s*(?:\(|function\b|\w+\s*=>)/g;
const ASYNC_METHOD_SHORTHAND_RE = /\basync\s+(\w+)\s*\(([^)]*)\)\s*\{/g;

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

function collectAsyncNames(source) {
  const names = new Set();
  let m;

  ASYNC_FUNC_DECL_RE.lastIndex = 0;
  while ((m = ASYNC_FUNC_DECL_RE.exec(source)) !== null) names.add(m[1]);

  ASYNC_VAR_ASSIGN_RE.lastIndex = 0;
  while ((m = ASYNC_VAR_ASSIGN_RE.exec(source)) !== null) names.add(m[1]);

  ASYNC_METHOD_SHORTHAND_RE.lastIndex = 0;
  while ((m = ASYNC_METHOD_SHORTHAND_RE.exec(source)) !== null) {
    // Exclude false positives like `async function` matched again, and the
    // `async (` arrow-form parsed as a zero-name "method" — require the
    // captured name to not itself be "function".
    if (m[1] !== "function") names.add(m[1]);
  }

  return names;
}

function scanFile(relPath, source) {
  const findings = [];
  const asyncNames = collectAsyncNames(source);

  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(source)) !== null) {
    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      rule: "foreach_inline_async_callback",
      severity: "error",
      message: "Array.prototype.forEach() is called with an inline async callback — forEach never awaits the callback's returned promise, so iterations run without the caller being able to wait for them, and a rejection becomes an unhandled promise rejection instead of a catchable error. Use a for...of loop with await, or Promise.all(arr.map(async ...)) if concurrency is fine.",
    });
  }

  NAMED_CALLBACK_RE.lastIndex = 0;
  while ((m = NAMED_CALLBACK_RE.exec(source)) !== null) {
    const name = m[1];
    if (!asyncNames.has(name)) continue;
    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      callback: name,
      rule: "foreach_named_async_callback",
      severity: "warning",
      message: `Array.prototype.forEach() is called with '${name}', an async function declared in this file — forEach never awaits the callback's returned promise. Use a for...of loop with await, or Promise.all(arr.map(${name})) if concurrency is fine.`,
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
function findAsyncCallbackInForEach(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_async_callback_in_foreach: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_async_callback_in_foreach: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_async_callback_in_foreach: extensions must be an array of strings.", -32602);

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

module.exports = { findAsyncCallbackInForEach };
