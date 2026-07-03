"use strict";
// ── HTTP_FETCH — make outbound HTTP/HTTPS requests from the MCP server ─────────
//
// Allows AI agents to call external APIs, health-check URLs, trigger webhooks,
// download data, or POST JSON payloads — all without needing shell execution or
// an MCP_ALLOW_EXEC=true setup.
//
// Security notes:
//   - Only http: and https: schemes are allowed (file:, data:, ftp: etc. rejected).
//   - The server does NOT filter by target hostname; this is an outbound request
//     tool — the MCP operator controls which roots/hosts are trusted at the
//     network level (firewall, ngrok ACLs, etc.), not via this module.
//   - Redirect following: up to MAX_REDIRECTS hops are followed automatically for
//     3xx responses. Redirect loops are detected and rejected.
//   - Response body is returned as UTF-8 text, truncated at MAX_BODY_BYTES (default
//     100 KB) to avoid flooding the MCP response channel with large downloads.
//   - No response body is persisted to disk in this module; use a combination of
//     http_fetch + write_file if the caller wants to save the response.

const http  = require("http");
const https = require("https");
const { URL } = require("url");
const { ToolError } = require("./errors");

const MAX_REDIRECTS  = 5;
const MAX_BODY_BYTES = 100 * 1024; // 100 KB
const DEFAULT_TIMEOUT_MS = 15_000;  // 15 s

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * Validate and parse a URL string. Throws ToolError(-32602) on bad input.
 */
function parseUrl(raw) {
  // Reject ASCII control characters (0x00-0x1F, 0x7F) up front. The WHATWG
  // URL parser silently percent-encodes most of these (e.g. a null byte in
  // the path becomes %00) rather than throwing, which would let a caller
  // smuggle control bytes into an outbound request unnoticed. Rejecting
  // them explicitly here is cheap, clear, and consistent with how this
  // server treats control characters elsewhere (path-traversal/injection
  // guards on the filesystem tools).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw new ToolError(`http_fetch: URL contains control characters and was rejected.`, -32602);
  }
  let parsed;
  try { parsed = new URL(raw); } catch (_) {
    throw new ToolError(`http_fetch: invalid URL: ${raw}`, -32602);
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new ToolError(
      `http_fetch: unsupported scheme '${parsed.protocol}' — only http: and https: are allowed.`,
      -32602
    );
  }
  return parsed;
}

/**
 * Make a single HTTP(S) request. Returns a Promise that resolves to
 * { status, body (raw Buffer), headers (plain object), url (final URL) }.
 */
function makeRequest(parsedUrl, method, reqHeaders, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = parsedUrl.protocol === "https:" ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   method.toUpperCase(),
      headers:  { ...reqHeaders },
    };

    // Set Content-Length automatically if a body is provided
    const bodyBuf = body ? Buffer.from(body, "utf8") : null;
    if (bodyBuf && bodyBuf.length > 0) {
      options.headers["content-length"] = String(bodyBuf.length);
    }

    const req = mod.request(options, (res) => {
      const chunks = [];
      let totalBytes = 0;
      let truncated = false;

      res.on("data", (chunk) => {
        if (truncated) return; // already over the limit — keep draining, discard the rest
        if (totalBytes + chunk.length > MAX_BODY_BYTES) {
          const remaining = MAX_BODY_BYTES - totalBytes;
          if (remaining > 0) chunks.push(chunk.slice(0, remaining));
          truncated = true;
          totalBytes = MAX_BODY_BYTES;
          // Do NOT req.destroy()/res.destroy() here — destroying mid-stream
          // makes Node's http client emit an "aborted" error on the response,
          // which rejects this Promise instead of resolving with the
          // truncated body. Letting the stream finish naturally (we just
          // stop storing chunks above) keeps this a clean, successful
          // truncation instead of a request failure.
        } else {
          chunks.push(chunk);
          totalBytes += chunk.length;
        }
      });

      res.on("end", () => {
        resolve({
          status:    res.statusCode,
          statusMsg: res.statusMessage,
          headers:   res.headers,
          body:      Buffer.concat(chunks),
          truncated,
          url:       parsedUrl.href,
        });
      });

      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new ToolError(`http_fetch: request timed out after ${timeoutMs / 1000}s.`, -32603));
    });

    if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Execute an HTTP fetch with up to MAX_REDIRECTS redirect follows.
 *
 * @param {object} opts
 * @param {string}  opts.url       — Request URL (http/https only)
 * @param {string}  [opts.method]  — HTTP method (default: GET)
 * @param {object}  [opts.headers] — Extra request headers
 * @param {string}  [opts.body]    — Request body (string)
 * @param {number}  [opts.timeout] — Request timeout in seconds (default: 15)
 * @returns {{ status, statusText, ok, url, headers, body, bodySize, truncated, redirected }}
 */
