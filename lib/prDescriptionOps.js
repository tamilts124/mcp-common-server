"use strict";
// ── GENERATE_PR_DESCRIPTION — auto-draft a markdown PR/commit description ──
// Combines gitDiffSummary (churn/file stats) with gitLog (commit list) to
// build a ready-to-paste markdown document, without adding any new git
// plumbing of its own. Read-only, git-scoped — mirrors git_diff_summary's
// resolveRepoDir usage in dispatchGit.js.

const { gitDiffSummary } = require("./gitDiffSummaryOps");
const { gitLog } = require("./gitLogOps");

/**
 * Build a markdown PR/commit description from a diff range plus commit log.
 * @param {string}      repoDir
 * @param {string|null} fromRef
 * @param {string|null} toRef
 * @param {boolean}     staged
 * @param {object}      [opts]
 * @param {number}      [opts.topN]        Cap on top-changed-files (1-500, default 10).
 * @param {number}      [opts.commitLimit] Cap on commits listed (1-200, default 20).
 * @returns {{fromRef, toRef, staged, totalFiles, additions, deletions,
 *            commitCount, commits: Array, markdown: string}}
 */
function generatePrDescription(repoDir, fromRef, toRef, staged, opts = {}) {
  const topN = Math.min(Math.max(1, Math.trunc(opts.topN ?? 10)), 500);
  const commitLimit = Math.min(Math.max(1, Math.trunc(opts.commitLimit ?? 20)), 200);

  const summary = gitDiffSummary(repoDir, fromRef, toRef, null, staged, { topN });

  // Commit list: a real ref range (fromRef given) walks fromRef..toRef (or
  // fromRef..HEAD); no fromRef (working-tree/staged mode) has no meaningful
  // commit range, so the log is simply the most recent commits on HEAD —
  // documented in the tool description rather than guessed at silently.
  let logResult;
  if (fromRef) {
    const range = `${fromRef}..${toRef || "HEAD"}`;
    logResult = gitLog(repoDir, commitLimit, null, range, false);
  } else {
    logResult = gitLog(repoDir, commitLimit, null, null, false);
  }
  const commits = logResult.commits.map(c => ({ shortHash: c.shortHash, subject: c.subject, author: c.author }));

  const statusParts = Object.entries(summary.byStatus).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  const oneLiner = summary.totalFiles === 0
    ? "No changes."
    : `${summary.totalFiles} file(s) changed (${statusParts.join(", ") || "no status data"}), +${summary.additions}/-${summary.deletions}.`;

  const md = [];
  md.push("## Summary", "", oneLiner, "");
  md.push("## Changes");
  for (const e of summary.byExtension.slice(0, 10)) {
    md.push(`- \`${e.ext}\`: ${e.count} file(s), +${e.additions}/-${e.deletions}`);
  }
  if (summary.topFiles.length) {
    md.push("", "### Top changed files");
    for (const f of summary.topFiles.slice(0, topN)) {
      md.push(`- \`${f.path}\` (+${f.additions ?? "?"}/-${f.deletions ?? "?"})`);
    }
  }
  md.push("", "## Commits");
  if (commits.length) {
    for (const c of commits) md.push(`- ${c.shortHash} ${c.subject} (${c.author})`);
  } else {
    md.push("_No commits in range._");
  }

  return {
    fromRef: summary.fromRef,
    toRef: summary.toRef,
    staged: summary.staged,
    totalFiles: summary.totalFiles,
    additions: summary.additions,
    deletions: summary.deletions,
    commitCount: commits.length,
    commits,
    markdown: md.join("\n"),
  };
}

module.exports = { generatePrDescription };
