"use strict";
// -- GIT FIND STALE BRANCHES -------------------------------------------------
// find_stale_branches -- list local (and optionally remote) branches whose
// last commit is older than a given age threshold, sorted oldest-first.
// Useful for repo-cleanup audits ("which branches can probably be deleted").
//
// Read-only -- does not require MCP_ALLOW_EXEC=true. Reuses the same
// for-each-ref formatting approach as gitBranchOps.js's git_branch_list.
const { gitExec, q } = require("./gitOpsHelpers");

const DEFAULT_DAYS = 90;
const MAX_DAYS = 3650; // 10 years -- generous ceiling, not a real limit concern

/**
 * @param {string}  repoDir       Absolute path inside (or at) the git working tree.
 * @param {number}  days          Age threshold in days (default 90). Branches whose
 *                                last commit is older than this are "stale".
 * @param {boolean} includeRemote When true, also consider remote-tracking branches.
 * @returns {{
 *   thresholdDays: number,
 *   cutoffDate: string,        // ISO 8601
 *   currentBranch: string|null,
 *   totalBranches: number,
 *   staleCount: number,
 *   stale: Array<{name, isCurrent, isRemote, lastCommitDate, lastCommitHash,
 *                 lastCommitShortHash, lastCommitSubject, lastCommitAuthor, ageDays}>
 * }}
 */
function findStaleBranches(repoDir, days, includeRemote) {
  let thresholdDays = Number(days);
  if (!Number.isFinite(thresholdDays)) thresholdDays = DEFAULT_DAYS;
  if (thresholdDays < 0) thresholdDays = 0;
  if (thresholdDays > MAX_DAYS) thresholdDays = MAX_DAYS;

  const SEP = String.fromCharCode(0x1f);
  const REC = String.fromCharCode(0x1e);

  const fmt =
    "%(HEAD)" + SEP +
    "%(refname:short)" + SEP +
    "%(refname)" + SEP +
    "%(objectname)" + SEP +
    "%(objectname:short)" + SEP +
    "%(committerdate:iso-strict)" + SEP +
    "%(subject)" + SEP +
    "%(authorname)" + REC;

  const patterns = includeRemote ? "refs/heads refs/remotes" : "refs/heads";

  let raw;
  try {
    raw = gitExec(`for-each-ref --format=${q(fmt)} ${patterns}`, repoDir);
  } catch (e) {
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("find_stale_branches failed: not a git repository."); }
    throw new Error(`find_stale_branches failed: ${e.message.split("\n")[0]}`);
  }

  const now = Date.now();
  const cutoffMs = now - thresholdDays * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs).toISOString();

  const all = [];
  let currentBranch = null;

  for (const record of raw.split(REC)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(SEP);
    if (parts.length < 8) continue;

    const isCurrent = parts[0].trim() === "*";
    const shortName = parts[1].trim();
    const fullRef = parts[2].trim();
    const isRemote = fullRef.startsWith("refs/remotes/");
    if (isRemote && /\/HEAD$/.test(fullRef)) continue; // skip synthetic origin/HEAD

    const lastCommitDate = parts[5].trim();
    const commitMs = Date.parse(lastCommitDate);
    const ageDays = Number.isFinite(commitMs) ? Math.floor((now - commitMs) / (24 * 60 * 60 * 1000)) : null;

    all.push({
      name: shortName,
      isCurrent,
      isRemote,
      lastCommitHash:      parts[3].trim(),
      lastCommitShortHash: parts[4].trim(),
      lastCommitDate,
      lastCommitSubject:   parts[6].trim(),
      lastCommitAuthor:    parts[7].trim(),
      ageDays,
    });
    if (isCurrent) currentBranch = shortName;
  }

  if (currentBranch === null) {
    try {
      const head = gitExec("rev-parse --abbrev-ref HEAD", repoDir).trim();
      if (head && head !== "HEAD") currentBranch = head;
    } catch (_) { /* non-fatal */ }
  }

  const stale = all
    .filter(b => b.ageDays !== null && Date.parse(b.lastCommitDate) < cutoffMs)
    .sort((a, b) => Date.parse(a.lastCommitDate) - Date.parse(b.lastCommitDate)); // oldest first

  return {
    thresholdDays,
    cutoffDate,
    currentBranch,
    totalBranches: all.length,
    staleCount: stale.length,
    stale,
  };
}

module.exports = { findStaleBranches };
