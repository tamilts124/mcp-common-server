"use strict";
// ── TEXT TRANSFORMS & JSON FORMATTING ────────────────────────────────────────
// json_format   — pretty-print or minify a JSON file in-place (write-gated).
// text_transform — apply one or more named transforms to a file's text content
//                  (write-gated when writing back; can also just return result).
//
// Zero dependencies — pure Node.js built-ins.

const fs = require("fs");

// ─────────────────────────────────────────────────────────────────────────────
//  JSON FORMAT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a JSON file, parse it, and re-serialise it (pretty or minified).
 *
 * @param {string}  absPath   Absolute path (jail-validated by caller).
 * @param {string}  origPath  Client path (echoed back).
 * @param {object}  [opts]
 * @param {number}  [opts.indent]   Spaces per indent level (2 = default). 0 = minify.
 * @param {boolean} [opts.in_place] Write the formatted result back to the same file.
 * @returns {{
 *   path: string, indent: number, originalBytes: number, newBytes: number,
 *   formatted: string, writtenInPlace: boolean
 * }}
 */
function jsonFormat(absPath, origPath, opts = {}) {
  const indent = (opts.indent != null) ? Math.max(0, Math.trunc(opts.indent)) : 2;
  const inPlace = !!opts.in_place;

  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new Error(`json_format: cannot read '${origPath}': ${e.message}`); }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error(`json_format: '${origPath}' is not valid JSON: ${e.message}`); }

  // indent=0 → minify (no spaces); otherwise pretty-print
  const formatted = indent === 0
    ? JSON.stringify(parsed)
    : JSON.stringify(parsed, null, indent);

  if (inPlace) {
    try { fs.writeFileSync(absPath, formatted + "\n", "utf8"); }
    catch (e) { throw new Error(`json_format: cannot write '${origPath}': ${e.message}`); }
  }

  return {
    path:           origPath,
    indent,
    originalBytes:  Buffer.byteLength(raw,           "utf8"),
    newBytes:       Buffer.byteLength(formatted + "\n", "utf8"),
    formatted,
    writtenInPlace: inPlace,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEXT TRANSFORM
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TRANSFORMS = new Set([
  "uppercase", "lowercase",
  "trim_lines",         // remove leading/trailing whitespace from each line
  "sort_lines",         // sort lines alphabetically
  "sort_lines_desc",    // sort lines reverse alphabetically
  "dedupe_lines",       // remove duplicate lines (keeps first occurrence)
  "reverse_lines",      // reverse the order of lines
  "remove_blank_lines", // filter out lines that are empty or whitespace-only
]);

/**
 * Apply an ordered list of named text transforms to a file's content.
 *
 * @param {string}   absPath    Absolute path (jail-validated).
 * @param {string}   origPath   Client path (echoed back).
 * @param {string[]} transforms List of transform names from VALID_TRANSFORMS.
 * @param {object}   [opts]
 * @param {boolean}  [opts.in_place]  Write the result back to the file.
 * @returns {{
 *   path: string, transforms: string[], originalLines: number, newLines: number,
 *   originalBytes: number, newBytes: number, result: string, writtenInPlace: boolean
 * }}
 */
function textTransform(absPath, origPath, transforms, opts = {}) {
  if (!Array.isArray(transforms) || transforms.length === 0)
    throw new Error("text_transform: 'transforms' must be a non-empty array of transform names.");

  for (const t of transforms) {
    if (!VALID_TRANSFORMS.has(t))
      throw new Error(
        `text_transform: unknown transform '${t}'. Valid transforms: ${[...VALID_TRANSFORMS].join(", ")}.`
      );
  }

  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new Error(`text_transform: cannot read '${origPath}': ${e.message}`); }

  const inPlace = !!opts.in_place;
  const originalLines = raw.split("\n").length;
  const originalBytes = Buffer.byteLength(raw, "utf8");

  // Apply transforms in order
  let lines = raw.split("\n");
  // If the file ends with a newline the last element is "", don't let it
  // interfere with sort/dedupe operations — we'll re-add it after.
  const trailingNewline = raw.endsWith("\n");
  if (trailingNewline && lines[lines.length - 1] === "") lines.pop();

  for (const t of transforms) {
    switch (t) {
      case "uppercase":
        lines = lines.map(l => l.toUpperCase());
        break;
      case "lowercase":
        lines = lines.map(l => l.toLowerCase());
        break;
      case "trim_lines":
        lines = lines.map(l => l.trim());
        break;
      case "sort_lines":
        lines = [...lines].sort((a, b) => a.localeCompare(b));
        break;
      case "sort_lines_desc":
        lines = [...lines].sort((a, b) => b.localeCompare(a));
        break;
      case "dedupe_lines": {
        const seen = new Set();
        lines = lines.filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
        break;
      }
      case "reverse_lines":
        lines = [...lines].reverse();
        break;
      case "remove_blank_lines":
        lines = lines.filter(l => l.trim() !== "");
        break;
    }
  }

  // Restore trailing newline if original had one
  const result = lines.join("\n") + (trailingNewline ? "\n" : "");

  if (inPlace) {
    try { fs.writeFileSync(absPath, result, "utf8"); }
    catch (e) { throw new Error(`text_transform: cannot write '${origPath}': ${e.message}`); }
  }

  return {
    path:           origPath,
    transforms,
    originalLines,
    newLines:       lines.length,
    originalBytes,
    newBytes:       Buffer.byteLength(result, "utf8"),
    result,
    writtenInPlace: inPlace,
  };
}

module.exports = { jsonFormat, textTransform, VALID_TRANSFORMS };
