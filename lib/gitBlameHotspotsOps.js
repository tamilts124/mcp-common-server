"use strict";
// ── GIT_BLAME_HOTSPOTS — review-risk ranking by recent author/commit churn ──
// Files touched by many distinct authors recently are more collision- and
// regression-prone (concurrent edits, unclear ownership). Unlike
// git_ownership (all-time blame-line aggregate per file/dir, one git-blame
// process per file), this tool answers "which files are hot right now": a
// SINGLE `git log --since=<N days> --name-only` call over the whole scope,
// parsed client-side into per-file {distinct author count, commit count}.
// This is deliberately not per-file git-blame — that would be O(files)
// process spawns; this is O(1) regardless of file count.
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

const DEFAULT_SINCE_DAYS = 90;
const MAX_SINCE_DAYS = 3650;
const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 500;
// Sentinel byte to mark commit-author lines in the parsed log stream —
// chosen because it can never appear in a valid author name or file path.
const SENTINEL = "\x01";

function clampInt(v, def, min, max) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = def;
  return Math.min(Math.max(n, min), max);
}

/**
 * Rank files by distinct-author count + commit count over a recent window.
 * @param {string} repoDir    Absolute repo directory (already jail/repo-root resolved).
 * @param {string} origPath   Client-relative path echoed in the result (scope label).
 * @param {object} [opts]
 * @param {number} [opts.sinceDays]  Lookback window in days (1-3650, default 90).
 * @param {number} [opts.topN]       Max hotspots returned (1-500, default 20).
 * @param {string} [opts.scopePath]  Optional pathspec (relative to repoDir) to restrict the log.
 * @param {string[]} [opts.extensions] Optional file-extension filter.
 * @returns {{path, sinceDays, filesWithActivity, truncated, hotspots: Array}}
 */
function gitBlameHotspots(repoDir, origPath, opts = {}) {
  const sinceDays = clampInt(opts.sinceDays, DEFAULT_SINCE_DAYS, 1, MAX_SINCE_DAYS);
  const topN = clampInt(opts.topN, DEFAULT_TOP_N, 1, MAX_TOP_N);
  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : null;

  let cmd = `log --since="${sinceDays} days ago" --format=${SENTINEL}%an --name-only`;
  if (opts.scopePath) {
    assertSafeArg(opts.scopePath, "path");
    cmd += ` -- ${q(opts.scopePath)}`;
  }

  let raw;
  try {
    raw = gitExec(cmd, repoDir);
  } catch (e) {
    throw new Error(`git_blame_hotspots: git log failed: ${e.message.split("\n")[0]}`);
  }

  const fileStats = new Map(); // file -> { authors: Set, commits: number }
  let currentAuthor = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith(SENTINEL)) {
      currentAuthor = line.slice(SENTINEL.length);
      continue;
    }
    if (!line || !currentAuthor) continue; // blank separator line, or file before any commit header seen
    if (extensions && !extensions.some(ext => line.endsWith(ext))) continue;

    let stat = fileStats.get(line);
    if (!stat) {
      stat = { authors: new Set(), commits: 0 };
      fileStats.set(line, stat);
    }
    stat.authors.add(currentAuthor);
    stat.commits++;
  }

  let hotspots = [...fileStats.entries()].map(([file, s]) => ({
    file,
    authorCount: s.authors.size,
    commitCount: s.commits,
    authors: [...s.authors].sort(),
  }));

  hotspots.sort((a, b) =>
    b.authorCount - a.authorCount ||
    b.commitCount - a.commitCount ||
    a.file.localeCompare(b.file)
  );

  const truncated = hotspots.length > topN;
  hotspots = hotspots.slice(0, topN);

  return {
    path: origPath || ".",
    sinceDays,
    filesWithActivity: fileStats.size,
    truncated,
    hotspots,
  };
}

module.exports = { gitBlameHotspots };
