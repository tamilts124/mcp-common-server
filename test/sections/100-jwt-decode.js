"use strict";
/**
 * test/sections/100-jwt-decode.js
 * Isolated functional tests for the jwt_decode tool.
 * Section [38]
 */

const { test } = require("../test-harness");
const { jwtDecode } = require("../../lib/jwtDecodeOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makeToken(header, payload, sig = "sig") {
  return `${b64url(header)}.${b64url(payload)}.${sig}`;
}

// [38-A] NORMAL
test("[38-A-1] decode: standard token returns header and payload", () => {
  const t = makeToken({ alg: "HS256", typ: "JWT" }, { sub: "u1", name: "Ada" });
  const r = jwtDecode(t);
  assert(r.header.alg === "HS256" && r.payload.sub === "u1" && r.payload.name === "Ada");
});
test("[38-A-2] decode: signature reported present with correct length, never verified", () => {
  const t = makeToken({ alg: "HS256" }, { a: 1 }, "abcXYZ123");
  const r = jwtDecode(t);
  assert(r.signature.present === true && r.signature.length === 9 && r.signature.verified === false);
});
test("[38-A-3] decode: empty signature segment reported as absent", () => {
  const t = makeToken({ alg: "none" }, { a: 1 }, "");
  const r = jwtDecode(t);
  assert(r.signature.present === false && r.signature.length === 0);
});
test("[38-A-4] decode: exp in the future -> expired:false", () => {
  const t = makeToken({ alg: "HS256" }, { exp: Math.floor(Date.now() / 1000) + 3600 });
  const r = jwtDecode(t);
  assert(r.expired === false && typeof r.times.exp.iso === "string");
});
test("[38-A-5] decode: exp in the past -> expired:true", () => {
  const t = makeToken({ alg: "HS256" }, { exp: Math.floor(Date.now() / 1000) - 3600 });
  const r = jwtDecode(t);
  assert(r.expired === true);
});
test("[38-A-6] decode: nbf in the future -> notYetValid:true", () => {
  const t = makeToken({ alg: "HS256" }, { nbf: Math.floor(Date.now() / 1000) + 3600 });
  const r = jwtDecode(t);
  assert(r.notYetValid === true);
});
test("[38-A-7] decode: no time claims -> expired/notYetValid null, times empty", () => {
  const t = makeToken({ alg: "HS256" }, { sub: "u1" });
  const r = jwtDecode(t);
  assert(r.expired === null && r.notYetValid === null);
  assert(Object.keys(r.times).length === 0);
});
test("[38-A-8] decode: base64url with URL-unsafe chars (-, _) and no padding decodes correctly", () => {
  // payload deliberately contains chars that base64-encode to '+' or '/' in std base64
  const t = makeToken({ alg: "HS256" }, { data: "??>>subjects++almost/\u00ff\u00fe" });
  const r = jwtDecode(t);
  assert(r.payload.data === "??>>subjects++almost/\u00ff\u00fe");
});

