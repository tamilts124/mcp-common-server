"use strict";
// ── docx_to_pdf — zero-dependency Word (.docx) -> PDF converter that keeps
// inline images ─────────────────────────────────────────────────────────────
// docx_to_md + md_to_pdf (see docxConvertOps.js / pdfConvertOps.js) round-trip
// through Markdown and silently drop any inline picture a resume/report might
// contain — Markdown-as-intermediate has no image representation in this
// project's converter subset. This tool skips that intermediate entirely: it
// reads word/document.xml directly for paragraph text/headings/bullets *and*
// walks each paragraph's <w:drawing> (or legacy <w:pict>/<v:imagedata>)
// elements to pull the referenced picture out of word/media/ via the
// word/_rels/document.xml.rels relationship map, embedding it as a real PDF
// Image XObject positioned inline at its authored size (from <wp:extent>,
// falling back to the image's own pixel size at 96dpi).
//
// Supported image formats (the two Word/Office normally produces):
//   - JPEG: any baseline/progressive SOF marker, embedded byte-for-byte via
//     the PDF /DCTDecode filter (no re-encoding, so quality is untouched).
//   - PNG: 8-bit grayscale / RGB / palette / grayscale+alpha / RGBA, non-
//     interlaced. Decoded by hand (zlib-inflate the IDAT stream, then apply
//     the PNG defilter algorithm per scanline) and re-encoded as raw 8-bit
//     DeviceRGB samples (+ a DeviceGray /SMask object for the alpha channel,
//     if present) compressed with /FlateDecode.
// Anything else (GIF/BMP/TIFF/WMF/EMF/WebP) has no lightweight zero-dependency
// PDF embedding path in a codebase with no image-decoding dependency, so it
// is rendered as a small italic placeholder line instead of failing the
// whole conversion.

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");
const { parseCentralDirectory, readEntryData } = require("./unzipOps");

// ═══════════════════════════ DOCX XML PARSING ═══════════════════════════

function xmlUnescape(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// Parse word/_rels/document.xml.rels -> { rId: target }
function parseRels(xml) {
  const map = {};
  const re = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) map[m[1]] = m[2];
  return map;
}

// Walk word/document.xml body and produce an ordered list of blocks:
//   { kind: 'heading', level, runs }
//   { kind: 'bullet', runs }
//   { kind: 'para', runs }
//   { kind: 'image', relId, cx, cy }   (cx/cy in EMUs, from <wp:extent>; null if absent)
// A paragraph that mixes running text with a picture (rare outside of resume
// headers) emits its image block(s) first, then a single text block for any
// non-empty text in that paragraph — good enough for the common case of a
// picture living in its own paragraph, which is how Word normally places one.
function parseDocumentXml(xml) {
  const paraMatches = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) || [];
  const blocks = [];

  for (const p of paraMatches) {
    const styleMatch = /<w:pStyle[^>]*w:val="(Heading[1-6]|heading ?([1-6]))"/i.exec(p);
    const isBullet = /<w:numPr>/.test(p);

    const runMatches = p.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) || [];
    const runs = [];
    const images = [];

    for (const r of runMatches) {
      const blip = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(r);
      const vml  = !blip ? /<v:imagedata\b[^>]*r:id="([^"]+)"/.exec(r) : null;
      if (blip || vml) {
        const relId = blip ? blip[1] : vml[1];
        const extentMatch = /<wp:extent\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(r);
        images.push({
          relId,
          cx: extentMatch ? Number(extentMatch[1]) : null,
          cy: extentMatch ? Number(extentMatch[2]) : null,
        });
        continue;
      }
      const tMatch = /<w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(r);
      if (!tMatch) continue;
      const bold = /<w:b\/>|<w:b w:val="(1|true)"/.test(r);
      const italic = /<w:i\/>|<w:i w:val="(1|true)"/.test(r);
      runs.push({ text: xmlUnescape(tMatch[1]), bold, italic });
    }

    for (const img of images) blocks.push({ kind: "image", ...img });
    if (runs.length === 0 && images.length > 0) continue;
    if (runs.length === 0) { blocks.push({ kind: "para", runs: [{ text: "" }] }); continue; }

    if (styleMatch) {
      const level = Number((styleMatch[1].match(/[1-6]/) || ["1"])[0]);
      blocks.push({ kind: "heading", level, runs });
    } else if (isBullet) {
      blocks.push({ kind: "bullet", runs });
    } else {
      blocks.push({ kind: "para", runs });
    }
  }
  return blocks;
}

