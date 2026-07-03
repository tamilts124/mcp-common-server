"use strict";
// ── CHECK_BINARY_FILE — sniff text vs binary + best-guess MIME type ────────
// Reads a small header chunk of a file and checks it against a table of
// known binary magic-byte signatures (PNG, JPEG, GIF, PDF, ZIP-family,
// GZIP, ELF, Windows PE, class files, etc). If no signature matches, falls
// back to a text-vs-binary heuristic: presence of a NUL byte anywhere in
// the sample, or a high ratio of non-printable/control bytes, both strong
// binary signals (same NUL-byte convention used by scan_todos/git_show/
// check_line_endings — kept consistent with the rest of this codebase
// rather than inventing a new heuristic). Read-only, zero-dependency.

const fs = require("fs");
const { ToolError } = require("./errors");

const SAMPLE_BYTES = 8000;

// Ordered signature table — first match wins. Each entry: bytes (array of
// numbers, -1 = wildcard), mime, label.
const SIGNATURES = [
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png", label: "PNG image" },
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg", label: "JPEG image" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif", label: "GIF image" },
  { bytes: [0x42, 0x4d], mime: "image/bmp", label: "BMP image" },
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf", label: "PDF document" },
  { bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip", label: "ZIP archive (or ZIP-based: docx/xlsx/pptx/jar/apk)" },
  { bytes: [0x50, 0x4b, 0x05, 0x06], mime: "application/zip", label: "ZIP archive (empty)" },
  { bytes: [0x1f, 0x8b], mime: "application/gzip", label: "GZIP archive" },
  { bytes: [0x42, 0x5a, 0x68], mime: "application/x-bzip2", label: "BZIP2 archive" },
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], mime: "application/x-7z-compressed", label: "7-Zip archive" },
  { bytes: [0x75, 0x73, 0x74, 0x61, 0x72], mime: "application/x-tar", label: "TAR archive", offset: 257 },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], mime: "application/x-elf", label: "ELF executable" },
  { bytes: [0x4d, 0x5a], mime: "application/x-msdownload", label: "Windows PE executable/DLL" },
  { bytes: [0xca, 0xfe, 0xba, 0xbe], mime: "application/java-vm", label: "Java class file" },
  { bytes: [0x25, 0x21, 0x50, 0x53], mime: "application/postscript", label: "PostScript document" },
  { bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg", label: "MP3 audio (ID3)" },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "audio/wav-or-video/avi", label: "RIFF container (WAV/AVI)" },
  { bytes: [0x00, 0x00, 0x00, -1, 0x66, 0x74, 0x79, 0x70], mime: "video/mp4", label: "MP4 video" },
  { bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65], mime: "application/x-sqlite3", label: "SQLite database" },
];

function matchesAt(buf, sig) {
  const off = sig.offset || 0;
  if (buf.length < off + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    const want = sig.bytes[i];
    if (want === -1) continue;
    if (buf[off + i] !== want) return false;
  }
  return true;
}

function detectSignature(buf) {
  for (const sig of SIGNATURES) {
    if (matchesAt(buf, sig)) return sig;
  }
  return null;
}

// Text-vs-binary heuristic fallback when no known signature matches:
// a NUL byte anywhere is a near-certain binary signal; otherwise count the
// ratio of control/non-printable bytes (excluding common text whitespace:
// \t \n \r) in the sample — above 30% is treated as binary.
function heuristicIsBinary(buf) {
  const len = Math.min(buf.length, SAMPLE_BYTES);
  if (len === 0) return { isBinary: false, nulFound: false, controlRatio: 0 };
  let nulFound = false;
  let controlCount = 0;
  for (let i = 0; i < len; i++) {
    const b = buf[i];
    if (b === 0x00) { nulFound = true; continue; }
    const isTextWhitespace = b === 0x09 || b === 0x0a || b === 0x0d;
    if (!isTextWhitespace && (b < 0x20 || b === 0x7f)) controlCount++;
  }
  const controlRatio = Math.round((controlCount / len) * 1000) / 1000;
  return { isBinary: nulFound || controlRatio > 0.3, nulFound, controlRatio };
}

/**
 * Sniff whether a file is text or binary via magic-byte signature match,
 * falling back to a NUL-byte/control-byte-ratio heuristic.
 * @param {string} absPath
 * @param {string} origPath
 * @returns {{path, sizeBytes, isBinary, mimeType, detectionMethod, description, nulByteFound, controlByteRatio}}
 */
function checkBinaryFile(absPath, origPath) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`check_binary_file: cannot access '${origPath}': ${e.message}`, -32602); }
  if (!stat.isFile()) {
    throw new ToolError(`check_binary_file: '${origPath}' is not a regular file.`, -32602);
  }

  const fd = fs.openSync(absPath, "r");
  let buf;
  try {
    const size = Math.min(stat.size, SAMPLE_BYTES);
    buf = Buffer.alloc(size);
    if (size > 0) fs.readSync(fd, buf, 0, size, 0);
  } finally {
    fs.closeSync(fd);
  }

  const sig = detectSignature(buf);
  if (sig) {
    return {
      path: origPath,
      sizeBytes: stat.size,
      isBinary: true,
      mimeType: sig.mime,
      detectionMethod: "signature",
      description: sig.label,
      nulByteFound: null,
      controlByteRatio: null,
    };
  }

  const h = heuristicIsBinary(buf);
  return {
    path: origPath,
    sizeBytes: stat.size,
    isBinary: h.isBinary,
    mimeType: h.isBinary ? "application/octet-stream" : "text/plain",
    detectionMethod: "heuristic",
    description: h.isBinary ? "unrecognized binary content" : "plain text",
    nulByteFound: h.nulFound,
    controlByteRatio: h.controlRatio,
  };
}

module.exports = { checkBinaryFile };
