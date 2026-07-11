"use strict";
// ── UTILITY TOOL SCHEMAS — part 15 ───────────────────────────────────────────────
// Added: key_generate (v4.151.0), oauth2_token (v4.151.0).

const UTIL_SCHEMAS_15 = [
  // ── key_generate ─────────────────────────────────────────────────────────────
  {
    name: "key_generate",
    description:
      "Generate cryptographic key material for use with JWT signing, TLS, HMAC, and AES encryption. " +
      "Uses Node.js built-in crypto module — zero npm dependencies. " +
      "Types: " +
      "'rsa' (default) — RSA key pair; bits: 1024/2048(default)/3072/4096/6144/8192; " +
      "returns privateKeyPem (PKCS#8), publicKeyPem (SPKI), fingerprint_sha256. " +
      "'ec' — EC key pair; curve: P-256(default)/P-384/P-521/secp256k1; " +
      "returns privateKeyPem, publicKeyPem, fingerprint_sha256. " +
      "'ed25519' — Ed25519 EdDSA key pair (Node >=12); returns privateKeyPem, publicKeyPem, fingerprint_sha256. " +
      "'ed448' — Ed448 EdDSA key pair (Node >=12); returns privateKeyPem, publicKeyPem, fingerprint_sha256. " +
      "'symmetric' — cryptographically random bytes for AES/HMAC; " +
      "size: 16/24/32(default)/48/64/128 bytes; encoding: hex(default)/base64/base64url; " +
      "returns key (string), bits, suggestedPurpose. " +
      "RSA key pairs can be used directly with jwt_sign/jwt_verify (RS256/RS384/RS512). " +
      "EC key pairs can be used with jwt_sign/jwt_verify (ES256 with P-256, ES384 with P-384, ES512 with P-521). " +
      "Ed25519/Ed448 are for EdDSA signing (not supported by jwt_sign, but useful for SSH keys, libsodium, age, etc.). " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Key type to generate: 'rsa' (default), 'ec', 'ed25519', 'ed448', or 'symmetric'.",
        },
        bits: {
          type: "number",
          description:
            "RSA only: key size in bits. Valid: 1024, 2048 (default), 3072, 4096, 6144, 8192. " +
            "Larger values are more secure but slower to generate.",
        },
        public_exponent: {
          type: "number",
          description:
            "RSA only: public exponent (default 65537). Must be odd and between 3 and 16777215.",
        },
        curve: {
          type: "string",
          description:
            "EC only: named curve. Valid: 'P-256' (default, NIST/FIPS), 'P-384', 'P-521', 'secp256k1' (Ethereum/Bitcoin). " +
            "P-256 is recommended for use with jwt_sign (ES256).",
        },
        size: {
          type: "number",
          description:
            "Symmetric only: key length in bytes. Valid: 16, 24, 32 (default, AES-256), 48, 64, 128.",
        },
        encoding: {
          type: "string",
          description:
            "Symmetric only: output encoding for the key string. 'hex' (default), 'base64', or 'base64url'.",
        },
      },
    },
  },

  // ── oauth2_token ──────────────────────────────────────────────────────────
  {
    name: "oauth2_token",
    description:
      "Perform OAuth2 token operations against any standard-compliant authorization server. " +
      "Zero additional npm dependencies — reuses http_fetch for the token endpoint POST. " +
      "Operations: " +
      "'client_credentials' (default) — RFC 6749 §4.4 client credentials grant; " +
      "  requires: token_endpoint, client_id; optional: client_secret, scope, audience, resource, extra_params. " +
      "'password' — RFC 6749 §4.3 resource owner password grant (ROPC); " +
      "  requires: token_endpoint, username, password; optional: client_id, scope, extra_params. " +
      "'refresh_token' — RFC 6749 §6.1; requires: token_endpoint, refresh_token; optional: client_id, scope. " +
      "'token_introspect' — RFC 7662 introspection; requires: introspect_endpoint, token; " +
      "  auth: bearer_token OR client_id+client_secret. " +
      "'parse_bearer' — Decode a Bearer token string without verifying the signature: " +
      "  returns header, payload, issuedAt, expiresAt, expired for JWT tokens; " +
      "  returns raw_token, is_jwt:false for opaque tokens. " +
      "  Strip 'Bearer ' prefix automatically. " +
      "Client authentication: defaults to HTTP Basic auth when client_id+client_secret are provided " +
      "(pass auth_method:'body' to send credentials in the form body instead). " +
      "Response: all fields returned by the server plus access_token_decoded (JWT claims if the token is a JWT). " +
      "Requires MCP_ALLOW_EXEC (outbound HTTP to the token endpoint).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description:
            "Operation: 'client_credentials' (default), 'password', 'refresh_token', " +
            "'token_introspect', or 'parse_bearer'.",
        },
        token_endpoint: {
          type: "string",
          description:
            "Full URL of the OAuth2 token endpoint, e.g. 'https://auth.example.com/oauth/token'. " +
            "Required for client_credentials, password, and refresh_token operations.",
        },
        client_id: {
          type: "string",
          description: "OAuth2 client identifier. Required for client_credentials; optional for others.",
        },
        client_secret: {
          type: "string",
          description:
            "OAuth2 client secret. Used with client_id for HTTP Basic auth by default. " +
            "Optional for public clients.",
        },
        auth_method: {
          type: "string",
          description:
            "How to send client credentials: 'basic' (HTTP Basic auth header, default when client_secret provided) " +
            "or 'body' (client_id/secret in the form body). Default: 'basic'.",
        },
        scope: {
          type: "string",
          description:
            "Requested scope string, space-separated (e.g. 'read write'). " +
            "Optional for client_credentials, password, and refresh_token.",
        },
        audience: {
          type: "string",
          description:
            "Requested audience (RFC 8707 'aud' parameter). Common in Auth0, Okta, and similar IdPs.",
        },
        resource: {
          type: "string",
          description:
            "Requested resource indicator (RFC 8707 'resource' parameter). Common in Azure AD.",
        },
        username: {
          type: "string",
          description: "Resource owner username. Required for 'password' grant.",
        },
        password: {
          type: "string",
          description: "Resource owner password. Required for 'password' grant.",
        },
        refresh_token: {
          type: "string",
          description: "Refresh token string. Required for 'refresh_token' grant.",
        },
        introspect_endpoint: {
          type: "string",
          description:
            "URL of the token introspection endpoint (RFC 7662). Required for 'token_introspect' operation.",
        },
        token: {
          type: "string",
          description:
            "Token to introspect (for 'token_introspect') or decode (for 'parse_bearer'). " +
            "For parse_bearer, 'Bearer ' prefix is stripped automatically.",
        },
        bearer_token: {
          type: "string",
          description:
            "Bearer token to authenticate the introspection request itself " +
            "(for 'token_introspect' when the endpoint requires Bearer auth).",
        },
        token_type_hint: {
          type: "string",
          description:
            "Hint for the introspection endpoint: 'access_token' or 'refresh_token'. Optional.",
        },
        extra_params: {
          type: "object",
          description:
            "Additional form-body parameters to include in the token request " +
            "(e.g. { 'provider_id': 'abc' }). Values are stringified.",
        },
        headers: {
          type: "object",
          description: "Extra HTTP headers to include in the request (e.g. custom correlation IDs).",
        },
        timeout: {
          type: "number",
          description: "Request timeout in seconds (default 15).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_15 };
