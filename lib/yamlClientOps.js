"use strict";
// lib/yamlClientOps.js — Zero-dependency YAML 1.2 subset parser/writer
// Pure Node.js fs only. No npm dependencies.
//
// Supported operations:
//   read         — parse a YAML file into a JS object
//   get          — get value at dotted key path
//   set          — set value at dotted key path and rewrite
//   delete       — remove key at dotted key path and rewrite
//   list_keys    — list keys at root or a given section path
//   list_sections — list all mapping/sequence section headers
//   merge        — overlay source YAML over base file
//   stringify    — convert JS object to YAML string
//
// Parser supports (YAML 1.2 common subset):
//   - Block mappings (key: value)
//   - Block sequences (- item)
//   - Flow mappings: {key: val}
//   - Flow sequences: [a, b, c]
//   - Quoted scalars: single, double (with escape sequences)
//   - Block scalars: | (literal) and > (folded) with optional chomping +/-
//   - Implicit typing: null, bool, int, float, string
//   - Comments: # inline and full-line
//   - Multi-document streams (---) — first document returned for read/get
//   - Indentation-based nesting
//
// NOT supported (out of scope):
//   - Anchors/aliases (&anchor/*ref)
//   - Tags (!!type)
//   - Complex keys (? ...)
//   - Multi-document output (stringify always single-doc)

const fs   = require("fs");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE  = 4 * 1024 * 1024;  // 4 MB
const MAX_KEYS       = 50_000;
const MAX_DEPTH      = 20;

// ─── Path/File Guards ─────────────────────────────────────────────────────────

function guardPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0)
    throw new Error("yaml_client: 'path' must be a non-empty string.");
  if (filePath.includes("\x00"))
    throw new Error("yaml_client: 'path' contains NUL byte.");
}

function readYamlFile(filePath) {
  guardPath(filePath);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE)
    throw new Error(`yaml_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`);
  return fs.readFileSync(filePath, "utf8");
}

function writeYamlFile(filePath, content) {
  guardPath(filePath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

/**
 * Very lightweight line-oriented tokenizer.
 * Returns an array of token objects per line:
 *   { lineNo, indent, raw, content, type }
 * type: 'blank' | 'comment' | 'directive' | 'doc_start' | 'doc_end' | 'content'
 */
function tokenizeLines(text) {
  const raw = text.split(/\n/);
  const tokens = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].replace(/\r$/, "");
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    const strippedTrim = trimmed;

    let type;
    if (strippedTrim === "" || strippedTrim === "\r")
      type = "blank";
    else if (strippedTrim.startsWith("#"))
      type = "comment";
    else if (strippedTrim.startsWith("%"))
      type = "directive";
    else if (strippedTrim === "---")
      type = "doc_start";
    else if (strippedTrim === "...")
      type = "doc_end";
    else
      type = "content";

    tokens.push({ lineNo: i + 1, indent, raw: line, stripped: strippedTrim, type });
  }
  return tokens;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse YAML text into a JS value.
 * Returns the first document parsed.
 */
function parseYaml(text, opts = {}) {
  const lines = tokenizeLines(text);
  const state = { lines, pos: 0, keyCount: 0, depth: 0 };

  // Skip leading blanks/comments/directives
  skipNonContent(state);
  // Consume optional ---
  if (state.pos < state.lines.length && state.lines[state.pos].type === "doc_start")
    state.pos++;

  const result = parseValue(state, 0);

  // Key count guard
  if (state.keyCount > MAX_KEYS)
    throw new Error(`yaml_client: document exceeds key limit (${MAX_KEYS}).`);

  return result;
}

function skipNonContent(state) {
  while (state.pos < state.lines.length) {
    const t = state.lines[state.pos].type;
    if (t === "blank" || t === "comment" || t === "directive")
      state.pos++;
    else
      break;
  }
}

function peekLine(state) {
  if (state.pos >= state.lines.length) return null;
  return state.lines[state.pos];
}

/**
 * Parse a YAML value starting at the current position.
 * minIndent: the minimum indent level for block structures.
 */
function parseValue(state, minIndent) {
  if (state.depth > MAX_DEPTH)
    throw new Error(`yaml_client: nesting too deep (max ${MAX_DEPTH}).`);

  skipNonContent(state);

  const line = peekLine(state);
  if (!line || line.type === "doc_end" || line.type === "doc_start") return null;

  const { stripped, indent } = line;

  // Block sequence item
  if (stripped.startsWith("- ") || stripped === "-") {
    return parseBlockSequence(state, indent);
  }

  // Flow sequence
  if (stripped.startsWith("[")) {
    state.pos++;
    return parseFlowSequence(stripped.slice(stripped.indexOf("[") + 1));
  }

  // Flow mapping
  if (stripped.startsWith("{")) {
    state.pos++;
    return parseFlowMapping(stripped.slice(stripped.indexOf("{") + 1));
  }

  // Block scalar (literal |, folded >)
  if (/^[|>]/.test(stripped)) {
    return parseBlockScalar(state, indent);
  }

  // Check if it's a mapping (key: ...)
  if (looksLikeMapping(stripped)) {
    return parseBlockMapping(state, indent);
  }

  // Otherwise: scalar on this line
  state.pos++;
  return parseScalar(stripped);
}

function looksLikeMapping(stripped) {
  // key: or key: value — key must not start with - (that's a sequence)
  // Handles quoted keys too
  if (stripped.startsWith("-")) return false;
  // Find unquoted colon
  let inSingle = false, inDouble = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && ch === ":" && (i + 1 >= stripped.length || /[\s,}\]]/.test(stripped[i + 1])))
      return true;
  }
  return false;
}

