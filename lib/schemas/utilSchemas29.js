"use strict";
// ── UTILITY TOOL SCHEMAS — part 29 ──────────────────────────────────────────────
// Added: nats_client (v4.168.0).

const UTIL_SCHEMAS_29 = [
  {
    name: "nats_client",
    description:
      "Zero-dependency NATS messaging client — pure Node.js net/tls, no npm deps.\n\n" +
      "Compatible with: NATS Server 2.x, Synadia Cloud, Jetstream-enabled clusters.\n\n" +
      "Operations:\n" +
      "  connect     — TCP/TLS + NATS handshake (INFO+CONNECT+PING/PONG probe)\n" +
      "  publish     — PUB a message to a subject (fire-and-forget)\n" +
      "  subscribe   — SUB to a subject and collect incoming messages\n" +
      "  request     — Request-reply: subscribe inbox, publish, await reply\n" +
      "  ping        — PING/PONG round-trip latency measurement\n\n" +
      "Connection options:\n" +
      "  host, port (default 4222 / 4443 for TLS), tls, reject_unauthorized\n" +
      "  user/pass (basic auth) or token (token auth)\n" +
      "  timeout (default 30s), connect_timeout\n\n" +
      "Security guards:\n" +
      "  CR/LF/NUL injection guards on subject names and auth credentials\n" +
      "  8 MB payload cap (NATS default max_payload)\n" +
      "  Credentials never included in result objects\n\n" +
      "Returns { host, port, operation, elapsedMs, serverId, serverName, version, ...op-specific fields }.\n" +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "operation"],
      properties: {
        host: {
          type: "string",
          description: "NATS server hostname or IP address.",
        },
        port: {
          type: "number",
          description: "NATS server port (default: 4222, or 4443 when tls:true).",
        },
        tls: {
          type: "boolean",
          description: "Use TLS/SSL. Default: false.",
        },
        reject_unauthorized: {
          type: "boolean",
          description: "Reject self-signed TLS certificates (default: true).",
        },
        user: {
          type: "string",
          description: "Username for basic user/password auth. Never returned in results.",
        },
        pass: {
          type: "string",
          description: "Password for basic user/password auth. Never returned in results.",
        },
        token: {
          type: "string",
          description: "Authentication token (single-token auth). Never returned in results.",
        },
        timeout: {
          type: "number",
          description: "Total wall-clock timeout in seconds (default: 30).",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connection timeout in seconds (default: min(timeout, 10)).",
        },
        operation: {
          type: "string",
          enum: ["connect", "publish", "subscribe", "request", "ping"],
          description:
            "NATS operation: connect (probe), publish (PUB), subscribe (SUB+collect)," +
            " request (request-reply), ping (PING/PONG latency).",
        },
        subject: {
          type: "string",
          description: "NATS subject to publish to or request from. Required for: publish, request. Used as subscribe subject if subscribe_subject not set.",
        },
        payload: {
          type: "string",
          description: "Message payload string (default: ''). For: publish, request.",
        },
        payload_encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "Payload encoding: 'utf8' (default) or 'base64' for binary payloads. For: publish, request.",
        },
        reply_to: {
          type: "string",
          description: "Reply-to subject embedded in the PUB frame. For publish: sets the reply-to field. For request: overrides the auto-generated inbox subject.",
        },
        subscribe_subject: {
          type: "string",
          description: "Subject (or wildcard pattern) to subscribe to. Overrides 'subject' for subscribe. For: subscribe.",
        },
        queue_group: {
          type: "string",
          description: "NATS queue group name for load-balanced subscriptions. For: subscribe.",
        },
        max_messages: {
          type: "number",
          description: "Maximum number of messages to collect (1–1000, default: 10). For: subscribe.",
        },
        subscribe_timeout: {
          type: "number",
          description: "Seconds to wait for messages after subscribing (default: 5). For: subscribe.",
        },
        request_timeout: {
          type: "number",
          description: "Seconds to wait for a reply message (default: 5). For: request.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_29 };
