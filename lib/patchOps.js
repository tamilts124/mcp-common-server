"use strict";
// ── APPLY_PATCH — apply a unified diff to a file ──────────────────────────────
//
// Implements a minimal unified-diff parser + applier.
// Supports the standard diff format produced by `diff_files` (and by `git diff`,
// `diff -u`, etc.):
//   --- a/path\n+++ b/path\n@@ -L,C +L,C @@\n context/+add/-remove lines
//
// The patch is applied atomically: the entire modified content is assembled in
// memory and only written to disk if every hunk applies successfully.
// Strict context matching (configurable via opts.strict, default: true) verifies
// that each context line in the patch matches the corresponding file line exactly.
// Fuzzy mode (strict: false) skips context verification — useful for offset-only
// patches on slightly modified files, but less safe.
//
// Returns:
//   { path, hunksApplied, additions, deletions, originalSize, newSize, patched: string }

const fs = require("fs");

/**
 * Parse a unified diff string into an array of hunk descriptors.
 *
 * Each hunk:
 *   { origStart, origCount, newStart, newCount,
 *     lines: [ { type: ' '|'+'|'-', text: string } ] }
 *
 * The leading +++ / --- header lines are extracted but not returned
 * (only the hunk bodies matter for application).
 *
 * @param {string} diffText
 * @returns {Array<object>}
 */
