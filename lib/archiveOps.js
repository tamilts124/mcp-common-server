"use strict";
// ── ARCHIVE OPERATIONS ────────────────────────────────────────────────────────
// read_archive — inspect the contents of a ZIP file without extracting it.
//
// Reads the ZIP Central Directory (the canonical index at the end of the file)
// to list all entries with their paths, sizes, compression method, CRC-32, and
// last-modified timestamps. Zero npm dependencies — pure Node.js built-ins only.
//
// ZIP specification reference: PKWARE APPNOTE.TXT §4.3
//   End-of-Central-Directory (EOCD) record:  signature 0x06054b50
//   Central Directory File Header (CDFH):    signature 0x02014b50

const fs   = require("fs");

// Compression method codes used in the ZIP spec
const COMPRESSION_NAMES = {
  0:  "stored",
  8:  "deflate",
  9:  "deflate64",
  12: "bzip2",
  14: "lzma",
  20: "zstd",
  93: "zstd",
  99: "aes",
};

/**
 * Read a ZIP file's central directory and return a structured manifest.
 *
 * @param {string} zipPath  Absolute path to the .zip file.
 * @returns {{
 *   zipPath:    string,          // echoed back
 *   fileCount:  number,          // total entries (includes directories)
 *   totalUncompressedBytes: number,
 *   totalCompressedBytes:   number,
 *   entries: Array<{
 *     name:              string,   // entry path/name inside the ZIP
 *     isDirectory:       boolean,
 *     size:              number,   // uncompressed size in bytes
 *     compressedSize:    number,   // compressed size in bytes
 *     compressionMethod: string,   // 'stored', 'deflate', etc.
 *     crc32:             number,
 *     lastModified:      string,   // ISO 8601 date string (from DOS timestamp)
 *   }>
 * }}
 */
function readArchive(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const len = buf.length;

  // ── 1. Locate the End-of-Central-Directory (EOCD) record ─────────────────
  // EOCD is variable-length but has a fixed 4-byte signature (0x06054b50).
  // It sits at the end of the file, possibly followed by a ZIP comment.
  // Maximum comment length is 65535 bytes, so EOCD is within last 65535+22 bytes.
  const EOCD_SIG      = 0x06054b50;
  const EOCD_MIN_SIZE = 22;
  const searchStart   = Math.max(0, len - 65535 - EOCD_MIN_SIZE);

  let eocdOffset = -1;
  for (let i = len - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error("read_archive: not a valid ZIP file (EOCD record not found).");
  }

  // EOCD layout:
  //   +0  4  signature
  //   +4  2  disk number
  //   +6  2  disk with start of CD
  //   +8  2  entries on this disk
  //   +10 2  total entries
  //   +12 4  size of central directory
  //   +16 4  offset of central directory (from start of first disk)
  //   +20 2  comment length
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset  = buf.readUInt32LE(eocdOffset + 16);

  // ── 2. Walk the Central Directory File Headers ────────────────────────────
  const CDFH_SIG = 0x02014b50;
  const entries  = [];
  let   pos      = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (pos + 46 > len) break; // truncated/corrupt ZIP
    if (buf.readUInt32LE(pos) !== CDFH_SIG) break;

    // Central Directory File Header layout:
    //   +0  4  signature
    //   +4  2  version made by
    //   +6  2  version needed to extract
    //   +8  2  general purpose bit flag
    //   +10 2  compression method
    //   +12 2  last mod file time (DOS)
    //   +14 2  last mod file date (DOS)
    //   +16 4  crc-32
    //   +20 4  compressed size
    //   +24 4  uncompressed size
    //   +28 2  file name length
    //   +30 2  extra field length
    //   +32 2  file comment length
    //   +34 2  disk number start
    //   +36 2  internal file attributes
    //   +38 4  external file attributes
    //   +42 4  relative offset of local header
    //   +46     file name (variable)
    //   +46+fn  extra field (variable)
    //   +46+fn+ef  file comment (variable)

    const method          = buf.readUInt16LE(pos + 10);
    const modTime         = buf.readUInt16LE(pos + 12);
    const modDate         = buf.readUInt16LE(pos + 14);
    const crc32           = buf.readUInt32LE(pos + 16);
    const compressedSize  = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const fnLen           = buf.readUInt16LE(pos + 28);
    const efLen           = buf.readUInt16LE(pos + 30);
    const fcLen           = buf.readUInt16LE(pos + 32);

    const name = buf.toString("utf8", pos + 46, pos + 46 + fnLen);

    // Convert DOS date/time to ISO 8601
    // DOS date: bits 15-9 = year-1980, bits 8-5 = month, bits 4-0 = day
    // DOS time: bits 15-11 = hours, bits 10-5 = minutes, bits 4-0 = seconds/2
    const dosYear    = ((modDate >> 9) & 0x7f) + 1980;
    const dosMonth   = (modDate >> 5) & 0x0f;
    const dosDay     = modDate & 0x1f;
    const dosHour    = (modTime >> 11) & 0x1f;
    const dosMinute  = (modTime >> 5) & 0x3f;
    const dosSecond  = (modTime & 0x1f) * 2;
    const lastModified = new Date(
      Date.UTC(dosYear, dosMonth - 1, dosDay, dosHour, dosMinute, dosSecond)
    ).toISOString();

    const compressionMethod = COMPRESSION_NAMES[method] || `method-${method}`;
    const isDirectory = name.endsWith("/");

    entries.push({
      name,
      isDirectory,
      size:              uncompressedSize,
      compressedSize,
      compressionMethod,
      crc32,
      lastModified,
    });

    pos += 46 + fnLen + efLen + fcLen;
  }

  const totalUncompressedBytes = entries.reduce((s, e) => s + e.size, 0);
  const totalCompressedBytes   = entries.reduce((s, e) => s + e.compressedSize, 0);

  return {
    fileCount: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes,
    entries,
  };
}

module.exports = { readArchive };
