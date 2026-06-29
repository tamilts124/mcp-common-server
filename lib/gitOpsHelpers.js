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

function assertSafeArg(value, label) {
  if (typeof value !== "string")
    throw new Error(`git_ops: ${label} must be a string, got ${typeof value}.`);
  if (value.length > 4096)
    throw new Error(`git_ops: ${label} exceeds 4096 characters.`);
  if (/[\0`$"\\!|&;<>(){}\n\r]/.test(value))
    throw new Error(`git_ops: ${label} contains disallowed characters.`);
}

function q(s) { return `"${s}"`; }

module.exports = { gitExec, assertSafeArg, q };
