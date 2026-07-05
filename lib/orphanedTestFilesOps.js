"use strict";
// ── FIND_ORPHANED_TEST_FILES — test files whose source no longer exists ──
// Convention-based: recognises common test-file naming patterns (JS/TS
// *.test.*/*.spec.*, Python test_*.py/*_test.py, Go *_test.go), derives the
// source file(s) each test file implies, and reports test files for which
// none of the candidate source paths exist. Not a real test-runner/import
// analysis — a test file that imports its subject via an unconventional
// name, or that intentionally has no 1:1 source file (e.g. an integration
// test), will be a false positive; treat orphaned[] as a review starting
// point, not an authoritative delete list.
//
// Candidate resolution per test file:
//   1. Same directory, same basename, tried against each source extension
//      for that language family (e.g. foo.test.js -> foo.js/.jsx/.ts/.tsx).
//   2. If the test file sits under a conventional test-directory segment
//      (test, tests, __tests__, spec, specs), also tried with that segment
//      replaced by each conventional source-directory segment (src, lib) —
//      mirroring how many projects place tests/foo.test.js next to src/foo.js.
// A test file is orphaned only if *none* of the above candidates exist.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const TEST_DIR_SEGMENTS = ["test", "tests", "__tests__", "spec", "specs"];
const SRC_DIR_SEGMENTS = ["src", "lib"];
const JS_SOURCE_EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

// Returns { base, sourceExts } for a recognised test filename, or null.
function matchTestConvention(filename) {
  let m = filename.match(/^(.+)\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/);
  if (m) return { base: m[1], sourceExts: JS_SOURCE_EXTS };

  m = filename.match(/^test_(.+)\.py$/);
  if (m) return { base: m[1], sourceExts: [".py"] };

  m = filename.match(/^(.+)_test\.py$/);
  if (m) return { base: m[1], sourceExts: [".py"] };

  m = filename.match(/^(.+)_test\.go$/);
  if (m) return { base: m[1], sourceExts: [".go"] };

  return null;
}

function collectFiles(absDir, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(abs, rel));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

function candidatesFor(testRelPath, base, sourceExts) {
  const dir = path.posix.dirname(testRelPath);
  const dirParts = dir === "." ? [] : dir.split("/");
  const candidates = [];

  const sameDir = dir === "." ? "" : dir + "/";
  for (const ext of sourceExts) candidates.push(sameDir + base + ext);

  for (let i = 0; i < dirParts.length; i++) {
    if (!TEST_DIR_SEGMENTS.includes(dirParts[i].toLowerCase())) continue;
    for (const srcSeg of SRC_DIR_SEGMENTS) {
      const swapped = [...dirParts];
      swapped[i] = srcSeg;
      const swappedDir = swapped.join("/");
      for (const ext of sourceExts) {
        candidates.push((swappedDir ? swappedDir + "/" : "") + base + ext);
      }
    }
  }
  return [...new Set(candidates)];
}

/**
 * @param {string} absDir   Absolute, jail-validated directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {number} [opts.maxResults] Cap on the orphaned[] list length (1-5000, default 500).
 * @returns {{path, filesScanned, testFilesScanned, orphanedCount, truncated, orphaned: Array}}
 */
function findOrphanedTestFiles(absDir, origPath, opts = {}) {
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new ToolError(`find_orphaned_test_files: '${origPath}' is not a directory.`, -32602);

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_orphaned_test_files: max_results must be a number.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = collectFiles(absDir);
  const fileSet = new Set(files);

  const orphaned = [];
  let testFilesScanned = 0;

  for (const rel of files) {
    const filename = path.posix.basename(rel);
    const conv = matchTestConvention(filename);
    if (!conv) continue;
    testFilesScanned++;

    const candidates = candidatesFor(rel, conv.base, conv.sourceExts);
    const found = candidates.some(c => fileSet.has(c));
    if (!found) orphaned.push({ file: rel, expectedSourceCandidates: candidates });
  }

  orphaned.sort((a, b) => a.file.localeCompare(b.file));
  const truncated = orphaned.length > maxResults;

  return {
    path: origPath,
    filesScanned: files.length,
    testFilesScanned,
    orphanedCount: orphaned.length,
    truncated,
    orphaned: orphaned.slice(0, maxResults),
  };
}

module.exports = { findOrphanedTestFiles };
