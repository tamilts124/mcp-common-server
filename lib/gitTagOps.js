"use strict";
// ── GIT TAG LIST OPERATIONS ─────────────────────────────────────────────────
// git_tag_list — list all tags in a repository with their target commit,
// date, and message. Handles both lightweight tags (a plain ref pointing
// directly at a commit) and annotated tags (a ref pointing at a tag object,
// which itself points at a commit and carries its own message/date).
//
// Read-only — does not require MCP_ALLOW_EXEC=true.
const { gitExec, q } = require("./gitOpsHelpers");

// ── GIT TAG LIST ─────────────────────────────────────────────────────────────
/**
 * Return a structured list of tags in the repository, most recent first.
 *
 * @param {string} repoDir  Absolute path inside (or at) the git working tree.
 * @returns {{
 *   count: number,
 *   tags: Array<{
 *     name: string,
 *     hash: string,        // the target commit hash (dereferenced for annotated tags)
 *     isAnnotated: boolean,
 *     date: string,        // ISO 8601 — tagger date for annotated, committer date for lightweight
 *     message: string,     // tag's own message for annotated, commit subject for lightweight
 *   }>
 * }}
 */
function gitTagList(repoDir) {
  const SEP = String.fromCharCode(0x1f); // unit-separator
  const REC = String.fromCharCode(0x1e); // record-separator

  // %(objecttype) is "tag" for an annotated tag object, "commit" for a
  // lightweight tag (the ref points straight at the commit).
  // %(objectname) is the ref's own object hash — for an annotated tag this
  // is the TAG object's hash, not the commit it points at, so we also
  // fetch %(*objectname) (dereferenced) to get the actual target commit
  // hash for annotated tags. %(subject)/%(creatordate) do NOT need
  // dereferencing: git already resolves these to the tag object's own
  // message/tagger-date for annotated tags (that object IS what for-each-ref
  // is describing), and to the commit's own subject/committer-date for
  // lightweight tags (since the ref points straight at the commit). Using
  // the dereferenced (*-prefixed) form of subject/date would incorrectly
  // pull the *target commit's* message/date instead of the tag's own.
  const fmt =
    "%(refname:short)" + SEP +
    "%(objecttype)" + SEP +
    "%(objectname)" + SEP +
    "%(*objectname)" + SEP +
    "%(creatordate:iso-strict)" + SEP +
    "%(subject)" + REC;

  let raw;
  try {
    raw = gitExec(`for-each-ref --format=${q(fmt)} refs/tags`, repoDir);
  } catch (e) {
    // Distinguish "not a git repo" from other failures for a clearer message.
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git tag list failed: not a git repository."); }
    throw new Error(`git tag list failed: ${e.message.split("\n")[0]}`);
  }

  const tags = [];

  for (const record of raw.split(REC)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(SEP);
    if (parts.length < 6) continue;

    const name        = parts[0].trim();
    const isAnnotated  = parts[1].trim() === "tag";
    const plainHash    = parts[2].trim();
    const derefHash    = parts[3].trim();
    const date         = parts[4].trim();
    const message      = parts[5].trim();

    tags.push({
      name,
      hash:        isAnnotated ? (derefHash || plainHash) : plainHash,
      isAnnotated,
      date,
      message,
    });
  }

  // Most-recent-first, matching git_log/git_stash_list convention.
  tags.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return { count: tags.length, tags };
}

module.exports = { gitTagList };
