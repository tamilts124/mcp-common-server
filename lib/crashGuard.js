"use strict";
// Global safety net for both transports. Without this, a stray rejection
// from a background source (e.g. playwright-extra's stealth plugin firing a
// CDP call after its target page/context/browser already closed) crashes
// the entire Node process via Node's default unhandledRejection behavior —
// taking down every tool and every other browser session with it, not just
// the offending one. Logs to stderr (never stdout — see stdio transport
// guard) and keeps the process alive. Idempotent: safe to call more than
// once, only installs listeners on the first call.
let installed = false;
function installCrashGuard() {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason, promise) => {
    const msg = reason && reason.stack ? reason.stack : String(reason);
    // Extract tool_name and request_id from the promise's context if available
    const ctx = (promise && promise.__mcpContext) || {};
    const tool = ctx.tool_name || "unknown_tool";
    const reqId = ctx.request_id || "unknown_req";
    console.error(`[UNHANDLED REJECTION][tool:${tool}][req:${reqId}] ${msg}`);
  });
  process.on("uncaughtException", (err) => {
    const msg = err && err.stack ? err.stack : String(err);
    const tool = (err && err.__mcpTool) || "unknown_tool";
    const reqId = (err && err.__mcpRequestId) || "unknown_req";
    console.error(`[UNCAUGHT EXCEPTION][tool:${tool}][req:${reqId}] ${msg}`);
  });
}
module.exports = { installCrashGuard };