// ═══════════════════════════ IMAGE DECODING ═══════════════════════════

function detectImageKind(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  return "unsupported";
}

// JPEG: only need width/height/component-count for the PDF image dict --
// the compressed data is embedded byte-for-byte via /DCTDecode, no decoding.
function readJpegInfo(buf) {
  let offset = 2; // skip SOI (FFD8)
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9) break; // EOI
    const segLen = buf.readUInt16BE(offset + 2);
    // SOF0..SOF15 frame markers, excluding DHT(C4)/JPG(C8)/DAC(CC) which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width  = buf.readUInt16BE(offset + 7);
      const components = buf[offset + 9];
      return { width, height, components };
    }
    offset += 2 + segLen;
  }
  throw new ToolError("docx_to_pdf: could not read JPEG dimensions (no SOF marker found).", -32602);
}

// PNG: decode IHDR, concatenate+inflate IDAT, undo the per-scanline filter,
// then normalize every supported color type down to 8-bit RGB (+ a separate
// 8-bit grayscale alpha buffer for the PDF /SMask, if the source has alpha).
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new ToolError("docx_to_pdf: not a valid PNG (bad signature).", -32602);
  let pos = 8;
  let width, height, bitDepth, colorType, palette = null, trns = null;
  const idatChunks = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const dataStart = pos + 8;
    const data = buf.slice(dataStart, dataStart + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new ToolError("docx_to_pdf: interlaced PNGs are not supported.", -32602);
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos = dataStart + len + 4; // skip CRC
  }
  if (!width) throw new ToolError("docx_to_pdf: PNG missing IHDR chunk.", -32602);
  if (bitDepth !== 8) throw new ToolError(`docx_to_pdf: only 8-bit PNGs are supported (got ${bitDepth}-bit).`, -32602);

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (channels === undefined) throw new ToolError(`docx_to_pdf: unsupported PNG color type ${colorType}.`, -32602);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const unfiltered = Buffer.alloc(height * stride);

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  let srcPos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[srcPos++];
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[srcPos++];
      const a = x >= bytesPerPixel ? unfiltered[rowStart + x - bytesPerPixel] : 0;
      const b = y > 0 ? unfiltered[prevRowStart + x] : 0;
      const c = (y > 0 && x >= bytesPerPixel) ? unfiltered[prevRowStart + x - bytesPerPixel] : 0;
      let value;
      switch (filterType) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + Math.floor((a + b) / 2); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new ToolError(`docx_to_pdf: unsupported PNG filter type ${filterType}.`, -32602);
      }
      unfiltered[rowStart + x] = value & 0xff;
    }
  }

  const rgb = Buffer.alloc(width * height * 3);
  let alpha = null;
  if (colorType === 4 || colorType === 6) alpha = Buffer.alloc(width * height);

  for (let i = 0, px = 0; px < width * height; px++, i += bytesPerPixel) {
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = unfiltered[i]; }
    else if (colorType === 2) { r = unfiltered[i]; g = unfiltered[i + 1]; b = unfiltered[i + 2]; }
    else if (colorType === 3) {
      const idx = unfiltered[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    } else if (colorType === 4) { r = g = b = unfiltered[i]; a = unfiltered[i + 1]; }
    else if (colorType === 6) { r = unfiltered[i]; g = unfiltered[i + 1]; b = unfiltered[i + 2]; a = unfiltered[i + 3]; }
    rgb[px * 3] = r; rgb[px * 3 + 1] = g; rgb[px * 3 + 2] = b;
    if (alpha) alpha[px] = a;
  }

  return { width, height, rgb, alpha };
}

// ═══════════════════════════ PAGE LAYOUT ═══════════════════════════

const PAGE_W = 612, PAGE_H = 792, MARGIN = 72;
const BODY_SIZE = 11, LINE_HEIGHT = 14;
const HEADING_SIZES = { 1: 22, 2: 19, 3: 16, 4: 14, 5: 12, 6: 11 };

function estWidth(text, fontSize, bold) {
  const factor = bold ? 0.56 : 0.50;
  return text.length * fontSize * factor;
}

function pdfStringEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/[\u0080-\uffff]/g, "");
}

