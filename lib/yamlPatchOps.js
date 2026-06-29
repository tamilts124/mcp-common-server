"use strict";
// ── YAML PATCH — apply structured mutations to a YAML file ────────────────────
// Companion to json_patch (RFC 6902) but for YAML files.
//
// Supported operations:
//   set        — set a value at a dot-notation key path (creates missing keys)
//   delete     — delete a key from a mapping (or splice an item from a sequence)
//   insert_at  — insert a value into a sequence at a given index
//   append_to  — append a value to the end of a sequence
//
// Approach:
//   1. Parse the YAML file using lib/yamlOps.js parseYaml.
//   2. Apply each mutation to the in-memory JS structure.
//   3. Re-serialise using lib/yamlSerializeOps.js serializeYaml.
//   4. Optionally write the result back to disk (gated on apply=true, default).
//
// Note: comments and original formatting are NOT preserved (that would require
// a CST — this parser is a pure value-oriented recursive descent parser).
// Anchors/aliases and other unsupported YAML constructs are rejected by the
// parser before we ever reach the mutation phase.
//
// This is a write-gated tool (disabled under MCP_READ_ONLY=true).

const fs   = require("fs");
const path = require("path");

const { parseYaml }    = require("./yamlOps");
const { serializeYaml } = require("./yamlSerializeOps");

// ── Dot-path helpers ──────────────────────────────────────────────────────────

/**
 * Split a dot-notation path into tokens.
 * "a.b.0.c" → ["a", "b", "0", "c"]
 * "" (empty) → [] (refers to root)
 * Tokens that are pure non-negative integers are kept as strings; the caller
 * decides whether to use them as array indices.
 */
function parsePath(p) {
  if (p === "" || p === null || p === undefined) return [];
  return String(p).split(".").filter(t => t !== "");
}

/**
 * Walk `doc` along `tokens`, returning the value at that path.
 * Throws a descriptive error if any segment is missing.
 */
function pathGet(doc, tokens) {
  let node = doc;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (Array.isArray(node)) {
      const idx = Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length)
        throw Object.assign(
          new Error(`yaml_patch: path segment '${tok}' is out of bounds in array (length ${node.length}).`),
          { code: -32602 }
        );
      node = node[idx];
    } else if (node !== null && typeof node === "object") {
      if (!Object.prototype.hasOwnProperty.call(node, tok))
        throw Object.assign(
          new Error(`yaml_patch: key '${tok}' not found in mapping.`),
          { code: -32602 }
        );
      node = node[tok];
    } else {
      throw Object.assign(
        new Error(`yaml_patch: cannot traverse into scalar at segment '${tok}'.`),
        { code: -32602 }
      );
    }
  }
  return node;
}

/**
 * Set the value at `tokens` inside `doc` (mutates).
 * Creates intermediate mapping keys as needed.
 * Throws if an intermediate path segment is a scalar.
 */
function pathSet(doc, tokens, value) {
  if (tokens.length === 0) {
    throw Object.assign(
      new Error("yaml_patch: cannot replace the root document with 'set' — use a non-empty path."),
      { code: -32602 }
    );
  }
  const parentTokens = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1];
  let parent = doc;
  for (let i = 0; i < parentTokens.length; i++) {
    const tok = parentTokens[i];
    if (Array.isArray(parent)) {
      const idx = Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length)
        throw Object.assign(
          new Error(`yaml_patch: path segment '${tok}' is out of bounds in array (length ${parent.length}).`),
          { code: -32602 }
        );
      parent = parent[idx];
    } else if (parent !== null && typeof parent === "object") {
      if (!Object.prototype.hasOwnProperty.call(parent, tok)) {
        // Auto-create intermediate mapping key
        parent[tok] = {};
      }
      parent = parent[tok];
    } else {
      throw Object.assign(
        new Error(`yaml_patch: cannot traverse into scalar at segment '${tok}'.`),
        { code: -32602 }
      );
    }
  }

  if (Array.isArray(parent)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length)
      throw Object.assign(
        new Error(`yaml_patch: set index '${last}' is out of bounds in array (length ${parent.length}).`),
        { code: -32602 }
      );
    parent[idx] = value;
  } else if (parent !== null && typeof parent === "object") {
    parent[last] = value;
  } else {
    throw Object.assign(
      new Error(`yaml_patch: parent at path is a scalar — cannot set child '${last}'.`),
      { code: -32602 }
    );
  }
}

/**
 * Delete the key/index at `tokens` inside `doc` (mutates).
 */
