"use strict";
// ── UNZIP_ARCHIVE — extract a ZIP file's contents into a jailed directory ────
//
// Companion to zip_directory (lib/utilOps.js) and read_archive
// (lib/archiveOps.js): those tools can create and inspect ZIPs, but neither
// can extract one. This module reads the same ZIP Central Directory format
// as lib/archiveOps.js's read_archive (kept as a self-contained parser here
// rather than importing from archiveOps.js, since extraction additionally
// needs each entry's local-header offset — a field read_archive's public
// return shape intentionally omits — and duplicating ~40 lines of CD-walking
// logic avoids coupling two independently-tested modules).
//
// SECURITY — "Zip Slip": a malicious ZIP can contain an entry name like
// "../../etc/passwd" or an absolute path ("/etc/passwd", "C:\\Windows\\..").
// If extracted naively (path.join(dest, entryName)), the write can land
// outside the intended destination directory entirely. Every entry name in
// the archive is validated *before any file is written* — if even one entry
// is unsafe, the whole extraction is aborted with nothing written, the same
// abort-before-write posture lib/moveDirOps.js uses for symlinks found
// inside a source tree being copied/moved.

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");

const EOCD_SIG  = 0x06054b50;
const CDFH_SIG  = 0x02014b50;
const LFH_SIG   = 0x04034b50;

/**
 * Validate a ZIP entry name is safe to extract: not absolute, no ".."
 * traversal segment (on either / or \ separators), no embedded null byte.
 * Throws a descriptive ToolError (policy code) rather than returning a
 * boolean, so the caller can abort the whole extraction immediately.
 */
function assertSafeEntryName(name) {
  if (name.indexOf("\0") !== -1) {
    throw new ToolError(`Refusing to extract: entry name '${name}' contains a null byte.`, -32001);
  }
  // Absolute on POSIX ("/etc/passwd") or Windows ("C:\\...", "\\\\server\\share").
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
    throw new ToolError(
      `Refusing to extract: entry '${name}' is an absolute path (Zip Slip). ` +
      `unzip_archive rejects the whole archive if any entry tries to escape the destination.`,
      -32001
    );
  }
  const segments = name.split(/[\\/]/);
  if (segments.some(seg => seg === "..")) {
    throw new ToolError(
      `Refusing to extract: entry '${name}' contains a '..' traversal segment (Zip Slip). ` +
      `unzip_archive rejects the whole archive if any entry tries to escape the destination.`,
      -32001
    );
  }
}

/**
 * Locate the End-of-Central-Directory record and return { cdOffset, cdEntries }.
 * Same search strategy as lib/archiveOps.js's readArchive.
 */
function findEOCD(buf) {
  const len = buf.length;
  const EOCD_MIN_SIZE = 22;
  const searchStart   = Math.max(0, len - 65535 - EOCD_MIN_SIZE);

  for (let i = len - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return {
        cdEntries: buf.readUInt16LE(i + 10),
        cdOffset:  buf.readUInt32LE(i + 16),
      };
    }
  }
  throw new ToolError("unzip_archive: not a valid ZIP file (EOCD record not found).", -32602);
}

/**
 * Walk the Central Directory and return a flat list of entries, each with
 * enough information to locate and decompress its data via the
 * corresponding Local File Header: { name, isDirectory, method,
 * compressedSize, uncompressedSize, localHeaderOffset }.
 */
function parseCentralDirectory(buf) {
  const { cdOffset, cdEntries } = findEOCD(buf);
  const len = buf.length;
  const entries = [];
  let pos = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (pos + 46 > len) break; // truncated/corrupt ZIP — stop at what we have
    if (buf.readUInt32LE(pos) !== CDFH_SIG) break;

    const method            = buf.readUInt16LE(pos + 10);
    const compressedSize    = buf.readUInt32LE(pos + 20);
    const uncompressedSize  = buf.readUInt32LE(pos + 24);
    const fnLen              = buf.readUInt16LE(pos + 28);
    const efLen              = buf.readUInt16LE(pos + 30);
    const fcLen              = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + fnLen);

    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    pos += 46 + fnLen + efLen + fcLen;
  }
  return entries;
}

/**
 * Read and decompress one entry's data given its Local File Header offset.
 */
function readEntryData(buf, entry) {
  const off = entry.localHeaderOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LFH_SIG) {
    throw new ToolError(`unzip_archive: corrupt ZIP — local file header missing for entry '${entry.name}'.`, -32602);
  }
  const fnLen = buf.readUInt16LE(off + 26);
  const efLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + fnLen + efLen;
  const dataEnd   = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new ToolError(`unzip_archive: corrupt ZIP — entry '${entry.name}' data extends past end of file.`, -32602);
  }
  const raw = buf.slice(dataStart, dataEnd);

  if (entry.method === 0) return raw;                       // stored (no compression)
  if (entry.method === 8) return zlib.inflateRawSync(raw);   // deflate
  throw new ToolError(
    `unzip_archive: entry '${entry.name}' uses unsupported compression method ${entry.method} ` +
    `(only 'stored' and 'deflate' are supported).`,
    -32602
  );
}

/**
 * Extract a ZIP file's contents into a destination directory.
 *
 * @param {string}  zipPath       Absolute path to the source .zip file.
 * @param {string}  destResolved  Absolute path of the jailed destination directory.
 * @param {object}  opts          { overwrite?: boolean }
 * @returns {{
 *   extracted: true, merged: boolean,
 *   filesExtracted: number, directoriesCreated: number, totalBytes: number,
 * }}
 */
function unzipArchive(zipPath, destResolved, opts = {}) {
  if (!fs.existsSync(zipPath)) {
    throw new ToolError(`Source ZIP does not exist: ${zipPath}`, -32602);
  }
  if (fs.statSync(zipPath).isDirectory()) {
    throw new ToolError("Source is a directory — unzip_archive expects a .zip file (use copy_directory for directory trees).", -32602);
  }

  const buf = fs.readFileSync(zipPath);
  const entries = parseCentralDirectory(buf);

  // ── Validate every entry up front — abort before writing anything if any
  //    single entry is unsafe (Zip Slip), same all-or-nothing posture as
  //    move_directory/copy_directory's whole-tree symlink rejection.
  for (const entry of entries) assertSafeEntryName(entry.name);

  const destExisted = fs.existsSync(destResolved);
  if (destExisted) {
    if (!fs.statSync(destResolved).isDirectory()) {
      throw new ToolError(`Destination already exists and is not a directory: ${destResolved}`, -32602);
    }
    if (!opts.overwrite) {
      throw new ToolError(
        `Destination directory already exists: ${destResolved}. Pass overwrite: true to extract into it.`,
        -32602
      );
    }
  }

  fs.mkdirSync(destResolved, { recursive: true });

  let filesExtracted     = 0;
  let directoriesCreated = 1; // the destination root itself
  let totalBytes         = 0;

  for (const entry of entries) {
    const destPath = path.join(destResolved, entry.name);
    if (entry.isDirectory) {
      fs.mkdirSync(destPath, { recursive: true });
      directoriesCreated++;
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const data = readEntryData(buf, entry);
    fs.writeFileSync(destPath, data);
    filesExtracted++;
    totalBytes += data.length;
  }

  return { extracted: true, merged: destExisted, filesExtracted, directoriesCreated, totalBytes };
}

module.exports = { unzipArchive, parseCentralDirectory, assertSafeEntryName, readEntryData };
