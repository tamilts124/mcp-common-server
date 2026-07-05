"use strict";
// ── GIT_SUBMODULE_STATUS ─────────────────────────────────────────────────────
// Wraps `git submodule status` (porcelain-stable single-char-prefix format)
// plus a `.gitmodules` presence/parse pass, so an agent can tell at a glance
// which configured submodules are initialized, up to date, or diverged —
// without git's own status output (which uses easy-to-miss leading
// characters) being misread.
//
// Prefix meanings (from `git help submodule`):
//   ' '  initialized, checked out at the commit recorded in the superproject
//   '-'  not initialized (submodule not yet `git submodule update --init`'d)
//   '+'  checked out commit does not match the superproject's recorded commit
//   'U'  merge conflicts present in the submodule
const fs = require("fs");
const path = require("path");
const { gitExec } = require("./gitOpsHelpers");

const STATUS_MEANING = {
  " ": "in-sync",
  "-": "not-initialized",
  "+": "diverged",
  "U": "conflicted",
};

// One status line looks like:
//   <flag><sha1> <path> (<describe>)?
// flag is the single leading char (or absent -> ' ' for in-sync), sha1 is a
// 40-char hex, path may contain spaces so it's everything up to the optional
// trailing " (...)" describe suffix.
const LINE_RE = /^([ +\-U])?([0-9a-f]{40}) (.+?)(?: \((.+)\))?$/;

function parseGitmodules(raw) {
  // Minimal, purpose-built parser for the handful of fields this tool needs
  // ([submodule "name"] blocks with path/url/branch) — not a full git-config
  // parser, deliberately, since .gitmodules is INI-like but git-config's
  // real grammar (quoting, continuation lines, subsections) is much larger
  // than anything a .gitmodules file legitimately uses in practice.
  const entries = [];
  let current = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[submodule\s+"(.+)"\]$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1], path: null, url: null, branch: null };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1].toLowerCase();
    const value = kvMatch[2].trim();
    if (key === "path") current.path = value;
    else if (key === "url") current.url = value;
    else if (key === "branch") current.branch = value;
  }
  return entries;
}

/**
 * @param {string} repoDir Absolute path inside (or at) the git working tree.
 * @returns {{
 *   hasGitmodules: boolean,
 *   configuredCount: number,
 *   configured: Array<{name, path, url, branch}>,
 *   statusCount: number,
 *   submodules: Array<{path, sha, status, statusMeaning, describe}>,
 *   outOfSyncCount: number,
 * }}
 */
function gitSubmoduleStatus(repoDir) {
  const gitmodulesPath = path.join(repoDir, ".gitmodules");
  let hasGitmodules = false;
  let configured = [];
  try {
    hasGitmodules = fs.statSync(gitmodulesPath).isFile();
  } catch (_) { /* absent — not an error, just means no submodules configured */ }
  if (hasGitmodules) {
    let raw;
    try { raw = fs.readFileSync(gitmodulesPath, "utf8"); }
    catch (e) { throw new Error(`git_submodule_status: cannot read .gitmodules: ${e.message}`); }
    configured = parseGitmodules(raw);
  }

  let raw;
  try {
    raw = gitExec("submodule status", repoDir);
  } catch (e) {
    // Distinguish "not a git repo" from other failures for a clearer message.
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git_submodule_status: not a git repository."); }
    throw new Error(`git_submodule_status: git submodule status failed: ${e.message.split("\n")[0]}`);
  }

  const submodules = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(LINE_RE);
    if (!m) continue; // skip any line git_submodule_status can't confidently parse rather than guess
    const [, flagRaw, sha, subPath, describe] = m;
    const flag = flagRaw || " ";
    submodules.push({
      path: subPath,
      sha,
      status: flag,
      statusMeaning: STATUS_MEANING[flag] || "unknown",
      describe: describe || null,
    });
  }

  const outOfSyncCount = submodules.filter((s) => s.status !== " ").length;

  return {
    hasGitmodules,
    configuredCount: configured.length,
    configured,
    statusCount: submodules.length,
    submodules,
    outOfSyncCount,
  };
}

module.exports = { gitSubmoduleStatus };
