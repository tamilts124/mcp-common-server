"use strict";
// ── PDF rich content extraction ─────────────────────────────────────────────
// Best-effort, zero-dependency (regex-based, no xref-table parsing, matching
// this project's other converters) extractor that goes beyond pdf_to_md's
// plain-text output: per-run font size (Tf), fill color (rg/g), bold/italic
// (BaseFont name heuristic resolved via a global /Font resource-name -> object
// map), pipe-delimited tables (same convention md_to_pdf/pdf_to_md already
// round-trip), and image XObjects: DCTDecode (JPEG) embedded byte-for-byte,
// and FlateDecode 8-bit DeviceRGB/DeviceGray raw samples re-encoded into a
// real PNG via pngEncodeOps.js. Indexed/Separation/ICCBased colorspaces and
// non-8-bit depth are skipped, same "unsupported -> documented limitation"
// pattern docxToPdfOps.js uses for GIF/BMP/TIFF/WMF/EMF/WebP in the other
// direction.
// Limitations: resource-name -> object maps are built globally across the
// whole file rather than per-page (simplification; works for the common case
// of one shared resource dict), and object bodies are found via a plain
// "N 0 obj ... endobj" regex scan, which does not resolve objects living
// inside compressed object streams (cross-reference streams) -- those simply
// yield no BaseFont/XObject match and fall back to default (non-bold, no
// image) behavior rather than crashing.

const zlib = require("zlib");
const { decodePdfString } = require("./pdfConvertOps");
const { readJpegInfo } = require("./imageDecodeOps");
const { encodePng } = require("./pngEncodeOps");

function buildObjectMap(raw) {
  const map = new Map();
  const re = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(raw)) !== null) map.set(Number(m[1]), m[2]);
  return map;
}

