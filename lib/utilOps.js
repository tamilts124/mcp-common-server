"use strict";
// ── UTILITY OPERATIONS ──────────────────────────────────────────────────────
// file_checksum  — MD5 / SHA-1 / SHA-256 / SHA-512 digest of a file
// zip_directory  — archive a directory subtree to a .zip file (pure Node, no deps)
// query_json     — parse a JSON file and extract a value by dot-path
// query_data     — parse a JSON *or* YAML file (by extension) and extract a
//                  value by dot-path; YAML parsing is handled by ./yamlOps.js

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const zlib   = require("zlib");
const { parseYaml } = require("./yamlOps");

// ── FILE CHECKSUM ────────────────────────────────────────────────────────────
/**
 * Compute a cryptographic digest of a file.
 * @param {string} filePath  Absolute filesystem path to the file.
 * @param {string} algorithm "md5" | "sha1" | "sha256" | "sha512"  (default "sha256")
 * @returns {{ algorithm: string, hex: string, sizeBytes: number }}
 */
function fileChecksum(filePath, algorithm) {
  const algo = (algorithm || "sha256").toLowerCase();
  const allowed = ["md5", "sha1", "sha256", "sha512"];
  if (!allowed.includes(algo))
    throw new Error(`Unsupported algorithm '${algorithm}'. Choose one of: ${allowed.join(", ")}.`);

  const data  = fs.readFileSync(filePath);
  const hex   = crypto.createHash(algo).update(data).digest("hex");
  return { algorithm: algo, hex, sizeBytes: data.length };
}

// ── ZIP DIRECTORY ─────────────────────────────────────────────────────────────
// Pure-Node ZIP writer — no npm packages.
// Implements the minimal ZIP Local File Header + Central Directory + EOCD
// specification (PKWARE AppNote §4.3). Uses DEFLATE compression via zlib.

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
 */
function collectFiles(dir, base, acc) {
  acc = acc || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

// ── DOT-PATH TRAVERSAL (shared by query_json and query_data) ────────────────
/**
 * Walk a parsed object/array by a dot-notation path and return the resolved
 * value, its type, and the path itself. An empty path returns the root.
 *
 * Path syntax:
 *   - Dot-separated property names:  "a.b.c"
 *   - Array indices are supported:   "items.0.name"  (index 0 of array `items`)
 *   - Escaped dots use backslash:    "a\\.b" matches key "a.b"
 *
 * @param {any}    parsed  Already-parsed document (object, array, or scalar).
 * @param {string} query   Dot-path into the document (empty = root).
 * @returns {{ value: any, path: string, type: string }}
 */
function traverseByPath(parsed, query) {
  if (!query || query.trim() === "") {
    return { value: parsed, path: ".", type: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed };
  }

  // Split on unescaped dots
  const parts = query.split(/(?<!\\)\./).map(p => p.replace(/\\./g, "."));
  let cursor = parsed;
  for (const part of parts) {
    if (cursor === undefined || cursor === null || typeof cursor !== "object")
      throw new Error(`Path '${query}' does not exist in the document (stopped at '${part}').`);
    cursor = cursor[part];
  }

  const type = cursor === null ? "null" : Array.isArray(cursor) ? "array" : typeof cursor;
  return { value: cursor, path: query, type };
}

// ── QUERY JSON ───────────────────────────────────────────────────────────────
/**
 * Parse a JSON file and extract a value by dot-notation path.
 * An empty `query` returns the full parsed document.
 * Kept as a dedicated JSON-only entry point for backward compatibility —
 * see query_data for a format-detecting (JSON or YAML) version.
 *
 * @param {string} filePath  Absolute path to the JSON file.
 * @param {string} query     Dot-path into the parsed object (empty = root).
 * @returns {{ value: any, path: string, type: string }}
 */
function queryJson(filePath, query) {
  const raw    = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw); // throws SyntaxError for invalid JSON
  return traverseByPath(parsed, query);
}

// ── QUERY DATA (JSON or YAML, format detected by extension) ─────────────────
/**
 * Parse a JSON or YAML file (format chosen by file extension) and extract a
 * value by dot-notation path, using the same path syntax as queryJson.
 *
 * Supported extensions: .json -> JSON.parse; .yaml/.yml -> minimal YAML
 * parser (see lib/yamlOps.js for the supported subset and limitations).
 * An explicit `format` argument ("json" | "yaml") overrides extension
 * sniffing, for files with unconventional names/extensions.
 *
 * @param {string} filePath  Absolute path to the file to parse.
 * @param {string} query     Dot-path into the parsed object (empty = root).
 * @param {string} [format]  Optional explicit format override.
 * @returns {{ value: any, path: string, type: string, format: string }}
 */
function queryData(filePath, query, format) {
  const ext = path.extname(filePath).toLowerCase();
  const resolvedFormat = (format || "").toLowerCase() ||
    (ext === ".yaml" || ext === ".yml" ? "yaml" : "json");

  if (resolvedFormat !== "json" && resolvedFormat !== "yaml")
    throw new Error(`Unsupported format '${format}'. Choose 'json' or 'yaml', or omit to detect from the file extension.`);

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = resolvedFormat === "yaml" ? parseYaml(raw) : JSON.parse(raw);
  return { ...traverseByPath(parsed, query), format: resolvedFormat };
}

module.exports = { fileChecksum, zipDirectory, queryJson, queryData };
