"use strict";
// ── GIT_COMMIT_FREQUENCY — commits-per-day (+ per-author) activity histogram ──
// Complements git_blame_hotspots (author/commit count per FILE, no time
// bucketing) and git_file_age (per-file recency) with an activity-OVER-TIME
// view of the repo as a whole: a single `git log --since --format` call,
// bucketed client-side by UTC day. Answers "is this repo actively worked on,
// are there dead periods / release-crunch spikes, does one author dominate
// recent history (bus-factor)" without per-file cost.
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

const DEFAULT_SINCE_DAYS = 30;
const MAX_SINCE_DAYS = 3650;
const DEFAULT_TOP_AUTHORS = 10;
const MAX_TOP_AUTHORS = 200;
const SEP = "\x1f";

function clampInt(v, def, min, max) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = def;
  return Math.min(Math.max(n, min), max);
}

/**
 * @param {string} repoDir   Absolute repo directory (already jail/repo-root resolved).
 * @param {object} [opts]
 * @param {number} [opts.sinceDays]   Lookback window in days (1-3650, default 30).
 * @param {string}  [opts.ref]        Ref to walk (default "HEAD").
 * @param {number} [opts.topAuthors] Max authors in the byAuthor breakdown (1-200, default 10).
 * @returns {{
 *   ref: string, sinceDays: number, totalCommits: number,
 *   activeDays: number, daysInWindow: number,
 *   byDay: Array<{date: string, count: number}>,
 *   byAuthor: Array<{author: string, count: number, percentage: number}>,
 *   truncatedAuthors: boolean,
 * }}
 */
function gitCommitFrequency(repoDir, opts = {}) {
  const sinceDays = clampInt(opts.sinceDays, DEFAULT_SINCE_DAYS, 1, MAX_SINCE_DAYS);
  const topAuthors = clampInt(opts.topAuthors, DEFAULT_TOP_AUTHORS, 1, MAX_TOP_AUTHORS);
  const ref = (opts.ref && String(opts.ref).trim()) ? String(opts.ref).trim() : "HEAD";
  assertSafeArg(ref, "ref");

  let raw;
  try {
    raw = gitExec(
      `log --since="${sinceDays} days ago" --format=%ad${SEP}%an --date=short ${q(ref)}`,
      repoDir
    );
  } catch (e) {
    const fullMsg = e.message || "";
    if (/unknown revision|bad revision|ambiguous argument/i.test(fullMsg)) {
      try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
      catch (_) { throw new Error("git_commit_frequency: not a git repository."); }
      throw new Error(`git_commit_frequency: unknown ref '${ref}'.`);
    }
    if (/does not have any commits yet|unborn/i.test(fullMsg)) {
      return {
        ref, sinceDays, totalCommits: 0, activeDays: 0, daysInWindow: sinceDays,
        byDay: [], byAuthor: [], truncatedAuthors: false,
      };
    }
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git_commit_frequency: not a git repository."); }
    throw new Error(`git_commit_frequency: ${fullMsg.split("\n")[0]}`);
  }

  const byDay = new Map();    // "YYYY-MM-DD" -> count
  const byAuthor = new Map(); // author -> count
  let totalCommits = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(SEP);
    if (idx === -1) continue;
    const date = trimmed.slice(0, idx);
    const author = trimmed.slice(idx + 1);
    totalCommits++;
    byDay.set(date, (byDay.get(date) || 0) + 1);
    byAuthor.set(author, (byAuthor.get(author) || 0) + 1);
  }

  const byDayArr = [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let byAuthorArr = [...byAuthor.entries()]
    .map(([author, count]) => ({
      author,
      count,
      percentage: totalCommits ? Math.round((count / totalCommits) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.count - a.count || a.author.localeCompare(b.author));

  const truncatedAuthors = byAuthorArr.length > topAuthors;
  byAuthorArr = byAuthorArr.slice(0, topAuthors);

  return {
    ref,
    sinceDays,
    totalCommits,
    activeDays: byDayArr.length,
    daysInWindow: sinceDays,
    byDay: byDayArr,
    byAuthor: byAuthorArr,
    truncatedAuthors,
  };
}

module.exports = { gitCommitFrequency };
