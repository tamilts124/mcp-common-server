"use strict";
// ── JSON_CLIENT ─────────────────────────────────────────────────────────────────
// Fine-grained JSON file editor (pure Node.js; zero npm deps).
//
// Operations:
//   read     — parse and return the entire JSON document
//   get      — retrieve a value at a dot/bracket-notation path
//   set      — set (create or overwrite) a value at a path; writes the file
//   delete   — delete a key/index at a path; writes the file
//   keys     — list keys at a path (object) or length (array)
//   merge    — deep-merge one or more JSON documents or objects into the file
//   patch    — apply a JSON Patch (RFC 6902) array of operations to the file
//   stringify — return the current document as a formatted or minified string
//
// Security:
//   • Path NUL guard on all file paths
//   • 10 MB file size cap
//   • Max nesting depth 100 in parsed documents
//   • 200,000-key limit across the entire document

const fs = require("fs");
const { ToolError } = require("./errors");

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DEPTH      = 100;
const MAX_KEYS       = 200_000;

// ── Path guard ───────────────────────────────────────────────────────────────
function guardPath(p, label) {
  if (typeof p !== "string" || p.length === 0)
    throw new ToolError(`${label}: path must be a non-empty string.`, -32602);
  if (p.indexOf("\0") !== -1)
    throw new ToolError(`${label}: path contains a NUL byte.`, -32602);
}

// ── File I/O ─────────────────────────────────────────────────────────────────
function readJsonFile(filePath, op) {
  if (!fs.existsSync(filePath))
    throw new ToolError(`${op}: file not found: ${filePath}`, -32602);
  const stat = fs.statSync(filePath);
  if (stat.isDirectory())
    throw new ToolError(`${op}: '${filePath}' is a directory, not a JSON file.`, -32602);
  if (stat.size > MAX_FILE_BYTES)
    throw new ToolError(
      `${op}: file too large (${stat.size} bytes > ${MAX_FILE_BYTES} limit).`, -32602);
  const raw = fs.readFileSync(filePath, "utf8");
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { throw new ToolError(`${op}: JSON parse error — ${e.message}`, -32602); }
  validateDepthAndKeys(doc, op);
  return doc;
}

function writeJsonFile(filePath, doc, indent) {
  const spaces = (indent == null) ? 2 : Math.max(0, Math.min(8, Math.trunc(indent)));
  const text = JSON.stringify(doc, null, spaces || undefined) + (spaces ? "\n" : "");
  fs.writeFileSync(filePath, text, "utf8");
  return text;
}

// ── Depth & key count validation ─────────────────────────────────────────────
function validateDepthAndKeys(doc, op) {
  let keyCount = 0;
  function walk(node, depth) {
    if (depth > MAX_DEPTH)
      throw new ToolError(`${op}: document exceeds max nesting depth (${MAX_DEPTH}).`, -32602);
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else {
      for (const k of Object.keys(node)) {
        if (++keyCount > MAX_KEYS)
          throw new ToolError(`${op}: document exceeds max key count (${MAX_KEYS}).`, -32602);
        walk(node[k], depth + 1);
      }
    }
  }
  walk(doc, 0);
}

// ── Path navigation ───────────────────────────────────────────────────────────
// Supports dot-notation: "a.b.c", "items.0.name"
// Also bracket-free: "a[0].b" is NOT supported — use "a.0.b" style.

function parsePath(pathStr) {
  // Split on unescaped dots; support "\\" escape for literal dots in keys
  // e.g. "a.b\.c.d" → ["a", "b.c", "d"]
  if (typeof pathStr !== "string" || pathStr === "")
    return [];
  const segments = [];
  let cur = "";
  for (let i = 0; i < pathStr.length; i++) {
    if (pathStr[i] === "\\" && i + 1 < pathStr.length && pathStr[i + 1] === ".") {
      cur += ".";
      i++;
    } else if (pathStr[i] === ".") {
      segments.push(cur);
      cur = "";
    } else {
      cur += pathStr[i];
    }
  }
  segments.push(cur);
  return segments;
}

function getAtPath(doc, segments) {
  let node = doc;
  for (const seg of segments) {
    if (node === null || typeof node !== "object")
      return { found: false, value: undefined };
    if (Array.isArray(node)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length)
        return { found: false, value: undefined };
      node = node[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(node, seg))
        return { found: false, value: undefined };
      node = node[seg];
    }
  }
  return { found: true, value: node };
}

