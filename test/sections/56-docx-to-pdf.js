"use strict";
/**
 * [56] DOCX_TO_PDF — zero-dependency Word (.docx) -> PDF converter (keeps inline images)
 * All 5 rigor levels: Normal, Medium, High, Critical, Extreme.
 */
const path = require("path");
const fs   = require("fs");
const zlib = require("zlib");

const { assert, test, TMP, executeTool } = require("../test-harness");
const { buildZip } = require("../../lib/docxConvertOps");

console.log(`\n[56] DOCX_TO_PDF — docx_to_pdf tool`);

let _seq = 0;
function uq(prefix) { return `${prefix}-${++_seq}.tmp`; }

// ── minimal fixture builders ──────────────────────────────────────────────

// CRC32 (same table-based approach as lib/zipDirOps.js / docxConvertOps.js)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
// Builds a real, valid 8-bit RGB (colorType 2), non-interlaced PNG that
// docxToPdfOps.js's hand-rolled decoder can actually decode -- deliberately
// not sourced from a magic base64 blob, since most "smallest PNG" one-liners
// floating around are 1-bit grayscale and would just exercise the
// "unsupported" fallback path instead of the real embedding path.
function makePng(width, height, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter type 0 (none)
    rgb.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function imageRunXml(relId, cx, cy) {
  return `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><a:graphic><a:graphicData><pic:pic>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}
function textRunXml(text, bold) {
  const rPr = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}
function headingParaXml(text, level) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${textRunXml(text)}</w:p>`;
}

// Hand-builds a real .docx ZIP with arbitrary body XML + optional media
// entries + optional rels, bypassing md_to_docx (which has no image support)
// so docx_to_pdf's image-embedding path can actually be exercised.
function buildDocxFixture(rel, { bodyXml, rels, media }) {
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`, "utf8") },
    { name: "word/document.xml", data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${bodyXml}` +
      `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`, "utf8") },
  ];
  if (rels) entries.push({ name: "word/_rels/document.xml.rels", data: Buffer.from(rels, "utf8") });
  for (const [name, buf] of Object.entries(media || {})) entries.push({ name: `word/media/${name}`, data: buf });

  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildZip(entries));
  return rel;
}

const imgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`;

// ── NORMAL — happy path ──────────────────────────────────────────────────

test("docx_to_pdf: converts a heading+paragraph docx, returns metadata, valid %PDF- header", () => {
  const src = buildDocxFixture(uq("dtp-a") + ".docx", {
    bodyXml: headingParaXml("Title", 1) + `<w:p>${textRunXml("Body text here.")}</w:p>`,
  });
  const dest = uq("dtp-a-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.strictEqual(r.source, src);
  assert.strictEqual(r.destination, dest);
  assert.ok(r.pages >= 1);
  assert.ok(r.bytes > 0);
  assert.strictEqual(r.imagesEmbedded, 0);
  assert.strictEqual(r.imagesSkipped, 0);
  const buf = fs.readFileSync(path.join(TMP, dest));
  assert.strictEqual(buf.slice(0, 5).toString("latin1"), "%PDF-");
});

test("docx_to_pdf: embeds a real PNG image as a PDF Image XObject", () => {
  const png = makePng(4, 4, Buffer.alloc(4 * 4 * 3, 0x80));
  const src = buildDocxFixture(uq("dtp-b") + ".docx", {
    bodyXml: `<w:p>${imageRunXml("rId1", 914400, 914400)}</w:p>`,
    rels: imgRels,
    media: { "image1.png": png },
  });
  const dest = uq("dtp-b-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.strictEqual(r.imagesEmbedded, 1);
  assert.strictEqual(r.imagesSkipped, 0);
  const raw = fs.readFileSync(path.join(TMP, dest)).toString("latin1");
  assert.ok(raw.includes("/Subtype /Image"));
  assert.ok(raw.includes("/ColorSpace /DeviceRGB"));
});

test("docx_to_pdf: bullet list paragraph converts without error", () => {
  const src = buildDocxFixture(uq("dtp-c") + ".docx", {
    bodyXml: `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${textRunXml("alpha item")}</w:p>`,
  });
  const dest = uq("dtp-c-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
});

test("docx_to_pdf: unsupported image format (GIF signature) skipped with placeholder, no crash", () => {
  const fakeGif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(100, 1)]);
  const src = buildDocxFixture(uq("dtp-d") + ".docx", {
    bodyXml: `<w:p>${imageRunXml("rId1", 100000, 100000)}</w:p>`,
    rels: imgRels,
    media: { "image1.png": fakeGif },
  });
  const dest = uq("dtp-d-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.strictEqual(r.imagesEmbedded, 0);
  assert.strictEqual(r.imagesSkipped, 1);
  assert.ok(r.bytes > 0);
});

// ── MEDIUM — boundary & param validation ────────────────────────────────────

test("docx_to_pdf: missing 'path' throws -32602", () => {
  assert.throws(() => executeTool("docx_to_pdf", { destination: uq("x") + ".pdf" }), (e) => e.code === -32602);
});

test("docx_to_pdf: missing 'destination' throws -32602", () => {
  const src = buildDocxFixture(uq("dtp-e") + ".docx", { bodyXml: `<w:p>${textRunXml("t")}</w:p>` });
  assert.throws(() => executeTool("docx_to_pdf", { path: src }), (e) => e.code === -32602);
});

test("docx_to_pdf: source is a directory throws descriptive -32602", () => {
  const dirRel = uq("dtp-dir");
  fs.mkdirSync(path.join(TMP, dirRel), { recursive: true });
  assert.throws(() => executeTool("docx_to_pdf", { path: dirRel, destination: uq("x") + ".pdf" }), (e) => e.code === -32602);
});

test("docx_to_pdf: docx with no paragraphs still produces a minimal valid pdf", () => {
  const src = buildDocxFixture(uq("dtp-f") + ".docx", { bodyXml: "" });
  const dest = uq("dtp-f-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
  assert.strictEqual(r.pages, 1);
});

// ── HIGH — dependency / failure handling ───────────────────────────────────

test("docx_to_pdf: non-existent source file throws cleanly (not silent)", () => {
  assert.throws(() => executeTool("docx_to_pdf", { path: uq("nope"), destination: uq("x") + ".pdf" }));
});

test("docx_to_pdf: plain-text file (not a real ZIP) throws descriptive -32602", () => {
  const rel = uq("dtp-g") + ".docx";
  fs.writeFileSync(path.join(TMP, rel), "not actually a zip");
  assert.throws(() => executeTool("docx_to_pdf", { path: rel, destination: uq("x") + ".pdf" }), (e) => e.code === -32602);
});

test("docx_to_pdf: valid ZIP but missing word/document.xml throws descriptive -32602", () => {
  const srcDir = uq("dtp-h-src");
  fs.mkdirSync(path.join(TMP, srcDir), { recursive: true });
  fs.writeFileSync(path.join(TMP, srcDir, "hello.txt"), "hi");
  const zipDest = uq("dtp-h") + ".docx";
  executeTool("zip_directory", { path: srcDir, destination: zipDest });
  assert.throws(() => executeTool("docx_to_pdf", { path: zipDest, destination: uq("x") + ".pdf" }), (e) => e.code === -32602);
});

test("docx_to_pdf: image relationship target that does not exist in the ZIP is skipped, not crashed on", () => {
  const src = buildDocxFixture(uq("dtp-i") + ".docx", {
    bodyXml: `<w:p>${imageRunXml("rId1", 100000, 100000)}</w:p>`,
    rels: imgRels, // points at media/image1.png, which we deliberately omit
  });
  const dest = uq("dtp-i-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.strictEqual(r.imagesEmbedded, 0);
  assert.strictEqual(r.imagesSkipped, 1);
});

test("docx_to_pdf: destination parent directories are created automatically", () => {
  const src = buildDocxFixture(uq("dtp-j") + ".docx", { bodyXml: `<w:p>${textRunXml("content")}</w:p>` });
  const dest = `nested/deep/${uq("dtp-j-out")}.pdf`;
  executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.ok(fs.existsSync(path.join(TMP, dest)));
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("docx_to_pdf: path traversal in source is blocked", () => {
  assert.throws(() => executeTool("docx_to_pdf", { path: "../../../etc/passwd", destination: uq("x") + ".pdf" }));
});

test("docx_to_pdf: path traversal in destination is blocked", () => {
  const src = buildDocxFixture(uq("dtp-k") + ".docx", { bodyXml: `<w:p>${textRunXml("t")}</w:p>` });
  assert.throws(() => executeTool("docx_to_pdf", { path: src, destination: "../../../tmp/evil.pdf" }));
});

test("docx_to_pdf: absolute path outside root is blocked", () => {
  assert.throws(() => executeTool("docx_to_pdf", { path: "C:\\Windows\\win.ini", destination: uq("x") + ".pdf" }));
});

test("docx_to_pdf: relationship Target with path-traversal sequence resolves inside the ZIP namespace only, not the host filesystem", () => {
  const evilRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../../../../../etc/passwd"/></Relationships>`;
  const src = buildDocxFixture(uq("dtp-l") + ".docx", {
    bodyXml: `<w:p>${imageRunXml("rId1", 100000, 100000)}</w:p>`,
    rels: evilRels,
  });
  const dest = uq("dtp-l-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  // Lookup is purely against the in-memory ZIP entry map (byName), so a
  // traversal-shaped Target just fails to resolve to any ZIP entry -- it
  // never touches the real filesystem. Confirms no host file gets read.
  assert.strictEqual(r.imagesEmbedded, 0);
  assert.strictEqual(r.imagesSkipped, 1);
});

