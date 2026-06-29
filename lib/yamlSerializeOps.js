"use strict";
// ── MINIMAL ZERO-DEPENDENCY YAML SERIALISER ───────────────────────────────────
// Companion to lib/yamlOps.js (parser).  This file handles the write direction:
// converting a plain JS value (the kind produced by parseYaml) back into a
// well-formed YAML string.
//
// Design constraints — same philosophy as the parser:
//   • Zero npm dependencies.
//   • Covers the subset produced/consumed by this server's YAML tools.
//   • Does NOT round-trip comments or preserve original key order beyond what
//     JavaScript's object iteration guarantees (insertion order for non-integer
//     keys).  If you need comment-preserving round-tripping you need a CST
//     library — that is deliberately out of scope here.
//
// Serialisation rules:
//   null           → "null"
//   boolean        → "true" / "false"
//   integer        → bare integer string
//   float          → bare float string
//   string         → bare (if safe) or double-quoted (if it contains special
//                    chars / looks like another YAML type)
//   array          → block sequence (- item per line), nested recursively
//   plain object   → block mapping (key: value per line), nested recursively
//   Multi-line strings use the literal block scalar style (|) which is both
//   human-readable and round-trippable via the existing parseYaml parser.

const INDENT_UNIT = 2; // spaces per indentation level

// ── Scalar safety heuristic ──────────────────────────────────────────────────
// Returns true if the string can be written unquoted without being
// misinterpreted by a standard YAML parser.

const YAML_SPECIAL = new Set([
  "true", "false", "True", "False", "TRUE", "FALSE",
  "null", "Null", "NULL", "~",
  "yes", "no", "Yes", "No", "YES", "NO",
  "on", "off", "On", "Off", "ON", "OFF",
]);

function needsQuoting(s) {
  if (s === "") return true;                                  // empty → ""
  if (YAML_SPECIAL.has(s)) return true;                      // boolean/null alias
  if (/^\s|\s$/.test(s)) return true;                        // leading/trailing space
  if (/^[-+]?\d+$/.test(s)) return true;                     // integer-like
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true; // float-like
  if (s.startsWith("#") || s.startsWith("&") || s.startsWith("*")) return true;
  if (s.startsWith(":") || s.startsWith("?") || s.startsWith("|") ||
      s.startsWith(">") || s.startsWith("!") || s.startsWith("%")) return true;
  if (s.startsWith("{") || s.startsWith("[") || s.startsWith("`")) return true;
  if (s.startsWith("'") || s.startsWith('"')) return true;
  if (/[:\n\r\t]/.test(s)) return true;                      // colons, newlines
  if (/^---/.test(s) || /^\.\.\./.test(s)) return true;      // document markers
  return false;
}

/** Serialise a string as double-quoted YAML (escaping special chars). */
function quoteScalar(s) {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\x00/g, "\\0")
    .replace(/\x07/g, "\\a")
    .replace(/\x08/g, "\\b")
    .replace(/\t/g, "\\t")
    .replace(/\x0b/g, "\\v")
    .replace(/\x0c/g, "\\f")
    .replace(/\r/g, "\\r")
    .replace(/\x1b/g, "\\e");
  return `"${escaped}"`;
}

/** Serialise a non-object, non-array value to its YAML token. */
function serializeScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!isFinite(value)) return value !== value ? ".nan" : (value > 0 ? ".inf" : "-.inf");
    return String(value);
  }
  if (typeof value === "string") {
    if (needsQuoting(value)) return quoteScalar(value);
    return value;
  }
  return quoteScalar(String(value));
}

// ── Block scalar for multi-line strings ───────────────────────────────────────

/**
 * Build the YAML representation of a multi-line string as a literal block
 * scalar (|).  The returned string looks like:
 *
 *   |-\n<indented lines>
 *   |\n<indented lines>
 *   |+\n<indented lines>
 *
 * The caller is responsible for prepending any "key: " prefix.
 * `contentIndent` is the absolute indentation string for content lines.
 */
