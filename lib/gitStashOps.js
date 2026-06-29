"use strict";
// ── GIT STASH OPERATIONS ─────────────────────────────────────────────────────
// git_stash_list — list stash entries (index, ref, message, author, date).
//
// Read-only — does not require MCP_ALLOW_EXEC=true.
const { gitExec, q } = require("./gitOpsHelpers");

// -- GIT STASH LIST -----------------------------------------------------------
/**
 * Return a structured list of stash entries in the repository.
 *
 * @param {string} repoDir  Absolute path inside (or at) the git working tree.
 * @returns {{ count: number, stashes: Array<{ index: number, ref: string,
 *   message: string, author: string, email: string, date: string }> }}
 */
function gitStashList(repoDir) {
  const SEP = String.fromCharCode(0x1f); // unit-separator
  const REC = String.fromCharCode(0x1e); // record-separator
  // %gs = reflog subject (e.g. "WIP on main: abc1234 subject")
  const fmt = "%gs" + SEP + "%an" + SEP + "%ae" + SEP + "%aI" + REC;
  let raw;
  try {
    raw = gitExec("log -g refs/stash --format=" + q(fmt), repoDir);
  } catch (e) {
    // No stash ref means no stashes ever created -- valid, not an error.
    if (/no such ref|unknown revision/i.test(e.message)) {
      try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
      catch (_) { throw new Error("git stash list failed: not a git repository."); }
      return { count: 0, stashes: [] };
    }
    throw new Error("git stash list failed: " + e.message.split("\n")[0]);
  }
  const stashes = [];
  let index = 0;
  for (const record of raw.split(REC)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(SEP);
    if (parts.length < 4) continue;
    stashes.push({
      index,
      ref:     "stash@{" + index + "}",
      message: parts[0].trim(),
      author:  parts[1].trim(),
      email:   parts[2].trim(),
      date:    parts[3].trim(),
    });
    index++;
  }
  return { count: stashes.length, stashes };
}

module.exports = { gitStashList };
