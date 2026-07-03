"use strict";
// ── GIT_DIFF_SUMMARY — churn / PR-style summary over a git diff ───────────
// Wraps gitDiffStat's per-file numstat+name-status data and rolls it up
// into a higher-level summary: counts by change status, a breakdown by
// file extension, a top-churn file list, and a ready-to-paste markdown
// block — useful for agents drafting commit/PR descriptions without
// re-deriving this from the raw changedFiles array themselves.

const path = require("path");
const { gitDiffStat } = require("./gitDiffStatOps");

const STATUS_LABELS = { A: "added", M: "modified", D: "deleted", R: "renamed" };

function extOf(p) {
  const e = path.posix.extname(p);
  return e || "(no ext)";
}

/**
 * Build a churn/PR-style summary on top of gitDiffStat.
 * @param {string}      repoDir  Absolute path inside (or at) the git working tree.
 * @param {string|null} fromRef
 * @param {string|null} toRef
 * @param {string|null} filePath
 * @param {boolean}     staged
 * @param {object}      [opts]
 * @param {number}      [opts.topN]  Cap on topFiles entries (1-500, default 20).
 * @returns {{fromRef, toRef, staged, file, totalFiles, additions, deletions,
 *            byStatus, byExtension, topFiles, markdown}}
 */
function gitDiffSummary(repoDir, fromRef, toRef, filePath, staged, opts = {}) {
  const topN = Math.min(Math.max(1, Math.trunc(opts.topN ?? 20)), 500);
  const stat = gitDiffStat(repoDir, fromRef, toRef, filePath, staged);

  const byStatus = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  const extMap = new Map(); // ext -> {count, additions, deletions}

  for (const f of stat.changedFiles) {
    const label = STATUS_LABELS[f.status] || "modified";
    byStatus[label]++;
    const ext = extOf(f.path);
    const cur = extMap.get(ext) || { ext, count: 0, additions: 0, deletions: 0 };
    cur.count++;
    cur.additions += f.additions || 0;
    cur.deletions += f.deletions || 0;
    extMap.set(ext, cur);
  }

  const byExtension = [...extMap.values()].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));

  const topFiles = [...stat.changedFiles]
    .map(f => ({ ...f, churn: (f.additions || 0) + (f.deletions || 0) }))
    .sort((a, b) => b.churn - a.churn)
    .slice(0, topN);

  const mdLines = [];
  mdLines.push(`## Diff summary`);
  mdLines.push(``);
  mdLines.push(`${stat.changedFiles.length} file(s) changed, +${stat.additions}/-${stat.deletions}`);
  mdLines.push(``);
  const statusParts = Object.entries(byStatus).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  if (statusParts.length) mdLines.push(`- ${statusParts.join(", ")}`);
  for (const e of byExtension.slice(0, 10)) {
    mdLines.push(`- \`${e.ext}\`: ${e.count} file(s), +${e.additions}/-${e.deletions}`);
  }
  if (topFiles.length) {
    mdLines.push(``);
    mdLines.push(`### Top changed files`);
    for (const f of topFiles.slice(0, 10)) {
      mdLines.push(`- \`${f.path}\` (${STATUS_LABELS[f.status] || "modified"}, +${f.additions ?? "?"}/-${f.deletions ?? "?"})`);
    }
  }

  return {
    fromRef: stat.fromRef,
    toRef: stat.toRef,
    staged: stat.staged,
    file: stat.file,
    totalFiles: stat.changedFiles.length,
    additions: stat.additions,
    deletions: stat.deletions,
    byStatus,
    byExtension,
    topFiles,
    markdown: mdLines.join("\n"),
  };
}

module.exports = { gitDiffSummary };
