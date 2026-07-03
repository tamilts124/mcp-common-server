"use strict";
// ── GIT_UNTRACKED_SIZE — sum on-disk size of untracked files in a repo ────
// Runs `git status --porcelain=v2 --untracked-files=all` (respects
// .gitignore automatically — ignored files never appear as "?" entries),
// stats each untracked file on disk, and returns total size plus the
// largest offenders. Catches accidental large-file additions (build
// artifacts, datasets, binaries) before `git add`/`git commit`.

const fs   = require("fs");
const path = require("path");
const { gitExec } = require("./gitOpsHelpers");

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024, i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(2)} ${units[i]}`;
}

/**
 * Sum the on-disk size of untracked (non-gitignored) files in a repo.
 * @param {string} repoDir  Absolute repo directory (already jail-resolved).
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {number} [opts.topN] Number of largest files to list (1-500, default 20).
 * @returns {{path, fileCount, totalBytes, totalHumanSize, largest:[{file,bytes,humanSize}]}}
 */
function gitUntrackedSize(repoDir, origPath, opts = {}) {
  const topN = Math.min(Math.max(1, Math.trunc(opts.topN ?? 20)), 500);

  // -z gives NUL-separated, unquoted paths — safe for filenames with spaces
  // or unusual characters. --untracked-files=all lists individual files
  // inside untracked directories too, not just the directory itself.
  const raw = gitExec("status --porcelain=v2 --untracked-files=all -z", repoDir);
  const entries = raw.length ? raw.split("\0") : [];

  const files = [];
  for (const line of entries) {
    if (!line) continue;
    // Untracked entries in porcelain=v2 are: "? <path>"
    if (line[0] !== "?" || line[1] !== " ") continue;
    const relPath = line.slice(2);
    const abs = path.join(repoDir, relPath);
    let size = 0;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      size = st.size;
    } catch (e) { continue; } // race: file removed between status and stat
    files.push({ file: origPath ? origPath + "/" + relPath : relPath, bytes: size });
  }

  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  files.sort((a, b) => b.bytes - a.bytes);
  const largest = files.slice(0, topN).map(f => ({ ...f, humanSize: humanSize(f.bytes) }));

  return {
    path: origPath,
    fileCount: files.length,
    totalBytes,
    totalHumanSize: humanSize(totalBytes),
    largest,
  };
}

module.exports = { gitUntrackedSize };
