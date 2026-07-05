"use strict";
// ── GIT OWNERSHIP (BLAME-AGGREGATE) OPERATIONS ─────────────────────────────
// git_ownership — aggregate git-blame lines by author for a single file or
// an entire directory tree, to answer "who owns this code" queries.
//
// Design notes:
//   - Uses `git blame --porcelain` (NOT --line-porcelain). Porcelain format
//     only repeats the full header block (author/author-mail/etc.) the
//     FIRST time a given commit hash appears in the output; every
//     subsequent line attributed to that same commit is just the compact
//     "<hash> <origLine> <finalLine>" line followed directly by the
//     tab-prefixed content line. --line-porcelain repeats the full header
//     on every single line, which is unnecessary cost here since we only
//     need the author name per line, not the commit metadata or content.
//   - Directory mode uses `git ls-files -- <path>` to enumerate tracked
//     files (naturally respects .gitignore and skips untracked/build
//     artifacts) rather than a raw filesystem walk.
//   - Repo-root discovery: gitOpsHelpers.gitExec sets GIT_CEILING_DIRECTORIES
//     to the *parent* of whatever cwd it's given, so that git's own upward
//     .git-discovery can't wander outside the intended sandbox. That's the
//     right safety net when cwd is already the repo root (every other
//     git_* tool's convention) — but this tool lets the caller point at an
//     arbitrary subdirectory, and if that subdirectory's immediate parent
//     is exactly where .git lives, the ceiling blocks git from ever
//     entering that parent, so it can't find the repo at all. To avoid
//     depending on that upward search + ceiling interaction, we resolve
//     the real repo root ourselves first (walking up looking for a `.git`
//     entry, capped at a sane depth) and always use THAT as the git cwd,
//     with all pathspecs given relative to it.
//   - A file that git blame fails on inside a *directory* scan (binary,
//     untracked, etc.) is recorded in filesSkipped with a reason rather
//     than aborting the whole aggregate. Single-file mode is the opposite:
//     the caller named exactly one file, so a blame failure there is
//     surfaced directly as an error rather than silently returning an
//     empty result.
//
// All functions are READ-ONLY and do not require MCP_ALLOW_EXEC=true
// (git itself is still required on PATH, same as every other git_* tool).
const path = require("path");
const { gitExec, assertSafeArg, q, findRepoRoot } = require("./gitOpsHelpers");

const DEFAULT_MAX_FILES = 100;
const HARD_MAX_FILES = 500;

// findRepoRoot (bounded upward .git discovery, capped at the jailed MCP
// root) now lives in lib/gitOpsHelpers.js as a shared helper — every other
// git_* tool's dispatch handler uses it too (see lib/dispatchRead.js). Kept
// imported under the same local name here so the rest of this file, and its
// doc comments below, don't need to change.

/**
 * Aggregate blame line counts by author for a single tracked file.
 *
 * @param {string} filePath  Path to the file, relative to repoDir.
 * @param {string} repoDir   Absolute path to the resolved repo root.
 * @returns {Map<string, number>} author name -> line count
 */
function blameAuthorCounts(filePath, repoDir, ref) {
  // ref is optional (working-tree blame, existing behavior) — when given,
  // blame that file's content as of that specific commit/ref instead,
  // letting callers compare ownership at two points in history without
  // ever checking anything out (git_blame_ownership_diff's use case).
  const cmd = ref
    ? `blame --porcelain ${q(ref)} -- ${q(filePath)}`
    : `blame --porcelain -- ${q(filePath)}`;
  let raw;
  try {
    raw = gitExec(cmd, repoDir);
  } catch (e) {
    throw new Error(`git blame failed for '${filePath}'${ref ? ` at '${ref}'` : ""}: ${e.message.split("\n")[0]}`);
  }

  const counts = new Map();
  const hashAuthor = new Map();
  let currentHash = null;

  for (const l of raw.split("\n")) {
    if (!l) continue;

    // Every blamed line starts with a header of this shape — either the
    // full form (new hash, optionally followed by a group-line count) or
    // the compact reused-hash form. Either way this regex captures the hash.
    const headerMatch = l.match(/^([0-9a-f]{40}) \d+ \d+(?:\s+\d+)?$/);
    if (headerMatch) {
      currentHash = headerMatch[1];
      continue;
    }

    if (currentHash && l.startsWith("author ") && !l.startsWith("author-")) {
      hashAuthor.set(currentHash, l.slice("author ".length));
      continue;
    }

    if (l.startsWith("\t")) {
      // Content line — completes this entry, attribute it to currentHash.
      if (currentHash) {
        const author = hashAuthor.get(currentHash) || "(unknown)";
        counts.set(author, (counts.get(author) || 0) + 1);
      }
      continue;
    }
    // Other header lines (author-mail, author-time, committer*, summary,
    // previous, filename, boundary) are irrelevant to line-count aggregation.
  }

  return counts;
}

