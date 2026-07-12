"use strict";
// lib/xmlClientOps.js — Zero-dependency XML file reader/writer/query tool
// Operations: read, get, set, delete, list, query, add_node, stringify
//
// XML features supported:
//   - Elements with tag names, attributes, text content, mixed content
//   - CDATA sections (<![CDATA[...]]>)
//   - Comments (<!-- ... -->)
//   - Processing instructions (<?...?>)
//   - XML declaration (<?xml ...?>) preserved on stringify
//   - Namespace prefixes (preserved as-is in tag/attribute names)
//   - Self-closing tags (<br/>, <img src="x"/>)
//   - Nested elements to configurable depth
//   - Attribute access via @attr syntax in paths
//
// Path notation (used by get/set/delete/query):
//   "project.dependencies.dependency[0].groupId"  — element navigation
//   "project.name"                                 — text content of <name>
//   "project.@version"                             — attribute on <project>
//   "root.items.item[2].@href"                    — attribute on 3rd <item>
//   Bracket [n] selects nth child (0-based) when multiple siblings share a tag
//
// Security:
//   - path NUL guard
//   - 4 MB file cap
//   - nesting depth limit (max 50)
//   - 100,000 node limit
//   - Attribute / text value size limits (64 KB)

const fs   = require("fs");
const path = require("path");

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 4 * 1024 * 1024;  // 4 MB
const MAX_DEPTH      = 50;
const MAX_NODES      = 100_000;
const MAX_VALUE_LEN  = 64 * 1024;        // 64 KB per text/attr value

// ── Path helpers ─────────────────────────────────────────────────────────────
function resolvePath(p) {
  if (typeof p !== "string" || p.length === 0)
    throw err("xml_client: 'path' must be a non-empty string.", "INVALID_ARG");
  if (p.includes("\0"))
    throw err("xml_client: 'path' must not contain NUL bytes.", "INVALID_ARG");
  return path.resolve(p);
}

function readFileSafe(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES)
    throw err(`xml_client: file too large (${stat.size} bytes; max ${MAX_FILE_BYTES}).`, "FILE_TOO_LARGE");
  return fs.readFileSync(filePath, "utf8");
}

function err(msg, code) {
  return Object.assign(new Error(msg), { code });
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────
function tokenize(xml) {
  const tokens = [];
  let i = 0;
  const len = xml.length;

  while (i < len) {
    if (xml[i] !== "<") {
      let j = xml.indexOf("<", i);
      if (j === -1) j = len;
      const text = xml.slice(i, j);
      if (text) tokens.push({ type: "text", value: text });
      i = j;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end === -1) throw err("xml_client: unclosed comment.", "PARSE_ERROR");
      tokens.push({ type: "comment", value: xml.slice(i + 4, end) });
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end === -1) throw err("xml_client: unclosed CDATA.", "PARSE_ERROR");
      tokens.push({ type: "cdata", value: xml.slice(i + 9, end) });
      i = end + 3;
    } else if (xml.startsWith("<!DOCTYPE", i) || xml.startsWith("<!doctype", i)) {
      let j = i + 2;
      let depth = 1;
      while (j < len && depth > 0) {
        if (xml[j] === "<") depth++;
        else if (xml[j] === ">") depth--;
        j++;
      }
      tokens.push({ type: "doctype", value: xml.slice(i, j) });
      i = j;
    } else if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end === -1) throw err("xml_client: unclosed processing instruction.", "PARSE_ERROR");
      const raw = xml.slice(i + 2, end).trim();
      // XML declaration is <?xml ...?> — target name is exactly "xml" (followed by
      // whitespace or end-of-content). <?xml-stylesheet?> and similar are PIs, not xml_decl.
      const rawLower = raw.toLowerCase();
      if (rawLower === "xml" || rawLower.startsWith("xml ") || rawLower.startsWith("xml\t")) {
        tokens.push({ type: "xml_decl", value: xml.slice(i, end + 2) });
      } else {
        tokens.push({ type: "pi", value: raw });
      }
      i = end + 2;
    } else if (xml[i + 1] === "/") {
      const end = xml.indexOf(">", i + 2);
      if (end === -1) throw err("xml_client: unclosed close tag.", "PARSE_ERROR");
      const name = xml.slice(i + 2, end).trim();
      tokens.push({ type: "close", name });
      i = end + 1;
    } else {
      const end = findTagEnd(xml, i + 1);
      if (end === -1) throw err("xml_client: unclosed open tag.", "PARSE_ERROR");
      const raw = xml.slice(i + 1, end);
      const selfClose = raw.trimEnd().endsWith("/");
      const inner = selfClose ? raw.slice(0, raw.lastIndexOf("/")).trim() : raw.trim();
      const { name, attrs } = parseTagInner(inner);
      if (selfClose) {
        tokens.push({ type: "selfclose", name, attrs });
      } else {
        tokens.push({ type: "open", name, attrs });
      }
      i = end + 1;
    }
  }
  return tokens;
}

