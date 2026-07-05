"use strict";
// ── FIND_RECENT_FORCE_PUSHES — detect history rewrites via local reflog ────
// Compares consecutive reflog entries for a ref (typically a remote-tracking
// ref such as `origin/main`, updated locally on every `fetch`/`pull`): if
// the older entry's commit is NOT an ancestor of the newer entry's commit
// (`git merge-base --is-ancestor <old> <new>` fails), that update rewrote
// history rather than fast-forwarding it — the signature of a force-push
// (or an equivalent history rewrite the local reflog happened to observe).
// This only sees rewrites the local reflog actually recorded (bounded by
// reflog expiry / entry count), not the full remote history — a real
// answer, not a full audit trail, but useful as a fast local-only warning
// signal before basing new work on a branch. Read-only beyond running git
// itself, consistent with every other git*Ops.js tool.

const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");
const { gitReflog } = require("./gitReflogOps");

const HASH_RE = /^[0-9a-f]{4,64}$/i;

function isAncestor(repoDir, ancestorHash, descendantHash) {
  try {
    gitExec(`merge-base --is-ancestor ${q(ancestorHash)} ${q(descendantHash)}`, repoDir);
    return true;
  } catch (e) {
    // Exit code 1 from `--is-ancestor` is a valid, expected "no" answer,
    // not a failure — only other exit codes / errors are real problems.
    if (e.status === 1) return false;
    throw e;
  }
}

/**
 * @param {string} repoDir  Absolute, jail-bounded repo root.
 * @param {string} [ref]    Ref whose reflog to scan (default "HEAD"; pass a
 *                          remote-tracking ref like "origin/main" for the
 *                          actual force-push-detection use case).
 * @param {number} [limit]  Max reflog entries to scan (1-500, default 30) —
 *                          passed straight through to gitReflog's own cap.
 * @returns {{ ref, entriesScanned, rewritesDetected,
 *             events: Array<{oldHash, oldShortHash, newHash, newShortHash, oldDate, newDate, action}> }}
 */
function findRecentForcePushes(repoDir, ref, limit) {
  const targetRef = (ref && ref.trim()) ? ref.trim() : "HEAD";
  assertSafeArg(targetRef, "ref");

  // Reuse gitReflog wholesale — same error classification (not-a-repo,
  // unknown ref, empty/unborn reflog), same limit clamping, same tested
  // parsing. No need to re-implement any of that here.
  const { entries } = gitReflog(repoDir, targetRef, limit);

  const events = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const newer = entries[i];     // reflog is newest-first
    const older = entries[i + 1];
    if (newer.hash === older.hash) continue; // no-op update, nothing to compare
    if (!HASH_RE.test(newer.hash) || !HASH_RE.test(older.hash)) continue; // defensive, shouldn't happen from git's own output

    let ancestor;
    try {
      ancestor = isAncestor(repoDir, older.hash, newer.hash);
    } catch (e) {
      // A hash reflog reported may already be gone (rare race with a
      // concurrent gc pruning an entry mid-scan) — skip that one pair
      // rather than aborting the whole scan; anything else rethrows.
      if (/bad revision|unknown revision|ambiguous argument|not a valid|no such object/i.test(e.message || "")) continue;

      throw e;
    }

    if (!ancestor) {
      events.push({
        oldHash:      older.hash,
        oldShortHash: older.shortHash,
        newHash:      newer.hash,
        newShortHash: newer.shortHash,
        oldDate:      older.date,
        newDate:      newer.date,
        action:       newer.action,
      });
    }
  }

  return {
    ref: targetRef,
    entriesScanned: entries.length,
    rewritesDetected: events.length,
    events,
  };
}

module.exports = { findRecentForcePushes };
