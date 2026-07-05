"use strict";
// -- GIT_ORPHANED_BRANCHES -- branches fully merged into a base branch --------
// Lists local branches whose tip is an ancestor of (fully merged into) a base
// branch -- safe-to-delete candidates. Complements find_stale_branches
// (age-based signal) with a merge-based signal: a branch touched yesterday
// but already fully merged is still safe to delete, unlike a branch that's
// merely old but has unmerged work sitting on it. Single `git for-each-ref
// --merged=<base>` call -- no per-branch `git merge-base` process.
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

const SEP = String.fromCharCode(0x1f);
const REC = String.fromCharCode(0x1e);

function detectBaseBranch(repoDir) {
  for (const candidate of ["main", "master"]) {
    try {
      gitExec(`show-ref --verify --quiet refs/heads/${candidate}`, repoDir);
      return candidate;
    } catch (_) { /* try next */ }
  }
  return null;
}

/**
 * @param {string} repoDir  Absolute path inside (or at) the git working tree.
 * @param {object} [opts]
 * @param {string} [opts.base]  Base branch to check merge-status against (default: auto-detect main/master).
 * @returns {{
 *   base: string, currentBranch: string|null, totalBranches: number,
 *   orphanedCount: number,
 *   orphaned: Array<{name, lastCommitDate, lastCommitHash, lastCommitShortHash, lastCommitSubject, lastCommitAuthor, ageDays}>
 * }}
 */
function gitOrphanedBranches(repoDir, opts = {}) {
  let base = (opts.base && String(opts.base).trim()) ? String(opts.base).trim() : null;
  if (base) {
    assertSafeArg(base, "base");
  } else {
    base = detectBaseBranch(repoDir);
    if (!base) {
      try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
      catch (_) { throw new Error("git_orphaned_branches: not a git repository."); }
      throw new Error("git_orphaned_branches: could not auto-detect a base branch (no 'main' or 'master' found); pass 'base' explicitly.");
    }
  }

  // Validate the base ref exists before using it in --merged (a bad ref
  // there produces a confusing/empty result rather than a clear error).
  try {
    gitExec(`rev-parse --verify ${q(base)}`, repoDir);
  } catch (e) {
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git_orphaned_branches: not a git repository."); }
    throw new Error(`git_orphaned_branches: unknown base branch '${base}'.`);
  }

  const fmt =
    "%(HEAD)" + SEP +
    "%(refname:short)" + SEP +
    "%(objectname)" + SEP +
    "%(objectname:short)" + SEP +
    "%(committerdate:iso-strict)" + SEP +
    "%(subject)" + SEP +
    "%(authorname)" + REC;

  let rawAll, rawMerged;
  try {
    rawAll = gitExec(`for-each-ref --format=${q(fmt)} refs/heads`, repoDir);
    rawMerged = gitExec(`for-each-ref --format=${q(fmt)} --merged=${q(base)} refs/heads`, repoDir);
  } catch (e) {
    throw new Error(`git_orphaned_branches: ${e.message.split("\n")[0]}`);
  }

  function parse(raw) {
    const out = [];
    for (const record of raw.split(REC)) {
      const trimmed = record.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(SEP);
      if (parts.length < 7) continue;
      out.push({
        isCurrent: parts[0].trim() === "*",
        name: parts[1].trim(),
        lastCommitHash: parts[2].trim(),
        lastCommitShortHash: parts[3].trim(),
        lastCommitDate: parts[4].trim(),
        lastCommitSubject: parts[5].trim(),
        lastCommitAuthor: parts[6].trim(),
      });
    }
    return out;
  }

  const all = parse(rawAll);
  const merged = parse(rawMerged);

  let currentBranch = null;
  for (const b of all) if (b.isCurrent) currentBranch = b.name;
  if (currentBranch === null) {
    try {
      const head = gitExec("rev-parse --abbrev-ref HEAD", repoDir).trim();
      if (head && head !== "HEAD") currentBranch = head;
    } catch (_) { /* non-fatal */ }
  }

  const now = Date.now();
  const orphaned = merged
    .filter(b => b.name !== base && b.name !== currentBranch)
    .map(b => {
      const commitMs = Date.parse(b.lastCommitDate);
      return {
        name: b.name,
        lastCommitHash: b.lastCommitHash,
        lastCommitShortHash: b.lastCommitShortHash,
        lastCommitDate: b.lastCommitDate,
        lastCommitSubject: b.lastCommitSubject,
        lastCommitAuthor: b.lastCommitAuthor,
        ageDays: Number.isFinite(commitMs) ? Math.floor((now - commitMs) / (24 * 60 * 60 * 1000)) : null,
      };
    })
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1)); // oldest-touched first

  return {
    base,
    currentBranch,
    totalBranches: all.length,
    orphanedCount: orphaned.length,
    orphaned,
  };
}

module.exports = { gitOrphanedBranches };