function findTagEnd(xml, start) {
  let i = start;
  const len = xml.length;
  while (i < len) {
    const c = xml[i];
    if (c === ">") return i;
    if (c === '"') {
      i++;
      while (i < len && xml[i] !== '"') i++;
      i++;
    } else if (c === "'") {
      i++;
      while (i < len && xml[i] !== "'") i++;
      i++;
    } else {
      i++;
    }
  }
  return -1;
}

function parseTagInner(raw) {
  raw = raw.trim();
  const m = raw.match(/^([^\s/]+)([\s\S]*)$/);
  if (!m) return { name: raw, attrs: {} };
  const name  = m[1];
  const rest  = m[2].trim();
  const attrs = {};
  const re    = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match;
  while ((match = re.exec(rest)) !== null) {
    const attrName = match[1];
    const attrVal  = match[2] !== undefined ? match[2]
                   : match[3] !== undefined ? match[3]
                   : match[4];
    attrs[attrName] = decodeXmlEntities(attrVal);
  }
  return { name, attrs };
}

// ── Entity codec ─────────────────────────────────────────────────────────────
function decodeXmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/#(\d+);/g,   (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([\da-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function encodeXmlEntities(s) {
  return String(s)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;");
}

function encodeXmlAttr(s) {
  return String(s)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;");
}

// ── DOM builder ───────────────────────────────────────────────────────────────
function buildDom(tokens) {
  let nodeCount = 0;
  const root = { type: "document", children: [] };
  const stack = [root];
  let depth = 0;

  for (const tok of tokens) {
    const parent = stack[stack.length - 1];
    if (++nodeCount > MAX_NODES)
      throw err(`xml_client: document exceeds ${MAX_NODES} node limit.`, "TOO_MANY_NODES");

    if (tok.type === "xml_decl") {
      root.xmlDecl = tok.value;
      nodeCount--;
    } else if (tok.type === "doctype") {
      root.doctype = tok.value;
      nodeCount--;
    } else if (tok.type === "text") {
      const val = decodeXmlEntities(tok.value);
      parent.children.push({ type: "text", value: val });
    } else if (tok.type === "comment") {
      parent.children.push({ type: "comment", value: tok.value });
    } else if (tok.type === "cdata") {
      parent.children.push({ type: "cdata", value: tok.value });
    } else if (tok.type === "pi") {
      parent.children.push({ type: "pi", value: tok.value });
    } else if (tok.type === "selfclose") {
      const node = { type: "element", name: tok.name, attrs: tok.attrs, children: [] };
      parent.children.push(node);
    } else if (tok.type === "open") {
      if (depth >= MAX_DEPTH)
        throw err(`xml_client: nesting depth exceeds ${MAX_DEPTH}.`, "TOO_DEEP");
      const node = { type: "element", name: tok.name, attrs: tok.attrs, children: [] };
      parent.children.push(node);
      stack.push(node);
      depth++;
    } else if (tok.type === "close") {
      if (stack.length <= 1)
        throw err(`xml_client: unexpected close tag </${tok.name}>.`, "PARSE_ERROR");
      stack.pop();
      depth--;
    }
  }
  // Validate all open tags were properly closed.
  if (stack.length > 1) {
    const unclosed = stack[stack.length - 1];
    throw err(
      `xml_client: unclosed element <${unclosed.name}> at end of document.`,
      "PARSE_ERROR",
    );
  }
  return root;
}

