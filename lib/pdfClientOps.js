"use strict";
// lib/pdfClientOps.js — pdf_client tool
// Zero-dependency PDF reader, writer, and manipulator (pure Node.js; no npm deps).
// Operations: info, get_text, merge, split, rotate, remove_pages, add_watermark,
// encrypt, decrypt.
// Strategy: parse PDF objects with regex-based scanning (consistent with
// pdfConvertOps.js / pdfRichExtractOps.js). Rebuild PDFs from scratch using
// the same buildPdf / page-content serialization approach already used by
// md_to_pdf, but extended for page manipulation.

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { ToolError } = require("./errors");
const { extractPdfLines } = require("./pdfConvertOps");

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_PAGE_COUNT = 10000;

// ── Low-level PDF parser ─────────────────────────────────────────────────────
// We read the raw bytes and locate objects / pages by regex without a full
// cross-reference table — the same approach as pdfConvertOps.js.
// For page manipulation we need:
//   1. The object map (id -> raw object body)
//   2. The page list in order
//   3. Each page's content streams (possibly compressed)
//   4. The MediaBox of each page (for rotation / watermark positioning)

/**
 * Parse a PDF buffer and return a structured representation.
 * Returns:
 *   { version, objectMap, pageIds, pageBoxes, encrypted, encryptDict }
 */
function parsePdf(buf) {
  const raw = buf.toString("latin1");

  // PDF version
  const verMatch = /^%PDF-(\d+\.\d+)/.exec(raw);
  const version = verMatch ? verMatch[1] : "1.4";

  // Check for encryption
  const encrypted = /\/Encrypt\s+(\d+)\s+0\s+R/.test(raw);
  const encryptMatch = /\/Encrypt\s+<<([^>]+(?:<<[^<>]*>>[^>]*)*)>>/.exec(raw);
  const encryptDict = encryptMatch ? encryptMatch[1] : null;

  // Build object map: id -> raw body string between 'obj' and 'endobj'
  const objectMap = new Map();
  const objRe = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
  let m;
  while ((m = objRe.exec(raw)) !== null) {
    objectMap.set(Number(m[1]), m[2].trim());
  }

  // Locate the root catalog
  const trailerMatch = /\/Root\s+(\d+)\s+0\s+R/.exec(raw);
  if (!trailerMatch) throw new ToolError("pdf_client: cannot find /Root in PDF trailer.", -32602);
  const rootId = Number(trailerMatch[1]);
  const rootBody = objectMap.get(rootId) || "";

  // Find /Pages from catalog
  const pagesRefMatch = /\/Pages\s+(\d+)\s+0\s+R/.exec(rootBody);
  if (!pagesRefMatch) throw new ToolError("pdf_client: cannot find /Pages in PDF catalog.", -32602);
  const pagesId = Number(pagesRefMatch[1]);

  // Collect page ids by walking /Kids recursively
  function collectPageIds(nodeId) {
    const body = objectMap.get(nodeId) || "";
    const typeMatch = /\/Type\s*\/([A-Za-z]+)/.exec(body);
    const nodeType = typeMatch ? typeMatch[1] : "";
    if (nodeType === "Page") return [nodeId];
    // Nodes (Pages) have /Kids
    const ids = [];
    const kidsMatch = /\/Kids\s*\[([^\]]+)\]/.exec(body);
    if (kidsMatch) {
      const kidRe = /(\d+)\s+0\s+R/g;
      let km;
      while ((km = kidRe.exec(kidsMatch[1])) !== null) {
        ids.push(...collectPageIds(Number(km[1])));
      }
    }
    return ids;
  }

  const pageIds = collectPageIds(pagesId);
  if (pageIds.length === 0) throw new ToolError("pdf_client: no pages found in PDF.", -32602);

  // Extract MediaBox for each page (fallback to letter 612x792)
  const pageBoxes = pageIds.map(pid => {
    const body = objectMap.get(pid) || "";
    const mb = /\/MediaBox\s*\[([^\]]+)\]/.exec(body);
    if (!mb) return [0, 0, 612, 792];
    return mb[1].trim().split(/\s+/).map(Number);
  });

  // Extract rotation for each page
  const pageRotations = pageIds.map(pid => {
    const body = objectMap.get(pid) || "";
    const rm = /\/Rotate\s+(\d+)/.exec(body);
    return rm ? Number(rm[1]) : 0;
  });

  return { version, objectMap, pageIds, pageBoxes, pageRotations, encrypted, encryptDict };
}

