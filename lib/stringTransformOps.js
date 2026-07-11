"use strict";
// ── string_transform — zero-dep string manipulation tool ─────────────────────
// Operations: camel_case, pascal_case, snake_case, kebab_case, constant_case,
// title_case, sentence_case, dot_case, path_case, slugify, reverse, capitalize,
// decapitalize, trim, trim_start, trim_end, repeat, truncate, pad_start,
// pad_end, pad_center, word_wrap, strip_diacritics, count, swap_case.

const { ToolError } = require("./errors");

const MAX_INPUT = 1 * 1024 * 1024; // 1 MB

// ── helpers ──────────────────────────────────────────────────────────────────

/** Split a string into tokens for case-conversion operations.
 *  Handles: space/hyphen/underscore/dot/slash separators, camelCase, PascalCase.
 */
function tokenize(s) {
  // Insert a space before each uppercase letter that follows a lowercase or digit
  // (camelCase split) and before sequences of uppercase followed by lowercase (acronym split).
  const spaced = s
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  // Split on any run of non-alphanumeric (whitespace, dash, underscore, dot, slash, etc.)
  return spaced.split(/[^a-zA-Z\d]+/).filter(Boolean);
}

/** Strip Unicode combining characters (diacritics) after NFD normalization.
 *  Falls back gracefully if normalize() is unavailable.
 */
function stripDiacritics(s) {
  try {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    return s;
  }
}

/**
 * Wrap text at max_width chars. Respects existing newlines.
 * Words longer than max_width are placed on their own line.
 */
function wordWrap(text, maxWidth, newline) {
  const nl = typeof newline === "string" ? newline : "\n";
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (line.length === 0) { out.push(""); continue; }
    const words = line.split(/ +/);
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
      } else if (current.length + 1 + word.length <= maxWidth) {
        current += " " + word;
      } else {
        out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out.join(nl);
}

// ── main export ──────────────────────────────────────────────────────────────

