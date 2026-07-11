"use strict";
// ── JWT_SIGN / JWT_VERIFY — HMAC and RSA/EC JWT signing + verification ────────
// Uses Node.js built-in `crypto` only — zero npm dependencies.
// Supports HS256/HS384/HS512 (symmetric HMAC) and
//           RS256/RS384/RS512 (RSA PKCS#1 v1.5) and
//           ES256/ES384/ES512 (ECDSA).
//
// SECURITY NOTE: Always use a secret/key that is long and random for HS*,
// or a proper RSA/EC private key PEM for RS*/ES*. Short secrets are
// vulnerable to brute-force. For production use a dedicated library like
// `jsonwebtoken` which has undergone more security auditing.

const crypto = require("crypto");
const { ToolError } = require("./errors");

const SUPPORTED_ALGORITHMS = ["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256", "ES384", "ES512"];

const ALG_TO_HASH = {
  HS256: "sha256", HS384: "sha384", HS512: "sha512",
  RS256: "sha256", RS384: "sha384", RS512: "sha512",
  ES256: "sha256", ES384: "sha384", ES512: "sha512",
};

const MAX_PAYLOAD_KEYS  = 200;
const MAX_SECRET_LENGTH = 65536; // 64 KB — guard against absurdly large PEM blobs

// ── Encoding helpers ──────────────────────────────────────────────────────────

function b64urlEncode(buf) {
  return buf.toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str))
    throw new ToolError("jwt: segment contains characters outside the base64url alphabet.", -32602);
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad === 1) throw new ToolError("jwt: invalid base64url segment length.", -32602);
  return Buffer.from(s, "base64");
}

// ── Time helper ───────────────────────────────────────────────────────────────

function parseTimeDelta(val, fieldName) {
  if (typeof val === "number") {
    if (!Number.isFinite(val)) throw new ToolError(`jwt_sign: '${fieldName}' must be a finite number.`, -32602);
    return val;
  }
  if (typeof val !== "string")
    throw new ToolError(`jwt_sign: '${fieldName}' must be a number (seconds) or string like '1h', '30m', '7d', '90s'.`, -32602);
  const m = val.match(/^(-?)(\d+)([smhdw])$/i);
  if (!m)
    throw new ToolError(`jwt_sign: invalid time format '${val}' for '${fieldName}'. Use seconds (number) or e.g. '1h', '30m', '7d', '90s', '2w'.`, -32602);
  const sign   = m[1] === "-" ? -1 : 1;
  const n      = parseInt(m[2], 10);
  const unit   = m[3].toLowerCase();
  const UNITS  = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return sign * n * UNITS[unit];
}

// ── Signing ───────────────────────────────────────────────────────────────────

function signSegments(alg, signingInput, secret) {
  const hash = ALG_TO_HASH[alg];
  if (alg.startsWith("HS")) {
    const hmac = crypto.createHmac(hash, secret);
    hmac.update(signingInput);
    return b64urlEncode(hmac.digest());
  }
  // RS* / ES*
  try {
    const signer = crypto.createSign(hash);
    signer.update(signingInput);
    const sig = signer.sign(secret); // PEM string
    return b64urlEncode(sig);
  } catch (e) {
    throw new ToolError(
      `jwt_sign: signing with algorithm ${alg} failed: ${e.message}. ` +
      `For RS*/ES* 'secret' must be a valid PEM private key (e.g. RSA private key for RS*, EC private key for ES*).`,
      -32602
    );
  }
}

// ── Public API: jwt_sign ──────────────────────────────────────────────────────

