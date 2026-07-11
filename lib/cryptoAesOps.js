"use strict";
// ── CRYPTO_ENCRYPT / CRYPTO_DECRYPT — AES-256-GCM authenticated encryption ──
// Uses Node.js built-in `crypto` only — zero npm dependencies.
//
// Token format (compact, pipe-free so it's grep-friendly):
//   v1:<kdf>:<iv_hex>:<auth_tag_hex>:<ciphertext_base64>
//
// Where <kdf> is one of:
//   raw                                → caller supplied a 64-char hex key directly
//   pbkdf2:<iter>:<salt_hex>           → PBKDF2-HMAC-SHA256 key derivation
//
// SECURITY NOTES:
//   - AES-256-GCM is authenticated: the auth tag catches any tampering.
//   - A fresh random IV is generated for each encryption; never reuse IV+key.
//   - PBKDF2 uses 600 000 iterations (NIST 2023 recommendation for HMAC-SHA256).
//   - Raw key mode skips KDF — use only when caller already has a high-entropy
//     cryptographic key (not a human-memorable password).

const crypto = require("crypto");
const { ToolError } = require("./errors");

// Algorithm constants
const AES_ALG          = "aes-256-gcm";
const KEY_BYTES        = 32;   // AES-256
const IV_BYTES         = 12;   // 96-bit recommended for GCM
const AUTH_TAG_BYTES   = 16;   // 128-bit GCM auth tag
const PBKDF2_SALT_BYTES = 16;  // 128-bit salt
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_DIGEST    = "sha256";
const TOKEN_VERSION    = "v1";
const MAX_BYTES        = 100 * 1024 * 1024; // 100 MB hard cap
const MAX_TOKEN_CHARS  = 200 * 1024 * 1024; // token string cap

// ── Key derivation ───────────────────────────────────────────────────────────

function deriveKey(password, salt, iterations) {
  return crypto.pbkdf2Sync(password, salt, iterations, KEY_BYTES, PBKDF2_DIGEST);
}

function parseRawKey(hexKey, field) {
  if (typeof hexKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(hexKey))
    throw new ToolError(
      `crypto_encrypt: '${field}' must be a 64-character hex string (32 bytes for AES-256). ` +
      `Generate one with: require('crypto').randomBytes(32).toString('hex')`,
      -32602
    );
  return Buffer.from(hexKey, "hex");
}

// ── Public API: crypto_encrypt ──────────────────────────────────────────────

/**
 * Encrypt a Buffer of plaintext bytes.
 * @param {Buffer} plainBuf - plaintext bytes
 * @param {{ password?: string, key?: string }} opts
 * @returns {{ token: string, algorithm: string, kdf: string, kdfIterations: number|null,
 *             plaintextBytes: number, encryptedTokenLength: number }}
 */
function cryptoEncryptBuffer(plainBuf, { password, key: rawKeyHex }) {
  if (!password && !rawKeyHex)
    throw new ToolError("crypto_encrypt: provide either 'password' (PBKDF2 key derivation) or 'key' (64-char hex AES-256 key).", -32602);
  if (password && rawKeyHex)
    throw new ToolError("crypto_encrypt: provide either 'password' or 'key', not both.", -32602);
  if (plainBuf.length > MAX_BYTES)
    throw new ToolError(`crypto_encrypt: input exceeds maximum of ${MAX_BYTES / 1024 / 1024} MB.`, -32602);

  // Derive or load key
  let keyBuf, kdfField;
  if (password) {
    if (typeof password !== "string" || password.length === 0)
      throw new ToolError("crypto_encrypt: 'password' must be a non-empty string.", -32602);
    const salt = crypto.randomBytes(PBKDF2_SALT_BYTES);
    keyBuf   = deriveKey(password, salt, PBKDF2_ITERATIONS);
    kdfField = `pbkdf2:${PBKDF2_ITERATIONS}:${salt.toString("hex")}`;
  } else {
    keyBuf   = parseRawKey(rawKeyHex, "key");
    kdfField = "raw";
  }

  // Encrypt
  const iv     = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALG, keyBuf, iv, { authTagLength: AUTH_TAG_BYTES });
  const ct1    = cipher.update(plainBuf);
  const ct2    = cipher.final();
  const tag    = cipher.getAuthTag();
  const ct     = Buffer.concat([ct1, ct2]);

  // Serialize token
  const token = [
    TOKEN_VERSION,
    kdfField,
    iv.toString("hex"),
    tag.toString("hex"),
    ct.toString("base64"),
  ].join(":");

  return {
    token,
    algorithm:            "AES-256-GCM",
    kdf:                  password ? `PBKDF2-HMAC-${PBKDF2_DIGEST.toUpperCase()}` : "none (raw key)",
    kdfIterations:        password ? PBKDF2_ITERATIONS : null,
    plaintextBytes:       plainBuf.length,
    encryptedTokenLength: token.length,
  };
}

// ── Public API: crypto_decrypt ──────────────────────────────────────────────

/**
 * Decrypt a token string produced by cryptoEncryptBuffer.
 * @param {string} token
 * @param {{ password?: string, key?: string }} opts
 * @returns {{ plaintext: Buffer, algorithm: string, kdf: string }}
 */
