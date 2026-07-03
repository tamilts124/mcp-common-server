"use strict";
// ── QUERY_PATH — JSONPath-style query engine (zero dependencies) ───────────
// Implements a useful, safe subset of the JSONPath specification:
//
//   $            root of the document
//   .key         child key access (dot notation)
//   ['key']      child key access (bracket notation, supports spaces/specials)
//   [N]          array index (non-negative integer)
//   [*]          wildcard — all direct children of an object or array
//   [start:end]  array slice (end exclusive, either side may be omitted; negative indices count from the end)
//   ..           recursive descent (deep scan) — finds matching keys at any depth
//
// Paths may start with $ or omit it (bare paths like "a.b[0]" also work).
// Multiple matches (from [*] or ..) are returned as a JSON array.
// A single match is returned as-is (not wrapped in an array) to mirror
// query_json/query_data behaviour for the common single-result case.
//
// Safety:
//   - All input parsed as a string, never eval'd or exec'd.
//   - Max recursion depth of 50 prevents stack overflow on pathological input.
//   - Max result count of 10 000 prevents memory exhaustion on huge documents.
//   - Circular-reference-free: the source document is never mutated.
//
// Read-only — does not require MCP_ALLOW_EXEC.

const fs   = require("fs");
const path = require("path");

const { parseYaml }    = require("./yamlOps");
const { ToolError }    = require("./errors");

const MAX_DEPTH   = 50;
const MAX_RESULTS = 10_000;

// ── Token types ──────────────────────────────────────────────────────────────
const T_KEY       = "key";       // .foo or ['foo']
const T_INDEX     = "index";     // [0]
const T_SLICE     = "slice";     // [1:3], [1:], [:3], [:]
const T_WILDCARD  = "wildcard";  // [*] or .*
const T_DESCENT   = "descent";   // ..
const T_SELF      = "self";      // $ (root marker, consumed at start)

/**
 * Parse a JSONPath expression into a list of token objects.
 * @param {string} expr  The JSONPath string (e.g. "$.store.book[*].author")
 * @returns {{ type: string, value?: string|number }[]}
 */
function tokenise(expr) {
  if (typeof expr !== "string") throw new ToolError("query_path: 'query' must be a string.", -32602);
  const s = expr.trim();
  if (s.length === 0) return [];          // empty = root document
  if (s.length > 2000) throw new ToolError("query_path: 'query' is too long (max 2000 chars).", -32602);

  const tokens = [];
  let i = 0;

  // Optional leading $
  if (s[i] === "$") {
    tokens.push({ type: T_SELF });
    i++;
  }

  while (i < s.length) {
    // Recursive descent ".."
    if (s[i] === "." && s[i + 1] === ".") {
      tokens.push({ type: T_DESCENT });
      i += 2;
      // After ".." there may be a key name immediately ("..author")
      if (i < s.length && s[i] !== "." && s[i] !== "[") {
        const key = readBareKey(s, i);
        if (key.value !== "*") {
          tokens.push({ type: T_KEY, value: key.value });
        } else {
          tokens.push({ type: T_WILDCARD });
        }
        i = key.end;
      }
      continue;
    }

    // Dot notation ".foo" or ".*"
    if (s[i] === ".") {
      i++;
      if (i >= s.length) throw new ToolError(`query_path: trailing '.' in path.`, -32602);
      const key = readBareKey(s, i);
      if (key.value === "*") {
        tokens.push({ type: T_WILDCARD });
      } else {
        tokens.push({ type: T_KEY, value: key.value });
      }
      i = key.end;
      continue;
    }

    // Bracket notation "[...]"
    if (s[i] === "[") {
      i++;
      if (i >= s.length) throw new ToolError(`query_path: unclosed '['.`, -32602);

      // [*]
      if (s[i] === "*" && s[i + 1] === "]") {
        tokens.push({ type: T_WILDCARD });
        i += 2;
        continue;
      }

      // ['key'] or ["key"]
      if (s[i] === "'" || s[i] === '"') {
        const q = s[i];
        i++;
        let key = "";
        while (i < s.length && s[i] !== q) {
          if (s[i] === "\\" && i + 1 < s.length) { i++; }
          key += s[i++];
        }
        if (i >= s.length) throw new ToolError(`query_path: unclosed string in bracket.`, -32602);
        i++; // consume closing quote
        if (s[i] !== "]") throw new ToolError(`query_path: expected ']' after quoted key.`, -32602);
        i++;
        tokens.push({ type: T_KEY, value: key });
        continue;
      }

      // [N] integer index, or [start:end] slice (either side optional, signed ints allowed)
      function readSignedInt() {
        let str = "";
        if (s[i] === "-") { str += s[i++]; }
        while (i < s.length && s[i] >= "0" && s[i] <= "9") { str += s[i++]; }
        return str;
      }

      const startStr = readSignedInt();
      if (s[i] === ":") {
        i++; // consume ':'
        const endStr = readSignedInt();
        if (s[i] !== "]")
          throw new ToolError(`query_path: invalid slice syntax at position ${i}.`, -32602);
        i++; // consume "]"
        tokens.push({
          type: T_SLICE,
          start: startStr === "" || startStr === "-" ? null : parseInt(startStr, 10),
          end:   endStr   === "" || endStr   === "-" ? null : parseInt(endStr, 10),
        });
        continue;
      }

      if (startStr.length === 0 || startStr === "-" || s[i] !== "]")
        throw new ToolError(`query_path: invalid bracket content at position ${i}.`, -32602);
      i++; // consume "]"
      tokens.push({ type: T_INDEX, value: parseInt(startStr, 10) });
      continue;
    }

    throw new ToolError(`query_path: unexpected character '${s[i]}' at position ${i}.`, -32602);
  }

  return tokens;
}