function jwtSign({
  payload,
  secret,
  algorithm,
  expires_in,
  not_before,
  issuer,
  subject,
  audience,
  jwt_id,
  extra_header,
}) {
  // ── Validate inputs ───────────────────────────────────────────────────────
  if (payload == null || typeof payload !== "object" || Array.isArray(payload))
    throw new ToolError("jwt_sign: 'payload' must be a non-null JSON object.", -32602);
  if (Object.keys(payload).length > MAX_PAYLOAD_KEYS)
    throw new ToolError(`jwt_sign: 'payload' exceeds maximum of ${MAX_PAYLOAD_KEYS} keys.`, -32602);

  if (typeof secret !== "string" || secret.length === 0)
    throw new ToolError("jwt_sign: 'secret' is required and must be a non-empty string (base64-decodable secret for HS*, or PEM private key for RS*/ES*).", -32602);
  if (secret.length > MAX_SECRET_LENGTH)
    throw new ToolError(`jwt_sign: 'secret' exceeds maximum length of ${MAX_SECRET_LENGTH} characters.`, -32602);

  const alg = (algorithm || "HS256").toUpperCase();
  if (!SUPPORTED_ALGORITHMS.includes(alg))
    throw new ToolError(`jwt_sign: unsupported algorithm '${algorithm}'. Supported: ${SUPPORTED_ALGORITHMS.join(", ")}.`, -32602);

  if (extra_header != null && (typeof extra_header !== "object" || Array.isArray(extra_header)))
    throw new ToolError("jwt_sign: 'extra_header' must be a plain object if provided.", -32602);

  // ── Build header ──────────────────────────────────────────────────────────
  const header = { alg, typ: "JWT", ...extra_header };

  // ── Build claims ──────────────────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = { iat: nowSec, ...payload };

  if (expires_in  != null) claims.exp = nowSec + parseTimeDelta(expires_in,  "expires_in");
  if (not_before  != null) claims.nbf = nowSec + parseTimeDelta(not_before,  "not_before");
  if (issuer      != null) { if (typeof issuer  !== "string") throw new ToolError("jwt_sign: 'issuer' must be a string.",   -32602); claims.iss = issuer; }
  if (subject     != null) { if (typeof subject !== "string") throw new ToolError("jwt_sign: 'subject' must be a string.",  -32602); claims.sub = subject; }
  if (audience    != null) {
    if (typeof audience !== "string" && !Array.isArray(audience))
      throw new ToolError("jwt_sign: 'audience' must be a string or array of strings.", -32602);
    claims.aud = audience;
  }
  if (jwt_id != null) { if (typeof jwt_id !== "string") throw new ToolError("jwt_sign: 'jwt_id' must be a string.", -32602); claims.jti = jwt_id; }

  // ── Encode and sign ───────────────────────────────────────────────────────
  const headerSeg  = b64urlEncode(Buffer.from(JSON.stringify(header)));
  const payloadSeg = b64urlEncode(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const sigSeg     = signSegments(alg, signingInput, secret);
  const token      = `${signingInput}.${sigSeg}`;

  return {
    token,
    algorithm: alg,
    header,
    payload: claims,
    issuedAt: new Date(nowSec * 1000).toISOString(),
    expiresAt: claims.exp != null ? new Date(claims.exp * 1000).toISOString() : null,
  };
}

// ── Public API: jwt_verify ────────────────────────────────────────────────────

function jwtVerify({
  token,
  secret,
  algorithms,
  ignore_expiration = false,
  ignore_not_before = false,
  issuer,
  audience,
}) {
  // ── Validate inputs ───────────────────────────────────────────────────────
  if (typeof token !== "string" || !token.trim())
    throw new ToolError("jwt_verify: 'token' is required and must be a non-empty string.", -32602);
  if (typeof secret !== "string" || !secret.trim())
    throw new ToolError("jwt_verify: 'secret' is required and must be a non-empty string.", -32602);
  if (secret.length > MAX_SECRET_LENGTH)
    throw new ToolError(`jwt_verify: 'secret' exceeds maximum length of ${MAX_SECRET_LENGTH} characters.`, -32602);

  const allowedAlgs = algorithms?.length
    ? algorithms.map(a => {
        if (typeof a !== "string") throw new ToolError("jwt_verify: 'algorithms' must be an array of strings.", -32602);
        const u = a.toUpperCase();
        if (!SUPPORTED_ALGORITHMS.includes(u))
          throw new ToolError(`jwt_verify: unsupported algorithm '${a}' in 'algorithms'. Supported: ${SUPPORTED_ALGORITHMS.join(", ")}.`, -32602);
        return u;
      })
    : SUPPORTED_ALGORITHMS;

  // ── Parse token ───────────────────────────────────────────────────────────
  const trimmed = token.trim();
  if (trimmed.length > 65536)
    throw new ToolError("jwt_verify: token exceeds maximum allowed length.", -32602);

  const parts = trimmed.split(".");
  if (parts.length !== 3)
    return _fail(`expected 3 dot-separated segments, got ${parts.length}.`, null, null);

  const [headerSeg, payloadSeg, sigSeg] = parts;

  let header;
  try {
    header = JSON.parse(b64urlDecode(headerSeg).toString("utf8"));
  } catch (e) {
    return _fail(`header decode failed: ${e.message}`, null, null);
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadSeg).toString("utf8"));
  } catch (e) {
    return _fail(`payload decode failed: ${e.message}`, header, null);
  }

  // ── Algorithm check ───────────────────────────────────────────────────────
  const alg = typeof header.alg === "string" ? header.alg.toUpperCase() : null;
  if (!alg)
    return _fail("header missing 'alg' field.", header, payload);
  if (!SUPPORTED_ALGORITHMS.includes(alg))
    return _fail(`algorithm '${header.alg}' is not supported by this tool. Supported: ${SUPPORTED_ALGORITHMS.join(", ")}.`, header, payload);
  if (!allowedAlgs.includes(alg))
    return _fail(`algorithm '${header.alg}' not in allowed list [${allowedAlgs.join(", ")}].`, header, payload);

  // ── Signature verification ────────────────────────────────────────────────
  const signingInput = `${headerSeg}.${payloadSeg}`;
  let sigValid = false;
  try {
    sigValid = verifySignature(alg, signingInput, sigSeg, secret);
  } catch (e) {
    return _fail(`signature check error: ${e.message}`, header, payload);
  }
  if (!sigValid)
    return _fail("signature verification failed — token was tampered with or wrong secret/key.", header, payload);

  // ── Time claims ───────────────────────────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  if (!ignore_expiration && typeof payload.exp === "number") {
    if (payload.exp < nowSec)
      return _fail(`token expired at ${new Date(payload.exp * 1000).toISOString()}.`, header, payload);
  }
  if (!ignore_not_before && typeof payload.nbf === "number") {
    if (payload.nbf > nowSec)
      return _fail(`token not valid before ${new Date(payload.nbf * 1000).toISOString()}.`, header, payload);
  }

  // ── Standard claim checks ─────────────────────────────────────────────────
  if (issuer != null) {
    if (payload.iss !== issuer)
      return _fail(`issuer mismatch: expected '${issuer}', got '${payload.iss}'.`, header, payload);
  }
  if (audience != null) {
    const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const wantAud  = Array.isArray(audience)    ? audience    : [audience];
    if (!wantAud.some(a => tokenAud.includes(a)))
      return _fail(`audience mismatch: expected [${wantAud.join(", ")}], token has [${tokenAud.join(", ")}].`, header, payload);
  }

  return {
    valid: true,
    algorithm: alg,
    header,
    payload,
    issuedAt:  typeof payload.iat === "number" ? new Date(payload.iat * 1000).toISOString() : null,
    expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null,
    error: null,
  };
}

function _fail(msg, header, payload) {
  return { valid: false, error: msg, header: header ?? null, payload: payload ?? null };
}

function verifySignature(alg, input, sigSeg, secret) {
  let sigBuf;
  try { sigBuf = b64urlDecode(sigSeg); } catch (e) { return false; }

  if (alg.startsWith("HS")) {
    const hash     = ALG_TO_HASH[alg];
    const expected = crypto.createHmac(hash, secret).update(input).digest();
    if (expected.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expected, sigBuf); // constant-time compare
  }
  // RS* / ES*
  try {
    const hash   = ALG_TO_HASH[alg];
    const verify = crypto.createVerify(hash);
    verify.update(input);
    return verify.verify(secret, sigBuf);
  } catch (e) {
    throw new ToolError(`key error during ${alg} verification: ${e.message}`, -32602);
  }
}

module.exports = { jwtSign, jwtVerify };
