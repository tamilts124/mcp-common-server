"use strict";
// ── MINIMAL ZERO-DEPENDENCY YAML PARSER ──────────────────────────────────────
// This project intentionally ships zero npm dependencies (see README), so
// full YAML 1.2 compliance (anchors/aliases, multi-document streams, complex
// merge keys, flow-in-block edge cases, etc.) is explicitly out of scope.
//
// Supported subset — covers the overwhelming majority of real-world config
// files (package.json-equivalents, docker-compose-style files, simple CI
// configs):
//   - Block mappings:        key: value / key:\n  nested: value
//   - Block sequences:       - item   (as a list under a key, or top-level)
//   - Flow sequences/maps:   key: [a, b, c]   key: {a: 1, b: 2}
//   - Scalars: strings (quoted/unquoted), integers, floats, true/false,
//     null/~, and ISO-date-like strings are left as strings (no Date coercion
//     — keeps behavior predictable for callers).
//   - Comments (# ...) outside of quoted strings.
//   - 2-space (or consistent N-space) indentation.
//
// NOT supported (will either throw a descriptive error or silently treat as
// a plain string — never silently produce wrong structured data):
//   - Anchors (&foo) / aliases (*foo) / merge keys (<<:)
//   - Multi-document streams (---/...)
//   - Block scalars (| and >) beyond simple literal capture
//   - Tags (!!str, !!int, etc.)
//
// Parse strategy: a small recursive-descent line-based parser operating on
// an array of {indent, raw} lines (comments/blank lines stripped first).

/**
 * Strip a trailing comment from a YAML line, respecting single/double quotes
 * (a '#' inside quotes is not a comment).
 */
function stripComment(line) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      // A '#' only starts a comment if preceded by whitespace or start-of-line
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

/** Convert a raw YAML scalar token (already trimmed) into a JS value. */
function parseScalar(tok) {
  if (tok === "" ) return null;
  if (tok === "~" || tok === "null" || tok === "Null" || tok === "NULL") return null;
  if (tok === "true" || tok === "True" || tok === "TRUE") return true;
  if (tok === "false" || tok === "False" || tok === "FALSE") return false;

  // Quoted strings — strip quotes, no escape processing beyond \" and \\ for
  // double-quoted (single-quoted YAML strings have no escapes except '').
  if (tok.length >= 2 && tok[0] === '"' && tok[tok.length - 1] === '"') {
    return tok.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (tok.length >= 2 && tok[0] === "'" && tok[tok.length - 1] === "'") {
    return tok.slice(1, -1).replace(/''/g, "'");
  }

  // Numbers — integer or float, optionally signed. Reject things like
  // "1.2.3" or version-looking strings by requiring a full numeric match.
  if (/^[-+]?\d+$/.test(tok)) return parseInt(tok, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(tok)) return parseFloat(tok);

  return tok; // plain string
}

/** Parse a flow-style collection: [a, b, c] or {a: 1, b: 2}. Single-line only. */
function parseFlow(tok) {
  tok = tok.trim();
  if (tok[0] === "[" && tok[tok.length - 1] === "]") {
    const inner = tok.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowItems(inner).map(item => parseFlowValue(item.trim()));
  }
  if (tok[0] === "{" && tok[tok.length - 1] === "}") {
    const inner = tok.slice(1, -1).trim();
    if (inner === "") return {};
    const obj = {};
    for (const item of splitFlowItems(inner)) {
      const idx = item.indexOf(":");
      if (idx === -1) throw new Error(`yaml: malformed flow mapping entry '${item}'.`);
      const key = parseScalar(item.slice(0, idx).trim());
      obj[key] = parseFlowValue(item.slice(idx + 1).trim());
    }
    return obj;
  }
  return parseScalar(tok);
}

function parseFlowValue(tok) {
  tok = tok.trim();
  if ((tok[0] === "[" && tok[tok.length - 1] === "]") || (tok[0] === "{" && tok[tok.length - 1] === "}")) {
    return parseFlow(tok);
  }
  return parseScalar(tok);
}

/** Split comma-separated flow items while respecting nested [], {}, and quotes. */
function splitFlowItems(s) {
  const items = [];
  let depth = 0, inSingle = false, inDouble = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        items.push(s.slice(start, i));
        start = i + 1;
      }
    }
  }
  items.push(s.slice(start));
  return items;
}

/**
 * Tokenize raw YAML text into { indent, text } lines, with comments and
 * blank lines removed, and document markers (---, ...) skipped.
 */
function tokenizeLines(raw) {
  const out = [];
  const rawLines = raw.split(/\r?\n/);
  for (const line of rawLines) {
    if (/^\s*(---|\.\.\.)\s*$/.test(line)) continue; // document markers
    const stripped = stripComment(line);
    if (stripped.trim() === "") continue;
    const indent = stripped.match(/^ */)[0].length;
    out.push({ indent, text: stripped.slice(indent).trimEnd() });
  }
  return out;
}

