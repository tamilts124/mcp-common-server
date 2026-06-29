"use strict";
// ── YAML MERGE — deep-merge a patch YAML document onto a base YAML file ───────
// Complement to yaml_patch (structured single-path mutations) and json_patch
// (RFC 6902 operations). yaml_merge takes a "base" YAML file on disk plus a
// "patch" YAML document supplied inline as a string, and deep-merges them.
//
// Merge semantics:
//   - Mappings are merged recursively: patch keys override base keys; keys
//     present only in base are preserved untouched.
//   - Sequences (arrays) in the patch REPLACE the corresponding base sequence
//     entirely (they are not concatenated/appended — use yaml_patch's
//     append_to for that). This mirrors common config-overlay tools (Helm
//     values, Kustomize strategic-merge-ish behavior for arrays-as-replace).
//   - Scalars in the patch replace the corresponding base scalar.
//   - If a key's base value and patch value have different "shapes" (e.g.
//     base is a mapping but patch is a scalar/array, or vice versa), the
//     patch value wins outright (replace, not merge) — there is no sane way
//     to recursively merge incompatible shapes.
//   - null in the patch explicitly overwrites (sets the key to null) rather
//     than being treated as "absent" — YAML/JSON have no distinct "delete"
//     sentinel here; use yaml_patch's `delete` op if true removal is needed.
//
// Approach:
//   1. Parse both documents with the existing lib/yamlOps.js parser.
//   2. Deep-merge in memory (pure function, no mutation of parser output
//      structures that might be shared/aliased — although this parser never
//      aliases since it has no anchor/alias support).
//   3. Re-serialise with lib/yamlSerializeOps.js.
//   4. Optionally write back to disk (gated on apply=true, default).
//
// This is a write-gated tool (disabled under MCP_READ_ONLY=true).

const fs   = require("fs");
const path = require("path");

const { parseYaml }     = require("./yamlOps");
const { serializeYaml } = require("./yamlSerializeOps");

/**
 * Returns true if `v` is a plain mapping (object, not array, not null).
 */
function isMapping(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deep-merge `patch` onto `base`, returning a NEW structure (does not mutate
 * either input). Mapping keys merge recursively; everything else (arrays,
 * scalars, mismatched shapes) is a full replace by the patch value.
 */
function deepMerge(base, patch) {
  if (isMapping(base) && isMapping(patch)) {
    const result = {};
    for (const key of Object.keys(base)) {
      result[key] = base[key];
    }
    for (const key of Object.keys(patch)) {
      if (
        Object.prototype.hasOwnProperty.call(result, key) &&
        isMapping(result[key]) &&
        isMapping(patch[key])
      ) {
        result[key] = deepMerge(result[key], patch[key]);
      } else {
        result[key] = patch[key];
      }
    }
    return result;
  }
  // Arrays, scalars, nulls, or mismatched shapes: patch fully replaces base.
  return patch;
}

/**
 * Merge a "patch" YAML document (inline string) onto a "base" YAML file.
 *
 * @param {string} resolvedPath  Absolute path to the base file (jail-checked by caller).
 * @param {string} origPath      Client-relative path echoed in the result.
 * @param {string} patchYaml     YAML document text to merge onto the base.
 * @param {object} [opts]
 * @param {boolean} [opts.apply] true (default) writes back; false = dry-run.
 * @returns {object} { path, apply, originalSize, newSize, result }
 */
function yamlMerge(resolvedPath, origPath, patchYaml, opts = {}) {
  const apply = opts.apply !== false; // default true

  if (typeof patchYaml !== "string" || patchYaml.trim() === "")
    throw Object.assign(
      new Error("'patch' must be a non-empty YAML document string."),
      { code: -32602 }
    );

  // ── Read & parse base ───────────────────────────────────────────────────
  const src = fs.readFileSync(resolvedPath, "utf8");
  let baseDoc;
  try {
    baseDoc = parseYaml(src);
  } catch (e) {
    throw new Error(`yaml_merge: base file is not valid YAML: ${e.message}`);
  }
  if (baseDoc === null) baseDoc = {};

  // ── Parse patch ─────────────────────────────────────────────────────────
  let patchDoc;
  try {
    patchDoc = parseYaml(patchYaml);
  } catch (e) {
    throw new Error(`yaml_merge: patch is not valid YAML: ${e.message}`);
  }
  if (patchDoc === null) patchDoc = {};

  const originalSize = Buffer.byteLength(src, "utf8");

  // ── Merge ───────────────────────────────────────────────────────────────
  const merged = deepMerge(baseDoc, patchDoc);

  // ── Serialise ───────────────────────────────────────────────────────────
  const serialised = serializeYaml(merged);
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

module.exports = { yamlMerge, deepMerge };
