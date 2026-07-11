"use strict";
// ── UTILITY TOOL SCHEMAS — part 14 ─────────────────────────────────────────────────
// Added: tls_cert_inspect (v4.150.0), http_multi_fetch (v4.150.0).

const UTIL_SCHEMAS_14 = [
  // ── tls_cert_inspect ──────────────────────────────────────────────────────────
  {
    name: "tls_cert_inspect",
    description:
      "Inspect the TLS/SSL certificate for any hostname:port (default port 443). " +
      "Zero npm dependencies — uses Node's built-in tls module. " +
      "Operations: " +
      "'inspect' (default) — connect and return the server's leaf certificate plus TLS session details. " +
      "'chain' — return the full peer certificate chain from leaf to root. " +
      "Returns: host, port, connected (bool), authorized (browser-style chain verification), " +
      "authorizationError (if not authorized), protocol (TLSv1.2/TLSv1.3), " +
      "cipher ({name, version}), and cert object with: " +
      "subject, issuer, serialNumber, valid_from, valid_to, isExpired (bool), " +
      "daysUntilExpiry (integer), subjectAltNames (array of DNS:/IP: entries), " +
      "fingerprint (SHA-1), fingerprint256 (SHA-256), bits (key size), " +
      "isSelfSigned (bool), isCA (bool). " +
      "expiryWarning is set to 'EXPIRED', 'EXPIRES_IN_N_DAYS', or null (ok). " +
      "Uses rejectUnauthorized:false so it inspects even untrusted/self-signed certs. " +
      "Requires MCP_ALLOW_EXEC (outbound TLS socket).",
    inputSchema: {
      type: "object",
      required: ["host"],
      properties: {
        host: {
          type: "string",
          description:
            "Hostname or IP address to connect to. " +
            "Examples: 'example.com', '192.168.1.1', 'internal.corp'.",
        },
        port: {
          type: "number",
          description: "TCP port to connect to (default 443). Range: 1–65535.",
        },
        operation: {
          type: "string",
          description:
            "'inspect' (default) — return the leaf cert + TLS session info. " +
            "'chain' — return the full certificate chain from leaf to root.",
        },
        timeout: {
          type: "number",
          description:
            "Connection timeout in milliseconds (default 10 000). " +
            "The TLS handshake must complete within this window.",
        },
        servername: {
          type: "string",
          description:
            "SNI (Server Name Indication) hostname override. " +
            "Defaults to 'host'. Useful when connecting via IP but needing a specific vhost cert.",
        },
        warn_days: {
          type: "number",
          description:
            "Warn (set expiryWarning) if the cert expires within this many days (default 30). " +
            "Set to 0 to disable expiry warnings.",
        },
      },
    },
  },

  // ── http_multi_fetch ──────────────────────────────────────────────────────────
  {
    name: "http_multi_fetch",
    description:
      "Send multiple HTTP/HTTPS requests in parallel and return all results as an array. " +
      "Zero additional npm dependencies — reuses the same http_fetch logic. " +
      "Configurable concurrency (default 5, max 20) via a worker pool that preserves input order. " +
      "Each request in 'requests' may specify: url (required), method (default GET), " +
      "headers (object), body (string), timeout (seconds, overrides default). " +
      "Each result includes: index, url (final after redirects), status, statusText, ok (bool), " +
      "redirected, headers, body (UTF-8, up to 100 KB), bodySize, truncated, duration_ms, error (null if ok). " +
      "Failed requests (connection/timeout errors) produce error string + ok:false; " +
      "HTTP 4xx/5xx responses are not errors, they produce ok:false with the body. " +
      "Aggregate stats: total, succeeded (ok:true), failed (http error status), errors (network failures). " +
      "Set fail_fast:true to throw on the first network/connection error. " +
      "Up to 100 requests per call. Requires MCP_ALLOW_EXEC (outbound HTTP).",
    inputSchema: {
      type: "object",
      required: ["requests"],
      properties: {
        requests: {
          type: "array",
          description:
            "Array of request objects. Each must have 'url'. " +
            "Optional per-request fields: method, headers, body, timeout (seconds). " +
            "Max 100 requests.",
          items: {
            type: "object",
            required: ["url"],
            properties: {
              url:     { type: "string",  description: "Target URL (http:// or https:// only)." },
              method:  { type: "string",  description: "HTTP method (default GET)." },
              headers: { type: "object",  description: "Extra HTTP headers." },
              body:    { type: "string",  description: "Request body (for POST/PUT/PATCH)." },
              timeout: { type: "number",  description: "Per-request timeout in seconds (overrides outer 'timeout')." },
            },
          },
        },
        concurrency: {
          type: "number",
          description:
            "Max number of requests to run simultaneously (default 5, max 20). " +
            "Use lower values to avoid rate-limiting on the target server.",
        },
        timeout: {
          type: "number",
          description:
            "Default timeout per request in seconds (default 15). " +
            "Individual requests may override this with their own 'timeout' field.",
        },
        fail_fast: {
          type: "boolean",
          description:
            "If true, throw a ToolError as soon as any request has a network/connection error " +
            "(HTTP 4xx/5xx do not trigger fail_fast). Default: false (collect all results).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_14 };
