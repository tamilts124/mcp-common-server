"use strict";
// ── GIT REFLOG OPERATIONS ────────────────────────────────────────────────────
// git_reflog — list reflog entries for a ref (default HEAD): every place
// that ref has pointed to recently, including commits no longer reachable
// from any branch (e.g. after a hard reset, an amend, or an interactive
// rebase) — information `git_log` alone cannot show, since git_log only
// walks the current ancestry graph.
//
// Read-only — does not require MCP_ALLOW_EXEC=true.
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

// ── GIT REFLOG ────────────────────────────────────────────────────────────────
/**
 * Return a structured list of reflog entries for `ref`, most recent first
 * (matching git's own reflog ordering).
 *
 * @param {string} repoDir  Absolute path inside (or at) the git working tree.
 * @param {string} [ref]    Ref whose reflog to read (default "HEAD"). Blank/
 *                          whitespace-only falls back to "HEAD", same
 *                          convention as git_show's `ref` handling.
 * @param {number} [limit]  Max entries to return (1-500, default 30).
 * @returns {{
 *   ref: string,
 *   count: number,
 *   entries: Array<{
 *     selector: string,   // e.g. "HEAD@{0}"
 *     hash: string,
 *     shortHash: string,
 *     action: string,     // reflog subject, e.g. "commit: fix bug" or "checkout: moving from main to feature"
 *     subject: string,    // the commit's own subject line (may differ from action for checkout/reset/etc.)
 *     author: string,
 *     email: string,
 *     date: string,       // ISO 8601
 *   }>
 * }}
 */
function gitReflog(repoDir, ref, limit) {
  const targetRef = (ref && ref.trim()) ? ref.trim() : "HEAD";
  assertSafeArg(targetRef, "ref");

  const n = Math.min(Math.max(1, parseInt(limit, 10) || 30), 500);

  const SEP = "\x1f"; // ASCII unit-separator
  const REC = "\x1e"; // ASCII record-separator

  // %gd = reflog selector (e.g. "HEAD@{0}"), %H/%h = full/short hash,
  // %gs = reflog subject (the action description git itself recorded —
  // "commit: ...", "checkout: moving from a to b", "reset: moving to ...",
  // "rebase (finish): ...", "pull: Fast-forward", etc.), %s = the commit's
  // own subject line (kept separately since it can differ meaningfully
  // from the reflog action, e.g. after a checkout or reset).
  const fmt = `%gd${SEP}%H${SEP}%h${SEP}%gs${SEP}%s${SEP}%an${SEP}%ae${SEP}%aI${REC}`;

  let raw;
  try {
    raw = gitExec(`log -g -n ${n} --format=${q(fmt)} ${q(targetRef)}`, repoDir);
  } catch (e) {
    // NOTE: classify against the *full* error message, not just its first
    // line -- execSync's thrown error message is "Command failed: <cmd>\n
    // <stderr>", so the actual git error text (e.g. "fatal: unknown
    // revision ...") is on a later line, not the first. Matching only the
    // first line (a prior bug here) meant this classification never fired
    // and unknown refs fell through to the generic "git reflog failed:
    // Command failed: ..." message instead of the intended, more useful
    // "unknown ref '<ref>'." message.
    const fullMsg = e.message || "";
    const firstLine = fullMsg.split("\n")[0];
    // An empty/never-updated reflog (e.g. a brand-new repo's very first
    // ref, or a ref that has no reflog entries yet) is a valid, empty
    // result, not an error -- but distinguish that from a genuinely
    // missing/invalid ref or a non-git directory, both of which should
    // still surface a clear error.
    if (/unknown revision|bad revision|ambiguous argument/i.test(fullMsg)) {
      try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
      catch (_) { throw new Error("git reflog failed: not a git repository."); }
      throw new Error(`git reflog failed: unknown ref '${targetRef}'.`);
    }
    if (/log for '.*' only has|does not have any commits yet|unborn/i.test(fullMsg)) {
      return { ref: targetRef, count: 0, entries: [] };
    }
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git reflog failed: not a git repository."); }
    throw new Error(`git reflog failed: ${firstLine}`);
  }

  const entries = [];
  for (const record of raw.split(REC)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(SEP);
    if (parts.length < 8) continue;
    entries.push({
      selector:  parts[0].trim(),
      hash:      parts[1].trim(),
      shortHash: parts[2].trim(),
      action:    parts[3].trim(),
      subject:   parts[4].trim(),
      author:    parts[5].trim(),
      email:     parts[6].trim(),
      date:      parts[7].trim(),
    });
  }

  return { ref: targetRef, count: entries.length, entries };
}

module.exports = { gitReflog };
