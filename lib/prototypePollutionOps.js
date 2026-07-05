"use strict";
// ── FIND_PROTOTYPE_POLLUTION_RISK — unguarded deep-merge / recursive-assign ─
// Prototype pollution: a deep-merge/recursive-assign that copies attacker-
// controlled keys (`__proto__`, `constructor`, `prototype`) onto a shared
// object corrupts Object.prototype for the whole process. Flags three shapes:
//   - `prototype_pollution_via_merge` (error) — `_.merge(`/`lodash.merge(`/
//     `deepmerge(` called with a request-input-tainted argument
//     (`req.body`/`req.query`/`req.params`/`JSON.parse(...)`) and no
//     `__proto__`/`constructor`/`prototype` guard hint nearby.
//   - `prototype_pollution_via_object_assign` (warning) — `Object.assign(`
//     called with a tainted source argument and no guard hint nearby.
//     `Object.assign` is shallow, but a source object with a literal
//     `__proto__` own key (e.g. from `JSON.parse(userInput)`) still invokes
//     Object.prototype's `__proto__` accessor on assignment — a real,
//     if narrower, footgun, so this stays a warning rather than an error.
//   - `unguarded_recursive_merge_function` (warning) — a hand-rolled
//     function whose body both (a) iterates a source object's keys
//     (`for...in`, `Object.keys(...).forEach(`, `for...of Object.keys(...)`)
//     and (b) assigns into a target via bracket notation (`target[key] =`),
//     with no `__proto__`/`constructor`/`prototype` guard anywhere in the
//     function body — the classic hand-rolled deep-merge footgun.
//
// Pure text-scan (regex + brace-depth function-body extraction), not an
// AST/data-flow parser:
//   CAVEATS:
//     - the merge/assign taint check is a same-line-or-small-window textual
//       signal, not proof the tainted value actually reaches the call.
//     - the guard hint is textual presence anywhere nearby/in-body, not
//       proof it actually short-circuits the dangerous key — a guard that
//       checks the wrong variable still suppresses the finding.
//     - recursive-merge-function detection requires both sub-patterns in
//       the SAME function body; a merge split across two mutually-calling
//       functions is not tracked (no cross-function call-graph analysis).
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const MERGE_CALL_RE = /\b(?:_\s*\.\s*merge|lodash\s*\.\s*merge|deepmerge)\s*\(/g;
const OBJECT_ASSIGN_CALL_RE = /\bObject\s*\.\s*assign\s*\(/g;
const TAINT_SOURCE_RE = /req\s*\.\s*(?:body|query|params)\b|JSON\.parse\s*\(/i;
const GUARD_HINT_RE = /__proto__|\bprototype\b|\bconstructor\b/i;

const FUNCTION_DECL_RE = /(?:function\s+(\w+)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+(\w+)\s*=\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>|\w+\s*=>)\s*\{)/g;
const KEY_ITERATION_RE = /for\s*\(\s*(?:const|let|var)\s+\w+\s+in\s+\w+\s*\)|Object\.keys\s*\([^)]*\)\s*\.\s*forEach\s*\(|for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+Object\.keys\s*\(/;
const BRACKET_ASSIGN_RE = /\b\w+\s*\[\s*\w+\s*\]\s*=(?!=)/;

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
  return source.slice(0, idx).split("\n").length;
}

function nearbyWindow(source, idx, radius = 150) {
  return source.slice(Math.max(0, idx - radius), Math.min(source.length, idx + radius));
}

// Matches parens starting at `openIdx` (the '(' itself) and returns the
// index just past its matching ')', or -1 if unbalanced.
function matchParen(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// Matches braces starting at `openIdx` (the '{' itself) and returns the
// index just past its matching '}', or -1 if unbalanced.
function matchBrace(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

function scanCallSites(source, re, ruleWhenTainted, severity, messageFn) {
  const findings = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchParen(source, openParen);
    const argsText = closeParen === -1 ? source.slice(openParen, openParen + 300) : source.slice(openParen, closeParen);
    if (!TAINT_SOURCE_RE.test(argsText)) continue;
    if (GUARD_HINT_RE.test(nearbyWindow(source, m.index))) continue;
    findings.push({ line: lineOf(source, m.index), rule: ruleWhenTainted, severity, message: messageFn() });
  }
  return findings;
}

function scanRecursiveMergeFunctions(source) {
  const findings = [];
  FUNCTION_DECL_RE.lastIndex = 0;
  let m;
  while ((m = FUNCTION_DECL_RE.exec(source)) !== null) {
    const braceOpen = source.indexOf("{", m.index + m[0].length - 1);
    if (braceOpen === -1) continue;
    const braceClose = matchBrace(source, braceOpen);
    if (braceClose === -1) continue;
    const body = source.slice(braceOpen, braceClose);
    if (KEY_ITERATION_RE.test(body) && BRACKET_ASSIGN_RE.test(body) && !GUARD_HINT_RE.test(body)) {
      const name = m[1] || m[2] || "(anonymous)";
      findings.push({
        line: lineOf(source, m.index), rule: "unguarded_recursive_merge_function", severity: "warning",
        functionName: name,
        message: `Function '${name}' iterates a source object's keys and assigns into a target via bracket notation with no '__proto__'/'constructor'/'prototype' guard — a hand-rolled deep-merge shape vulnerable to prototype pollution if the source is attacker-controlled.`,
      });
    }
  }
  return findings;
}

function scanFileForPrototypePollution(relPath, source) {
  const findings = [
    ...scanCallSites(source, MERGE_CALL_RE, "prototype_pollution_via_merge", "error",
      () => "Deep-merge call receives a request-input-tainted argument with no '__proto__'/'constructor'/'prototype' guard nearby — attacker-controlled keys can pollute Object.prototype."),
    ...scanCallSites(source, OBJECT_ASSIGN_CALL_RE, "prototype_pollution_via_object_assign", "warning",
      () => "Object.assign() receives a request-input-tainted source argument with no '__proto__'/'constructor'/'prototype' guard nearby — a source with a literal '__proto__' own key (e.g. from JSON.parse) can still pollute Object.prototype."),
    ...scanRecursiveMergeFunctions(source),
  ];
  for (const f of findings) f.file = relPath;
  return findings;
}

/**
 * @param {string} absTarget  Absolute, jail-validated file or directory.
 * @param {string} origPath   Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults] Cap on findings[] length (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: Array}}
 */
function findPrototypePollutionRisk(absTarget, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absTarget); }
  catch (e) { throw new ToolError(`find_prototype_pollution_risk: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_prototype_pollution_risk: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_prototype_pollution_risk: extensions must be an array of strings.", -32602);

  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;

  const isDirectory = stat.isDirectory();
  let files;
  if (isDirectory) {
    files = collectFiles(absTarget, extensions);
  } else {
    if (!extensions.some(e => absTarget.endsWith(e)))
      throw new ToolError(`find_prototype_pollution_risk: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }
  const baseDir = isDirectory ? absTarget : path.dirname(absTarget);

  const findings = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    findings.push(...scanFileForPrototypePollution(rel, buf.toString("utf8")));
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

module.exports = { findPrototypePollutionRisk };
