"use strict";
// ── FIND_HARDCODED_PORTS — deployment portability hygiene ─────────────────
// Scans JS/TS source for `.listen(...)` call sites (covers `app.listen(N)`,
// `server.listen(N, ...)`, `http.createServer(...).listen(N)`, etc.) whose
// first argument is a bare numeric literal rather than something sourced
// from configuration (`process.env.PORT`, a config object, a CLI arg, etc).
// A hardcoded port number breaks portability — the app can't be run twice
// on one host, can't be reconfigured for a different environment without a
// code edit, and commonly collides with other services in containerized/CI
// setups where the port must be injected at runtime.
//
// Pure text-scan (regex on the `.listen(` call site's first argument), not
// a real parser:
//   CAVEATS:
//     - only the first argument is inspected. `server.listen(port, host)`
//       correctly ignores `host` — only whether the PORT itself is a bare
//       literal matters.
//     - a first argument that is a plain identifier (`server.listen(port)`)
//       is never flagged, even if that identifier is itself assigned a
//       hardcoded literal a few lines earlier — no cross-line data-flow
//       tracing is attempted (same scope-limiting tradeoff as
//       find_missing_await's same-file-only convention, but narrower still:
//       this tool doesn't even trace same-file assignments). Reduces false
//       positives at the cost of missing indirect hardcoding.
//     - an expression like `3000 || process.env.PORT` is flagged (its
//       resolved value still defaults to a hardcoded literal in the common
//       case), but `process.env.PORT || 3000` is NOT flagged (the literal
//       is only a fallback) — order of the `||` operands matters, matching
//       how `process.env.PORT` presence is checked in the full argument text.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const LISTEN_RE = /\.listen\s*\(\s*([^,)]*)/g;

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

function classifyArg(arg) {
  const trimmed = arg.trim();
  if (trimmed === "") return null; // .listen() with no args (or a callback-only call) — nothing to flag
  // NOTE: env-ref detection is order-sensitive — see leading-digit check below,
  // Pure numeric literal: "3000", "3000 || 8080" (still a literal default), etc.
  // Only flag when the leading token is itself a numeric literal — this is
  // the common `.listen(3000)` / `.listen(3000, () => {})` shape.
  const m = /^(\d{1,5})\b/.exec(trimmed);
  if (!m) return null;
  return Number(m[1]);
}

function scanFileForHardcodedPorts(relPath, source) {
  const findings = [];
  LISTEN_RE.lastIndex = 0;
  let m;
  while ((m = LISTEN_RE.exec(source)) !== null) {
    const port = classifyArg(m[1]);
    if (port === null) continue;
    const idx = m.index;
    const lineStart = source.lastIndexOf("\n", idx) + 1;
    const lineEnd = source.indexOf("\n", idx);
    const lineText = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
    findings.push({ file: relPath, line: lineOf(source, idx), port, text: lineText });
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
function findHardcodedPorts(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_hardcoded_ports: max_results must be a number.", -32602);
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
      throw new ToolError(`find_hardcoded_ports: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForHardcodedPorts(rel, source));
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

module.exports = { findHardcodedPorts };
