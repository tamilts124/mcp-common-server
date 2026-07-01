"use strict";
// ── DIR_SIZE_STATS — directory-level disk-usage rollup (like `du --max-depth=N`) ──
// Aggregates bytes recursively per subdirectory (each directory's total includes
// everything nested beneath it, however deep), then reports only directories up
// to `maxDepth` levels below the scanned root, sorted by bytes descending.
//
// Complements file_stats (flat per-file top-N list) with a directory-level view —
// useful for quickly finding which subtree of a large tree is eating the space,
// without eyeballing file_tree with sizes:true or manually summing file_stats
// entries by hand.
//
// Zero dependencies — pure Node.js built-ins.

const fs   = require("fs");
const path = require("path");

const { isIgnored } = require("./roots");

// Clamp a numeric option to [min, max], truncating to an integer and falling
// back to `def` for anything that isn't a finite number (missing, NaN,
// non-numeric strings, Infinity, etc.) — a plain Math.min(Math.max(...))
// clamp silently propagates NaN through every comparison (Math.max(1, NaN)
// is NaN, not 1), which would make maxDepth/topN pass right through the
// clamp when a caller passes a garbage-typed value instead of getting a
// safe default.
function clampInt(value, def, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(min, n), max);
}

/**
 * Compute a directory-level disk-usage rollup for a directory tree.
 *
 * @param {string}  absDir    Absolute path of the directory (jail-validated by caller).
 * @param {string}  origPath  Client-relative path echoed in the result and prefixed
 *                            onto each reported directory's path.
 * @param {object}  [opts]
 * @param {number}  [opts.maxDepth]  How many levels of subdirectories below the
 *                                   scanned root to report individually
 *                                   (default: 2, min: 1, max: 10). Each reported
 *                                   directory's `bytes`/`fileCount` still include
 *                                   everything nested beneath it, however deep —
 *                                   only which directories are *listed* is capped
 *                                   by depth. The root itself is never listed as
 *                                   a directory entry (it's redundant with the
 *                                   top-level totalBytes/totalFiles/totalDirs).
 * @param {number}  [opts.topN]      Max number of directories to return, sorted by
 *                                   bytes descending (default: 20, min: 1, max: 200).
 * @returns {{
 *   path: string,
 *   maxDepth: number,
 *   totalBytes: number,
 *   totalFiles: number,
 *   totalDirs: number,
 *   directories: Array<{ path: string, depth: number, bytes: number, fileCount: number }>
 * }}
 */
function dirSizeStats(absDir, origPath, opts = {}) {
  const maxDepth = clampInt(opts.maxDepth, 2, 1, 10);
  const topN     = clampInt(opts.topN, 20, 1, 200);

  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new Error(`dir_size_stats: '${origPath}' is not a directory.`);

  // Recursive per-directory rollups, keyed by relPath ("" = the scanned root
  // itself). Every directory encountered during the walk gets an entry here
  // (even ones with zero bytes / no files), so totalDirs and the depth-capped
  // listing both reflect the real tree shape, not just where files happened
  // to be found.
  const dirBytes = new Map([["", 0]]);
  const dirFiles = new Map([["", 0]]);
  const allDirRelPaths = new Set([""]);

  // Roll a file's byte count up through every ancestor directory, including
  // the root. relDir is the file's immediate containing directory.
  function addToAncestors(relDir, bytes) {
    let cur = relDir;
    for (;;) {
      dirBytes.set(cur, (dirBytes.get(cur) || 0) + bytes);
      dirFiles.set(cur, (dirFiles.get(cur) || 0) + 1);
      if (cur === "") break;
      const idx = cur.lastIndexOf("/");
      cur = idx === -1 ? "" : cur.slice(0, idx);
    }
  }

  let totalFiles = 0;
  let totalBytes = 0;
  let totalDirs  = 0;

  (function walk(dir, relDir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; } // unreadable dir — skip silently, matches file_stats/file_tree convention

    for (const ent of entries) {
      if (isIgnored(ent.name)) continue;
      const relPath = relDir ? relDir + "/" + ent.name : ent.name;

      if (ent.isDirectory()) {
        totalDirs++;
        allDirRelPaths.add(relPath);
        dirBytes.set(relPath, dirBytes.get(relPath) || 0);
        dirFiles.set(relPath, dirFiles.get(relPath) || 0);
        walk(path.join(dir, ent.name), relPath);
      } else if (ent.isFile()) {
        let size = 0;
        try { size = fs.statSync(path.join(dir, ent.name)).size; } catch (_) {}
        totalFiles++;
        totalBytes += size;
        addToAncestors(relDir, size);
      }
      // Symlinks are neither isDirectory() nor isFile() under withFileTypes()
      // Dirent semantics (which use lstat, not stat) — they're silently
      // skipped, same as every other walker in this codebase. No symlink is
      // ever followed as if it were a real directory.
    }
  })(absDir, "");

  const depthOf = relPath => relPath === "" ? 0 : relPath.split("/").length;

  const directories = [...allDirRelPaths]
    .filter(relPath => relPath !== "" && depthOf(relPath) <= maxDepth)
    .map(relPath => ({
      path:      origPath ? origPath + "/" + relPath : relPath,
      depth:     depthOf(relPath),
      bytes:     dirBytes.get(relPath) || 0,
      fileCount: dirFiles.get(relPath) || 0,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topN);

  return {
    path: origPath,
    maxDepth,
    totalBytes,
    totalFiles,
    totalDirs,
    directories,
  };
}

module.exports = { dirSizeStats };