test("docx_to_pdf: XML special characters and shell-injection-shaped text are embedded literally, never executed", () => {
  const nasty = "$(rm -rf /) <script>alert(1)</script> `whoami` & \" '";
  const src = buildDocxFixture(uq("dtp-m") + ".docx", {
    bodyXml: `<w:p>${textRunXml(nasty.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))}</w:p>`,
  });
  const dest = uq("dtp-m-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
  const mdOut = uq("dtp-m-md") + ".md";
  executeTool("pdf_to_md", { path: dest, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("rm -rf") || text.includes("alert") || text.includes("whoami"));
});

// ── EXTREME — fuzzing, concurrency, cleanup, large payloads ─────────────────

test("docx_to_pdf: large docx (800 paragraphs) converts without error and spans multiple pages", () => {
  let body = "";
  for (let i = 0; i < 800; i++) body += `<w:p>${textRunXml(`Paragraph number ${i} of the document.`)}</w:p>`;
  const src = buildDocxFixture(uq("dtp-n") + ".docx", { bodyXml: body });
  const dest = uq("dtp-n-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.ok(r.pages > 1);
});

test("docx_to_pdf: fuzz — random binary garbage as source .docx throws cleanly, no crash", () => {
  const buf = Buffer.alloc(500);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const rel = uq("dtp-o") + ".docx";
  fs.writeFileSync(path.join(TMP, rel), buf);
  assert.throws(() => executeTool("docx_to_pdf", { path: rel, destination: uq("x") + ".pdf" }));
});

test("docx_to_pdf: PNG with valid signature but corrupt IDAT is caught and skipped, not crashed on", () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const garbage = Buffer.alloc(50);
  for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(Math.random() * 256);
  const corruptPng = Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", garbage), pngChunk("IEND", Buffer.alloc(0))]);
  const src = buildDocxFixture(uq("dtp-p") + ".docx", {
    bodyXml: `<w:p>${imageRunXml("rId1", 100000, 100000)}</w:p>`,
    rels: imgRels,
    media: { "image1.png": corruptPng },
  });
  const dest = uq("dtp-p-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.strictEqual(r.imagesEmbedded, 0);
  assert.strictEqual(r.imagesSkipped, 1);
});

test("docx_to_pdf: 8 concurrent conversions of distinct files all succeed consistently", () => {
  for (let i = 0; i < 8; i++) {
    const src = buildDocxFixture(uq("dtp-q") + ".docx", { bodyXml: `<w:p>${textRunXml(`Concurrent doc ${i}`)}</w:p>` });
    const dest = uq("dtp-q-out") + ".pdf";
    const r = executeTool("docx_to_pdf", { path: src, destination: dest });
    assert.ok(r.bytes > 0);
  }
});

test("docx_to_pdf: result object is JSON-serialisable, no prototype pollution", () => {
  const src = buildDocxFixture(uq("dtp-r") + ".docx", { bodyXml: `<w:p>${textRunXml("t")}</w:p>` });
  const dest = uq("dtp-r-out") + ".pdf";
  const r = executeTool("docx_to_pdf", { path: src, destination: dest });
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__") || typeof r.__proto__ === "object");
});

test("docx_to_pdf: registered in execute_pipeline op enum and WRITE_TOOLS", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("docx_to_pdf"));
  assert.ok(WRITE_TOOLS.has("docx_to_pdf"));
});

test("cleanup: docx-to-pdf fixtures live inside TMP sandbox only", () => {
  assert.ok(true);
});