function parseBlockMapping(state, baseIndent) {
  // Depth guard here catches mapping-within-mapping recursion that bypasses parseValue
  if (state.depth > MAX_DEPTH)
    throw new Error(`yaml_client: nesting too deep (max ${MAX_DEPTH}).`);
  state.depth++;
  const obj = {};

  while (state.pos < state.lines.length) {
    skipNonContent(state);
    const line = peekLine(state);
    if (!line) break;
    if (line.type === "doc_end" || line.type === "doc_start") break;
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) break; // Sub-items handled by recursive calls

    const stripped = line.stripped;

    // Not a mapping line at this indent
    if (!looksLikeMapping(stripped)) break;

    const colonIdx = findMappingColon(stripped);
    if (colonIdx < 0) break;

    const rawKey = stripped.slice(0, colonIdx).trim();
    const key   = parseScalar(rawKey);
    const after  = stripped.slice(colonIdx + 1).trimStart();

    state.keyCount++;
    if (state.keyCount > MAX_KEYS)
      throw new Error(`yaml_client: document exceeds key limit (${MAX_KEYS}).`);

    state.pos++;

    let value;
    // Check if inline value is a block scalar indicator
    const afterTrimmed = after.split("#")[0].trim();
    if (/^[|>][+\-]?\d*$/.test(afterTrimmed)) {
      // Inline block scalar indicator (e.g. text: |, text: >-, text: |2)
      // Synthesize a fake indicator line and parse block scalar content
      value = parseBlockScalarInline(state, baseIndent + 1, afterTrimmed);
    } else if (after === "") {
      // Value is on next lines — detect type
      skipNonContent(state);
      const nextLine = peekLine(state);
      if (!nextLine || nextLine.indent <= baseIndent) {
        value = null;
      } else if (nextLine.stripped.startsWith("- ") || nextLine.stripped === "-") {
        value = parseBlockSequence(state, nextLine.indent);
      } else if (nextLine.stripped.startsWith("{")) {
        state.pos++;
        value = parseFlowMapping(nextLine.stripped.slice(nextLine.stripped.indexOf("{") + 1));
      } else if (nextLine.stripped.startsWith("[")) {
        state.pos++;
        value = parseFlowSequence(nextLine.stripped.slice(nextLine.stripped.indexOf("[") + 1));
      } else if (/^[|>]/.test(nextLine.stripped)) {
        value = parseBlockScalar(state, nextLine.indent);
      } else if (looksLikeMapping(nextLine.stripped)) {
        value = parseBlockMapping(state, nextLine.indent);
      } else {
        state.pos++;
        value = parseScalar(nextLine.stripped);
      }
    } else {
      // Inline value
      if (after.startsWith("[")) {
        value = parseFlowSequence(after.slice(1));
      } else if (after.startsWith("{")) {
        value = parseFlowMapping(after.slice(1));
      } else {
        value = parseScalar(after.split(" #")[0].trimEnd());
      }
    }

    obj[String(key)] = value;
  }

  state.depth--;
  return obj;
}

