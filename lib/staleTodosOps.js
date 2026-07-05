"use strict";
// ── FIND_STALE_TODOS — TODO/FIXME markers flagged by git-blame age ──
// Combines scan_todos (marker detection) with the same per-line git blame
// lookup as find_todo_owners, but groups by *age* instead of author: any
// marker whose blamed commit date is older than `threshold_days` is
// reported as stale (likely-abandoned), sorted oldest-first.
const path = require("path");
const { findRepoRoot } = require("./gitOpsHelpers");
const { scanTodos } = require("./scanTodosOps");
const { blameLine } = require("./todoOwnersOps");

const DEFAULT_MAX_MARKERS = 200;
const HARD_MAX_MARKERS = 1000;
const DEFAULT_THRESHOLD_DAYS = 90;

/**
 * @param {string} absTarget    Absolute, already-jailed path to scan.
 * @param {string} clientPath   Original client-relative path (result echo).
 * @param {boolean} isDirectory Whether absTarget is a directory.
 * @param {string} jailBoundary Root repo-discovery must not ascend above.
 * @param {object} opts
 * @param {number}   [opts.thresholdDays] Age cutoff in days (default 90, min 1).
 * @param {string[]} [opts.markers]
 * @param {string[]} [opts.extensions]
 * @param {boolean}  [opts.caseSensitive]
 * @param {number}   [opts.maxMarkers]
 * @returns {{path, thresholdDays, totalMarkers, staleCount, freshCount,
 *   unresolvedCount, truncated, stale: Array, unresolved: Array}}
 */
function findStaleTodos(absTarget, clientPath, isDirectory, jailBoundary, opts = {}) {
  const searchFrom = isDirectory ? absTarget : path.dirname(absTarget);
  const repoRoot = findRepoRoot(searchFrom, jailBoundary);
  if (!repoRoot) {
    throw new Error(`find_stale_todos: '${clientPath}' is not inside a git repository (no .git found).`);
  }

  if (opts.thresholdDays !== undefined && typeof opts.thresholdDays !== "number") {
    throw new Error("find_stale_todos: threshold_days must be a number.");
  }
  const thresholdDays = Math.max(1, Math.trunc(opts.thresholdDays ?? DEFAULT_THRESHOLD_DAYS));

  let maxMarkers = parseInt(opts.maxMarkers, 10);
  if (!Number.isFinite(maxMarkers) || maxMarkers < 1) maxMarkers = DEFAULT_MAX_MARKERS;
  maxMarkers = Math.min(Math.max(1, maxMarkers), HARD_MAX_MARKERS);

  const scan = scanTodos(absTarget, clientPath, {
    markers:       opts.markers,
    extensions:    opts.extensions,
    caseSensitive: opts.caseSensitive,
    maxMatches:    maxMarkers,
  });

  const prefix = clientPath ? clientPath + "/" : "";
  const now = Date.now();
  const cutoffMs = thresholdDays * 24 * 60 * 60 * 1000;

  const stale = [];
  const fresh = [];
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

    const ageDays = Math.floor((now - new Date(blamed.date).getTime()) / (24 * 60 * 60 * 1000));
    const entry = { file: m.file, line: m.line, marker: m.marker, text: m.text, author: blamed.author, date: blamed.date, ageDays };
    if (now - new Date(blamed.date).getTime() >= cutoffMs) stale.push(entry);
    else fresh.push(entry);
  }

  stale.sort((a, b) => b.ageDays - a.ageDays);

  return {
    path: clientPath,
    thresholdDays,
    totalMarkers: scan.totalMatches,
    staleCount: stale.length,
    freshCount: fresh.length,
    unresolvedCount: unresolved.length,
    truncated: scan.truncated,
    stale,
    unresolved,
  };
}

module.exports = { findStaleTodos };
