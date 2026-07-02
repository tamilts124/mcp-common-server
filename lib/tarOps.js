"use strict";
// ── TAR ARCHIVE OPS — zero-dependency USTAR reader/writer ──────────────────
// Pure-Node implementation of the POSIX USTAR tar format (optionally
// gzip-wrapped via zlib for .tar.gz/.tgz), mirroring lib/zipDirOps.js /
// lib/unzipOps.js's role for ZIP archives. No npm packages.
//
// create_tar reuses lib/zipDirOps.js's collectFiles() (same MCP_IGNORE walk,
// same "only files, directories implied by path" convention as zip_directory
// — no explicit directory entries are written).
//
// extract_tar applies the same "Zip Slip" defense as unzip_archive: every
// entry name is validated *before any file is written*, and any entry whose
// type is not a plain file or directory (symlink/hardlink/device/fifo) is
// rejected outright — a malicious tar cannot plant a symlink to later escape
// the destination via a second, differently-shaped entry.

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");
const { collectFiles } = require("./zipDirOps");

const BLOCK_SIZE = 512;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function writeOctalField(buf, offset, len, value) {
  const oct = Math.max(0, Math.trunc(value)).toString(8);
  if (oct.length > len - 1) {
    throw new ToolError(`create_tar: value ${value} too large for USTAR header field.`, -32602);
  }
  buf.write(oct.padStart(len - 1, "0"), offset, len - 1, "ascii");
  buf[offset + len - 1] = 0;
}

function readOctalField(buf, offset, len) {
  const str = buf.toString("ascii", offset, offset + len).replace(/\0.*$/s, "").trim();
  if (!str) return 0;
  const n = parseInt(str, 8);
  return Number.isNaN(n) ? 0 : n;
}

/** Split a relative path into USTAR's 100-byte name + 155-byte prefix fields. */
function splitName(relPath) {
  if (Buffer.byteLength(relPath, "utf8") <= 100) return { prefix: "", name: relPath };
  const parts = relPath.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { prefix, name };
    }
  }
  throw new ToolError(`create_tar: path too long for USTAR format (max 255 bytes, split at '/'): '${relPath}'`, -32602);
}

function buildHeader(relPath, size, mtimeSec, typeflag) {
  const { prefix, name } = splitName(relPath);
  const buf = Buffer.alloc(BLOCK_SIZE, 0);
  buf.write(name, 0, 100, "utf8");
  writeOctalField(buf, 100, 8, 0o644);       // mode
  writeOctalField(buf, 108, 8, 0);           // uid
  writeOctalField(buf, 116, 8, 0);           // gid
  writeOctalField(buf, 124, 12, size);       // size
  writeOctalField(buf, 136, 12, mtimeSec);   // mtime
  buf.fill(0x20, 148, 156);                  // chksum placeholder (spaces during checksum calc)
  buf[156] = typeflag.charCodeAt(0);         // typeflag
  buf.write("ustar", 257, 6, "ascii");       // magic ("ustar\0")
  buf.write("00", 263, 2, "ascii");          // version
  if (prefix) buf.write(prefix, 345, 155, "utf8");

  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function padBlock(size) {
  const pad = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
  return pad === 0 ? Buffer.alloc(0) : Buffer.alloc(pad, 0);
}

/**
 * Archive a directory to a .tar (or .tar.gz/.tgz, gzip-compressed) file.
 * @returns {{ tarPath: string, filesArchived: number, sizeBytes: number, gzip: boolean }}
 */
function createTar(srcDir, destTar, opts = {}) {
  const files = collectFiles(srcDir, "", []);
  const blocks = [];
  for (const { absPath, relPath } of files) {
    const data = fs.readFileSync(absPath);
    const stat = fs.statSync(absPath);
    blocks.push(buildHeader(relPath, data.length, Math.floor(stat.mtimeMs / 1000), "0"));
    blocks.push(data, padBlock(data.length));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0)); // two zero blocks = end of archive

  let tarBuffer = Buffer.concat(blocks);
  const gzip = opts.gzip !== undefined ? !!opts.gzip : /\.(tgz|tar\.gz)$/i.test(destTar);
  if (gzip) tarBuffer = zlib.gzipSync(tarBuffer);

  fs.writeFileSync(destTar, tarBuffer);
  return { tarPath: destTar, filesArchived: files.length, sizeBytes: tarBuffer.length, gzip };
}

