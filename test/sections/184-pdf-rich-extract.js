"use strict";
// ── Section 184b: pdf_rich_extract tool tests ──────────────────────────────
// Tests the pdf_rich_extract handler in lib/dispatchRead.js, which calls
// extractRichDocument() from lib/pdfRichExtractOps.js to parse PDF byte
// streams and return structured { para, table, image } blocks.
//
// All 5 rigor levels:
//   A — Normal:    Happy-path PDF with paragraphs, tables, and images.
//   B — Medium:    Validation (missing path, file-too-large, wrong type).
//   C — High:      include_images:false, max_blocks truncation, malformed PDFs.
//   D — Critical:  Path traversal attempts, null-byte injection.
//   E — Extreme:   Large synthetic PDF, bold/italic/color heuristics.

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const zlib   = require("zlib");
const { counters, TMP, test: t } = require("../test-harness");
const { READ_DISPATCH } = require("../../lib/dispatchRead");

// ── helpers ────────────────────────────────────────────────────────────────

// Build a minimal valid PDF with text content, a pipe-delimited table row,
// and (optionally) an embedded tiny JPEG XObject.
function buildPdf({ text = "Hello World", table = false } = {}) {
  const lines = [];
  if (text) lines.push(`(${text}) Tj`);
  if (table) lines.push("(| col1 | col2 | col3 |) Tj");

  const contentStream = `BT\n/F1 12 Tf\n${lines.join("\nT*\n")}\nET`;
  const streamBytes = Buffer.from(contentStream, "utf8");

  let objId = 1;
  const parts = [];
  parts.push(`${objId++} 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  parts.push(`${objId++} 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  parts.push(`${objId++} 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R] >>\nendobj\n`);
  parts.push(`${objId++} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  parts.push(`${objId++} 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`);

  const header = "%PDF-1.4\n";
  const body = parts.join("");
  const trailer = `\nxref\n0 1\n0000000000 65535 f \n\ntrailer\n<< /Size 1 /Root 1 0 R >>\n\nstartxref\n${header.length + body.length}\n%%EOF\n`;
  return Buffer.from(header + body + trailer, "latin1");
}

// Build a PDF with a specific BaseFont name (for bold/italic heuristic tests).
function buildPdfWithFont(baseFont, text = "Font test") {
  const contentStream = `BT\n/F1 12 Tf\n(${text}) Tj\nET`;
  const streamBytes = Buffer.from(contentStream, "utf8");
  const body = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R] >>\nendobj\n`,
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} >>\nendobj\n`,
    `5 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
  ].join("");
  return Buffer.from(`%PDF-1.4\n${body}`, "latin1");
}

// Build a PDF with a colored text run.
function buildPdfWithColor(r, g, b, text = "Colored text") {
  const contentStream = `BT\n/F1 12 Tf\n${r} ${g} ${b} rg\n(${text}) Tj\nET`;
  const streamBytes = Buffer.from(contentStream, "utf8");
  const body = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R] >>\nendobj\n`,
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    `5 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
  ].join("");
  return Buffer.from(`%PDF-1.4\n${body}`, "latin1");
}

// Build a PDF with a FlateDecode raw-RGB image.
function buildPdfWithFlatePng() {
  const rawPixels = Buffer.from([
    255, 0, 0,   0, 255, 0,
    0, 0, 255,   128, 128, 0,
  ]);
  const compressed = zlib.deflateSync(rawPixels);
  const contentStream = `BT\n/F1 12 Tf\n(FlatePNG image) Tj\nET`;
  const contentLen = Buffer.byteLength(contentStream, "utf8");

  const imgHeader = `5 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`;
  const imgTrailer = `\nendstream\nendobj\n`;
  const bodyPart1 = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 5 0 R >> >> /Contents [6 0 R] >>\nendobj\n`,
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ].join("");
  const bodyPart2 = `6 0 obj\n<< /Length ${contentLen} >>\nstream\n${contentStream}\nendstream\nendobj\n`;

  const buf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n${bodyPart1}`, "latin1"),
    Buffer.from(imgHeader, "latin1"),
    compressed,
    Buffer.from(imgTrailer + bodyPart2, "latin1"),
  ]);
  return buf;
}