function parseXml(xmlStr) {
  const tokens = tokenize(xmlStr);
  return buildDom(tokens);
}

// ── DOM → object ──────────────────────────────────────────────────────────────
function nodeToObject(node) {
  if (node.type === "text")    return { type: "text",    value: node.value };
  if (node.type === "comment") return { type: "comment", value: node.value };
  if (node.type === "cdata")   return { type: "cdata",   value: node.value };
  if (node.type === "pi")      return { type: "pi",      value: node.value };
  if (node.type === "document") {
    return {
      type: "document",
      ...(node.xmlDecl ? { xmlDecl: node.xmlDecl } : {}),
      ...(node.doctype ? { doctype: node.doctype } : {}),
      children: node.children.map(nodeToObject),
    };
  }
  const obj = {
    type:  "element",
    name:  node.name,
    attrs: { ...node.attrs },
  };
  const textChildren  = node.children.filter(c => c.type === "text" || c.type === "cdata");
  const elemChildren  = node.children.filter(c => c.type === "element");
  const otherChildren = node.children.filter(c => c.type !== "text" && c.type !== "cdata" && c.type !== "element");

  const textVal = textChildren.map(c => c.value).join("").trim();
  if (textVal) obj.text = textVal;

  if (elemChildren.length > 0) {
    obj.children = node.children.map(nodeToObject);
  } else if (otherChildren.length > 0) {
    obj.children = otherChildren.map(nodeToObject);
  }
  return obj;
}

// ── Stringify DOM ─────────────────────────────────────────────────────────────
function stringifyNode(node, indent, level) {
  const pad = indent ? " ".repeat(indent * level) : "";
  const nl  = indent ? "\n" : "";

  if (node.type === "text") {
    const v = node.value;
    if (!indent || v.trim()) return pad + encodeXmlEntities(v);
    return "";
  }
  if (node.type === "comment")
    return `${pad}<!--${node.value}-->`;
  if (node.type === "cdata")
    return `${pad}<![CDATA[${node.value}]]>`;
  if (node.type === "pi")
    return `${pad}<?${node.value}?>`;

  if (node.type === "document") {
    const parts = [];
    if (node.xmlDecl) parts.push(node.xmlDecl);
    if (node.doctype) parts.push(node.doctype);
    for (const c of node.children) {
      const s = stringifyNode(c, indent, level);
      if (s) parts.push(s);
    }
    return parts.join(nl || "\n");
  }

  const attrStr = Object.entries(node.attrs || {})
    .map(([k, v]) => ` ${k}="${encodeXmlAttr(v)}"`)
    .join("");

  if (!node.children || node.children.length === 0) {
    return `${pad}<${node.name}${attrStr}/>`;
  }

  const nonWS = node.children.filter(c => c.type !== "text" || c.value.trim());
  if (nonWS.length === 1 && nonWS[0].type === "text") {
    const tv = encodeXmlEntities(nonWS[0].value.trim());
    return `${pad}<${node.name}${attrStr}>${tv}</${node.name}>`;
  }
  if (nonWS.length === 1 && nonWS[0].type === "cdata") {
    const tv = `<![CDATA[${nonWS[0].value}]]>`;
    return `${pad}<${node.name}${attrStr}>${tv}</${node.name}>`;
  }

  const childParts = node.children
    .map(c => stringifyNode(c, indent, level + 1))
    .filter(s => s !== "");

  if (childParts.length === 0) return `${pad}<${node.name}${attrStr}></${node.name}>`;

  const inner = childParts.join(nl);
  if (indent) {
    return `${pad}<${node.name}${attrStr}>${nl}${inner}${nl}${pad}</${node.name}>`;
  }
  return `${pad}<${node.name}${attrStr}>${inner}</${node.name}>`;
}

