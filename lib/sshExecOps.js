"use strict";
// ── SSH EXEC OPERATIONS ────────────────────────────────────────────────────────
// Implements ssh_exec: exec (run remote command), copy_to (SCP local→remote),
// copy_from (SCP remote→local).
//
// Uses spawnSync with an EXPLICIT ARGS ARRAY — no shell=true, no interpolation.
// This is the same injection-safe pattern used by git_write_ops.
//
// Auth options (in precedence order):
//   1. key_path  — path to an existing private key file on disk
//   2. key_data  — PEM private key text; written to a temp file, used, deleted
//   3. SSH agent — if SSH_AUTH_SOCK is set (or Windows OpenSSH agent is running)
//
// Requires MCP_ALLOW_EXEC=true.

const childProcess = require("child_process");
const fs           = require("fs");
const os           = require("os");
const path         = require("path");
const crypto       = require("crypto");

const config = require("./config");
const { ToolError }  = require("./errors");

// ── Constants ────────────────────────────────────────────────────────────────
const SSH_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES       = 4 * 1024 * 1024;   // 4 MB stdout/stderr cap
const MAX_HOST_LEN           = 253;
const MAX_CMD_LEN            = 8_192;
const MAX_REMOTE_PATH_LEN    = 4_096;
const MAX_LOCAL_PATH_LEN     = 4_096;
const MAX_KEY_DATA_LEN       = 16_384;             // 16 KB — plenty for any PEM key

// ── Validation helpers ────────────────────────────────────────────────────────
function requireExec() {
  if (!config.ALLOW_EXEC)
    throw new ToolError(
      "ssh_exec is disabled. Start server with MCP_ALLOW_EXEC=true to enable.",
      -32001,
    );
}

/**
 * Guard: reject values that could perturb an SSH URI or cause DoS.
 * We pass args as an array (never via shell), so shell metacharacters are safe,
 * but null bytes crash spawnSync and lengths must be sane.
 */
function validateStr(value, label, maxLen) {
  maxLen = maxLen || 4096;
  if (typeof value !== "string")
    throw new ToolError(`ssh_exec: '${label}' must be a string, got ${typeof value}.`, -32602);
  if (value.length === 0)
    throw new ToolError(`ssh_exec: '${label}' must not be empty.`, -32602);
  if (value.length > maxLen)
    throw new ToolError(`ssh_exec: '${label}' exceeds ${maxLen} characters.`, -32602);
  if (/\0/.test(value))
    throw new ToolError(`ssh_exec: '${label}' contains null bytes.`, -32602);
}

/**
 * Validate an SSH hostname/IP. Must not contain shell-dangerous characters
 * that could escape argument quoting inside remote commands, and must conform
 * to basic hostname rules.
 *
 * Note: we pass host via `-o HostName=...` as a separate arg element,
 * so the only risk is to the *SSH host-pattern*, not a shell — but we
 * still reject \r \n \t and space to be safe.
 */
function validateHost(host) {
  validateStr(host, "host", MAX_HOST_LEN);
  // Reject control chars, whitespace, and OpenSSH pattern wildcards
  if (/[\r\n\t ]/.test(host))
    throw new ToolError("ssh_exec: 'host' must not contain whitespace or control characters.", -32602);
  // Reject characters that could form SSH ProxyJump/config injection
  if (/[,;@\*\?!%]/.test(host))
    throw new ToolError("ssh_exec: 'host' contains disallowed characters (,;@*?!%).", -32602);
}

function validatePort(port) {
  if (port == null) return;
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new ToolError("ssh_exec: 'port' must be an integer 1–65535.", -32602);
}

function validateUser(user) {
  if (!user) return;
  validateStr(user, "user", 64);
  if (/[\r\n\t @:\*\?]/.test(user))
    throw new ToolError("ssh_exec: 'user' contains disallowed characters.", -32602);
}

// ── Temp key file helper ───────────────────────────────────────────────────────
/**
 * Write a PEM private key to a temp file with mode 0600 and return its path.
 * Caller is responsible for unlinking it in a finally block.
 */
