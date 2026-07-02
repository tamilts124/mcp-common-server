"use strict";
// ── search_in_document — grep-like text search inside .docx/.pdf without a
// full convert-to-md round trip (no destination file written, read-only). ──
// Reuses the same text-extraction logic as docx_to_md (lib/docxXmlOps.js's
// parseDocumentXml, via lib/unzipOps.js for the ZIP layer) and pdf_to_md
// (lib/pdfConvertOps.js's extractPdfLines) so results stay consistent with
// what those converters would produce, and mirrors search_lines' pattern/
// context/regex/case-insensitive matching semantics (lib/fileOps.js) for a
// familiar result shape.

const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");
const { parseCentralDirectory, readEntryData } = require("./unzipOps");
const { parseDocumentXml } = require("./docxXmlOps");
const { extractPdfLines } = require("./pdfConvertOps");

// docx -> flat array of plain-text lines, one per paragraph/bullet/heading
// block (images are skipped — nothing to text-search), in document order.
function extractDocxLines(absPath, origPath) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`search_in_document: cannot access '${origPath}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`search_in_document: '${origPath}' is not a regular file.`, -32602);

  const zipBuf = fs.readFileSync(absPath);
  let entries;
  try { entries = parseCentralDirectory(zipBuf); }
  catch (e) { throw new ToolError(`search_in_document: '${origPath}' is not a valid .docx/ZIP file: ${e.message}`, -32602); }

  const docEntry = entries.find(e => e.name === "word/document.xml");
  if (!docEntry) throw new ToolError(`search_in_document: '${origPath}' has no word/document.xml part — not a valid .docx file.`, -32602);

  const xml = readEntryData(zipBuf, docEntry).toString("utf8");
  const blocks = parseDocumentXml(xml);

  return blocks
    .filter(b => b.kind !== "image")
    .map(b => b.runs.map(r => r.text).join(""));
}

const SUPPORTED_EXT = new Set([".docx", ".pdf"]);

/**
 * Grep-like search inside a .docx or .pdf file's extracted plain text.
 *
 * @param {string} absPath  Absolute, jail-validated path.
 * @param {string} origPath Client path (echoed back).
 * @param {string} pattern  Literal substring (escaped) or regex pattern.
 * @param {object} [opts]
 * @param {boolean} [opts.isRegex]
 * @param {boolean} [opts.ignoreCase]
 * @param {number}  [opts.context]     0-10, default 0.
 * @param {number}  [opts.maxMatches]  1-2000, default 200.
 * @returns {{ path, format, pattern, isRegex, ignoreCase, totalLines,
 *   totalMatches, truncated, matches: [{ line, content, context: {before, after} }] }}
 */
function searchInDocument(absPath, origPath, pattern, opts = {}) {
  const ext = path.extname(origPath || absPath).toLowerCase();
  if (!SUPPORTED_EXT.has(ext)) {
    throw new ToolError(
      `search_in_document: unsupported file type '${ext || "(none)"}' — only .docx and .pdf are supported.`,
      -32602,
    );
  }
  if (!pattern) throw new ToolError("search_in_document: 'pattern' is required.", -32602);

  const isRegex    = !!opts.isRegex;
  const ignoreCase = !!opts.ignoreCase;
  const ctxLines   = Math.min(Math.max(0, Math.trunc(opts.context ?? 0)), 10);
  const maxMatches = Math.min(Math.max(1, Math.trunc(opts.maxMatches ?? 200)), 2000);

  let re;
  try {
    const flags = ignoreCase ? "i" : "";
    re = isRegex
      ? new RegExp(pattern, flags)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch (e) {
    throw new ToolError(`search_in_document: invalid regex pattern: ${e.message}`, -32602);
  }

  const lines = ext === ".docx"
    ? extractDocxLines(absPath, origPath)
    : extractPdfLines(absPath, origPath, "search_in_document");

  const matches = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    if (truncated) break;
    const line = lines[i];
    re.lastIndex = 0;
    if (!re.test(line)) continue;
    re.lastIndex = 0;

    const before = lines.slice(Math.max(0, i - ctxLines), i);
    const after  = lines.slice(i + 1, Math.min(lines.length, i + 1 + ctxLines));

    matches.push({ line: i + 1, content: line, context: { before, after } });
    if (matches.length >= maxMatches) truncated = true;
  }

  return {
    path:         origPath,
    format:       ext.slice(1),
    pattern,
    isRegex,
    ignoreCase,
    totalLines:   lines.length,
    totalMatches: matches.length,
    truncated,
    matches,
  };
}

module.exports = { searchInDocument, extractDocxLines };
