"use strict";
/**
 * test/sections/167-crypto-encrypt-decrypt.js
 * Isolated functional tests for crypto_encrypt and crypto_decrypt tools.
 * Section [167] — 5 rigor levels.
 */

const { test } = require("../test-harness");
const { cryptoEncryptBuffer, cryptoDecryptToken } = require("../../lib/cryptoAesOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const PASSWORD  = "correct horse battery staple";
const RAW_KEY  = require("crypto").randomBytes(32).toString("hex"); // fixed for test session

// ─────────────────────────────────────────────────────────────────────────────
// [167-A] NORMAL — basic encrypt/decrypt round-trips
// ─────────────────────────────────────────────────────────────────────────────
test("[167-A-1] crypto_encrypt(password): returns token starting with 'v1:pbkdf2:'", () => {
  const r = cryptoEncryptBuffer(Buffer.from("hello"), { password: PASSWORD });
  assert(r.token.startsWith("v1:pbkdf2:"), `bad prefix: ${r.token.slice(0, 20)}`);
});

test("[167-A-2] crypto_encrypt(key): returns token starting with 'v1:raw:'", () => {
  const r = cryptoEncryptBuffer(Buffer.from("hello"), { key: RAW_KEY });
  assert(r.token.startsWith("v1:raw:"), `bad prefix: ${r.token.slice(0, 20)}`);
});

test("[167-A-3] crypto_decrypt(password): round-trips UTF-8 text", () => {
  const plain = "The quick brown fox jumps over the lazy dog.";
  const { token } = cryptoEncryptBuffer(Buffer.from(plain), { password: PASSWORD });
  const dec = cryptoDecryptToken(token, { password: PASSWORD });
  assert(dec.plaintext.toString("utf8") === plain);
});

test("[167-A-4] crypto_decrypt(key): round-trips UTF-8 text", () => {
  const plain = "AES-256-GCM raw key mode";
  const { token } = cryptoEncryptBuffer(Buffer.from(plain), { key: RAW_KEY });
  const dec = cryptoDecryptToken(token, { key: RAW_KEY });
  assert(dec.plaintext.toString("utf8") === plain);
});

test("[167-A-5] crypto_encrypt: plaintextBytes matches input length", () => {
  const buf = Buffer.from("12345");
  const r = cryptoEncryptBuffer(buf, { password: PASSWORD });
  assert(r.plaintextBytes === 5);
});

test("[167-A-6] crypto_encrypt: algorithm is 'AES-256-GCM'", () => {
  const r = cryptoEncryptBuffer(Buffer.from("x"), { password: PASSWORD });
  assert(r.algorithm === "AES-256-GCM");
});

test("[167-A-7] crypto_decrypt: plaintextBytes in result", () => {
  const plain = "foobar";
  const { token } = cryptoEncryptBuffer(Buffer.from(plain), { key: RAW_KEY });
  const dec = cryptoDecryptToken(token, { key: RAW_KEY });
  assert(dec.plaintextBytes === 6);
});

test("[167-A-8] crypto_encrypt(password): kdfIterations is 600000", () => {
  const r = cryptoEncryptBuffer(Buffer.from("x"), { password: PASSWORD });
  assert(r.kdfIterations === 600000);
});

test("[167-A-9] crypto_encrypt(key): kdfIterations is null", () => {
  const r = cryptoEncryptBuffer(Buffer.from("x"), { key: RAW_KEY });
  assert(r.kdfIterations === null);
});

test("[167-A-10] crypto_encrypt: each call produces different token (random IV)", () => {
  const buf = Buffer.from("same input");
  const t1 = cryptoEncryptBuffer(buf, { key: RAW_KEY }).token;
  const t2 = cryptoEncryptBuffer(buf, { key: RAW_KEY }).token;
  assert(t1 !== t2, "two encryptions of the same plaintext must produce different tokens");
});

// ─────────────────────────────────────────────────────────────────────────────
// [167-B] MEDIUM — validation for empty/invalid inputs
// ─────────────────────────────────────────────────────────────────────────────
test("[167-B-1] crypto_encrypt: neither password nor key throws ToolError", () => {
  let threw = false;
  try { cryptoEncryptBuffer(Buffer.from("x"), {}); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-2] crypto_encrypt: both password and key throws ToolError", () => {
  let threw = false;
  try { cryptoEncryptBuffer(Buffer.from("x"), { password: PASSWORD, key: RAW_KEY }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-3] crypto_encrypt: empty password throws ToolError", () => {
  let threw = false;
  try { cryptoEncryptBuffer(Buffer.from("x"), { password: "" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-4] crypto_encrypt: key too short (32 hex chars) throws ToolError", () => {
  let threw = false;
  try { cryptoEncryptBuffer(Buffer.from("x"), { key: "deadbeef".repeat(4) }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-5] crypto_encrypt: key with non-hex chars throws ToolError", () => {
  let threw = false;
  try { cryptoEncryptBuffer(Buffer.from("x"), { key: "zz".repeat(32) }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-6] crypto_decrypt: wrong password returns ToolError (auth failure)", () => {
  const { token } = cryptoEncryptBuffer(Buffer.from("secret"), { password: PASSWORD });
  let threw = false;
  try { cryptoDecryptToken(token, { password: "wrong-password" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-7] crypto_decrypt: wrong key returns ToolError (auth failure)", () => {
  const { token } = cryptoEncryptBuffer(Buffer.from("secret"), { key: RAW_KEY });
  const wrongKey = require("crypto").randomBytes(32).toString("hex");
  let threw = false;
  try { cryptoDecryptToken(token, { key: wrongKey }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-8] crypto_decrypt: empty token throws ToolError", () => {
  let threw = false;
  try { cryptoDecryptToken("", { password: PASSWORD }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-9] crypto_decrypt: token with wrong version prefix throws ToolError", () => {
  let threw = false;
  try { cryptoDecryptToken("v2:raw:aabb:ccdd:ZWFz", { key: RAW_KEY }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-10] crypto_decrypt: key provided but token is pbkdf2-encrypted throws ToolError", () => {
  const { token } = cryptoEncryptBuffer(Buffer.from("x"), { password: PASSWORD });
  let threw = false;
  try { cryptoDecryptToken(token, { key: RAW_KEY }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-B-11] crypto_decrypt: password provided but token is raw-key-encrypted throws ToolError", () => {
  const { token } = cryptoEncryptBuffer(Buffer.from("x"), { key: RAW_KEY });
  let threw = false;
  try { cryptoDecryptToken(token, { password: PASSWORD }); } catch (e) { threw = true; }
  assert(threw);
});

// ─────────────────────────────────────────────────────────────────────────────
// [167-C] HIGH — binary data, edge bytes, and token structure
// ─────────────────────────────────────────────────────────────────────────────
test("[167-C-1] crypto_encrypt/decrypt: round-trips binary buffer (all byte values 0-255)", () => {
  const buf = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) buf[i] = i;
  const { token } = cryptoEncryptBuffer(buf, { key: RAW_KEY });
  const dec = cryptoDecryptToken(token, { key: RAW_KEY });
  assert(dec.plaintext.equals(buf), "binary round-trip mismatch");
});

test("[167-C-2] crypto_encrypt/decrypt: empty plaintext Buffer round-trips", () => {
  const buf = Buffer.alloc(0);
  const { token } = cryptoEncryptBuffer(buf, { key: RAW_KEY });
  const dec = cryptoDecryptToken(token, { key: RAW_KEY });
  assert(dec.plaintext.length === 0);
});

test("[167-C-3] crypto_decrypt: truncated auth tag throws ToolError (tampering)", () => {
  const { token } = cryptoEncryptBuffer(Buffer.from("test"), { key: RAW_KEY });
  // The token is v1:raw:<24hex-iv>:<32hex-tag>:<base64-ct>
  // Trim the last char from the tag segment to corrupt it
  const parts = token.split(":"); // ['v1','raw','<iv>','<tag>','<ct>']
  parts[3] = parts[3].slice(0, -1); // shorten auth tag
  let threw = false;
  try { cryptoDecryptToken(parts.join(":"), { key: RAW_KEY }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-C-4] crypto_decrypt: altered ciphertext throws ToolError (GCM auth failure)", () => {
  const { token } = cryptoEncryptBuffer(Buffer.from("hello world"), { key: RAW_KEY });
  // Flip the last character of the ciphertext (base64, last segment)
  const idx = token.lastIndexOf(":");
  const ct = token.slice(idx + 1);
  const alteredCt = ct.slice(0, -1) + (ct.slice(-1) === "A" ? "B" : "A");
  let threw = false;
  try { cryptoDecryptToken(token.slice(0, idx + 1) + alteredCt, { key: RAW_KEY }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-C-5] crypto_encrypt/decrypt: 1 MB plaintext round-trips correctly", () => {
  const buf = Buffer.alloc(1024 * 1024, 0x42); // 1MB of 'B'
  const { token } = cryptoEncryptBuffer(buf, { key: RAW_KEY });
  const dec = cryptoDecryptToken(token, { key: RAW_KEY });
  assert(dec.plaintext.length === buf.length && dec.plaintext[0] === 0x42);
});

test("[167-C-6] crypto_encrypt/decrypt: NUL bytes in plaintext round-trip", () => {
  const buf = Buffer.from([0x00, 0x01, 0x00, 0xff, 0x00]);
  const { token } = cryptoEncryptBuffer(buf, { key: RAW_KEY });
  const dec = cryptoDecryptToken(token, { key: RAW_KEY });
  assert(dec.plaintext.equals(buf));
});

// ─────────────────────────────────────────────────────────────────────────────
// [167-D] CRITICAL — injection / path traversal / boundary checks
// ─────────────────────────────────────────────────────────────────────────────
test("[167-D-1] crypto_decrypt: malformed token with too few colons throws ToolError", () => {
  let threw = false;
  try { cryptoDecryptToken("v1:raw:onlythree", { key: RAW_KEY }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-D-2] crypto_decrypt: IV field wrong hex length throws ToolError", () => {
  // Construct a token where the IV is too short
  const { token } = cryptoEncryptBuffer(Buffer.from("x"), { key: RAW_KEY });
  const parts = token.split(":"); // v1 : raw : ivHex : tagHex : ct
  parts[2] = "aabb"; // too short (should be 24 chars)
  let threw = false;
  try { cryptoDecryptToken(parts.join(":"), { key: RAW_KEY }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-D-3] crypto_decrypt: unknown KDF field throws ToolError", () => {
  const { token } = cryptoEncryptBuffer(Buffer.from("x"), { key: RAW_KEY });
  // Replace 'raw' with an unknown KDF name
  const altered = token.replace("v1:raw:", "v1:unknown:");
  let threw = false;
  try { cryptoDecryptToken(altered, { key: RAW_KEY }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-D-4] crypto_decrypt: PBKDF2 iteration count 0 throws ToolError", () => {
  const { token } = cryptoEncryptBuffer(Buffer.from("x"), { password: PASSWORD });
  // Tamper the iteration count to 0
  const altered = token.replace(/pbkdf2:\d+:/, "pbkdf2:0:");
  let threw = false;
  try { cryptoDecryptToken(altered, { password: PASSWORD }); } catch (e) { threw = true; }
  assert(threw);
});

test("[167-D-5] crypto_encrypt: payload claiming to be a key but wrong length throws ToolError", () => {
  let threw = false;
  try { cryptoEncryptBuffer(Buffer.from("x"), { key: "abcdef" }); } catch (e) { threw = true; }
  assert(threw);
});

// ─────────────────────────────────────────────────────────────────────────────
// [167-E] EXTREME — concurrency and stress
// ─────────────────────────────────────────────────────────────────────────────
test("[167-E-1] crypto_encrypt/decrypt(key): 200 sequential round-trips, all correct", () => {
  let ok = 0;
  for (let i = 0; i < 200; i++) {
    const plain = `message-${i}`;
    const { token } = cryptoEncryptBuffer(Buffer.from(plain), { key: RAW_KEY });
    const dec = cryptoDecryptToken(token, { key: RAW_KEY });
    if (dec.plaintext.toString("utf8") === plain) ok++;
  }
  assert(ok === 200, `expected 200 ok, got ${ok}`);
});

test("[167-E-2] crypto_encrypt/decrypt(password): 2 sequential round-trips (PBKDF2 is slow)", () => {
  let ok = 0;
  for (let i = 0; i < 2; i++) {
    const plain = `pbkdf2-test-${i}`;
    const { token } = cryptoEncryptBuffer(Buffer.from(plain), { password: `${PASSWORD}-${i}` });
    const dec = cryptoDecryptToken(token, { password: `${PASSWORD}-${i}` });
    if (dec.plaintext.toString("utf8") === plain) ok++;
  }
  assert(ok === 2, `expected 2 ok, got ${ok}`);
});

test("[167-E-3] crypto_encrypt/decrypt(key): 50 concurrent round-trips via Promise.all", async () => {
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => {
      const plain = `concurrent-${i}`;
      const { token } = cryptoEncryptBuffer(Buffer.from(plain), { key: RAW_KEY });
      const dec = cryptoDecryptToken(token, { key: RAW_KEY });
      return dec.plaintext.toString("utf8") === plain;
    }))
  );
  assert(results.every(Boolean), "some concurrent encrypt/decrypt round-trips failed");
});

test("[167-E-4] crypto_encrypt: 100 encryptions of same input produce 100 unique tokens", () => {
  const buf = Buffer.from("always same");
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    tokens.add(cryptoEncryptBuffer(buf, { key: RAW_KEY }).token);
  }
  assert(tokens.size === 100, `expected 100 unique tokens, got ${tokens.size}`);
});

test("[167-E-5] crypto_encrypt/decrypt: 10 KB plaintext round-trips in under 5s (key mode)", () => {
  const buf = Buffer.alloc(10240, 0x41);
  const start = Date.now();
  const { token } = cryptoEncryptBuffer(buf, { key: RAW_KEY });
  const dec = cryptoDecryptToken(token, { key: RAW_KEY });
  const elapsed = Date.now() - start;
  assert(dec.plaintext.equals(buf), "plaintext mismatch");
  assert(elapsed < 5000, `took ${elapsed}ms, expected < 5000ms`);
});