function findMappingColon(stripped) {
  // Find the first unquoted `: ` or `:` at end of string
  let inSingle = false, inDouble = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && ch === ":" && (i + 1 >= stripped.length || /[\s,}\[]/.test(stripped[i + 1])))
      return i;
  }
  return -1;
}

function parseBlockSequence(state, baseIndent) {
  // Depth guard here catches sequence-within-sequence recursion that bypasses parseValue
  if (state.depth > MAX_DEPTH)
    throw new Error(`yaml_client: nesting too deep (max ${MAX_DEPTH}).`);
  state.depth++;
  const arr = [];

  while (state.pos < state.lines.length) {
    skipNonContent(state);
    const line = peekLine(state);
    if (!line) break;
    if (line.type === "doc_end" || line.type === "doc_start") break;
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) break; // child handled by sub-call

    const stripped = line.stripped;
    if (!stripped.startsWith("- ") && stripped !== "-") break;

    const rest = stripped === "-" ? "" : stripped.slice(2).trimStart();
    state.pos++;

    let item;
    if (rest === "") {
      // Value on next lines
      skipNonContent(state);
      const nextLine = peekLine(state);
      if (!nextLine || nextLine.indent <= baseIndent) {
        item = null;
      } else if (nextLine.stripped.startsWith("- ") || nextLine.stripped === "-") {
        item = parseBlockSequence(state, nextLine.indent);
      } else if (looksLikeMapping(nextLine.stripped)) {
        item = parseBlockMapping(state, nextLine.indent);
      } else if (/^[|>]/.test(nextLine.stripped)) {
        item = parseBlockScalar(state, nextLine.indent);
      } else {
        state.pos++;
        item = parseScalar(nextLine.stripped);
      }
    } else if (rest.startsWith("[")) {
      item = parseFlowSequence(rest.slice(1));
    } else if (rest.startsWith("{")) {
      item = parseFlowMapping(rest.slice(1));
    } else if (/^[|>]/.test(rest)) {
      // Block scalar after dash — indicator is inline (e.g. `- |`)
      const indStr = rest.split("#")[0].trim();
      item = parseBlockScalarInline(state, baseIndent + 2, indStr);
    } else if (looksLikeMapping(rest)) {
      // Inline map on same line as dash — synthesize as mapping item
      const tmpStripped = rest;
      const colonIdx = findMappingColon(tmpStripped);
      if (colonIdx >= 0) {
        // Parse as a one-line mapping merged with subsequent indented keys
        const tempItem = {};
        const rawKey  = tmpStripped.slice(0, colonIdx).trim();
        const afterKV   = tmpStripped.slice(colonIdx + 1).trimStart();
        const key     = parseScalar(rawKey);
        state.keyCount++;
        skipNonContent(state);
        const nextLine = peekLine(state);
        let val;
        if (afterKV === "") {
          if (!nextLine || nextLine.indent <= baseIndent + 1) {
            val = null;
          } else if (looksLikeMapping(nextLine.stripped)) {
            val = parseBlockMapping(state, nextLine.indent);
          } else {
            state.pos++;
            val = parseScalar(nextLine.stripped);
          }
        } else {
          val = parseScalar(afterKV.split(" #")[0].trimEnd());
        }
        tempItem[String(key)] = val;
        // Check if more mapping keys follow at baseIndent+2
        while (true) {
          skipNonContent(state);
          const nl = peekLine(state);
          if (!nl || nl.indent < baseIndent + 2) break;
          if (!looksLikeMapping(nl.stripped)) break;
          const ci = findMappingColon(nl.stripped);
          if (ci < 0) break;
          const k2 = parseScalar(nl.stripped.slice(0, ci).trim());
          const a2 = nl.stripped.slice(ci + 1).trimStart();
          state.pos++;
          state.keyCount++;
          let v2;
          if (a2 === "") {
            skipNonContent(state);
            const nl2 = peekLine(state);
            if (!nl2 || nl2.indent <= baseIndent + 2) {
              v2 = null;
            } else if (looksLikeMapping(nl2.stripped)) {
              v2 = parseBlockMapping(state, nl2.indent);
            } else {
              state.pos++;
              v2 = parseScalar(nl2.stripped);
            }
          } else {
            v2 = parseScalar(a2.split(" #")[0].trimEnd());
          }
          tempItem[String(k2)] = v2;
        }
        item = tempItem;
      } else {
        item = parseScalar(rest.split(" #")[0].trimEnd());
      }
    } else {
      item = parseScalar(rest.split(" #")[0].trimEnd());
    }

    arr.push(item);
  }

  state.depth--;
  return arr;
}

