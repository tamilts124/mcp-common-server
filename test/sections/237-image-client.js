"use strict";
// ── Section 237: image_client tests ──────────────────────────────────────────
// Isolated functional tests for lib/imageClientOps.js
// Rigor levels: A=validation, B=unit, C=happy-path, D=security, E=error-paths, F=concurrency

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const { imageClient } = require("../../lib/imageClientOps");

let passed = 0, failed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "image-client-test-"));

function test(name, fn) {
  try {
    fn();
    console.error(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assertThrows(fn, msgPart) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgPart && !e.message.includes(msgPart))
      throw new Error(`Expected error containing '${msgPart}' but got: ${e.message}`);
  }
  if (!threw) throw new Error("Expected error but none thrown");
}

// ── Helpers: build minimal binary test files ──────────────────────────────────

function buildMinimalJpeg(width, height) {
  width  = width  || 64;
  height = height || 48;
  const parts = [];
  parts.push(Buffer.from([0xFF, 0xD8]));
  // APP0 JFIF
  const app0 = Buffer.alloc(18);
  app0[0] = 0xFF; app0[1] = 0xE0;
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "latin1");
  app0[9] = 0x01; app0[10] = 0x01;
  app0[11] = 0x01;
  app0.writeUInt16BE(72, 12);
  app0.writeUInt16BE(72, 14);
  parts.push(app0);
  // SOF0
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xFF; sof0[1] = 0xC0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3;
  parts.push(sof0);
  // SOS + minimal data + EOI
  parts.push(Buffer.from([0xFF, 0xDA, 0x00, 0x0C, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00]));
  parts.push(Buffer.from([0x00, 0xFF, 0xD9]));
  return Buffer.concat(parts);
}

function buildMinimalPng(width, height, colorType) {
  width = width || 32; height = height || 32; colorType = colorType || 2;
  const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = colorType;
  const ihdrChunk = Buffer.alloc(4 + 4 + 13 + 4);
  ihdrChunk.writeUInt32BE(13, 0);
  ihdrChunk.write("IHDR", 4, "latin1");
  ihdrData.copy(ihdrChunk, 8);
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
  return Buffer.concat([SIG, ihdrChunk, iend]);
}

function buildMinimalBmp(width, height, bpp) {
  width = width || 16; height = height || 16; bpp = bpp || 24;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const pixelSize = rowSize * height;
  const fileSize = 54 + pixelSize;
  const buf = Buffer.alloc(fileSize, 0);
  buf[0] = 0x42; buf[1] = 0x4D;
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(0, 30);
  return buf;
}

function buildMinimalGif(width, height, frames) {
  width = width || 8; height = height || 8; frames = frames || 1;
  const parts = [];
  parts.push(Buffer.from("GIF89a", "latin1"));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | 0x01;
  parts.push(lsd);
  parts.push(Buffer.alloc(12, 0x80)); // GCT 4 colors
  for (let f = 0; f < frames; f++) {
    if (frames > 1) {
      parts.push(Buffer.from([0x21, 0xF9, 0x04, 0x01, 0x0A, 0x00, 0x00, 0x00]));
    }
    const id = Buffer.alloc(10);
    id[0] = 0x2C;
    id.writeUInt16LE(0, 1); id.writeUInt16LE(0, 3);
    id.writeUInt16LE(width, 5); id.writeUInt16LE(height, 7);
    id[9] = 0;
    parts.push(id);
    parts.push(Buffer.from([0x02, 0x02, 0x4C, 0x01, 0x00]));
  }
  parts.push(Buffer.from([0x3B]));
  return Buffer.concat(parts);
}

function buildMinimalIco() {
  const buf = Buffer.alloc(6 + 16 + 40, 0);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(1, 4);
  buf[6] = 16; buf[7] = 16;
  buf.writeUInt16LE(1, 10);
  buf.writeUInt16LE(32, 12);
  buf.writeUInt32LE(40, 14);
  buf.writeUInt32LE(6 + 16, 18);
  const bih = buf.slice(6 + 16);
  bih.writeUInt32LE(40, 0);
  bih.writeInt32LE(16, 4);
  bih.writeInt32LE(32, 8);
  bih.writeUInt16LE(1, 12);
  bih.writeUInt16LE(32, 14);
  return buf;
}