function writeTempKey(keyData) {
  // Validate length before writing
  if (typeof keyData !== "string" || keyData.length === 0)
    throw new ToolError("ssh_exec: 'key_data' must be a non-empty PEM string.", -32602);
  if (keyData.length > MAX_KEY_DATA_LEN)
    throw new ToolError(`ssh_exec: 'key_data' exceeds ${MAX_KEY_DATA_LEN} bytes.`, -32602);
  if (/\0/.test(keyData))
    throw new ToolError("ssh_exec: 'key_data' contains null bytes.", -32602);

  const rand   = crypto.randomBytes(16).toString("hex");
  const tmpDir = os.tmpdir();
  const tmpKey = path.join(tmpDir, `mcp_ssh_key_${rand}.pem`);

  fs.writeFileSync(tmpKey, keyData, { mode: 0o600, encoding: "utf8" });
  return tmpKey;
}

// ── Common SSH args builder ────────────────────────────────────────────────────
/**
 * Build common flags shared by ssh and scp:
 *   -p / -P port
 *   -i identity file
 *   -o StrictHostKeyChecking=...
 *   -o ConnectTimeout=...
 *   -o BatchMode=yes  (never block on interactive prompts)
 */
function buildCommonSshArgs(opts, isScp) {
  const args = [];
  const portFlag = isScp ? "-P" : "-p";

  if (opts.port) {
    args.push(portFlag, String(opts.port));
  }
  if (opts.key_path) {
    args.push("-i", opts.key_path);
  }

  // StrictHostKeyChecking: default 'accept-new' (trusts new hosts but rejects changed keys)
  // User can pass 'yes' to fully verify, or 'no' to skip (insecure, but sometimes needed).
  const shk = opts.strict_host_key_checking ?? "accept-new";
  const shkAllowed = ["yes", "no", "accept-new"];
  if (!shkAllowed.includes(shk))
    throw new ToolError(
      `ssh_exec: 'strict_host_key_checking' must be one of: ${shkAllowed.join(", ")}.`,
      -32602,
    );
  args.push("-o", `StrictHostKeyChecking=${shk}`);

  // BatchMode=yes prevents SSH from blocking on password prompts.
  // This is critical for a server tool — any interactive prompt would hang.
  args.push("-o", "BatchMode=yes");

  // ConnectTimeout in seconds (our timeout is in ms)
  const timeoutSec = Math.ceil((opts.timeout ?? SSH_DEFAULT_TIMEOUT_MS) / 1000);
  args.push("-o", `ConnectTimeout=${timeoutSec}`);

  // Suppress pseudo-TTY allocation (avoids MOTD noise on stdout)
  if (!isScp) {
    args.push("-T");
  }

  // Known-hosts file: use /dev/null when strict checking is off to avoid
  // permanently polluting the system known_hosts file.
  if (shk === "no") {
    // On Windows /dev/null doesn't exist; use NUL
    const nullDev = process.platform === "win32" ? "NUL" : "/dev/null";
    args.push("-o", `UserKnownHostsFile=${nullDev}`);
  }

  return args;
}

// ── Build the [user@]host string ──────────────────────────────────────────────
function buildTarget(user, host) {
  return user ? `${user}@${host}` : host;
}

