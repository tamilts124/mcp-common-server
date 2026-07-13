"use strict";
// ── EPUB_CLIENT ────────────────────────────────────────────────────────────────
// Zero-dependency EPUB 2 / EPUB 3 ebook reader (pure Node.js; no npm deps).
// EPUB is a ZIP container; we reuse the existing parseCentralDirectory /
// readEntryData ZIP primitives.
//
// Operations:
//   info      — container summary (version, unique ID, file count)
//   metadata  — Dublin Core + OPF metadata (title, author, publisher, ISBN, …)
//   toc       — table of contents (NCX for EPUB 2, nav for EPUB 3)
//   chapters  — ordered spine items with hrefs and titles
//   read      — read one item's content (text or base64)
//   images    — list cover + embedded images
//
// Security:
//   • 200 MB file cap
//   • 5 MB per read cap
//   • NUL-byte guard on path
//   • Directory guard
//   • 10,000 entry cap on ZIP directory

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");
const { parseCentralDirectory, readEntryData } = require("./unzipOps");

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_EPUB_BYTES = 200 * 1024 * 1024;
const MAX_READ_BYTES =   5 * 1024 * 1024;
const MAX_ENTRIES    = 10_000;

// ── Guard helpers ─────────────────────────────────────────────────────────────
function guardPath(p, op) {
  if (typeof p !== "string" || p.length === 0)
    throw new ToolError(`epub_client ${op}: 'path' must be a non-empty string.`, -32602);
  if (p.indexOf("\0") !== -1)
    throw new ToolError(`epub_client ${op}: path contains a NUL byte.`, -32602);
}

function guardEpubFile(p, op) {
  guardPath(p, op);
  if (!fs.existsSync(p))
    throw new ToolError(`epub_client ${op}: file not found: ${p}`, -32602);
  const stat = fs.statSync(p);
  if (stat.isDirectory())
    throw new ToolError(`epub_client ${op}: '${p}' is a directory, not an EPUB file.`, -32602);
  if (stat.size > MAX_EPUB_BYTES)
    throw new ToolError(
      `epub_client ${op}: file too large (${stat.size} bytes > ${MAX_EPUB_BYTES} limit).`, -32602);
}

// ── ZIP access helpers ────────────────────────────────────────────────────────
function loadEpub(epubPath) {
  const buf     = fs.readFileSync(epubPath);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50)
    throw new ToolError(
      "epub_client: not a valid ZIP/EPUB file (missing PK signature).", -32602);
  const entries = parseCentralDirectory(buf);
  if (entries.length > MAX_ENTRIES)
    throw new ToolError(
      `epub_client: too many ZIP entries (${entries.length} > ${MAX_ENTRIES}).`, -32602);
  return { buf, entries };
}

function findEntry(entries, name) {
  let e = entries.find(x => x.name === name);
  if (!e) e = entries.find(x => x.name.toLowerCase() === name.toLowerCase());
  return e || null;
}

function getEntryText(buf, entries, name) {
  const e = findEntry(entries, name);
  if (!e) return null;
  return readEntryData(buf, e).toString("utf8");
}