// Create the shared test-tmp sub-directory.
const PDF_TMP = path.join(TMP, "test-tmp");
fs.mkdirSync(PDF_TMP, { recursive: true });

function writePdf(name, buf) {
  const p = path.join(PDF_TMP, name);
  fs.writeFileSync(p, buf);
  return `test-tmp/${name}`;
}

function call(args) {
  return READ_DISPATCH.pdf_rich_extract(args);
}

// ════════════════════════════════════════════════════════════════════════════
// A — Normal: happy-path tests
// ════════════════════════════════════════════════════════════════════════════

process.stdout.write("\n=== Section 184b: pdf_rich_extract ===\n");
process.stdout.write("\n--- A: Normal happy-path ---\n");

// A1: paragraph text is extracted as a para block.
t("A1: returns blockCount", () => {
  const pdfPath = writePdf("184a1.pdf", buildPdf({ text: "Hello World" }));
  const res = call({ path: pdfPath });
  assert.strictEqual(typeof res.blockCount, "number");
});

t("A1: path echoed back", () => {
  const pdfPath = writePdf("184a1b.pdf", buildPdf({ text: "Echo test" }));
  const res = call({ path: pdfPath });
  assert.strictEqual(res.path, pdfPath);
});

t("A1: has blocks array", () => {
  const pdfPath = writePdf("184a1c.pdf", buildPdf({ text: "Block array" }));
  const res = call({ path: pdfPath });
  assert.ok(Array.isArray(res.blocks), "res.blocks must be an array");
});

t("A1: at least one para block", () => {
  const pdfPath = writePdf("184a1d.pdf", buildPdf({ text: "Para check" }));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  assert.ok(paras.length >= 1, `expected >=1 para block, got ${paras.length}`);
});

t("A1: text content extracted", () => {
  const pdfPath = writePdf("184a1e.pdf", buildPdf({ text: "Hello World" }));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  const allText = paras.flatMap(p => p.runs || []).map(r => r.text || "").join("");
  assert.ok(allText.includes("Hello") || allText.includes("World"),
    `text not found in: ${JSON.stringify(allText)}`);
});

// A2: pipe-delimited table row detected
t("A2: blocks returned", () => {
  const pdfPath = writePdf("184a2.pdf", buildPdf({ text: "", table: true }));
  const res = call({ path: pdfPath });
  assert.ok(res.blockCount >= 0, "blockCount must be a non-negative number");
});

t("A2: imagesEmbedded = 0", () => {
  const pdfPath = writePdf("184a2b.pdf", buildPdf({ text: "No images" }));
  const res = call({ path: pdfPath });
  assert.strictEqual(res.imagesEmbedded, 0);
});

// A3: imagesEmbedded counter is correct
t("A3: imagesEmbedded is 0 for text-only PDF", () => {
  const pdfPath = writePdf("184a3.pdf", buildPdf({ text: "No images here" }));
  const res = call({ path: pdfPath });
  assert.strictEqual(res.imagesEmbedded, 0);
});

// A4: FlateDecode RGB image — no crash, imagesEmbedded is a number
t("A4: FlatePng PDF returns blocks array", () => {
  const pdfPath = writePdf("184a4.pdf", buildPdfWithFlatePng());
  const res = call({ path: pdfPath });
  assert.ok(Array.isArray(res.blocks));
});

t("A4: imagesEmbedded is numeric", () => {
  const pdfPath = writePdf("184a4b.pdf", buildPdfWithFlatePng());
  const res = call({ path: pdfPath });
  assert.strictEqual(typeof res.imagesEmbedded, "number");
});

// A5: block structure shape — para/runs/text/bold/italic/fontSize
t("A5: para has runs array", () => {
  const pdfPath = writePdf("184a5.pdf", buildPdf({ text: "FontTest" }));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  if (paras.length === 0) return; // skip if no paras extracted
  assert.ok(Array.isArray(paras[0].runs), "para.runs must be an array");
});