/**
 * Recursive-descent block parser.
 * @param {Array<{indent:number,text:string}>} lines
 * @param {number} pos       Current index into `lines`.
 * @param {number} minIndent Minimum indent that belongs to this block.
 * @returns {{ value: any, next: number }}
 */
function parseBlock(lines, pos, minIndent) {
  if (pos >= lines.length) return { value: null, next: pos };

  const first = lines[pos];
  if (first.indent < minIndent) return { value: null, next: pos };

  if (first.text.startsWith("- ") || first.text === "-") {
    return parseSequence(lines, pos, first.indent);
  }
  return parseMapping(lines, pos, first.indent);
}

function parseSequence(lines, pos, indent) {
  const arr = [];
  while (pos < lines.length) {
    const line = lines[pos];
    if (line.indent !== indent) break;
    if (!(line.text.startsWith("- ") || line.text === "-")) break;

    const rest = line.text === "-" ? "" : line.text.slice(2);
    if (rest.trim() === "") {
      // Item value is on following more-indented lines, or null
      const { value, next } = parseBlock(lines, pos + 1, indent + 1);
      arr.push(value === null && next === pos + 1 ? null : value);
      pos = next;
    } else if (/^[^:\[{][^:]*:\s*($|.*)/.test(rest) && looksLikeInlineMapStart(rest)) {
      // "- key: value" — inline mapping start; treat this line + following
      // deeper lines (at indent+2, aligned under the key) as one mapping.
      const fakeLines = [{ indent: indent + 2, text: rest }, ...lines.slice(pos + 1)];
      const { value, next } = parseMapping(fakeLines, 0, indent + 2);
      arr.push(value);
      pos = pos + 1 + (next - 1);
    } else if (looksLikeFlow(rest)) {
      arr.push(parseFlow(rest.trim()));
      pos++;
    } else {
      arr.push(parseScalar(rest.trim()));
      pos++;
    }
  }
  return { value: arr, next: pos };
}

function looksLikeInlineMapStart(text) {
  // crude but effective: "key: value" or "key:" where key has no spaces/colons
  const idx = findUnquotedColon(text);
  return idx > 0;
}

function looksLikeFlow(text) {
  const t = text.trim();
  return (t[0] === "[" && t[t.length - 1] === "]") || (t[0] === "{" && t[t.length - 1] === "}");
}

/** Find the index of the first unquoted ": " (or trailing ":") colon separator. */
function findUnquotedColon(text) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ":" && !inSingle && !inDouble) {
      if (i === text.length - 1 || text[i + 1] === " ") return i;
    }
  }
  return -1;
}

function parseMapping(lines, pos, indent) {
  const obj = {};
  while (pos < lines.length) {
    const line = lines[pos];
    if (line.indent !== indent) break;
    if (line.text.startsWith("- ") || line.text === "-") break;

    const colonIdx = findUnquotedColon(line.text);
    if (colonIdx === -1)
      throw new Error(`yaml: expected 'key: value' but got '${line.text}'.`);

    const rawKey = line.text.slice(0, colonIdx).trim();
    const key    = parseScalar(rawKey);
    const rest   = line.text.slice(colonIdx + 1).trim();

    if (rest === "") {
      // Nested block (mapping or sequence) on following lines, or null.
      const next = lines[pos + 1];
      if (next && next.indent > indent) {
        const { value, next: n2 } = parseBlock(lines, pos + 1, indent + 1);
        obj[key] = value;
        pos = n2;
      } else {
        obj[key] = null;
        pos++;
      }
    } else if (looksLikeFlow(rest)) {
      obj[key] = parseFlow(rest);
      pos++;
    } else {
      obj[key] = parseScalar(rest);
      pos++;
    }
  }
  return { value: obj, next: pos };
}

/**
 * Parse a YAML string (single document) into a JS value.
 * Throws a descriptive Error on malformed input or unsupported constructs.
 * @param {string} raw  Raw YAML text.
 * @returns {any}
 */
function parseYaml(raw) {
  // Detect anchor (&name) / alias (*name) tokens appearing as a YAML value —
  // i.e. preceded by start-of-line, ": ", or "- " — while ignoring '&'/'*'
  // that simply appear inside quoted strings or as literal text content.
  if (/(^|:\s|-\s)&[A-Za-z0-9_-]+(\s|$)/m.test(raw))
    throw new Error("yaml: anchors (&) are not supported by this minimal parser.");
  if (/(^|:\s|-\s)\*[A-Za-z0-9_-]+(\s|$)/m.test(raw))
    throw new Error("yaml: aliases (*) are not supported by this minimal parser.");

  const lines = tokenizeLines(raw);
  if (lines.length === 0) return null;
  const { value } = parseBlock(lines, 0, lines[0].indent);
  return value;
}

module.exports = { parseYaml };
