"use strict";
// ── IMAGE OPERATIONS ──────────────────────────────────────────────────────────────────────
// Zero-dependency image utility.
// imageInfo   — reads format + dimensions from PNG/JPEG/GIF/BMP/WEBP magic bytes.
// imagePngResize / imagePngCrop / imagePngRotate / imagePngFlip / imagePngGrayscale
//             — decode PNG → pixel ops → re-encode PNG (bilinear resize; exact crop
//               / rotate / flip / luminance grayscale).  Alpha channel preserved.
// Depends on imageDecodeOps.js (PNG full decode, JPEG header-only read)
// and pngEncodeOps.js (RGB + gray PNG writer) — both zero-dep.

const zlib = require("zlib");
const { readJpegInfo, decodePng } = require("./imageDecodeOps");
const { encodePng } = require("./pngEncodeOps");
const { ToolError } = require("./errors");

const MAX_IMAGE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB file read cap
const MAX_DIM             = 16_000;            // max output dimension (pixels)
const MAX_OUT_PIXELS      = 100_000_000;       // 100 MP output cap

// ── Format detection ────────────────────────────────────────────────────────────────────

function detectImageFormat(buf) {
  if (buf.length >= 8 &&
      buf.readUInt32BE(0) === 0x89504e47 &&
      buf.readUInt32BE(4) === 0x0d0a1a0a) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 6).startsWith("GIF8")) return "gif";
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  if (buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "unknown";
}

// ── Image info (header-only, no pixel decode) ───────────────────────────────────────

function imageInfo(buf) {
  const format = detectImageFormat(buf);

  switch (format) {
    case "png": {
      if (buf.length < 33)
        throw new ToolError("image_ops: PNG file too small to contain IHDR chunk.", -32602);
      const width     = buf.readUInt32BE(16);
      const height    = buf.readUInt32BE(20);
      const bitDepth  = buf[24];
      const colorType = buf[25];
      const interlaced = buf[28] !== 0;
      const chanMap   = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      const channels  = chanMap[colorType] ?? 1;
      const hasAlpha  = (colorType === 4 || colorType === 6);
      return { format: "png", width, height, bitDepth, colorType, channels, hasAlpha, interlaced, fileSizeBytes: buf.length };
    }
    case "jpeg": {
      const { width, height, components } = readJpegInfo(buf);
      return { format: "jpeg", width, height, bitDepth: 8, channels: components, hasAlpha: false, fileSizeBytes: buf.length };
    }
    case "gif": {
      if (buf.length < 10) throw new ToolError("image_ops: GIF file too small.", -32602);
      const version = buf.toString("ascii", 0, 6);
      const width   = buf.readUInt16LE(6);
      const height  = buf.readUInt16LE(8);
      return { format: "gif", version, width, height, bitDepth: 8, channels: 3, hasAlpha: true, fileSizeBytes: buf.length };
    }
    case "bmp": {
      if (buf.length < 26) throw new ToolError("image_ops: BMP file too small.", -32602);
      const infoSize = buf.readUInt32LE(14);
      let   w, h, bpp;
      if (infoSize >= 40) {
        w   = Math.abs(buf.readInt32LE(18));
        h   = Math.abs(buf.readInt32LE(22));
        bpp = buf.readUInt16LE(28);
      } else {
        w   = buf.readUInt16LE(18);
        h   = buf.readUInt16LE(20);
        bpp = buf.readUInt16LE(24);
      }
      const hasAlpha = bpp === 32;
      return { format: "bmp", width: w, height: h, bitDepth: bpp,
               channels: bpp <= 8 ? 1 : bpp === 24 ? 3 : 4, hasAlpha, fileSizeBytes: buf.length };
    }
    case "webp": {
      if (buf.length < 30) throw new ToolError("image_ops: WEBP file too small.", -32602);
      const chunk = buf.toString("ascii", 12, 16);
      let   w = 0, h = 0, hasAlpha = false;
      if (chunk === "VP8 " && buf.length >= 30 &&
          buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
        w = buf.readUInt16LE(26) & 0x3fff;
        h = buf.readUInt16LE(28) & 0x3fff;
      } else if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
        const bits = buf.readUInt32LE(21);
        w        = (bits & 0x3fff) + 1;
        h        = ((bits >> 14) & 0x3fff) + 1;
        hasAlpha = ((bits >> 28) & 1) === 1;
      } else if (chunk === "VP8X" && buf.length >= 30) {
        hasAlpha = (buf[20] & 0x10) !== 0;
        w        = buf.readUIntLE(24, 3) + 1;
        h        = buf.readUIntLE(27, 3) + 1;
      }
      return { format: "webp", width: w, height: h, bitDepth: 8,
               channels: hasAlpha ? 4 : 3, hasAlpha, fileSizeBytes: buf.length };
    }
    default:
      throw new ToolError("image_ops: unrecognised image format (expected PNG, JPEG, GIF, BMP, or WEBP).", -32602);
  }
}

