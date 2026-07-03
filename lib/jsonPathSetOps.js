"use strict";
// ── JSON_PATH_SET — mutate a JSON/YAML file by JSONPath query ─────────────
// Write companion to the read-only query_path tool. Supports a safe subset
// of JSONPath for the LOCATION being mutated: key access (.foo/['foo']),
// array index ([N], including one-past-the-end for append), and wildcard
// ([*]/.*). Array slice ([a:b]) and recursive descent (..) are rejected
// with a clear validation error — they're ambiguous/dangerous as a mutation
// target (which of many possible parents would "win"?), so query_path
// remains the tool for that read-only exploration.
//
// Two operations:
//   set    — args.value (JSON text) is parsed and assigned at every location
//            matched by the query (a fresh clone per match, so multiple
//            matches never end up sharing one mutable object by reference).
//   delete — the matched key/index is removed. For arrays, all matched
//            indices under the same array are collected first and spliced
//            out highest-index-first so earlier deletions never shift the
//            index of a later one.
//
// The file is parsed (JSON or YAML, auto-detected or forced via `format`),
// mutated in memory, re-serialised, and written back. Pass apply:false for
// a dry-run. This is a write-gated tool (disabled under MCP_READ_ONLY=true).

const fs   = require("fs");
const path = require("path");

const {
  tokenise, parseDocument, MAX_DEPTH, MAX_RESULTS,
  T_KEY, T_INDEX, T_SLICE, T_WILDCARD, T_DESCENT, T_SELF,
} = require("./jsonPathOps");
const { serializeYaml } = require("./yamlSerializeOps");
const { ToolError } = require("./errors");

function stripSelf(tokens) {
  return tokens[0]?.type === T_SELF ? tokens.slice(1) : tokens;
}

/** Throws if the query contains a step type unsupported for mutation. */
function assertMutable(steps) {
  for (const step of steps) {
    if (step.type === T_SLICE) {
      throw new ToolError("json_path_set: array slice ([a:b]) is not supported as a mutation target — use an explicit index or [*].", -32602);
    }
    if (step.type === T_DESCENT) {
      throw new ToolError("json_path_set: recursive descent ('..') is not supported as a mutation target — use an explicit key path.", -32602);
    }
  }
}

/**
 * Walk `root` per `steps`, collecting { container, key } for every location
 * the query matches (container is the direct parent object/array, key is
 * the string property name or numeric array index to mutate on it).
 */
function collectTargets(root, steps) {
  const targets = [];

  function walk(node, stepIdx, depth) {
    if (depth > MAX_DEPTH || targets.length >= MAX_RESULTS) return;
    const step = steps[stepIdx];
    const isLast = stepIdx === steps.length - 1;

    if (step.type === T_KEY) {
      if (node === null || typeof node !== "object" || Array.isArray(node)) return;
      if (isLast) {
        targets.push({ container: node, key: step.value });
      } else if (Object.prototype.hasOwnProperty.call(node, step.value)) {
        walk(node[step.value], stepIdx + 1, depth + 1);
      }
      return;
    }

    if (step.type === T_INDEX) {
      if (!Array.isArray(node)) return;
      if (isLast) {
        if (step.value < 0 || step.value > node.length) {
          throw new ToolError(`json_path_set: index ${step.value} out of bounds (array length ${node.length}; use ${node.length} to append).`, -32602);
        }
        targets.push({ container: node, key: step.value });
      } else if (step.value >= 0 && step.value < node.length) {
        walk(node[step.value], stepIdx + 1, depth + 1);
      }
      return;
    }

    if (step.type === T_WILDCARD) {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length && targets.length < MAX_RESULTS; i++) {
          if (isLast) targets.push({ container: node, key: i });
          else walk(node[i], stepIdx + 1, depth + 1);
        }
      } else if (node !== null && typeof node === "object") {
        for (const k of Object.keys(node)) {
          if (targets.length >= MAX_RESULTS) break;
          if (isLast) targets.push({ container: node, key: k });
          else walk(node[k], stepIdx + 1, depth + 1);
        }
      }
      return;
    }
  }

  walk(root, 0, 0);
  return targets;
}

