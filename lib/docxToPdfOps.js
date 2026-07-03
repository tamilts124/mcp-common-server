"use strict";
// ── docx_to_pdf — zero-dependency Word (.docx) -> PDF converter that keeps
// inline images, tables, and basic run formatting ──────────────────────────
// docx_to_md + md_to_pdf (see docxConvertOps.js / pdfConvertOps.js) round-trip
// through Markdown and silently drop any inline picture, table, font color,
// or explicit font size a resume/report might contain — Markdown-as-
// intermediate has no representation for those in this project's converter
// subset. This tool skips that intermediate entirely: it reads
// word/document.xml directly for paragraph text/headings/bullets/tables and
// walks each paragraph's <w:drawing> (or legacy <w:pict>/<v:imagedata>)
// elements to pull the referenced picture out of word/media/ via the
// word/_rels/document.xml.rels relationship map, embedding it as a real PDF
// Image XObject positioned inline at its authored size (from <wp:extent>,
// falling back to the image's own pixel size at 96dpi).
//
// Formatting fidelity supported:
//   - Bold / italic (real Helvetica-Bold / -Oblique / -BoldOblique fonts).
//   - Run-level font color (<w:color w:val="RRGGBB"/>).
//   - Paragraph-level font size (<w:sz w:val=".."/>, first run in the
//     paragraph that declares one — Word applies size per-run, this project
//     approximates it at paragraph granularity to keep layout/wrapping
//     tractable without a dependency).
//   - Tables (<w:tbl>): real column widths from <w:tblGrid>/<w:gridCol w:w>
//     when present (proportionally rescaled to the page's usable width;
//     equal-width fallback if no grid is declared), per-cell text (bold/
//     italic/color preserved, one wrapped paragraph per cell), per-cell
//     shading (<w:shd w:fill="RRGGBB"/>), and a stroked border grid around
//     every cell (approximates Word's common "All Borders" table style —
//     exact per-edge border-style/width from <w:tblBorders>/<w:tcBorders> is
//     not modeled, every table renders with a uniform thin black grid).
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

const { xmlUnescape, parseRels, parseDocumentXml } = require("./docxXmlOps");
const { detectImageKind, readJpegInfo, decodePng } = require("./imageDecodeOps");

// ═══════════════════════════ PAGE LAYOUT ═══════════════════════════

const PAGE_W = 612, PAGE_H = 792, MARGIN = 72;
const BODY_SIZE = 11, LINE_HEIGHT = 14;
const HEADING_SIZES = { 1: 22, 2: 19, 3: 16, 4: 14, 5: 12, 6: 11 };
const CELL_PAD = 4;
const TABLE_GAP_AFTER = 8;

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
    for (const p of parts) words.push({ text: p, bold: r.bold, italic: r.italic, color: r.color || null });
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

// Lay out a table block into draw ops appended to `cur` (mutated in place),
// starting at vertical position `y`, calling `newPage()` (which resets `cur`
// via the pages/y closures owned by the caller) whenever a row wouldn't fit.
// Returns the new `y` and (possibly new, post-page-break) `cur` array.
function layoutTable(table, cur, y, newPage, usableWidth) {
  const rows = table.rows;
  const numCols = Math.max(1, ...rows.map(r => r.length));
  // Real column widths from <w:tblGrid> (twips, proportionally rescaled to
  // fit usableWidth) when available and well-formed; equal-width fallback
  // otherwise (unchanged from prior behavior).
  let colWidths;
  if (table.colWidths && table.colWidths.length === numCols) {
    const total = table.colWidths.reduce((a, w) => a + w, 0);
    colWidths = table.colWidths.map(w => (w / total) * usableWidth);
  } else {
    colWidths = new Array(numCols).fill(usableWidth / numCols);
  }
  const colX = [];
  { let acc = 0; for (let c = 0; c < numCols; c++) { colX.push(acc); acc += colWidths[c]; } }

  for (const row of rows) {
    const cellLines = row.map((cell, c) => {
      const runs = [];
      for (const cb of cell.blocks) if (cb.runs) runs.push(...cb.runs);
      if (runs.length === 0) runs.push({ text: "" });
      return wrapRuns(runs, BODY_SIZE, colWidths[c] - 2 * CELL_PAD);
    });
    const lineCount = Math.max(1, ...cellLines.map(l => l.length));
    const rowHeight = lineCount * LINE_HEIGHT + 2 * CELL_PAD;

    if (y - rowHeight < MARGIN) { cur = newPage(); }
    const rowTop = y;

    for (let c = 0; c < row.length; c++) {
      const cx = MARGIN + colX[c];
      const cw = colWidths[c];
      const fill = row[c].fill;
      if (fill) cur.push({ type: "rect", x: cx, y: rowTop - rowHeight, w: cw, h: rowHeight, fill });
      cur.push({ type: "strokeRect", x: cx, y: rowTop - rowHeight, w: cw, h: rowHeight });
      let ty = rowTop - CELL_PAD - BODY_SIZE * 0.85;
      for (const line of cellLines[c]) {
        cur.push({ type: "text", line, fontSize: BODY_SIZE, baseline: ty, x: cx + CELL_PAD });
        ty -= LINE_HEIGHT;
      }
    }
    y = rowTop - rowHeight;
  }
  y -= TABLE_GAP_AFTER;
  return { y, cur };
}

