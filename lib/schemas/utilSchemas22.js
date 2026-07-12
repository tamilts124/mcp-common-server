"use strict";
// ── Schema 22: ssh_exec ───────────────────────────────────────────────────────────────
const UTIL_SCHEMAS_22 = [
  {
    name: "ssh_exec",
    description:
      "Execute a command or copy files over SSH/SCP using the system OpenSSH client " +
      "(available on Windows 10+, Linux, and macOS). " +
      "Three operations: exec — run a shell command on the remote host and return stdout/stderr/exitCode; " +
      "copy_to — SCP a local file or directory to the remote host; " +
      "copy_from — SCP a remote file or directory to a local path. " +
      "Auth: supply 'key_path' (path to a PEM private key on disk) or 'key_data' (inline PEM text, written " +
      "to a secure temp file and deleted after use), or rely on a running SSH agent (SSH_AUTH_SOCK). " +
      "Uses spawnSync with an explicit args array — no shell interpolation, no injection risk. " +
      "BatchMode=yes is always set so a missing key never hangs on a password prompt. " +
      "Requires MCP_ALLOW_EXEC=true.",
    inputSchema: {
      type: "object",
      required: ["operation", "host"],
      properties: {
        // ── Common ───────────────────────────────────────────────────────────────
        operation: {
          type: "string",
          enum: ["exec", "copy_to", "copy_from"],
          description:
            "'exec' — run a command on the remote host. " +
            "'copy_to' — SCP a local file/directory to the remote host. " +
            "'copy_from' — SCP a remote file/directory to a local path.",
        },
        host: {
          type: "string",
          description: "Remote hostname or IP address (e.g. 'example.com', '192.168.1.10'). Max 253 characters.",
        },
        user: {
          type: "string",
          description: "Remote username (e.g. 'ubuntu', 'root'). Omit to use the SSH default (current OS user or ~/.ssh/config).",
        },
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "Remote SSH port (default: 22).",
        },
        // ── Auth ─────────────────────────────────────────────────────────────────
        key_path: {
          type: "string",
          description: "Path to a PEM private key file on disk (e.g. '~/.ssh/id_rsa'). Cannot be used with 'key_data'.",
        },
        key_data: {
          type: "string",
          description:
            "Inline PEM private key text (e.g. '-----BEGIN OPENSSH PRIVATE KEY-----\\n...'). " +
            "Written to a secure temp file (mode 0600) and deleted immediately after use. " +
            "Cannot be used with 'key_path'. Max 16 KB.",
        },
        // ── Security ─────────────────────────────────────────────────────────────
        strict_host_key_checking: {
          type: "string",
          enum: ["yes", "no", "accept-new"],
          description:
            "StrictHostKeyChecking SSH option: " +
            "'accept-new' (default) — trust new/unknown hosts but reject changed keys; " +
            "'yes' — fail if the host is not already in known_hosts; " +
            "'no' — skip host key checking entirely (insecure; also routes to /dev/null known_hosts).",
        },
        // ── Timing ────────────────────────────────────────────────────────────────
        timeout: {
          type: "integer",
          minimum: 1000,
          maximum: 300_000,
          description: "Total operation timeout in milliseconds (default: 30000 = 30 s).",
        },
        // ── exec-only ────────────────────────────────────────────────────────────
        command: {
          type: "string",
          description:
            "[exec only] The shell command to run on the remote host. " +
            "Passed as a single argument to ssh, which hands it to the remote shell " +
            "($SHELL or /bin/sh). Max 8192 characters.",
        },
        // ── copy_to / copy_from ──────────────────────────────────────────────────
        local_path: {
          type: "string",
          description:
            "[copy_to / copy_from] " +
            "For copy_to: the local file or directory to send. " +
            "For copy_from: the local destination path to receive into.",
        },
        remote_path: {
          type: "string",
          description:
            "[copy_to / copy_from] " +
            "For copy_to: the remote destination path (e.g. '/tmp/file.txt'). " +
            "For copy_from: the remote file or directory to fetch.",
        },
        recursive: {
          type: "boolean",
          description: "[copy_to / copy_from] Pass -r to SCP for recursive directory copies (default: false).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_22 };