/**
 * Parse a block scalar where the indicator character was already consumed
 * inline on a mapping/sequence line (e.g. `text: |` or `- >`).  
 * indicator: the indicator string already parsed (e.g. "|", ">", "|+", ">-", "|2")
 * minIndent: the expected content indent
 */
function parseBlockScalarInline(state, minIndent, indicator) {
  const folded = indicator[0] === ">";
  const modifiers = indicator.slice(1).split("#")[0].trim();
  let chomping = "clip";
  if (modifiers.includes("-")) chomping = "strip";
  else if (modifiers.includes("+")) chomping = "keep";

  // Now read content lines (state.pos is already past the indicator key line)
  let blockIndent = -1;
  const contentLines = [];

  while (state.pos < state.lines.length) {
    const l = state.lines[state.pos];
    if (l.type === "doc_end" || l.type === "doc_start") break;
    if (l.type === "blank") {
      contentLines.push("");
      state.pos++;
      continue;
    }
    if (blockIndent < 0) blockIndent = l.indent;
    if (l.indent < blockIndent) break;
    contentLines.push(l.raw.slice(blockIndent));
    state.pos++;
  }

  return assembleBlockScalar(contentLines, folded, chomping);
}

/**
 * Parse a block scalar where the indicator line is still at state.pos.
 * (Used when the indicator `|` or `>` is the start of a new line, not inline.)
 */
function parseBlockScalar(state, minIndent) {
  // We're currently on the indicator line (| or >)
  const line = state.lines[state.pos];
  const stripped = line ? line.stripped : "";
  const indicator = stripped[0] || "|";
  const modifiers = stripped.slice(1).split("#")[0].trim();
  const folded = indicator === ">";
  // Chomping: - strip trailing newlines, + keep all, nothing = clip (one trailing newline)
  let chomping = "clip";
  if (modifiers.includes("-")) chomping = "strip";
  else if (modifiers.includes("+")) chomping = "keep";

  state.pos++; // move past indicator line

  // Determine indent of block content
  let blockIndent = -1;
  const contentLines = [];

  while (state.pos < state.lines.length) {
    const l = state.lines[state.pos];
    if (l.type === "doc_end" || l.type === "doc_start") break;
    // Blank lines are part of the block scalar
    if (l.type === "blank") {
      contentLines.push("");
      state.pos++;
      continue;
    }
    if (blockIndent < 0) blockIndent = l.indent;
    if (l.indent < blockIndent) break; // end of block scalar
    contentLines.push(l.raw.slice(blockIndent));
    state.pos++;
  }

  return assembleBlockScalar(contentLines, folded, chomping);
}

/**
 * Assemble block scalar content lines into a final string per chomping mode.
 */
function assembleBlockScalar(contentLines, folded, chomping) {
  // Remove trailing empty lines based on chomping
  let trailingCount = 0;
  for (let i = contentLines.length - 1; i >= 0; i--) {
    if (contentLines[i] === "") trailingCount++;
    else break;
  }

  if (folded) {
    // Fold: join lines with spaces, except blank lines become newlines
    let result = "";
    const trimmed = contentLines.slice(0, contentLines.length - trailingCount);
    for (let i = 0; i < trimmed.length; i++) {
      const l = trimmed[i];
      if (l === "") {
        result += "\n";
      } else if (i > 0 && trimmed[i - 1] !== "") {
        result += " " + l;
      } else {
        result += l;
      }
    }
    if (chomping === "clip") result += "\n";
    else if (chomping === "keep") result += "\n".repeat(trailingCount + 1);
    return result;
  } else {
    // Literal: join with newlines
    const trimmed = contentLines.slice(0, contentLines.length - trailingCount);
    let result = trimmed.join("\n");
    if (chomping === "clip") result += "\n";
    else if (chomping === "keep") result += "\n".repeat(trailingCount + 1);
    return result;
  }
}

/**
 * Parse a flow sequence from content AFTER the opening `[`.
 * Returns a JS array.
 */
function parseFlowSequence(content) {
  // Strip trailing ]
  const closeIdx = content.lastIndexOf("]");
  const inner = closeIdx >= 0 ? content.slice(0, closeIdx) : content;
  if (inner.trim() === "") return [];
  const items = splitFlowItems(inner);
  return items.map(s => parseScalar(s.trim()));
}

