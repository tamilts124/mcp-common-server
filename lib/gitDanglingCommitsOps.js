"use strict";
// GIT_DANGLING_COMMITS - recover commits unreachable from any ref.
// Lists commit objects that still exist in the object database but are not
// reachable from any branch or tag HEAD - the classic "I did a hard reset
// / deleted a branch and need my work back" recovery scenario, before
// git gc eventually prunes them. Uses `git fsck --unreachable --no-reflogs`:
// fsck by DEFAULT treats reflog entries as extra reachability roots, so a
// commit still referenced by a reflog entry (the common post-reset/
// post-amend case) would NOT show up under a plain --unreachable run.
// --no-reflogs is required to reveal commits kept alive only by a reflog
// entry, not by any branch/tag - exactly the recoverable set this tool is
// meant to surface (once the reflog entry expires and git gc runs, these
// are what actually gets pruned).
// Read-only - does not require MCP_ALLOW_EXEC beyond running git itself,
// consistent with every other git*Ops.js tool in this codebase.

const { gitExec, q } = require("./gitOpsHelpers");

const DEFAULT_LIMIT = 50;
const HARD_LIMIT     = 500;

const HEX_RE = /^[0-9a-f]{4,64}$/i;

/**
 * @param {string} repoDir  Absolute, jail-bounded repo root (already resolved via findRepoRoot).
 * @param {number} [limit]  Max dangling commits to detail (1-500, default 50).
 * @returns {{ count: number, truncated: boolean, danglingCommits: Array<{hash, shortHash, subject, author, email, date}> }}
 */
function gitDanglingCommits(repoDir, limit) {
  let n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_LIMIT;
  n = Math.min(n, HARD_LIMIT);

  let fsckOut;
  try {
    fsckOut = gitExec("fsck --unreachable --no-reflogs --no-progress", repoDir);
  } catch (e) {
    const msg = e.message || "";
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git_dangling_commits failed: not a git repository."); }
    throw new Error(`git_dangling_commits failed: ${msg.split("\n")[0]}`);
  }

  const hashes = [];
  for (const line of fsckOut.split("\n")) {
    const m = line.match(/^unreachable commit ([0-9a-f]{4,64})/i);
    if (m) hashes.push(m[1]);
  }

  const total = hashes.length;
  const toDetail = hashes.slice(0, n).filter((h) => HEX_RE.test(h));

  if (toDetail.length === 0) {
    return { count: total, truncated: total > toDetail.length, danglingCommits: [] };
  }

  const SEP = "\x1f";
  const REC = "\x1e";
  const fmt = `%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ae${SEP}%aI${REC}`;

  let logOut;
  try {
    logOut = gitExec(`log --no-walk --format=${q(fmt)} ${toDetail.join(" ")}`, repoDir);
  } catch (e) {
    const msg = e.message || "";
    // A hash fsck reported may already be gone (rare race with concurrent gc) —
    // tolerate only that specific, expected case; anything else is a real
    // failure and must surface with its actual message, not be swallowed.
    if (/bad revision|unknown revision|ambiguous argument/i.test(msg)) {
      return { count: total, truncated: total > toDetail.length, danglingCommits: [] };
    }
    throw new Error(`git_dangling_commits failed while looking up commit metadata: ${msg.split("\n")[0]}`);
  }

  const danglingCommits = [];
  for (const record of logOut.split(REC)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(SEP);
    if (parts.length < 6) continue;
    danglingCommits.push({
      hash:      parts[0].trim(),
      shortHash: parts[1].trim(),
      subject:   parts[2].trim(),
      author:    parts[3].trim(),
      email:     parts[4].trim(),
      date:      parts[5].trim(),
    });
  }

  return {
    count: total,
    truncated: total > toDetail.length,
    danglingCommits,
  };
}

module.exports = { gitDanglingCommits };