/**
 * Mutate a JSON or YAML file by JSONPath query: set or delete every
 * location the query matches.
 *
 * @param {string} resolvedPath  Absolute, jail-checked path to the file.
 * @param {string} origPath      Client-relative path echoed in the result.
 * @param {string} query         JSONPath expression (key/index/wildcard steps only).
 * @param {object} [opts]
 * @param {string}  [opts.value]     JSON text for the value to set (required unless opts.delete).
 * @param {boolean} [opts.delete]    Delete matched locations instead of setting (default false).
 * @param {string}  [opts.format]    'json' | 'yaml' | '' (auto-detect from extension).
 * @param {boolean} [opts.apply]     Write back to disk (default true).
 * @param {number}  [opts.indent]    Indent width for JSON output (default 2, clamped 0-8).
 */
function jsonPathSet(resolvedPath, origPath, query, opts = {}) {
  const isDelete = opts.delete === true;

  if (!isDelete && (typeof opts.value !== "string" || opts.value.trim() === "")) {
    throw new ToolError("json_path_set: 'value' (JSON text) is required unless 'delete' is true.", -32602);
  }

  let parsedValue;
  if (!isDelete) {
    try { parsedValue = JSON.parse(opts.value); }
    catch (e) { throw new ToolError(`json_path_set: 'value' is not valid JSON: ${e.message}`, -32602); }
  }

  const tokens = tokenise(query || "");
  const steps  = stripSelf(tokens);
  if (steps.length === 0) {
    throw new ToolError("json_path_set: query must reference at least one key/index — the bare root ('$') cannot be set or deleted by this tool.", -32602);
  }
  assertMutable(steps);

  const ext = path.extname(resolvedPath).toLowerCase();
  const fmt = opts.format
    ? opts.format.toLowerCase()
    : (ext === ".json" ? "json" : (ext === ".yaml" || ext === ".yml" ? "yaml" : "json"));
  if (fmt !== "json" && fmt !== "yaml") {
    throw new ToolError(`json_path_set: unsupported format '${opts.format}'. Use 'json' or 'yaml'.`, -32602);
  }

  const src = fs.readFileSync(resolvedPath, "utf8");
  const originalSize = Buffer.byteLength(src, "utf8");
  const doc = parseDocument(resolvedPath, fmt);

  const targets = collectTargets(doc, steps);

  if (isDelete) {
    // Group by container; for arrays, splice highest-index-first so an
    // earlier splice never shifts the index of a later one in the same batch.
    const byContainer = new Map();
    for (const t of targets) {
      if (!byContainer.has(t.container)) byContainer.set(t.container, []);
      byContainer.get(t.container).push(t.key);
    }
    for (const [container, keys] of byContainer) {
      if (Array.isArray(container)) {
        [...new Set(keys)].sort((a, b) => b - a).forEach((idx) => container.splice(idx, 1));
      } else {
        for (const k of keys) delete container[k];
      }
    }
  } else {
    for (const t of targets) {
      // Clone per-match so multiple matches never alias the same object.
      t.container[t.key] = targets.length > 1 ? JSON.parse(JSON.stringify(parsedValue)) : parsedValue;
    }
  }

  let indent = parseInt(opts.indent, 10);
  if (!Number.isFinite(indent) || indent < 0) indent = 2;
  indent = Math.min(indent, 8);

  const serialised = fmt === "json"
    ? JSON.stringify(doc, null, indent) + "\n"
    : serializeYaml(doc);
  const newSize = Buffer.byteLength(serialised, "utf8");

  const apply = opts.apply !== false;
  if (apply) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, serialised, "utf8");
  }

  return {
    path: origPath,
    query: query || "",
    format: fmt,
    operation: isDelete ? "delete" : "set",
    matchCount: targets.length,
    apply,
    originalSize,
    newSize,
    result: doc,
  };
}

module.exports = { jsonPathSet };