function pathDelete(doc, tokens) {
  if (tokens.length === 0) {
    throw Object.assign(
      new Error("yaml_patch: cannot delete the root document."),
      { code: -32602 }
    );
  }
  const parentTokens = tokens.slice(0, -1);
  const last = tokens[tokens.length - 1];
  const parent = pathGet(doc, parentTokens);

  if (Array.isArray(parent)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length)
      throw Object.assign(
        new Error(`yaml_patch: delete index '${last}' is out of bounds in array (length ${parent.length}).`),
        { code: -32602 }
      );
    parent.splice(idx, 1);
  } else if (parent !== null && typeof parent === "object") {
    if (!Object.prototype.hasOwnProperty.call(parent, last))
      throw Object.assign(
        new Error(`yaml_patch: key '${last}' not found in mapping — cannot delete.`),
        { code: -32602 }
      );
    delete parent[last];
  } else {
    throw Object.assign(
      new Error(`yaml_patch: parent at path is a scalar — cannot delete child '${last}'.`),
      { code: -32602 }
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const ALLOWED_OPS = new Set(["set", "delete", "insert_at", "append_to"]);

/**
 * Apply structured mutation operations to a YAML file.
 *
 * @param {string}   resolvedPath  Absolute path (already jail-checked by caller).
 * @param {string}   origPath      Client-relative path echoed in the result.
 * @param {object[]} ops           Array of mutation operations.
 * @param {object}   [opts]
 * @param {boolean}  [opts.apply]  true (default) writes back; false = dry-run.
 * @returns {object}  { path, operationsApplied, apply, originalSize, newSize?, result }
 */
function yamlPatch(resolvedPath, origPath, ops, opts = {}) {
  const apply = opts.apply !== false; // default true

  if (!Array.isArray(ops) || ops.length === 0)
    throw Object.assign(
      new Error("'ops' must be a non-empty array of yaml_patch operations."),
      { code: -32602 }
    );

  // ── Read & parse ──────────────────────────────────────────────────────────
  const src = fs.readFileSync(resolvedPath, "utf8");
  let doc;
  try {
    doc = parseYaml(src);
  } catch (e) {
    throw new Error(`yaml_patch: file is not valid YAML: ${e.message}`);
  }

  // If the document is null (empty file) treat it as an empty object for
  // mutation purposes — most callers want to build up a mapping from scratch.
  if (doc === null) doc = {};

  const originalSize = Buffer.byteLength(src, "utf8");

  // ── Apply operations ──────────────────────────────────────────────────────
  let opsApplied = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== "object")
      throw Object.assign(new Error(`ops[${i}]: each operation must be an object.`), { code: -32602 });
    if (!ALLOWED_OPS.has(op.op))
      throw Object.assign(
        new Error(`ops[${i}]: unknown op '${op.op}'. Allowed: ${[...ALLOWED_OPS].join(", ")}.`),
        { code: -32602 }
      );
    if (typeof op.path !== "string")
      throw Object.assign(new Error(`ops[${i}]: 'path' must be a string dot-notation path.`), { code: -32602 });

    const tokens = parsePath(op.path);

    switch (op.op) {
      case "set": {
        if (!("value" in op))
          throw Object.assign(new Error(`ops[${i}] set: 'value' is required.`), { code: -32602 });
        if (tokens.length === 0)
          throw Object.assign(
            new Error(`ops[${i}] set: path must be non-empty (use a key path like 'a.b.c').`),
            { code: -32602 }
          );
        pathSet(doc, tokens, op.value);
        break;
      }

      case "delete": {
        pathDelete(doc, tokens);
        break;
      }

      case "insert_at": {
        if (!("value" in op))
          throw Object.assign(new Error(`ops[${i}] insert_at: 'value' is required.`), { code: -32602 });
        if (typeof op.index !== "number" || !Number.isInteger(op.index) || op.index < 0)
          throw Object.assign(
            new Error(`ops[${i}] insert_at: 'index' must be a non-negative integer.`),
            { code: -32602 }
          );
        const arr = pathGet(doc, tokens);
        if (!Array.isArray(arr))
          throw Object.assign(
            new Error(`ops[${i}] insert_at: value at '${op.path}' is not an array.`),
            { code: -32602 }
          );
        if (op.index > arr.length)
          throw Object.assign(
            new Error(`ops[${i}] insert_at: index ${op.index} is out of bounds (array length ${arr.length}).`),
            { code: -32602 }
          );
        arr.splice(op.index, 0, op.value);
        break;
      }

      case "append_to": {
        if (!("value" in op))
          throw Object.assign(new Error(`ops[${i}] append_to: 'value' is required.`), { code: -32602 });
        const arr = pathGet(doc, tokens);
        if (!Array.isArray(arr))
          throw Object.assign(
            new Error(`ops[${i}] append_to: value at '${op.path}' is not an array.`),
            { code: -32602 }
          );
        arr.push(op.value);
        break;
      }
    }
    opsApplied++;
  }

  // ── Serialise ─────────────────────────────────────────────────────────────
  const serialised = serializeYaml(doc);
  const newSize = Buffer.byteLength(serialised, "utf8");

  if (apply) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, serialised, "utf8");
  }

  return {
    path: origPath,
    operationsApplied: opsApplied,
    apply,
    originalSize,
    newSize,
    result: doc,
  };
}

module.exports = { yamlPatch };
