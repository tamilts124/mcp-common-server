"use strict";
// ── GIT SHARED HELPERS ─────────────────────────────────────────────────────
// Shared by gitOps.js (status/log/blame/diff) and gitStashOps.js (stash list).
// Extracted to avoid code duplication while keeping each file under 500 lines.
const { execSync } = require("child_process");

const GIT_TIMEOUT_MS = 15_000;

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

module.exports = { gitExec, gitExecBuffer, assertSafeArg, q };
