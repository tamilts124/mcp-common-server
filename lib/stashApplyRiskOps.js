"use strict";
// ── CHECK_STASH_APPLY_RISK — will this stash apply cleanly? ────────────────
// Answers "would `git stash apply <stash>` conflict?" WITHOUT touching the
// working tree or the stash itself: extracts the stash's own diff via
// `git stash show -p` and validates it against the current working tree
// with `git apply --check` (a dry-run — no files written, index untouched).
// Read-only beyond running git itself, consistent with every other
// git*Ops.js tool. Complements merge_conflict_risk (branch-vs-branch) and
// git_stash_list (enumeration only, no risk signal) — neither answers
// "can I safely un-stash this right now".
const { spawnSync } = require("child_process");
const { gitExec } = require("./gitOpsHelpers");

const STASH_RE = /^stash@\{\d{1,4}\}$/;

/**
 * @param {string} repoDir   Absolute, jail-bounded repo root.
 * @param {string} [stashRef] Stash to check (default "stash@{0}"). Must
 *                             match the literal `stash@{N}` form git itself
 *                             produces — free-form refs are rejected rather
 *                             than passed through, since the value is later
 *                             used to build a `git stash show` argument.
 * @returns {{ stash, applyClean, conflictOutput: string|null }}
 */
function checkStashApplyRisk(repoDir, stashRef) {
  const target = (stashRef && stashRef.trim()) ? stashRef.trim() : "stash@{0}";
  if (!STASH_RE.test(target)) {
    throw new Error(`stash_apply_risk: stash must match 'stash@{N}' form, got '${target}'.`);
  }

  // Confirm we're in a repo, and that this specific stash entry exists,
  // before doing anything else — surfaces a clear, specific error instead
  // of a raw git failure from a later step.
  try {
    gitExec("rev-parse --is-inside-work-tree", repoDir);
  } catch (_) {
    throw new Error("stash_apply_risk: not a git repository.");
  }
  try {
    gitExec(`rev-parse --verify ${target}`, repoDir);
  } catch (_) {
    throw new Error(`stash_apply_risk: no such stash entry '${target}'.`);
  }

  // Extract the stash's own diff. --no-color guarantees clean plain-text
  // output that `git apply` can consume; a stash with no tracked changes
  // (e.g. untracked-only via `stash -u`) produces empty output, which is
  // trivially "clean" — nothing to apply, nothing to conflict.
  let diffText;
  try {
    diffText = gitExec(`stash show -p --no-color ${target}`, repoDir, 20 * 1024 * 1024);
  } catch (e) {
    throw new Error(`stash_apply_risk: failed to read stash diff: ${(e.message || "").split("\n")[0]}`);
  }

  if (!diffText.trim()) {
    return { stash: target, applyClean: true, conflictOutput: null };
  }

  // `git apply --check` is a pure dry-run: validates the patch would apply
  // to the current working tree without writing anything. Piped via stdin
  // (spawnSync, not a shell pipe) so patch content with any shell
  // metacharacters is never interpreted — Windows-safe, matches this
  // project's existing batch-check-via-stdin convention (see
  // lfsCoverageOps.js's `git check-attr --stdin`).
  const result = spawnSync("git", ["apply", "--check", "-"], {
    cwd: repoDir,
    input: diffText + "\n",
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });

  if (result.error) {
    throw new Error(`stash_apply_risk: git apply --check failed to run: ${result.error.message}`);
  }

  const applyClean = result.status === 0;
  return {
    stash: target,
    applyClean,
    conflictOutput: applyClean ? null : (result.stderr || "").trim() || (result.stdout || "").trim() || "git apply --check reported a non-zero exit with no output.",
  };
}

module.exports = { checkStashApplyRisk };
