"use strict";
// ── MULTIPART_UPLOAD — send multipart/form-data requests from the MCP server ───────────
//
// Builds a multipart/form-data body from text fields, files on disk, and
// inline data parts. No npm dependencies — MIME boundary construction is
// done here in pure JS; outbound HTTP(S) reuses the same pattern as
// httpFetchOps.js (Node's built-in http/https modules).
//
// Security notes:
//   - Only http: and https: schemes are allowed.
//   - Files are read at call time; the caller must supply absolute resolved paths.
//   - Response body is truncated at MAX_BODY_BYTES (100 KB) same as http_fetch.
//   - A unique boundary is generated per call with crypto.randomBytes().

const http   = require("http");
const https  = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const { ToolError } = require("./errors");

const MAX_BODY_BYTES   = 100 * 1024;  // 100 KB response cap
const DEFAULT_TIMEOUT  = 30 * 1000;  // 30 s
const MAX_FIELDS       = 100;
const MAX_INLINE_SIZE  = 50 * 1024 * 1024; // 50 MB per inline part
const ALLOWED_METHODS  = new Set(["POST", "PUT", "PATCH"]);
const ALLOWED_SCHEMES  = new Set(["http:", "https:"]);

// ── Boundary helpers ───────────────────────────────────────────────────────────────────────

function generateBoundary() {
  // 24 random hex bytes → 48-char boundary; collision probability negligible.
  return "----McpBoundary" + crypto.randomBytes(16).toString("hex");
}

/**
 * Escape a form-data parameter value for Content-Disposition.
 * Per RFC 5987 / RFC 6266 the safe approach is to keep only printable ASCII
 * and replace double-quotes and backslashes.
 */
function escapeDisposition(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * Build the complete multipart body as a single Buffer.
 *
 * @param {string}   boundary
 * @param {object}   fields         — plain key→value object of text form fields
 * @param {Array}    fileParts      — [{name, filename, contentType, data: Buffer}]
 * @returns {{ body: Buffer, partCount: number }}
 */
function buildMultipartBody(boundary, fields, fileParts) {
  const CRLF = Buffer.from("\r\n", "ascii");
  const DASH2 = "--";
  const chunks = [];

  // ─ Text fields ─────────────────────────────────────────────────────────────────
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `${DASH2}${boundary}\r\nContent-Disposition: form-data; name="${escapeDisposition(name)}"\r\n\r\n`,
      "utf8"
    ));
    chunks.push(Buffer.from(String(value), "utf8"));
    chunks.push(CRLF);
  }

  // ─ File / inline data parts ──────────────────────────────────────────────
  for (const fp of fileParts) {
    const ct = fp.contentType || "application/octet-stream";
    chunks.push(Buffer.from(
      `${DASH2}${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeDisposition(fp.name)}"; filename="${escapeDisposition(fp.filename)}"\r\n` +
      `Content-Type: ${ct}\r\n\r\n`,
      "utf8"
    ));
    chunks.push(fp.data); // already a Buffer
    chunks.push(CRLF);
  }

  // ─ Closing boundary ────────────────────────────────────────────────────────────
  chunks.push(Buffer.from(`${DASH2}${boundary}${DASH2}\r\n`, "utf8"));

  const partCount = Object.keys(fields).length + fileParts.length;
  return { body: Buffer.concat(chunks), partCount };
}

// ── HTTP request (mirrors httpFetchOps makeRequest pattern) ───────────────────────

function makeRequest(parsedUrl, method, reqHeaders, bodyBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = parsedUrl.protocol === "https:" ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   method,
      headers:  { ...reqHeaders, "content-length": String(bodyBuf.length) },
    };

    const req = mod.request(options, (res) => {
      const chunks = [];
      let total = 0;
      let truncated = false;

      res.on("data", (chunk) => {
        if (truncated) return;
        if (total + chunk.length > MAX_BODY_BYTES) {
          const rem = MAX_BODY_BYTES - total;
          if (rem > 0) chunks.push(chunk.slice(0, rem));
          truncated = true;
          total = MAX_BODY_BYTES;
        } else {
          chunks.push(chunk);
          total += chunk.length;
        }
      });

      res.on("end", () => resolve({
        status:    res.statusCode,
        statusMsg: res.statusMessage,
        headers:   res.headers,
        body:      Buffer.concat(chunks),
        bodySize:  total,
        truncated,
        url:       parsedUrl.href,
      }));

      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new ToolError(
        `multipart_upload: request timed out after ${timeoutMs / 1000}s.`, -32603));
    });

    req.write(bodyBuf);
    req.end();
  });
}

