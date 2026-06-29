"use strict";
// ── HASH_DIRECTORY ───────────────────────────────────────────────────────────
// hash_directory — compute a single aggregate fingerprint of an entire directory
// tree. All file contents are hashed together with their relative paths (sorted)
// so any add/remove/rename/modify in the tree changes the aggregate hash.
// Read-only, zero dependencies.

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { isIgnored } = require("./roots");

const ALLOWED_ALGORITHMS = ["md5", "sha1", "sha256", "sha512"];

/**
 * Collect sorted { relPath, absPath } for every file under baseDir,
 * skipping MCP_IGNORE'd names.
 */
function collectSorted(baseDir, extensions) {
  const files = [];
  const exts  = extensions && extensions.length ? extensions : null;

  function walk(dir, relPrefix) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { throw new Error(`hash_directory: cannot read '${dir}': ${e.message}`); }

    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        if (exts && !exts.some(x => entry.name.endsWith(x))) continue;
        files.push({ relPath: rel, absPath: abs });
      }
    }
  }

  walk(baseDir, "");
  // Deterministic sort by relative path
  files.sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  return files;
}

/**
 * Compute an aggregate hash of a directory tree.
 *
 * @param {string}   absDir      Absolute path (jail-validated by caller).
 * @param {string}   origPath    Client path (for echoing back).
 * @param {object}   [opts]
 * @param {string}   [opts.algorithm]   md5 | sha1 | sha256 (default) | sha512
 * @param {string[]} [opts.extensions]  Only include files with these extensions.
 * @returns {{
 *   path: string, algorithm: string, hash: string,
 *   fileCount: number, totalBytes: number
 * }}
 */
function hashDirectory(absDir, origPath, opts = {}) {
  const algorithm = (opts.algorithm || "sha256").toLowerCase();
  if (!ALLOWED_ALGORITHMS.includes(algorithm))
    throw new Error(`hash_directory: unsupported algorithm '${opts.algorithm}'. Choose one of: ${ALLOWED_ALGORITHMS.join(", ")}.`);

  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new Error(`hash_directory: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isDirectory())
    throw new Error(`hash_directory: '${origPath}' is not a directory.`);

  const files = collectSorted(absDir, opts.extensions);

  // Build a combined hash: for each file (in sorted relPath order) feed
  // the relPath + NUL separator + file content into a rolling hash.
  const agg = crypto.createHash(algorithm);
  let totalBytes = 0;

  for (const { relPath, absPath } of files) {
    let content;
    try { content = fs.readFileSync(absPath); }
    catch (e) { throw new Error(`hash_directory: cannot read '${relPath}': ${e.message}`); }
    agg.update(relPath);
    agg.update("\0");
    agg.update(content);
    totalBytes += content.length;
  }

  return {
    path:       origPath,
    algorithm,
    hash:       agg.digest("hex"),
    fileCount:  files.length,
    totalBytes,
  };
}

module.exports = { hashDirectory };
