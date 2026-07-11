"use strict";
// ── oauth2_token: OAuth2 token operations ──────────────────────────────
// Reuses httpFetch from httpFetchOps.js — zero additional npm deps.
// Operations:
//   client_credentials — OAuth2 client_credentials grant (RFC 6749 §4.4)
//   password           — OAuth2 ROPC password grant (RFC 6749 §4.3)
//   refresh_token      — OAuth2 refresh token grant (RFC 6749 §6.1)
//   token_introspect   — RFC 7662 token introspection endpoint
//   parse_bearer       — Decode a JWT Bearer token (header + payload, no verify)

const { httpFetch } = require("./httpFetchOps");
const { ToolError } = require("./errors");

const VALID_OPS = new Set([
  "client_credentials", "password", "refresh_token",
  "token_introspect",   "parse_bearer",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Base64url-decode a segment (adds padding if needed).
 */
function b64urlDecode(s) {
  const b64 = (s + "===".slice((s.length + 3) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Decode a JWT (header + payload) without verification.
 * Returns { header, payload, issuedAt, expiresAt, expired, notYetValid }.
 * Returns null if the token is not a valid 3-segment JWT.
 */
function decodeJwtUnsafe(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header  = JSON.parse(b64urlDecode(parts[0]));
    const payload = JSON.parse(b64urlDecode(parts[1]));
    const nowS    = Math.floor(Date.now() / 1000);
    const iat     = typeof payload.iat === "number" ? payload.iat : null;
    const exp     = typeof payload.exp === "number" ? payload.exp : null;
    const nbf     = typeof payload.nbf === "number" ? payload.nbf : null;
    return {
      header,
      payload,
      issuedAt:    iat ? new Date(iat * 1000).toISOString() : null,
      expiresAt:   exp ? new Date(exp * 1000).toISOString() : null,
      notBefore:   nbf ? new Date(nbf * 1000).toISOString() : null,
      expired:     exp !== null ? nowS > exp : null,
      notYetValid: nbf !== null ? nowS < nbf : null,
    };
  } catch {
    return null;
  }
}

/**
 * Build a URL-encoded form body string from a plain object.
 */
function formEncode(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/**
 * Make a POST request to an OAuth2 token endpoint.
 * Handles Basic auth (client_id + client_secret) or body auth.
 * Parses the JSON response and attaches optional JWT decode of access_token.
 *
 * @param {object} opts
 * @param {string}  opts.token_endpoint
 * @param {object}  opts.params           — form body params
 * @param {string}  [opts.client_id]
 * @param {string}  [opts.client_secret]
 * @param {string}  [opts.auth_method]    — "basic" (default if client_secret provided) or "body"
 * @param {object}  [opts.extra_headers]
 * @param {number}  [opts.timeout]        — seconds
 * @returns {Promise<object>}
 */
async function tokenEndpointRequest(opts) {
  const {
    token_endpoint,
    params,
    client_id,
    client_secret,
    auth_method,
    extra_headers = {},
    timeout = 15,
  } = opts;

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept":       "application/json",
    ...extra_headers,
  };

  const bodyParams = { ...params };

  // Client authentication
  const useBasic = auth_method === "basic" ||
    (auth_method !== "body" && client_id && client_secret);

  if (useBasic && client_id) {
    // RFC 6749 §2.3.1 — Basic auth is preferred
    const cred = Buffer.from(
      `${encodeURIComponent(client_id)}:${encodeURIComponent(client_secret || "")}`
    ).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  } else if (client_id) {
    // Body params auth
    bodyParams.client_id = client_id;
    if (client_secret) bodyParams.client_secret = client_secret;
  }

  const body = formEncode(bodyParams);

  let response;
  try {
    response = await httpFetch({ url: token_endpoint, method: "POST", headers, body, timeout });
  } catch (e) {
    throw new ToolError(
      `oauth2_token: request to '${token_endpoint}' failed — ${e.message}`,
      -32603
    );
  }

  // Parse the response body as JSON
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new ToolError(
      `oauth2_token: token endpoint returned non-JSON response (status ${response.status}): ${response.body?.slice(0, 200)}`,
      -32603
    );
  }

  // RFC 6749 error response: { error, error_description }
  if (!response.ok) {
    const errMsg = parsed.error_description || parsed.error || response.statusText;
    throw new ToolError(
      `oauth2_token: token endpoint returned ${response.status} — ${errMsg}`,
      -32603
    );
  }

  // Annotate access_token if it's a JWT
  const result = {
    ...parsed,
    token_endpoint,
    status:    response.status,
    status_ok: response.ok,
  };

  if (typeof parsed.access_token === "string") {
    const decoded = decodeJwtUnsafe(parsed.access_token);
    if (decoded) result.access_token_decoded = decoded;
  }

  return result;
}

// ── Grant implementations ────────────────────────────────────────────

function validateEndpoint(url, opName) {
  if (!url || typeof url !== "string" || !url.trim()) {
    throw new ToolError(`oauth2_token (${opName}): 'token_endpoint' is required.`, -32602);
  }
  if (!/^https?:\/\//i.test(url.trim())) {
    throw new ToolError(
      `oauth2_token (${opName}): 'token_endpoint' must start with http:// or https://.`,
      -32602
    );
  }
}

async function clientCredentials(opts) {
  validateEndpoint(opts.token_endpoint, "client_credentials");
  if (!opts.client_id) {
    throw new ToolError("oauth2_token (client_credentials): 'client_id' is required.", -32602);
  }

  const params = { grant_type: "client_credentials" };
  if (opts.scope)    params.scope    = opts.scope;
  if (opts.audience) params.audience = opts.audience;
  if (opts.resource) params.resource = opts.resource;
  Object.assign(params, opts.extra_params || {});

  return tokenEndpointRequest({
    token_endpoint: opts.token_endpoint.trim(),
    params,
    client_id:      opts.client_id,
    client_secret:  opts.client_secret,
    auth_method:    opts.auth_method,
    extra_headers:  opts.headers,
    timeout:        opts.timeout,
  });
}

async function passwordGrant(opts) {
  validateEndpoint(opts.token_endpoint, "password");
  if (!opts.username) throw new ToolError("oauth2_token (password): 'username' is required.", -32602);
  if (!opts.password) throw new ToolError("oauth2_token (password): 'password' is required.", -32602);

  const params = {
    grant_type: "password",
    username:   opts.username,
    password:   opts.password,
  };
  if (opts.scope) params.scope = opts.scope;
  Object.assign(params, opts.extra_params || {});

  return tokenEndpointRequest({
    token_endpoint: opts.token_endpoint.trim(),
    params,
    client_id:     opts.client_id,
    client_secret: opts.client_secret,
    auth_method:   opts.auth_method,
    extra_headers: opts.headers,
    timeout:       opts.timeout,
  });
}

async function refreshTokenGrant(opts) {
  validateEndpoint(opts.token_endpoint, "refresh_token");
  if (!opts.refresh_token) {
    throw new ToolError("oauth2_token (refresh_token): 'refresh_token' is required.", -32602);
  }

  const params = {
    grant_type:    "refresh_token",
    refresh_token: opts.refresh_token,
  };
  if (opts.scope) params.scope = opts.scope;
  Object.assign(params, opts.extra_params || {});

  return tokenEndpointRequest({
    token_endpoint: opts.token_endpoint.trim(),
    params,
    client_id:     opts.client_id,
    client_secret: opts.client_secret,
    auth_method:   opts.auth_method,
    extra_headers: opts.headers,
    timeout:       opts.timeout,
  });
}

async function tokenIntrospect(opts) {
  if (!opts.introspect_endpoint || typeof opts.introspect_endpoint !== "string") {
    throw new ToolError("oauth2_token (token_introspect): 'introspect_endpoint' is required.", -32602);
  }
  if (!/^https?:\/\//i.test(opts.introspect_endpoint.trim())) {
    throw new ToolError(
      "oauth2_token (token_introspect): 'introspect_endpoint' must start with http:// or https://.",
      -32602
    );
  }
  if (!opts.token || typeof opts.token !== "string") {
    throw new ToolError("oauth2_token (token_introspect): 'token' is required.", -32602);
  }

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept":       "application/json",
    ...(opts.headers || {}),
  };

  // Bearer auth on introspect endpoint (RFC 7662 §2.1)
  if (opts.bearer_token) {
    headers["Authorization"] = `Bearer ${opts.bearer_token}`;
  } else if (opts.client_id && opts.client_secret) {
    const cred = Buffer.from(
      `${encodeURIComponent(opts.client_id)}:${encodeURIComponent(opts.client_secret)}`
    ).toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }

  const bodyParams = { token: opts.token };
  if (opts.token_type_hint) bodyParams.token_type_hint = opts.token_type_hint;

  let response;
  try {
    response = await httpFetch({
      url:     opts.introspect_endpoint.trim(),
      method:  "POST",
      headers,
      body:    formEncode(bodyParams),
      timeout: opts.timeout ?? 15,
    });
  } catch (e) {
    throw new ToolError(
      `oauth2_token (token_introspect): request failed — ${e.message}`,
      -32603
    );
  }

  let parsed;
  try { parsed = JSON.parse(response.body); }
  catch {
    throw new ToolError(
      `oauth2_token (token_introspect): non-JSON response (status ${response.status}): ${response.body?.slice(0, 200)}`,
      -32603
    );
  }

  return {
    ...parsed,
    introspect_endpoint: opts.introspect_endpoint.trim(),
    status: response.status,
  };
}

function parseBearer(opts) {
  const token = opts.token || opts.bearer;
  if (!token || typeof token !== "string") {
    throw new ToolError("oauth2_token (parse_bearer): 'token' is required (non-empty string).", -32602);
  }
  // Strip 'Bearer ' prefix if present
  const raw = token.trim().replace(/^Bearer\s+/i, "");
  const decoded = decodeJwtUnsafe(raw);
  if (!decoded) {
    // Return raw info for opaque tokens
    return {
      raw_token:  raw,
      is_jwt:     false,
      token_type: "opaque",
      length:     raw.length,
    };
  }
  return {
    raw_token:  raw,
    is_jwt:     true,
    ...decoded,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────

async function oauth2Token(opts = {}) {
  const op = opts.operation ?? "client_credentials";

  if (!VALID_OPS.has(op)) {
    throw new ToolError(
      `oauth2_token: unknown operation '${op}'. Valid: ${[...VALID_OPS].join(", ")}.`,
      -32602
    );
  }

  switch (op) {
    case "client_credentials": return clientCredentials(opts);
    case "password":           return passwordGrant(opts);
    case "refresh_token":      return refreshTokenGrant(opts);
    case "token_introspect":   return tokenIntrospect(opts);
    case "parse_bearer":       return parseBearer(opts);
    default:
      throw new ToolError(`oauth2_token: unhandled operation '${op}'.`, -32500);
  }
}

module.exports = {
  oauth2Token,
  clientCredentials, passwordGrant, refreshTokenGrant,
  tokenIntrospect,  parseBearer,
  decodeJwtUnsafe,  formEncode,
};
