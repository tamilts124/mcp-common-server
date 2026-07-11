"use strict";
// ── TOTP_GENERATE / TOTP_VERIFY — RFC 6238 Time-based One-Time Passwords ────
// Uses Node.js built-in `crypto` only — zero npm dependencies.
// Compatible with Google Authenticator, Authy, and any RFC 6238 TOTP app.
// Implements RFC 4226 (HOTP) + RFC 6238 (TOTP extension).
// Base32 (RFC 4648) secret decoding is implemented inline (zero deps).

const crypto = require("crypto");
const { ToolError } = require("./errors");

// ── Base32 decoder (RFC 4648 alphabet: A–Z 2–7) ───────────────────────────────

const BASE32_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_MAP   = new Map([...BASE32_ALPHA].map((c, i) => [c, i]));

function base32Decode(str) {
  // Normalize: uppercase, strip spaces, dashes, and padding '='
  const s = str.toUpperCase().replace(/[\s\-=]/g, "");
  if (s.length === 0)
    throw new ToolError("totp: 'secret' is empty after stripping whitespace/padding.", -32602);
  if (!/^[A-Z2-7]+$/.test(s))
    throw new ToolError(
      "totp: 'secret' contains characters outside the Base32 alphabet (A-Z, 2-7). " +
      "Ensure the secret is Base32-encoded (as displayed by most TOTP setup flows).",
      -32602
    );

  // Each Base32 character encodes 5 bits; collect into bytes
  const totalBits  = s.length * 5;
  const byteCount  = Math.floor(totalBits / 8);
  const buf        = Buffer.alloc(byteCount, 0);
  let   bitPos     = 0;

  for (const char of s) {
    const val = BASE32_MAP.get(char);
    // Write 5 bits MSB-first into buf
    for (let b = 4; b >= 0; b--) {
      const bit      = (val >> b) & 1;
      const byteIdx  = Math.floor(bitPos / 8);
      const bitInByte = 7 - (bitPos % 8);
      if (byteIdx < byteCount)
        buf[byteIdx] |= (bit << bitInByte);
      bitPos++;
    }
  }

  return buf;
}

// ── HOTP computation (RFC 4226) ───────────────────────────────────────────────

function hotp(keyBuf, counter, digits, algorithm) {
  // counter is an 8-byte big-endian unsigned integer
  const counterBuf = Buffer.alloc(8);
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  counterBuf.writeUInt32BE(hi, 0);
  counterBuf.writeUInt32BE(lo, 4);

  const hmac   = crypto.createHmac(algorithm, keyBuf);
  hmac.update(counterBuf);
  const digest = hmac.digest();

  // Dynamic truncation (RFC 4226 §5.3)
  const offset = digest[digest.length - 1] & 0x0F;
  const code   = (
    ((digest[offset]     & 0x7F) << 24) |
    ((digest[offset + 1] & 0xFF) << 16) |
    ((digest[offset + 2] & 0xFF) << 8)  |
     (digest[offset + 3] & 0xFF)
  );

  const mod = Math.pow(10, digits);
  return String(code % mod).padStart(digits, "0");
}

// ── Input validation ────────────────────────────────────────────────────────────────

const SUPPORTED_ALGORITHMS = ["sha1", "sha256", "sha512"];
const SUPPORTED_DIGITS     = [6, 8];
const MIN_PERIOD           = 1;
const MAX_PERIOD           = 86400;
const MAX_WINDOW           = 10;