async function httpFetch(opts = {}) {
  const rawUrl   = opts.url;
  if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new ToolError("http_fetch: 'url' is required and must be a non-empty string.", -32602);
  }

  const method     = (opts.method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new ToolError(
      `http_fetch: unsupported method '${method}'. Allowed: ${[...ALLOWED_METHODS].join(", ")}.`,
      -32602
    );
  }

  const timeoutMs = typeof opts.timeout === "number"
    ? Math.min(opts.timeout, 60) * 1000  // cap at 60 s
    : DEFAULT_TIMEOUT_MS;

  // Merge user headers with sensible defaults
  const reqHeaders = {
    "user-agent": "mcp-common-server/1.0 (http_fetch)",
    "accept":     "*/*",
    ...Object.fromEntries(
      Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    ),
  };

  // If a body is present and content-type not set, default to text/plain
  if (opts.body && !reqHeaders["content-type"]) {
    reqHeaders["content-type"] = "text/plain; charset=utf-8";
  }

  let parsedUrl = parseUrl(rawUrl.trim());
  let redirected = false;
  let redirectCount = 0;
  const visited  = new Set();

  // Loop bound is MAX_REDIRECTS+1 requests total (the original request plus
  // up to MAX_REDIRECTS follow-ups) — redirectCount below is the actual
  // authority on the limit; this just keeps the for-loop finite as a
  // backstop.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const href = parsedUrl.href;
    if (visited.has(href)) {
      throw new ToolError(`http_fetch: redirect loop detected at ${href}.`, -32603);
    }
    visited.add(href);

    // Only send body on the first (original) hop and only for mutating methods
    const sendBody = hop === 0 && opts.body && ["POST", "PUT", "PATCH"].includes(method);
    let resp;
    try {
      resp = await makeRequest(parsedUrl, method, reqHeaders, sendBody ? opts.body : null, timeoutMs);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(`http_fetch: request failed — ${e.message}`, -32603);
    }

    const { status, statusMsg, headers, body, truncated, url } = resp;

    // Follow 3xx redirects
    if (status >= 301 && status <= 308 && headers.location) {
      if (redirectCount >= MAX_REDIRECTS) {
        throw new ToolError(
          `http_fetch: too many redirects (max ${MAX_REDIRECTS}) for ${rawUrl}.`,
          -32603
        );
      }
      let loc = headers.location;
      // Location may be relative — resolve against current URL
      try { parsedUrl = new URL(loc, parsedUrl); } catch (_) {
        throw new ToolError(`http_fetch: invalid redirect Location: ${loc}`, -32603);
      }
      if (!ALLOWED_SCHEMES.has(parsedUrl.protocol)) {
        throw new ToolError(
          `http_fetch: redirect to unsupported scheme '${parsedUrl.protocol}' blocked.`,
          -32601
        );
      }
      redirected = true;
      redirectCount++;
      continue;
    }

    // Convert body to UTF-8 text; replace non-UTF-8 sequences gracefully
    const bodyText = body.toString("utf8");
    const bodySize = body.length;

    // Build a clean, serialisable headers object (multi-value headers as arrays)
    const outHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      outHeaders[k] = v; // Node already normalises to lowercase; arrays for multi-value
    }

    return {
      url:        parsedUrl.href,
      status,
      statusText: statusMsg || "",
      ok:         status >= 200 && status < 300,
      redirected,
      headers:    outHeaders,
      body:       bodyText,
      bodySize,
      truncated,
    };
  }

  throw new ToolError(
    `http_fetch: too many redirects (max ${MAX_REDIRECTS}) for ${rawUrl}.`,
    -32603
  );
}

module.exports = { httpFetch, parseUrl, ALLOWED_SCHEMES, MAX_REDIRECTS };
