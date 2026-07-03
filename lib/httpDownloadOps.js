"use strict";
// ── HTTP_DOWNLOAD — stream a URL's response body directly to a jailed disk
// file, instead of buffering into memory (http_fetch caps bodies at 100KB
// and returns them as in-memory UTF-8 text; this tool is for larger and/or
// binary payloads — installers, archives, datasets, images — that need to
// land on disk without ever materialising fully as a JS string/Buffer).
//
// Reuses http_fetch's URL validation (http/https only, control-char guard)
// and redirect-following convention (up to MAX_REDIRECTS hops, loop-safe).
// GET only — this is a download tool, not a general request tool (use
// http_fetch for POST/PUT/etc against APIs).
//
// Security notes:
//   - destResolved is expected to already be jail-checked by the caller
//     (resolveClientPath in dispatchWrite.js), same convention as every
//     other write-gated tool in this module family.
//   - Byte cap is enforced mid-stream: once the response body exceeds
//     max_bytes, the request is aborted and the partial file on disk is
//     deleted — callers never receive a silently-truncated file they might
//     mistake for complete.
//   - Write-gated: blocked when MCP_READ_ONLY=true (enforced centrally via
//     WRITE_TOOLS in lib/toolsSchema.js, same as every other write tool).

const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const https = require("https");
const { URL } = require("url");
const { ToolError } = require("./errors");
const { parseUrl, MAX_REDIRECTS } = require("./httpFetchOps");

const DEFAULT_MAX_BYTES  = 100 * 1024 * 1024; // 100 MB
const HARD_CAP_BYTES     = 500 * 1024 * 1024; // 500 MB — never allow more, regardless of caller input
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Download `url` (GET) to `destResolved`, following redirects, streaming
 * straight to disk with a byte cap enforced mid-stream.
 *
 * @param {string} url
 * @param {string} destResolved   Absolute, jail-checked destination path.
 * @param {string} destOrigPath   Client-relative path echoed back in the result.
 * @param {object} [opts]
 * @param {object} [opts.headers]
 * @param {number} [opts.timeout]   Seconds, capped at 120.
 * @param {number} [opts.max_bytes] Byte cap, capped at HARD_CAP_BYTES (default 100MB).
 * @returns {Promise<{url, path, status, contentType, bytesWritten, redirected, truncated}>}
 */
async function httpDownload(url, destResolved, destOrigPath, opts = {}) {
  const rawUrl = url;
  if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new ToolError("http_download: 'url' is required and must be a non-empty string.", -32602);
  }

  const timeoutMs = typeof opts.timeout === "number"
    ? Math.min(Math.max(opts.timeout, 1), 120) * 1000
    : DEFAULT_TIMEOUT_MS;

  let maxBytes = typeof opts.max_bytes === "number" ? opts.max_bytes : DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) maxBytes = DEFAULT_MAX_BYTES;
  maxBytes = Math.min(maxBytes, HARD_CAP_BYTES);

  const reqHeaders = {
    "user-agent": "mcp-common-server/1.0 (http_download)",
    "accept": "*/*",
    ...Object.fromEntries(
      Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    ),
  };

  fs.mkdirSync(path.dirname(destResolved), { recursive: true });

  let parsedUrl = parseUrl(rawUrl.trim());
  let redirected = false;
  const visited = new Set();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const href = parsedUrl.href;
    if (visited.has(href)) {
      throw new ToolError(`http_download: redirect loop detected at ${href}.`, -32603);
    }
    visited.add(href);

    const result = await new Promise((resolve, reject) => {
      const mod = parsedUrl.protocol === "https:" ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: "GET",
        headers: reqHeaders,
      };

      const req = mod.request(options, (res) => {
        // Redirect: drain this response and resolve with a redirect marker.
        if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
          res.resume(); // discard body
          resolve({ redirect: res.headers.location });
          return;
        }

        const out = fs.createWriteStream(destResolved);
        let bytesWritten = 0;
        let truncated = false;
        let settled = false;

        const cleanupPartial = () => {
          out.destroy();
          fs.unlink(destResolved, () => {});
        };

        res.on("data", (chunk) => {
          if (settled) return;
          bytesWritten += chunk.length;
          if (bytesWritten > maxBytes) {
            truncated = true;
            settled = true;
            res.destroy();
            cleanupPartial();
            reject(new ToolError(
              `http_download: response exceeded max_bytes (${maxBytes}) — aborted, no partial file left on disk.`,
              -32603
            ));
            return;
          }
          out.write(chunk);
        });

        res.on("end", () => {
          if (settled) return;
          settled = true;
          out.end(() => {
            resolve({
              status: res.statusCode,
              contentType: res.headers["content-type"] || null,
              bytesWritten,
              truncated,
            });
          });
        });

        res.on("error", (e) => {
          if (settled) return;
          settled = true;
          cleanupPartial();
          reject(e);
        });

        out.on("error", (e) => {
          if (settled) return;
          settled = true;
          reject(e);
        });
      });

      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new ToolError(`http_download: request timed out after ${timeoutMs / 1000}s.`, -32603));
      });
      req.end();
    });

    if (result.redirect) {
      redirected = true;
      try { parsedUrl = new URL(result.redirect, parsedUrl); } catch (_) {
        throw new ToolError(`http_download: invalid redirect Location: ${result.redirect}`, -32603);
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new ToolError(`http_download: redirect to unsupported scheme '${parsedUrl.protocol}' blocked.`, -32601);
      }
      continue;
    }

    return {
      url: parsedUrl.href,
      path: destOrigPath,
      status: result.status,
      contentType: result.contentType,
      bytesWritten: result.bytesWritten,
      redirected,
      truncated: result.truncated,
    };
  }

  throw new ToolError(`http_download: too many redirects (max ${MAX_REDIRECTS}) for ${rawUrl}.`, -32603);
}

module.exports = { httpDownload };
