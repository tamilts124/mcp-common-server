"use strict";
// ── XML PARSE ────────────────────────────────────────────────────────────────
// Zero-dependency pure-JS XML → JSON AST parser + optional path query.
// Supports: XML declarations, elements, attributes (quoted with " or '),
//   text nodes, CDATA sections (<![CDATA[...]]>), comments (<!-- ... -->),
//   processing instructions (<?...?>), self-closing tags, namespaces (preserved
//   as part of tag/attr name, not resolved), nested elements.
// Does NOT support: DTD declarations, entity references (only &amp; &lt; &gt;
//   &quot; &apos; and &#nnn; are decoded), XML schemas.
// AST node shape:
//   { tag, attrs: {k:v}, text: string, children: [...nodes] }
//   Text-only nodes have tag === "#text" and no attrs/children.
// Path query: "a.b.1.c" selects node at path, treating arrays by index;
//   a numeric segment is an array-index into siblings with the same tag, or
//   into the children array if the segment is purely numeric.
// Returns { root, declaration: { version, encoding, standalone } | null,
//   nodeCount, maxDepth, query?, queryResult? }.

const MAX_INPUT = 4 * 1024 * 1024; // 4 MB

// ── Entity decoder ─────────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: "\u00A0", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", ldquo: "\u201C",
  rdquo: "\u201D", lsquo: "\u2018", rsquo: "\u2019",
};

function decodeEntities(str) {
  return str.replace(/&(?:(#x[0-9a-fA-F]+)|(#\d+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, hex, dec, name) => {
    if (hex)  return String.fromCodePoint(parseInt(hex.slice(2), 16));
    if (dec)  return String.fromCodePoint(parseInt(dec.slice(1), 10));
    if (name && NAMED_ENTITIES[name]) return NAMED_ENTITIES[name];
    return m; // unknown entity: leave as-is
  });
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────
// Types: START_TAG, END_TAG, SELF_CLOSE, TEXT, COMMENT, CDATA, PI, DECL

function tokenize(xml) {
  const tokens = [];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    if (xml[i] === "<") {
      // Comment: <!-- ... -->
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i + 4);
        if (end === -1) throw new Error(`XML parse error: unclosed comment at offset ${i}`);
        tokens.push({ type: "COMMENT", text: xml.slice(i + 4, end) });
        i = end + 3;
        continue;
      }
      // CDATA: <![CDATA[...]]>
      if (xml.startsWith("<![CDATA[", i)) {
        const end = xml.indexOf("]]>", i + 9);
        if (end === -1) throw new Error(`XML parse error: unclosed CDATA at offset ${i}`);
        tokens.push({ type: "CDATA", text: xml.slice(i + 9, end) });
        i = end + 3;
        continue;
      }
      // DOCTYPE / other declarations: <!...>
      if (xml.startsWith("<!", i)) {
        const end = xml.indexOf(">", i + 2);
        if (end === -1) throw new Error(`XML parse error: unclosed declaration at offset ${i}`);
        tokens.push({ type: "DECL_OTHER", text: xml.slice(i + 2, end) });
        i = end + 1;
        continue;
      }
      // Processing instruction: <?...?>
      if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i + 2);
        if (end === -1) throw new Error(`XML parse error: unclosed processing instruction at offset ${i}`);
        const piContent = xml.slice(i + 2, end);
        tokens.push({ type: "PI", text: piContent });
        i = end + 2;
        continue;
      }
      // End tag: </name>
      if (xml[i + 1] === "/") {
        const end = xml.indexOf(">", i + 2);
        if (end === -1) throw new Error(`XML parse error: unclosed end tag at offset ${i}`);
        const name = xml.slice(i + 2, end).trim();
        tokens.push({ type: "END_TAG", name });
        i = end + 1;
        continue;
      }
      // Start tag or self-closing: <name attrs... > or <name attrs... />
      {
        const gtIdx = findTagEnd(xml, i + 1, n);
        if (gtIdx === -1) throw new Error(`XML parse error: unclosed tag at offset ${i}`);
        const tagContent = xml.slice(i + 1, gtIdx);
        const selfClose = tagContent.endsWith("/");
        const body = selfClose ? tagContent.slice(0, -1).trimEnd() : tagContent;
        const { name, attrs } = parseTagHead(body);
        tokens.push({ type: selfClose ? "SELF_CLOSE" : "START_TAG", name, attrs });
        i = gtIdx + 1;
        continue;
      }
    }
    // Text
    const gtIdx = xml.indexOf("<", i);
    const rawText = gtIdx === -1 ? xml.slice(i) : xml.slice(i, gtIdx);
    if (rawText) tokens.push({ type: "TEXT", text: decodeEntities(rawText) });
    i = gtIdx === -1 ? n : gtIdx;
  }
  return tokens;
}

