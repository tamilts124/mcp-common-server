"use strict";
// ── FILE CHECKSUM ────────────────────────────────────────────────────────────
// file_checksum — MD5 / SHA-1 / SHA-256 / SHA-512 digest of a file

const fs     = require("fs");
const crypto = require("crypto");

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

module.exports = { fileChecksum };
