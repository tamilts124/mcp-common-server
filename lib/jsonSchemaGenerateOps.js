"use strict";
// ── JSON_SCHEMA_GENERATE — infer a minimal JSON Schema from a sample document ──
// Read-only counterpart to json_schema_validate: given a sample JSON/YAML
// document, infer a minimal JSON Schema describing its shape (types,
// required fields at each object level, and a merged item schema for
// arrays) so an agent can scaffold a schema from a real example instead of
// hand-writing one before calling json_schema_validate.
//
// Inference rules:
//   - null            -> {type:"null"}
//   - boolean/string  -> {type:"boolean"|"string"}
//   - number          -> {type:"integer"} if Number.isInteger, else {type:"number"}
//   - array           -> {type:"array", items: <merged schema of up to
//                         max_array_sample sampled elements>}; empty array
//                         -> {type:"array", items:{}} (items unconstrained).
//   - object          -> {type:"object", properties:{...}, required:[...]}
//                         — every own key at THIS level is required, since a
//                         single sample can't know which keys are optional
//                         (documented behavior, not a bug — edit the
//                         generated schema's `required` array by hand if
//                         some keys are known to be optional).
//
// Array item merging: if every sampled element resolves to the same
// scalar/null type, items is that single type schema. If elements are
// objects, items.properties is the UNION of all sampled elements' keys and
// items.required is the INTERSECTION (only keys present in every sampled
// element) — this is the one place required is not "all keys seen", since
// an array naturally offers multiple samples to compare. Mixed scalar/
// object/array types across elements produce {type:[...]} (JSON Schema's
// own multi-type array form) with no further properties/items narrowing.
//
// Safety:
//   - Documents are only ever JSON.parse'd or parsed by the existing
//     zero-dep lib/yamlOps.js parser — never eval'd.
//   - MAX_DEPTH guards recursion on deeply-nested/pathological documents,
//     mirroring json_diff's convention (degrades to {} — an unconstrained
//     schema — rather than risking a stack overflow).
//   - Every "properties" object is built on a null-prototype object
//     (Object.create(null)), so a sample document containing a literal
//     "__proto__" key can never repoint the schema object's prototype via
//     the inherited __proto__ accessor — bracket-assignment on a
//     null-prototype target is always a plain own-property write.
//
// Read-only — does not require MCP_ALLOW_EXEC.

const fs   = require("fs");
const path = require("path");

const { parseYaml } = require("./yamlOps");
const { ToolError } = require("./errors");

const MAX_DEPTH                = 50;
const DEFAULT_MAX_ARRAY_SAMPLE = 100;
const HARD_MAX_ARRAY_SAMPLE    = 1000;

// ── Parsing (mirrors json_diff's parseDocument convention) ─────────────────

function parseDocument(filePath, format) {
  const raw = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  const fmt = format
    ? String(format).toLowerCase()
    : (ext === ".json" ? "json" : (ext === ".yaml" || ext === ".yml" ? "yaml" : "json"));

  if (fmt !== "json" && fmt !== "yaml")
    throw new ToolError(`json_schema_generate: unsupported format '${format}'. Use 'json' or 'yaml'.`, -32602);

  if (fmt === "json") {
    try { return { doc: JSON.parse(raw), format: fmt }; }
    catch (e) { throw new Error(`json_schema_generate: file is not valid JSON — ${e.message}`); }
  }
  try { return { doc: parseYaml(raw) ?? null, format: fmt }; }
  catch (e) { throw new Error(`json_schema_generate: file is not valid YAML — ${e.message}`); }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function scalarType(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return "string"; // defensive fallback — unreachable for JSON/YAML-parsed values
}

/** Infer a schema for a single value. */
function inferOne(value, depth, maxArraySample) {
  if (depth > MAX_DEPTH) return {}; // pathologically deep — unconstrained, no crash

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: {} };
    const sample = value.slice(0, maxArraySample);
    const itemSchemas = sample.map((el) => inferOne(el, depth + 1, maxArraySample));
    return { type: "array", items: mergeSchemas(itemSchemas) };
  }

  if (isPlainObject(value)) {
    const properties = Object.create(null);
    const required = [];
    for (const key of Object.keys(value)) {
      properties[key] = inferOne(value[key], depth + 1, maxArraySample);
      required.push(key);
    }
    return { type: "object", properties, required };
  }

  return { type: scalarType(value) };
}

/** Merge N independently-inferred schemas into one (used for array items). */
function mergeSchemas(schemas) {
  if (schemas.length === 0) return {};
  if (schemas.length === 1) return schemas[0];

  const types = Array.from(new Set(schemas.map((s) => s.type))).sort();

  if (types.length > 1) {
    // Mixed types across sampled elements — JSON Schema's multi-type form,
    // no further narrowing (documented behavior, not a bug).
    return { type: types };
  }

  const type = types[0];

  if (type === "object") {
    const properties = Object.create(null);
    const keyPresenceCount = Object.create(null);
    const perKeySchemas = Object.create(null);
    for (const s of schemas) {
      for (const key of Object.keys(s.properties || {})) {
        keyPresenceCount[key] = (keyPresenceCount[key] || 0) + 1;
        if (!perKeySchemas[key]) perKeySchemas[key] = [];
        perKeySchemas[key].push(s.properties[key]);
      }
    }
    const required = [];
    for (const key of Object.keys(perKeySchemas)) {
      properties[key] = mergeSchemas(perKeySchemas[key]);
      if (keyPresenceCount[key] === schemas.length) required.push(key);
    }
    return { type: "object", properties, required };
  }

  if (type === "array") {
    const allItemSchemas = schemas.map((s) => s.items || {});
    return { type: "array", items: mergeSchemas(allItemSchemas) };
  }

  // Same scalar/null type across all sampled elements.
  return { type };
}

/**
 * Infer a minimal JSON Schema describing a sample JSON/YAML document's shape.
 *
 * @param {string} absPath   Absolute, jail-checked path to the sample file.
 * @param {string} origPath  Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string} [opts.format]            Force 'json' or 'yaml' (default: detect from extension).
 * @param {number} [opts.max_array_sample]  Max array elements sampled per array when inferring/
 *                                          merging an `items` schema (default 100, hard cap 1000).
 * @returns {{ path: string, format: string, schema: object }}
 */
function jsonSchemaGenerate(absPath, origPath, opts = {}) {
  let maxArraySample = parseInt(opts.max_array_sample, 10);
  if (!Number.isFinite(maxArraySample) || maxArraySample <= 0) maxArraySample = DEFAULT_MAX_ARRAY_SAMPLE;
  maxArraySample = Math.min(maxArraySample, HARD_MAX_ARRAY_SAMPLE);

  const { doc, format } = parseDocument(absPath, opts.format);
  const schema = inferOne(doc, 0, maxArraySample);

  return { path: origPath, format, schema };
}

module.exports = { jsonSchemaGenerate, inferOne, mergeSchemas };