// ── spawnSync wrapper ─────────────────────────────────────────────────────────
function runSpawn(binary, args, opts) {
  const timeoutMs = opts.timeout ?? SSH_DEFAULT_TIMEOUT_MS;
  const result = childProcess.spawnSync(binary, args, {
    timeout:     timeoutMs,
    encoding:    "buffer",     // get raw Buffer so we can cap bytes
    maxBuffer:   MAX_OUTPUT_BYTES + 1024,
    windowsHide: true,
    // Never inherit env vars that could interfere with SSH behaviour.
    // Pass through only PATH, HOME, SSH_AUTH_SOCK (for agent auth).
    env: {
      PATH:          process.env.PATH || "",
      HOME:          process.env.HOME || process.env.USERPROFILE || "",
      USERPROFILE:   process.env.USERPROFILE || "",
      SystemRoot:    process.env.SystemRoot || "",
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK || "",
    },
  });

  if (result.error) {
    // ETIMEDOUT / ENOENT / etc.
    const isTimeout = result.error.code === "ETIMEDOUT" ||
                      (result.timedOut === true);
    if (isTimeout)
      throw new ToolError(
        `ssh_exec: timed out after ${timeoutMs}ms waiting for '${binary}'.`,
        -32603,
      );
    throw new ToolError(
      `ssh_exec: failed to launch '${binary}': ${result.error.message}`,
      -32603,
    );
  }

  // Decode and cap stdout/stderr
  let stdout = result.stdout
    ? result.stdout.slice(0, MAX_OUTPUT_BYTES).toString("utf8")
    : "";
  let stderr = result.stderr
    ? result.stderr.slice(0, MAX_OUTPUT_BYTES).toString("utf8")
    : "";

  const stdoutTruncated = result.stdout && result.stdout.length > MAX_OUTPUT_BYTES;
  const stderrTruncated = result.stderr && result.stderr.length > MAX_OUTPUT_BYTES;
  if (stdoutTruncated) stdout += "\n[OUTPUT TRUNCATED — 4 MB cap reached]";
  if (stderrTruncated) stderr += "\n[STDERR TRUNCATED — 4 MB cap reached]";

  return {
    exitCode: result.status ?? -1,
    stdout,
    stderr,
    stdoutTruncated: !!stdoutTruncated,
    stderrTruncated: !!stderrTruncated,
    timedOut: !!result.timedOut,
  };
}

// ── Operation: exec ────────────────────────────────────────────────────────────
/**
 * Run a command on a remote host via SSH.
 *
 * Returns:
 *   { host, user, port, command, exitCode, stdout, stderr,
 *     stdoutTruncated, stderrTruncated, timedOut, success }
 */
function opExec(args) {
  validateHost(args.host);
  validateUser(args.user);
  validatePort(args.port);
  validateStr(args.command, "command", MAX_CMD_LEN);

  let tmpKeyPath = null;
  try {
    // Prepare auth: key_data wins over key_path
    const opts = { ...args };
    if (args.key_data) {
      tmpKeyPath = writeTempKey(args.key_data);
      opts.key_path = tmpKeyPath;
    } else if (args.key_path) {
      validateStr(args.key_path, "key_path", MAX_LOCAL_PATH_LEN);
    }

    const sshArgs = [
      ...buildCommonSshArgs(opts, false),
      buildTarget(args.user, args.host),
      // Command is a SINGLE STRING arg — SSH itself passes it to the remote shell.
      // This is equivalent to `ssh host 'command'` but without shell quoting.
      args.command,
    ];

    const out = runSpawn("ssh", sshArgs, { timeout: args.timeout ?? SSH_DEFAULT_TIMEOUT_MS });

    return {
      host:             args.host,
      user:             args.user || null,
      port:             args.port || 22,
      command:          args.command,
      exitCode:         out.exitCode,
      stdout:           out.stdout,
      stderr:           out.stderr,
      stdoutTruncated:  out.stdoutTruncated,
      stderrTruncated:  out.stderrTruncated,
      timedOut:         out.timedOut,
      success:          out.exitCode === 0,
    };
  } finally {
    if (tmpKeyPath) {
      try { fs.unlinkSync(tmpKeyPath); } catch (_) {}
    }
  }
}

// ── Operation: copy_to ─────────────────────────────────────────────────────────
/**
 * Copy a local file/directory to a remote host via SCP.
 *
 * Returns:
 *   { host, user, port, local_path, remote_path, exitCode, stderr,
 *     timedOut, success }
 */
