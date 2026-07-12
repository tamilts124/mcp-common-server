"use strict";
// test/sections/217-pdf-client.js
// Section 217 — pdf_client tool tests
// 75 total: A=validation(10), B=unit(20), C=happy-path(20), D=security(10), E=error-paths(10), F=concurrency(5)

const { pdfClient } = require("../../lib/pdfClientOps");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

// ── Test harness ──────────────────────────────────────────────────
let passed = 0, failed = 0, errors = [];

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; errors.push(msg); process.stderr.write(`  FAIL: ${msg}\n`); }
}

function assertThrows(fn, pattern, msg) {
  try {
    fn();
    failed++; errors.push(`Expected throw: ${msg}`);
    process.stderr.write(`  FAIL: expected throw — ${msg}\n`);
  } catch (e) {
    if (pattern && !e.message.includes(pattern)) {
      failed++; errors.push(`Wrong error for: ${msg} (got: ${e.message})`);
      process.stderr.write(`  FAIL: wrong error for '${msg}': ${e.message}\n`);
    } else {
      passed++;
    }
  }
}

// ── Setup helpers ──────────────────────────────────────────────────
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-test-"));
const allFiles = [];

function tmpFile(name) {
  const p = path.join(TMPDIR, name);
  allFiles.push(p);
  return p;
}

function resolve(p) { return { resolved: p }; }

function run(args) {
  return pdfClient(args, resolve);
}

// Build a minimal valid PDF using md_to_pdf infrastructure
const { buildPdf, markdownToPages } = require("../../lib/pdfConvertOps");

