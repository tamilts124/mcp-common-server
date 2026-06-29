"use strict";
// ── JSON PATCH — RFC 6902 JSON Patch operations on a JSON file ─────────────────
// Supported operations: add, remove, replace, move, copy, test
// Path pointers use RFC 6901 JSON Pointer syntax (e.g. /a/b/0/c).
// The file is read, patched in memory, then written back (pretty-printed at the
// original indent level).  Pass apply=false for a dry-run that returns the
// patched document without touching the file.
//
// This is a write-gated tool (disabled under MCP_READ_ONLY=true).

const fs   = require("fs");
const path = require("path");

// ── RFC 6901 JSON Pointer helpers ─────────────────────────────────────────────

/** Unescape a single JSON Pointer token: ~1 → /, ~0 → ~ (in that order). */
function unescapeToken(tok) {
  return tok.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Parse a JSON Pointer string into an array of tokens.
 * The empty string "" refers to the root document.
 * All other pointers must start with "/".
 */
function parsePointer(ptr) {
  if (ptr === "") return [];           // root
  if (!ptr.startsWith("/"))
    throw new Error(`JSON Pointer must start with '/' (got: ${JSON.stringify(ptr)})`);
  return ptr.slice(1).split("/").map(unescapeToken);
}

/**
 * Get the value at `pointer` inside `doc`.
 * Throws if the path does not exist.
 */
function pointerGet(doc, pointer) {
  const tokens = parsePointer(pointer);
  let node = doc;
  for (const tok of tokens) {
    if (Array.isArray(node)) {
      const idx = tok === "-" ? node.length - 1 : Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length)
        throw new Error(`JSON Pointer out of bounds: ${JSON.stringify(pointer)} (index ${JSON.stringify(tok)})`);
      node = node[idx];
    } else if (node !== null && typeof node === "object") {
      if (!Object.prototype.hasOwnProperty.call(node, tok))
        throw new Error(`JSON Pointer path not found: ${JSON.stringify(pointer)} (key ${JSON.stringify(tok)})`);
      node = node[tok];
    } else {
      throw new Error(`JSON Pointer cannot traverse into scalar at ${JSON.stringify(pointer)}`);
    }
  }
  return node;
}

/**
 * Set the value at `pointer` inside `doc` (mutates).
 * The special token "-" on an array means "append".
 */
function pointerSet(doc, pointer, value) {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0)
    throw new Error("Cannot set root — replace the whole document with the 'replace' op at ''.");
  const parentTokens = tokens.slice(0, -1);
  const last         = tokens[tokens.length - 1];
  let parent = doc;
  for (const tok of parentTokens) {
    if (Array.isArray(parent)) {
      const idx = Number(tok);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length)
        throw new Error(`JSON Pointer parent path not found: index ${JSON.stringify(tok)}`);
      parent = parent[idx];
    } else if (parent !== null && typeof parent === "object") {
      if (!Object.prototype.hasOwnProperty.call(parent, tok))
        throw new Error(`JSON Pointer parent path not found: key ${JSON.stringify(tok)}`);
      parent = parent[tok];
    } else {
      throw new Error("JSON Pointer cannot traverse into scalar in parent path.");
    }
  }

  if (Array.isArray(parent)) {
    if (last === "-") {
      parent.push(value);
    } else {
      const idx = Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length)
        throw new Error(`JSON Pointer array insert out of bounds: index ${JSON.stringify(last)}`);
      parent.splice(idx, 0, value);
    }
  } else if (parent !== null && typeof parent === "object") {
    parent[last] = value;
  } else {
    throw new Error("JSON Pointer parent is a scalar — cannot set a child key.");
  }
}

/**
 * Remove the value at `pointer` inside `doc` (mutates).
 */
function pointerRemove(doc, pointer) {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0)
    throw new Error("Cannot remove root.");
  const parentTokens = tokens.slice(0, -1);
  const last         = tokens[tokens.length - 1];
  let parent = doc;
  for (const tok of parentTokens) {
    if (Array.isArray(parent)) {
      const idx = Number(tok);
      parent = parent[idx];
    } else if (parent !== null && typeof parent === "object") {
      parent = parent[tok];
    } else {
      throw new Error("JSON Pointer parent path is a scalar.");
    }
  }

  if (Array.isArray(parent)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length)
      throw new Error(`JSON Pointer remove: array index out of bounds: ${JSON.stringify(last)}`);
    parent.splice(idx, 1);
  } else if (parent !== null && typeof parent === "object") {
    if (!Object.prototype.hasOwnProperty.call(parent, last))
      throw new Error(`JSON Pointer remove: key not found: ${JSON.stringify(last)}`);
    delete parent[last];
  } else {
    throw new Error("JSON Pointer parent is a scalar — cannot remove.");
  }
}

