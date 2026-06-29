"use strict";
// ── GIT BRANCH LIST OPERATIONS ────────────────────────────────────────────────
// git_branch_list — list local (and optionally remote) branches with the
// current-branch marker and last-commit metadata for each.
//
// Read-only — does not require MCP_ALLOW_EXEC=true.
const { gitExec, q } = require("./gitOpsHelpers");

// ── GIT BRANCH LIST ───────────────────────────────────────────────────────────
/**
 * Return a structured list of branches in the repository.
 *
 * @param {string}  repoDir       Absolute path inside (or at) the git working tree.
 * @param {boolean} includeRemote When true, also include remote-tracking branches
 *                                (refs/remotes/*). Default: false (local only).
 * @returns {{
 *   currentBranch: string|null,
 *   count: number,
 *   branches: Array<{
 *     name: string,
 *     isCurrent: boolean,
 *     isRemote: boolean,
 *     lastCommitHash: string,
 *     lastCommitShortHash: string,
 *     lastCommitDate: string,   // ISO 8601
 *     lastCommitSubject: string,
 *     lastCommitAuthor: string,
 *   }>
 * }}
 */
function gitBranchList(repoDir, includeRemote) {
  const SEP = String.fromCharCode(0x1f); // unit-separator
  const REC = String.fromCharCode(0x1e); // record-separator

  // %(HEAD) is "*" for the currently checked-out branch, " " otherwise.
  // %(refname:short) gives "main" for local, "origin/main" for remote refs.
  const fmt =
    "%(HEAD)" + SEP +
    "%(refname:short)" + SEP +
    "%(refname)" + SEP +
    "%(objectname)" + SEP +
    "%(objectname:short)" + SEP +
    "%(committerdate:iso-strict)" + SEP +
    "%(subject)" + SEP +
    "%(authorname)" + REC;

  const patterns = includeRemote
    ? "refs/heads refs/remotes"
    : "refs/heads";

  let raw;
  try {
    raw = gitExec(`for-each-ref --format=${q(fmt)} ${patterns}`, repoDir);
  } catch (e) {
    // Distinguish "not a git repo" from other failures for a clearer message.
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git branch list failed: not a git repository."); }
    throw new Error(`git branch list failed: ${e.message.split("\n")[0]}`);
  }

  const branches = [];
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
    // Skip the synthetic "origin/HEAD" pointer ref — it's not a real branch.
    if (isRemote && /\/HEAD$/.test(fullRef)) continue;

    const entry = {
      name: shortName,
      isCurrent,
      isRemote,
      lastCommitHash:       parts[3].trim(),
      lastCommitShortHash:  parts[4].trim(),
      lastCommitDate:       parts[5].trim(),
      lastCommitSubject:    parts[6].trim(),
      lastCommitAuthor:     parts[7].trim(),
    };
    branches.push(entry);
    if (isCurrent) currentBranch = shortName;
  }

  // A detached HEAD has no local branch marked current via for-each-ref;
  // fall back to a direct check so currentBranch isn't misleadingly null
  // when on a real (but perhaps just-created/unborn) branch.
  if (currentBranch === null) {
    try {
      const head = gitExec("rev-parse --abbrev-ref HEAD", repoDir).trim();
      if (head && head !== "HEAD") currentBranch = head;
    } catch (_) { /* non-fatal: leave currentBranch as null */ }
  }

  return { currentBranch, count: branches.length, branches };
}

module.exports = { gitBranchList };
