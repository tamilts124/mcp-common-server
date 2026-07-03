"use strict";
// ── JWT_DECODE — decode a JWT's header/payload without verifying it ───────
// Pure computation, no fs/exec. NOT a security tool: the signature segment
// is never checked, so a decoded payload must never be trusted as
// authenticated. Useful for dev-time inspection of a token you already
// have (checking claims, expiry) before/without a verifying library.

const { ToolError } = require("./errors");

const MAX_TOKEN_LENGTH = 8000;

function base64UrlDecode(segment, label) {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new ToolError(`jwt_decode: token is missing its ${label} segment.`, -32602);
  }
  // base64url -> base64, restore padding.
  let b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  else if (pad === 1) {
    throw new ToolError(`jwt_decode: token's ${label} segment is not valid base64url.`, -32602);
  }
  let buf;
  try {
    buf = Buffer.from(b64, "base64");
  } catch (e) {
    throw new ToolError(`jwt_decode: failed to base64url-decode the ${label} segment: ${e.message}`, -32602);
  }
  return buf;
}

function parseJsonSegment(buf, label) {
  let text;
  try {
    text = buf.toString("utf8");
  } catch (e) {
    throw new ToolError(`jwt_decode: ${label} segment is not valid UTF-8.`, -32602);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ToolError(`jwt_decode: ${label} segment is not valid JSON: ${e.message}`, -32602);
  }
}

// Claims that carry NumericDate (seconds since epoch) semantics per RFC 7519.
const TIME_CLAIMS = ["exp", "iat", "nbf"];

function annotateTimes(payload) {
  const times = {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return times;
  for (const claim of TIME_CLAIMS) {
    const v = payload[claim];
    if (typeof v === "number" && Number.isFinite(v)) {
      const d = new Date(v * 1000);
      times[claim] = { raw: v, iso: isNaN(d.getTime()) ? null : d.toISOString() };
    }
  }
  return times;
}

/**
 * Decode a JWT's header and payload (base64url JSON). The signature segment
 * is only reported as present/length — it is never verified or decoded,
 * since a JWT signature is not itself base64url(JSON).
 *
 * @param {string} token  The raw JWT (three dot-separated segments).
 */
function jwtDecode(token) {
  if (typeof token !== "string" || token.trim() === "") {
    throw new ToolError("jwt_decode: 'token' is required and must be a non-empty string.", -32602);
  }
  const trimmed = token.trim();
  if (trimmed.length > MAX_TOKEN_LENGTH) {
    throw new ToolError(`jwt_decode: token exceeds max length of ${MAX_TOKEN_LENGTH} characters.`, -32602);
  }

  const parts = trimmed.split(".");
  if (parts.length !== 3) {
    throw new ToolError(`jwt_decode: expected 3 dot-separated segments (header.payload.signature), got ${parts.length}.`, -32602);
  }
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  const header  = parseJsonSegment(base64UrlDecode(headerSeg, "header"), "header");
  const payload = parseJsonSegment(base64UrlDecode(payloadSeg, "payload"), "payload");

  if (signatureSeg.length > 0 && !/^[A-Za-z0-9_-]+$/.test(signatureSeg)) {
    throw new ToolError("jwt_decode: signature segment contains characters outside the base64url alphabet.", -32602);
  }

  const times = annotateTimes(payload);
  const nowSec = Date.now() / 1000;
  const expired     = typeof times.exp?.raw === "number" ? times.exp.raw < nowSec : null;
  const notYetValid = typeof times.nbf?.raw === "number" ? times.nbf.raw > nowSec : null;

  return {
    header,
    payload,
    signature: { present: signatureSeg.length > 0, length: signatureSeg.length, verified: false },
    times,
    expired,
    notYetValid,
  };
}

module.exports = { jwtDecode };