function domToString(doc, indent) {
  return stringifyNode(doc, indent || 0, 0);
}

// ── Path navigator ────────────────────────────────────────────────────────────
function parseDotPath(p) {
  const segments = [];
  let buf = "";
  for (const ch of p) {
    if (ch === ".") {
      if (buf) segments.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) segments.push(buf);
  return segments;
}

function parseSeg(seg) {
  const m = seg.match(/^([^\[]+)(?:\[(\d+)\])?$/);
  if (!m) throw err(`xml_client: invalid path segment '${seg}'.`, "INVALID_ARG");
  return { tagName: m[1], index: m[2] !== undefined ? parseInt(m[2], 10) : undefined };
}

function navigatePath(doc, segs) {
  if (!segs || segs.length === 0)
    throw err("xml_client: empty path.", "INVALID_ARG");

  const firstSeg = segs[0];
  const { tagName: firstName, index: firstIdx } = parseSeg(firstSeg);

  const rootElems = doc.children.filter(c => c.type === "element");
  const matchingRoots = rootElems.filter(c => c.name === firstName);
  if (matchingRoots.length === 0) return null;

  const idx = firstIdx ?? 0;
  if (idx >= matchingRoots.length) return null;

  let current = matchingRoots[idx];
  let parent  = doc;
  let parentIndex = doc.children.indexOf(current);

  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];

    if (seg.startsWith("@")) {
      const attrName = seg.slice(1);
      return { node: current, parent, parentIndex, attrName, attrHolder: current };
    }

    const { tagName, index } = parseSeg(seg);
    if (current.type !== "element") return null;

    const kids = current.children.filter(c => c.type === "element" && c.name === tagName);
    const kidIdx = index ?? 0;
    if (kidIdx >= kids.length) return null;

    parent      = current;
    current     = kids[kidIdx];
    parentIndex = parent.children.indexOf(current);
  }

  return { node: current, parent, parentIndex };
}

// Get text content of node
function getTextContent(node) {
  if (!node || node.type !== "element") return null;
  return node.children
    .filter(c => c.type === "text" || c.type === "cdata")
    .map(c => c.value)
    .join("")
    .trim();
}

// ── Query engine ──────────────────────────────────────────────────────────────
function queryAll(doc, queryStr) {
  const results = [];
  const isDeep  = queryStr.startsWith("//");

  if (isDeep) {
    const rest = queryStr.slice(2);
    const attrIdx = rest.lastIndexOf("/@");
    let tagTarget, attrTarget = null;
    if (attrIdx !== -1) {
      tagTarget  = rest.slice(0, attrIdx).split("/").pop();
      attrTarget = rest.slice(attrIdx + 2);
    } else {
      tagTarget = rest.split("/").pop();
    }

    function walk(node) {
      if (node.type === "element") {
        if (node.name === tagTarget || tagTarget === "*") {
          if (attrTarget) {
            const val = node.attrs[attrTarget];
            if (val !== undefined)
              results.push({ element: nodeToObject(node), value: val, type: "attribute", attrName: attrTarget });
          } else {
            results.push({ element: nodeToObject(node), text: getTextContent(node), type: "element" });
          }
        }
        for (const c of node.children) walk(c);
      }
    }
    for (const c of doc.children) walk(c);
  } else {
    const segs = queryStr.split("/").filter(Boolean);
    let attrTarget = null;
    let pathSegs   = segs;
    if (segs.length > 0 && segs[segs.length - 1].startsWith("@")) {
      attrTarget = segs[segs.length - 1].slice(1);
      pathSegs   = segs.slice(0, -1);
    }
    const dotPath = pathSegs.join(".");
    const dotSegs = parseDotPath(dotPath);
    const nav     = dotSegs.length ? navigatePath(doc, dotSegs) : null;
    if (!nav) return results;

    if (attrTarget) {
      const val = nav.node.attrs[attrTarget];
      if (val !== undefined)
        results.push({ element: nodeToObject(nav.node), value: val, type: "attribute", attrName: attrTarget });
    } else {
      results.push({ element: nodeToObject(nav.node), text: getTextContent(nav.node), type: "element" });
    }
  }
  return results;
}