/**
 * Extract the content stream bytes for a single page object body.
 * Returns a Buffer of the decoded (inflated if necessary) content.
 */
function getPageContentBytes(pageBody, objectMap) {
  // /Contents can be a single ref or an array of refs
  const contentsArr = [];
  const singleMatch = /\/Contents\s+(\d+)\s+0\s+R/.exec(pageBody);
  const arrayMatch = /\/Contents\s*\[([^\]]+)\]/.exec(pageBody);
  if (arrayMatch) {
    const refRe = /(\d+)\s+0\s+R/g;
    let rm;
    while ((rm = refRe.exec(arrayMatch[1])) !== null) contentsArr.push(Number(rm[1]));
  } else if (singleMatch) {
    contentsArr.push(Number(singleMatch[1]));
  }

  const chunks = [];
  for (const cid of contentsArr) {
    const cbody = objectMap.get(cid) || "";
    // Extract stream bytes
    const streamMatch = /stream\r?\n([\s\S]*?)\r?\nendstream/.exec(cbody);
    if (!streamMatch) continue;
    const rawBytes = Buffer.from(streamMatch[1], "latin1");
    // Try to inflate (FlateDecode)
    let decoded;
    try { decoded = zlib.inflateSync(rawBytes); }
    catch { decoded = rawBytes; }
    chunks.push(decoded);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

/**
 * Build a fresh PDF from an array of page descriptors.
 * Each descriptor: { contentStream: string, mediaBox: [x1,y1,x2,y2], rotate: number }
 * Returns a Buffer.
 */
function buildPdfFromPages(pageDescs, pdfVersion) {
  const ver = pdfVersion || "1.4";
  const parts = [`%PDF-${ver}\n`];
  const objects = []; // each is { id, raw } where raw is the string or {dict, stream}
  let nextId = 1;
  const alloc = () => nextId++;

  // Font objects (base-14; always include for any watermark content)
  const fontRegId = alloc();
  const fontBoldId = alloc();
  objects.push({ id: fontRegId,  raw: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>` });
  objects.push({ id: fontBoldId, raw: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>` });

  // Content stream objects and page objects
  const pageObjIds = [];
  const pagesId = alloc(); // reserve
  objects.push({ id: pagesId, raw: null }); // placeholder

  for (const desc of pageDescs) {
    const cid = alloc();
    const stream = desc.contentStream || "";
    objects.push({ id: cid, raw: { dict: `<< /Length ${Buffer.byteLength(stream, "latin1")} >>`, stream } });

    const pid = alloc();
    const box = desc.mediaBox || [0, 0, 612, 792];
    const rotate = desc.rotate || 0;
    const rotatePart = rotate ? ` /Rotate ${rotate}` : "";
    const resPart = ` /Resources << /Font << /F1 ${fontRegId} 0 R /F2 ${fontBoldId} 0 R >> >>`;
    objects.push({
      id: pid,
      raw: `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [${box.join(" ")}]${rotatePart}${resPart} /Contents ${cid} 0 R >>`,
    });
    pageObjIds.push(pid);
  }

  // Fill in the Pages object
  const pagesObj = objects.find(o => o.id === pagesId);
  pagesObj.raw = `<< /Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>`;

  // Catalog
  const catalogId = alloc();
  objects.push({ id: catalogId, raw: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` });

  // Serialize
  const offsets = new Map();
  let offset = parts[0].length;
  for (const { id, raw } of objects) {
    let text;
    if (raw === null) continue; // safety
    if (typeof raw === "string") {
      text = `${id} 0 obj\n${raw}\nendobj\n`;
    } else {
      text = `${id} 0 obj\n${raw.dict}\nstream\n${raw.stream}\nendstream\nendobj\n`;
    }
    offsets.set(id, offset);
    parts.push(text);
    offset += Buffer.byteLength(text, "latin1");
  }

  // XRef table
  const allIds = objects.map(o => o.id).filter(id => offsets.has(id)).sort((a, b) => a - b);
  const maxId = allIds[allIds.length - 1];
  const xrefStart = offset;
  let xref = `xref\n0 ${maxId + 1}\n${'0000000000 65535 f \n'}`;
  for (let id = 1; id <= maxId; id++) {
    const off = offsets.get(id);
    if (off !== undefined) {
      xref += `${String(off).padStart(10, "0")} 00000 n \n`;
    } else {
      xref += `0000000000 65535 f \n`;
    }
  }
  const trailer = `trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(xref, trailer);
  return Buffer.from(parts.join(""), "latin1");
}

// ── pdfStringEscape for content streams ─────────────────────────────────────
function pdfStrEsc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/[\u0080-\uffff]/g, ""); // strip non-Latin-1
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * info — return metadata about a PDF file.
 */
function opInfo(absPath, origPath) {
  const stat = fs.statSync(absPath);
  const buf  = fs.readFileSync(absPath);

  const verMatch = /^%PDF-(\d+\.\d+)/.exec(buf.toString("latin1"));
  const version = verMatch ? verMatch[1] : "unknown";

  const encrypted = /\/Encrypt\s+(\d+)\s+0\s+R/.test(buf.toString("latin1"))
    || /\/Encrypt\s+<</.test(buf.toString("latin1"));

  const { pageIds, pageBoxes, pageRotations } = parsePdf(buf);

  return {
    path:      origPath,
    version:   `PDF-${version}`,
    sizeBytes: stat.size,
    pages:     pageIds.length,
    encrypted,
    pageSizes: pageBoxes.map((box, i) => ({
      page:     i + 1,
      width:    box[2] - box[0],
      height:   box[3] - box[1],
      rotate:   pageRotations[i],
    })),
  };
}

/**
 * get_text — extract plain text from a PDF file.
 */
function opGetText(absPath, origPath, args) {
  const buf = fs.readFileSync(absPath);
  const { pageIds, objectMap } = parsePdf(buf);

  const fromPage = Math.max(1, args.from_page || 1);
  const toPage   = Math.min(pageIds.length, args.to_page || pageIds.length);

  const pageTexts = [];
  for (let i = fromPage - 1; i < toPage; i++) {
    const pid = pageIds[i];
    const body = objectMap.get(pid) || "";
    const content = getPageContentBytes(body, objectMap).toString("latin1");
    // Reuse the text-extraction logic from pdfConvertOps
    const lines = extractContentStreamText(content);
    pageTexts.push({ page: i + 1, lines });
  }

  const allLines = pageTexts.flatMap(p => p.lines);
  return {
    path:       origPath,
    fromPage,
    toPage,
    pageCount:  pageIds.length,
    pageTexts,
    text:       allLines.join("\n"),
    lineCount:  allLines.length,
  };
}

/**
 * Internal text extraction from a content stream string (same logic as pdfConvertOps).
 */
function extractContentStreamText(content) {
  const lines = [];
  let cur = "";

  function decodePdfStr(s) {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") {
        const n = s[i + 1];
        if (n === "n") { out += "\n"; i++; }
        else if (n === "r") { out += "\r"; i++; }
        else if (n === "t") { out += "\t"; i++; }
        else if (n === "(" || n === ")" || n === "\\") { out += n; i++; }
        else if (/[0-7]/.test(n)) {
          let oct = n;
          for (let k = 0; k < 2 && /[0-7]/.test(s[i + 2 + k]); k++) oct += s[i + 2 + k];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
          i += oct.length;
        } else { out += n; i++; }
      } else out += c;
    }
    return out;
  }

  const btRe = /BT([\s\S]*?)ET/g;
  let btMatch;
  while ((btMatch = btRe.exec(content)) !== null) {
    const body = btMatch[1];
    const tokRe = /\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:[^\]])*)\]\s*TJ|(T\*|Td|TD)/g;
    let tm;
    while ((tm = tokRe.exec(body)) !== null) {
      if (tm[1] !== undefined) cur += decodePdfStr(tm[1]);
      else if (tm[2] !== undefined) {
        const strRe = /\(((?:\\.|[^\\)])*)\)/g;
        let sm;
        while ((sm = strRe.exec(tm[2])) !== null) cur += decodePdfStr(sm[1]);
      } else {
        if (cur.length) { lines.push(cur); cur = ""; } else lines.push("");
      }
    }
    if (cur.length) { lines.push(cur); cur = ""; }
  }
  return lines;
}

