"use strict";
// ── BROTLI COMPRESS / DECOMPRESS ───────────────────────────────────────────────
// brotli_compress   — brotli-compress a source file, write to a destination.
// brotli_decompress — brotli-decompress a source file, write to a destination.
//
// Zero-dependency, using Node's built-in zlib Brotli sync API. Both are
// write-capable (always write a destination file), so both are write-gated
// in WRITE_TOOLS, unlike base64_encode which is read-only. Mirrors
// lib/gzipOps.js's structure exactly.

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");

/**
 * Brotli-compress a file.
 *
 * @param {string} absPath   Absolute source path (jail-validated by caller).
 * @param {string} origPath  Client source path (echoed back).
 * @param {string} absDest   Absolute destination path (jail-validated by caller).
 * @param {string} origDest  Client destination path (echoed back).
 * @param {object} [opts]
 * @param {number} [opts.quality]  Brotli quality 0-11 (default: 11, zlib's BROTLI_DEFAULT_QUALITY).
 * @returns {{ source: string, destination: string, originalBytes: number, compressedBytes: number, ratio: number }}
 */
function brotliCompress(absPath, origPath, absDest, origDest, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new Error(`brotli_compress: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isFile())
    throw new Error(`brotli_compress: '${origPath}' is not a regular file.`);

  let quality = opts.quality != null ? Math.trunc(opts.quality) : zlib.constants.BROTLI_DEFAULT_QUALITY;
  if (opts.quality != null && (!Number.isFinite(quality) || quality < 0 || quality > 11))
    throw new Error(`brotli_compress: 'quality' must be an integer between 0 and 11.`);

  const input = fs.readFileSync(absPath);
  let compressed;
  try {
    compressed = zlib.brotliCompressSync(input, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
      },
    });
  } catch (e) {
    throw new Error(`brotli_compress: compression failed: ${e.message}`);
  }

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, compressed);
  } catch (e) {
    throw new Error(`brotli_compress: cannot write to '${origDest}': ${e.message}`);
  }

  return {
    source:            origPath,
    destination:       origDest,
    originalBytes:     input.length,
    compressedBytes:   compressed.length,
    ratio:             input.length === 0 ? 0 : Number((compressed.length / input.length).toFixed(4)),
  };
}

/**
 * Brotli-decompress a file.
 *
 * @param {string} absPath   Absolute source (.br) path (jail-validated by caller).
 * @param {string} origPath  Client source path (echoed back).
 * @param {string} absDest   Absolute destination path (jail-validated by caller).
 * @param {string} origDest  Client destination path (echoed back).
 * @returns {{ source: string, destination: string, compressedBytes: number, decompressedBytes: number }}
 */
function brotliDecompress(absPath, origPath, absDest, origDest) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new Error(`brotli_decompress: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isFile())
    throw new Error(`brotli_decompress: '${origPath}' is not a regular file.`);

  const input = fs.readFileSync(absPath);
  let decompressed;
  try {
    decompressed = zlib.brotliDecompressSync(input);
  } catch (e) {
    throw new Error(`brotli_decompress: '${origPath}' is not valid brotli data: ${e.message}`);
  }

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, decompressed);
  } catch (e) {
    throw new Error(`brotli_decompress: cannot write to '${origDest}': ${e.message}`);
  }

  return {
    source:              origPath,
    destination:         origDest,
    compressedBytes:     input.length,
    decompressedBytes:   decompressed.length,
  };
}

module.exports = { brotliCompress, brotliDecompress };
