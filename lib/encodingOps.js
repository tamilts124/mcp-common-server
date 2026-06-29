"use strict";
// ── BASE64 ENCODE / DECODE ────────────────────────────────────────────────────
// base64_encode — encode a file's bytes (or inline text) to a base64 string.
// base64_decode — decode a base64 string and write the result to a file.
//
// Both are zero-dependency, using Node.js built-in Buffer.
// encode is always available (read-only); decode is write-gated.

const fs   = require("fs");
const path = require("path");

/**
 * Encode a file to base64.
 *
 * @param {string} absPath      Absolute path (already jail-validated by caller).
 * @param {string} origPath     Client path (echoed back).
 * @param {object} [opts]
 * @param {boolean} [opts.url_safe]  Use URL-safe alphabet (- and _ instead of + and /).
 * @returns {{ path: string, encoding: string, bytes: number, base64: string }}
 */
function base64Encode(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new Error(`base64_encode: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isFile())
    throw new Error(`base64_encode: '${origPath}' is not a regular file.`);

  const buf = fs.readFileSync(absPath);
  let b64 = buf.toString("base64");

  // RFC 4648 §5 URL-safe alphabet: replace + with - and / with _
  if (opts.url_safe) b64 = b64.replace(/\+/g, "-").replace(/\//g, "_");

  return {
    path:     origPath,
    encoding: opts.url_safe ? "base64url" : "base64",
    bytes:    buf.length,
    base64:   b64,
  };
}

/**
 * Decode a base64 string and write the binary result to a file.
 *
 * @param {string} b64Data      The base64 (or base64url) string to decode.
 * @param {string} absDestPath  Absolute destination path (jail-validated by caller).
 * @param {string} origDest     Client-relative destination (echoed back).
 * @returns {{ destination: string, bytes: number }}
 */
function base64Decode(b64Data, absDestPath, origDest) {
  if (typeof b64Data !== "string")
    throw new Error(`base64_decode: 'data' must be a string.`);

  // Normalise URL-safe characters back to standard base64, and strip any
  // whitespace (spaces, tabs, CR, LF) before decoding — base64 producers
  // commonly wrap output at a fixed line length (e.g. MIME's 76-char
  // lines), and that whitespace is not part of the encoded data.
  const normalised = b64Data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");

  let buf;
  try {
    buf = Buffer.from(normalised, "base64");
  } catch (e) {
    throw new Error(`base64_decode: invalid base64 input: ${e.message}`);
  }

  // Verify the round-trip: if the input is not valid base64 the re-encoding
  // won't match (Buffer.from silently ignores illegal chars, so this is the
  // only reliable way to detect bad input).
  const reEncoded = buf.toString("base64");
  const canonInput = normalised.replace(/=+$/, ""); // strip padding for comparison
  const canonRe    = reEncoded.replace(/=+$/, "");
  if (canonInput !== canonRe) {
    throw new Error(`base64_decode: input contains characters that are not valid base64.`);
  }

  try {
    fs.mkdirSync(path.dirname(absDestPath), { recursive: true });
    fs.writeFileSync(absDestPath, buf);
  } catch (e) {
    throw new Error(`base64_decode: cannot write to '${origDest}': ${e.message}`);
  }

  return { destination: origDest, bytes: buf.length };
}

module.exports = { base64Encode, base64Decode };