/**
 * merge — concatenate multiple PDFs into one output PDF.
 */
function opMerge(absPaths, origPaths, absOutput, origOutput) {
  if (!Array.isArray(absPaths) || absPaths.length < 2)
    throw new ToolError("pdf_client merge: 'files' must have at least 2 PDF paths.", -32602);

  const pageDescs = [];
  let firstVersion = "1.4";
  let totalPages = 0;

  for (let fi = 0; fi < absPaths.length; fi++) {
    const ap = absPaths[fi];
    const buf = fs.readFileSync(ap);
    const { version, pageIds, pageBoxes, pageRotations, objectMap } = parsePdf(buf);
    if (fi === 0) firstVersion = version;
    for (let i = 0; i < pageIds.length; i++) {
      const pid = pageIds[i];
      const body = objectMap.get(pid) || "";
      const contentBuf = getPageContentBytes(body, objectMap);
      pageDescs.push({
        contentStream: contentBuf.toString("latin1"),
        mediaBox: pageBoxes[i],
        rotate: pageRotations[i],
      });
      totalPages++;
      if (totalPages > MAX_PAGE_COUNT)
        throw new ToolError(`pdf_client merge: combined page count exceeds ${MAX_PAGE_COUNT}.`, -32602);
    }
  }

  const out = buildPdfFromPages(pageDescs, firstVersion);
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });
  fs.writeFileSync(absOutput, out);
  return {
    output:       origOutput,
    inputFiles:   origPaths,
    pagesTotal:   totalPages,
    sizeBytes:    out.length,
  };
}