function opCopyTo(args) {
  validateHost(args.host);
  validateUser(args.user);
  validatePort(args.port);
  validateStr(args.local_path,  "local_path",  MAX_LOCAL_PATH_LEN);
  validateStr(args.remote_path, "remote_path", MAX_REMOTE_PATH_LEN);

  let tmpKeyPath = null;
  try {
    const opts = { ...args };
    if (args.key_data) {
      tmpKeyPath = writeTempKey(args.key_data);
      opts.key_path = tmpKeyPath;
    } else if (args.key_path) {
      validateStr(args.key_path, "key_path", MAX_LOCAL_PATH_LEN);
    }

    const scpArgs = [
      ...buildCommonSshArgs(opts, true),
    ];
    if (args.recursive) scpArgs.push("-r");
    // SCP source (local) and destination (remote)
    scpArgs.push(
      args.local_path,
      `${buildTarget(args.user, args.host)}:${args.remote_path}`,
    );

    const out = runSpawn("scp", scpArgs, { timeout: args.timeout ?? SSH_DEFAULT_TIMEOUT_MS });

    return {
      host:        args.host,
      user:        args.user || null,
      port:        args.port || 22,
      local_path:  args.local_path,
      remote_path: args.remote_path,
      exitCode:    out.exitCode,
      stdout:      out.stdout,
      stderr:      out.stderr,
      timedOut:    out.timedOut,
      success:     out.exitCode === 0,
    };
  } finally {
    if (tmpKeyPath) {
      try { fs.unlinkSync(tmpKeyPath); } catch (_) {}
    }
  }
}

// ── Operation: copy_from ───────────────────────────────────────────────────────
/**
 * Copy a remote file/directory to a local path via SCP.
 *
 * Returns:
 *   { host, user, port, remote_path, local_path, exitCode, stderr,
 *     timedOut, success }
 */
function opCopyFrom(args) {
  validateHost(args.host);
  validateUser(args.user);
  validatePort(args.port);
  validateStr(args.remote_path, "remote_path", MAX_REMOTE_PATH_LEN);
  validateStr(args.local_path,  "local_path",  MAX_LOCAL_PATH_LEN);

  let tmpKeyPath = null;
  try {
    const opts = { ...args };
    if (args.key_data) {
      tmpKeyPath = writeTempKey(args.key_data);
      opts.key_path = tmpKeyPath;
    } else if (args.key_path) {
      validateStr(args.key_path, "key_path", MAX_LOCAL_PATH_LEN);
    }

    const scpArgs = [
      ...buildCommonSshArgs(opts, true),
    ];
    if (args.recursive) scpArgs.push("-r");
    // SCP source (remote) and destination (local)
    scpArgs.push(
      `${buildTarget(args.user, args.host)}:${args.remote_path}`,
      args.local_path,
    );

    const out = runSpawn("scp", scpArgs, { timeout: args.timeout ?? SSH_DEFAULT_TIMEOUT_MS });

    return {
      host:        args.host,
      user:        args.user || null,
      port:        args.port || 22,
      remote_path: args.remote_path,
      local_path:  args.local_path,
      exitCode:    out.exitCode,
      stdout:      out.stdout,
      stderr:      out.stderr,
      timedOut:    out.timedOut,
      success:     out.exitCode === 0,
    };
  } finally {
    if (tmpKeyPath) {
      try { fs.unlinkSync(tmpKeyPath); } catch (_) {}
    }
  }
}

// ── Main dispatcher ────────────────────────────────────────────────────────────
const VALID_OPS = ["exec", "copy_to", "copy_from"];

function sshExec(args) {
  requireExec();

  if (!args.operation)
    throw new ToolError("ssh_exec: 'operation' is required.", -32602);
  if (!VALID_OPS.includes(args.operation))
    throw new ToolError(
      `ssh_exec: unknown operation '${args.operation}'. Valid: ${VALID_OPS.join(", ")}.`,
      -32602,
    );
  if (!args.host)
    throw new ToolError("ssh_exec: 'host' is required.", -32602);

  switch (args.operation) {
    case "exec":      return opExec(args);
    case "copy_to":   return opCopyTo(args);
    case "copy_from": return opCopyFrom(args);
    default:
      throw new ToolError(`ssh_exec: unhandled operation '${args.operation}'.`, -32603);
  }
}

module.exports = {
  sshExec,
  // Export helpers for tests
  _validateHost: validateHost,
  _validateUser: validateUser,
  _buildCommonSshArgs: buildCommonSshArgs,
  _buildTarget: buildTarget,
  _writeTempKey: writeTempKey,
};
