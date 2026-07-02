"use strict";
// ── md_to_pdf / pdf_to_md — zero-dependency Markdown <-> PDF ────────────────
// md_to_pdf hand-builds a minimal, valid, multi-page PDF (base-14 Helvetica/
// Helvetica-Bold fonts, no embedding needed for ASCII text) with a simple
// content-stream text layout engine: word-wrap, page breaks, headings
// (# .. ######), bullet items (- / *), and inline **bold**/*italic* runs.
// pdf_to_md is a best-effort regex-based text extractor: it scans the raw
// file for stream/endstream blocks (no xref-table parsing), zlib-inflates
// any FlateDecode-compressed ones, then walks BT/ET text blocks pulling text
// out of Tj/TJ/'/" show-text operators. Consistent with this project's other
// regex-based, zero-dependency document converters (see docxConvertOps.js).

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");

// ── PDF writer ───────────────────────────────────────────────────────────
const PAGE_W = 612, PAGE_H = 792, MARGIN = 72;
const BODY_SIZE = 11, LINE_HEIGHT = 14;
const HEADING_SIZES = { 1: 22, 2: 19, 3: 16, 4: 14, 5: 12, 6: 11 };

// Rough per-character width factors (em fraction) for Helvetica, used only
// for word-wrap estimation -- the PDF viewer renders with its own accurate
// built-in metrics for the standard-14 fonts, this is not embedded.
function estWidth(text, fontSize, bold) {
  const factor = bold ? 0.56 : 0.50;
  return text.length * fontSize * factor;
}

function pdfStringEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
    .replace(/[\u0080-\uffff]/g, ""); // strip non-Latin1: base14 fonts have no embedded encoding for these
}

// Parse **bold** / *italic* inline spans -> [{text, bold, italic}]
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

// Word-wrap a list of {text,bold,italic} runs into lines that fit maxWidth,
// splitting on spaces. Returns array of lines, each an array of runs.
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
    if (!isSpace && curWidth + ww > maxWidth && cur.length > 0) {
      lines.push(cur);
      cur = []; curWidth = 0;
    }
    if (isSpace && cur.length === 0) continue; // no leading space on a wrapped line
    cur.push(w); curWidth += ww;
  }
  if (cur.length) lines.push(cur);
  if (lines.length === 0) lines.push([]);
  return lines;
}

function runsToContentOps(lines, fontSize, indent) {
  // Emits Tf/Tj operators for each visual line, one Td move per line.
  const ops = [];
  for (const line of lines) {
    let seg = "";
    let curBold = null;
    const flush = () => {
      if (seg === "") return;
      const font = curBold ? "/F2" : "/F1";
      ops.push(`${font} ${fontSize} Tf (${pdfStringEscape(seg)}) Tj`);
      seg = "";
    };
    for (const w of line) {
      if (curBold === null) curBold = !!w.bold;
      if (!!w.bold !== curBold) { flush(); curBold = !!w.bold; }
      seg += w.text;
    }
    flush();
    ops.push("nextline");
  }
  return ops;
}

function markdownToPages(md) {
  const rawLines = md.split(/\r\n|\n/);
  const blocks = []; // {kind: 'heading'|'bullet'|'para'|'blank', level, runs}
  for (const line of rawLines) {
    if (line.trim() === "") { blocks.push({ kind: "blank" }); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, runs: parseInline(heading[2]) }); continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { blocks.push({ kind: "bullet", runs: [{ text: "\x95  " }, ...parseInline(bullet[1])] }); continue; }
    blocks.push({ kind: "para", runs: parseInline(line) });
  }

  const usableWidth = PAGE_W - 2 * MARGIN;
  const pages = [];
  let cur = [];
  let y = PAGE_H - MARGIN;
  const newPage = () => { if (cur.length) pages.push(cur); cur = []; y = PAGE_H - MARGIN; };

  for (const b of blocks) {
    if (b.kind === "blank") { y -= LINE_HEIGHT * 0.6; if (y < MARGIN) newPage(); continue; }
    const fontSize = b.kind === "heading" ? HEADING_SIZES[b.level] : BODY_SIZE;
    const bold = b.kind === "heading";
    const runs = bold ? b.runs.map(r => ({ ...r, bold: true })) : b.runs;
    const wrapped = wrapRuns(runs, fontSize, usableWidth);
    for (const line of wrapped) {
      if (y < MARGIN + LINE_HEIGHT) newPage();
      cur.push({ line, fontSize });
      y -= (fontSize === BODY_SIZE ? LINE_HEIGHT : fontSize + 6);
    }
  }
  newPage();
  if (pages.length === 0) pages.push([]);
  return pages;
}

function pageContentStream(pageLines) {
  const ops = ['BT', `${MARGIN} ${PAGE_H - MARGIN} Td`, `${LINE_HEIGHT} TL`];
  let firstLine = true;
  for (const { line, fontSize } of pageLines) {
    const leading = (fontSize === BODY_SIZE ? LINE_HEIGHT : fontSize + 6);
    if (!firstLine) ops.push(`${leading} TL T*`);
    firstLine = false;
    const lineOps = runsToContentOps([line], fontSize, 0);
    for (const op of lineOps) { if (op !== "nextline") ops.push(op); }
  }
  ops.push('ET');
  return ops.join("\n");
}