// ── Micro XML parser ──────────────────────────────────────────────────────────
function decodeXmlEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g,   (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([A-Za-z_:][A-Za-z0-9_.:\-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const [, name, dq, sq, unq] = m;
    const localName = name.includes(":") ? name.split(":").pop() : name;
    attrs[localName.toLowerCase()] = decodeXmlEntities(dq ?? sq ?? unq ?? "");
  }
  return attrs;
}

function parseXml(xml) {
  if (!xml) return { tag: "#root", attrs: {}, children: [], text: "" };
  if (xml.charCodeAt(0) === 0xFEFF) xml = xml.slice(1);
  xml = xml.replace(/<\?[^?]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");

  const root  = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re    = /<(!--[\s\S]*?--|[^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, tagContent, textContent] = m;
    const cur = stack[stack.length - 1];
    if (textContent !== undefined) {
      const t = decodeXmlEntities(textContent);
      cur.text += t;
      if (cur.children.length > 0 && cur.children[cur.children.length - 1].tag === "#text") {
        cur.children[cur.children.length - 1].text += t;
      } else {
        cur.children.push({ tag: "#text", attrs: {}, children: [], text: t });
      }
      continue;
    }
    if (!tagContent || tagContent.startsWith("!--")) continue;
    const selfClose = tagContent.endsWith("/");
    const closing   = tagContent.startsWith("/");
    const inner     = (selfClose ? tagContent.slice(0, -1) : closing ? tagContent.slice(1) : tagContent).trim();
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const spaceIdx = inner.search(/[\s]/);
    const rawTag   = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx);
    const attrStr  = spaceIdx === -1 ? "" : inner.slice(spaceIdx + 1);
    const localTag = (rawTag.includes(":") ? rawTag.split(":").pop() : rawTag).toLowerCase();
    const attrs    = parseAttrs(attrStr);
    const node     = { tag: localTag, attrs, children: [], text: "" };
    cur.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function findNode(node, tag) {
  if (!node) return null;
  if (node.tag === tag) return node;
  for (const c of node.children) { const r = findNode(c, tag); if (r) return r; }
  return null;
}

function findAll(node, tag) {
  if (!node) return [];
  const result = [];
  function walk(n) {
    if (n.tag === tag) result.push(n);
    for (const c of n.children) walk(c);
  }
  walk(node);
  return result;
}

function textContent(node) {
  if (!node) return "";
  if (node.tag === "#text") return node.text;
  return node.children.map(textContent).join("").trim();
}

// ── EPUB structure resolution ─────────────────────────────────────────────────
function resolveOpfPath(buf, entries) {
  const e = entries.find(x => x.name.toLowerCase() === "meta-inf/container.xml");
  if (!e) throw new ToolError("epub_client: META-INF/container.xml not found — not a valid EPUB.", -32602);
  const xml  = readEntryData(buf, e).toString("utf8");
  const tree = parseXml(xml);
  const rf   = findNode(tree, "rootfile");
  if (!rf) throw new ToolError("epub_client: <rootfile> not found in container.xml.", -32602);
  const opfPath = rf.attrs["full-path"];
  if (!opfPath) throw new ToolError("epub_client: rootfile missing full-path attribute.", -32602);
  return opfPath;
}

function resolveHref(base, href) {
  if (!href) return href;
  let decoded;
  try { decoded = decodeURIComponent(href.split("#")[0]); } catch { decoded = href.split("#")[0]; }
  if (decoded.startsWith("/")) return decoded.slice(1);
  const combined = (base || "") + decoded;
  const parts = combined.split("/");
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); }
  return out.join("/");
}

function parseOpf(buf, entries, opfPath) {
  const e = findEntry(entries, opfPath);
  if (!e) throw new ToolError(`epub_client: OPF file not found: ${opfPath}`, -32602);
  const opfText = readEntryData(buf, e).toString("utf8");
  const opfDir  = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const tree    = parseXml(opfText);
  const pkg     = findNode(tree, "package");
  const version  = pkg ? (pkg.attrs.version || "2.0") : "2.0";
  const uniqueId = pkg ? (pkg.attrs["unique-identifier"] || "") : "";

  const metaNode = findNode(tree, "metadata");
  const DC_TAGS  = ["title","creator","contributor","subject","description",
                    "publisher","date","type","format","identifier",
                    "source","language","relation","coverage","rights"];
  const dc = {};
  for (const tag of DC_TAGS) {
    const nodes = findAll(metaNode, tag);
    if (!nodes.length) continue;
    const vals = nodes.map(n => {
      const t    = textContent(n).slice(0, 2000);
      const role = n.attrs.role || n.attrs["file-as"] || null;
      const id   = n.attrs.id || null;
      return (role || id) ? { value: t, role, id } : t;
    });
    dc[tag] = vals.length === 1 ? vals[0] : vals;
  }
  const meta = {};
  for (const n of findAll(metaNode, "meta")) {
    const name    = n.attrs.name || n.attrs.property || null;
    const content = n.attrs.content || textContent(n) || null;
    if (name && content) meta[name] = content;
  }

  const manifestNode = findNode(tree, "manifest");
  const manifest = {};
  for (const item of findAll(manifestNode, "item")) {
    const id    = item.attrs.id;
    const href  = item.attrs.href;
    const mt    = item.attrs["media-type"] || item.attrs.mediatype || "";
    const props = item.attrs.properties || "";
    if (id && href) manifest[id] = { id, href: resolveHref(opfDir, href), mediaType: mt, properties: props };
  }

  const spineNode  = findNode(tree, "spine");
  const tocId      = spineNode ? (spineNode.attrs.toc || "") : "";
  const spineItems = findAll(spineNode, "itemref").map(n => ({
    idref:  n.attrs.idref,
    linear: (n.attrs.linear || "yes") !== "no",
  }));

  return { version, uniqueId, metadata: { dc, meta }, manifest, spine: spineItems, tocId, opfDir };
}

function parseNcx(buf, entries, ncxPath) {
  if (!ncxPath) return [];
  const e = findEntry(entries, ncxPath);
  if (!e) return [];
  const xml    = readEntryData(buf, e).toString("utf8");
  const tree   = parseXml(xml);
  const navMap = findNode(tree, "navmap");
  if (!navMap) return [];

  function pts(node, depth) {
    return node.children
      .filter(c => c.tag === "navpoint")
      .map(np => {
        const lbl  = findNode(np, "navlabel") || findNode(np, "text");
        const text = lbl ? textContent(findNode(lbl, "text") || lbl) : "(untitled)";
        const src  = np.children.find(c => c.tag === "content");
        const href = src ? (src.attrs.src || "") : "";
        return {
          label:     text.trim(),
          href:      href.split("#")[0],
          anchor:    href.includes("#") ? href.split("#")[1] : null,
          playOrder: parseInt(np.attrs.playorder || "0", 10) || 0,
          depth,
          children:  pts(np, depth + 1),
        };
      });
  }
  return pts(navMap, 0);
}

function parseNavDoc(buf, entries, navPath) {
  if (!navPath) return [];
  const e = findEntry(entries, navPath);
  if (!e) return [];
  const xml      = readEntryData(buf, e).toString("utf8");
  const tree     = parseXml(xml);
  const navNodes = findAll(tree, "nav");
  const tocNav   = navNodes.find(n =>
    (n.attrs.type || n.attrs["epub:type"] || "").toLowerCase().includes("toc")
  ) || navNodes[0];
  if (!tocNav) return [];
  const ol = findNode(tocNav, "ol");
  if (!ol) return [];

  function parseOl(olNode, depth) {
    return olNode.children
      .filter(c => c.tag === "li")
      .map(li => {
        const a    = li.children.find(c => c.tag === "a") || li.children.find(c => c.tag === "span");
        const lbl  = a ? textContent(a).trim() : "(untitled)";
        const href = a ? (a.attrs.href || "") : "";
        const cOl  = li.children.find(c => c.tag === "ol");
        return {
          label:    lbl,
          href:     href.split("#")[0],
          anchor:   href.includes("#") ? href.split("#")[1] : null,
          depth,
          children: cOl ? parseOl(cOl, depth + 1) : [],
        };
      });
  }
  return parseOl(ol, 0);
}

// ── Operations ────────────────────────────────────────────────────────────────
function opInfo(args) {
  guardEpubFile(args.path, "info");
  const { buf, entries } = loadEpub(args.path);
  const stat    = fs.statSync(args.path);
  const opfPath = resolveOpfPath(buf, entries);
  const { version, uniqueId, metadata, manifest, spine } = parseOpf(buf, entries, opfPath);

  const getString = v => typeof v === "string" ? v
    : (v && typeof v === "object" ? (v.value || (Array.isArray(v) ? (typeof v[0]==="string" ? v[0] : v[0]?.value||"") : "")) : "");
  const title    = getString(metadata.dc.title);
  const author   = getString(metadata.dc.creator);
  const language = getString(metadata.dc.language);
  const imgCount = Object.values(manifest).filter(m =>
    m.mediaType.startsWith("image/") || /\.(jpg|jpeg|png|gif|svg|webp|bmp)$/i.test(m.href)).length;
  const hasCover = Object.values(manifest).some(m =>
    (m.properties||"").includes("cover-image") || m.id === "cover" || m.id === "cover-image");

  return {
    operation:     "info",
    path:          args.path,
    fileSizeBytes: stat.size,
    epubVersion:   version,
    uniqueId,
    title:         String(title).slice(0, 500),
    author:        String(author).slice(0, 500),
    language:      String(language).slice(0, 20),
    manifestItems: Object.keys(manifest).length,
    spineItems:    spine.length,
    imageCount:    imgCount,
    hasCover,
    opfPath,
    zipEntries:    entries.length,
  };
}

function opMetadata(args) {
  guardEpubFile(args.path, "metadata");
  const { buf, entries } = loadEpub(args.path);
  const opfPath = resolveOpfPath(buf, entries);
  const { version, uniqueId, metadata } = parseOpf(buf, entries, opfPath);

  let isbn = null;
  const ids = metadata.dc.identifier;
  if (ids) {
    const arr = Array.isArray(ids) ? ids : [ids];
    for (const id of arr) {
      const v = typeof id === "string" ? id : (id.value || "");
      if (/^(isbn[:\s]?)?97[89][\d\-]{10,}/i.test(v) || /^97[89][\d]{10}$/.test(v.replace(/[^0-9]/g, ""))) {
        const digits = v.replace(/[^0-9]/g, "");
        if (digits.length >= 13) { isbn = digits.slice(0, 13); break; }
      }
    }
  }

  return { operation: "metadata", path: args.path, epubVersion: version, uniqueId, dc: metadata.dc, meta: metadata.meta, isbn };
}

function opToc(args) {
  guardEpubFile(args.path, "toc");
  const { buf, entries } = loadEpub(args.path);
  const opfPath = resolveOpfPath(buf, entries);
  const { manifest, tocId } = parseOpf(buf, entries, opfPath);

  let tocItems = [];
  let tocSource = null;

  const navItem = Object.values(manifest).find(m =>
    (m.properties || "").includes("nav") ||
    /nav\.(x?html?)$/i.test(m.href) || /toc\.(x?html?)$/i.test(m.href));
  if (navItem) {
    tocItems = parseNavDoc(buf, entries, navItem.href);
    tocSource = "epub3-nav";
  }
  if (tocItems.length === 0) {
    const ncxItem = tocId ? manifest[tocId]
      : Object.values(manifest).find(m =>
          m.mediaType === "application/x-dtbncx+xml" || /\.ncx$/i.test(m.href));
    if (ncxItem) {
      tocItems = parseNcx(buf, entries, ncxItem.href);
      tocSource = "epub2-ncx";
    }
  }

  function flatten(items, out = []) {
    for (const it of items) {
      out.push({ label: it.label, href: it.href, anchor: it.anchor, depth: it.depth });
      flatten(it.children, out);
    }
    return out;
  }
  const flat  = flatten(tocItems);
  const limit = args.limit ? Math.min(Math.max(1, args.limit), 1000) : 200;
  return { operation: "toc", path: args.path, tocSource, totalItems: flat.length, items: flat.slice(0, limit), truncated: flat.length > limit };
}

function opChapters(args) {
  guardEpubFile(args.path, "chapters");
  const { buf, entries } = loadEpub(args.path);
  const opfPath = resolveOpfPath(buf, entries);
  const { manifest, spine } = parseOpf(buf, entries, opfPath);

  const titleMap = {};
  const navItem  = Object.values(manifest).find(m =>
    (m.properties || "").includes("nav") || /nav\.(x?html?)$/i.test(m.href));
  if (navItem) {
    const items = parseNavDoc(buf, entries, navItem.href);
    const fl = [];
    function flat(arr) { for (const i of arr) { fl.push(i); flat(i.children); } }
    flat(items);
    for (const t of fl) if (t.href) titleMap[t.href] = t.label;
  }

  const onlyLinear = args.linear_only !== false;
  const chapters   = [];
  let seq = 0;
  for (const s of spine) {
    const item = manifest[s.idref];
    if (!item) continue;
    if (onlyLinear && !s.linear) continue;
    let title = titleMap[item.href] || null;
    if (!title) {
      const text = getEntryText(buf, entries, item.href);
      if (text) {
        const m = text.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (m) title = decodeXmlEntities(m[1]).trim();
      }
    }
    seq++;
    const stat = entries.find(e => e.name === item.href);
    chapters.push({
      index: seq, id: s.idref, href: item.href, mediaType: item.mediaType,
      linear: s.linear, title: title || null, sizeBytes: stat ? stat.uncompressedSize : null,
    });
  }
  return { operation: "chapters", path: args.path, totalChapters: chapters.length, linearOnly: onlyLinear, chapters };
}

function opRead(args) {
  guardEpubFile(args.path, "read");
  if (!args.item || typeof args.item !== "string")
    throw new ToolError("epub_client read: 'item' (entry path or manifest ID) is required.", -32602);
  if (args.item.indexOf("\0") !== -1)
    throw new ToolError("epub_client read: 'item' contains a NUL byte.", -32602);

  const { buf, entries } = loadEpub(args.path);
  let entryPath = args.item;
  let entry     = findEntry(entries, entryPath);
  if (!entry) {
    const opfPath = resolveOpfPath(buf, entries);
    const { manifest } = parseOpf(buf, entries, opfPath);
    const item = manifest[args.item];
    if (item) { entryPath = item.href; entry = findEntry(entries, entryPath); }
    if (!entry)
      throw new ToolError(
        `epub_client read: item '${args.item}' not found as ZIP entry or manifest ID.`, -32602);
  }
  if (entry.isDirectory)
    throw new ToolError(`epub_client read: '${entryPath}' is a directory entry.`, -32602);
  if (entry.uncompressedSize > MAX_READ_BYTES)
    throw new ToolError(
      `epub_client read: entry too large (${entry.uncompressedSize} bytes > ${MAX_READ_BYTES} cap).`, -32602);

  const data = readEntryData(buf, entry);
  const isBinary = /\.(jpg|jpeg|png|gif|webp|bmp|ttf|otf|woff2?|css)$/i.test(entryPath)
    || args.encoding === "base64"
    || (() => {
      let ctrl = 0;
      const check = Math.min(data.length, 2048);
      for (let i = 0; i < check; i++) {
        const b = data[i];
        if (b < 32 && b !== 9 && b !== 10 && b !== 13) ctrl++;
      }
      return ctrl / check > 0.08;
    })();

  let content, enc;
  if (isBinary || args.encoding === "base64") { content = data.toString("base64"); enc = "base64"; }
  else { content = data.toString("utf8"); enc = "utf8"; }

  return { operation: "read", path: args.path, item: entryPath, sizeBytes: data.length, encoding: enc, content };
}

function opImages(args) {
  guardEpubFile(args.path, "images");
  const { buf, entries } = loadEpub(args.path);
  const opfPath = resolveOpfPath(buf, entries);
  const { manifest } = parseOpf(buf, entries, opfPath);

  const imageExts  = /\.(jpg|jpeg|png|gif|svg|webp|bmp)$/i;
  const imageMimes = /^image\//;
  const images     = [];
  for (const item of Object.values(manifest)) {
    if (!imageMimes.test(item.mediaType) && !imageExts.test(item.href)) continue;
    const isCover = (item.properties || "").includes("cover-image")
      || item.id === "cover" || item.id === "cover-image";
    const stat = entries.find(e => e.name === item.href);
    images.push({ id: item.id, href: item.href, mediaType: item.mediaType, isCover, sizeBytes: stat ? stat.uncompressedSize : null });
  }
  images.sort((a, b) => (a.isCover === b.isCover ? a.href.localeCompare(b.href) : a.isCover ? -1 : 1));
  const limit   = args.limit ? Math.min(Math.max(1, args.limit), 500) : 100;
  const limited = images.slice(0, limit);
  return {
    operation: "images", path: args.path, totalImages: images.length,
    cover: images.find(i => i.isCover) || null, images: limited, truncated: images.length > limit,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function epubClient(args) {
  if (!args || typeof args.operation !== "string" || args.operation.trim() === "") {
    throw new ToolError(
      "epub_client: 'operation' is required. Valid: info, metadata, toc, chapters, read, images.", -32602);
  }
  const op = args.operation.trim().toLowerCase();
  switch (op) {
    case "info":     return opInfo(args);
    case "metadata": return opMetadata(args);
    case "toc":      return opToc(args);
    case "chapters": return opChapters(args);
    case "read":     return opRead(args);
    case "images":   return opImages(args);
    default:
      throw new ToolError(
        `epub_client: unknown operation '${op}'. Valid: info, metadata, toc, chapters, read, images.`, -32602);
  }
}

module.exports = { epubClient };
