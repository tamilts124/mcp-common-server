"use strict";
// ── DUPLICATE FILE DETECTION ────────────────────────────────────────────────
// find_duplicates — scan a directory recursively and group files that share
// identical content (same cryptographic hash), reporting duplicate sets and
// aggregate wasted-space totals. Read-only — does not require MCP_ALLOW_EXEC.
//
// Performance note: hashing every file in a large tree is wasteful when most
// files are unique. We first group candidate files by size (a cheap stat()
// call) and only compute a content hash for files that share their exact
// size with at least one other file. Files with a unique size in the tree
// can never be a duplicate of anything, so they are skipped entirely.

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { isIgnored, clientRelative } = require("./roots");

const ALLOWED_ALGORITHMS = ["md5", "sha1", "sha256", "sha512"];

/**
 * Recursively collect { absPath, relPath, size } for every file under `dir`,
 * skipping anything matched by the server's MCP_IGNORE patterns.
 */
function collectCandidates(dir, alias, extensions) {
  const out = [];
  const exts = extensions && extensions.length ? extensions : null;

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      throw new Error(`find_duplicates: cannot read directory '${current}': ${e.message}`);
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        if (exts && !exts.some(x => entry.name.endsWith(x))) continue;
        let size;
        try { size = fs.statSync(abs).size; } catch (_) { continue; } // skip unreadable/broken entries
        out.push({ absPath: abs, relPath: clientRelative(alias, abs), size });
      }
    }
  }

  walk(dir);
  return out;
}

/**
 * Scan `rootDir` for duplicate files by content hash.
 *
 * @param {string}   rootDir              Absolute, already-jailed directory to scan.
 * @param {string}   alias                Root alias, used to build clean relative paths.
 * @param {object}   [opts]
 * @param {string}   [opts.algorithm]     "md5" | "sha1" | "sha256" (default) | "sha512"
 * @param {string[]} [opts.extensions]    Only consider files with these extensions.
 * @param {number}   [opts.minSize]       Ignore files smaller than this many bytes (default 0).
 * @returns {{
 *   path: string, algorithm: string, filesScanned: number, filesHashed: number,
 *   duplicateSets: Array<{ hash: string, size: number, count: number, wastedBytes: number, files: string[] }>,
 *   duplicateSetCount: number, totalDuplicateFiles: number, totalWastedBytes: number
 * }}
 */
function findDuplicates(rootDir, alias, opts = {}) {
  const algorithm = (opts.algorithm || "sha256").toLowerCase();
  if (!ALLOWED_ALGORITHMS.includes(algorithm))
    throw new Error(`find_duplicates: unsupported algorithm '${opts.algorithm}'. Choose one of: ${ALLOWED_ALGORITHMS.join(", ")}.`);

  const minSize = opts.minSize != null ? Number(opts.minSize) : 0;
  if (!Number.isFinite(minSize) || minSize < 0)
    throw new Error(`find_duplicates: 'min_size' must be a non-negative number, got '${opts.minSize}'.`);

  const stat = fs.statSync(rootDir);
  if (!stat.isDirectory())
    throw new Error(`find_duplicates: '${rootDir}' is not a directory.`);

  const candidates = collectCandidates(rootDir, alias, opts.extensions)
    .filter(f => f.size >= minSize);

  // Pass 1 — group by size. Only sizes shared by 2+ files can possibly be duplicates.
  const bySize = new Map();
  for (const f of candidates) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }

  // Pass 2 — hash only files whose size is shared with at least one sibling.
  const byHash = new Map(); // hash -> { size, files: [relPath,...] }
  let filesHashed = 0;
  for (const group of bySize.values()) {
    if (group.length < 2) continue; // unique size — cannot be a duplicate of anything
    for (const f of group) {
      let hash;
      try {
        hash = crypto.createHash(algorithm).update(fs.readFileSync(f.absPath)).digest("hex");
      } catch (e) {
        continue; // skip unreadable file rather than crashing the whole scan
      }
      filesHashed++;
      const key = `${f.size}:${hash}`;
      if (!byHash.has(key)) byHash.set(key, { hash, size: f.size, files: [] });
      byHash.get(key).files.push(f.relPath);
    }
  }

  const duplicateSets = [...byHash.values()]
    .filter(set => set.files.length > 1)
    .map(set => ({
      hash: set.hash,
      size: set.size,
      count: set.files.length,
      wastedBytes: set.size * (set.files.length - 1),
      files: set.files.slice().sort(),
    }))
    .sort((a, b) => b.wastedBytes - a.wastedBytes);

  return {
    algorithm,
    filesScanned: candidates.length,
    filesHashed,
    duplicateSetCount: duplicateSets.length,
    totalDuplicateFiles: duplicateSets.reduce((n, s) => n + s.count, 0),
    totalWastedBytes: duplicateSets.reduce((n, s) => n + s.wastedBytes, 0),
    duplicateSets,
  };
}

module.exports = { findDuplicates };
