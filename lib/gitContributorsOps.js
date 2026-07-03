"use strict";
// ── GIT CONTRIBUTORS SUMMARY ────────────────────────────────────────────────
// git_contributors_summary — per-author rollup across a repo (or ref range):
// commit count, first/last commit date, lines inserted/deleted. Complements
// git_ownership (per-file blame aggregate, "who owns this code now") with a
// per-author activity view ("who has done how much, and since when").
//
// Implementation: a single `git log --numstat` call (one git process
// regardless of repo size or author count, same O(1)-process design as
// git_blame_hotspots) rather than one `git log --author=X` per author.
// --numstat after each commit's header line prints "<ins>\t<del>\t<path>"
// per changed file (or "-\t-\t<path>" for binary files, which we skip for
// the line-count totals but still tolerate parsing).
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

const DEFAULT_TOP_N = 50;
const HARD_MAX_TOP_N = 500;

// Unit separator (\x1f) as the field delimiter: commit subjects/author names
// can contain literally anything else (pipes, commas, quotes) but not this
// control character, so it can't be spoofed by repo content the way a
// printable delimiter could.
const FIELD_SEP = "\x1f";
const COMMIT_PREFIX = "C" + FIELD_SEP;

/**
 * Aggregate commit/line-change stats per author across a repo or ref range.
 *
 * @param {string} repoDir
 * @param {object} opts
 * @param {string} [opts.range]   Optional ref range/revision arg (e.g. 'HEAD~50..HEAD', 'main', a branch name). Defaults to all of HEAD's history.
 * @param {number} [opts.topN]    Max authors to return (1-500, default 50), sorted by commits desc.
 * @param {string} [opts.since]   Optional --since date filter (e.g. '90 days ago', '2025-01-01').
 * @returns {{
 *   range: string,
 *   authorsFound: number,
 *   truncated: boolean,
 *   totalCommits: number,
 *   authors: Array<{name: string, email: string, commits: number, insertions: number, deletions: number, firstCommit: string, lastCommit: string}>
 * }}
 */
function gitContributorsSummary(repoDir, opts = {}) {
  let topN = parseInt(opts.topN, 10);
  if (!Number.isFinite(topN) || topN < 1) topN = DEFAULT_TOP_N;
  topN = Math.min(Math.max(1, topN), HARD_MAX_TOP_N);

  const range = typeof opts.range === "string" && opts.range ? opts.range : null;
  if (range) assertSafeArg(range, "range");
  const since = typeof opts.since === "string" && opts.since ? opts.since : null;
  if (since) assertSafeArg(since, "since");

  const fmt = `${COMMIT_PREFIX}%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%ad`;
  let cmd = `log --numstat --date=iso-strict --format=${q(fmt)}`;
  if (since) cmd += ` --since=${q(since)}`;
  if (range) cmd += ` ${q(range)}`;

  let raw;
  try {
    raw = gitExec(cmd, repoDir);
  } catch (e) {
    const msg = e.message || "";
    // A freshly-initialized repo with zero commits ("does not have any
    // commits yet") is a valid, common state — not an error condition —
    // so it gets an empty rollup rather than a thrown error. Any other
    // git failure (not a repo, bad range, etc.) still surfaces normally.
    if (/does not have any commits yet/i.test(msg)) {
      return { range: range || "HEAD", authorsFound: 0, truncated: false, totalCommits: 0, authors: [] };
    }
    throw new Error(`git_contributors_summary: git log failed: ${msg.split("\n")[0]}`);
  }

  const byAuthor = new Map(); // key: `${name}\u0000${email}`
  let currentKey = null;
  let totalCommits = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;

    if (line.startsWith(COMMIT_PREFIX)) {
      const parts = line.split(FIELD_SEP);
      // parts[0] === "C", [1]=hash, [2]=name, [3]=email, [4]=date
      const [, , name, email, date] = parts;
      currentKey = `${name}\u0000${email}`;
      totalCommits++;
      let entry = byAuthor.get(currentKey);
      if (!entry) {
        entry = { name, email, commits: 0, insertions: 0, deletions: 0, firstCommit: date, lastCommit: date };
        byAuthor.set(currentKey, entry);
      }
      entry.commits++;
      // iso-strict dates sort correctly as plain strings.
      if (date < entry.firstCommit) entry.firstCommit = date;
      if (date > entry.lastCommit) entry.lastCommit = date;
      continue;
    }

    // numstat line: "<ins>\t<del>\t<path>" (binary files use "-" for both).
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (m && currentKey) {
      const entry = byAuthor.get(currentKey);
      if (m[1] !== "-") entry.insertions += parseInt(m[1], 10);
      if (m[2] !== "-") entry.deletions += parseInt(m[2], 10);
    }
  }

  const allAuthors = [...byAuthor.values()].sort(
    (a, b) => b.commits - a.commits || a.name.localeCompare(b.name)
  );
  const truncated = allAuthors.length > topN;
  const authors = allAuthors.slice(0, topN);

  return {
    range: range || "HEAD",
    authorsFound: allAuthors.length,
    truncated,
    totalCommits,
    authors,
  };
}

module.exports = { gitContributorsSummary };