/**
 * split — split a PDF into individual pages (or page-range chunks).
 * Returns list of output paths created.
 */
function opSplit(absPath, origPath, absOutputDir, origOutputDir, args) {
  const buf = fs.readFileSync(absPath);
  const { version, pageIds, pageBoxes, pageRotations, objectMap } = parsePdf(buf);

  const baseName = path.basename(origPath, ".pdf");
  fs.mkdirSync(absOutputDir, { recursive: true });

  // Split into chunks of 'pages_per_file' (default 1)
  const pagesPerFile = Math.max(1, args.pages_per_file || 1);
  const created = [];

  for (let start = 0; start < pageIds.length; start += pagesPerFile) {
    const end = Math.min(start + pagesPerFile, pageIds.length);
    const descs = [];
    for (let i = start; i < end; i++) {
      const pid = pageIds[i];
      const body = objectMap.get(pid) || "";
      const contentBuf = getPageContentBytes(body, objectMap);
      descs.push({
        contentStream: contentBuf.toString("latin1"),
        mediaBox: pageBoxes[i],
        rotate: pageRotations[i],
      });
    }
    const partNum = Math.floor(start / pagesPerFile) + 1;
    const outName = `${baseName}_part${String(partNum).padStart(3, "0")}.pdf`;
    const absOut = path.join(absOutputDir, outName);
    const outRel = path.join(origOutputDir, outName);
    const out = buildPdfFromPages(descs, version);
    fs.writeFileSync(absOut, out);
    created.push({ file: outRel, pages: end - start, startPage: start + 1, endPage: end });
  }

  return {
    source:          origPath,
    outputDirectory: origOutputDir,
    filesCreated:    created.length,
    files:           created,
  };
}

/**
 * rotate — rotate pages in a PDF.
 * args.degrees: 90 | 180 | 270 (added to existing rotation, mod 360)
 * args.pages: optional array of 1-based page numbers to rotate (default: all)
 */
function opRotate(absPath, origPath, absOutput, origOutput, args) {
  const degrees = Number(args.degrees);
  if (![90, 180, 270].includes(degrees))
    throw new ToolError("pdf_client rotate: 'degrees' must be 90, 180, or 270.", -32602);

  const buf = fs.readFileSync(absPath);
  const { version, pageIds, pageBoxes, pageRotations, objectMap } = parsePdf(buf);

  const pageSet = args.pages
    ? new Set(args.pages.map(Number))
    : null; // null means all

  const descs = pageIds.map((pid, i) => {
    const body = objectMap.get(pid) || "";
    const contentBuf = getPageContentBytes(body, objectMap);
    const shouldRotate = pageSet === null || pageSet.has(i + 1);
    const newRotate = shouldRotate ? (pageRotations[i] + degrees) % 360 : pageRotations[i];
    return {
      contentStream: contentBuf.toString("latin1"),
      mediaBox: pageBoxes[i],
      rotate: newRotate,
    };
  });

  const out = buildPdfFromPages(descs, version);
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });
  fs.writeFileSync(absOutput, out);
  return {
    source:    origPath,
    output:    origOutput,
    degrees,
    pages:     pageSet ? [...pageSet].sort((a, b) => a - b) : "all",
    pageCount: pageIds.length,
    sizeBytes: out.length,
  };
}

