"use strict";
/**
 * test/sections/166-jwt-sign-verify.js
 * Isolated functional tests for jwt_sign and jwt_verify tools.
 * Section [166] — 5 rigor levels.
 */

const { test } = require("../test-harness");
const { jwtSign, jwtVerify } = require("../../lib/jwtSignOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ── helpers ──────────────────────────────────────────────────────────────────
const SECRET = "super-secret-key-for-tests-only-at-least-256-bits";

function b64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// [166-A] NORMAL — happy-path sign & verify
// ─────────────────────────────────────────────────────────────────────────────
test("[166-A-1] jwt_sign: returns token with three dot-separated segments", () => {
  const r = jwtSign({ payload: { sub: "u1" }, secret: SECRET });
  assert(typeof r.token === "string" && r.token.split(".").length === 3);
});

test("[166-A-2] jwt_sign: default algorithm is HS256", () => {
  const r = jwtSign({ payload: { sub: "u1" }, secret: SECRET });
  assert(r.algorithm === "HS256" && r.header.alg === "HS256");
});

test("[166-A-3] jwt_sign: iat claim auto-set within 5s of now", () => {
  const before = Math.floor(Date.now() / 1000);
  const r = jwtSign({ payload: { sub: "u1" }, secret: SECRET });
  const after = Math.floor(Date.now() / 1000);
  assert(r.payload.iat >= before && r.payload.iat <= after + 1);
});

test("[166-A-4] jwt_sign: expires_in string '1h' sets exp +3600s", () => {
  const before = Math.floor(Date.now() / 1000);
  const r = jwtSign({ payload: { sub: "u1" }, secret: SECRET, expires_in: "1h" });
  assert(r.payload.exp >= before + 3595 && r.payload.exp <= before + 3605);
  assert(typeof r.expiresAt === "string");
});

test("[166-A-5] jwt_sign: expires_in number (seconds) sets exp", () => {
  const before = Math.floor(Date.now() / 1000);
  const r = jwtSign({ payload: {}, secret: SECRET, expires_in: 300 });
  assert(r.payload.exp >= before + 295 && r.payload.exp <= before + 305);
});

test("[166-A-6] jwt_sign: issuer / subject / audience / jwt_id claims set correctly", () => {
  const r = jwtSign({
    payload: {},
    secret: SECRET,
    issuer: "api.example.com",
    subject: "user:42",
    audience: ["svc-a", "svc-b"],
    jwt_id: "tok-abc",
  });
  assert(r.payload.iss === "api.example.com");
  assert(r.payload.sub === "user:42");
  assert(Array.isArray(r.payload.aud) && r.payload.aud.includes("svc-a"));
  assert(r.payload.jti === "tok-abc");
});

test("[166-A-7] jwt_sign: extra_header merges into JOSE header", () => {
  const r = jwtSign({ payload: {}, secret: SECRET, extra_header: { kid: "key-1", x5t: "abc" } });
  assert(r.header.kid === "key-1" && r.header.x5t === "abc");
});

test("[166-A-8] jwt_verify: valid HS256 token returns valid:true", () => {
  const { token } = jwtSign({ payload: { sub: "u1", role: "admin" }, secret: SECRET });
  const v = jwtVerify({ token, secret: SECRET });
  assert(v.valid === true && v.payload.sub === "u1" && v.payload.role === "admin");
});

test("[166-A-9] jwt_verify: HS384 round-trip", () => {
  const { token } = jwtSign({ payload: { x: 1 }, secret: SECRET, algorithm: "HS384" });
  const v = jwtVerify({ token, secret: SECRET, algorithms: ["HS384"] });
  assert(v.valid === true && v.algorithm === "HS384");
});

test("[166-A-10] jwt_verify: HS512 round-trip", () => {
  const { token } = jwtSign({ payload: { x: 1 }, secret: SECRET, algorithm: "HS512" });
  const v = jwtVerify({ token, secret: SECRET, algorithms: ["HS512"] });
  assert(v.valid === true && v.algorithm === "HS512");
});

// ─────────────────────────────────────────────────────────────────────────────
// [166-B] MEDIUM — validation for empty/invalid inputs
// ─────────────────────────────────────────────────────────────────────────────
test("[166-B-1] jwt_sign: missing payload throws ToolError", () => {
  let threw = false;
  try { jwtSign({ payload: null, secret: SECRET }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-B-2] jwt_sign: array payload throws ToolError", () => {
  let threw = false;
  try { jwtSign({ payload: [1, 2], secret: SECRET }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-B-3] jwt_sign: empty secret throws ToolError", () => {
  let threw = false;
  try { jwtSign({ payload: {}, secret: "" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-B-4] jwt_sign: unsupported algorithm throws ToolError", () => {
  let threw = false;
  try { jwtSign({ payload: {}, secret: SECRET, algorithm: "NONE" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-B-5] jwt_sign: invalid expires_in string throws ToolError", () => {
  let threw = false;
  try { jwtSign({ payload: {}, secret: SECRET, expires_in: "banana" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-B-6] jwt_sign: non-finite expires_in number throws ToolError", () => {
  let threw = false;
  try { jwtSign({ payload: {}, secret: SECRET, expires_in: Infinity }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-B-7] jwt_verify: wrong secret returns valid:false", () => {
  const { token } = jwtSign({ payload: { x: 1 }, secret: SECRET });
  const v = jwtVerify({ token, secret: "wrong-secret" });
  assert(v.valid === false && typeof v.error === "string" && v.error.length > 0);
});

test("[166-B-8] jwt_verify: tampered payload returns valid:false", () => {
  const { token } = jwtSign({ payload: { role: "user" }, secret: SECRET });
  // flip one character in the payload segment
  const parts = token.split(".");
  parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === "A" ? "B" : "A");
  const tampered = parts.join(".");
  const v = jwtVerify({ token: tampered, secret: SECRET });
  assert(v.valid === false);
});

test("[166-B-9] jwt_verify: algorithm not in allowed list returns valid:false", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, algorithm: "HS256" });
  const v = jwtVerify({ token, secret: SECRET, algorithms: ["HS512"] });
  assert(v.valid === false && /not in allowed/.test(v.error));
});

test("[166-B-10] jwt_verify: missing token throws ToolError", () => {
  let threw = false;
  try { jwtVerify({ token: "", secret: SECRET }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-B-11] jwt_verify: missing secret throws ToolError", () => {
  let threw = false;
  try { jwtVerify({ token: "a.b.c", secret: "" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-B-12] jwt_verify: token with only 2 segments returns valid:false", () => {
  const v = jwtVerify({ token: "aaa.bbb", secret: SECRET });
  assert(v.valid === false);
});

// ─────────────────────────────────────────────────────────────────────────────
// [166-C] HIGH — time-claim and claim-check logic
// ─────────────────────────────────────────────────────────────────────────────
test("[166-C-1] jwt_verify: expired token returns valid:false by default", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, expires_in: -1 }); // already expired
  const v = jwtVerify({ token, secret: SECRET });
  assert(v.valid === false && /expired/.test(v.error));
});

test("[166-C-2] jwt_verify: expired token accepted with ignore_expiration:true", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, expires_in: -1 });
  const v = jwtVerify({ token, secret: SECRET, ignore_expiration: true });
  assert(v.valid === true);
});

test("[166-C-3] jwt_verify: nbf in the future returns valid:false", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, not_before: 3600 }); // valid 1h from now
  const v = jwtVerify({ token, secret: SECRET });
  assert(v.valid === false && /not valid before/.test(v.error));
});

