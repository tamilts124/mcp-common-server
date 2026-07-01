"use strict";
// ── GIT DIFF --stat MODE ────────────────────────────────────────────────────
// git_diff's stat_only extension: return per-file added/deleted line counts
// without the full unified-diff text, useful for a quick "what changed and
// how much" overview before pulling the full diff.
//
// Extracted to its own module (rather than growing lib/gitOps.js past the
// 500-line threshold) — gitOps.js's gitDiff() delegates here when
// opts.statOnly is true, using the exact same ref/staged/file selection
// logic so both modes stay behaviorally consistent.
//
// Design note: rename detection is explicitly disabled (--no-renames) for
// this mode only. `git diff --numstat`'s rename output format (e.g.
// "dir/{old => new}/file.txt" for a shared-prefix rename, or a bare
// "old => new" otherwise) has no single reliable delimiter to split back
// into distinct old/new paths, and getting that wrong would silently
// misreport file paths. Disabling renames guarantees every numstat/
// name-status line is a plain, unambiguous "<path>" — a rename then simply
// shows up as one D (old path) + one A (new path) entry instead of a single
// R entry, which is a deliberate, documented tradeoff for correctness over
// completeness in the summary view. (Full, non-stat_only git_diff calls are
// unaffected — this file is never invoked from that code path.)
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

/**
 * Build the ref/staged/file portion of a `git diff` command, shared by both
 * the --numstat and --name-status invocations so their file lists line up.
 */
function buildSelectorArgs(fromRef, toRef, filePath, staged) {
  let cmd = "";
  if (staged) cmd += " --cached";
  if (fromRef && toRef) cmd += ` ${q(fromRef)} ${q(toRef)}`;
  else if (fromRef) cmd += ` ${q(fromRef)}`;
  else if (!staged) cmd += " HEAD";
  if (filePath) cmd += ` -- ${q(filePath)}`;
  return cmd;
}

/**
 * Return a stat-only summary of the diff between two states in a git
 * repository: per-file added/deleted line counts and status, with no
 * unified diff text generated at all.
 *
 * @param {string}      repoDir   Absolute path inside (or at) the git working tree.
 * @param {string|null} fromRef   Optional: left-side ref/commit/branch (default HEAD).
 * @param {string|null} toRef     Optional: right-side ref/commit/branch.
 * @param {string|null} filePath  Optional: restrict to this file/dir path.
 * @param {boolean}     staged    When true and no refs given, diff index vs HEAD.
 * @returns {{
 *   fromRef: string,
 *   toRef: string|null,
 *   staged: boolean,
 *   file: string|null,
 *   statOnly: true,
 *   unified: null,
 *   additions: number,
 *   deletions: number,
 *   changedFiles: Array<{ status: string, path: string, additions: number|null, deletions: number|null }>
 * }}
 */
function gitDiffStat(repoDir, fromRef, toRef, filePath, staged) {
  if (fromRef) assertSafeArg(fromRef, "from_ref");
  if (toRef)   assertSafeArg(toRef,   "to_ref");
  if (filePath) assertSafeArg(filePath, "file");

  const selector = buildSelectorArgs(fromRef, toRef, filePath, staged);

  let numstatRaw, nameStatusRaw;
  try {
    numstatRaw    = gitExec(`diff --no-renames --numstat${selector}`, repoDir);
    nameStatusRaw = gitExec(`diff --no-renames --name-status${selector}`, repoDir);
  } catch (e) {
    throw new Error(`git diff (stat_only) failed: ${e.message.split("\n")[0]}`);
  }

  // Build a path -> single-letter-status map from --name-status. With
  // --no-renames every line is exactly "STATUS\tpath" (e.g. "A\tfoo.txt",
  // "M\tbar.txt", "D\tbaz.txt") — no third field to worry about.
  const statusByPath = new Map();
  for (const line of nameStatusRaw.split("\n")) {
    if (!line.trim()) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) continue;
    const status = line.slice(0, tabIdx).trim()[0] || "M";
    const path   = line.slice(tabIdx + 1).trim();
    statusByPath.set(path, status);
  }

  const changedFiles = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of numstatRaw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addRaw, delRaw, path] = parts;

    // Binary files report "-" for both counts instead of a number — must
    // not be coerced through Number()/parseInt() into NaN.
    const isBinary  = addRaw.trim() === "-" || delRaw.trim() === "-";
    const additions = isBinary ? null : parseInt(addRaw, 10) || 0;
    const deletions = isBinary ? null : parseInt(delRaw, 10) || 0;

    if (!isBinary) { totalAdditions += additions; totalDeletions += deletions; }

    changedFiles.push({
      status: statusByPath.get(path) || "M",
      path,
      additions,
      deletions,
    });
  }

  return {
    fromRef:      fromRef || (staged ? "HEAD (staged)" : "HEAD"),
    toRef:        toRef   || null,
    staged:       !!staged,
    file:         filePath || null,
    statOnly:     true,
    unified:      null,
    additions:    totalAdditions,
    deletions:    totalDeletions,
    changedFiles,
  };
}

module.exports = { gitDiffStat };
