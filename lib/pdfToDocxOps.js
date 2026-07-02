"use strict";
// ── pdf_to_docx — zero-dependency PDF -> Word (.docx) converter, text only ──
// Reuses pdf_to_md's stream-scanning text extractor (extractTextFromContentStream
// in pdfConvertOps.js) and md_to_docx's minimal OOXML zip writer (buildZip in
// docxConvertOps.js). Like pdf_to_md, this has no xref-table parsing and no
// image extraction -- output is one plain paragraph per extracted text line,
// no headings/bold/bullets/images recovered. For the image-preserving
// direction this project instead goes docx -> pdf (see docxToPdfOps.js),
// which does embed images; pdf -> docx deliberately drops them, same as
// pdf_to_md does today.

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");
const { extractTextFromContentStream } = require("./pdfConvertOps");
const { buildZip } = require("./docxConvertOps");

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
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

function linesToDocumentXml(lines) {
  const paras = lines.map(l => l === ""
    ? "<w:p/>"
    : `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(l)}</w:t></w:r></w:p>`);
  return paras.join("");
}

// Same stream-scan / inflate / extract loop as pdfToMd in pdfConvertOps.js,
// pulled out here (not exported there) so this file has no dependency on
// that function's internal fs/ToolError side effects -- pure buffer in,
// {lines, streamCount} out.
function extractPdfLines(buf) {
  const raw = buf.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  const allLines = [];
  let streamCount = 0;
  while ((m = streamRe.exec(raw)) !== null) {
    streamCount++;
    const rawBytes = Buffer.from(m[1], "latin1");
    let text;
    try { text = zlib.inflateSync(rawBytes).toString("latin1"); }
    catch (e) { text = m[1]; }
    if (!/BT[\s\S]*ET/.test(text)) continue;
    allLines.push(...extractTextFromContentStream(text));
  }

  const cleaned = [];
  let blankRun = 0;
  for (const l of allLines) {
    const t = l.replace(/[ \t]+$/, "");
    if (t === "") { blankRun++; if (blankRun > 1) continue; } else blankRun = 0;
    cleaned.push(t);
  }
  return { lines: cleaned, streamCount };
}

/**
 * Convert a .pdf file into a best-effort .docx file (plain text paragraphs,
 * one per extracted text-positioning line -- no headings/bold/images).
 * @returns {{ source, destination, paragraphs, bytes, imagesEmbedded }}
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

  const { lines, streamCount } = extractPdfLines(buf);
  if (streamCount === 0) {
    throw new ToolError(`pdf_to_docx: '${origSrc}' contains no stream objects — not a readable PDF content structure.`, -32602);
  }

  const body = linesToDocumentXml(lines);
  const zipBuf = buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels",         data: Buffer.from(RELS, "utf8") },
    { name: "word/document.xml",   data: Buffer.from(documentXml(body), "utf8") },
  ]);

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, zipBuf);
  } catch (e) {
    throw new ToolError(`pdf_to_docx: cannot write to '${origDest}': ${e.message}`, -32603);
  }

  return { source: origSrc, destination: origDest, paragraphs: lines.length, bytes: zipBuf.length, imagesEmbedded: 0 };
}

module.exports = { pdfToDocx };
