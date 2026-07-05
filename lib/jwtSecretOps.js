"use strict";
// ── FIND_HARDCODED_JWT_SECRET — literal secret args to jsonwebtoken calls ──
// Flags `jwt.sign(payload, SECRET, ...)` / `jwt.verify(token, SECRET, ...)`
// call sites (jsonwebtoken's conventional `jwt` import name, or any
// identifier whose own require/import target is 'jsonwebtoken') where the
// SECRET argument is a string/template literal rather than a variable,
// property access (process.env.*, config.*), or function call. A hardcoded
// signing secret compromises every token ever issued by the app and can't
// be rotated without a code change — distinct from scan_secrets (generic
// entropy/pattern-based scan over arbitrary text) and
// find_hardcoded_credentials_in_config (config files only, not JS/TS
// call-sites).
//
// Pure text-scan, not a real parser:
//   CAVEATS:
//     - only recognizes calls made through an identifier literally named
//       `jwt` OR through an identifier whose require('jsonwebtoken')/import
//       ... from 'jsonwebtoken' binding was found earlier in the same file
//       (so `const token = require('jsonwebtoken'); token.sign(...)` is
//       still recognized even though the local name isn't `jwt`).
//     - the secret argument is extracted via a simple top-level-comma split
//       over the balanced-paren call-argument text — a secret argument that
//       is itself a call/object/array containing a comma at paren-depth 0
//       relative to the whole call (extremely unusual for a real jwt.sign
//       secret) is not specially handled beyond depth tracking.
//     - a secret argument that's a plain string/template literal is
//       flagged unconditionally, even if that literal happens to just be a
//       short placeholder like "" in a test fixture — no entropy/length
//       heuristic is applied (any literal is a literal), same "shape, not
//       semantics" tradeoff used by find_hardcoded_credentials_in_config.
//     - a `{ secret: 'literal' }` options-object shape used by some JWT
//       libraries is out of scope for v1 — only jsonwebtoken's positional
//       2nd-argument convention is checked.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const JWT_BINDING_RE = /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["']jsonwebtoken["']\s*\)|import\s+(\w+)\s+from\s+["']jsonwebtoken["']/g;
const CALL_RE_TMPL = (name) => new RegExp(`\\b${name}\\s*\\.\\s*(sign|verify)\\s*\\(`, "g");
const STRING_OR_TEMPLATE_LITERAL_RE = /^\s*(['"`])(?:(?!\1)[^\\]|\\.)*\1\s*$/;

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

// Extract the full balanced-paren argument text of a call whose '(' is at openIdx.
// Returns { argsText, endIdx } where endIdx is the index of the matching ')'.
function extractCallArgs(source, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) break; }
  }
  return { argsText: source.slice(openIdx + 1, i), endIdx: i };
}

// Split call-argument text on top-level commas (respecting (), [], {} nesting
// and skipping commas inside string/template literals).
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let start = 0;
  let inString = null;
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { inString = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(argsText.slice(start, i));
      start = i + 1;
    }
  }
  args.push(argsText.slice(start));
  return args;
}

function findJwtIdentifiers(source) {
  const names = new Set(["jwt"]);
  JWT_BINDING_RE.lastIndex = 0;
  let m;
  while ((m = JWT_BINDING_RE.exec(source)) !== null) {
    const name = m[1] || m[2];
    if (name) names.add(name);
  }
  return names;
}

function scanFileForHardcodedJwtSecret(relPath, source) {
  const findings = [];
  const jwtNames = findJwtIdentifiers(source);

  for (const name of jwtNames) {
    const callRe = CALL_RE_TMPL(name);
    let m;
    while ((m = callRe.exec(source)) !== null) {
      const method = m[1];
      const openIdx = m.index + m[0].length - 1;
      const { argsText, endIdx } = extractCallArgs(source, openIdx);
      const args = splitTopLevelArgs(argsText);
      // sign(payload, secret, ...) / verify(token, secret, ...) — secret is arg[1].
      if (args.length < 2) continue;
      const secretArg = args[1].trim();
      if (!secretArg || !STRING_OR_TEMPLATE_LITERAL_RE.test(secretArg)) continue;

      const line = lineOf(source, m.index);
      const lineStart = source.lastIndexOf("\n", m.index) + 1;
      const lineEnd = source.indexOf("\n", endIdx);
      const text = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
      findings.push({
        file: relPath,
        line,
        method: `${name}.${method}`,
        secretPreview: secretArg.length > 40 ? secretArg.slice(0, 40) + "…" : secretArg,
        text,
      });
      callRe.lastIndex = endIdx;
    }
  }

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
function findHardcodedJwtSecret(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_hardcoded_jwt_secret: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_hardcoded_jwt_secret: extensions must be an array of strings.", -32602);
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
      throw new ToolError(`find_hardcoded_jwt_secret: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForHardcodedJwtSecret(rel, source));
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

module.exports = { findHardcodedJwtSecret };