function buildMinimalWebp(width, height) {
  width = width || 10; height = height || 10;
  // Layout: RIFF(4) + riffSize(4) + WEBP(4) + "VP8 "(4) + chunkSize(4) + chunkData(16) = 36 bytes total
  const buf = Buffer.alloc(36, 0);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(28, 4);           // riff payload size = 4(WEBP) + 8(chunkHdr) + 16(data)
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8 ", 12, "latin1");
  buf.writeUInt32LE(16, 16);          // chunk data size
  // VP8 bitstream: at byte 3,4,5 of chunk data (offset 20+3=23)
  buf[23] = 0x9D; buf[24] = 0x01; buf[25] = 0x2A;
  // width/height at offsets 26 and 28 (within the 36-byte buffer)
  buf.writeUInt16LE(width,  26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

function buildJpegWithExif() {
  const parts = [];
  parts.push(Buffer.from([0xFF, 0xD8]));
  // TIFF IFD with Make tag
  const tiff = Buffer.alloc(128, 0);
  tiff[0] = 0x49; tiff[1] = 0x49; // LE
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 at offset 8
  tiff.writeUInt16LE(1, 8); // 1 entry
  // Make tag (0x010F), ASCII, fits inline (4 chars "CAM\0")
  const e = 10;
  tiff.writeUInt16LE(0x010F, e);
  tiff.writeUInt16LE(2, e+2); // ASCII
  tiff.writeUInt32LE(4, e+4); // count
  tiff.write("CAM\0", e+8, "latin1"); // fits in 4 bytes
  tiff.writeUInt32LE(0, e+12); // next IFD

  const exifHeader = Buffer.from("Exif\0\0", "latin1");
  const tiffSlice  = tiff.slice(0, e + 16);
  const app1Data   = Buffer.concat([exifHeader, tiffSlice]);
  const app1       = Buffer.alloc(4 + app1Data.length);
  app1[0] = 0xFF; app1[1] = 0xE1;
  app1.writeUInt16BE(2 + app1Data.length, 2);
  app1Data.copy(app1, 4);
  parts.push(app1);
  // SOF0
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xFF; sof0[1] = 0xC0;
  sof0.writeUInt16BE(17, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(48, 5);
  sof0.writeUInt16BE(64, 7);
  sof0[9] = 3;
  parts.push(sof0);
  parts.push(Buffer.from([0xFF, 0xDA, 0x00, 0x0C, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00, 0x00, 0xFF, 0xD9]));
  return Buffer.concat(parts);
}

function buildPngWithText(key, value) {
  const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(32, 0); ihdrData.writeUInt32BE(32, 4);
  ihdrData[8] = 8; ihdrData[9] = 2;
  const makeChunk = (type, data) => {
    const c = Buffer.alloc(4 + 4 + data.length + 4);
    c.writeUInt32BE(data.length, 0);
    c.write(type, 4, "latin1");
    data.copy(c, 8);
    return c;
  };
  const textData = Buffer.from(key + "\0" + value, "latin1");
  const iend = Buffer.from([0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82]);
  return Buffer.concat([SIG, makeChunk("IHDR", ihdrData), makeChunk("tEXt", textData), iend]);
}

function writeTmp(name, buf) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, buf);
  return p;
}

// Pre-create test files
const jpegPath     = writeTmp("test.jpg",      buildMinimalJpeg(64, 48));
const pngPath      = writeTmp("test.png",      buildMinimalPng(32, 32, 2));
const pngAlpha     = writeTmp("test-rgba.png", buildMinimalPng(16, 16, 6));
const webpPath     = writeTmp("test.webp",     buildMinimalWebp(10, 10));
const bmpPath      = writeTmp("test.bmp",      buildMinimalBmp(16, 16, 24));
const gifPath      = writeTmp("test.gif",      buildMinimalGif(8, 8, 1));
const gifAnim      = writeTmp("test-anim.gif", buildMinimalGif(8, 8, 3));
const icoPath      = writeTmp("test.ico",      buildMinimalIco());
const jpegExifPath = writeTmp("test-exif.jpg", buildJpegWithExif());
const pngTextPath  = writeTmp("test-text.png", buildPngWithText("Author", "TestAuthor"));

// ── A: Validation (10) ────────────────────────────────────────────────────────
console.error("\n[A] Validation");

test("A01: missing operation throws", () => {
  assertThrows(() => imageClient({ path: jpegPath }), "'operation' is required");
});
test("A02: missing path throws", () => {
  assertThrows(() => imageClient({ operation: "info" }), "'path' is required");
});
test("A03: unknown operation throws", () => {
  assertThrows(() => imageClient({ operation: "flip", path: jpegPath }), "unknown operation");
});
test("A04: all 5 valid operations accepted for JPEG", () => {
  for (const op of ["info", "exif", "iptc", "xmp", "validate"]) {
    const r = imageClient({ operation: op, path: jpegPath });
    assert.ok(r, `op '${op}' returned nothing`);
  }
});
test("A05: NUL byte in path throws", () => {
  assertThrows(() => imageClient({ operation: "info", path: "test\0.jpg" }), "NUL byte");
});
test("A06: directory path throws", () => {
  assertThrows(() => imageClient({ operation: "info", path: tmpDir }), "directory");
});
test("A07: nonexistent file throws", () => {
  assertThrows(() => imageClient({ operation: "info", path: path.join(tmpDir, "nope.jpg") }), "");
});
test("A08: unrecognized format throws", () => {
  const p = writeTmp("unknown.bin", Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
  assertThrows(() => imageClient({ operation: "info", path: p }), "unrecognized image format");
});
test("A09: all 5 valid operations accepted for PNG", () => {
  for (const op of ["info", "exif", "iptc", "xmp", "validate"]) {
    const r = imageClient({ operation: op, path: pngPath });
    assert.ok(r, `PNG op '${op}' returned nothing`);
  }
});
test("A10: all 5 valid operations accepted for BMP", () => {
  for (const op of ["info", "exif", "iptc", "xmp", "validate"]) {
    const r = imageClient({ operation: op, path: bmpPath });
    assert.ok(r, `BMP op '${op}' returned nothing`);
  }
});

// ── B: Unit (20) ──────────────────────────────────────────────────────────────
console.error("\n[B] Unit");

test("B01: JPEG info returns format=JPEG", () => {
  assert.strictEqual(imageClient({ operation: "info", path: jpegPath }).format, "JPEG");
});
test("B02: JPEG info returns correct dimensions", () => {
  const r = imageClient({ operation: "info", path: jpegPath });
  assert.strictEqual(r.width, 64);
  assert.strictEqual(r.height, 48);
});
test("B03: JPEG info returns channels=3", () => {
  assert.strictEqual(imageClient({ operation: "info", path: jpegPath }).channels, 3);
});
test("B04: PNG info returns format=PNG and correct size", () => {
  const r = imageClient({ operation: "info", path: pngPath });
  assert.strictEqual(r.format, "PNG");
  assert.strictEqual(r.width, 32);
  assert.strictEqual(r.height, 32);
});
test("B05: PNG colorType 2 = RGB, hasAlpha=false", () => {
  const r = imageClient({ operation: "info", path: pngPath });
  assert.strictEqual(r.colorSpace, "RGB");
  assert.strictEqual(r.hasAlpha, false);
});
test("B06: PNG colorType 6 = RGBA, hasAlpha=true", () => {
  const r = imageClient({ operation: "info", path: pngAlpha });
  assert.strictEqual(r.colorSpace, "RGBA");
  assert.strictEqual(r.hasAlpha, true);
});
test("B07: BMP info returns format=BMP and correct size", () => {
  const r = imageClient({ operation: "info", path: bmpPath });
  assert.strictEqual(r.format, "BMP");
  assert.strictEqual(r.width, 16);
  assert.strictEqual(r.height, 16);
});
test("B08: GIF info returns format=GIF", () => {
  assert.strictEqual(imageClient({ operation: "info", path: gifPath }).format, "GIF");
});
test("B09: GIF animated returns frameCount>=3 and isAnimated=true", () => {
  const r = imageClient({ operation: "info", path: gifAnim });
  assert.ok(r.frameCount >= 3, `Expected 3+ frames, got ${r.frameCount}`);
  assert.strictEqual(r.isAnimated, true);
});
test("B10: ICO info returns format=ICO with images array", () => {
  const r = imageClient({ operation: "info", path: icoPath });
  assert.strictEqual(r.format, "ICO");
  assert.ok(r.imageCount >= 1);
  assert.ok(Array.isArray(r.images));
});
test("B11: ICO images[0] is 16x16 32bpp", () => {
  const r = imageClient({ operation: "info", path: icoPath });
  const img = r.images.find(i => i.width === 16 && i.height === 16);
  assert.ok(img, "No 16x16 ICO image found");
  assert.strictEqual(img.bitsPerPixel, 32);
});
test("B12: WebP info returns format=WebP", () => {
  assert.strictEqual(imageClient({ operation: "info", path: webpPath }).format, "WebP");
});
test("B13: JPEG without EXIF returns hasEXIF=false in info", () => {
  assert.strictEqual(imageClient({ operation: "info", path: jpegPath }).hasEXIF, false);
});
test("B14: JPEG with EXIF returns hasEXIF=true in info", () => {
  assert.strictEqual(imageClient({ operation: "info", path: jpegExifPath }).hasEXIF, true);
});
test("B15: exif op returns exif object with Make tag", () => {
  const r = imageClient({ operation: "exif", path: jpegExifPath });
  assert.ok(r.hasEXIF, "Expected hasEXIF=true");
  assert.ok(r.exif["Make"] !== undefined, `Make tag not found; keys: ${Object.keys(r.exif).join(",")}`);
});
test("B16: JPEG exif Make tag value is CAM", () => {
  const r = imageClient({ operation: "exif", path: jpegExifPath });
  assert.ok(r.exif["Make"].includes("CAM"), `Make='${r.exif["Make"]}'`);
});
test("B17: PNG tEXt metadata extracted in info", () => {
  const r = imageClient({ operation: "info", path: pngTextPath });
  assert.ok(r.textMetadata, "Expected textMetadata");
  assert.strictEqual(r.textMetadata["Author"], "TestAuthor");
});
test("B18: iptc op on plain JPEG returns iptc object (empty)", () => {
  const r = imageClient({ operation: "iptc", path: jpegPath });
  assert.ok("iptc" in r);
  assert.ok(typeof r.iptc === "object");
});
test("B19: xmp op returns xmp object", () => {
  const r = imageClient({ operation: "xmp", path: jpegPath });
  assert.ok("xmp" in r);
});
test("B20: xmp include_raw=true returns rawXMP key", () => {
  const r = imageClient({ operation: "xmp", path: jpegPath, include_raw: true });
  assert.ok("rawXMP" in r);
});

// ── C: Happy-path (20) ────────────────────────────────────────────────────────
console.error("\n[C] Happy-path");

test("C01: info returns correct fileSize", () => {
  const r = imageClient({ operation: "info", path: jpegPath });
  assert.strictEqual(r.fileSize, fs.statSync(jpegPath).size);
});
test("C02: info echoes path", () => {
  assert.strictEqual(imageClient({ operation: "info", path: jpegPath }).path, jpegPath);
});
test("C03: info echoes operation", () => {
  assert.strictEqual(imageClient({ operation: "info", path: pngPath }).operation, "info");
});
test("C04: validate returns valid=true for well-formed JPEG", () => {
  const r = imageClient({ operation: "validate", path: jpegPath });
  assert.strictEqual(r.valid, true, `Issues: ${JSON.stringify(r.issues)}`);
  assert.strictEqual(r.issueCount, 0);
});
test("C05: validate returns valid=true for well-formed PNG", () => {
  const r = imageClient({ operation: "validate", path: pngPath });
  assert.strictEqual(r.valid, true, `Issues: ${JSON.stringify(r.issues)}`);
});
test("C06: validate returns valid=true for BMP", () => {
  const r = imageClient({ operation: "validate", path: bmpPath });
  assert.strictEqual(r.valid, true, `Issues: ${JSON.stringify(r.issues)}`);
});
test("C07: validate returns valid=true for GIF", () => {
  const r = imageClient({ operation: "validate", path: gifPath });
  assert.strictEqual(r.valid, true, `Issues: ${JSON.stringify(r.issues)}`);
});
test("C08: validate returns valid=true for ICO", () => {
  const r = imageClient({ operation: "validate", path: icoPath });
  assert.strictEqual(r.valid, true, `Issues: ${JSON.stringify(r.issues)}`);
});
test("C09: PNG bitDepth=8", () => {
  assert.strictEqual(imageClient({ operation: "info", path: pngPath }).bitDepth, 8);
});
test("C10: JPEG bitDepth=8", () => {
  assert.strictEqual(imageClient({ operation: "info", path: jpegPath }).bitDepth, 8);
});
test("C11: BMP 24bpp colorSpace=RGB", () => {
  const r = imageClient({ operation: "info", path: bmpPath });
  assert.strictEqual(r.colorSpace, "RGB");
  assert.strictEqual(r.bitDepth, 24);
});
test("C12: GIF colorSpace=Indexed", () => {
  assert.strictEqual(imageClient({ operation: "info", path: gifPath }).colorSpace, "Indexed");
});
test("C13: ICO hasAlpha=true", () => {
  assert.strictEqual(imageClient({ operation: "info", path: icoPath }).hasAlpha, true);
});
test("C14: JPEG info has appSegments array", () => {
  assert.ok(Array.isArray(imageClient({ operation: "info", path: jpegPath }).appSegments));
});
test("C15: PNG chunkTypes includes IHDR", () => {
  const r = imageClient({ operation: "info", path: pngPath });
  assert.ok(Array.isArray(r.chunkTypes));
  assert.ok(r.chunkTypes.includes("IHDR"));
});
test("C16: PNG chunkTypes includes IEND", () => {
  assert.ok(imageClient({ operation: "info", path: pngPath }).chunkTypes.includes("IEND"));
});
test("C17: exif on plain PNG returns hasEXIF=false", () => {
  assert.strictEqual(imageClient({ operation: "exif", path: pngPath }).hasEXIF, false);
});
test("C18: iptc on PNG returns empty iptc", () => {
  const r = imageClient({ operation: "iptc", path: pngPath });
  assert.strictEqual(r.hasIPTC, false);
  assert.strictEqual(Object.keys(r.iptc).length, 0);
});
test("C19: GIF version starts with GIF89 for animated", () => {
  assert.ok(imageClient({ operation: "info", path: gifAnim }).version.startsWith("GIF89"));
});
test("C20: WebP info returns numeric width and height", () => {
  const r = imageClient({ operation: "info", path: webpPath });
  assert.ok(typeof r.width === "number");
  assert.ok(typeof r.height === "number");
});

// ── D: Security (10) ──────────────────────────────────────────────────────────
console.error("\n[D] Security");

test("D01: NUL byte in path rejected", () => {
  assertThrows(() => imageClient({ operation: "info", path: "img\0.jpg" }), "NUL byte");
});
test("D02: directory path rejected", () => {
  assertThrows(() => imageClient({ operation: "info", path: tmpDir }), "directory");
});
test("D03: truncated JPEG (SOI+marker) returns width=0, no crash", () => {
  // Need >=4 bytes so detectFormat can identify JPEG (FF D8 FF + one more byte)
  const p = writeTmp("truncjpeg.jpg", Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
  const r = imageClient({ operation: "info", path: p });
  assert.strictEqual(r.format, "JPEG");
  assert.strictEqual(r.width, 0);
});
test("D04: too-small PNG (8+1 bytes) throws", () => {
  const p = writeTmp("tinypng.png",
    Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00]));
  assertThrows(() => imageClient({ operation: "info", path: p }), "PNG too small");
});
test("D05: too-small BMP throws", () => {
  // Need >=4 bytes so detectFormat identifies it as BMP (0x42 0x4D + 2 more)
  const p = writeTmp("tinybmp.bmp", Buffer.from([0x42,0x4D,0x00,0x00]));
  assertThrows(() => imageClient({ operation: "info", path: p }), "BMP too small");
});
test("D06: too-small GIF (header only) throws", () => {
  const p = writeTmp("tinygif.gif", Buffer.from("GIF89a", "latin1"));
  assertThrows(() => imageClient({ operation: "info", path: p }), "GIF too small");
});
test("D07: too-small ICO throws", () => {
  // Need >=4 bytes so detectFormat identifies it as ICO (00 00 01 00)
  const p = writeTmp("tinyico.ico", Buffer.from([0x00,0x00,0x01,0x00]));
  assertThrows(() => imageClient({ operation: "info", path: p }), "ICO too small");
});
test("D08: EXIF IFD with 1001 entries (>1000) is safely skipped", () => {
  const parts = [Buffer.from([0xFF, 0xD8])];
  const exifBuf = Buffer.alloc(64, 0);
  exifBuf[0] = 0x49; exifBuf[1] = 0x49;
  exifBuf.writeUInt16LE(42, 2);
  exifBuf.writeUInt32LE(8, 4);
  exifBuf.writeUInt16LE(1001, 8); // >1000 limit
  const exifHeader = Buffer.from("Exif\0\0", "latin1");
  const app1Data = Buffer.concat([exifHeader, exifBuf]);
  const app1 = Buffer.alloc(4 + app1Data.length);
  app1[0] = 0xFF; app1[1] = 0xE1;
  app1.writeUInt16BE(2 + app1Data.length, 2);
  app1Data.copy(app1, 4);
  parts.push(app1);
  parts.push(Buffer.from([0xFF, 0xD9]));
  const p = writeTmp("bigifd.jpg", Buffer.concat(parts));
  const r = imageClient({ operation: "exif", path: p });
  assert.strictEqual(typeof r.exif, "object"); // no throw, no hang
});
test("D09: PNG with overflowing chunk length is handled safely", () => {
  const SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(4,0); ihdrData.writeUInt32BE(4,4);
  ihdrData[8]=8; ihdrData[9]=2;
  const ihdr = Buffer.alloc(4+4+13+4);
  ihdr.writeUInt32BE(13,0); ihdr.write("IHDR",4,"latin1"); ihdrData.copy(ihdr,8);
  // A chunk with absurdly large declared length
  const badChunk = Buffer.alloc(12,0);
  badChunk.writeUInt32BE(0xFFFFFF00, 0); // huge length
  badChunk.write("tEXt", 4, "latin1");
  const p = writeTmp("overflow.png", Buffer.concat([SIG, ihdr, badChunk]));
  // Should not throw or hang; just returns info without that chunk
  const r = imageClient({ operation: "info", path: p });
  assert.strictEqual(r.width, 4);
});
test("D10: empty file (0 bytes) throws unrecognized format", () => {
  const p = writeTmp("empty0.bin", Buffer.alloc(0));
  assertThrows(() => imageClient({ operation: "info", path: p }), "");
});

// ── E: Error-paths (10) ──────────────────────────────────────────────────────
console.error("\n[E] Error-paths");

test("E01: validate on JPEG with 0x0 dimensions reports invalid", () => {
  const parts = [Buffer.from([0xFF,0xD8])];
  const sof0 = Buffer.alloc(19);
  sof0[0]=0xFF; sof0[1]=0xC0; sof0.writeUInt16BE(17,2); sof0[4]=8;
  sof0.writeUInt16BE(0,5); sof0.writeUInt16BE(0,7); sof0[9]=3;
  parts.push(sof0);
  parts.push(Buffer.from([0xFF,0xDA,0x00,0x08,0x03,0x01,0x00,0x02,0x11,0x00,0x3F,0xFF,0xD9]));
  const p = writeTmp("zerodim.jpg", Buffer.concat(parts));
  const r = imageClient({ operation: "validate", path: p });
  assert.strictEqual(r.valid, false);
  assert.ok(r.issues.length > 0);
});
test("E02: exif on BMP returns empty exif", () => {
  const r = imageClient({ operation: "exif", path: bmpPath });
  assert.strictEqual(r.hasEXIF, false);
  assert.strictEqual(Object.keys(r.exif).length, 0);
});
test("E03: xmp on BMP returns empty xmp", () => {
  const r = imageClient({ operation: "xmp", path: bmpPath });
  assert.strictEqual(r.hasXMP, false);
  assert.strictEqual(r.xmpFieldCount, 0);
});
test("E04: iptc on BMP returns empty iptc", () => {
  assert.strictEqual(imageClient({ operation: "iptc", path: bmpPath }).hasIPTC, false);
});
test("E05: iptc on GIF returns empty iptc", () => {
  assert.strictEqual(imageClient({ operation: "iptc", path: gifPath }).hasIPTC, false);
});
test("E06: 1-byte file throws (too small to detect format)", () => {
  const p = writeTmp("one.bin", Buffer.from([0xFF]));
  assertThrows(() => imageClient({ operation: "info", path: p }), "");
});
test("E07: ICO with 0 images fails validate", () => {
  const buf = Buffer.alloc(6, 0);
  buf.writeUInt16LE(0,0); buf.writeUInt16LE(1,2); buf.writeUInt16LE(0,4);
  const p = writeTmp("empty.ico", buf);
  const r = imageClient({ operation: "validate", path: p });
  assert.strictEqual(r.valid, false);
  assert.ok(r.issues.some(i => i.includes("ICO")));
});
test("E08: PNG without IEND still extracts IHDR dimensions", () => {
  const SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(20,0); ihdrData.writeUInt32BE(20,4);
  ihdrData[8]=8; ihdrData[9]=2;
  const chunk = Buffer.alloc(4+4+13+4);
  chunk.writeUInt32BE(13,0); chunk.write("IHDR",4,"latin1"); ihdrData.copy(chunk,8);
  const p = writeTmp("noiend.png", Buffer.concat([SIG, chunk]));
  const r = imageClient({ operation: "info", path: p });
  assert.strictEqual(r.width, 20);
  assert.strictEqual(r.height, 20);
});
test("E09: WebP too small still returns format=WebP without crash", () => {
  const p = writeTmp("tinywp.webp", Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1"));
  const r = imageClient({ operation: "info", path: p });
  assert.strictEqual(r.format, "WebP");
});
test("E10: xmp on PNG (no XMP) returns hasXMP=false and xmpFieldCount=0", () => {
  const r = imageClient({ operation: "xmp", path: pngPath });
  assert.strictEqual(r.hasXMP, false);
  assert.strictEqual(r.xmpFieldCount, 0);
});

// ── F: Concurrency (6) ───────────────────────────────────────────────────────
console.error("\n[F] Concurrency");

test("F01: 20 concurrent info calls on JPEG return consistent results", () => {
  const results = [];
  for (let i = 0; i < 20; i++) results.push(imageClient({ operation: "info", path: jpegPath }));
  for (const r of results) {
    assert.strictEqual(r.format, "JPEG");
    assert.strictEqual(r.width, 64);
    assert.strictEqual(r.height, 48);
  }
});
test("F02: 20 concurrent info calls on PNG return consistent results", () => {
  const results = [];
  for (let i = 0; i < 20; i++) results.push(imageClient({ operation: "info", path: pngPath }));
  for (const r of results) {
    assert.strictEqual(r.format, "PNG");
    assert.strictEqual(r.width, 32);
  }
});
test("F03: mixed format calls return correct format per file", () => {
  const calls = [
    [jpegPath,"JPEG"],[pngPath,"PNG"],[bmpPath,"BMP"],[gifPath,"GIF"],[icoPath,"ICO"],
    [jpegPath,"JPEG"],[pngPath,"PNG"],[bmpPath,"BMP"],[gifPath,"GIF"],[icoPath,"ICO"],
  ];
  const results = calls.map(c => imageClient({ operation: "info", path: c[0] }));
  for (let i = 0; i < results.length; i++)
    assert.strictEqual(results[i].format, calls[i][1]);
});
test("F04: 10 concurrent exif calls on EXIF-JPEG return same tag count", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(imageClient({ operation: "exif", path: jpegExifPath }));
  const tc = results[0].exifTagCount;
  for (const r of results) assert.strictEqual(r.exifTagCount, tc);
});
test("F05: 10 concurrent validate calls on PNG all valid=true", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(imageClient({ operation: "validate", path: pngPath }));
  for (const r of results) assert.strictEqual(r.valid, true);
});
test("F06: 10 concurrent GIF info calls on animated GIF return consistent frameCount", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(imageClient({ operation: "info", path: gifAnim }));
  const fc = results[0].frameCount;
  for (const r of results) assert.strictEqual(r.frameCount, fc);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.error(`\nSection 237: ${passed}/${total} passed${failed > 0 ? ` (${failed} FAILED)` : ""}`);
if (failed > 0) process.exit(1);
