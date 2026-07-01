"use strict";
// ── FILE_DIFF_DIR — file-level + line-level diff between two directory trees ──
// Combines lib/compareOps.js's compareDirectories() (which only classifies
// files as added/removed/modified/unchanged by content hash) with
// lib/diffFileOps.js's diffFiles() (which produces a line-level unified diff for
// exactly two specific files) into a single tool: walk both trees, find every
// modified file, and produce a unified diff for each one — added/removed
// files are reported by status only (there is no "other side" to diff against).
//
// Output can get large for big trees with many changed files, so a
// `max_diff_lines` budget caps the total number of unified-diff lines emitted
// across all files combined (default 500). Once the budget is exhausted,
// remaining modified files are still listed (status + relPath) but without
// a computed unified diff, and `truncated: true` is set so callers know more
// detail is available by diffing those specific files directly with
// `diff_files`.
//
// Read-only — does not require MCP_ALLOW_EXEC.

const fs   = require("fs");
const path = require("path");

const { compareDirectories } = require("./compareOps");
const { diffFiles }          = require("./diffFileOps");

const DEFAULT_MAX_DIFF_LINES = 500;
const ABSOLUTE_MAX_DIFF_LINES = 5000;

/**
 * Join a forward-slash relative path (as produced by compareDirectories)
 * onto a base directory, respecting the host OS path separator.
 */
function joinRel(baseDir, relPath) {
  return path.join(baseDir, ...relPath.split("/"));
}

/**
 * Diff two directory trees at both the file level (added/removed/modified/
 * unchanged, via compareDirectories) and the line level (unified diff per
 * modified file, via diffFiles).
 *
 * @param {string}   leftDir              Absolute, already-jailed "before" directory.
 * @param {string}   rightDir             Absolute, already-jailed "after" directory.
 * @param {string}   leftClientPath       Client-relative left path, echoed in output.
 * @param {string}   rightClientPath      Client-relative right path, echoed in output.
 * @param {object}   [opts]
 * @param {string}   [opts.algorithm]     Hash algorithm passed through to compareDirectories.
 * @param {string[]} [opts.extensions]    Only consider files with these extensions.
 * @param {number}   [opts.max_diff_lines] Cap on total unified-diff lines across all files (default 500, max 5000).
 * @param {number}   [opts.context]       Context lines per hunk, passed through to diffFiles (default 3).
 * @returns {{
 *   left: string, right: string, algorithm: string,
 *   leftFileCount: number, rightFileCount: number,
 *   summary: { addedCount, removedCount, modifiedCount, unchangedCount },
 *   diffs: Array<{ relPath: string, status: "added"|"removed"|"modified",
 *                   unified?: string, additions?: number, deletions?: number, hunks?: number }>,
 *   maxDiffLines: number, totalDiffLinesEmitted: number, truncated: boolean
 * }}
 */
function fileDiffDir(leftDir, rightDir, leftClientPath, rightClientPath, opts = {}) {
  let maxDiffLines = opts.max_diff_lines != null ? Math.trunc(opts.max_diff_lines) : DEFAULT_MAX_DIFF_LINES;
  if (!Number.isFinite(maxDiffLines) || maxDiffLines < 0)
    throw Object.assign(new Error("file_diff_dir: 'max_diff_lines' must be a non-negative integer."), { code: -32602 });
  if (maxDiffLines > ABSOLUTE_MAX_DIFF_LINES) maxDiffLines = ABSOLUTE_MAX_DIFF_LINES;

  const context = opts.context != null ? Math.max(0, Math.trunc(opts.context)) : 3;

  const cmp = compareDirectories(leftDir, rightDir, {
    algorithm:  opts.algorithm,
    extensions: opts.extensions,
  });

  // Build the combined, alphabetically-sorted list of changed paths we need
  // to report (added + removed + modified — unchanged files carry no diff
  // information and are omitted from the per-file list, same convention as
  // compare_directories' own summary-only treatment of unchanged files).
  const entries = [
    ...cmp.added.map(relPath => ({ relPath, status: "added" })),
    ...cmp.removed.map(relPath => ({ relPath, status: "removed" })),
    ...cmp.modified.map(relPath => ({ relPath, status: "modified" })),
  ].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const diffs = [];
  let totalDiffLinesEmitted = 0;
  let truncated = false;

  for (const entry of entries) {
    if (entry.status !== "modified") {
      // Added/removed files have no "other side" to line-diff against.
      diffs.push({ relPath: entry.relPath, status: entry.status });
      continue;
    }

    if (totalDiffLinesEmitted >= maxDiffLines) {
      // Budget already exhausted — list the file without computing a diff.
      diffs.push({ relPath: entry.relPath, status: "modified" });
      truncated = true;
      continue;
    }

    const leftAbs  = joinRel(leftDir, entry.relPath);
    const rightAbs = joinRel(rightDir, entry.relPath);

    let result;
    try {
      result = diffFiles(leftAbs, rightAbs, entry.relPath, entry.relPath, context);
    } catch (e) {
      // A file that disappeared/changed type between the hash-comparison
      // pass and this pass (rare race) shouldn't crash the whole tool —
      // report it as modified-but-undiffable instead.
      diffs.push({ relPath: entry.relPath, status: "modified", note: `diff failed: ${e.message}` });
      continue;
    }

    const lineCount = result.unified === "" ? 0 : result.unified.split("\n").length;

    if (totalDiffLinesEmitted + lineCount > maxDiffLines) {
      // Including this file's full diff would bust the budget — list it
      // without the unified text rather than truncating mid-file.
      diffs.push({ relPath: entry.relPath, status: "modified" });
      truncated = true;
      continue;
    }

    diffs.push({
      relPath:   entry.relPath,
      status:    "modified",
      unified:   result.unified,
      additions: result.additions,
      deletions: result.deletions,
      hunks:     result.hunks,
    });
    totalDiffLinesEmitted += lineCount;
  }

  return {
    left:  leftClientPath,
    right: rightClientPath,
    algorithm: cmp.algorithm,
    leftFileCount:  cmp.leftFileCount,
    rightFileCount: cmp.rightFileCount,
    summary: cmp.summary,
    diffs,
    maxDiffLines,
    totalDiffLinesEmitted,
    truncated,
  };
}

module.exports = { fileDiffDir };
