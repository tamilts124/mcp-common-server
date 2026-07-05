"use strict";
// ── DIR_DIFF_SUMMARY — one-call semantic diff across a whole directory ─────
// Composes compare_directories (file-level added/removed/modified/unchanged
// classification) with a per-modified-file semantic diff, auto-dispatched
// by extension:
//   .json           -> jsonDiff   (structural diff)
//   .yaml/.yml       -> jsonDiff   (auto YAML detection, same tool)
//   .csv             -> csvDiff    (positional/index row diff — no single
//                        key column is knowable generically across an
//                        arbitrary directory, so this always uses the
//                        documented by-index convention; call csv_diff
//                        directly with key_column for an identity diff)
//   anything else    -> checkBinaryFile first; binary files are reported
//                        but not diffed; text files get diffFiles' line
//                        counts (full unified diff text omitted by default
//                        to keep the summary response small — pass
//                        include_unified_diff:true to include it).
//
// A max_files budget (default 50, hard cap 500) caps how many *modified*
// files get a full per-file diff computed (compare_directories' own
// added/removed/unchanged lists are always returned in full — they're
// cheap, just relative paths).

const path = require("path");
const { compareDirectories } = require("./compareOps");
const { jsonDiff } = require("./jsonDiffOps");
const { csvDiff } = require("./csvDiffOps");
const { diffFiles } = require("./diffFileOps");
const { checkBinaryFile } = require("./binaryFileOps");
const { ToolError } = require("./errors");

const DEFAULT_MAX_FILES = 50;
const HARD_MAX_FILES    = 500;

function kindForExt(ext) {
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  if (ext === ".csv") return "csv";
  return "text";
}

function diffOneFile(leftAbs, rightAbs, relPath, includeUnified) {
  const ext  = path.extname(relPath).toLowerCase();
  const kind = kindForExt(ext);

  if (kind === "json" || kind === "yaml") {
    try {
      const res = jsonDiff(leftAbs, rightAbs, relPath, relPath);
      return { path: relPath, kind, identical: res.identical, totalChanges: res.totalChanges, changes: res.changes };
    } catch (e) {
      return { path: relPath, kind, error: e.message };
    }
  }

  if (kind === "csv") {
    try {
      const res = csvDiff(leftAbs, rightAbs, relPath, relPath);
      return { path: relPath, kind, identical: res.identical, addedCount: res.addedCount, removedCount: res.removedCount, changedCount: res.changedCount, added: res.added, removed: res.removed, changed: res.changed };
    } catch (e) {
      return { path: relPath, kind, error: e.message };
    }
  }

  // Text/binary fallback
  let bin;
  try { bin = checkBinaryFile(leftAbs, relPath); }
  catch (e) { return { path: relPath, kind: "error", error: e.message }; }
  if (bin.isBinary) {
    return { path: relPath, kind: "binary", note: "binary file — sizes differ, content not diffed" };
  }
  try {
    const res = diffFiles(leftAbs, rightAbs, relPath, relPath, 3);
    const out = { path: relPath, kind: "text", identical: res.identical, additions: res.additions, deletions: res.deletions, hunks: res.hunks };
    if (includeUnified) out.unified = res.unified;
    return out;
  } catch (e) {
    return { path: relPath, kind: "text", error: e.message };
  }
}

/**
 * Compose compare_directories with a per-modified-file semantic diff.
 * @param {string} leftDir  Absolute, jail-checked left directory.
 * @param {string} rightDir Absolute, jail-checked right directory.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]  Restrict compare_directories to these extensions.
 * @param {number}   [opts.max_files]   Cap on modified files given a per-file diff (default 50, hard cap 500).
 * @param {boolean}  [opts.include_unified_diff]  Include full unified diff text for text files (default false).
 */
function dirDiffSummary(leftDir, rightDir, leftLabel, rightLabel, opts = {}) {
  let maxFiles = parseInt(opts.max_files, 10);
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) maxFiles = DEFAULT_MAX_FILES;
  maxFiles = Math.min(maxFiles, HARD_MAX_FILES);
  const includeUnified = opts.include_unified_diff === true;

  const cmp = compareDirectories(leftDir, rightDir, { extensions: opts.extensions });

  const toProcess = cmp.modified.slice(0, maxFiles);
  const diffs = toProcess.map((relPath) =>
    diffOneFile(path.join(leftDir, relPath), path.join(rightDir, relPath), relPath, includeUnified)
  );

  return {
    left: leftLabel,
    right: rightLabel,
    addedCount: cmp.added.length,
    removedCount: cmp.removed.length,
    modifiedCount: cmp.modified.length,
    unchangedCount: cmp.unchanged.length,
    added: cmp.added,
    removed: cmp.removed,
    filesDiffed: diffs.length,
    truncated: cmp.modified.length > diffs.length,
    diffs,
  };
}

module.exports = { dirDiffSummary };
