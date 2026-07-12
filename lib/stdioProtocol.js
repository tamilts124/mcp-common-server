"use strict";
// ── STDIO JSON-RPC PROTOCOL LOGIC (transport-agnostic, testable in isolation) ──
// Pure message-framing/dispatch logic shared by server-stdio.js. Extracted
// into its own module — with zero stdin/stdout/process side effects — so the
// isolated functional test suite can exercise line-buffering, JSON parsing,
// and JSON-RPC method dispatch directly (import + call + assert), exactly
// like every other lib/ module, instead of needing to spawn a real child
// process and pipe bytes into it.
//
// server-stdio.js itself stays a thin wrapper: read real stdin → splitLines
// → parseLine → handleMessage → write the result to real stdout.
const { TOOLS, executeTool, getErrorCode } = require("./executeTool");
const { serializeResult, formatError } = require("./safeSerialize");

const SERVER_NAME    = "mcp-file-server";
const SERVER_VERSION = "3.1.0";

/**
 * Split an accumulated input buffer into complete newline-terminated lines
 * plus whatever partial line is left over (to be prepended to the next
 * chunk). Strips a trailing \r from each line so \r\n input is tolerated.
 * Blank/whitespace-only lines are dropped — they carry no JSON-RPC message.
 *
 * @param {string} buffer
 * @returns {{ lines: string[], remainder: string }}
 */
function splitLines(buffer) {
  const lines = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, idx).replace(/\r$/, "");
    rest = rest.slice(idx + 1);
    if (line.trim()) lines.push(line);
  }
  return { lines, remainder: rest };
}

/**
 * Parse a single line of input as one JSON-RPC message.
 * @param {string} line
 * @returns {{ ok: true, msg: object } | { ok: false, error: Error }}
 */
function parseLine(line) {
  try {
    return { ok: true, msg: JSON.parse(line) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * Handle one already-parsed JSON-RPC message and return the response object
 * to send back, or `null` if no response should be written at all
 * (notifications per JSON-RPC 2.0 §4 — including unrecognized methods that
 * arrived with no `id`).
 *
 * Mirrors server-http.js's tools/call, tools/list, initialize, ping, and
 * notifications/initialized handling exactly, so both transports expose
 * identical protocol behavior on top of the same lib/executeTool.js dispatch.
 *
 * @param {object} msg  Parsed JSON-RPC request/notification (may be
 *   malformed/partial — this function never throws; on the one error path
 *   that can throw (executeTool), it is caught and turned into a JSON-RPC
 *   error response).
 * @returns {object|null}
 */
async function handleMessage(msg) {
  const { id, method, params } = msg || {};

  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list")
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    try {
      const result = await Promise.resolve(executeTool(name, args || {}));
      const { text, truncated, originalBytes } = serializeResult(result);
      if (truncated) {
        console.error(`[TOOL] ${name} — response truncated (${originalBytes} bytes > 3.5 MB limit)`);
      }
      return {
        jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text }],
        },
      };
    } catch (e) {
      const code = getErrorCode(e);
      const detail = formatError(e, name);
      console.error(`[TOOL ERROR] ${detail}`);
      return {
        jsonrpc: "2.0", id,
        // Proper JSON-RPC error envelope with full detail
        error: { code, message: e.message, data: { tool: name, stack: e.stack || null } },
        // MCP content envelope with rich error text for any client that reads result.content
        result: {
          content: [{ type: "text", text: detail }],
          isError: true,
        },
      };
    }
  }

  // Unknown method: only respond if it was a request (has an id). Per
  // JSON-RPC 2.0, notifications (no id) never get a response, recognized or not.
  if (id !== undefined)
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  return null;
}

module.exports = { splitLines, parseLine, handleMessage, SERVER_NAME, SERVER_VERSION };
