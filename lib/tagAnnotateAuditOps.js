"use strict";
// ── GIT_TAG_ANNOTATE_AUDIT — flag tags that skip annotation/message hygiene ─
// Many release processes expect every release tag to be an *annotated* tag
// carrying a message (tagger name/date/message, its own object in the ODB)
// rather than a lightweight tag (a bare ref pointing straight at a commit,
// with no tagger metadata of its own). A plain `git tag -l` or even
// `git_tag_list` returns both kinds side-by-side with no hygiene signal —
// this tool is the fast "which of our tags don't meet that bar" check,
// composed directly on top of git_tag_list's already-tested for-each-ref
// parsing rather than re-implementing tag enumeration.
// Read-only — does not require MCP_ALLOW_EXEC=true.
const { gitTagList } = require("./gitTagOps");

/**
 * @param {string} repoDir  Absolute path inside (or at) the git working tree.
 * @returns {{
 *   totalTags: number,
 *   annotatedCount: number,
 *   lightweightCount: number,
 *   flaggedCount: number,
 *   tags: Array<{ name, hash, isAnnotated, message, flagged, reason: string|null }>
 * }}
 */
function gitTagAnnotateAudit(repoDir) {
  const { tags: rawTags } = gitTagList(repoDir);

  let annotatedCount = 0;
  let lightweightCount = 0;
  let flaggedCount = 0;

  const tags = rawTags.map(t => {
    if (t.isAnnotated) annotatedCount++;
    else lightweightCount++;

    let reason = null;
    if (!t.isAnnotated) {
      reason = "lightweight";
    } else if (!t.message || !t.message.trim()) {
      reason = "annotated-empty-message";
    }
    const flagged = reason !== null;
    if (flagged) flaggedCount++;

    return {
      name: t.name,
      hash: t.hash,
      isAnnotated: t.isAnnotated,
      message: t.message,
      flagged,
      reason,
    };
  });

  return {
    totalTags: tags.length,
    annotatedCount,
    lightweightCount,
    flaggedCount,
    tags,
  };
}

module.exports = { gitTagAnnotateAudit };
