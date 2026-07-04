"use strict";
// ── JSON_PATCH_GENERATE — diff two JSON/YAML files into an RFC 6902 patch ──
// Read-only counterpart to json_diff: instead of a human-readable change
// report, this emits an actual RFC 6902 JSON Patch (add/remove/replace ops
// with RFC 6901 pointers) that the existing json_patch tool can apply
// directly — a diff-then-apply workflow across two files/versions.
//
// Array semantics mirror json_diff's documented by-INDEX comparison (not an
// LCS/edit-distance diff): overlapping indices are compared and emitted as
// 'replace' if different; extra elements on the right are 'add'ed at the
// end in ascending index order (each append doesn't shift earlier indices);
// extra elements on the left are 'remove'd starting from the HIGHEST index
// first, so that applying the ops sequentially (as json_patch does, one
// after another against a single in-memory document) never has an earlier
// removal invalidate a later index.

const fs   = require("fs");
const path = require("path");

const { parseYaml } = require("./yamlOps");
const { ToolError } = require("./errors");

const MAX_DEPTH    = 50;
const DEFAULT_MAX_OPS = 2000;
const HARD_MAX_OPS    = 20000;

function parseDocument(filePath, format, side) {
  const raw = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  const fmt = format
    ? String(format).toLowerCase()
    : (ext === ".json" ? "json" : (ext === ".yaml" || ext === ".yml" ? "yaml" : "json"));

  if (fmt !== "json" && fmt !== "yaml") {
    throw new ToolError(`json_patch_generate: unsupported format '${format}'. Use 'json' or 'yaml'.`, -32602);
  }
  if (fmt === "json") {
    try { return { doc: JSON.parse(raw), format: fmt }; }
    catch (e) { throw new ToolError(`json_patch_generate: ${side} file is not valid JSON — ${e.message}`, -32602); }
  }
  try { return { doc: parseYaml(raw) ?? null, format: fmt }; }
  catch (e) { throw new ToolError(`json_patch_generate: ${side} file is not valid YAML — ${e.message}`, -32602); }
}

function ptr(base, key) {
  const escaped = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
  return base === "" ? "/" + escaped : base + "/" + escaped;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false; // scalars already handled by === above
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** Counter object so `truncated` reflects reality even once ops[] is capped. */
function pushOp(acc, counter, maxOps, op) {
  counter.total++;
  if (acc.length < maxOps) acc.push(op);
}

function diffValues(oldVal, newVal, currentPath, depth, acc, counter, maxOps) {
  if (depth > MAX_DEPTH) return; // pathological nesting — stop descending, treated as no further diff
  if (deepEqual(oldVal, newVal)) return;

  const oldIsArr = Array.isArray(oldVal), newIsArr = Array.isArray(newVal);
  const oldIsObj = isPlainObject(oldVal), newIsObj = isPlainObject(newVal);

  if (oldIsArr && newIsArr) {
    const minLen = Math.min(oldVal.length, newVal.length);
    for (let i = 0; i < minLen; i++) {
      diffValues(oldVal[i], newVal[i], ptr(currentPath, i), depth + 1, acc, counter, maxOps);
    }
    for (let i = oldVal.length; i < newVal.length; i++) {
      pushOp(acc, counter, maxOps, { op: "add", path: ptr(currentPath, i), value: newVal[i] });
    }
    for (let i = oldVal.length - 1; i >= newVal.length; i--) {
      pushOp(acc, counter, maxOps, { op: "remove", path: ptr(currentPath, i) });
    }
    return;
  }

  if (oldIsObj && newIsObj) {
    for (const k of Object.keys(oldVal)) {
      if (!Object.prototype.hasOwnProperty.call(newVal, k)) {
        pushOp(acc, counter, maxOps, { op: "remove", path: ptr(currentPath, k) });
      }
    }
    for (const k of Object.keys(newVal)) {
      if (!Object.prototype.hasOwnProperty.call(oldVal, k)) {
        pushOp(acc, counter, maxOps, { op: "add", path: ptr(currentPath, k), value: newVal[k] });
      } else {
        diffValues(oldVal[k], newVal[k], ptr(currentPath, k), depth + 1, acc, counter, maxOps);
      }
    }
    return;
  }

  // Type mismatch (object vs array vs scalar) or differing scalars: single replace.
  // The root itself can't be "replaced" via a RFC 6901 pointer (there is no
  // parent key) — represent a wholesale root change as replace at "".
  pushOp(acc, counter, maxOps, { op: "replace", path: currentPath === "" ? "" : currentPath, value: newVal });
}

/**
 * Diff two JSON/YAML files and produce an RFC 6902 JSON Patch describing
 * how to turn `left` into `right`.
 */
function jsonPatchGenerate(leftResolved, rightResolved, leftClientPath, rightClientPath, opts = {}) {
  let maxOps = parseInt(opts.max_ops, 10);
  if (!Number.isFinite(maxOps) || maxOps <= 0) maxOps = DEFAULT_MAX_OPS;
  maxOps = Math.min(maxOps, HARD_MAX_OPS);

  const { doc: left,  format: leftFmt  } = parseDocument(leftResolved,  opts.format, "left");
  const { doc: right, format: rightFmt } = parseDocument(rightResolved, opts.format, "right");
  const format = opts.format ? String(opts.format).toLowerCase() : leftFmt;

  const acc = [];
  const counter = { total: 0 };
  diffValues(left, right, "", 0, acc, counter, maxOps);

  return {
    left: leftClientPath,
    right: rightClientPath,
    format,
    identical: counter.total === 0,
    opCount: counter.total,
    truncated: counter.total > acc.length,
    ops: acc,
  };
}

module.exports = { jsonPatchGenerate, deepEqual, ptr };
