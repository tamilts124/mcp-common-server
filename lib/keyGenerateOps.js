"use strict";
// ── key_generate: generate cryptographic keys ─────────────────────────────────
// Uses Node's built-in crypto module — zero npm dependencies.
// Supported key types:
//   rsa       — RSA key pair (1024-8192 bits, default 2048)
//   ec        — EC key pair (P-256/P-384/P-521/secp256k1)
//   ed25519   — Ed25519 EdDSA key pair
//   ed448     — Ed448 EdDSA key pair
//   symmetric — Random bytes for AES-256 or HMAC (raw hex or base64)
// Returns PEM strings for asymmetric types, hex/base64 for symmetric.

const crypto = require("crypto");
const { ToolError } = require("./errors");

// ── Defaults ──────────────────────────────────────────────────────────────────
const RSA_VALID_BITS = [1024, 2048, 3072, 4096, 6144, 8192];
const RSA_DEFAULT_BITS = 2048;
const EC_VALID_CURVES = ["P-256", "P-384", "P-521", "secp256k1"];
const EC_DEFAULT_CURVE = "P-256";
const SYM_VALID_SIZES = [16, 24, 32, 48, 64, 128];  // bytes
const SYM_DEFAULT_SIZE = 32;  // 256 bits

/**
 * Compute SHA-256 fingerprint of a public key (DER-encoded),
 * returned as lowercase colon-hex (same format as TLS fingerprints).
 */
function publicKeyFingerprint(keyObj) {
  try {
    const der = keyObj.export({ type: "spki", format: "der" });
    const hash = crypto.createHash("sha256").update(der).digest("hex");
    return hash.match(/.{2}/g).join(":");
  } catch {
    return null;
  }
}

/**
 * Generate an RSA key pair.
 */
function generateRSA(opts = {}) {
  const bits = opts.bits ?? RSA_DEFAULT_BITS;
  if (!RSA_VALID_BITS.includes(bits)) {
    throw new ToolError(
      `key_generate: invalid RSA 'bits' ${bits}. Valid: ${RSA_VALID_BITS.join(", ")}.`,
      -32602
    );
  }

  const exponent = opts.public_exponent ?? 65537;
  if (typeof exponent !== "number" || exponent < 3 || exponent > 16777215 || exponent % 2 === 0) {
    throw new ToolError(
      "key_generate: 'public_exponent' must be an odd number between 3 and 16777215 (default 65537).",
      -32602
    );
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength:  bits,
    publicExponent: exponent,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding:  { type: "spki",  format: "pem" },
  });

  // Fingerprint from raw key object
  const pubKeyObj = crypto.createPublicKey(publicKey);
  const fingerprint = publicKeyFingerprint(pubKeyObj);

  return {
    algorithm:          "RSA",
    bits,
    publicExponent:     exponent,
    privateKeyPem:      privateKey,
    publicKeyPem:       publicKey,
    fingerprint_sha256: fingerprint,
  };
}

/**
 * Generate an EC key pair.
 */
function generateEC(opts = {}) {
  const curve = opts.curve ?? EC_DEFAULT_CURVE;
  if (!EC_VALID_CURVES.includes(curve)) {
    throw new ToolError(
      `key_generate: invalid EC 'curve' '${curve}'. Valid: ${EC_VALID_CURVES.join(", ")}.`,
      -32602
    );
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve:         curve,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding:  { type: "spki",  format: "pem" },
  });

  const pubKeyObj = crypto.createPublicKey(publicKey);
  const fingerprint = publicKeyFingerprint(pubKeyObj);

  return {
    algorithm:          "EC",
    curve,
    privateKeyPem:      privateKey,
    publicKeyPem:       publicKey,
    fingerprint_sha256: fingerprint,
  };
}

/**
 * Generate an Ed25519 or Ed448 key pair.
 */
function generateEdDSA(type) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync(type.toLowerCase(), {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding:  { type: "spki",  format: "pem" },
  });

  const pubKeyObj = crypto.createPublicKey(publicKey);
  const fingerprint = publicKeyFingerprint(pubKeyObj);

  return {
    algorithm:          type,
    privateKeyPem:      privateKey,
    publicKeyPem:       publicKey,
    fingerprint_sha256: fingerprint,
  };
}

/**
 * Generate a random symmetric key (bytes for AES/HMAC).
 */
function generateSymmetric(opts = {}) {
  const sizeBytes = opts.size ?? SYM_DEFAULT_SIZE;
  if (!SYM_VALID_SIZES.includes(sizeBytes)) {
    throw new ToolError(
      `key_generate: invalid symmetric 'size' ${sizeBytes}. Valid byte lengths: ${SYM_VALID_SIZES.join(", ")}.`,
      -32602
    );
  }

  const encoding = opts.encoding ?? "hex";
  if (!["hex", "base64", "base64url"].includes(encoding)) {
    throw new ToolError(
      "key_generate: 'encoding' must be 'hex', 'base64', or 'base64url'.",
      -32602
    );
  }

  const bytes = crypto.randomBytes(sizeBytes);
  let key;
  if (encoding === "base64url") {
    key = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } else {
    key = bytes.toString(encoding);
  }

  const purpose = sizeBytes === 16 ? "AES-128-GCM / HMAC-SHA256"
    : sizeBytes === 24 ? "AES-192-GCM"
    : sizeBytes === 32 ? "AES-256-GCM / HMAC-SHA256"
    : sizeBytes === 48 ? "HMAC-SHA384"
    : sizeBytes === 64 ? "HMAC-SHA512"
    : `${sizeBytes * 8}-bit symmetric key`;

  return {
    algorithm:        "symmetric",
    bits:             sizeBytes * 8,
    encoding,
    key,
    suggestedPurpose: purpose,
  };
}

/**
 * Main entry point.
 *
 * @param {object} opts
 * @param {string} opts.type  — "rsa" | "ec" | "ed25519" | "ed448" | "symmetric"
 * @returns {object}
 */
function keyGenerate(opts = {}) {
  const type = (opts.type ?? "rsa").toLowerCase();

  switch (type) {
    case "rsa":
      return generateRSA(opts);
    case "ec":
      return generateEC(opts);
    case "ed25519":
      return generateEdDSA("Ed25519");
    case "ed448":
      return generateEdDSA("Ed448");
    case "symmetric":
      return generateSymmetric(opts);
    default:
      throw new ToolError(
        `key_generate: unknown 'type' '${opts.type}'. Valid: rsa, ec, ed25519, ed448, symmetric.`,
        -32602
      );
  }
}

module.exports = { keyGenerate, generateRSA, generateEC, generateEdDSA, generateSymmetric };
