"use strict";
// ── JSON_FLATTEN — flatten/unflatten nested JSON or YAML documents ────────
// flatten:   nested object/array -> { "a.b.c": value, "items.0.name": value }
// unflatten: dot-notation flat object -> nested object/array
// Useful for env-var generation (KEY.SUB=val), config diffing (compare flat
// key sets instead of deep-equal trees), and CLI-friendly key listing.
// Reuses the same JSON/YAML format-detection convention as queryOps.js.

const fs   = require("fs");
const path = require("path");
const { parseYaml } = require("./yamlOps");

const MAX_DEPTH = 100; // guards against pathological/cyclic-looking structures

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Escape a literal dot inside a key so it round-trips through unflatten.
function escapeKey(k) {
  return String(k).replace(/\./g, "\\.");
}

function flattenValue(value, prefix, out, depth) {
  if (depth > MAX_DEPTH)
    throw new Error(`json_flatten: nesting exceeds max depth (${MAX_DEPTH}) — possible cyclic or pathological structure.`);

  if (Array.isArray(value)) {
    if (value.length === 0) { out[prefix || "."] = []; return; }
    value.forEach((v, i) => flattenValue(v, prefix ? `${prefix}.${i}` : String(i), out, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) { out[prefix || "."] = {}; return; }
    for (const k of keys) {
      const seg = escapeKey(k);
      flattenValue(value[k], prefix ? `${prefix}.${seg}` : seg, out, depth + 1);
    }
    return;
  }
  out[prefix || "."] = value; // scalar (string/number/boolean/null)
}

/**
 * Flatten a nested JSON/YAML document into dot-notation key/value pairs.
 * @param {string} filePath
 * @param {string} [format] "json" | "yaml" — overrides extension sniffing.
 * @returns {{ flattened: object, keyCount: number, format: string }}
 */
function jsonFlatten(filePath, format) {
  const ext = path.extname(filePath).toLowerCase();
  const resolvedFormat = (format || "").toLowerCase() ||
    (ext === ".yaml" || ext === ".yml" ? "yaml" : "json");
  if (resolvedFormat !== "json" && resolvedFormat !== "yaml")
    throw new Error(`json_flatten: unsupported format '${format}'. Choose 'json' or 'yaml'.`);

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = resolvedFormat === "yaml" ? parseYaml(raw) : JSON.parse(raw);

  const out = {};
  flattenValue(parsed, "", out, 0);
  return { flattened: out, keyCount: Object.keys(out).length, format: resolvedFormat };
}

// Split a dot-path into segments, honouring backslash-escaped dots.
function splitPath(key) {
  return key.split(/(?<!\\)\./).map(p => p.replace(/\\\./g, "."));
}

/**
 * Unflatten a dot-notation flat object back into a nested object/array.
 * Numeric-looking segments become array indices when every sibling segment
 * at that level is also numeric; otherwise they're treated as object keys.
 * @param {object} flat  Flat { "a.b.0.c": value } style object.
 * @returns {any} Reconstructed nested structure.
 */
function jsonUnflatten(flat) {
  if (flat === null || typeof flat !== "object" || Array.isArray(flat))
    throw new Error("json_flatten: unflatten input must be a flat object.");

  const root = {};
  for (const rawKey of Object.keys(flat)) {
    const value = flat[rawKey];
    if (rawKey === ".") { Object.assign(root, isPlainObject(value) ? value : {}); continue; }
    const segs = splitPath(rawKey);
    let cursor = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const isLast = i === segs.length - 1;
      if (isLast) { cursor[seg] = value; break; }
      if (cursor[seg] === undefined || typeof cursor[seg] !== "object" || cursor[seg] === null) {
        cursor[seg] = {};
      }
      cursor = cursor[seg];
    }
  }
  return arrayify(root);
}

// Post-process: any object whose keys are a contiguous 0..N-1 numeric
// sequence is converted into a real array (recursively, bottom-up).
function arrayify(node) {
  if (Array.isArray(node)) return node.map(arrayify);
  if (!isPlainObject(node)) return node;
  const keys = Object.keys(node);
  const isArrayLike = keys.length > 0 && keys.every((k, i) => k === String(i));
  const mapped = {};
  for (const k of keys) mapped[k] = arrayify(node[k]);
  return isArrayLike ? keys.map(k => mapped[k]) : mapped;
}

/**
 * Read a flat JSON file ({ "a.b.c": value, ... }) and unflatten it back
 * into a nested object/array.
 * @param {string} filePath  Absolute path to a JSON file holding a flat object.
 * @returns {{ nested: any, keyCount: number }}
 */
function jsonUnflattenFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const flat = JSON.parse(raw);
  return { nested: jsonUnflatten(flat), keyCount: Object.keys(flat).length };
}

module.exports = { jsonFlatten, jsonUnflatten, jsonUnflattenFile };
