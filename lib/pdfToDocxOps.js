"use strict";
// ── pdf_to_docx — zero-dependency PDF -> Word (.docx) converter ─────────────
// Upgraded from a plain-text-only converter: now reuses pdfRichExtractOps.js
// to reconstruct per-run bold/italic/color/font-size, pipe-delimited tables
// (w:tbl, borders via w:tcBorders so they render visibly in Word, matching
// docxToPdfOps.js's "uniform thin grid" convention on the other direction),
// and JPEG images (embedded into word/media + referenced via w:drawing,
// mirroring how docxXmlOps.js/docxToPdfOps.js read that same structure back
// out on the docx->pdf side). Non-JPEG images (PDFs almost always use either
// DCTDecode/JPEG or raw FlateDecode sample data for anything else) and exact
// 2-D positioning are documented limitations -- this stays a flowed-text
// reconstruction, not a pixel-faithful layout engine.

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");
const { buildZip } = require("./docxConvertOps");
const { extractRichDocument } = require("./pdfRichExtractOps");

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function rgb01ToHex(color) {
  if (!color) return null;
  const toHex = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return (toHex(color[0]) + toHex(color[1]) + toHex(color[2])).toUpperCase();
}

function runXml(run) {
  const props = [];
  if (run.bold) props.push("<w:b/>");
  if (run.italic) props.push("<w:i/>");
  const hex = rgb01ToHex(run.color);
  if (hex) props.push(`<w:color w:val="${hex}"/>`);
  if (run.fontSize) props.push(`<w:sz w:val="${Math.round(run.fontSize * 2)}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
}

function paraXml(runs) {
  if (!runs || runs.length === 0 || runs.every(r => r.text === "")) return "<w:p/>";
  return `<w:p>${runs.map(runXml).join("")}</w:p>`;
}

function cellXml(text) {
  const borders = `<w:tcBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/>` +
    `<w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/></w:tcBorders>`;
  return `<w:tc><w:tcPr>${borders}</w:tcPr><w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`;
}

function tableXml(rows) {
  const grid = Math.max(1, ...rows.map(r => r.length));
  const gridCols = Array.from({ length: grid }, () => `<w:gridCol/>`).join("");
  const trs = rows.map(r => `<w:tr>${r.map(cellXml).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblBorders/></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${trs}</w:tbl>`;
}

function imageParaXml(relId, widthPx, heightPx) {
  // 96dpi px -> EMU (914400 EMU/inch / 96 px/inch = 9525 EMU/px), capped to
  // a reasonable page width (6.5in usable at MARGIN=1in on a Letter page).
  const MAX_EMU = 6.5 * 914400;
  let cx = widthPx * 9525, cy = heightPx * 9525;
  if (cx > MAX_EMU) { const scale = MAX_EMU / cx; cx *= scale; cy *= scale; }
  cx = Math.max(1, Math.round(cx)); cy = Math.max(1, Math.round(cy));
  return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:blipFill><a:blip r:embed="${relId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const CONTENT_TYPES_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>`;

function documentXml(bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body>
</w:document>`;
}

/**
 * Convert a .pdf file into a best-effort .docx file, reconstructing bold/
 * italic/font-color/font-size runs, pipe-delimited tables, and JPEG images
 * (instead of the plain-text-only conversion this tool used to do).
 * @returns {{ source, destination, paragraphs, tables, imagesEmbedded, bytes }}
 */
function pdfToDocx(absSrc, origSrc, absDest, origDest) {
  let stat;
  try { stat = fs.statSync(absSrc); }
  catch (e) { throw new ToolError(`pdf_to_docx: cannot access '${origSrc}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`pdf_to_docx: '${origSrc}' is not a regular file.`, -32602);

  const buf = fs.readFileSync(absSrc);
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") {
    throw new ToolError(`pdf_to_docx: '${origSrc}' is not a valid PDF file (missing %PDF- header).`, -32602);
  }

  let blocks, imagesEmbedded;
  try {
    ({ blocks, imagesEmbedded } = extractRichDocument(buf));
  } catch (e) {
    throw new ToolError(`pdf_to_docx: failed to parse '${origSrc}': ${e.message}`, -32602);
  }
  if (blocks.length === 0) {
    throw new ToolError(`pdf_to_docx: '${origSrc}' contains no extractable content structure.`, -32602);
  }

  const mediaEntries = [];
  const relEntries = [];
  const typeOverrides = new Set();
  let bodyXml = "";
  let paragraphs = 0, tables = 0;
  let imgCounter = 0;

  for (const b of blocks) {
    if (b.kind === "table") {
      bodyXml += tableXml(b.rows);
      tables++;
    } else if (b.kind === "image") {
      imgCounter++;
      const relId = `rIdImg${imgCounter}`;
      const mediaName = `image${imgCounter}.jpg`;
      mediaEntries.push({ name: `word/media/${mediaName}`, data: b.data });
      relEntries.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName}"/>`);
      typeOverrides.add("jpg");
      bodyXml += imageParaXml(relId, b.width, b.height);
    } else {
      bodyXml += paraXml(b.runs);
      paragraphs++;
    }
  }

  const contentTypes = CONTENT_TYPES_HEAD +
    (typeOverrides.has("jpg") ? `<Default Extension="jpg" ContentType="image/jpeg"/>` : "") +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const zipEntries = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml(bodyXml), "utf8") },
  ];
  if (relEntries.length) {
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relEntries.join("\n")}
</Relationships>`;
    zipEntries.push({ name: "word/_rels/document.xml.rels", data: Buffer.from(docRels, "utf8") });
  }
  zipEntries.push(...mediaEntries);

  const zipBuf = buildZip(zipEntries);

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, zipBuf);
  } catch (e) {
    throw new ToolError(`pdf_to_docx: cannot write to '${origDest}': ${e.message}`, -32603);
  }

  return { source: origSrc, destination: origDest, paragraphs, tables, imagesEmbedded, bytes: zipBuf.length };
}

module.exports = { pdfToDocx };