function wrapRuns(runs, fontSize, maxWidth) {
  const words = [];
  for (const r of runs) {
    const parts = r.text.split(/(\s+)/).filter(p => p !== "");
    for (const p of parts) words.push({ text: p, bold: r.bold, italic: r.italic });
  }
  const lines = [];
  let cur = [], curWidth = 0;
  for (const w of words) {
    const isSpace = /^\s+$/.test(w.text);
    const ww = estWidth(w.text, fontSize, w.bold);
    if (!isSpace && curWidth + ww > maxWidth && cur.length > 0) { lines.push(cur); cur = []; curWidth = 0; }
    if (isSpace && cur.length === 0) continue;
    cur.push(w); curWidth += ww;
  }
  if (cur.length) lines.push(cur);
  if (lines.length === 0) lines.push([]);
  return lines;
}

// Lay out blocks into pages of draw ops. Each op is either:
//   { type: 'text', line: [{text,bold,italic}...], fontSize, baseline }
//   { type: 'image', relId, x, y, w, h }
// `baseline`/`y` are absolute PDF-space coordinates (origin bottom-left) so
// text and images can be interleaved freely without a running text cursor.
function layoutPages(blocks, imageCache) {
  const usableWidth = PAGE_W - 2 * MARGIN;
  const maxImgHeight = PAGE_H - 2 * MARGIN;
  const pages = [];
  let cur = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => { if (cur.length) pages.push(cur); cur = []; y = PAGE_H - MARGIN; };

  for (const b of blocks) {
    if (b.kind === "image") {
      const info = imageCache.get(b.relId);
      if (!info || info.kind === "unsupported") {
        const label = `[Image not embedded: ${info ? info.name : b.relId} — unsupported format]`;
        const wrapped = wrapRuns([{ text: label, italic: true }], BODY_SIZE, usableWidth);
        for (const line of wrapped) {
          if (y < MARGIN + LINE_HEIGHT) newPage();
          cur.push({ type: "text", line, fontSize: BODY_SIZE, baseline: y });
          y -= LINE_HEIGHT;
        }
        continue;
      }
      let wPt, hPt;
      if (b.cx && b.cy) { wPt = b.cx / 12700; hPt = b.cy / 12700; }
      else { wPt = info.width * 72 / 96; hPt = info.height * 72 / 96; }
      if (wPt > usableWidth) { const scale = usableWidth / wPt; wPt *= scale; hPt *= scale; }
      if (hPt > maxImgHeight) { const scale = maxImgHeight / hPt; wPt *= scale; hPt *= scale; }
      if (y - hPt < MARGIN) newPage();
      cur.push({ type: "image", relId: b.relId, x: MARGIN, y: y - hPt, w: wPt, h: hPt });
      y -= hPt + 6;
      continue;
    }

    const fontSize = b.kind === "heading" ? HEADING_SIZES[b.level] : BODY_SIZE;
    const bold = b.kind === "heading";
    let runs = b.runs;
    if (b.kind === "bullet") runs = [{ text: "\u2022  " }, ...runs];
    if (bold) runs = runs.map(r => ({ ...r, bold: true }));
    const wrapped = wrapRuns(runs, fontSize, usableWidth);
    for (const line of wrapped) {
      const leading = fontSize === BODY_SIZE ? LINE_HEIGHT : fontSize + 6;
      if (y < MARGIN + leading) newPage();
      cur.push({ type: "text", line, fontSize, baseline: y });
      y -= leading;
    }
  }
  newPage();
  if (pages.length === 0) pages.push([]);
  return pages;
}

// ═══════════════════════════ PDF SERIALIZATION ═══════════════════════════

function pageContentStream(ops, imageXNames) {
  const chunks = [];
  for (const op of ops) {
    if (op.type === "image") {
      const name = imageXNames.get(op.relId);
      if (!name) continue;
      chunks.push(`q ${op.w.toFixed(2)} 0 0 ${op.h.toFixed(2)} ${op.x.toFixed(2)} ${op.y.toFixed(2)} cm ${name} Do Q`);
      continue;
    }
    let seg = "", curBold = null;
    const runOps = [];
    const flush = () => {
      if (seg === "") return;
      const font = curBold ? "/F2" : "/F1";
      runOps.push(`${font} ${op.fontSize} Tf (${pdfStringEscape(seg)}) Tj`);
      seg = "";
    };
    for (const w of op.line) {
      if (curBold === null) curBold = !!w.bold;
      if (!!w.bold !== curBold) { flush(); curBold = !!w.bold; }
      seg += w.text;
    }
    flush();
    if (runOps.length === 0) continue;
    chunks.push(`BT ${MARGIN} ${op.baseline.toFixed(2)} Td ${runOps.join(" ")} ET`);
  }
  return chunks.join("\n");
}

