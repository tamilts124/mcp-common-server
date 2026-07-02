"use strict";
// ── SCAN_TODOS — recursive TODO/FIXME/HACK/XXX/BUG comment-marker scanner ──
// Zero-dependency dev-debt scanner: walks a file or directory (honouring the
// server's MCP_IGNORE patterns exactly like file_stats/dir_size_stats/
// file_tree), regex-matches a configurable set of marker words per line, and
// returns structured {file, line, marker, text} hits plus a per-marker
// summary count. Binary files are skipped via the same NUL-byte-in-first-8000
// -bytes heuristic used elsewhere in this project (see git_show).

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_MARKERS = ["TODO", "FIXME", "HACK", "XXX", "BUG"];

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function scanFileInto(absPath, relPath, markerRe, maxMatches, results) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) { return; }
  if (looksBinary(buf)) return;
  const lines = buf.toString("utf8").split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (results.length >= maxMatches) return;
    const m = markerRe.exec(lines[i]);
    if (m) {
      results.push({ file: relPath, line: i + 1, marker: m[1].toUpperCase(), text: lines[i].trim().slice(0, 400) });
    }
  }
}

/**
 * Scan a file or directory tree for TODO/FIXME/HACK-style comment markers.
 * @returns {{ path, filesScanned, totalMatches, truncated, byMarker, matches }}
 */
function scanTodos(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`scan_todos: cannot access '${origPath}': ${e.message}`, -32602); }

  const rawMarkers = (opts.markers && opts.markers.length ? opts.markers : DEFAULT_MARKERS)
    .map(m => String(m).trim()).filter(Boolean);
  if (rawMarkers.length === 0) throw new ToolError("scan_todos: 'markers' must not be an empty array.", -32602);
  const escaped = rawMarkers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const markerRe = new RegExp(`\\b(${escaped.join("|")})\\b`, opts.caseSensitive ? "" : "i");

  const maxMatches = Math.min(Math.max(1, Math.trunc(opts.maxMatches ?? 500)), 5000);
  const exts = opts.extensions?.length
    ? opts.extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())
    : null;

  const results = [];
  let filesScanned = 0;

  if (stat.isFile()) {
    filesScanned = 1;
    scanFileInto(absPath, origPath, markerRe, maxMatches, results);
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
          scanFileInto(full, origPath ? origPath + "/" + relPath : relPath, markerRe, maxMatches, results);
        }
      }
    })(absPath, "");
  } else {
    throw new ToolError(`scan_todos: '${origPath}' is neither a regular file nor a directory.`, -32602);
  }

  const byMarker = {};
  for (const r of results) byMarker[r.marker] = (byMarker[r.marker] || 0) + 1;

  return {
    path: origPath,
    filesScanned,
    totalMatches: results.length,
    truncated: results.length >= maxMatches,
    byMarker,
    matches: results,
  };
}

module.exports = { scanTodos };
