"use strict";
// ── JSON_DIFF — structural (semantic) diff between two JSON/YAML documents ────
// Complement to diff_files (line-based text diff) and file_diff_dir (tree-level
// line diff): those compare TEXT, so reordering keys, changing indentation, or
// reformatting a document produces diff noise even when the actual data is
// unchanged. json_diff instead parses both sides into real JS values and
// recursively compares the DATA, reporting only genuine additions, removals,
// and value changes at their JSON-Pointer-style path (e.g. /a/b/0/name).
//
// Also a natural read-only counterpart to json_patch/yaml_patch/yaml_merge
// (which apply structured changes) — json_diff is how you'd discover what
// changed between two versions of a config/data file in the first place.
//
// Comparison semantics:
//   - Mappings/objects: compared key-by-key. A key present only on the left
//     is "removed"; present only on the right is "added"; present on both
//     with a different value is "changed" (recursed into if both sides are
//     objects/arrays, otherwise reported directly).
//   - Arrays: compared by INDEX POSITION, not by content/set (no LCS/edit-
//     distance matching — that's what diff_files is for on serialised text).
//     This means inserting an element at the front of an array will show
//     every subsequent element as "changed" rather than "added" — documented
//     behavior, not a bug. Extra trailing elements on either side are
//     reported as added/removed at their index path.
//   - Scalars (string/number/boolean/null): compared with `===` (null via
//     `Object.is`-safe equality — null === null is true in JS already).
//   - Type mismatches (e.g. left is an object, right is a scalar) are
//     reported as a single "changed" entry at that path, not recursed into.
//
// Safety:
//   - Documents are only ever JSON.parse'd or parsed by the existing
//     zero-dep lib/yamlOps.js parser — never eval'd.
//   - MAX_DEPTH guards recursion on deeply-nested/pathological documents.
//   - MAX_CHANGES caps the result array size; once hit, remaining changes
//     are counted but not enumerated and `truncated: true` is set — mirrors
//     the budget convention used by file_diff_dir's max_diff_lines.
//
// Read-only — does not require MCP_ALLOW_EXEC.

const fs   = require("fs");
const path = require("path");

const { parseYaml } = require("./yamlOps");
const { ToolError } = require("./errors");

const MAX_DEPTH        = 50;
const DEFAULT_MAX_CHANGES = 2000;
const HARD_MAX_CHANGES    = 20000;

// ── Parsing (mirrors query_path's auto-detect-by-extension convention) ────────

function parseDocument(filePath, format, side) {
  const raw = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();

  const fmt = format
    ? String(format).toLowerCase()
    : (ext === ".json" ? "json" : (ext === ".yaml" || ext === ".yml" ? "yaml" : "json"));

  if (fmt !== "json" && fmt !== "yaml")
    throw new ToolError(`json_diff: unsupported format '${format}'. Use 'json' or 'yaml'.`, -32602);

  if (fmt === "json") {
    try { return { doc: JSON.parse(raw), format: fmt }; }
    catch (e) { throw new Error(`json_diff: ${side} file is not valid JSON — ${e.message}`); }
  }
  try { return { doc: parseYaml(raw) ?? null, format: fmt }; }
  catch (e) { throw new Error(`json_diff: ${side} file is not valid YAML — ${e.message}`); }
}

// ── Pointer helpers ────────────────────────────────────────────────────────

