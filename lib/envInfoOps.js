"use strict";
// ── ENV INFO ─────────────────────────────────────────────────────────────────
// env_info — read-only, secret-free snapshot of the server's runtime environment.

/**
 * Return structured, read-only information about the server environment.
 * Safe to expose: only static/public system facts — NO environment variables,
 * NO secrets, NO file system paths beyond the configured roots.
 *
 * @returns {{
 *   nodeVersion: string,
 *   platform: string,
 *   arch: string,
 *   hostname: string,
 *   uptimeSeconds: number,
 *   roots: string[],
 *   readOnly: boolean,
 *   allowExec: boolean,
 *   cmdTimeoutSeconds: number
 * }}
 */
function envInfo() {
  const os  = require("os");
  const { READ_ONLY, ALLOW_EXEC, CMD_TIMEOUT } = require("./config");
  const { ROOTS } = require("./roots");

  return {
    nodeVersion:       process.version,
    platform:          process.platform,
    arch:              process.arch,
    hostname:          os.hostname(),
    uptimeSeconds:     Math.floor(process.uptime()),
    roots:             [...ROOTS.keys()],
    readOnly:          READ_ONLY,
    allowExec:         ALLOW_EXEC,
    cmdTimeoutSeconds: CMD_TIMEOUT,
  };
}

module.exports = { envInfo };
