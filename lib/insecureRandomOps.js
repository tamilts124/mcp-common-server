"use strict";
// ── FIND_INSECURE_RANDOM_USAGE — Math.random() in security-sensitive spots ─
// Flags `Math.random()` calls that appear to generate a security-sensitive
// value: (1) inside a function/method whose *name* implies that purpose
// (generateToken, createSession, resetPassword, ...), or (2) assigned
// directly to a variable/object-property whose *name* implies the same
// (const token = Math.random()..., { apiKey: Math.random()... }).
// Math.random() is not cryptographically secure (predictable PRNG state) —
// tokens/secrets/session ids/passwords generated from it can be brute-forced
// or predicted. Recommends crypto.randomBytes/randomUUID instead.
//
// Pure text-scan, not a real parser:
//   CAVEATS:
//     - name-based heuristic only — a sensitively-named function that
//       doesn't actually generate a credential (or a innocuously-named one
//       that does) will be mis-classified in either direction.
//     - function-name detection only recognizes brace-bodied functions
//       (declaration, arrow, function-expression, object/class method
//       shorthand) — bodyless single-expression arrows are out of scope,
//       same tradeoff as find_sync_fs_in_async_context.
//     - assignment/property detection is single-line only — a multi-line
//       `const token =\n  Math.random()...` is not joined across lines.
//     - matches are deduplicated by source line so a call already counted
//       via its enclosing sensitive function name isn't double-reported by
//       the assignment/property pass on the same line.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const SENSITIVE_NAME_RE = /token|secret|session|password|passwd|credential|api[_-]?key|otp|csrf|privatekey|private[_-]?key|resetcode|reset[_-]?code|verificationcode|verification[_-]?code|auth/i;
const RANDOM_RE = /Math\.random\s*\(\s*\)/g;

// Each captures the function/method name in group 1 and ends at the body's opening '{'.
const FUNC_SPAN_PATTERNS = [
  /(?:async\s+)?function\s*\*?\s*(\w+)\s*\([^)]*\)\s*\{/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{/g,
  /(\w+)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
  /(\w+)\s*:\s*(?:async\s+)?function\s*\*?\s*\([^)]*\)\s*\{/g,
  /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm,
];

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

function extractBody(source, openBraceIdx) {
  let depth = 1;
  let i = openBraceIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  return { body: source.slice(openBraceIdx + 1, i), endIdx: i };
}

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function findSensitiveFuncSpans(source) {
  const spans = [];
  for (const re of FUNC_SPAN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      if (!name || !SENSITIVE_NAME_RE.test(name)) continue;
      const openBraceIdx = m.index + m[0].length - 1;
      const { body, endIdx } = extractBody(source, openBraceIdx);
      spans.push({ name, bodyStart: openBraceIdx + 1, bodyEnd: endIdx, body });
    }
  }
  return spans;
}

function scanFileForInsecureRandom(relPath, source) {
  const findings = [];
  const seenLines = new Set();

  for (const span of findSensitiveFuncSpans(source)) {
    RANDOM_RE.lastIndex = 0;
    let m;
    while ((m = RANDOM_RE.exec(span.body)) !== null) {
      const absIdx = span.bodyStart + m.index;
      const line = lineOf(source, absIdx);
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      const lineStart = source.lastIndexOf("\n", absIdx) + 1;
      const lineEnd = source.indexOf("\n", absIdx);
      const text = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
      findings.push({ file: relPath, line, kind: "function-name", name: span.name, text });
    }
  }

  const lines = source.split("\n");
  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    if (seenLines.has(lineNum)) return;
    const trimmed = rawLine.trim();
    if (!trimmed || !RANDOM_RE.test(trimmed)) return;
    RANDOM_RE.lastIndex = 0;

    const assignM = /^(?:const|let|var)\s+(\w+)\s*=.*Math\.random\s*\(\s*\)/.exec(trimmed);
    if (assignM && SENSITIVE_NAME_RE.test(assignM[1])) {
      seenLines.add(lineNum);
      findings.push({ file: relPath, line: lineNum, kind: "assignment", name: assignM[1], text: trimmed });
      return;
    }

    const propM = /^(\w+)\s*:.*Math\.random\s*\(\s*\)/.exec(trimmed);
    if (propM && SENSITIVE_NAME_RE.test(propM[1])) {
      seenLines.add(lineNum);
      findings.push({ file: relPath, line: lineNum, kind: "property", name: propM[1], text: trimmed });
    }
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
function findInsecureRandomUsage(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_insecure_random_usage: max_results must be a number.", -32602);
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
      throw new ToolError(`find_insecure_random_usage: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForInsecureRandom(rel, source));
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

module.exports = { findInsecureRandomUsage };