function validateTotpInputs({ secret, digits, period, algorithm }) {
  if (typeof secret !== "string" || secret.trim().length === 0)
    throw new ToolError("totp: 'secret' must be a non-empty Base32-encoded string.", -32602);
  if (secret.length > 1024)
    throw new ToolError("totp: 'secret' exceeds maximum length of 1024 characters.", -32602);

  const d = digits ?? 6;
  if (!SUPPORTED_DIGITS.includes(d))
    throw new ToolError(`totp: 'digits' must be 6 or 8 (got ${d}).`, -32602);

  const p = period ?? 30;
  if (!Number.isInteger(p) || p < MIN_PERIOD || p > MAX_PERIOD)
    throw new ToolError(
      `totp: 'period' must be an integer between ${MIN_PERIOD} and ${MAX_PERIOD} (got ${p}).`,
      -32602
    );

  const alg = (algorithm || "sha1").toLowerCase();
  if (!SUPPORTED_ALGORITHMS.includes(alg))
    throw new ToolError(
      `totp: 'algorithm' must be one of ${SUPPORTED_ALGORITHMS.join(", ")} (got ${algorithm}).`,
      -32602
    );

  return { d, p, alg };
}

function validateTime(time, tool) {
  const t = time ?? Math.floor(Date.now() / 1000);
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0)
    throw new ToolError(
      `${tool}: 'time' must be a non-negative finite Unix timestamp in seconds.`,
      -32602
    );
  return t;
}

// ── Public API: totp_generate ─────────────────────────────────────────────────────────

function totpGenerate({ secret, digits, period, algorithm, time }) {
  const { d, p, alg } = validateTotpInputs({ secret, digits, period, algorithm });
  const nowSec        = validateTime(time, "totp_generate");
  const counter       = Math.floor(nowSec / p);
  const keyBuf        = base32Decode(secret.trim());
  const otp           = hotp(keyBuf, counter, d, alg);

  const stepStart = counter * p;
  const stepEnd   = stepStart + p;
  const validFor  = stepEnd - nowSec; // seconds remaining in this time step

  return {
    otp,
    algorithm:   alg.toUpperCase(),
    digits:      d,
    period:      p,
    counter,
    validFor,
    expiresAt:   new Date(stepEnd * 1000).toISOString(),
    generatedAt: new Date(nowSec * 1000).toISOString(),
  };
}

// ── Public API: totp_verify ──────────────────────────────────────────────────────────

function totpVerify({ otp, secret, digits, period, algorithm, window: win, time }) {
  const { d, p, alg } = validateTotpInputs({ secret, digits, period, algorithm });
  const nowSec        = validateTime(time, "totp_verify");

  if (typeof otp !== "string" || !/^\d+$/.test(otp))
    throw new ToolError("totp_verify: 'otp' must be a numeric string (digits only).", -32602);
  if (otp.length !== d)
    throw new ToolError(
      `totp_verify: 'otp' must be exactly ${d} digits (got ${otp.length}).`,
      -32602
    );

  const w = win ?? 1;
  if (!Number.isInteger(w) || w < 0 || w > MAX_WINDOW)
    throw new ToolError(
      `totp_verify: 'window' must be an integer between 0 and ${MAX_WINDOW} (got ${win}).`,
      -32602
    );

  const counter = Math.floor(nowSec / p);
  const keyBuf  = base32Decode(secret.trim());

  // Check counter - window .. counter + window (inclusive)
  for (let delta = -w; delta <= w; delta++) {
    const c = counter + delta;
    if (c < 0) continue;

    const code    = hotp(keyBuf, c, d, alg);
    const codeBuf = Buffer.from(code,  "utf8");
    const otpBuf  = Buffer.from(otp,   "utf8");

    // timingSafeEqual requires equal-length buffers
    let equal = false;
    if (codeBuf.length === otpBuf.length) {
      try { equal = crypto.timingSafeEqual(codeBuf, otpBuf); } catch { equal = false; }
    }

    if (equal) {
      return {
        valid:     true,
        delta,
        counter:   c,
        algorithm: alg.toUpperCase(),
        digits:    d,
        period:    p,
      };
    }
  }

  return {
    valid:     false,
    delta:     null,
    counter,
    algorithm: alg.toUpperCase(),
    digits:    d,
    period:    p,
  };
}

module.exports = { totpGenerate, totpVerify, base32Decode, hotp };
