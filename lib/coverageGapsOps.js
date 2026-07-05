"use strict";
// ── CHECK_TEST_COVERAGE_GAPS — source files with no corresponding test ──
// Inverse of find_orphaned_test_files: reuses its exact test-file naming
// conventions and candidate-resolution logic (JS/TS *.test.*/*.spec.*,
// Python test_*.py/*_test.py, Go *_test.go; same-directory + test-dir-to-
// src-dir segment swap), but instead flags *source* files for which no
// recognised test file resolves back to them.
//
// A source file is "covered" if at least one scanned test file's candidate
// list includes it. Same caveats as find_orphaned_test_files: convention-
// based text/path matching, not real import analysis — a source file
// legitimately tested only via an integration/e2e suite, or one with no
// dedicated unit test by design (a barrel index.js, a pure type-only file,
// a CLI entry point), will be a false positive. Use exclude_filenames to
// suppress known-intentional gaps.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");
const { matchTestConvention, candidatesFor, collectFiles } = require("./orphanedTestFilesOps");

const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const SOURCE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go"];

/**
 * @param {string} absDir   Absolute, jail-validated directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.excludeFilenames] Exact basenames to skip (e.g. ["index.js"]).
 * @param {number}   [opts.maxResults] Cap on the gaps[] list length (1-5000, default 500).
 * @returns {{path, filesScanned, sourceFilesScanned, testFilesScanned, gapCount, truncated, gaps: string[]}}
 */
function checkTestCoverageGaps(absDir, origPath, opts = {}) {
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new ToolError(`check_test_coverage_gaps: '${origPath}' is not a directory.`, -32602);

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_test_coverage_gaps: max_results must be a number.", -32602);
  if (opts.excludeFilenames !== undefined && !Array.isArray(opts.excludeFilenames))
    throw new ToolError("check_test_coverage_gaps: exclude_filenames must be an array of strings.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const excludeSet = new Set(Array.isArray(opts.excludeFilenames) ? opts.excludeFilenames : []);

  const files = collectFiles(absDir);
  const fileSet = new Set(files);

  const covered = new Set();
  let testFilesScanned = 0;

  for (const rel of files) {
    const filename = path.posix.basename(rel);
    const conv = matchTestConvention(filename);
    if (!conv) continue;
    testFilesScanned++;
    for (const c of candidatesFor(rel, conv.base, conv.sourceExts)) {
      if (fileSet.has(c)) covered.add(c);
    }
  }

  const gaps = [];
  let sourceFilesScanned = 0;

  for (const rel of files) {
    const filename = path.posix.basename(rel);
    if (matchTestConvention(filename)) continue;
    if (!SOURCE_EXTENSIONS.some(e => filename.endsWith(e))) continue;
    if (excludeSet.has(filename)) continue;
    sourceFilesScanned++;
    if (!covered.has(rel)) gaps.push(rel);
  }

  gaps.sort();
  const truncated = gaps.length > maxResults;

  return {
    path: origPath,
    filesScanned: files.length,
    sourceFilesScanned,
    testFilesScanned,
    gapCount: gaps.length,
    truncated,
    gaps: gaps.slice(0, maxResults),
  };
}

module.exports = { checkTestCoverageGaps };
