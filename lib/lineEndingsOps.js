"use strict";
// ── CHECK_LINE_ENDINGS — classify files as LF / CRLF / mixed / none ────────
// Recursively walks a file or directory (same MCP_IGNORE-aware walk pattern
// as scan_todos/scan_conflict_markers/scan_secrets) and, per text file,
// counts CRLF vs bare-LF line terminators. Mixed-line-ending files are
// surfaced individually — they're a common source of noisy git diffs and
// subtle bugs (e.g. a shell script with a stray CRLF line). Read-only,
// zero-dependency. Binary files skipped (NUL-byte heuristic, same as
// scan_todos/git_show).

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

// Classify one file's line endings by counting CRLF vs bare-LF terminators
// directly in the raw buffer (avoids String#split losing the distinction).
function classifyFile(absPath) {
  const buf = fs.readFileSync(absPath);
  if (looksBinary(buf)) return null;
  let crlf = 0, lf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) { // \n
      if (i > 0 && buf[i - 1] === 0x0d) crlf++; else lf++;
    }
  }
  let ending;
  if (crlf === 0 && lf === 0) ending = "none";
  else if (crlf > 0 && lf > 0) ending = "mixed";
  else if (crlf > 0) ending = "CRLF";
  else ending = "LF";
  return { ending, crlfCount: crlf, lfCount: lf };
}

/**
 * Scan a file or directory tree, classifying each text file's line endings.
 * @returns {{ path, filesScanned, binarySkipped, byEnding, mixedFiles }}
 */
function checkLineEndings(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`check_line_endings: cannot access '${origPath}': ${e.message}`, -32602); }

  const maxMixed = Math.min(Math.max(1, Math.trunc(opts.maxMixedFiles ?? 500)), 5000);
  const exts = opts.extensions?.length
    ? opts.extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())
    : null;

  const byEnding = { LF: 0, CRLF: 0, mixed: 0, none: 0 };
  const mixedFiles = [];
  let filesScanned = 0;
  let binarySkipped = 0;
  let mixedTruncated = false;

  function classifyInto(full, relPath) {
    filesScanned++;
    let result;
    try { result = classifyFile(full); }
    catch (e) { return; } // unreadable — skip silently, same as scan_todos
    if (!result) { binarySkipped++; return; }
    byEnding[result.ending]++;
    if (result.ending === "mixed") {
      if (mixedFiles.length < maxMixed) {
        mixedFiles.push({ file: relPath, lfCount: result.lfCount, crlfCount: result.crlfCount });
      } else {
        mixedTruncated = true;
      }
    }
  }

  if (stat.isFile()) {
    classifyInto(absPath, origPath);
  } else if (stat.isDirectory()) {
    (function walk(dir, relDir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { return; }
      for (const ent of entries) {
        if (isIgnored(ent.name)) continue;
        const relPath = relDir ? relDir + "/" + ent.name : ent.name;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full, relPath);
        } else if (ent.isFile()) {
          if (exts && !exts.includes(path.extname(ent.name).toLowerCase())) continue;
          classifyInto(full, origPath ? origPath + "/" + relPath : relPath);
        }
      }
    })(absPath, "");
  } else {
    throw new ToolError(`check_line_endings: '${origPath}' is neither a regular file nor a directory.`, -32602);
  }

  return {
    path: origPath,
    filesScanned,
    binarySkipped,
    byEnding,
    mixedTruncated,
    mixedFiles,
  };
}

module.exports = { checkLineEndings };