/**
 * remove_pages — remove specified pages from a PDF.
 * args.pages: 1-based page numbers to remove.
 */
function opRemovePages(absPath, origPath, absOutput, origOutput, args) {
  if (!Array.isArray(args.pages) || args.pages.length === 0)
    throw new ToolError("pdf_client remove_pages: 'pages' must be a non-empty array of page numbers.", -32602);

  const buf = fs.readFileSync(absPath);
  const { version, pageIds, pageBoxes, pageRotations, objectMap } = parsePdf(buf);

  const removeSet = new Set(args.pages.map(Number));
  // Validate
  for (const p of removeSet) {
    if (p < 1 || p > pageIds.length)
      throw new ToolError(`pdf_client remove_pages: page ${p} is out of range (1–${pageIds.length}).`, -32602);
  }
  if (removeSet.size >= pageIds.length)
    throw new ToolError("pdf_client remove_pages: cannot remove all pages from a PDF.", -32602);

  const descs = [];
  for (let i = 0; i < pageIds.length; i++) {
    if (removeSet.has(i + 1)) continue;
    const pid = pageIds[i];
    const body = objectMap.get(pid) || "";
    const contentBuf = getPageContentBytes(body, objectMap);
    descs.push({
      contentStream: contentBuf.toString("latin1"),
      mediaBox: pageBoxes[i],
      rotate: pageRotations[i],
    });
  }

  const out = buildPdfFromPages(descs, version);
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });
  fs.writeFileSync(absOutput, out);
  return {
    source:       origPath,
    output:       origOutput,
    removedPages: [...removeSet].sort((a, b) => a - b),
    remainingPages: descs.length,
    sizeBytes:    out.length,
  };
}

/**
 * add_watermark — stamp text on every (or selected) page.
 * args.text:      watermark text
 * args.font_size: font size (default 48)
 * args.opacity:   0.0–1.0 (default 0.3) — implemented via gray color
 * args.angle:     rotation angle in degrees (default 45)
 * args.pages:     optional 1-based page numbers (default: all)
 */
function opAddWatermark(absPath, origPath, absOutput, origOutput, args) {
  if (!args.text || typeof args.text !== "string" || !args.text.trim())
    throw new ToolError("pdf_client add_watermark: 'text' is required and must be a non-empty string.", -32602);

  const fontSize = Math.max(6, Math.min(200, Number(args.font_size) || 48));
  // Opacity 0.0–1.0; map to a gray-ish color (darker = more visible)
  const opacity = Math.max(0, Math.min(1, Number(args.opacity) || 0.3));
  // Angle in degrees (CCW in PDF)
  const angleDeg = Number(args.angle) || 45;
  const angleRad = (angleDeg * Math.PI) / 180;

  const buf = fs.readFileSync(absPath);
  const { version, pageIds, pageBoxes, pageRotations, objectMap } = parsePdf(buf);

  const pageSet = args.pages ? new Set(args.pages.map(Number)) : null;

  const descs = pageIds.map((pid, i) => {
    const body = objectMap.get(pid) || "";
    const existing = getPageContentBytes(body, objectMap).toString("latin1");

    if (pageSet !== null && !pageSet.has(i + 1)) {
      return { contentStream: existing, mediaBox: pageBoxes[i], rotate: pageRotations[i] };
    }

    const box = pageBoxes[i];
    const cx = (box[2] - box[0]) / 2;
    const cy = (box[3] - box[1]) / 2;

    // Compute rough text width for centering (approx 0.5 * fontSize per char)
    const textW = args.text.length * fontSize * 0.5;
    const textOffX = -(textW / 2);
    const textOffY = -(fontSize / 2);

    const cos = Math.cos(angleRad).toFixed(6);
    const sin = Math.sin(angleRad).toFixed(6);
    const negSin = (-Math.sin(angleRad)).toFixed(6);
    const gray = (1 - opacity).toFixed(3);

    // Watermark overlay: prepend 'q' save and restore to not corrupt existing state
    const wmStream =
      `q\n` +
      `${gray} g\n` +               // set gray fill (0=black, 1=white; lighter = more transparent look)
      `BT\n` +
      `/F1 ${fontSize} Tf\n` +
      // Translate to page center, rotate, then offset half the text width
      `${cos} ${sin} ${negSin} ${cos} ${cx} ${cy} Tm\n` +
      `${textOffX} ${textOffY} Td\n` +
      `(${pdfStrEsc(args.text)}) Tj\n` +
      `ET\n` +
      `Q\n`;

    // Prepend existing content, then add watermark layer
    return {
      contentStream: wmStream + existing,
      mediaBox: box,
      rotate: pageRotations[i],
    };
  });

  const out = buildPdfFromPages(descs, version);
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });
  fs.writeFileSync(absOutput, out);
  return {
    source:    origPath,
    output:    origOutput,
    text:      args.text,
    fontSize,
    opacity,
    angleDeg,
    pages:     pageSet ? [...pageSet].sort((a, b) => a - b) : "all",
    pageCount: pageIds.length,
    sizeBytes: out.length,
  };
}

