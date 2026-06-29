"use strict";
// ── DIRECTORY COMPARISON ────────────────────────────────────────────────────
// compare_directories — recursively diff two directory trees by content hash
// and classify every relative path as added / removed / modified / unchanged.
// Read-only — does not require MCP_ALLOW_EXEC.
//
// Note: relative paths are computed against each compared directory itself
// (not against the server's configured MCP_ROOTS alias), so that e.g.
// "buildA/src/index.js" vs "buildB/src/index.js" are correctly matched up
// as the same relative file "src/index.js" in two different trees.

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { isIgnored } = require("./roots");

const ALLOWED_ALGORITHMS = ["md5", "sha1", "sha256", "sha512"];

/**
 * Recursively collect { absPath, relPath } for every file under `baseDir`,
 * with relPath computed relative to baseDir itself (forward-slash separated),
 * skipping anything matched by the server's MCP_IGNORE patterns.
 */
function collectRelative(baseDir, extensions) {
  const out  = [];
  const exts = extensions && extensions.length ? extensions : null;

  function walk(dir, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`compare_directories: cannot read directory '${dir}': ${e.message}`);
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        if (exts && !exts.some(x => entry.name.endsWith(x))) continue;
        out.push({ absPath: abs, relPath: rel });
      }
    }
  }

  walk(baseDir, "");
  return out;
}

function hashFile(absPath, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(absPath)).digest("hex");
}

/**
 * Compare two directory trees by content hash.
 *
 * @param {string}   leftDir              Absolute, already-jailed "before" directory.
 * @param {string}   rightDir             Absolute, already-jailed "after" directory.
 * @param {object}   [opts]
 * @param {string}   [opts.algorithm]     "md5" | "sha1" | "sha256" (default) | "sha512"
 * @param {string[]} [opts.extensions]    Only consider files with these extensions.
 * @returns {{
 *   algorithm: string, leftFileCount: number, rightFileCount: number,
 *   added: string[], removed: string[], modified: string[], unchanged: string[],
 *   summary: { addedCount: number, removedCount: number, modifiedCount: number, unchangedCount: number }
 * }}
 */
function compareDirectories(leftDir, rightDir, opts = {}) {
  const algorithm = (opts.algorithm || "sha256").toLowerCase();
  if (!ALLOWED_ALGORITHMS.includes(algorithm))
    throw new Error(`compare_directories: unsupported algorithm '${opts.algorithm}'. Choose one of: ${ALLOWED_ALGORITHMS.join(", ")}.`);

  let leftStat;
  try { leftStat = fs.statSync(leftDir); }
  catch (e) { throw new Error(`compare_directories: cannot access 'left' directory: ${e.message}`); }
  if (!leftStat.isDirectory())
    throw new Error(`compare_directories: 'left' path is not a directory.`);

  let rightStat;
  try { rightStat = fs.statSync(rightDir); }
  catch (e) { throw new Error(`compare_directories: cannot access 'right' directory: ${e.message}`); }
  if (!rightStat.isDirectory())
    throw new Error(`compare_directories: 'right' path is not a directory.`);

  const leftFiles  = collectRelative(leftDir, opts.extensions);
  const rightFiles = collectRelative(rightDir, opts.extensions);

  const leftMap  = new Map(leftFiles.map(f => [f.relPath, f]));
  const rightMap = new Map(rightFiles.map(f => [f.relPath, f]));

  const added = [], removed = [], modified = [], unchanged = [];

  for (const relPath of leftMap.keys()) {
    if (!rightMap.has(relPath)) removed.push(relPath);
  }
  for (const relPath of rightMap.keys()) {
    if (!leftMap.has(relPath)) added.push(relPath);
  }
  for (const [relPath, l] of leftMap) {
    const r = rightMap.get(relPath);
    if (!r) continue; // already recorded as removed above

    let leftSize, rightSize;
    try { leftSize = fs.statSync(l.absPath).size; } catch (_) { modified.push(relPath); continue; }
    try { rightSize = fs.statSync(r.absPath).size; } catch (_) { modified.push(relPath); continue; }

    if (leftSize !== rightSize) { modified.push(relPath); continue; }

    let leftHash, rightHash;
    try { leftHash = hashFile(l.absPath, algorithm); } catch (_) { modified.push(relPath); continue; }
    try { rightHash = hashFile(r.absPath, algorithm); } catch (_) { modified.push(relPath); continue; }

    if (leftHash === rightHash) unchanged.push(relPath);
    else modified.push(relPath);
  }

  added.sort();
  removed.sort();
  modified.sort();
  unchanged.sort();

  return {
    algorithm,
    leftFileCount:  leftFiles.length,
    rightFileCount: rightFiles.length,
    added, removed, modified, unchanged,
    summary: {
      addedCount:     added.length,
      removedCount:   removed.length,
      modifiedCount:  modified.length,
      unchangedCount: unchanged.length,
    },
  };
}

module.exports = { compareDirectories };
