"use strict";
// ── FIND_REGEX_DENIAL_OF_SERVICE_IN_ROUTE_PARAMS — ReDoS-via-user-input scan ─
// Pairs find_unsafe_regex's catastrophic-backtracking pattern shapes with
// request-input taint tracking (like find_open_redirect_risks' req.query/
// req.body sourcing): a regex applied to `req.params`/`req.query`/`req.body`
// is a much more exploitable ReDoS than one applied to trusted internal
// strings, because an attacker fully controls the input length/shape.
//
// Three independent rule shapes, pure text-scan (regex + small line
// window), not an AST/scope parser:
//   1. regex_pattern_from_request_input (critical) — `new RegExp(ARG)` where
//      the pattern argument ITSELF is sourced from req.params/query/body (or
//      a variable tainted from one of those) — the attacker controls the
//      whole regex, not just the input, which is a strictly worse "regex
//      injection" footgun. Always flagged regardless of the searched value.
//   2. unsafe_regex_against_request_input (error) — a regex literal or a
//      `new RegExp("literal-string")` whose PATTERN has a catastrophic-
//      backtracking shape (nested quantifier / quantified overlapping
//      alternation — same classifyPattern() as find_unsafe_regex) is applied
//      via .test(/.exec(/.match(/.replace( to a request-input-tainted value.
//   3. dynamic_regex_against_request_input (warning) — a `new RegExp(VAR)`
//      built from a non-literal, non-tainted expression (pattern shape is
//      unknown/unverifiable) is applied to a request-input-tainted value.
// A same-line or 10-line-lookback length-cap hint referencing the tainted
// name (`.slice(0,`/`.substring(0,`/a `.length >`/`.length <` comparison)
// suppresses the finding, since a capped input bounds worst-case backtrack
// time regardless of the pattern shape.
//
// Caveats shared with the rest of this heuristic tool family: no AST/
// data-flow tracking across function boundaries, taint tracking is a single
// forward pass over simple `const/let/var NAME = req.X[.Y]` assignments and
// one-level destructures, and regex-literal extraction can rarely
// false-positive on division operators (same limitation as find_unsafe_regex).

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const LOOKBACK_LINES = 10;

const REGEX_LITERAL = "\\/(?:\\\\.|\\[(?:\\\\.|[^\\]\\\\])*\\]|[^\\/\\n\\\\])+\\/[gimsuy]*";
// Quoted-string alternative (handles parens inside the string, e.g. '(a|a)+')
// so the RegExp(...) call boundary is found correctly instead of stopping at
// the first ')' character that happens to sit inside the pattern string.
const QSTR = "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`";
const NEW_REGEXP_ANY = `new\\s+RegExp\\(\\s*(?:${QSTR}|[A-Za-z_$][\\w$.]*)\\s*(?:,\\s*(?:${QSTR}|[A-Za-z_$][\\w$.]*))?\\s*\\)`;
const REGEX_OR_NEWREGEXP = `(?:${REGEX_LITERAL}|${NEW_REGEXP_ANY})`;

const TEST_EXEC_RE = new RegExp(`(${REGEX_OR_NEWREGEXP})\\s*\\.\\s*(test|exec)\\s*\\(\\s*([^)]*)\\)`);
const MATCH_REPLACE_RE = new RegExp(`([A-Za-z_$][\\w$.]*)\\s*\\.\\s*(match|replace)\\s*\\(\\s*(${REGEX_OR_NEWREGEXP})`);
const NEW_REGEXP_STRING_RE = /new\s+RegExp\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/;
const NEW_REGEXP_ARG_RE = /new\s+RegExp\(\s*([^,)]+)/;
const REQ_MEMBER_RE = /\breq\s*\.\s*(params|query|body)\b(?:\s*\.\s*([A-Za-z_$][\w$]*))?/;
const ASSIGN_FROM_REQ_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*req\s*\.\s*(?:params|query|body)\b/;
const DESTRUCTURE_FROM_REQ_RE = /^\s*(?:export\s+)?(?:const|let|var)\s*\{([^}]*)\}\s*=\s*req\s*\.\s*(?:params|query|body)\b/;

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

function hasNestedQuantifier(pattern) {
  return /\([^()]*[+*]\)[+*]/.test(pattern);
}

function overlappingAlternationQuantified(pattern) {
  const re = /\(([^()|]*)\|([^()|]*)\)[+*]/g;
  let m;
  while ((m = re.exec(pattern))) {
    const a = m[1], b = m[2];
    if (!a && !b) continue;
    if (a === b) return true;
    if (a && b.startsWith(a)) return true;
    if (b && a.startsWith(b)) return true;
  }
  return false;
}

function isUnsafeShape(pattern) {
  return hasNestedQuantifier(pattern) || overlappingAlternationQuantified(pattern);
}

function extractDestructuredNames(inner) {
  return inner.split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const colon = s.indexOf(":");
      const name = colon === -1 ? s : s.slice(colon + 1);
      return name.trim().replace(/=.*/, "").trim();
    })
    .filter(n => /^[A-Za-z_$][\w$]*$/.test(n));
}