function stringTransform(args) {
  if (!args || typeof args.input !== "string")
    throw new ToolError("string_transform: 'input' must be a string.", -32602);
  if (args.input.length > MAX_INPUT)
    throw new ToolError(`string_transform: 'input' exceeds 1 MB limit (${args.input.length} bytes).`, -32602);

  const op = (args.operation || "").trim();
  if (!op)
    throw new ToolError("string_transform: 'operation' is required.", -32602);

  const input = args.input;

  switch (op) {
    // ── Case conversions ─────────────────────────────────────────────���────
    case "camel_case": {
      const tokens = tokenize(input);
      if (!tokens.length) return { operation: op, input, result: "" };
      const result = tokens[0].toLowerCase() +
        tokens.slice(1).map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()).join("");
      return { operation: op, input, result };
    }
    case "pascal_case": {
      const tokens = tokenize(input);
      const result = tokens.map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()).join("");
      return { operation: op, input, result };
    }
    case "snake_case": {
      const result = tokenize(input).map(t => t.toLowerCase()).join("_");
      return { operation: op, input, result };
    }
    case "kebab_case": {
      const result = tokenize(input).map(t => t.toLowerCase()).join("-");
      return { operation: op, input, result };
    }
    case "constant_case": {
      const result = tokenize(input).map(t => t.toUpperCase()).join("_");
      return { operation: op, input, result };
    }
    case "dot_case": {
      const result = tokenize(input).map(t => t.toLowerCase()).join(".");
      return { operation: op, input, result };
    }
    case "path_case": {
      const result = tokenize(input).map(t => t.toLowerCase()).join("/");
      return { operation: op, input, result };
    }
    case "title_case": {
      const result = input.replace(/\S+/g, w =>
        w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
      return { operation: op, input, result };
    }
    case "sentence_case": {
      const result = input.charAt(0).toUpperCase() + input.slice(1).toLowerCase();
      return { operation: op, input, result };
    }
    case "swap_case": {
      const result = input.split("").map(c =>
        c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join("");
      return { operation: op, input, result };
    }

    // ── Simple transforms ─────────────────────────────────────────────────
    case "reverse": {
      // Handle surrogate pairs correctly via spread
      const result = [...input].reverse().join("");
      return { operation: op, input, result };
    }
    case "capitalize": {
      const result = input.charAt(0).toUpperCase() + input.slice(1);
      return { operation: op, input, result };
    }
    case "decapitalize": {
      const result = input.charAt(0).toLowerCase() + input.slice(1);
      return { operation: op, input, result };
    }
    case "trim":       return { operation: op, input, result: input.trim() };
    case "trim_start": return { operation: op, input, result: input.trimStart() };
    case "trim_end":   return { operation: op, input, result: input.trimEnd() };

    case "slugify": {
      let result = stripDiacritics(input.toLowerCase());
      result = result.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      return { operation: op, input, result };
    }

    case "strip_diacritics": {
      const result = stripDiacritics(input);
      return { operation: op, input, result };
    }

    case "repeat": {
      const count = typeof args.count === "number" ? args.count : 1;
      if (!Number.isInteger(count) || count < 0 || count > 10000)
        throw new ToolError("string_transform(repeat): 'count' must be an integer 0-10000.", -32602);
      const sep = typeof args.separator === "string" ? args.separator : "";
      const result = Array(count).fill(input).join(sep);
      return { operation: op, input, result, count, separator: sep };
    }

    // ── Length-bounded transforms ─────────────────────────────────────────
    case "truncate": {
      const maxLen = typeof args.max_length === "number" ? args.max_length : null;
      if (maxLen === null || !Number.isInteger(maxLen) || maxLen < 0)
        throw new ToolError("string_transform(truncate): 'max_length' must be a non-negative integer.", -32602);
      const ellipsis = typeof args.ellipsis === "string" ? args.ellipsis : "\u2026"; // …
      if (input.length <= maxLen) {
        return { operation: op, input, result: input, truncated: false, max_length: maxLen };
      }
      // Truncate to (maxLen - ellipsis.length) chars, then append ellipsis.
      // When ellipsis itself is longer than maxLen, clamp by slicing the ellipsis.
      const cutAt = Math.max(0, maxLen - ellipsis.length);
      const result = cutAt > 0
        ? input.slice(0, cutAt) + ellipsis
        : ellipsis.slice(0, maxLen);
      return { operation: op, input, result, truncated: true, max_length: maxLen };
    }

    case "pad_start":
    case "pad_end":
    case "pad_center": {
      const minLen = typeof args.min_length === "number" ? args.min_length : null;
      if (minLen === null || !Number.isInteger(minLen) || minLen < 0 || minLen > 100000)
        throw new ToolError(`string_transform(${op}): 'min_length' must be an integer 0-100000.`, -32602);
      const padChar = typeof args.pad_char === "string" && args.pad_char.length > 0
        ? args.pad_char[0] : " ";
      let result;
      if (input.length >= minLen) {
        result = input;
      } else if (op === "pad_start") {
        result = input.padStart(minLen, padChar);
      } else if (op === "pad_end") {
        result = input.padEnd(minLen, padChar);
      } else {
        // pad_center: distribute padding evenly on both sides
        const totalPad = minLen - input.length;
        const leftPad  = Math.floor(totalPad / 2);
        const rightPad = totalPad - leftPad;
        result = padChar.repeat(leftPad) + input + padChar.repeat(rightPad);
      }
      return { operation: op, input, result, min_length: minLen, pad_char: padChar };
    }

    case "word_wrap": {
      const maxWidth = typeof args.max_width === "number" ? args.max_width : null;
      if (maxWidth === null || !Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 100000)
        throw new ToolError("string_transform(word_wrap): 'max_width' must be an integer 1-100000.", -32602);
      const newline = typeof args.newline === "string" ? args.newline : "\n";
      const result = wordWrap(input, maxWidth, newline);
      const lineCount = result.split(newline).length;
      return { operation: op, input, result, max_width: maxWidth, lines: lineCount };
    }

    // ── Analytics ─────────────────────────────────────────────────────────
    case "count": {
      const chars = [...input].length; // Unicode-aware
      const bytes = Buffer.byteLength(input, "utf8");
      const words = input.trim() === "" ? 0 : input.trim().split(/\s+/).length;
      const lines = input === "" ? 0 : input.split(/\r?\n/).length;
      return { operation: op, input, result: null,
        stats: { chars, bytes, words, lines } };
    }

    default:
      throw new ToolError(
        `string_transform: unknown operation '${op}'. Valid operations: ` +
        "camel_case, pascal_case, snake_case, kebab_case, constant_case, " +
        "dot_case, path_case, title_case, sentence_case, swap_case, " +
        "reverse, capitalize, decapitalize, trim, trim_start, trim_end, " +
        "slugify, strip_diacritics, repeat, truncate, pad_start, pad_end, " +
        "pad_center, word_wrap, count.",
        -32602
      );
  }
}

module.exports = { stringTransform };
