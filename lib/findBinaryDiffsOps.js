"use strict";
// ── FIND_BINARY_DIFFS — detect changed binary assets across two trees ──────
// Composes compare_directories' modified-file classification with
// check_binary_file + file_checksum: only files where BOTH sides are
// binary are reported (text-diffable files are skipped — use
// dir_diff_summary for those). Reports leftHash/rightHash/leftSize/
// rightSize per changed binary file instead of a byte-by-byte diff, since
// a binary diff is rarely meaningful to a human/agent reader.

const path = require("path");
const { compareDirectories } = require("./compareOps");
const { checkBinaryFile } = require("./binaryFileOps");
const { fileChecksum } = require("./checksumOps");

const DEFAULT_MAX_FILES = 200;
const HARD_MAX_FILES    = 2000;

/**
 * @param {string} leftDir   Absolute, jail-checked left directory.
 * @param {string} rightDir  Absolute, jail-checked right directory.
 * @param {string} leftLabel  Original client-facing left path (for the response).
 * @param {string} rightLabel Original client-facing right path.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]  Restrict compare_directories to these extensions.
 * @param {number}   [opts.max_files]   Cap on modified pairs inspected (default 200, hard cap 2000).
 * @param {string}   [opts.algorithm]   Checksum algorithm: md5|sha1|sha256(default)|sha512.
 */
function findBinaryDiffs(leftDir, rightDir, leftLabel, rightLabel, opts = {}) {
  let maxFiles = parseInt(opts.max_files, 10);
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) maxFiles = DEFAULT_MAX_FILES;
  maxFiles = Math.min(maxFiles, HARD_MAX_FILES);

  const algorithm = (opts.algorithm || "sha256").toLowerCase();
  const allowed = ["md5", "sha1", "sha256", "sha512"];
  if (!allowed.includes(algorithm))
    throw new Error(`find_binary_diffs: unsupported algorithm '${opts.algorithm}'. Choose one of: ${allowed.join(", ")}.`);

  const cmp = compareDirectories(leftDir, rightDir, { extensions: opts.extensions });

  const toInspect = cmp.modified.slice(0, maxFiles);
  const changedBinaryFiles = [];
  let skippedTextOrErrored = 0;

  for (const relPath of toInspect) {
    const leftAbs  = path.join(leftDir, relPath);
    const rightAbs = path.join(rightDir, relPath);

    let leftBin, rightBin;
    try {
      leftBin  = checkBinaryFile(leftAbs, relPath);
      rightBin = checkBinaryFile(rightAbs, relPath);
    } catch (_) {
      skippedTextOrErrored++;
      continue;
    }

    if (!leftBin.isBinary || !rightBin.isBinary) {
      skippedTextOrErrored++;
      continue;
    }

    let leftSum, rightSum;
    try {
      leftSum  = fileChecksum(leftAbs, algorithm);
      rightSum = fileChecksum(rightAbs, algorithm);
    } catch (e) {
      changedBinaryFiles.push({ path: relPath, error: e.message });
      continue;
    }

    changedBinaryFiles.push({
      path: relPath,
      leftHash:  leftSum.hex,
      rightHash: rightSum.hex,
      leftSize:  leftSum.sizeBytes,
      rightSize: rightSum.sizeBytes,
      identical: leftSum.hex === rightSum.hex, // same content, different mtime/perms only
    });
  }

  return {
    left: leftLabel,
    right: rightLabel,
    algorithm,
    addedCount:    cmp.added.length,
    removedCount:  cmp.removed.length,
    modifiedCount: cmp.modified.length,
    unchangedCount: cmp.unchanged.length,
    inspected: toInspect.length,
    truncated: cmp.modified.length > toInspect.length,
    skippedTextOrErrored,
    changedBinaryFiles,
  };
}

module.exports = { findBinaryDiffs };