// Maps a resource dict kind (e.g. "Font", "XObject") declared anywhere in the
// file to { resourceName -> objNum }, merging every occurrence found (simple
// global approximation instead of per-page /Resources resolution).
function buildResourceMap(raw, dictKind) {
  const map = new Map();
  const dictRe = new RegExp(`/${dictKind}\\s*<<([^>]*(?:<<[^<>]*>>[^>]*)*)>>`, "g");
  let dm;
  while ((dm = dictRe.exec(raw)) !== null) {
    const entryRe = /\/([A-Za-z0-9#+\-_.]+)\s+(\d+)\s+0\s+R/g;
    let em;
    while ((em = entryRe.exec(dm[1])) !== null) map.set(em[1], Number(em[2]));
  }
  return map;
}

function buildFontStyleMap(raw, objMap) {
  const fontResMap = buildResourceMap(raw, "Font");
  const styleMap = new Map();
  for (const [resName, objNum] of fontResMap) {
    const content = objMap.get(objNum) || "";
    const bfMatch = /\/BaseFont\s*\/([^\s\/>]+)/.exec(content);
    const baseFont = bfMatch ? bfMatch[1] : "";
    styleMap.set(resName, {
      bold: /bold/i.test(baseFont),
      italic: /italic|oblique/i.test(baseFont),
      baseFont,
    });
  }
  return styleMap;
}

// Extracts /Subtype /Image XObjects:
//  - /Filter /DCTDecode (JPEG): compressed bytes embedded byte-for-byte, no
//    re-encoding, mirroring docxToPdfOps.js's JPEG handling in reverse.
//  - /Filter /FlateDecode + 8-bit /DeviceRGB or /DeviceGray (raw pixel
//    samples, the common case for simple graphics/scans a PDF producer
//    stored uncompressed-then-deflated rather than as a JPEG): inflated and
//    hand-re-encoded into a real PNG file via pngEncodeOps.js, since docx
//    media needs an actual image file, not raw sample bytes.
//  Indexed/Separation/ICCBased colorspaces, non-8-bit depth, and any other
//  filter are left unsupported (skipped, not crashed on) -- same
//  "unsupported -> documented limitation" pattern docxToPdfOps.js uses for
//  GIF/BMP/TIFF/WMF/EMF/WebP on the other conversion direction.
function extractImages(raw) {
  const images = new Map(); // objNum -> { width, height, kind:'jpeg'|'png', data }
  const re = /(\d+)\s+0\s+obj\s*(<<(?:[^<>]|<<[^<>]*>>)*?\/Subtype\s*\/Image(?:[^<>]|<<[^<>]*>>)*?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, objNumStr, dict, streamBody] = m;
    const streamBuf = Buffer.from(streamBody, "latin1");

    if (/\/Filter\s*(\/DCTDecode|\[[^\]]*\/DCTDecode)/.test(dict)) {
      let width, height;
      try {
        const info = readJpegInfo(streamBuf);
        width = info.width; height = info.height;
      } catch (e) {
        const wM = /\/Width\s+(\d+)/.exec(dict), hM = /\/Height\s+(\d+)/.exec(dict);
        if (!wM || !hM) continue;
        width = Number(wM[1]); height = Number(hM[1]);
      }
      images.set(Number(objNumStr), { width, height, kind: "jpeg", data: streamBuf, sourceBytes: streamBuf });
      continue;
    }

    if (/\/Filter\s*(\/FlateDecode|\[[^\]]*\/FlateDecode)/.test(dict)) {
      const wM = /\/Width\s+(\d+)/.exec(dict), hM = /\/Height\s+(\d+)/.exec(dict);
      const bpcM = /\/BitsPerComponent\s+(\d+)/.exec(dict);
      const isRgb = /\/ColorSpace\s*\/DeviceRGB/.test(dict);
      const isGray = /\/ColorSpace\s*\/DeviceGray/.test(dict);
      if (!wM || !hM || !bpcM || Number(bpcM[1]) !== 8 || (!isRgb && !isGray)) continue;
      const width = Number(wM[1]), height = Number(hM[1]);
      let samples;
      try { samples = zlib.inflateSync(streamBuf); }
      catch (e) { continue; }
      let png;
      try { png = encodePng(width, height, samples, isRgb ? 3 : 1); }
      catch (e) { continue; }
      images.set(Number(objNumStr), { width, height, kind: "png", data: png });
    }
  }
  return images;
}

// GFM-style pipe row detection, matching pdfConvertOps.js's markdownToPages
// table convention so PDFs produced by this project's own md_to_pdf (and any
// PDF whose extracted text literally contains "| a | b |" rows) round-trip
// as real w:tbl tables instead of flat paragraphs.
function splitTableRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map(c => c.trim());
}
function looksLikeTableRow(line) {
  return line.includes("|") && splitTableRow(line).length >= 2;
}

