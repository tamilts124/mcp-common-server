"use strict";
// ── HASH STRING ─────────────────────────────────────────────────────────────
// hash_string — compute a cryptographic digest of an arbitrary string
// payload, with no file I/O involved. Sibling of file_checksum
// (lib/utilOps.js) for callers that already have data in hand (an API
// response body, a generated config, a value read via another tool) and
// don't want to round-trip it through a temp file just to hash it.
// Extracted to its own module to keep lib/utilOps.js under the project's
// 500-line threshold.

const crypto = require("crypto");

const ALLOWED_ALGOS     = ["md5", "sha1", "sha256", "sha512"];
const ALLOWED_ENCODINGS = ["utf8", "base64", "hex"];

/**
 * Compute a cryptographic digest of an arbitrary string payload.
 * @param {string} data      The string payload to hash.
 * @param {string} algorithm "md5" | "sha1" | "sha256" | "sha512" (default "sha256")
 * @param {string} encoding  How to interpret `data`: "utf8" (default) | "base64" | "hex"
 * @returns {{ algorithm: string, encoding: string, hex: string, sizeBytes: number }}
 */
function hashString(data, algorithm, encoding) {
  if (typeof data !== "string")
    throw new Error("hash_string: 'data' is required and must be a string.");

  const algo = (algorithm || "sha256").toLowerCase();
  if (!ALLOWED_ALGOS.includes(algo))
    throw new Error(`Unsupported algorithm '${algorithm}'. Choose one of: ${ALLOWED_ALGOS.join(", ")}.`);

  const enc = (encoding || "utf8").toLowerCase();
  if (!ALLOWED_ENCODINGS.includes(enc))
    throw new Error(`Unsupported encoding '${encoding}'. Choose one of: ${ALLOWED_ENCODINGS.join(", ")}.`);

  let buf;
  try {
    buf = Buffer.from(data, enc);
  } catch (e) {
    throw new Error(`hash_string: could not decode 'data' as ${enc}: ${e.message}`);
  }
  // Buffer.from silently drops invalid characters for base64/hex rather than
  // throwing (e.g. Buffer.from("not-hex!", "hex") -> empty buffer) — catch
  // the case where non-empty input decoded to nothing, which almost always
  // indicates malformed input rather than a genuinely empty payload.
  if (buf.length === 0 && data.length > 0 && enc !== "utf8")
    throw new Error(`hash_string: 'data' does not look like valid ${enc} (decoded to 0 bytes).`);

  const hex = crypto.createHash(algo).update(buf).digest("hex");
  return { algorithm: algo, encoding: enc, hex, sizeBytes: buf.length };
}

module.exports = { hashString };