function cryptoDecryptToken(token, { password, key: rawKeyHex }) {
  if (typeof token !== "string" || !token.trim())
    throw new ToolError("crypto_decrypt: 'encrypted' must be a non-empty string token.", -32602);
  if (token.length > MAX_TOKEN_CHARS)
    throw new ToolError("crypto_decrypt: token is too large.", -32602);
  if (!password && !rawKeyHex)
    throw new ToolError("crypto_decrypt: provide either 'password' or 'key' (must match what was used to encrypt).", -32602);
  if (password && rawKeyHex)
    throw new ToolError("crypto_decrypt: provide either 'password' or 'key', not both.", -32602);

  // Parse token format: v1:<kdf>:<iv_hex>:<tag_hex>:<ct_base64>
  // The kdf field itself may contain colons (pbkdf2:iter:salt), so split conservatively
  const withoutVersion = token.trim();
  if (!withoutVersion.startsWith(`${TOKEN_VERSION}:`))
    throw new ToolError(
      `crypto_decrypt: unrecognized token version. Expected format: '${TOKEN_VERSION}:<kdf>:<iv>:<tag>:<ciphertext>'.`,
      -32602
    );

  const rest  = withoutVersion.slice(TOKEN_VERSION.length + 1); // remove 'v1:'
  // The rest is: <kdf>:<iv_hex>:<tag_hex>:<ct_base64>
  // kdf is either 'raw' or 'pbkdf2:<iter>:<salt_hex>' (contains colons).
  // We split from the right: last field is ciphertext (may contain '+', '/', '='),
  // second-to-last is tag hex (32 chars), third-to-last is iv hex (24 chars).
  // Everything before those three is the kdf field.

  // Find the positions by splitting and counting from the right
  const colonIdx = []; // indices of all ':' in rest
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === ":") colonIdx.push(i);
  }
  if (colonIdx.length < 3)
    throw new ToolError("crypto_decrypt: malformed token — too few ':' separators.", -32602);

  const ctStart  = colonIdx[colonIdx.length - 1] + 1;
  const tagStart = colonIdx[colonIdx.length - 2] + 1;
  const ivStart  = colonIdx[colonIdx.length - 3] + 1;
  const kdfEnd   = colonIdx[colonIdx.length - 3]; // exclusive

  const kdfField  = rest.slice(0, kdfEnd);
  const ivHex     = rest.slice(ivStart, colonIdx[colonIdx.length - 2]);
  const tagHex    = rest.slice(tagStart, colonIdx[colonIdx.length - 1]);
  const ctBase64  = rest.slice(ctStart);

  // Parse/validate each field
  if (!/^[0-9a-fA-F]+$/.test(ivHex) || ivHex.length !== IV_BYTES * 2)
    throw new ToolError(`crypto_decrypt: malformed IV field (expected ${IV_BYTES * 2} hex chars, got ${ivHex.length}).`, -32602);
  if (!/^[0-9a-fA-F]+$/.test(tagHex) || tagHex.length !== AUTH_TAG_BYTES * 2)
    throw new ToolError(`crypto_decrypt: malformed auth-tag field (expected ${AUTH_TAG_BYTES * 2} hex chars, got ${tagHex.length}).`, -32602);

  const iv  = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  let   ct;
  try { ct = Buffer.from(ctBase64, "base64"); } catch (e) {
    throw new ToolError(`crypto_decrypt: ciphertext base64 decode failed: ${e.message}`, -32602);
  }

  // Recover key
  let keyBuf, kdfStr;
  if (kdfField === "raw") {
    if (!rawKeyHex)
      throw new ToolError("crypto_decrypt: token was encrypted with 'key' (raw mode) but only 'password' was provided.", -32602);
    keyBuf = parseRawKey(rawKeyHex, "key");
    kdfStr = "none (raw key)";
  } else if (kdfField.startsWith("pbkdf2:")) {
    if (!password)
      throw new ToolError("crypto_decrypt: token was encrypted with a 'password' (PBKDF2) but only 'key' was provided.", -32602);
    const parts = kdfField.split(":");
    if (parts.length !== 3)
      throw new ToolError("crypto_decrypt: malformed PBKDF2 KDF field in token.", -32602);
    const iter    = parseInt(parts[1], 10);
    const saltHex = parts[2];
    if (!Number.isInteger(iter) || iter < 1)
      throw new ToolError("crypto_decrypt: invalid PBKDF2 iteration count in token.", -32602);
    if (!/^[0-9a-fA-F]{32}$/.test(saltHex))
      throw new ToolError("crypto_decrypt: malformed PBKDF2 salt in token.", -32602);
    const salt = Buffer.from(saltHex, "hex");
    keyBuf     = deriveKey(password, salt, iter);
    kdfStr     = `PBKDF2-HMAC-${PBKDF2_DIGEST.toUpperCase()}`;
  } else {
    throw new ToolError(`crypto_decrypt: unknown KDF '${kdfField}' in token.`, -32602);
  }

  // Decrypt
  let plainBuf;
  try {
    const decipher = crypto.createDecipheriv(AES_ALG, keyBuf, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(tag);
    const p1 = decipher.update(ct);
    const p2 = decipher.final(); // throws if auth tag fails
    plainBuf = Buffer.concat([p1, p2]);
  } catch (e) {
    // GCM auth failure surfaces as "Unsupported state or unable to authenticate data"
    throw new ToolError(
      `crypto_decrypt: decryption failed — wrong password/key, corrupted ciphertext, or tampered token. (${e.message})`,
      -32602
    );
  }

  return {
    plaintext:      plainBuf,
    algorithm:      "AES-256-GCM",
    kdf:            kdfStr,
    plaintextBytes: plainBuf.length,
  };
}

module.exports = { cryptoEncryptBuffer, cryptoDecryptToken };
