"use strict";
// ── MERGE_CONFLICT_RISK — predict conflict risk between two branches ───────
// Finds the merge-base of two branches, then diffs each branch against that
// common ancestor to get its changed-file set. Files touched on *both*
// sides since diverging are the actual merge/rebase conflict candidates —
// git can silently auto-merge non-overlapping changes to the same file,
// but overlapping files are where a real conflict is likely (not
// guaranteed — line-level overlap within a file isn't checked, only
// file-level, which is a fast, useful first-pass signal without needing an
// actual trial merge).
//
// Reuses gitDiffStatOps.js's gitDiffStat() for both sides (two-dot diff
// from the merge-base to each branch tip) rather than adding new numstat
// parsing — mirrors generate_pr_description's "compose existing tools"
// approach.

const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");
const { gitDiffStat } = require("./gitDiffStatOps");

function toChurnMap(stat) {
  const map = new Map();
  for (const f of stat.changedFiles) {
    const churn = (f.additions || 0) + (f.deletions || 0);
    map.set(f.path, { status: f.status, additions: f.additions, deletions: f.deletions, churn });
  }
  return map;
}

function bucketRiskLevel(overlapCount, overlapRatio) {
  if (overlapCount === 0) return "none";
  if (overlapRatio < 0.1) return "low";
  if (overlapRatio < 0.3) return "medium";
  return "high";
}

/**
 * Predict merge/rebase conflict risk between two branches via changed-file
 * overlap since their merge-base.
 * @param {string} repoDir
 * @param {string} branchA
 * @param {string} branchB
 * @param {object} [opts]
 * @param {number} [opts.topN]  Cap on the overlapping-files list (1-500, default 50).
 * @returns {{branchA, branchB, mergeBase, filesChangedA, filesChangedB,
 *            overlappingCount, overlapRatio, riskLevel,
 *            overlapping: Array<{path, churnA, churnB, riskScore}>}}
 */
function predictMergeConflictRisk(repoDir, branchA, branchB, opts = {}) {
  assertSafeArg(branchA, "branchA");
  assertSafeArg(branchB, "branchB");
  const topN = Math.min(Math.max(1, Math.trunc(opts.topN ?? 50)), 500);

  let mergeBase;
  try {
    mergeBase = gitExec(`merge-base ${q(branchA)} ${q(branchB)}`, repoDir);
  } catch (e) {
    throw new Error(`merge_conflict_risk: git merge-base failed (no common ancestor, or unknown ref): ${e.message.split("\n")[0]}`);
  }
  if (!mergeBase) throw new Error("merge_conflict_risk: git merge-base returned no result.");

  const statA = gitDiffStat(repoDir, mergeBase, branchA, null, false);
  const statB = gitDiffStat(repoDir, mergeBase, branchB, null, false);
  const mapA = toChurnMap(statA);
  const mapB = toChurnMap(statB);

  const unionPaths = new Set([...mapA.keys(), ...mapB.keys()]);
  const overlapping = [];
  for (const p of mapA.keys()) {
    if (!mapB.has(p)) continue;
    const a = mapA.get(p), b = mapB.get(p);
    overlapping.push({ path: p, churnA: a.churn, churnB: b.churn, riskScore: a.churn + b.churn });
  }
  overlapping.sort((x, y) => y.riskScore - x.riskScore);

  const overlapRatio = unionPaths.size > 0 ? overlapping.length / unionPaths.size : 0;

  return {
    branchA, branchB, mergeBase,
    filesChangedA: mapA.size,
    filesChangedB: mapB.size,
    overlappingCount: overlapping.length,
    overlapRatio: Math.round(overlapRatio * 1000) / 1000,
    riskLevel: bucketRiskLevel(overlapping.length, overlapRatio),
    overlapping: overlapping.slice(0, topN),
  };
}

module.exports = { predictMergeConflictRisk };
