"use strict";
// ── MOVE_FILE / COPY_FILE — audited cross-root/symlink/EXDEV-safe helpers ─────
//
// Audit findings fixed here (see task.md "audit move_file/copy_file" entry):
//
// (1) SYMLINK ESCAPE: resolveClientPath() only validates the *requested*
//     path string lexically (path.resolve, no symlink follow). If a symlink
//     living *inside* a jailed root pointed outside the root (e.g. a root
//     containing `evil -> /etc`), the old code would happily rename/copy
//     through it — fs.renameSync/copyFileSync follow symlinks on the
//     filesystem level, so content could leak out of (copy_file) or
//     overwrite a target through (move_file) a symlink the jail check never
//     saw. Fixed by realpath-checking the *parent directory* of both source
//     and destination (the file itself may not exist yet for destination,
//     so we resolve the nearest existing ancestor) and rejecting if the
//     real, symlink-resolved path falls outside the owning root.
//
// (2) EXDEV (cross-device move): fs.renameSync throws EXDEV when source and
//     destination are on different filesystems/drives (a real scenario here
//     — MCP_ROOTS can list roots on different Windows drive letters, e.g.
//     D:\proj1 and C:\proj2). The old code let this throw bubble up as a
//     raw, unfriendly Node error. Fixed with a copy+unlink fallback when
//     rename fails with code === "EXDEV".
//
// (3) OVERWRITE SAFETY: neither tool checked whether the destination already
//     existed — both silently clobbered it. Fixed with an explicit
//     `overwrite` option (default: false) that throws a clear ToolError
//     instead of silently destroying the existing destination file. This
//     mirrors create_file's existing "File already exists" convention.
//
// (4) DIRECTORY SOURCE: passing a directory as `source` used to surface a
//     raw OS-level error (EISDIR on copyFileSync, or a silent directory
//     rename on renameSync — which is *not* what a "move_file" caller
//     expects, since destination dir semantics differ subtly from file
//     semantics). Fixed with an explicit upfront isDirectory check and a
//     clear ToolError for both tools.
//
// (5) SAME-PATH NO-OP: moving/copying a path to itself (after path
//     resolution) is now explicitly short-circuited with a descriptive
//     result rather than relying on incidental OS behaviour (which differs
//     between rename-to-self, which Windows treats as a no-op, and
//     copy-to-self, which Windows actually permits as a same-file
//     truncate/overwrite that can corrupt the file mid-copy in rare cases).

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

/**
 * Resolve the nearest existing ancestor directory of `absPath` and return
 * its realpath (symlinks fully resolved). Used to detect a symlink jump
 * that resolveClientPath's lexical check cannot see, even for destination
 * paths whose final segment does not exist yet.
 */
function realpathOfNearestAncestor(absPath) {
  let dir = path.dirname(absPath);
  // Walk up until we find a directory that actually exists (handles
  // multi-level mkdir -p style destinations where no intermediate dir
  // exists yet).
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root, give up climbing
    dir = parent;
  }
  return fs.realpathSync(dir);
}

/**
 * Verify that `absPath` (file may or may not exist yet) — once symlinks in
 * its existing ancestry are resolved — still lands inside `rootAbs`.
 * Throws a ToolError (policy denial code) if a symlink escapes the jail.
 */
function assertRealpathWithinRoot(absPath, rootAbs, label) {
  const realRoot     = fs.realpathSync(rootAbs);
  const realAncestor = realpathOfNearestAncestor(absPath);
  const withSep       = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const ok = realAncestor === realRoot || realAncestor.startsWith(withSep);
  if (!ok) {
    throw new ToolError(
      `Access denied: ${label} path resolves outside its root through a symlink.`,
      -32001
    );
  }
  // If the target itself already exists (e.g. source file, or an existing
  // destination we're about to overwrite), also realpath-check it directly —
  // it could itself be a symlink pointing outside the jail even if its
  // parent directory is fine.
  if (fs.existsSync(absPath)) {
    const realTarget = fs.realpathSync(absPath);
    const okTarget = realTarget === realRoot || realTarget.startsWith(withSep);
    if (!okTarget) {
      throw new ToolError(
        `Access denied: ${label} is a symlink pointing outside its root.`,
        -32001
      );
    }
  }
}

/**
 * Shared validation for move_file/copy_file: rejects directory sources,
 * verifies neither side escapes its root via a symlink, and enforces the
 * overwrite policy on the destination.
 *
 * @returns {{ noop: boolean }}  noop=true means source and destination
 *   resolve to the literal same file — caller should skip the OS operation.
 */
function validateMoveOrCopy(srcResolved, srcRoot, dstResolved, dstRoot, opts) {
  if (!fs.existsSync(srcResolved)) {
    throw new ToolError(`Source does not exist: ${srcResolved}`, -32602);
  }
  const srcStat = fs.statSync(srcResolved);
  if (srcStat.isDirectory()) {
    throw new ToolError(
      "Source is a directory — move_file/copy_file operate on files only " +
      "(use create_directory / delete_directory / a recursive copy pipeline for directory trees).",
      -32602
    );
  }

  assertRealpathWithinRoot(srcResolved, srcRoot, "source");
  assertRealpathWithinRoot(dstResolved, dstRoot, "destination");

  // Same-file no-op: compare realpaths if both exist, else compare the
  // resolved absolute path strings directly (destination may not exist yet).
  let same = srcResolved === dstResolved;
  if (!same && fs.existsSync(dstResolved)) {
    try { same = fs.realpathSync(srcResolved) === fs.realpathSync(dstResolved); }
    catch (_) { /* ignore — fall through to the string comparison result */ }
  }
  if (same) return { noop: true };

  if (fs.existsSync(dstResolved) && !opts.overwrite) {
    throw new ToolError(
      `Destination already exists: ${dstResolved}. Pass overwrite: true to replace it.`,
      -32602
    );
  }
  return { noop: false };
}

/**
 * Move (rename) a file, with EXDEV (cross-device) fallback to copy+unlink.
 */
function moveFile(src, srcRoot, dst, dstRoot, opts = {}) {
  const { noop } = validateMoveOrCopy(src, srcRoot, dst, dstRoot, opts);
  if (noop) return { moved: true, noop: true, note: "Source and destination are the same file — nothing to do." };

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code === "EXDEV") {
      // Cross-device rename is not supported by the OS — fall back to a
      // copy followed by removing the original, which works across drives
      // (e.g. moving between two MCP_ROOTS on different Windows drive letters).
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
      return { moved: true, noop: false, crossDevice: true };
    }
    throw e;
  }
  return { moved: true, noop: false, crossDevice: false };
}

/**
 * Copy a file, with the same safety checks as moveFile (minus the unlink).
 */
function copyFile(src, srcRoot, dst, dstRoot, opts = {}) {
  const { noop } = validateMoveOrCopy(src, srcRoot, dst, dstRoot, opts);
  if (noop) return { copied: true, noop: true, note: "Source and destination are the same file — nothing to do." };

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return { copied: true, noop: false };
}

module.exports = { moveFile, copyFile, assertRealpathWithinRoot };
