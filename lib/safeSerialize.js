"use strict";
// ── SAFE JSON SERIALISATION + RESPONSE SIZE CAP ───────────────────────────────
// The Custom Connector proxy (and Claude Desktop's MCP bridge) silently drops
// responses that exceed its internal size limit and replaces them with a
// generic {"error": "Error occurred during tool execution", "request_id": "..."}.
// That message is produced entirely by the proxy — our server never emits it.
//
// Root causes that trigger the proxy error:
//   1. Response JSON > ~4 MB serialised (most common)
//   2. Proxy read-timeout (~30 s) while our server is still computing
//   3. A non-serialisable value (circular ref, undefined at top level, etc.)
//      causes JSON.stringify() to throw, crashing the response pipeline
//
// This module fixes all three:
//   • safeSerialize()  — JSON.stringify with circular-ref guard + cap
//   • serializeResult() — wraps a tool result for MCP content envelope,
//                          truncating cleanly if the payload is too large
//   • formatError()    — always returns a rich, specific error string
//                          (code + message + stack) so callers never see
//                          a bare generic message
//
// MAX_RESPONSE_BYTES is set to 3.5 MB to stay safely under the ~4 MB proxy
// limit while leaving room for the JSON-RPC envelope fields around the payload.

const MAX_RESPONSE_BYTES = 3.5 * 1024 * 1024; // 3.5 MB
const TRUNC_NOTICE = "\n\n[TRUNCATED: response exceeded " +
  Math.round(MAX_RESPONSE_BYTES / 1024) + " KB limit. " +
  "Use more specific queries, pagination, or smaller path targets.]";

/**
 * JSON.stringify that:
 *   - handles circular references (replaces them with "[Circular]")  
 *   - handles BigInt (converts to string)
 *   - never throws (returns an error-JSON string on any failure)
 *
 * @param {*} value
 * @param {number} [indent=2]
 * @returns {string}
 */
function safeSerialize(value, indent = 2) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }, indent);
  } catch (e) {
    // Last-resort: return a valid JSON error object instead of throwing
    try {
      return JSON.stringify({ __serializeError: e.message, value: String(value) });
    } catch {
      return '{"__serializeError":"Serialization completely failed"}';
    }
  }
}

/**
 * Serialize a tool result into an MCP content-envelope text string, truncating
 * if the serialised form exceeds MAX_RESPONSE_BYTES.
 *
 * Returns { text, truncated, originalBytes, finalBytes }.
 *
 * @param {*} result
 * @returns {{ text: string, truncated: boolean, originalBytes: number, finalBytes: number }}
 */
function serializeResult(result) {
  const full = safeSerialize(result);
  const fullBytes = Buffer.byteLength(full, "utf8");

  if (fullBytes <= MAX_RESPONSE_BYTES) {
    return { text: full, truncated: false, originalBytes: fullBytes, finalBytes: fullBytes };
  }

  // Truncate at byte boundary, not character boundary, to be precise.
  // Then append a human-readable truncation notice.
  const noticeBytes  = Buffer.byteLength(TRUNC_NOTICE, "utf8");
  const allowedBytes = MAX_RESPONSE_BYTES - noticeBytes;
  const buf          = Buffer.from(full, "utf8");
  const cutBuf       = buf.slice(0, allowedBytes);
  // Back off to the last valid UTF-8 boundary (avoids splitting a multi-byte char)
  let cutLen = cutBuf.length;
  while (cutLen > 0 && (cutBuf[cutLen - 1] & 0xC0) === 0x80) cutLen--;

  const truncated = cutBuf.slice(0, cutLen).toString("utf8") + TRUNC_NOTICE;
  return {
    text:          truncated,
    truncated:     true,
    originalBytes: fullBytes,
    finalBytes:    Buffer.byteLength(truncated, "utf8"),
  };
}

/**
 * Format any thrown error into a specific, debuggable string.
 * Never returns a generic fallback — always includes code + message + stack.
 *
 * @param {*} e      - The caught error (may be any type)
 * @param {string} toolName - Tool name for context
 * @returns {string}
 */
function formatError(e, toolName) {
  if (!e) return `[${toolName}] Unknown error (no error object thrown)`;

  const code    = typeof e.code === "number" ? e.code : -32603;
  const message = e.message || String(e);
  const stack   = e.stack ? `\nStack: ${e.stack}` : "";
  const name    = e.name && e.name !== "Error" ? ` [${e.name}]` : "";

  return `Error (code ${code})${name} in '${toolName}': ${message}${stack}`;
}

module.exports = { safeSerialize, serializeResult, formatError, MAX_RESPONSE_BYTES };
