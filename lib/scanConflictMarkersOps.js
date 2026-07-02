"use strict";
// ── SCAN_CONFLICT_MARKERS — find unresolved git merge-conflict markers ─────
// Recursively walks a file or directory (same MCP_IGNORE-aware walk pattern
// as scan_todos) looking for the three standard git conflict marker lines:
//   <<<<<<< [label]      (start)
//   =======              (separator)
//   >>>>>>> [label]      (end)
// Useful as a post-patch/post-merge safety check for agents that apply
// patches (apply_patch, json_patch, yaml_patch, replace_in_file) — a leftover
// marker left in a file usually means a patch/merge did not resolve cleanly.
// Read-only, zero-dependency. Binary files skipped (NUL-byte heuristic, same
// as scan_todos/git_show).

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const START_RE = /^<{7}(?:\s.*)?$/;
const SEP_RE   = /^={7}$/;
const END_RE   = /^>{7}(?:\s.*)?$/;

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function scanFileInto(absPath, relPath, maxMatches, results) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) { return; }
  if (looksBinary(buf)) return;
  const lines = buf.toString("utf8").split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (results.length >= maxMatches) return;
    const line = lines[i];
    let markerType = null;
    if (START_RE.test(line)) markerType = "start";
    else if (SEP_RE.test(line)) markerType = "separator";
    else if (END_RE.test(line)) markerType = "end";
    if (markerType) {
      results.push({ file: relPath, line: i + 1, markerType, text: line.slice(0, 400) });
    }
  }
}

/**
 * Scan a file or directory tree for unresolved git conflict markers.
 * @returns {{ path, filesScanned, totalMatches, truncated, filesAffected, matches }}
 */
function scanConflictMarkers(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`scan_conflict_markers: cannot access '${origPath}': ${e.message}`, -32602); }

  const maxMatches = Math.min(Math.max(1, Math.trunc(opts.maxMatches ?? 500)), 5000);
  const exts = opts.extensions?.length
    ? opts.extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())
    : null;

  const results = [];
  let filesScanned = 0;

  if (stat.isFile()) {
    filesScanned = 1;
    scanFileInto(absPath, origPath, maxMatches, results);
  } else if (stat.isDirectory()) {
    (function walk(dir, relDir) {
      if (results.length >= maxMatches) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { return; }
      for (const ent of entries) {
        if (results.length >= maxMatches) return;
        if (isIgnored(ent.name)) continue;
        const relPath = relDir ? relDir + "/" + ent.name : ent.name;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full, relPath);
        } else if (ent.isFile()) {
          if (exts && !exts.includes(path.extname(ent.name).toLowerCase())) continue;
          filesScanned++;
          scanFileInto(full, origPath ? origPath + "/" + relPath : relPath, maxMatches, results);
        }
      }
    })(absPath, "");
  } else {
    throw new ToolError(`scan_conflict_markers: '${origPath}' is neither a regular file nor a directory.`, -32602);
  }

  const filesAffected = new Set(results.map(r => r.file)).size;

  return {
    path: origPath,
    filesScanned,
    totalMatches: results.length,
    truncated: results.length >= maxMatches,
    filesAffected,
    matches: results,
  };
}

module.exports = { scanConflictMarkers };
