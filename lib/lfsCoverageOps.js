"use strict";
// ── CHECK_LFS_COVERAGE — are large tracked files actually covered by Git LFS? ──
// Complements find_large_git_objects (finds large blobs in history) by
// answering a different question: for files that ARE large, does the repo's
// .gitattributes actually route them through `filter=lfs`? A large file
// with no LFS rule is exactly the kind of accidental-big-commit find_large_
// git_objects flags after the fact — this tool catches it going forward,
// before the next commit.
//
// Uses real `git check-attr` (not a reimplemented gitattributes-pattern
// matcher) so results always match git's actual semantics, matching this
// project's existing convention (see gitignoreCoverageOps.js). Batched via
// `--stdin -z` (NUL-delimited both directions) rather than one process per
// candidate file — robust against any path content and far cheaper than
// spawning git once per file.

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const GIT_TIMEOUT_MS = 15_000;
const MAX_PATHS = 500;
const MAX_SCAN = 20000; // safety cap on tracked files enumerated via ls-files

function validatePaths(paths) {
  if (paths === undefined || paths === null) return null;
  if (!Array.isArray(paths))
    throw new ToolError("check_lfs_coverage: paths must be an array of strings.", -32602);
  if (paths.length === 0)
    throw new ToolError("check_lfs_coverage: paths must not be empty when provided.", -32602);
  if (paths.length > MAX_PATHS)
    throw new ToolError(`check_lfs_coverage: paths exceeds max of ${MAX_PATHS}.`, -32602);
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0)
      throw new ToolError("check_lfs_coverage: every path must be a non-empty string.", -32602);
    if (p.length > 1024)
      throw new ToolError("check_lfs_coverage: a path exceeds 1024 characters.", -32602);
    if (p.includes("\0"))
      throw new ToolError("check_lfs_coverage: a path contains a null byte.", -32602);
  }
  return paths;
}

// Batch-checks the `filter` attribute for every candidate in one process via
// `git check-attr --stdin -z filter`. Output with -z is a flat, repeating
// NUL-delimited triple: <path>\0<attribute>\0<value>\0 — no line-splitting
// ambiguity regardless of what characters appear in a path.
function batchCheckAttr(repoDir, candidates) {
  const result = spawnSync(
    "git", ["check-attr", "--stdin", "-z", "filter"],
    { cwd: repoDir, timeout: GIT_TIMEOUT_MS, encoding: "utf8", windowsHide: true,
      input: candidates.map(c => c + "\0").join(""), maxBuffer: 20 * 1024 * 1024 }
  );
  if (result.error)
    throw new ToolError(`check_lfs_coverage: git check-attr failed: ${result.error.message}`, -32603);
  const fields = (result.stdout || "").split("\0").filter(Boolean);
  const byPath = new Map();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [p, , value] = [fields[i], fields[i + 1], fields[i + 2]];
    byPath.set(p, value);
  }
  return candidates.map(c => {
    const value = byPath.has(c) ? byPath.get(c) : "unspecified";
    return { path: c, filterValue: value, lfsTracked: value === "lfs" };
  });
}

/**
 * Check whether large tracked files (or caller-supplied paths) are covered
 * by a `filter=lfs` .gitattributes rule.
 * @param {string}        repoDir
 * @param {string[]|null} paths           Explicit candidate paths (skips size scan).
 * @param {object}        [opts]
 * @param {number}        [opts.minSizeBytes]  Default-mode size threshold (default 5MB).
 * @param {number}        [opts.maxFiles]      Cap on candidates checked (1-2000, default 200).
 */
function checkLfsCoverage(repoDir, paths, opts = {}) {
  if (!repoDir)
    throw new ToolError("check_lfs_coverage: not inside a git repository.", -32602);
  const validated = validatePaths(paths);
  const usingDefaults = validated === null;
  const maxFiles = Math.min(Math.max(1, Math.trunc(opts.maxFiles ?? 200)), 2000);

  if (!usingDefaults) {
    const checked = batchCheckAttr(repoDir, validated);
    const notCovered = checked.filter(c => !c.lfsTracked);
    return {
      usingDefaults: false, minSizeBytes: null, totalTrackedScanned: null,
      candidatesOverThreshold: checked.length, checked,
      notCoveredCount: notCovered.length, recommendations: [],
    };
  }

  const minSizeBytes = Math.max(0, Math.trunc(opts.minSizeBytes ?? 5 * 1024 * 1024));

  let lsFilesOut;
  try {
    lsFilesOut = execFileSync("git", ["ls-files", "-z"],
      { cwd: repoDir, timeout: GIT_TIMEOUT_MS, encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    throw new ToolError(`check_lfs_coverage: git ls-files failed: ${(e.message || "").split("\n")[0]}`, -32603);
  }
  const tracked = lsFilesOut.split("\0").filter(Boolean).slice(0, MAX_SCAN);

  const sized = [];
  for (const rel of tracked) {
    try {
      const st = fs.statSync(path.join(repoDir, rel));
      if (st.isFile() && st.size >= minSizeBytes) sized.push({ path: rel, size: st.size });
    } catch (_) { /* submodule/missing/symlink target gone — skip, not an error */ }
  }
  sized.sort((a, b) => b.size - a.size);
  const candidates = sized.slice(0, maxFiles);

  const attrResults = candidates.length ? batchCheckAttr(repoDir, candidates.map(c => c.path)) : [];
  const attrByPath = new Map(attrResults.map(r => [r.path, r]));
  const checked = candidates.map(c => ({ ...c, ...attrByPath.get(c.path) }));
  const notCovered = checked.filter(c => !c.lfsTracked);

  const recommendations = notCovered.map(c =>
    `'${c.path}' (${c.size} bytes) is not covered by a filter=lfs rule — consider tracking it with Git LFS.`);

  return {
    usingDefaults: true,
    minSizeBytes,
    totalTrackedScanned: tracked.length,
    candidatesOverThreshold: sized.length,
    checked,
    notCoveredCount: notCovered.length,
    recommendations,
  };
}

module.exports = { checkLfsCoverage };
