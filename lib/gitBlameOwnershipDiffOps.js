"use strict";
// ── GIT_BLAME_OWNERSHIP_DIFF — did ownership shift between two refs? ───────
// Aggregates blame-line ownership (reusing gitOwnershipOps's tested
// per-author blame parser, at two different refs) for a single file, then
// diffs the two ownership snapshots — surfacing author share changes a
// plain `git_diff` (line-level, not attribution-level) or a single
// `git_ownership` call (one point in time only) don't show directly. E.g.
// a refactor that reformats a file wholesale can silently transfer
// majority ownership to whoever ran the reformatter, even though the
// "logic" is unchanged — this tool is the fast way to notice that.
// Read-only beyond running git itself, consistent with every other
// git*Ops.js tool.
const path = require("path");
const { blameAuthorCounts, findRepoRoot } = require("./gitOwnershipOps");
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

function toPercentMap(counts) {
  let total = 0;
  for (const n of counts.values()) total += n;
  const pct = new Map();
  for (const [author, n] of counts) {
    pct.set(author, total > 0 ? Math.round((n / total) * 10000) / 100 : 0);
  }
  return { total, pct };
}

/**
 * @param {string} absTarget    Absolute, already-jailed path to the file.
 * @param {string} clientPath   Original client-relative path (result echo).
 * @param {string} jailBoundary Absolute path of the MCP root absTarget was
 *                               resolved against — repo-root discovery
 *                               never ascends above this.
 * @param {string} refA         Older ref to compare from (e.g. a tag, an
 *                               earlier commit, "HEAD~20").
 * @param {string} refB         Newer ref to compare to (default "HEAD").
 * @returns {{
 *   path: string, refA: string, refB: string,
 *   ownershipA: Array<{name, lines, percentage}>,
 *   ownershipB: Array<{name, lines, percentage}>,
 *   shifts: Array<{name, percentageA, percentageB, delta}>,
 *   maxShiftAuthor: string|null, maxShiftDelta: number,
 * }}
 */
function gitBlameOwnershipDiff(absTarget, clientPath, jailBoundary, refA, refB) {
  const repoRoot = findRepoRoot(path.dirname(absTarget), jailBoundary);
  if (!repoRoot) {
    throw new Error(`git_blame_ownership_diff: '${clientPath}' is not inside a git repository (no .git found).`);
  }
  if (!refA || !refA.trim()) {
    throw new Error("git_blame_ownership_diff: 'ref_a' is required.");
  }
  const a = refA.trim();
  const b = (refB && refB.trim()) ? refB.trim() : "HEAD";
  assertSafeArg(a, "ref_a");
  assertSafeArg(b, "ref_b");

  const relToRepo = path.relative(repoRoot, absTarget).split(path.sep).join("/");

  // Confirm both refs resolve before doing any blame work, so a bad ref
  // surfaces one clear error instead of a raw blame failure.
  for (const [label, ref] of [["ref_a", a], ["ref_b", b]]) {
    try {
      gitExec(`rev-parse --verify ${q(ref)}`, repoRoot);
    } catch (_) {
      throw new Error(`git_blame_ownership_diff: unknown ${label} '${ref}'.`);
    }
  }

  const countsA = blameAuthorCounts(relToRepo, repoRoot, a);
  const countsB = blameAuthorCounts(relToRepo, repoRoot, b);

  const { total: totalA, pct: pctA } = toPercentMap(countsA);
  const { total: totalB, pct: pctB } = toPercentMap(countsB);

  const toArray = (counts, pct, total) => [...counts.entries()]
    .map(([name, lines]) => ({ name, lines, percentage: pct.get(name) || 0 }))
    .sort((x, y) => y.lines - x.lines || x.name.localeCompare(y.name));

  const allAuthors = new Set([...pctA.keys(), ...pctB.keys()]);
  const shifts = [...allAuthors]
    .map(name => {
      const percentageA = pctA.get(name) || 0;
      const percentageB = pctB.get(name) || 0;
      return { name, percentageA, percentageB, delta: Math.round((percentageB - percentageA) * 100) / 100 };
    })
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.name.localeCompare(y.name));

  const top = shifts[0] || null;

  return {
    path: clientPath,
    refA: a,
    refB: b,
    ownershipA: toArray(countsA, pctA, totalA),
    ownershipB: toArray(countsB, pctB, totalB),
    shifts,
    maxShiftAuthor: top ? top.name : null,
    maxShiftDelta: top ? top.delta : 0,
  };
}

module.exports = { gitBlameOwnershipDiff };
