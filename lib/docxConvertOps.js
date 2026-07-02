"use strict";
// ── md_to_docx / docx_to_md — zero-dependency Markdown <-> Word (.docx) ──────
// A .docx is a ZIP containing OOXML parts. We hand-build the minimal valid
// set ([Content_Types].xml, _rels/.rels, word/document.xml) using the same
// raw ZIP writer primitives as lib/zipDirOps.js (buildLocalEntry etc., here
// reimplemented over an in-memory {name, data} list since zipDirOps.js
// reads its inputs from disk paths, not in-memory buffers).
//
// Supported Markdown subset (deliberately small — this is a utility
// converter, not a full CommonMark engine):
//   # .. ###### heading      -> bold, size-scaled paragraph (direct formatting,
//                               not a named Word style, so it renders correctly
//                               even without a styles.xml part)
//   - / * item               -> bullet-prefixed paragraph ("•  item")
//   1. item                  -> kept as a literal numbered paragraph
//   **bold** / *italic*      -> inline run formatting
//   blank line                -> paragraph break
// Docx -> Markdown is the inverse best-effort mapping, read via regex over
// word/document.xml (no full XML parser, consistent with this project's
// existing regex-based OOXML-adjacent tools).

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");
const { parseCentralDirectory, readEntryData } = require("./unzipOps");

// ── minimal in-memory ZIP writer (see lib/zipDirOps.js for the on-disk twin) ──
function writeUInt16LE(buf, val, off) { buf.writeUInt16LE(val, off); }
function writeUInt32LE(buf, val, off) { buf.writeUInt32LE(val, off); }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localBlocks = [];
  const centralDirs  = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes  = Buffer.from(name, "utf8");
    const deflated    = zlib.deflateRawSync(data, { level: 6 });
    const crc         = crc32(data);
    const lh = Buffer.alloc(30 + nameBytes.length, 0);
    writeUInt32LE(lh, 0x04034b50, 0);
    writeUInt16LE(lh, 20, 4);
    writeUInt16LE(lh, 0x0800, 6);
    writeUInt16LE(lh, 8, 8);
    writeUInt16LE(lh, 0, 10);
    writeUInt16LE(lh, 0, 12);
    writeUInt32LE(lh, crc, 14);
    writeUInt32LE(lh, deflated.length, 18);
    writeUInt32LE(lh, data.length, 22);
    writeUInt16LE(lh, nameBytes.length, 26);
    writeUInt16LE(lh, 0, 28);
    nameBytes.copy(lh, 30);
    const block = Buffer.concat([lh, deflated]);

    const cd = Buffer.alloc(46 + nameBytes.length, 0);
    writeUInt32LE(cd, 0x02014b50, 0);
    writeUInt16LE(cd, 20, 4);
    writeUInt16LE(cd, 20, 6);
    writeUInt16LE(cd, 0x0800, 8);
    writeUInt16LE(cd, 8, 10);
    writeUInt16LE(cd, 0, 12);
    writeUInt16LE(cd, 0, 14);
    writeUInt32LE(cd, crc, 16);
    writeUInt32LE(cd, deflated.length, 20);
    writeUInt32LE(cd, data.length, 24);
    writeUInt16LE(cd, nameBytes.length, 28);
    writeUInt16LE(cd, 0, 30);
    writeUInt16LE(cd, 0, 32);
    writeUInt16LE(cd, 0, 34);
    writeUInt16LE(cd, 0, 36);
    writeUInt32LE(cd, 0, 38);
    writeUInt32LE(cd, offset, 42);
    nameBytes.copy(cd, 46);

    localBlocks.push(block);
    centralDirs.push(cd);
    offset += block.length;
  }
  const cdBuf = Buffer.concat(centralDirs);
  const eocd  = Buffer.alloc(22, 0);
  writeUInt32LE(eocd, 0x06054b50, 0);
  writeUInt16LE(eocd, entries.length, 8);
  writeUInt16LE(eocd, entries.length, 10);
  writeUInt32LE(eocd, cdBuf.length, 12);
  writeUInt32LE(eocd, offset, 16);
  return Buffer.concat([...localBlocks, cdBuf, eocd]);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const HEADING_SIZES = { 1: 32, 2: 28, 3: 26, 4: 24, 5: 22, 6: 20 }; // half-points

