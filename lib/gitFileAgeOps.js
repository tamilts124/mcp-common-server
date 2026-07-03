"use strict";
// ── GIT_FILE_AGE — inverse-recency companion to git_blame_hotspots ────────
// Days since each tracked file's last commit — surfaces stale/abandoned
// files (candidates for removal/re-review) rather than hot ones. Same
// single-git-log-walk technique as git_blame_hotspots (SENTINEL-delimited
// --name-only parse, O(1) git processes) instead of one `git log -1 --
// <file>` spawn per tracked file.
//
// Tracked files whose last touch falls outside the scanned commit window
// (max_commits) are reported with ageDays:null / unknown:true rather than
// silently omitted or mis-reported as untouched — the caller can widen
// max_commits if it matters for their use case.
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

const DEFAULT_MAX_FILES = 300;
const HARD_MAX_FILES = 2000;
const DEFAULT_MAX_COMMITS = 3000;
const HARD_MAX_COMMITS = 20000;
const DEFAULT_TOP_N = 20;
const MAX_TOP_N = 500;
const SENTINEL = "\x01";
const FIELD_SEP = "\x02";

function clampInt(v, def, min, max) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = def;
  return Math.min(Math.max(n, min), max);
}

/**
 * Days since each tracked file's last commit, oldest first.
 * @param {string} repoDir  Absolute repo directory (already repo-root resolved).
 * @param {string} origPath Client-relative path echoed in the result (scope label).
 * @param {object} [opts]
 * @param {number} [opts.maxFiles]    Cap on tracked files enumerated (1-2000, default 300).
 * @param {number} [opts.maxCommits]  Cap on commit history depth scanned (1-20000, default 3000).
 * @param {number} [opts.topN]        Cap on the result list length (1-500, default 20).
 * @param {string} [opts.scopePath]   Optional pathspec (relative to repoDir).
 * @returns {object}
 */
function gitFileAge(repoDir, origPath, opts = {}) {
  const maxFiles = clampInt(opts.maxFiles, DEFAULT_MAX_FILES, 1, HARD_MAX_FILES);
  const maxCommits = clampInt(opts.maxCommits, DEFAULT_MAX_COMMITS, 1, HARD_MAX_COMMITS);
  const topN = clampInt(opts.topN, DEFAULT_TOP_N, 1, MAX_TOP_N);

  let scopeArg = "";
  if (opts.scopePath) {
    assertSafeArg(opts.scopePath, "path");
    scopeArg = ` -- ${q(opts.scopePath)}`;
  }

  // 1. Enumerate tracked files (respects .gitignore).
  let lsOut;
  try {
    lsOut = gitExec(`ls-files${scopeArg}`, repoDir);
  } catch (e) {
    throw new Error(`git_file_age: git ls-files failed: ${e.message.split("\n")[0]}`);
  }
  const allFiles = lsOut ? lsOut.split("\n").filter(Boolean) : [];
  const filesTruncated = allFiles.length > maxFiles;
  const trackedFiles = allFiles.slice(0, maxFiles);

  // 2. Single newest-first commit walk; first occurrence of a file = its
  //    most recent commit (git log defaults to reverse-chronological order).
  let raw;
  try {
    raw = gitExec(
      `log -n ${maxCommits} --format=${SENTINEL}%H${FIELD_SEP}%ai${FIELD_SEP}%an --name-only${scopeArg}`,
      repoDir
    );
  } catch (e) {
    throw new Error(`git_file_age: git log failed: ${e.message.split("\n")[0]}`);
  }

  const lastSeen = new Map(); // file -> {hash, date, author}
  let current = null;
  let commitsScanned = 0;

  for (const line of raw.split("\n")) {
    if (line.startsWith(SENTINEL)) {
      const [hash, date, author] = line.slice(SENTINEL.length).split(FIELD_SEP);
      current = { hash, date, author };
      commitsScanned++;
      continue;
    }
    if (!line || !current) continue;
    if (!lastSeen.has(line)) lastSeen.set(line, current);
  }

  const now = Date.now();
  const results = trackedFiles.map(file => {
    const seen = lastSeen.get(file);
    if (!seen) return { file, ageDays: null, unknown: true, lastCommitDate: null, lastCommitHash: null, lastCommitAuthor: null };
    const ageDays = Math.floor((now - new Date(seen.date).getTime()) / 86400000);
    return {
      file,
      ageDays,
      unknown: false,
      lastCommitDate: seen.date,
      lastCommitHash: seen.hash,
      lastCommitShortHash: seen.hash.slice(0, 7),
      lastCommitAuthor: seen.author,
    };
  });

  results.sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1; // known ages first
    if (!a.unknown) return b.ageDays - a.ageDays; // oldest first
    return a.file.localeCompare(b.file);
  });

  const resultsTruncated = results.length > topN;
  const oldest = results.slice(0, topN);

  return {
    path: origPath || ".",
    filesScanned: trackedFiles.length,
    filesTruncated,
    commitsScanned,
    commitWindowMayBeTruncated: commitsScanned >= maxCommits,
    truncated: resultsTruncated,
    oldest,
  };
}

module.exports = { gitFileAge };
