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
  process.on("unhandledRejection", (reason) => {
    const msg = reason && reason.stack ? reason.stack : String(reason);
    console.error(`[UNHANDLED REJECTION] ${msg}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[UNCAUGHT EXCEPTION] ${err && err.stack ? err.stack : err}`);
  });
}
module.exports = { installCrashGuard };