// Parse **bold** / *italic* inline spans into an array of {text, bold, italic}.
function parseInline(text) {
  const runs = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true });
    else runs.push({ text: m[2], italic: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  if (runs.length === 0) runs.push({ text: "" });
  return runs;
}

function runXml(run, extraProps) {
  const props = [];
  if (run.bold) props.push("<w:b/>");
  if (run.italic) props.push("<w:i/>");
  if (extraProps) props.push(extraProps);
  const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
}

function markdownToDocumentXml(md) {
  const lines = md.split(/\r\n|\n/);
  const paras = [];
  for (const raw of lines) {
    const line = raw;
    if (line.trim() === "") { paras.push('<w:p/>'); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const sz = HEADING_SIZES[level];
      const runs = parseInline(heading[2]).map(r => runXml(r, `<w:b/><w:sz w:val="${sz}"/>`)).join("");
      paras.push(`<w:p>${runs}</w:p>`);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const runs = [{ text: "•  " }, ...parseInline(bullet[1])].map(r => runXml(r)).join("");
      paras.push(`<w:p>${runs}</w:p>`);
      continue;
    }

    const runs = parseInline(line).map(r => runXml(r)).join("");
    paras.push(`<w:p>${runs}</w:p>`);
  }
  return paras.join("");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body>
</w:document>`;
}

/**
 * Convert a Markdown source file into a .docx file.
 * @returns {{ source, destination, paragraphs, bytes }}
 */
function mdToDocx(absSrc, origSrc, absDest, origDest) {
  let stat;
  try { stat = fs.statSync(absSrc); }
  catch (e) { throw new ToolError(`md_to_docx: cannot access '${origSrc}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`md_to_docx: '${origSrc}' is not a regular file.`, -32602);

  const md = fs.readFileSync(absSrc, "utf8");
  const body = markdownToDocumentXml(md);
  const zipBuf = buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels",         data: Buffer.from(RELS, "utf8") },
    { name: "word/document.xml",   data: Buffer.from(documentXml(body), "utf8") },
  ]);

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, zipBuf);
  } catch (e) {
    throw new ToolError(`md_to_docx: cannot write to '${origDest}': ${e.message}`, -32603);
  }

  const paragraphs = (body.match(/<w:p[ >]/g) || []).length;
  return { source: origSrc, destination: origDest, paragraphs, bytes: zipBuf.length };
}

/**
 * Convert a .docx file into a best-effort Markdown text file.
 * @returns {{ source, destination, paragraphs, bytes }}
 */
function docxToMd(absSrc, origSrc, absDest, origDest) {
  let stat;
  try { stat = fs.statSync(absSrc); }
  catch (e) { throw new ToolError(`docx_to_md: cannot access '${origSrc}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`docx_to_md: '${origSrc}' is not a regular file.`, -32602);

  const zipBuf = fs.readFileSync(absSrc);
  let entries;
  try { entries = parseCentralDirectory(zipBuf); }
  catch (e) { throw new ToolError(`docx_to_md: '${origSrc}' is not a valid .docx/ZIP file: ${e.message}`, -32602); }

  const docEntry = entries.find(e => e.name === "word/document.xml");
  if (!docEntry) throw new ToolError(`docx_to_md: '${origSrc}' has no word/document.xml part — not a valid .docx file.`, -32602);

  const xml = readEntryData(zipBuf, docEntry).toString("utf8");
  const paraMatches = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) || [];

  const mdLines = [];
  for (const p of paraMatches) {
    const styleMatch = /<w:pStyle[^>]*w:val="(Heading[1-6]|heading ?([1-6]))"/i.exec(p);
    const runMatches = p.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) || [];
    let text = "";
    for (const r of runMatches) {
      const tMatch = /<w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(r);
      if (!tMatch) continue;
      let t = tMatch[1]
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      const bold = /<w:b\/>|<w:b w:val="(1|true)"/.test(r);
      const italic = /<w:i\/>|<w:i w:val="(1|true)"/.test(r);
      if (bold && italic) t = `***${t}***`;
      else if (bold) t = `**${t}**`;
      else if (italic) t = `*${t}*`;
      text += t;
    }
    if (styleMatch) {
      const level = (styleMatch[1].match(/[1-6]/) || ["1"])[0];
      mdLines.push(`${"#".repeat(Number(level))} ${text.replace(/^\*\*|\*\*$/g, "")}`);
    } else if (text.trimStart().startsWith("•")) {
      mdLines.push(`- ${text.replace(/^\s*•\s*/, "")}`);
    } else {
      mdLines.push(text);
    }
  }

  const mdText = mdLines.join("\n") + "\n";
  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, mdText, "utf8");
  } catch (e) {
    throw new ToolError(`docx_to_md: cannot write to '${origDest}': ${e.message}`, -32603);
  }

  return { source: origSrc, destination: origDest, paragraphs: paraMatches.length, bytes: Buffer.byteLength(mdText, "utf8") };
}

module.exports = { mdToDocx, docxToMd, buildZip, markdownToDocumentXml };
