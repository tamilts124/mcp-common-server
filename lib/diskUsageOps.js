"use strict";
// ── DISK_USAGE_SUMMARY — one-call snapshot combining file_stats + dir_size_stats ──
// Reuses fileStats() and dirSizeStats() (no duplicated tree-walk logic) and
// trims their output down to the fields most useful for a quick "what's
// using space here" answer, so a caller doesn't need two separate tool
// round-trips for a very common agent workflow.
//
// Zero dependencies — pure Node.js built-ins (via the two reused modules).

const { fileStats } = require("./fileStatsOps");
const { dirSizeStats } = require("./dirSizeOps");

/**
 * Combined disk-usage snapshot for a directory tree.
 *
 * @param {string}  absDir    Absolute path of the directory (jail-validated by caller).
 * @param {string}  origPath  Client-relative path echoed in the result.
 * @param {object}  [opts]
 * @param {number}  [opts.topFiles] Number of largest files to list (default: 10, max: 100).
 * @param {number}  [opts.topDirs]  Number of largest subdirectories to list (default: 10, max: 200).
 * @param {number}  [opts.maxDepth] How many levels of subdirectories to consider for topDirs (default: 3, max: 10).
 * @returns {{
 *   path: string,
 *   totalBytes: number,
 *   totalFiles: number,
 *   totalDirs: number,
 *   avgBytes: number,
 *   largestFiles: Array<{path: string, bytes: number}>,
 *   largestDirs: Array<{path: string, depth: number, bytes: number, fileCount: number}>,
 *   byExtension: Array<{ext: string, count: number, bytes: number}>
 * }}
 */
function diskUsageSummary(absDir, origPath, opts = {}) {
  const topFiles = opts.topFiles ?? 10;
  const topDirs  = opts.topDirs ?? 10;
  const maxDepth = opts.maxDepth ?? 3;

  const fs = fileStats(absDir, origPath, { topN: topFiles });
  const ds = dirSizeStats(absDir, origPath, { topN: topDirs, maxDepth });

  return {
    path: origPath,
    totalBytes: fs.totalBytes,
    totalFiles: fs.totalFiles,
    totalDirs: ds.totalDirs,
    avgBytes: fs.avgBytes,
    largestFiles: fs.largestFiles,
    largestDirs: ds.directories,
    byExtension: fs.byExtension,
  };
}

module.exports = { diskUsageSummary };