/**
 * Aggregate blame lines by author across a single file or a directory tree.
 *
 * @param {string} absTarget    Absolute, already-jailed path to the file or
 *                               directory to scan.
 * @param {string} clientPath   Original client-relative path (for the result echo).
 * @param {boolean} isDirectory Whether absTarget is a directory.
 * @param {string} jailBoundary Absolute path of the MCP root absTarget was
 *                               resolved against (from resolveClientPath).
 *                               Repo-root discovery never ascends above this.
 * @param {object} opts
 * @param {number} [opts.maxFiles]   Cap on number of files blamed in directory
 *                                    mode (clamped 1..HARD_MAX_FILES, default
 *                                    DEFAULT_MAX_FILES).
 * @param {string[]} [opts.extensions] Optional extension filter (directory mode).
 * @returns {{
 *   path: string,
 *   filesScanned: number,
 *   filesSkipped: Array<{path: string, reason: string}>,
 *   truncated: boolean,
 *   totalLines: number,
 *   authors: Array<{name: string, lines: number, percentage: number}>
 * }}
 */
function gitOwnership(absTarget, clientPath, isDirectory, jailBoundary, opts = {}) {
  const searchFrom = isDirectory ? absTarget : path.dirname(absTarget);
  const repoRoot = findRepoRoot(searchFrom, jailBoundary);
  if (!repoRoot) {
    throw new Error(`git_ownership: '${clientPath}' is not inside a git repository (no .git found).`);
  }

  const relToRepo = path.relative(repoRoot, absTarget).split(path.sep).join("/");

  let maxFiles = parseInt(opts.maxFiles, 10);
  if (!Number.isFinite(maxFiles) || maxFiles < 1) maxFiles = DEFAULT_MAX_FILES;
  maxFiles = Math.min(Math.max(1, maxFiles), HARD_MAX_FILES);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : null;

  let files;
  if (isDirectory) {
    const pathspec = relToRepo === "" ? "." : relToRepo;
    assertSafeArg(pathspec, "path");
    let lsOut;
    try {
      lsOut = gitExec(`ls-files -- ${q(pathspec)}`, repoRoot);
    } catch (e) {
      throw new Error(`git ls-files failed: ${e.message.split("\n")[0]}`);
    }
    files = lsOut ? lsOut.split("\n").filter(Boolean) : [];
    if (extensions) files = files.filter(f => extensions.some(ext => f.endsWith(ext)));
  } else {
    files = [relToRepo];
  }

  const truncated = files.length > maxFiles;
  const scanFiles = files.slice(0, maxFiles);

  const authorTotals = new Map();
  const filesSkipped = [];
  let filesScanned = 0;
  let totalLines = 0;

  for (const f of scanFiles) {
    let counts;
    if (isDirectory) {
      // Directory scan: don't let one unblameable file (binary, etc.)
      // abort the whole aggregate — record it and move on.
      try {
        counts = blameAuthorCounts(f, repoRoot);
      } catch (e) {
        filesSkipped.push({ path: f, reason: e.message.split("\n")[0] });
        continue;
      }
    } else {
      // Single-file mode: the caller named exactly this file, so a
      // failure here is the whole answer — surface it directly.
      counts = blameAuthorCounts(f, repoRoot);
    }
    filesScanned++;
    for (const [author, n] of counts) {
      authorTotals.set(author, (authorTotals.get(author) || 0) + n);
      totalLines += n;
    }
  }

  const authors = [...authorTotals.entries()]
    .map(([name, lines]) => ({
      name,
      lines,
      percentage: totalLines > 0 ? Math.round((lines / totalLines) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));

  return {
    path: clientPath,
    filesScanned,
    filesSkipped,
    truncated,
    totalLines,
    authors,
  };
}

module.exports = { gitOwnership, blameAuthorCounts, findRepoRoot };
