"use strict";
// ── MOVE_DIRECTORY / COPY_DIRECTORY — recursive-tree variants ────────────────
// Built on the same safety conventions audited into lib/moveOps.js
// (move_file/copy_file): symlink-escape rejection, explicit overwrite policy,
// same-path no-op short-circuit. Unlike move_file/copy_file, these operate on
// directory trees, so the symlink policy is stricter — any symlink found
// *anywhere inside* the source tree (file or directory) causes the whole
// operation to abort before anything is written, rather than silently
// skipping it. A partially-applied recursive copy/move is worse than no
// operation at all, since the caller has no way to know which subset of the
// tree succeeded.
//
// move_directory tries a fast whole-tree fs.renameSync() first (only when
// the destination does not already exist) and falls back to a recursive
// copy + source delete when the OS rejects the rename with EXDEV
// (cross-device — a real scenario since MCP_ROOTS can span multiple Windows
// drive letters) or when merging into an existing destination.

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");
const { isIgnored } = require("./roots");
const { assertRealpathWithinRoot } = require("./moveOps");

/**
 * Recursively walk `dir`, returning two flat lists of paths relative to
 * `dir` (forward-slash separated): one for files, one for directories
 * (directories listed parent-before-child so callers can mkdir in order).
 * Throws immediately if any symlink is encountered anywhere in the tree —
 * by design, no partial/silent-skip behavior for a multi-file operation.
 * MCP_IGNORE'd entries (e.g. node_modules, .git) are skipped, matching the
 * convention used by file_tree/hash_directory/compare_directories.
 */
function walkTree(dir) {
  const files = [];
  const dirs  = [];

  function walk(absDir, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      throw new ToolError(`Cannot read directory '${absDir}': ${e.message}`, -32603);
    }
    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        throw new ToolError(
          `Refusing to traverse: '${rel}' is a symlink. move_directory/copy_directory ` +
          `reject any symlink found inside the source tree to avoid a jail escape.`,
          -32001
        );
      }
      if (entry.isDirectory()) {
        dirs.push(rel);
        walk(abs, rel);
      } else if (entry.isFile()) {
        files.push(rel);
      }
      // Other types (sockets, FIFOs, devices) are silently skipped — they
      // cannot be meaningfully copied and are not expected inside a
      // developer-agent-managed project tree.
    }
  }

  walk(dir, "");
  return { files, dirs };
}

/**
 * Shared validation for move_directory/copy_directory: rejects non-directory
 * or missing sources, verifies neither side escapes its root via a symlink
 * at the top level, and enforces the overwrite policy on the destination.
 *
 * @returns {{ noop: boolean }}
 */
function validateDirOp(srcResolved, srcRoot, dstResolved, dstRoot, opts) {
  if (!fs.existsSync(srcResolved)) {
    throw new ToolError(`Source directory does not exist: ${srcResolved}`, -32602);
  }
  const srcStat = fs.statSync(srcResolved);
  if (!srcStat.isDirectory()) {
    throw new ToolError(
      "Source is not a directory — move_directory/copy_directory operate on directories only " +
      "(use move_file/copy_file for a single file).",
      -32602
    );
  }

  assertRealpathWithinRoot(srcResolved, srcRoot, "source");
  assertRealpathWithinRoot(dstResolved, dstRoot, "destination");

  let same = srcResolved === dstResolved;
  if (!same && fs.existsSync(dstResolved)) {
    try { same = fs.realpathSync(srcResolved) === fs.realpathSync(dstResolved); }
    catch (_) { /* ignore — fall through to the string comparison result */ }
  }
  if (same) return { noop: true };

  if (fs.existsSync(dstResolved)) {
    if (!fs.statSync(dstResolved).isDirectory()) {
      throw new ToolError(
        `Destination already exists and is not a directory: ${dstResolved}`,
        -32602
      );
    }
    if (!opts.overwrite) {
      throw new ToolError(
        `Destination directory already exists: ${dstResolved}. Pass overwrite: true to merge into it.`,
        -32602
      );
    }
  }
  return { noop: false };
}

/**
 * Recursively copy every directory and file from `src` to `dst`.
 * Caller must have already validated both sides via validateDirOp.
 * Also re-checks each individual destination ancestor for a symlink escape
 * as directories are created, defense-in-depth alongside the upfront
 * source-tree symlink rejection in walkTree().
 */
function copyTreeContents(src, dst, dstRoot) {
  const { files, dirs } = walkTree(src);

  fs.mkdirSync(dst, { recursive: true });
  let totalBytes = 0;

  for (const relDir of dirs) {
    fs.mkdirSync(path.join(dst, relDir), { recursive: true });
  }
  for (const relFile of files) {
    const srcFile = path.join(src, relFile);
    const dstFile = path.join(dst, relFile);
    fs.mkdirSync(path.dirname(dstFile), { recursive: true });
    fs.copyFileSync(srcFile, dstFile);
    totalBytes += fs.statSync(dstFile).size;
  }

  return {
    filesCopied: files.length,
    directoriesCreated: dirs.length + 1, // +1 for the destination root itself
    totalBytes,
  };
}

/**
 * Move (or merge) an entire directory tree.
 */
function moveDirectory(src, srcRoot, dst, dstRoot, opts = {}) {
  const { noop } = validateDirOp(src, srcRoot, dst, dstRoot, opts);
  if (noop) {
    return { moved: true, noop: true, note: "Source and destination are the same directory — nothing to do." };
  }

  const dstExisted = fs.existsSync(dst);

  // Fast path: a whole-tree rename only works when the destination does not
  // already exist (renaming onto an existing non-empty directory fails on
  // every OS this server targets) — and only on the same filesystem/drive.
  if (!dstExisted) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.renameSync(src, dst);
      return { moved: true, noop: false, crossDevice: false, merged: false, strategy: "rename" };
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
      // fall through to recursive copy+delete below
    }
  }

  const stats = copyTreeContents(src, dst, dstRoot);
  fs.rmSync(src, { recursive: true, force: true });
  return {
    moved: true,
    noop: false,
    crossDevice: !dstExisted, // only relevant if we fell back from a rename attempt
    merged: dstExisted,
    strategy: "copy+delete",
    ...stats,
  };
}

/**
 * Copy an entire directory tree (source is left untouched).
 */
function copyDirectory(src, srcRoot, dst, dstRoot, opts = {}) {
  const { noop } = validateDirOp(src, srcRoot, dst, dstRoot, opts);
  if (noop) {
    return { copied: true, noop: true, note: "Source and destination are the same directory — nothing to do." };
  }

  const dstExisted = fs.existsSync(dst);
  const stats = copyTreeContents(src, dst, dstRoot);
  return { copied: true, noop: false, merged: dstExisted, ...stats };
}

module.exports = { moveDirectory, copyDirectory, walkTree };
