"use strict";
// ── FILE_TREE ────────────────────────────────────────────────────────────────
// file_tree — pretty-print an ASCII directory tree, like the Unix `tree` command.
// Read-only, zero dependencies.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_FILES = 500; // stop growing the output when this many nodes accumulated

/**
 * Build an ASCII tree string for the given directory.
 *
 * @param {string}  baseDir   Absolute path (already jail-validated).
 * @param {string}  origPath  Client-relative path for the root label.
 * @param {object}  [opts]
 * @param {number}  [opts.depth]    Max depth to recurse (default 4, max 10).
 * @param {boolean} [opts.sizes]    Annotate file entries with their byte size.
 * @returns {{
 *   path: string, tree: string,
 *   dirCount: number, fileCount: number, truncated: boolean
 * }}
 */
function fileTree(baseDir, origPath, opts = {}) {
  const maxDepth = Math.min(Math.max(1, Math.trunc(opts.depth || DEFAULT_MAX_DEPTH)), 10);
  const showSizes = !!opts.sizes;

  let stat;
  try { stat = fs.statSync(baseDir); }
  catch (e) { throw new Error(`file_tree: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isDirectory())
    throw new Error(`file_tree: '${origPath}' is not a directory.`);

  let dirCount  = 0;
  let fileCount = 0;
  let truncated = false;
  const lines   = [];

  // Root label
  lines.push(origPath);

  function walk(dir, prefix, depth) {
    if (depth > maxDepth) return;
    if (lines.length >= DEFAULT_MAX_FILES + 1) { truncated = true; return; }

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { lines.push(`${prefix}[cannot read: ${e.message}]`); return; }

    // Sort: directories first, then files; alphabetically within each group
    entries.sort((a, b) => {
      const aIsDir = a.isDirectory();
      const bIsDir = b.isDirectory();
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Filter ignored entries
    const visible = entries.filter(e => !isIgnored(e.name));

    for (let i = 0; i < visible.length; i++) {
      if (lines.length >= DEFAULT_MAX_FILES + 1) { truncated = true; break; }
      const entry   = visible[i];
      const isLast  = i === visible.length - 1;
      const branch  = isLast ? "└── " : "├── ";
      const childPfx = isLast ? prefix + "    " : prefix + "│   ";

      if (entry.isDirectory()) {
        dirCount++;
        lines.push(`${prefix}${branch}${entry.name}/`);
        walk(path.join(dir, entry.name), childPfx, depth + 1);
      } else if (entry.isFile()) {
        fileCount++;
        let label = entry.name;
        if (showSizes) {
          try {
            const sz = fs.statSync(path.join(dir, entry.name)).size;
            label += ` (${sz}B)`;
          } catch (_) {}
        }
        lines.push(`${prefix}${branch}${label}`);
      }
    }
  }

  walk(baseDir, "", 1);

  const summary = truncated
    ? `\n${dirCount} directories, ${fileCount} files (output truncated at ${DEFAULT_MAX_FILES} nodes)`
    : `\n${dirCount} directories, ${fileCount} files`;

  return {
    path:      origPath,
    tree:      lines.join("\n") + summary,
    dirCount,
    fileCount,
    truncated,
  };
}

module.exports = { fileTree };