/** Find the index of '>' closing a tag, respecting attribute quoting. */
function findTagEnd(xml, start, n) {
  let i = start;
  while (i < n) {
    const c = xml[i];
    if (c === '"' || c === "'") {
      const close = xml.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close + 1;
    } else if (c === ">") {
      return i;
    } else {
      i++;
    }
  }
  return -1;
}

/** Parse tag name and attributes from raw tag body (after '<' before '>'). */
function parseTagHead(body) {
  body = body.trim();
  // Tag name: everything up to first whitespace
  const spaceIdx = body.search(/\s/);
  const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
  const attrStr = spaceIdx === -1 ? "" : body.slice(spaceIdx).trim();
  const attrs = parseAttrs(attrStr);
  return { name: name.trim(), attrs };
}

/** Parse attribute string into key-value object. */
function parseAttrs(str) {
  const attrs = {};
  const re = /([^\s=/"'<>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[key] = decodeEntities(val);
  }
  return attrs;
}

// ── AST builder ────────────────────────────────────────────────────────────────

function buildTree(tokens) {
  let declaration = null;
  let nodeCount = 0;
  let maxDepth = 0;

  // Parse XML declaration (first PI token named "xml")
  const firstPI = tokens.find(t => t.type === "PI");
  if (firstPI) {
    const piText = firstPI.text.trim();
    if (piText.startsWith("xml")) {
      const verM  = piText.match(/version\s*=\s*["']([^"']+)["']/);
      const encM  = piText.match(/encoding\s*=\s*["']([^"']+)["']/);
      const staM  = piText.match(/standalone\s*=\s*["']([^"']+)["']/);
      declaration = {
        version:    verM  ? verM[1]  : null,
        encoding:   encM  ? encM[1]  : null,
        standalone: staM  ? staM[1]  : null,
      };
    }
  }

  // Build element tree
  const stack = [];
  let root = null;

  for (const tok of tokens) {
    if (tok.type === "COMMENT" || tok.type === "PI" || tok.type === "DECL_OTHER") continue;

    if (tok.type === "START_TAG") {
      nodeCount++;
      const node = { tag: tok.name, attrs: tok.attrs, children: [], text: "" };
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        if (root) throw new Error(`XML parse error: multiple root elements (found second root '${tok.name}').`);
        root = node;
      }
      stack.push(node);
      maxDepth = Math.max(maxDepth, stack.length);
      continue;
    }

    if (tok.type === "SELF_CLOSE") {
      nodeCount++;
      const node = { tag: tok.name, attrs: tok.attrs, children: [], text: "" };
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        if (root) throw new Error(`XML parse error: multiple root elements.`);
        root = node;
      }
      maxDepth = Math.max(maxDepth, stack.length + 1);
      continue;
    }

    if (tok.type === "END_TAG") {
      if (stack.length === 0)
        throw new Error(`XML parse error: unexpected end tag </${tok.name}> with no open element.`);
      const top = stack[stack.length - 1];
      if (top.tag !== tok.name) {
        throw new Error(`XML parse error: mismatched tags — opened <${top.tag}> closed by </${tok.name}>.`);
      }
      // Consolidate direct text content
      top.text = top.children
        .filter(c => c.tag === "#text")
        .map(c => c.text)
        .join("");
      // Remove #text children that are just whitespace and there are element siblings
      const hasElements = top.children.some(c => c.tag !== "#text");
      if (hasElements) {
        top.children = top.children.filter(c => c.tag !== "#text" || c.text.trim());
        top.children.forEach(c => { if (c.tag === "#text") c.text = c.text.trim(); });
        // Remove whitespace-only #text nodes entirely
        top.children = top.children.filter(c => c.tag !== "#text" || c.text.length > 0);
      }
      stack.pop();
      continue;
    }

    if (tok.type === "TEXT" || tok.type === "CDATA") {
      const text = tok.text;
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        // Only add non-whitespace-only text nodes (or CDATA always)
        if (tok.type === "CDATA" || text.trim()) {
          parent.children.push({ tag: "#text", text, attrs: {}, children: [] });
        }
      }
      continue;
    }
  }

  if (stack.length > 0) {
    throw new Error(`XML parse error: unclosed element(s): ${stack.map(n => `<${n.tag}>`).join(", ")}.`);
  }

  return { root, declaration, nodeCount, maxDepth };
}