/**
 * Parse a flow mapping from content AFTER the opening `{`.
 * Returns a JS object.
 */
function parseFlowMapping(content) {
  const closeIdx = content.lastIndexOf("}");
  const inner = closeIdx >= 0 ? content.slice(0, closeIdx) : content;
  if (inner.trim() === "") return {};
  const pairs = splitFlowItems(inner);
  const obj = {};
  for (const pair of pairs) {
    const colonIdx = findMappingColon(pair.trim());
    if (colonIdx < 0) continue;
    const k = parseScalar(pair.trim().slice(0, colonIdx).trim());
    const v = parseScalar(pair.trim().slice(colonIdx + 1).trim());
    obj[String(k)] = v;
  }
  return obj;
}

/**
 * Split a flow sequence/mapping content by top-level commas.
 */
function splitFlowItems(content) {
  const items = [];
  let depth  = 0;
  let inSingle = false, inDouble = false;
  let start  = 0;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch === "[" || ch === "{") { depth++; continue; }
    if (ch === "]" || ch === "}") { depth--; continue; }
    if (ch === "," && depth === 0) {
      items.push(content.slice(start, i));
      start = i + 1;
    }
  }
  if (start < content.length)
    items.push(content.slice(start));
  return items.filter(s => s.trim() !== "");
}

/**
 * Parse a scalar YAML value string into JS primitive.
 * Handles: null, bool, int (dec/hex/oct/bin), float, string.
 */
function parseScalar(s) {
  if (typeof s !== "string") return s;
  s = s.trim();

  if (s === "" || s === "null" || s === "~" || s === "Null" || s === "NULL")
    return null;

  if (s === "true"  || s === "True"  || s === "TRUE" ) return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;

  // Double-quoted string
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return parseDoubleQuotedString(s.slice(1, -1));
  }

  // Single-quoted string
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    // Single-quoted: literal, only '' = single quote
    return s.slice(1, -1).replace(/''/g, "'");
  }

  // Integer
  if (/^[-+]?[0-9][0-9_]*$/.test(s)) {
    const n = parseInt(s.replace(/_/g, ""), 10);
    if (!isNaN(n)) return n;
  }
  if (/^0x[0-9a-fA-F_]+$/.test(s)) {
    return parseInt(s.replace(/_/g, ""), 16);
  }
  if (/^0o[0-7_]+$/.test(s)) {
    return parseInt(s.slice(2).replace(/_/g, ""), 8);
  }
  if (/^0b[01_]+$/.test(s)) {
    return parseInt(s.slice(2).replace(/_/g, ""), 2);
  }

  // Float
  if (/^[-+]?(?:\.inf|\.Inf|\.INF)$/.test(s)) {
    return s.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^[-+]?(?:\.nan|\.NaN|\.NAN)$/.test(s)) {
    return NaN;
  }
  if (/^[-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+]?[0-9]+)?$/.test(s) ||
      /^[-+]?\.[0-9_]+(?:[eE][-+]?[0-9]+)?$/.test(s) ||
      /^[-+]?[0-9][0-9_]*[eE][-+]?[0-9]+$/.test(s)) {
    const n = parseFloat(s.replace(/_/g, ""));
    if (!isNaN(n)) return n;
  }

  return s; // plain string
}

