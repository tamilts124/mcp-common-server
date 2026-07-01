"use strict";
// ── DOT-PATH QUERY (JSON / YAML) ────────────────────────────────────────────
// query_json — parse a JSON file and extract a value by dot-path
// query_data — parse a JSON *or* YAML file (by extension) and extract a
//              value by dot-path; YAML parsing is handled by ./yamlOps.js

const fs   = require("fs");
const path = require("path");
const { parseYaml } = require("./yamlOps");

// ── DOT-PATH TRAVERSAL (shared by query_json and query_data) ────────────────
/**
 * Walk a parsed object/array by a dot-notation path and return the resolved
 * value, its type, and the path itself. An empty path returns the root.
 *
 * Path syntax:
 *   - Dot-separated property names:  "a.b.c"
 *   - Array indices are supported:   "items.0.name"  (index 0 of array `items`)
 *   - Escaped dots use backslash:    "a\\.b" matches key "a.b"
 *
 * @param {any}    parsed  Already-parsed document (object, array, or scalar).
 * @param {string} query   Dot-path into the document (empty = root).
 * @returns {{ value: any, path: string, type: string }}
 */
function traverseByPath(parsed, query) {
  if (!query || query.trim() === "") {
    return { value: parsed, path: ".", type: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed };
  }

  // Split on unescaped dots
  const parts = query.split(/(?<!\\)\./).map(p => p.replace(/\\./g, "."));
  let cursor = parsed;
  for (const part of parts) {
    if (cursor === undefined || cursor === null || typeof cursor !== "object")
      throw new Error(`Path '${query}' does not exist in the document (stopped at '${part}').`);
    cursor = cursor[part];
  }

  const type = cursor === null ? "null" : Array.isArray(cursor) ? "array" : typeof cursor;
  return { value: cursor, path: query, type };
}

// ── QUERY JSON ───────────────────────────────────────────────────────────────
/**
 * Parse a JSON file and extract a value by dot-notation path.
 * An empty `query` returns the full parsed document.
 * Kept as a dedicated JSON-only entry point for backward compatibility —
 * see query_data for a format-detecting (JSON or YAML) version.
 *
 * @param {string} filePath  Absolute path to the JSON file.
 * @param {string} query     Dot-path into the parsed object (empty = root).
 * @returns {{ value: any, path: string, type: string }}
 */
function queryJson(filePath, query) {
  const raw    = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw); // throws SyntaxError for invalid JSON
  return traverseByPath(parsed, query);
}

// ── QUERY DATA (JSON or YAML, format detected by extension) ─────────────────
/**
 * Parse a JSON or YAML file (format chosen by file extension) and extract a
 * value by dot-notation path, using the same path syntax as queryJson.
 *
 * Supported extensions: .json -> JSON.parse; .yaml/.yml -> minimal YAML
 * parser (see lib/yamlOps.js for the supported subset and limitations).
 * An explicit `format` argument ("json" | "yaml") overrides extension
 * sniffing, for files with unconventional names/extensions.
 *
 * @param {string} filePath  Absolute path to the file to parse.
 * @param {string} query     Dot-path into the parsed object (empty = root).
 * @param {string} [format]  Optional explicit format override.
 * @returns {{ value: any, path: string, type: string, format: string }}
 */
function queryData(filePath, query, format) {
  const ext = path.extname(filePath).toLowerCase();
  const resolvedFormat = (format || "").toLowerCase() ||
    (ext === ".yaml" || ext === ".yml" ? "yaml" : "json");

  if (resolvedFormat !== "json" && resolvedFormat !== "yaml")
    throw new Error(`Unsupported format '${format}'. Choose 'json' or 'yaml', or omit to detect from the file extension.`);

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = resolvedFormat === "yaml" ? parseYaml(raw) : JSON.parse(raw);
  return { ...traverseByPath(parsed, query), format: resolvedFormat };
}

module.exports = { queryJson, queryData, traverseByPath };