// ── DOM statistics ────────────────────────────────────────────────────────────
function domStats(node) {
  let elements = 0, textNodes = 0, comments = 0, maxDepth = 0;
  function walk(n, d) {
    if (d > maxDepth) maxDepth = d;
    if (n.type === "element") {
      elements++;
      for (const c of n.children) walk(c, d + 1);
    } else if (n.type === "text") {
      textNodes++;
    } else if (n.type === "comment") {
      comments++;
    }
  }
  if (node.type === "document") {
    for (const c of node.children) walk(c, 0);
  } else {
    walk(node, 0);
  }
  return { elements, textNodes, comments, maxDepth };
}

function rootElementName(doc) {
  const root = doc.children.find(c => c.type === "element");
  return root ? root.name : null;
}

// ── Build node from spec ──────────────────────────────────────────────────────
function buildNode(spec) {
  if (!spec || !spec.name || typeof spec.name !== "string")
    throw err("xml_client: 'node_spec.name' is required for add_node.", "INVALID_ARG");
  const node = {
    type: "element",
    name: spec.name,
    attrs: {},
    children: [],
  };
  if (spec.attrs && typeof spec.attrs === "object") {
    for (const [k, v] of Object.entries(spec.attrs))
      node.attrs[k] = String(v);
  }
  if (spec.text != null) {
    node.children.push({ type: "text", value: String(spec.text) });
  }
  if (Array.isArray(spec.children)) {
    for (const child of spec.children)
      node.children.push(buildNode(child));
  }
  return node;
}

// ── Operations ────────────────────────────────────────────────────────────────
function opRead(args) {
  const resolved = resolvePath(args.path);
  const xml = readFileSafe(resolved);
  const doc = parseXml(xml);
  const stats = domStats(doc);
  const docObj = nodeToObject(doc);
  return {
    path: args.path,
    rootElement: rootElementName(doc),
    elementCount: stats.elements,
    textNodeCount: stats.textNodes,
    commentCount: stats.comments,
    maxDepth: stats.maxDepth,
    hasXmlDecl: !!doc.xmlDecl,
    document: docObj,
  };
}

function opGet(args) {
  if (!args.xml_path)
    throw err("xml_client: 'xml_path' is required for get.", "INVALID_ARG");
  const resolved = resolvePath(args.path);
  const xml = readFileSafe(resolved);
  const doc = parseXml(xml);
  const segs = parseDotPath(args.xml_path);

  let attrTarget = null;
  let pathSegs   = segs;
  if (segs.length > 0 && segs[segs.length - 1].startsWith("@")) {
    attrTarget = segs[segs.length - 1].slice(1);
    pathSegs   = segs.slice(0, -1);
  }

  const nav = navigatePath(doc, pathSegs);
  if (!nav || !nav.node)
    return { path: args.path, xml_path: args.xml_path, found: false, value: null };

  if (attrTarget) {
    const val = nav.node.attrs[attrTarget];
    if (val === undefined)
      return { path: args.path, xml_path: args.xml_path, found: false, value: null, type: "attribute", attrName: attrTarget };
    return { path: args.path, xml_path: args.xml_path, found: true, value: val, type: "attribute", attrName: attrTarget };
  }
  if (nav.attrName) {
    const val = nav.node.attrs[nav.attrName];
    if (val === undefined)
      return { path: args.path, xml_path: args.xml_path, found: false, value: null };
    return { path: args.path, xml_path: args.xml_path, found: true, value: val, type: "attribute", attrName: nav.attrName };
  }

  const text = getTextContent(nav.node);
  const obj  = nodeToObject(nav.node);
  return {
    path: args.path, xml_path: args.xml_path, found: true,
    type: "element", element: obj, text: text ?? null,
    attrs: nav.node.attrs,
  };
}

