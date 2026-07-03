"use strict";
// ── Minimal zero-dependency PNG encoder ─────────────────────────────────────
// Used by pdfRichExtractOps.js to re-encode raw FlateDecode image-XObject
// sample data (PDFs store raw pixel samples, not PNG files) into an actual
// .png file docx media can embed. Mirrors imageDecodeOps.js's decodePng on
// the other conversion direction, but in reverse: encode, not decode.
// Supports only 8-bit DeviceRGB (colorType 2) / DeviceGray (colorType 0),
// non-interlaced, filter-type-0 (none) per scanline -- sufficient for the
// raw sample data a PDF image XObject provides, no palette/alpha here.

const zlib = require("zlib");

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

/**
 * Encode raw 8-bit interleaved samples (no filter bytes, no alpha) into a
 * valid non-interlaced PNG file.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} samples - width*height*components bytes, row-major
 * @param {number} components - 1 (gray) or 3 (RGB)
 */
function encodePng(width, height, samples, components) {
  const colorType = components === 1 ? 0 : 2;
  const stride = width * components;
  const expected = stride * height;
  if (samples.length < expected) throw new Error(`encodePng: sample buffer too short (need ${expected}, got ${samples.length})`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter type 0 (none)
    samples.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

module.exports = { encodePng, crc32 };
