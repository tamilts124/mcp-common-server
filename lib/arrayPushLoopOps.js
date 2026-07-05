"use strict";
// ── FIND_UNBOUNDED_ARRAY_PUSH_IN_LOOP — unbounded in-memory array growth ──
// Scans JS/TS for `for(...)`/`while(...)` loops and `.forEach(`/`.map(`
// calls whose body `.push(`es onto an array that was declared (as an array
// literal `= []`) somewhere earlier in the same file, with no visible cap
// anywhere in the loop body (`.length <` bound check, `.slice(`, or a bare
// `break`). Building an ever-growing in-memory array inside a loop with no
// bound — especially one driven by external input (paginated API results,
// a stream, a queue) — is a common unbounded-memory-growth shape, distinct
// from find_unbounded_object_growth (object *key* growth, not array push)
// and find_missing_pagination_limit (HTTP response shape, not loop-local
// accumulation).
//
// `for`/`while`: the loop header is delimited by paren-depth matching from
// the header's opening `(` to its matching close (same findCallEnd
// convention as sibling scan tools), then the body is the brace-delimited
// block immediately following the header — single-statement loops with no
// `{...}` block are skipped rather than guessed at (their "body" extent
// isn't safely text-extractable the same way).
// `.forEach(`/`.map(`: the whole call (delimited the same paren-depth way)
// is treated as the body text, since the callback is just another argument
// inside that same outer call — this mirrors find_missing_pagination_limit's
// GET-route handling.
//
// The "declared outside the loop" check is a whole-file heuristic: it looks
// for `const/let/var <name> = [` anywhere earlier in the file, not a real
// scope/shadowing resolution — a same-named local declared inside a
// different, unrelated function earlier in the file could produce a false
// positive. Pure text-scan (regex + paren/brace-depth extraction), not an
// AST/data-flow parser, same documented-limitation style as sibling tools.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const FOR_WHILE_RE = /\b(for|while)\s*\(/g;
const FOREACH_MAP_RE = /\.\s*(forEach|map)\s*\(/g;
const PUSH_RE = /\b([a-zA-Z_$][\w$]*)\s*\.\s*push\s*\(/g;
const CAP_HINT_RE = /\.\s*length\s*<|\.\s*slice\s*\(|\bbreak\b/;

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

function findMatchingClose(source, openIdx, openCh, closeCh) {
  let depth = 1;
  let i = openIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function declaredAsArrayEarlier(source, varName, beforeIdx) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*\\[`);
  return re.test(source.slice(0, beforeIdx));
}

function collectLoopFindings(relPath, source, loopStartIdx, bodyText, findings) {
  const pushedVars = new Set();
  PUSH_RE.lastIndex = 0;
  let pm;
  while ((pm = PUSH_RE.exec(bodyText)) !== null) pushedVars.add(pm[1]);
  if (pushedVars.size === 0) return;
  if (CAP_HINT_RE.test(bodyText)) return;

  for (const varName of pushedVars) {
    if (!declaredAsArrayEarlier(source, varName, loopStartIdx)) continue;
    findings.push({
      file: relPath,
      line: lineOf(source, loopStartIdx),
      rule: "unbounded_array_push_in_loop",
      severity: "warning",
      message: `Loop pushes onto '${varName}' (declared as an array literal earlier in the file) with no visible cap (.length bound, .slice(), or break) anywhere in the loop body — this can grow the array unboundedly in memory.`,
    });
  }
}

function scanFile(relPath, source, findings) {
  FOR_WHILE_RE.lastIndex = 0;
  let m;
  while ((m = FOR_WHILE_RE.exec(source)) !== null) {
    const openParenIdx = m.index + m[0].length - 1;
    const headerEndIdx = findMatchingClose(source, openParenIdx, "(", ")");
    if (headerEndIdx === -1) { FOR_WHILE_RE.lastIndex = m.index + m[0].length; continue; }
    let j = headerEndIdx + 1;
    while (j < source.length && /\s/.test(source[j])) j++;
    if (source[j] !== "{") { FOR_WHILE_RE.lastIndex = headerEndIdx + 1; continue; } // single-statement loop body, skip rather than guess
    const braceCloseIdx = findMatchingClose(source, j, "{", "}");
    if (braceCloseIdx === -1) { FOR_WHILE_RE.lastIndex = j + 1; continue; }
    const bodyText = source.slice(j, braceCloseIdx + 1);
    collectLoopFindings(relPath, source, m.index, bodyText, findings);
    FOR_WHILE_RE.lastIndex = braceCloseIdx + 1;
  }

  FOREACH_MAP_RE.lastIndex = 0;
  while ((m = FOREACH_MAP_RE.exec(source)) !== null) {
    const openParenIdx = m.index + m[0].length - 1;
    const endIdx = findMatchingClose(source, openParenIdx, "(", ")");
    if (endIdx === -1) { FOREACH_MAP_RE.lastIndex = m.index + m[0].length; continue; }
    const bodyText = source.slice(openParenIdx, endIdx + 1);
    collectLoopFindings(relPath, source, m.index, bodyText, findings);
    FOREACH_MAP_RE.lastIndex = endIdx + 1;
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, loopsSeen, findingsCount, warningCount, truncated, findings}}
 */
function findUnboundedArrayPushInLoop(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_unbounded_array_push_in_loop: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unbounded_array_push_in_loop: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_unbounded_array_push_in_loop: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let loopsSeen = 0;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    const forWhileMatches = source.match(FOR_WHILE_RE);
    const forEachMapMatches = source.match(FOREACH_MAP_RE);
    loopsSeen += (forWhileMatches ? forWhileMatches.length : 0) + (forEachMapMatches ? forEachMapMatches.length : 0);

    scanFile(rel, source, findings);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    loopsSeen,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findUnboundedArrayPushInLoop };
