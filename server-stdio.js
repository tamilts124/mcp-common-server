#!/usr/bin/env node

/**
 * MCP Common Server — stdio Transport  v3.1.0
 * For local MCP clients that launch a server as a child process and speak
 * JSON-RPC over stdin/stdout (e.g. Claude Desktop's local MCP integration,
 * Claude Code, and most "command + args" style MCP launchers).
 * Zero npm dependencies — pure Node.js built-ins only.
 *
 * ── Quick start ───────────────────────────────────────────────────────────────
 *
 *   # Single root, no exec
 *   MCP_ROOT_DIR=D:/myproject node server-stdio.js
 *
 *   # Multiple roots, exec enabled
 *   MCP_ALLOW_EXEC=true MCP_ROOTS=D:/proj1,D:/proj2 node server-stdio.js
 *
 *   # Or put everything in a .env file next to this script and run:
 *   node server-stdio.js
 *
 * Most MCP client configs look like:
 *   { "command": "node", "args": ["D:/ClaudeDir/mcp-common-server/server-stdio.js"],
 *     "env": { "MCP_ROOTS": "D:/proj1,D:/proj2", "MCP_ALLOW_EXEC": "true" } }
 *
 * ── Environment variables ─────────────────────────────────────────────────────
 * Same as server-http.js (see its header / README) EXCEPT `PORT` and
 * `MCP_AUTH_TOKEN` are not used here — stdio has no network listener and no
 * concept of an HTTP bearer token. The OS process boundary (whoever can spawn
 * this process and own its stdin/stdout pipes) is the trust boundary, which
 * matches how every other stdio MCP server in the ecosystem works.
 *
 * ── STDOUT GUARD ───────────────────────────────────────────────────────────────
 * This is the one transport where stdout corruption is fatal to the protocol:
 * stdout carries newline-delimited JSON-RPC messages ONLY. Every diagnostic /
 * lifecycle log in this file goes to console.error (stderr), never
 * console.log. Do not add a console.log anywhere in this file, or in any
 * lib/ module reachable from it, while it can run under this transport.
 *
 * ── Message framing ───────────────────────────────────────────────────────────
 * One JSON-RPC message per line on stdin, one JSON-RPC message per line on
 * stdout (ndjson — no Content-Length headers). Partial reads are buffered
 * until a full line is available. All of the actual framing/parsing/dispatch
 * logic lives in lib/stdioProtocol.js (pure functions, no I/O) so it can be
 * exercised by the isolated functional test suite directly — this file is
 * just real-stdin-in, real-stdout-out glue around that module.
 *
 * Tool dispatch itself is shared with server-http.js via lib/executeTool.js
 * — any tool added there is automatically available on both transports with
 * no changes needed here.
 */

const { READ_ONLY, ALLOW_EXEC, CMD_TIMEOUT, IGNORE_PATTERNS } = require("./lib/config");
const { ROOTS, buildRoots } = require("./lib/roots");
const { splitLines, parseLine, handleMessage, SERVER_VERSION } = require("./lib/stdioProtocol");
const { installCrashGuard } = require("./lib/crashGuard");

installCrashGuard();

try {
  buildRoots();
} catch (e) {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
}

console.error(`MCP Common Server (stdio) v${SERVER_VERSION}`);
console.error(`Roots:`);
for (const [alias, abs] of ROOTS) console.error(`  [${alias}] ${abs}`);
console.error(`ReadOnly  : ${READ_ONLY}`);
console.error(`Exec      : ${ALLOW_EXEC ? `enabled (timeout: ${CMD_TIMEOUT}s)` : "disabled"}`);
console.error(`Ignore    : ${IGNORE_PATTERNS.join(", ")}`);
console.error(`Transport : stdio (stdin/stdout JSON-RPC, ndjson)`);
console.error(`---`);

// ── WRITE — one JSON-RPC message, one line, stdout only ──────────────────────
function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

// ── READ — buffer stdin, dispatch each complete line ──────────────────────────
let buffer = "";

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const { lines, remainder } = splitLines(buffer);
  buffer = remainder;

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed.ok) {
      console.error(`[PARSE ERROR] ${parsed.error.message}`);
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }

    // handleMessage is async (tools like http_fetch are asynchronous).
    Promise.resolve(handleMessage(parsed.msg))
      .then((response) => {
        if (parsed.msg?.method === "tools/call") {
          const a = parsed.msg.params?.arguments;
          console.error(`[TOOL] ${parsed.msg.params?.name}`, a?.path || a?.command || a?.id ||
            (a?.files?.length ? `(${a.files.length} files)` : "") ||
            (a?.steps?.length ? `(${a.steps.length} steps)` : "") || "");
        }
        if (response) send(response);
      })
      .catch((e) => {
        // Should be unreachable — handleMessage already wraps executeTool in
        // its own try/catch — but this guarantees one malformed message can
        // never take the whole process down.
        console.error(`[FATAL DISPATCH ERROR] ${e.stack || e.message}`);
        if (parsed.msg && parsed.msg.id !== undefined) {
          send({ jsonrpc: "2.0", id: parsed.msg.id, error: { code: -32603, message: "Internal error" } });
        }
      });
  }
});

process.stdin.on("end", () => {
  console.error(`[STDIO] stdin closed — exiting.`);
  process.exit(0);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