const OP_RE = /\/(?<fontRes>[A-Za-z0-9#+\-_.]+)\s+(?<fontSize>[\d.]+)\s+Tf|(?<rgR>[\d.]+)\s+(?<rgG>[\d.]+)\s+(?<rgB>[\d.]+)\s+rg|(?<grayG>[\d.]+)\s+g\b|\((?<tjText>(?:\\.|[^\\)])*)\)\s*Tj|\[(?<tjArr>(?:[^\]])*)\]\s*TJ|(?<star>T\*)|(?<td1>[\d.\-]+)\s+(?<td2>[\d.\-]+)\s+Td|(?<td3>[\d.\-]+)\s+(?<td4>[\d.\-]+)\s+TD|\/(?<xobj>[A-Za-z0-9#+\-_.]+)\s+Do|\b(?<bt>BT)\b/g;

// Walks one decompressed content-stream string in operator order, emitting
// { kind:'line', runs:[{text,bold,italic,color,fontSize}], x, y } and
// { kind:'image', relName } blocks (relName resolved to actual image bytes
// by the caller via the XObject resource map, since the resource map is
// built globally rather than per-stream). x/y are the text position
// (PDF user-space, origin bottom-left) accumulated from Td/TD offsets since
// the last BT (text matrix reset) -- an approximation valid for the common
// case of simple generated content that never sets an explicit Tm, same
// "best-effort heuristic" tradeoff as the rest of this file. Used by
// detectGeometricTable() to map text back onto ruled-line table cells.
function walkContentStream(content, fontStyleMap) {
  const blocks = [];
  let curFont = { size: 11, bold: false, italic: false };
  let curColor = null; // [r,g,b] 0-1, null = default black
  let curRuns = [];
  let curText = "";
  let posX = 0, posY = 0;

  const flushRun = () => {
    if (curText === "") return;
    curRuns.push({ text: curText, bold: curFont.bold, italic: curFont.italic, color: curColor, fontSize: curFont.size });
    curText = "";
  };
  const flushLine = () => {
    flushRun();
    if (curRuns.length) { blocks.push({ kind: "line", runs: curRuns, x: posX, y: posY }); curRuns = []; }
  };

  let m;
  OP_RE.lastIndex = 0;
  while ((m = OP_RE.exec(content)) !== null) {
    const g = m.groups;
    if (g.bt !== undefined) {
      flushLine();
      posX = 0; posY = 0;
    } else if (g.fontRes !== undefined) {
      flushRun();
      const style = fontStyleMap.get(g.fontRes) || { bold: false, italic: false };
      curFont = { size: Number(g.fontSize) || 11, bold: style.bold, italic: style.italic };
    } else if (g.rgR !== undefined) {
      flushRun();
      const r = Number(g.rgR), gr = Number(g.rgG), b = Number(g.rgB);
      curColor = (r === 0 && gr === 0 && b === 0) ? null : [r, gr, b];
    } else if (g.grayG !== undefined) {
      flushRun();
      const gray = Number(g.grayG);
      curColor = gray === 0 ? null : [gray, gray, gray];
    } else if (g.tjText !== undefined) {
      curText += decodePdfString(g.tjText);
    } else if (g.tjArr !== undefined) {
      const strRe = /\(((?:\\.|[^\\)])*)\)/g;
      let sm;
      while ((sm = strRe.exec(g.tjArr)) !== null) curText += decodePdfString(sm[1]);
    } else if (g.star !== undefined) {
      flushLine();
    } else if (g.td1 !== undefined) {
      flushLine();
      posX += Number(g.td1); posY += Number(g.td2);
    } else if (g.td3 !== undefined) {
      flushLine();
      posX += Number(g.td3); posY += Number(g.td4);
    } else if (g.xobj !== undefined) {
      flushLine();
      blocks.push({ kind: "image", relName: g.xobj });
    }
  }
  flushLine();
  return blocks;
}

// Detects ruled-line (geometric) tables from two drawing conventions:
//  1. a solid rectangular grid of stroked rects (`x y w h re S`, the exact
//     pattern docxToPdfOps.js emits per table cell), or
//  2. a grid drawn as raw stroked line segments (`x1 y1 m x2 y2 l S`) --
//     each full-span horizontal/vertical line is a grid line, and cells are
//     the rectangles implied by consecutive grid-line intersections.
// Either way, text is mapped onto cells via the x/y position tracked on
// each line block by walkContentStream (Td/TD accumulated since last BT).
// Distinct from the pipe-delimited convention above -- this covers real
// bordered tables, not just literal "| a | b |" text.
// Documented scope (same "best-effort, not fixed" pattern as the rest of
// this file): only a perfectly solid rows*cols grid is recognized --
// ragged layouts, merged cells, and partial/sparse rulings fall back to
// flowed paragraph text (the existing pre-this-feature behavior, so this
// stays strictly additive with no regression risk); rotated or
// non-axis-aligned tables are out of scope.
function detectRectGrid(streamText) {
  const RECT_RE = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\s+S\b/g;
  const rects = [];
  let m;
  while ((m = RECT_RE.exec(streamText)) !== null) {
    rects.push({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) });
  }
  if (rects.length < 4) return null;

  const round = n => Math.round(n * 4) / 4; // quarter-unit tolerance bucket
  const xs = [...new Set(rects.map(r => round(r.x)))].sort((a, b) => a - b);
  const ys = [...new Set(rects.map(r => round(r.y)))].sort((a, b) => b - a); // descending: top row first
  const numCols = xs.length, numRows = ys.length;
  if (numCols < 2 || numRows < 2) return null;
  if (rects.length !== numCols * numRows) return null; // only solid rectangular grids

  const colIndex = new Map(xs.map((x, i) => [x, i]));
  const rowIndex = new Map(ys.map((y, i) => [y, i]));
  const grid = Array.from({ length: numRows }, () => new Array(numCols).fill(null));
  for (const r of rects) {
    const c = colIndex.get(round(r.x));
    const rIdx = rowIndex.get(round(r.y));
    if (c === undefined || rIdx === undefined || grid[rIdx][c]) return null; // dup coord: not a clean grid
    grid[rIdx][c] = r;
  }
  return { grid, numRows, numCols };
}