function blockScalar(str, contentIndent) {
  const trailingNl = str.match(/\n+$/);
  const trailingCount = trailingNl ? trailingNl[0].length : 0;
  let chomp;
  if (trailingCount === 0) chomp = "-";
  else if (trailingCount === 1) chomp = "";
  else chomp = "+";

  // For clip (default), remove the trailing newline before splitting so we
  // don't get an empty last element that would add an extra blank line.
  let src = str;
  if (chomp === "" && src.endsWith("\n")) src = src.slice(0, -1);

  const lines = src.split("\n").map(l => contentIndent + l).join("\n");
  return `|${chomp}\n${lines}`;
}

// ── Core recursive serialiser ─────────────────────────────────────────────────

/**
 * Serialise `value` into a block of YAML lines at the given `level`.
 * Returns a string (possibly containing embedded newlines).
 * Does NOT have a leading indent on the first token — that is the caller's
 * responsibility (because in "- value" the dash already provides the indent).
 *
 * @param {*}      value
 * @param {number} level  indentation depth of *this* value's own content
 * @returns {string}
 */
function serializeValue(value, level) {
  const indent      = " ".repeat(level * INDENT_UNIT);
  const childIndent = " ".repeat((level + 1) * INDENT_UNIT);

  // null / undefined
  if (value === null || value === undefined) return "null";

  // boolean / number
  if (typeof value === "boolean" || typeof value === "number") {
    return serializeScalar(value);
  }

  // string
  if (typeof value === "string") {
    if (value.includes("\n")) {
      return blockScalar(value, childIndent);
    }
    return serializeScalar(value);
  }

  // Array → block sequence
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const linesBuf = [];
    for (const item of value) {
      // The "- " marker lives at `indent`; the item content lives at `childIndent`.
      const prefix = `${indent}- `;
      if (item === null || item === undefined ||
          typeof item === "boolean" || typeof item === "number") {
        linesBuf.push(`${prefix}${serializeScalar(item)}`);
      } else if (typeof item === "string") {
        if (item.includes("\n")) {
          // block scalar indicator goes on the "- " line
          const bs = blockScalar(item, childIndent);
          // bs = "|chomp\n  line1\n  line2"
          linesBuf.push(`${prefix}${bs}`);
        } else {
          linesBuf.push(`${prefix}${serializeScalar(item)}`);
        }
      } else if (Array.isArray(item)) {
        // nested array — put it on the next line
        const nested = serializeValue(item, level + 1);
        linesBuf.push(`${indent}-`);
        linesBuf.push(nested);
      } else {
        // Mapping as sequence item.
        // YAML format:
        //   - firstKey: firstVal
        //     secondKey: secondVal
        // The "- " provides the visual indent for the first key;
        // subsequent keys are indented by `childIndent` (level+1 spaces).
        const keys = Object.keys(item);
        if (keys.length === 0) {
          linesBuf.push(`${prefix}{}`);
          continue;
        }
        // Inline the first key (no leading indent — "- " provides it)
        const firstKey = keys[0];
        const firstLines = inlineMappingEntry(firstKey, item[firstKey], childIndent);
        linesBuf.push(`${prefix}${firstLines[0]}`);
        for (let r = 1; r < firstLines.length; r++) linesBuf.push(firstLines[r]);

        // Remaining keys at childIndent
        for (let k = 1; k < keys.length; k++) {
          const kn = keys[k];
          const kLines = mappingEntry(kn, item[kn], level + 1);
          for (const l of kLines) linesBuf.push(l);
        }
      }
    }
    return linesBuf.join("\n");
  }

  // Plain object (mapping)
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const linesBuf = [];
    for (const key of keys) {
      const entryLines = mappingEntry(key, value[key], level);
      for (const l of entryLines) linesBuf.push(l);
    }
    return linesBuf.join("\n");
  }

  return quoteScalar(String(value));
}