// Serializes a list of { type:'dict', text } | { type:'stream', dict, data:Buffer }
// objects (1-indexed by array position) into a valid PDF file. Uses Buffer
// concatenation throughout (never a latin1 string round-trip) so binary
// image streams can't get corrupted, unlike pdfConvertOps.js's text-only
// buildPdf (which only ever serializes ASCII content streams).
function serializePdf(objects, catalogId) {
  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let offset = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    const id = i + 1;
    const obj = objects[i];
    let buf;
    if (obj.type === "dict") {
      buf = Buffer.from(`${id} 0 obj\n${obj.text}\nendobj\n`, "latin1");
    } else {
      const head = Buffer.from(`${id} 0 obj\n${obj.dict}\nstream\n`, "latin1");
      const tail = Buffer.from(`\nendstream\nendobj\n`, "latin1");
      buf = Buffer.concat([head, obj.data, tail]);
    }
    offsets.push(offset);
    parts.push(buf);
    offset += buf.length;
  }
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(Buffer.from(xref + trailer, "latin1"));
  return Buffer.concat(parts);
}

function buildPdfWithImages(pages, imageCache) {
  const objects = [];
  const nextId = () => objects.length + 1;

  const fontRegularId = nextId(); objects.push({ type: "dict", text: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" });
  const fontBoldId    = nextId(); objects.push({ type: "dict", text: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>" });

  const relIdsUsed = new Set();
  for (const ops of pages) for (const op of ops) if (op.type === "image") relIdsUsed.add(op.relId);

  const xObjIdByRelId = new Map();
  const xObjNameByRelId = new Map();
  let imgCounter = 0;
  for (const relId of relIdsUsed) {
    const info = imageCache.get(relId);
    if (!info || (info.kind !== "jpeg" && info.kind !== "png")) continue;
    imgCounter++;
    const xName = `/Im${imgCounter}`;

    let smaskId = null;
    if (info.kind === "png" && info.alpha) {
      const smaskData = zlib.deflateSync(info.alpha, { level: 6 });
      smaskId = nextId();
      objects.push({
        type: "stream",
        dict: `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${smaskData.length} >>`,
        data: smaskData,
      });
    }

    let imgObjId;
    if (info.kind === "jpeg") {
      const colorSpace = info.components === 1 ? "/DeviceGray" : info.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
      // Adobe-flavoured 4-component (CMYK/YCCK) JPEGs are conventionally
      // stored inverted; this is a best-effort approximation, not a full
      // Adobe APP14 transform reader.
      const decodeArr = info.components === 4 ? " /Decode [1 0 1 0 1 0 1 0]" : "";
      imgObjId = nextId();
      objects.push({
        type: "stream",
        dict: `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode${decodeArr} /Length ${info.data.length} >>`,
        data: info.data,
      });
    } else {
      const rgbData = zlib.deflateSync(info.rgb, { level: 6 });
      const smaskRef = smaskId ? ` /SMask ${smaskId} 0 R` : "";
      imgObjId = nextId();
      objects.push({
        type: "stream",
        dict: `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smaskRef} /Length ${rgbData.length} >>`,
        data: rgbData,
      });
    }
    xObjIdByRelId.set(relId, imgObjId);
    xObjNameByRelId.set(relId, xName);
  }

  const contentIds = [];
  for (const ops of pages) {
    const stream = pageContentStream(ops, xObjNameByRelId);
    const data = Buffer.from(stream, "latin1");
    const cid = nextId();
    objects.push({ type: "stream", dict: `<< /Length ${data.length} >>`, data });
    contentIds.push(cid);
  }

  const pagesId = nextId();
  objects.push(null); // reserve slot; filled in once page object ids are known
  const pageObjIds = [];
  for (let i = 0; i < pages.length; i++) {
    const xobjEntries = [];
    for (const op of pages[i]) {
      if (op.type !== "image") continue;
      const objId = xObjIdByRelId.get(op.relId);
      const name = xObjNameByRelId.get(op.relId);
      if (objId) xobjEntries.push(`${name} ${objId} 0 R`);
    }
    const xobjDict = xobjEntries.length ? ` /XObject << ${xobjEntries.join(" ")} >>` : "";
    const pid = nextId();
    pageObjIds.push(pid);
    objects.push({
      type: "dict",
      text: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >>${xobjDict} >> /Contents ${contentIds[i]} 0 R >>`,
    });
  }
  objects[pagesId - 1] = { type: "dict", text: `<< /Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>` };

  const catalogId = nextId();
  objects.push({ type: "dict", text: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` });

  return serializePdf(objects, catalogId);
}

// ═══════════════════════════ ENTRY POINT ═══════════════════════════

/**
 * Convert a .docx file directly into a .pdf file, embedding inline images
 * (JPEG/PNG) instead of dropping them the way the docx_to_md -> md_to_pdf
 * round-trip does.
 * @returns {{ source, destination, pages, bytes, imagesEmbedded, imagesSkipped }}
 */
function docxToPdf(absSrc, origSrc, absDest, origDest) {
  let stat;
  try { stat = fs.statSync(absSrc); }
  catch (e) { throw new ToolError(`docx_to_pdf: cannot access '${origSrc}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`docx_to_pdf: '${origSrc}' is not a regular file.`, -32602);

  const zipBuf = fs.readFileSync(absSrc);
  let entries;
  try { entries = parseCentralDirectory(zipBuf); }
  catch (e) { throw new ToolError(`docx_to_pdf: '${origSrc}' is not a valid .docx/ZIP file: ${e.message}`, -32602); }

  const byName = new Map(entries.map(e => [e.name, e]));
  const docEntry = byName.get("word/document.xml");
  if (!docEntry) throw new ToolError(`docx_to_pdf: '${origSrc}' has no word/document.xml part — not a valid .docx file.`, -32602);

  const documentXml = readEntryData(zipBuf, docEntry).toString("utf8");
  const relsEntry = byName.get("word/_rels/document.xml.rels");
  const rels = relsEntry ? parseRels(readEntryData(zipBuf, relsEntry).toString("utf8")) : {};

  const blocks = parseDocumentXml(documentXml);

  const imageCache = new Map();
  for (const b of blocks) {
    if (b.kind !== "image" || imageCache.has(b.relId)) continue;
    const target = rels[b.relId];
    if (!target) { imageCache.set(b.relId, { kind: "unsupported", name: b.relId }); continue; }
    const mediaPath = "word/" + target.replace(/^\.?\//, "");
    const mediaEntry = byName.get(mediaPath);
    if (!mediaEntry) { imageCache.set(b.relId, { kind: "unsupported", name: mediaPath }); continue; }
    const mediaBuf = readEntryData(zipBuf, mediaEntry);
    const kind = detectImageKind(mediaBuf);
    try {
      if (kind === "jpeg") {
        const info = readJpegInfo(mediaBuf);
        imageCache.set(b.relId, { kind: "jpeg", data: mediaBuf, ...info, name: mediaPath });
      } else if (kind === "png") {
        const info = decodePng(mediaBuf);
        imageCache.set(b.relId, { kind: "png", ...info, name: mediaPath });
      } else {
        imageCache.set(b.relId, { kind: "unsupported", name: mediaPath });
      }
    } catch (e) {
      imageCache.set(b.relId, { kind: "unsupported", name: mediaPath, error: e.message });
    }
  }

  const pages = layoutPages(blocks, imageCache);
  const pdfBuf = buildPdfWithImages(pages, imageCache);

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, pdfBuf);
  } catch (e) {
    throw new ToolError(`docx_to_pdf: cannot write to '${origDest}': ${e.message}`, -32603);
  }

  const imagesEmbedded = [...imageCache.values()].filter(v => v.kind === "jpeg" || v.kind === "png").length;
  const imagesSkipped  = [...imageCache.values()].filter(v => v.kind === "unsupported").length;

  return {
    source: origSrc, destination: origDest,
    pages: pages.length, bytes: pdfBuf.length,
    imagesEmbedded, imagesSkipped,
  };
}

module.exports = { docxToPdf };
