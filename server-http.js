#!/usr/bin/env node

/**
 * MCP File Server — HTTP + SSE Transport  v3.1.0
 * For Claude Web (claude.ai) via ngrok or any public HTTPS URL
 * Zero npm dependencies — pure Node.js built-ins only
 *
 * ── Quick start ───────────────────────────────────────────────────────────────
 *
 *   # Single root, no auth, no exec
 *   MCP_ROOT_DIR=D:/myproject node server-http.js
 *
 *   # Multiple roots
 *   MCP_ROOTS=D:/proj1,D:/proj2 node server-http.js
 *
 *   # With auth token
 *   MCP_AUTH_TOKEN=mysecret MCP_ROOTS=D:/proj1,D:/proj2 node server-http.js
 *
 *   # With shell command execution enabled
 *   MCP_ALLOW_EXEC=true MCP_ROOT_DIR=D:/myproject node server-http.js
 *
 *   # Or just put everything in a .env file next to this script and run:
 *   node server-http.js
 *
 * ── All environment variables ─────────────────────────────────────────────────
 *
 *   PORT              HTTP port (default: 3000)
 *   MCP_ROOT_DIR      Single root directory (backwards compat)
 *   MCP_ROOTS         Comma-separated list of root directories
 *   MCP_AUTH_TOKEN    Bearer token for auth. Omit = open access (default)
 *   MCP_READ_ONLY     true = disable all write/delete/exec tools (default: false)
 *   MCP_ALLOW_EXEC    true = enable run_command, execute_pipeline, start_process,
 *                     get_process_output, kill_process exec steps
 *                     (default: false — exec tools hidden from tools/list)
 *   MCP_CMD_TIMEOUT   Max seconds a run_command may run (default: 60)
 *   MCP_IGNORE        Comma-separated dir/file names to skip in listings
 *                     (default: node_modules,.git,__pycache__,.nyc_output,dist,build)
 *
 * Implementation is split across lib/:
 *   lib/config.js       — .env loading + env var config
 *   lib/roots.js         — multi-root setup, path jailing, ignore patterns
 *   lib/fileOps.js       — file/dir read/write/search/find/replace helpers
 *   lib/processOps.js    — run_command / background process management
 *   lib/toolsSchema.js   — JSON-RPC tool schema declarations
 *   lib/executeTool.js   — tool dispatch + execute_pipeline
 */

const http   = require("http");
const crypto = require("crypto");

const { PORT, AUTH_TOKEN, READ_ONLY, ALLOW_EXEC, CMD_TIMEOUT, IGNORE_PATTERNS } = require("./lib/config");
const { ROOTS, buildRoots } = require("./lib/roots");
const { TOOLS, executeTool, getErrorCode } = require("./lib/executeTool");
const { installCrashGuard } = require("./lib/crashGuard");

installCrashGuard();

buildRoots();

console.log(`MCP File Server (HTTP+SSE) v3.1.0`);
console.log(`Roots:`);
for (const [alias, abs] of ROOTS) console.log(`  [${alias}] ${abs}`);
console.log(`Auth      : ${AUTH_TOKEN ? "enabled (token set)" : "disabled (open)"}`);
console.log(`ReadOnly  : ${READ_ONLY}`);
console.log(`Exec      : ${ALLOW_EXEC ? `enabled (timeout: ${CMD_TIMEOUT}s)` : "disabled"}`);
console.log(`Ignore    : ${IGNORE_PATTERNS.join(", ")}`);
console.log(`Port      : ${PORT}`);
console.log("---");

// ── AUTH ──────────────────────────────────────────────────────────────────────
function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers["authorization"] || "";
  return header === `Bearer ${AUTH_TOKEN}`;
}

// ── SSE SESSION STORE ─────────────────────────────────────────────────────────
const sessions = new Map(); // sessionId → { res, lastSeen }

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      console.log(`[SSE] Pruning stale session: ${id}`);
      sessions.delete(id);
    }
  }
}, 60_000);

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (!checkAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized — invalid or missing Bearer token" }));
    return;
  }

  // ── GET /sse ───────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/sse") {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
    sessions.set(sessionId, { res, lastSeen: Date.now() });
    console.log(`[SSE] Client connected: ${sessionId}`);

    const keepalive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); }
    }, 20_000);

    req.on("close", () => {
      clearInterval(keepalive);
      sessions.delete(sessionId);
      console.log(`[SSE] Client disconnected: ${sessionId}`);
    });
    return;
  }

  // ── POST /message ──────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/message") {
    const sessionId = url.searchParams.get("sessionId");
    const session   = sessions.get(sessionId);
    if (session) session.lastSeen = Date.now();

    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400); res.end("Bad JSON"); return;
      }

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      const respond = (payload) => {
        if (!session) return;
        session.res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const { id, method, params } = msg;

      if (method === "initialize") {
        return respond({ jsonrpc: "2.0", id, result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-file-server", version: "3.1.0" },
        }});
      }
      if (method === "notifications/initialized") return;
      if (method === "ping") return respond({ jsonrpc: "2.0", id, result: {} });

      if (method === "tools/list")
        return respond({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

      if (method === "tools/call") {
        const { name, arguments: args } = params;
        Promise.resolve()
          .then(() => executeTool(name, args || {}))
          .then((result) => {
            console.log(`[TOOL] ${name}`, args?.path || args?.command || args?.id || (args?.files?.length ? `(${args.files.length} files)` : "") || (args?.steps?.length ? `(${args.steps.length} steps)` : "") || "");
            respond({ jsonrpc: "2.0", id, result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            }});
          })
          .catch((e) => {
            const code = getErrorCode(e);
            console.error(`[TOOL ERROR] ${name} (code ${code}): ${e.message}`);
            respond({ jsonrpc: "2.0", id,
              error: { code, message: e.message },
              result: {
                content: [{ type: "text", text: `Error (${code}): ${e.message}` }],
                isError: true,
              },
            });
          });
        return;
      }

      if (id !== undefined)
        respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    });
    return;
  }

  // ── GET / — Health check ───────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:    "ok",
      server:    "mcp-file-server",
      version:   "3.1.0",
      readOnly:  READ_ONLY,
      auth:      !!AUTH_TOKEN,
      execEnabled: ALLOW_EXEC,
      roots:     Object.fromEntries(ROOTS),
      tools:     TOOLS.map(t => t.name),
    }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`   SSE endpoint : http://localhost:${PORT}/sse`);
  console.log(`   Health check : http://localhost:${PORT}/`);
  console.log(`\nNow run: ngrok http ${PORT}`);
  console.log(`Then add https://xxxx.ngrok-free.app/sse to Claude Web integrations\n`);
});