/**
 * Serialise one key: value mapping entry at `level`.
 * Returns an array of lines (without trailing newlines).
 * All lines carry their own leading indentation.
 *
 * @param {string} key
 * @param {*}      value
 * @param {number} level   indentation level of this mapping's keys
 * @returns {string[]}
 */
function mappingEntry(key, value, level) {
  const indent      = " ".repeat(level * INDENT_UNIT);
  const childIndent = " ".repeat((level + 1) * INDENT_UNIT);
  const safeKey = needsQuoting(String(key)) ? quoteScalar(String(key)) : String(key);

  // null / scalar — inline
  if (value === null || value === undefined) return [`${indent}${safeKey}: null`];
  if (typeof value === "boolean" || typeof value === "number") {
    return [`${indent}${safeKey}: ${serializeScalar(value)}`];
  }
  if (typeof value === "string") {
    if (value.includes("\n")) {
      const bs = blockScalar(value, childIndent);
      // bs starts with "|chomp\n  ..."
      const nlIdx = bs.indexOf("\n");
      const indicator = bs.slice(0, nlIdx);
      const rest = bs.slice(nlIdx + 1);
      return [`${indent}${safeKey}: ${indicator}`, ...rest.split("\n")];
    }
    return [`${indent}${safeKey}: ${serializeScalar(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${safeKey}: []`];
    const block = serializeValue(value, level + 1);
    return [`${indent}${safeKey}:`, ...block.split("\n")];
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return [`${indent}${safeKey}: {}`];
    const block = serializeValue(value, level + 1);
    return [`${indent}${safeKey}:`, ...block.split("\n")];
  }
  return [`${indent}${safeKey}: ${quoteScalar(String(value))}`];
}

/**
 * Like `mappingEntry` but WITHOUT the leading indentation on the first line.
 * Used for the first key in a sequence-item mapping (where "- " provides the
 * visual indent).
 *
 * Returns an array of lines where:
 *   [0] — "key: value"  (no leading spaces)
 *   [1+] — continuation lines (with `childIndent` leading spaces, i.e. level+1)
 *
 * `childIndent` is the absolute indentation string for continuation lines
 * (= the indentation that aligns with the key on line [0]).
 */
function inlineMappingEntry(key, value, childIndent) {
  const safeKey = needsQuoting(String(key)) ? quoteScalar(String(key)) : String(key);

  if (value === null || value === undefined) return [`${safeKey}: null`];
  if (typeof value === "boolean" || typeof value === "number") {
    return [`${safeKey}: ${serializeScalar(value)}`];
  }
  if (typeof value === "string") {
    if (value.includes("\n")) {
      const nestedChildIndent = childIndent + " ".repeat(INDENT_UNIT);
      const bs = blockScalar(value, nestedChildIndent);
      const nlIdx = bs.indexOf("\n");
      const indicator = bs.slice(0, nlIdx);
      const rest = bs.slice(nlIdx + 1);
      return [`${safeKey}: ${indicator}`, ...rest.split("\n")];
    }
    return [`${safeKey}: ${serializeScalar(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${safeKey}: []`];
    // Determine what level childIndent corresponds to and use level+1 for nested
    const nestedLevel = childIndent.length / INDENT_UNIT + 1;
    const block = serializeValue(value, nestedLevel);
    return [`${safeKey}:`, ...block.split("\n")];
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return [`${safeKey}: {}`];
    const nestedLevel = childIndent.length / INDENT_UNIT + 1;
    const block = serializeValue(value, nestedLevel);
    return [`${safeKey}:`, ...block.split("\n")];
  }
  return [`${safeKey}: ${quoteScalar(String(value))}`];
}

/**
 * Serialise a JS value to a YAML string (top-level call).
 * The output always ends with a single newline.
 *
 * @param {*} value
 * @returns {string}
 */
function serializeYaml(value) {
  if (value === null || value === undefined) return "null\n";
  const body = serializeValue(value, 0);
  return body.replace(/\n*$/, "") + "\n";
}

module.exports = { serializeYaml };
