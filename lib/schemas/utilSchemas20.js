"use strict";
// ── UTILITY TOOL SCHEMAS — part 20 ────────────────────────────────────────────────
// Added: tcp_client (v4.158.0).

const UTIL_SCHEMAS_20 = [
  {
    name: "tcp_client",
    description:
      "Open a raw TCP (or TLS) socket connection to any host:port, optionally send one or more " +
      "messages, and collect the server's responses. Zero npm dependencies — pure Node.js net/tls. " +
      "\n\nIdeal for:\n" +
      "  • Redis commands (PING, GET, SET) via inline protocol \n" +
      "  • SMTP banner grabs and EHLO handshakes \n" +
      "  • Memcached, custom TCP daemons, port health-checks \n" +
      "  • Protocol debugging and TCP smoke tests \n\n" +
      "Each message in 'messages' has a 'data' string (UTF-8 by default, or base64/hex for binary), " +
      "an optional 'add_newline' flag (default true for UTF-8 messages — appends \\r\\n, the standard " +
      "line terminator for text protocols like SMTP and Redis inline), " +
      "an optional 'recv_until' substring to wait for before sending the next message " +
      "(useful for pipelining SMTP or Redis commands that require round-trip acknowledgement), " +
      "and an optional per-message 'recv_timeout' override. " +
      "\n\nReceived data is returned as an array of chunks with per-chunk timing and byte counts. " +
      "A total byte budget ('max_recv_bytes', default 256 KB) and chunk cap ('max_chunks', default 100) " +
      "prevent accidental runaway reads. " +
      "\n\nReturns { host, port, secure, connected, connectMs, messagesSent, chunksReceived, " +
      "totalReceivedBytes, truncated, chunks: [{index,elapsedMs,sizeBytes,data,encoding}], elapsedMs, error? }. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "port"],
      properties: {
        host: {
          type: "string",
          description: "Hostname or IP address to connect to (e.g. '127.0.0.1', 'redis.example.com').",
        },
        port: {
          type: "number",
          description: "TCP port to connect to (1–65535).",
        },
        secure: {
          type: "boolean",
          description: "Use TLS (default: false). Self-signed certificates are accepted.",
        },
        servername: {
          type: "string",
          description: "TLS SNI server name override (default: same as 'host'). Only used when 'secure' is true.",
        },
        messages: {
          type: "array",
          description: "Ordered list of messages to send after connecting (max 50).",
          items: {
            type: "object",
            required: ["data"],
            properties: {
              data: {
                type: "string",
                description: "Payload to send. Interpreted as UTF-8 text by default; set 'encoding' for binary.",
              },
              encoding: {
                type: "string",
                enum: ["utf8", "base64", "hex"],
                description: "Encoding of the 'data' field (default: 'utf8').",
              },
              add_newline: {
                type: "boolean",
                description:
                  "Append \\r\\n after the payload (default: true for utf8 messages). " +
                  "Set false for raw binary payloads or protocols that don't use CR LF.",
              },
              delay_ms: {
                type: "number",
                description: "Milliseconds to wait before sending this message (0–30000, default 0).",
              },
              recv_until: {
                type: "string",
                description:
                  "Wait until this substring appears in received data before sending the next message. " +
                  "Useful for request-response protocols (SMTP, FTP, Redis inline). " +
                  "Matching is done on raw bytes; the search string is UTF-8 encoded.",
              },
              recv_timeout: {
                type: "number",
                description:
                  "Per-message override for idle-receive timeout (seconds, default: global 'recv_timeout'). " +
                  "Only used when 'recv_until' is set on this message.",
              },
            },
          },
        },
        connect_timeout: {
          type: "number",
          description: "Seconds to wait for the TCP connection to be established (default 10, max 30).",
        },
        recv_timeout: {
          type: "number",
          description:
            "Idle-receive timeout in seconds: if no new data arrives within this window the session " +
            "is considered finished (default 5, max 60). This is NOT an error — most protocols signal " +
            "end-of-response by stopping, not by closing the connection.",
        },
        timeout: {
          type: "number",
          description: "Total wall-clock timeout for the entire session in seconds (default 30, max 120).",
        },
        max_recv_bytes: {
          type: "number",
          description:
            "Maximum total bytes to accept from the server (default 262144 = 256 KB, max 4 MB). " +
            "When exceeded, 'truncated' is set to true and the session ends.",
        },
        max_chunks: {
          type: "number",
          description:
            "Maximum number of received chunks to record (default 100, max 1000). " +
            "Extra chunks are dropped and 'truncated' is set to true.",
        },
        recv_encoding: {
          type: "string",
          enum: ["utf8", "base64", "hex"],
          description:
            "How to encode received byte chunks in the 'chunks[].data' field (default: 'utf8'). " +
            "Use 'base64' or 'hex' when the server sends binary data.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_20 };
