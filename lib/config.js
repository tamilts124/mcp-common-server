"use strict";
// ── CONFIG & .ENV LOADING ──────────────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");

function loadEnvFile(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    for (const raw of txt.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val; // existing env vars always win
    }
  } catch (_) { /* no .env file present — fine, rely on real env vars */ }
}

// Load .env from the project root (one level up from lib/)
loadEnvFile(path.join(__dirname, "..", ".env"));

const PORT        = parseInt(process.env.PORT || "3000");
const AUTH_TOKEN  = process.env.MCP_AUTH_TOKEN  || null;
const READ_ONLY   = process.env.MCP_READ_ONLY   === "true";
const ALLOW_EXEC  = process.env.MCP_ALLOW_EXEC  === "true" && !READ_ONLY;
const CMD_TIMEOUT = parseInt(process.env.MCP_CMD_TIMEOUT || "60");
const IGNORE_PATTERNS = (
  process.env.MCP_IGNORE || "node_modules,.git,__pycache__,.nyc_output,dist,build"
).split(",").map(s => s.trim()).filter(Boolean);

module.exports = {
  loadEnvFile, PORT, AUTH_TOKEN, READ_ONLY, ALLOW_EXEC, CMD_TIMEOUT, IGNORE_PATTERNS,
};