// ── RGBA PNG encoder (adds colorType 6 to pngEncodeOps.js's RGB/gray) ────────────

const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function _crc32(buf) {
  let v = 0xffffffff;
  for (let i = 0; i < buf.length; i++) v = (v >>> 8) ^ _CRC_TABLE[(v ^ buf[i]) & 0xff];
  return (v ^ 0xffffffff) >>> 0;
}

function _pngChunk(type, data) {
  const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const cb = Buffer.alloc(4); cb.writeUInt32BE(_crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([lb, tb, data, cb]);
}

function _encodeRgbaPng(width, height, rgb, alpha) {
  const stride = width * 4;
  const ihdr   = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 3;
      const di = y * (1 + stride) + 1 + x * 4;
      raw[di]     = rgb[si];
      raw[di + 1] = rgb[si + 1];
      raw[di + 2] = rgb[si + 2];
      raw[di + 3] = alpha[y * width + x];
    }
  }
  const idat = zlib.deflateSync(raw);
  const SIG  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([SIG, _pngChunk("IHDR", ihdr), _pngChunk("IDAT", idat), _pngChunk("IEND", Buffer.alloc(0))]);
}

function _encodeOutput(w, h, rgb, alpha) {
  return alpha ? _encodeRgbaPng(w, h, rgb, alpha) : encodePng(w, h, rgb, 3);
}

// ── Bilinear resize ────────────────────────────────────────────────────────────────────────

function _bilinear(rgb, alpha, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 3);
  const oa  = alpha ? Buffer.alloc(dstW * dstH) : null;
  const xR  = srcW / dstW;
  const yR  = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const gy = Math.max(0, (dy + 0.5) * yR - 0.5);
    const y0 = Math.min(srcH - 1, Math.floor(gy));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const yd = gy - y0;
    for (let dx = 0; dx < dstW; dx++) {
      const gx = Math.max(0, (dx + 0.5) * xR - 0.5);
      const x0 = Math.min(srcW - 1, Math.floor(gx));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const xd = gx - x0;
      const di = (dy * dstW + dx) * 3;
      for (let c = 0; c < 3; c++) {
        const tl = rgb[(y0 * srcW + x0) * 3 + c];
        const tr = rgb[(y0 * srcW + x1) * 3 + c];
        const bl = rgb[(y1 * srcW + x0) * 3 + c];
        const br = rgb[(y1 * srcW + x1) * 3 + c];
        const top = tl + (tr - tl) * xd;
        const bot = bl + (br - bl) * xd;
        out[di + c] = Math.round(top + (bot - top) * yd) & 0xff;
      }
      if (oa) {
        const tl = alpha[y0 * srcW + x0];
        const tr = alpha[y0 * srcW + x1];
        const bl = alpha[y1 * srcW + x0];
        const br = alpha[y1 * srcW + x1];
        const top = tl + (tr - tl) * xd;
        const bot = bl + (br - bl) * xd;
        oa[dy * dstW + dx] = Math.round(top + (bot - top) * yd) & 0xff;
      }
    }
  }
  return { rgb: out, alpha: oa };
}

// ── Exported pixel operations (PNG in → PNG out) ─────────────────────────────────────