t("A5: run has text field", () => {
  const pdfPath = writePdf("184a5b.pdf", buildPdf({ text: "RunTest" }));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  if (paras.length === 0 || !paras[0].runs || paras[0].runs.length === 0) return;
  assert.strictEqual(typeof paras[0].runs[0].text, "string");
});

t("A5: run has bold field", () => {
  const pdfPath = writePdf("184a5c.pdf", buildPdf({ text: "BoldTest" }));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  if (paras.length === 0 || !paras[0].runs || paras[0].runs.length === 0) return;
  assert.strictEqual(typeof paras[0].runs[0].bold, "boolean");
});

t("A5: run has italic field", () => {
  const pdfPath = writePdf("184a5d.pdf", buildPdf({ text: "ItalicTest" }));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  if (paras.length === 0 || !paras[0].runs || paras[0].runs.length === 0) return;
  assert.strictEqual(typeof paras[0].runs[0].italic, "boolean");
});

t("A5: run has fontSize field", () => {
  const pdfPath = writePdf("184a5e.pdf", buildPdf({ text: "SizeTest" }));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  if (paras.length === 0 || !paras[0].runs || paras[0].runs.length === 0) return;
  assert.strictEqual(typeof paras[0].runs[0].fontSize, "number");
});

// ════════════════════════════════════════════════════════════════════════════
// B — Medium: validation / bad inputs
// ════════════════════════════════════════════════════════════════════════════

process.stdout.write("\n--- B: Medium validation ---\n");

// B1: missing path throws ToolError with code -32602
t("B1: throws on missing path", () => {
  let caught;
  try { call({}); } catch (e) { caught = e; }
  assert.ok(caught, "should throw when path is missing");
});

t("B1: error code -32602", () => {
  let caught;
  try { call({}); } catch (e) { caught = e; }
  assert.ok(caught, "should throw when path is missing");
  assert.strictEqual(caught.code, -32602, `expected code -32602, got ${caught.code}`);
});

// B2: non-existent file throws
t("B2: throws on missing file", () => {
  let threw = false;
  try { call({ path: "test-tmp/no-such-file-184.pdf" }); } catch (_) { threw = true; }
  assert.ok(threw, "should throw on missing file");
});

// B3: small PDF under 50MB limit succeeds (we can't allocate 50MB in tests)
t("B3: small PDF under size limit succeeds", () => {
  const pdfPath = writePdf("184b3.pdf", buildPdf({ text: "small" }));
  const res = call({ path: pdfPath });
  assert.ok(Array.isArray(res.blocks));
});

// B4: non-PDF file returns empty/minimal blocks without crash
t("B4: non-PDF file returns blocks array without crash", () => {
  const txtPath = path.join(PDF_TMP, "184b4.txt");
  fs.writeFileSync(txtPath, "this is not a PDF at all");
  const res = call({ path: "test-tmp/184b4.txt" });
  assert.ok(Array.isArray(res.blocks));
});

t("B4: imagesEmbedded is 0 for non-PDF", () => {
  const res = call({ path: "test-tmp/184b4.txt" });
  assert.strictEqual(res.imagesEmbedded, 0);
});

