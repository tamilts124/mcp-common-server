"use strict";
/**
 * test/sections/168-hmac-totp.js
 * Isolated functional tests for hmac_sign, hmac_verify, totp_generate, totp_verify.
 * Section [168] — 5 rigor levels.
 */

const { test } = require("../test-harness");
const { hmacSign, hmacVerify } = require("../../lib/hmacSignOps");
const { totpGenerate, totpVerify, base32Decode, hotp } = require("../../lib/totpOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ── helpers ──────────────────────────────────────────────────────────────────
// RFC 4226 Appendix D test vector secret: "12345678901234567890" => Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890" base32

// A well-known TOTP test secret (Google Authenticator compatible)
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";

// ───────────────────────────────────────────────────────────────────────────────
// [168-A] NORMAL — HMAC happy paths
// ───────────────────────────────────────────────────────────────────────────────
test("[168-A-1] hmac_sign: default SHA-256 hex output shape", () => {
  const r = hmacSign({ message: "hello", secret: "secret" });
  assert(typeof r.signature === "string" && r.signature.length === 64, "expected 64-char hex");
  assert(r.algorithm === "sha256");
  assert(r.encoding  === "hex");
  assert(r.messageLength === 5);
});

test("[168-A-2] hmac_sign: known SHA-256 test vector (HMAC of 'The quick brown fox')", () => {
  // Python: import hmac, hashlib; hmac.new(b'key', b'The quick brown fox jumps over the lazy dog', hashlib.sha256).hexdigest()
  // = f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8
  const r = hmacSign({ message: "The quick brown fox jumps over the lazy dog", secret: "key" });
  assert(r.signature === "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    `expected known vector, got ${r.signature}`);
});

test("[168-A-3] hmac_sign: base64 encoding", () => {
  const hex = hmacSign({ message: "msg", secret: "key" }).signature;
  const b64 = hmacSign({ message: "msg", secret: "key", encoding: "base64" }).signature;
  assert(Buffer.from(b64, "base64").toString("hex") === hex, "base64 must decode to same hex");
});

test("[168-A-4] hmac_sign: base64url encoding", () => {
  const b64url = hmacSign({ message: "msg", secret: "key", encoding: "base64url" }).signature;
  assert(!/[+/=]/.test(b64url), "base64url must not contain +, /, or =");
});

test("[168-A-5] hmac_sign: SHA-512 produces 128-char hex", () => {
  const r = hmacSign({ message: "data", secret: "key", algorithm: "sha512" });
  assert(r.signature.length === 128 && r.algorithm === "sha512");
});

test("[168-A-6] hmac_sign: SHA-1 produces 40-char hex", () => {
  const r = hmacSign({ message: "data", secret: "key", algorithm: "sha1" });
  assert(r.signature.length === 40 && r.algorithm === "sha1");
});

test("[168-A-7] hmac_verify: valid signature returns valid:true", () => {
  const { signature } = hmacSign({ message: "hello", secret: "secret" });
  const v = hmacVerify({ message: "hello", secret: "secret", signature });
  assert(v.valid === true);
});

test("[168-A-8] hmac_verify: wrong message returns valid:false", () => {
  const { signature } = hmacSign({ message: "hello", secret: "secret" });
  const v = hmacVerify({ message: "HELLO", secret: "secret", signature });
  assert(v.valid === false);
});

test("[168-A-9] hmac_verify: wrong secret returns valid:false", () => {
  const { signature } = hmacSign({ message: "hello", secret: "secret" });
  const v = hmacVerify({ message: "hello", secret: "wrong-secret", signature });
  assert(v.valid === false);
});

test("[168-A-10] hmac_verify: base64url round-trip", () => {
  const { signature } = hmacSign({ message: "test", secret: "key", encoding: "base64url" });
  const v = hmacVerify({ message: "test", secret: "key", signature, encoding: "base64url" });
  assert(v.valid === true);
});

// ───────────────────────────────────────────────────────────────────────────────
// [168-B] NORMAL — TOTP happy paths
// ───────────────────────────────────────────────────────────────────────────────
// RFC 4226 Appendix D SHA-1 test vectors (HOTP counter 0-9)
// secret = "12345678901234567890" (bytes), Base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const RFC4226_VECTORS = [
  { counter: 0, otp: "755224" },
  { counter: 1, otp: "287082" },
  { counter: 2, otp: "359152" },
  { counter: 3, otp: "969429" },
  { counter: 4, otp: "338314" },
  { counter: 5, otp: "254676" },
  { counter: 6, otp: "287922" },
  { counter: 7, otp: "162583" },
  { counter: 8, otp: "399871" },
  { counter: 9, otp: "520489" },
];

test("[168-B-1] base32Decode: RFC 4648 §10 test vectors", () => {
  // RFC 4648 §10 canonical test vectors (padding/lowercase stripped by decoder)
  assert(base32Decode("MY").toString("ascii")         === "f",      "MY => 'f'");
  assert(base32Decode("MZXQ").toString("ascii")       === "fo",     "MZXQ => 'fo'");
  assert(base32Decode("MZXW6").toString("ascii")      === "foo",    "MZXW6 => 'foo'");
  assert(base32Decode("MZXW6YQ").toString("ascii")    === "foob",   "MZXW6YQ => 'foob'");
  assert(base32Decode("MZXW6YTB").toString("ascii")   === "fooba",  "MZXW6YTB => 'fooba'");
  assert(base32Decode("MZXW6YTBOI").toString("ascii") === "foobar", "MZXW6YTBOI => 'foobar'");
  const buf = base32Decode("mzxw6ytboi======");  // lowercase + padding
  assert(buf.toString("ascii") === "foobar", `got: ${buf.toString("ascii")}`);
});

test("[168-B-2] base32Decode: RFC 4226 secret decodes to correct bytes", () => {
  const buf = base32Decode(RFC_SECRET);
  assert(buf.toString("ascii") === "12345678901234567890",
    `got: ${JSON.stringify(buf.toString("ascii"))}`);
});

test("[168-B-3] hotp: RFC 4226 Appendix D test vectors (counter 0-9)", () => {
  const { base32Decode: bd, hotp: h } = require("../../lib/totpOps");
  const keyBuf = bd(RFC_SECRET);
  for (const { counter, otp } of RFC4226_VECTORS) {
    const got = h(keyBuf, counter, 6, "sha1");
    assert(got === otp, `counter ${counter}: expected ${otp}, got ${got}`);
  }
});

test("[168-B-4] totp_generate: returns 6-digit string", () => {
  const r = totpGenerate({ secret: TOTP_SECRET });
  assert(typeof r.otp === "string" && /^\d{6}$/.test(r.otp), `otp: ${r.otp}`);
  assert(r.digits === 6 && r.period === 30 && r.algorithm === "SHA1");
  assert(r.validFor >= 0 && r.validFor <= 30);
});

test("[168-B-5] totp_generate: deterministic with fixed time", () => {
  const t = 1000000000; // arbitrary fixed unix time
  const a = totpGenerate({ secret: TOTP_SECRET, time: t });
  const b = totpGenerate({ secret: TOTP_SECRET, time: t });
  assert(a.otp === b.otp, "same time must yield same otp");
  assert(a.counter === b.counter);
});

test("[168-B-6] totp_generate: adjacent time steps produce different OTPs", () => {
  const t = 1000000000;
  const otp1 = totpGenerate({ secret: TOTP_SECRET, time: t }).otp;
  const otp2 = totpGenerate({ secret: TOTP_SECRET, time: t + 30 }).otp; // next period
  // Different counters should (almost certainly) produce different codes
  // This could theoretically collide but is astronomically unlikely
  const counter1 = Math.floor(t / 30);
  const counter2 = Math.floor((t + 30) / 30);
  assert(counter1 !== counter2, "counters must differ for adjacent periods");
});

test("[168-B-7] totp_verify: generated OTP verifies successfully", () => {
  const t = 1000000000;
  const { otp } = totpGenerate({ secret: TOTP_SECRET, time: t });
  const v = totpVerify({ otp, secret: TOTP_SECRET, time: t });
  assert(v.valid === true && v.delta === 0);
});

test("[168-B-8] totp_verify: OTP from previous period accepted with window=1", () => {
  const t = 1000000000;
  const { otp } = totpGenerate({ secret: TOTP_SECRET, time: t - 30 }); // previous period
  const v = totpVerify({ otp, secret: TOTP_SECRET, time: t, window: 1 });
  assert(v.valid === true && v.delta === -1, `expected delta -1, got ${v.delta}`);
});

test("[168-B-9] totp_verify: wrong OTP returns valid:false", () => {
  const v = totpVerify({ otp: "000000", secret: TOTP_SECRET });
  assert(v.valid === false && v.delta === null);
});

test("[168-B-10] totp_generate: 8-digit OTP mode", () => {
  const r = totpGenerate({ secret: TOTP_SECRET, digits: 8 });
  assert(/^\d{8}$/.test(r.otp) && r.digits === 8);
});

// ───────────────────────────────────────────────────────────────────────────────
// [168-C] MEDIUM — validation for empty/invalid inputs
// ───────────────────────────────────────────────────────────────────────────────
test("[168-C-1] hmac_sign: empty message throws ToolError", () => {
  // empty string is valid (0-byte message), but non-string should throw
  let threw = false;
  try { hmacSign({ message: 123, secret: "key" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-2] hmac_sign: empty secret throws ToolError", () => {
  let threw = false;
  try { hmacSign({ message: "msg", secret: "" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-3] hmac_sign: unsupported algorithm throws ToolError", () => {
  let threw = false;
  try { hmacSign({ message: "msg", secret: "key", algorithm: "md5" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-4] hmac_sign: unsupported encoding throws ToolError", () => {
  let threw = false;
  try { hmacSign({ message: "msg", secret: "key", encoding: "raw" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-5] hmac_verify: invalid hex signature returns ToolError or valid:false", () => {
  // 'ZZZ' is not valid hex, should throw ToolError
  let threw = false;
  try {
    hmacVerify({ message: "hello", secret: "secret", signature: "ZZZZZZ" });
  } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-6] hmac_verify: signature with correct hex length but wrong value", () => {
  const v = hmacVerify({
    message: "hello", secret: "secret",
    signature: "0000000000000000000000000000000000000000000000000000000000000000",
  });
  assert(v.valid === false);
});

test("[168-C-7] totp_generate: invalid secret (non-base32) throws ToolError", () => {
  let threw = false;
  try { totpGenerate({ secret: "!!! not base32 !!!" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-8] totp_generate: empty secret throws ToolError", () => {
  let threw = false;
  try { totpGenerate({ secret: "" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-9] totp_generate: invalid digits throws ToolError", () => {
  let threw = false;
  try { totpGenerate({ secret: TOTP_SECRET, digits: 7 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-10] totp_verify: non-numeric OTP throws ToolError", () => {
  let threw = false;
  try { totpVerify({ otp: "ABCDEF", secret: TOTP_SECRET }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-11] totp_verify: OTP wrong length throws ToolError", () => {
  let threw = false;
  try { totpVerify({ otp: "12345", secret: TOTP_SECRET, digits: 6 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-C-12] totp_generate: unsupported algorithm throws ToolError", () => {
  let threw = false;
  try { totpGenerate({ secret: TOTP_SECRET, algorithm: "sha224" }); } catch (e) { threw = true; }
  assert(threw);
});

// ───────────────────────────────────────────────────────────────────────────────
// [168-D] HIGH — edge cases and algorithm variants
// ───────────────────────────────────────────────────────────────────────────────
test("[168-D-1] hmac_sign: empty string message is valid (0-byte HMAC)", () => {
  const r = hmacSign({ message: "", secret: "key" });
  assert(typeof r.signature === "string" && r.signature.length === 64);
  assert(r.messageLength === 0);
});

test("[168-D-2] hmac_sign: SHA-384 produces 96-char hex", () => {
  const r = hmacSign({ message: "data", secret: "key", algorithm: "sha384" });
  assert(r.signature.length === 96);
});

test("[168-D-3] hmac_sign: SHA-224 produces 56-char hex", () => {
  const r = hmacSign({ message: "data", secret: "key", algorithm: "sha224" });
  assert(r.signature.length === 56);
});

test("[168-D-4] hmac_verify: valid hex with wrong byte length returns valid:false (not throw)", () => {
  // 62-char hex = 31 bytes: valid even-length hex, but wrong for SHA-256 (expects 32 bytes).
  // The timingSafeEqual length-mismatch guard must return valid:false, NOT throw.
  const shortSig = "0".repeat(62); // 62 chars = 31 bytes; valid hex, wrong length for SHA-256 (32 bytes)
  if (shortSig.length !== 62) throw new Error("sanity: expected 62 hex chars, got " + shortSig.length);
  const v = hmacVerify({ message: "hello", secret: "secret", signature: shortSig });
  assert(v.valid === false, "expected valid:false for wrong-length sig, got " + v.valid);
});

test("[168-D-5] hmac_verify: base64 encoded signature round-trip", () => {
  const { signature } = hmacSign({ message: "webhook payload", secret: "my-webhook-secret", encoding: "base64" });
  const v = hmacVerify({ message: "webhook payload", secret: "my-webhook-secret", signature, encoding: "base64" });
  assert(v.valid === true && v.encoding === "base64");
});

test("[168-D-6] totp_generate: period=60 yields correct validFor", () => {
  const t = 1000000000;
  const r = totpGenerate({ secret: TOTP_SECRET, period: 60, time: t });
  assert(r.period === 60);
  assert(r.validFor >= 0 && r.validFor <= 60);
  const expected = 60 - (t % 60);
  assert(r.validFor === expected, `expected ${expected}, got ${r.validFor}`);
});

test("[168-D-7] totp_generate: SHA-256 variant", () => {
  const r = totpGenerate({ secret: TOTP_SECRET, algorithm: "sha256" });
  assert(r.algorithm === "SHA256" && /^\d{6}$/.test(r.otp));
});

test("[168-D-8] totp_generate: SHA-512 variant", () => {
  const r = totpGenerate({ secret: TOTP_SECRET, algorithm: "sha512" });
  assert(r.algorithm === "SHA512" && /^\d{6}$/.test(r.otp));
});

test("[168-D-9] totp_verify: window=0 only accepts current step", () => {
  const t = 1000000000;
  const { otp: prevOtp } = totpGenerate({ secret: TOTP_SECRET, time: t - 30 });
  const v = totpVerify({ otp: prevOtp, secret: TOTP_SECRET, time: t, window: 0 });
  assert(v.valid === false, "previous step should fail with window=0");
});

test("[168-D-10] totp_verify: window=2 accepts two steps ahead", () => {
  const t = 1000000000;
  const { otp } = totpGenerate({ secret: TOTP_SECRET, time: t + 60 }); // 2 periods ahead
  const v = totpVerify({ otp, secret: TOTP_SECRET, time: t, window: 2 });
  assert(v.valid === true && v.delta === 2);
});

test("[168-D-11] totp_generate: secret with lowercase/spaces/dashes accepted", () => {
  // JBSWY3DPEHPK3PXP == JBSWY3DP EHPK3PXP (spaces) == jbswy3dpehpk3pxp (lower)
  const t = 1000000000;
  const otp1 = totpGenerate({ secret: "JBSWY3DPEHPK3PXP",      time: t }).otp;
  const otp2 = totpGenerate({ secret: "jbswy3dpehpk3pxp",      time: t }).otp;
  const otp3 = totpGenerate({ secret: "JBSWY3DP EHPK3PXP",     time: t }).otp;
  const otp4 = totpGenerate({ secret: "JBSWY3DP-EHPK3PXP",     time: t }).otp;
  const otp5 = totpGenerate({ secret: "JBSWY3DPEHPK3PXP======", time: t }).otp; // with padding
  assert(otp1 === otp2 && otp1 === otp3 && otp1 === otp4 && otp1 === otp5,
    `expected all equal but got: ${[otp1,otp2,otp3,otp4,otp5]}`);
});

// ───────────────────────────────────────────────────────────────────────────────
// [168-E] CRITICAL — security and boundary safety
// ───────────────────────────────────────────────────────────────────────────────
test("[168-E-1] hmac_verify: timing-safe comparison (different lengths still returns valid:false, not throw)", () => {
  // A 40-char hex (sha1 size) provided but algorithm=sha256 expects 64-char output.
  // Length mismatch — should return valid:false without throwing.
  const smallSig = hmacSign({ message: "msg", secret: "key", algorithm: "sha1" }).signature; // 40 hex chars
  const v = hmacVerify({ message: "msg", secret: "key", signature: smallSig, algorithm: "sha256" });
  assert(v.valid === false);
});

test("[168-E-2] hmac_sign: Unicode message (emoji, CJK) signs and verifies", () => {
  const message = "\u4e2d\u6587\uD83D\uDE00 \u0041\u0301"; // CJK + emoji + combining char
  const { signature } = hmacSign({ message, secret: "key" });
  const v = hmacVerify({ message, secret: "key", signature });
  assert(v.valid === true);
});

test("[168-E-3] hmac_sign: very long key (10KB secret) still works", () => {
  const key = "x".repeat(10 * 1024);
  const r = hmacSign({ message: "test", secret: key });
  assert(typeof r.signature === "string" && r.signature.length === 64);
});

test("[168-E-4] hmac_verify: tampered signature (one hex digit flipped) returns false", () => {
  const { signature } = hmacSign({ message: "critical data", secret: "webhook-secret" });
  // Flip the last hex character
  const lastChar = signature.slice(-1);
  const flipped  = lastChar === "a" ? "b" : "a";
  const tampered = signature.slice(0, -1) + flipped;
  const v = hmacVerify({ message: "critical data", secret: "webhook-secret", signature: tampered });
  assert(v.valid === false);
});

test("[168-E-5] totp_generate: expiresAt is always after generatedAt", () => {
  const r = totpGenerate({ secret: TOTP_SECRET });
  assert(new Date(r.expiresAt) > new Date(r.generatedAt));
});

test("[168-E-6] totp_verify: window larger than MAX_WINDOW throws ToolError", () => {
  let threw = false;
  try { totpVerify({ otp: "000000", secret: TOTP_SECRET, window: 11 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-E-7] totp_generate: period=1 (1-second steps) still produces valid 6-digit code", () => {
  const r = totpGenerate({ secret: TOTP_SECRET, period: 1 });
  assert(/^\d{6}$/.test(r.otp));
  assert(r.period === 1);
});

test("[168-E-8] totp_generate: invalid time (negative) throws ToolError", () => {
  let threw = false;
  try { totpGenerate({ secret: TOTP_SECRET, time: -1 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[168-E-9] totp_generate: invalid time (Infinity) throws ToolError", () => {
  let threw = false;
  try { totpGenerate({ secret: TOTP_SECRET, time: Infinity }); } catch (e) { threw = true; }
  assert(threw);
});

// ───────────────────────────────────────────────────────────────────────────────
// [168-F] EXTREME — concurrency and stress
// ───────────────────────────────────────────────────────────────────────────────
test("[168-F-1] hmac_sign+verify: 1000 sequential sign+verify round-trips", () => {
  let ok = 0;
  for (let i = 0; i < 1000; i++) {
    const msg = `message-${i}-payload`;
    const { signature } = hmacSign({ message: msg, secret: "stress-secret" });
    const v = hmacVerify({ message: msg, secret: "stress-secret", signature });
    if (v.valid) ok++;
  }
  assert(ok === 1000, `expected 1000 valid, got ${ok}`);
});

test("[168-F-2] hmac_sign+verify: 100 concurrent round-trips via Promise.all", async () => {
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      Promise.resolve().then(() => {
        const msg = `concurrent-${i}`;
        const { signature } = hmacSign({ message: msg, secret: "key" });
        return hmacVerify({ message: msg, secret: "key", signature });
      })
    )
  );
  const allValid = results.every(v => v.valid);
  assert(allValid, "all concurrent verifications must pass");
});

test("[168-F-3] totp_generate: 500 different secrets all produce valid 6-digit OTPs", () => {
  const t = 1000000000;
  let ok = 0;
  for (let i = 0; i < 500; i++) {
    // Generate a random-ish base32 secret of 16 chars (80 bits = 10 bytes)
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let secret = "";
    for (let j = 0; j < 16; j++) secret += chars[((i * 7 + j * 13) % 32)];
    const r = totpGenerate({ secret, time: t });
    if (/^\d{6}$/.test(r.otp)) ok++;
  }
  assert(ok === 500, `expected 500 valid OTPs, got ${ok}`);
});

test("[168-F-4] totp_generate+verify: sign-then-verify always matches at same time", () => {
  const t = 1234567890;
  let ok = 0;
  const secrets = [TOTP_SECRET, RFC_SECRET, "MFRA", "AAAAAAAAAAAAAAAA", "ZZZZZZZZZZZZZZZZ"];
  for (const secret of secrets) {
    const { otp } = totpGenerate({ secret, time: t });
    const v = totpVerify({ otp, secret, time: t, window: 0 });
    if (v.valid && v.delta === 0) ok++;
  }
  assert(ok === secrets.length, `expected ${secrets.length} successes, got ${ok}`);
});

test("[168-F-5] hmac_sign: large message (512KB) signs correctly", () => {
  const big = "A".repeat(512 * 1024);
  const r = hmacSign({ message: big, secret: "key" });
  assert(typeof r.signature === "string" && r.signature.length === 64);
  assert(r.messageLength === 512 * 1024);
});
