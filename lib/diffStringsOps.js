"use strict";
// ── DIFF STRINGS ──────────────────────────────────────────────────────────────
// diff_strings — compute a unified or structured diff of two in-memory strings.
// Reuses the LCS-based computeEdits() from diffFileOps.js — same algorithm as
// diff_files, but accepts raw strings instead of file paths so callers can diff
// API responses, config values, generated output, etc. without touching the
// file system.
// Zero dependencies — pure Node.js built-ins (algorithm only; no I/O at all).

const { computeEdits } = require("./diffFileOps");

// Maximum byte-length of each input string (guards against runaway LCS table)
const MAX_INPUT_BYTES = 4 * 1024 * 1024; // 4 MB

/**
 * Diff two in-memory strings.
 *
 * @param {string}  a         "Old" / left-side string.
 * @param {string}  b         "New" / right-side string.
 * @param {object}  [opts]
 * @param {string}  [opts.label_a="a"]       Display label for the left side.
 * @param {string}  [opts.label_b="b"]       Display label for the right side.
 * @param {number}  [opts.context=3]         Lines of context around each hunk.
 * @param {string}  [opts.format="unified"]  Output format: "unified" or "json".
 * @returns {{ labelA, labelB, hunks, additions, deletions, identical, unified? | changes? }}
 */
function diffStrings(a, b, opts = {}) {
  if (typeof a !== "string") throw new TypeError("diff_strings: 'a' must be a string.");
  if (typeof b !== "string") throw new TypeError("diff_strings: 'b' must be a string.");

  const aBuf = Buffer.byteLength(a, "utf8");
  const bBuf = Buffer.byteLength(b, "utf8");
  if (aBuf > MAX_INPUT_BYTES)
    throw new RangeError(
      `diff_strings: 'a' exceeds ${MAX_INPUT_BYTES / 1024 / 1024} MB limit ` +
      `(got ${(aBuf / 1024 / 1024).toFixed(2)} MB).`
    );
  if (bBuf > MAX_INPUT_BYTES)
    throw new RangeError(
      `diff_strings: 'b' exceeds ${MAX_INPUT_BYTES / 1024 / 1024} MB limit ` +
      `(got ${(bBuf / 1024 / 1024).toFixed(2)} MB).`
    );

  const ctx    = Math.max(0, opts.context != null && opts.context !== "" ? Math.trunc(Number(opts.context)) : 3);
  const labelA = typeof opts.label_a === "string" ? opts.label_a : "a";
  const labelB = typeof opts.label_b === "string" ? opts.label_b : "b";
  const format = opts.format === "json" ? "json" : "unified";

  // Split into lines; strip the spurious trailing empty element that
  // split("\n") produces for strings ending with a newline.
  const trimTrailing = (arr) =>
    arr.length > 0 && arr[arr.length - 1] === "" ? arr.slice(0, -1) : arr;
  const aLines = trimTrailing(a.split("\n"));
  const bLines = trimTrailing(b.split("\n"));

  const edits     = computeEdits(aLines, bLines);
  const identical = edits.length === 0 || edits.every(e => e.type === "equal");

  if (identical) {
    const base = {
      labelA, labelB,
      hunks: 0, additions: 0, deletions: 0,
      identical: true,
      aLines: aLines.length,
      bLines: bLines.length,
    };
    return format === "json" ? { ...base, changes: [] } : { ...base, unified: "" };
  }

  // ── Mark which edit entries fall within a hunk window ────────────────────
  const n      = edits.length;
  const inHunk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (edits[i].type !== "equal") {
      const lo = Math.max(0, i - ctx);
      const hi = Math.min(n - 1, i + ctx);
      for (let j = lo; j <= hi; j++) inHunk[j] = 1;
    }
  }

  // ── JSON format ──────────────────────────────────────────────────────────
  if (format === "json") {
    const changes = [];
    let i = 0;
    while (i < n) {
      if (!inHunk[i]) { i++; continue; }
      const block = [];
      while (i < n && inHunk[i]) {
        const e = edits[i];
        if (e.type === "delete")
          block.push({ op: "-", text: aLines[e.aIdx], aLine: e.aIdx + 1 });
        else if (e.type === "insert")
          block.push({ op: "+", text: bLines[e.bIdx], bLine: e.bIdx + 1 });
        else
          block.push({ op: " ", text: aLines[e.aIdx], aLine: e.aIdx + 1, bLine: e.bIdx + 1 });
        i++;
      }
      changes.push(block);
    }
    let additions = 0, deletions = 0;
    for (const blk of changes)
      for (const l of blk) {
        if (l.op === "+") additions++;
        else if (l.op === "-") deletions++;
      }
    return {
      labelA, labelB,
      hunks: changes.length, additions, deletions,
      identical: false,
      aLines: aLines.length, bLines: bLines.length,
      changes,
    };
  }

  // ── Unified text format ──────────────────────────────────────────────────
  const outputLines = [];
  let hunks = 0, additions = 0, deletions = 0;
  let i = 0;
  while (i < n) {
    if (!inHunk[i]) { i++; continue; }

    const hunkEdits = [];
    while (i < n && inHunk[i]) { hunkEdits.push(edits[i]); i++; }

    let aStart = null, bStart = null, aCount = 0, bCount = 0;
    const hunkBody = [];

    for (const e of hunkEdits) {
      if (e.type === "equal" || e.type === "delete") {
        if (aStart === null) aStart = e.aIdx;
        aCount++;
      }
      if (e.type === "equal" || e.type === "insert") {
        if (bStart === null) bStart = e.bIdx;
        bCount++;
      }
      if (e.type === "delete") {
        hunkBody.push("-" + aLines[e.aIdx]);
        deletions++;
      } else if (e.type === "insert") {
        hunkBody.push("+" + bLines[e.bIdx]);
        additions++;
      } else {
        hunkBody.push(" " + aLines[e.aIdx]);
      }
    }

    const ah = `${(aStart ?? 0) + 1},${aCount}`;
    const bh = `${(bStart ?? 0) + 1},${bCount}`;
    outputLines.push(`@@ -${ah} +${bh} @@`);
    outputLines.push(...hunkBody);
    hunks++;
  }

  const header  = `--- ${labelA}\n+++ ${labelB}\n`;
  const unified = header + outputLines.join("\n");
  return {
    labelA, labelB,
    hunks, additions, deletions,
    identical: false,
    aLines: aLines.length, bLines: bLines.length,
    unified,
  };
}

module.exports = { diffStrings };