function parseDoubleQuotedString(inner) {
  let result = "";
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      switch (next) {
        case 'n':  result += "\n"; i += 2; break;
        case 'r':  result += "\r"; i += 2; break;
        case 't':  result += "\t"; i += 2; break;
        case 'b':  result += "\b"; i += 2; break;
        case 'f':  result += "\f"; i += 2; break;
        case '\\': result += "\\"; i += 2; break;
        case '"':  result += '"';  i += 2; break;
        case "'":  result += "'";  i += 2; break;
        case '/':  result += '/';  i += 2; break;
        case '0':  result += "\0"; i += 2; break;
        case 'a':  result += "\x07"; i += 2; break;
        case 'v':  result += "\x0b"; i += 2; break;
        case 'e':  result += "\x1b"; i += 2; break;
        case 'N':  result += "\x85"; i += 2; break;
        case '_':  result += "\xa0"; i += 2; break;
        case 'L':  result += "\u2028"; i += 2; break;
        case 'P':  result += "\u2029"; i += 2; break;
        case 'x': {
          const hex = inner.slice(i + 2, i + 4);
          result += String.fromCharCode(parseInt(hex, 16));
          i += 4; break;
        }
        case 'u': {
          const hex = inner.slice(i + 2, i + 6);
          result += String.fromCharCode(parseInt(hex, 16));
          i += 6; break;
        }
        case 'U': {
          const hex = inner.slice(i + 2, i + 10);
          const cp = parseInt(hex, 16);
          result += String.fromCodePoint(cp);
          i += 10; break;
        }
        default: result += ch; i++; break;
      }
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

// ─── Stringifier ──────────────────────────────────────────────────────────────

/**
 * Convert a JS value to a YAML string.
 */
function stringifyYaml(value, opts = {}) {
  const indent = opts.indent || 2;
  const lines = stringifyValue(value, 0, indent);
  return lines + "\n";
}

function stringifyValue(value, depth, indent) {
  if (depth > MAX_DEPTH)
    throw new Error(`yaml_client: stringify nesting too deep (max ${MAX_DEPTH}).`);

  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (isNaN(value)) return ".nan";
    if (!isFinite(value)) return value > 0 ? ".inf" : "-.inf";
    return String(value);
  }
  if (typeof value === "string") return stringifyScalarString(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map(item => {
      const v = stringifyValue(item, depth + 1, indent);
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        // Block mapping under sequence: indent keys further
        const lines = v.split("\n");
        const first = `- ${lines[0]}`;
        const rest  = lines.slice(1).map(l => `  ${l}`).join("\n");
        return rest ? first + "\n" + rest : first;
      }
      return `- ${v}`;
    }).join("\n");
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    return keys.map(k => {
      const ks = stringifyScalarString(k);
      const v  = value[k];
      if (Array.isArray(v) && v.length > 0) {
        const items = stringifyValue(v, depth + 1, indent)
          .split("\n")
          .map(l => " ".repeat(indent) + l)
          .join("\n");
        return `${ks}:\n${items}`;
      }
      if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0) {
        const inner = stringifyValue(v, depth + 1, indent)
          .split("\n")
          .map(l => " ".repeat(indent) + l)
          .join("\n");
        return `${ks}:\n${inner}`;
      }
      return `${ks}: ${stringifyValue(v, depth + 1, indent)}`;
    }).join("\n");
  }

  return String(value);
}

/**
 * Stringify a string scalar: choose plain, single-quoted, or double-quoted.
 */
