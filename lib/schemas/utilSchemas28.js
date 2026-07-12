"use strict";
// ── UTILITY TOOL SCHEMAS — part 28 ───────────────────────────────────────────
// Added: stomp_client (v4.167.0).

const UTIL_SCHEMAS_28 = [
  {
    name: "stomp_client",
    description:
      "Zero-dependency STOMP 1.2 client — pure Node.js net/tls, no npm deps.\n\n" +
      "Compatible with: ActiveMQ, RabbitMQ (STOMP plugin), Apollo, Artemis.\n\n" +
      "Operations:\n" +
      "  connect     — TCP/TLS + STOMP handshake (CONNECTED frame probe)\n" +
      "  send        — Publish a message to a STOMP destination\n" +
      "  subscribe   — Subscribe to a destination and collect incoming messages\n" +
      "  request     — Request/reply pattern (subscribe reply-to, send, await reply)\n" +
      "  disconnect  — Graceful DISCONNECT (RECEIPT confirmed)\n\n" +
      "Connection options:\n" +
      "  host, port (default 61613 / 61614 for TLS), tls, reject_unauthorized\n" +
      "  login, passcode (PLAIN auth; credentials never echoed in results)\n" +
      "  vhost (default '/'), heartbeat_send/heartbeat_recv (ms, default 0)\n" +
      "  timeout (default 30s), connect_timeout\n\n" +
      "Security guards:\n" +
      "  NUL/CR/LF injection guards on all header fields (STOMP header injection)\n" +
      "  10 MB message body cap\n" +
      "  Credentials never included in result objects\n\n" +
      "Returns { host, port, vhost, operation, elapsedMs, version, ...op-specific fields }.\n" +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "operation"],
      properties: {
        host: {
          type: "string",
          description: "STOMP broker hostname or IP address.",
        },
        port: {
          type: "number",
          description: "STOMP broker port (default: 61613, or 61614 when tls:true).",
        },
        tls: {
          type: "boolean",
          description: "Use TLS/SSL. Default: false.",
        },
        reject_unauthorized: {
          type: "boolean",
          description: "Reject self-signed TLS certificates (default: true).",
        },
        login: {
          type: "string",
          description: "STOMP login (username) for PLAIN auth. Never returned in results.",
        },
        passcode: {
          type: "string",
          description: "STOMP passcode (password) for PLAIN auth. Never returned in results.",
        },
        vhost: {
          type: "string",
          description: "STOMP virtual host sent in the CONNECT frame 'host' header (default: '/').",
        },
        heartbeat_send: {
          type: "number",
          description: "Smallest number of milliseconds between heartbeats the client can send (default: 0 = disabled).",
        },
        heartbeat_recv: {
          type: "number",
          description: "Desired heartbeat receive interval in ms (default: 0 = no constraint).",
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
          enum: ["connect", "send", "subscribe", "request", "disconnect"],
          description:
            "STOMP operation: connect (probe), send (publish message), " +
            "subscribe (collect messages), request (request-reply), disconnect.",
        },
        destination: {
          type: "string",
          description: "STOMP destination (e.g. '/queue/myqueue', '/topic/news'). Required for: send, request. Used as subscribe destination if subscribe_destination not set.",
        },
        body: {
          type: "string",
          description: "Message body to send (default: ''). For: send, request.",
        },
        body_encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "Body encoding: 'utf8' (default) or 'base64' for binary payloads. For: send, request.",
        },
        content_type: {
          type: "string",
          description: "MIME content-type header for the message (e.g. 'application/json'). For: send, request.",
        },
        headers: {
          type: "object",
          description: "Extra STOMP headers to include in the SEND frame (object of string key-value pairs). For: send, request.",
          additionalProperties: { type: "string" },
        },
        request_receipt: {
          type: "boolean",
          description: "Request a RECEIPT frame from the broker after SEND (default: false). For: send.",
        },
        subscribe_destination: {
          type: "string",
          description: "Destination to subscribe to (overrides 'destination' for subscribe). For: subscribe.",
        },
        id: {
          type: "string",
          description: "Subscription ID (auto-generated if omitted). For: subscribe.",
        },
        ack_mode: {
          type: "string",
          enum: ["auto", "client"],
          description: "Acknowledgement mode: 'auto' (default, broker auto-acks) or 'client' (explicit ACK per message). For: subscribe.",
        },
        max_messages: {
          type: "number",
          description: "Maximum number of messages to collect (1–500, default: 10). For: subscribe.",
        },
        subscribe_timeout: {
          type: "number",
          description: "Seconds to wait for messages after subscribing (default: 5). For: subscribe.",
        },
        reply_to: {
          type: "string",
          description: "Reply-to destination for request/reply (default: auto-generated temp queue path). For: request.",
        },
        correlation_id: {
          type: "string",
          description: "Correlation-id header value to match the reply (auto-generated if omitted). For: request.",
        },
        request_timeout: {
          type: "number",
          description: "Seconds to wait for a reply message (default: 5). For: request.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_28 };
