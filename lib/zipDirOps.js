"use strict";
// ── ZIP DIRECTORY ────────────────────────────────────────────────────
// Pure-Node ZIP writer — no npm packages.
// Implements the minimal ZIP Local File Header + Central Directory + EOCD
// specification (PKWARE AppNote §4.3). Uses DEFLATE compression via zlib.
// Companion to lib/unzipOps.js (the extraction side).

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { isIgnored } = require("./roots");

/** Write a 16-bit unsigned integer little-endian into a buffer at offset. */
function writeUInt16LE(buf, val, offset) {
  buf[offset]     = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
}
/** Write a 32-bit unsigned integer little-endian into a buffer at offset. */
function writeUInt32LE(buf, val, offset) {
  buf[offset]     = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
  buf[offset + 3] = (val >> 24) & 0xff;
}

/**
 * Build a Local File Header + deflated data block.
 * Returns { headerAndData: Buffer, crc32: number, compressedSize: number, uncompressedSize: number }
 */
function buildLocalEntry(entryName, fileData) {
  const nameBytes    = Buffer.from(entryName, "utf8");
  const uncompressed = fileData.length;
  // Deflate (raw, no zlib wrapper) — method 8 in ZIP spec.
  const deflated     = zlib.deflateRawSync(fileData, { level: 6 });
  const compressed   = deflated.length;
  const crc          = crc32(fileData);

  // Local file header (30 bytes) + name + compressed data
  const lhSize = 30 + nameBytes.length;
  const header = Buffer.alloc(lhSize, 0);
  writeUInt32LE(header, 0x04034b50, 0);  // Local file header signature
  writeUInt16LE(header, 20,          4);  // Version needed (2.0)
  writeUInt16LE(header, 0x0800,      6);  // General purpose bit flag (UTF-8 name)
  writeUInt16LE(header, 8,           8);  // Compression method (DEFLATE)
  writeUInt16LE(header, 0,          10);  // Last mod file time
  writeUInt16LE(header, 0,          12);  // Last mod file date
  writeUInt32LE(header, crc,        14);  // CRC-32
  writeUInt32LE(header, compressed, 18);  // Compressed size
  writeUInt32LE(header, uncompressed, 22); // Uncompressed size
  writeUInt16LE(header, nameBytes.length, 26); // File name length
  writeUInt16LE(header, 0,          28);  // Extra field length
  nameBytes.copy(header, 30);

  return {
    headerAndData: Buffer.concat([header, deflated]),
    crc32: crc,
    compressedSize: compressed,
    uncompressedSize: uncompressed,
  };
}

/**
 * Build a Central Directory record for one entry.
 */
function buildCentralDirEntry(entryName, crc, compressedSize, uncompressedSize, localHeaderOffset) {
  const nameBytes = Buffer.from(entryName, "utf8");
  const cdSize    = 46 + nameBytes.length;
  const cd        = Buffer.alloc(cdSize, 0);
  writeUInt32LE(cd, 0x02014b50,        0);  // Central dir signature
  writeUInt16LE(cd, 20,                4);  // Version made by
  writeUInt16LE(cd, 20,                6);  // Version needed
  writeUInt16LE(cd, 0x0800,            8);  // General purpose bit flag (UTF-8)
  writeUInt16LE(cd, 8,                10);  // Compression method
  writeUInt16LE(cd, 0,                12);  // Last mod time
  writeUInt16LE(cd, 0,                14);  // Last mod date
  writeUInt32LE(cd, crc,              16);  // CRC-32
  writeUInt32LE(cd, compressedSize,   20);  // Compressed size
  writeUInt32LE(cd, uncompressedSize, 24);  // Uncompressed size
  writeUInt16LE(cd, nameBytes.length, 28);  // File name length
  writeUInt16LE(cd, 0,                30);  // Extra field length
  writeUInt16LE(cd, 0,                32);  // File comment length
  writeUInt16LE(cd, 0,                34);  // Disk number start
  writeUInt16LE(cd, 0,                36);  // Internal file attributes
  writeUInt32LE(cd, 0,                38);  // External file attributes
  writeUInt32LE(cd, localHeaderOffset, 42); // Relative offset of local header
  nameBytes.copy(cd, 46);
  return cd;
}

/**
 * Build the End-of-Central-Directory record.
 */
function buildEOCD(entryCount, centralDirSize, centralDirOffset) {
  const eocd = Buffer.alloc(22, 0);
  writeUInt32LE(eocd, 0x06054b50,      0);  // EOCD signature
  writeUInt16LE(eocd, 0,               4);  // Disk number
  writeUInt16LE(eocd, 0,               6);  // Disk with start of CD
  writeUInt16LE(eocd, entryCount,      8);  // Entries on this disk
  writeUInt16LE(eocd, entryCount,     10);  // Total entries
  writeUInt32LE(eocd, centralDirSize, 12);  // Central directory size
  writeUInt32LE(eocd, centralDirOffset, 16); // CD offset
  writeUInt16LE(eocd, 0,              20);  // Comment length
  return eocd;
}

// CRC-32 lookup table (generated once at module load)
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
  for (let i = 0; i < buf.length; i++)
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Recursively collect all files under `dir`, returning { absPath, relPath } pairs.
 * Excludes directories from the list (they're represented by their contents).
 * Skips any entry matched by the server's MCP_IGNORE patterns (e.g.
 * node_modules, .git, dist, build) -- same convention every other
 * directory-walking tool in this codebase follows (file_stats,
 * dir_size_stats, hash_directory, find_duplicates, compare_directories,
 * move_directory, etc.), so a zip_directory over a project root doesn't
 * silently bundle build artefacts or version-control internals.
 */
function collectFiles(dir, base, acc) {
  acc = acc || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isIgnored(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectFiles(abs, rel, acc);
    } else if (entry.isFile()) {
      acc.push({ absPath: abs, relPath: rel });
    }
  }
  return acc;
}

/**
 * Archive a directory to a ZIP file.
 * @param {string} srcDir   Absolute path to the directory to zip.
 * @param {string} destZip  Absolute path for the output .zip file.
 * @returns {{ zipPath: string, filesArchived: number, sizeBytes: number }}
 */
function zipDirectory(srcDir, destZip) {
  const files = collectFiles(srcDir, "", []);
  const localBlocks  = [];
  const centralDirs  = [];
  let   offset       = 0;

  for (const { absPath, relPath } of files) {
    const data  = fs.readFileSync(absPath);
    const entry = buildLocalEntry(relPath, data);
    const cd    = buildCentralDirEntry(
      relPath,
      entry.crc32,
      entry.compressedSize,
      entry.uncompressedSize,
      offset,
    );
    localBlocks.push(entry.headerAndData);
    centralDirs.push(cd);
    offset += entry.headerAndData.length;
  }

  const cdBuffer   = Buffer.concat(centralDirs);
  const eocd       = buildEOCD(files.length, cdBuffer.length, offset);
  const zipBuffer  = Buffer.concat([...localBlocks, cdBuffer, eocd]);

  fs.writeFileSync(destZip, zipBuffer);
  return { zipPath: destZip, filesArchived: files.length, sizeBytes: zipBuffer.length };
}

module.exports = { zipDirectory, collectFiles, crc32 };
