"use strict";
// ── FIND_TODO_OWNERS — TODO/FIXME/HACK/XXX/BUG marker → git-blame author ──
// Combines scan_todos (marker detection) with a per-line git blame lookup so
// each flagged comment can be attributed to the person who last touched that
// exact line, rather than just listing markers with no ownership signal.
//
// Design:
//   - Reuses scanTodosOps.js's scanTodos() unmodified for marker detection
//     (same MCP_IGNORE-aware walk, binary-skip heuristic, marker/extension
//     filtering conventions).
//   - For each match, runs a single-line `git blame -L <n>,<n> --porcelain`
//     (cheap — restricted to exactly one line, so porcelain always emits
//     exactly one full header block for that line, no multi-hash bookkeeping
//     needed unlike git_ownership's whole-file aggregate).
//   - Repo-root discovery reuses the shared, jail-bounded findRepoRoot()
//     helper (same convention as every other git_* tool).
//   - A marker whose line can't be blamed (uncommitted/untracked file, line
//     added after HEAD in a context git can't resolve, etc.) is recorded in
//     `unresolved` with a reason rather than aborting the whole scan.
//   - Bounded by max_markers (delegates to scan_todos' own maxMatches), since
//     each marker costs one extra git process spawn — kept modest by default.
const path = require("path");
const { gitExec, assertSafeArg, q, findRepoRoot } = require("./gitOpsHelpers");
const { scanTodos } = require("./scanTodosOps");

const DEFAULT_MAX_MARKERS = 200;
const HARD_MAX_MARKERS = 1000;

/**
 * Blame a single line of a tracked file, returning its author + date.
 * @returns {{ author: string, date: string }}
 */
function blameLine(relPath, line, repoRoot) {
  assertSafeArg(relPath, "file");
  if (!Number.isInteger(line) || line < 1) {
    throw new Error(`find_todo_owners: invalid line number ${line}.`);
  }
  const cmd = `blame -L ${line},${line} --porcelain -- ${q(relPath)}`;
  const raw = gitExec(cmd, repoRoot);
  let author = null;
  let date = null;
  for (const l of raw.split("\n")) {
    if (l.startsWith("author ") && !l.startsWith("author-")) {
      author = l.slice("author ".length);
    } else if (l.startsWith("author-time ")) {
      const ts = parseInt(l.slice("author-time ".length), 10);
      if (Number.isFinite(ts)) date = new Date(ts * 1000).toISOString();
    }
  }
  if (!author) throw new Error(`find_todo_owners: could not resolve blame author for '${relPath}':${line}.`);
  return { author, date };
}

/**
 * Scan for TODO-style markers and attribute each to its git-blame author.
 *
 * @param {string} absTarget    Absolute, already-jailed path to the file or
 *                                directory to scan.
 * @param {string} clientPath   Original client-relative path (for the result echo).
 * @param {boolean} isDirectory Whether absTarget is a directory.
 * @param {string} jailBoundary Absolute path of the MCP root absTarget was
 *                                resolved against. Repo-root discovery never
 *                                ascends above this (same convention as
 *                                git_ownership / every other git_* tool).
 * @param {object} opts
 * @param {string[]} [opts.markers]     Marker words (default TODO/FIXME/HACK/XXX/BUG).
 * @param {string[]} [opts.extensions]  Extension filter (directory mode).
 * @param {boolean}  [opts.caseSensitive]
 * @param {number}   [opts.maxMarkers]  Cap on markers processed (clamped 1..HARD_MAX_MARKERS, default 200).
 * @returns {{
 *   path: string,
 *   totalMarkers: number,
 *   resolvedCount: number,
 *   unresolvedCount: number,
 *   truncated: boolean,
 *   byAuthor: Array<{author: string, count: number, items: Array<{file, line, marker, text, date}>}>,
 *   unresolved: Array<{file, line, marker, reason}>
 * }}
 */
function findTodoOwners(absTarget, clientPath, isDirectory, jailBoundary, opts = {}) {
  const searchFrom = isDirectory ? absTarget : path.dirname(absTarget);
  const repoRoot = findRepoRoot(searchFrom, jailBoundary);
  if (!repoRoot) {
    throw new Error(`find_todo_owners: '${clientPath}' is not inside a git repository (no .git found).`);
  }

  let maxMarkers = parseInt(opts.maxMarkers, 10);
  if (!Number.isFinite(maxMarkers) || maxMarkers < 1) maxMarkers = DEFAULT_MAX_MARKERS;
  maxMarkers = Math.min(Math.max(1, maxMarkers), HARD_MAX_MARKERS);

  const scan = scanTodos(absTarget, clientPath, {
    markers:       opts.markers,
    extensions:    opts.extensions,
    caseSensitive: opts.caseSensitive,
    maxMatches:    maxMarkers,
  });

  // scanTodos' match.file is `${clientPath}/${relWithinScan}` for directory
  // scans (or just clientPath for single-file mode) — strip the clientPath
  // prefix to recover the path relative to absTarget, then resolve it
  // relative to the repo root for the git blame pathspec.
  const prefix = clientPath ? clientPath + "/" : "";

  const authorTotals = new Map();
  const unresolved = [];

  for (const m of scan.matches) {
    const relWithinScan = isDirectory && prefix && m.file.startsWith(prefix)
      ? m.file.slice(prefix.length)
      : (isDirectory ? m.file : "");
    const absFile = isDirectory ? path.join(absTarget, relWithinScan) : absTarget;
    const relToRepo = path.relative(repoRoot, absFile).split(path.sep).join("/");

    let blamed;
    try {
      blamed = blameLine(relToRepo, m.line, repoRoot);
    } catch (e) {
      unresolved.push({ file: m.file, line: m.line, marker: m.marker, reason: e.message.split("\n")[0] });
      continue;
    }

    if (!authorTotals.has(blamed.author)) authorTotals.set(blamed.author, []);
    authorTotals.get(blamed.author).push({ file: m.file, line: m.line, marker: m.marker, text: m.text, date: blamed.date });
  }

  const byAuthor = [...authorTotals.entries()]
    .map(([author, items]) => ({ author, count: items.length, items }))
    .sort((a, b) => b.count - a.count || a.author.localeCompare(b.author));

  return {
    path: clientPath,
    totalMarkers: scan.totalMatches,
    resolvedCount: scan.totalMatches - unresolved.length,
    unresolvedCount: unresolved.length,
    truncated: scan.truncated,
    byAuthor,
    unresolved,
  };
}

module.exports = { findTodoOwners };