function setAtPath(doc, segments, value) {
  if (segments.length === 0) return value; // replace root
  const parent = segments.slice(0, -1);
  const key    = segments[segments.length - 1];
  const { found, value: parentNode } = getAtPath(doc, parent);
  if (!found || parentNode === null || typeof parentNode !== "object")
    throw new ToolError(
      `set: parent path '${parent.join(".") || "root"}' does not exist or is not an object/array.`,
      -32602);
  if (Array.isArray(parentNode)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0)
      throw new ToolError(`set: array index '${key}' must be a non-negative integer.`, -32602);
    parentNode[idx] = value;
  } else {
    parentNode[key] = value;
  }
  return doc;
}

function deleteAtPath(doc, segments) {
  if (segments.length === 0)
    throw new ToolError("delete: cannot delete the root document. Use set to replace it.", -32602);
  const parent = segments.slice(0, -1);
  const key    = segments[segments.length - 1];
  const { found, value: parentNode } = getAtPath(doc, parent);
  if (!found || parentNode === null || typeof parentNode !== "object")
    throw new ToolError(
      `delete: parent path '${parent.join(".") || "root"}' does not exist or is not an object/array.`,
      -32602);
  if (Array.isArray(parentNode)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= parentNode.length)
      throw new ToolError(
        `delete: array index '${key}' out of bounds (length ${parentNode.length}).`, -32602);
    parentNode.splice(idx, 1);
  } else {
    if (!Object.prototype.hasOwnProperty.call(parentNode, key))
      throw new ToolError(`delete: key '${key}' not found at path.`, -32602);
    delete parentNode[key];
  }
  return doc;
}

// ── Deep merge ───────────────────────────────────────────────────────────────
// Recursively merges `src` into `dst`. Arrays: concat (not replaced).
// null src value overrides dst (explicit override).
function deepMerge(dst, src) {
  if (src === null || typeof src !== "object" || Array.isArray(src))
    return src; // scalars, null, arrays: src wins
  if (dst === null || typeof dst !== "object" || Array.isArray(dst))
    return src; // dst not mergeable: src wins
  const result = Object.assign({}, dst);
  for (const k of Object.keys(src)) {
    if (k in result && result[k] !== null && typeof result[k] === "object" &&
        !Array.isArray(result[k]) && src[k] !== null && typeof src[k] === "object" &&
        !Array.isArray(src[k])) {
      result[k] = deepMerge(result[k], src[k]);
    } else {
      result[k] = src[k];
    }
  }
  return result;
}

// ── JSON Patch (RFC 6902) ─────────────────────────────────────────────────────
// Supported operations: add, remove, replace, move, copy, test
function jsonPointerToSegments(pointer) {
  if (pointer === "") return []; // root
  if (!pointer.startsWith("/"))
    throw new ToolError(`patch: invalid JSON Pointer '${pointer}' — must start with '/'.`, -32602);
  return pointer.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function patchGet(doc, pointer) {
  const segs = jsonPointerToSegments(pointer);
  if (segs.length === 0) return { found: true, value: doc };
  return getAtPath(doc, segs);
}

function patchSet(doc, pointer, value) {
  const segs = jsonPointerToSegments(pointer);
  if (segs.length === 0) return value;
  return setAtPath(doc, segs, value);
}

function patchRemove(doc, pointer) {
  const segs = jsonPointerToSegments(pointer);
  if (segs.length === 0)
    throw new ToolError("patch/remove: cannot remove root.", -32602);
  return deleteAtPath(doc, segs);
}

function applyJsonPatch(doc, ops) {
  if (!Array.isArray(ops))
    throw new ToolError("patch: 'operations' must be an array of RFC 6902 patch operation objects.", -32602);
  let cur = JSON.parse(JSON.stringify(doc)); // deep clone to keep atomic
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== "object")
      throw new ToolError(`patch: operation ${i} is not an object.`, -32602);
    switch (op.op) {
      case "add": {
        cur = patchSet(cur, op.path, op.value);
        break;
      }
      case "remove": {
        cur = patchRemove(cur, op.path);
        break;
      }
      case "replace": {
        const { found } = patchGet(cur, op.path);
        if (!found)
          throw new ToolError(`patch/replace: path '${op.path}' does not exist.`, -32602);
        cur = patchSet(cur, op.path, op.value);
        break;
      }
      case "move": {
        const { found, value: moved } = patchGet(cur, op.from);
        if (!found)
          throw new ToolError(`patch/move: 'from' path '${op.from}' does not exist.`, -32602);
        cur = patchRemove(cur, op.from);
        cur = patchSet(cur, op.path, moved);
        break;
      }
      case "copy": {
        const { found, value: copied } = patchGet(cur, op.from);
        if (!found)
          throw new ToolError(`patch/copy: 'from' path '${op.from}' does not exist.`, -32602);
        cur = patchSet(cur, op.path, JSON.parse(JSON.stringify(copied)));
        break;
      }
      case "test": {
        const { found, value: actual } = patchGet(cur, op.path);
        if (!found)
          throw new ToolError(`patch/test: path '${op.path}' does not exist.`, -32602);
        if (JSON.stringify(actual) !== JSON.stringify(op.value))
          throw new ToolError(
            `patch/test: value at '${op.path}' does not equal expected value. ` +
            `Got: ${JSON.stringify(actual)}, expected: ${JSON.stringify(op.value)}`, -32602);
        break;
      }
      default:
        throw new ToolError(`patch: unknown op '${op.op}' at index ${i}. Valid: add, remove, replace, move, copy, test.`, -32602);
    }
  }
  return cur;
}