function detectLineSegmentGrid(streamText) {
  const LINE_RE = /(-?[\d.]+)\s+(-?[\d.]+)\s+m\s+(-?[\d.]+)\s+(-?[\d.]+)\s+l\s+S\b/g;
  const segs = [];
  let m;
  while ((m = LINE_RE.exec(streamText)) !== null) {
    segs.push({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) });
  }
  if (segs.length < 6) return null; // need >=3 horizontal + >=3 vertical for a 2x2 grid

  const EPS = 1.0;
  const round = n => Math.round(n * 4) / 4;
  const horiz = segs.filter(s => Math.abs(s.y1 - s.y2) < EPS && Math.abs(s.x1 - s.x2) >= EPS);
  const vert = segs.filter(s => Math.abs(s.x1 - s.x2) < EPS && Math.abs(s.y1 - s.y2) >= EPS);
  if (horiz.length < 3 || vert.length < 3) return null;

  const xs = [...new Set(vert.map(s => round(s.x1)))].sort((a, b) => a - b);
  const ys = [...new Set(horiz.map(s => round(s.y1)))].sort((a, b) => b - a);
  const numCols = xs.length - 1, numRows = ys.length - 1;
  if (numCols < 2 || numRows < 2) return null;
  // exactly numRows+1 / numCols+1 distinct lines expected -- extra/dup lines mean a non-uniform layout
  if (horiz.length !== numRows + 1 || vert.length !== numCols + 1) return null;

  const minX = xs[0], maxX = xs[xs.length - 1];
  const minY = ys[ys.length - 1], maxY = ys[0];
  // every horizontal line must span the full column range and vice versa -- otherwise it's a
  // partial ruling (e.g. a single underline), not a complete table grid
  for (const s of horiz) {
    const lo = Math.min(s.x1, s.x2), hi = Math.max(s.x1, s.x2);
    if (lo > minX + EPS || hi < maxX - EPS) return null;
  }
  for (const s of vert) {
    const lo = Math.min(s.y1, s.y2), hi = Math.max(s.y1, s.y2);
    if (lo > minY + EPS || hi < maxY - EPS) return null;
  }

  const grid = Array.from({ length: numRows }, (_, r) =>
    Array.from({ length: numCols }, (_, c) => ({
      x: xs[c], y: ys[r + 1], w: xs[c + 1] - xs[c], h: ys[r] - ys[r + 1],
    }))
  );
  return { grid, numRows, numCols };
}

function mapTextOntoGrid(grid, numRows, numCols, streamLineBlocks) {
  const allRects = grid.flat();
  const minX = Math.min(...allRects.map(r => r.x));
  const maxX = Math.max(...allRects.map(r => r.x + r.w));
  const minY = Math.min(...allRects.map(r => r.y));
  const maxY = Math.max(...allRects.map(r => r.y + r.h));
  const EPS = 1.0;

  const rowsText = Array.from({ length: numRows }, () => new Array(numCols).fill(""));
  const consumed = new Set();
  streamLineBlocks.forEach((b, idx) => {
    if (b.kind !== "line") return;
    const { x, y } = b;
    if (x < minX - EPS || x > maxX + EPS || y < minY - EPS || y > maxY + EPS) return;
    outer:
    for (let rIdx = 0; rIdx < numRows; rIdx++) {
      for (let c = 0; c < numCols; c++) {
        const cell = grid[rIdx][c];
        if (x >= cell.x - EPS && x <= cell.x + cell.w + EPS && y >= cell.y - EPS && y <= cell.y + cell.h + EPS) {
          const text = b.runs.map(r2 => r2.text).join("");
          rowsText[rIdx][c] = rowsText[rIdx][c] ? rowsText[rIdx][c] + " " + text : text;
          consumed.add(idx);
          break outer;
        }
      }
    }
  });
  if (consumed.size === 0) return null; // grid found but nothing mapped -- not worth it

  const colWidths = grid[0].map(cell => cell.w);
  return { rows: rowsText, colWidths, consumed };
}