// ── Path query ─────────────────────────────────────────────────────────────────
// "a.b.2.c" — each segment is either:
//   - A tag name → match first child with that tag (or all if used as list context)
//   - A number   → index into children or into same-tag siblings

function queryNode(node, path) {
  if (!path || path === "") return node;

  const segments = path.split(".").map(s => s.trim()).filter(s => s !== "");
  let current = node;

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (!current) return null;

    // Numeric segment: index into children array
    if (/^\d+$/.test(seg)) {
      const idx = parseInt(seg, 10);
      if (Array.isArray(current.children) && idx < current.children.length) {
        current = current.children[idx];
      } else if (Array.isArray(current) && idx < current.length) {
        current = current[idx];
      } else {
        return null;
      }
      continue;
    }

    // "attrs" special segment: return attrs object
    if (seg === "attrs") {
      current = current.attrs;
      continue;
    }

    // "text" special segment: return text string
    if (seg === "text") {
      current = current.text;
      continue;
    }

    // "children" special segment: return children array
    if (seg === "children") {
      current = current.children;
      continue;
    }

    // Tag name segment: find first matching child, or all (array) if ambiguous
    if (current.children) {
      const matches = current.children.filter(c => c.tag === seg);
      if (matches.length === 0) {
        // Try attribute name
        if (current.attrs && seg in current.attrs) {
          current = current.attrs[seg];
          continue;
        }
        return null;
      }
      if (matches.length === 1) {
        current = matches[0];
      } else {
        // Multiple children with same tag — return array
        // If next segment is a number, we'll handle indexing in next iteration
        current = matches;
      }
      continue;
    }

    // current is an array (from previous multiple-match)
    if (Array.isArray(current)) {
      const matches = current.filter(c => c && c.tag === seg);
      if (matches.length === 0) return null;
      current = matches.length === 1 ? matches[0] : matches;
      continue;
    }

    // Plain object lookup — supports attrs.ATTRNAME after the "attrs" segment
    if (current !== null && typeof current === 'object' && !Array.isArray(current) &&
        current.tag === undefined && current.children === undefined) {
      current = seg in current ? current[seg] : null;
      if (current === null) return null;
      continue;
    }
    return null;
  }
  return current;
}

// ── Public API ─────────────────────────────────────────────────────────────────

function xmlParse(xmlStr, opts = {}) {
  if (typeof xmlStr !== "string")
    throw new Error("xml_parse: input must be a string.");
  if (xmlStr.length > MAX_INPUT)
    throw new Error(`xml_parse: input too large (${xmlStr.length} bytes, max ${MAX_INPUT}).`);
  if (xmlStr.trim() === "")
    throw new Error("xml_parse: input is empty.");

  const tokens = tokenize(xmlStr);
  const { root, declaration, nodeCount, maxDepth } = buildTree(tokens);

  if (!root) throw new Error("xml_parse: no root element found in input.");

  const result = { root, declaration, nodeCount, maxDepth };

  if (opts.query) {
    const qResult = queryNode(root, opts.query);
    result.query = opts.query;
    result.queryResult = qResult ?? null;
    result.queryMatched = qResult !== null;
  }

  return result;
}

module.exports = { xmlParse };
