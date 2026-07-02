"use strict";
// ── IMAGE DECODING ───────────────────────────────────────────────────────────
// Extracted from lib/docxToPdfOps.js (which had grown past the 500-line
// threshold). Zero-dependency JPEG dimension reader (bytes are embedded as-is
// via PDF /DCTDecode, no decoding needed) and a hand-rolled PNG decoder
// (zlib-inflate IDAT, undo per-scanline filtering, normalize to 8-bit RGB(+A)).

const zlib = require("zlib");
const { ToolError } = require("./errors");

function detectImageKind(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  return "unsupported";
}

// JPEG: only need width/height/component-count for the PDF image dict --
// the compressed data is embedded byte-for-byte via /DCTDecode, no decoding.
function readJpegInfo(buf) {
  let offset = 2; // skip SOI (FFD8)
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9) break; // EOI
    const segLen = buf.readUInt16BE(offset + 2);
    // SOF0..SOF15 frame markers, excluding DHT(C4)/JPG(C8)/DAC(CC) which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width  = buf.readUInt16BE(offset + 7);
      const components = buf[offset + 9];
      return { width, height, components };
    }
    offset += 2 + segLen;
  }
  throw new ToolError("docx_to_pdf: could not read JPEG dimensions (no SOF marker found).", -32602);
}

// PNG: decode IHDR, concatenate+inflate IDAT, undo the per-scanline filter,
// then normalize every supported color type down to 8-bit RGB (+ a separate
// 8-bit grayscale alpha buffer for the PDF /SMask, if the source has alpha).
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new ToolError("docx_to_pdf: not a valid PNG (bad signature).", -32602);
  let pos = 8;
  let width, height, bitDepth, colorType, palette = null, trns = null;
  const idatChunks = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const dataStart = pos + 8;
    const data = buf.slice(dataStart, dataStart + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new ToolError("docx_to_pdf: interlaced PNGs are not supported.", -32602);
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos = dataStart + len + 4; // skip CRC
  }
  if (!width) throw new ToolError("docx_to_pdf: PNG missing IHDR chunk.", -32602);
  if (bitDepth !== 8) throw new ToolError(`docx_to_pdf: only 8-bit PNGs are supported (got ${bitDepth}-bit).`, -32602);

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (channels === undefined) throw new ToolError(`docx_to_pdf: unsupported PNG color type ${colorType}.`, -32602);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const unfiltered = Buffer.alloc(height * stride);

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  let srcPos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[srcPos++];
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[srcPos++];
      const a = x >= bytesPerPixel ? unfiltered[rowStart + x - bytesPerPixel] : 0;
      const b = y > 0 ? unfiltered[prevRowStart + x] : 0;
      const c = (y > 0 && x >= bytesPerPixel) ? unfiltered[prevRowStart + x - bytesPerPixel] : 0;
      let value;
      switch (filterType) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + Math.floor((a + b) / 2); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new ToolError(`docx_to_pdf: unsupported PNG filter type ${filterType}.`, -32602);
      }
      unfiltered[rowStart + x] = value & 0xff;
    }
  }

  const rgb = Buffer.alloc(width * height * 3);
  let alpha = null;
  if (colorType === 4 || colorType === 6) alpha = Buffer.alloc(width * height);

  for (let i = 0, px = 0; px < width * height; px++, i += bytesPerPixel) {
    let r, g, b, a = 255;
    if (colorType === 0) { r = g = b = unfiltered[i]; }
    else if (colorType === 2) { r = unfiltered[i]; g = unfiltered[i + 1]; b = unfiltered[i + 2]; }
    else if (colorType === 3) {
      const idx = unfiltered[i];
      r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    } else if (colorType === 4) { r = g = b = unfiltered[i]; a = unfiltered[i + 1]; }
    else if (colorType === 6) { r = unfiltered[i]; g = unfiltered[i + 1]; b = unfiltered[i + 2]; a = unfiltered[i + 3]; }
    rgb[px * 3] = r; rgb[px * 3 + 1] = g; rgb[px * 3 + 2] = b;
    if (alpha) alpha[px] = a;
  }

  return { width, height, rgb, alpha };
}

module.exports = { detectImageKind, readJpegInfo, decodePng };
