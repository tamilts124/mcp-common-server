"use strict";
// ── GIT WORKTREE LIST OPERATIONS ────────────────────────────────────────────
// git_worktree_list — list all worktrees attached to a repository (the main
// worktree plus any linked worktrees added via `git worktree add`), parsed
// from `git worktree list --porcelain` so an agent juggling multiple
// worktrees/branches can see at a glance which path has which branch checked
// out, whether it's detached, and whether it's locked/prunable.
//
// Read-only — does not require MCP_ALLOW_EXEC=true.
const { gitExec } = require("./gitOpsHelpers");

/**
 * Return a structured list of worktrees for the repository containing repoDir.
 *
 * @param {string} repoDir Absolute path inside (or at) the git working tree.
 * @returns {{
 *   count: number,
 *   worktrees: Array<{
 *     path: string,
 *     head: string|null,
 *     branch: string|null,      // e.g. "refs/heads/main"; null if bare/detached
 *     isMain: boolean,          // first entry `git worktree list` reports
 *     isBare: boolean,
 *     isDetached: boolean,
 *     isLocked: boolean,
 *     lockReason: string|null,
 *     isPrunable: boolean,
 *     prunableReason: string|null,
 *   }>
 * }}
 */
function gitWorktreeList(repoDir) {
  let raw;
  try {
    raw = gitExec("worktree list --porcelain", repoDir);
  } catch (e) {
    // Distinguish "not a git repo" from other failures for a clearer message.
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git worktree list failed: not a git repository."); }
    throw new Error(`git worktree list failed: ${e.message.split("\n")[0]}`);
  }

  // Porcelain output is a series of blocks separated by a blank line, one
  // block per worktree, each block a set of "<key>[ <value>]" lines (some
  // keys like "bare"/"detached"/"locked"/"prunable" are boolean-only unless
  // they carry a trailing reason string).
  const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const worktrees = [];

  for (const block of blocks) {
    const entry = {
      path: null, head: null, branch: null, isMain: worktrees.length === 0,
      isBare: false, isDetached: false,
      isLocked: false, lockReason: null,
      isPrunable: false, prunableReason: null,
    };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) entry.head = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) entry.branch = line.slice("branch ".length).trim();
      else if (line === "bare") entry.isBare = true;
      else if (line === "detached") entry.isDetached = true;
      else if (line === "locked") entry.isLocked = true;
      else if (line.startsWith("locked ")) { entry.isLocked = true; entry.lockReason = line.slice("locked ".length).trim(); }
      else if (line === "prunable") entry.isPrunable = true;
      else if (line.startsWith("prunable ")) { entry.isPrunable = true; entry.prunableReason = line.slice("prunable ".length).trim(); }
    }
    if (entry.path) worktrees.push(entry);
  }

  return { count: worktrees.length, worktrees };
}

/**
 * Filter gitWorktreeList() down to worktrees that are safe `git worktree prune`
 * candidates — composed on top of the already-tested list, no new git calls
 * beyond it. git itself sets `prunable`/`prunableReason` (e.g. when a linked
 * worktree's directory has been deleted or its administrative files are
 * stale); this adds a filesystem existence cross-check as a second signal so
 * a worktree whose directory is missing but that git hasn't yet flagged is
 * still surfaced with `missingOnDisk: true`, `isMain` is never a candidate
 * (deleting the main worktree isn't a thing `git worktree prune` does).
 *
 * @param {string} repoDir Absolute path inside (or at) the git working tree.
 * @returns {{
 *   totalWorktrees: number,
 *   candidateCount: number,
 *   candidates: Array<{path, branch, missingOnDisk, isPrunable, prunableReason}>,
 * }}
 */
function gitWorktreePruneCandidates(repoDir) {
  const fs = require("fs");
  const { count, worktrees } = gitWorktreeList(repoDir);
  const candidates = [];
  for (const wt of worktrees) {
    if (wt.isMain) continue;
    let missingOnDisk = false;
    try { missingOnDisk = !fs.existsSync(wt.path); } catch (_) { missingOnDisk = false; }
    if (wt.isPrunable || missingOnDisk) {
      candidates.push({
        path: wt.path,
        branch: wt.branch,
        missingOnDisk,
        isPrunable: wt.isPrunable,
        prunableReason: wt.prunableReason,
      });
    }
  }
  return { totalWorktrees: count, candidateCount: candidates.length, candidates };
}

module.exports = { gitWorktreeList, gitWorktreePruneCandidates };
