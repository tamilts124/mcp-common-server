"use strict";
// ── BASE62 ENCODE / DECODE ────────────────────────────────────────────────────
// base62_encode — encode a non-negative integer or Buffer as a Base62 string.
// base62_decode — decode a Base62 string back to a BigInt (or hex/decimal string).
//
// Alphabet: 0-9 A-Z a-z  (digits first, then upper, then lower)
// This is the most common convention (used by YouTube, Bitly, etc.).
// Zero dependencies — pure Node.js built-ins.

const { ToolError } = require("./errors");

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE     = BigInt(ALPHABET.length); // 62n

// O(1) reverse lookup map
const CHAR_TO_VAL = new Map();
for (let i = 0; i < ALPHABET.length; i++) CHAR_TO_VAL.set(ALPHABET[i], BigInt(i));

const MAX_ENCODE_BIGINT = BigInt("9999999999999999999999999999999999999999"); // 40 decimal digits — sanity guard
const MAX_ENCODED_LEN   = 1024; // for decode input

/**
 * Convert a non-negative integer / bigint / Buffer to a Base62 string.
 *
 * @param {object} opts
 * @param {number|string|bigint|null}  [opts.number]  Non-negative integer (decimal string or JS number/bigint).
 * @param {string|null}               [opts.hex]     Hexadecimal string (0x prefix optional, even/odd length ok).
 * @param {string|null}               [opts.bytes]   Base64-encoded bytes to encode as Base62.
 * @param {number}                    [opts.min_length]  Pad output with leading '0' to at least this length.
 * @returns {{ encoded, base, alphabet, inputType, inputBigInt }}
 */
function base62Encode({ number: num, hex, bytes, min_length } = {}) {
  let bigVal;
  let inputType;

  // ── Input source selection ───────────────────────────────────────────────
  const provided = [num != null, hex != null, bytes != null].filter(Boolean).length;
  if (provided === 0)
    throw new ToolError("base62_encode: provide 'number', 'hex', or 'bytes'.", -32602);
  if (provided > 1)
    throw new ToolError("base62_encode: provide only one of 'number', 'hex', or 'bytes'.", -32602);

  if (num != null) {
    inputType = "number";
    const s = String(num).trim();
    if (!/^\d+$/.test(s))
      throw new ToolError("base62_encode: 'number' must be a non-negative decimal integer string.", -32602);
    bigVal = BigInt(s);
    if (bigVal < 0n)
      throw new ToolError("base62_encode: 'number' must be non-negative.", -32602);
    if (bigVal > MAX_ENCODE_BIGINT)
      throw new ToolError("base62_encode: 'number' exceeds the 40-decimal-digit limit.", -32602);
  } else if (hex != null) {
    inputType = "hex";
    let h = String(hex).trim().replace(/^0x/i, "").replace(/\s/g, "");
    if (h.length === 0) throw new ToolError("base62_encode: 'hex' must not be empty.", -32602);
    if (!/^[0-9a-fA-F]+$/.test(h))
      throw new ToolError("base62_encode: 'hex' contains invalid characters.", -32602);
    // Ensure even-length hex so BigInt conversion is unambiguous
    if (h.length % 2 !== 0) h = "0" + h;
    bigVal = BigInt("0x" + h);
  } else {
    inputType = "bytes";
    let buf;
    try {
      buf = Buffer.from(String(bytes), "base64");
    } catch {
      throw new ToolError("base62_encode: 'bytes' is not valid base64.", -32602);
    }
    if (buf.length === 0) throw new ToolError("base62_encode: 'bytes' is empty.", -32602);
    bigVal = BigInt("0x" + buf.toString("hex"));
  }

  // ── Encode ───────────────────────────────────────────────────────────────
  if (bigVal === 0n) {
    const encoded = "0";
    const padded  = encoded.padStart(Math.max(1, min_length ?? 1), "0");
    return { encoded: padded, base: 62, alphabet: ALPHABET, inputType, inputBigInt: "0" };
  }

  const digits = [];
  let n = bigVal;
  while (n > 0n) {
    digits.push(ALPHABET[Number(n % BASE)]);
    n /= BASE;
  }
  const encoded = digits.reverse().join("");
  const padded  = encoded.padStart(Math.max(encoded.length, min_length ?? 0), "0");
  return {
    encoded: padded,
    base: 62,
    alphabet: ALPHABET,
    inputType,
    inputBigInt: bigVal.toString(),
  };
}

/**
 * Decode a Base62 string back to a BigInt, with output as decimal/hex/bytes.
 *
 * @param {object} opts
 * @param {string}  opts.encoded      Base62 string to decode.
 * @param {string}  [opts.output]     Output format: 'decimal' (default), 'hex', 'bytes' (base64).
 * @returns {{ decoded, base, outputFormat, decodedBigInt }}
 */
function base62Decode({ encoded, output } = {}) {
  if (typeof encoded !== "string" || encoded.trim().length === 0)
    throw new ToolError("base62_decode: 'encoded' must be a non-empty string.", -32602);

  const s = encoded.trim();
  if (s.length > MAX_ENCODED_LEN)
    throw new ToolError(`base62_decode: input exceeds ${MAX_ENCODED_LEN}-character limit.`, -32602);

  // Validate charset
  for (const ch of s) {
    if (!CHAR_TO_VAL.has(ch))
      throw new ToolError(
        `base62_decode: invalid Base62 character '${ch}' (alphabet is 0-9A-Za-z).`,
        -32602
      );
  }

  // Decode
  let val = 0n;
  for (const ch of s) {
    val = val * BASE + CHAR_TO_VAL.get(ch);
  }

  const outputFormat = output === "hex" ? "hex" : output === "bytes" ? "bytes" : "decimal";
  let decoded;

  if (outputFormat === "decimal") {
    decoded = val.toString(10);
  } else if (outputFormat === "hex") {
    let h = val.toString(16);
    if (h.length % 2 !== 0) h = "0" + h;
    decoded = h;
  } else {
    // bytes — return as base64
    let h = val.toString(16);
    if (h.length % 2 !== 0) h = "0" + h;
    decoded = Buffer.from(h, "hex").toString("base64");
  }

  return {
    decoded,
    base: 62,
    outputFormat,
    decodedBigInt: val.toString(),
  };
}

module.exports = { base62Encode, base62Decode, ALPHABET };
