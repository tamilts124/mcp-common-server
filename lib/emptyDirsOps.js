"use strict";
// ── FIND_EMPTY_DIRS — recursively find directories with no files ──────────
// Walks a directory tree (honouring MCP_IGNORE) and reports directories that
// contain no files anywhere in their subtree (i.e. only nested empty dirs,
// or nothing at all). Useful cleanup pass before packaging/zipping/committing.
// Post-order walk: a dir is "empty" iff every child dir is empty AND it has
// zero direct files. Zero dependencies — pure Node.js built-ins.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");

/**
 * Find directories with no files anywhere in their subtree.
 * @param {string}  absDir    Absolute, jail-validated directory path.
 * @param {string}  origPath  Client-relative path echoed in the result.
 * @param {object}  [opts]
 * @param {number}  [opts.maxResults] Cap on number of empty dirs returned (1–5000, default 500).
 * @returns {{path, dirsScanned, emptyDirs:string[], count, truncated}}
 */
function findEmptyDirs(absDir, origPath, opts = {}) {
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new Error(`find_empty_dirs: '${origPath}' is not a directory.`);

  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? 500)), 5000);

  let dirsScanned = 0;
  const emptyDirs = [];
  let truncated = false;

  // Returns true if `dir` (given its relPath) contains no files anywhere
  // in its subtree. Pushes empty dirs into emptyDirs in post-order so
  // deepest empty dirs are listed first.
  function walk(dir, relPath) {
    dirsScanned++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return false; } // unreadable — treat as not-empty (skip silently)

    let hasFile = false;
    let allChildDirsEmpty = true;
    let hadAnyChildDir = false;

    for (const ent of entries) {
      if (isIgnored(ent.name)) continue;
      if (ent.isDirectory()) {
        hadAnyChildDir = true;
        const childRel = relPath ? relPath + "/" + ent.name : ent.name;
        const childEmpty = walk(path.join(dir, ent.name), childRel);
        if (!childEmpty) allChildDirsEmpty = false;
      } else if (ent.isFile()) {
        hasFile = true;
      }
    }

    const isEmpty = !hasFile && allChildDirsEmpty;
    if (isEmpty) {
      const label = origPath ? (relPath ? origPath + "/" + relPath : origPath) : relPath;
      if (emptyDirs.length < maxResults) {
        emptyDirs.push(label);
      } else {
        truncated = true;
      }
    }
    return isEmpty;
  }

  walk(absDir, "");

  return {
    path: origPath,
    dirsScanned,
    emptyDirs,
    count: emptyDirs.length,
    truncated,
  };
}

module.exports = { findEmptyDirs };
