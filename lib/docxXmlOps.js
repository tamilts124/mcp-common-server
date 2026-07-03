"use strict";
// ── DOCX XML PARSING ─────────────────────────────────────────────────────────
// Parses word/document.xml + word/_rels/document.xml.rels into plain JS
// structures docxToPdfOps.js's layout/PDF-serialization stage consumes.
// Supports: headings, bullets, paragraphs, inline images, run-level
// bold/italic/color/font-size (paragraph-granularity), and tables (w:tbl)
// with per-cell shading. No PDF/image concerns live here.

function xmlUnescape(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// "RRGGBB" -> [r,g,b] each 0-1. Returns null for missing/"auto"/invalid input.
function hexToRgb01(hex) {
  if (!hex || typeof hex !== "string") return null;
  const h = hex.trim().toLowerCase();
  if (h === "auto" || !/^[0-9a-f]{6}$/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

// Parse word/_rels/document.xml.rels -> { rId: target }
function parseRels(xml) {
  const map = {};
  const re = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) map[m[1]] = m[2];
  return map;
}

// Parse a single <w:r>...</w:r> run: text, bold, italic, color, sz (points).
function parseRun(r) {
  const tMatch = /<w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(r);
  if (!tMatch) return null;
  const bold = /<w:b\/>|<w:b w:val="(1|true)"/.test(r);
  const italic = /<w:i\/>|<w:i w:val="(1|true)"/.test(r);
  const colorMatch = /<w:color\b[^>]*w:val="([0-9A-Fa-f]{6}|auto)"/.exec(r);
  const color = colorMatch ? hexToRgb01(colorMatch[1]) : null;
  const szMatch = /<w:sz\b[^>]*w:val="(\d+)"/.exec(r);
  const sz = szMatch ? Number(szMatch[1]) / 2 : null; // half-points -> points
  return { text: xmlUnescape(tMatch[1]), bold, italic, color, sz };
}

// Parse one <w:p>...</w:p> paragraph into zero or more blocks:
//   { kind: 'image', relId, cx, cy }  (emitted first, if any)
//   { kind: 'heading'|'bullet'|'para', runs, fontSize? }
// Multiple images/blocks can result from a single paragraph.
function parseParagraph(p) {
  const out = [];
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
    const run = parseRun(r);
    if (run) runs.push(run);
  }

  for (const img of images) out.push({ kind: "image", ...img });
  if (runs.length === 0 && images.length > 0) return out;
  if (runs.length === 0) { out.push({ kind: "para", runs: [{ text: "" }] }); return out; }

  // Paragraph-granularity font size: first run that declares an explicit sz.
  const fontSize = (runs.find(r => r.sz) || {}).sz || null;

  if (styleMatch) {
    const level = Number((styleMatch[1].match(/[1-6]/) || ["1"])[0]);
    out.push({ kind: "heading", level, runs, fontSize });
  } else if (isBullet) {
    out.push({ kind: "bullet", runs, fontSize });
  } else {
    out.push({ kind: "para", runs, fontSize });
  }
  return out;
}

// Parse a <w:tbl>...</w:tbl> block into { kind:'table', rows }
// rows: [ [ { blocks: [paraBlock...], fill: [r,g,b]|null } ... ] ... ]
function parseTable(tblXml) {
  const rowMatches = tblXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  const rows = rowMatches.map(trXml => {
    const cellMatches = trXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [];
    return cellMatches.map(tcXml => {
      const paraMatches = tcXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g) || [];
      const blocks = [];
      for (const p of paraMatches) {
        for (const b of parseParagraph(p)) if (b.kind !== "image") blocks.push(b);
      }
      const shdMatch = /<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/.exec(tcXml);
      const fill = shdMatch ? hexToRgb01(shdMatch[1]) : null;
      return { blocks, fill };
    });
  });
  return rows;
}

// Walk word/document.xml body and produce an ordered list of top-level
// blocks (paragraphs, images, and tables), in document order. Tables are
// extracted first (non-nested only — nested tables are rare and unsupported)
// so their inner <w:p> paragraphs aren't double-counted as top-level ones.
function parseDocumentXml(xml) {
  const tables = [];
  const xmlNoTables = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (match) => {
    const token = `@@TABLE_${tables.length}@@`;
    tables.push(match);
    return token;
  });

  const blocks = [];
  const combinedRe = /@@TABLE_(\d+)@@|(<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>)/g;
  let m;
  while ((m = combinedRe.exec(xmlNoTables)) !== null) {
    if (m[1] !== undefined) {
      const rows = parseTable(tables[Number(m[1])]);
      blocks.push({ kind: "table", rows });
    } else {
      for (const b of parseParagraph(m[2])) blocks.push(b);
    }
  }
  return blocks;
}

module.exports = { xmlUnescape, hexToRgb01, parseRels, parseDocumentXml, parseTable, parseParagraph };