function readBareKey(s, i) {
  let value = "";
  while (i < s.length && s[i] !== "." && s[i] !== "[") {
    value += s[i++];
  }
  if (value.length === 0) throw new ToolError(`query_path: empty key segment in path.`, -32602);
  return { value, end: i };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Evaluate a token list against a document root.
 * Returns an array of matches.
 */
function evaluate(tokens, root) {
  // Filter out leading T_SELF token — it just marks "$" and carries no traversal info.
  const steps = tokens[0]?.type === T_SELF ? tokens.slice(1) : tokens;
  if (steps.length === 0) return [root];

  const results = [];

  function walk(node, depth) {
    if (depth > MAX_DEPTH) return;
    if (results.length >= MAX_RESULTS) return;

    // Apply all steps in sequence starting from `node`.
    applySteps(node, 0, depth, results);
  }

  function applySteps(node, stepIdx, depth, acc) {
    if (stepIdx >= steps.length) {
      acc.push(node);
      return;
    }
    if (acc.length >= MAX_RESULTS) return;

    const step = steps[stepIdx];
    const next = stepIdx + 1;

    if (step.type === T_KEY) {
      if (node !== null && typeof node === "object" && !Array.isArray(node) &&
          Object.prototype.hasOwnProperty.call(node, step.value)) {
        applySteps(node[step.value], next, depth + 1, acc);
      }
      return;
    }

    if (step.type === T_INDEX) {
      if (Array.isArray(node) && step.value < node.length) {
        applySteps(node[step.value], next, depth + 1, acc);
      }
      return;
    }

    if (step.type === T_SLICE) {
      if (Array.isArray(node)) {
        const len = node.length;
        const normalize = (n, def) => {
          if (n === null) return def;
          return n < 0 ? Math.max(0, len + n) : Math.min(n, len);
        };
        const start = normalize(step.start, 0);
        const end   = normalize(step.end, len);
        for (let idx = start; idx < end && acc.length < MAX_RESULTS; idx++) {
          applySteps(node[idx], next, depth + 1, acc);
        }
      }
      return;
    }

    if (step.type === T_WILDCARD) {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length && acc.length < MAX_RESULTS; i++)
          applySteps(node[i], next, depth + 1, acc);
      } else if (node !== null && typeof node === "object") {
        for (const k of Object.keys(node)) {
          if (acc.length >= MAX_RESULTS) break;
          applySteps(node[k], next, depth + 1, acc);
        }
      }
      return;
    }

    if (step.type === T_DESCENT) {
      // Apply the *remainder* of the path (steps from `next` onward) to the
      // current node AND recursively to all descendants.
      applySteps(node, next, depth, acc);
      descend(node, next, depth, acc);
      return;
    }
  }

  function descend(node, fromStep, depth, acc) {
    if (depth > MAX_DEPTH || acc.length >= MAX_RESULTS) return;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (acc.length >= MAX_RESULTS) break;
        applySteps(child, fromStep, depth + 1, acc);
        descend(child, fromStep, depth + 1, acc);
      }
    } else if (node !== null && typeof node === "object") {
      for (const child of Object.values(node)) {
        if (acc.length >= MAX_RESULTS) break;
        applySteps(child, fromStep, depth + 1, acc);
        descend(child, fromStep, depth + 1, acc);
      }
    }
  }

  walk(root, 0);
  return results;
}

// ── Auto-detect format + parse ───────────────────────────────────────────────

function parseDocument(filePath, format) {
  const raw = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();

  const fmt = format
    ? format.toLowerCase()
    : (ext === ".json" ? "json" : (ext === ".yaml" || ext === ".yml" ? "yaml" : "json"));

  if (fmt !== "json" && fmt !== "yaml")
    throw new ToolError(`query_path: unsupported format '${format}'. Use 'json' or 'yaml'.`, -32602);

  if (fmt === "json") {
    try { return JSON.parse(raw); }
    catch (e) { throw new Error(`query_path: JSON parse error — ${e.message}`); }
  }
  try { return parseYaml(raw) ?? null; }
  catch (e) { throw new Error(`query_path: YAML parse error — ${e.message}`); }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Query a JSON or YAML file using a JSONPath-style expression.
 *
 * @param {string} filePath   Absolute, already-jailed path to the file.
 * @param {string} clientPath Client-relative path echoed in the result.
 * @param {string} query      JSONPath expression (e.g. "$.store.book[*].author").
 * @param {string} [format]   'json' | 'yaml' | '' (auto-detect from extension).
 * @returns {{
 *   path: string, query: string, format: string,
 *   matchCount: number, truncated: boolean,
 *   result: any                      // array when multiple matches, scalar when one
 * }}
 */
function queryPath(filePath, clientPath, query, format) {
  const doc     = parseDocument(filePath, format || "");
  const tokens  = tokenise(query || "");
  const matches = evaluate(tokens, doc);

  const truncated = matches.length >= MAX_RESULTS;
  const ext       = path.extname(filePath).toLowerCase();
  const usedFmt   = format
    ? format.toLowerCase()
    : (ext === ".json" ? "json" : (ext === ".yaml" || ext === ".yml" ? "yaml" : "json"));

  return {
    path:       clientPath,
    query:      query || "",
    format:     usedFmt,
    matchCount: matches.length,
    truncated,
    result:     matches.length === 1 ? matches[0] : matches,
  };
}

module.exports = {
  queryPath, tokenise, evaluate, parseDocument,
  MAX_DEPTH, MAX_RESULTS,
  T_KEY, T_INDEX, T_SLICE, T_WILDCARD, T_DESCENT, T_SELF,
};
