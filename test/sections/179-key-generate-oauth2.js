"use strict";
/**
 * Section 179: key_generate + oauth2_token tools
 * All 5 rigor levels across 10 sub-sections (A–J).
 *
 * A: key_generate — input validation
 * B: key_generate — RSA key pairs
 * C: key_generate — EC key pairs
 * D: key_generate — Ed25519/Ed448 key pairs
 * E: key_generate — symmetric keys
 * F: oauth2_token  — input validation
 * G: oauth2_token  — parse_bearer (JWT decode, no network)
 * H: oauth2_token  — formEncode + decodeJwtUnsafe unit tests
 * I: oauth2_token  — live client_credentials against a mock server
 * J: key_generate  — RSA key usability with jwt_sign/jwt_verify
 */

const { counters } = require("../test-harness");
const http = require("http");
const crypto = require("crypto");

const {
  keyGenerate, generateRSA, generateEC, generateEdDSA, generateSymmetric,
} = require("../../lib/keyGenerateOps");

const {
  oauth2Token,
  decodeJwtUnsafe, formEncode,
  parseBearer,
} = require("../../lib/oauth2TokenOps");

const { jwtSign, jwtVerify } = require("../../lib/jwtSignOps");
const { ToolError } = require("../../lib/errors");

function ok(label, pass, detail = "") {
  counters[pass ? "pass" : "fail"]++;
  const sym = pass ? "\u2713" : "\u2717";
  const msg = detail ? `  ${sym} ${label}: ${detail}` : `  ${sym} ${label}`;
  if (!pass) process.stderr.write(msg + "\n");
  else console.log(msg);
}

function throws(fn, msgPart) {
  try { fn(); return false; }
  catch (e) { return !msgPart || e.message.includes(msgPart); }
}

// ──────────────────────────────────────────────────────────────────────────
// [179-A] key_generate: input validation
// ──────────────────────────────────────────────────────────────────────────
console.log("[179-A] key_generate: input validation");

ok("A1: unknown type throws",       throws(() => keyGenerate({ type: "dh" }), "unknown 'type'"));
ok("A2: bad RSA bits throws",       throws(() => keyGenerate({ type: "rsa", bits: 512 }), "invalid RSA 'bits'"));
ok("A3: bad EC curve throws",       throws(() => keyGenerate({ type: "ec", curve: "brainpoolP256r1" }), "invalid EC 'curve'"));
ok("A4: bad sym size throws",       throws(() => keyGenerate({ type: "symmetric", size: 17 }), "invalid symmetric 'size'"));
ok("A5: bad sym encoding throws",   throws(() => keyGenerate({ type: "symmetric", encoding: "latin1" }), "'encoding' must be"));
ok("A6: even RSA exponent throws",  throws(() => keyGenerate({ type: "rsa", public_exponent: 4 }), "public_exponent"));
ok("A7: default type is rsa",       (() => {
  const r = keyGenerate({});
  return r.algorithm === "RSA" && typeof r.privateKeyPem === "string";
})());

// ──────────────────────────────────────────────────────────────────────────
// [179-B] key_generate: RSA key pairs
// ──────────────────────────────────────────────────────────────────────────
console.log("[179-B] key_generate: RSA key pairs");

