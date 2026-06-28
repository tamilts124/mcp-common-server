"use strict";
// ── SHARED JSON-RPC ERROR TYPES ───────────────────────────────────────────────
// Kept in a standalone module so any lib/ file can import ToolError without
// creating a circular dependency through executeTool.js.
//
// Standard JSON-RPC 2.0 codes used in this server:
//   -32601  Method not found      (unknown tool name)
//   -32602  Invalid params        (missing/invalid required field per inputSchema)
//   -32603  Internal error        (default fallback for any untagged thrown error)
//   -32001  App-reserved          (policy denial: read-only mode, exec disabled)

class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

// Returns the JSON-RPC error code for a thrown error: the error's own .code
// if it is a tagged ToolError, otherwise -32603 (internal error) by default.
function getErrorCode(err) {
  return (err && typeof err.code === "number") ? err.code : -32603;
}

module.exports = { ToolError, getErrorCode };