/** Same Zip-Slip-style defense as lib/unzipOps.js's assertSafeEntryName. */
function assertSafeEntryName(name) {
  if (!name || name.indexOf("\0") !== -1) {
    throw new ToolError(`Refusing to extract: entry name '${name}' is empty or contains a null byte.`, -32001);
  }
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
    throw new ToolError(
      `Refusing to extract: entry '${name}' is an absolute path. ` +
      `extract_tar rejects the whole archive if any entry tries to escape the destination.`,
      -32001
    );
  }
  const segments = name.split(/[\\/]/);
  if (segments.some(seg => seg === "..")) {
    throw new ToolError(
      `Refusing to extract: entry '${name}' contains a '..' traversal segment. ` +
      `extract_tar rejects the whole archive if any entry tries to escape the destination.`,
      -32001
    );
  }
}

const SAFE_TYPEFLAGS = new Set(["0", "\0", "5"]); // regular file, regular file (old), directory

/** Parse a raw (already gunzipped, if needed) tar buffer into entry descriptors. */
function parseTar(buf) {
  const entries = [];
  let pos = 0;
  while (pos + BLOCK_SIZE <= buf.length) {
    const block = buf.subarray(pos, pos + BLOCK_SIZE);
    let allZero = true;
    for (let i = 0; i < BLOCK_SIZE; i++) { if (block[i] !== 0) { allZero = false; break; } }
    if (allZero) break; // end-of-archive marker

    const nameRaw = block.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const size = readOctalField(block, 124, 12);
    const typeflag = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
    const magic = block.toString("ascii", 257, 262);
    const prefix = magic === "ustar" ? block.toString("utf8", 345, 500).replace(/\0.*$/s, "") : "";
    const name = prefix ? `${prefix}/${nameRaw}` : nameRaw;

    pos += BLOCK_SIZE;
    const dataStart = pos;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      throw new ToolError(`extract_tar: corrupt archive — entry '${name}' data extends past end of file.`, -32602);
    }
    entries.push({ name, size, typeflag, dataStart, dataEnd });
    pos = dataEnd + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);
  }
  return entries;
}

/**
 * Extract a .tar/.tar.gz/.tgz file's contents into a destination directory.
 * @returns {{ extracted: true, merged: boolean, filesExtracted: number,
 *             directoriesCreated: number, totalBytes: number }}
 */
function extractTar(tarPath, destResolved, opts = {}) {
  if (!fs.existsSync(tarPath)) throw new ToolError(`Source tar does not exist: ${tarPath}`, -32602);
  if (fs.statSync(tarPath).isDirectory()) {
    throw new ToolError("Source is a directory — extract_tar expects a .tar/.tar.gz file.", -32602);
  }

  let buf = fs.readFileSync(tarPath);
  if (buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) {
    try {
      buf = zlib.gunzipSync(buf);
    } catch (e) {
      throw new ToolError(`extract_tar: gzip-looking archive failed to decompress — ${e.message}`, -32602);
    }
  }

  const entries = parseTar(buf);

  // Validate every entry up front — abort before writing anything if unsafe.
  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    if (!SAFE_TYPEFLAGS.has(entry.typeflag)) {
      throw new ToolError(
        `Refusing to extract: entry '${entry.name}' has an unsupported/unsafe type ` +
        `(symlink, hardlink, device, or fifo entries are rejected — only regular files and directories are supported).`,
        -32001
      );
    }
  }

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

  let filesExtracted = 0;
  let directoriesCreated = 1; // destination root itself
  let totalBytes = 0;

  for (const entry of entries) {
    const destPath = path.join(destResolved, entry.name);
    if (entry.typeflag === "5") {
      fs.mkdirSync(destPath, { recursive: true });
      directoriesCreated++;
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const data = buf.subarray(entry.dataStart, entry.dataEnd);
    fs.writeFileSync(destPath, data);
    filesExtracted++;
    totalBytes += data.length;
  }

  return { extracted: true, merged: destExisted, filesExtracted, directoriesCreated, totalBytes };
}

module.exports = { createTar, extractTar, parseTar, assertSafeEntryName, splitName };