const rsa2048 = generateRSA({ bits: 2048 });
ok("B1: algorithm=RSA",           rsa2048.algorithm === "RSA");
ok("B2: bits=2048",               rsa2048.bits === 2048);
ok("B3: privateKeyPem is string", typeof rsa2048.privateKeyPem === "string");
ok("B4: privateKey starts PKCS8", rsa2048.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"));
ok("B5: publicKey starts SPKI",   rsa2048.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"));
ok("B6: fingerprint_sha256",      typeof rsa2048.fingerprint_sha256 === "string" && rsa2048.fingerprint_sha256.includes(":"));
ok("B7: fingerprint length",      rsa2048.fingerprint_sha256.split(":").length === 32);
ok("B8: publicExponent=65537",    rsa2048.publicExponent === 65537);

// 1024-bit (fast for testing)
const rsa1024 = generateRSA({ bits: 1024 });
ok("B9: 1024-bit RSA works",      rsa1024.bits === 1024);
ok("B10: keys are different each call", rsa1024.privateKeyPem !== rsa2048.privateKeyPem);

// Private key is parseable by Node crypto
const privKeyObj = crypto.createPrivateKey(rsa2048.privateKeyPem);
ok("B11: privateKey parsed by Node",   privKeyObj.type === "private");
const pubKeyObj = crypto.createPublicKey(rsa2048.publicKeyPem);
ok("B12: publicKey parsed by Node",    pubKeyObj.type === "public");
ok("B13: key type is rsa",             privKeyObj.asymmetricKeyType === "rsa");

// ──────────────────────────────────────────────────────────────────────────
// [179-C] key_generate: EC key pairs
// ──────────────────────────────────────────────────────────────────────────
console.log("[179-C] key_generate: EC key pairs");

const ecP256 = generateEC({ curve: "P-256" });
ok("C1: algorithm=EC",          ecP256.algorithm === "EC");
ok("C2: curve=P-256",           ecP256.curve === "P-256");
ok("C3: privateKeyPem present", ecP256.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"));
ok("C4: publicKeyPem present",  ecP256.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"));
ok("C5: fingerprint present",   typeof ecP256.fingerprint_sha256 === "string");

const ecP384 = generateEC({ curve: "P-384" });
ok("C6: P-384 works",           ecP384.curve === "P-384");
const ecP521 = generateEC({ curve: "P-521" });
ok("C7: P-521 works",           ecP521.curve === "P-521");
const ecK1   = generateEC({ curve: "secp256k1" });
ok("C8: secp256k1 works",       ecK1.curve === "secp256k1");

// Keys are parseable
const ecPriv = crypto.createPrivateKey(ecP256.privateKeyPem);
ok("C9: EC private parseable",  ecPriv.asymmetricKeyType === "ec");

// Default curve is P-256
const ecDefault = generateEC({});
ok("C10: default curve P-256",  ecDefault.curve === "P-256");

// ──────────────────────────────────────────────────────────────────────────
// [179-D] key_generate: Ed25519 / Ed448
// ──────────────────────────────────────────────────────────────────────────
console.log("[179-D] key_generate: Ed25519/Ed448");

const ed25519 = generateEdDSA("Ed25519");
ok("D1: Ed25519 algorithm",          ed25519.algorithm === "Ed25519");
ok("D2: Ed25519 privateKey PEM",     ed25519.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"));
ok("D3: Ed25519 publicKey PEM",      ed25519.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"));
ok("D4: Ed25519 fingerprint",        typeof ed25519.fingerprint_sha256 === "string");
ok("D5: Ed25519 type via Node",      crypto.createPrivateKey(ed25519.privateKeyPem).asymmetricKeyType === "ed25519");

const ed448 = generateEdDSA("Ed448");
ok("D6: Ed448 algorithm",            ed448.algorithm === "Ed448");
ok("D7: Ed448 privateKey PEM",       ed448.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"));
ok("D8: Ed448 type via Node",        crypto.createPrivateKey(ed448.privateKeyPem).asymmetricKeyType === "ed448");

// keyGenerate dispatch for ed25519 / ed448
const kgEd = keyGenerate({ type: "ed25519" });
ok("D9: keyGenerate('ed25519')",     kgEd.algorithm === "Ed25519");
const kgEd448 = keyGenerate({ type: "ed448" });
ok("D10: keyGenerate('ed448')",      kgEd448.algorithm === "Ed448");

// ──────────────────────────────────────────────────────────────────────────
// [179-E] key_generate: symmetric keys
// ──────────────────────────────────────────────────────────────────────────
console.log("[179-E] key_generate: symmetric keys");

const sym32 = generateSymmetric({ size: 32 });
ok("E1: algorithm=symmetric",     sym32.algorithm === "symmetric");
ok("E2: bits=256",                sym32.bits === 256);
ok("E3: encoding=hex default",    sym32.encoding === "hex");
ok("E4: key is hex string",       /^[0-9a-f]{64}$/.test(sym32.key));
ok("E5: suggestedPurpose set",    typeof sym32.suggestedPurpose === "string" && sym32.suggestedPurpose.length > 0);

const sym16 = generateSymmetric({ size: 16 });
ok("E6: 16-byte key is 32 hex",   /^[0-9a-f]{32}$/.test(sym16.key));

const sym64b64 = generateSymmetric({ size: 64, encoding: "base64" });
ok("E7: base64 encoding",         sym64b64.encoding === "base64");
ok("E8: base64 length correct",   Buffer.from(sym64b64.key, "base64").length === 64);

const sym32b64u = generateSymmetric({ size: 32, encoding: "base64url" });
ok("E9: base64url no +/=/",       !/[+/=]/.test(sym32b64u.key));
ok("E10: base64url key decodes",  Buffer.from(sym32b64u.key, "base64url").length >= 31);

// Keys are random (two calls give different results)
const sym32b = generateSymmetric({ size: 32 });
ok("E11: keys are unique",        sym32.key !== sym32b.key);

// keyGenerate dispatch for symmetric
const kgSym = keyGenerate({ type: "symmetric", size: 48 });
ok("E12: keyGenerate symmetric",  kgSym.bits === 384);

// ──────────────────────────────────────────────────────────────────────────
// [179-F] oauth2_token: input validation
// ──────────────────────────────────────────────────────────────────────────
console.log("[179-F] oauth2_token: input validation");

async function asyncThrows(fn, msgPart) {
  try { await fn(); return false; }
  catch (e) { return !msgPart || e.message.includes(msgPart); }
}

module.exports = (async () => {
  // Validation tests use asyncThrows
  ok("F1: unknown op throws",
    await asyncThrows(() => oauth2Token({ operation: "device_code" }), "unknown operation"));
  ok("F2: client_credentials missing token_endpoint throws",
    await asyncThrows(() => oauth2Token({ operation: "client_credentials" }), "token_endpoint"));
  ok("F3: client_credentials missing client_id throws",
    await asyncThrows(
      () => oauth2Token({ operation: "client_credentials", token_endpoint: "https://x.example.com/token" }),
      "client_id"
    ));
  ok("F4: password missing username throws",
    await asyncThrows(
      () => oauth2Token({ operation: "password", token_endpoint: "https://x.example.com/token" }),
      "username"
    ));
  ok("F5: password missing password throws",
    await asyncThrows(
      () => oauth2Token({ operation: "password", token_endpoint: "https://x.example.com/token", username: "u" }),
      "password"
    ));
  ok("F6: refresh_token missing refresh_token throws",
    await asyncThrows(
      () => oauth2Token({ operation: "refresh_token", token_endpoint: "https://x.example.com/token" }),
      "refresh_token"
    ));
  ok("F7: token_introspect missing endpoint throws",
    await asyncThrows(
      () => oauth2Token({ operation: "token_introspect" }),
      "introspect_endpoint"
    ));
  ok("F8: token_introspect missing token throws",
    await asyncThrows(
      () => oauth2Token({ operation: "token_introspect", introspect_endpoint: "https://x.example.com/introspect" }),
      "'token' is required"
    ));
  ok("F9: ftp scheme rejected",
    await asyncThrows(
      () => oauth2Token({ operation: "client_credentials", token_endpoint: "ftp://x.example.com/token", client_id: "c" }),
      "http:// or https://"
    ));
  ok("F10: parse_bearer missing token throws",
    await asyncThrows(() => oauth2Token({ operation: "parse_bearer" }), "'token' is required"));

  // ──────────────────────────────────────────────────────────────────────────
  // [179-G] oauth2_token: parse_bearer
  // ──────────────────────────────────────────────────────────────────────────
  console.log("[179-G] oauth2_token: parse_bearer");

  // Build a real JWT with our jwtSign
  const jwtPayload = { sub: "user123", scope: "read write", iss: "test-issuer", aud: "api" };
  const secret = "supersecretkey";
  const signed = jwtSign({ payload: jwtPayload, secret, algorithm: "HS256", expires_in: "1h" });

  const parsed = await oauth2Token({ operation: "parse_bearer", token: signed.token });
  ok("G1: is_jwt=true",         parsed.is_jwt === true);
  ok("G2: payload.sub",         parsed.payload.sub === "user123");
  ok("G3: payload.iss",         parsed.payload.iss === "test-issuer");
  ok("G4: issuedAt present",    typeof parsed.issuedAt === "string");
  ok("G5: expiresAt present",   typeof parsed.expiresAt === "string");
  ok("G6: expired=false",       parsed.expired === false);
  ok("G7: header.alg=HS256",    parsed.header.alg === "HS256");

  // 'Bearer ' prefix stripped automatically
  const withPrefix = await oauth2Token({ operation: "parse_bearer", token: `Bearer ${signed.token}` });
  ok("G8: Bearer prefix stripped", withPrefix.is_jwt === true && withPrefix.payload.sub === "user123");

  // Opaque token (not a JWT)
  const opaque = await oauth2Token({ operation: "parse_bearer", token: "abc123xyz" });
  ok("G9: opaque is_jwt=false",  opaque.is_jwt === false);
  ok("G10: opaque token_type",   opaque.token_type === "opaque");
  ok("G11: opaque length",       opaque.length === 9);

  // Already-expired JWT detection
  const expiredToken = jwtSign({ payload: { sub: "x" }, secret, algorithm: "HS256", expires_in: -1 });
  const expiredParsed = await oauth2Token({ operation: "parse_bearer", token: expiredToken.token });
  ok("G12: expired detected",    expiredParsed.expired === true);

  // ──────────────────────────────────────────────────────────────────────────
  // [179-H] oauth2_token: helper unit tests (formEncode, decodeJwtUnsafe)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("[179-H] formEncode + decodeJwtUnsafe");

  ok("H1: formEncode simple",    formEncode({ a: "1", b: "2" }) === "a=1&b=2");
  ok("H2: formEncode encodes spaces", formEncode({ scope: "read write" }) === "scope=read%20write");
  ok("H3: formEncode encodes &",  formEncode({ x: "a&b" }) === "x=a%26b");
  ok("H4: formEncode empty",      formEncode({}) === "");
  ok("H5: formEncode grant_type", formEncode({ grant_type: "client_credentials" }) === "grant_type=client_credentials");

  ok("H6: decodeJwtUnsafe null on non-string", decodeJwtUnsafe(null) === null);
  ok("H7: decodeJwtUnsafe null on 2-segment",  decodeJwtUnsafe("a.b") === null);
  ok("H8: decodeJwtUnsafe null on bad base64",  decodeJwtUnsafe("!!!.!!!.!!!") === null);

  // Build a test JWT and decode it
  const testToken = jwtSign({ payload: { sub: "u1", foo: "bar" }, secret: "s", algorithm: "HS256" });
  const dec = decodeJwtUnsafe(testToken.token);
  ok("H9: decodeJwtUnsafe header",  dec !== null && dec.header.alg === "HS256");
  ok("H10: decodeJwtUnsafe payload.sub", dec.payload.sub === "u1");
  ok("H11: decodeJwtUnsafe issuedAt",   typeof dec.issuedAt === "string");
  ok("H12: decodeJwtUnsafe expired null (no exp)", dec.expired === null);

  // ──────────────────────────────────────────────────────────────────────────
  // [179-I] oauth2_token: live client_credentials against a mock server
  // ──────────────────────────────────────────────────────────────────────────
  console.log("[179-I] oauth2_token: mock OAuth2 server");

  // Minimal RFC 6749 compliant mock token endpoint
  const mockClients = {
    client1: { secret: "secret1", scope: "read write" },
    publicClient: { secret: null, scope: "read" },
  };

  const mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => { body += d; });
    req.on("end", () => {
      const params = Object.fromEntries(new URLSearchParams(body));

      // Token endpoint: POST /token
      if (req.url === "/token" && req.method === "POST") {
        // Authenticate client
        let clientId = params.client_id;
        let clientSecret = params.client_secret || null;

        // Check Basic auth
        const authHeader = req.headers.authorization || "";
        if (authHeader.startsWith("Basic ")) {
          try {
            const creds = Buffer.from(authHeader.slice(6), "base64").toString();
            const [cId, cSec] = creds.split(":").map(decodeURIComponent);
            clientId = cId;
            clientSecret = cSec || null;
          } catch { /* bad auth */ }
        }

        const client = mockClients[clientId];
        if (!client) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid_client", error_description: "Unknown client" }));
        }
        if (client.secret !== null && client.secret !== clientSecret) {
          res.writeHead(401, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid_client", error_description: "Bad secret" }));
        }

        if (params.grant_type === "client_credentials") {
          const scope = params.scope || client.scope;
          const token = jwtSign({
            payload: { sub: clientId, scope, type: "access_token" },
            secret:  "mocksecret",
            algorithm: "HS256",
            expires_in: "1h",
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            access_token: token.token,
            token_type:   "Bearer",
            expires_in:   3600,
            scope,
          }));
        }

        if (params.grant_type === "refresh_token") {
          if (!params.refresh_token || params.refresh_token !== "mock-refresh-abc") {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "invalid_grant", error_description: "Bad refresh token" }));
          }
          const token = jwtSign({
            payload: { sub: clientId, type: "refreshed_access" },
            secret:  "mocksecret",
            algorithm: "HS256",
            expires_in: "2h",
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ access_token: token.token, token_type: "Bearer", expires_in: 7200 }));
        }

        if (params.grant_type === "password") {
          if (params.username !== "alice" || params.password !== "alicepw") {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "invalid_grant", error_description: "Bad credentials" }));
          }
          const token = jwtSign({
            payload: { sub: params.username, type: "password_access" },
            secret:  "mocksecret",
            algorithm: "HS256",
            expires_in: "30m",
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({
            access_token:  token.token,
            refresh_token: "mock-refresh-abc",
            token_type:    "Bearer",
            expires_in:    1800,
          }));
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      }

      // Introspect endpoint: POST /introspect
      if (req.url === "/introspect" && req.method === "POST") {
        const token = params.token;
        const decoded = decodeJwtUnsafe(token);
        if (!decoded || decoded.expired) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ active: false }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          active:    true,
          sub:       decoded.payload.sub,
          scope:     decoded.payload.scope || "",
          token_type: "Bearer",
          exp:       decoded.payload.exp,
        }));
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const { port } = mockServer.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    // I1-I5: client_credentials (Basic auth)
    const cc = await oauth2Token({
      operation:      "client_credentials",
      token_endpoint: `${base}/token`,
      client_id:      "client1",
      client_secret:  "secret1",
      scope:          "read",
    });
    ok("I1: cc access_token present",   typeof cc.access_token === "string" && cc.access_token.length > 0);
    ok("I2: cc token_type=Bearer",       cc.token_type === "Bearer");
    ok("I3: cc expires_in=3600",         cc.expires_in === 3600);
    ok("I4: cc access_token_decoded",    cc.access_token_decoded?.payload?.sub === "client1");
    ok("I5: cc status=200",              cc.status === 200);

    // I6: client_credentials bad secret throws
    const ccBad = await asyncThrows(
      () => oauth2Token({
        operation:      "client_credentials",
        token_endpoint: `${base}/token`,
        client_id:      "client1",
        client_secret:  "wrongsecret",
      }),
      "401"
    );
    ok("I6: bad secret throws 401", ccBad);

    // I7-I8: password grant
    const pw = await oauth2Token({
      operation:      "password",
      token_endpoint: `${base}/token`,
      client_id:      "client1",
      client_secret:  "secret1",
      username:       "alice",
      password:       "alicepw",
    });
    ok("I7: password access_token",    typeof pw.access_token === "string");
    ok("I8: password refresh_token",   pw.refresh_token === "mock-refresh-abc");

    // I9: refresh_token grant
    const rt = await oauth2Token({
      operation:      "refresh_token",
      token_endpoint: `${base}/token`,
      client_id:      "client1",
      client_secret:  "secret1",
      refresh_token:  "mock-refresh-abc",
    });
    ok("I9: refresh access_token",     typeof rt.access_token === "string");
    ok("I10: refresh expires_in=7200", rt.expires_in === 7200);

    // I11-I13: token introspect
    const intr = await oauth2Token({
      operation:           "token_introspect",
      introspect_endpoint: `${base}/introspect`,
      token:               cc.access_token,
    });
    ok("I11: introspect active=true",  intr.active === true);
    ok("I12: introspect sub=client1",  intr.sub === "client1");
    ok("I13: introspect status=200",   intr.status === 200);

    // I14: body auth method works
    const bodyAuth = await oauth2Token({
      operation:      "client_credentials",
      token_endpoint: `${base}/token`,
      client_id:      "client1",
      client_secret:  "secret1",
      auth_method:    "body",
    });
    ok("I14: body auth works",         typeof bodyAuth.access_token === "string");

    // I15: extra_params are forwarded
    const ccExtra = await oauth2Token({
      operation:      "client_credentials",
      token_endpoint: `${base}/token`,
      client_id:      "client1",
      client_secret:  "secret1",
      extra_params:   { custom_claim: "value1" },
    });
    ok("I15: extra_params don't break request", typeof ccExtra.access_token === "string");

  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // [179-J] key_generate: RSA keys usable with jwt_sign/jwt_verify
  // ──────────────────────────────────────────────────────────────────────────
  console.log("[179-J] key_generate: RSA/EC keys with jwt_sign/jwt_verify");

  // Generate a fresh 1024-bit RSA key (fast for testing)
  const rsaKP = generateRSA({ bits: 1024 });

  // Sign a JWT with the private key
  const rsaToken = jwtSign({
    payload:    { sub: "alice", role: "admin" },
    secret:     rsaKP.privateKeyPem,
    algorithm:  "RS256",
    expires_in: "10m",
  });
  ok("J1: RSA sign produces token",   typeof rsaToken.token === "string");
  ok("J2: RSA sign alg=RS256",        rsaToken.algorithm === "RS256");

  // Verify with public key
  const rsaVerified = jwtVerify({
    token:      rsaToken.token,
    secret:     rsaKP.publicKeyPem,
    algorithms: ["RS256"],
  });
  ok("J3: RSA verify valid=true",     rsaVerified.valid === true);
  ok("J4: RSA verify payload.sub",    rsaVerified.payload.sub === "alice");
  ok("J5: RSA verify role",           rsaVerified.payload.role === "admin");

  // Wrong public key should fail
  const rsaKP2  = generateRSA({ bits: 1024 });
  const wrongVerify = jwtVerify({
    token:      rsaToken.token,
    secret:     rsaKP2.publicKeyPem,
    algorithms: ["RS256"],
  });
  ok("J6: wrong key verify fails",    wrongVerify.valid === false);

  // EC P-256 key pair with ES256
  const ecKP = generateEC({ curve: "P-256" });
  const ecToken = jwtSign({
    payload:    { sub: "bob" },
    secret:     ecKP.privateKeyPem,
    algorithm:  "ES256",
    expires_in: "5m",
  });
  ok("J7: EC sign produces token",    typeof ecToken.token === "string");
  const ecVerified = jwtVerify({
    token:      ecToken.token,
    secret:     ecKP.publicKeyPem,
    algorithms: ["ES256"],
  });
  ok("J8: EC verify valid=true",      ecVerified.valid === true);
  ok("J9: EC verify payload.sub",     ecVerified.payload.sub === "bob");

  // EC P-384 with ES384
  const ecKP384 = generateEC({ curve: "P-384" });
  const ec384Token = jwtSign({
    payload:    { sub: "carol" },
    secret:     ecKP384.privateKeyPem,
    algorithm:  "ES384",
    expires_in: "5m",
  });
  const ec384Verified = jwtVerify({
    token:      ec384Token.token,
    secret:     ecKP384.publicKeyPem,
    algorithms: ["ES384"],
  });
  ok("J10: EC P-384 ES384 round-trip", ec384Verified.valid === true);

  console.log("");
})();
