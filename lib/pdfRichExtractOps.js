"use strict";
// ── PDF rich content extraction ─────────────────────────────────────────────
// Best-effort, zero-dependency (regex-based, no xref-table parsing, matching
// this project's other converters) extractor that goes beyond pdf_to_md's
// plain-text output: per-run font size (Tf), fill color (rg/g), bold/italic
// (BaseFont name heuristic resolved via a global /Font resource-name -> object
// map), pipe-delimited tables (same convention md_to_pdf/pdf_to_md already
// round-trip), and JPEG image XObjects (DCTDecode only -- FlateDecode raw
// sample images have no lightweight re-encode path here and are skipped,
// same "unsupported -> documented limitation" pattern docxToPdfOps.js uses
// for GIF/BMP/TIFF/WMF/EMF/WebP in the other direction).
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

// Extracts /Subtype /Image XObjects whose stream is /DCTDecode (JPEG) --
// embeds the compressed bytes byte-for-byte, no re-encoding, mirroring
// docxToPdfOps.js's JPEG handling on the other conversion direction.
function extractJpegImages(raw) {
  const images = new Map(); // objNum -> { width, height, data }
  const re = /(\d+)\s+0\s+obj\s*(<<(?:[^<>]|<<[^<>]*>>)*?\/Subtype\s*\/Image(?:[^<>]|<<[^<>]*>>)*?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [, objNumStr, dict, streamBody] = m;
    if (!/\/Filter\s*(\/DCTDecode|\[[^\]]*\/DCTDecode)/.test(dict)) continue;
    const data = Buffer.from(streamBody, "latin1");
    let width, height;
    try {
      const info = readJpegInfo(data);
      width = info.width; height = info.height;
    } catch (e) {
      const wM = /\/Width\s+(\d+)/.exec(dict), hM = /\/Height\s+(\d+)/.exec(dict);
      if (!wM || !hM) continue;
      width = Number(wM[1]); height = Number(hM[1]);
    }
    images.set(Number(objNumStr), { width, height, data });
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

const OP_RE = /\/(?<fontRes>[A-Za-z0-9#+\-_.]+)\s+(?<fontSize>[\d.]+)\s+Tf|(?<rgR>[\d.]+)\s+(?<rgG>[\d.]+)\s+(?<rgB>[\d.]+)\s+rg|(?<grayG>[\d.]+)\s+g\b|\((?<tjText>(?:\\.|[^\\)])*)\)\s*Tj|\[(?<tjArr>(?:[^\]])*)\]\s*TJ|(?<star>T\*)|(?<td1>[\d.\-]+)\s+(?<td2>[\d.\-]+)\s+Td|(?<td3>[\d.\-]+)\s+(?<td4>[\d.\-]+)\s+TD|\/(?<xobj>[A-Za-z0-9#+\-_.]+)\s+Do/g;

// Walks one decompressed content-stream string in operator order, emitting
// { kind:'line', runs:[{text,bold,italic,color,fontSize}] } and
// { kind:'image', relName } blocks (relName resolved to actual image bytes
// by the caller via the XObject resource map, since the resource map is
// built globally rather than per-stream).
function walkContentStream(content, fontStyleMap) {
  const blocks = [];
  let curFont = { size: 11, bold: false, italic: false };
  let curColor = null; // [r,g,b] 0-1, null = default black
  let curRuns = [];
  let curText = "";

  const flushRun = () => {
    if (curText === "") return;
    curRuns.push({ text: curText, bold: curFont.bold, italic: curFont.italic, color: curColor, fontSize: curFont.size });
    curText = "";
  };
  const flushLine = () => {
    flushRun();
    if (curRuns.length) { blocks.push({ kind: "line", runs: curRuns }); curRuns = []; }
  };

  let m;
  OP_RE.lastIndex = 0;
  while ((m = OP_RE.exec(content)) !== null) {
    const g = m.groups;
    if (g.fontRes !== undefined) {
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
    } else if (g.star !== undefined || g.td1 !== undefined || g.td3 !== undefined) {
      flushLine();
    } else if (g.xobj !== undefined) {
      flushLine();
      blocks.push({ kind: "image", relName: g.xobj });
    }
  }
  flushLine();
  return blocks;
}

/**
 * Extract a rich (formatting + tables + images preserved where detectable)
 * document structure from a PDF buffer.
 * @returns {{ blocks: Array, imagesEmbedded: number }}
 *   blocks: { kind:'para', runs:[{text,bold,italic,color,fontSize}] }
 *         | { kind:'table', rows: string[][] }
 *         | { kind:'image', width, height, data: Buffer }
 */
function extractRichDocument(buf) {
  const raw = buf.toString("latin1");
  const objMap = buildObjectMap(raw);
  const fontStyleMap = buildFontStyleMap(raw, objMap);
  const xobjResMap = buildResourceMap(raw, "XObject");
  const jpegImages = extractJpegImages(raw);
  const jpegDataSet = new Set([...jpegImages.values()].map(v => v.data));

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
    lineBlocks.push(...walkContentStream(text, fontStyleMap));
  }

  // Group consecutive pipe-delimited lines into tables; resolve image blocks.
  const blocks = [];
  let i = 0;
  let imagesEmbedded = 0;
  while (i < lineBlocks.length) {
    const b = lineBlocks[i];
    if (b.kind === "image") {
      const objNum = xobjResMap.get(b.relName);
      const info = objNum !== undefined ? jpegImages.get(objNum) : undefined;
      if (info) { blocks.push({ kind: "image", width: info.width, height: info.height, data: info.data }); imagesEmbedded++; }
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

module.exports = { extractRichDocument, buildObjectMap, buildResourceMap, buildFontStyleMap, extractJpegImages };
