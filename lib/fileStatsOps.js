"use strict";
// ── FILE STATS — aggregate statistics for a directory tree ────────────────────────────────────────────
// file_stats: walks a directory recursively (honouring MCP_IGNORE), collects
// per-file sizes, groups by extension, and returns:
//   { path, totalFiles, totalBytes, avgBytes, maxBytes, minBytes,
//     byExtension: [{ext, count, bytes}] (sorted by bytes desc),
//     largestFiles: [{path, bytes}] (top N, sorted by bytes desc) }
//
// Zero dependencies — pure Node.js built-ins.

const fs   = require("fs");
const path = require("path");

const { isIgnored, clientRelative } = require("./roots");

/**
 * Collect aggregate file statistics for a directory tree.
 *
 * @param {string}  absDir    Absolute path of the directory (jail-validated by caller).
 * @param {string}  origPath  Client-relative path echoed in the result.
 * @param {object}  [opts]
 * @param {number}  [opts.topN]        Number of largest files to return (default: 10, max: 100).
 * @param {string[]} [opts.extensions] Optional extension whitelist (e.g. ['.js', '.ts']).
 * @returns {object}
 */
function fileStats(absDir, origPath, opts = {}) {
  const topN = Math.min(Math.max(1, Math.trunc(opts.topN ?? 10)), 100);
  const exts  = opts.extensions?.length
    ? opts.extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())
    : null;

  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new Error(`file_stats: '${origPath}' is not a directory.`);

  // Walk tree collecting {relPath, ext, bytes} for every file.
  // We build relative paths manually (relDir + entry name) rather than
  // calling clientRelative() per file — that avoids one ROOTS.get() per entry
  // and sidesteps the alias/absPath argument-order coupling entirely.
  const fileList = [];
  (function walk(dir, relDir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; } // unreadable dir — skip silently

    for (const ent of entries) {
      if (isIgnored(ent.name)) continue;
      const relPath = relDir ? relDir + "/" + ent.name : ent.name;

      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name), relPath);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase() || "(no extension)";
        if (exts && !exts.includes(ext)) continue;
        let size = 0;
        try { size = fs.statSync(path.join(dir, ent.name)).size; } catch (_) {}
        fileList.push({ rel: origPath ? origPath + "/" + relPath : relPath, ext, bytes: size });
      }
    }
  })(absDir, "");

  const totalFiles = fileList.length;
  const totalBytes = fileList.reduce((s, f) => s + f.bytes, 0);
  const avgBytes   = totalFiles > 0 ? Math.round(totalBytes / totalFiles) : 0;
  const maxBytes   = totalFiles > 0 ? Math.max(...fileList.map(f => f.bytes)) : 0;
  const minBytes   = totalFiles > 0 ? Math.min(...fileList.map(f => f.bytes)) : 0;

  // Group by extension
  const extMap = new Map();
  for (const f of fileList) {
    const e = extMap.get(f.ext) ?? { ext: f.ext, count: 0, bytes: 0 };
    e.count++;
    e.bytes += f.bytes;
    extMap.set(f.ext, e);
  }
  const byExtension = [...extMap.values()].sort((a, b) => b.bytes - a.bytes);

  // Top N largest files
  const largestFiles = fileList
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, topN)
    .map(f => ({ path: f.rel, bytes: f.bytes }));

  return {
    path:        origPath,
    totalFiles,
    totalBytes,
    avgBytes,
    maxBytes,
    minBytes,
    byExtension,
    largestFiles,
  };
}

module.exports = { fileStats };