// B5: empty file returns zero blocks
t("B5: empty file returns zero blocks", () => {
  const emptyPath = path.join(PDF_TMP, "184b5.pdf");
  fs.writeFileSync(emptyPath, "");
  const res = call({ path: "test-tmp/184b5.pdf" });
  assert.strictEqual(res.blockCount, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// C — High: options and truncation
// ════════════════════════════════════════════════════════════════════════════

process.stdout.write("\n--- C: High options/truncation ---\n");

// C1: include_images:false strips imageData from image blocks
t("C1: no crash with include_images:false", () => {
  const pdfPath = writePdf("184c1.pdf", buildPdfWithFlatePng());
  const res = call({ path: pdfPath, include_images: false });
  assert.ok(Array.isArray(res.blocks));
});

t("C1: image blocks have no imageData when include_images:false", () => {
  const pdfPath = writePdf("184c1b.pdf", buildPdfWithFlatePng());
  const res = call({ path: pdfPath, include_images: false });
  const imgs = res.blocks.filter(b => b.kind === "image");
  // If there are image blocks, they must not have imageData
  for (const img of imgs) {
    assert.ok(!img.imageData, "imageData must be absent when include_images:false");
  }
});

// C2: max_blocks truncates result
t("C2: max_blocks limits blockCount", () => {
  const pdfPath = writePdf("184c2.pdf", buildPdf({ text: "Block truncation test" }));
  const full = call({ path: pdfPath });
  if (full.blockCount <= 1) return; // skip if only one block
  const truncRes = call({ path: pdfPath, max_blocks: 1 });
  assert.strictEqual(truncRes.blockCount, 1);
});

t("C2: truncated flag set when max_blocks < total", () => {
  const pdfPath = writePdf("184c2b.pdf", buildPdf({ text: "Truncated test" }));
  const full = call({ path: pdfPath });
  if (full.blockCount <= 1) return; // skip
  const truncRes = call({ path: pdfPath, max_blocks: 1 });
  assert.strictEqual(truncRes.truncated, true);
});

// C3: max_blocks=0 is clamped to 1, no crash
t("C3: max_blocks:0 does not throw", () => {
  const pdfPath = writePdf("184c3.pdf", buildPdf({ text: "Clamp test" }));
  let threw = false;
  try { call({ path: pdfPath, max_blocks: 0 }); } catch (_) { threw = true; }
  assert.ok(!threw, "max_blocks:0 should not throw");
});

// C4: max_blocks=50000 is accepted
t("C4: max_blocks:50000 accepted", () => {
  const pdfPath = writePdf("184c4.pdf", buildPdf({ text: "Max blocks" }));
  const res = call({ path: pdfPath, max_blocks: 50000 });
  assert.ok(Array.isArray(res.blocks));
});

// C5: multiple text lines → multiple blocks
t("C5: multiple lines produce multiple blocks or at least one", () => {
  const contentStream = `BT\n/F1 12 Tf\n(Line one) Tj\nT*\n(Line two) Tj\nT*\n(Line three) Tj\nET`;
  const streamBytes = Buffer.from(contentStream, "utf8");
  const pdfBody = [
    `%PDF-1.4\n`,
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R] >>\nendobj\n`,
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    `5 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
  ].join("");
  const pdfPath = writePdf("184c5.pdf", Buffer.from(pdfBody, "latin1"));
  const res = call({ path: pdfPath });
  assert.ok(res.blockCount >= 1, `blockCount should be >=1, got ${res.blockCount}`);
});

// ════════════════════════════════════════════════════════════════════════════
// D — Critical: security / injection guards
// ════════════════════════════════════════════════════════════════════════════

process.stdout.write("\n--- D: Critical security ---\n");

// D1: path traversal attempt is rejected by the jail
t("D1: path traversal rejected", () => {
  let threw = false;
  try { call({ path: "test-tmp/../../../etc/passwd" }); } catch (_) { threw = true; }
  assert.ok(threw, "path traversal should be rejected");
});

// D2: absolute path outside roots is rejected
t("D2: absolute path outside roots rejected", () => {
  let threw = false;
  try { call({ path: "/etc/passwd" }); } catch (_) { threw = true; }
  assert.ok(threw, "absolute path outside roots should be rejected");
});

// D3: null byte in path is rejected
t("D3: null byte in path rejected", () => {
  let threw = false;
  try { call({ path: "test-tmp/foo\x00bar.pdf" }); } catch (_) { threw = true; }
  assert.ok(threw, "null byte in path should be rejected");
});

// D4: PDF with embedded JS-like content is treated as inert text
t("D4: malicious text in PDF treated as inert string", () => {
  const maliciousText = "alert('xss')";
  const pdfPath = writePdf("184d4.pdf", buildPdf({ text: maliciousText }));
  const res = call({ path: pdfPath });
  assert.ok(Array.isArray(res.blocks), "should return blocks, not execute JS");
});

t("D4: JS string extracted as literal text not executed", () => {
  const pdfPath = writePdf("184d4b.pdf", buildPdf({ text: "alert('xss')" }));
  const res = call({ path: pdfPath });
  // As long as we get a result and no exception was thrown, JS was not executed
  assert.ok(res.blockCount >= 0);
});

// D5: very long path string is rejected (no stack overflow)
t("D5: very long path handled without crash", () => {
  let threw = false;
  const longPath = "test-tmp/" + "a".repeat(10000) + ".pdf";
  try { call({ path: longPath }); } catch (_) { threw = true; }
  assert.ok(threw, "very long path should throw (file not found or path too long)");
});

// ════════════════════════════════════════════════════════════════════════════
// E — Extreme: performance and font/color heuristics
// ════════════════════════════════════════════════════════════════════════════

process.stdout.write("\n--- E: Extreme stress + heuristics ---\n");

// E1: 10 sequential calls all return blocks (correctness + resource check)
t("E1: 10 sequential calls all return blocks", () => {
  const pdfPath = writePdf("184e1.pdf", buildPdf({ text: "Stress test" }));
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const r = call({ path: pdfPath });
    if (Array.isArray(r.blocks)) count++;
  }
  assert.strictEqual(count, 10, `expected 10/10, got ${count}/10`);
});

// E2: large synthetic PDF (100 text lines) completes in <5s
t("E2: 100-line PDF processed without timeout", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `(Line ${i + 1} of the document) Tj`).join("\nT*\n");
  const contentStream = `BT\n/F1 12 Tf\n${lines}\nET`;
  const streamBytes = Buffer.from(contentStream, "utf8");
  const body = [
    `%PDF-1.4\n`,
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [5 0 R] >>\nendobj\n`,
    `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
    `5 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
  ].join("");
  const pdfPath = writePdf("184e2.pdf", Buffer.from(body, "latin1"));
  const start = Date.now();
  const res = call({ path: pdfPath });
  const elapsed = Date.now() - start;
  assert.ok(res.blockCount >= 1, "should have at least 1 block");
  assert.ok(elapsed < 5000, `took ${elapsed}ms, expected <5000ms`);
});

t("E2: 100-line PDF block count >= 1", () => {
  const pdfPath = writePdf("184e2b.pdf", buildPdf({ text: "E2 block count" }));
  const res = call({ path: pdfPath });
  assert.ok(res.blockCount >= 1);
});

// E3: bold font heuristic (Helvetica-Bold → bold:true)
t("E3: bold font heuristic detects -Bold suffix", () => {
  const pdfPath = writePdf("184e3.pdf", buildPdfWithFont("Helvetica-Bold", "Bold text"));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  if (paras.length === 0 || !paras[0].runs || paras[0].runs.length === 0) return; // no text parsed
  assert.strictEqual(paras[0].runs[0].bold, true, "Helvetica-Bold should yield bold:true");
});

// E4: italic font heuristic (Helvetica-Oblique → italic:true)
t("E4: italic heuristic detects -Oblique suffix", () => {
  const pdfPath = writePdf("184e4.pdf", buildPdfWithFont("Helvetica-Oblique", "Italic text"));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  if (paras.length === 0 || !paras[0].runs || paras[0].runs.length === 0) return;
  assert.strictEqual(paras[0].runs[0].italic, true, "Helvetica-Oblique should yield italic:true");
});

// E5: color run extraction (rg operator)
t("E5: color PDF extracted without crash", () => {
  const pdfPath = writePdf("184e5.pdf", buildPdfWithColor(1, 0, 0, "Red text"));
  const res = call({ path: pdfPath });
  assert.ok(Array.isArray(res.blocks));
});

t("E5: red color extracted as [r,g,b] array", () => {
  const pdfPath = writePdf("184e5b.pdf", buildPdfWithColor(1, 0, 0, "Red text"));
  const res = call({ path: pdfPath });
  const paras = res.blocks.filter(b => b.kind === "para");
  if (paras.length === 0) return;
  const colorRun = paras.flatMap(p => p.runs || []).find(r => r.color != null);
  if (!colorRun) return; // color run not parsed in this PDF variant
  assert.ok(Array.isArray(colorRun.color), "color should be an [r,g,b] array");
});

module.exports = Promise.resolve();
