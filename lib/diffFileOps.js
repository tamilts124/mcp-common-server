"use strict";
// ── DIFF FILES ───────────────────────────────────────────────────────────────
// diff_files — compute a unified diff between two text files inside the jail.
// Pure-JS LCS-based diff (no external dependencies).

const fs = require("fs");

/**
 * Compute a unified diff between two text files.
 * Uses a pure-JS LCS-based diff (no external dependencies).
 * Returns the diff as a unified-diff string plus structured summary.
 *
 * @param {string} aPath  Absolute path to the "old" file (left side).
 * @param {string} bPath  Absolute path to the "new" file (right side).
 * @param {string} [aLabel]  Display label for the old file (default: aPath).
 * @param {string} [bLabel]  Display label for the new file (default: bPath).
 * @param {number} [context]  Lines of context around each hunk (default: 3).
 * @returns {{
 *   unified: string,
 *   hunks: number,
 *   additions: number,
 *   deletions: number,
 *   identical: boolean
 * }}
 */
function diffFiles(aPath, bPath, aLabel, bLabel, context) {
  const ctx    = Math.max(0, parseInt(context) || 3);
  const aText  = fs.readFileSync(aPath, "utf8");
  const bText  = fs.readFileSync(bPath, "utf8");
  // Strip the single trailing empty element that split("\n") produces for
  // files ending with a newline (the most common case for text files). This
  // matches the behaviour of diff(1): "hello\n" is treated as one line, not
  // as ["hello", ""].  Files with no trailing newline keep their last element.
  const trimTrailing = (lines) =>
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  const aLines = trimTrailing(aText.split("\n"));
  const bLines = trimTrailing(bText.split("\n"));
  const labelA = aLabel || aPath;
  const labelB = bLabel || bPath;

  // ── Compute diff as sequence of edit operations ─────────────────────────
  // Each op: { type: "equal"|"insert"|"delete", aIdx, bIdx }
  // aIdx/bIdx are 0-based indices into aLines/bLines.
  const edits = computeEdits(aLines, bLines);

  if (edits.length === 0 || edits.every(e => e.type === "equal")) {
    return { unified: "", hunks: 0, additions: 0, deletions: 0, identical: true };
  }

  // ── Build unified diff hunks ─────────────────────────────────────────────
  // Strategy: mark each edit index as "changed" or "equal", then slide a
  // window of size (2*ctx+1) to group nearby changes into hunks.
  const n = edits.length;
  const inHunk = new Uint8Array(n); // 1 if this edit is inside any hunk

  // First pass: mark positions within `ctx` of any change
  for (let i = 0; i < n; i++) {
    if (edits[i].type !== "equal") {
      for (let j = Math.max(0, i - ctx); j <= Math.min(n - 1, i + ctx); j++) {
        inHunk[j] = 1;
      }
    }
  }

  const outputLines = [];
  let hunks = 0, additions = 0, deletions = 0;
  let i = 0;

  while (i < n) {
    if (!inHunk[i]) { i++; continue; }

    // Start of a hunk: collect the contiguous inHunk block
    const hunkEdits = [];
    while (i < n && inHunk[i]) {
      hunkEdits.push(edits[i]);
      i++;
    }

    // Calculate old/new start lines for the @@ header
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

  const header = `--- ${labelA}\n+++ ${labelB}\n`;
  return {
    unified:   header + outputLines.join("\n"),
    hunks,
    additions,
    deletions,
    identical: false,
  };
}

/**
 * Compute an edit sequence (LCS-based) between two string arrays.
 * Uses the classic O(N*M) dynamic-programming LCS algorithm and traces back
 * the edit operations. For very large files this may be slow, but for typical
 * source-code files (< 10k lines each) it is perfectly adequate.
 *
 * Returns Array<{ type: "equal"|"insert"|"delete", aIdx: number, bIdx: number }>.
 * Note: for "insert" ops aIdx is meaningless (set to -1); for "delete" ops
 * bIdx is meaningless (set to -1).
 */
function computeEdits(a, b) {
  const n = a.length, m = b.length;

  // Build the DP table. To save memory we only need two rows at a time,
  // but for backtracking we need the full table — we store it row-by-row.
  // Max reasonable table: 5000 * 5000 = 25M entries (200 MB as Uint16) —
  // cap both dimensions at 5000 to stay safe in all environments.
  const maxN = Math.min(n, 5000);
  const maxM = Math.min(m, 5000);

  // lcs[i][j] = length of LCS of a[0..i-1] and b[0..j-1]
  // Using a flat Uint16Array for efficiency
  const lcs = new Uint16Array((maxN + 1) * (maxM + 1));

  for (let i = 1; i <= maxN; i++) {
    for (let j = 1; j <= maxM; j++) {
      if (a[i - 1] === b[j - 1]) {
        lcs[i * (maxM + 1) + j] = lcs[(i - 1) * (maxM + 1) + (j - 1)] + 1;
      } else {
        const up   = lcs[(i - 1) * (maxM + 1) + j];
        const left = lcs[i * (maxM + 1) + (j - 1)];
        lcs[i * (maxM + 1) + j] = up > left ? up : left;
      }
    }
  }

  // Backtrack to reconstruct edits for the capped portions
  const edits = [];
  let i = maxN, j = maxM;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      edits.push({ type: "equal", aIdx: i - 1, bIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || lcs[(i) * (maxM + 1) + (j - 1)] >= lcs[(i - 1) * (maxM + 1) + j])) {
      edits.push({ type: "insert", aIdx: -1, bIdx: j - 1 });
      j--;
    } else {
      edits.push({ type: "delete", aIdx: i - 1, bIdx: -1 });
      i--;
    }
  }

  // Append any lines beyond the cap as bulk inserts/deletes
  for (let k = maxN; k < n; k++) edits.push({ type: "delete", aIdx: k, bIdx: -1 });
  for (let k = maxM; k < m; k++) edits.push({ type: "insert", aIdx: -1, bIdx: k });

  return edits.reverse();
}

module.exports = { diffFiles, computeEdits };