function _requirePng(srcBuf, op) {
  const fmt = detectImageFormat(srcBuf);
  if (fmt !== "png")
    throw new ToolError(
      `image_ops '${op}': only PNG input is supported for pixel operations (got ${fmt}). ` +
      "Use 'info' for non-PNG formats.", -32602);
  return decodePng(srcBuf); // { width, height, rgb, alpha }
}

// resize: bilinear interpolation, aspect-ratio control
function imagePngResize(srcBuf, opts = {}) {
  const { width: srcW, height: srcH, rgb, alpha } = _requirePng(srcBuf, "resize");
  let { width: dstW, height: dstH, keep_aspect } = opts;

  if (!dstW && !dstH)
    throw new ToolError("image_ops resize: provide at least 'width' or 'height'.", -32602);

  if (keep_aspect !== false) {
    // Maintain aspect ratio: fit within requested bounds
    if (dstW && !dstH) {
      dstH = Math.max(1, Math.round(srcH * (dstW / srcW)));
    } else if (dstH && !dstW) {
      dstW = Math.max(1, Math.round(srcW * (dstH / srcH)));
    } else {
      const scale = Math.min(dstW / srcW, dstH / srcH);
      dstW = Math.max(1, Math.round(srcW * scale));
      dstH = Math.max(1, Math.round(srcH * scale));
    }
  } else {
    if (!dstW) dstW = srcW;
    if (!dstH) dstH = srcH;
  }

  dstW = Math.min(MAX_DIM, Math.max(1, dstW));
  dstH = Math.min(MAX_DIM, Math.max(1, dstH));

  if (dstW * dstH > MAX_OUT_PIXELS)
    throw new ToolError(
      `image_ops resize: output ${dstW}×${dstH} exceeds ${MAX_OUT_PIXELS / 1e6}M pixel limit.`, -32602);

  if (dstW === srcW && dstH === srcH)
    return srcBuf; // no-op: return original unchanged

  const { rgb: outRgb, alpha: outAlpha } = _bilinear(rgb, alpha, srcW, srcH, dstW, dstH);
  return _encodeOutput(dstW, dstH, outRgb, outAlpha);
}

// crop: extract sub-rectangle
function imagePngCrop(srcBuf, opts = {}) {
  const { width: srcW, height: srcH, rgb, alpha } = _requirePng(srcBuf, "crop");
  const cx = opts.x          ?? 0;
  const cy = opts.y          ?? 0;
  const cw = opts.crop_width  ?? (srcW - cx);
  const ch = opts.crop_height ?? (srcH - cy);

  if (!Number.isInteger(cx) || !Number.isInteger(cy) || !Number.isInteger(cw) || !Number.isInteger(ch))
    throw new ToolError("image_ops crop: x, y, crop_width, crop_height must be integers.", -32602);
  if (cx < 0 || cy < 0)
    throw new ToolError("image_ops crop: x and y must be ≥ 0.", -32602);
  if (cw <= 0 || ch <= 0)
    throw new ToolError("image_ops crop: crop_width and crop_height must be > 0.", -32602);
  if (cx + cw > srcW || cy + ch > srcH)
    throw new ToolError(
      `image_ops crop: region (${cx},${cy}) ${cw}×${ch} exceeds source bounds ${srcW}×${srcH}.`, -32602);

  const outRgb   = Buffer.alloc(cw * ch * 3);
  const outAlpha = alpha ? Buffer.alloc(cw * ch) : null;
  for (let row = 0; row < ch; row++) {
    for (let col = 0; col < cw; col++) {
      const si = ((cy + row) * srcW + (cx + col)) * 3;
      const di = (row * cw + col) * 3;
      outRgb[di] = rgb[si]; outRgb[di + 1] = rgb[si + 1]; outRgb[di + 2] = rgb[si + 2];
      if (outAlpha) outAlpha[row * cw + col] = alpha[(cy + row) * srcW + (cx + col)];
    }
  }
  return _encodeOutput(cw, ch, outRgb, outAlpha);
}

