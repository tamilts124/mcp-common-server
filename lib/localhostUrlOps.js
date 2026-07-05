"use strict";
// ── FIND_HARDCODED_LOCALHOST_URLS — dev-URL-shipped-to-prod hygiene scan ──
// Scans JS/TS source for literal `http://localhost`, `https://localhost`,
// `http://127.0.0.1`, `ws://localhost`, `wss://localhost` (with optional
// :port) URLs. A dev-only base URL hardcoded into source instead of read
// from configuration silently breaks in any deployed environment.
//
// Distinct from find_hardcoded_ips (any IP literal, no URL-scheme/localhost
// focus) and find_hardcoded_ports (bare `.listen(N)` port literals, not
// URLs). Files whose path contains test/spec/mock/fixture/__tests__/__mocks__
// segments are skipped by default — localhost URLs in test fixtures are
// expected and not a bug.
//
// Pure text-scan (regex), not a data-flow parser: doesn't check whether the
// literal sits inside a `NODE_ENV !== 'production'`-guarded branch or is
// only used as a fallback after `process.env.API_URL ||`.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const LOCALHOST_URL_RE = /\b(https?|wss?):\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?[^\s'"`)]*/g;
const TEST_PATH_RE = /(^|[\\/])(test|tests|spec|specs|mocks?|fixtures?|__tests__|__mocks__)([\\/]|$)/i;

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

function scanFile(relPath, source, findings) {
  LOCALHOST_URL_RE.lastIndex = 0;
  let m;
  while ((m = LOCALHOST_URL_RE.exec(source)) !== null) {
    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      rule: "hardcoded_localhost_url",
      severity: "warning",
      message: `Hardcoded dev URL '${m[0]}' — read the base URL from configuration/environment instead so it works outside local development.`,
    });
  }
}

/**
 * @param {string} absTarget  Absolute, jail-validated file or directory.
 * @param {string} origPath   Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on findings[] length (1-5000, default 500).
 * @param {boolean}  [opts.includeTestFiles] If true, don't skip test/spec/mock/fixture paths (default false).
 * @returns {{path, filesScanned, filesSkippedAsTest, findingsCount, warningCount, truncated, findings}}
 */
function findHardcodedLocalhostUrls(absTarget, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absTarget); }
  catch (e) { throw new ToolError(`find_hardcoded_localhost_urls: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_hardcoded_localhost_urls: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_hardcoded_localhost_urls: extensions must be an array of strings.", -32602);
  if (opts.includeTestFiles !== undefined && typeof opts.includeTestFiles !== "boolean")
    throw new ToolError("find_hardcoded_localhost_urls: include_test_files must be a boolean.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const includeTestFiles = !!opts.includeTestFiles;

  const isDirectory = stat.isDirectory();
  const allFiles = isDirectory ? collectFiles(absTarget, extensions) : [path.basename(absTarget)];
  const baseDir = isDirectory ? absTarget : path.dirname(absTarget);

  let filesSkippedAsTest = 0;
  const files = allFiles.filter(rel => {
    if (includeTestFiles) return true;
    const isTestPath = TEST_PATH_RE.test(rel);
    if (isTestPath) filesSkippedAsTest++;
    return !isTestPath;
  });

  const findings = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    scanFile(rel, buf.toString("utf8"), findings);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    filesSkippedAsTest,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findHardcodedLocalhostUrls };