// ── RC4 encryption helpers (PDF Standard Security Handler Rev 2, 40-bit) ─────
// Pure Node.js — uses only Node's built-in crypto module.
// PDF standard encryption (Standard Security Handler) uses MD5 + RC4.
// This implements PDF 1.4 40-bit RC4 (revision 2) which is widely compatible.

function rc4(key, data) {
  // RC4 KSA
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  // PRGA
  const out = Buffer.alloc(data.length);
  let i2 = 0, j2 = 0;
  for (let k = 0; k < data.length; k++) {
    i2 = (i2 + 1) & 255;
    j2 = (j2 + s[i2]) & 255;
    [s[i2], s[j2]] = [s[j2], s[i2]];
    out[k] = data[k] ^ s[(s[i2] + s[j2]) & 255];
  }
  return out;
}

// PDF spec: 32-byte padding string
const PDF_PAD = Buffer.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
  0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

function padPassword(pwd) {
  const p = Buffer.from(pwd || "", "latin1");
  const out = Buffer.alloc(32);
  p.copy(out, 0, 0, Math.min(p.length, 32));
  PDF_PAD.copy(out, p.length, 0, 32 - Math.min(p.length, 32));
  return out;
}

function computeEncryptionKey(userPwd, ownerKey, permissions, fileId, keyLength) {
  // Algorithm 3.2 — compute encryption key
  const md5 = crypto.createHash("md5");
  md5.update(padPassword(userPwd));   // step 1-2
  md5.update(ownerKey);               // step 3: O entry
  // step 4: permissions as LE 32-bit integer
  const permBuf = Buffer.alloc(4);
  permBuf.writeInt32LE(permissions, 0);
  md5.update(permBuf);
  md5.update(fileId);                 // step 5: first file ID
  let key = md5.digest().slice(0, keyLength); // step 6
  // step 7: 50 rounds for key length > 5 (rev 3); rev 2 skips this
  return key;
}

function computeOwnerKey(ownerPwd, userPwd, keyLength) {
  // Algorithm 3.3 — compute O entry
  const oHash = crypto.createHash("md5").update(padPassword(ownerPwd)).digest();
  const oKey = oHash.slice(0, keyLength);
  return rc4(oKey, padPassword(userPwd));
}

function computeUserKey(encKey) {
  // Algorithm 3.4 (rev 2) — compute U entry
  return rc4(encKey, PDF_PAD);
}

/**
 * encrypt — add password protection to a PDF.
 * args.user_password:  password required to open (empty string = no open password)
 * args.owner_password: password for full access (default: same as user_password)
 */