// rotate: 90/180/270 clockwise (or 0 = no-op)
function imagePngRotate(srcBuf, opts = {}) {
  const { width: srcW, height: srcH, rgb, alpha } = _requirePng(srcBuf, "rotate");
  const deg = (((opts.degrees ?? 90) % 360) + 360) % 360;
  if (deg !== 0 && deg !== 90 && deg !== 180 && deg !== 270)
    throw new ToolError("image_ops rotate: degrees must be 0, 90, 180, or 270.", -32602);

  if (deg === 0) return srcBuf;

  const outW = (deg === 90 || deg === 270) ? srcH : srcW;
  const outH = (deg === 90 || deg === 270) ? srcW : srcH;
  const outRgb   = Buffer.alloc(outW * outH * 3);
  const outAlpha = alpha ? Buffer.alloc(outW * outH) : null;

  for (let sy = 0; sy < srcH; sy++) {
    for (let sx = 0; sx < srcW; sx++) {
      let dx, dy;
      if      (deg === 90)  { dx = srcH - 1 - sy; dy = sx; }          // 90° CW
      else if (deg === 180) { dx = srcW - 1 - sx; dy = srcH - 1 - sy; } // 180°
      else                  { dx = sy;             dy = srcW - 1 - sx; } // 270° CW

      const si = (sy * srcW + sx) * 3;
      const di = (dy * outW + dx) * 3;
      outRgb[di] = rgb[si]; outRgb[di + 1] = rgb[si + 1]; outRgb[di + 2] = rgb[si + 2];
      if (outAlpha) outAlpha[dy * outW + dx] = alpha[sy * srcW + sx];
    }
  }
  return _encodeOutput(outW, outH, outRgb, outAlpha);
}

// flip: horizontal (mirror L-R) or vertical (mirror T-B)
function imagePngFlip(srcBuf, opts = {}) {
  const { width: srcW, height: srcH, rgb, alpha } = _requirePng(srcBuf, "flip");
  const axis = opts.axis ?? "horizontal";
  if (axis !== "horizontal" && axis !== "vertical")
    throw new ToolError("image_ops flip: axis must be 'horizontal' or 'vertical'.", -32602);

  const outRgb   = Buffer.alloc(srcW * srcH * 3);
  const outAlpha = alpha ? Buffer.alloc(srcW * srcH) : null;

  for (let sy = 0; sy < srcH; sy++) {
    for (let sx = 0; sx < srcW; sx++) {
      const dx = axis === "horizontal" ? srcW - 1 - sx : sx;
      const dy = axis === "vertical"   ? srcH - 1 - sy : sy;
      const si = (sy * srcW + sx) * 3;
      const di = (dy * srcW + dx) * 3;
      outRgb[di] = rgb[si]; outRgb[di + 1] = rgb[si + 1]; outRgb[di + 2] = rgb[si + 2];
      if (outAlpha) outAlpha[dy * srcW + dx] = alpha[sy * srcW + sx];
    }
  }
  return _encodeOutput(srcW, srcH, outRgb, outAlpha);
}

// grayscale: ITU-R BT.709 luminance (0.2126R + 0.7152G + 0.0722B)
function imagePngGrayscale(srcBuf) {
  const { width: srcW, height: srcH, rgb, alpha } = _requirePng(srcBuf, "grayscale");
  const outRgb   = Buffer.alloc(srcW * srcH * 3);
  const outAlpha = alpha ? Buffer.alloc(srcW * srcH) : null;

  for (let i = 0; i < srcW * srcH; i++) {
    const gray = Math.round(0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2]) & 0xff;
    outRgb[i * 3] = outRgb[i * 3 + 1] = outRgb[i * 3 + 2] = gray;
    if (outAlpha) outAlpha[i] = alpha[i];
  }
  return _encodeOutput(srcW, srcH, outRgb, outAlpha);
}

module.exports = {
  MAX_IMAGE_FILE_SIZE,
  detectImageFormat,
  imageInfo,
  imagePngResize,
  imagePngCrop,
  imagePngRotate,
  imagePngFlip,
  imagePngGrayscale,
};