function opSet(args) {
  if (!args.xml_path)
    throw err("xml_client: 'xml_path' is required for set.", "INVALID_ARG");
  if (args.value === undefined)
    throw err("xml_client: 'value' is required for set.", "INVALID_ARG");
  if (String(args.value).length > MAX_VALUE_LEN)
    throw err(`xml_client: value too long (max ${MAX_VALUE_LEN} chars).`, "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const xml = readFileSafe(resolved);
  const doc = parseXml(xml);
  const segs = parseDotPath(args.xml_path);

  let attrTarget = null;
  let pathSegs   = segs;
  if (segs.length > 0 && segs[segs.length - 1].startsWith("@")) {
    attrTarget = segs[segs.length - 1].slice(1);
    pathSegs   = segs.slice(0, -1);
  }

  const nav = navigatePath(doc, pathSegs);
  if (!nav || !nav.node)
    throw err(`xml_client: path '${args.xml_path}' not found.`, "NOT_FOUND");

  const strVal = String(args.value);
  if (attrTarget || nav.attrName) {
    const aName = attrTarget || nav.attrName;
    nav.node.attrs[aName] = strVal;
  } else {
    nav.node.children = nav.node.children.filter(c => c.type !== "text" && c.type !== "cdata");
    nav.node.children.unshift({ type: "text", value: strVal });
  }

  const outXml = domToString(doc, args.indent || 0);
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, outXml, "utf8");
  return {
    path: args.path, xml_path: args.xml_path, value: strVal,
    output_path: outPath, written: true,
  };
}

function opDelete(args) {
  if (!args.xml_path)
    throw err("xml_client: 'xml_path' is required for delete.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const xml = readFileSafe(resolved);
  const doc = parseXml(xml);
  const segs = parseDotPath(args.xml_path);

  let attrTarget = null;
  let pathSegs   = segs;
  if (segs.length > 0 && segs[segs.length - 1].startsWith("@")) {
    attrTarget = segs[segs.length - 1].slice(1);
    pathSegs   = segs.slice(0, -1);
  }

  const nav = navigatePath(doc, pathSegs);
  if (!nav || !nav.node)
    return { path: args.path, xml_path: args.xml_path, deleted: false };

  let deleted = false;
  if (attrTarget || nav.attrName) {
    const aName = attrTarget || nav.attrName;
    if (nav.node.attrs[aName] !== undefined) {
      delete nav.node.attrs[aName];
      deleted = true;
    }
  } else {
    if (nav.parent && nav.parentIndex !== -1) {
      nav.parent.children.splice(nav.parentIndex, 1);
      deleted = true;
    }
  }

  if (deleted) {
    const outXml = domToString(doc, args.indent || 0);
    const outPath = args.output_path || args.path;
    const outResolved = resolvePath(outPath);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, outXml, "utf8");
    return { path: args.path, xml_path: args.xml_path, deleted: true, output_path: outPath, written: true };
  }
  return { path: args.path, xml_path: args.xml_path, deleted: false };
}

function opList(args) {
  const resolved = resolvePath(args.path);
  const xml = readFileSafe(resolved);
  const doc = parseXml(xml);

  let target;
  if (args.xml_path) {
    const segs = parseDotPath(args.xml_path);
    const nav  = navigatePath(doc, segs);
    if (!nav || !nav.node || nav.node.type !== "element")
      throw err(`xml_client: path '${args.xml_path}' not found or not an element.`, "NOT_FOUND");
    target = nav.node;
  } else {
    target = doc.children.find(c => c.type === "element");
    if (!target) throw err("xml_client: no root element found.", "NOT_FOUND");
  }

  const children = target.children.filter(c => c.type === "element");
  const byTag = {};
  for (const c of children) {
    byTag[c.name] = (byTag[c.name] || 0) + 1;
  }

  return {
    path: args.path,
    xml_path: args.xml_path || null,
    element: target.name,
    attrs: target.attrs,
    childCount: children.length,
    childTags: byTag,
    children: children.map(c => ({
      name: c.name,
      attrs: c.attrs,
      text: getTextContent(c),
      childCount: c.children.filter(x => x.type === "element").length,
    })),
  };
}