function detectGeometricTable(streamLineBlocks, streamText) {
  const gridInfo = detectRectGrid(streamText) || detectLineSegmentGrid(streamText);
  if (!gridInfo) return null;
  return mapTextOntoGrid(gridInfo.grid, gridInfo.numRows, gridInfo.numCols, streamLineBlocks);
}

/**
 * Extract a rich (formatting + tables + images preserved where detectable)
 * document structure from a PDF buffer.
 * @returns {{ blocks: Array, imagesEmbedded: number }}
 *   blocks: { kind:'para', runs:[{text,bold,italic,color,fontSize}] }
 *         | { kind:'table', rows: string[][] }
 *         | { kind:'image', width, height, data: Buffer, imageKind: 'jpeg'|'png' }
 */
function extractRichDocument(buf) {
  const raw = buf.toString("latin1");
  const objMap = buildObjectMap(raw);
  const fontStyleMap = buildFontStyleMap(raw, objMap);
  const xobjResMap = buildResourceMap(raw, "XObject");
  const images = extractImages(raw);
  // PNG-kind entries were already inflated+re-encoded (data != raw stream
  // bytes), so only original JPEG stream bytes need matching here to skip
  // re-parsing an image's own compressed data as page content.
  const jpegDataSet = new Set([...images.values()].filter(v => v.kind === "jpeg").map(v => v.data));

  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const lineBlocks = [];
  let sm;
  while ((sm = streamRe.exec(raw)) !== null) {
    const rawBytes = Buffer.from(sm[1], "latin1");
    if ([...jpegDataSet].some(d => d.equals(rawBytes))) continue; // skip image's own stream
    let text;
    try { text = zlib.inflateSync(rawBytes).toString("latin1"); }
    catch (e) { text = sm[1]; }
    if (!/BT[\s\S]*ET/.test(text) && !/\bDo\b/.test(text)) continue;
    const streamBlocks = walkContentStream(text, fontStyleMap);
    const geoTable = detectGeometricTable(streamBlocks, text);
    if (geoTable) {
      let inserted = false;
      for (let idx = 0; idx < streamBlocks.length; idx++) {
        if (geoTable.consumed.has(idx)) {
          if (!inserted) { lineBlocks.push({ kind: "table", rows: geoTable.rows, colWidths: geoTable.colWidths }); inserted = true; }
          continue; // folded into the table block, drop the raw line
        }
        lineBlocks.push(streamBlocks[idx]);
      }
    } else {
      lineBlocks.push(...streamBlocks);
    }
  }

  // Group consecutive pipe-delimited lines into tables; resolve image blocks.
  const blocks = [];
  let i = 0;
  let imagesEmbedded = 0;
  while (i < lineBlocks.length) {
    const b = lineBlocks[i];
    if (b.kind === "table") { blocks.push(b); i++; continue; }
    if (b.kind === "image") {
      const objNum = xobjResMap.get(b.relName);
      const info = objNum !== undefined ? images.get(objNum) : undefined;
      if (info) { blocks.push({ kind: "image", width: info.width, height: info.height, data: info.data, imageKind: info.kind }); imagesEmbedded++; }
      i++;
      continue;
    }
    const lineText = b.runs.map(r => r.text).join("");
    if (looksLikeTableRow(lineText)) {
      const rows = [splitTableRow(lineText)];
      let j = i + 1;
      while (j < lineBlocks.length && lineBlocks[j].kind === "line") {
        const t = lineBlocks[j].runs.map(r => r.text).join("");
        if (!looksLikeTableRow(t)) break;
        rows.push(splitTableRow(t));
        j++;
      }
      if (rows.length >= 2) { blocks.push({ kind: "table", rows }); i = j; continue; }
    }
    blocks.push({ kind: "para", runs: b.runs });
    i++;
  }

  return { blocks, imagesEmbedded };
}

module.exports = { extractRichDocument, buildObjectMap, buildResourceMap, buildFontStyleMap, extractImages, detectGeometricTable, walkContentStream };
