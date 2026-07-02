"use strict";
// ── GZIP COMPRESS / DECOMPRESS ─────────────────────────────────────────────────
// gzip_compress   — gzip a source file, write the result to a destination.
// gzip_decompress — gunzip a source file, write the result to a destination.
//
// Both zero-dependency, using Node's built-in zlib (sync API). Both are
// write-capable (they always write a destination file), so both are
// write-gated in WRITE_TOOLS, unlike base64_encode which is read-only.

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");

/**
 * Gzip-compress a file.
 *
 * @param {string} absPath   Absolute source path (jail-validated by caller).
 * @param {string} origPath  Client source path (echoed back).
 * @param {string} absDest   Absolute destination path (jail-validated by caller).
 * @param {string} origDest  Client destination path (echoed back).
 * @param {object} [opts]
 * @param {number} [opts.level]  zlib compression level 0-9 (default: 6).
 * @returns {{ source: string, destination: string, originalBytes: number, compressedBytes: number, ratio: number }}
 */
function gzipCompress(absPath, origPath, absDest, origDest, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new Error(`gzip_compress: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isFile())
    throw new Error(`gzip_compress: '${origPath}' is not a regular file.`);

  let level = opts.level != null ? Math.trunc(opts.level) : zlib.constants.Z_DEFAULT_COMPRESSION;
  if (opts.level != null && (!Number.isFinite(level) || level < 0 || level > 9))
    throw new Error(`gzip_compress: 'level' must be an integer between 0 and 9.`);

  const input = fs.readFileSync(absPath);
  let compressed;
  try {
    compressed = zlib.gzipSync(input, { level });
  } catch (e) {
    throw new Error(`gzip_compress: compression failed: ${e.message}`);
  }

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, compressed);
  } catch (e) {
    throw new Error(`gzip_compress: cannot write to '${origDest}': ${e.message}`);
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
 * Gunzip-decompress a file.
 *
 * @param {string} absPath   Absolute source (.gz) path (jail-validated by caller).
 * @param {string} origPath  Client source path (echoed back).
 * @param {string} absDest   Absolute destination path (jail-validated by caller).
 * @param {string} origDest  Client destination path (echoed back).
 * @returns {{ source: string, destination: string, compressedBytes: number, decompressedBytes: number }}
 */
function gzipDecompress(absPath, origPath, absDest, origDest) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new Error(`gzip_decompress: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isFile())
    throw new Error(`gzip_decompress: '${origPath}' is not a regular file.`);

  const input = fs.readFileSync(absPath);
  let decompressed;
  try {
    decompressed = zlib.gunzipSync(input);
  } catch (e) {
    throw new Error(`gzip_decompress: '${origPath}' is not valid gzip data: ${e.message}`);
  }

  try {
    fs.mkdirSync(path.dirname(absDest), { recursive: true });
    fs.writeFileSync(absDest, decompressed);
  } catch (e) {
    throw new Error(`gzip_decompress: cannot write to '${origDest}': ${e.message}`);
  }

  return {
    source:              origPath,
    destination:         origDest,
    compressedBytes:     input.length,
    decompressedBytes:   decompressed.length,
  };
}

module.exports = { gzipCompress, gzipDecompress };