test("[166-C-4] jwt_verify: nbf in the future accepted with ignore_not_before:true", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, not_before: 3600 });
  const v = jwtVerify({ token, secret: SECRET, ignore_not_before: true });
  assert(v.valid === true);
});

test("[166-C-5] jwt_verify: issuer mismatch returns valid:false", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, issuer: "good.example.com" });
  const v = jwtVerify({ token, secret: SECRET, issuer: "evil.example.com" });
  assert(v.valid === false && /issuer mismatch/.test(v.error));
});

test("[166-C-6] jwt_verify: correct issuer passes", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, issuer: "api.example.com" });
  const v = jwtVerify({ token, secret: SECRET, issuer: "api.example.com" });
  assert(v.valid === true);
});

test("[166-C-7] jwt_verify: audience mismatch returns valid:false", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, audience: "svc-a" });
  const v = jwtVerify({ token, secret: SECRET, audience: "svc-b" });
  assert(v.valid === false && /audience mismatch/.test(v.error));
});

test("[166-C-8] jwt_verify: audience array overlap passes", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, audience: ["svc-a", "svc-b"] });
  const v = jwtVerify({ token, secret: SECRET, audience: ["svc-b", "svc-c"] });
  assert(v.valid === true);
});

test("[166-C-9] jwt_sign: '7d' time string sets exp +604800s", () => {
  const before = Math.floor(Date.now() / 1000);
  const r = jwtSign({ payload: {}, secret: SECRET, expires_in: "7d" });
  assert(r.payload.exp >= before + 604795 && r.payload.exp <= before + 604805);
});

test("[166-C-10] jwt_sign: '2w' time string sets exp +1209600s", () => {
  const before = Math.floor(Date.now() / 1000);
  const r = jwtSign({ payload: {}, secret: SECRET, expires_in: "2w" });
  assert(r.payload.exp >= before + 1209595 && r.payload.exp <= before + 1209605);
});