function opQuery(args) {
  if (!args.query)
    throw err("xml_client: 'query' is required for query.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const xml = readFileSafe(resolved);
  const doc = parseXml(xml);
  const maxResults = Math.min(Math.max(1, args.max_results ?? 100), 10_000);

  const results = queryAll(doc, args.query);
  const truncated = results.length > maxResults;
  return {
    path: args.path,
    query: args.query,
    matchCount: Math.min(results.length, maxResults),
    totalFound: results.length,
    truncated,
    matches: results.slice(0, maxResults),
  };
}

function opAddNode(args) {
  if (!args.node_spec)
    throw err("xml_client: 'node_spec' is required for add_node.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  let doc;
  if (fs.existsSync(resolved)) {
    const xml = readFileSafe(resolved);
    doc = parseXml(xml);
  } else {
    doc = { type: "document", xmlDecl: '<?xml version="1.0" encoding="UTF-8"?>', children: [] };
  }

  const newNode = buildNode(args.node_spec);

  if (args.xml_path) {
    const segs = parseDotPath(args.xml_path);
    const nav  = navigatePath(doc, segs);
    if (!nav || !nav.node || nav.node.type !== "element")
      throw err(`xml_client: parent path '${args.xml_path}' not found or not an element.`, "NOT_FOUND");
    const pos = args.position === "prepend" ? 0 : nav.node.children.length;
    nav.node.children.splice(pos, 0, newNode);
  } else {
    const rootElem = doc.children.find(c => c.type === "element");
    if (rootElem) {
      const pos = args.position === "prepend" ? 0 : rootElem.children.length;
      rootElem.children.splice(pos, 0, newNode);
    } else {
      doc.children.push(newNode);
    }
  }

  const outXml = domToString(doc, args.indent !== undefined ? args.indent : 2);
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, outXml, "utf8");
  return {
    path: args.path, xml_path: args.xml_path || null,
    added: newNode.name, output_path: outPath, written: true,
  };
}

function opStringify(args) {
  let doc;
  if (args.data != null && args.path != null)
    throw err("xml_client: provide 'data' or 'path', not both.", "INVALID_ARG");

  if (args.data != null) {
    if (typeof args.data !== "object" || Array.isArray(args.data))
      throw err("xml_client: 'data' must be a plain object for stringify.", "INVALID_ARG");
    doc = { type: "document", xmlDecl: '<?xml version="1.0" encoding="UTF-8"?>', children: [buildNode(args.data)] };
  } else if (args.path != null) {
    const resolved = resolvePath(args.path);
    const xml = readFileSafe(resolved);
    doc = parseXml(xml);
  } else {
    throw err("xml_client: provide 'data' or 'path' for stringify.", "INVALID_ARG");
  }

  const indent = args.indent !== undefined ? Number(args.indent) : 2;
  const xmlOut = domToString(doc, indent);

  if (args.output_path) {
    const outResolved = resolvePath(args.output_path);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, xmlOut, "utf8");
    return { output_path: args.output_path, length: xmlOut.length, written: true, xml: xmlOut };
  }
  return { length: xmlOut.length, written: false, xml: xmlOut };
}

// ── Main Dispatcher ───────────────────────────────────────────────────────────
function xmlClient(args) {
  if (!args || !args.operation)
    throw err("xml_client: 'operation' is required.", "INVALID_ARG");

  switch (args.operation) {
    case "read":      return opRead(args);
    case "get":       return opGet(args);
    case "set":       return opSet(args);
    case "delete":    return opDelete(args);
    case "list":      return opList(args);
    case "query":     return opQuery(args);
    case "add_node":  return opAddNode(args);
    case "stringify": return opStringify(args);
    default:
      throw err(
        `xml_client: unknown operation '${args.operation}'. Valid: read, get, set, delete, list, query, add_node, stringify.`,
        "INVALID_ARG",
      );
  }
}

module.exports = {
  xmlClient,
  parseXml,
  domToString,
  nodeToObject,
  navigatePath,
  parseDotPath,
  queryAll,
  getTextContent,
  buildNode,
  decodeXmlEntities,
  encodeXmlEntities,
};
