"use strict";
// lib/schemas/utilSchemas44.js — JSON schema for http_client tool

const UTIL_SCHEMAS_44 = [
  {
    name: "http_client",
    description: "Stateful HTTP/HTTPS session client (pure Node.js; zero npm deps). Supports cookie jar per session, automatic redirect following, Basic/Bearer/Digest authentication, retry with exponential backoff, timeout, HTTP proxy (CONNECT tunnel for HTTPS), JSON/form-urlencoded/multipart/raw request bodies, gzip/deflate/brotli response decompression, TLS options, and file download. Operations: get, post, put, patch, delete, head, options (shorthand HTTP methods); request (explicit method); download (save response body to file); session_new (create/reset cookie jar); session_clear (delete session). Security: URL scheme validation (http/https only); SSRF guard blocking private/loopback IPs (enabled by default, disable with ssrf_guard: false); header injection prevention (no NUL/CRLF in header names or values); redirect limit; response body size cap. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["request", "get", "post", "put", "patch", "delete", "head", "options", "download", "session_new", "session_clear"],
          description: "Operation to perform. Shorthand methods (get/post/put/patch/delete/head/options) set the HTTP method automatically. 'request' lets you specify any method explicitly. 'download' fetches and writes the response body to a file. 'session_new' creates or resets a named cookie-jar session. 'session_clear' deletes one or all sessions.",
        },

        // ── Core request args ──────────────────────────────────────────────
        url: {
          type: "string",
          description: "Target URL (required for all request/download operations). Must be http:// or https://.",
        },
        method: {
          type: "string",
          description: "HTTP method (required only for 'request' operation; ignored for shorthand operations). Example: 'GET', 'POST', 'DELETE', 'PATCH'.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Additional HTTP request headers as key-value pairs. Header names and values must not contain NUL or CRLF characters.",
        },

        // ── Request body (mutually exclusive: use one at most) ─────────────
        json: {
          description: "Request body serialised as JSON. Sets Content-Type to 'application/json' automatically. Mutually exclusive with 'form', 'multipart', and 'body'.",
        },
        form: {
          type: "object",
          additionalProperties: {},
          description: "Request body as URL-encoded form data (application/x-www-form-urlencoded). Pass an object; keys and values are percent-encoded automatically. Mutually exclusive with 'json', 'multipart', 'body'.",
        },
        multipart: {
          type: "array",
          description: "Request body as multipart/form-data. Array of { name, value, filename?, content_type? } parts. Mutually exclusive with 'json', 'form', 'body'.",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name:         { type: "string",  description: "Field name." },
              value:        { description:     "Field value (stringified automatically)." },
              filename:     { type: "string",  description: "Optional filename for file-upload parts." },
              content_type: { type: "string",  description: "Optional Content-Type for this part." },
            },
          },
        },
        body: {
          type: "string",
          description: "Raw request body string. Use 'content_type' to set Content-Type header. Mutually exclusive with 'json', 'form', 'multipart'.",
        },
        content_type: {
          type: "string",
          description: "Content-Type header for raw 'body'. Default: 'text/plain'.",
        },

        // ── Session ────────────────────────────────────────────────────────
        session_id: {
          type: "string",
          description: "Session identifier for stateful cookie jar. Cookies from responses are stored under this ID and sent with subsequent requests using the same session_id. For 'session_new': creates or resets the jar. For 'session_clear': deletes this specific session (omit to clear all sessions).",
        },

        // ── Redirect ───────────────────────────────────────────────────────
        follow_redirects: {
          type: "boolean",
          description: "Whether to follow HTTP redirects. Default: true. Set to false to disable redirect following entirely.",
        },
        max_redirects: {
          type: "number",
          description: "Maximum number of redirects to follow (default: 10). Raises an error if exceeded.",
        },

        // ── Timeout & retry ────────────────────────────────────────────────
        timeout: {
          type: "number",
          description: "Request timeout in milliseconds (default: 30000). Applied per attempt.",
        },
        retry_count: {
          type: "number",
          description: "Number of times to retry a failed request (default: 0 = no retry). Uses exponential backoff: delay doubles after each retry.",
        },
        retry_delay_ms: {
          type: "number",
          description: "Base retry delay in milliseconds (default: 500). Actual delay = retry_delay_ms × 2^(attempt-1).",
        },

        // ── Authentication ─────────────────────────────────────────────────
        auth: {
          type: "object",
          description: "Authentication configuration.",
          properties: {
            type: {
              type: "string",
              enum: ["basic", "bearer", "digest"],
              description: "Authentication scheme: 'basic' (username+password, base64), 'bearer' (token in Authorization header), 'digest' (MD5 challenge-response, auto-retried on 401).",
            },
            username: { type: "string", description: "Username for basic/digest auth." },
            password: { type: "string", description: "Password for basic/digest auth." },
            token:    { type: "string", description: "Token for bearer auth." },
          },
          required: ["type"],
        },

        // ── Security ───────────────────────────────────────────────────────
        ssrf_guard: {
          type: "boolean",
          description: "Block requests to private/loopback IP ranges and 'localhost' (default: true). Set to false to allow intranet requests.",
        },

        // ── TLS ────────────────────────────────────────────────────────────
        reject_unauthorized: {
          type: "boolean",
          description: "Reject TLS certificates that fail validation (default: true). Set to false to allow self-signed certificates.",
        },
        ca: {
          type: "string",
          description: "Optional custom CA certificate (PEM string) for TLS verification.",
        },
        cert: {
          type: "string",
          description: "Optional client TLS certificate (PEM string) for mutual TLS.",
        },
        key: {
          type: "string",
          description: "Optional client TLS private key (PEM string) for mutual TLS.",
        },

        // ── Proxy ──────────────────────────────────────────────────────────
        proxy: {
          type: "string",
          description: "HTTP/HTTPS proxy URL (e.g. 'http://proxy.example.com:8080'). For HTTPS targets, uses HTTP CONNECT tunnelling. Supports proxy authentication via URL credentials (http://user:pass@proxy:port).",
        },

        // ── Response ───────────────────────────────────────────────────────
        max_response_bytes: {
          type: "number",
          description: "Maximum response body size in bytes (default: 10485760 = 10 MB; hard cap: 209715200 = 200 MB).",
        },

        // ── Download ───────────────────────────────────────────────────────
        download_path: {
          type: "string",
          description: "File path to save the downloaded response body to. Required for 'download' operation. Parent directories are created automatically.",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_44 };
