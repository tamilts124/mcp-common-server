"use strict";
// ── COUNT_LINES ──────────────────────────────────────────────────────────────
// count_lines — count lines, words, and bytes in one or more files.
// Read-only, zero dependencies.

const fs   = require("fs");
const path = require("path");

/**
 * Count lines, words, and bytes for a single file.
 * Lines are newline-delimited (\n or \r\n).
 * Words are whitespace-separated tokens.
 *
 * @param {string} absPath Absolute path (already jail-validated by caller).
 * @returns {{ lines: number, words: number, bytes: number }}
 */
function countSingleFile(absPath) {
  const buf = fs.readFileSync(absPath);
  const bytes = buf.length;

  // Count lines: occurrences of \n  (handles \r\n too since \n is still there)
  let lines = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) lines++; // 0x0a === '\n'
  }
  // A file with content but no trailing newline still has at least 1 line
  if (bytes > 0 && buf[buf.length - 1] !== 0x0a) lines++;

  // Count words: split the UTF-8 text on whitespace
  const words = buf.length === 0
    ? 0
    : buf.toString("utf8").trim().split(/\s+/).filter(Boolean).length;

  return { lines, words, bytes };
}

/**
 * Count lines/words/bytes for one or more files.
 *
 * @param {string[]} absPaths  Absolute file paths (already jail-validated).
 * @param {string[]} origPaths Original client-relative paths for echoing back.
 * @returns {{
 *   files: Array<{ path: string, lines: number, words: number, bytes: number }>,
 *   total: { lines: number, words: number, bytes: number }
 * }}
 */
function countLines(absPaths, origPaths) {
  const files = [];
  let totalLines = 0, totalWords = 0, totalBytes = 0;

  for (let i = 0; i < absPaths.length; i++) {
    const abs  = absPaths[i];
    const orig = origPaths[i];

    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      throw new Error(`count_lines: cannot access '${orig}': ${e.message}`);
    }
    if (!stat.isFile()) {
      throw new Error(`count_lines: '${orig}' is not a regular file.`);
    }

    const { lines, words, bytes } = countSingleFile(abs);
    files.push({ path: orig, lines, words, bytes });
    totalLines += lines;
    totalWords += words;
    totalBytes += bytes;
  }

  return {
    files,
    total: { lines: totalLines, words: totalWords, bytes: totalBytes },
  };
}

module.exports = { countLines };