function buildPdf(pages) {
  if (pages.length === 0) pages = [[]];
  const objects = [];
  const nextId = () => objects.length + 1;

  const fontRegularId = nextId(); objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  const fontBoldId    = nextId(); objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);

  const pageIds = [];
  const contentIds = [];
  for (const pageLines of pages) {
    const stream = pageContentStream(pageLines);
    const cid = nextId();
    objects.push({ stream, dict: `<< /Length ${Buffer.byteLength(stream, "latin1")} >>` });
    contentIds.push(cid);
    pageIds.push(null); // placeholder, filled after pagesId known
  }

  const pagesId = nextId();
  objects.push(null); // reserve slot immediately so later nextId() calls don't collide
  const pageObjIds = [];
  for (let i = 0; i < pages.length; i++) {
    const pid = nextId();
    pageObjIds.push(pid);
    objects.push(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`);
  }
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>`;

  const catalogId = nextId();
  objects.push(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  // Serialize
  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  let offset = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    const id = i + 1;
    const obj = objects[i];
    let text;
    if (typeof obj === "string") {
      text = `${id} 0 obj\n${obj}\nendobj\n`;
    } else {
      text = `${id} 0 obj\n${obj.dict}\nstream\n${obj.stream}\nendstream\nendobj\n`;
    }
    offsets.push(offset);
    parts.push(text);
    offset += Buffer.byteLength(text, "latin1");
  }
  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  parts.push(xref, trailer);
  return Buffer.from(parts.join(""), "latin1");
}

/** Convert a Markdown source file into a .pdf file. */
function mdToPdf(absSrc, origSrc, absDest, origDest) {
  let stat;
  try { stat = fs.statSync(absSrc); }
  catch (e) { throw new ToolError(`md_to_pdf: cannot access '${origSrc}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`md_to_pdf: '${origSrc}' is not a regular file.`, -32602);

  const md = fs.readFileSync(absSrc, "utf8");
  const pages = markdownToPages(md);
  const pdfBuf = buildPdf(pages);

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, pdfBuf);
  } catch (e) {
    throw new ToolError(`md_to_pdf: cannot write to '${origDest}': ${e.message}`, -32603);
  }

  return { source: origSrc, destination: origDest, pages: pages.length, bytes: pdfBuf.length };
}

// ── PDF text extractor ──────────────────────────────────────────────────
function decodePdfString(s) {
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

function extractTextFromContentStream(content) {
  const lines = [];
  let cur = "";
  const btRe = /BT([\s\S]*?)ET/g;
  let btMatch;
  while ((btMatch = btRe.exec(content)) !== null) {
    const body = btMatch[1];
    // tokens: (...)Tj  |  [ (..) num (..) ... ] TJ  |  positioning ops trigger newline
    const tokRe = /\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:[^\]])*)\]\s*TJ|(T\*|Td|TD)/g;
    let tm;
    while ((tm = tokRe.exec(body)) !== null) {
      if (tm[1] !== undefined) {
        cur += decodePdfString(tm[1]);
      } else if (tm[2] !== undefined) {
        const strRe = /\(((?:\\.|[^\\)])*)\)/g;
        let sm;
        while ((sm = strRe.exec(tm[2])) !== null) cur += decodePdfString(sm[1]);
      } else if (tm[3] !== undefined) {
        if (cur.length) { lines.push(cur); cur = ""; }
        else lines.push("");
      }
    }
    if (cur.length) { lines.push(cur); cur = ""; }
  }
  return lines;
}

/** Convert a .pdf file into a best-effort Markdown/plain-text file. */
function pdfToMd(absSrc, origSrc, absDest, origDest) {
  let stat;
  try { stat = fs.statSync(absSrc); }
  catch (e) { throw new ToolError(`pdf_to_md: cannot access '${origSrc}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`pdf_to_md: '${origSrc}' is not a regular file.`, -32602);

  const buf = fs.readFileSync(absSrc);
  if (buf.slice(0, 5).toString("latin1") !== "%PDF-") {
    throw new ToolError(`pdf_to_md: '${origSrc}' is not a valid PDF file (missing %PDF- header).`, -32602);
  }

  const raw = buf.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  const allLines = [];
  let streamCount = 0;
  while ((m = streamRe.exec(raw)) !== null) {
    streamCount++;
    const rawBytes = Buffer.from(m[1], "latin1");
    let text;
    try {
      const inflated = zlib.inflateSync(rawBytes);
      text = inflated.toString("latin1");
    } catch (e) {
      text = m[1]; // not FlateDecode (or already plain) -- use as-is
    }
    if (!/BT[\s\S]*ET/.test(text)) continue;
    const lines = extractTextFromContentStream(text);
    allLines.push(...lines);
  }

  if (streamCount === 0) {
    throw new ToolError(`pdf_to_md: '${origSrc}' contains no stream objects — not a readable PDF content structure.`, -32602);
  }

  // Collapse runs of 3+ blank lines, trim trailing whitespace per line.
  const cleaned = [];
  let blankRun = 0;
  for (const l of allLines) {
    const t = l.replace(/[ \t]+$/, "");
    if (t === "") { blankRun++; if (blankRun > 1) continue; } else blankRun = 0;
    cleaned.push(t);
  }
  const mdText = cleaned.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, mdText, "utf8");
  } catch (e) {
    throw new ToolError(`pdf_to_md: cannot write to '${origDest}': ${e.message}`, -32603);
  }

  return { source: origSrc, destination: origDest, linesExtracted: cleaned.length, bytes: Buffer.byteLength(mdText, "utf8") };
}

module.exports = { mdToPdf, pdfToMd, markdownToPages, buildPdf, extractTextFromContentStream };
