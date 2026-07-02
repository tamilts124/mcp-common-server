"use strict";
// ── WHICH COMMAND ────────────────────────────────────────────────────────────
// which_command — resolve an executable's full path(s) by searching
// process.env.PATH (honouring PATHEXT on Windows), zero-dependency.
// Read-only: only fs.statSync checks, never spawns anything, so it never
// requires MCP_ALLOW_EXEC (unlike run_command/start_process which actually
// execute the resolved binary).

const path = require("path");
const fs = require("fs");
const { ToolError } = require("./errors");

/**
 * @param {{command: string}} args
 * @returns {{command: string, platform: string, found: boolean, resolvedPath: string|null, allMatches: string[]}}
 */
function whichCommand(args) {
  const command = args && args.command;
  if (typeof command !== "string" || !command.trim())
    throw new ToolError("which_command requires a non-empty 'command' string.", -32602);
  // Bare executable name only — this is a PATH lookup, not a general file-
  // existence oracle for arbitrary paths (that's what file_info is for).
  if (/[\/\\]/.test(command))
    throw new ToolError(
      "which_command expects a bare executable name with no path separators (e.g. 'node', not './node' or '/usr/bin/node'); use file_info to check a specific path.",
      -32602,
    );

  const isWindows = process.platform === "win32";
  const pathEnv = process.env.PATH || process.env.Path || process.env.path || "";
  const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);

  let extsToTry;
  if (isWindows) {
    const pathext = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const lowerCmd = command.toLowerCase();
    const alreadyHasExt = pathext.some((e) => lowerCmd.endsWith(e.toLowerCase()));
    extsToTry = alreadyHasExt ? [""] : pathext;
  } else {
    extsToTry = [""];
  }

  const matches = [];
  // PATH commonly contains duplicate directories (e.g. both a user-scope and
  // system-scope entry pointing at the same install dir on Windows) — dedupe
  // by resolved path so allMatches reflects distinct binaries, not repeats.
  // Windows paths are case-insensitive, so normalize case for the dedupe key
  // there while still returning the on-disk-cased path in the results.
  const seen = new Set();
  for (const dir of pathDirs) {
    for (const ext of extsToTry) {
      const full = path.join(dir, command + ext);
      const dedupeKey = isWindows ? full.toLowerCase() : full;
      if (seen.has(dedupeKey)) continue;
      try {
        const st = fs.statSync(full);
        // POSIX: require at least one executable bit set. Windows has no
        // such concept via stat mode, so extension match is sufficient there.
        if (st.isFile() && (isWindows || (st.mode & 0o111) !== 0)) {
          matches.push(full);
          seen.add(dedupeKey);
        }
      } catch (_) {
        // Not found in this dir/ext combo — expected, keep scanning.
      }
    }
  }

  return {
    command,
    platform: process.platform,
    found: matches.length > 0,
    resolvedPath: matches[0] || null,
    allMatches: matches,
  };
}

module.exports = { whichCommand };
