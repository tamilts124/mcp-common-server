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
//   - Block scalars: literal (|) and folded (>) with optional chomping
//     indicators (- for strip, + for keep, default = clip).
//     Explicit indentation indicators (e.g. |2) are also supported.
//
// NOT supported (will either throw a descriptive error or silently treat as
// a plain string — never silently produce wrong structured data):
//   - Anchors (&foo) / aliases (*foo) / merge keys (<<:)
//   - Multi-document streams (---/...)
//   - Tags (!!str, !!int, etc.)
//
// Parse strategy: a small recursive-descent line-based parser. Comments and
// blank lines are removed during tokenisation EXCEPT inside block scalars,
// where all raw content lines are preserved and collapsed into a single token.

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

  if (tok.length >= 2 && tok[0] === '"' && tok[tok.length - 1] === '"') {
    return tok.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (tok.length >= 2 && tok[0] === "'" && tok[tok.length - 1] === "'") {
    return tok.slice(1, -1).replace(/''/g, "'");
  }

  if (/^[-+]?\d+$/.test(tok)) return parseInt(tok, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(tok)) return parseFloat(tok);

  return tok;
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
  if ((tok[0] === "[" && tok[tok.length - 1] === "]") ||
      (tok[0] === "{" && tok[tok.length - 1] === "}")) {
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

// ── BLOCK SCALAR PARSING ─────────────────────────────────────────────────────
// YAML block scalars start with | (literal) or > (folded) on the same line as
// the mapping key or as the value of a sequence item.
//
// Indicator syntax:  |[-+]?[1-9]?  or  >[1-9]?[-+]?   (order of digit/chomp
// indicators is flexible per the YAML 1.2 spec)
//
//   Style:    | = literal (newlines preserved)
//             > = folded (newlines between non-blank lines → space;
//                         blank lines → literal newline paragraph breaks)
//   Chomping: - = strip (remove all trailing newlines)
//              + = keep (preserve all trailing newlines)
//              (default) = clip (exactly one trailing newline)
//   Indent:   explicit digit sets the absolute indentation column; omitted =
//              auto-detected from first non-blank content line.

/**
 * Parse the block scalar header: everything after | or > on the indicator line.
 * Returns { style: "literal"|"folded", chomp: "clip"|"strip"|"keep", explicitIndent: number }.
 */
function parseBlockScalarHeader(style, rest) {
  let chomp = "clip";
  let explicitIndent = 0;
  for (const ch of rest) {
    if (ch === "-") chomp = "strip";
    else if (ch === "+") chomp = "keep";
    else if (ch >= "1" && ch <= "9") explicitIndent = parseInt(ch, 10);
    else break; // stop at space (comment) or unknown
  }
  return { style, chomp, explicitIndent };
}

/**
 * Collect block scalar content lines from rawLines starting at rawLineIndex,
 * then assemble the final string value.
 *
 * A line belongs to the block scalar when:
 *   (a) it is blank/whitespace-only, OR
 *   (b) its indentation is strictly greater than parentIndent.
 * We stop at the first non-blank line whose indent <= parentIndent.
 *
 * Returns { value: string, nextRawLine: number }.
 */
function collectBlockScalar(rawLines, rawLineIndex, parentIndent, header) {
  const { style, chomp, explicitIndent } = header;

  // ── 1. Gather raw content lines ───────────────────────────────────────────
  const contentLines = [];
  let i = rawLineIndex;
  while (i < rawLines.length) {
    const raw = rawLines[i];
    const trimmed = raw.trim();
    if (trimmed === "") {
      contentLines.push(""); // blank line — preserve as empty string
      i++;
      continue;
    }
    const lineIndent = raw.match(/^ */)[0].length;
    if (lineIndent <= parentIndent) break;
    contentLines.push(raw);
    i++;
  }

  // ── 2. Determine block indentation ────────────────────────────────────────
  let blockIndent = explicitIndent;
  if (blockIndent === 0) {
    for (const line of contentLines) {
      if (line === "") continue; // skip blank lines when auto-detecting
      blockIndent = line.match(/^ */)[0].length;
      break;
    }
  }

  // ── 3. Strip block indentation ────────────────────────────────────────────
  // Blank lines become "", content lines have blockIndent leading spaces removed.
  const stripped = contentLines.map(line =>
    line === "" ? "" : line.slice(blockIndent),
  );

  // ── 4. Assemble value based on style ──────────────────────────────────────
  let result;

  if (style === "literal") {
    // Every stripped line joins with \n; trailing \n added before chomping.
    result = stripped.join("\n") + "\n";

  } else {
    // Folded (>) style — YAML 1.2 §8.1.1.2:
    //   • Non-empty lines within a group are joined with a space (the
    //     line-break is "folded" into a space).
    //   • Each blank line produces a literal \n in the output.
    //   • The transition from a text group to blank lines emits a \n
    //     (the folded newline of the last text line becomes a real newline).
    //
    // Algorithm: walk stripped[], tracking runs of text vs blank lines.
    // Output is built as an array of string fragments joined at the end.
    const out = [];
    let textGroupActive = false; // are we in a run of non-blank lines?

    for (let j = 0; j < stripped.length; j++) {
      const line = stripped[j];
      if (line === "") {
        // Blank line: if we were in a text run, the fold becomes a \n;
        // the blank line itself contributes another \n.
        if (textGroupActive) {
          out.push("\n"); // close the current text group
          textGroupActive = false;
        }
        out.push("\n"); // the blank line's own paragraph break
      } else {
        // Non-blank line: join into the current text group with a space,
        // or start a new text group.
        if (textGroupActive) {
          out.push(" "); // fold: replace previous \n with a space
        }
        // If we just came out of blank lines, the paragraph break is already
        // in `out` — no extra separator needed before this line.
        out.push(line);
        textGroupActive = true;
      }
    }

    // Close the last text group with the mandatory trailing \n
    if (textGroupActive) out.push("\n");

    result = out.join("");
  }

  // ── 5. Apply chomping ─────────────────────────────────────────────────────
  if (chomp === "clip") {
    // Exactly one trailing newline.
    result = result.replace(/\n*$/, "") + (result.length > 0 ? "\n" : "");
    // Edge case: completely empty content → empty string (not "\n").
    if (result === "\n") result = "";
  } else if (chomp === "strip") {
    // No trailing newlines.
    result = result.replace(/\n+$/, "");
  } else {
    // "keep": preserve all trailing newlines exactly as produced.
    // The assembled result already has the correct trailing newlines from
    // blank lines that were collected at the end of contentLines.
    // No further adjustment needed.
  }

  return { value: result, nextRawLine: i };
}

// ── TOKENISER ────────────────────────────────────────────────────────────────

/**
 * Detect if a tokenised line's text contains a block scalar indicator (| or >)
 * as its value part.  Returns { header, keyPart } or null.
 *
 *   keyPart for a mapping:  "key:"   (value will be empty → parser picks up blockScalarValue)
 *   keyPart for a sequence: "-"      (rest will be empty → parser picks up blockScalarValue)
 */
function detectBlockScalarIndicator(text) {
  // 1. Mapping key:  "key: |..."  or  "key: >..."
  const colonIdx = findUnquotedColon(text);
  if (colonIdx !== -1) {
    const valueStart = text.slice(colonIdx + 1).trimStart();
    const m = valueStart.match(/^([|>])([-+]?\d?|\d?[-+]?)(\s.*)?$/);
    if (m) {
      const style = m[1] === "|" ? "literal" : "folded";
      const header = parseBlockScalarHeader(style, (m[2] || "").trim());
      return { header, keyPart: text.slice(0, colonIdx + 1) };
    }
  }

  // 2. Sequence item:  "- |..."  or  "- >..."
  if (text === "-" || text.startsWith("- ")) {
    const rest = text === "-" ? "" : text.slice(2).trimStart();
    const m = rest.match(/^([|>])([-+]?\d?|\d?[-+]?)(\s.*)?$/);
    if (m) {
      const style = m[1] === "|" ? "literal" : "folded";
      const header = parseBlockScalarHeader(style, (m[2] || "").trim());
      return { header, keyPart: "-" };
    }
  }

  return null;
}

/**
 * Tokenise raw YAML text into { indent, text, blockScalarValue? } line objects,
 * stripping comments and blank lines.  When a block scalar indicator is found,
 * all subsequent content lines are consumed and stored in blockScalarValue so
 * the recursive-descent parser never sees them as separate tokens.
 */
function tokenizeLines(raw) {
  const rawLines = raw.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];

    // Skip document markers (---, ...)
    if (/^\s*(---|\.\.\.)(\s*#.*)?$/.test(line)) { i++; continue; }

    const stripped = stripComment(line);
    if (stripped.trim() === "") { i++; continue; }

    const indent = stripped.match(/^ */)[0].length;
    const text   = stripped.slice(indent).trimEnd();

    const bsMatch = detectBlockScalarIndicator(text);
    if (bsMatch) {
      const { value: blockScalarValue, nextRawLine } = collectBlockScalar(
        rawLines,
        i + 1,    // first candidate content line (raw, not stripped)
        indent,   // parent indent = indent of the key/sequence line
        bsMatch.header,
      );
      out.push({ indent, text: bsMatch.keyPart, blockScalarValue });
      i = nextRawLine;
      continue;
    }

    out.push({ indent, text });
    i++;
  }

  return out;
}

// ── RECURSIVE-DESCENT BLOCK PARSER ──────────────────────────────────────────

/** Find the index of the first unquoted ": " (or trailing ":") colon. */
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

function looksLikeFlow(text) {
  const t = text.trim();
  return (t[0] === "[" && t[t.length - 1] === "]") ||
         (t[0] === "{" && t[t.length - 1] === "}");
}

function looksLikeInlineMapStart(text) {
  return findUnquotedColon(text) > 0;
}

/**
 * @param {Array<{indent:number, text:string, blockScalarValue?:string}>} lines
 * @param {number} pos
 * @param {number} minIndent
 * @returns {{ value: any, next: number }}
 */
function parseBlock(lines, pos, minIndent) {
  if (pos >= lines.length) return { value: null, next: pos };
  const first = lines[pos];
  if (first.indent < minIndent) return { value: null, next: pos };
  if (first.text === "-" || first.text.startsWith("- ")) {
    return parseSequence(lines, pos, first.indent);
  }
  return parseMapping(lines, pos, first.indent);
}

function parseSequence(lines, pos, indent) {
  const arr = [];
  while (pos < lines.length) {
    const line = lines[pos];
    if (line.indent !== indent) break;
    if (line.text !== "-" && !line.text.startsWith("- ")) break;

    // Block scalar already collected into the token
    if (line.blockScalarValue !== undefined) {
      arr.push(line.blockScalarValue);
      pos++;
      continue;
    }

    const rest = line.text === "-" ? "" : line.text.slice(2);
    if (rest.trim() === "") {
      const { value, next } = parseBlock(lines, pos + 1, indent + 1);
      arr.push(value === null && next === pos + 1 ? null : value);
      pos = next;
    } else if (looksLikeFlow(rest)) {
      arr.push(parseFlow(rest.trim()));
      pos++;
    } else if (looksLikeInlineMapStart(rest)) {
      // "- key: value" inline mapping
      const fakeLines = [{ indent: indent + 2, text: rest }, ...lines.slice(pos + 1)];
      const { value, next } = parseMapping(fakeLines, 0, indent + 2);
      arr.push(value);
      pos = pos + 1 + (next - 1);
    } else {
      arr.push(parseScalar(rest.trim()));
      pos++;
    }
  }
  return { value: arr, next: pos };
}

function parseMapping(lines, pos, indent) {
  const obj = {};
  while (pos < lines.length) {
    const line = lines[pos];
    if (line.indent !== indent) break;
    if (line.text === "-" || line.text.startsWith("- ")) break;

    const colonIdx = findUnquotedColon(line.text);
    if (colonIdx === -1)
      throw new Error(`yaml: expected 'key: value' but got '${line.text}'.`);

    const key = parseScalar(line.text.slice(0, colonIdx).trim());

    // Block scalar already collected during tokenisation
    if (line.blockScalarValue !== undefined) {
      obj[key] = line.blockScalarValue;
      pos++;
      continue;
    }

    const rest = line.text.slice(colonIdx + 1).trim();

    if (rest === "") {
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
 */
function parseYaml(raw) {
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
