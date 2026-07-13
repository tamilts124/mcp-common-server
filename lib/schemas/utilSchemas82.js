"use strict";
/**
 * utilSchemas82.js — JSON Schema for syslog_client tool.
 */

const syslogClientSchema = {
  name: "syslog_client",
  description:
    "Zero-dependency Syslog client (pure Node.js dgram/net/tls; no npm deps). " +
    "Sends syslog messages over UDP, TCP, or TCP+TLS transports using " +
    "RFC 5424 (modern) or RFC 3164 (BSD legacy) formats. " +
    "Operations: send (send a single syslog message), " +
    "send_batch (send multiple messages in one call), " +
    "info (return facility/severity tables and format descriptions). " +
    "Facilities: kern(0), user(1), mail(2), daemon(3), auth(4), syslog(5), local0-7(16-23). " +
    "Severities: emerg(0), alert(1), crit(2), err(3), warning(4), notice(5), info(6), debug(7). " +
    "Security: NUL-byte guards on host/app_name/hostname/message; " +
    "timeout clamped 1s–30s; message capped at 64 KB; batch capped at 1000 messages.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: ["send", "send_batch", "info"],
        description:
          "Operation to perform. " +
          "'send': send a single syslog message to a server. " +
          "'send_batch': send multiple syslog messages in one call (UDP: separate datagrams; TCP/TLS: single connection). " +
          "'info': return facility codes, severity codes, format descriptions, and transport details.",
      },
      host: {
        type: "string",
        description:
          "Syslog server hostname or IP address. " +
          "Default: '127.0.0.1'. Examples: '10.0.0.5', 'syslog.example.com'.",
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        description:
          "Server port. Defaults: UDP/TCP → 514, TLS → 6514. " +
          "Override with this field.",
      },
      transport: {
        type: "string",
        enum: ["udp", "tcp", "tls"],
        description:
          "Transport protocol. " +
          "'udp': UDP datagram (unreliable, low overhead, default). " +
          "'tcp': TCP stream (reliable, plain-text). " +
          "'tls': TCP+TLS (reliable, encrypted, RFC 5425, default port 6514).",
      },
      timeout: {
        type: "integer",
        minimum: 1000,
        maximum: 30000,
        description: "Connection/send timeout in milliseconds (default: 5000, min: 1000, max: 30000).",
      },
      // ── Message fields (used by 'send'; also defaults for 'send_batch') ──
      facility: {
        description:
          "Syslog facility — string name (e.g. 'user', 'daemon', 'local0') or integer 0–23. " +
          "Default: 'user' (1). Common: kern(0), user(1), daemon(3), auth(4), local0-7(16-23).",
        oneOf: [
          { type: "string" },
          { type: "integer", minimum: 0, maximum: 23 },
        ],
      },
      severity: {
        description:
          "Syslog severity — string name (e.g. 'info', 'err', 'debug') or integer 0–7. " +
          "Default: 'info' (6). " +
          "Values: emerg(0), alert(1), crit(2), err(3), warning(4), notice(5), info(6), debug(7).",
        oneOf: [
          { type: "string" },
          { type: "integer", minimum: 0, maximum: 7 },
        ],
      },
      message: {
        type: "string",
        description: "The log message text (MSG field in RFC 5424 / RFC 3164).",
      },
      format: {
        type: "string",
        enum: ["rfc5424", "rfc3164"],
        description:
          "Syslog message format. " +
          "'rfc5424': modern syslog (2009), structured data, UTF-8 BOM, default. " +
          "'rfc3164': BSD legacy syslog (2001), simpler format, widely supported.",
      },
      hostname: {
        type: "string",
        description:
          "Override the HOSTNAME field (default: os.hostname()). " +
          "RFC 5424: max 255 chars; RFC 3164: max 255 chars.",
      },
      app_name: {
        type: "string",
        description:
          "Application name for the APP-NAME / TAG field " +
          "(default: 'syslog_client'). RFC 5424: max 48 chars.",
      },
      proc_id: {
        type: "string",
        description:
          "Process ID for the PROCID field (default: current process PID as string). " +
          "RFC 5424 only (max 128 chars).",
      },
      msg_id: {
        type: "string",
        description:
          "Message ID for the MSGID field (default: '-' nil-value). " +
          "RFC 5424 only (max 32 chars). Example: 'TCPIN', 'WEBOUT'.",
      },
      structured_data: {
        description:
          "Structured data for RFC 5424 STRUCTURED-DATA field. " +
          "Pass a raw string like '[exampleSDID@32473 key=\"val\"]' " +
          "or an object { sdId: { key: value } } (auto-serialised). " +
          "Ignored for RFC 3164 format.",
        oneOf: [
          { type: "string" },
          { type: "object" },
        ],
      },
      timestamp: {
        type: "string",
        description:
          "Override the TIMESTAMP field (default: current UTC ISO-8601 string). " +
          "RFC 5424 expects ISO-8601; RFC 3164 ignores this field (always uses current time).",
      },
      // ── TLS-specific ──
      reject_unauthorized: {
        type: "boolean",
        description:
          "TLS only: whether to reject servers with invalid certificates (default: true). " +
          "Set false only for self-signed certs in dev/test environments.",
      },
      servername: {
        type: "string",
        description:
          "TLS only: SNI hostname to use for certificate verification (default: host value). " +
          "Override when connecting by IP but the cert is issued to a hostname.",
      },
      // ── send_batch ──
      messages: {
        type: "array",
        description:
          "'send_batch' only: array of message objects, each with the same fields as 'send' " +
          "(message, facility, severity, format, hostname, app_name, proc_id, msg_id, " +
          "structured_data, timestamp). Per-message fields override the top-level defaults. " +
          "Maximum 1000 messages per batch.",
        maxItems: 1000,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            message:         { type: "string" },
            facility:        { oneOf: [{ type: "string" }, { type: "integer", minimum: 0, maximum: 23 }] },
            severity:        { oneOf: [{ type: "string" }, { type: "integer", minimum: 0, maximum: 7  }] },
            format:          { type: "string", enum: ["rfc5424", "rfc3164"] },
            hostname:        { type: "string" },
            app_name:        { type: "string" },
            proc_id:         { type: "string" },
            msg_id:          { type: "string" },
            structured_data: { oneOf: [{ type: "string" }, { type: "object" }] },
            timestamp:       { type: "string" },
          },
        },
      },
    },
  },
};

module.exports = { syslogClientSchema };
