"use strict";
// ── FIND_DANGLING_PROMISES — floating Promises left unhandled ────────────
// Scans JS/TS for two floating-Promise shapes used as a *bare statement*
// (the line starts the statement, i.e. not awaited/returned/assigned):
//   1. A call to a known same-file async function, e.g. `doThing();`
//   2. A `.then(`-chained expression, e.g. `promise.then(cb);` /
//      `foo().then(cb);`
// Either shape is flagged unless a `.catch(` also appears on the same line
// (rejection handled). Complements find_missing_await (which flags ANY
// non-awaited call to a known async function, including ones passed as
// arguments or used in conditions) by focusing specifically on *statement*
// position — the actual "unhandled rejection" risk shape.
//
// Pure text-scan (regex per trimmed line), not a real parser:
//   CAVEATS:
//     - only same-file async function declarations are tracked for shape 1
//       (no cross-module import resolution), same scope limit as
//       find_missing_await.
//     - single-line statements only — a `.then(` chain that wraps onto
//       multiple lines is not detected (no multi-line statement joining).
//     - `.finally(` is not treated as handling the rejection (only `.catch(`
//       counts) — matches how unhandled-rejection linters usually reason.
//     - a bare call to an *unknown* function (not a local async name, not
//       `.then(`-chained) is never flagged — this tool cannot know if an
//       imported/external function returns a Promise.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const DECL_PATTERNS = [
  /async\s+function\s*\*?\s*(\w+)/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*async\s*\(/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*async\s+function/g,
  /(\w+)\s*:\s*async\s*\(/g,
  /^\s*async\s+(\w+)\s*\(/gm,
];

const THEN_CALL_RE = /^[\w$]+\s*\([^;]*\)\s*\.then\s*\(/;   // foo(...).then(
const THEN_PLAIN_RE = /^[\w$][\w$.]*\.then\s*\(/;           // myPromise.then(

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

function isDeclarationLine(line) {
  for (const re of DECL_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(line)) return true;
  }
  return false;
}

function findAsyncNames(source) {
  const names = new Set();
  for (const re of DECL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  return names;
}

function classifyLine(trimmed, asyncNames) {
  if (trimmed.includes(".catch(")) return null; // rejection handled on this line
  const callMatch = /^([\w$]+)\s*\(/.exec(trimmed);
  if (callMatch && asyncNames.has(callMatch[1])) return "async-call";
  if (THEN_CALL_RE.test(trimmed) || THEN_PLAIN_RE.test(trimmed)) return "then-chain";
  return null;
}

function scanFileForDanglingPromises(relPath, source) {
  const asyncNames = findAsyncNames(source);
  const lines = source.split("\n");
  const findings = [];

  lines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (isDeclarationLine(rawLine)) return;
    if (/^(await|return|const|let|var)\b/.test(trimmed)) return; // handled/assigned

    const kind = classifyLine(trimmed, asyncNames);
    if (kind) findings.push({ file: relPath, line: idx + 1, kind, text: trimmed });
  });

  return findings;
}

/**
 * @param {string} absTarget  Absolute, jail-validated file or directory.
 * @param {string} origPath   Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults] Cap on findings[] length (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, truncated, findings: Array}}
 */
function findDanglingPromises(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_dangling_promises: max_results must be a number.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;

  const stat = fs.statSync(absTarget);
  const isDirectory = stat.isDirectory();

  let files;
  if (isDirectory) {
    files = collectFiles(absTarget, extensions);
  } else {
    if (!extensions.some(e => absTarget.endsWith(e)))
      throw new ToolError(`find_dangling_promises: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForDanglingPromises(rel, source));
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

module.exports = { findDanglingPromises };