function ptr(base, key) {
  const escaped = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  return base === "" ? "/" + escaped : base + "/" + escaped;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ── Recursive comparison ──────────────────────────────────────────────────

/**
 * Recursively compare `left` and `right`, pushing { path, type, oldValue?,
 * newValue? } entries into `acc`. Stops enumerating (but keeps counting)
 * once acc.length reaches maxChanges; caller reports the true total via a
 * separate counter object so `truncated` accurately reflects reality even
 * though `changes` itself is capped.
 */
function walk(left, right, currentPath, depth, acc, counter, maxChanges) {
  if (depth > MAX_DEPTH) {
    // Pathologically deep structure — stop recursing, report as a single
    // opaque "changed" entry rather than risking a stack overflow.
    recordChange(acc, counter, maxChanges, currentPath, "changed", left, right);
    return;
  }

  const leftIsObj  = isPlainObject(left);
  const rightIsObj = isPlainObject(right);
  const leftIsArr  = Array.isArray(left);
  const rightIsArr = Array.isArray(right);

  if (leftIsObj && rightIsObj) {
    const leftKeys  = Object.keys(left);
    const rightKeys = Object.keys(right);
    const allKeys = Array.from(new Set([...leftKeys, ...rightKeys])).sort();
    for (const key of allKeys) {
      const hasLeft  = Object.prototype.hasOwnProperty.call(left, key);
      const hasRight = Object.prototype.hasOwnProperty.call(right, key);
      const childPath = ptr(currentPath, key);
      if (hasLeft && !hasRight) {
        recordChange(acc, counter, maxChanges, childPath, "removed", left[key], undefined);
      } else if (!hasLeft && hasRight) {
        recordChange(acc, counter, maxChanges, childPath, "added", undefined, right[key]);
      } else {
        walk(left[key], right[key], childPath, depth + 1, acc, counter, maxChanges);
      }
      if (counter.total >= HARD_MAX_CHANGES) return;
    }
    return;
  }

  if (leftIsArr && rightIsArr) {
    const maxLen = Math.max(left.length, right.length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = ptr(currentPath, i);
      const hasLeft  = i < left.length;
      const hasRight = i < right.length;
      if (hasLeft && !hasRight) {
        recordChange(acc, counter, maxChanges, childPath, "removed", left[i], undefined);
      } else if (!hasLeft && hasRight) {
        recordChange(acc, counter, maxChanges, childPath, "added", undefined, right[i]);
      } else {
        walk(left[i], right[i], childPath, depth + 1, acc, counter, maxChanges);
      }
      if (counter.total >= HARD_MAX_CHANGES) return;
    }
    return;
  }

  // Type mismatch (object vs array vs scalar) or both scalars: compare directly.
  if (leftIsObj !== rightIsObj || leftIsArr !== rightIsArr || !valuesEqual(left, right)) {
    recordChange(acc, counter, maxChanges, currentPath, "changed", left, right);
  }
}

function valuesEqual(a, b) {
  if (a === b) return true;
  // NaN !== NaN in JS but two NaN values from JSON/YAML parsing should read
  // as equal for diff purposes (JSON has no NaN literal, but defensive).
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return true;
  return false;
}

function recordChange(acc, counter, maxChanges, changePath, type, oldValue, newValue) {
  counter.total++;
  if (acc.length >= maxChanges) return;
  const entry = { path: changePath, type };
  if (type === "removed" || type === "changed") entry.oldValue = oldValue;
  if (type === "added"   || type === "changed") entry.newValue = newValue;
  acc.push(entry);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Structurally diff two JSON/YAML documents.
 *
 * @param {string} leftResolved   Absolute, jail-checked path to the left ("old") file.
 * @param {string} rightResolved  Absolute, jail-checked path to the right ("new") file.
 * @param {string} leftClientPath  Client-relative path echoed in the result.
 * @param {string} rightClientPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string}  [opts.format]      Force 'json' or 'yaml' for BOTH sides
 *                                     (overrides per-file extension detection).
 * @param {number}  [opts.max_changes] Cap on enumerated changes (default 2000,
 *                                     hard cap 20000). Total count is always
 *                                     accurate via `totalChanges` even when
 *                                     `changes` itself is truncated.
 * @returns {object} { left, right, format, identical, totalChanges,
 *                      addedCount, removedCount, changedCount, truncated, changes }
 */
function jsonDiff(leftResolved, rightResolved, leftClientPath, rightClientPath, opts = {}) {
  let maxChanges = opts.max_changes === undefined ? DEFAULT_MAX_CHANGES : Number(opts.max_changes);
  if (!Number.isFinite(maxChanges) || maxChanges < 0 || !Number.isInteger(maxChanges))
    throw new ToolError("json_diff: 'max_changes' must be a non-negative integer.", -32602);
  maxChanges = Math.min(maxChanges, HARD_MAX_CHANGES);

  const { doc: leftDoc,  format: leftFmt  } = parseDocument(leftResolved,  opts.format, "left");
  const { doc: rightDoc, format: rightFmt } = parseDocument(rightResolved, opts.format, "right");

  // Only meaningful when opts.format wasn't forced; informational either way.
  const format = opts.format ? String(opts.format).toLowerCase() : (leftFmt === rightFmt ? leftFmt : "mixed");

  const acc = [];
  const counter = { total: 0 };
  walk(leftDoc, rightDoc, "", 0, acc, counter, maxChanges);

  let addedCount = 0, removedCount = 0, changedCount = 0;
  for (const c of acc) {
    if (c.type === "added") addedCount++;
    else if (c.type === "removed") removedCount++;
    else changedCount++;
  }
  // Counts below reflect the (possibly truncated) enumerated list; totalChanges
  // is the true total regardless of truncation, per the max_diff_lines-style
  // budget convention used elsewhere (file_diff_dir).
  return {
    left:  leftClientPath,
    right: rightClientPath,
    format,
    identical: counter.total === 0,
    totalChanges: counter.total,
    addedCount,
    removedCount,
    changedCount,
    truncated: counter.total > acc.length,
    changes: acc,
  };
}

module.exports = { jsonDiff, walk, ptr };