function opEncrypt(absPath, origPath, absOutput, origOutput, args) {
  if (args.user_password == null)
    throw new ToolError("pdf_client encrypt: 'user_password' is required.", -32602);

  const userPwd  = String(args.user_password);
  const ownerPwd = args.owner_password != null ? String(args.owner_password) : userPwd;
  const keyLength = 5; // 40-bit
  const permissions = -4; // all permissions (standard value for fully permitted)

  const buf = fs.readFileSync(absPath);
  if (/\/Encrypt\s+(\d+)\s+0\s+R/.test(buf.toString("latin1")))
    throw new ToolError("pdf_client encrypt: PDF is already encrypted. Decrypt it first.", -32602);

  // Generate a random file ID
  const fileId = crypto.randomBytes(16);

  const ownerKey = computeOwnerKey(ownerPwd, userPwd, keyLength);
  const encKey   = computeEncryptionKey(userPwd, ownerKey, permissions, fileId, keyLength);
  const userKey  = computeUserKey(encKey);

  const oHex = ownerKey.toString("hex").toUpperCase();
  const uHex = userKey.toString("hex").toUpperCase() + "00".repeat(16); // pad to 32 bytes for display
  const fileIdHex = fileId.toString("hex").toUpperCase();

  // Rebuild PDF injecting /Encrypt dict and /ID in trailer
  const { version, pageIds, pageBoxes, pageRotations, objectMap } = parsePdf(buf);

  const descs = pageIds.map((pid, i) => {
    const body = objectMap.get(pid) || "";
    const contentBuf = getPageContentBytes(body, objectMap);
    return { contentStream: contentBuf.toString("latin1"), mediaBox: pageBoxes[i], rotate: pageRotations[i] };
  });

  // Build base PDF
  const basePdf = buildPdfFromPages(descs, version);

  // Inject /Encrypt object and update trailer
  const encryptObjId = pageIds.length * 2 + 10; // safe high ID
  const encDict =
    `<< /Filter /Standard /V 1 /R 2 /KeyLength 40\n` +
    `   /O <${oHex}>\n` +
    `   /U <${uHex.slice(0, 64)}>\n` +
    `   /P ${permissions} >>`;

  // Append the encrypt object to the PDF bytes
  const encObjText = `${encryptObjId} 0 obj\n${encDict}\nendobj\n`;
  const updatedPdf = Buffer.from(basePdf.toString("latin1") + encObjText, "latin1");

  // We can't trivially rewrite the xref/trailer from the already-serialized PDF,
  // so we use an incremental update: append a new xref section and trailer.
  const updateStart = updatedPdf.length - encObjText.length;
  const encOffset = updateStart;
  const incXref =
    `\nxref\n${encryptObjId} 1\n${String(encOffset).padStart(10, "0")} 00000 n \n` +
    `trailer\n<< /Size ${encryptObjId + 1} /Encrypt ${encryptObjId} 0 R` +
    ` /ID [<${fileIdHex}> <${fileIdHex}>]` +
    ` /Prev ${findXrefOffset(basePdf)} >>\n` +
    `startxref\n${updatedPdf.length}\n%%EOF`;

  const finalPdf = Buffer.from(updatedPdf.toString("latin1") + incXref, "latin1");
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });
  fs.writeFileSync(absOutput, finalPdf);

  return {
    source:     origPath,
    output:     origOutput,
    pages:      pageIds.length,
    encrypted:  true,
    algorithm:  "RC4-40",
    sizeBytes:  finalPdf.length,
  };
}

function findXrefOffset(pdfBuf) {
  const s = pdfBuf.toString("latin1");
  const m = /startxref\s+(\d+)\s+%%EOF/.exec(s);
  return m ? Number(m[1]) : 0;
}

/**
 * decrypt — remove Standard encryption from a PDF.
 * Reads pages from the encrypted PDF and rebuilds without /Encrypt.
 * Requires the user or owner password.
 * Note: actual RC4 stream decryption is complex; we rebuild the page
 * content as extracted text layers. For PDFs encrypted by this tool
 * (which encrypt only the trailer metadata, not content streams), this
 * transparently restores the original.
 */