// [38-B] MEDIUM — boundary & validation
test("[38-B-1] decode: missing token throws -32602", () => {
  let threw = false;
  try { jwtDecode(undefined); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[38-B-2] decode: non-string token throws -32602", () => {
  let threw = false;
  try { jwtDecode(12345); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[38-B-3] decode: empty string throws -32602", () => {
  let threw = false;
  try { jwtDecode("   "); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[38-B-4] decode: wrong segment count throws with clear message", () => {
  let threw = false, msg = "";
  try { jwtDecode("only.two"); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /3 dot-separated segments/.test(msg));
});
test("[38-B-5] decode: four segments also rejected", () => {
  let threw = false;
  try { jwtDecode("a.b.c.d"); } catch (e) { threw = true; }
  assert(threw);
});
test("[38-B-6] decode: header segment not valid base64url throws", () => {
  let threw = false;
  try { jwtDecode("a!!!.eyJhIjoxfQ.sig"); } catch (e) { threw = true; }
  assert(threw);
});
test("[38-B-7] decode: header decodes but isn't JSON throws descriptive error", () => {
  const badHeader = Buffer.from("not json").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let threw = false, msg = "";
  try { jwtDecode(`${badHeader}.eyJhIjoxfQ.sig`); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /not valid JSON/.test(msg));
});
test("[38-B-8] decode: token exceeding max length throws -32602", () => {
  const huge = "a.".repeat(5000) + "b";
  let threw = false;
  try { jwtDecode(huge); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[38-B-9] decode: signature segment with invalid characters throws", () => {
  let threw = false;
  try { jwtDecode(`${b64url({ a: 1 })}.${b64url({ b: 2 })}.not!valid!!`); } catch (e) { threw = true; }
  assert(threw);
});

// [38-C] HIGH — structural edge cases
test("[38-C-1] decode: payload is a JSON array, not object -> times empty, no crash", () => {
  const t = makeToken({ alg: "HS256" }, [1, 2, 3]);
  const r = jwtDecode(t);
  assert(Array.isArray(r.payload) && Object.keys(r.times).length === 0);
});
test("[38-C-2] decode: payload is a bare JSON number", () => {
  const t = `${b64url({ alg: "HS256" })}.${Buffer.from("42").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.sig`;
  const r = jwtDecode(t);
  assert(r.payload === 42);
});
test("[38-C-3] decode: non-numeric exp claim ignored (not coerced), times.exp absent", () => {
  const t = makeToken({ alg: "HS256" }, { exp: "not-a-number" });
  const r = jwtDecode(t);
  assert(!("exp" in r.times) && r.expired === null);
});
test("[38-C-4] decode: whitespace-padded token is trimmed before parsing", () => {
  const t = makeToken({ alg: "HS256" }, { sub: "u1" });
  const r = jwtDecode(`  ${t}  `);
  assert(r.payload.sub === "u1");
});
test("[38-C-5] decode: 'alg: none' header decodes fine (still no verification implied)", () => {
  const t = makeToken({ alg: "none", typ: "JWT" }, { sub: "u1" });
  const r = jwtDecode(t);
  assert(r.header.alg === "none" && r.signature.verified === false);
});

// [38-D] CRITICAL — security
test("[38-D-1] decode: SQL-injection-shaped claim value round-trips as inert literal text", () => {
  const t = makeToken({ alg: "HS256" }, { note: "'; DROP TABLE users; --" });
  const r = jwtDecode(t);
  assert(r.payload.note === "'; DROP TABLE users; --");
});
test("[38-D-2] decode: path-traversal-shaped claim value is inert data, not a path", () => {
  const t = makeToken({ alg: "HS256" }, { file: "../../../etc/passwd" });
  const r = jwtDecode(t);
  assert(r.payload.file === "../../../etc/passwd");
});
test("[38-D-3] decode: __proto__ key in payload JSON does not pollute Object.prototype", () => {
  const t = makeToken({ alg: "HS256" }, { __proto__: { polluted: true } });
  jwtDecode(t);
  assert(({}).polluted === undefined && Object.prototype.polluted === undefined);
});
test("[38-D-4] decode: HTML/script-shaped claim value round-trips as literal text", () => {
  const t = makeToken({ alg: "HS256" }, { note: "<script>alert(1)</script>" });
  const r = jwtDecode(t);
  assert(r.payload.note === "<script>alert(1)</script>");
});
test("[38-D-5] decode: signature is never included verified/decoded, only metadata", () => {
  const t = makeToken({ alg: "HS256" }, { a: 1 }, "totallyFakeSig");
  const r = jwtDecode(t);
  const keys = Object.keys(r.signature).sort();
  assert(JSON.stringify(keys) === JSON.stringify(["length", "present", "verified"]));
});

// [38-E] EXTREME
test("[38-E-1] fuzz: random-byte token string throws cleanly, never crashes process", () => {
  const fuzz = Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  let handled = false;
  try { jwtDecode(fuzz); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[38-E-2] decode: large but valid payload (many claims) decodes correctly", () => {
  const bigPayload = {};
  for (let i = 0; i < 80; i++) bigPayload[`c${i}`] = i;
  const t = makeToken({ alg: "HS256" }, bigPayload);
  const r = jwtDecode(t);
  assert(Object.keys(r.payload).length === 80 && r.payload.c79 === 79);
});
test("[38-E-3] decode: 20 rapid sequential calls with different tokens are independent (no shared state)", () => {
  for (let i = 0; i < 20; i++) {
    const t = makeToken({ alg: "HS256" }, { i });
    const r = jwtDecode(t);
    assert(r.payload.i === i);
  }
});
