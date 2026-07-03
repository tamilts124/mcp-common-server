"use strict";
// ── FIND_LARGE_GIT_OBJECTS — largest blobs ever committed, across all history ──
// Complements git_untracked_size (untracked working-tree bloat): this scans
// the *committed* object history, so it catches large files that were added
// and later deleted — those still bloat the .git directory and every future
// clone even though they're invisible to a working-tree size scan.
//
// Cross-platform note: uses spawnSync + a stdin pipe (not a shell `|` pipe)
// to feed the hash list from `git rev-list --objects --all` into
// `git cat-file --batch-check`, since this project's dev environment is
// Windows and shell pipe syntax between two `git` invocations is not
// reliably portable through execSync's shell wrapper there.

const { execSync, spawnSync } = require("child_process");

const GIT_TIMEOUT_MS = 30_000;
const REV_LIST_MAX_BUFFER = 50 * 1024 * 1024;
const CAT_FILE_MAX_BUFFER = 50 * 1024 * 1024;

/**
 * Find the largest blobs ever committed in a repo's full history.
 * @param {string} repoDir
 * @param {object} [opts]
 * @param {number} [opts.topN]          Result cap (1-500, default 20).
 * @param {number} [opts.minSizeBytes]  Only report blobs >= this size (default 0 = no filter).
 * @param {number} [opts.maxObjects]    Safety cap on objects scanned from rev-list (1000-500000, default 100000).
 * @returns {{totalObjectsScanned, blobCount, truncated, objects: Array<{path, hash, sizeBytes}>}}
 */
function findLargeGitObjects(repoDir, opts = {}) {
  const topN = Math.min(Math.max(1, Math.trunc(opts.topN ?? 20)), 500);
  const minSizeBytes = Math.max(0, Math.trunc(opts.minSizeBytes ?? 0));
  const maxObjects = Math.min(Math.max(1000, Math.trunc(opts.maxObjects ?? 100000)), 500000);

  const parent = require("path").dirname(repoDir);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: parent };

  let revListRaw;
  try {
    revListRaw = execSync("git rev-list --objects --all", {
      cwd: repoDir, timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8", windowsHide: true, maxBuffer: REV_LIST_MAX_BUFFER, env,
    });
  } catch (e) {
    throw new Error(`find_large_git_objects: git rev-list failed: ${e.message.split("\n")[0]}`);
  }

  // Each line: "<hash>[ <path>]" — commits/annotated-tags have no path.
  const hashToPath = new Map();
  const hashes = [];
  let truncated = false;
  for (const line of revListRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (hashes.length >= maxObjects) { truncated = true; break; }
    const sp = trimmed.indexOf(" ");
    const hash = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const p = sp === -1 ? null : trimmed.slice(sp + 1);
    if (!hashToPath.has(hash)) { hashes.push(hash); hashToPath.set(hash, p); }
  }

  let batchOut = { stdout: "", status: 0, error: null };
  if (hashes.length > 0) {
    batchOut = spawnSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      cwd: repoDir, timeout: GIT_TIMEOUT_MS, encoding: "utf8", windowsHide: true,
      maxBuffer: CAT_FILE_MAX_BUFFER, input: hashes.join("\n") + "\n", env,
    });
  }
  if (batchOut.error) throw new Error(`find_large_git_objects: git cat-file failed: ${batchOut.error.message}`);

  // Dedupe by path, keeping the largest size ever seen for that path (a
  // file can be committed/modified/re-added at multiple hashes over time).
  const byPath = new Map();
  let blobCount = 0;
  for (const line of batchOut.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(" ");
    if (parts.length !== 3) continue;
    const [hash, type, sizeRaw] = parts;
    if (type !== "blob") continue;
    blobCount++;
    const size = parseInt(sizeRaw, 10) || 0;
    const p = hashToPath.get(hash) || "(unknown path)";
    const existing = byPath.get(p);
    if (!existing || size > existing.sizeBytes) byPath.set(p, { path: p, hash, sizeBytes: size });
  }

  const objects = [...byPath.values()]
    .filter(o => o.sizeBytes >= minSizeBytes)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, topN);

  return {
    totalObjectsScanned: hashes.length,
    blobCount,
    truncated,
    objects,
  };
}

module.exports = { findLargeGitObjects };