const CAP_HINT_RE = /\.(?:slice|substring)\s*\(\s*0\s*,|\.length\s*(?:>|<|>=|<=)/;

// Build a map of variable names tainted by a direct req.params/query/body
// assignment or destructure, scanning the whole file in one forward pass.
// Each entry records whether the assignment line itself already applies a
// length cap (e.g. `const q = req.query.name.slice(0, 50);`).
function buildTaintedVars(lines) {
  const tainted = new Map();
  for (const line of lines) {
    const a = ASSIGN_FROM_REQ_RE.exec(line);
    if (a) tainted.set(a[1], { capped: CAP_HINT_RE.test(line) });
    const d = DESTRUCTURE_FROM_REQ_RE.exec(line);
    if (d) for (const n of extractDestructuredNames(d[1])) if (!tainted.has(n)) tainted.set(n, { capped: false });
  }
  return tainted;
}

function isTainted(argText, taintedVars) {
  if (!argText) return false;
  if (REQ_MEMBER_RE.test(argText)) return true;
  const id = argText.trim().match(/^[A-Za-z_$][\w$]*/);
  return !!(id && taintedVars.has(id[0]));
}

function isCappedVar(argText, taintedVars) {
  if (!argText) return false;
  const id = argText.trim().match(/^[A-Za-z_$][\w$]*/);
  return !!(id && taintedVars.get(id[0])?.capped);
}

function taintedIdentifier(argText, taintedVars) {
  const m = REQ_MEMBER_RE.exec(argText);
  if (m) return m[2] ? `req.${m[1]}.${m[2]}` : `req.${m[1]}`;
  const id = argText.trim().match(/^[A-Za-z_$][\w$]*/);
  return id ? id[0] : argText.trim();
}

function hasLengthCapNearby(lines, idx, name) {
  if (!name) return false;
  const nameRe = name.replace(/[.$]/g, "\\$&");
  const capRe = new RegExp(`\\b${nameRe}\\b\\s*\\.\\s*(?:slice|substring)\\s*\\(\\s*0\\s*,|\\b${nameRe}\\b\\s*\\.\\s*length\\s*(?:>|<|>=|<=)`);
  const start = Math.max(0, idx - LOOKBACK_LINES);
  for (let j = start; j <= idx; j++) if (capRe.test(lines[j])) return true;
  return false;
}

function classifyRegexToken(token) {
  // token is either a /literal/flags or new RegExp(...)
  if (token.startsWith("/")) {
    const body = token.slice(1, token.lastIndexOf("/"));
    return { kind: "literal", pattern: body, patternIsLiteral: true, patternSource: null };
  }
  const strMatch = NEW_REGEXP_STRING_RE.exec(token);
  if (strMatch) return { kind: "new_regexp", pattern: strMatch[2], patternIsLiteral: true, patternSource: null };
  const argMatch = NEW_REGEXP_ARG_RE.exec(token);
  return { kind: "new_regexp", pattern: null, patternIsLiteral: false, patternSource: argMatch ? argMatch[1].trim() : null };
}

function scanFile(relPath, source, taintedVars) {
  const findings = [];
  const lines = source.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const calls = [];

    const te = TEST_EXEC_RE.exec(line);
    if (te) calls.push({ token: te[1], method: te[2], arg: te[3] });

    const mr = MATCH_REPLACE_RE.exec(line);
    if (mr) calls.push({ token: mr[3], method: mr[2], arg: mr[1] });

    for (const call of calls) {
      const classified = classifyRegexToken(call.token);

      // Rule 1: the regex PATTERN itself is sourced from request input.
      if (!classified.patternIsLiteral && classified.patternSource && isTainted(classified.patternSource, taintedVars)) {
        findings.push({
          file: relPath, line: i + 1, rule: "regex_pattern_from_request_input", severity: "error",
          message: "RegExp pattern is built directly from request input (regex injection) — the attacker controls the entire pattern, guaranteeing a possible catastrophic-backtracking or arbitrary-match construction regardless of any length cap on the searched value.",
        });
        continue;
      }

      const argTainted = isTainted(call.arg, taintedVars);
      if (!argTainted) continue;

      const taintName = taintedIdentifier(call.arg, taintedVars);
      if (isCappedVar(call.arg, taintedVars) || hasLengthCapNearby(lines, i, taintName)) continue;

      if (classified.patternIsLiteral && classified.pattern !== null && isUnsafeShape(classified.pattern)) {
        findings.push({
          file: relPath, line: i + 1, rule: "unsafe_regex_against_request_input", severity: "error",
          message: `Catastrophic-backtracking-shaped regex is applied to request input ('${taintName}') with no visible length cap — an attacker can choose input length/shape to trigger ReDoS.`,
        });
      } else if (!classified.patternIsLiteral) {
        findings.push({
          file: relPath, line: i + 1, rule: "dynamic_regex_against_request_input", severity: "warning",
          message: `Dynamically-built regex (pattern safety unknown/unverifiable) is applied to request input ('${taintName}') with no visible length cap.`,
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
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults]
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function findRegexDosInRouteParams(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_regex_denial_of_service_in_route_params: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_regex_denial_of_service_in_route_params: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_regex_denial_of_service_in_route_params: extensions must be an array of strings.", -32602);

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
    const lines = source.split(/\r\n|\r|\n/);
    const taintedVars = buildTaintedVars(lines);
    findings.push(...scanFile(rel, source, taintedVars));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const finalFindings = findings.slice(0, maxResults);

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    errorCount: finalFindings.filter(f => f.severity === "error").length,
    warningCount: finalFindings.filter(f => f.severity === "warning").length,
    truncated,
    findings: finalFindings,
  };
}

module.exports = { findRegexDosInRouteParams };
