"use strict";
// ── CHECK_DOTENV_FILES_NOT_GITIGNORED — secret-file exposure checker ──────
// Finds `.env`/`.env.<name>` files on disk (excluding `.example`/`.sample`/
// `.template`/`.dist` variants, which are meant to be committed) and cross-
// checks each against real git state:
//   - `dotenv_file_tracked_by_git` (error): the file is already committed
//     to the git index — its contents (likely real secrets) are exposed in
//     the repo, including to anyone who ever clones it, even after a later
//     `.gitignore` addition or `git rm`.
//   - `dotenv_file_not_gitignored` (warning): the file isn't tracked yet,
//     but no `.gitignore` rule covers it either — one `git add .` away from
//     being committed.
// A dotenv file that's both untracked AND gitignore-covered is safe and
// produces no finding.
//
// Uses real `git ls-files` (batched, one process for all candidates) and
// `git check-ignore -v --no-index` (one process per candidate, same
// convention as check_gitignore_coverage) via execFileSync — args passed as
// arrays, never through a shell, so no shell-injection surface exists
// regardless of file name/path content.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const GIT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FILES = 200;
const HARD_MAX_FILES = 500;
const DOTENV_RE = /^\.env(\..+)?$/i;
const EXAMPLE_SUFFIX_RE = /\.(example|sample|template|dist)$/i;

function collectDotenvFiles(absDir, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectDotenvFiles(abs, rel));
    else if (ent.isFile() && DOTENV_RE.test(ent.name)) out.push(rel);
  }
  return out;
}

// Batched `git ls-files -z -- <candidates...>`: returns the Set of
// candidates (relative paths, as given) that are currently tracked.
function trackedSet(repoDir, candidates) {
  if (candidates.length === 0) return new Set();
  let out;
  try {
    out = execFileSync(
      "git", ["ls-files", "-z", "--", ...candidates],
      { cwd: repoDir, timeout: GIT_TIMEOUT_MS, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    const stderr = (err.stderr || err.message || "").toString().trim();
    throw new ToolError(`check_dotenv_files_not_gitignored: git ls-files failed: ${stderr.slice(0, 300) || "unknown error"}`, -32603);
  }
  const tracked = (out || "").split("\0").filter(Boolean);
  // Normalize separators (git always emits forward slashes) for exact match.
  return new Set(tracked.map(p => p.replace(/\\/g, "/")));
}

// Single `git check-ignore -v --no-index -- <candidate>` call.
// Exit 0 = ignored, exit 1 = not ignored (expected, not an error).
function isIgnoredByGit(repoDir, candidate) {
  try {
    execFileSync(
      "git", ["check-ignore", "--no-index", "-q", "--", candidate],
      { cwd: repoDir, timeout: GIT_TIMEOUT_MS, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    const stderr = (err.stderr || err.message || "").toString().trim();
    throw new ToolError(`check_dotenv_files_not_gitignored: git check-ignore failed: ${stderr.slice(0, 300) || "unknown error"}`, -32603);
  }
}

/**
 * @param {string} repoDir  Absolute repo directory (already jail-resolved).
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {boolean} [opts.includeExamples] Also scan .example/.sample/.template/.dist variants (default false).
 * @param {number}  [opts.maxFiles] Cap on candidate dotenv files processed (1-500, default 200).
 * @returns {{path, filesScanned, filesSkippedAsExample, trackedCount, notIgnoredCount, findingsCount, errorCount, warningCount, truncated, dotenvFiles, findings}}
 */
function checkDotenvFilesNotGitignored(repoDir, origPath, opts = {}) {
  if (!repoDir)
    throw new ToolError("check_dotenv_files_not_gitignored: not inside a git repository.", -32602);
  if (!fs.existsSync(path.join(repoDir, ".git")))
    throw new ToolError(`check_dotenv_files_not_gitignored: '${origPath}' is not inside a git repository.`, -32602);

  if (opts.maxFiles !== undefined && typeof opts.maxFiles !== "number")
    throw new ToolError("check_dotenv_files_not_gitignored: max_files must be a number.", -32602);
  if (opts.includeExamples !== undefined && typeof opts.includeExamples !== "boolean")
    throw new ToolError("check_dotenv_files_not_gitignored: include_examples must be a boolean.", -32602);

  const maxFiles = Math.min(Math.max(1, Math.trunc(opts.maxFiles ?? DEFAULT_MAX_FILES)), HARD_MAX_FILES);
  const includeExamples = !!opts.includeExamples;

  const allFound = collectDotenvFiles(repoDir);
  let filesSkippedAsExample = 0;
  const candidates = allFound.filter(rel => {
    if (includeExamples) return true;
    const isExample = EXAMPLE_SUFFIX_RE.test(rel);
    if (isExample) filesSkippedAsExample++;
    return !isExample;
  });

  const truncated = candidates.length > maxFiles;
  const scanned = candidates.slice(0, maxFiles);

  const tracked = trackedSet(repoDir, scanned);
  const dotenvFiles = [];
  const findings = [];

  for (const rel of scanned) {
    const isTracked = tracked.has(rel);
    const ignored = isTracked ? null : isIgnoredByGit(repoDir, rel);
    dotenvFiles.push({ file: rel, tracked: isTracked, ignored });

    if (isTracked) {
      findings.push({
        file: rel, rule: "dotenv_file_tracked_by_git", severity: "error",
        message: `'${rel}' is tracked by git — its contents are already committed and visible to anyone with repo access, even after a later .gitignore rule or 'git rm'. Remove it from history (e.g. git filter-repo/BFG) and rotate any real secrets it contained.`,
      });
    } else if (!ignored) {
      findings.push({
        file: rel, rule: "dotenv_file_not_gitignored", severity: "warning",
        message: `'${rel}' is not tracked yet but no .gitignore rule covers it — one 'git add .' away from being committed. Add a matching rule (e.g. '.env*') to .gitignore.`,
      });
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file));
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: scanned.length,
    filesSkippedAsExample,
    trackedCount: dotenvFiles.filter(f => f.tracked).length,
    notIgnoredCount: dotenvFiles.filter(f => !f.tracked && !f.ignored).length,
    findingsCount: findings.length,
    errorCount,
    warningCount,
    truncated,
    dotenvFiles,
    findings,
  };
}

module.exports = { checkDotenvFilesNotGitignored };
