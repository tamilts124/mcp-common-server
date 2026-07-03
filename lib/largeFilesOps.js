"use strict";
// ── FIND_LARGE_FILES — recursively find files above a size threshold ──────
// Walks a directory (honouring MCP_IGNORE), collects every file whose size
// exceeds min_bytes, and returns them sorted descending by size with a
// human-readable size string. Useful for spotting accidentally-committed
// binaries, build artifacts, or bloat before a commit/push.
// Zero dependencies — pure Node.js built-ins.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024, i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(2)} ${units[i]}`;
}

/**
 * Find files at or above a size threshold within a directory tree.
 * @param {string}  absDir    Absolute, jail-validated directory path.
 * @param {string}  origPath  Client-relative path echoed in the result.
 * @param {object}  [opts]
 * @param {number}  [opts.minBytes]   Minimum size in bytes to include (default: 1,048,576 = 1MB).
 * @param {number}  [opts.topN]       Max number of files to return (1–2000, default: 100).
 * @param {string[]} [opts.extensions] Optional extension whitelist.
 * @returns {{path, filesScanned, matchCount, truncated, minBytes, files:[{path,bytes,humanSize}]}}
 */
function findLargeFiles(absDir, origPath, opts = {}) {
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new Error(`find_large_files: '${origPath}' is not a directory.`);

  const minBytes = Math.max(0, Math.trunc(opts.minBytes ?? 1048576));
  const topN     = Math.min(Math.max(1, Math.trunc(opts.topN ?? 100)), 2000);
  const exts     = opts.extensions?.length
    ? opts.extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())
    : null;

  let filesScanned = 0;
  const matches = [];

  (function walk(dir, relDir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const ent of entries) {
      if (isIgnored(ent.name)) continue;
      const relPath = relDir ? relDir + "/" + ent.name : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, relPath);
      } else if (ent.isFile()) {
        filesScanned++;
        if (exts && !exts.includes(path.extname(ent.name).toLowerCase())) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) { continue; }
        if (size >= minBytes) {
          matches.push({ path: origPath ? origPath + "/" + relPath : relPath, bytes: size });
        }
      }
    }
  })(absDir, "");

  matches.sort((a, b) => b.bytes - a.bytes);
  const truncated = matches.length > topN;
  const files = matches.slice(0, topN).map(f => ({ ...f, humanSize: humanSize(f.bytes) }));

  return {
    path: origPath,
    filesScanned,
    matchCount: matches.length,
    truncated,
    minBytes,
    files,
  };
}

module.exports = { findLargeFiles };
