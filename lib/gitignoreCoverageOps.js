"use strict";
// ── GITIGNORE COVERAGE CHECKER ─────────────────────────────────────────────
// Uses real `git check-ignore -v --no-index` (execFileSync, no shell — args
// passed as an array, so no shell-injection surface exists regardless of
// path content) to determine whether candidate paths would be ignored by
// the repo's actual gitignore rule stack (.gitignore files at any level,
// .git/info/exclude, core.excludesFile), matching this project's existing
// convention of exercising real git state rather than reimplementing
// gitignore glob-matching semantics ourselves.
const { execFileSync } = require("child_process");
const { ToolError } = require("./errors");

const GIT_TIMEOUT_MS = 15_000;
const MAX_PATHS = 100;

// Representative candidate paths for common recommended-but-often-missed
// ignore targets. These are concrete paths (not raw glob patterns) since
// `git check-ignore` matches literal paths against the rule stack.
const DEFAULT_CHECK_PATHS = [
  "node_modules/example-pkg/index.js",
  ".env",
  ".env.local",
  ".DS_Store",
  "Thumbs.db",
  "npm-debug.log",
  "dist/bundle.js",
  "build/output.js",
  "debug.log",
  "coverage/lcov-report/index.html",
  ".vscode/settings.json",
  ".idea/workspace.xml",
  "backup.bak",
];

function validatePaths(paths) {
  if (paths === undefined || paths === null) return null;
  if (!Array.isArray(paths))
    throw new ToolError("check_gitignore_coverage: paths must be an array of strings.", -32602);
  if (paths.length === 0)
    throw new ToolError("check_gitignore_coverage: paths must not be empty when provided.", -32602);
  if (paths.length > MAX_PATHS)
    throw new ToolError(`check_gitignore_coverage: paths exceeds max of ${MAX_PATHS}.`, -32602);
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0)
      throw new ToolError("check_gitignore_coverage: every path must be a non-empty string.", -32602);
    if (p.length > 1024)
      throw new ToolError("check_gitignore_coverage: a path exceeds 1024 characters.", -32602);
    if (p.includes("\0"))
      throw new ToolError("check_gitignore_coverage: a path contains a null byte.", -32602);
  }
  return paths;
}

// Runs `git check-ignore -v --no-index -- <path>` for a single candidate.
// Exit code 0 = ignored (stdout has one "-v" formatted line to parse).
// Exit code 1 = not ignored (expected, not an error).
// Any other exit code (e.g. 128 for a real git error) is surfaced distinctly.
function checkOne(repoDir, candidate) {
  try {
    const out = execFileSync(
      "git",
      ["check-ignore", "-v", "--no-index", "--", candidate],
      { cwd: repoDir, timeout: GIT_TIMEOUT_MS, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    return parseIgnored(candidate, out);
  } catch (err) {
    if (err.status === 1) return { path: candidate, ignored: false };
    const stderr = (err.stderr || err.message || "").toString().trim();
    return { path: candidate, ignored: null, error: stderr.slice(0, 300) || "git check-ignore failed" };
  }
}

// -v output format: "<source>:<line>:<pattern>\t<path>" (tab-separated).
function parseIgnored(candidate, out) {
  const line = (out || "").split("\n").find(l => l.trim().length > 0) || "";
  const tabIdx = line.lastIndexOf("\t");
  const meta = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
  const parts = meta.split(":");
  const lineNum = parts.length >= 2 ? Number(parts[parts.length - 2]) : null;
  const pattern = parts.length >= 3 ? parts.slice(2).join(":") : (parts[parts.length - 1] || null);
  const source = parts.length >= 1 ? parts[0] : null;
  return {
    path: candidate,
    ignored: true,
    source: source || null,
    line: Number.isFinite(lineNum) ? lineNum : null,
    pattern: pattern || null,
  };
}

function checkGitignoreCoverage(repoDir, paths) {
  if (!repoDir)
    throw new ToolError("check_gitignore_coverage: not inside a git repository.", -32602);
  const validated = validatePaths(paths);
  const usingDefaults = validated === null;
  const candidates = usingDefaults ? DEFAULT_CHECK_PATHS : validated;

  const results = candidates.map(c => checkOne(repoDir, c));
  const ignoredCount = results.filter(r => r.ignored === true).length;
  const notIgnoredCount = results.filter(r => r.ignored === false).length;
  const errorCount = results.filter(r => r.ignored === null).length;

  const recommendations = usingDefaults
    ? results.filter(r => r.ignored === false).map(r =>
        `'${r.path}' is not ignored — consider adding a rule for it if this is unintentional.`)
    : [];

  return {
    usingDefaults,
    totalChecked: candidates.length,
    ignoredCount,
    notIgnoredCount,
    errorCount,
    results,
    recommendations,
  };
}

module.exports = { checkGitignoreCoverage, DEFAULT_CHECK_PATHS };