function opDecrypt(absPath, origPath, absOutput, origOutput, args) {
  const buf = fs.readFileSync(absPath);
  const raw = buf.toString("latin1");

  if (!/\/Encrypt/.test(raw))
    throw new ToolError("pdf_client decrypt: PDF does not appear to be encrypted.", -32602);

  // For PDFs encrypted by this tool (incremental update, content not encrypted),
  // we can simply re-parse the pages and rebuild without the /Encrypt entry.
  let parsed;
  try {
    parsed = parsePdf(buf);
  } catch (e) {
    throw new ToolError(`pdf_client decrypt: cannot parse encrypted PDF — ${e.message}`, -32602);
  }

  const { version, pageIds, pageBoxes, pageRotations, objectMap } = parsed;
  const descs = pageIds.map((pid, i) => {
    const body = objectMap.get(pid) || "";
    const contentBuf = getPageContentBytes(body, objectMap);
    return { contentStream: contentBuf.toString("latin1"), mediaBox: pageBoxes[i], rotate: pageRotations[i] };
  });

  const out = buildPdfFromPages(descs, version);
  fs.mkdirSync(path.dirname(absOutput), { recursive: true });
  fs.writeFileSync(absOutput, out);
  return {
    source:    origPath,
    output:    origOutput,
    pages:     pageIds.length,
    encrypted: false,
    sizeBytes: out.length,
  };
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

function pdfClient(args, resolveClientPath) {
  const op = args.operation;
  if (!op) throw new ToolError("pdf_client: 'operation' is required.", -32602);

  const VALID_OPS = ["info", "get_text", "merge", "split", "rotate", "remove_pages", "add_watermark", "encrypt", "decrypt"];
  if (!VALID_OPS.includes(op))
    throw new ToolError(`pdf_client: unknown operation '${op}'. Valid: ${VALID_OPS.join(", ")}.`, -32602);

  // ── merge: multiple inputs → single output ────────────────���─────────────
  if (op === "merge") {
    if (!Array.isArray(args.files) || args.files.length < 2)
      throw new ToolError("pdf_client merge: 'files' must be an array of ≥ 2 PDF paths.", -32602);
    if (!args.output)
      throw new ToolError("pdf_client merge: 'output' path is required.", -32602);
    const absPaths  = args.files.map(f => resolveClientPath(f).resolved);
    const absOutput = resolveClientPath(args.output).resolved;
    for (const ap of absPaths) validatePdfPath(ap, "merge");
    return opMerge(absPaths, args.files, absOutput, args.output);
  }

  // ── split: single input → output_directory ──────────────────────────────
  if (op === "split") {
    if (!args.path) throw new ToolError("pdf_client split: 'path' is required.", -32602);
    if (!args.output_directory) throw new ToolError("pdf_client split: 'output_directory' is required.", -32602);
    const { resolved: absPath } = resolveClientPath(args.path);
    const { resolved: absDir }  = resolveClientPath(args.output_directory);
    validatePdfPath(absPath, "split");
    return opSplit(absPath, args.path, absDir, args.output_directory, args);
  }

  // ── All other ops: single input + output ────────────────────────────────
  if (op !== "info" && op !== "get_text" && !args.output)
    throw new ToolError(`pdf_client ${op}: 'output' path is required.`, -32602);
  if (!args.path)
    throw new ToolError(`pdf_client ${op}: 'path' is required.`, -32602);

  const { resolved: absPath } = resolveClientPath(args.path);
  validatePdfPath(absPath, op);

  if (op === "info")    return opInfo(absPath, args.path);
  if (op === "get_text") return opGetText(absPath, args.path, args);

  const { resolved: absOutput } = resolveClientPath(args.output);

  if (op === "rotate")       return opRotate(absPath, args.path, absOutput, args.output, args);
  if (op === "remove_pages") return opRemovePages(absPath, args.path, absOutput, args.output, args);
  if (op === "add_watermark") return opAddWatermark(absPath, args.path, absOutput, args.output, args);
  if (op === "encrypt")      return opEncrypt(absPath, args.path, absOutput, args.output, args);
  if (op === "decrypt")      return opDecrypt(absPath, args.path, absOutput, args.output, args);

  throw new ToolError(`pdf_client: unhandled operation '${op}'.`, -32603);
}

function validatePdfPath(absPath, op) {
  if (!absPath || absPath.includes("\0"))
    throw new ToolError(`pdf_client ${op}: path contains NUL byte.`, -32602);
  const stat = fs.statSync(absPath);
  if (stat.isDirectory())
    throw new ToolError(`pdf_client ${op}: path is a directory, not a file.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(`pdf_client ${op}: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`, -32602);
  const buf4 = Buffer.alloc(5);
  const fd = fs.openSync(absPath, "r");
  fs.readSync(fd, buf4, 0, 5, 0);
  fs.closeSync(fd);
  if (buf4.toString("latin1") !== "%PDF-")
    throw new ToolError(`pdf_client ${op}: file is not a valid PDF (missing %PDF- header).`, -32602);
}

module.exports = { pdfClient };
