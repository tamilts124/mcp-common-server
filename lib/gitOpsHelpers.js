"use strict";
// ── GIT SHARED HELPERS ─────────────────────────────────────────────────────
// Shared by gitOps.js (status/log/blame/diff) and gitStashOps.js (stash list).
// Extracted to avoid code duplication while keeping each file under 500 lines.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const GIT_TIMEOUT_MS = 15_000;
const MAX_WALK_UP = 64; // sane secondary cap; jailBoundary is the real stop condition

// Walk upward from `startDir` looking for a `.git` entry. Returns the
// absolute path of the directory containing it, or null if none is found.
//
// SECURITY: the walk never ascends above `jailBoundary` (inclusive) — this
// is the same MCP root directory resolveClientPath() already validated the
// target against. Without this cap, a target directory that isn't itself a
// git repo (or a subdirectory of one) would cause the walk to keep climbing
// past the sandbox root and could pick up a completely unrelated `.git`
// higher up the real filesystem (e.g. the user's home directory) — letting
// git commands run with a cwd, and therefore read access, outside the jail
// entirely. jailBoundary is required precisely to prevent that escape;
// MAX_WALK_UP is only a secondary belt-and-suspenders limit.
//
// This is the shared fix for the "cwd is a subdirectory, not the repo root"
// gap: every git_* tool historically ran gitExec() with cwd set directly to
// whatever directory resolveClientPath() resolved, relying on git's own
// upward .git-discovery bounded by GIT_CEILING_DIRECTORIES=dirname(cwd) —
// which only ever lets git look one level above cwd, so a target nested two
// or more levels inside a repo (with no .git in that immediate parent)
// would silently fail to discover the repo at all. findRepoRoot replaces
// that implicit, single-level discovery with an explicit, correctly-bounded
// walk any git_* tool can use before invoking gitExec.
function findRepoRoot(startDir, jailBoundary) {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (jailBoundary && dir === jailBoundary) break; // never ascend past the sandbox root
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

function gitExec(args, cwd) {
  const cmd = `git ${args}`;
  const parent = require("path").dirname(cwd);
  const out = execSync(cmd, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: parent,
    },
  });
  return (out || "").trimEnd();
}

// Same as gitExec, but returns the raw stdout as a Buffer (no encoding
// coercion, no trimEnd). Needed for git_show, where the file content being
// read may be arbitrary binary data — decoding it as utf8 first would
// corrupt or crash on non-text bytes before we even get a chance to detect
// that it's binary.
function gitExecBuffer(args, cwd) {
  const cmd = `git ${args}`;
  const parent = require("path").dirname(cwd);
  return execSync(cmd, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 50 * 1024 * 1024, // 50MB safety cap for large/binary blobs
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: parent,
    },
  });
}

function assertSafeArg(value, label) {
  if (typeof value !== "string")
    throw new Error(`git_ops: ${label} must be a string, got ${typeof value}.`);
  if (value.length > 4096)
    throw new Error(`git_ops: ${label} exceeds 4096 characters.`);
  if (/[\0`$"\\!|&;<>(){}\n\r]/.test(value))
    throw new Error(`git_ops: ${label} contains disallowed characters.`);
}

function q(s) { return `"${s}"`; }

module.exports = { gitExec, gitExecBuffer, assertSafeArg, q, findRepoRoot };
