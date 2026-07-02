"use strict";
// ── DOCX XML PARSING ─────────────────────────────────────────────────────────
// Extracted from lib/docxToPdfOps.js (which had grown past the 500-line
// threshold). Parses word/document.xml + word/_rels/document.xml.rels into
// plain JS structures docxToPdfOps.js's layout/PDF-serialization stage
// consumes. No PDF/image concerns live here — purely OOXML text extraction.

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

module.exports = { xmlUnescape, parseRels, parseDocumentXml };