// Lay out blocks into pages of draw ops. Each op is one of:
//   { type: 'text', line: [{text,bold,italic,color}...], fontSize, baseline, x? }
//   { type: 'image', relId, x, y, w, h }
//   { type: 'rect', x, y, w, h, fill: [r,g,b] }        (table cell shading)
//   { type: 'strokeRect', x, y, w, h }                  (table cell border)
// `baseline`/`y` are absolute PDF-space coordinates (origin bottom-left) so
// text and images can be interleaved freely without a running text cursor.
function layoutPages(blocks, imageCache) {
  const usableWidth = PAGE_W - 2 * MARGIN;
  const maxImgHeight = PAGE_H - 2 * MARGIN;
  const pages = [];
  let cur = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => { if (cur.length) pages.push(cur); cur = []; y = PAGE_H - MARGIN; return cur; };

  for (const b of blocks) {
    if (b.kind === "table") {
      const result = layoutTable(b, cur, y, newPage, usableWidth);
      cur = result.cur; y = result.y;
      continue;
    }

    if (b.kind === "image") {
      const info = imageCache.get(b.relId);
      if (!info || info.kind === "unsupported") {
        const label = `[Image not embedded: ${info ? info.name : b.relId} — unsupported format]`;
        const wrapped = wrapRuns([{ text: label, italic: true }], BODY_SIZE, usableWidth);
        for (const line of wrapped) {
          if (y < MARGIN + LINE_HEIGHT) { cur = newPage(); }
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
      if (y - hPt < MARGIN) { cur = newPage(); }
      cur.push({ type: "image", relId: b.relId, x: MARGIN, y: y - hPt, w: wPt, h: hPt });
      y -= hPt + 6;
      continue;
    }

    const fontSize = b.kind === "heading" ? HEADING_SIZES[b.level] : (b.fontSize || BODY_SIZE);
    const bold = b.kind === "heading";
    let runs = b.runs;
    if (b.kind === "bullet") runs = [{ text: "\u2022  " }, ...runs];
    if (bold) runs = runs.map(r => ({ ...r, bold: true }));
    const wrapped = wrapRuns(runs, fontSize, usableWidth);
    for (const line of wrapped) {
      const leading = fontSize === BODY_SIZE ? LINE_HEIGHT : fontSize + 6;
      if (y < MARGIN + leading) { cur = newPage(); }
      cur.push({ type: "text", line, fontSize, baseline: y });
      y -= leading;
    }
  }
  newPage();
  if (pages.length === 0) pages.push([]);
  return pages;
}

// ═══════════════════════════ PDF SERIALIZATION ═══════════════════════════

function fontNameFor(bold, italic) {
  if (bold && italic) return "/F4";
  if (bold) return "/F2";
  if (italic) return "/F3";
  return "/F1";
}

function pageContentStream(ops, imageXNames) {
  const chunks = [];
  for (const op of ops) {
    if (op.type === "image") {
      const name = imageXNames.get(op.relId);
      if (!name) continue;
      chunks.push(`q ${op.w.toFixed(2)} 0 0 ${op.h.toFixed(2)} ${op.x.toFixed(2)} ${op.y.toFixed(2)} cm ${name} Do Q`);
      continue;
    }
    if (op.type === "rect") {
      const [r, g, bch] = op.fill;
      chunks.push(`q ${r.toFixed(3)} ${g.toFixed(3)} ${bch.toFixed(3)} rg ${op.x.toFixed(2)} ${op.y.toFixed(2)} ${op.w.toFixed(2)} ${op.h.toFixed(2)} re f Q`);
      continue;
    }
    if (op.type === "strokeRect") {
      chunks.push(`q 0 0 0 RG 0.75 w ${op.x.toFixed(2)} ${op.y.toFixed(2)} ${op.w.toFixed(2)} ${op.h.toFixed(2)} re S Q`);
      continue;
    }

    // text
    let seg = "", curBold = null, curItalic = null, curColorKey = null, curColor = null;
    const runOps = [];
    const flush = () => {
      if (seg === "") return;
      const font = fontNameFor(curBold, curItalic);
      const colorOp = curColor ? `${curColor[0].toFixed(3)} ${curColor[1].toFixed(3)} ${curColor[2].toFixed(3)} rg` : "0 0 0 rg";
      runOps.push(`${colorOp} ${font} ${op.fontSize} Tf (${pdfStringEscape(seg)}) Tj`);
      seg = "";
    };
    for (const w of op.line) {
      const wColorKey = w.color ? w.color.join(",") : null;
      if (curBold === null) { curBold = !!w.bold; curItalic = !!w.italic; curColorKey = wColorKey; curColor = w.color || null; }
      if (!!w.bold !== curBold || !!w.italic !== curItalic || wColorKey !== curColorKey) {
        flush();
        curBold = !!w.bold; curItalic = !!w.italic; curColorKey = wColorKey; curColor = w.color || null;
      }
      seg += w.text;
    }
    flush();
    if (runOps.length === 0) continue;
    const xPos = op.x !== undefined ? op.x : MARGIN;
    chunks.push(`BT ${xPos.toFixed(2)} ${op.baseline.toFixed(2)} Td ${runOps.join(" ")} ET`);
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
  const fontItalicId  = nextId(); objects.push({ type: "dict", text: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>" });
  const fontBoldItId  = nextId(); objects.push({ type: "dict", text: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique >>" });

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
        `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontItalicId} 0 R /F4 ${fontBoldItId} 0 R >>${xobjDict} >> /Contents ${contentIds[i]} 0 R >>`,
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
 * (JPEG/PNG), tables (with borders/shading), and run-level color/paragraph-
 * level font size — instead of dropping them the way the docx_to_md ->
 * md_to_pdf round-trip does.
 * @returns {{ source, destination, pages, bytes, imagesEmbedded, imagesSkipped, tables }}
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
  const tables = blocks.filter(b => b.kind === "table").length;

  return {
    source: origSrc, destination: origDest,
    pages: pages.length, bytes: pdfBuf.length,
    imagesEmbedded, imagesSkipped, tables,
  };
}

module.exports = { docxToPdf };