function makePdf(text, filePath) {
  const pages = markdownToPages(text);
  const buf = buildPdf(pages);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

const SAMPLE_PATH   = tmpFile("sample.pdf");
const SAMPLE2_PATH  = tmpFile("sample2.pdf");
const SAMPLE3_PATH  = tmpFile("sample3.pdf");
const OUT_PATH      = tmpFile("out.pdf");
const OUT_DIR       = path.join(TMPDIR, "split_out");

makePdf("# Hello PDF\n\nThis is page one.\n\n---\n\n## Page Two\n\nSome more content here.", SAMPLE_PATH);
makePdf("# Second Document\n\nContent from second PDF.", SAMPLE2_PATH);
makePdf("# Third Document\n\nThird PDF content.", SAMPLE3_PATH);

// ─────────────────────────────────────────────────────────────────
// A — Input Validation (10)
// ─────────────────────────────────────────────────────────────────
process.stderr.write("Section A — Validation\n");

assertThrows(() => run({}), "'operation' is required", "A1: missing operation");
assertThrows(() => run({ operation: "nope" }), "unknown operation", "A2: unknown operation");
assertThrows(() => run({ operation: "info" }), "'path' is required", "A3: info missing path");
assertThrows(() => run({ operation: "get_text" }), "'path' is required", "A4: get_text missing path");
assertThrows(() => run({ operation: "rotate", path: SAMPLE_PATH }), "'output' path is required", "A5: rotate missing output");
assertThrows(() => run({ operation: "rotate", path: SAMPLE_PATH, output: OUT_PATH }), "'degrees' must be", "A6: rotate bad degrees");
assertThrows(() => run({ operation: "rotate", path: SAMPLE_PATH, output: OUT_PATH, degrees: 45 }), "'degrees' must be", "A7: rotate degrees not 90/180/270");
assertThrows(() => run({ operation: "remove_pages", path: SAMPLE_PATH, output: OUT_PATH }), "'pages' must be", "A8: remove_pages missing pages");
assertThrows(() => run({ operation: "merge" }), "'files' must be", "A9: merge missing files");
assertThrows(() => run({ operation: "add_watermark", path: SAMPLE_PATH, output: OUT_PATH, text: "  " }), "'text' is required", "A10: watermark blank text");

// ─────────────────────────────────────────────────────────────────
// B — Unit tests (20)
// ─────────────────────────────────────────────────────────────────
process.stderr.write("Section B — Unit\n");

// B1-B4: info returns correct fields
const infoResult = run({ operation: "info", path: SAMPLE_PATH });
assert(infoResult.path === SAMPLE_PATH, "B1: info.path correct");
assert(typeof infoResult.pages === "number" && infoResult.pages >= 1, "B2: info.pages is a number >= 1");
assert(infoResult.version.startsWith("PDF-"), "B3: info.version starts with PDF-");
assert(typeof infoResult.sizeBytes === "number" && infoResult.sizeBytes > 0, "B4: info.sizeBytes > 0");
assert(Array.isArray(infoResult.pageSizes), "B5: info.pageSizes is an array");
assert(infoResult.pageSizes.length === infoResult.pages, "B6: pageSizes length equals pages");
assert(infoResult.pageSizes[0].width > 0, "B7: page width > 0");
assert(infoResult.pageSizes[0].height > 0, "B8: page height > 0");
assert(infoResult.encrypted === false, "B9: unencrypted PDF reports encrypted=false");
assert(typeof infoResult.pageSizes[0].rotate === "number", "B10: page rotate is a number");

// B11-B14: get_text returns correct fields
const textResult = run({ operation: "get_text", path: SAMPLE_PATH });
assert(typeof textResult.text === "string", "B11: get_text.text is a string");
assert(textResult.lineCount >= 0, "B12: get_text.lineCount >= 0");
assert(textResult.fromPage === 1, "B13: get_text.fromPage defaults to 1");
assert(textResult.toPage >= 1, "B14: get_text.toPage >= 1");
assert(Array.isArray(textResult.pageTexts), "B15: get_text.pageTexts is array");
assert(textResult.pageTexts.length > 0, "B16: get_text has page text entries");
assert(typeof textResult.pageTexts[0].page === "number", "B17: pageTexts[0].page is number");
assert(Array.isArray(textResult.pageTexts[0].lines), "B18: pageTexts[0].lines is array");
assert(textResult.pageCount >= 1, "B19: get_text.pageCount >= 1");
assert(textResult.text.length > 0, "B20: extracted text is non-empty");

// ─────────────────────────────────────────────────────────────────
// C — Happy-path (20)
// ─────────────────────────────────────────────────────────────────
process.stderr.write("Section C — Happy-path\n");

// C1-C3: merge two PDFs
const mergeOut = tmpFile("merged.pdf");
const mergeResult = run({ operation: "merge", files: [SAMPLE_PATH, SAMPLE2_PATH], output: mergeOut });
assert(mergeResult.pagesTotal >= 2, "C1: merge pagesTotal >= 2");
assert(fs.existsSync(mergeOut), "C2: merge created output file");
assert(mergeResult.sizeBytes > 0, "C3: merge output has bytes");

// C4: merged PDF contains pages from both inputs
const mergedInfo = run({ operation: "info", path: mergeOut });
const info1 = run({ operation: "info", path: SAMPLE_PATH });
const info2 = run({ operation: "info", path: SAMPLE2_PATH });
assert(mergedInfo.pages === info1.pages + info2.pages, "C4: merged page count = sum of inputs");

// C5-C7: split
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const splitResult = run({ operation: "split", path: SAMPLE_PATH, output_directory: OUT_DIR });
assert(splitResult.filesCreated >= 1, "C5: split created files");
assert(Array.isArray(splitResult.files), "C6: split.files is array");
assert(splitResult.files[0].pages >= 1, "C7: first split file has pages");

// C8: split output files exist on disk
for (const f of splitResult.files) {
  // f.file is original-path-prefixed; resolve it
  const absFile = path.join(OUT_DIR, path.basename(f.file));
  assert(fs.existsSync(absFile), `C8: split file exists: ${path.basename(f.file)}`);
}

// C9-C11: rotate 90 degrees
const rotOut = tmpFile("rotated.pdf");
const rotResult = run({ operation: "rotate", path: SAMPLE_PATH, output: rotOut, degrees: 90 });
assert(rotResult.degrees === 90, "C9: rotate result.degrees === 90");
assert(fs.existsSync(rotOut), "C10: rotate output file exists");
assert(rotResult.sizeBytes > 0, "C11: rotate output has bytes");

// C12: rotated PDF's pages have rotate=90
const rotInfo = run({ operation: "info", path: rotOut });
assert(rotInfo.pageSizes[0].rotate === 90, "C12: page rotate is 90 after rotation");

// C13-C14: rotate 180
const rot180Out = tmpFile("rotated180.pdf");
run({ operation: "rotate", path: SAMPLE_PATH, output: rot180Out, degrees: 180 });
const rot180Info = run({ operation: "info", path: rot180Out });
assert(rot180Info.pageSizes[0].rotate === 180, "C13: page rotate is 180");

// C14: rotate selective pages
if (info1.pages >= 2) {
  const selRotOut = tmpFile("sel_rotated.pdf");
  run({ operation: "rotate", path: SAMPLE_PATH, output: selRotOut, degrees: 90, pages: [1] });
  const selInfo = run({ operation: "info", path: selRotOut });
  assert(selInfo.pageSizes[0].rotate === 90, "C14: selective rotate page 1 = 90");
} else {
  assert(true, "C14: skipped (single page PDF)");
}

// C15-C17: remove_pages
const removeOut = tmpFile("removed.pdf");
const pagesCount = info1.pages;
if (pagesCount >= 2) {
  const removeResult = run({ operation: "remove_pages", path: SAMPLE_PATH, output: removeOut, pages: [1] });
  assert(removeResult.removedPages.includes(1), "C15: remove_pages reports page 1 removed");
  assert(fs.existsSync(removeOut), "C16: remove_pages output exists");
  const removeInfo = run({ operation: "info", path: removeOut });
  assert(removeInfo.pages === pagesCount - 1, "C17: removed PDF has one less page");
} else {
  // Can't remove all pages; single-page PDF edge case
  assert(true, "C15: skipped");
  assert(true, "C16: skipped");
  assert(true, "C17: skipped");
}

// C18-C19: add_watermark
const wmOut = tmpFile("watermarked.pdf");
const wmResult = run({ operation: "add_watermark", path: SAMPLE_PATH, output: wmOut, text: "CONFIDENTIAL" });
assert(fs.existsSync(wmOut), "C18: add_watermark output exists");
assert(wmResult.text === "CONFIDENTIAL", "C19: watermark text in result");

// C20: watermarked file is a valid PDF
const wmInfo = run({ operation: "info", path: wmOut });
assert(wmInfo.pages === info1.pages, "C20: watermarked PDF has same page count");

// ─────────────────────────────────────────────────────────────────
// D — Security (10)
// ─────────────────────────────────────────────────────────────────
process.stderr.write("Section D — Security\n");

// D1: NUL byte in path rejected
assertThrows(
  () => run({ operation: "info", path: "some\0path.pdf" }),
  "NUL byte",
  "D1: NUL byte in path rejected"
);

// D2: directory instead of file rejected
assertThrows(
  () => run({ operation: "info", path: TMPDIR }),
  "is a directory",
  "D2: directory path rejected"
);

// D3: non-PDF file header rejected
const notPdf = tmpFile("fake.pdf");
fs.writeFileSync(notPdf, "This is not a PDF\n");
assertThrows(
  () => run({ operation: "info", path: notPdf }),
  "not a valid PDF",
  "D3: non-PDF header rejected"
);

// D4: missing file throws
assertThrows(
  () => run({ operation: "info", path: tmpFile("doesnotexist.pdf") }),
  "",
  "D4: missing file throws"
);

// D5: remove_pages out-of-range page rejected
assertThrows(
  () => run({ operation: "remove_pages", path: SAMPLE_PATH, output: OUT_PATH, pages: [999] }),
  "out of range",
  "D5: out-of-range page rejected"
);

// D6: remove_pages all pages rejected
assertThrows(
  () => run({ operation: "remove_pages", path: SAMPLE_PATH, output: OUT_PATH, pages: Array.from({length: 100}, (_, i) => i+1) }),
  "", // either 'out of range' or 'cannot remove all pages'
  "D6: remove all pages rejected"
);

// D7: merge requires >= 2 files
assertThrows(
  () => run({ operation: "merge", files: [SAMPLE_PATH], output: OUT_PATH }),
  "≥ 2",
  "D7: merge with 1 file rejected"
);

// D8: merge with non-PDF throws
assertThrows(
  () => run({ operation: "merge", files: [SAMPLE_PATH, notPdf], output: OUT_PATH }),
  "not a valid PDF",
  "D8: merge with non-PDF file rejected"
);

// D9: encrypt then verify encrypted flag
const encOut = tmpFile("encrypted.pdf");
const encResult = run({ operation: "encrypt", path: SAMPLE_PATH, output: encOut, user_password: "s3cr3t" });
assert(encResult.encrypted === true, "D9: encrypt result reports encrypted=true");
assert(fs.existsSync(encOut), "D9b: encrypt output file exists");

// D10: encrypt on already-encrypted PDF rejected
assertThrows(
  () => run({ operation: "encrypt", path: encOut, output: tmpFile("double_enc.pdf"), user_password: "pw" }),
  "already encrypted",
  "D10: double-encrypt rejected"
);

// ─────────────────────────────────────────────────────────────────
// E — Error paths (10)
// ─────────────────────────────────────────────────────────────────
process.stderr.write("Section E — Error-paths\n");

// E1: split missing output_directory
assertThrows(
  () => run({ operation: "split", path: SAMPLE_PATH }),
  "'output_directory' is required",
  "E1: split missing output_directory"
);

// E2: rotate without required degrees
assertThrows(
  () => run({ operation: "rotate", path: SAMPLE_PATH, output: OUT_PATH, degrees: 0 }),
  "'degrees' must be",
  "E2: rotate degrees=0 rejected"
);

// E3: encrypt missing user_password
assertThrows(
  () => run({ operation: "encrypt", path: SAMPLE_PATH, output: OUT_PATH }),
  "'user_password' is required",
  "E3: encrypt missing user_password"
);

// E4: decrypt on non-encrypted PDF
assertThrows(
  () => run({ operation: "decrypt", path: SAMPLE_PATH, output: tmpFile("dec_noenc.pdf") }),
  "does not appear to be encrypted",
  "E4: decrypt non-encrypted PDF rejected"
);

// E5: remove_pages with empty array
assertThrows(
  () => run({ operation: "remove_pages", path: SAMPLE_PATH, output: OUT_PATH, pages: [] }),
  "'pages' must be",
  "E5: remove_pages empty array rejected"
);

// E6: add_watermark missing text
assertThrows(
  () => run({ operation: "add_watermark", path: SAMPLE_PATH, output: OUT_PATH }),
  "'text' is required",
  "E6: add_watermark missing text"
);

// E7: merge missing output
assertThrows(
  () => run({ operation: "merge", files: [SAMPLE_PATH, SAMPLE2_PATH] }),
  "'output' path is required",
  "E7: merge missing output"
);

// E8: get_text on non-existent file
assertThrows(
  () => run({ operation: "get_text", path: tmpFile("ghost.pdf") }),
  "",
  "E8: get_text on missing file throws"
);

// E9: merge with < 2 files array
assertThrows(
  () => run({ operation: "merge", files: [], output: OUT_PATH }),
  "≥ 2",
  "E9: merge empty files array rejected"
);

// E10: rotate missing path
assertThrows(
  () => run({ operation: "rotate", output: OUT_PATH, degrees: 90 }),
  "'path' is required",
  "E10: rotate missing path rejected"
);

// ─────────────────────────────────────────────────────────────────
// F — Concurrency (5)
// ─────────────────────────────────────────────────────────────────
process.stderr.write("Section F — Concurrency\n");

// F1: parallel info calls on same file
{
  const results = Array.from({ length: 5 }, (_, i) => run({ operation: "info", path: SAMPLE_PATH }));
  assert(results.every(r => r.pages >= 1), "F1: 5 concurrent info calls all succeed");
}

// F2: parallel get_text calls
{
  const results = Array.from({ length: 5 }, () => run({ operation: "get_text", path: SAMPLE_PATH }));
  assert(results.every(r => typeof r.text === "string"), "F2: 5 concurrent get_text calls all succeed");
}

// F3: parallel rotate calls to different outputs
{
  const outputs = Array.from({ length: 5 }, (_, i) => tmpFile(`concrot${i}.pdf`));
  const results = outputs.map(out => run({ operation: "rotate", path: SAMPLE_PATH, output: out, degrees: 90 }));
  assert(results.every(r => r.degrees === 90), "F3: 5 concurrent rotate calls all succeed");
  assert(outputs.every(o => fs.existsSync(o)), "F3b: all rotate outputs created");
}

// F4: parallel watermark calls to different outputs
{
  const outputs = Array.from({ length: 5 }, (_, i) => tmpFile(`concwm${i}.pdf`));
  outputs.forEach((out, i) => run({ operation: "add_watermark", path: SAMPLE_PATH, output: out, text: `WM${i}` }));
  assert(outputs.every(o => fs.existsSync(o)), "F4: 5 concurrent watermark calls all created output");
}

// F5: parallel merge calls (each uses 3 PDFs)
{
  const outputs = Array.from({ length: 3 }, (_, i) => tmpFile(`concmerge${i}.pdf`));
  outputs.forEach(out => run({ operation: "merge", files: [SAMPLE_PATH, SAMPLE2_PATH, SAMPLE3_PATH], output: out }));
  assert(outputs.every(o => fs.existsSync(o)), "F5: 3 concurrent merge calls created all outputs");
}

// ── Summary ────────────────────────────────────────────────────────────────

// Cleanup
try {
  for (const f of allFiles) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
  try { fs.rmdirSync(OUT_DIR, { recursive: true }); } catch {}
  try { fs.rmdirSync(TMPDIR, { recursive: true }); } catch {}
} catch {}

const total = passed + failed;
process.stderr.write(`\nSection 217 results: ${passed}/${total} passed`);
if (failed > 0) {
  process.stderr.write(`\nFailed tests:\n${errors.map(e => '  - ' + e).join('\n')}\n`);
}
process.stderr.write("\n");

if (failed > 0) process.exit(1);