// ── Operations ────────────────────────────────────────────────────────────────

function opRead(args) {
  guardPath(args.path, "read");
  const doc = readJsonFile(args.path, "read");
  return {
    path: args.path,
    type: Array.isArray(doc) ? "array" : doc === null ? "null" : typeof doc,
    value: doc,
  };
}

function opGet(args) {
  guardPath(args.path, "get");
  if (!args.key_path)
    throw new ToolError("get: 'key_path' is required.", -32602);
  const doc  = readJsonFile(args.path, "get");
  const segs = parsePath(args.key_path);
  const { found, value } = getAtPath(doc, segs);
  if (!found && !args.default_value_set)
    throw new ToolError(
      `get: path '${args.key_path}' not found in '${args.path}'. ` +
      `Pass default to return a default value instead of throwing.`, -32602);
  return {
    path:     args.path,
    key_path: args.key_path,
    found,
    type:  found ? (Array.isArray(value) ? "array" : value === null ? "null" : typeof value) : null,
    value: found ? value : (args.default !== undefined ? args.default : null),
  };
}

function opSet(args) {
  guardPath(args.path, "set");
  if (args.key_path === undefined || args.key_path === null)
    throw new ToolError("set: 'key_path' is required (use '' to replace root).", -32602);
  if (args.value === undefined)
    throw new ToolError("set: 'value' is required.", -32602);

  // Read existing doc (or start fresh if file doesn't exist and create:true)
  let doc;
  if (!fs.existsSync(args.path)) {
    if (!args.create)
      throw new ToolError(`set: file not found: '${args.path}'. Pass create:true to create a new file.`, -32602);
    doc = {}; // bootstrap empty object
  } else {
    doc = readJsonFile(args.path, "set");
  }

  const segs    = parsePath(args.key_path);
  const newDoc  = setAtPath(doc, segs, args.value);
  validateDepthAndKeys(newDoc, "set");
  const text = writeJsonFile(args.path, newDoc, args.indent);
  return {
    path:     args.path,
    key_path: args.key_path,
    written:  true,
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
}

function opDelete(args) {
  guardPath(args.path, "delete");
  if (!args.key_path)
    throw new ToolError("delete: 'key_path' is required.", -32602);
  const doc  = readJsonFile(args.path, "delete");
  const segs = parsePath(args.key_path);

  // Check if the key exists first (for better error messages)
  const { found } = getAtPath(doc, segs);
  if (!found) {
    if (args.ignore_missing)
      return { path: args.path, key_path: args.key_path, deleted: false, found: false };
    throw new ToolError(
      `delete: key_path '${args.key_path}' not found. Pass ignore_missing:true to skip.`, -32602);
  }
  const newDoc  = deleteAtPath(doc, segs);
  const text = writeJsonFile(args.path, newDoc, args.indent);
  return {
    path:     args.path,
    key_path: args.key_path,
    deleted:  true,
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
}

function opKeys(args) {
  guardPath(args.path, "keys");
  const doc  = readJsonFile(args.path, "keys");
  const segs = args.key_path ? parsePath(args.key_path) : [];
  const { found, value: node } = segs.length === 0
    ? { found: true, value: doc }
    : getAtPath(doc, segs);
  if (!found)
    throw new ToolError(`keys: path '${args.key_path}' not found in '${args.path}'.`, -32602);
  if (node === null || typeof node !== "object")
    throw new ToolError(
      `keys: value at '${args.key_path || "root"}' is not an object or array (got ${typeof node}).`,
      -32602);
  if (Array.isArray(node)) {
    return { path: args.path, key_path: args.key_path || "", type: "array", length: node.length,
      indices: Array.from({ length: node.length }, (_, i) => String(i)) };
  }
  const keys = Object.keys(node);
  return { path: args.path, key_path: args.key_path || "", type: "object", count: keys.length, keys };
}

function opMerge(args) {
  guardPath(args.path, "merge");

  // Load base document
  let doc;
  if (!fs.existsSync(args.path)) {
    if (!args.create)
      throw new ToolError(`merge: file not found: '${args.path}'. Pass create:true to create a new file.`, -32602);
    doc = {};
  } else {
    doc = readJsonFile(args.path, "merge");
  }

  // Collect sources: either `sources` (array of file paths) or `data` (inline object/array)
  const mergeTargets = [];
  if (args.sources && args.sources.length > 0) {
    for (const src of args.sources) {
      guardPath(src, "merge");
      mergeTargets.push(readJsonFile(src, "merge"));
    }
  }
  if (args.data !== undefined) {
    mergeTargets.push(args.data);
  }
  if (mergeTargets.length === 0)
    throw new ToolError("merge: provide 'sources' (file paths) and/or 'data' (inline value) to merge.", -32602);

  let merged = doc;
  for (const src of mergeTargets) {
    merged = deepMerge(merged, src);
  }
  validateDepthAndKeys(merged, "merge");
  const text = writeJsonFile(args.path, merged, args.indent);
  return {
    path:        args.path,
    sourcesApplied: mergeTargets.length,
    written:     true,
    sizeBytes:   Buffer.byteLength(text, "utf8"),
  };
}

function opPatch(args) {
  guardPath(args.path, "patch");
  if (!Array.isArray(args.operations) || args.operations.length === 0)
    throw new ToolError("patch: 'operations' must be a non-empty array of RFC 6902 patch operation objects.", -32602);
  const doc    = readJsonFile(args.path, "patch");
  const newDoc = applyJsonPatch(doc, args.operations);
  validateDepthAndKeys(newDoc, "patch");
  const text = writeJsonFile(args.path, newDoc, args.indent);
  return {
    path:       args.path,
    opsApplied: args.operations.length,
    written:    true,
    sizeBytes:  Buffer.byteLength(text, "utf8"),
  };
}

function opStringify(args) {
  guardPath(args.path, "stringify");
  const doc = readJsonFile(args.path, "stringify");
  const indent = args.indent !== undefined ? args.indent : 2;
  const spaces = Math.max(0, Math.min(8, Math.trunc(indent)));
  const text = JSON.stringify(doc, null, spaces || undefined);
  if (args.write_back) {
    fs.writeFileSync(args.path, text + (spaces ? "\n" : ""), "utf8");
  }
  return {
    path:   args.path,
    indent: spaces,
    sizeBytes: Buffer.byteLength(text, "utf8"),
    content: text,
    written: !!args.write_back,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function jsonClient(args) {
  const op = args.operation;
  switch (op) {
    case "read":      return opRead(args);
    case "get":       return opGet(args);
    case "set":       return opSet(args);
    case "delete":    return opDelete(args);
    case "keys":      return opKeys(args);
    case "merge":     return opMerge(args);
    case "patch":     return opPatch(args);
    case "stringify": return opStringify(args);
    default:
      throw new ToolError(
        `json_client: unknown operation '${op}'. Valid: read, get, set, delete, keys, merge, patch, stringify.`,
        -32602);
  }
}

module.exports = { jsonClient };