// ─────────────────────────────────────────────────────────────────────────────
// [166-D] CRITICAL — injection / boundary safety
// ─────────────────────────────────────────────────────────────────────────────
test("[166-D-1] jwt_sign: Unicode payload values round-trip correctly", () => {
  const payload = { msg: "\u4e2d\u6587 emoji \uD83D\uDE00", tab: "\t", newline: "\n" };
  const { token } = jwtSign({ payload, secret: SECRET });
  const v = jwtVerify({ token, secret: SECRET });
  assert(v.valid && v.payload.msg === payload.msg && v.payload.tab === "\t");
});

test("[166-D-2] jwt_sign: payload with 200 keys stays under limit", () => {
  const payload = {};
  for (let i = 0; i < 200; i++) payload[`k${i}`] = i;
  const r = jwtSign({ payload, secret: SECRET });
  assert(typeof r.token === "string");
});

test("[166-D-3] jwt_sign: payload with 201 keys throws ToolError", () => {
  const payload = {};
  for (let i = 0; i <= 200; i++) payload[`k${i}`] = i;
  let threw = false;
  try { jwtSign({ payload, secret: SECRET }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-D-4] jwt_verify: token exceeding 65536 chars throws ToolError", () => {
  let threw = false;
  try { jwtVerify({ token: "a".repeat(65537), secret: SECRET }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-D-5] jwt_sign: extra_header cannot be an array", () => {
  let threw = false;
  try { jwtSign({ payload: {}, secret: SECRET, extra_header: [1, 2] }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-D-6] jwt_verify: base64url segment with illegal chars returns valid:false", () => {
  // insert a space which is illegal in base64url
  const { token } = jwtSign({ payload: { x: 1 }, secret: SECRET });
  const parts = token.split(".");
  const v = jwtVerify({ token: parts[0] + ".hel lo." + parts[2], secret: SECRET });
  assert(v.valid === false);
});

test("[166-D-7] jwt_sign: issuer must be string or throws", () => {
  let threw = false;
  try { jwtSign({ payload: {}, secret: SECRET, issuer: 123 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[166-D-8] jwt_verify: unsupported algorithm in 'algorithms' array throws ToolError", () => {
  let threw = false;
  try { jwtVerify({ token: "a.b.c", secret: SECRET, algorithms: ["MD5"] }); } catch (e) { threw = true; }
  assert(threw);
});

// ─────────────────────────────────────────────────────────────────────────────
// [166-E] EXTREME — concurrency and throughput
// ─────────────────────────────────────────────────────────────────────────────
test("[166-E-1] jwt_sign+verify: 500 sequential HS256 round-trips all valid", () => {
  let ok = 0;
  for (let i = 0; i < 500; i++) {
    const { token } = jwtSign({ payload: { i }, secret: SECRET, expires_in: 60 });
    const v = jwtVerify({ token, secret: SECRET });
    if (v.valid && v.payload.i === i) ok++;
  }
  assert(ok === 500, `expected 500 valid tokens, got ${ok}`);
});

test("[166-E-2] jwt_sign+verify: 100 concurrent round-trips via Promise.all", async () => {
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) => Promise.resolve().then(() => {
      const { token } = jwtSign({ payload: { i }, secret: SECRET });
      return jwtVerify({ token, secret: SECRET });
    }))
  );
  const allValid = results.every(v => v.valid);
  assert(allValid, "some tokens failed verification in concurrent batch");
});

test("[166-E-3] jwt_sign: large payload (1KB string value) round-trips", () => {
  const bigVal = "x".repeat(1024);
  const { token } = jwtSign({ payload: { data: bigVal }, secret: SECRET });
  const v = jwtVerify({ token, secret: SECRET });
  assert(v.valid && v.payload.data === bigVal);
});

test("[166-E-4] jwt_verify: all-algorithms rejection with empty algorithms array behaves as allow-all", () => {
  // algorithms: [] should default to allowing all supported
  const { token } = jwtSign({ payload: { x: 1 }, secret: SECRET, algorithm: "HS384" });
  const v = jwtVerify({ token, secret: SECRET, algorithms: [] });
  assert(v.valid === true);
});

test("[166-E-5] jwt_sign: negative expires_in (already expired) round-trips and returns expired", () => {
  const { token } = jwtSign({ payload: {}, secret: SECRET, expires_in: -10 });
  const v = jwtVerify({ token, secret: SECRET });
  assert(v.valid === false && /expired/.test(v.error));
  // but payload is still decoded and returned
  assert(typeof v.payload.exp === "number" && v.payload.exp < Math.floor(Date.now() / 1000));
});