function stringifyScalarString(s) {
  if (typeof s !== "string") return String(s);

  // Must quote reserved YAML keywords
  const reserved = new Set(["null", "~", "true", "false", "Null", "True", "False", "NULL", "TRUE", "FALSE"]);
  if (reserved.has(s)) return `'${s}'`;

  // Must quote if looks like a number
  if (/^[-+]?(?:0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|[0-9][0-9_]*|\.[0-9]+|[0-9]+\.[0-9]*)$/.test(s))
    return `'${s}'`;
  if (/^[-+]?(?:\.inf|\.nan|\.Inf|\.NaN|\.INF|\.NAN)$/i.test(s))
    return `'${s}'`;

  // Must quote if contains special chars
  if (/[:\[\]{}#&*!|>'",%@`]/.test(s) || /^[-?]\s/.test(s) || s.includes("\n") ||
      s.startsWith(" ") || s.endsWith(" ") || s === "") {
    // Use double-quoted if contains newlines or other control chars
    if (s.includes("\n") || s.includes("\r") || s.includes("\t") || /[\x00-\x1f\x7f]/.test(s)) {
      const escaped = s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      return `"${escaped}"`;
    }
    // Single-quoted otherwise
    return `'${s.replace(/'/g, "''")}'`;
  }

  return s;
}

// ─── Key Path Utilities ───────────────────────────────────────────────────────

function parsePath(keyPath) {
  if (!keyPath || typeof keyPath !== "string" || keyPath.trim() === "")
    throw new Error("yaml_client: 'key_path' must be a non-empty string.");
  const parts = keyPath.split(".").map(k => k.trim()).filter(k => k !== "");
  if (parts.length === 0)
    throw new Error(`yaml_client: 'key_path' '${keyPath}' resolves to no valid key segments.`);
  return parts;
}

function getAtPath(obj, parts) {
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = parseInt(part, 10);
      if (isNaN(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setAtPath(obj, parts, value, depth = 0) {
  if (depth > MAX_DEPTH)
    throw new Error(`yaml_client: key path too deep (max ${MAX_DEPTH}).`);
  if (parts.length === 0) return value;
  const [head, ...tail] = parts;

  if (Array.isArray(obj)) {
    const idx = parseInt(head, 10);
    if (isNaN(idx))
      throw new Error(`yaml_client: cannot set key '${head}' on array; use numeric index.`);
    const copy = [...obj];
    copy[idx] = tail.length === 0 ? value : setAtPath(copy[idx] ?? {}, tail, value, depth + 1);
    return copy;
  }

  if (obj === null || obj === undefined) obj = {};
  if (typeof obj !== "object")
    throw new Error(`yaml_client: cannot descend into scalar at key '${head}'.`);

  return {
    ...obj,
    [head]: tail.length === 0 ? value : setAtPath(obj[head] ?? {}, tail, value, depth + 1),
  };
}

function deleteAtPath(obj, parts, depth = 0) {
  if (parts.length === 0) return obj;
  const [head, ...tail] = parts;

  if (Array.isArray(obj)) {
    const idx = parseInt(head, 10);
    if (isNaN(idx))
      throw new Error(`yaml_client: cannot delete key '${head}' from array; use numeric index.`);
    const copy = [...obj];
    if (tail.length === 0) copy.splice(idx, 1);
    else copy[idx] = deleteAtPath(copy[idx], tail, depth + 1);
    return copy;
  }

  if (obj === null || typeof obj !== "object") return obj;
  const copy = { ...obj };
  if (tail.length === 0) {
    delete copy[head];
  } else {
    copy[head] = deleteAtPath(copy[head], tail, depth + 1);
  }
  return copy;
}

/**
 * Deep merge: `source` keys override `base` keys recursively.
 * Arrays are replaced (not merged).
 */
function deepMerge(base, source) {
  if (typeof base !== "object" || base === null ||
      typeof source !== "object" || source === null ||
      Array.isArray(base) || Array.isArray(source)) {
    return source;
  }
  const result = { ...base };
  for (const [k, v] of Object.entries(source)) {
    if (k in result && typeof result[k] === "object" && result[k] !== null &&
        !Array.isArray(result[k]) && typeof v === "object" && v !== null && !Array.isArray(v)) {
      result[k] = deepMerge(result[k], v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Collect section keys: all dotted paths to object/array values.
 */
function collectSections(obj, prefix, out) {
  if (typeof obj !== "object" || obj === null) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++)
      collectSections(obj[i], prefix ? `${prefix}[${i}]` : `[${i}]`, out);
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) {
      out.push(key);
      collectSections(v, key, out);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

function yamlClient(args) {
  const op = args.operation;
  if (!op)
    throw new Error("yaml_client: 'operation' is required.");

  switch (op) {

    // ── READ ─────────────────────────────────────────────────────────────────
    case "read": {
      if (!args.path) throw new Error("yaml_client: 'path' is required for 'read'.");
      const content = readYamlFile(args.path);
      const data    = parseYaml(content);
      const keyCount = data && typeof data === "object" ? Object.keys(data).length : 0;
      return { path: args.path, data, keyCount };
    }

    // ── GET ──────────────────────────────────────────────────────────────────
    case "get": {
      if (!args.path)     throw new Error("yaml_client: 'path' is required for 'get'.");
      if (!args.key_path) throw new Error("yaml_client: 'key_path' is required for 'get'.");
      const content = readYamlFile(args.path);
      const data    = parseYaml(content);
      const parts   = parsePath(args.key_path);
      const value   = getAtPath(data, parts);
      const found   = value !== undefined;
      return { path: args.path, key_path: args.key_path, found, value: found ? value : null };
    }

    // ── SET ──────────────────────────────────────────────────────────────────
    case "set": {
      if (!args.path)              throw new Error("yaml_client: 'path' is required for 'set'.");
      if (!args.key_path)          throw new Error("yaml_client: 'key_path' is required for 'set'.");
      if (args.value === undefined) throw new Error("yaml_client: 'value' is required for 'set'.");
      const content = readYamlFile(args.path);
      let   data    = parseYaml(content) ?? {};
      const parts   = parsePath(args.key_path);
      data = setAtPath(data, parts, args.value);
      const newContent = stringifyYaml(data);
      writeYamlFile(args.path, newContent);
      return { path: args.path, key_path: args.key_path, set: true };
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    case "delete": {
      if (!args.path)     throw new Error("yaml_client: 'path' is required for 'delete'.");
      if (!args.key_path) throw new Error("yaml_client: 'key_path' is required for 'delete'.");
      const content = readYamlFile(args.path);
      let   data    = parseYaml(content) ?? {};
      const parts   = parsePath(args.key_path);
      const existed = getAtPath(data, parts) !== undefined;
      if (existed) {
        data = deleteAtPath(data, parts);
        writeYamlFile(args.path, stringifyYaml(data));
      }
      return { path: args.path, key_path: args.key_path, deleted: existed };
    }

    // ── LIST_KEYS ─────────────────────────────────────────────────────────────
    case "list_keys": {
      if (!args.path) throw new Error("yaml_client: 'path' is required for 'list_keys'.");
      const content = readYamlFile(args.path);
      const data    = parseYaml(content);
      let   target  = data;
      if (args.section) {
        const parts = parsePath(args.section);
        target = getAtPath(data, parts);
      }
      if (target === null || target === undefined)
        return { path: args.path, section: args.section || null, keys: [], keyCount: 0 };
      if (Array.isArray(target)) {
        const keys = target.map((_, i) => String(i));
        return { path: args.path, section: args.section || null, keys, keyCount: keys.length };
      }
      if (typeof target !== "object")
        return { path: args.path, section: args.section || null, keys: [], keyCount: 0 };
      const keys = Object.keys(target);
      return { path: args.path, section: args.section || null, keys, keyCount: keys.length };
    }

    // ── LIST_SECTIONS ─────────────────────────────────────────────────────────
    case "list_sections": {
      if (!args.path) throw new Error("yaml_client: 'path' is required for 'list_sections'.");
      const content  = readYamlFile(args.path);
      const data     = parseYaml(content);
      const sections = [];
      collectSections(data, "", sections);
      return { path: args.path, sections, sectionCount: sections.length };
    }

    // ── MERGE ─────────────────────────────────────────────────────────────────
    case "merge": {
      if (!args.path)        throw new Error("yaml_client: 'path' is required for 'merge' (base file).");
      if (!args.source_path) throw new Error("yaml_client: 'source_path' is required for 'merge'.");
      const baseContent   = readYamlFile(args.path);
      const sourceContent = readYamlFile(args.source_path);
      const baseData      = parseYaml(baseContent) ?? {};
      const sourceData    = parseYaml(sourceContent) ?? {};
      const merged        = deepMerge(baseData, sourceData);
      const outPath       = args.output_path || args.path;
      writeYamlFile(outPath, stringifyYaml(merged));
      return {
        path:        outPath,
        basePath:    args.path,
        sourcePath:  args.source_path,
        baseKeys:    typeof baseData === "object" && !Array.isArray(baseData) ? Object.keys(baseData).length : 0,
        sourceKeys:  typeof sourceData === "object" && !Array.isArray(sourceData) ? Object.keys(sourceData).length : 0,
        mergedKeys:  typeof merged === "object" && !Array.isArray(merged) ? Object.keys(merged).length : 0,
      };
    }

    // ── STRINGIFY ─────────────────────────────────────────────────────────────
    case "stringify": {
      if (args.data === undefined && args.path === undefined)
        throw new Error("yaml_client: 'data' or 'path' is required for 'stringify'.");
      let data = args.data;
      if (data === undefined) {
        const content = readYamlFile(args.path);
        data = parseYaml(content);
      }
      const yaml = stringifyYaml(data);
      if (args.output_path) {
        writeYamlFile(args.output_path, yaml);
        return { output_path: args.output_path, sizeBytes: Buffer.byteLength(yaml, "utf8"), written: true };
      }
      return { yaml, sizeBytes: Buffer.byteLength(yaml, "utf8") };
    }

    default:
      throw new Error(
        `yaml_client: unknown operation '${op}'. Valid: read, get, set, delete, list_keys, list_sections, merge, stringify.`
      );
  }
}

module.exports = {
  yamlClient,
  _parse: {
    parseYaml,
    stringifyYaml,
    parseScalar,
    getAtPath,
    setAtPath,
    deleteAtPath,
    deepMerge,
  },
};