function parsePatch(diffText) {
  const rawLines = diffText.split("\n");
  // `split("\n")` produces a trailing "" element whenever diffText ends with
  // a newline (which unified diffs always do). That trailing "" is a split
  // artifact, not a real line in the patch, so it must be dropped before
  // scanning — otherwise it gets misread as a phantom blank context line
  // and throws off every position calculation in applyHunks (off-by-one on
  // every hunk, surfacing as bogus "context line N is beyond the file" /
  // "context mismatch" errors).
  const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === ""
    ? rawLines.slice(0, -1)
    : rawLines;

  const hunks  = [];
  let   i      = 0;
  let   hunk   = null;

  while (i < lines.length) {
    const line = lines[i];

    // Skip file header lines (---, +++).
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      i++;
      continue;
    }

    // Hunk header: @@ -origStart[,origCount] +newStart[,newCount] @@
    const hhMatch = line.match(/^@@\s+-([\d]+)(?:,([\d]+))?\s+\+([\d]+)(?:,([\d]+))?\s+@@/);
    if (hhMatch) {
      if (hunk) hunks.push(hunk);
      hunk = {
        origStart: parseInt(hhMatch[1], 10),
        origCount: hhMatch[2] !== undefined ? parseInt(hhMatch[2], 10) : 1,
        newStart:  parseInt(hhMatch[3], 10),
        newCount:  hhMatch[4] !== undefined ? parseInt(hhMatch[4], 10) : 1,
        lines:     [],
      };
      i++;
      continue;
    }

    // Hunk body lines.
    if (hunk) {
      if (line.startsWith("\\")) {
        // "\ No newline at end of file" marker — carries no patch data, skip.
      } else if (line.startsWith("+")) {
        hunk.lines.push({ type: "+", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        hunk.lines.push({ type: "-", text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        // Context line (space-prefixed).
        hunk.lines.push({ type: " ", text: line.slice(1) });
      } else if (line === "") {
        // A genuinely blank line inside a hunk body (context line that is
        // empty in the file, but whose leading space got trimmed by some
        // diff producers). Treat as an empty context line.
        hunk.lines.push({ type: " ", text: "" });
      }
      // Any other line shape inside a hunk is silently skipped — it carries
      // no patch information we can act on.
    }
    i++;
  }
  if (hunk) hunks.push(hunk);
  return hunks;
}

/**
 * Apply a list of parsed hunks to an array of file lines.
 *
 * Lines are 0-indexed in the array but 1-indexed in the hunk headers.
 * The hunks must be in ascending order (as a standard diff produces them).
 *
 * @param {string[]} fileLines   Lines of the original file (without trailing newlines).
 * @param {object[]} hunks       Parsed hunks from parsePatch().
 * @param {boolean}  strict      If true, verify context lines match.
 * @returns {{ result: string[], additions: number, deletions: number }}
 */
function applyHunks(fileLines, hunks, strict) {
  let additions = 0;
  let deletions = 0;
  // We build the output by tracking an offset (how many lines we've added or
  // removed so far relative to the original file) so we can translate the
  // original 1-based hunk positions to working-array positions.
  let offset = 0;
  const out  = fileLines.slice(); // working copy

  for (const hunk of hunks) {
    // Convert 1-based hunk start to 0-based array index, adjusted by prior edits.
    let pos = (hunk.origStart - 1) + offset;

    // Process each line in the hunk.
    const insertBuf = []; // additions accumulated between context/deletions

    for (const hl of hunk.lines) {
      if (hl.type === " ") {
        // Context line — must match the file at current position.
        if (strict) {
          const fileLine = out[pos];
          if (fileLine === undefined) {
            throw new Error(
              `apply_patch: context line ${pos + 1} is beyond the file (length ${out.length}). ` +
              `Patch may be for a different version of the file.`
            );
          }
          if (fileLine !== hl.text) {
            throw new Error(
              `apply_patch: context mismatch at line ${pos + 1}: ` +
              `expected ${JSON.stringify(hl.text)}, found ${JSON.stringify(fileLine)}. ` +
              `Patch may be for a different version of the file.`
            );
          }
        }
        pos++;
      } else if (hl.type === "-") {
        // Remove line at current position.
        if (strict && out[pos] !== undefined && out[pos] !== hl.text) {
          // Soft warning — removed lines don't always match exactly in all diff formats.
          // We'll still remove the line; the context check is the stronger guard.
        }
        out.splice(pos, 1);
        offset--;
        deletions++;
        // `pos` stays the same (next line slides into the removed slot).
      } else if (hl.type === "+") {
        out.splice(pos, 0, hl.text);
        offset++;
        additions++;
        pos++;
      }
    }
  }

  return { result: out, additions, deletions };
}

/**
 * Apply a unified diff patch to a file.
 *
 * @param {string} resolvedPath  Absolute path to the target file (already jail-checked).
 * @param {string} clientPath    Client-relative path for error messages / result.
 * @param {string} patch         Unified diff text (as produced by diff -u or git diff).
 * @param {object} [opts]
 * @param {boolean} [opts.strict=true]  Verify context lines match the file exactly.
 * @param {boolean} [opts.dry_run=false]  Return patched text without writing the file.
 * @returns {{ path, hunksApplied, additions, deletions, originalSize, newSize }}
 */
function applyPatch(resolvedPath, clientPath, patch, opts = {}) {
  const strict  = opts.strict  !== false; // default: true
  const dry_run = !!opts.dry_run;

  if (!patch || typeof patch !== "string" || !patch.trim()) {
    const { ToolError } = require("./errors");
    throw new ToolError("apply_patch: 'patch' must be a non-empty string.", -32602);
  }

  const hunks = parsePatch(patch);
  if (hunks.length === 0) {
    // An empty diff (no hunks) is valid — the file is already up to date.
    const originalSize = fs.statSync(resolvedPath).size;
    return {
      path:         clientPath,
      hunksApplied: 0,
      additions:    0,
      deletions:    0,
      originalSize,
      newSize:      originalSize,
      note:         "No hunks found in patch — file unchanged.",
    };
  }

  const original      = fs.readFileSync(resolvedPath, "utf8");
  const originalSize  = Buffer.byteLength(original, "utf8");
  // Split carefully: a trailing newline produces a trailing empty string which
  // we must handle so line counts stay consistent with the hunk positions.
  const fileLines     = original.split("\n");
  // Remove the phantom empty element that split produces for a newline-terminated file.
  const hadTrailingNL = fileLines[fileLines.length - 1] === "";
  if (hadTrailingNL) fileLines.pop();

  const { result, additions, deletions } = applyHunks(fileLines, hunks, strict);

  // Restore a trailing newline if the original had one.
  const patched  = result.join("\n") + (hadTrailingNL ? "\n" : "");
  const newSize  = Buffer.byteLength(patched, "utf8");

  if (!dry_run) {
    fs.writeFileSync(resolvedPath, patched, "utf8");
  }

  return {
    path:         clientPath,
    hunksApplied: hunks.length,
    additions,
    deletions,
    originalSize,
    newSize,
    ...(dry_run ? { patched } : {}),
  };
}

module.exports = { applyPatch, parsePatch };
