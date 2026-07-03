"use strict";
// ── JSON MERGE — RFC 7396 JSON Merge Patch onto a base JSON file ──────────
// Complement to json_patch (RFC 6902 — an explicit list of ops) and
// yaml_merge (deep-merge for YAML, where null REPLACES a key with null).
// json_merge implements RFC 7396 (https://www.rfc-editor.org/rfc/rfc7396)
// specifically, whose one meaningful difference from yaml_merge's merge
// semantics is what null means: in RFC 7396, null in the patch DELETES the
// key from the result rather than setting it to null. That's the standard,
// widely-implemented (e.g. `kubectl patch --type merge`, HTTP PATCH with
// application/merge-patch+json) meaning of "merge patch", so this tool
// follows the spec rather than yaml_merge's convention, and the schema/
// README call that difference out explicitly to avoid surprising a caller
// used to one or the other.
//
// Merge semantics (RFC 7396 §2):
//   - If the patch is not a JSON object, the result is the patch itself
//     (full replace) — same rule applies recursively at every level.
//   - Otherwise, for each key in the patch: if the value is null, remove
//     that key from the result (if present); if the value is an object AND
//     the existing result value at that key is also an object, merge
//     recursively; otherwise the patch value replaces the key's value
//     (this includes arrays — RFC 7396 has no array-merge concept, they are
//     always a full replace, exactly like yaml_merge's array behavior).
//   - Keys present only in the base are preserved untouched.
//
// This is a write-gated tool (disabled under MCP_READ_ONLY=true).

const fs   = require("fs");
const path = require("path");

function isMergeableObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * RFC 7396 JSON Merge Patch: apply `patch` onto `target`, returning a NEW
 * value (does not mutate either input).
 */
function mergePatch(target, patch) {
  if (!isMergeableObject(patch)) return patch; // full replace at this level

  const base = isMergeableObject(target) ? target : {};
  const result = {};
  for (const key of Object.keys(base)) result[key] = base[key];

  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    if (patchVal === null) {
      delete result[key]; // RFC 7396: null deletes the key
    } else if (isMergeableObject(patchVal)) {
      result[key] = mergePatch(result[key], patchVal);
    } else {
      result[key] = patchVal;
    }
  }
  return result;
}

/**
 * Merge a JSON Merge Patch document (inline string) onto a base JSON file.
 *
 * @param {string} resolvedPath  Absolute path to the base file (jail-checked by caller).
 * @param {string} origPath      Client-relative path echoed in the result.
 * @param {string} patchJson     JSON text (an object, per RFC 7396 typical use) to merge onto the base.
 * @param {object} [opts]
 * @param {boolean} [opts.apply] true (default) writes back; false = dry-run.
 * @param {number}  [opts.indent] Pretty-print indent width for the written file (default 2).
 * @returns {object} { path, apply, originalSize, newSize, result }
 */
function jsonMerge(resolvedPath, origPath, patchJson, opts = {}) {
  const apply = opts.apply !== false; // default true
  let indent = parseInt(opts.indent, 10);
  if (!Number.isFinite(indent) || indent < 0) indent = 2;
  indent = Math.min(indent, 8);

  if (typeof patchJson !== "string" || patchJson.trim() === "")
    throw Object.assign(
      new Error("'patch' must be a non-empty JSON document string."),
      { code: -32602 }
    );

  const src = fs.readFileSync(resolvedPath, "utf8");
  let baseDoc;
  try {
    baseDoc = JSON.parse(src);
  } catch (e) {
    throw new Error(`json_merge: base file is not valid JSON: ${e.message}`);
  }

  let patchDoc;
  try {
    patchDoc = JSON.parse(patchJson);
  } catch (e) {
    throw new Error(`json_merge: patch is not valid JSON: ${e.message}`);
  }

  const originalSize = Buffer.byteLength(src, "utf8");

  const merged = mergePatch(baseDoc, patchDoc);

  const serialised = JSON.stringify(merged, null, indent) + "\n";
  const newSize = Buffer.byteLength(serialised, "utf8");

  if (apply) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, serialised, "utf8");
  }

  return {
    path: origPath,
    apply,
    originalSize,
    newSize,
    result: merged,
  };
}

module.exports = { jsonMerge, mergePatch };
