"use strict";
// ── HMAC_SIGN / HMAC_VERIFY — HMAC generation + constant-time verification ──────
// Uses Node.js built-in `crypto` only — zero npm dependencies.
// Universally useful for webhook signature verification (GitHub, Stripe,
// Slack, Shopify all use HMAC-SHA256), API authentication, and data integrity
// checks. hmac_verify uses crypto.timingSafeEqual() to prevent timing attacks.

const crypto = require("crypto");
const { ToolError } = require("./errors");

const SUPPORTED_ALGORITHMS = ["sha256", "sha384", "sha512", "sha1", "sha224"];
const SUPPORTED_ENCODINGS  = ["hex", "base64", "base64url"];
const MAX_MESSAGE_BYTES    = 50 * 1024 * 1024; // 50 MB
const MAX_SECRET_LENGTH    = 65536;             // 64 KB

// ── Encoding helpers ──────────────────────────────────────────────────────────

function encodeDigest(buf, encoding) {
  if (encoding === "base64url")
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (encoding === "base64")
    return buf.toString("base64");
  return buf.toString("hex");
}

function decodeSignature(sig, encoding) {
  try {
    if (encoding === "base64url") {
      let s = sig.replace(/-/g, "+").replace(/_/g, "/");
      const pad = s.length % 4;
      if (pad === 2) s += "==";
      else if (pad === 3) s += "=";
      return Buffer.from(s, "base64");
    }
    if (encoding === "base64")
      return Buffer.from(sig, "base64");
    // hex
    if (!/^[0-9a-fA-F]*$/.test(sig) || sig.length % 2 !== 0)
      throw new ToolError("hmac_verify: 'signature' is not valid hex.", -32602);
    return Buffer.from(sig, "hex");
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`hmac_verify: could not decode signature: ${e.message}`, -32602);
  }
}

// ── Input validation helpers ─────────────────────────────────────────────────

function validateAlgorithm(alg, tool) {
  const a = (alg || "sha256").toLowerCase();
  if (!SUPPORTED_ALGORITHMS.includes(a))
    throw new ToolError(
      `${tool}: unsupported algorithm '${alg}'. Supported: ${SUPPORTED_ALGORITHMS.join(", ")}.`,
      -32602
    );
  return a;
}

function validateEncoding(enc, tool) {
  const e = (enc || "hex").toLowerCase();
  if (!SUPPORTED_ENCODINGS.includes(e))
    throw new ToolError(
      `${tool}: unsupported encoding '${enc}'. Supported: ${SUPPORTED_ENCODINGS.join(", ")}.`,
      -32602
    );
  return e;
}

function validateMessage(message, tool) {
  if (typeof message !== "string")
    throw new ToolError(`${tool}: 'message' must be a string.`, -32602);
  const buf = Buffer.from(message, "utf8");
  if (buf.length > MAX_MESSAGE_BYTES)
    throw new ToolError(
      `${tool}: 'message' exceeds maximum of ${MAX_MESSAGE_BYTES / 1024 / 1024} MB.`,
      -32602
    );
  return buf;
}

function validateSecret(secret, tool) {
  if (typeof secret !== "string" || secret.length === 0)
    throw new ToolError(`${tool}: 'secret' must be a non-empty string.`, -32602);
  if (secret.length > MAX_SECRET_LENGTH)
    throw new ToolError(
      `${tool}: 'secret' exceeds maximum length of ${MAX_SECRET_LENGTH} characters.`,
      -32602
    );
  return secret;
}

// ── Public API: hmac_sign ───────────────────────────────────────────────────────────────

function hmacSign({ message, secret, algorithm, encoding }) {
  const msgBuf = validateMessage(message, "hmac_sign");
  const key    = validateSecret(secret, "hmac_sign");
  const alg    = validateAlgorithm(algorithm, "hmac_sign");
  const enc    = validateEncoding(encoding, "hmac_sign");

  const digest    = crypto.createHmac(alg, key).update(msgBuf).digest();
  const signature = encodeDigest(digest, enc);

  return {
    signature,
    algorithm:       alg,
    encoding:        enc,
    messageLength:   msgBuf.length,
    signatureLength: signature.length,
  };
}

// ── Public API: hmac_verify ────────────────────────────────────────────────────────────

function hmacVerify({ message, secret, signature, algorithm, encoding }) {
  const msgBuf = validateMessage(message, "hmac_verify");
  const key    = validateSecret(secret, "hmac_verify");
  const alg    = validateAlgorithm(algorithm, "hmac_verify");
  const enc    = validateEncoding(encoding, "hmac_verify");

  if (typeof signature !== "string" || signature.length === 0)
    throw new ToolError("hmac_verify: 'signature' must be a non-empty string.", -32602);
  if (signature.length > 65536)
    throw new ToolError("hmac_verify: 'signature' string is too long.", -32602);

  const expected = crypto.createHmac(alg, key).update(msgBuf).digest();
  const provided = decodeSignature(signature, enc);

  // Constant-time comparison. timingSafeEqual throws if buffer lengths differ,
  // so we handle that case explicitly with a dummy comparison to avoid leaking
  // length information through a branch short-circuit.
  let valid = false;
  if (expected.length === provided.length) {
    valid = crypto.timingSafeEqual(expected, provided);
  } else {
    // Lengths differ — definitely invalid. Run a dummy same-length comparison
    // to keep timing consistent (prevents length-oracle side channel).
    const dummy = Buffer.alloc(expected.length);
    crypto.timingSafeEqual(expected, dummy); // result intentionally discarded
    valid = false;
  }

  return {
    valid,
    algorithm:     alg,
    encoding:      enc,
    messageLength: msgBuf.length,
  };
}

module.exports = { hmacSign, hmacVerify };