// ── Detect original indentation ────────────────────────────────────────────────

/**
 * Heuristically detect the indent of a JSON string.
 * Returns a number (spaces) or a tab string.  Defaults to 2.
 */
function detectIndent(src) {
  for (const line of src.split("\n")) {
    const m = line.match(/^(\t+| {1,8})\S/);
    if (m) {
      const ws = m[1];
      return ws.includes("\t") ? "\t" : ws.length;
    }
  }
  return 2;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Apply RFC 6902 JSON Patch operations to a JSON file.
 *
 * @param {string}   resolvedPath  Absolute path to the JSON file (jail-checked by caller).
 * @param {string}   origPath      Client-relative path echoed in the result.
 * @param {object[]} ops           Array of patch operations.
 * @param {object}   [opts]
 * @param {boolean}  [opts.apply]  true (default) writes back; false = dry-run.
 * @returns {object}  { path, opsApplied, apply, originalSize, newSize?, result }
 */
function jsonPatch(resolvedPath, origPath, ops, opts = {}) {
  const apply = opts.apply !== false; // default true

  if (!Array.isArray(ops) || ops.length === 0)
    throw Object.assign(new Error("'ops' must be a non-empty array of JSON Patch operations."), { code: -32602 });

  // Read and parse
  const src  = fs.readFileSync(resolvedPath, "utf8");
  const indent = detectIndent(src);
  let doc;
  try { doc = JSON.parse(src); }
  catch (e) { throw new Error(`json_patch: file is not valid JSON: ${e.message}`); }

  const ALLOWED_OPS = new Set(["add", "remove", "replace", "move", "copy", "test"]);
  let opsApplied = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== "object")
      throw Object.assign(new Error(`ops[${i}]: each operation must be an object.`), { code: -32602 });
    if (!ALLOWED_OPS.has(op.op))
      throw Object.assign(new Error(`ops[${i}]: unknown op ${JSON.stringify(op.op)}. Allowed: ${[...ALLOWED_OPS].join(", ")}.`), { code: -32602 });
    if (typeof op.path !== "string")
      throw Object.assign(new Error(`ops[${i}]: 'path' must be a string.`), { code: -32602 });

    switch (op.op) {
      case "add":
        if (!("value" in op)) throw Object.assign(new Error(`ops[${i}] add: 'value' is required.`), { code: -32602 });
        pointerSet(doc, op.path, structuredClone(op.value));
        break;

      case "remove":
        pointerRemove(doc, op.path);
        break;

      case "replace": {
        if (!("value" in op)) throw Object.assign(new Error(`ops[${i}] replace: 'value' is required.`), { code: -32602 });
        // replace = remove then add — but path must already exist.
        pointerGet(doc, op.path); // throws if not found
        pointerRemove(doc, op.path);
        pointerSet(doc, op.path, structuredClone(op.value));
        break;
      }

      case "move": {
        if (typeof op.from !== "string")
          throw Object.assign(new Error(`ops[${i}] move: 'from' must be a string.`), { code: -32602 });
        if (op.path.startsWith(op.from + "/") || op.path === op.from)
          throw new Error(`ops[${i}] move: 'path' must not be a child or equal to 'from'.`);
        const val = pointerGet(doc, op.from);
        pointerRemove(doc, op.from);
        pointerSet(doc, op.path, val);
        break;
      }

      case "copy": {
        if (typeof op.from !== "string")
          throw Object.assign(new Error(`ops[${i}] copy: 'from' must be a string.`), { code: -32602 });
        const val = pointerGet(doc, op.from);
        pointerSet(doc, op.path, structuredClone(val));
        break;
      }

      case "test": {
        if (!("value" in op)) throw Object.assign(new Error(`ops[${i}] test: 'value' is required.`), { code: -32602 });
        const actual = pointerGet(doc, op.path);
        if (JSON.stringify(actual) !== JSON.stringify(op.value))
          throw new Error(
            `ops[${i}] test: value at ${JSON.stringify(op.path)} does not match expected. ` +
            `Got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(op.value)}.`
          );
        break;
      }
    }
    opsApplied++;
  }

  const serialised = JSON.stringify(doc, null, indent) + "\n";
  const originalSize = Buffer.byteLength(src, "utf8");
  const newSize      = Buffer.byteLength(serialised, "utf8");

  if (apply) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, serialised, "utf8");
  }

  return {
    path: origPath,
    opsApplied,
    apply,
    originalSize,
    newSize,
    result: doc,
  };
}

module.exports = { jsonPatch };