// ── Public API ───────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}          opts.url            — Target URL (http/https only)
 * @param {string}          [opts.method]       — POST (default), PUT, PATCH
 * @param {object}          [opts.fields]       — Text form fields {name: value}
 * @param {Array}           [opts.files]        — [{name, resolvedPath, filename?, contentType?}]
 *                                                 file data is a Buffer (read before this call)
 * @param {Array}           [opts.inlineFiles]  — [{name, filename, data: Buffer, contentType?}]
 * @param {object}          [opts.headers]      — Extra request headers
 * @param {number}          [opts.timeout]      — Timeout in seconds (default 30)
 * @returns {Promise<object>}
 */
async function multipartUpload(opts) {
  const rawUrl = opts.url;
  if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new ToolError("multipart_upload: 'url' is required.", -32602);
  }

  // Validate URL
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(rawUrl)) {
    throw new ToolError("multipart_upload: URL contains control characters.", -32602);
  }
  let parsedUrl;
  try { parsedUrl = new URL(rawUrl.trim()); } catch (_) {
    throw new ToolError(`multipart_upload: invalid URL: ${rawUrl}`, -32602);
  }
  if (!ALLOWED_SCHEMES.has(parsedUrl.protocol)) {
    throw new ToolError(
      `multipart_upload: unsupported scheme '${parsedUrl.protocol}' — only http: and https: are allowed.`,
      -32602
    );
  }

  const method = (opts.method || "POST").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new ToolError(
      `multipart_upload: method '${method}' not allowed. Use POST, PUT, or PATCH.`, -32602);
  }

  const timeoutMs = typeof opts.timeout === "number"
    ? Math.min(opts.timeout, 300) * 1000
    : DEFAULT_TIMEOUT;

  // ─ Validate field count ─
  const fields = opts.fields || {};
  if (typeof fields !== "object" || Array.isArray(fields)) {
    throw new ToolError("multipart_upload: 'fields' must be a plain object.", -32602);
  }
  const fieldCount = Object.keys(fields).length;
  if (fieldCount > MAX_FIELDS) {
    throw new ToolError(`multipart_upload: too many fields (${fieldCount} > ${MAX_FIELDS}).`, -32602);
  }

  // ─ Build file parts from pre-read Buffers (callers supply Buffer in opts.files) ─
  const fileParts = [];

  // Disk-read files (data already read by dispatch handler)
  for (const f of (opts.files || [])) {
    if (!f.name) throw new ToolError("multipart_upload: each file entry must have a 'name'.", -32602);
    if (!Buffer.isBuffer(f.data)) throw new ToolError(`multipart_upload: file '${f.name}' data must be a Buffer.`, -32602);
    fileParts.push({
      name:        f.name,
      filename:    f.filename || f.name,
      contentType: f.contentType || "application/octet-stream",
      data:        f.data,
    });
  }

  // Inline files
  for (const f of (opts.inlineFiles || [])) {
    if (!f.name) throw new ToolError("multipart_upload: each inline_file must have a 'name'.", -32602);
    let data;
    if (Buffer.isBuffer(f.data)) {
      data = f.data;
    } else if (typeof f.data === "string") {
      const enc = f.encoding === "base64" ? "base64" : "utf8";
      data = Buffer.from(f.data, enc);
    } else {
      throw new ToolError(`multipart_upload: inline_file '${f.name}' data must be a string or Buffer.`, -32602);
    }
    if (data.length > MAX_INLINE_SIZE) {
      throw new ToolError(`multipart_upload: inline_file '${f.name}' exceeds 50 MB limit.`, -32602);
    }
    fileParts.push({
      name:        f.name,
      filename:    f.filename || f.name,
      contentType: f.contentType || "application/octet-stream",
      data,
    });
  }

  if (Object.keys(fields).length === 0 && fileParts.length === 0) {
    throw new ToolError(
      "multipart_upload: provide at least one field, file, or inline_file.", -32602);
  }

  // ─ Build body ─
  const boundary = generateBoundary();
  const { body, partCount } = buildMultipartBody(boundary, fields, fileParts);

  // ─ Assemble headers ─
  const reqHeaders = {
    "user-agent":   "mcp-common-server/1.0 (multipart_upload)",
    "accept":       "*/*",
    "content-type": `multipart/form-data; boundary=${boundary}`,
    ...Object.fromEntries(
      Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    ),
  };

  // ─ Send ─
  let resp;
  try {
    resp = await makeRequest(parsedUrl, method, reqHeaders, body, timeoutMs);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`multipart_upload: request failed — ${e.message}`, -32603);
  }

  const bodyText = resp.body.toString("utf8");

  return {
    url:       parsedUrl.href,
    method,
    status:    resp.status,
    statusText: resp.statusMsg || "",
    ok:        resp.status >= 200 && resp.status < 300,
    headers:   resp.headers,
    body:      bodyText,
    bodySize:  resp.bodySize,
    truncated: resp.truncated,
    boundary,
    partCount,
    requestBodySize: body.length,
  };
}

module.exports = { multipartUpload };
